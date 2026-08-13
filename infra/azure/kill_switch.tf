# Circuit breaker, kill switch, and cost posture for the public instance.
#
# --- what this file is ------------------------------------------------------
#
# The service targets roughly $100/month. The circuit breaker is $200/month.
# When it trips, an automated, total, fail-closed kill switch takes the instance
# dark: serving and uploads both off, in one action, with no partial state.
#
# The kill switch is one named mechanism -- the Automation runbook
# "PatchPage-KillSwitch" -- reached through one action group. Two independent
# triggers point at that same action group:
#
#   1. Budget alert. azurerm_consumption_budget_subscription.circuit_breaker,
#      Actual (not Forecasted) spend, at 100% of the $200 monthly budget. Actual
#      spend is deliberate: it accepts Azure's cost-data lag (hours, sometimes
#      most of a day) in exchange for never going dark on a forecast that a
#      quiet afternoon would have falsified.
#   2. Egress tripwire. azurerm_monitor_metric_alert.egress_tripwire, on the
#      Container App metric `TxBytes` (portal name "Network Out Bytes",
#      namespace Microsoft.App/containerApps), Total aggregation over a rolling
#      P1D window evaluated every PT15M, threshold ~100 GiB. TxBytes is the
#      bytes the app actually put on the wire, which is the quantity that turns
#      into a bandwidth bill and the one a scraped-draft flood would move first.
#      It is near-real-time where the budget alert is not, which is the whole
#      reason there are two triggers rather than one.
#
# Either trigger alone fires the kill. Neither depends on the other, and the
# egress one is not derived from cost data, so a billing-pipeline stall cannot
# silence both.
#
# --- fail-closed, and why restore is genuinely operator-only ----------------
#
# The kill is the Container Apps stop operation, which terminates every replica
# and leaves the app runningStatus "Stopped". Serving and uploads are the same
# HTTP surface on the same ingress, so one stop takes both off; there is no
# read-only half-state to reason about.
#
# The Automation identity holds azurerm_role_definition.kill_switch, a custom
# role whose entire permission set is containerApps/read and
# containerApps/stop/action, assignable only at this one Container App. It has
# no start, no write, no delete, and no reach outside that resource. So "restore
# is an operator decision" is not a convention this file asks people to respect
# -- the automation is mechanically unable to bring the service back, and an
# operator with their own credentials is the only thing that can.
#
# `tofu apply` cannot silently restore it either: runningStatus is not a field
# this configuration manages, so a stopped app stays stopped across applies.
# See README.md for the restore procedure and the fire drill.
#
# --- standing invariants recorded here -------------------------------------
#
#   * No CDN and no reverse proxy at launch. The instance serves its own bytes,
#     which is exactly why an egress tripwire is load-bearing: there is no cache
#     layer between a hot draft and the bandwidth bill. Adding one is a decision
#     that has to revisit this file, because it changes what TxBytes means.
#   * No WAF, no bot-blocking, and no challenges or human-checks on draft URLs.
#     Draft links are share-a-link-never-be-found and agents must be able to
#     fetch a pasted link; the ingress postconditions in container_app.tf
#     already pin the absence of IP restrictions. Rate limits and expiry are the
#     abuse controls, not interrogation.
#   * Escalation lever order when the cheap layers are outrun: friction (rate
#     limits, quotas) -> money (raise the budget deliberately) -> expiry
#     (shorten the draft clock). Reaching for money before friction is how a
#     free service becomes an expensive one.
#   * Blob storage is LRS, not GRS (see variables.tf), with a 50 GiB total-size
#     alarm below. Drafts are cheap to re-publish and expire on a 90-day clock;
#     paying a geo-redundancy premium to protect them is not the trade this
#     service is making.
#   * Replicas are pinned min 1 / max 1 (see container_app.tf).

locals {
  # Container Apps stop operation, from the Microsoft.App resource provider.
  # POST {containerAppId}/stop?api-version=... returns 200 (stopped) or 202
  # (stop accepted); the runbook treats anything else as a failure to go dark.
  container_app_stop_api_version = "2025-01-01"

  # Notification thresholds on a consumption budget are percentages of the
  # budget amount, so the ~$100 target is expressed as its share of the $200
  # circuit breaker. Deriving it keeps the two numbers from drifting apart:
  # move the budget and the advisory notice moves with it.
  cost_target_threshold_percent = (var.monthly_cost_target_amount / var.monthly_budget_amount) * 100

  # An operator email is optional so a self-hoster can apply this stack without
  # inventing one. When it is unset both action groups still exist and still
  # fire -- the kill switch does not depend on anyone reading mail -- the
  # operator just learns about it from the Azure Monitor alert history instead.
  operator_alert_emails = var.operator_alert_email == null ? [] : [var.operator_alert_email]
}

