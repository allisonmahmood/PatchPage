locals {
  app_secret_env = {
    DATABASE_URL                  = { secret = "database-url", value = local.database_url }
    PATCHPAGE_BOOTSTRAP_API_TOKEN = { secret = "bootstrap-token", value = local.bootstrap_api_token }
  }

  app_plain_env = merge({
    NODE_ENV                          = "production"
    PORT                              = "3000"
    PATCHPAGE_PUBLIC_BASE_URL         = var.public_base_url
    PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS = "false"
    PATCHPAGE_MAX_HTML_BYTES          = tostring(var.max_html_bytes)
    PATCHPAGE_DB_DRIVER               = "postgres"
    PATCHPAGE_STORAGE_DRIVER          = "azure-blob"
    AZURE_STORAGE_ACCOUNT             = azurerm_storage_account.drafts.name
    AZURE_STORAGE_CONTAINER           = azurerm_storage_container.drafts.name
    AZURE_CLIENT_ID                   = azurerm_user_assigned_identity.app.client_id
  }, var.trust_proxy == null ? {} : {
    PATCHPAGE_TRUST_PROXY = var.trust_proxy
  })
}

resource "azurerm_container_app" "server" {
  name                         = "patchpage-server"
  container_app_environment_id = azurerm_container_app_environment.patchpage.id
  resource_group_name          = azurerm_resource_group.patchpage.name
  revision_mode                = "Single"

  # Azure CLI owns the custom hostname and managed-certificate binding. In the
  # AzureRM schema custom_domain is computed under ingress, so ignoring only
  # that leaf is ineffective; ignoring ingress prevents a later update from
  # replacing the CLI-managed binding with Terraform's original ingress shape.
  lifecycle {
    ignore_changes = [ingress]
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.patchpage.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 3000
    transport                  = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  dynamic "secret" {
    for_each = local.app_secret_env
    content {
      name  = secret.value.secret
      value = secret.value.value
    }
  }

  template {
    min_replicas = 0
    max_replicas = 1

    container {
      name   = "server"
      image  = var.server_image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = local.app_plain_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.app_secret_env
        content {
          name        = env.key
          secret_name = env.value.secret
        }
      }
    }
  }
}
