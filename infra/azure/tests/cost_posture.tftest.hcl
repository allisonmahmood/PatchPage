# The circuit breaker, the kill switch, and the cost posture around them.
#
# Per the spec's testing decisions, this automation is validated by static
# assertion over the infrastructure code -- there is no runtime test that fires
# a real kill switch, and there could not honestly be one at this stage.
#
# The mock_provider preamble follows the same rule as every other suite here:
# OpenTofu resolves mocked computed attributes during plan, so any attribute
# that flows into *another* resource's configuration has to be well-formed
# enough for the real azurerm validators. That set grew with this file --
# the Container App id now reaches a role definition, a role assignment, a
# metric alert scope and the runbook body; the Automation account, webhook and
# action group ids reach the action group and the alerts.
mock_provider "azurerm" {
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.OperationalInsights/workspaces/log-mock"
    }
  }

  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.App/managedEnvironments/cae-mock"
    }
  }

  mock_resource "azurerm_container_registry" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ContainerRegistry/registries/acrmock"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Storage/storageAccounts/stmock"
    }
  }

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-mock"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-mock"
      principal_id = "00000000-0000-0000-0000-000000000001"
    }
  }

  mock_resource "azurerm_container_app" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.App/containerApps/ca-mock"
    }
  }

  mock_resource "azurerm_automation_account" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Automation/automationAccounts/aa-mock"
    }
  }

  mock_resource "azurerm_automation_webhook" {
    defaults = {
      id  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Automation/automationAccounts/aa-mock/webhooks/wh-mock"
      uri = "https://mock.webhook.automation.invalid/webhooks?token=mock"
    }
  }

  mock_resource "azurerm_role_definition" {
    defaults = {
      role_definition_resource_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-000000000002"
    }
  }

  mock_resource "azurerm_monitor_action_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Insights/actionGroups/ag-mock"
    }
  }
}

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
  server_image    = "acrpatchpageabc123.azurecr.io/patchpage-server@sha256:0000000000000000000000000000000000000000000000000000000000000000"
}

# --- the standing single-replica invariant ----------------------------------

run "pins_the_server_to_exactly_one_replica" {
  command = plan

  # Both bounds, asserted separately, because they fail for different reasons.
  # max above 1 is the correctness bug: the rate limiter counts in one
  # process's memory, so N replicas silently multiply every per-minute limit by
  # N. min below 1 is only a latency and cost trade, but it is the one that
  # quietly returns if someone reaches for scale-to-zero to shave a few dollars.
  assert {
    condition     = azurerm_container_app.server.template[0].max_replicas == 1
    error_message = "Expected max_replicas to stay pinned at 1; raising it requires replacing the in-memory rate limiter with a shared-store one in the same change."
  }

  assert {
    condition     = azurerm_container_app.server.template[0].min_replicas == 1
    error_message = "Expected min_replicas to stay pinned at 1."
  }
}

# --- blob storage cost posture ----------------------------------------------

run "defaults_blob_storage_to_local_redundancy" {
  command = plan

  assert {
    condition     = azurerm_storage_account.drafts.account_replication_type == "LRS"
    error_message = "Expected locally redundant blob storage by default."
  }
}

run "alarms_on_total_blob_size" {
  command = plan

  assert {
    condition     = azurerm_monitor_metric_alert.blob_capacity.criteria[0].metric_namespace == "Microsoft.Storage/storageAccounts/blobServices"
    error_message = "Expected the blob size alarm to read the blobServices metric namespace, which is where capacity metrics live."
  }

  assert {
    condition     = azurerm_monitor_metric_alert.blob_capacity.criteria[0].metric_name == "BlobCapacity"
    error_message = "Expected the blob size alarm to read BlobCapacity."
  }

  assert {
    condition     = azurerm_monitor_metric_alert.blob_capacity.criteria[0].aggregation == "Average"
    error_message = "Expected BlobCapacity to be read with its Average aggregation."
  }

  # 50 GiB.
  assert {
    condition = (
      azurerm_monitor_metric_alert.blob_capacity.criteria[0].operator == "GreaterThan" &&
      azurerm_monitor_metric_alert.blob_capacity.criteria[0].threshold == 53687091200
    )
    error_message = "Expected the blob size alarm to fire above 50 GiB."
  }

  # Splitting on BlobType would alert per blob type; the number that matters is
  # the account total.
  assert {
    condition     = length(azurerm_monitor_metric_alert.blob_capacity.criteria[0].dimension) == 0
    error_message = "Expected the blob size alarm to read total capacity rather than splitting on a dimension."
  }

  assert {
    condition     = one(azurerm_monitor_metric_alert.blob_capacity.scopes) == "${azurerm_storage_account.drafts.id}/blobServices/default"
    error_message = "Expected the blob size alarm to be scoped to the drafts account's blob service."
  }
}

