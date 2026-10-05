# ---------------------------------------------------------------- naming

variable "name_prefix" {
  description = "Prefix for every resource name. Lowercase letters, digits and hyphens."
  type        = string
  default     = "aerotrace"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.name_prefix))
    error_message = "name_prefix must be 2-16 characters: lowercase letters, digits, hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "Environment name, used in resource names and tags (prod, staging, pilot)."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.environment))
    error_message = "environment must be 2-10 lowercase letters or digits."
  }
}

variable "region" {
  description = "AWS region for everything in this module."
  type        = string
  default     = "us-east-1"
}

variable "tags" {
  description = "Extra tags added to every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------- application

variable "public_url" {
  description = "The https URL people open, e.g. https://gate.example.com. Passkeys are bound to this host, so pick the final name before anyone enrols."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+$", var.public_url))
    error_message = "public_url must start with https:// and have no trailing slash or path."
  }
}

variable "admin_email" {
  description = "Email of the first administrator, created by the migrate task on an empty database."
  type        = string
}

variable "admin_name" {
  description = "Display name of the first administrator."
  type        = string
  default     = "Gate Administrator"
}

variable "image_tag" {
  description = "Image tag Terraform puts in the task definitions. After the first deploy the GitHub workflow registers new revisions, and Terraform leaves the running revision alone."
  type        = string
  default     = "2.3.0"
}

variable "ecr_repository_name" {
  description = "Name of the ECR repository created for the app image."
  type        = string
  default     = "aerotrace-gate"
}

variable "extra_environment" {
  description = "Extra non-secret environment variables for web, worker and migrate (OIDC_ISSUER, LLM_PROVIDER, LOG_LEVEL and so on). Secrets belong in Secrets Manager with a <NAME>_REF entry here."
  type        = map(string)
  default     = {}
}

variable "secret_delivery" {
  description = "How secrets reach the container. \"ref\" sets <NAME>_REF=aws-sm://<arn> and the app reads Secrets Manager itself (the runtime contract). \"platform\" has ECS inject DATABASE_URL, SESSION_SECRET and ADMIN_PASSWORD as environment variables, for images that do not resolve *_REF yet."
  type        = string
  default     = "ref"

  validation {
    condition     = contains(["ref", "platform"], var.secret_delivery)
    error_message = "secret_delivery must be \"ref\" or \"platform\"."
  }
}

variable "connector_allowed_hosts" {
  description = "Comma-separated hosts evidence connectors may reach on private addresses or plain http (an internal GitHub Enterprise or Jira Data Center). Sets CONNECTOR_ALLOWED_HOSTS on web and worker when not empty."
  type        = string
  default     = ""
}

variable "storage_s3_prefix" {
  description = "Key prefix for evidence objects in the bucket. The task role can only touch objects under it."
  type        = string
  default     = "evidence/"
}

variable "evidence_glacier_ir_days" {
  description = "Days after which evidence objects (and old versions) move to S3 Glacier Instant Retrieval. Reads stay immediate."
  type        = number
  default     = 365
}

# ---------------------------------------------------------------- network

variable "vpc_cidr" {
  description = "CIDR block for the VPC. Public subnets take the first two /24s, private subnets take /24s starting at offset 10."
  type        = string
  default     = "10.40.0.0/16"
}

variable "nat_gateway_ha" {
  description = "One NAT gateway per AZ (true) or a single shared one (false). A single NAT is cheaper but is a single point of failure for outbound traffic."
  type        = bool
  default     = false
}

variable "enable_flow_logs" {
  description = "Send VPC flow logs to CloudWatch Logs."
  type        = bool
  default     = true
}

