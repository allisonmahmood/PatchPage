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

run "wires_default_rate_limits" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
  }

  assert {
    condition = alltrue([
      for expected in [
        {
          name  = "PATCHPAGE_PROTECTED_API_RATE_LIMIT_PER_MINUTE"
          value = "60"
        },
        {
          name  = "PATCHPAGE_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE"
          value = "20"
        },
        {
          name  = "PATCHPAGE_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE"
          value = "5"
        },
        {
          name  = "PATCHPAGE_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE"
          value = "10"
        },
        {
          name  = "PATCHPAGE_REPORT_RATE_LIMIT_PER_MINUTE"
          value = "10"
        },
        {
          name  = "PATCHPAGE_LIVE_DRAFTS_PER_TOKEN"
          value = "1000"
        }
        ] : anytrue([
          for setting in azurerm_container_app.server.template[0].container[0].env :
          setting.name == expected.name ? try(setting.value == expected.value, false) : false
      ])
    ])
    error_message = "Default rate-limit values must match the server defaults and be wired into the Container App environment."
  }
}

run "wires_custom_rate_limits" {
  command = plan

  variables {
    subscription_id                            = "00000000-0000-0000-0000-000000000000"
    public_base_url                            = "https://drafts.self-hoster.dev"
    protected_api_rate_limit_per_minute        = 120
    authenticated_upload_rate_limit_per_minute = 40
    self_service_mint_rate_limit_per_minute    = 10
    draft_create_rate_limit_per_minute         = 25
    report_rate_limit_per_minute               = 30
    live_drafts_per_token                      = 50
  }

  assert {
    condition = alltrue([
      for expected in [
        {
          name  = "PATCHPAGE_PROTECTED_API_RATE_LIMIT_PER_MINUTE"
          value = "120"
        },
        {
          name  = "PATCHPAGE_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE"
          value = "40"
        },
        {
          name  = "PATCHPAGE_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE"
          value = "10"
        },
        {
          name  = "PATCHPAGE_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE"
          value = "25"
        },
        {
          name  = "PATCHPAGE_REPORT_RATE_LIMIT_PER_MINUTE"
          value = "30"
        },
        {
          name  = "PATCHPAGE_LIVE_DRAFTS_PER_TOKEN"
          value = "50"
        }
        ] : anytrue([
          for setting in azurerm_container_app.server.template[0].container[0].env :
          setting.name == expected.name ? try(setting.value == expected.value, false) : false
      ])
    ])
    error_message = "Custom rate-limit values must be wired into the Container App environment."
  }
}

run "rejects_zero_protected_api_rate_limit" {
  command = plan

  variables {
    subscription_id                     = "00000000-0000-0000-0000-000000000000"
    public_base_url                     = "https://drafts.self-hoster.dev"
    protected_api_rate_limit_per_minute = 0
  }

  expect_failures = [var.protected_api_rate_limit_per_minute]
}

run "rejects_fractional_protected_api_rate_limit" {
  command = plan

  variables {
    subscription_id                     = "00000000-0000-0000-0000-000000000000"
    public_base_url                     = "https://drafts.self-hoster.dev"
    protected_api_rate_limit_per_minute = 1.5
  }

  expect_failures = [var.protected_api_rate_limit_per_minute]
}

run "rejects_too_large_protected_api_rate_limit" {
  command = plan

  variables {
    subscription_id                     = "00000000-0000-0000-0000-000000000000"
    public_base_url                     = "https://drafts.self-hoster.dev"
    protected_api_rate_limit_per_minute = 10001
  }

  expect_failures = [var.protected_api_rate_limit_per_minute]
}

run "rejects_zero_authenticated_upload_rate_limit" {
  command = plan

  variables {
    subscription_id                            = "00000000-0000-0000-0000-000000000000"
    public_base_url                            = "https://drafts.self-hoster.dev"
    authenticated_upload_rate_limit_per_minute = 0
  }

  expect_failures = [var.authenticated_upload_rate_limit_per_minute]
}

run "rejects_fractional_authenticated_upload_rate_limit" {
  command = plan

  variables {
    subscription_id                            = "00000000-0000-0000-0000-000000000000"
    public_base_url                            = "https://drafts.self-hoster.dev"
    authenticated_upload_rate_limit_per_minute = 1.5
  }

  expect_failures = [var.authenticated_upload_rate_limit_per_minute]
}