# --- the kill switch is total and fail-closed -------------------------------

run "kill_switch_stops_the_server_and_cannot_start_it" {
  command = plan

  # The whole permission set. Asserted as an exact list rather than a
  # "contains", because what makes this fail-closed is what is *absent*: a
  # start action here would turn the restore decision back into something the
  # automation could take on its own.
  assert {
    condition = tolist(azurerm_role_definition.kill_switch.permissions[0].actions) == tolist([
      "Microsoft.App/containerApps/read",
      "Microsoft.App/containerApps/stop/action",
    ])
    error_message = "Expected the kill switch role to carry exactly read and stop, and in particular no start action."
  }

  assert {
    condition     = length(azurerm_role_definition.kill_switch.permissions[0].not_actions) == 0
    error_message = "Expected the kill switch role to need no not_actions, since it grants only two."
  }

  assert {
    condition     = azurerm_automation_runbook.kill_switch.runbook_type == "PowerShell72"
    error_message = "Expected the kill switch runbook to run on PowerShell 7.2 rather than the legacy 5.1 runtime."
  }

  # The module the runbook cannot run without, imported explicitly rather than
  # inherited from whatever the Automation account happens to ship. Relying on
  # the defaults fails in the worst possible way: not at apply, but at the
  # moment the kill switch is asked to run, with both triggers firing into an
  # erroring job while the instance stays up and keeps spending.
  assert {
    condition     = azurerm_automation_powershell72_module.az_accounts.name == "Az.Accounts"
    error_message = "Expected Az.Accounts to be imported explicitly; Connect-AzAccount and Invoke-AzRestMethod both come from it."
  }

  assert {
    condition     = azurerm_automation_powershell72_module.az_accounts.automation_account_id == azurerm_automation_account.kill_switch.id
    error_message = "Expected Az.Accounts to be imported into the kill switch Automation account."
  }

  # Pinned to an exact published version, so the import either succeeds at apply
  # or fails loudly there.
  assert {
    condition     = strcontains(azurerm_automation_powershell72_module.az_accounts.module_link[0].uri, "/Az.Accounts/5.5.2")
    error_message = "Expected the Az.Accounts import to pin an exact PowerShell Gallery version."
  }

  # The runbook calls the Container Apps stop operation and never the start one.
  assert {
    condition     = strcontains(azurerm_automation_runbook.kill_switch.content, "/stop?api-version=")
    error_message = "Expected the kill switch runbook to call the Container Apps stop operation."
  }

  assert {
    condition     = strcontains(azurerm_automation_runbook.kill_switch.content, "2025-01-01")
    error_message = "Expected the kill switch runbook to pin the Container Apps stop api-version."
  }

  assert {
    condition     = !strcontains(azurerm_automation_runbook.kill_switch.content, "/start?api-version=")
    error_message = "Expected the kill switch runbook never to call the Container Apps start operation; restoring service is an operator decision."
  }

  # A managed identity, not a stored credential.
  assert {
    condition     = strcontains(azurerm_automation_runbook.kill_switch.content, "Connect-AzAccount -Identity")
    error_message = "Expected the kill switch runbook to authenticate as the Automation account's managed identity."
  }

  assert {
    condition     = azurerm_automation_account.kill_switch.identity[0].type == "SystemAssigned"
    error_message = "Expected the Automation account to carry a system-assigned identity, so no secret has to be stored for the kill switch."
  }

  # Verbose and progress streams stay off: a kill-switch job's output is read
  # during an incident and the guide's no-private-output rule applies to it.
  assert {
    condition = (
      azurerm_automation_runbook.kill_switch.log_verbose == false &&
      azurerm_automation_runbook.kill_switch.log_progress == false
    )
    error_message = "Expected the kill switch runbook to keep verbose and progress logging off."
  }

  assert {
    condition     = azurerm_automation_webhook.kill_switch.enabled == true
    error_message = "Expected the kill switch webhook to be enabled; a disabled one leaves both triggers wired to nothing."
  }

  assert {
    condition     = azurerm_automation_webhook.kill_switch.runbook_name == azurerm_automation_runbook.kill_switch.name
    error_message = "Expected the kill switch webhook to invoke the kill switch runbook."
  }

  assert {
    condition     = azurerm_monitor_action_group.kill_switch.automation_runbook_receiver[0].runbook_name == azurerm_automation_runbook.kill_switch.name
    error_message = "Expected the kill action group to invoke the kill switch runbook."
  }
}