variable "allowed_cidrs" {
  description = "CIDR ranges allowed to reach the load balancer on 80/443."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ---------------------------------------------------------------- TLS / load balancer

variable "acm_certificate_arn" {
  description = "ARN of an issued ACM certificate in this region that covers the host in public_url."
  type        = string
}

variable "enable_waf" {
  description = "Attach an AWS WAF web ACL with the AWS managed common and known-bad-inputs rule sets to the load balancer."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Deletion protection on the database and load balancer. Turn off only for teardown."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------- database

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_engine_version" {
  description = "PostgreSQL version. A major version alone (\"16\") lets RDS pick the current minor."
  type        = string
  default     = "16"
}

variable "db_allocated_storage" {
  description = "Initial database storage in GiB."
  type        = number
  default     = 50
}

variable "db_max_allocated_storage" {
  description = "Upper limit in GiB for storage autoscaling."
  type        = number
  default     = 500
}

variable "db_multi_az" {
  description = "Run a synchronous standby in a second AZ."
  type        = bool
  default     = true
}

variable "db_backup_retention_days" {
  description = "Days of automated backups and point-in-time recovery."
  type        = number
  default     = 14
}

# ---------------------------------------------------------------- compute

variable "cpu_architecture" {
  description = "Fargate CPU architecture. Must match the image (the GitHub workflow builds X86_64)."
  type        = string
  default     = "X86_64"
}

variable "web_cpu" {
  description = "Fargate CPU units for a web task (app plus collector sidecar)."
  type        = number
  default     = 1024
}

variable "web_memory" {
  description = "Fargate memory in MiB for a web task."
  type        = number
  default     = 2048
}

variable "worker_cpu" {
  description = "Fargate CPU units for a worker task."
  type        = number
  default     = 1024
}

variable "worker_memory" {
  description = "Fargate memory in MiB for a worker task."
  type        = number
  default     = 3072
}

variable "migrate_cpu" {
  description = "Fargate CPU units for the migrate task."
  type        = number
  default     = 512
}

variable "migrate_memory" {
  description = "Fargate memory in MiB for the migrate task."
  type        = number
  default     = 1024
}

variable "web_desired_count" {
  description = "Web tasks to run. Also the autoscaling minimum."
  type        = number
  default     = 2
}

variable "web_max_count" {
  description = "Most web tasks autoscaling may run."
  type        = number
  default     = 6
}

variable "worker_desired_count" {
  description = "Worker tasks to start with. Autoscaling moves between 1 and worker_max_count."
  type        = number
  default     = 2
}

variable "worker_max_count" {
  description = "Most worker tasks autoscaling may run."
  type        = number
  default     = 10
}

variable "cpu_target_percent" {
  description = "Average CPU utilisation that web and worker autoscaling aims for."
  type        = number
  default     = 60
}

variable "container_insights" {
  description = "Turn on ECS Container Insights. The 'tasks below desired' alarms need it."
  type        = bool
  default     = true
}

variable "otel_collector_image" {
  description = "AWS Distro for OpenTelemetry collector image. Pin a version (e.g. :v0.40.0) for production."
  type        = string
  default     = "public.ecr.aws/aws-observability/aws-otel-collector:latest"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for app, collector, metrics and flow logs."
  type        = number
  default     = 365
}

# ---------------------------------------------------------------- alerts

variable "alarm_email" {
  description = "Email address subscribed to the alarm SNS topic. Empty means no subscription (attach your own)."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------- GitHub deploy

variable "github_repo" {
  description = "GitHub repository allowed to deploy, as owner/name (e.g. nikhilsrikant/aerotrace-gate)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must look like owner/name."
  }
}

variable "github_branch" {
  description = "Branch whose workflow runs may assume the deploy role (in addition to the GitHub environment below)."
  type        = string
  default     = "main"
}

variable "github_environment" {
  description = "GitHub environment the deploy workflows run in. Jobs in an environment get an OIDC subject of repo:<repo>:environment:<name>, so the trust policy allows it."
  type        = string
  default     = "production"
}

variable "create_github_oidc_provider" {
  description = "Create the token.actions.githubusercontent.com OIDC provider. Set false if the account already has one; it is then looked up."
  type        = bool
  default     = true
}