run "rejects_too_large_authenticated_upload_rate_limit" {
  command = plan

  variables {
    subscription_id                            = "00000000-0000-0000-0000-000000000000"
    public_base_url                            = "https://drafts.self-hoster.dev"
    authenticated_upload_rate_limit_per_minute = 10001
  }

  expect_failures = [var.authenticated_upload_rate_limit_per_minute]
}

run "rejects_zero_self_service_mint_rate_limit" {
  command = plan

  variables {
    subscription_id                         = "00000000-0000-0000-0000-000000000000"
    public_base_url                         = "https://drafts.self-hoster.dev"
    self_service_mint_rate_limit_per_minute = 0
  }

  expect_failures = [var.self_service_mint_rate_limit_per_minute]
}

run "rejects_fractional_self_service_mint_rate_limit" {
  command = plan

  variables {
    subscription_id                         = "00000000-0000-0000-0000-000000000000"
    public_base_url                         = "https://drafts.self-hoster.dev"
    self_service_mint_rate_limit_per_minute = 1.5
  }

  expect_failures = [var.self_service_mint_rate_limit_per_minute]
}

run "rejects_too_large_self_service_mint_rate_limit" {
  command = plan

  variables {
    subscription_id                         = "00000000-0000-0000-0000-000000000000"
    public_base_url                         = "https://drafts.self-hoster.dev"
    self_service_mint_rate_limit_per_minute = 10001
  }

  expect_failures = [var.self_service_mint_rate_limit_per_minute]
}

run "rejects_zero_draft_create_rate_limit" {
  command = plan

  variables {
    subscription_id                    = "00000000-0000-0000-0000-000000000000"
    public_base_url                    = "https://drafts.self-hoster.dev"
    draft_create_rate_limit_per_minute = 0
  }

  expect_failures = [var.draft_create_rate_limit_per_minute]
}

run "rejects_fractional_draft_create_rate_limit" {
  command = plan

  variables {
    subscription_id                    = "00000000-0000-0000-0000-000000000000"
    public_base_url                    = "https://drafts.self-hoster.dev"
    draft_create_rate_limit_per_minute = 1.5
  }

  expect_failures = [var.draft_create_rate_limit_per_minute]
}

run "rejects_too_large_draft_create_rate_limit" {
  command = plan

  variables {
    subscription_id                    = "00000000-0000-0000-0000-000000000000"
    public_base_url                    = "https://drafts.self-hoster.dev"
    draft_create_rate_limit_per_minute = 10001
  }

  expect_failures = [var.draft_create_rate_limit_per_minute]
}

run "rejects_zero_report_rate_limit" {
  command = plan

  variables {
    subscription_id              = "00000000-0000-0000-0000-000000000000"
    public_base_url              = "https://drafts.self-hoster.dev"
    report_rate_limit_per_minute = 0
  }

  expect_failures = [var.report_rate_limit_per_minute]
}

run "rejects_fractional_report_rate_limit" {
  command = plan

  variables {
    subscription_id              = "00000000-0000-0000-0000-000000000000"
    public_base_url              = "https://drafts.self-hoster.dev"
    report_rate_limit_per_minute = 1.5
  }

  expect_failures = [var.report_rate_limit_per_minute]
}

run "rejects_too_large_report_rate_limit" {
  command = plan

  variables {
    subscription_id              = "00000000-0000-0000-0000-000000000000"
    public_base_url              = "https://drafts.self-hoster.dev"
    report_rate_limit_per_minute = 10001
  }

  expect_failures = [var.report_rate_limit_per_minute]
}

run "rejects_zero_live_drafts_per_token" {
  command = plan

  variables {
    subscription_id       = "00000000-0000-0000-0000-000000000000"
    public_base_url       = "https://drafts.self-hoster.dev"
    live_drafts_per_token = 0
  }

  expect_failures = [var.live_drafts_per_token]
}

run "rejects_fractional_live_drafts_per_token" {
  command = plan

  variables {
    subscription_id       = "00000000-0000-0000-0000-000000000000"
    public_base_url       = "https://drafts.self-hoster.dev"
    live_drafts_per_token = 1.5
  }

  expect_failures = [var.live_drafts_per_token]
}

run "rejects_too_large_live_drafts_per_token" {
  command = plan

  variables {
    subscription_id       = "00000000-0000-0000-0000-000000000000"
    public_base_url       = "https://drafts.self-hoster.dev"
    live_drafts_per_token = 1000001
  }

  expect_failures = [var.live_drafts_per_token]
}
