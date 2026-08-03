# OpenTofu resolves mocked computed attributes during plan, where Terraform 1.9.8
# left them unknown. Mocked Azure resource IDs therefore now reach the real azurerm
# schema validators, which reject the generated random strings. Only the attributes
# that flow into another resource's configuration have to be well-formed; no run
# asserts on these values.
mock_provider "azurerm" {
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.OperationalInsights/workspaces/log-mock"
    }
  }

  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.App/managedEnvironments/cae-mock"
    }
  }

  mock_resource "azurerm_container_registry" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ContainerRegistry/registries/acrmock"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Storage/storageAccounts/stmock"
    }
  }

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-mock"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-mock"
      principal_id = "00000000-0000-0000-0000-000000000001"
    }
  }
}

# Pin the registry name suffix. With computed values now resolved at plan time an
# unpinned result leaves local.server_image_is_managed_digest false, which trips the
# Container App create-time precondition before any assertion below is reached.
mock_provider "random" {
  mock_resource "random_string" {
    defaults = {
      id     = "abc123"
      result = "abc123"
    }
  }
}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000000"
  public_base_url = "https://drafts.self-hoster.dev"
  server_image    = "acrpatchpageabc123.azurecr.io/patchpage-server@sha256:0000000000000000000000000000000000000000000000000000000000000000"
}

run "protects_persistent_data_by_default" {
  command = plan


  assert {
    condition     = azurerm_storage_account.drafts.account_replication_type == "GRS"
    error_message = "Expected geo-redundant Storage replication by default."
  }

  assert {
    condition     = azurerm_storage_account.drafts.blob_properties[0].versioning_enabled == true
    error_message = "Expected Blob versioning to be enabled."
  }

  assert {
    condition     = azurerm_storage_account.drafts.blob_properties[0].delete_retention_policy[0].days == 30
    error_message = "Expected deleted blobs to remain recoverable for 30 days by default."
  }

  assert {
    condition     = azurerm_storage_account.drafts.blob_properties[0].delete_retention_policy[0].permanent_delete_enabled == false
    error_message = "Expected permanent deletion of soft-deleted blobs to remain disabled."
  }

  assert {
    condition     = azurerm_storage_account.drafts.blob_properties[0].container_delete_retention_policy[0].days == 30
    error_message = "Expected deleted containers to remain recoverable for 30 days by default."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.patchpage.backup_retention_days == 35
    error_message = "Expected PostgreSQL backups to remain recoverable for 35 days by default."
  }

  assert {
    condition     = azurerm_storage_container.drafts.container_access_type == "private"
    error_message = "Expected the drafts container to remain private."
  }

  assert {
    condition     = azurerm_management_lock.drafts_storage.lock_level == "CanNotDelete"
    error_message = "Expected a CanNotDelete lock for drafts Storage."
  }

  assert {
    condition     = azurerm_management_lock.patchpage_postgres.lock_level == "CanNotDelete"
    error_message = "Expected a CanNotDelete lock for PostgreSQL."
  }
}

run "supports_alternate_recovery_settings" {
  command = plan

  variables {
    storage_replication_type       = "ZRS"
    storage_delete_retention_days  = 365
    postgres_backup_retention_days = 7
  }

  assert {
    condition     = azurerm_storage_account.drafts.account_replication_type == "ZRS"
    error_message = "Expected the configured Storage replication type."
  }

  assert {
    condition = (
      azurerm_storage_account.drafts.blob_properties[0].delete_retention_policy[0].days == 365 &&
      azurerm_storage_account.drafts.blob_properties[0].container_delete_retention_policy[0].days == 365
    )
    error_message = "Expected the configured blob and container delete-retention window."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.patchpage.backup_retention_days == 7
    error_message = "Expected the configured PostgreSQL backup-retention window."
  }
}
