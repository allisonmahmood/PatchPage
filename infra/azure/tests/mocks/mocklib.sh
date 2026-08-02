# Shared helpers for the Azure guide-harness PATH shims.
#
# The shims (az, terraform, git, curl, dig) are executables, not shell
# functions, so they cannot see the variables of the shell that runs the
# extracted README block. Everything a shim needs is therefore either
#   * exported by the harness before it starts the block (PP_MOCK_* and the
#     block's own documented input variables), or
#   * recomputed here from those exported values, or
#   * kept in a file under the per-scenario state directory PP_MOCK_STATE.
#
# Nothing in here may hold state in a shell variable across commands.

scenario="${PP_MOCK_SCENARIO:-}"
state_dir="${PP_MOCK_STATE:-}"

# The subscription every private_az wrapper is required to pin. Most flows take
# it as a documented input the harness exports; the custom-domain context block
# derives it from Terraform instead, so that flow exports the expected value
# under PP_MOCK_SUBSCRIPTION_ID and the guard below stays an independent check
# rather than a comparison against the block's own variable.
MOCK_SUBSCRIPTION_ID="${PP_MOCK_SUBSCRIPTION_ID:-${SUBSCRIPTION_ID:-}}"

# --- recording ---------------------------------------------------------------

# Append one already-formatted line to the scenario command log.
mock_log() {
  test -n "${PP_MOCK_LOG:-}" || return 0
  printf '%s\n' "$1" >> "$PP_MOCK_LOG"
}

# --- per-scenario state files ------------------------------------------------

mock_state_file() {
  printf '%s\n' "$state_dir/$1"
}

mock_state_exists() {
  test -e "$state_dir/$1"
}

mock_state_mark() {
  : > "$state_dir/$1"
}

mock_state_read() {
  cat "$state_dir/$1"
}

mock_state_write() {
  printf '%s\n' "$2" > "$state_dir/$1"
}

# Increment a counter file and print its new value. This is the protocol the
# harness already used for the counts that had to survive a subshell.
mock_state_count() {
  mock_count_file="$state_dir/$1"
  mock_count=0
  if test -e "$mock_count_file"; then
    mock_count="$(cat "$mock_count_file")"
  fi
  mock_count=$((mock_count + 1))
  printf '%s\n' "$mock_count" > "$mock_count_file"
  printf '%s\n' "$mock_count"
}

# --- argument helpers --------------------------------------------------------

# Every documented az call goes through a private_az wrapper that pins the
# subscription. Strip that pin and refuse anything that omits it; this is the
# single subscription guard all the per-group az mocks used to repeat.
mock_az_normalize() {
  mock_raw_args="$*"
  mock_subscription_suffix=" --subscription $MOCK_SUBSCRIPTION_ID"
  case "$mock_raw_args" in
    *"$mock_subscription_suffix")
      MOCK_AZ_ARGS="${mock_raw_args%"$mock_subscription_suffix"}"
      ;;
    *) return 1 ;;
  esac
}

# Print the value that follows the named flag; fail when the flag is absent.
mock_flag_value() {
  mock_flag="$1"
  shift
  while test "$#" -gt 0; do
    if test "$1" = "$mock_flag"; then
      shift
      test "$#" -gt 0 || return 1
      printf '%s\n' "$1"
      return 0
    fi
    shift
  done
  return 1
}

# Print the last argument.
mock_last_arg() {
  mock_last=
  for mock_arg do
    mock_last="$mock_arg"
  done
  printf '%s\n' "$mock_last"
}

# --- identities the block recomputes ----------------------------------------

# The block derives these from the same documented inputs the harness exports,
# so recomputing them here keeps the mock's answer independent of the block
# instead of echoing the block's own variable back at it.
mock_expected_state_storage_account_id() {
  printf '%s\n' \
    "/subscriptions/$MOCK_SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT"
}

mock_expected_operation_container_id() {
  printf '%s/blobServices/default/containers/patchpage-operations\n' \
    "$(mock_expected_state_storage_account_id)"
}

mock_expected_acr_id() {
  printf '%s\n' \
    "/subscriptions/$MOCK_SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/$ACR"
}

mock_expected_container_app_id() {
  printf '%s\n' \
    "/subscriptions/$MOCK_SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/containerApps/$CONTAINER_APP"
}

