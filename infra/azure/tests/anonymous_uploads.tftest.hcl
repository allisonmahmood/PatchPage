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

  # The cost posture in kill_switch.tf made five more computed ids reach
  # another resource's *configuration*, which is the condition the note above
  # describes: the Container App id now flows into a role definition, a role
  # assignment, a metric alert scope and the runbook body, and the Automation
  # account, webhook and action group ids flow into the action group and the
  # two alerts. Every suite that plans this configuration therefore has to mock
  # them well enough for the real azurerm validators, including the suites that
  # assert nothing about any of it. tests/cost_posture.tftest.hcl is where they
  # are actually asserted.
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

run "keeps_anonymous_uploads_disabled_by_default" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
  }

  assert {
    condition = anytrue([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting.name == "PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS" ? try(setting.value == "false", false) : false
    ])
    error_message = "Anonymous uploads must remain disabled by default in the Container App environment."
  }
}

run "wires_anonymous_upload_operator_opt_in" {
  command = plan

  variables {
    subscription_id         = "00000000-0000-0000-0000-000000000000"
    public_base_url         = "https://drafts.self-hoster.dev"
    allow_anonymous_uploads = true
  }

  assert {
    condition = anytrue([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting.name == "PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS" ? try(setting.value == "true", false) : false
    ])
    error_message = "The anonymous-upload operator setting must reach the Container App environment."
  }
}