# --- what the kill switch is pointed at, pinned by address ------------------
#
# Same problem, and same remedy, as the management-lock scopes in
# persistent_data_invariants.tftest.hcl. Under the per-type mock_resource
# defaults above, every azurerm_container_app mocks to one id and every
# azurerm_monitor_action_group mocks to another, so "the role is scoped to the
# Container App id" or "the alert fires the kill action group" would hold for a
# resource wired to any container app, and -- far more importantly -- for an
# alert wired to the *notice* action group instead of the kill one.
#
# override_resource is per address. Giving the two action groups ids that
# differ from each other, and the Container App an id that appears nowhere
# else, makes each assertion below satisfiable only by the exact wiring it
# names. Pointing the egress tripwire at the notice group, or the advisory
# budget notification at the kill group, turns the matching run red.

run "both_triggers_fire_the_one_kill_action" {
  command = plan

  override_resource {
    target = azurerm_container_app.server
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.App/containerApps/ca-distinct"
    }
  }

  override_resource {
    target = azurerm_monitor_action_group.kill_switch
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.Insights/actionGroups/ag-kill-distinct"
    }
  }

  override_resource {
    target = azurerm_monitor_action_group.operator_notice
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.Insights/actionGroups/ag-notice-distinct"
    }
  }

  # Trigger 1: the circuit breaker, at 100% of an actual-spend budget.
  assert {
    condition = length([
      for notification in azurerm_consumption_budget_subscription.circuit_breaker.notification : notification
      if notification.threshold == 100 &&
      notification.threshold_type == "Actual" &&
      notification.operator == "GreaterThanOrEqualTo" &&
      notification.enabled &&
      one(notification.contact_groups) == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.Insights/actionGroups/ag-kill-distinct"
    ]) == 1
    error_message = "Expected exactly one budget notification firing the kill action group at 100 percent of actual spend."
  }

  # Trigger 2: the egress tripwire.
  assert {
    condition     = one([for action in azurerm_monitor_metric_alert.egress_tripwire.action : action.action_group_id]) == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.Insights/actionGroups/ag-kill-distinct"
    error_message = "Expected the egress tripwire to fire the kill action group."
  }

  # The two advisory paths must NOT reach the kill group. This is the assertion
  # that makes the separation real rather than decorative.
  assert {
    condition = length([
      for notification in azurerm_consumption_budget_subscription.circuit_breaker.notification : notification
      if notification.threshold == 50 &&
      one(notification.contact_groups) == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.Insights/actionGroups/ag-notice-distinct"
    ]) == 1
    error_message = "Expected the cost-target notification to reach the notice group only; crossing the target must never take the service down."
  }

  assert {
    condition     = one([for action in azurerm_monitor_metric_alert.blob_capacity.action : action.action_group_id]) == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.Insights/actionGroups/ag-notice-distinct"
    error_message = "Expected the blob size alarm to notify only; it must not fire the kill switch."
  }

  # The kill switch's privilege, and the runbook's target, are pinned to this
  # exact Container App rather than to whatever app the mock happened to make.
  assert {
    condition     = azurerm_role_definition.kill_switch.scope == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.App/containerApps/ca-distinct"
    error_message = "Expected the kill switch role to be defined at the Container App itself."
  }

  assert {
    condition     = one(azurerm_role_definition.kill_switch.assignable_scopes) == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.App/containerApps/ca-distinct"
    error_message = "Expected the kill switch role to be assignable only at the Container App itself."
  }

  assert {
    condition     = azurerm_role_assignment.kill_switch_stop.scope == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.App/containerApps/ca-distinct"
    error_message = "Expected the kill switch role assignment to be scoped to the Container App itself."
  }

  assert {
    condition     = strcontains(azurerm_automation_runbook.kill_switch.content, "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.App/containerApps/ca-distinct")
    error_message = "Expected the kill switch runbook body to target this Container App."
  }

  assert {
    condition     = one(azurerm_monitor_metric_alert.egress_tripwire.scopes) == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wiring/providers/Microsoft.App/containerApps/ca-distinct"
    error_message = "Expected the egress tripwire to measure this Container App."
  }
}

