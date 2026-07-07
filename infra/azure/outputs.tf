output "acr_login_server" {
  value = azurerm_container_registry.patchpage.login_server
}

output "acr_name" {
  value = azurerm_container_registry.patchpage.name
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
