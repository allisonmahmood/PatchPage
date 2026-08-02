mock_provider "azurerm" {}

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
          name  = "PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE"
          value = "5"
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
    anonymous_create_rate_limit_per_minute     = 10
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
          name  = "PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE"
          value = "10"
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

run "rejects_zero_anonymous_create_rate_limit" {
  command = plan

  variables {
    subscription_id                        = "00000000-0000-0000-0000-000000000000"
    public_base_url                        = "https://drafts.self-hoster.dev"
    anonymous_create_rate_limit_per_minute = 0
  }

  expect_failures = [var.anonymous_create_rate_limit_per_minute]
}

run "rejects_fractional_anonymous_create_rate_limit" {
  command = plan

  variables {
    subscription_id                        = "00000000-0000-0000-0000-000000000000"
    public_base_url                        = "https://drafts.self-hoster.dev"
    anonymous_create_rate_limit_per_minute = 1.5
  }

  expect_failures = [var.anonymous_create_rate_limit_per_minute]
}

run "rejects_too_large_anonymous_create_rate_limit" {
  command = plan

  variables {
    subscription_id                        = "00000000-0000-0000-0000-000000000000"
    public_base_url                        = "https://drafts.self-hoster.dev"
    anonymous_create_rate_limit_per_minute = 10001
  }

  expect_failures = [var.anonymous_create_rate_limit_per_minute]
}