# --- the kill switch itself --------------------------------------------------

resource "azurerm_automation_account" "kill_switch" {
  name                = "aa-patchpage-killswitch-${var.environment_name}"
  location            = azurerm_resource_group.patchpage.location
  resource_group_name = azurerm_resource_group.patchpage.name
  sku_name            = "Basic"

  identity {
    type = "SystemAssigned"
  }
}

# The whole privilege the kill switch holds. Two actions, one resource.
#
# The built-in alternative was Contributor scoped to the Container App, which
# would also let the automation delete the app, rewrite its image, or read its
# secrets -- a much larger blast radius for a mechanism whose entire job is to
# make one call. Writing the role out costs a dozen lines and makes the
# security story checkable by reading it.
#
# containerApps/start/action is deliberately absent. That omission is what turns
# "restore is an operator decision" from documentation into a permission.
resource "azurerm_role_definition" "kill_switch" {
  name        = "patchpage-kill-switch-${local.name_suffix}"
  scope       = azurerm_container_app.server.id
  description = "Lets the PatchPage kill switch stop the Container App, and nothing else. Deliberately carries no start action: restoring service is an operator decision."

  permissions {
    actions = [
      "Microsoft.App/containerApps/read",
      "Microsoft.App/containerApps/stop/action",
    ]
    not_actions = []
  }

  assignable_scopes = [azurerm_container_app.server.id]
}

resource "azurerm_role_assignment" "kill_switch_stop" {
  scope              = azurerm_container_app.server.id
  role_definition_id = azurerm_role_definition.kill_switch.role_definition_resource_id
  principal_id       = azurerm_automation_account.kill_switch.identity[0].principal_id
}

resource "azurerm_automation_runbook" "kill_switch" {
  name                    = "PatchPage-KillSwitch"
  location                = azurerm_resource_group.patchpage.location
  resource_group_name     = azurerm_resource_group.patchpage.name
  automation_account_name = azurerm_automation_account.kill_switch.name
  runbook_type            = "PowerShell"
  description             = "Total fail-closed kill switch: stops the PatchPage Container App, taking serving and uploads off together. Restoring service is an operator decision."

  # Verbose and progress streams stay off. A kill-switch job's output is read by
  # an operator during an incident and should say what happened and nothing
  # else; the guide's no-private-output rule applies here as much as to cmd/.
  log_verbose  = false
  log_progress = false

  content = templatefile("${path.module}/kill-switch-runbook.ps1.tftpl", {
    container_app_id = azurerm_container_app.server.id
    stop_api_version = local.container_app_stop_api_version
  })
}

# The action group's only way to reach the runbook. The URI is a capability:
# anyone holding it can fire the kill switch, which is why it is never an
# output and never printed. Firing the kill switch is not a privileged act in
# the sense that matters -- the worst a leaked URI buys is taking down a free
# service that the operator can restart -- but it still has an expiry, so
# rotation is a scheduled chore rather than a surprise. See README.md.
resource "azurerm_automation_webhook" "kill_switch" {
  name                    = "patchpage-kill-switch"
  resource_group_name     = azurerm_resource_group.patchpage.name
  automation_account_name = azurerm_automation_account.kill_switch.name
  runbook_name            = azurerm_automation_runbook.kill_switch.name
  expiry_time             = var.kill_switch_webhook_expiry
  enabled                 = true
}

# --- the one action every kill trigger points at ----------------------------

