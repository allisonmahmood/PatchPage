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

variables {
  server_image = "registry.invalid/patchpage-server@sha256:0000000000000000000000000000000000000000000000000000000000000000"
}

run "accepts_deployer_owned_https_origin" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
  }
}

run "rejects_maintainer_origin" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://post.patchyhq.com"
  }

  expect_failures = [var.public_base_url]
}

run "rejects_non_https_origin" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "http://drafts.self-hoster.dev"
  }

  expect_failures = [var.public_base_url]
}

run "rejects_url_with_path" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev/patchpage"
  }

  expect_failures = [var.public_base_url]
}

run "rejects_placeholder_origin" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://patchpage.your-domain.com"
  }

  expect_failures = [var.public_base_url]
}

run "rejects_example_configuration_origin" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://patchpage.your-domain.invalid"
  }

  expect_failures = [var.public_base_url]
}

run "rejects_home_arpa_origin" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://patchpage.home.arpa"
  }

  expect_failures = [var.public_base_url]
}
