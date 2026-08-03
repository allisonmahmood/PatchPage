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

# --- management-lock scope, asserted behaviourally ----------------------------
#
# A lock's scope is another resource's computed `id`. Under the per-type
# mock_resource defaults above, every azurerm_storage_account in the
# configuration mocks to the same id, so "the lock's scope equals that id" holds
# for a lock wired to any storage account: it pins the mock, not the wiring.
#
# override_resource is per *address*, which is what makes these two runs
# possible. Each gives the two protected parents ids that appear nowhere else in
# this configuration and that differ from each other, so an assertion that a
# lock's scope equals one of them can only be satisfied by a lock wired to that
# exact resource. Re-scoping either lock -- to the resource group, or to the
# other protected resource -- turns the matching run red.
#
# The static checks in tests/guide_commands_test.sh stay. They cover what a
# plan-time assertion still cannot see: `prevent_destroy` is a meta-argument and
# is invisible here, and the static scope check reads the expression rather than
# its value, so the two guards fail for different reasons.

run "pins_drafts_lock_scope_to_the_drafts_storage_account" {
  command = plan

  override_resource {
    target = azurerm_storage_account.drafts
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-lock-scope/providers/Microsoft.Storage/storageAccounts/stdraftsdistinct"
    }
  }

  override_resource {
    target = azurerm_postgresql_flexible_server.patchpage
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-lock-scope/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-distinct"
    }
  }

  assert {
    condition     = azurerm_management_lock.drafts_storage.scope == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-lock-scope/providers/Microsoft.Storage/storageAccounts/stdraftsdistinct"
    error_message = "Expected the drafts deletion lock to be scoped to the drafts Storage account itself."
  }
}

run "pins_postgres_lock_scope_to_the_postgres_server" {
  command = plan

  override_resource {
    target = azurerm_storage_account.drafts
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-lock-scope/providers/Microsoft.Storage/storageAccounts/stdraftsdistinct"
    }
  }

  override_resource {
    target = azurerm_postgresql_flexible_server.patchpage
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-lock-scope/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-distinct"
    }
  }

  assert {
    condition     = azurerm_management_lock.patchpage_postgres.scope == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-lock-scope/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-distinct"
    error_message = "Expected the PostgreSQL deletion lock to be scoped to the flexible server itself."
  }
}
