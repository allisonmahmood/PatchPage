mock_provider "azurerm" {}

mock_provider "random" {}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000000"
  public_base_url = "https://drafts.self-hoster.dev"
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
      try(one(azurerm_container_app.server.ingress[0].traffic_weight).label, null) == null &&
      try(one(azurerm_container_app.server.ingress[0].traffic_weight).revision_suffix, null) == null
    )
    error_message = "Expected one unlabeled 100 percent latest-revision route."
  }
}
