mock_provider "azurerm" {}

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
