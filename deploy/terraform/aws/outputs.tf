output "alb_dns_name" {
  description = "Load balancer DNS name. Point your hostname (public_url) at it with a CNAME or Route 53 alias."
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone ID of the load balancer, for a Route 53 alias record."
  value       = aws_lb.main.zone_id
}

output "public_url" {
  description = "The URL the app expects to be reached on."
  value       = var.public_url
}

output "ecr_repository_url" {
  description = "ECR repository for the app image."
  value       = aws_ecr_repository.app.repository_url
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.main.name
}

output "web_service_name" {
  description = "ECS service running the web role."
  value       = aws_ecs_service.web.name
}

output "worker_service_name" {
  description = "ECS service running the worker role."
  value       = aws_ecs_service.worker.name
}

output "web_task_family" {
  description = "Task definition family for web."
  value       = aws_ecs_task_definition.app["web"].family
}

output "worker_task_family" {
  description = "Task definition family for worker."
  value       = aws_ecs_task_definition.app["worker"].family
}

output "migrate_task_family" {
  description = "Task definition family for the one-shot migrate task."
  value       = aws_ecs_task_definition.app["migrate"].family
}

output "private_subnet_ids" {
  description = "Private subnets for aws ecs run-task."
  value       = aws_subnet.private[*].id
}

output "task_security_group_id" {
  description = "Security group for aws ecs run-task."
  value       = aws_security_group.tasks.id
}

output "log_group_name" {
  description = "CloudWatch log group for app and collector logs. Streams are <role>/<container>/<task-id>."
  value       = aws_cloudwatch_log_group.app.name
}

output "deploy_role_arn" {
  description = "IAM role the GitHub deploy workflow assumes through OIDC."
  value       = aws_iam_role.deploy.arn
}

output "signing_key_arn" {
  description = "KMS signing key (ECC_NIST_P256, SIGN_VERIFY)."
  value       = aws_kms_key.signing.arn
}

output "signing_key_alias" {
  description = "Alias of the signing key."
  value       = aws_kms_alias.signing.name
}

output "evidence_bucket_name" {
  description = "S3 bucket holding evidence bundles."
  value       = aws_s3_bucket.evidence.bucket
}

output "admin_password_secret_arn" {
  description = "Secrets Manager secret with the first administrator's password."
  value       = aws_secretsmanager_secret.app["admin-password"].arn
}

output "connector_secret_prefix" {
  description = "Evidence connector token references must start with this (CONNECTOR_SECRET_PREFIXES). Create the secrets under this path with the data key."
  value       = "aws-sm://${local.connector_secret_path}"
}

output "connector_secret_kms_key" {
  description = "KMS alias to encrypt connector secrets with (the key the app's other secrets use)."
  value       = aws_kms_alias.data.name
}

output "database_endpoint" {
  description = "RDS endpoint (private)."
  value       = aws_db_instance.main.address
}

output "alarm_topic_arn" {
  description = "SNS topic the alarms publish to."
  value       = aws_sns_topic.alarms.arn
}

output "github_variables" {
  description = "Repository or environment variables for .github/workflows/deploy-aws.yml."
  value = {
    AWS_REGION             = local.region
    AWS_DEPLOY_ROLE_ARN    = aws_iam_role.deploy.arn
    ECR_REPOSITORY_URL     = aws_ecr_repository.app.repository_url
    ECS_CLUSTER            = aws_ecs_cluster.main.name
    ECS_WEB_SERVICE        = aws_ecs_service.web.name
    ECS_WORKER_SERVICE     = aws_ecs_service.worker.name
    ECS_WEB_FAMILY         = aws_ecs_task_definition.app["web"].family
    ECS_WORKER_FAMILY      = aws_ecs_task_definition.app["worker"].family
    ECS_MIGRATE_FAMILY     = aws_ecs_task_definition.app["migrate"].family
    ECS_SUBNETS            = join(",", aws_subnet.private[*].id)
    ECS_SECURITY_GROUP     = aws_security_group.tasks.id
    ECS_LOG_GROUP          = aws_cloudwatch_log_group.app.name
    AEROTRACE_PUBLIC_URL   = var.public_url
  }
}
