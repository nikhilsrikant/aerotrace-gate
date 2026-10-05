# ================================================================ ECR

resource "aws_ecr_repository" "app" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  # AES256 avoids extra KMS grants for pulls. Switch to KMS with the data key if policy requires it.
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Drop untagged layers after 14 days. Tagged release images are kept."
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 14
      }
      action = { type = "expire" }
    }]
  })
}

# ================================================================ ECS cluster

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ================================================================ task definitions

locals {
  roles = {
    web     = { cpu = var.web_cpu, memory = var.web_memory }
    worker  = { cpu = var.worker_cpu, memory = var.worker_memory }
    migrate = { cpu = var.migrate_cpu, memory = var.migrate_memory }
  }

  # Runtime contract: docs/cloud/configuration.md
  base_env = merge(
    {
      PUBLIC_URL                  = var.public_url
      DATABASE_SSL                = "require"
      STORAGE_BACKEND             = "s3"
      STORAGE_S3_BUCKET           = aws_s3_bucket.evidence.bucket
      STORAGE_S3_PREFIX           = var.storage_s3_prefix
      STORAGE_S3_KMS_KEY_ID       = aws_kms_key.s3.arn
      AWS_REGION                  = local.region
      SIGNER                      = "aws-kms"
      SIGNER_AWS_KMS_KEY_ID       = aws_kms_key.signing.arn
      OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
      OTEL_RESOURCE_ATTRIBUTES    = "deployment.environment=${var.environment},cloud.provider=aws"
      SEED_DEMO_DATA              = "false"
      LOG_LEVEL                   = "info"
    },
    var.extra_environment,
  )

  # Evidence connectors (docs/connectors.md). Web validates source settings, the worker syncs.
  connector_env = merge(
    { CONNECTOR_SECRET_PREFIXES = "aws-sm://${local.connector_secret_path}" },
    var.connector_allowed_hosts != "" ? { CONNECTOR_ALLOWED_HOSTS = var.connector_allowed_hosts } : {},
  )

  role_env = {
    web = merge(local.connector_env, {
      OTEL_SERVICE_NAME = "aerotrace-web"
    })
    worker = merge(local.connector_env, {
      OTEL_SERVICE_NAME        = "aerotrace-worker"
      WORKER_METRICS_PORT      = "9464"
      WORKER_SHUTDOWN_GRACE_MS = "50000"
    })
    migrate = {
      OTEL_SERVICE_NAME = "aerotrace-migrate"
      ADMIN_EMAIL       = var.admin_email
      ADMIN_NAME        = var.admin_name
    }
  }

  # Which secrets each role gets. Only migrate needs the bootstrap admin password.
  role_secrets = {
    web     = ["DATABASE_URL", "SESSION_SECRET"]
    worker  = ["DATABASE_URL", "SESSION_SECRET"]
    migrate = ["DATABASE_URL", "SESSION_SECRET", "ADMIN_PASSWORD"]
  }

  # secret_delivery = "ref": the app resolves aws-sm://<arn> with the task role.
  ref_env = {
    for role, names in local.role_secrets : role => {
      for n in names : "${n}_REF" => "aws-sm://${local.app_secret_arns[n]}" if var.secret_delivery == "ref"
    }
  }

  # secret_delivery = "platform": ECS injects the values with the execution role.
  ecs_secrets = {
    for role, names in local.role_secrets : role => [
      for n in names : { name = n, valueFrom = local.app_secret_arns[n] } if var.secret_delivery == "platform"
    ]
  }

  port_mappings = {
    web     = [{ name = "http", containerPort = 3000, protocol = "tcp" }]
    worker  = [{ name = "metrics", containerPort = 9464, protocol = "tcp" }]
    migrate = []
  }

  mount_points = {
    web = [
      { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
      { sourceVolume = "next-cache", containerPath = "/app/.next/cache", readOnly = false },
    ]
    worker  = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    migrate = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
  }

  # ECS ignores the Dockerfile HEALTHCHECK, so repeat it. The script checks /api/health for web
  # and /healthz on the metrics port for workers. migrate is one-shot and has none.
  health_checks = {
    web = {
      healthCheck = {
        command     = ["CMD", "node", "/app/healthcheck.mjs"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
    worker = {
      healthCheck = {
        command     = ["CMD", "node", "/app/healthcheck.mjs"]
        interval    = 30
        timeout     = 5
        retries     = 4
        startPeriod = 30
      }
    }
    migrate = {}
  }

  container_definitions = {
    for role, r in local.roles : role => jsonencode([
      merge(
        {
          name                   = "app"
          image                  = local.image
          essential              = true
          command                = [role]
          user                   = "10001:10001"
          readonlyRootFilesystem = true
          environment = [
            for k, v in merge(local.base_env, local.role_env[role], local.ref_env[role]) : { name = k, value = v }
          ]
          secrets      = local.ecs_secrets[role]
          portMappings = local.port_mappings[role]
          mountPoints  = local.mount_points[role]
          stopTimeout  = role == "worker" ? 60 : 30
          linuxParameters = {
            initProcessEnabled = true
            capabilities       = { drop = ["ALL"] }
          }
          dependsOn = [{ containerName = "otel-collector", condition = "START" }]
          logConfiguration = {
            logDriver = "awslogs"
            options = {
              "awslogs-group"         = aws_cloudwatch_log_group.app.name
              "awslogs-region"        = local.region
              "awslogs-stream-prefix" = role
            }
          }
        },
        local.health_checks[role],
      ),
      {
        name = "otel-collector"
        # Not essential: a collector crash must not take the app down. For migrate, the task
        # stops as soon as the essential app container exits.
        image                  = var.otel_collector_image
        essential              = false
        readonlyRootFilesystem = true
        environment = [
          { name = "AOT_CONFIG_CONTENT", value = file("${path.module}/../../otel/collector-aws.yaml") },
        ]
        mountPoints       = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
        memoryReservation = 128
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            "awslogs-group"         = aws_cloudwatch_log_group.app.name
            "awslogs-region"        = local.region
            "awslogs-stream-prefix" = role
          }
        }
      },
    ])
  }
}

resource "aws_ecs_task_definition" "app" {
  for_each = local.roles

  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(each.value.cpu)
  memory                   = tostring(each.value.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = local.container_definitions[each.key]

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  # Fargate task storage, writable even though the root filesystem is read-only.
  volume {
    name = "tmp"
  }

  dynamic "volume" {
    for_each = each.key == "web" ? ["next-cache"] : []
    content {
      name = volume.value
    }
  }

  tags = { Role = each.key }
}

# ================================================================ load balancer

resource "aws_lb" "main" {
  name                       = "${local.name}-alb"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  # Evidence bundles can be up to MAX_UPLOAD_MB (200 MB by default).
  idle_timeout = 300
}

resource "aws_lb_target_group" "web" {
  name                 = "${local.name}-web"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

# ================================================================ WAF (optional)

resource "aws_wafv2_web_acl" "main" {
  count = var.enable_waf ? 1 : 0

  name  = "${local.name}-web"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        # The body-size rule blocks anything over 8 KB, which would block evidence uploads.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-web"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "main" {
  count = var.enable_waf ? 1 : 0

  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main[0].arn
}

# ================================================================ services

# The GitHub workflow registers a new task definition revision per release and points the
# services at it, so Terraform ignores task_definition after creation. Environment changes made
# here land in a new revision that the next deploy picks up (it copies the latest revision).
resource "aws_ecs_service" "web" {
  name             = "${local.name}-web"
  cluster          = aws_ecs_cluster.main.id
  task_definition  = aws_ecs_task_definition.app["web"].arn
  desired_count    = var.web_desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  enable_execute_command             = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "app"
    container_port   = 3000
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name             = "${local.name}-worker"
  cluster          = aws_ecs_cluster.main.id
  task_definition  = aws_ecs_task_definition.app["worker"].arn
  desired_count    = var.worker_desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  enable_execute_command             = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

# ================================================================ autoscaling

resource "aws_appautoscaling_target" "web" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.web.name}"
  min_capacity       = var.web_desired_count
  max_capacity       = var.web_max_count
}

resource "aws_appautoscaling_policy" "web_cpu" {
  name               = "${local.name}-web-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension
  resource_id        = aws_appautoscaling_target.web.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"
  min_capacity       = 1
  max_capacity       = var.worker_max_count
}

resource "aws_appautoscaling_policy" "worker_cpu" {
  name               = "${local.name}-worker-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  resource_id        = aws_appautoscaling_target.worker.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
