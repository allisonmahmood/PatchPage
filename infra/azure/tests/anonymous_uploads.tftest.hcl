mock_provider "azurerm" {}

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
