terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State holds the generated database password and secret values. Keep it in an
  # encrypted, access-controlled backend, for example:
  #
  # backend "s3" {
  #   bucket         = "my-org-terraform-state"
  #   key            = "aerotrace/prod/terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "terraform-locks"
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}
