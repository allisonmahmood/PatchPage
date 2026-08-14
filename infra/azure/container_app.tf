locals {
  managed_registry_login_server = "${azurerm_container_registry.patchpage.name}.azurecr.io"

  # Create-time gate for the Container App image: managed ACR + patchpage-server +
  # lowercase SHA-256 digest, and never the quickstart placeholder.
  #
  # This predicate is a named local rather than an inline precondition expression
  # because plan-time `tofu test` cannot tell a precondition failure apart
  # from a postcondition failure on the same resource: `expect_failures` for
  # azurerm_container_app.server stays satisfied by the postcondition even if the
  # precondition is deleted. Naming it lets the guide harness statically pin the
  # precondition to this local, and lets server_image_invariants.tftest.hcl assert
  # the predicate directly through the server_image_is_managed_digest output.
  #
  # #73 retried this under OpenTofu, whose override_resource is per-address, and
  # the masking is still there: the postcondition reads a configured field, which
  # override_resource refuses, and the one route that does isolate the
  # precondition needs a `command = apply` run that prevent_destroy makes
  # impossible to tear down. tests/guide_commands_test.sh records the exact
  # errors next to the static check that remains the guard.
  #
  # Guard indexes with try() so malformed images fail the predicate instead of
  # raising Invalid index during expression evaluation.
  #
  # Conjunct-level coverage: the registry, repository, sha256-algorithm,
  # digest-length and lowercase-hex conjuncts are each pinned by a dedicated
  # predicate_rejects_* run in tests/server_image_invariants.tftest.hcl, so
  # dropping any one of them turns exactly that run red. The remaining four are
  # deliberately unpinnable and harmless, because none of them can widen what the
  # predicate accepts:
  #
  #   * The three structural length(split(...)) guards only stop an Invalid index
  #     from being raised while evaluating the branch below; try() would swallow
  #     that error into the same false the guards produce. Dropping one therefore
  #     cannot make a rejected image pass, only change which false it takes.
  #   * The quickstart-placeholder literal is already excluded by the digest
  #     structure the guards require (it carries no @digest), so it is a named
  #     early-out that documents intent rather than an independent gate.
  server_image_is_managed_digest = try(
    (
      var.server_image != "mcr.microsoft.com/k8se/quickstart:latest" &&
      length(split("@", var.server_image)) == 2 &&
      length(split("/", split("@", var.server_image)[0])) == 2 &&
      length(split(":", split("@", var.server_image)[1])) == 2
      ) ? (
      split("/", split("@", var.server_image)[0])[0] == local.managed_registry_login_server &&
      split("/", split("@", var.server_image)[0])[1] == "patchpage-server" &&
      split(":", split("@", var.server_image)[1])[0] == "sha256" &&
      length(split(":", split("@", var.server_image)[1])[1]) == 64 &&
      length(regexall("[^0-9a-f]", split(":", split("@", var.server_image)[1])[1])) == 0
    ) : false,
    false
  )

  app_secret_env = {
    DATABASE_URL                  = { secret = "database-url", value = local.database_url }
    PATCHPAGE_BOOTSTRAP_API_TOKEN = { secret = "bootstrap-token", value = local.bootstrap_api_token }
  }

  app_plain_env = merge({
    NODE_ENV                                             = "production"
    PORT                                                 = "3000"
    PATCHPAGE_PUBLIC_BASE_URL                            = var.public_base_url
    PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS                    = tostring(var.allow_anonymous_uploads)
    PATCHPAGE_MAX_HTML_BYTES                             = tostring(var.max_html_bytes)
    PATCHPAGE_PROTECTED_API_RATE_LIMIT_PER_MINUTE        = tostring(var.protected_api_rate_limit_per_minute)
    PATCHPAGE_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE = tostring(var.authenticated_upload_rate_limit_per_minute)
    PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE     = tostring(var.anonymous_create_rate_limit_per_minute)
    PATCHPAGE_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE         = tostring(var.draft_create_rate_limit_per_minute)
    PATCHPAGE_LIVE_DRAFTS_PER_TOKEN                      = tostring(var.live_drafts_per_token)
    PATCHPAGE_DB_DRIVER                                  = "postgres"
    PATCHPAGE_STORAGE_DRIVER                             = "azure-blob"
    AZURE_STORAGE_ACCOUNT                                = azurerm_storage_account.drafts.name
    AZURE_STORAGE_CONTAINER                              = azurerm_storage_container.drafts.name
    AZURE_CLIENT_ID                                      = azurerm_user_assigned_identity.app.client_id
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
  # replacing the CLI-managed binding with OpenTofu's original ingress shape.
  lifecycle {
    ignore_changes = [
      ingress,
      template[0].container[0].image,
    ]

    precondition {
      # Fail closed before create/update. Targeted bootstrap plans that exclude
      # this resource may still use the quickstart placeholder default.
      # The predicate lives in local.server_image_is_managed_digest so it stays
      # independently assertable; guide_commands_test.sh statically requires this
      # condition to be exactly that local.
      condition     = local.server_image_is_managed_digest
      error_message = "server_image must be an immutable patchpage-server digest in the managed Azure Container Registry; the quickstart placeholder cannot be deployed."
    }

    postcondition {
      condition = try(
        (
          length(self.template) == 1 &&
          length(self.template[0].container) == 1 &&
          length(split("@", self.template[0].container[0].image)) == 2 &&
          length(split("/", split("@", self.template[0].container[0].image)[0])) == 2 &&
          length(split(":", split("@", self.template[0].container[0].image)[1])) == 2
          ) ? (
          split("/", split("@", self.template[0].container[0].image)[0])[1] == "patchpage-server" ? (
            split("/", split("@", self.template[0].container[0].image)[0])[0] == local.managed_registry_login_server &&
            split(":", split("@", self.template[0].container[0].image)[1])[0] == "sha256" &&
            length(split(":", split("@", self.template[0].container[0].image)[1])[1]) == 64 &&
            length(regexall("[^0-9a-f]", split(":", split("@", self.template[0].container[0].image)[1])[1])) == 0
          ) : false
        ) : false,
        false
      )
      error_message = "The observed Container App image must remain an immutable patchpage-server digest in the managed Azure Container Registry."
    }

    postcondition {
      condition     = length(self.ingress) == 1
      error_message = "Container App must retain exactly one ingress configuration."
    }

    postcondition {
      condition     = try(self.ingress[0].external_enabled == true, false)
      error_message = "Container App ingress must remain external."
    }

    postcondition {
      condition     = try(self.ingress[0].allow_insecure_connections == false, false)
      error_message = "Container App ingress must keep insecure HTTP disabled."
    }

    postcondition {
      condition     = try(self.ingress[0].target_port == 3000, false)
      error_message = "Container App ingress must target server port 3000."
    }

    postcondition {
      condition     = try(lower(self.ingress[0].transport) == "auto", false)
      error_message = "Container App ingress transport must remain auto."
    }

    postcondition {
      condition = try(
        self.ingress[0].client_certificate_mode == null ? true : (
          trimspace(self.ingress[0].client_certificate_mode) == "" ||
          lower(trimspace(self.ingress[0].client_certificate_mode)) == "ignore"
        ),
        false
      )
      error_message = "Container App ingress must keep client certificates ignored."
    }

    postcondition {
      condition = try(
        self.ingress[0].exposed_port == null ||
        self.ingress[0].exposed_port == 0,
        false
      )
      error_message = "Container App ingress must not expose a separate port."
    }

    postcondition {
      condition     = try(length(self.ingress[0].cors) == 0, false)
      error_message = "Container App ingress must not enable a CORS policy."
    }

    postcondition {
      condition     = try(length(self.ingress[0].ip_security_restriction) == 0, false)
      error_message = "Container App ingress must not add IP security restrictions."
    }

    postcondition {
      condition = try(
        length(self.ingress[0].traffic_weight) == 1 &&
        one(self.ingress[0].traffic_weight).latest_revision == true &&
        one(self.ingress[0].traffic_weight).percentage == 100 &&
        (
          one(self.ingress[0].traffic_weight).label == null ? true :
          trimspace(one(self.ingress[0].traffic_weight).label) == ""
        ),
        false
      )
      error_message = "Container App ingress must route 100 percent of traffic through one unlabeled latest-revision rule."
    }
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
    client_certificate_mode    = "ignore"

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
    # STANDING INVARIANT: exactly one replica, min and max.
    #
    # This is not a capacity setting and it is not a cost setting -- it is a
    # correctness precondition for the rate limiter. The limiter counts
    # attempts in the server's own memory, so every per-minute limit above is
    # really per replica. Take PATCHPAGE_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE,
    # which is 10: at one replica it means ten creates a minute per token, at
    # two it silently means twenty, and at N it means 10N -- with no error
    # anywhere and nothing in a test to notice.
    #
    # PATCHPAGE_LIVE_DRAFTS_PER_TOKEN is not affected, and the difference is
    # the point: it is counted from the database, so it holds at any replica
    # count. Only the in-memory per-minute limits depend on this invariant.
    #
    # So the rule is: any change that raises max_replicas above 1 must, in the
    # same change, replace the in-memory limiter with a shared-store one.
    # Raising the count first and "doing the limiter next" is not a smaller
    # step -- it is a quota outage that looks like normal operation.
    #
    # min_replicas is 1 rather than 0 for a different reason: scale-to-zero
    # trades a cold start on the first request for a few dollars a month, and
    # the first request is very often a person opening a link somebody just
    # sent them. tests/cost_posture.tftest.hcl pins both numbers.
    min_replicas = 1
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
