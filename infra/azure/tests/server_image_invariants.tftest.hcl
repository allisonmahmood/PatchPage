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

  assert {
    condition     = output.server_image_is_managed_digest
    error_message = "The create-time server_image predicate must accept a managed patchpage-server digest."
  }
}

# The rejects_* runs below prove the Container App fails closed, but plan-time
# expect_failures cannot tell the precondition apart from the postcondition on the
# same resource: deleting the precondition alone leaves them green. These runs
# assert local.server_image_is_managed_digest directly instead. The registry target
# keeps azurerm_container_app.server out of the plan so the precondition cannot be
# the thing that fails, leaving the predicate itself under test.
run "predicate_rejects_quickstart_placeholder" {
  command = plan

  plan_options {
    target = [azurerm_container_registry.patchpage]
  }

  variables {
    server_image = "mcr.microsoft.com/k8se/quickstart:latest"
  }

  assert {
    condition     = output.server_image_is_managed_digest == false
    error_message = "The create-time server_image predicate must reject the quickstart placeholder."
  }
}

run "predicate_rejects_mutable_release_tag" {
  command = plan

  plan_options {
    target = [azurerm_container_registry.patchpage]
  }

  variables {
    server_image = "registry.invalid/patchpage-server:release"
  }

  assert {
    condition     = output.server_image_is_managed_digest == false
    error_message = "The create-time server_image predicate must reject a mutable release tag."
  }
}

run "predicate_rejects_uppercase_digest" {
  command = plan

  plan_options {
    target = [azurerm_container_registry.patchpage]
  }

  variables {
    server_image = "registry.invalid/patchpage-server@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  }

  assert {
    condition     = output.server_image_is_managed_digest == false
    error_message = "The create-time server_image predicate must reject an uppercase digest."
  }
}

run "predicate_rejects_wrong_registry" {
  command = plan

  plan_options {
    target = [azurerm_container_registry.patchpage]
  }

  variables {
    server_image = "other.azurecr.io/patchpage-server@sha256:4444444444444444444444444444444444444444444444444444444444444444"
  }

  assert {
    condition     = output.server_image_is_managed_digest == false
    error_message = "The create-time server_image predicate must reject an unmanaged registry."
  }
}

run "predicate_rejects_wrong_repository" {
  command = plan

  plan_options {
    target = [azurerm_container_registry.patchpage]
  }

  variables {
    server_image = "acrpatchpageabc123.azurecr.io/other-server@sha256:2222222222222222222222222222222222222222222222222222222222222222"
  }

  assert {
    condition     = output.server_image_is_managed_digest == false
    error_message = "The create-time server_image predicate must reject a foreign repository."
  }
}

run "predicate_rejects_nested_repository_path" {
  command = plan

  plan_options {
    target = [azurerm_container_registry.patchpage]
  }

  variables {
    server_image = "acrpatchpageabc123.azurecr.io/team/patchpage-server@sha256:3333333333333333333333333333333333333333333333333333333333333333"
  }

  assert {
    condition     = output.server_image_is_managed_digest == false
    error_message = "The create-time server_image predicate must reject a nested repository path."
  }
}

run "predicate_rejects_short_digest" {
  command = plan

  plan_options {
    target = [azurerm_container_registry.patchpage]
  }

  variables {
    server_image = "acrpatchpageabc123.azurecr.io/patchpage-server@sha256:abc123"
  }

  assert {
    condition     = output.server_image_is_managed_digest == false
    error_message = "The create-time server_image predicate must reject a truncated digest."
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
