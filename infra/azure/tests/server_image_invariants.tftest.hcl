mock_provider "azurerm" {}

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
}

run "seeds_managed_registry_name" {
  command = apply

  plan_options {
    target = [random_string.unique]
  }
}

run "allows_placeholder_for_registry_target_bootstrap" {
  command = plan

  plan_options {
    target = [azurerm_container_registry.patchpage]
  }
}

run "accepts_valid_observed_managed_digest" {
  command = plan

  variables {
    server_image = "acrpatchpageabc123.azurecr.io/patchpage-server@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }
}

run "rejects_quickstart_placeholder" {
  command = plan

  variables {
    server_image = "mcr.microsoft.com/k8se/quickstart:latest"
  }

  expect_failures = [azurerm_container_app.server]
}

run "rejects_mutable_release_tag" {
  command = plan

  variables {
    server_image = "registry.invalid/patchpage-server:release"
  }

  expect_failures = [azurerm_container_app.server]
}

run "rejects_uppercase_digest" {
  command = plan

  variables {
    server_image = "registry.invalid/patchpage-server@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  }

  expect_failures = [azurerm_container_app.server]
}

run "rejects_observed_wrong_registry" {
  command = plan

  variables {
    server_image = "other.azurecr.io/patchpage-server@sha256:4444444444444444444444444444444444444444444444444444444444444444"
  }

  expect_failures = [azurerm_container_app.server]
}

run "rejects_observed_wrong_registry_repository_and_format" {
  command = plan

  variables {
    server_image = "other.azurecr.io/team/other-server@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azurerm_container_app.server]
}

run "rejects_observed_wrong_repository" {
  command = plan

  variables {
    server_image = "acrpatchpageabc123.azurecr.io/other-server@sha256:2222222222222222222222222222222222222222222222222222222222222222"
  }

  expect_failures = [azurerm_container_app.server]
}

run "rejects_observed_wrong_format" {
  command = plan

  variables {
    server_image = "acrpatchpageabc123.azurecr.io/team/patchpage-server@sha256:3333333333333333333333333333333333333333333333333333333333333333"
  }

  expect_failures = [azurerm_container_app.server]
}
