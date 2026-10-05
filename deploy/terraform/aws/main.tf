# AeroTrace Gate on AWS: ECS Fargate (web, worker, migrate) behind an ALB, RDS PostgreSQL,
# S3 evidence storage, KMS decision signing, Secrets Manager, CloudWatch + X-Ray via ADOT.
#
# Files:
#   network.tf        VPC, subnets, NAT, routes, flow logs, S3 gateway endpoint
#   security.tf       KMS keys, secrets, security groups, IAM roles, GitHub OIDC deploy role
#   database.tf       RDS PostgreSQL
#   compute.tf        ECR, ECS cluster, task definitions, services, ALB, autoscaling, WAF
#   observability.tf  log groups, SNS topic, CloudWatch alarms
#   main.tf           (this file) shared locals and the evidence bucket

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  name       = "${var.name_prefix}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.name

  tags = merge({
    Application = "aerotrace-gate"
    Environment = var.environment
    ManagedBy   = "terraform"
  }, var.tags)

  # Secrets Manager names: <prefix>/<env>/<secret>
  secret_path = "${var.name_prefix}/${var.environment}"

  # Evidence connector tokens: <prefix>/<env>/connectors/<name>. Operators create these; the app
  # role can read this path and nothing else beyond its own secrets.
  connector_secret_path = "${local.secret_path}/connectors/"

  image = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
}

# ---------------------------------------------------------------- evidence bucket

resource "aws_s3_bucket" "evidence" {
  bucket = "${local.name}-evidence-${local.account_id}"

  # Audit evidence. Emptying the bucket is a deliberate, manual step (see docs/cloud/aws.md, teardown).
  force_destroy = false
}

resource "aws_s3_bucket_ownership_controls" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    id     = "evidence-to-glacier-ir"
    status = "Enabled"

    filter {
      prefix = ""
    }

    transition {
      days          = var.evidence_glacier_ir_days
      storage_class = "GLACIER_IR"
    }

    noncurrent_version_transition {
      noncurrent_days = var.evidence_glacier_ir_days
      storage_class   = "GLACIER_IR"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.evidence]
}

data "aws_iam_policy_document" "evidence_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.evidence.arn,
      "${aws_s3_bucket.evidence.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid     = "DenyOldTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.evidence.arn,
      "${aws_s3_bucket.evidence.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "NumericLessThan"
      variable = "s3:TlsVersion"
      values   = ["1.2"]
    }
  }
}

resource "aws_s3_bucket_policy" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  policy = data.aws_iam_policy_document.evidence_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.evidence]
}