# --- the numbers -------------------------------------------------------------

run "sets_the_circuit_breaker_at_two_hundred_a_month" {
  command = plan

  assert {
    condition     = azurerm_consumption_budget_subscription.circuit_breaker.amount == 200
    error_message = "Expected a 200 per month circuit breaker."
  }

  assert {
    condition     = azurerm_consumption_budget_subscription.circuit_breaker.time_grain == "Monthly"
    error_message = "Expected the budget to reset monthly."
  }

  assert {
    condition     = azurerm_consumption_budget_subscription.circuit_breaker.subscription_id == "/subscriptions/00000000-0000-0000-0000-000000000000"
    error_message = "Expected the budget to cover the whole deployment subscription."
  }

  # Every notification reads actual spend. Forecasted spend was rejected: the
  # spec accepts cost-data lag rather than going dark on a projection.
  assert {
    condition = alltrue([
      for notification in azurerm_consumption_budget_subscription.circuit_breaker.notification :
      notification.threshold_type == "Actual"
    ])
    error_message = "Expected every budget notification to read actual spend rather than a forecast."
  }
}

run "sets_the_egress_tripwire_at_a_hundred_gibibytes_a_day" {
  command = plan

  assert {
    condition     = azurerm_monitor_metric_alert.egress_tripwire.criteria[0].metric_namespace == "Microsoft.App/containerApps"
    error_message = "Expected the egress tripwire to read a Container App metric."
  }

  # TxBytes is the portal's "Network Out Bytes": what the app actually put on
  # the wire, which is the quantity that becomes a bandwidth bill.
  assert {
    condition     = azurerm_monitor_metric_alert.egress_tripwire.criteria[0].metric_name == "TxBytes"
    error_message = "Expected the egress tripwire to read TxBytes."
  }

  assert {
    condition     = azurerm_monitor_metric_alert.egress_tripwire.criteria[0].aggregation == "Total"
    error_message = "Expected egress to be summed over the window rather than averaged."
  }

  # 100 GiB.
  assert {
    condition = (
      azurerm_monitor_metric_alert.egress_tripwire.criteria[0].operator == "GreaterThan" &&
      azurerm_monitor_metric_alert.egress_tripwire.criteria[0].threshold == 107374182400
    )
    error_message = "Expected the egress tripwire to fire above 100 GiB."
  }

  # A rolling day, re-evaluated every quarter hour: being near-real-time is
  # this trigger's whole reason to exist next to the lagging circuit breaker.
  assert {
    condition     = azurerm_monitor_metric_alert.egress_tripwire.window_size == "P1D"
    error_message = "Expected the egress tripwire to measure a rolling day."
  }

  assert {
    condition     = azurerm_monitor_metric_alert.egress_tripwire.frequency == "PT15M"
    error_message = "Expected the egress tripwire to be evaluated every 15 minutes."
  }

  # Egress falling back under the line after the app is stopped is the kill
  # switch having worked, not a recovery.
  assert {
    condition     = azurerm_monitor_metric_alert.egress_tripwire.auto_mitigate == false
    error_message = "Expected the egress tripwire never to auto-resolve."
  }

  assert {
    condition     = azurerm_monitor_metric_alert.egress_tripwire.severity == 0
    error_message = "Expected the egress tripwire to carry the highest severity."
  }
}

