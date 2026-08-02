data "azurerm_client_config" "current" {}

resource "random_string" "unique" {
  length  = 6
  lower   = true
  upper   = false
  numeric = true
  special = false
}

resource "random_password" "postgres_admin" {
  length  = 32
  special = false
}

resource "random_password" "bootstrap_api_token" {
  length  = 48
  special = false
}

locals {
  name_suffix         = "${var.environment_name}-${random_string.unique.result}"
  resource_slug       = "patchpage-${var.environment_name}"
  postgres_server     = "pg-patchpage-${local.name_suffix}"
  storage_account     = "stpp${random_string.unique.result}"
  storage_container   = "drafts"
  bootstrap_api_token = "pp_${random_password.bootstrap_api_token.result}"
  database_url        = "postgres://${var.postgres_admin_login}:${random_password.postgres_admin.result}@${azurerm_postgresql_flexible_server.patchpage.fqdn}:5432/${azurerm_postgresql_flexible_server_database.patchpage.name}?sslmode=require"
}

resource "azurerm_resource_group" "patchpage" {
  name     = "rg-patchpage-${var.environment_name}"
  location = var.location
  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_log_analytics_workspace" "patchpage" {
  name                = "log-patchpage-${var.environment_name}"
  location            = azurerm_resource_group.patchpage.location
  resource_group_name = azurerm_resource_group.patchpage.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_app_environment" "patchpage" {
  name                       = "cae-patchpage-${var.environment_name}"
  location                   = azurerm_resource_group.patchpage.location
  resource_group_name        = azurerm_resource_group.patchpage.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.patchpage.id
}

resource "azurerm_container_registry" "patchpage" {
  name                = "acrpatchpage${random_string.unique.result}"
  resource_group_name = azurerm_resource_group.patchpage.name
  location            = azurerm_resource_group.patchpage.location
  sku                 = "Basic"
  admin_enabled       = false
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-patchpage-${var.environment_name}"
  location            = azurerm_resource_group.patchpage.location
  resource_group_name = azurerm_resource_group.patchpage.name
}

resource "azurerm_role_assignment" "app_acr_pull" {
  scope                = azurerm_container_registry.patchpage.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_storage_account" "drafts" {
  name                            = local.storage_account
  resource_group_name             = azurerm_resource_group.patchpage.name
  location                        = azurerm_resource_group.patchpage.location
  account_tier                    = "Standard"
  account_replication_type        = var.storage_replication_type
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days                     = var.storage_delete_retention_days
      permanent_delete_enabled = false
    }

    container_delete_retention_policy {
      days = var.storage_delete_retention_days
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_management_lock" "drafts_storage" {
  name       = "protect-patchpage-drafts"
  scope      = azurerm_storage_account.drafts.id
  lock_level = "CanNotDelete"
  notes      = "Protects persistent blob data from accidental deletion."

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "drafts" {
  name                  = local.storage_container
  storage_account_id    = azurerm_storage_account.drafts.id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "app_blob_contributor" {
  scope                = azurerm_storage_account.drafts.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_postgresql_flexible_server" "patchpage" {
  name                          = local.postgres_server
  resource_group_name           = azurerm_resource_group.patchpage.name
  location                      = azurerm_resource_group.patchpage.location
  version                       = "16"
  administrator_login           = var.postgres_admin_login
  administrator_password        = random_password.postgres_admin.result
  sku_name                      = var.postgres_sku_name
  storage_mb                    = var.postgres_storage_mb
  backup_retention_days         = var.postgres_backup_retention_days
  public_network_access_enabled = true

  lifecycle {
    ignore_changes  = [zone]
    prevent_destroy = true
  }
}

resource "azurerm_management_lock" "patchpage_postgres" {
  name       = "protect-patchpage-postgres"
  scope      = azurerm_postgresql_flexible_server.patchpage.id
  lock_level = "CanNotDelete"
  notes      = "Protects persistent database data from accidental deletion."

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_postgresql_flexible_server_database" "patchpage" {
  name      = var.postgres_database_name
  server_id = azurerm_postgresql_flexible_server.patchpage.id
  charset   = "UTF8"
  collation = "en_US.utf8"

  lifecycle {
    prevent_destroy = true
  }
}

# Allow Azure-hosted services, including the Container App, to reach the server.
# This mirrors `az postgres flexible-server create --public-access 0.0.0.0`.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.patchpage.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}