resource "azurerm_monitor_action_group" "kill_switch" {
  name                = "ag-patchpage-kill-switch-${var.environment_name}"
  resource_group_name = azurerm_resource_group.patchpage.name
  short_name          = "ppkill"

  automation_runbook_receiver {
    name                    = "fire-kill-switch"
    automation_account_id   = azurerm_automation_account.kill_switch.id
    runbook_name            = azurerm_automation_runbook.kill_switch.name
    webhook_resource_id     = azurerm_automation_webhook.kill_switch.id
    service_uri             = azurerm_automation_webhook.kill_switch.uri
    is_global_runbook       = false
    use_common_alert_schema = true
  }

  # Telling the operator is a courtesy, not a dependency. The kill fires whether
  # or not this receiver exists.
  dynamic "email_receiver" {
    for_each = local.operator_alert_emails
    content {
      name                    = "operator"
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }
}

# Notification only. Nothing wired here takes the service down: this is the
# group for "look at this soon", and keeping it separate from the kill group is
# what stops an advisory threshold from ever becoming an outage.
resource "azurerm_monitor_action_group" "operator_notice" {
  name                = "ag-patchpage-operator-notice-${var.environment_name}"
  resource_group_name = azurerm_resource_group.patchpage.name
  short_name          = "ppnotice"

  dynamic "email_receiver" {
    for_each = local.operator_alert_emails
    content {
      name                    = "operator"
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }
}

# --- trigger 1: the $200/month circuit breaker ------------------------------

resource "azurerm_consumption_budget_subscription" "circuit_breaker" {
  name            = "budget-patchpage-${var.environment_name}"
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = var.monthly_budget_amount
  time_grain      = "Monthly"

  time_period {
    start_date = var.budget_start_date
  }

  # The circuit breaker. Actual spend, at the full budget, wired to the kill
  # action group.
  notification {
    enabled        = true
    threshold      = 100
    threshold_type = "Actual"
    operator       = "GreaterThanOrEqualTo"
    contact_groups = [azurerm_monitor_action_group.kill_switch.id]
  }

  # The ~$100 target, as an advisory. Notification only, and pointed at the
  # notice group precisely so that passing the target can never take the service
  # down -- only passing the breaker can.
  notification {
    enabled        = true
    threshold      = local.cost_target_threshold_percent
    threshold_type = "Actual"
    operator       = "GreaterThanOrEqualTo"
    contact_groups = [azurerm_monitor_action_group.operator_notice.id]
  }
}

# --- trigger 2: the ~100 GiB/day egress tripwire ----------------------------

resource "azurerm_monitor_metric_alert" "egress_tripwire" {
  name                = "alert-patchpage-egress-tripwire-${var.environment_name}"
  resource_group_name = azurerm_resource_group.patchpage.name
  scopes              = [azurerm_container_app.server.id]
  description         = "Container App egress passed the daily tripwire. Fires the PatchPage kill switch."
  severity            = 0

  # A rolling day, re-evaluated every quarter hour. The window is a day because
  # the budget it protects is a monthly one and a day of unbounded egress is the
  # unit of damage worth stopping; the frequency is 15 minutes because being
  # near-real-time is this trigger's entire reason to exist alongside the budget
  # alert, which is not.
  window_size = "P1D"
  frequency   = "PT15M"

  # Never auto-resolve. Egress falling back under the line after the app is
  # stopped is not a recovery, it is the kill switch having worked, and an alert
  # that quietly closes itself invites the incident being marked over before an
  # operator has decided anything.
  auto_mitigate = false

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "TxBytes"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = var.egress_tripwire_bytes_per_day
  }

  action {
    action_group_id = azurerm_monitor_action_group.kill_switch.id
  }
}

# --- the blob size alarm ----------------------------------------------------
#
# Deliberately not a kill trigger. Stored bytes are a slow, cheap, and
# recoverable problem -- 50 GiB of blob is single-digit dollars a month, and the
# 90-day draft expiry is already draining it -- so the right response is an
# operator looking at what is accumulating, not an outage. The two things that
# do warrant going dark are runaway spend and runaway egress, and those have
# their own triggers above.
resource "azurerm_monitor_metric_alert" "blob_capacity" {
  name                = "alert-patchpage-blob-capacity-${var.environment_name}"
  resource_group_name = azurerm_resource_group.patchpage.name

  # Capacity metrics live on the blobServices child, not the account itself.
  scopes      = ["${azurerm_storage_account.drafts.id}/blobServices/default"]
  description = "Total PatchPage blob storage passed its size alarm. Notification only; the kill switch is not involved."
  severity    = 2

  # BlobCapacity is a slow metric with an hourly-at-best grain, so a daily
  # window is what it can actually fill. No dimension filter: splitting on
  # BlobType would alert per blob type, and the number that matters is the total.
  window_size = "P1D"
  frequency   = "PT1H"

  criteria {
    metric_namespace = "Microsoft.Storage/storageAccounts/blobServices"
    metric_name      = "BlobCapacity"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = var.blob_capacity_alarm_bytes
  }

  action {
    action_group_id = azurerm_monitor_action_group.operator_notice.id
  }
}