# --- the one operation-lease implementation ---------------------------------

# Handles acquire, renew, release and break for every flow that leases the
# operation container. Two knobs cover the differences the per-group copies
# used to encode by hand:
#   PP_MOCK_LEASE_SCENARIO_PREFIX  scenario-name prefix for the failure
#                                  injections ("operation_lease_" for the
#                                  release/rollback/deploy/infrastructure
#                                  flows, empty for stale-lease recovery)
#   PP_MOCK_LEASE_FILE             state file holding the currently held ID
mock_operation_lease() {
  test "$1 $2 $3" = "storage container lease" || return 1
  operation_lease_action="$4"
  shift 4
  operation_account=
  operation_container=
  operation_auth_mode=
  operation_duration=
  operation_proposed_id=
  operation_lease_id=
  operation_break_period=
  while test "$#" -gt 0; do
    case "$1" in
      --account-name)
        operation_account="$2"
        shift 2
        ;;
      --container-name)
        operation_container="$2"
        shift 2
        ;;
      --auth-mode)
        operation_auth_mode="$2"
        shift 2
        ;;
      --lease-duration)
        operation_duration="$2"
        shift 2
        ;;
      --proposed-lease-id)
        operation_proposed_id="$2"
        shift 2
        ;;
      --lease-id)
        operation_lease_id="$2"
        shift 2
        ;;
      --lease-break-period)
        operation_break_period="$2"
        shift 2
        ;;
      --output) shift 2 ;;
      --subscription)
        test "$2" = "$MOCK_SUBSCRIPTION_ID" || return 1
        shift 2
        ;;
      *) return 1 ;;
    esac
  done
  test "$operation_account" = "$STATE_STORAGE_ACCOUNT" || return 1
  test "$operation_container" = "patchpage-operations" || return 1
  test "$operation_auth_mode" = "${EXPECTED_OPERATION_AUTH_MODE:-login}" || return 1
  operation_lease_file="$state_dir/${PP_MOCK_LEASE_FILE:-operation-lease-id}"
  # Unset means the default prefix; an exported empty value means no prefix,
  # so this deliberately uses ${x-default} rather than ${x:-default}.
  operation_lease_prefix="${PP_MOCK_LEASE_SCENARIO_PREFIX-operation_lease_}"
  case "$operation_lease_action" in
    break)
      test "$operation_break_period" = "0" || return 1
      test "$scenario" != "${operation_lease_prefix}break_failure" || return 1
      ;;
    acquire)
      case "$operation_duration" in
        -1 | 60) ;;
        *) return 1 ;;
      esac
      printf '%s\n' "$operation_proposed_id" |
        grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ||
        return 1
      case "$scenario" in
        "${operation_lease_prefix}held" | "${operation_lease_prefix}acquire_failure")
          return 1
          ;;
      esac
      test ! -e "$operation_lease_file" || return 1
      printf '%s\n' "$operation_proposed_id" > "$operation_lease_file"
      ;;
    renew)
      test -f "$operation_lease_file" || return 1
      test "$operation_lease_id" = "$(cat "$operation_lease_file")" || return 1
      test "$scenario" != "${operation_lease_prefix}renew_failure" || return 1
      # Transient renew blip: acquire already succeeded and Azure holds the
      # infinite lease, but the first renew-as-proof fails. Later renews recover,
      # so the EXIT trap can and must still release the lease it owns.
      if test "$scenario" = "${operation_lease_prefix}acquire_ok_renew_fails" &&
        test ! -e "$state_dir/operation-lease-renew-blip"; then
        : > "$state_dir/operation-lease-renew-blip"
        return 1
      fi
      ;;
    release)
      test -f "$operation_lease_file" || return 1
      test "$operation_lease_id" = "$(cat "$operation_lease_file")" || return 1
      test "$scenario" != "${operation_lease_prefix}release_failure" || return 1
      rm -f "$operation_lease_file"
      ;;
    *) return 1 ;;
  esac
}

# --- shared JSON builders ----------------------------------------------------