# --- the guardrails are sizeable without being re-plumbed -------------------

run "supports_a_self_hosters_own_thresholds" {
  command = plan

  variables {
    monthly_circuit_breaker_amount = 40
    monthly_cost_target_amount     = 10
    egress_tripwire_bytes_per_day  = 10737418240
    blob_capacity_alarm_bytes      = 5368709120
    storage_replication_type       = "ZRS"
    operator_alert_email           = "ops@self-hoster.dev"
  }

  assert {
    condition     = azurerm_consumption_budget_subscription.circuit_breaker.amount == 40
    error_message = "Expected the configured budget amount."
  }

  # The advisory threshold is derived, not a second hand-kept number: 10 of 40
  # is 25 percent.
  assert {
    condition = length([
      for notification in azurerm_consumption_budget_subscription.circuit_breaker.notification : notification
      if notification.threshold == 25
    ]) == 1
    error_message = "Expected the cost-target notification to track the budget amount rather than a separately maintained percentage."
  }

  assert {
    condition     = azurerm_monitor_metric_alert.egress_tripwire.criteria[0].threshold == 10737418240
    error_message = "Expected the configured egress tripwire threshold."
  }

  assert {
    condition     = azurerm_monitor_metric_alert.blob_capacity.criteria[0].threshold == 5368709120
    error_message = "Expected the configured blob size alarm threshold."
  }

  assert {
    condition     = azurerm_storage_account.drafts.account_replication_type == "ZRS"
    error_message = "Expected a self-hoster to still be able to choose their own redundancy."
  }

  # An operator address reaches both groups: the one that tells them the
  # service went dark, and the one that tells them it is heading that way.
  assert {
    condition = (
      length(azurerm_monitor_action_group.kill_switch.email_receiver) == 1 &&
      azurerm_monitor_action_group.kill_switch.email_receiver[0].email_address == "ops@self-hoster.dev"
    )
    error_message = "Expected the configured operator address on the kill action group."
  }

  assert {
    condition = (
      length(azurerm_monitor_action_group.operator_notice.email_receiver) == 1 &&
      azurerm_monitor_action_group.operator_notice.email_receiver[0].email_address == "ops@self-hoster.dev"
    )
    error_message = "Expected the configured operator address on the notice action group."
  }
}

run "fires_the_kill_switch_with_no_operator_address_configured" {
  command = plan

  # The kill switch must not depend on anyone reading mail. With no address
  # configured the action group still carries its runbook receiver, so both
  # triggers still take the instance dark; the operator learns about it from
  # Azure Monitor instead.
  assert {
    condition     = length(azurerm_monitor_action_group.kill_switch.email_receiver) == 0
    error_message = "Expected no email receiver when no operator address is configured."
  }

  assert {
    condition     = length(azurerm_monitor_action_group.kill_switch.automation_runbook_receiver) == 1
    error_message = "Expected the kill action group to keep its runbook receiver regardless of whether an operator address is configured."
  }
}

# --- input guards ------------------------------------------------------------

run "rejects_a_cost_target_at_or_above_the_circuit_breaker" {
  command = plan

  variables {
    monthly_circuit_breaker_amount = 200
    monthly_cost_target_amount     = 200
  }

  expect_failures = [var.monthly_cost_target_amount]
}

run "rejects_a_budget_start_that_is_not_the_first_of_a_month" {
  command = plan

  variables {
    budget_start_date = "2026-08-15T00:00:00Z"
  }

  expect_failures = [var.budget_start_date]
}

run "rejects_a_tripwire_low_enough_to_fire_on_ordinary_traffic" {
  command = plan

  variables {
    egress_tripwire_bytes_per_day = 1048576
  }

  expect_failures = [var.egress_tripwire_bytes_per_day]
}

run "rejects_a_malformed_operator_address" {
  command = plan

  variables {
    operator_alert_email = "not-an-address"
  }

  expect_failures = [var.operator_alert_email]
}

run "rejects_a_malformed_webhook_expiry" {
  command = plan

  variables {
    kill_switch_webhook_expiry = "2036-01-01"
  }

  expect_failures = [var.kill_switch_webhook_expiry]
}
