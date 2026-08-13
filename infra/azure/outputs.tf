output "acr_login_server" {
  value = azurerm_container_registry.patchpage.login_server
}

output "acr_name" {
  value = azurerm_container_registry.patchpage.name
}

output "subscription_id" {
  value = var.subscription_id
}

output "resource_group_name" {
  value = azurerm_resource_group.patchpage.name
}

output "container_app_name" {
  value = azurerm_container_app.server.name
}

output "container_app_environment_name" {
  value = azurerm_container_app_environment.patchpage.name
}

output "container_app_fqdn" {
  value = azurerm_container_app.server.ingress[0].fqdn
}

output "container_app_url" {
  value = "https://${azurerm_container_app.server.ingress[0].fqdn}"
}

output "container_app_environment_static_ip" {
  value = azurerm_container_app_environment.patchpage.static_ip_address
}

output "custom_domain_verification_id" {
  sensitive = true
  value     = azurerm_container_app.server.custom_domain_verification_id
}

output "public_base_url" {
  value = var.public_base_url
}

output "custom_domain_hostname" {
  value = trimprefix(var.public_base_url, "https://")
}

output "storage_account_name" {
  value = azurerm_storage_account.drafts.name
}

output "postgres_server_fqdn" {
  value = azurerm_postgresql_flexible_server.patchpage.fqdn
}

output "app_identity_client_id" {
  value = azurerm_user_assigned_identity.app.client_id
}

output "bootstrap_api_token" {
  sensitive = true
  value     = local.bootstrap_api_token
}

# Test-only. Exposes the Container App create-time image gate so
# tests/server_image_invariants.tftest.hcl can assert the predicate itself, one
# conjunct at a time. Plan-time expect_failures on the Container App cannot
# distinguish the precondition from the postcondition, so without this the
# precondition could be weakened silently. Derived from var.server_image only.
output "server_image_is_managed_digest" {
  value = local.server_image_is_managed_digest
}

# The kill switch's two names, so the fire drill in README.md can be followed
# without guessing at them. Neither is sensitive: the capability is the webhook
# URI, which is deliberately not an output here or anywhere else.
output "kill_switch_automation_account_name" {
  value = azurerm_automation_account.kill_switch.name
}

output "kill_switch_runbook_name" {
  value = azurerm_automation_runbook.kill_switch.name
}
