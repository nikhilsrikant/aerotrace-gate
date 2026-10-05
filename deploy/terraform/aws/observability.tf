# ================================================================ log groups

resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.name_prefix}/${var.environment}/ecs"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
}

# The ADOT collector writes CloudWatch embedded-metric-format records here.
# The name is fixed in deploy/otel/collector-aws.yaml; change both together.
resource "aws_cloudwatch_log_group" "metrics" {
  name              = "/aerotrace/metrics"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
}

# ================================================================ alarm topic

resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = aws_kms_key.data.arn
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count = var.alarm_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
}

# ================================================================ load balancer

resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  alarm_name          = "${local.name}-alb-5xx-rate"
  alarm_description   = "More than 5% of requests returned 5xx (target or load balancer) in 3 of the last 5 minutes."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 5
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "rate"
    expression  = "100 * (FILL(t5xx, 0) + FILL(e5xx, 0)) / FILL(req, 1)"
    label       = "5xx percent"
    return_data = true
  }

  metric_query {
    id = "t5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
  }

  metric_query {
    id = "e5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
  }

  metric_query {
    id = "req"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_latency_p95" {
  alarm_name          = "${local.name}-alb-latency-p95"
  alarm_description   = "p95 target response time above 2 seconds for 10 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ================================================================ database

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name}-rds-cpu"
  alarm_description   = "Database CPU above 80% for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${local.name}-rds-free-storage"
  alarm_description   = "Database free storage below 10% of the initial allocation (at least 5 GiB). Storage autoscaling should kick in; if it has hit db_max_allocated_storage, raise it."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = max(5, var.db_allocated_storage * 0.1) * 1073741824
  comparison_operator = "LessThanThreshold"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ================================================================ ECS services (needs Container Insights)

resource "aws_cloudwatch_metric_alarm" "ecs_tasks_below_desired" {
  for_each = var.container_insights ? {
    web    = aws_ecs_service.web.name
    worker = aws_ecs_service.worker.name
  } : {}

  alarm_name          = "${local.name}-${each.key}-tasks-below-desired"
  alarm_description   = "Fewer ${each.key} tasks running than desired for 10 minutes."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 10
  datapoints_to_alarm = 10
  treat_missing_data  = "missing"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "gap"
    expression  = "desired - running"
    label       = "Missing tasks"
    return_data = true
  }

  metric_query {
    id = "desired"
    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "DesiredTaskCount"
      period      = 60
      stat        = "Average"
      dimensions  = { ClusterName = aws_ecs_cluster.main.name, ServiceName = each.value }
    }
  }

  metric_query {
    id = "running"
    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "RunningTaskCount"
      period      = 60
      stat        = "Average"
      dimensions  = { ClusterName = aws_ecs_cluster.main.name, ServiceName = each.value }
    }
  }
}

# ================================================================ app metrics (namespace AeroTrace, via ADOT/EMF)

resource "aws_cloudwatch_metric_alarm" "approval_age" {
  alarm_name          = "${local.name}-approval-oldest-age"
  alarm_description   = "An audit has waited more than 2 days (172800 s) for human approval."
  namespace           = "AeroTrace"
  metric_name         = "aerotrace.approvals.oldest_age_seconds"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 172800
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
