# See tests/trust_proxy.tftest.hcl for why every computed id that flows into
# another resource's configuration has to be mocked well enough for the real
# azurerm validators, even in suites that assert nothing about them.
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

  mock_resource "azurerm_container_app" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.App/containerApps/ca-mock"
    }
  }

  mock_resource "azurerm_automation_account" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Automation/automationAccounts/aa-mock"
    }
  }

  mock_resource "azurerm_automation_webhook" {
    defaults = {
      id  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Automation/automationAccounts/aa-mock/webhooks/wh-mock"
      uri = "https://mock.webhook.automation.invalid/webhooks?token=mock"
    }
  }

  mock_resource "azurerm_role_definition" {
    defaults = {
      role_definition_resource_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-000000000002"
    }
  }

  mock_resource "azurerm_monitor_action_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Insights/actionGroups/ag-mock"
    }
  }
}

variables {
  server_image = "registry.invalid/patchpage-server@sha256:0000000000000000000000000000000000000000000000000000000000000000"
}

run "omits_analytics_by_default" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
  }

  assert {
    condition = length([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting if setting.name == "PATCHPAGE_POSTHOG_API_KEY"
    ]) == 0
    error_message = "The safe default must leave PATCHPAGE_POSTHOG_API_KEY unset — analytics off is the self-hosted posture."
  }

  assert {
    condition = length([
      for secret in azurerm_container_app.server.secret :
      secret if secret.name == "posthog-api-key"
    ]) == 0
    error_message = "No posthog-api-key secret may exist when no key is configured."
  }
}

run "wires_analytics_key_as_secret" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    posthog_api_key = "phc_mock_project_key"
  }

  assert {
    condition = anytrue([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting.name == "PATCHPAGE_POSTHOG_API_KEY" ? try(
        setting.secret_name == "posthog-api-key",
        false
      ) : false
    ])
    error_message = "A configured PostHog key must reach the Container App as a secret-backed env var."
  }

  assert {
    condition = length([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting if setting.name == "PATCHPAGE_POSTHOG_API_KEY" && try(setting.value != null, false)
    ]) == 0
    error_message = "The PostHog key must never appear as a plain env value."
  }
}
