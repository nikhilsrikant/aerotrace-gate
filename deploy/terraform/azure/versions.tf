terraform {
  required_version = ">= 1.6.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.20"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }

  # State holds generated passwords and secret values. Use an encrypted backend with access control:
  #
  # backend "azurerm" {
  #   resource_group_name  = "tfstate-rg"
  #   storage_account_name = "myorgtfstate"
  #   container_name       = "tfstate"
  #   key                  = "aerotrace/prod.tfstate"
  #   use_azuread_auth     = true
  # }
}

provider "azurerm" {
  subscription_id = var.subscription_id

  # The storage account has shared keys disabled, so the provider must use Entra ID.
  storage_use_azuread = true

  features {
    key_vault {
      # Purge protection is on; never try to purge on destroy.
      purge_soft_delete_on_destroy          = false
      purge_soft_deleted_keys_on_destroy    = false
      purge_soft_deleted_secrets_on_destroy = false
      recover_soft_deleted_key_vaults       = true
      recover_soft_deleted_keys             = true
      recover_soft_deleted_secrets          = true
    }

    resource_group {
      prevent_deletion_if_contains_resources = true
    }

    # The storage account is private-endpoint only. Keep the provider on the management plane
    # (the evidence container is created through ARM). Added in azurerm 4.x; check your version.
    storage {
      data_plane_available = false
    }
  }
}

provider "azuread" {}