# Container App JSON for the release and rollback flows, which both pin the
# ingress hostname, custom domains and the public-origin environment variable.
mock_containerapp_json() {
  # id latest_revision ready_revision fqdn custom_domains image env
  printf '{"id":"%s","properties":{"provisioningState":"Succeeded","latestRevisionName":"%s","latestReadyRevisionName":"%s","configuration":{"activeRevisionsMode":"Single","ingress":{"fqdn":"%s","customDomains":%s,"traffic":[{"latestRevision":true,"weight":100}]}},"template":{"containers":[{"name":"server","image":"%s","env":%s}]}}}\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7"
}

# Container App JSON for the infrastructure flow, which does not inspect the
# CLI-managed custom-domain state.
mock_containerapp_plain_json() {
  # id latest_revision ready_revision image
  printf '{"id":"%s","properties":{"provisioningState":"Succeeded","latestRevisionName":"%s","latestReadyRevisionName":"%s","configuration":{"activeRevisionsMode":"Single","ingress":{"traffic":[{"latestRevision":true,"weight":100}]}},"template":{"containers":[{"name":"server","image":"%s"}]}}}\n' \
    "$1" "$2" "$3" "$4"
}

mock_revision_json() {
  # name active provisioning_state health_state running_state weight image
  printf '{"name":"%s","properties":{"active":%s,"provisioningState":"%s","healthState":"%s","runningState":"%s","trafficWeight":%s,"template":{"containers":[{"name":"server","image":"%s"}]}}}\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7"
}

mock_active_revision_list_json() {
  if test "$#" -eq 2; then
    printf '[{"name":"%s","properties":{"active":true}},{"name":"%s","properties":{"active":true}}]\n' \
      "$1" "$2"
  else
    printf '[{"name":"%s","properties":{"active":true}}]\n' "$1"
  fi
}

mock_blob_service_properties_json() {
  # versioning blob_delete_enabled permanent_delete blob_delete_days
  # container_delete_enabled container_delete_days
  printf '{"isVersioningEnabled":%s,"deleteRetentionPolicy":{"enabled":%s,"allowPermanentDelete":%s,"days":%s},"containerDeleteRetentionPolicy":{"enabled":%s,"days":%s}}\n' \
    "$1" "$2" "$3" "$4" "$5" "$6"
}

mock_role_assignment_json() {
  # principal_id role_definition_id scope
  printf '[{"principalId":"%s","roleDefinitionId":"%s","scope":"%s"}]\n' "$1" "$2" "$3"
}

MOCK_BLOB_CONTRIBUTOR_ROLE_ID="ba92f5b4-2d11-453d-a403-e96b0029c9fe"
MOCK_BLOB_READER_ROLE_ID="2a2b9908-6ea1-4ae2-8e65-a410df84e7d1"
MOCK_BLOB_OWNER_ROLE_ID="acdd72a7-3385-48ef-bd42-f606fba81ae7"

mock_role_definition_id() {
  printf '/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/%s\n' \
    "$MOCK_SUBSCRIPTION_ID" "$1"
}

# --- shared post-deploy endpoint mock ---------------------------------------

# The release and rollback flows drive the same three bounded endpoint checks.
# The lease guard below only existed in the rollback copy: no documented flow
# may reach an endpoint after it has given up the operation lease.
mock_release_curl() {
  test -f "$state_dir/operation-lease-id" || return 1
  mock_log "curl $*"
  mock_curl_url="$(mock_last_arg "$@")"
  case "$mock_curl_url" in
    "https://$CONTAINER_APP_FQDN/healthz")
      test "$scenario" != "native_health_failure" || return 1
      if test "$scenario" = "native_health_status_mismatch"; then
        printf '{"ok":true}\n204'
      else
        printf '{"ok":true}\n200'
      fi
      ;;
    "$PUBLIC_BASE_URL/healthz")
      test "$scenario" != "public_health_failure" || return 1
      if test "$scenario" = "public_health_body_mismatch"; then
        printf '{"ok":false}\n200'
      else
        printf '{"ok":true}\n200'
      fi
      ;;
    "$CANARY_URL")
      test "$scenario" != "canary_request_failure" || return 1
      if test "$scenario" = "canary_marker_failure"; then
        printf '%s\n' "STALE_CANARY"
      else
        printf '%s\n' "$CANARY_MARKER"
      fi
      ;;
    *) return 1 ;;
  esac
}
