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

run "configures_every_ignored_ingress_invariant" {
  command = plan

  assert {
    condition     = length(azurerm_container_app.server.ingress) == 1
    error_message = "Expected exactly one ingress configuration."
  }

  assert {
    condition     = azurerm_container_app.server.ingress[0].external_enabled == true
    error_message = "Expected external ingress."
  }

  assert {
    condition     = azurerm_container_app.server.ingress[0].allow_insecure_connections == false
    error_message = "Expected insecure HTTP to remain disabled."
  }

  assert {
    condition     = azurerm_container_app.server.ingress[0].target_port == 3000
    error_message = "Expected ingress to target port 3000."
  }

  assert {
    condition     = lower(azurerm_container_app.server.ingress[0].transport) == "auto"
    error_message = "Expected auto ingress transport."
  }

  assert {
    condition     = lower(azurerm_container_app.server.ingress[0].client_certificate_mode) == "ignore"
    error_message = "Expected client certificates to remain ignored."
  }

  assert {
    condition     = try(azurerm_container_app.server.ingress[0].exposed_port, null) == null
    error_message = "Expected no separately exposed ingress port."
  }

  assert {
    condition     = length(azurerm_container_app.server.ingress[0].cors) == 0
    error_message = "Expected no ingress CORS policy."
  }

  assert {
    condition     = length(azurerm_container_app.server.ingress[0].ip_security_restriction) == 0
    error_message = "Expected no ingress IP security restrictions."
  }

  assert {
    condition = (
      length(azurerm_container_app.server.ingress[0].traffic_weight) == 1 &&
      one(azurerm_container_app.server.ingress[0].traffic_weight).latest_revision == true &&
      one(azurerm_container_app.server.ingress[0].traffic_weight).percentage == 100 &&
      (
        try(one(azurerm_container_app.server.ingress[0].traffic_weight).label, null) == null ? true :
        trimspace(one(azurerm_container_app.server.ingress[0].traffic_weight).label) == ""
      )
    )
    error_message = "Expected one unlabeled 100 percent latest-revision route."
  }
}
