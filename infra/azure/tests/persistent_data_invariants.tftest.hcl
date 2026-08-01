mock_provider "azurerm" {
  mock_resource "azurerm_storage_account" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-prod/providers/Microsoft.Storage/storageAccounts/stppmockdrafts"
    }
    override_during = plan
  }

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg-patchpage-mock"
    }
    override_during = plan
  }
}

mock_provider "random" {}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000000"
  public_base_url = "https://drafts.self-hoster.dev"
  server_image    = "registry.invalid/patchpage-server@sha256:0000000000000000000000000000000000000000000000000000000000000000"
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

run "locks_are_scoped_to_persistent_child_resources" {
  command = plan

  assert {
    condition     = azurerm_management_lock.drafts_storage.scope == azurerm_storage_account.drafts.id
    error_message = "Expected the drafts Storage lock to be scoped to the storage account, not a parent scope."
  }

  assert {
    condition     = azurerm_management_lock.patchpage_postgres.scope == azurerm_postgresql_flexible_server.patchpage.id
    error_message = "Expected the PostgreSQL lock to be scoped to the flexible server, not a parent scope."
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
