#!/bin/sh

set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)"
README="$ROOT/infra/azure/README.md"
TMP_ROOT="$(mktemp -d)"
TMP_DIR="$TMP_ROOT/guide commands"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_ROOT"' 0 HUP INT TERM

fail() {
  printf 'guide_commands_test: %s\n' "$1" >&2
  exit 1
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

normalize_az_args() {
  raw_az_args="$*"
  az_subscription_suffix=" --subscription $SUBSCRIPTION_ID"
  case "$raw_az_args" in
    *"$az_subscription_suffix")
      NORMALIZED_AZ_ARGS="${raw_az_args%"$az_subscription_suffix"}"
      ;;
    *) return 1 ;;
  esac
}

case "$TMP_DIR" in
  *' '*) ;;
  *) fail "guide harness temporary path does not contain spaces" ;;
esac

if grep -Fq -- '--header "Authorization: Bearer $BOOTSTRAP_API_TOKEN"' "$README"; then
  fail "deployed smoke exposes the bootstrap token in curl argv"
fi

extract_block() {
  marker="<!-- guide-test:$1 -->"
  awk -v marker="$marker" '
    $0 == marker { marked = 1; next }
    marked && $0 == "```sh" { copying = 1; next }
    copying && $0 == "```" { found = 1; exit }
    copying { print }
    END { if (!found) exit 1 }
  ' "$README"
}

extract_second_block() {
  marker="<!-- guide-test:$1 -->"
  awk -v marker="$marker" '
    $0 == marker { marked = 1; next }
    marked && $0 == "```sh" { blocks++; copying = blocks == 2; next }
    copying && $0 == "```" { found = 1; exit }
    copying { print }
    END { if (!found) exit 1 }
  ' "$README"
}

HOSTNAME_MUTATION_BLOCK="$(extract_block hostname-mutation)"
STATE_BOOTSTRAP_BLOCK="$(extract_block state-bootstrap)"
DEPLOY_RESOURCES_BLOCK="$(extract_block deploy-resources)"
APP_RELEASE_BLOCK="$(extract_block app-release)"
APP_ROLLBACK_BLOCK="$(extract_block app-rollback)"
INFRASTRUCTURE_CHANGE_BLOCK="$(extract_block infrastructure-change)"
INFRASTRUCTURE_CHANGE_APPLY_BLOCK="$(extract_second_block infrastructure-change)"
STALE_LEASE_RECOVERY_BLOCK="$(extract_block stale-lease-recovery)"
CUSTOM_DOMAIN_CONTEXT_BLOCK="$(extract_block custom-domain-context)"
INGRESS_VERIFICATION_BLOCK="$(extract_block ingress-verification)"
APEX_DNS_BLOCK="$(extract_block apex-dns)"
CAA_POLICY_BLOCK="$(extract_block caa-policy)"
CERTIFICATE_BINDING_BLOCK="$(extract_block certificate-binding)"
DEPLOYED_SMOKE_BLOCK="$(extract_block deployed-smoke)"

run_state_bootstrap_block() {
  scenario="$1"
  scenario_root="$TMP_DIR/state-$scenario"
  log="$TMP_DIR/state-$scenario.log"
  output="$TMP_DIR/state-$scenario.out"
  rm -rf "$scenario_root"
  mkdir -p "$scenario_root/infra/azure"
  : > "$log"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    STATE_STORAGE_ACCOUNT="patchpagestate"
    STATE_CONTAINER="tfstate"
    OPERATION_PRINCIPAL_ID="22222222-2222-4222-8222-222222222222"
    OPERATION_PRINCIPAL_TYPE="ServicePrincipal"
    if test "$scenario" = "operation_principal_invalid"; then
      OPERATION_PRINCIPAL_ID="not-a-guid"
    fi
    if test "$scenario" = "operation_principal_group"; then
      OPERATION_PRINCIPAL_TYPE="Group"
    fi
    if test "$scenario" = "state_key_invalid"; then
      STATE_KEY="../unsafe.tfstate"
    else
      STATE_KEY="patchpage-prod.tfstate"
    fi
    case "$scenario" in
      resume_* | state_key_history_*) RESUME_STATE_BOOTSTRAP="true" ;;
      *) RESUME_STATE_BOOTSTRAP="false" ;;
    esac
    case "$scenario" in
      resume_account_success | resume_exact_operation_role | resume_retention_preserved | \
        resume_foreign_container | \
        resume_deleted_container | resume_stronger_state_lock | \
        state_key_history_*)
        state_container_created="true"
        operation_container_created="true"
        ;;
      *)
        state_container_created="false"
        operation_container_created="false"
        ;;
    esac
    state_account_created="false"
    if test "$scenario" = "resume_exact_operation_role"; then
      role_assignment_created="true"
    else
      role_assignment_created="false"
    fi
    resource_list_count=0

    git() {
      test "$*" = "rev-parse --show-toplevel" || return 1
      printf '%s\n' "$scenario_root"
    }

    az() {
      normalize_az_args "$@" || return 1
      printf '%s\n' "$NORMALIZED_AZ_ARGS" >> "$log"
      printf 'private-az-diagnostic %s\n' "$NORMALIZED_AZ_ARGS" >&2
      case "$1 $2" in
        "account set")
          test "$scenario" != "subscription_set_failure"
          ;;
        "account show")
          test "$scenario" != "subscription_show_failure" || return 1
          if test "$scenario" = "subscription_mismatch"; then
            printf '%s\n' "11111111-1111-1111-1111-111111111111"
          else
            printf '%s\n' "$SUBSCRIPTION_ID"
          fi
          ;;
        "group exists")
          test "$scenario" != "state_resource_group_check_failure" || return 1
          case "$scenario" in
            state_resource_group_exists | resume_* | state_key_history_*)
              printf '%s\n' "true"
              ;;
            *) printf '%s\n' "false" ;;
          esac
          ;;
        "resource list")
          resource_list_count=$((resource_list_count + 1))
          case "$scenario" in
            resume_foreign_resource)
              printf '%s\n' \
                "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.KeyVault/vaults/foreign"
              ;;
            resume_account_success | resume_exact_operation_role | resume_retention_preserved | \
              resume_foreign_container | \
              resume_deleted_container | resume_stronger_state_lock | \
              state_key_history_*)
              printf '%s\n' \
                "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate"
              ;;
            foreign_resource_after_group_create)
              printf '%s\n' \
                "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.KeyVault/vaults/foreign"
              ;;
            foreign_resource_before_lock)
              if test "$state_account_created" = "true"; then
                printf '%s\n' \
                  "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate"
                printf '%s\n' \
                  "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.KeyVault/vaults/foreign"
              fi
              ;;
            *)
              if test "$state_account_created" = "true"; then
                printf '%s\n' \
                  "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate"
              fi
              ;;
          esac
          ;;
        "group create")
          test "$scenario" != "group_create_failure"
          ;;
        "group show")
          if test "$scenario" = "group_verification_failure"; then
            return 1
          elif test "$scenario" = "group_location_drift"; then
            printf '%s\n' "eastus"
          else
            printf '%s\n' "centralus"
          fi
          ;;
        "storage account")
          case "$3" in
            check-name)
              test "$scenario" != "state_account_check_failure" || return 1
              case "$scenario" in
                resume_account_success | resume_exact_operation_role | resume_retention_preserved | \
                  resume_foreign_container | resume_deleted_container | resume_stronger_state_lock | \
                  state_key_history_*)
                  printf '%s\n' "false"
                  ;;
                *) printf '%s\n' "true" ;;
              esac
              ;;
            create)
              test "$scenario" != "account_create_failure" || return 1
              state_account_created="true"
              ;;
            show)
              test "$scenario" != "account_verification_failure" || return 1
              account_location="centralus"
              account_kind="StorageV2"
              account_sku="Standard_GRS"
              account_tls="TLS1_2"
              account_https="true"
              account_public_blob="false"
              case "$scenario" in
                account_location_drift) account_location="eastus" ;;
                account_kind_drift) account_kind="BlobStorage" ;;
                account_sku_drift) account_sku="Standard_LRS" ;;
                account_tls_drift) account_tls="TLS1_0" ;;
                account_https_drift) account_https="false" ;;
                account_public_blob_drift) account_public_blob="true" ;;
              esac
              printf \
                '{"id":"/subscriptions/%s/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate","location":"%s","kind":"%s","sku":{"name":"%s"},"minimumTlsVersion":"%s","enableHttpsTrafficOnly":%s,"allowBlobPublicAccess":%s}\n' \
                "$SUBSCRIPTION_ID" \
                "$account_location" \
                "$account_kind" \
                "$account_sku" \
                "$account_tls" \
                "$account_https" \
                "$account_public_blob"
              ;;
            blob-service-properties)
              case "$4" in
                update)
                  test "$scenario" != "blob_protection_update_failure"
                  ;;
                show)
                  test "$scenario" != "blob_protection_show_failure" || return 1
                  versioning="true"
                  blob_delete_enabled="true"
                  blob_delete_days="30"
                  permanent_delete="false"
                  container_delete_enabled="true"
                  container_delete_days="30"
                  case "$scenario" in
                    versioning_drift) versioning="false" ;;
                    blob_delete_disabled) blob_delete_enabled="false" ;;
                    blob_delete_too_short) blob_delete_days="29" ;;
                    permanent_delete_enabled) permanent_delete="true" ;;
                    container_delete_disabled) container_delete_enabled="false" ;;
                    container_delete_too_short) container_delete_days="29" ;;
                    resume_retention_preserved)
                      blob_delete_days="90"
                      container_delete_days="365"
                      ;;
                  esac
                  printf \
                    '{"isVersioningEnabled":%s,"deleteRetentionPolicy":{"enabled":%s,"allowPermanentDelete":%s,"days":%s},"containerDeleteRetentionPolicy":{"enabled":%s,"days":%s}}\n' \
                    "$versioning" \
                    "$blob_delete_enabled" \
                    "$permanent_delete" \
                    "$blob_delete_days" \
                    "$container_delete_enabled" \
                    "$container_delete_days"
                  ;;
                *)
                  return 1
                  ;;
              esac
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        "storage container")
          case " $* " in
            *" --auth-mode key "*) ;;
            *) return 1 ;;
          esac
          case "$3" in
            create)
              test "$scenario" != "create_failure" || return 1
              case " $* " in
                *" --name tfstate "*) state_container_created="true" ;;
                *" --name patchpage-operations "*) operation_container_created="true" ;;
                *) return 1 ;;
              esac
              ;;
            exists)
              if test "$scenario" = "verification_failure"; then
                return 1
              elif test "$scenario" = "container_missing"; then
                printf '%s\n' "false"
              else
                case " $* " in
                  *" --name tfstate "*) printf '%s\n' "$state_container_created" ;;
                  *" --name patchpage-operations "*) printf '%s\n' "$operation_container_created" ;;
                  *) return 1 ;;
                esac
              fi
              ;;
            list)
              if test "$scenario" = "resume_foreign_container"; then
                printf 'foreign\tfalse\n'
              elif test "$scenario" = "resume_deleted_container"; then
                printf 'tfstate\ttrue\n'
              else
                test "$state_container_created" = "false" || printf 'tfstate\t\n'
                test "$operation_container_created" = "false" || printf 'patchpage-operations\t\n'
              fi
              ;;
            metadata)
              test "$4" = "show" || return 1
              if test "$scenario" = "operation_container_foreign_metadata"; then
                printf '%s\n' '{"foreign":"value"}'
              else
                printf '%s\n' '{}'
              fi
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        "storage blob")
          test "$3" = "list" || return 1
          case " $* " in
            *" --container-name patchpage-operations "*)
              test "$scenario" != "operation_container_nonempty" ||
                printf '%s\n' "unexpected"
              ;;
          esac
          test "$scenario" != "state_key_history_check_failure" || return 1
          if test "$scenario" = "state_key_history_exists" &&
            case " $* " in *" --container-name tfstate "*) true ;; *) false ;; esac; then
            printf '%s\n' "patchpage-prod.tfstate"
          fi
          ;;
        "role assignment")
          case "$3" in
            list)
              case " $* " in
                *" --assignee-object-id $OPERATION_PRINCIPAL_ID --role /subscriptions/$SUBSCRIPTION_ID/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe --scope /subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/patchpage-operations --include-inherited --include-groups --fill-principal-name false --fill-role-definition-name false --output json "*)
                  role_assignment_scope="operation"
                  ;;
                *" --assignee-object-id $OPERATION_PRINCIPAL_ID --scope /subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/tfstate --include-inherited --include-groups --fill-principal-name false --fill-role-definition-name false --output json "*)
                  role_assignment_scope="state"
                  ;;
                *) return 1 ;;
              esac
              if test "$scenario" = "operation_role_inherited_broad"; then
                printf '[{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe","scope":"/subscriptions/%s/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate"}]\n' \
                  "$OPERATION_PRINCIPAL_ID" "$SUBSCRIPTION_ID" "$SUBSCRIPTION_ID"
              elif test "$role_assignment_scope" = "state"; then
                if test "$scenario" = "operation_role_state_reader"; then
                  printf '[{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/2a2b9908-6ea1-4ae2-8e65-a410df84e7d1","scope":"/subscriptions/%s/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/tfstate"}]\n' \
                    "$OPERATION_PRINCIPAL_ID" "$SUBSCRIPTION_ID" "$SUBSCRIPTION_ID"
                else
                  printf '%s\n' '[]'
                fi
              elif test "$role_assignment_created" = "true"; then
                printf '[{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe","scope":"/subscriptions/%s/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/patchpage-operations"}]\n' \
                  "$OPERATION_PRINCIPAL_ID" "$SUBSCRIPTION_ID" "$SUBSCRIPTION_ID"
              else
                printf '%s\n' '[]'
              fi
              ;;
            create)
              test "$scenario" != "operation_role_create_failure" || return 1
              case " $* " in
                *" --role /subscriptions/$SUBSCRIPTION_ID/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe --scope /subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/patchpage-operations "*) ;;
                *) return 1 ;;
              esac
              role_assignment_created="true"
              ;;
            *) return 1 ;;
          esac
          ;;
        "lock list")
          if test "$scenario" = "resume_stronger_state_lock"; then
            printf 'ReadOnly\t/subscriptions/%s/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/providers/Microsoft.Authorization/locks/protect-patchpage-tfstate\n' "$SUBSCRIPTION_ID"
          fi
          ;;
        "lock create")
          test "$scenario" != "state_lock_create_failure"
          ;;
        "lock show")
          test "$scenario" != "state_lock_show_failure" || return 1
          if test "$scenario" = "state_lock_level_drift"; then
            printf 'ReadOnly\t/subscriptions/%s/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/providers/Microsoft.Authorization/locks/protect-patchpage-tfstate\n' "$SUBSCRIPTION_ID"
          else
            printf 'CanNotDelete\t/subscriptions/%s/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/providers/Microsoft.Authorization/locks/protect-patchpage-tfstate\n' "$SUBSCRIPTION_ID"
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    eval "$STATE_BOOTSTRAP_BLOCK"
  ) >"$output" 2>&1
}

test_state_bootstrap() {
  printf '%s\n' "$STATE_BOOTSTRAP_BLOCK" |
    grep -Fq -- '--role "$STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID"' ||
    fail "state bootstrap does not filter operation RBAC by the official built-in role ID"
  printf '%s\n' "$STATE_BOOTSTRAP_BLOCK" |
    grep -Fq -- '--include-inherited' ||
    fail "state bootstrap does not inspect inherited operation RBAC"
  printf '%s\n' "$STATE_BOOTSTRAP_BLOCK" |
    grep -Fq -- '--include-groups' ||
    fail "state bootstrap does not inspect operation RBAC inherited through groups"
  for scenario in \
    subscription_set_failure \
    subscription_show_failure \
    operation_principal_group \
    subscription_mismatch \
    state_account_check_failure \
    state_resource_group_check_failure \
    state_resource_group_exists \
    state_key_invalid \
    operation_principal_invalid \
    group_create_failure \
    foreign_resource_after_group_create \
    group_verification_failure \
    group_location_drift \
    account_create_failure \
    account_verification_failure \
    account_location_drift \
    account_kind_drift \
    account_sku_drift \
    account_tls_drift \
    account_https_drift \
    account_public_blob_drift \
    blob_protection_update_failure \
    blob_protection_show_failure \
    versioning_drift \
    blob_delete_disabled \
    permanent_delete_enabled \
    blob_delete_too_short \
    container_delete_disabled \
    container_delete_too_short \
    create_failure \
    verification_failure \
    container_missing \
    operation_container_nonempty \
    operation_container_foreign_metadata \
    operation_role_create_failure \
    operation_role_inherited_broad \
    operation_role_state_reader \
    state_lock_create_failure \
    state_key_history_check_failure \
    state_key_history_exists \
    state_lock_show_failure \
    state_lock_level_drift \
    resume_group_only_success \
    resume_account_success \
    resume_exact_operation_role \
    resume_retention_preserved \
    resume_foreign_resource \
    resume_deleted_container \
    resume_stronger_state_lock \
    resume_foreign_container \
    foreign_resource_before_lock \
    success; do
    if run_state_bootstrap_block "$scenario"; then
      status=0
    else
      status=$?
    fi

    backend="$TMP_DIR/state-$scenario/infra/azure/backend.hcl"
    case "$scenario" in
      success)
        test "$status" -eq 0 || fail "state bootstrap failed after protection verification"
        test -f "$backend" || fail "state bootstrap did not create backend config after verification"
        grep -Fqx 'key                  = "patchpage-prod.tfstate"' "$backend" ||
          fail "state bootstrap did not use the private environment-specific state key"
        grep -Fqx \
          'group create --name rg-patchpage-tfstate --location centralus' \
          "$log" ||
          fail "state resource group was not created in the intended location"
        grep -Fqx \
          'group show --name rg-patchpage-tfstate --query location --output tsv' \
          "$log" ||
          fail "state resource group location was not verified"
        grep -Fqx \
          'storage account check-name --name patchpagestate --query nameAvailable --output tsv' \
          "$log" ||
          fail "state bootstrap did not check global account-name availability"
        grep -Fqx \
          'storage account create --name patchpagestate --resource-group rg-patchpage-tfstate --location centralus --sku Standard_GRS --kind StorageV2 --min-tls-version TLS1_2 --https-only true --allow-blob-public-access false' \
          "$log" ||
          fail "state storage account was not created with geo-redundancy and required security properties"
        grep -Fqx \
          'storage account show --name patchpagestate --resource-group rg-patchpage-tfstate --output json' \
          "$log" ||
          fail "state storage account properties were not verified"
        grep -Fqx \
          'storage account blob-service-properties update --account-name patchpagestate --resource-group rg-patchpage-tfstate --enable-versioning true --enable-delete-retention true --delete-retention-days 30 --enable-container-delete-retention true --container-delete-retention-days 30 --set deleteRetentionPolicy.allowPermanentDelete=false' \
          "$log" ||
          fail "state blob versioning and soft-delete retention were not configured"
        grep -Fqx \
          'storage account blob-service-properties show --account-name patchpagestate --resource-group rg-patchpage-tfstate --output json' \
          "$log" ||
          fail "state blob versioning and soft-delete retention were not verified"
        grep -Fqx \
          'storage container list --account-name patchpagestate --auth-mode key --include-deleted true --num-results * --query [].[name,deleted] --output tsv' \
          "$log" ||
          fail "state bootstrap did not exhaustively inspect active and deleted containers"
        grep -Fqx \
          'storage container create --name tfstate --account-name patchpagestate --auth-mode key' \
          "$log" ||
          fail "state container creation did not use key authorization"
        grep -Fqx \
          'storage container exists --name tfstate --account-name patchpagestate --auth-mode key --query exists --output tsv' \
          "$log" ||
          fail "state container verification did not use key authorization"
        grep -Fqx \
          'storage container create --name patchpage-operations --account-name patchpagestate --auth-mode key' \
          "$log" ||
          fail "operation-lease container was not created beside the state container"
        grep -Fqx \
          'storage blob list --account-name patchpagestate --container-name patchpage-operations --auth-mode key --include d v --num-results * --query [].name --output tsv' \
          "$log" ||
          fail "operation-lease container was not verified empty"
        grep -Fqx \
          'storage container metadata show --name patchpage-operations --account-name patchpagestate --auth-mode key --output json' \
          "$log" ||
          fail "operation-lease container metadata was not verified empty before workload binding"
        grep -Fqx \
          "role assignment list --assignee-object-id 22222222-2222-4222-8222-222222222222 --role /subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe --scope /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/patchpage-operations --include-inherited --include-groups --fill-principal-name false --fill-role-definition-name false --output json" \
          "$log" ||
          fail "state bootstrap did not inspect exact and inherited built-in role assignments"
        grep -Fqx \
          "role assignment list --assignee-object-id 22222222-2222-4222-8222-222222222222 --scope /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/tfstate --include-inherited --include-groups --fill-principal-name false --fill-role-definition-name false --output json" \
          "$log" ||
          fail "state bootstrap did not prove the operation principal lacks tfstate access"
        grep -Fqx \
          "role assignment create --assignee-object-id 22222222-2222-4222-8222-222222222222 --assignee-principal-type ServicePrincipal --role /subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe --scope /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/patchpage-operations --output none" \
          "$log" ||
          fail "operation principal was not granted exact-container Blob contributor access"
        grep -Fqx \
          "storage blob list --account-name patchpagestate --container-name tfstate --auth-mode key --prefix patchpage-prod.tfstate --include d v --num-results * --query [?name=='patchpage-prod.tfstate'].name --output tsv" \
          "$log" ||
          fail "state bootstrap did not prove the backend key lacks current, deleted, or versioned history"
        grep -Fqx \
          'lock create --name protect-patchpage-tfstate --lock-type CanNotDelete --resource /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate' \
          "$log" ||
          fail "state storage-account deletion lock was not created at exact scope"
        grep -Fqx \
          "lock list --resource /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate --query [?name=='protect-patchpage-tfstate'].[level,id] --output tsv" \
          "$log" ||
          fail "state storage-account deletion lock was not inspected before mutation"
        grep -Fqx \
          'lock show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/providers/Microsoft.Authorization/locks/protect-patchpage-tfstate --query [level,id] --output tsv' \
          "$log" ||
          fail "state storage-account deletion lock scope was not verified"
        backend_mode="$(
          file_mode "$backend"
        )"
        test "$backend_mode" = "600" ||
          fail "state bootstrap backend config is not mode 0600"
        ;;
      resume_group_only_success | resume_account_success | resume_exact_operation_role | \
        resume_retention_preserved)
        test "$status" -eq 0 ||
          fail "state bootstrap rejected safe partial resume $scenario"
        test -f "$backend" ||
          fail "state bootstrap resume did not create backend config"
        if grep -Fq 'group create ' "$log"; then
          fail "state bootstrap resume recreated its existing resource group"
        fi
        if test "$scenario" = "resume_group_only_success"; then
          grep -Fq 'storage account create ' "$log" ||
            fail "group-only state bootstrap resume did not create the missing account"
        elif grep -Fq 'storage account create ' "$log"; then
          fail "state bootstrap resume recreated its existing account"
        fi
        if test "$scenario" = "resume_retention_preserved"; then
          grep -Fqx \
            'storage account blob-service-properties update --account-name patchpagestate --resource-group rg-patchpage-tfstate --enable-versioning true --enable-delete-retention true --delete-retention-days 90 --enable-container-delete-retention true --container-delete-retention-days 365 --set deleteRetentionPolicy.allowPermanentDelete=false' \
            "$log" ||
            fail "state bootstrap resume lowered existing retention"
        fi
        if test "$scenario" = "resume_exact_operation_role" &&
          grep -q '^role assignment create ' "$log"; then
          fail "state bootstrap recreated an existing exact operation role assignment"
        fi
        backend_mode="$(
          file_mode "$backend"
        )"
        test "$backend_mode" = "600" ||
          fail "state bootstrap resume backend config is not mode 0600"
        ;;
      *)
        test "$status" -ne 0 || fail "state bootstrap succeeded after $scenario"
        test ! -e "$backend" || fail "state bootstrap created backend config after $scenario"
        if grep -Eq \
          '00000000-0000-0000-0000-000000000000|11111111-1111-1111-1111-111111111111|patchpagestate|rg-patchpage-tfstate|patchpage-prod\.tfstate' \
          "$TMP_DIR/state-$scenario.out"; then
          fail "state bootstrap exposed private identifiers after $scenario"
        fi
        ;;
    esac
    case "$scenario" in
      state_key_history_exists | state_key_history_check_failure | \
        state_resource_group_exists | resume_foreign_resource | \
        resume_foreign_container | resume_deleted_container | resume_stronger_state_lock)
      if grep -Eq \
        '^(group create|storage account create|storage account blob-service-properties update|storage container create|lock create) ' \
        "$log"; then
        fail "state bootstrap mutated existing state infrastructure before rejecting $scenario"
      fi
      ;;
    esac
    case "$scenario" in
      operation_role_inherited_broad | operation_role_state_reader)
        if grep -Eq '^(role assignment create|lock create) ' "$log"; then
          fail "state bootstrap mutated RBAC or locks after finding inherited broad access"
        fi
        ;;
      foreign_resource_after_group_create | foreign_resource_before_lock)
        if grep -q '^lock create ' "$log"; then
          fail "state bootstrap locked a scope after a foreign resource appeared"
        fi
        ;;
    esac
  done
}

run_deploy_resources_block() {
  scenario="$1"
  scenario_root="$TMP_DIR/deploy-$scenario"
  log="$TMP_DIR/deploy-$scenario.log"
  output="$TMP_DIR/deploy-$scenario.out"
  rm -rf "$scenario_root"
  mkdir -p "$scenario_root/infra/azure"
  : > "$log"
  diagnostic_root="$TMP_DIR/deploy-diagnostics-$scenario"
  rm -rf "$diagnostic_root"
  mkdir -p "$diagnostic_root"
  diagnostic_root="$(CDPATH= cd -- "$diagnostic_root" && pwd -P)"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    STATE_STORAGE_ACCOUNT="patchpagestate"
    STATE_KEY="patchpage-prod.tfstate"
    FULL_SHA="1111111111111111111111111111111111111111"
    IMAGE_DIGEST_VALUE="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    TERRAFORM_DIAGNOSTIC_ROOT="$diagnostic_root"
    export TERRAFORM_DIAGNOSTIC_ROOT
    EXPECTED_OPERATION_AUTH_MODE="key"
    case "$scenario" in
      resume_*) RESUME_INITIAL_DEPLOY="true" ;;
      *) RESUME_INITIAL_DEPLOY="false" ;;
    esac
    cd "$scenario_root/infra/azure"
    printf '%s\n' \
      'resource_group_name = "foreign"' \
      'storage_account_name = "foreignstate"' \
      'container_name = "foreign"' \
      'key = "foreign.tfstate"' > backend.hcl

    git() {
      case "$*" in
        "rev-parse --show-toplevel")
          test "$scenario" != "repo_root_failure" || return 1
          printf '%s\n' "$scenario_root"
          ;;
        "-C ../.. status --porcelain")
          test "$scenario" != "git_status_failure" || return 1
          if test "$scenario" = "dirty_worktree"; then
            printf '%s\n' " M apps/server/src/start.ts"
          fi
          ;;
        "-C ../.. rev-parse HEAD")
          test "$scenario" != "git_failure" || return 1
          test "$scenario" != "git_empty" || return 0
          if test "$scenario" = "git_short"; then
            printf '%s\n' "1111111"
          else
            printf '%s\n' "$FULL_SHA"
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    mktemp() {
      mktemp_count_file="$scenario_root/mktemp-count"
      mktemp_count=0
      if test -e "$mktemp_count_file"; then
        mktemp_count="$(cat "$mktemp_count_file")"
      fi
      mktemp_count=$((mktemp_count + 1))
      printf '%s\n' "$mktemp_count" > "$mktemp_count_file"
      if test "$scenario" = "diagnostic_secure_dir_failure" &&
        test "$mktemp_count" -eq 1; then
        return 1
      fi
      if test "$scenario" = "target_secure_dir_failure" &&
        test "$mktemp_count" -eq 3; then
        return 1
      fi
      if test "$scenario" = "secure_plan_dir_failure" &&
        test "$mktemp_count" -eq 4; then
        return 1
      fi
      mktemp_result="$(command mktemp "$@")" || return 1
      if test "$mktemp_count" -eq 1; then
        printf '%s\n' "$mktemp_result" > "$scenario_root/diagnostic-dir"
        if test "$scenario" = "diagnostic_log_open_failure"; then
          mkdir "$mktemp_result/terraform.log"
        fi
      elif test "$scenario" = "state_diagnostic_open_failure" &&
        test "$mktemp_count" -eq 2; then
        command rm -f -- "$mktemp_result"
        mkdir "$mktemp_result"
      fi
      printf '%s\n' "$mktemp_result"
    }

    cat() {
      if test "$scenario" = "state_diagnostic_read_failure" &&
        test "${1:-}" = "--" &&
        test "${2:-}" = "${STATE_LIST_ERROR:-}"; then
        printf 'private read failure: %s\n' "$2" >&2
        return 1
      fi
      command cat "$@"
    }

    rm() {
      if test "$scenario" = "state_diagnostic_remove_failure" &&
        test "${1:-}" = "-f" &&
        test "${3:-}" = "${STATE_LIST_ERROR:-}"; then
        printf 'private remove failure: %s\n' "$3" >&2
        return 1
      fi
      if test "$scenario" = "diagnostic_cleanup_failure" &&
        test "${1:-}" = "-rf" &&
        test "${3:-}" = "${TERRAFORM_DIAGNOSTIC_DIR:-}"; then
        printf 'private cleanup failure: %s\n' "$3" >&2
        return 1
      fi
      if test "$scenario" = "target_cleanup_failure" &&
        test "${1:-}" = "-rf" &&
        test "${3:-}" = "${SECURE_TARGET_DIR:-}"; then
        printf 'private target cleanup failure: %s\n' "$3" >&2
        return 1
      fi
      if test "$scenario" = "initial_cleanup_failure" &&
        test "${1:-}" = "-rf" &&
        test "${3:-}" = "${SECURE_PLAN_DIR:-}"; then
        printf 'private plan cleanup failure: %s\n' "$3" >&2
        return 1
      fi
      command rm "$@"
    }

    jq() {
      jq_input=
      for jq_arg do
        jq_input="$jq_arg"
      done
      if test -n "${INITIAL_PLAN_JSON:-}" &&
        test "$jq_input" = "$INITIAL_PLAN_JSON"; then
        jq_seen="$scenario_root/initial-plan-jq-seen"
        if test "$scenario" = "plan_summary_failure" && test -e "$jq_seen"; then
          return 1
        fi
        : > "$jq_seen"
      fi
      command jq "$@"
    }

    terraform() {
      printf 'terraform %s\n' "$*" >> "$log"
      printf 'private-terraform-diagnostic %s\n' "$*" >&2
      case "$*" in
        "init -input=false -reconfigure -backend-config=backend.hcl")
          if test "$scenario" = "state_list_aggregate_false_missing"; then
            printf '%s\n' "No state file was found in an unrelated init diagnostic." >&2
          fi
          test "$scenario" != "init_failure"
          ;;
        "console -no-color")
          IFS= read -r console_expression || return 1
          case "$console_expression" in
            "var.subscription_id")
              test "$scenario" != "terraform_subscription_console_failure" || return 1
              if test "$scenario" = "terraform_subscription_mismatch"; then
                printf '%s\n' '"33333333-3333-3333-3333-333333333333"'
              else
                printf '"%s"\n' "$SUBSCRIPTION_ID"
              fi
              ;;
            '"rg-patchpage-${var.environment_name}"')
              test "$scenario" != "terraform_resource_group_console_failure" || return 1
              if test "$scenario" = "terraform_resource_group_invalid"; then
                printf '%s\n' "not-json"
              else
                printf '%s\n' '"rg-patchpage-workload"'
              fi
              ;;
            "azurerm_storage_account.drafts.id")
              printf '"/subscriptions/%s/resourceGroups/rg-patchpage-workload/providers/Microsoft.Storage/storageAccounts/patchpagedrafts"\n' "$SUBSCRIPTION_ID"
              ;;
            "azurerm_postgresql_flexible_server.patchpage.id")
              printf '"/subscriptions/%s/resourceGroups/rg-patchpage-workload/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-postgres"\n' "$SUBSCRIPTION_ID"
              ;;
            "azurerm_container_app.server.id")
              printf '"/subscriptions/%s/resourceGroups/rg-patchpage-workload/providers/Microsoft.App/containerApps/patchpage-app"\n' "$SUBSCRIPTION_ID"
              ;;
            "azurerm_container_registry.patchpage.id")
              printf '"/subscriptions/%s/resourceGroups/rg-patchpage-workload/providers/Microsoft.ContainerRegistry/registries/acrpatchpageabc123"\n' "$SUBSCRIPTION_ID"
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        "state list")
          case "$scenario" in
            state_list_failure | state_list_aggregate_false_missing)
              printf '%s\n' "Backend state lookup failed." >&2
              return 1
              ;;
            nonempty_initial_state)
              printf '%s\n' "azurerm_resource_group.existing"
              ;;
            resume_partial_rg_success | resume_live_foreign_resource | resume_stronger_lock)
              printf '%s\n' \
                "random_string.unique" \
                "azurerm_resource_group.patchpage"
              ;;
            resume_target_complete_success | resume_acr_id_mismatch)
              printf '%s\n' \
                "random_string.unique" \
                "azurerm_resource_group.patchpage" \
                "azurerm_container_registry.patchpage"
              ;;
            resume_full_state)
              printf '%s\n' \
                "random_string.unique" \
                "azurerm_resource_group.patchpage" \
                "azurerm_container_registry.patchpage" \
                "azurerm_storage_account.drafts" \
                "azurerm_container_app.server"
              ;;
            resume_acr_without_random)
              printf '%s\n' \
                "azurerm_resource_group.patchpage" \
                "azurerm_container_registry.patchpage"
              ;;
            resume_unexpected_state)
              printf '%s\n' "azurerm_resource_group.unexpected"
              ;;
            *)
              printf '%s\n' "No state file was found!" >&2
              return 1
              ;;
          esac
          ;;
        "output -raw resource_group_name")
          test "$scenario" != "resource_group_output_failure" || return 1
          test "$scenario" != "resource_group_output_empty" || return 0
          printf '%s\n' "rg-patchpage-workload"
          ;;
        "output -raw acr_name")
          test "$scenario" != "acr_output_failure" || return 1
          test "$scenario" != "acr_output_empty" || return 0
          if test "$scenario" = "unexpected_acr_name"; then
            printf '%s\n' "not-an-acr-name"
          else
            printf '%s\n' "acrpatchpageabc123"
          fi
          ;;
        "output -raw acr_login_server")
          test "$scenario" != "login_output_failure" || return 1
          test "$scenario" != "login_output_empty" || return 0
          if test "$scenario" = "unexpected_login_server"; then
            printf '%s\n' "other.azurecr.io"
          else
            printf '%s\n' "acrpatchpageabc123.azurecr.io"
          fi
          ;;
        "output -raw container_app_name")
          printf '%s\n' "patchpage-app"
          ;;
        plan\ -target=azurerm_container_registry.patchpage\ -input=false\ -out=*)
          test "$scenario" != "target_plan_failure"
          ;;
        plan\ -input=false\ -out=*)
          test "$scenario" != "plan_failure"
          ;;
        show\ -json\ *)
          case "$3" in
            *"/registry-target.tfplan")
              test "$scenario" != "target_plan_show_failure" || return 1
              if test "$scenario" = "target_plan_delete"; then
                printf '%s\n' \
                  '{"resource_changes":[{"address":"azurerm_container_registry.patchpage","change":{"actions":["delete","create"]}}]}'
              else
                printf '%s\n' \
                  '{"resource_changes":[{"address":"azurerm_container_registry.patchpage","change":{"actions":["create"]}}]}'
              fi
              ;;
            *)
              test "$scenario" != "plan_gate_show_failure" || return 1
              case "$scenario" in
                plan_delete)
                  printf '%s\n' \
                    '{"resource_changes":[{"address":"azurerm_storage_account.drafts","change":{"actions":["delete"]}}]}'
                  ;;
                plan_replacement)
                  printf '%s\n' \
                    '{"resource_changes":[{"address":"azurerm_postgresql_flexible_server.patchpage","change":{"actions":["delete","create"]}}]}'
                  ;;
                *)
                  printf '%s\n' \
                    '{"resource_changes":[{"address":"azurerm_container_app.server","change":{"actions":["create"]}}]}'
                  ;;
              esac
              ;;
          esac
          ;;
        apply\ -input=false\ *)
          if test "$3" = "$REGISTRY_TARGET_PLAN"; then
            test "$scenario" != "target_apply_failure"
          elif test "$3" = "$INITIAL_PLAN"; then
            test "$scenario" != "final_apply_failure"
          else
            return 1
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    az() {
      normalize_az_args "$@" || return 1
      printf 'az %s\n' "$NORMALIZED_AZ_ARGS" >> "$log"
      printf 'private-az-diagnostic %s\n' "$NORMALIZED_AZ_ARGS" >&2
      case "$1 $2" in
        "account set")
          test "$scenario" != "subscription_set_failure"
          ;;
        "account show")
          test "$scenario" != "subscription_show_failure" || return 1
          if test "$scenario" = "subscription_mismatch"; then
            printf '%s\n' "22222222-2222-2222-2222-222222222222"
          else
            printf '%s\n' "$SUBSCRIPTION_ID"
          fi
          ;;
        "group exists")
          test "$scenario" != "workload_group_exists_check_failure" || return 1
          case "$scenario" in
            workload_group_exists | resume_*) printf '%s\n' "true" ;;
            *) printf '%s\n' "false" ;;
          esac
          ;;
        "group show")
          printf '%s\n' \
            "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-workload"
          ;;
        "resource list")
          case "$scenario" in
            resume_target_complete_success)
              printf '%s\n' \
                "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-workload/providers/Microsoft.ContainerRegistry/registries/acrpatchpageabc123"
              ;;
            resume_live_foreign_resource)
              printf '%s\n' \
                "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-workload/providers/Microsoft.Storage/storageAccounts/foreign"
              ;;
          esac
          ;;
        "storage container-rm")
          test "$3" = "show" || return 1
          if test "$scenario" = "operation_container_id_mismatch"; then
            printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/foreign/blobServices/default/containers/patchpage-operations"
          else
            printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/patchpage-operations"
          fi
          ;;
        "storage container")
          case "$3 $4" in
            "exists --account-name") printf '%s\n' "true" ;;
            "metadata show")
              operation_metadata_count_file="$scenario_root/operation-metadata-count"
              operation_metadata_count=0
              if test -f "$operation_metadata_count_file"; then
                operation_metadata_count="$(command cat "$operation_metadata_count_file")"
              fi
              operation_metadata_count=$((operation_metadata_count + 1))
              printf '%s\n' "$operation_metadata_count" > "$operation_metadata_count_file"
              if test "$scenario" = "operation_binding_foreign" ||
                { test "$scenario" = "operation_binding_concurrent_metadata" &&
                  test "$operation_metadata_count" -gt 1; }; then
                printf '%s\n' '{"foreign":"binding"}'
              elif test -f "$scenario_root/operation-binding"; then
                operation_binding="$(command cat "$scenario_root/operation-binding")"
                printf '{"patchpage_workload_binding_sha256":"%s"}\n' "$operation_binding"
              else
                printf '%s\n' '{}'
              fi
              ;;
            "metadata update")
              test "$scenario" != "operation_binding_update_failure" || return 1
              operation_metadata_lease_id=
              operation_binding=
              while test "$#" -gt 0; do
                case "$1" in
                  --lease-id)
                    operation_metadata_lease_id="$2"
                    shift 2
                    ;;
                  patchpage_workload_binding_sha256=*)
                    operation_binding="${1#*=}"
                    shift
                    ;;
                  *) shift ;;
                esac
              done
              test -f "$scenario_root/operation-lease-id" || return 1
              test "$operation_metadata_lease_id" = "$(
                command cat "$scenario_root/operation-lease-id"
              )" || return 1
              test -n "$operation_binding" || return 1
              printf '%s\n' "$operation_binding" > "$scenario_root/operation-binding"
              ;;
            "lease acquire" | "lease renew" | "lease release")
              mock_operation_lease "$@"
              ;;
            *) return 1 ;;
          esac
          ;;
        "storage blob")
          test "$3" = "list" || return 1
          test "$scenario" != "operation_container_nonempty" ||
            printf '%s\n' "foreign"
          ;;
        "lock list")
          protected_resource=""
          while test "$#" -gt 0; do
            if test "$1" = "--resource"; then
              protected_resource="$2"
              break
            fi
            shift
          done
          test -n "$protected_resource" || return 1
          protected_name="protect-patchpage-drafts"
          case "$protected_resource" in
            *"/Microsoft.DBforPostgreSQL/flexibleServers/"*) protected_name="protect-patchpage-postgres" ;;
          esac
          if test "$scenario" = "foreign_workload_lock"; then
            printf 'foreign-lock\tReadOnly\t%s/providers/Microsoft.Authorization/locks/foreign-lock\n' "$protected_resource"
          elif test -f "$scenario_root/$protected_name"; then
            printf '%s\tCanNotDelete\t%s/providers/Microsoft.Authorization/locks/%s\n' \
              "$protected_name" "$protected_resource" "$protected_name"
          fi
          ;;
        "lock create")
          test "$scenario" != "workload_lock_create_failure" || return 1
          case " $NORMALIZED_AZ_ARGS " in
            *" --name protect-patchpage-drafts "*) : > "$scenario_root/protect-patchpage-drafts" ;;
            *" --name protect-patchpage-postgres "*) : > "$scenario_root/protect-patchpage-postgres" ;;
            *) return 1 ;;
          esac
          ;;
        "lock show")
          test "$scenario" != "workload_lock_show_failure" || return 1
          lock_id=""
          while test "$#" -gt 0; do
            if test "$1" = "--ids"; then lock_id="$2"; break; fi
            shift
          done
          test -n "$lock_id" || return 1
          if test "$scenario" = "workload_lock_level_drift"; then
            printf 'ReadOnly\t%s\n' "$lock_id"
          else
            printf 'CanNotDelete\t%s\n' "$lock_id"
          fi
          ;;
        "acr show")
          if test "$scenario" = "resume_acr_id_mismatch"; then
            printf '%s\n' \
              "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-workload/providers/Microsoft.ContainerRegistry/registries/other"
          else
            printf '%s\n' \
              "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-workload/providers/Microsoft.ContainerRegistry/registries/acrpatchpageabc123"
          fi
          ;;
        "acr build")
          test "$scenario" != "build_failure"
          ;;
        "acr manifest")
          test "$3" = "show-metadata" || return 1
          test "$scenario" != "digest_resolution_failure" || return 1
          if test "$scenario" = "invalid_digest"; then
            printf '%s\n' "sha256:not-a-digest"
          else
            printf '%s\n' "$IMAGE_DIGEST_VALUE"
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    eval "$DEPLOY_RESOURCES_BLOCK"
    printf '%s\n' completed >> "$log"
  ) >"$output" 2>&1
}

test_deploy_resources() {
  for scenario in \
    subscription_set_failure \
    subscription_show_failure \
    subscription_mismatch \
    repo_root_failure \
    diagnostic_secure_dir_failure \
    diagnostic_log_open_failure \
    init_failure \
    terraform_subscription_console_failure \
    terraform_subscription_mismatch \
    terraform_resource_group_console_failure \
    terraform_resource_group_invalid \
    workload_group_exists_check_failure \
    workload_group_exists \
    state_list_failure \
    state_list_aggregate_false_missing \
    state_diagnostic_open_failure \
    state_diagnostic_read_failure \
    state_diagnostic_remove_failure \
    nonempty_initial_state \
    target_secure_dir_failure \
    target_plan_failure \
    target_plan_show_failure \
    target_plan_delete \
    target_apply_failure \
    target_cleanup_failure \
    resume_partial_rg_success \
    resume_target_complete_success \
    resume_full_state \
    resume_live_foreign_resource \
    resume_acr_without_random \
    resume_unexpected_state \
    resume_acr_id_mismatch \
    resource_group_output_failure \
    resource_group_output_empty \
    operation_container_id_mismatch \
    operation_container_nonempty \
    operation_binding_foreign \
    operation_binding_update_failure \
    operation_binding_concurrent_metadata \
    foreign_workload_lock \
    workload_lock_create_failure \
    workload_lock_show_failure \
    workload_lock_level_drift \
    git_status_failure \
    dirty_worktree \
    git_failure \
    git_empty \
    git_short \
    acr_output_failure \
    acr_output_empty \
    unexpected_acr_name \
    login_output_failure \
    login_output_empty \
    unexpected_login_server \
    build_failure \
    digest_resolution_failure \
    invalid_digest \
    secure_plan_dir_failure \
    plan_failure \
    plan_gate_show_failure \
    plan_delete \
    plan_replacement \
    plan_summary_failure \
    final_apply_failure \
    initial_cleanup_failure \
    diagnostic_cleanup_failure \
    success; do
    if run_deploy_resources_block "$scenario"; then
      status=0
    else
      status=$?
    fi

    log="$TMP_DIR/deploy-$scenario.log"
    output="$TMP_DIR/deploy-$scenario.out"
    image_vars="$TMP_DIR/deploy-$scenario/infra/azure/server-image.auto.tfvars"
    diagnostic_path_file="$TMP_DIR/deploy-$scenario/diagnostic-dir"
    case "$scenario" in
      success | diagnostic_cleanup_failure)
        test "$status" -eq 0 || fail "guarded deployment rejected successful commands"
        test -f "$image_vars" || fail "successful build did not write server image variables"
        grep -Fqx \
          'server_image = "acrpatchpageabc123.azurecr.io/patchpage-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
          "$image_vars" ||
          fail "deployment wrote an unexpected digest-based server image reference"
        backend_file="$TMP_DIR/deploy-$scenario/infra/azure/backend.hcl"
        test "$(cat "$backend_file")" = \
          'resource_group_name  = "rg-patchpage-tfstate"
storage_account_name = "patchpagestate"
container_name       = "tfstate"
key                  = "patchpage-prod.tfstate"' ||
          fail "deployment did not replace stale backend coordinates with the verified state record"
        backend_mode="$(
          file_mode "$backend_file"
        )"
        test "$backend_mode" = "600" ||
          fail "deployment backend configuration is not mode 0600"
        grep -Fqx \
          'terraform init -input=false -reconfigure -backend-config=backend.hcl' \
          "$log" ||
          fail "deployment did not reconfigure Terraform to the verified backend"
        initial_build_tag="$(
          sed -n \
            's/^az acr build --registry acrpatchpageabc123 --image patchpage-server:\([^ ]*\) --build-arg REVISION=1111111111111111111111111111111111111111 --file apps\/server\/Dockerfile \.\.\/\.\.$/\1/p' \
            "$log"
        )"
        printf '%s\n' "$initial_build_tag" |
          grep -Eq '^1111111111111111111111111111111111111111-[0-9a-f]{32}$' ||
          fail "deployment did not use a unique full-commit image tag with revision provenance"
        grep -Fqx \
          "az acr manifest show-metadata --registry acrpatchpageabc123 --name patchpage-server:$initial_build_tag --query digest --output tsv" \
          "$log" ||
          fail "deployment did not resolve the unique built tag to an ACR manifest digest"
        target_plan="$(
          awk '
            /^terraform plan -target=azurerm_container_registry\.patchpage -input=false -out=.*\/registry-target\.tfplan$/ {
              sub(/^terraform plan -target=azurerm_container_registry\.patchpage -input=false -out=/, "")
              print
            }
          ' "$log"
        )"
        test -n "$target_plan" ||
          fail "deployment did not create a saved registry-target plan"
        case "$target_plan" in
          "$diagnostic_root"/*) ;;
          *) fail "deployment stored its registry-target plan outside the private diagnostic root" ;;
        esac
        grep -Fqx "terraform show -json $target_plan" "$log" ||
          fail "deployment did not inspect the registry-target plan"
        grep -Fqx "terraform apply -input=false $target_plan" "$log" ||
          fail "deployment did not apply the reviewed registry-target plan"
        initial_plan="$(
          awk '
            /^terraform plan -input=false -out=.*\/initial\.tfplan$/ {
              sub(/^terraform plan -input=false -out=/, "")
              print
            }
          ' "$log"
        )"
        test -n "$initial_plan" ||
          fail "deployment did not create a saved plan in the secure directory"
        case "$initial_plan" in
          "$diagnostic_root"/*) ;;
          *) fail "deployment stored its initial plan outside the private diagnostic root" ;;
        esac
        test "$(grep -Fxc "terraform show -json $initial_plan" "$log")" -eq 1 ||
          fail "deployment did not capture the saved plan JSON exactly once"
        grep -Fqx "terraform apply -input=false $initial_plan" "$log" ||
          fail "deployment did not apply the reviewed saved plan"
        awk '
          /^terraform apply -input=false .*\/initial\.tfplan$/ { stage = 1; next }
          stage == 1 && /^az storage container-rm show --ids .*\/blobServices\/default\/containers\/patchpage-operations --query id --output tsv$/ { stage = 2; next }
          stage == 2 && /^az storage container lease acquire --account-name patchpagestate --container-name patchpage-operations --auth-mode key --lease-duration 60 --proposed-lease-id [0-9a-f-]{36} --output none$/ { binding_lease_id = $15; stage = 3; next }
          stage == 3 && /^az storage container metadata update --account-name patchpagestate --name patchpage-operations --auth-mode key --lease-id [0-9a-f-]{36} --metadata patchpage_workload_binding_sha256=[0-9a-f]{64} --output none$/ && $13 == binding_lease_id { stage = 4; next }
          stage == 4 && /^az storage container lease release --account-name patchpagestate --container-name patchpage-operations --auth-mode key --lease-id [0-9a-f-]{36} --output none$/ && $13 == binding_lease_id { stage = 5; next }
          stage == 5 && /^az lock create --name protect-patchpage-drafts --lock-type CanNotDelete --resource .*\/Microsoft\.Storage\/storageAccounts\/patchpagedrafts$/ { stage = 6; next }
          stage == 6 && /^az lock show --ids .*\/Microsoft\.Storage\/storageAccounts\/patchpagedrafts\/providers\/Microsoft\.Authorization\/locks\/protect-patchpage-drafts --query \[level,id\] --output tsv$/ { stage = 7; next }
          stage == 7 && /^az lock create --name protect-patchpage-postgres --lock-type CanNotDelete --resource .*\/Microsoft\.DBforPostgreSQL\/flexibleServers\/patchpage-postgres$/ { stage = 8; next }
          stage == 8 && /^az lock show --ids .*\/Microsoft\.DBforPostgreSQL\/flexibleServers\/patchpage-postgres\/providers\/Microsoft\.Authorization\/locks\/protect-patchpage-postgres --query \[level,id\] --output tsv$/ { stage = 9 }
          END { exit stage == 9 ? 0 : 1 }
        ' "$log" ||
          fail "deployment did not lease-bind the exact operation container and protect only persistent child resources after apply"
        if grep -Eq '^az lock .*--resource-group ' "$log"; then
          fail "deployment created or required a workload resource-group lock"
        fi
        grep -Fqx completed "$log" ||
          fail "successful deployment did not complete"
        test -f "$diagnostic_path_file" ||
          fail "successful deployment did not create a private diagnostic location"
        if test "$scenario" = "diagnostic_cleanup_failure"; then
          test -d "$(cat "$diagnostic_path_file")" ||
            fail "deployment cleanup-failure scenario unexpectedly removed diagnostics"
          grep -Fqx 'Terraform succeeded, but private diagnostic cleanup failed.' "$output" ||
            fail "deployment cleanup failure did not emit only its generic error"
        else
          test ! -d "$(cat "$diagnostic_path_file")" ||
            fail "successful deployment retained private Terraform diagnostics"
        fi
        ;;
      resume_partial_rg_success | resume_target_complete_success)
        test "$status" -eq 0 || fail "guarded deployment rejected $scenario"
        test -f "$image_vars" ||
          fail "resumed deployment did not write digest-based image variables"
        target_plan="$(
          awk '
            /^terraform plan -target=azurerm_container_registry\.patchpage -input=false -out=.*\/registry-target\.tfplan$/ {
              sub(/^terraform plan -target=azurerm_container_registry\.patchpage -input=false -out=/, "")
              print
            }
          ' "$log"
        )"
        test -n "$target_plan" ||
          fail "resumed deployment did not save a registry-target plan"
        case "$target_plan" in
          "$diagnostic_root"/*) ;;
          *) fail "resumed deployment stored its target plan outside the private diagnostic root" ;;
        esac
        grep -Fqx "terraform show -json $target_plan" "$log" ||
          fail "resumed deployment did not inspect its registry-target plan"
        grep -Fqx "terraform apply -input=false $target_plan" "$log" ||
          fail "resumed deployment did not apply only its reviewed registry-target plan"
        grep -Fq \
          'az lock create --name protect-patchpage-drafts --lock-type CanNotDelete --resource ' \
          "$log" ||
          fail "resumed deployment did not protect the exact workload Storage account"
        grep -Fq \
          'az lock create --name protect-patchpage-postgres --lock-type CanNotDelete --resource ' \
          "$log" ||
          fail "resumed deployment did not protect the exact PostgreSQL server"
        if grep -Eq '^az lock .*--resource-group ' "$log"; then
          fail "resumed deployment locked its mixed workload resource group"
        fi
        grep -Fqx completed "$log" ||
          fail "resumed deployment did not complete"
        test -f "$diagnostic_path_file" ||
          fail "resumed deployment did not create a private diagnostic location"
        test ! -d "$(cat "$diagnostic_path_file")" ||
          fail "resumed deployment retained private Terraform diagnostics"
        ;;
      secure_plan_dir_failure | plan_failure | plan_gate_show_failure | \
        plan_delete | plan_replacement | plan_summary_failure | final_apply_failure | \
        initial_cleanup_failure | operation_container_id_mismatch | \
        operation_container_nonempty | operation_binding_foreign | \
        operation_binding_update_failure | operation_binding_concurrent_metadata | \
        foreign_workload_lock | workload_lock_create_failure | \
        workload_lock_show_failure | workload_lock_level_drift)
        test "$status" -ne 0 || fail "deployment masked $scenario"
        test -f "$image_vars" ||
          fail "deployment lost the verified digest before $scenario"
        ;;
      *)
        test "$status" -ne 0 || fail "deployment masked $scenario"
        test ! -e "$image_vars" ||
          fail "deployment wrote image variables after $scenario"
        ;;
    esac

    case "$scenario" in
      digest_resolution_failure | invalid_digest | \
        secure_plan_dir_failure | plan_failure | plan_gate_show_failure | \
        plan_delete | plan_replacement | plan_summary_failure)
        if grep -Eq '^terraform apply -input=false .*/initial\.tfplan$' "$log"; then
          fail "deployment reached the final apply after $scenario"
        fi
        ;;
    esac
    case "$scenario" in
      git_status_failure | dirty_worktree)
        if grep -Fq 'az acr build ' "$log"; then
          fail "deployment built an image after rejecting $scenario"
        fi
        ;;
    esac
    case "$scenario" in
      operation_binding_update_failure | operation_binding_concurrent_metadata)
        grep -Eq \
          '^az storage container lease acquire .* --auth-mode key --lease-duration 60 --proposed-lease-id [0-9a-f-]{36} --output none$' \
          "$log" ||
          fail "deployment did not acquire a finite lease before sealing $scenario"
        grep -Eq \
          '^az storage container lease release .* --auth-mode key --lease-id [0-9a-f-]{36} --output none$' \
          "$log" ||
          fail "deployment did not release the finite binding lease after $scenario"
        if test "$scenario" = "operation_binding_concurrent_metadata" &&
          grep -Fq 'az storage container metadata update ' "$log"; then
          fail "deployment overwrote concurrent operation-container metadata"
        fi
        if grep -Fq 'az lock create ' "$log"; then
          fail "deployment created workload locks after $scenario"
        fi
        ;;
    esac
    case "$scenario" in
      terraform_subscription_console_failure | terraform_subscription_mismatch | \
        terraform_resource_group_console_failure | terraform_resource_group_invalid | \
        workload_group_exists_check_failure | workload_group_exists | state_list_failure | \
        nonempty_initial_state | target_secure_dir_failure | target_plan_failure | \
        target_plan_show_failure | target_plan_delete | resume_full_state | \
        resume_acr_without_random | resume_unexpected_state | resume_acr_id_mismatch | \
        resume_live_foreign_resource | resume_stronger_lock)
        if grep -Eq '^terraform apply -input=false .*/registry-target\.tfplan$' "$log"; then
          fail "deployment reached the registry-target apply after $scenario"
        fi
        ;;
    esac
    if test "$scenario" != "success" &&
      test "$scenario" != "diagnostic_cleanup_failure" &&
      test "$scenario" != "resume_partial_rg_success" &&
      test "$scenario" != "resume_target_complete_success" &&
      grep -q '^completed$' "$log"; then
      fail "deployment continued after $scenario"
    fi
    if grep -Eq \
      '00000000-0000-0000-0000-000000000000|22222222-2222-2222-2222-222222222222|private-(az|terraform)-diagnostic' \
      "$output"; then
      fail "deployment exposed private identifiers or producer diagnostics after $scenario"
    fi
    if grep -Fq "$TMP_DIR/deploy-diagnostics-$scenario" "$output"; then
      fail "deployment exposed the private Terraform diagnostic path"
    fi
    if test "$scenario" = "final_apply_failure"; then
      test -f "$diagnostic_path_file" ||
        fail "failed deployment lost its private diagnostic location"
      diagnostic_log="$(cat "$diagnostic_path_file")/terraform.log"
      test -f "$diagnostic_log" ||
        fail "failed deployment did not preserve Terraform diagnostics"
      diagnostic_mode="$(
        file_mode "$diagnostic_log"
      )"
      test "$diagnostic_mode" = "600" ||
        fail "failed deployment diagnostic log is not mode 0600"
      grep -Fq 'private-terraform-diagnostic apply -input=false' "$diagnostic_log" ||
        fail "failed deployment diagnostic log omitted provider diagnostics"
    fi
  done
}

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
  while test "$#" -gt 0; do
    case "$1" in
      --account-name) operation_account="$2"; shift 2 ;;
      --container-name) operation_container="$2"; shift 2 ;;
      --auth-mode) operation_auth_mode="$2"; shift 2 ;;
      --lease-duration) operation_duration="$2"; shift 2 ;;
      --proposed-lease-id) operation_proposed_id="$2"; shift 2 ;;
      --lease-id) operation_lease_id="$2"; shift 2 ;;
      --output) shift 2 ;;
      --subscription)
        test "$2" = "$SUBSCRIPTION_ID" || return 1
        shift 2
        ;;
      *) return 1 ;;
    esac
  done
  test "$operation_account" = "$STATE_STORAGE_ACCOUNT" || return 1
  test "$operation_container" = "patchpage-operations" || return 1
  test "$operation_auth_mode" = "${EXPECTED_OPERATION_AUTH_MODE:-login}" || return 1
  operation_lease_file="$scenario_root/operation-lease-id"
  case "$operation_lease_action" in
    acquire)
      case "$operation_duration" in
        -1 | 60) ;;
        *) return 1 ;;
      esac
      printf '%s\n' "$operation_proposed_id" |
        grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ||
        return 1
      case "$scenario" in
        operation_lease_held | operation_lease_acquire_failure) return 1 ;;
      esac
      test ! -e "$operation_lease_file" || return 1
      printf '%s\n' "$operation_proposed_id" > "$operation_lease_file"
      ;;
    renew)
      test -f "$operation_lease_file" || return 1
      test "$operation_lease_id" = "$(cat "$operation_lease_file")" || return 1
      test "$scenario" != "operation_lease_renew_failure" || return 1
      ;;
    release)
      test -f "$operation_lease_file" || return 1
      test "$operation_lease_id" = "$(cat "$operation_lease_file")" || return 1
      test "$scenario" != "operation_lease_release_failure" || return 1
      rm -f "$operation_lease_file"
      ;;
    *) return 1 ;;
  esac
}

run_app_release_block() {
  scenario="$1"
  scenario_root="$TMP_DIR/release-$scenario"
  log="$TMP_DIR/release-$scenario.log"
  output="$TMP_DIR/release-$scenario.out"
  rm -rf "$scenario_root"
  mkdir -p "$scenario_root"
  scenario_root_canonical="$(CDPATH= cd -- "$scenario_root" && pwd -P)"
  : > "$log"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    STATE_STORAGE_ACCOUNT="patchpagestate"
    STATE_CONTAINER="tfstate"
    STATE_KEY="patchpage-prod.tfstate"
    RESOURCE_GROUP="rg-patchpage-workload"
    CONTAINER_APP="patchpage-app"
    ACR="acrpatchpageabc123"
    EXPECTED_STORAGE_ACCOUNT_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/patchpagedrafts"
    EXPECTED_POSTGRES_SERVER_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-postgres"
    LOGIN_SERVER="acrpatchpageabc123.azurecr.io"
    CONTAINER_APP_FQDN="patchpage-app.example.invalid"
    PUBLIC_BASE_URL="https://drafts.example.invalid"
    CANARY_URL="$PUBLIC_BASE_URL/d/abc123def456"
    case "$scenario" in
      public_base_credentials) PUBLIC_BASE_URL="https://user@drafts.example.invalid" ;;
      public_base_port) PUBLIC_BASE_URL="https://drafts.example.invalid:443" ;;
      public_base_path) PUBLIC_BASE_URL="https://drafts.example.invalid/path" ;;
      public_base_query) PUBLIC_BASE_URL="https://drafts.example.invalid?mode=canary" ;;
      public_base_fragment) PUBLIC_BASE_URL="https://drafts.example.invalid#canary" ;;
      public_base_trailing_slash) PUBLIC_BASE_URL="https://drafts.example.invalid/" ;;
      foreign_canary_origin) CANARY_URL="https://foreign.example.invalid/d/abc123def456" ;;
      wrong_canary_path) CANARY_URL="$PUBLIC_BASE_URL/v/abc123def456" ;;
      canary_query) CANARY_URL="$PUBLIC_BASE_URL/d/abc123def456?mode=canary" ;;
      canary_fragment) CANARY_URL="$PUBLIC_BASE_URL/d/abc123def456#canary" ;;
      invalid_canary_id) CANARY_URL="$PUBLIC_BASE_URL/d/invalid-id" ;;
      mismatched_private_login_server) LOGIN_SERVER="otherregistry.azurecr.io" ;;
      mixed_state_workload_record) STATE_KEY="patchpage-foreign.tfstate" ;;
      uppercase_public_hostname)
        PUBLIC_BASE_URL="https://Drafts.Example.Invalid"
        CANARY_URL="$PUBLIC_BASE_URL/d/abc123def456"
        ;;
    esac
    case "$scenario" in
      empty_canary_marker) CANARY_MARKER="" ;;
      whitespace_canary_marker) CANARY_MARKER="   " ;;
      *) CANARY_MARKER="PATCHPAGE_CANARY" ;;
    esac
    FULL_SHA="1111111111111111111111111111111111111111"
    ROLLBACK_DIGEST_VALUE="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    RELEASE_DIGEST_VALUE="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    if test "$scenario" = "already_deployed_digest"; then
      RELEASE_DIGEST_VALUE="$ROLLBACK_DIGEST_VALUE"
    fi
    ROLLBACK_IMAGE_VALUE="$LOGIN_SERVER/patchpage-server@$ROLLBACK_DIGEST_VALUE"
    RELEASE_IMAGE_VALUE="$LOGIN_SERVER/patchpage-server@$RELEASE_DIGEST_VALUE"
    OLD_REVISION_NAME="patchpage-app--old"
    NEW_REVISION_NAME="patchpage-app--new"
    LATER_REVISION_NAME="patchpage-app--later"
    EXPECTED_OPERATION_BINDING_SHA256="$(
      printf '%s\n' \
        'patchpage-operation-binding-v1' \
        "subscription_id=$SUBSCRIPTION_ID" \
        "state_storage_account=$STATE_STORAGE_ACCOUNT" \
        'state_key=patchpage-prod.tfstate' \
        "resource_group=$RESOURCE_GROUP" \
        "container_app=$CONTAINER_APP" \
        "acr=$ACR" \
        "operation_container_id=/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT/blobServices/default/containers/patchpage-operations" \
        "container_app_id=/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/containerApps/$CONTAINER_APP" \
        "acr_id=/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/$ACR" \
        "storage_account_id=$EXPECTED_STORAGE_ACCOUNT_ID" \
        "postgres_server_id=$EXPECTED_POSTGRES_SERVER_ID" |
        openssl dgst -sha256 -r |
        cut -d ' ' -f1
    )"
    ROLLBACK_RECORD="$TMP_DIR/release-$scenario.rollback.env"
    case "$scenario" in
      rollback_record_directory)
        mkdir -p "$ROLLBACK_RECORD"
        ;;
      rollback_record_symlink)
        printf '%s\n' "existing-rollback-record" > "${ROLLBACK_RECORD}.target"
        command ln -s "${ROLLBACK_RECORD}.target" "$ROLLBACK_RECORD"
        ;;
      *)
        printf '%s\n' "existing-rollback-record" > "$ROLLBACK_RECORD"
        command chmod 644 "$ROLLBACK_RECORD"
        ;;
    esac

    mktemp() {
      test "$scenario" != "rollback_record_create_failure" || return 1
      command mktemp "$@"
    }

    chmod() {
      if test "$scenario" = "rollback_record_chmod_failure"; then
        case "$2" in
          "${ROLLBACK_RECORD}.tmp."*) return 1 ;;
        esac
      fi
      command chmod "$@"
    }

    git() {
      printf 'git %s\n' "$*" >> "$log"
      case "$*" in
        "rev-parse --show-toplevel")
          test "$scenario" != "repo_root_failure" || return 1
          printf '%s\n' "$scenario_root"
          ;;
        "-C $scenario_root_canonical status --porcelain")
          test "$scenario" != "git_status_failure" || return 1
          if test "$scenario" = "dirty_worktree"; then
            printf '%s\n' " M apps/server/src/index.ts"
          fi
          ;;
        "-C $scenario_root_canonical rev-parse HEAD")
          test "$scenario" != "git_failure" || return 1
          if test "$scenario" = "git_short"; then
            printf '%s\n' "1111111"
          else
            printf '%s\n' "$FULL_SHA"
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    terraform() {
      printf 'terraform %s\n' "$*" >> "$log"
      return 1
    }

    sleep() {
      printf 'sleep %s\n' "$*" >> "$log"
    }

    az() {
      normalize_az_args "$@" || return 1
      printf 'az %s\n' "$NORMALIZED_AZ_ARGS" >> "$log"
      case "$1 $2" in
        "account set")
          test "$scenario" != "subscription_set_failure"
          ;;
        "account show")
          test "$scenario" != "subscription_show_failure" || return 1
          if test "$scenario" = "subscription_mismatch"; then
            printf '%s\n' "22222222-2222-2222-2222-222222222222"
          else
            printf '%s\n' "$SUBSCRIPTION_ID"
          fi
          ;;
        "lock show")
          test "$scenario" != "workload_lock_show_failure" || return 1
          lock_id=""
          while test "$#" -gt 0; do
            if test "$1" = "--ids"; then lock_id="$2"; break; fi
            shift
          done
          test -n "$lock_id" || return 1
          if test "$scenario" = "workload_lock_level_drift"; then
            printf 'ReadOnly\t%s\n' "$lock_id"
          else
            printf 'CanNotDelete\t%s\n' "$lock_id"
          fi
          ;;
        "storage account")
          return 1
          ;;
        "storage container-rm")
          test "$3" = "show" || return 1
          if test "$scenario" = "operation_container_id_mismatch"; then
            printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/foreign/blobServices/default/containers/patchpage-operations"
          else
            printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT/blobServices/default/containers/patchpage-operations"
          fi
          ;;
        "storage container")
          case "$3" in
            exists)
              if test "$scenario" = "operation_container_missing"; then
                printf '%s\n' "false"
              else
                printf '%s\n' "true"
              fi
              ;;
            metadata)
              test "$4" = "show" || return 1
              if test "$scenario" = "operation_binding_mismatch"; then
                printf '%s\n' '{"patchpage_workload_binding_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}'
              elif test "$scenario" = "operation_binding_foreign_metadata"; then
                printf '%s\n' '{"foreign":"value"}'
              else
                printf '{"patchpage_workload_binding_sha256":"%s"}\n' "$EXPECTED_OPERATION_BINDING_SHA256"
              fi
              ;;
            lease) mock_operation_lease "$@" ;;
            *) return 1 ;;
          esac
          ;;
        "storage blob")
          test "$3" = "list" || return 1
          test "$scenario" != "operation_container_nonempty" ||
            printf '%s\n' "unexpected"
          ;;
        "acr show")
          case " $* " in
            *" --query id "*)
              if test "$scenario" = "wrong_acr_id"; then
                printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/otherregistry"
              else
                printf '%s\n' "$EXPECTED_ACR_ID"
              fi
              ;;
            *" --query loginServer "*)
              if test "$scenario" = "wrong_live_login_server"; then
                printf '%s\n' "otherregistry.azurecr.io"
              else
                printf '%s\n' "acrpatchpageabc123.azurecr.io"
              fi
              ;;
            *) return 1 ;;
          esac
          ;;
        "containerapp show")
          case " $* " in
            *" --ids "*" --output json "*)
              app_show_count_file="$scenario_root/containerapp-show-count"
              app_show_count=0
              if test -e "$app_show_count_file"; then
                app_show_count="$(cat "$app_show_count_file")"
              fi
              app_show_count=$((app_show_count + 1))
              printf '%s\n' "$app_show_count" > "$app_show_count_file"
              app_id="$EXPECTED_CONTAINER_APP_ID"
              app_fqdn="$CONTAINER_APP_FQDN"
              app_public_base_url="$PUBLIC_BASE_URL"
              app_public_hostname="$(
                printf '%s' "${PUBLIC_BASE_URL#https://}" |
                  tr '[:upper:]' '[:lower:]'
              )"
              app_custom_domains="[{\"name\":\"$app_public_hostname\",\"bindingType\":\"SniEnabled\",\"certificateId\":\"managed-cert-id\"}]"
              app_env='[{"name":"PATCHPAGE_PUBLIC_BASE_URL","value":"PLACEHOLDER"}]'
              app_image="$ROLLBACK_IMAGE_VALUE"
              app_latest_revision="$OLD_REVISION_NAME"
              app_ready_revision="$OLD_REVISION_NAME"
              if test -e "$scenario_root/release-updated"; then
                app_image="$RELEASE_IMAGE_VALUE"
                app_latest_revision="$NEW_REVISION_NAME"
                app_ready_revision="$NEW_REVISION_NAME"
                updated_app_show_count_file="$scenario_root/updated-app-show-count"
                updated_app_show_count=0
                if test -e "$updated_app_show_count_file"; then
                  updated_app_show_count="$(cat "$updated_app_show_count_file")"
                fi
                updated_app_show_count=$((updated_app_show_count + 1))
                printf '%s\n' "$updated_app_show_count" > "$updated_app_show_count_file"
                if test "$scenario" = "final_pinned_drift" &&
                  test "$updated_app_show_count" -ge 3; then
                  app_latest_revision="$LATER_REVISION_NAME"
                  app_ready_revision="$LATER_REVISION_NAME"
                fi
              else
                case "$scenario" in
                  preexisting_pending_revision)
                    app_latest_revision="patchpage-app--pending"
                    ;;
                  preexisting_failed_revision)
                    app_latest_revision="patchpage-app--failed"
                    ;;
                esac
              fi
              case "$scenario" in
                container_app_id_mismatch) app_id="${EXPECTED_CONTAINER_APP_ID%/*}/foreign" ;;
                fqdn_mismatch) app_fqdn="foreign.example.invalid" ;;
                public_env_mismatch) app_public_base_url="https://foreign.example.invalid" ;;
                public_env_missing) app_env='[]' ;;
                public_env_duplicate) app_env='[{"name":"PATCHPAGE_PUBLIC_BASE_URL","value":"PLACEHOLDER"},{"name":"PATCHPAGE_PUBLIC_BASE_URL","value":"PLACEHOLDER"}]' ;;
                custom_domain_missing) app_custom_domains='[]' ;;
                custom_domain_duplicate) app_custom_domains="[{\"name\":\"$app_public_hostname\",\"bindingType\":\"SniEnabled\",\"certificateId\":\"managed-cert-id\"},{\"name\":\"$app_public_hostname\",\"bindingType\":\"SniEnabled\",\"certificateId\":\"managed-cert-id\"}]" ;;
                custom_domain_mismatch) app_custom_domains='[{"name":"foreign.example.invalid","bindingType":"SniEnabled","certificateId":"managed-cert-id"}]' ;;
                custom_domain_binding_invalid) app_custom_domains="[{\"name\":\"$app_public_hostname\",\"bindingType\":\"Disabled\",\"certificateId\":\"managed-cert-id\"}]" ;;
                custom_domain_certificate_missing) app_custom_domains="[{\"name\":\"$app_public_hostname\",\"bindingType\":\"SniEnabled\"}]" ;;
                rollback_image_show_failure) app_image="" ;;
                rollback_image_invalid) app_image="$LOGIN_SERVER/patchpage-server:mutable" ;;
                rollback_digest_invalid) app_image="$LOGIN_SERVER/patchpage-server@sha256:invalid" ;;
                prelease_locked_image_mismatch)
                  if test "$app_show_count" -ge 2; then
                    app_image="$RELEASE_IMAGE_VALUE"
                  fi
                  ;;
                preupdate_image_mismatch)
                  if test "$app_show_count" -ge 4; then
                    app_image="$RELEASE_IMAGE_VALUE"
                  fi
                  ;;
              esac
              app_env="$(printf '%s\n' "$app_env" | sed "s|PLACEHOLDER|$app_public_base_url|g")"
              printf '{"id":"%s","properties":{"provisioningState":"Succeeded","latestRevisionName":"%s","latestReadyRevisionName":"%s","configuration":{"activeRevisionsMode":"Single","ingress":{"fqdn":"%s","customDomains":%s,"traffic":[{"latestRevision":true,"weight":100}]}},"template":{"containers":[{"name":"server","image":"%s","env":%s}]}}}\n' \
                "$app_id" "$app_latest_revision" "$app_ready_revision" \
                "$app_fqdn" "$app_custom_domains" "$app_image" "$app_env"
              return
              ;;
          esac
          return 1
          ;;
        "containerapp revision")
          revision_action="$3"
          revision_name=
          while test "$#" -gt 0; do
            if test "$1" = "--revision"; then
              revision_name="$2"
              break
            fi
            shift
          done
          case "$revision_action" in
            show)
              revision_image="$ROLLBACK_IMAGE_VALUE"
              revision_active=true
              revision_provisioning="Provisioned"
              revision_health="Healthy"
              revision_running="Running"
              revision_weight=100
              case "$revision_name" in
                "$NEW_REVISION_NAME")
                  revision_image="$RELEASE_IMAGE_VALUE"
                  new_revision_show_count_file="$scenario_root/new-revision-show-count"
                  new_revision_show_count=0
                  if test -e "$new_revision_show_count_file"; then
                    new_revision_show_count="$(cat "$new_revision_show_count_file")"
                  fi
                  new_revision_show_count=$((new_revision_show_count + 1))
                  printf '%s\n' "$new_revision_show_count" > "$new_revision_show_count_file"
                  if test "$new_revision_show_count" -eq 1 ||
                    test "$scenario" = "never_ready_revision" ||
                    test "$scenario" = "deployed_image_show_failure"; then
                    revision_active=false
                    revision_provisioning="Provisioning"
                    revision_health="Unknown"
                    revision_running="Processing"
                    revision_weight=0
                  fi
                  case "$scenario" in
                    wrong_revision_image | deployed_image_mismatch)
                      revision_image="$ROLLBACK_IMAGE_VALUE"
                      ;;
                    final_image_show_failure)
                      test "$new_revision_show_count" -lt 3 || return 1
                      ;;
                    final_image_mismatch)
                      if test "$new_revision_show_count" -ge 3; then
                        revision_image="$ROLLBACK_IMAGE_VALUE"
                      fi
                      ;;
                  esac
                  ;;
                patchpage-app--pending)
                  revision_active=false
                  revision_provisioning="Provisioning"
                  revision_health="Unknown"
                  revision_running="Processing"
                  revision_weight=0
                  ;;
                patchpage-app--failed)
                  revision_active=false
                  revision_provisioning="Failed"
                  revision_health="Unhealthy"
                  revision_running="Stopped"
                  revision_weight=0
                  ;;
                "$OLD_REVISION_NAME") ;;
                *) return 1 ;;
              esac
              if test "$scenario" = "scale_to_zero_revision"; then
                revision_health="None"
                revision_running="ScaleToZero"
              fi
              printf '{"name":"%s","properties":{"active":%s,"provisioningState":"%s","healthState":"%s","runningState":"%s","trafficWeight":%s,"template":{"containers":[{"name":"server","image":"%s"}]}}}\n' \
                "$revision_name" "$revision_active" "$revision_provisioning" \
                "$revision_health" "$revision_running" "$revision_weight" \
                "$revision_image"
              ;;
            list)
              if test -e "$scenario_root/release-updated"; then
                if test "$scenario" = "multiple_active_revisions"; then
                  printf '[{"name":"%s","properties":{"active":true}},{"name":"%s","properties":{"active":true}}]\n' \
                    "$OLD_REVISION_NAME" "$NEW_REVISION_NAME"
                else
                  printf '[{"name":"%s","properties":{"active":true}}]\n' \
                    "$NEW_REVISION_NAME"
                fi
              else
                printf '[{"name":"%s","properties":{"active":true}}]\n' \
                  "$OLD_REVISION_NAME"
              fi
              ;;
            *) return 1 ;;
          esac
          ;;
        "containerapp update")
          test "$scenario" != "containerapp_update_failure" || return 1
          : > "$scenario_root/release-updated"
          case "$scenario" in
            update_empty_revision) ;;
            update_same_revision) printf '%s\n' "$OLD_REVISION_NAME" ;;
            *) printf '%s\n' "$NEW_REVISION_NAME" ;;
          esac
          ;;
        "acr build")
          test "$scenario" != "build_failure"
          ;;
        "acr manifest")
          test "$3" = "show-metadata" || return 1
          case " $* " in
            *" patchpage-server@$ROLLBACK_DIGEST_VALUE "*)
              test "$scenario" != "rollback_manifest_failure" || return 1
              if test "$scenario" = "rollback_manifest_mismatch"; then
                printf '%s\n' "$RELEASE_DIGEST_VALUE"
              else
                printf '%s\n' "$ROLLBACK_DIGEST_VALUE"
              fi
              ;;
            *" patchpage-server:$FULL_SHA-"*)
              test "$scenario" != "release_manifest_failure" || return 1
              if test "$scenario" = "release_digest_invalid"; then
                printf '%s\n' "sha256:invalid"
              else
                printf '%s\n' "$RELEASE_DIGEST_VALUE"
              fi
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        *)
          return 1
          ;;
      esac
    }

    curl() {
      printf 'curl %s\n' "$*" >> "$log"
      url=
      for arg do
        url="$arg"
      done
      case "$url" in
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
        *)
          return 1
          ;;
      esac
    }

    eval "$APP_RELEASE_BLOCK"
    printf '%s\n' completed >> "$log"
  ) >"$output" 2>&1
}

test_app_release() {
  for scenario in \
    empty_canary_marker \
    whitespace_canary_marker \
    public_base_credentials \
    public_base_port \
    public_base_path \
    public_base_query \
    public_base_fragment \
    public_base_trailing_slash \
    foreign_canary_origin \
    wrong_canary_path \
    canary_query \
    canary_fragment \
    invalid_canary_id \
    mismatched_private_login_server \
    subscription_set_failure \
    subscription_show_failure \
    subscription_mismatch \
    wrong_acr_id \
    wrong_live_login_server \
    container_app_id_mismatch \
    fqdn_mismatch \
    public_env_missing \
    public_env_duplicate \
    public_env_mismatch \
    custom_domain_missing \
    custom_domain_duplicate \
    custom_domain_mismatch \
    custom_domain_binding_invalid \
    custom_domain_certificate_missing \
    workload_lock_show_failure \
    workload_lock_level_drift \
    operation_container_id_mismatch \
    operation_container_missing \
    operation_container_nonempty \
    operation_binding_mismatch \
    operation_binding_foreign_metadata \
    mixed_state_workload_record \
    operation_lease_held \
    operation_lease_acquire_failure \
    operation_lease_renew_failure \
    operation_lease_release_failure \
    rollback_image_show_failure \
    rollback_image_invalid \
    rollback_digest_invalid \
    rollback_manifest_failure \
    rollback_manifest_mismatch \
    rollback_record_create_failure \
    rollback_record_directory \
    rollback_record_symlink \
    rollback_record_chmod_failure \
    repo_root_failure \
    dirty_worktree \
    git_status_failure \
    git_failure \
    git_short \
    build_failure \
    release_manifest_failure \
    release_digest_invalid \
    preexisting_pending_revision \
    preexisting_failed_revision \
    prelease_locked_image_mismatch \
    preupdate_image_mismatch \
    containerapp_update_failure \
    update_empty_revision \
    update_same_revision \
    never_ready_revision \
    wrong_revision_image \
    multiple_active_revisions \
    final_pinned_drift \
    deployed_image_show_failure \
    deployed_image_mismatch \
    final_image_show_failure \
    final_image_mismatch \
    native_health_failure \
    public_health_failure \
    native_health_status_mismatch \
    public_health_body_mismatch \
    canary_request_failure \
    canary_marker_failure \
    already_deployed_digest \
    scale_to_zero_revision \
    uppercase_public_hostname \
    success; do
    if run_app_release_block "$scenario"; then
      status=0
    else
      status=$?
    fi

    log="$TMP_DIR/release-$scenario.log"
    if test "$scenario" = "success" ||
      test "$scenario" = "uppercase_public_hostname" ||
      test "$scenario" = "scale_to_zero_revision"; then
      test "$status" -eq 0 || fail "app release rejected the successful guarded flow"
      grep -Fqx \
        'az containerapp update --resource-group rg-patchpage-workload --name patchpage-app --container-name server --image acrpatchpageabc123.azurecr.io/patchpage-server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --query properties.latestRevisionName --output tsv' \
        "$log" ||
        fail "app release did not update only the expected Container App to the reviewed digest"
      test "$(grep -Fc 'az containerapp update ' "$log")" -eq 1 ||
        fail "app release updated more than the one expected Container App"
      grep -Fqx \
        'az acr manifest show-metadata --registry acrpatchpageabc123 --name patchpage-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --query digest --output tsv' \
        "$log" ||
        fail "app release did not verify the rollback digest manifest"
      grep -Fqx \
        'az acr show --name acrpatchpageabc123 --resource-group rg-patchpage-workload --query id --output tsv' \
        "$log" ||
        fail "app release did not prove the expected ACR resource ID"
      grep -Fqx \
        'az acr show --name acrpatchpageabc123 --resource-group rg-patchpage-workload --query loginServer --output tsv' \
        "$log" ||
        fail "app release did not prove the expected live ACR login server"
      release_build_tag="$(
        sed -n \
          "s|^az acr build --registry acrpatchpageabc123 --image patchpage-server:\\([^ ]*\\) --build-arg REVISION=1111111111111111111111111111111111111111 --file apps/server/Dockerfile $scenario_root_canonical$|\\1|p" \
          "$log"
      )"
      printf '%s\n' "$release_build_tag" |
        grep -Eq '^1111111111111111111111111111111111111111-[0-9a-f]{32}$' ||
        fail "app release did not use a unique full-commit image tag with revision provenance"
      grep -Fqx \
        "az acr manifest show-metadata --registry acrpatchpageabc123 --name patchpage-server:$release_build_tag --query digest --output tsv" \
        "$log" ||
        fail "app release did not resolve the unique release manifest digest"
      rollback_record="$TMP_DIR/release-$scenario.rollback.env"
      grep -Fqx \
        'ROLLBACK_IMAGE_REF=acrpatchpageabc123.azurecr.io/patchpage-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
        "$rollback_record" ||
        fail "app release did not persist the verified rollback digest"
      grep -Fqx \
        'RELEASE_IMAGE_REF=acrpatchpageabc123.azurecr.io/patchpage-server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
        "$rollback_record" ||
        fail "app release did not bind the rollback record to the new release digest"
      test "$(wc -l < "$rollback_record" | tr -d ' ')" -eq 2 ||
        fail "app release rollback record contains unexpected fields"
      grep -Eq \
        '^az storage container lease acquire --account-name patchpagestate --container-name patchpage-operations --auth-mode login --lease-duration -1 --proposed-lease-id [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} --output none$' \
        "$log" ||
        fail "app release did not acquire an infinite GUID operation lease"
      grep -Eq \
        '^az storage container lease release --account-name patchpagestate --container-name patchpage-operations --auth-mode login --lease-id [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} --output none$' \
        "$log" ||
        fail "app release did not release its exact operation lease"
      lease_id="$(sed -n 's/^az storage container lease acquire .* --proposed-lease-id \([^ ]*\) --output none$/\1/p' "$log")"
      test -n "$lease_id" || fail "app release did not record a proposed lease ID in the mock log"
      grep -Fq "az storage container lease renew --account-name patchpagestate --container-name patchpage-operations --auth-mode login --lease-id $lease_id --output none" "$log" ||
        fail "app release did not renew with the exact acquired lease ID"
      grep -Fqx \
        'az storage blob list --account-name patchpagestate --container-name patchpage-operations --auth-mode login --include d v --num-results * --query [].name --output tsv' \
        "$log" ||
        fail "app release did not verify the operation container is empty"
      test "$(grep -Fxc "az containerapp show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.App/containerApps/patchpage-app --output json" "$log")" -ge 7 ||
        fail "app release did not independently fetch Container App JSON for its pinned gates"
      grep -Fqx \
        'az containerapp revision show --resource-group rg-patchpage-workload --name patchpage-app --revision patchpage-app--new --output json' \
        "$log" ||
        fail "app release did not inspect the exact returned revision"
      grep -Fqx \
        'az containerapp revision list --resource-group rg-patchpage-workload --name patchpage-app --all --output json' \
        "$log" ||
        fail "app release did not inspect all revisions"
      grep -Fqx \
        'az storage container-rm show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/patchpage-operations --query id --output tsv' \
        "$log" ||
        fail "app release did not prove the exact operation-container resource ID"
      grep -Fqx \
        'az lock show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.Storage/storageAccounts/patchpagedrafts/providers/Microsoft.Authorization/locks/protect-patchpage-drafts --query [level,id] --output tsv' \
        "$log" ||
        fail "app release did not prove the exact workload Storage lock"
      grep -Fqx \
        'az lock show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-postgres/providers/Microsoft.Authorization/locks/protect-patchpage-postgres --query [level,id] --output tsv' \
        "$log" ||
        fail "app release did not prove the exact PostgreSQL lock"
      if grep -Fq 'az storage account show ' "$log"; then
        fail "app release required parent state-account management read"
      fi
      awk '
        /^az lock show --ids .*protect-patchpage-drafts / { storage_lock = NR }
        /^az lock show --ids .*protect-patchpage-postgres / { postgres_lock = NR }
        /^az containerapp show --ids .* --output json$/ { if (!app) app = NR }
        /^az storage container-rm show --ids .*patchpage-operations / { container_id = NR }
        /^az storage container metadata show .* --auth-mode login --output json$/ { binding = NR }
        /^az storage container lease acquire / { lease = NR }
        /^az acr build / { build = NR }
        /^az containerapp update / { update = NR }
        /^az containerapp revision show .*--revision patchpage-app--new / { if (!revision) revision = NR }
        /^curl .*\/healthz$/ { smoke = NR }
        /^az storage container lease release / { release = NR }
        END {
          exit !(storage_lock && postgres_lock && app && container_id && binding && lease && build && update && revision && smoke && release &&
            storage_lock < build && postgres_lock < build && app < build &&
            container_id < build && binding < build && lease < build && build < update &&
            update < revision && revision < smoke && smoke < release)
        }
      ' "$log" ||
        fail "app release did not complete every identity, endpoint, lock, and bound-lease gate before build/update"
      test "$(grep -Ec '^curl .* --connect-timeout 15 --max-time 120 ' "$log")" -eq 3 ||
        fail "app release did not bound every post-deploy endpoint request"
      grep -Fqx 'sleep 5' "$log" ||
        fail "app release success did not exercise bounded readiness polling"
      rollback_mode="$(
        file_mode "$rollback_record"
      )"
      test "$rollback_mode" = "600" ||
        fail "app release rollback record is not mode 0600"
      grep -Fqx completed "$log" ||
        fail "successful app release did not complete"
    elif test "$scenario" = "already_deployed_digest"; then
      test "$status" -eq 0 ||
        fail "app release rejected the already-deployed digest"
      if grep -Fq 'az containerapp update ' "$log"; then
        fail "app release updated the Container App for an already-deployed digest"
      fi
      grep -Eq '^az storage container lease release ' "$log" ||
        fail "app release did not release its lease after the no-op digest check"
      grep -Fqx \
        'existing-rollback-record' \
        "$TMP_DIR/release-$scenario.rollback.env" ||
        fail "app release rewrote the rollback record for an already-deployed digest"
      grep -Fqx \
        'Release image is already deployed; no update is required.' \
        "$TMP_DIR/release-$scenario.out" ||
        fail "app release omitted its no-op result"
      if grep -Fq '^completed$' "$log"; then
        fail "app release continued past its already-deployed digest guard"
      fi
    else
      test "$status" -ne 0 || fail "app release accepted $scenario"
      if grep -q '^completed$' "$log"; then
        fail "app release continued after $scenario"
      fi
      if test "$scenario" = "rollback_record_chmod_failure"; then
        failed_rollback_record="$TMP_DIR/release-$scenario.rollback.env"
        grep -Fqx 'existing-rollback-record' "$failed_rollback_record" ||
          fail "failed rollback record replacement modified the existing record"
      fi
      case "$scenario" in
        build_failure | release_manifest_failure | release_digest_invalid)
          failed_rollback_record="$TMP_DIR/release-$scenario.rollback.env"
          grep -Fqx 'existing-rollback-record' "$failed_rollback_record" ||
            fail "app release wrote the rollback record before the release digest was known"
          ;;
      esac
    fi
    if test "$scenario" = "rollback_record_directory" ||
      test "$scenario" = "rollback_record_symlink"; then
      if grep -Fq 'az account set ' "$log"; then
        fail "app release mutated Azure before rejecting $scenario"
      fi
    fi
    case "$scenario" in
      public_base_credentials | public_base_port | public_base_path | \
        public_base_query | public_base_fragment | public_base_trailing_slash | \
        foreign_canary_origin | wrong_canary_path | canary_query | \
        canary_fragment | invalid_canary_id)
        if grep -Fq 'az ' "$log"; then
          fail "app release contacted Azure before rejecting $scenario"
        fi
        ;;
      mismatched_private_login_server | wrong_acr_id | wrong_live_login_server)
        if grep -Eq '^az acr (build|manifest) |^az containerapp update ' "$log"; then
          fail "app release accessed an image or updated the workload after $scenario"
        fi
        ;;
      container_app_id_mismatch | fqdn_mismatch | public_env_missing | \
        public_env_duplicate | public_env_mismatch | custom_domain_missing | \
        custom_domain_duplicate | custom_domain_mismatch | \
        custom_domain_binding_invalid | custom_domain_certificate_missing | \
        workload_lock_show_failure | workload_lock_level_drift | \
        operation_container_id_mismatch | operation_container_missing | \
        operation_container_nonempty | operation_binding_mismatch | \
        operation_binding_foreign_metadata | mixed_state_workload_record | \
        operation_lease_held | operation_lease_acquire_failure | \
        operation_lease_renew_failure | preexisting_pending_revision | \
        preexisting_failed_revision | prelease_locked_image_mismatch)
        if grep -Eq '^az acr build |^az containerapp update ' "$log"; then
          fail "app release built or updated after fail-closed preflight $scenario"
        fi
        ;;
    esac

    if grep -Eq \
      '^terraform |^az (network|postgres|resource delete|group delete|lock delete) ' \
      "$log"; then
      fail "app release attempted Terraform, DNS, Storage, PostgreSQL, or destructive resource mutation"
    fi
    case "$scenario" in
      native_health_failure | public_health_failure | native_health_status_mismatch | \
        public_health_body_mismatch | canary_request_failure | canary_marker_failure | \
        final_image_show_failure | final_image_mismatch)
        grep -Fqx \
          'az containerapp update --resource-group rg-patchpage-workload --name patchpage-app --container-name server --image acrpatchpageabc123.azurecr.io/patchpage-server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --query properties.latestRevisionName --output tsv' \
          "$log" ||
          fail "health/canary failure scenario did not reach the expected reviewed update"
        ;;
    esac
    case "$scenario" in
      containerapp_update_failure | native_health_failure | public_health_failure | \
        native_health_status_mismatch | public_health_body_mismatch | \
        canary_request_failure | canary_marker_failure)
        if grep -Fq 'az storage container lease release ' "$log"; then
          fail "app release released the lease after uncertain post-mutation failure $scenario"
        fi
        grep -Fq \
          'The operation lease remains held for second-operator recovery.' \
          "$output" ||
          fail "app release omitted the retained-lease recovery warning after $scenario"
        ;;
    esac
    case "$scenario" in
      operation_container_missing | operation_container_nonempty | \
        operation_container_id_mismatch | operation_binding_mismatch | \
        operation_binding_foreign_metadata | mixed_state_workload_record | \
        operation_lease_held | operation_lease_acquire_failure | operation_lease_renew_failure)
        if grep -Fq 'az containerapp update ' "$log"; then
          fail "app release updated the image after rejecting $scenario"
        fi
        ;;
      operation_lease_release_failure)
        grep -Fq 'az containerapp update ' "$log" ||
          fail "app release release-failure scenario did not hold the lease through the update"
        ;;
      update_empty_revision | update_same_revision | never_ready_revision | \
        wrong_revision_image | multiple_active_revisions | final_pinned_drift | \
        deployed_image_show_failure | deployed_image_mismatch | \
        final_image_show_failure | final_image_mismatch)
        grep -Fq 'az containerapp update ' "$log" ||
          fail "app release readiness failure did not reach the expected update"
        if grep -Fq 'az storage container lease release ' "$log"; then
          fail "app release released the lease after post-mutation readiness failure"
        fi
        grep -Fq \
          'Container App readiness failed; second-operator recovery is required.' \
          "$output" ||
          fail "app release readiness failure omitted the generic recovery error"
        grep -Fq \
          'The operation lease remains held for second-operator recovery.' \
          "$output" ||
          fail "app release readiness failure omitted the retained-lease recovery warning after $scenario"
        ;;
    esac
    if grep -Eq \
      '00000000-0000-0000-0000-000000000000|patchpagestate|rg-patchpage-workload|[0-9a-f]{64}' \
      "$output"; then
      fail "app release exposed a private ID or workload-binding hash after $scenario"
    fi
  done
}

run_app_rollback_block() {
  scenario="$1"
  scenario_root="$TMP_DIR/rollback-$scenario-repo"
  log="$TMP_DIR/rollback-$scenario.log"
  output="$TMP_DIR/rollback-$scenario.out"
  rm -rf "$scenario_root"
  mkdir -p "$scenario_root"
  : > "$log"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    STATE_STORAGE_ACCOUNT="patchpagestate"
    STATE_CONTAINER="tfstate"
    STATE_KEY="patchpage-prod.tfstate"
    RESOURCE_GROUP="rg-patchpage-workload"
    CONTAINER_APP="patchpage-app"
    ACR="acrpatchpageabc123"
    EXPECTED_STORAGE_ACCOUNT_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/patchpagedrafts"
    EXPECTED_POSTGRES_SERVER_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-postgres"
    LOGIN_SERVER="acrpatchpageabc123.azurecr.io"
    CONTAINER_APP_FQDN="patchpage-app.example.invalid"
    PUBLIC_BASE_URL="https://drafts.example.invalid"
    CANARY_URL="$PUBLIC_BASE_URL/d/abc123def456"
    CANARY_MARKER="PATCHPAGE_CANARY"
    case "$scenario" in
      public_base_credentials) PUBLIC_BASE_URL="https://user@drafts.example.invalid" ;;
      public_base_port) PUBLIC_BASE_URL="https://drafts.example.invalid:443" ;;
      public_base_path) PUBLIC_BASE_URL="https://drafts.example.invalid/path" ;;
      public_base_query) PUBLIC_BASE_URL="https://drafts.example.invalid?mode=canary" ;;
      public_base_fragment) PUBLIC_BASE_URL="https://drafts.example.invalid#canary" ;;
      public_base_trailing_slash) PUBLIC_BASE_URL="https://drafts.example.invalid/" ;;
      foreign_canary_origin) CANARY_URL="https://foreign.example.invalid/d/abc123def456" ;;
      wrong_canary_path) CANARY_URL="$PUBLIC_BASE_URL/v/abc123def456" ;;
      canary_query) CANARY_URL="$PUBLIC_BASE_URL/d/abc123def456?mode=canary" ;;
      canary_fragment) CANARY_URL="$PUBLIC_BASE_URL/d/abc123def456#canary" ;;
      invalid_canary_id) CANARY_URL="$PUBLIC_BASE_URL/d/invalid-id" ;;
      empty_canary_marker) CANARY_MARKER="" ;;
      whitespace_canary_marker) CANARY_MARKER="   " ;;
      mismatched_private_login_server) LOGIN_SERVER="otherregistry.azurecr.io" ;;
      mixed_state_workload_record) STATE_KEY="patchpage-foreign.tfstate" ;;
      uppercase_public_hostname)
        PUBLIC_BASE_URL="https://Drafts.Example.Invalid"
        CANARY_URL="$PUBLIC_BASE_URL/d/abc123def456"
        ;;
    esac
    ROLLBACK_DIGEST_VALUE="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    RELEASE_DIGEST_VALUE="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ROLLBACK_IMAGE_VALUE="$LOGIN_SERVER/patchpage-server@$ROLLBACK_DIGEST_VALUE"
    RELEASE_IMAGE_VALUE="$LOGIN_SERVER/patchpage-server@$RELEASE_DIGEST_VALUE"
    OLD_REVISION_NAME="patchpage-app--release"
    NEW_REVISION_NAME="patchpage-app--rollback"
    LATER_REVISION_NAME="patchpage-app--later"
    EXPECTED_OPERATION_BINDING_SHA256="$(
      printf '%s\n' \
        'patchpage-operation-binding-v1' \
        "subscription_id=$SUBSCRIPTION_ID" \
        "state_storage_account=$STATE_STORAGE_ACCOUNT" \
        'state_key=patchpage-prod.tfstate' \
        "resource_group=$RESOURCE_GROUP" \
        "container_app=$CONTAINER_APP" \
        "acr=$ACR" \
        "operation_container_id=/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT/blobServices/default/containers/patchpage-operations" \
        "container_app_id=/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/containerApps/$CONTAINER_APP" \
        "acr_id=/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/$ACR" \
        "storage_account_id=$EXPECTED_STORAGE_ACCOUNT_ID" \
        "postgres_server_id=$EXPECTED_POSTGRES_SERVER_ID" |
        openssl dgst -sha256 -r |
        cut -d ' ' -f1
    )"
    ROLLBACK_RECORD="$TMP_DIR/rollback-$scenario.env"
    case "$scenario" in
      rollback_record_extra_line)
        printf 'ROLLBACK_IMAGE_REF=%s\nRELEASE_IMAGE_REF=%s\nEXTRA=value\n' \
          "$ROLLBACK_IMAGE_VALUE" "$RELEASE_IMAGE_VALUE" > "$ROLLBACK_RECORD"
        ;;
      rollback_record_trailing_blank)
        printf 'ROLLBACK_IMAGE_REF=%s\nRELEASE_IMAGE_REF=%s\n\n' \
          "$ROLLBACK_IMAGE_VALUE" "$RELEASE_IMAGE_VALUE" > "$ROLLBACK_RECORD"
        ;;
      rollback_record_missing_release)
        printf 'ROLLBACK_IMAGE_REF=%s\n' "$ROLLBACK_IMAGE_VALUE" > "$ROLLBACK_RECORD"
        ;;
      *)
        printf 'ROLLBACK_IMAGE_REF=%s\nRELEASE_IMAGE_REF=%s\n' \
          "$ROLLBACK_IMAGE_VALUE" "$RELEASE_IMAGE_VALUE" > "$ROLLBACK_RECORD"
        ;;
    esac

    git() {
      test "$*" = "rev-parse --show-toplevel" || return 1
      printf '%s\n' "$scenario_root"
    }

    sleep() {
      printf 'sleep %s\n' "$*" >> "$log"
    }

    az() {
      normalize_az_args "$@" || return 1
      printf 'az %s\n' "$NORMALIZED_AZ_ARGS" >> "$log"
      printf 'private-rollback-diagnostic %s\n' "$*" >&2
      case "$1 $2" in
        "account set")
          test "$scenario" != "subscription_set_failure"
          ;;
        "account show")
          if test "$scenario" = "subscription_mismatch"; then
            printf '%s\n' "22222222-2222-2222-2222-222222222222"
          else
            printf '%s\n' "$SUBSCRIPTION_ID"
          fi
          ;;
        "lock show")
          lock_id=""
          while test "$#" -gt 0; do
            if test "$1" = "--ids"; then lock_id="$2"; break; fi
            shift
          done
          test -n "$lock_id" || return 1
          if test "$scenario" = "lock_drift"; then
            printf 'ReadOnly\t%s\n' "$lock_id"
          else
            printf 'CanNotDelete\t%s\n' "$lock_id"
          fi
          ;;
        "storage account")
          return 1
          ;;
        "storage container-rm")
          test "$3" = "show" || return 1
          if test "$scenario" = "operation_container_id_mismatch"; then
            printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/foreign/blobServices/default/containers/patchpage-operations"
          else
            printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT/blobServices/default/containers/patchpage-operations"
          fi
          ;;
        "storage container")
          case "$3" in
            exists)
              if test "$scenario" = "operation_container_missing"; then
                printf '%s\n' "false"
              else
                printf '%s\n' "true"
              fi
              ;;
            metadata)
              test "$4" = "show" || return 1
              if test "$scenario" = "operation_binding_mismatch"; then
                printf '%s\n' '{"patchpage_workload_binding_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}'
              elif test "$scenario" = "operation_binding_foreign_metadata"; then
                printf '%s\n' '{"foreign":"value"}'
              else
                printf '{"patchpage_workload_binding_sha256":"%s"}\n' "$EXPECTED_OPERATION_BINDING_SHA256"
              fi
              ;;
            lease) mock_operation_lease "$@" ;;
            *) return 1 ;;
          esac
          ;;
        "storage blob")
          test "$3" = "list" || return 1
          test "$scenario" != "operation_container_nonempty" ||
            printf '%s\n' "unexpected"
          ;;
        "acr show")
          case " $* " in
            *" --query id "*)
              if test "$scenario" = "wrong_acr_id"; then
                printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/otherregistry"
              else
                printf '%s\n' "$EXPECTED_ACR_ID"
              fi
              ;;
            *" --query loginServer "*)
              if test "$scenario" = "wrong_live_login_server"; then
                printf '%s\n' "otherregistry.azurecr.io"
              else
                printf '%s\n' "acrpatchpageabc123.azurecr.io"
              fi
              ;;
            *) return 1 ;;
          esac
          ;;
        "acr manifest")
          if test "$scenario" = "manifest_mismatch"; then
            printf '%s\n' "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          else
            printf '%s\n' "$ROLLBACK_DIGEST_VALUE"
          fi
          ;;
        "containerapp show")
          case " $* " in
            *" --ids "*" --output json "*)
              app_show_count_file="$scenario_root/rollback-app-show-count"
              app_show_count=0
              if test -e "$app_show_count_file"; then
                app_show_count="$(cat "$app_show_count_file")"
              fi
              app_show_count=$((app_show_count + 1))
              printf '%s\n' "$app_show_count" > "$app_show_count_file"
              app_id="$EXPECTED_CONTAINER_APP_ID"
              app_fqdn="$CONTAINER_APP_FQDN"
              app_public_base_url="$PUBLIC_BASE_URL"
              app_public_hostname="$(
                printf '%s' "${PUBLIC_BASE_URL#https://}" |
                  tr '[:upper:]' '[:lower:]'
              )"
              app_custom_domains="[{\"name\":\"$app_public_hostname\",\"bindingType\":\"SniEnabled\",\"certificateId\":\"managed-cert-id\"}]"
              app_env='[{"name":"PATCHPAGE_PUBLIC_BASE_URL","value":"PLACEHOLDER"}]'
              app_image="$RELEASE_IMAGE_VALUE"
              app_latest_revision="$OLD_REVISION_NAME"
              app_ready_revision="$OLD_REVISION_NAME"
              if test -e "$scenario_root/rollback-updated"; then
                app_image="$ROLLBACK_IMAGE_VALUE"
                app_latest_revision="$NEW_REVISION_NAME"
                app_ready_revision="$NEW_REVISION_NAME"
                updated_app_show_count_file="$scenario_root/updated-app-show-count"
                updated_app_show_count=0
                if test -e "$updated_app_show_count_file"; then
                  updated_app_show_count="$(cat "$updated_app_show_count_file")"
                fi
                updated_app_show_count=$((updated_app_show_count + 1))
                printf '%s\n' "$updated_app_show_count" > "$updated_app_show_count_file"
                if test "$scenario" = "final_pinned_drift" &&
                  test "$updated_app_show_count" -ge 3; then
                  app_latest_revision="$LATER_REVISION_NAME"
                  app_ready_revision="$LATER_REVISION_NAME"
                fi
              else
                case "$scenario" in
                  preexisting_pending_revision)
                    app_latest_revision="patchpage-app--pending"
                    ;;
                  preexisting_failed_revision)
                    app_latest_revision="patchpage-app--failed"
                    ;;
                  stale_current_image)
                    if test "$app_show_count" -ge 2; then
                      app_image="$ROLLBACK_IMAGE_VALUE"
                    fi
                    ;;
                esac
              fi
              case "$scenario" in
                container_app_id_mismatch) app_id="${EXPECTED_CONTAINER_APP_ID%/*}/foreign" ;;
                fqdn_mismatch) app_fqdn="foreign.example.invalid" ;;
                public_env_mismatch) app_public_base_url="https://foreign.example.invalid" ;;
                public_env_missing) app_env='[]' ;;
                public_env_duplicate) app_env='[{"name":"PATCHPAGE_PUBLIC_BASE_URL","value":"PLACEHOLDER"},{"name":"PATCHPAGE_PUBLIC_BASE_URL","value":"PLACEHOLDER"}]' ;;
                custom_domain_missing) app_custom_domains='[]' ;;
                custom_domain_duplicate) app_custom_domains="[{\"name\":\"$app_public_hostname\",\"bindingType\":\"SniEnabled\",\"certificateId\":\"managed-cert-id\"},{\"name\":\"$app_public_hostname\",\"bindingType\":\"SniEnabled\",\"certificateId\":\"managed-cert-id\"}]" ;;
                custom_domain_mismatch) app_custom_domains='[{"name":"foreign.example.invalid","bindingType":"SniEnabled","certificateId":"managed-cert-id"}]' ;;
                custom_domain_binding_invalid) app_custom_domains="[{\"name\":\"$app_public_hostname\",\"bindingType\":\"Disabled\",\"certificateId\":\"managed-cert-id\"}]" ;;
                custom_domain_certificate_missing) app_custom_domains="[{\"name\":\"$app_public_hostname\",\"bindingType\":\"SniEnabled\"}]" ;;
              esac
              app_env="$(printf '%s\n' "$app_env" | sed "s|PLACEHOLDER|$app_public_base_url|g")"
              printf '{"id":"%s","properties":{"provisioningState":"Succeeded","latestRevisionName":"%s","latestReadyRevisionName":"%s","configuration":{"activeRevisionsMode":"Single","ingress":{"fqdn":"%s","customDomains":%s,"traffic":[{"latestRevision":true,"weight":100}]}},"template":{"containers":[{"name":"server","image":"%s","env":%s}]}}}\n' \
                "$app_id" "$app_latest_revision" "$app_ready_revision" \
                "$app_fqdn" "$app_custom_domains" "$app_image" "$app_env"
              ;;
            *) return 1 ;;
          esac
          ;;
        "containerapp revision")
          revision_action="$3"
          revision_name=
          while test "$#" -gt 0; do
            if test "$1" = "--revision"; then
              revision_name="$2"
              break
            fi
            shift
          done
          case "$revision_action" in
            show)
              revision_image="$RELEASE_IMAGE_VALUE"
              revision_active=true
              revision_provisioning="Provisioned"
              revision_health="Healthy"
              revision_running="Running"
              revision_weight=100
              case "$revision_name" in
                "$NEW_REVISION_NAME")
                  revision_image="$ROLLBACK_IMAGE_VALUE"
                  new_revision_show_count_file="$scenario_root/new-revision-show-count"
                  new_revision_show_count=0
                  if test -e "$new_revision_show_count_file"; then
                    new_revision_show_count="$(cat "$new_revision_show_count_file")"
                  fi
                  new_revision_show_count=$((new_revision_show_count + 1))
                  printf '%s\n' "$new_revision_show_count" > "$new_revision_show_count_file"
                  if test "$new_revision_show_count" -eq 1 ||
                    test "$scenario" = "never_ready_revision"; then
                    revision_active=false
                    revision_provisioning="Provisioning"
                    revision_health="Unknown"
                    revision_running="Processing"
                    revision_weight=0
                  fi
                  case "$scenario" in
                    wrong_revision_image | postupdate_image_mismatch)
                      revision_image="$RELEASE_IMAGE_VALUE"
                      ;;
                    final_image_show_failure)
                      test "$new_revision_show_count" -lt 3 || return 1
                      ;;
                    final_image_mismatch)
                      if test "$new_revision_show_count" -ge 3; then
                        revision_image="$RELEASE_IMAGE_VALUE"
                      fi
                      ;;
                  esac
                  ;;
                patchpage-app--pending)
                  revision_active=false
                  revision_provisioning="Provisioning"
                  revision_health="Unknown"
                  revision_running="Processing"
                  revision_weight=0
                  ;;
                patchpage-app--failed)
                  revision_active=false
                  revision_provisioning="Failed"
                  revision_health="Unhealthy"
                  revision_running="Stopped"
                  revision_weight=0
                  ;;
                "$OLD_REVISION_NAME") ;;
                *) return 1 ;;
              esac
              if test "$scenario" = "scale_to_zero_revision"; then
                revision_health="None"
                revision_running="ScaleToZero"
              fi
              printf '{"name":"%s","properties":{"active":%s,"provisioningState":"%s","healthState":"%s","runningState":"%s","trafficWeight":%s,"template":{"containers":[{"name":"server","image":"%s"}]}}}\n' \
                "$revision_name" "$revision_active" "$revision_provisioning" \
                "$revision_health" "$revision_running" "$revision_weight" \
                "$revision_image"
              ;;
            list)
              if test -e "$scenario_root/rollback-updated"; then
                if test "$scenario" = "multiple_active_revisions"; then
                  printf '[{"name":"%s","properties":{"active":true}},{"name":"%s","properties":{"active":true}}]\n' \
                    "$OLD_REVISION_NAME" "$NEW_REVISION_NAME"
                else
                  printf '[{"name":"%s","properties":{"active":true}}]\n' \
                    "$NEW_REVISION_NAME"
                fi
              else
                printf '[{"name":"%s","properties":{"active":true}}]\n' \
                  "$OLD_REVISION_NAME"
              fi
              ;;
            *) return 1 ;;
          esac
          ;;
        "containerapp update")
          test "$scenario" != "update_failure" || return 1
          : > "$scenario_root/rollback-updated"
          case "$scenario" in
            update_empty_revision) ;;
            update_same_revision) printf '%s\n' "$OLD_REVISION_NAME" ;;
            *) printf '%s\n' "$NEW_REVISION_NAME" ;;
          esac
          ;;
        *)
          return 1
          ;;
      esac
    }

    curl() {
      test -f "$scenario_root/operation-lease-id" || return 1
      printf 'curl %s\n' "$*" >> "$log"
      url=
      for arg do
        url="$arg"
      done
      case "$url" in
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

    eval "$APP_ROLLBACK_BLOCK"
    printf '%s\n' completed >> "$log"
  ) >"$output" 2>&1
}

test_app_rollback() {
  for scenario in \
    rollback_record_extra_line \
    rollback_record_trailing_blank \
    rollback_record_missing_release \
    empty_canary_marker \
    whitespace_canary_marker \
    public_base_credentials \
    public_base_port \
    public_base_path \
    public_base_query \
    public_base_fragment \
    public_base_trailing_slash \
    foreign_canary_origin \
    wrong_canary_path \
    canary_query \
    canary_fragment \
    invalid_canary_id \
    mismatched_private_login_server \
    subscription_set_failure \
    subscription_mismatch \
    wrong_acr_id \
    wrong_live_login_server \
    container_app_id_mismatch \
    fqdn_mismatch \
    public_env_missing \
    public_env_duplicate \
    public_env_mismatch \
    custom_domain_missing \
    custom_domain_duplicate \
    custom_domain_mismatch \
    custom_domain_binding_invalid \
    custom_domain_certificate_missing \
    lock_drift \
    operation_container_id_mismatch \
    operation_container_missing \
    operation_container_nonempty \
    operation_binding_mismatch \
    operation_binding_foreign_metadata \
    mixed_state_workload_record \
    operation_lease_held \
    operation_lease_acquire_failure \
    operation_lease_renew_failure \
    operation_lease_release_failure \
    preexisting_pending_revision \
    preexisting_failed_revision \
    stale_current_image \
    manifest_mismatch \
    update_failure \
    update_empty_revision \
    update_same_revision \
    never_ready_revision \
    wrong_revision_image \
    multiple_active_revisions \
    final_pinned_drift \
    postupdate_image_mismatch \
    native_health_failure \
    native_health_status_mismatch \
    public_health_failure \
    public_health_body_mismatch \
    canary_request_failure \
    canary_marker_failure \
    final_image_show_failure \
    final_image_mismatch \
    scale_to_zero_revision \
    uppercase_public_hostname \
    success; do
    if run_app_rollback_block "$scenario"; then
      status=0
    else
      status=$?
    fi

    log="$TMP_DIR/rollback-$scenario.log"
    output="$TMP_DIR/rollback-$scenario.out"
    if test "$scenario" = "success" || test "$scenario" = "update_failure"; then
      grep -Fqx \
        'az containerapp update --resource-group rg-patchpage-workload --name patchpage-app --container-name server --image acrpatchpageabc123.azurecr.io/patchpage-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --query properties.latestRevisionName --output tsv' \
        "$log" ||
        fail "rollback did not target only the expected Container App and digest"
    fi
    if grep -Eq \
      'private-rollback-diagnostic|00000000-0000-0000-0000-000000000000|22222222-2222-2222-2222-222222222222|acrpatchpageabc123|patchpagestate|[0-9a-f]{64}' \
      "$output"; then
      fail "rollback exposed private identifiers or producer diagnostics"
    fi

    if test "$scenario" = "success" ||
      test "$scenario" = "uppercase_public_hostname" ||
      test "$scenario" = "scale_to_zero_revision"; then
      test "$status" -eq 0 || fail "rollback rejected the successful update"
      grep -Eq \
        '^az storage container lease acquire --account-name patchpagestate --container-name patchpage-operations --auth-mode login --lease-duration -1 --proposed-lease-id [0-9a-f-]{36} --output none$' \
        "$log" ||
        fail "rollback did not acquire the infinite operation lease"
      grep -Eq \
        '^az storage container lease release --account-name patchpagestate --container-name patchpage-operations --auth-mode login --lease-id [0-9a-f-]{36} --output none$' \
        "$log" ||
        fail "rollback did not release the exact operation lease"
      grep -Fqx \
        'az acr show --name acrpatchpageabc123 --resource-group rg-patchpage-workload --query id --output tsv' \
        "$log" ||
        fail "rollback did not prove the expected ACR resource ID"
      grep -Fqx \
        'az acr show --name acrpatchpageabc123 --resource-group rg-patchpage-workload --query loginServer --output tsv' \
        "$log" ||
        fail "rollback did not prove the expected live ACR login server"
      test "$(grep -Fxc "az containerapp show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.App/containerApps/patchpage-app --output json" "$log")" -ge 7 ||
        fail "rollback did not independently fetch Container App JSON for its pinned gates"
      grep -Fqx \
        'az containerapp revision show --resource-group rg-patchpage-workload --name patchpage-app --revision patchpage-app--rollback --output json' \
        "$log" ||
        fail "rollback did not inspect the exact returned revision"
      grep -Fqx \
        'az containerapp revision list --resource-group rg-patchpage-workload --name patchpage-app --all --output json' \
        "$log" ||
        fail "rollback did not inspect all revisions"
      grep -Fqx \
        'az storage container-rm show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/patchpage-operations --query id --output tsv' \
        "$log" ||
        fail "rollback did not prove the exact operation-container resource ID"
      grep -Fqx \
        'az lock show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.Storage/storageAccounts/patchpagedrafts/providers/Microsoft.Authorization/locks/protect-patchpage-drafts --query [level,id] --output tsv' \
        "$log" ||
        fail "rollback did not prove the exact workload Storage lock"
      grep -Fqx \
        'az lock show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-postgres/providers/Microsoft.Authorization/locks/protect-patchpage-postgres --query [level,id] --output tsv' \
        "$log" ||
        fail "rollback did not prove the exact PostgreSQL lock"
      if grep -Fq 'az storage account show ' "$log"; then
        fail "rollback required parent state-account management read"
      fi
      awk '
        /^az lock show --ids .*protect-patchpage-drafts / { storage_lock = NR }
        /^az lock show --ids .*protect-patchpage-postgres / { postgres_lock = NR }
        /^az containerapp show --ids .* --output json$/ { if (!app) app = NR }
        /^az storage container-rm show --ids .*patchpage-operations / { container_id = NR }
        /^az storage container metadata show .* --auth-mode login --output json$/ { binding = NR }
        /^az storage container lease acquire / { lease = NR }
        /^az containerapp update / { update = NR }
        /^az containerapp revision show .*--revision patchpage-app--rollback / { if (!revision) revision = NR }
        /^curl .*\/healthz$/ { smoke = NR }
        /^az storage container lease release / { release = NR }
        END {
          exit !(storage_lock && postgres_lock && app && container_id && binding && lease && update && revision && smoke && release &&
            storage_lock < update && postgres_lock < update && app < update &&
            container_id < update && binding < update && lease < update &&
            update < revision && revision < smoke && smoke < release)
        }
      ' "$log" ||
        fail "rollback did not complete every identity, endpoint, lock, and bound-lease gate before update"
      canary_line="$(grep -nE '^curl --proto =https --tlsv1.2 --fail --silent --show-error --connect-timeout 15 --max-time 120 https://[^/]+/d/abc123def456$' "$log" | sed -n '1s/:.*//p')"
      final_image_line="$(grep -nF "az containerapp revision show --resource-group rg-patchpage-workload --name patchpage-app --revision patchpage-app--rollback --output json" "$log" | tail -1 | sed 's/:.*//')"
      release_line="$(grep -nF 'az storage container lease release ' "$log" | sed -n '1s/:.*//p')"
      if test -z "$canary_line" || test -z "$final_image_line" ||
        test -z "$release_line" || test "$canary_line" -ge "$final_image_line" ||
        test "$final_image_line" -ge "$release_line"; then
        fail "rollback released its lease before completing canary and final-image verification"
      fi
      test "$(grep -Ec '^curl .* --connect-timeout 15 --max-time 120 ' "$log")" -eq 3 ||
        fail "rollback did not bound every post-deploy endpoint request"
      grep -Fqx completed "$log" ||
        fail "successful rollback did not complete"
      grep -Fqx 'sleep 5' "$log" ||
        fail "rollback success did not exercise bounded readiness polling"
      test ! -s "$output" ||
        fail "successful rollback emitted unexpected output"
    else
      test "$status" -ne 0 || fail "rollback masked $scenario"
      if grep -q '^completed$' "$log"; then
        fail "rollback continued after $scenario"
      fi
    fi
    case "$scenario" in
      rollback_record_extra_line | rollback_record_trailing_blank | \
        rollback_record_missing_release)
        if grep -Fq 'az account set ' "$log"; then
          fail "rollback contacted Azure before rejecting $scenario"
        fi
        ;;
      public_base_credentials | public_base_port | public_base_path | \
        public_base_query | public_base_fragment | public_base_trailing_slash | \
        foreign_canary_origin | wrong_canary_path | canary_query | \
        canary_fragment | invalid_canary_id)
        if grep -Fq 'az ' "$log"; then
          fail "rollback contacted Azure before rejecting $scenario"
        fi
        ;;
      mismatched_private_login_server | wrong_acr_id | wrong_live_login_server)
        if grep -Eq '^az acr manifest |^az containerapp update ' "$log"; then
          fail "rollback accessed an image or updated the workload after $scenario"
        fi
        ;;
      container_app_id_mismatch | fqdn_mismatch | public_env_missing | \
        public_env_duplicate | public_env_mismatch | custom_domain_missing | \
        custom_domain_duplicate | custom_domain_mismatch | \
        custom_domain_binding_invalid | custom_domain_certificate_missing | lock_drift | \
        operation_container_id_mismatch | operation_container_missing | \
        operation_container_nonempty | operation_binding_mismatch | \
        operation_binding_foreign_metadata | mixed_state_workload_record | \
        operation_lease_held | operation_lease_acquire_failure | \
        operation_lease_renew_failure | preexisting_pending_revision | \
        preexisting_failed_revision | stale_current_image)
        if grep -Fq 'az containerapp update ' "$log"; then
          fail "rollback updated after fail-closed preflight $scenario"
        fi
        ;;
      operation_container_id_mismatch | operation_container_missing | \
        operation_container_nonempty | operation_binding_mismatch | \
        operation_binding_foreign_metadata | mixed_state_workload_record | operation_lease_held | \
        operation_lease_acquire_failure | operation_lease_renew_failure | stale_current_image)
        if grep -Fq 'az containerapp update ' "$log"; then
          fail "rollback updated the image after rejecting $scenario"
        fi
        ;;
      operation_lease_release_failure)
        grep -Fq 'az containerapp update ' "$log" ||
          fail "rollback release-failure scenario did not hold the lease through the update"
        ;;
      update_failure | native_health_failure | native_health_status_mismatch | \
        public_health_failure | public_health_body_mismatch | \
        canary_request_failure | canary_marker_failure)
        grep -Fq 'az containerapp update ' "$log" ||
          fail "rollback verification failure did not reach the expected update"
        if grep -Fq 'az storage container lease release ' "$log"; then
          fail "rollback released the lease after uncertain post-mutation failure $scenario"
        fi
        grep -Fq \
          'The operation lease remains held for second-operator recovery.' \
          "$output" ||
          fail "rollback omitted the retained-lease recovery warning after $scenario"
        ;;
      update_empty_revision | update_same_revision | never_ready_revision | \
        wrong_revision_image | multiple_active_revisions | final_pinned_drift | \
        postupdate_image_mismatch | final_image_show_failure | final_image_mismatch)
        grep -Fq 'az containerapp update ' "$log" ||
          fail "rollback readiness failure did not reach the expected update"
        if grep -Fq 'az storage container lease release ' "$log"; then
          fail "rollback released the lease after post-mutation readiness failure"
        fi
        grep -Fq \
          'Container App readiness failed; second-operator recovery is required.' \
          "$output" ||
          fail "rollback readiness failure omitted the generic recovery error"
        grep -Fq \
          'The operation lease remains held for second-operator recovery.' \
          "$output" ||
          fail "rollback readiness failure omitted the retained-lease recovery warning after $scenario"
        ;;
    esac
  done
}

run_infrastructure_change_block() {
  scenario="$1"
  scenario_root="$TMP_DIR/infrastructure-$scenario"
  log="$TMP_DIR/infrastructure-$scenario.log"
  output="$TMP_DIR/infrastructure-$scenario.out"
  rm -rf "$scenario_root"
  mkdir -p "$scenario_root/infra/azure"
  : > "$log"
  case "$scenario" in
    adoption_*)
      printf 'server_image = "acrpatchpageabc123.azurecr.io/patchpage-server:%s"\n' \
        "1111111" > "$scenario_root/infra/azure/server-image.auto.tfvars"
      ;;
  esac
  diagnostic_root="$TMP_DIR/infrastructure-diagnostics-$scenario"
  rm -rf "$diagnostic_root"
  mkdir -p "$diagnostic_root"
  diagnostic_root="$(CDPATH= cd -- "$diagnostic_root" && pwd -P)"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    STATE_STORAGE_ACCOUNT="patchpagestate"
    STATE_CONTAINER="tfstate"
    STATE_KEY="patchpage-prod.tfstate"
    OPERATION_PRINCIPAL_ID="22222222-2222-4222-8222-222222222222"
    OPERATION_PRINCIPAL_TYPE="ServicePrincipal"
    EXPECTED_OPERATION_AUTH_MODE="key"
    EXPECTED_STATE_LINEAGE="11111111-1111-1111-1111-111111111111"
    EXPECTED_RESOURCE_GROUP_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-workload"
    EXPECTED_STORAGE_ACCOUNT_ID="$EXPECTED_RESOURCE_GROUP_ID/providers/Microsoft.Storage/storageAccounts/patchpagedrafts"
    EXPECTED_POSTGRES_SERVER_ID="$EXPECTED_RESOURCE_GROUP_ID/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-db"
    EXPECTED_ACR_ID="$EXPECTED_RESOURCE_GROUP_ID/providers/Microsoft.ContainerRegistry/registries/acrpatchpageabc123"
    EXPECTED_CONTAINER_APP_ID="$EXPECTED_RESOURCE_GROUP_ID/providers/Microsoft.App/containerApps/patchpage-app"
    RESOURCE_GROUP="rg-patchpage-workload"
    LEGACY_IMAGE_TAG="1111111"
    LEGACY_IMAGE_DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    IMMUTABLE_IMAGE="acrpatchpageabc123.azurecr.io/patchpage-server@$LEGACY_IMAGE_DIGEST"
    OLD_REVISION_NAME="patchpage-app--stable"
    ADOPTION_REVISION_NAME="patchpage-app--adopted"
    POSTAPPLY_REVISION_NAME="patchpage-app--infra"
    LATER_REVISION_NAME="patchpage-app--later"
    EXPECTED_OPERATION_BINDING_SHA256="$(
      printf '%s\n' \
        'patchpage-operation-binding-v1' \
        "subscription_id=$SUBSCRIPTION_ID" \
        "state_storage_account=$STATE_STORAGE_ACCOUNT" \
        "state_key=$STATE_KEY" \
        "resource_group=$RESOURCE_GROUP" \
        'container_app=patchpage-app' \
        'acr=acrpatchpageabc123' \
        "operation_container_id=/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT/blobServices/default/containers/patchpage-operations" \
        "container_app_id=$EXPECTED_CONTAINER_APP_ID" \
        "acr_id=$EXPECTED_ACR_ID" \
        "storage_account_id=$EXPECTED_STORAGE_ACCOUNT_ID" \
        "postgres_server_id=$EXPECTED_POSTGRES_SERVER_ID" |
        openssl dgst -sha256 -r |
        cut -d ' ' -f1
    )"
    TERRAFORM_DIAGNOSTIC_ROOT="$diagnostic_root"
    export TERRAFORM_DIAGNOSTIC_ROOT
    case "$scenario" in
      adoption_*) ADOPT_SAFETY_GUARDS="true" ;;
      invalid_adopt_value) ADOPT_SAFETY_GUARDS="yes" ;;
      *) ADOPT_SAFETY_GUARDS="false" ;;
    esac
    case "$scenario" in
      adoption_operation_principal_id_missing) unset OPERATION_PRINCIPAL_ID ;;
      adoption_operation_principal_id_invalid) OPERATION_PRINCIPAL_ID="not-a-guid" ;;
      adoption_operation_principal_type_missing) unset OPERATION_PRINCIPAL_TYPE ;;
      adoption_operation_principal_type_invalid) OPERATION_PRINCIPAL_TYPE="Application" ;;
      adoption_operation_principal_group) OPERATION_PRINCIPAL_TYPE="Group" ;;
    esac
    case "$scenario" in
      adoption_digest_current | adoption_legacy_digest_missing) ;;
      adoption_legacy_digest_mismatch)
        EXPECTED_LEGACY_IMAGE_DIGEST="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ;;
      adoption_*) EXPECTED_LEGACY_IMAGE_DIGEST="$LEGACY_IMAGE_DIGEST" ;;
    esac
    case "$scenario" in
      adoption_existing_unbound_success | adoption_binding_update_failure | \
        adoption_binding_concurrent_metadata | adoption_foreign_binding)
        operation_container_created="true"
        ;;
      adoption_*) operation_container_created="false" ;;
      *) operation_container_created="true" ;;
    esac
    role_assignment_created="false"

    git() {
      printf 'git %s\n' "$*" >> "$log"
      test "$*" = "rev-parse --show-toplevel" || return 1
      test "$scenario" != "infra_repo_root_failure" || return 1
      printf '%s\n' "$scenario_root"
    }

    chmod() {
      if test "$scenario" = "backend_chmod_failure" &&
        test "$2" = "backend.hcl"; then
        return 1
      fi
      command chmod "$@"
    }

    mktemp() {
      mktemp_count_file="$scenario_root/mktemp-count"
      mktemp_count=0
      if test -e "$mktemp_count_file"; then
        mktemp_count="$(cat "$mktemp_count_file")"
      fi
      mktemp_count=$((mktemp_count + 1))
      printf '%s\n' "$mktemp_count" > "$mktemp_count_file"
      if test "$scenario" = "infra_diagnostic_secure_dir_failure" &&
        test "$mktemp_count" -eq 1; then
        return 1
      fi
      if test "$scenario" = "secure_change_dir_failure" &&
        test "$mktemp_count" -eq 2; then
        return 1
      fi
      mktemp_result="$(command mktemp "$@")" || return 1
      if test "$mktemp_count" -eq 1; then
        printf '%s\n' "$mktemp_result" > "$scenario_root/diagnostic-dir"
        if test "$scenario" = "infra_diagnostic_log_open_failure"; then
          mkdir "$mktemp_result/terraform.log"
        fi
      elif test "$scenario" = "state_snapshot_open_failure" &&
        test "$mktemp_count" -eq 2; then
        mkdir "$mktemp_result/state.json"
      fi
      printf '%s\n' "$mktemp_result"
    }

    rm() {
      if test "$scenario" = "infra_diagnostic_cleanup_failure" &&
        test "${1:-}" = "-rf" &&
        test "${3:-}" = "${TERRAFORM_DIAGNOSTIC_DIR:-}"; then
        printf 'private cleanup failure: %s\n' "$3" >&2
        return 1
      fi
      if test "$scenario" = "secure_change_cleanup_failure" &&
        test "${1:-}" = "-rf" &&
        test "${3:-}" = "${SECURE_CHANGE_DIR:-}"; then
        printf 'private change cleanup failure: %s\n' "$3" >&2
        return 1
      fi
      command rm "$@"
    }

    sleep() {
      printf 'sleep %s\n' "$*" >> "$log"
    }

    jq() {
      jq_input=
      for jq_arg do
        jq_input="$jq_arg"
      done
      if test -n "${INFRA_PLAN_JSON:-}" &&
        test "$jq_input" = "$INFRA_PLAN_JSON"; then
        jq_seen="$scenario_root/infrastructure-plan-jq-seen"
        if test "$scenario" = "plan_summary_failure" && test -e "$jq_seen"; then
          return 1
        fi
        : > "$jq_seen"
      fi
      command jq "$@"
    }

    terraform() {
      printf 'terraform %s\n' "$*" >> "$log"
      printf 'private-infra-terraform-diagnostic %s\n' "$*" >&2
      case "$*" in
        "init -input=false -reconfigure -backend-config=backend.hcl")
          test "$scenario" != "init_failure"
          ;;
        "console -no-color")
          IFS= read -r console_expression || return 1
          case "$console_expression" in
            "var.subscription_id")
              test "$scenario" != "infra_subscription_console_failure" || return 1
              if test "$scenario" = "infra_subscription_mismatch"; then
                printf '%s\n' '"44444444-4444-4444-4444-444444444444"'
              else
                printf '"%s"\n' "$SUBSCRIPTION_ID"
              fi
              ;;
            '"rg-patchpage-${var.environment_name}"')
              test "$scenario" != "infra_resource_group_console_failure" || return 1
              if test "$scenario" = "infra_resource_group_invalid"; then
                printf '%s\n' "not-json"
              elif test "$scenario" = "infra_resource_group_mismatch"; then
                printf '%s\n' '"rg-patchpage-other"'
              else
                printf '"%s"\n' "$RESOURCE_GROUP"
              fi
              ;;
            "var.storage_delete_retention_days")
              printf '%s\n' "30"
              ;;
            "var.server_image")
              if test "$scenario" = "adoption_image_config_mismatch"; then
                printf '%s\n' '"registry.invalid/patchpage-server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
              else
                configured_server_image="$(
                  sed -n 's/^server_image = "\(.*\)"$/\1/p' \
                    server-image.auto.tfvars
                )" || return 1
                test -n "$configured_server_image" || return 1
                printf '"%s"\n' "$configured_server_image"
              fi
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        "state pull")
          test "$scenario" != "state_pull_failure" || return 1
          if test "$scenario" = "wrong_lineage"; then
            printf '%s\n' '{"lineage":"22222222-2222-2222-2222-222222222222"}'
          else
            printf '{"lineage":"%s"}\n' "$EXPECTED_STATE_LINEAGE"
          fi
          ;;
        "show -json")
          test "$scenario" != "state_values_failure" || return 1
          resource_group_id="$EXPECTED_RESOURCE_GROUP_ID"
          storage_account_id="$EXPECTED_STORAGE_ACCOUNT_ID"
          postgres_server_id="$EXPECTED_POSTGRES_SERVER_ID"
          acr_id="$EXPECTED_ACR_ID"
          container_app_id="$EXPECTED_CONTAINER_APP_ID"
          case "$scenario" in
            wrong_resource_group_id) resource_group_id="$resource_group_id-other" ;;
            wrong_storage_account_id) storage_account_id="$storage_account_id-other" ;;
            wrong_postgres_server_id) postgres_server_id="$postgres_server_id-other" ;;
            wrong_acr_id) acr_id="$acr_id-other" ;;
            wrong_container_app_id) container_app_id="$container_app_id-other" ;;
          esac
          state_values_count_file="$scenario_root/state-values-count"
          state_values_count=0
          if test -f "$state_values_count_file"; then
            state_values_count="$(cat "$state_values_count_file")"
          fi
          state_values_count=$((state_values_count + 1))
          printf '%s\n' "$state_values_count" > "$state_values_count_file"
          lock_resources=
          if test "$ADOPT_SAFETY_GUARDS" = "false" ||
            test "$state_values_count" -gt 1; then
            lock_resources=',{"address":"azurerm_management_lock.drafts_storage","values":{"id":"'"$EXPECTED_STORAGE_ACCOUNT_ID"'/providers/Microsoft.Authorization/locks/protect-patchpage-drafts"}},{"address":"azurerm_management_lock.patchpage_postgres","values":{"id":"'"$EXPECTED_POSTGRES_SERVER_ID"'/providers/Microsoft.Authorization/locks/protect-patchpage-postgres"}}'
          fi
          printf \
            '{"values":{"root_module":{"resources":[{"address":"azurerm_resource_group.patchpage","values":{"id":"%s"}},{"address":"azurerm_storage_account.drafts","values":{"id":"%s"}},{"address":"azurerm_postgresql_flexible_server.patchpage","values":{"id":"%s"}},{"address":"azurerm_container_registry.patchpage","values":{"id":"%s"}},{"address":"azurerm_container_app.server","values":{"id":"%s"}}%s]}}}\n' \
            "$resource_group_id" \
            "$storage_account_id" \
            "$postgres_server_id" \
            "$acr_id" \
            "$container_app_id" \
            "$lock_resources"
          ;;
        state\ show\ *)
          if test "$scenario" = "missing_required_state_address" &&
            test "$3" = "azurerm_storage_container.drafts"; then
            return 1
          fi
          case "$3" in
            azurerm_management_lock.drafts_storage)
              test "$ADOPT_SAFETY_GUARDS" = "false" ||
                test -f "$scenario_root/storage-lock-imported"
              ;;
            azurerm_management_lock.patchpage_postgres)
              test "$ADOPT_SAFETY_GUARDS" = "false" ||
                test -f "$scenario_root/postgres-lock-imported"
              ;;
          esac
          ;;
        import\ -input=false\ *)
          case "$3" in
            azurerm_management_lock.drafts_storage)
              test "$4" = "$EXPECTED_STORAGE_ACCOUNT_ID/providers/Microsoft.Authorization/locks/protect-patchpage-drafts" ||
                return 1
              test "$scenario" != "adoption_storage_lock_import_failure" || return 1
              : > "$scenario_root/storage-lock-imported"
              ;;
            azurerm_management_lock.patchpage_postgres)
              test "$4" = "$EXPECTED_POSTGRES_SERVER_ID/providers/Microsoft.Authorization/locks/protect-patchpage-postgres" ||
                return 1
              test "$scenario" != "adoption_postgres_lock_import_failure" || return 1
              : > "$scenario_root/postgres-lock-imported"
              ;;
            *) return 1 ;;
          esac
          ;;
        plan\ -input=false\ -out=*)
          test "$scenario" != "plan_failure" || return 1
          : > "$scenario_root/infra-plan-created"
          if test "$scenario" = "plan_json_open_failure"; then
            mkdir "$INFRA_PLAN_JSON"
          fi
          ;;
        show\ -json\ *)
          test "$scenario" != "plan_gate_show_failure" || return 1
          case "$scenario" in
            delete_plan)
              plan_change_json='[{"address":"azurerm_storage_account.drafts","change":{"actions":["delete"]}}]'
              ;;
            replacement_plan)
              plan_change_json='[{"address":"azurerm_postgresql_flexible_server.patchpage","change":{"actions":["delete","create"]}}]'
              ;;
            missing_container_plan)
              plan_change_json='[{"address":"azurerm_storage_container.drafts","change":{"actions":["create"]}}]'
              ;;
            missing_database_plan)
              plan_change_json='[{"address":"azurerm_postgresql_flexible_server_database.patchpage","change":{"actions":["create"]}}]'
              ;;
            *)
              plan_change_json='[{"address":"azurerm_container_app.server","change":{"actions":["update"]}}]'
              ;;
          esac
          printf \
            '{"planned_values":{"root_module":{"resources":[{"address":"azurerm_container_app.server","values":{"template":[{"container":[{"image":"acrpatchpageabc123.azurecr.io/patchpage-server@%s"}]}]}}]}},"resource_changes":%s}\n' \
            "$LEGACY_IMAGE_DIGEST" \
            "$plan_change_json"
          ;;
        apply\ *)
          test "$2" = "-input=false" && test "$3" = "$INFRA_PLAN" || return 1
          test "$scenario" != "final_apply_failure" || return 1
          : > "$scenario_root/infra-apply-completed"
          ;;
        *)
          return 1
          ;;
      esac
    }

    az() {
      normalize_az_args "$@" || return 1
      printf 'az %s\n' "$NORMALIZED_AZ_ARGS" >> "$log"
      printf 'private-infra-az-diagnostic %s\n' "$*" >&2
      case "$1 $2" in
        "account set")
          test "$scenario" != "subscription_set_failure"
          ;;
        "account show")
          test "$scenario" != "subscription_show_failure" || return 1
          if test "$scenario" = "subscription_mismatch"; then
            printf '%s\n' "33333333-3333-3333-3333-333333333333"
          else
            printf '%s\n' "$SUBSCRIPTION_ID"
          fi
          ;;
        "storage blob")
          case "$3" in
            exists)
              case " $* " in
                *" --account-name $STATE_STORAGE_ACCOUNT --container-name $STATE_CONTAINER --name $STATE_KEY --auth-mode key --query exists --output tsv "*) ;;
                *) return 1 ;;
              esac
              test "$scenario" != "state_blob_check_failure" || return 1
              if test "$scenario" = "missing_state_blob"; then
                printf '%s\n' "false"
              else
                printf '%s\n' "true"
              fi
              ;;
            list)
              case " $* " in
                *" --account-name $STATE_STORAGE_ACCOUNT --container-name patchpage-operations --auth-mode key --include d v --num-results * --query [].name --output tsv "*)
                  test "$scenario" != "operation_container_nonempty" ||
                    printf '%s\n' "unexpected"
                  ;;
                *) return 1 ;;
              esac
              ;;
            *) return 1 ;;
          esac
          ;;
        "storage account")
          if test "$3" = "show"; then
            if test "$scenario" = "state_account_identity_mismatch"; then
              printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/otherstate"
            else
              printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT"
            fi
          else
            case "$3 $4" in
            "blob-service-properties update")
              test "$scenario" != "adoption_retention_update_failure"
              ;;
            "blob-service-properties show")
              test "$scenario" != "retention_show_failure" || return 1
              versioning="true"
              blob_delete_enabled="true"
              blob_delete_days="30"
              permanent_delete="false"
              container_delete_enabled="true"
              container_delete_days="30"
              case " $* " in
                *" --account-name patchpagedrafts "*)
                  if test "$scenario" = "workload_retention_too_low"; then
                    blob_delete_days="90"
                    container_delete_days="365"
                  fi
                  ;;
                *)
                  case "$scenario" in
                    versioning_missing) versioning="false" ;;
                    blob_retention_missing) blob_delete_enabled="false" ;;
                    state_permanent_delete_enabled) permanent_delete="true" ;;
                    blob_retention_too_short) blob_delete_days="29" ;;
                    container_retention_missing) container_delete_enabled="false" ;;
                    container_retention_too_short) container_delete_days="29" ;;
                    adoption_preserves_state_retention)
                      blob_delete_days="90"
                      container_delete_days="365"
                      ;;
                  esac
                  ;;
              esac
              printf \
                '{"isVersioningEnabled":%s,"deleteRetentionPolicy":{"enabled":%s,"allowPermanentDelete":%s,"days":%s},"containerDeleteRetentionPolicy":{"enabled":%s,"days":%s}}\n' \
                "$versioning" \
                "$blob_delete_enabled" \
                "$permanent_delete" \
                "$blob_delete_days" \
                "$container_delete_enabled" \
                "$container_delete_days"
              ;;
            *)
              return 1
              ;;
            esac
          fi
          ;;
        "storage container-rm")
          test "$3" = "show" || return 1
          if test "$scenario" = "operation_container_id_mismatch"; then
            printf '%s\n' "$EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/foreign"
          else
            printf '%s\n' "$EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/patchpage-operations"
          fi
          ;;
        "storage container")
          case "$3" in
            create)
              case " $* " in
                *" --name patchpage-operations --account-name $STATE_STORAGE_ACCOUNT --public-access off --auth-mode key --fail-on-exist --metadata patchpage_workload_binding_sha256=$EXPECTED_OPERATION_BINDING_SHA256 "*) ;;
                *) return 1 ;;
              esac
              test "$scenario" != "adoption_operation_container_create_failure" || return 1
              operation_container_created="true"
              printf '%s\n' "$EXPECTED_OPERATION_BINDING_SHA256" > "$scenario_root/operation-binding"
              ;;
            exists)
              case " $* " in
                *" --name $STATE_CONTAINER --account-name $STATE_STORAGE_ACCOUNT --auth-mode key --query exists --output tsv "*)
                  printf '%s\n' "true"
                  ;;
                *" --name patchpage-operations --account-name $STATE_STORAGE_ACCOUNT --auth-mode key --query exists --output tsv "*)
                  if test "$scenario" = "operation_container_missing"; then
                    printf '%s\n' "false"
                  else
                    printf '%s\n' "$operation_container_created"
                  fi
                  ;;
                *" --account-name $STATE_STORAGE_ACCOUNT --name patchpage-operations --auth-mode key --query exists --output tsv "*)
                  if test "$scenario" = "operation_container_missing"; then
                    printf '%s\n' "false"
                  else
                    printf '%s\n' "$operation_container_created"
                  fi
                  ;;
                *) return 1 ;;
              esac
              ;;
            metadata)
              case "$4" in
                show)
                  operation_metadata_count_file="$scenario_root/operation-metadata-count"
                  operation_metadata_count=0
                  if test -f "$operation_metadata_count_file"; then
                    operation_metadata_count="$(command cat "$operation_metadata_count_file")"
                  fi
                  operation_metadata_count=$((operation_metadata_count + 1))
                  printf '%s\n' "$operation_metadata_count" > "$operation_metadata_count_file"
                  if test "$scenario" = "adoption_foreign_binding" ||
                    { test "$scenario" = "adoption_binding_concurrent_metadata" &&
                      test "$operation_metadata_count" -gt 1; }; then
                    printf '%s\n' '{"foreign":"binding"}'
                  elif test -f "$scenario_root/operation-binding"; then
                    operation_binding="$(command cat "$scenario_root/operation-binding")"
                    printf '{"patchpage_workload_binding_sha256":"%s"}\n' "$operation_binding"
                  elif test "$scenario" = "adoption_existing_unbound_success" ||
                    test "$scenario" = "adoption_binding_update_failure" ||
                    test "$scenario" = "adoption_binding_concurrent_metadata"; then
                    printf '%s\n' '{}'
                  else
                    printf '{"patchpage_workload_binding_sha256":"%s"}\n' "$EXPECTED_OPERATION_BINDING_SHA256"
                  fi
                  ;;
                update)
                  test "$scenario" != "adoption_binding_update_failure" || return 1
                  operation_metadata_lease_id=
                  operation_binding=
                  while test "$#" -gt 0; do
                    case "$1" in
                      --lease-id)
                        operation_metadata_lease_id="$2"
                        shift 2
                        ;;
                      patchpage_workload_binding_sha256=*)
                        operation_binding="${1#*=}"
                        shift
                        ;;
                      *) shift ;;
                    esac
                  done
                  test -f "$scenario_root/operation-lease-id" || return 1
                  test "$operation_metadata_lease_id" = "$(
                    command cat "$scenario_root/operation-lease-id"
                  )" || return 1
                  test -n "$operation_binding" || return 1
                  printf '%s\n' "$operation_binding" > "$scenario_root/operation-binding"
                  ;;
                *) return 1 ;;
              esac
              ;;
            list)
              case " $* " in
                *" --account-name $STATE_STORAGE_ACCOUNT --auth-mode key --include-deleted true --num-results * --query [].[name,deleted] --output tsv "*) ;;
                *) return 1 ;;
              esac
              case "$scenario" in
                adoption_foreign_container)
                  printf 'tfstate\tfalse\nforeign\tfalse\n'
                  ;;
                adoption_recoverable_container)
                  printf 'tfstate\tfalse\npatchpage-operations\ttrue\n'
                  ;;
                adoption_duplicate_container)
                  printf 'tfstate\tfalse\ntfstate\tfalse\n'
                  ;;
                adoption_container_inventory_inconsistent)
                  printf 'tfstate\tfalse\npatchpage-operations\tfalse\n'
                  ;;
                *)
                  printf 'tfstate\tfalse\n'
                  test "$operation_container_created" = "false" ||
                    printf 'patchpage-operations\tfalse\n'
                  ;;
              esac
              ;;
            lease) mock_operation_lease "$@" ;;
            *) return 1 ;;
          esac
          ;;
        "role assignment")
          case "$3" in
            list)
              case " $* " in
                *" --assignee-object-id ${OPERATION_PRINCIPAL_ID:-} --role /subscriptions/$SUBSCRIPTION_ID/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe --scope $EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/patchpage-operations --include-inherited --include-groups --fill-principal-name false --fill-role-definition-name false --output json "*)
                  role_assignment_scope="operation"
                  ;;
                *" --assignee-object-id ${OPERATION_PRINCIPAL_ID:-} --scope $EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/tfstate --include-inherited --include-groups --fill-principal-name false --fill-role-definition-name false --output json "*)
                  role_assignment_scope="state"
                  ;;
                *) return 1 ;;
              esac
              if test "$scenario" = "adoption_operation_role_broad"; then
                printf '[{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe","scope":"%s"}]\n' \
                  "$OPERATION_PRINCIPAL_ID" "$SUBSCRIPTION_ID" "$EXPECTED_STATE_STORAGE_ACCOUNT_ID"
              elif test "$role_assignment_scope" = "state"; then
                if test "$scenario" = "adoption_state_role_reader"; then
                  printf '[{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/2a2b9908-6ea1-4ae2-8e65-a410df84e7d1","scope":"%s/blobServices/default/containers/tfstate"}]\n' \
                    "$OPERATION_PRINCIPAL_ID" "$SUBSCRIPTION_ID" "$EXPECTED_STATE_STORAGE_ACCOUNT_ID"
                elif test "$scenario" = "adoption_operation_role_ambiguous"; then
                  printf '[{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe","scope":"%s"}]\n' \
                    "$OPERATION_PRINCIPAL_ID" "$SUBSCRIPTION_ID" "$EXPECTED_STATE_STORAGE_ACCOUNT_ID"
                else
                  printf '%s\n' '[]'
                fi
              else
                case "$scenario" in
                  adoption_operation_role_wrong)
                    printf '[{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7","scope":"%s/blobServices/default/containers/patchpage-operations"}]\n' \
                      "$OPERATION_PRINCIPAL_ID" "$SUBSCRIPTION_ID" "$EXPECTED_STATE_STORAGE_ACCOUNT_ID"
                    ;;
                  adoption_operation_role_ambiguous)
                    printf '[{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe","scope":"%s/blobServices/default/containers/patchpage-operations"},{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe","scope":"%s"}]\n' \
                      "$OPERATION_PRINCIPAL_ID" "$SUBSCRIPTION_ID" "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" \
                      "$OPERATION_PRINCIPAL_ID" "$SUBSCRIPTION_ID" "$EXPECTED_STATE_STORAGE_ACCOUNT_ID"
                    ;;
                  *)
                    if test "$role_assignment_created" = "true"; then
                      printf '[{"principalId":"%s","roleDefinitionId":"/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe","scope":"%s/blobServices/default/containers/patchpage-operations"}]\n' \
                        "$OPERATION_PRINCIPAL_ID" "$SUBSCRIPTION_ID" "$EXPECTED_STATE_STORAGE_ACCOUNT_ID"
                    else
                      printf '%s\n' '[]'
                    fi
                    ;;
                esac
              fi
              ;;
            create)
              case " $* " in
                *" --assignee-object-id ${OPERATION_PRINCIPAL_ID:-} --assignee-principal-type ${OPERATION_PRINCIPAL_TYPE:-} --role /subscriptions/$SUBSCRIPTION_ID/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe --scope $EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/patchpage-operations --output none "*) ;;
                *) return 1 ;;
              esac
              test "$scenario" != "adoption_operation_role_create_failure" || return 1
              role_assignment_created="true"
              ;;
            *) return 1 ;;
          esac
          ;;
        "lock list")
          lock_resource=""
          while test "$#" -gt 0; do
            if test "$1" = "--resource"; then lock_resource="$2"; break; fi
            shift
          done
          case "$lock_resource" in
            "$EXPECTED_STATE_STORAGE_ACCOUNT_ID")
              lock_name="protect-patchpage-tfstate"
              stronger_scenario="adoption_state_stronger_lock"
              ;;
            "$EXPECTED_STORAGE_ACCOUNT_ID")
              lock_name="protect-patchpage-drafts"
              stronger_scenario="adoption_workload_stronger_lock"
              ;;
            "$EXPECTED_POSTGRES_SERVER_ID")
              lock_name="protect-patchpage-postgres"
              stronger_scenario="adoption_postgres_foreign_lock"
              ;;
            *) return 1 ;;
          esac
          if test "$scenario" = "$stronger_scenario"; then
            printf '%s\tReadOnly\t%s/providers/Microsoft.Authorization/locks/%s\n' \
              "$lock_name" "$lock_resource" "$lock_name"
          elif test "${ADOPT_SAFETY_GUARDS:-false}" != "true"; then
            printf '%s\tCanNotDelete\t%s/providers/Microsoft.Authorization/locks/%s\n' \
              "$lock_name" "$lock_resource" "$lock_name"
          fi
          ;;
        "lock create")
          case " $* " in
            *" --name protect-patchpage-tfstate "*)
              test "$scenario" != "adoption_state_lock_create_failure"
              ;;
            *" --name protect-patchpage-drafts "*)
              test "$scenario" != "adoption_workload_lock_create_failure"
              ;;
            *" --name protect-patchpage-postgres "*)
              test "$scenario" != "adoption_postgres_lock_create_failure"
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        "lock show")
          case " $* " in
            *" --ids $EXPECTED_STATE_STORAGE_ACCOUNT_ID/providers/Microsoft.Authorization/locks/protect-patchpage-tfstate "*)
              test "$scenario" != "state_lock_show_failure" || return 1
              if test "$scenario" = "state_lock_missing"; then
                printf 'ReadOnly\t%s/providers/Microsoft.Authorization/locks/protect-patchpage-tfstate\n' "$EXPECTED_STATE_STORAGE_ACCOUNT_ID"
              else
                printf 'CanNotDelete\t%s/providers/Microsoft.Authorization/locks/protect-patchpage-tfstate\n' "$EXPECTED_STATE_STORAGE_ACCOUNT_ID"
              fi
              ;;
            *" --ids $EXPECTED_STORAGE_ACCOUNT_ID/providers/Microsoft.Authorization/locks/protect-patchpage-drafts "*)
              test "$scenario" != "workload_lock_show_failure" || return 1
              if test "$scenario" = "workload_lock_missing"; then
                printf 'ReadOnly\t%s/providers/Microsoft.Authorization/locks/protect-patchpage-drafts\n' "$EXPECTED_STORAGE_ACCOUNT_ID"
              else
                printf 'CanNotDelete\t%s/providers/Microsoft.Authorization/locks/protect-patchpage-drafts\n' "$EXPECTED_STORAGE_ACCOUNT_ID"
              fi
              ;;
            *" --ids $EXPECTED_POSTGRES_SERVER_ID/providers/Microsoft.Authorization/locks/protect-patchpage-postgres "*)
              printf 'CanNotDelete\t%s/providers/Microsoft.Authorization/locks/protect-patchpage-postgres\n' "$EXPECTED_POSTGRES_SERVER_ID"
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        "resource show")
          test "$3" = "--ids" || return 1
          case "$4" in
            "$EXPECTED_STORAGE_ACCOUNT_ID")
              test "$scenario" != "storage_resource_missing"
              ;;
            "$EXPECTED_POSTGRES_SERVER_ID")
              test "$scenario" != "postgres_resource_missing"
              ;;
            "$EXPECTED_ACR_ID")
              test "$scenario" != "acr_resource_missing"
              ;;
            "$EXPECTED_CONTAINER_APP_ID")
              test "$scenario" != "container_app_resource_missing"
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        "acr show")
          printf '%s\n' "acrpatchpageabc123.azurecr.io"
          ;;
        "acr manifest")
          test "$3" = "show-metadata" || return 1
          test "$scenario" != "adoption_manifest_failure" || return 1
          printf '%s\n' "$LEGACY_IMAGE_DIGEST"
          ;;
        "containerapp show")
          case " $* " in
            *" --ids $EXPECTED_CONTAINER_APP_ID --output json "*) ;;
            *) return 1 ;;
          esac
          if test "$scenario" = "postapply_app_show_failure" &&
            test -e "$scenario_root/infra-apply-completed"; then
            return 1
          fi
          app_image="$IMMUTABLE_IMAGE"
          app_latest_revision="$OLD_REVISION_NAME"
          app_ready_revision="$OLD_REVISION_NAME"
          if test -e "$scenario_root/infra-apply-completed"; then
            case "$scenario" in
              nonrevision_apply_success)
                app_latest_revision="$(
                  if test -e "$scenario_root/legacy-image-updated"; then
                    printf '%s\n' "$ADOPTION_REVISION_NAME"
                  else
                    printf '%s\n' "$OLD_REVISION_NAME"
                  fi
                )"
                app_ready_revision="$app_latest_revision"
                ;;
              *)
                app_latest_revision="$POSTAPPLY_REVISION_NAME"
                app_ready_revision="$POSTAPPLY_REVISION_NAME"
                ;;
            esac
            postapply_app_show_count_file="$scenario_root/postapply-app-show-count"
            postapply_app_show_count=0
            if test -e "$postapply_app_show_count_file"; then
              postapply_app_show_count="$(cat "$postapply_app_show_count_file")"
            fi
            postapply_app_show_count=$((postapply_app_show_count + 1))
            printf '%s\n' "$postapply_app_show_count" > "$postapply_app_show_count_file"
            if test "$scenario" = "final_pinned_drift" &&
              test "$postapply_app_show_count" -ge 4; then
              app_latest_revision="$LATER_REVISION_NAME"
              app_ready_revision="$LATER_REVISION_NAME"
            fi
          elif test -e "$scenario_root/legacy-image-updated"; then
            app_latest_revision="$ADOPTION_REVISION_NAME"
            app_ready_revision="$ADOPTION_REVISION_NAME"
          elif test "${ADOPT_SAFETY_GUARDS:-false}" = "true"; then
            if test "$scenario" = "adoption_invalid_legacy_tag"; then
              app_image="acrpatchpageabc123.azurecr.io/patchpage-server:latest"
            elif test "$scenario" != "adoption_digest_current"; then
              app_image="acrpatchpageabc123.azurecr.io/patchpage-server:$LEGACY_IMAGE_TAG"
            fi
          else
            case "$scenario" in
              preexisting_pending_revision)
                app_latest_revision="patchpage-app--pending"
                ;;
              preexisting_failed_revision)
                app_latest_revision="patchpage-app--failed"
                ;;
            esac
          fi
          if test -e "$scenario_root/infra-plan-created" &&
            ! test -e "$scenario_root/infra-apply-completed" &&
            test "$scenario" = "preapply_image_mismatch"; then
            app_image="acrpatchpageabc123.azurecr.io/patchpage-server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          fi
          printf '{"id":"%s","properties":{"provisioningState":"Succeeded","latestRevisionName":"%s","latestReadyRevisionName":"%s","configuration":{"activeRevisionsMode":"Single","ingress":{"traffic":[{"latestRevision":true,"weight":100}]}},"template":{"containers":[{"name":"server","image":"%s"}]}}}\n' \
            "$EXPECTED_CONTAINER_APP_ID" "$app_latest_revision" \
            "$app_ready_revision" "$app_image"
          ;;
        "containerapp revision")
          revision_action="$3"
          revision_name=
          while test "$#" -gt 0; do
            if test "$1" = "--revision"; then
              revision_name="$2"
              break
            fi
            shift
          done
          case "$revision_action" in
            show)
              revision_image="$IMMUTABLE_IMAGE"
              revision_active=true
              revision_provisioning="Provisioned"
              revision_health="Healthy"
              revision_running="Running"
              revision_weight=100
              case "$revision_name" in
                "$OLD_REVISION_NAME") ;;
                "$ADOPTION_REVISION_NAME")
                  adoption_revision_show_count_file="$scenario_root/adoption-revision-show-count"
                  adoption_revision_show_count=0
                  if test -e "$adoption_revision_show_count_file"; then
                    adoption_revision_show_count="$(cat "$adoption_revision_show_count_file")"
                  fi
                  adoption_revision_show_count=$((adoption_revision_show_count + 1))
                  printf '%s\n' "$adoption_revision_show_count" > "$adoption_revision_show_count_file"
                  if test "$adoption_revision_show_count" -eq 1; then
                    revision_active=false
                    revision_provisioning="Provisioning"
                    revision_health="Unknown"
                    revision_running="Processing"
                    revision_weight=0
                  fi
                  if test "$scenario" = "adoption_image_verification_failure"; then
                    revision_image="acrpatchpageabc123.azurecr.io/patchpage-server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                  fi
                  ;;
                "$POSTAPPLY_REVISION_NAME")
                  postapply_revision_show_count_file="$scenario_root/postapply-revision-show-count"
                  postapply_revision_show_count=0
                  if test -e "$postapply_revision_show_count_file"; then
                    postapply_revision_show_count="$(cat "$postapply_revision_show_count_file")"
                  fi
                  postapply_revision_show_count=$((postapply_revision_show_count + 1))
                  printf '%s\n' "$postapply_revision_show_count" > "$postapply_revision_show_count_file"
                  if test "$postapply_revision_show_count" -eq 1 ||
                    test "$scenario" = "postapply_never_ready"; then
                    revision_active=false
                    revision_provisioning="Provisioning"
                    revision_health="Unknown"
                    revision_running="Processing"
                    revision_weight=0
                  fi
                  if test "$scenario" = "postapply_image_mismatch"; then
                    revision_image="acrpatchpageabc123.azurecr.io/patchpage-server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                  fi
                  ;;
                patchpage-app--pending)
                  revision_active=false
                  revision_provisioning="Provisioning"
                  revision_health="Unknown"
                  revision_running="Processing"
                  revision_weight=0
                  ;;
                patchpage-app--failed)
                  revision_active=false
                  revision_provisioning="Failed"
                  revision_health="Unhealthy"
                  revision_running="Stopped"
                  revision_weight=0
                  ;;
                *) return 1 ;;
              esac
              if test "$scenario" = "scale_to_zero_success"; then
                revision_health="None"
                revision_running="ScaleToZero"
              fi
              printf '{"name":"%s","properties":{"active":%s,"provisioningState":"%s","healthState":"%s","runningState":"%s","trafficWeight":%s,"template":{"containers":[{"name":"server","image":"%s"}]}}}\n' \
                "$revision_name" "$revision_active" "$revision_provisioning" \
                "$revision_health" "$revision_running" "$revision_weight" \
                "$revision_image"
              ;;
            list)
              active_revision="$OLD_REVISION_NAME"
              if test -e "$scenario_root/infra-apply-completed"; then
                if test "$scenario" = "nonrevision_apply_success"; then
                  if test -e "$scenario_root/legacy-image-updated"; then
                    active_revision="$ADOPTION_REVISION_NAME"
                  fi
                else
                  active_revision="$POSTAPPLY_REVISION_NAME"
                fi
                if test "$scenario" = "postapply_multiple_active"; then
                  printf '[{"name":"%s","properties":{"active":true}},{"name":"%s","properties":{"active":true}}]\n' \
                    "$OLD_REVISION_NAME" "$POSTAPPLY_REVISION_NAME"
                  return
                fi
              elif test -e "$scenario_root/legacy-image-updated"; then
                active_revision="$ADOPTION_REVISION_NAME"
              fi
              printf '[{"name":"%s","properties":{"active":true}}]\n' \
                "$active_revision"
              ;;
            *) return 1 ;;
          esac
          ;;
        "containerapp update")
          test "$scenario" != "adoption_image_update_failure" || return 1
          : > "$scenario_root/legacy-image-updated"
          printf '%s\n' "$ADOPTION_REVISION_NAME"
          ;;
        *)
          return 1
          ;;
      esac
    }

    eval "$INFRASTRUCTURE_CHANGE_BLOCK"
    eval "$INFRASTRUCTURE_CHANGE_APPLY_BLOCK"
    printf '%s\n' completed >> "$log"
  ) >"$output" 2>&1
}

test_infrastructure_change() {
  required_addresses='
azurerm_resource_group.patchpage
azurerm_container_registry.patchpage
azurerm_storage_account.drafts
azurerm_storage_container.drafts
azurerm_postgresql_flexible_server.patchpage
azurerm_postgresql_flexible_server_database.patchpage
azurerm_container_app.server'
  printf '%s\n' "$required_addresses" |
    while IFS= read -r address; do
      test -z "$address" && continue
      printf '%s\n' "$INFRASTRUCTURE_CHANGE_BLOCK" | grep -Fq "$address" ||
        fail "infrastructure change omitted required state address $address"
    done

  for scenario in \
    subscription_set_failure \
    subscription_show_failure \
    subscription_mismatch \
    infra_repo_root_failure \
    backend_chmod_failure \
    infra_subscription_console_failure \
    infra_subscription_mismatch \
    infra_resource_group_console_failure \
    infra_resource_group_invalid \
    infra_resource_group_mismatch \
    invalid_adopt_value \
    adoption_operation_principal_id_missing \
    adoption_operation_principal_id_invalid \
    adoption_operation_principal_type_missing \
    adoption_operation_principal_type_invalid \
    adoption_operation_principal_group \
    adoption_foreign_container \
    adoption_recoverable_container \
    adoption_duplicate_container \
    adoption_container_inventory_inconsistent \
    adoption_foreign_binding \
    adoption_binding_update_failure \
    adoption_binding_concurrent_metadata \
    adoption_operation_container_create_failure \
    adoption_operation_role_create_failure \
    adoption_operation_role_broad \
    adoption_operation_role_wrong \
    adoption_operation_role_ambiguous \
    adoption_state_role_reader \
    adoption_state_stronger_lock \
    adoption_workload_stronger_lock \
    adoption_postgres_foreign_lock \
    adoption_retention_update_failure \
    adoption_state_lock_create_failure \
    adoption_workload_lock_create_failure \
    adoption_postgres_lock_create_failure \
    adoption_storage_lock_import_failure \
    adoption_postgres_lock_import_failure \
    adoption_manifest_failure \
    adoption_invalid_legacy_tag \
    adoption_legacy_digest_missing \
    adoption_legacy_digest_mismatch \
    adoption_image_update_failure \
    adoption_image_verification_failure \
    adoption_image_config_mismatch \
    adoption_digest_current \
    adoption_existing_unbound_success \
    adoption_success \
    adoption_preserves_state_retention \
    state_blob_check_failure \
    missing_state_blob \
    state_account_identity_mismatch \
    state_lock_show_failure \
    state_lock_missing \
    retention_show_failure \
    versioning_missing \
    blob_retention_missing \
    state_permanent_delete_enabled \
    blob_retention_too_short \
    container_retention_missing \
    infra_diagnostic_secure_dir_failure \
    infra_diagnostic_log_open_failure \
    container_retention_too_short \
    init_failure \
    secure_change_dir_failure \
    state_snapshot_open_failure \
    state_pull_failure \
    state_values_failure \
    wrong_lineage \
    missing_required_state_address \
    wrong_resource_group_id \
    wrong_storage_account_id \
    wrong_postgres_server_id \
    wrong_acr_id \
    wrong_container_app_id \
    storage_resource_missing \
    postgres_resource_missing \
    acr_resource_missing \
    container_app_resource_missing \
    operation_container_missing \
    operation_container_id_mismatch \
    operation_container_nonempty \
    operation_lease_held \
    operation_lease_acquire_failure \
    operation_lease_renew_failure \
    operation_lease_release_failure \
    workload_retention_too_low \
    workload_lock_show_failure \
    workload_lock_missing \
    plan_failure \
    plan_json_open_failure \
    preexisting_pending_revision \
    preexisting_failed_revision \
    preapply_image_mismatch \
    postapply_image_mismatch \
    postapply_app_show_failure \
    postapply_never_ready \
    postapply_multiple_active \
    final_pinned_drift \
    plan_gate_show_failure \
    delete_plan \
    replacement_plan \
    missing_container_plan \
    missing_database_plan \
    plan_summary_failure \
    nonrevision_apply_success \
    scale_to_zero_success \
    final_apply_failure \
    secure_change_cleanup_failure \
    infra_diagnostic_cleanup_failure \
    success; do
    if run_infrastructure_change_block "$scenario"; then
      status=0
    else
      status=$?
    fi

    log="$TMP_DIR/infrastructure-$scenario.log"
    output="$TMP_DIR/infrastructure-$scenario.out"
    diagnostic_path_file="$TMP_DIR/infrastructure-$scenario/diagnostic-dir"
    if test "$scenario" = "success" ||
      test "$scenario" = "infra_diagnostic_cleanup_failure" ||
      test "$scenario" = "nonrevision_apply_success" ||
      test "$scenario" = "scale_to_zero_success" ||
      test "$scenario" = "adoption_success" ||
      test "$scenario" = "adoption_digest_current" ||
      test "$scenario" = "adoption_existing_unbound_success" ||
      test "$scenario" = "adoption_preserves_state_retention"; then
      test "$status" -eq 0 || fail "infrastructure change rejected $scenario"
      infra_plan="$(
        awk '
          /^terraform plan -input=false -out=.*\/infrastructure\.tfplan$/ {
            sub(/^terraform plan -input=false -out=/, "")
            print
          }
        ' "$log"
      )"
      test -n "$infra_plan" ||
        fail "infrastructure change did not save its plan in the secure directory"
      case "$infra_plan" in
        "$diagnostic_root"/*) ;;
        *) fail "infrastructure change stored its plan outside the private diagnostic root" ;;
      esac
      test "$(grep -Fxc "terraform show -json $infra_plan" "$log")" -eq 1 ||
        fail "infrastructure change did not capture the saved plan JSON exactly once"
      test "$(grep -Fxc "terraform apply -input=false $infra_plan" "$log")" -eq 1 ||
        fail "infrastructure change did not apply exactly the reviewed saved plan"
      test -f "$diagnostic_path_file" ||
        fail "successful infrastructure change did not create a private diagnostic location"
      if test "$scenario" = "infra_diagnostic_cleanup_failure"; then
        test -d "$(cat "$diagnostic_path_file")" ||
          fail "infrastructure cleanup-failure scenario unexpectedly removed diagnostics"
        grep -Fqx 'Terraform succeeded, but private diagnostic cleanup failed.' "$output" ||
          fail "infrastructure cleanup failure did not emit only its generic error"
      else
        test ! -d "$(cat "$diagnostic_path_file")" ||
          fail "successful infrastructure change retained private Terraform diagnostics"
      fi
      grep -Fqx completed "$log" ||
        fail "successful infrastructure change did not complete"
      grep -Eq \
        '^az storage container lease acquire --account-name patchpagestate --container-name patchpage-operations --auth-mode key --lease-duration -1 --proposed-lease-id [0-9a-f-]{36} --output none$' \
        "$log" ||
        fail "infrastructure change did not acquire the infinite operation lease with state-account key authorization"
      infra_lease_id="$(
        sed -n \
          's/^az storage container lease acquire .* --lease-duration -1 --proposed-lease-id \([^ ]*\) --output none$/\1/p' \
          "$log"
      )"
      test -n "$infra_lease_id" ||
        fail "infrastructure change did not record its infinite operation lease ID"
      grep -Fqx \
        "az storage container lease renew --account-name patchpagestate --container-name patchpage-operations --auth-mode key --lease-id $infra_lease_id --output none" \
        "$log" ||
        fail "infrastructure change did not renew its exact lease with state-account key authorization"
      grep -Fqx \
        "az storage container lease release --account-name patchpagestate --container-name patchpage-operations --auth-mode key --lease-id $infra_lease_id --output none" \
        "$log" ||
        fail "infrastructure change did not release its exact lease with state-account key authorization"
      grep -Fqx \
        'az storage blob list --account-name patchpagestate --container-name patchpage-operations --auth-mode key --include d v --num-results * --query [].name --output tsv' \
        "$log" ||
        fail "infrastructure change did not key-verify the empty operation container"
      if grep -Eq '^az storage (container exists|blob list|container lease) .*--auth-mode login' "$log"; then
        fail "infrastructure change used release-principal login authorization for operation storage"
      fi
      backend_file="$TMP_DIR/infrastructure-$scenario/infra/azure/backend.hcl"
      grep -Fqx 'storage_account_name = "patchpagestate"' "$backend_file" ||
        fail "infrastructure backend did not retain the private state account identity"
      grep -Fqx 'container_name       = "tfstate"' "$backend_file" ||
        fail "infrastructure backend did not retain the private state container identity"
      grep -Fqx \
        'az storage account show --name patchpagestate --resource-group rg-patchpage-tfstate --query id --output tsv' \
        "$log" ||
        fail "infrastructure change did not prove the live state-account identity"
      backend_mode="$(
        file_mode "$backend_file"
      )"
      test "$backend_mode" = "600" ||
        fail "infrastructure change backend config is not mode 0600"
      image_vars_file="$TMP_DIR/infrastructure-$scenario/infra/azure/server-image.auto.tfvars"
      grep -Fqx \
        'server_image = "acrpatchpageabc123.azurecr.io/patchpage-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
        "$image_vars_file" ||
        fail "infrastructure change did not synchronize the verified immutable image"
      image_vars_mode="$(
        file_mode "$image_vars_file"
      )"
      test "$image_vars_mode" = "600" ||
        fail "infrastructure image variable is not mode 0600"
      case "$scenario" in
        adoption_success | adoption_existing_unbound_success | adoption_preserves_state_retention)
          if test "$scenario" = "adoption_preserves_state_retention"; then
            grep -Fqx \
              'az storage account blob-service-properties update --account-name patchpagestate --resource-group rg-patchpage-tfstate --enable-versioning true --enable-delete-retention true --delete-retention-days 90 --enable-container-delete-retention true --container-delete-retention-days 365 --set deleteRetentionPolicy.allowPermanentDelete=false' \
              "$log" ||
              fail "safety adoption lowered existing state retention"
          else
            grep -Fqx \
              'az storage account blob-service-properties update --account-name patchpagestate --resource-group rg-patchpage-tfstate --enable-versioning true --enable-delete-retention true --delete-retention-days 30 --enable-container-delete-retention true --container-delete-retention-days 30 --set deleteRetentionPolicy.allowPermanentDelete=false' \
              "$log" ||
              fail "safety adoption did not enable state versioning and retention"
          fi
          grep -Fqx \
            'az lock create --name protect-patchpage-tfstate --lock-type CanNotDelete --resource /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate' \
            "$log" ||
            fail "safety adoption did not create the exact state-account deletion lock"
          grep -Fqx \
            'az lock create --name protect-patchpage-drafts --lock-type CanNotDelete --notes Protects persistent blob data from accidental deletion. --resource /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.Storage/storageAccounts/patchpagedrafts' \
            "$log" ||
            fail "safety adoption did not create the exact workload Storage deletion lock"
          grep -Fqx \
            'az lock create --name protect-patchpage-postgres --lock-type CanNotDelete --notes Protects persistent database data from accidental deletion. --resource /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-db' \
            "$log" ||
            fail "safety adoption did not create the exact PostgreSQL deletion lock"
          grep -Fqx \
            'terraform import -input=false azurerm_management_lock.drafts_storage /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.Storage/storageAccounts/patchpagedrafts/providers/Microsoft.Authorization/locks/protect-patchpage-drafts' \
            "$log" ||
            fail "safety adoption did not bind the Storage lock to Terraform state"
          grep -Fqx \
            'terraform import -input=false azurerm_management_lock.patchpage_postgres /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-db/providers/Microsoft.Authorization/locks/protect-patchpage-postgres' \
            "$log" ||
            fail "safety adoption did not bind the PostgreSQL lock to Terraform state"
          if grep -Eq '^az lock .*--resource-group ' "$log"; then
            fail "safety adoption locked the mixed workload resource group"
          fi
          grep -Fqx \
            'az containerapp update --resource-group rg-patchpage-workload --name patchpage-app --container-name server --image acrpatchpageabc123.azurecr.io/patchpage-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --query properties.latestRevisionName --output tsv' \
            "$log" ||
            fail "safety adoption did not migrate the legacy image tag to its verified digest"
          ;;
        adoption_digest_current)
          if grep -Fq 'az containerapp update ' "$log"; then
            fail "safety adoption rewrote an already immutable image"
          fi
          ;;
      esac
      case "$scenario" in
        adoption_success | adoption_digest_current | adoption_existing_unbound_success | adoption_preserves_state_retention)
          container_inventory_command='az storage container list --account-name patchpagestate --auth-mode key --include-deleted true --num-results * --query [].[name,deleted] --output tsv'
          role_create_command='az role assignment create --assignee-object-id 22222222-2222-4222-8222-222222222222 --assignee-principal-type ServicePrincipal --role /subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe --scope /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/patchpage-operations --output none'
          key_verify_command='az storage container exists --account-name patchpagestate --name patchpage-operations --auth-mode key --query exists --output tsv'
          test "$(grep -Fxc "$container_inventory_command" "$log")" -eq 2 ||
            fail "safety adoption did not inventory only-tfstate state storage before and after operation-container creation"
          if test "$scenario" = "adoption_existing_unbound_success"; then
            if grep -Eq '^az storage container create ' "$log"; then
              fail "safety adoption recreated an existing unbound operation container"
            fi
            binding_lease_id="$(
              sed -n \
                's/^az storage container lease acquire .* --lease-duration 60 --proposed-lease-id \([^ ]*\) --output none$/\1/p' \
                "$log"
            )"
            test -n "$binding_lease_id" ||
              fail "safety adoption did not acquire a finite binding lease"
            grep -Eq \
              "^az storage container metadata update --account-name patchpagestate --name patchpage-operations --auth-mode key --lease-id $binding_lease_id --metadata patchpage_workload_binding_sha256=[0-9a-f]{64} --output none$" \
              "$log" ||
              fail "safety adoption did not bind the existing empty operation container under its exact lease"
            grep -Fqx \
              "az storage container lease release --account-name patchpagestate --container-name patchpage-operations --auth-mode key --lease-id $binding_lease_id --output none" \
              "$log" ||
              fail "safety adoption did not release its finite binding lease"
          else
            grep -Eq '^az storage container create --name patchpage-operations --account-name patchpagestate --public-access off --auth-mode key --fail-on-exist --metadata patchpage_workload_binding_sha256=[0-9a-f]{64}$' "$log" ||
              fail "safety adoption did not atomically create and bind the exact operation container"
          fi
          grep -Fqx "$role_create_command" "$log" ||
            fail "safety adoption did not create the exact container-scoped built-in role grant"
          grep -Fqx "$key_verify_command" "$log" ||
            fail "safety adoption did not let the infrastructure operator key-verify the operation container"
          first_inventory_line="$(grep -nF "$container_inventory_command" "$log" | sed -n '1s/:.*//p')"
          create_line="$(grep -nE '^az storage container (create|metadata update) ' "$log" | sed -n '1s/:.*//p')"
          second_inventory_line="$(grep -nF "$container_inventory_command" "$log" | sed -n '2s/:.*//p')"
          role_create_line="$(grep -nF "$role_create_command" "$log" | sed -n '1s/:.*//p')"
          key_verify_line="$(grep -nF "$key_verify_command" "$log" | sed -n '$s/:.*//p')"
          lease_line="$(grep -nE '^az storage container lease acquire .* --lease-duration -1 ' "$log" | sed -n '1s/:.*//p')"
          plan_line="$(grep -nE '^terraform plan ' "$log" | sed -n '1s/:.*//p')"
          apply_line="$(grep -nE '^terraform apply ' "$log" | sed -n '1s/:.*//p')"
          if test -z "$first_inventory_line" || test -z "$create_line" ||
            test -z "$second_inventory_line" || test -z "$role_create_line" ||
            test -z "$key_verify_line" || test -z "$lease_line" ||
            test -z "$plan_line" || test -z "$apply_line"; then
            fail "safety adoption did not provision and verify the operation guard before lease, plan, and apply"
          fi
          if test "$scenario" = "adoption_existing_unbound_success"; then
            binding_lease_line="$(grep -nF "az storage container lease acquire --account-name patchpagestate --container-name patchpage-operations --auth-mode key --lease-duration 60 --proposed-lease-id $binding_lease_id --output none" "$log" | sed -n '1s/:.*//p')"
            binding_release_line="$(grep -nF "az storage container lease release --account-name patchpagestate --container-name patchpage-operations --auth-mode key --lease-id $binding_lease_id --output none" "$log" | sed -n '1s/:.*//p')"
            if test -z "$binding_lease_line" || test -z "$binding_release_line" ||
              test "$first_inventory_line" -ge "$second_inventory_line" ||
              test "$second_inventory_line" -ge "$binding_lease_line" ||
              test "$binding_lease_line" -ge "$create_line" ||
              test "$create_line" -ge "$binding_release_line" ||
              test "$binding_release_line" -ge "$role_create_line"; then
              fail "safety adoption did not lease-bind the inventoried operation guard before role provisioning"
            fi
          elif test "$first_inventory_line" -ge "$create_line" ||
            test "$create_line" -ge "$second_inventory_line" ||
            test "$second_inventory_line" -ge "$role_create_line"; then
            fail "safety adoption did not create and inventory the operation guard before role provisioning"
          fi
          if test "$role_create_line" -ge "$key_verify_line" ||
            test "$key_verify_line" -ge "$lease_line" ||
            test "$lease_line" -ge "$plan_line" ||
            test "$plan_line" -ge "$apply_line"; then
            fail "safety adoption did not provision and verify the operation guard before lease, plan, and apply"
          fi
          ;;
      esac
    else
      test "$status" -ne 0 || fail "infrastructure change accepted $scenario"
      if test "$scenario" != "final_apply_failure" &&
        test "$scenario" != "postapply_image_mismatch" &&
        test "$scenario" != "postapply_app_show_failure" &&
        test "$scenario" != "postapply_never_ready" &&
        test "$scenario" != "postapply_multiple_active" &&
        test "$scenario" != "final_pinned_drift" &&
        test "$scenario" != "operation_lease_release_failure" &&
        test "$scenario" != "secure_change_cleanup_failure" &&
        grep -Eq '^terraform apply -input=false .*/infrastructure\.tfplan$' "$log"; then
        fail "infrastructure change reached apply after $scenario"
      fi
      if grep -q '^completed$' "$log"; then
        fail "infrastructure change continued after $scenario"
      fi
    fi
    if grep -Eq \
      'private-infra-(az|terraform)-diagnostic|22222222-2222-4222-8222-222222222222|33333333-3333-3333-3333-333333333333|44444444-4444-4444-4444-444444444444|patchpagestate' \
      "$output"; then
      fail "infrastructure change exposed private producer diagnostics"
    fi
    if grep -Fq \
      '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload' \
      "$output"; then
      fail "infrastructure change exposed a configured private resource path"
    fi
    case "$scenario" in
      adoption_operation_principal_id_missing | adoption_operation_principal_id_invalid | \
      adoption_operation_principal_type_missing | adoption_operation_principal_type_invalid | \
        adoption_operation_principal_group | \
        adoption_foreign_container | adoption_recoverable_container | \
        adoption_duplicate_container | adoption_container_inventory_inconsistent | \
        adoption_foreign_binding | \
        adoption_operation_container_create_failure | adoption_operation_role_create_failure | \
        adoption_operation_role_broad | adoption_operation_role_wrong | \
        adoption_operation_role_ambiguous | adoption_state_role_reader)
        if grep -Eq '^az storage container lease acquire |^terraform (plan|apply) ' "$log"; then
          fail "safety adoption reached the lease or Terraform after unsafe operation-storage preflight $scenario"
        fi
        ;;
      adoption_binding_update_failure | adoption_binding_concurrent_metadata)
        if grep -Eq \
          '^az storage container lease acquire .* --lease-duration -1 |^terraform (plan|apply) ' \
          "$log"; then
          fail "safety adoption reached the operation lease or Terraform after $scenario"
        fi
        grep -Eq \
          '^az storage container lease acquire .* --auth-mode key --lease-duration 60 --proposed-lease-id [0-9a-f-]{36} --output none$' \
          "$log" ||
          fail "safety adoption did not acquire a finite binding lease before $scenario"
        grep -Eq \
          '^az storage container lease release .* --auth-mode key --lease-id [0-9a-f-]{36} --output none$' \
          "$log" ||
          fail "safety adoption did not release the finite binding lease after $scenario"
        if grep -Fq 'az role assignment create ' "$log"; then
          fail "safety adoption provisioned operation access after $scenario"
        fi
        if test "$scenario" = "adoption_binding_concurrent_metadata" &&
          grep -Fq 'az storage container metadata update ' "$log"; then
          fail "safety adoption overwrote concurrent operation-container metadata"
        fi
        ;;
      adoption_state_stronger_lock | adoption_workload_stronger_lock | \
        adoption_postgres_foreign_lock)
        if grep -Eq \
          '^az (storage account blob-service-properties update|storage container create|storage container metadata update|role assignment create|lock create) ' \
          "$log"; then
          fail "safety adoption mutated before rejecting foreign lock scenario $scenario"
        fi
        ;;
      adoption_storage_lock_import_failure | adoption_postgres_lock_import_failure)
        if grep -Eq '^terraform (plan|apply) ' "$log"; then
          fail "safety adoption planned after a management-lock state import failed"
        fi
        ;;
      adoption_legacy_digest_missing | adoption_legacy_digest_mismatch)
        if grep -Fq 'az containerapp update ' "$log"; then
          fail "safety adoption updated a legacy tag without the separately verified digest"
        fi
        ;;
      adoption_image_config_mismatch)
        if grep -Eq '^terraform (plan|apply) ' "$log"; then
          fail "safety adoption planned after Terraform rejected the synchronized image"
        fi
        ;;
      operation_container_id_mismatch | operation_container_missing | operation_container_nonempty | operation_lease_held | \
        operation_lease_acquire_failure | operation_lease_renew_failure)
        if grep -Eq '^terraform (plan|apply) ' "$log"; then
          fail "infrastructure change planned or applied after rejecting $scenario"
        fi
        ;;
      operation_lease_release_failure)
        grep -Eq '^terraform apply -input=false .*/infrastructure\.tfplan$' "$log" ||
          fail "infrastructure release-failure scenario did not hold the lease through apply"
        ;;
      adoption_image_update_failure | final_apply_failure)
        if grep -Fq 'az storage container lease release ' "$log"; then
          fail "infrastructure flow released the lease after uncertain mutation $scenario"
        fi
        grep -Fq \
          'The operation lease remains held for second-operator recovery.' \
          "$output" ||
          fail "infrastructure flow omitted the retained-lease warning after $scenario"
        ;;
      adoption_image_verification_failure | postapply_image_mismatch | \
        postapply_app_show_failure | postapply_never_ready | \
        postapply_multiple_active | final_pinned_drift)
        if grep -Fq 'az storage container lease release ' "$log"; then
          fail "infrastructure flow released the lease after readiness failure $scenario"
        fi
        grep -Fq \
          'Container App readiness failed; second-operator recovery is required.' \
          "$output" ||
          fail "infrastructure flow omitted the readiness recovery warning after $scenario"
        grep -Fq \
          'The operation lease remains held for second-operator recovery.' \
          "$output" ||
          fail "infrastructure flow readiness failure omitted the retained-lease warning after $scenario"
        ;;
    esac
    if test "$scenario" = "postapply_app_show_failure"; then
      test -f "$diagnostic_path_file" ||
        fail "readiness recovery lost the private Terraform diagnostic location"
      readiness_diagnostic_dir="$(cat "$diagnostic_path_file")"
      test -d "$readiness_diagnostic_dir" ||
        fail "readiness recovery removed private Terraform diagnostics"
      test -f "$readiness_diagnostic_dir/terraform.log" ||
        fail "readiness recovery did not preserve the Terraform log"
    fi
    case "$scenario" in
      adoption_foreign_container | adoption_recoverable_container | \
        adoption_duplicate_container | adoption_container_inventory_inconsistent | \
        adoption_foreign_binding)
        if grep -Eq '^az (storage container create|role assignment create) ' "$log"; then
          fail "safety adoption mutated operation storage after unsafe container inventory $scenario"
        fi
        if test "$scenario" = "adoption_foreign_binding" &&
          grep -Eq '^az storage container metadata update ' "$log"; then
          fail "safety adoption overwrote foreign operation-container metadata"
        fi
        ;;
      adoption_operation_principal_id_missing | adoption_operation_principal_id_invalid | \
        adoption_operation_principal_type_missing | adoption_operation_principal_type_invalid | \
        adoption_operation_principal_group)
        if grep -Eq '^az (storage container create|role assignment create) ' "$log"; then
          fail "safety adoption mutated operation storage after invalid private principal input $scenario"
        fi
        ;;
    esac
    case "$scenario" in
      adoption_*) ;;
      *)
        if grep -Eq '^az (storage container create|role assignment create) ' "$log"; then
          fail "normal infrastructure mode created operation storage or access after $scenario"
        fi
        ;;
    esac
    if grep -Fq "$TMP_DIR/infrastructure-diagnostics-$scenario" "$output"; then
      fail "infrastructure change exposed the private Terraform diagnostic path"
    fi
    if test "$scenario" = "plan_failure"; then
      test -f "$diagnostic_path_file" ||
        fail "failed infrastructure change lost its private diagnostic location"
      diagnostic_log="$(cat "$diagnostic_path_file")/terraform.log"
      test -f "$diagnostic_log" ||
        fail "failed infrastructure change did not preserve Terraform diagnostics"
      diagnostic_mode="$(
        file_mode "$diagnostic_log"
      )"
      test "$diagnostic_mode" = "600" ||
        fail "failed infrastructure diagnostic log is not mode 0600"
      grep -Fq 'private-infra-terraform-diagnostic plan -input=false' "$diagnostic_log" ||
        fail "failed infrastructure diagnostic log omitted provider diagnostics"
    fi
  done
}

run_stale_lease_recovery_block() {
  scenario="$1"
  scenario_root="$TMP_DIR/stale-lease-$scenario"
  log="$TMP_DIR/stale-lease-$scenario.log"
  output="$TMP_DIR/stale-lease-$scenario.out"
  rm -rf "$scenario_root"
  mkdir -p "$scenario_root"
  : > "$log"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    STATE_STORAGE_ACCOUNT="patchpagestate"
    STATE_CONTAINER="tfstate"
    STATE_KEY="patchpage-prod.tfstate"
    RESOURCE_GROUP="rg-patchpage-workload"
    CONTAINER_APP="patchpage-app"
    ACR="acrpatchpageabc123"
    EXPECTED_STORAGE_ACCOUNT_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/patchpagedrafts"
    EXPECTED_POSTGRES_SERVER_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-db"
    if test "$scenario" != "confirmation_missing"; then
      CONFIRM_STALE_OPERATION_LEASE="second-operator-confirmed-no-active-operation"
    fi

    az() {
      normalize_az_args "$@" || return 1
      printf 'az %s\n' "$NORMALIZED_AZ_ARGS" >> "$log"
      case "$1 $2" in
        "account set") ;;
        "account show") printf '%s\n' "$SUBSCRIPTION_ID" ;;
        "storage container-rm")
          test "$3" = "show" || return 1
          test "$NORMALIZED_AZ_ARGS" = \
            "storage container-rm show --ids /subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT/blobServices/default/containers/patchpage-operations --query id --output tsv" ||
            return 1
          test "$scenario" != "operation_container_lookup_failure" || return 1
          if test "$scenario" = "operation_container_identity_mismatch"; then
            printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT/blobServices/default/containers/foreign"
          else
            printf '%s\n' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT/blobServices/default/containers/patchpage-operations"
          fi
          ;;
        "storage container")
          case "$3" in
            exists)
              if test "$scenario" = "container_missing"; then
                printf '%s\n' "false"
              else
                printf '%s\n' "true"
              fi
              ;;
            metadata)
              test "$4" = "show" || return 1
              test "$scenario" != "binding_lookup_failure" || return 1
              if test "$scenario" = "foreign_binding"; then
                printf '%s\n' '{"patchpage_workload_binding_sha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}'
              else
                printf '{"patchpage_workload_binding_sha256":"%s"}\n' "$OPERATION_BINDING_SHA256"
              fi
              ;;
            lease)
              action="$4"
              case "$action" in
                break)
                  case " $* " in
                    *" --auth-mode login --lease-break-period 0 --output none "*) ;;
                    *) return 1 ;;
                  esac
                  test "$scenario" != "break_failure" || return 1
                  ;;
                acquire)
                  recovery_lease_id="$(
                    printf '%s\n' "$*" |
                      sed -n 's/.* --proposed-lease-id \([^ ]*\) --output none.*/\1/p'
                  )"
                  printf '%s\n' "$recovery_lease_id" |
                    grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ||
                    return 1
                  test "$scenario" != "acquire_failure" || return 1
                  printf '%s\n' "$recovery_lease_id" > "$scenario_root/recovery-lease-id"
                  ;;
                renew | release)
                  requested_lease_id="$(
                    printf '%s\n' "$*" |
                      sed -n 's/.* --lease-id \([^ ]*\) --output none.*/\1/p'
                  )"
                  test -f "$scenario_root/recovery-lease-id" || return 1
                  test "$requested_lease_id" = "$(cat "$scenario_root/recovery-lease-id")" || return 1
                  if test "$action" = "renew"; then
                    test "$scenario" != "renew_failure" || return 1
                  else
                    test "$scenario" != "release_failure" || return 1
                    rm -f "$scenario_root/recovery-lease-id"
                  fi
                  ;;
                *) return 1 ;;
              esac
              ;;
            *) return 1 ;;
          esac
          ;;
        "storage blob")
          test "$3" = "list" || return 1
          test "$scenario" != "container_nonempty" || printf '%s\n' "unexpected"
          ;;
        *) return 1 ;;
      esac
    }

    eval "$STALE_LEASE_RECOVERY_BLOCK"
    printf '%s\n' completed >> "$log"
  ) >"$output" 2>&1
}

test_stale_lease_recovery() {
  for scenario in \
    confirmation_missing \
    operation_container_lookup_failure \
    operation_container_identity_mismatch \
    binding_lookup_failure \
    foreign_binding \
    container_missing \
    container_nonempty \
    break_failure \
    acquire_failure \
    renew_failure \
    release_failure \
    success; do
    if run_stale_lease_recovery_block "$scenario"; then
      status=0
    else
      status=$?
    fi
    log="$TMP_DIR/stale-lease-$scenario.log"
    output="$TMP_DIR/stale-lease-$scenario.out"
    if test "$scenario" = "success"; then
      test "$status" -eq 0 || fail "stale operation lease recovery rejected success"
      test "$(cat "$output")" = "Operation lease recovery completed." ||
        fail "stale operation lease recovery emitted non-generic success"
      container_show_command='az storage container-rm show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/blobServices/default/containers/patchpage-operations --query id --output tsv'
      metadata_show_command='az storage container metadata show --account-name patchpagestate --name patchpage-operations --auth-mode login --output json'
      grep -Fqx "$container_show_command" "$log" ||
        fail "stale operation lease recovery did not prove the exact operation-container identity"
      grep -Fqx "$metadata_show_command" "$log" ||
        fail "stale operation lease recovery did not verify the workload binding"
      if grep -Fq 'az storage account show ' "$log"; then
        fail "stale operation lease recovery required parent state-account management read"
      fi
      grep -Fqx \
        'az storage container lease break --account-name patchpagestate --container-name patchpage-operations --auth-mode login --lease-break-period 0 --output none' \
        "$log" ||
        fail "stale operation lease recovery did not use the documented break command"
      container_show_line="$(grep -nF "$container_show_command" "$log" | sed -n '1s/:.*//p')"
      metadata_show_line="$(grep -nF "$metadata_show_command" "$log" | sed -n '1s/:.*//p')"
      break_line="$(grep -nF 'az storage container lease break ' "$log" | sed -n '1s/:.*//p')"
      if test -z "$container_show_line" || test -z "$metadata_show_line" ||
        test -z "$break_line" ||
        test "$container_show_line" -ge "$metadata_show_line" ||
        test "$metadata_show_line" -ge "$break_line"; then
        fail "stale operation lease recovery did not verify identity and binding before lease break"
      fi
      recovery_lease_id="$(sed -n 's/^az storage container lease acquire .* --proposed-lease-id \([^ ]*\) --output none$/\1/p' "$log")"
      test -n "$recovery_lease_id" || fail "stale operation lease recovery omitted its proof lease"
      grep -Fqx \
        "az storage container lease renew --account-name patchpagestate --container-name patchpage-operations --auth-mode login --lease-id $recovery_lease_id --output none" \
        "$log" || fail "stale recovery did not renew with its exact proof lease ID"
      grep -Fqx \
        "az storage container lease release --account-name patchpagestate --container-name patchpage-operations --auth-mode login --lease-id $recovery_lease_id --output none" \
        "$log" || fail "stale recovery did not release with its exact proof lease ID"
    else
      test "$status" -ne 0 || fail "stale operation lease recovery accepted $scenario"
      if grep -q '^completed$' "$log"; then
        fail "stale operation lease recovery continued after $scenario"
      fi
      if grep -Eq \
        '00000000-0000-0000-0000-000000000000|patchpagestate|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
        "$output"; then
        fail "stale operation lease recovery exposed a private identifier after $scenario"
      fi
      case "$scenario" in
        operation_container_lookup_failure | operation_container_identity_mismatch | \
          binding_lookup_failure | foreign_binding)
          if grep -Fq 'az storage container lease break ' "$log"; then
            fail "stale operation lease recovery broke a lease after $scenario"
          fi
          ;;
      esac
    fi
  done
  grep -Fq 'A second authorized operator must independently verify' "$README" ||
    fail "stale operation lease guidance omitted second-operator verification"
  grep -Fq 'An infinite lease survives `SIGKILL`' "$README" ||
    fail "stale operation lease guidance omitted uncatchable-kill behavior"
}

test_public_safe_runbook_static() {
  if grep -Eiq 'If[-]Match|e[t]ag|patchpageOperation[L]ock|private_az r[e]st' "$README"; then
    fail "Azure guide retains the unsupported Container App tag/conditional-REST mutex"
  fi
  if ! awk '
    $0 == "private_az() {" {
      getline
      wrappers++
      if ($0 != "  az \"$@\" --subscription \"$SUBSCRIPTION_ID\" 2>/dev/null") exit 1
    }
    END { if (wrappers == 0) exit 1 }
  ' "$README"; then
    fail "a private_az wrapper does not pin every command to the explicit subscription"
  fi
  if grep -Eq -- \
    'az account show[^|;]*(--query[ =]+['"'"'"]?(user|tenantId|environmentName)|--output json)' \
    "$README"; then
    fail "Azure guide queries caller details instead of only the active subscription ID"
  fi
  if grep -Eq -- \
    'terraform state pull[[:space:]]*>[[:space:]]*[^[:space:]"$]|terraform show[[:space:]]+"\$[^"]*PLAN"|terraform plan[[:space:]]+-out=[^[:space:]"$]' \
    "$README"; then
    fail "Azure guide writes raw Terraform state or plan output to a repository-visible path"
  fi
  printf '%s\n%s\n' "$APP_RELEASE_BLOCK" "$INFRASTRUCTURE_CHANGE_BLOCK" |
    grep -Eq '(^|[;&|][[:space:]]*)echo[[:space:]].*\$(IMAGE|.*_ID|RESOURCE_GROUP|STATE_)' &&
    fail "new runbook blocks directly echo a sensitive image or resource value"
  printf '%s\n' "$APP_RELEASE_BLOCK" |
    grep -Fq 'terraform ' &&
    fail "app release block contains a Terraform command"
  if grep -Eq \
    'Could not select Azure subscription %s|Expected subscription %s|Could not add hostname %s|Could not bind a managed certificate for %s|empty managed certificate ID for %s|No SNI binding for %s uses exact certificate ID %s' \
    "$README"; then
    fail "Azure guide retains a verbose hostname or certificate error that exposes private values"
  fi
  # Lifecycle prevent_destroy is a meta-argument and is invisible to plan-time
  # terraform test assertions. Statically require the expected blocks.
  #
  # Management-lock scope equality against child resource IDs also cannot be
  # evaluated under terraform test on the CI-pinned Terraform 1.9.8: plan leaves
  # those IDs unknown, mock_resource.override_during was only added after 1.9.8,
  # and apply-time mocks need full Azure ID shapes for every dependent resource.
  # Statically require each lock's scope to reference the child resource id.
  azure_tf_dir="$ROOT/infra/azure"
  for prevent_destroy_resource in \
    'azurerm_storage_account.drafts' \
    'azurerm_storage_container.drafts' \
    'azurerm_postgresql_flexible_server.patchpage' \
    'azurerm_postgresql_flexible_server_database.patchpage' \
    'azurerm_management_lock.drafts_storage' \
    'azurerm_management_lock.patchpage_postgres'; do
    resource_type="${prevent_destroy_resource%%.*}"
    resource_name="${prevent_destroy_resource#*.}"
    if ! awk -v rtype="$resource_type" -v rname="$resource_name" '
      $0 == ("resource \"" rtype "\" \"" rname "\" {") {
        in_resource = 1
        depth = 1
        next
      }
      in_resource {
        line = $0
        opens = gsub(/\{/, "{", line)
        line = $0
        closes = gsub(/\}/, "}", line)
        depth += opens - closes
        if ($0 ~ /^[[:space:]]*prevent_destroy[[:space:]]*=[[:space:]]*true[[:space:]]*$/) {
          found = 1
        }
        if (depth <= 0) {
          exit !found
        }
      }
      END {
        if (!in_resource || !found) exit 1
      }
    ' "$azure_tf_dir"/*.tf; then
      fail "persistent data resource $prevent_destroy_resource lacks prevent_destroy = true"
    fi
  done

  # lock_resource|expected_scope_expression
  for lock_scope_spec in \
    'azurerm_management_lock.drafts_storage|azurerm_storage_account.drafts.id' \
    'azurerm_management_lock.patchpage_postgres|azurerm_postgresql_flexible_server.patchpage.id'; do
    lock_resource="${lock_scope_spec%%|*}"
    expected_scope="${lock_scope_spec#*|}"
    resource_type="${lock_resource%%.*}"
    resource_name="${lock_resource#*.}"
    if ! awk -v rtype="$resource_type" -v rname="$resource_name" -v expected="$expected_scope" '
      $0 == ("resource \"" rtype "\" \"" rname "\" {") {
        in_resource = 1
        depth = 1
        next
      }
      in_resource {
        line = $0
        opens = gsub(/\{/, "{", line)
        line = $0
        closes = gsub(/\}/, "}", line)
        depth += opens - closes
        if (match($0, /^[[:space:]]*scope[[:space:]]*=[[:space:]]*/)) {
          rest = substr($0, RSTART + RLENGTH)
          gsub(/[[:space:]]+$/, "", rest)
          if (rest == expected) {
            found = 1
          }
        }
        if (depth <= 0) {
          exit !found
        }
      }
      END {
        if (!in_resource || !found) exit 1
      }
    ' "$azure_tf_dir"/*.tf; then
      fail "management lock $lock_resource is not scoped to $expected_scope"
    fi
  done
}

test_custom_domain_context() {
  context_output="$TMP_DIR/custom-domain-context.out"
  if ! (
    expected_subscription="00000000-0000-0000-0000-000000000000"

    terraform() {
      case "$*" in
        "output -raw subscription_id") printf '%s\n' "$expected_subscription" ;;
        "output -raw resource_group_name") printf '%s\n' "rg-test" ;;
        "output -raw container_app_name") printf '%s\n' "app-test" ;;
        "output -raw container_app_environment_name") printf '%s\n' "env-test" ;;
        "output -raw container_app_fqdn") printf '%s\n' "APP.AZURECONTAINERAPPS.IO." ;;
        "output -raw container_app_environment_static_ip") printf '%s\n' "203.0.113.10" ;;
        "output -raw custom_domain_verification_id") printf '%s\n' "verification-id" ;;
        "output -raw public_base_url") printf '%s\n' "https://DRAFTS.SELF-HOSTER.DEV" ;;
        "output -raw custom_domain_hostname") printf '%s\n' "DRAFTS.SELF-HOSTER.DEV." ;;
        *) return 1 ;;
      esac
    }

    az() {
      normalize_az_args "$@" || return 1
      case "$1 $2" in
        "account set") return 0 ;;
        "account show") printf '%s\n' "$expected_subscription" ;;
        *) return 1 ;;
      esac
    }

    eval "$CUSTOM_DOMAIN_CONTEXT_BLOCK"
    test "$CUSTOM_DOMAIN" = "drafts.self-hoster.dev"
    test "$CONTAINER_APP_FQDN" = "app.azurecontainerapps.io"
    test "$NORMALIZED_PUBLIC_BASE_URL" = "https://drafts.self-hoster.dev"
  ) >"$context_output" 2>&1; then
    fail "Terraform hostnames were not normalized before DNS and certificate checks"
  fi
  test "$(cat "$context_output")" = "Azure deployment context verified privately." ||
    fail "custom-domain context exposed deployment details instead of generic success"
}

run_custom_domain_output_guard_block() {
  scenario="$1"
  log="$TMP_DIR/custom-domain-output-$scenario.log"
  output="$TMP_DIR/custom-domain-output-$scenario.out"
  : > "$log"

  (
    expected_subscription="00000000-0000-0000-0000-000000000000"

    terraform() {
      output_name="$3"
      test "$scenario" != "failure_$output_name" || return 1
      test "$scenario" != "empty_$output_name" || return 0
      case "$output_name" in
        subscription_id) printf '%s\n' "$expected_subscription" ;;
        resource_group_name) printf '%s\n' "rg-test" ;;
        container_app_name) printf '%s\n' "app-test" ;;
        container_app_environment_name) printf '%s\n' "env-test" ;;
        container_app_fqdn) printf '%s\n' "app.azurecontainerapps.io" ;;
        container_app_environment_static_ip) printf '%s\n' "203.0.113.10" ;;
        custom_domain_verification_id) printf '%s\n' "verification-id" ;;
        public_base_url) printf '%s\n' "https://drafts.self-hoster.dev" ;;
        custom_domain_hostname) printf '%s\n' "drafts.self-hoster.dev" ;;
        *) return 1 ;;
      esac
    }

    az() {
      normalize_az_args "$@" || return 1
      printf 'az %s\n' "$NORMALIZED_AZ_ARGS" >> "$log"
      case "$1 $2" in
        "account set")
          test "$scenario" != "account_set_failure"
          ;;
        "account show")
          test "$scenario" != "account_show_failure" || return 1
          if test "$scenario" = "subscription_mismatch"; then
            printf '%s\n' "11111111-1111-1111-1111-111111111111"
          else
            printf '%s\n' "$expected_subscription"
          fi
          ;;
        *) return 1 ;;
      esac
    }

    set +e
    eval "$CUSTOM_DOMAIN_CONTEXT_BLOCK"
    printf '%s\n' completed >> "$log"
  ) >"$output" 2>&1
}

test_custom_domain_output_guards() {
  output_names="subscription_id
resource_group_name
container_app_name
container_app_environment_name
container_app_fqdn
container_app_environment_static_ip
custom_domain_verification_id
public_base_url
custom_domain_hostname"

  for output_name in $output_names; do
    for mode in failure empty; do
      scenario="${mode}_$output_name"
      if run_custom_domain_output_guard_block "$scenario"; then
        status=0
      else
        status=$?
      fi
      test "$status" -ne 0 || fail "custom-domain context masked $scenario"
      if grep -q '^az ' "$TMP_DIR/custom-domain-output-$scenario.log"; then
        fail "custom-domain context called Azure after $scenario"
      fi
      if grep -q '^completed$' "$TMP_DIR/custom-domain-output-$scenario.log"; then
        fail "custom-domain context continued after $scenario"
      fi
      if grep -Eq \
        '00000000-0000-0000-0000-000000000000|rg-test|app-test|env-test|203\.0\.113\.10|verification-id|drafts\.self-hoster\.dev' \
        "$TMP_DIR/custom-domain-output-$scenario.out"; then
        fail "custom-domain context exposed a private output after $scenario"
      fi
    done
  done
  for scenario in account_set_failure account_show_failure subscription_mismatch; do
    if run_custom_domain_output_guard_block "$scenario"; then
      fail "custom-domain context accepted $scenario"
    fi
    if grep -q '^completed$' "$TMP_DIR/custom-domain-output-$scenario.log"; then
      fail "custom-domain context continued after $scenario"
    fi
    if grep -Eq \
      '00000000-0000-0000-0000-000000000000|11111111-1111-1111-1111-111111111111|rg-test|app-test|env-test|203\.0\.113\.10|verification-id|drafts\.self-hoster\.dev' \
      "$TMP_DIR/custom-domain-output-$scenario.out"; then
      fail "custom-domain context exposed private deployment details after $scenario"
    fi
  done
}

run_ingress_verification_block() {
  scenario="$1"
  log="$TMP_DIR/ingress-$scenario.log"
  : > "$log"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    RESOURCE_GROUP="rg-test"
    CONTAINER_APP="app-test"

    az() {
      normalize_az_args "$@" || return 1
      printf '%s\n' "$NORMALIZED_AZ_ARGS" >> "$log"
      test "$scenario" != "command_failure" || return 1
      test "$NORMALIZED_AZ_ARGS" = \
        "containerapp ingress show --resource-group rg-test --name app-test --output json" ||
        return 1

      external="true"
      allow_insecure="false"
      target_port="3000"
      transport='"Auto"'
      traffic='[{"latestRevision":true,"weight":100}]'
      client_certificate_mode='"Ignore"'
      cors_policy="null"
      exposed_port="null"
      ip_security_restrictions="null"
      additional_port_mappings="null"
      sticky_sessions="null"
      case "$scenario" in
        malformed_json)
          printf '%s\n' '{not-json'
          return 0
          ;;
        external_drift) external="false" ;;
        insecure_drift) allow_insecure="true" ;;
        target_port_drift) target_port="8080" ;;
        transport_drift) transport='"http2"' ;;
        missing_transport) transport="null" ;;
        client_certificate_accept_drift) client_certificate_mode='"Accept"' ;;
        client_certificate_require_drift) client_certificate_mode='"Require"' ;;
        null_client_certificate) client_certificate_mode="null" ;;
        cors_drift) cors_policy='{"allowedOrigins":["https://other.example"]}' ;;
        exposed_port_drift) exposed_port="8443" ;;
        additional_port_drift)
          additional_port_mappings='[{"external":true,"targetPort":9000,"exposedPort":9000}]'
          ;;
        sticky_session_drift) sticky_sessions='{"affinity":"sticky"}' ;;
        ip_restriction_drift)
          ip_security_restrictions='[{"action":"Allow","ipAddressRange":"192.0.2.0/24","name":"unexpected"}]'
          ;;
        empty_traffic) traffic='[]' ;;
        multiple_traffic)
          traffic='[{"latestRevision":true,"weight":50},{"latestRevision":false,"weight":50}]'
          ;;
        empty_label_dynamic)
          traffic='[{"label":"","latestRevision":true,"revisionName":"","weight":100}]'
          ;;
        pinned_revision)
          traffic='[{"latestRevision":false,"revisionName":"app-test--old","weight":100}]'
          ;;
        label_drift)
          traffic='[{"label":"canary","latestRevision":true,"weight":100}]'
          ;;
        weight_drift) traffic='[{"latestRevision":true,"weight":90}]' ;;
      esac
      printf \
        '{"external":%s,"allowInsecure":%s,"targetPort":%s,"transport":%s,"clientCertificateMode":%s,"corsPolicy":%s,"exposedPort":%s,"additionalPortMappings":%s,"stickySessions":%s,"ipSecurityRestrictions":%s,"traffic":%s}\n' \
        "$external" "$allow_insecure" "$target_port" "$transport" \
        "$client_certificate_mode" "$cors_policy" "$exposed_port" \
        "$additional_port_mappings" "$sticky_sessions" \
        "$ip_security_restrictions" "$traffic"
    }

    eval "$INGRESS_VERIFICATION_BLOCK"
  ) >/dev/null 2>&1
}

test_ingress_verification() {
  run_ingress_verification_block success ||
    fail "documented ingress verification rejected the intended live ingress"
  grep -Fqx \
    'containerapp ingress show --resource-group rg-test --name app-test --output json' \
    "$TMP_DIR/ingress-success.log" ||
    fail "documented ingress verification did not read the live ingress"
  run_ingress_verification_block null_client_certificate ||
    fail "documented ingress verification rejected Azure's null client-certificate default"
  run_ingress_verification_block empty_label_dynamic ||
    fail "documented ingress verification rejected AzureRM's empty dynamic-route fields"

  for scenario in \
    command_failure \
    malformed_json \
    external_drift \
    insecure_drift \
    target_port_drift \
    transport_drift \
    missing_transport \
    client_certificate_accept_drift \
    client_certificate_require_drift \
    cors_drift \
    exposed_port_drift \
    additional_port_drift \
    sticky_session_drift \
    ip_restriction_drift \
    empty_traffic \
    multiple_traffic \
    pinned_revision \
    label_drift \
    weight_drift; do
    if run_ingress_verification_block "$scenario"; then
      fail "documented ingress verification accepted $scenario"
    fi
  done
}

test_hostname_mutation_guard() {
  expected_subscription="00000000-0000-0000-0000-000000000000"
  expected_certificate_id="/subscriptions/$expected_subscription/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env-test/managedCertificates/cert-one"

  for scenario in \
    set_failure \
    wrong_selection \
    hostname_add_failure \
    hostname_bind_failure \
    empty_certificate_id \
    success; do
    log="$TMP_DIR/hostname-$scenario.log"
    : > "$log"
    output="$TMP_DIR/hostname-$scenario.out"

    if (
      SUBSCRIPTION_ID="$expected_subscription"
      ACTIVE_SUBSCRIPTION_ID=""
      RESOURCE_GROUP="rg-test"
      CONTAINER_APP="app-test"
      CONTAINER_APP_ENVIRONMENT="env-test"
      CUSTOM_DOMAIN="drafts.self-hoster.dev"
      VALIDATION_METHOD="CNAME"

      az() {
        normalize_az_args "$@" || return 1
        printf '%s\n' "$NORMALIZED_AZ_ARGS" >> "$log"
        case "$1 $2" in
          "account set")
            test "$scenario" != "set_failure"
            ;;
          "account show")
            if test "$scenario" = "wrong_selection"; then
              printf '%s\n' "11111111-1111-1111-1111-111111111111"
            else
              printf '%s\n' "$expected_subscription"
            fi
            ;;
          "containerapp hostname")
            case "$3" in
              add)
                test "$scenario" != "hostname_add_failure"
                ;;
              bind)
                test "$scenario" != "hostname_bind_failure" || return 1
                test "$scenario" != "empty_certificate_id" || return 0
                printf '%s\n' "$expected_certificate_id"
                ;;
              *)
                return 1
                ;;
            esac
            ;;
          *)
            return 1
            ;;
        esac
      }

      eval "$HOSTNAME_MUTATION_BLOCK"
    ) >"$output" 2>&1; then
      status=0
    else
      status=$?
    fi

    case "$scenario" in
      success)
        test "$status" -eq 0 || fail "hostname mutations failed after valid subscription selection"
        test "$(grep -c '^containerapp hostname' "$log")" -eq 2 ||
          fail "valid subscription selection did not run both hostname mutations"
        grep -Fqx \
          "containerapp hostname bind --resource-group rg-test --name app-test --hostname drafts.self-hoster.dev --environment env-test --validation-method CNAME --query [?name=='drafts.self-hoster.dev'].certificateId | [0] --output tsv" \
          "$log" ||
          fail "hostname bind did not capture its exact certificate resource ID"
        ;;
      hostname_bind_failure|empty_certificate_id)
        test "$status" -ne 0 || fail "hostname mutations succeeded after $scenario"
        test "$(grep -c '^containerapp hostname' "$log")" -eq 2 ||
          fail "hostname bind guard did not run after a successful hostname add"
        ;;
      hostname_add_failure)
        test "$status" -ne 0 || fail "hostname mutations succeeded after $scenario"
        test "$(grep -c '^containerapp hostname' "$log")" -eq 1 ||
          fail "hostname bind ran after hostname add failed"
        ;;
      *)
        test "$status" -ne 0 || fail "hostname mutations succeeded after $scenario"
        if grep -q '^containerapp hostname' "$log"; then
          fail "hostname mutation ran after $scenario"
        fi
        ;;
    esac
    if grep -Eq \
      '00000000-0000-0000-0000-000000000000|11111111-1111-1111-1111-111111111111|drafts\.self-hoster\.dev|managedCertificates/cert-one' \
      "$output"; then
      fail "hostname mutation exposed a subscription, hostname, or certificate ID after $scenario"
    fi
  done
}

run_apex_block() {
  a_records="$1"
  aaaa_scenario="$2"

  (
    DNS_ZONE="drafts.self-hoster.dev"
    CUSTOM_DOMAIN="drafts.self-hoster.dev"
    CONTAINER_APP_STATIC_IP="203.0.113.10"
    DOMAIN_VERIFICATION_ID="verification-id"

    dig() {
      case "$1" in
        +short)
          case "$2" in
            A) printf '%s\n' "$a_records" ;;
            AAAA)
              case "$aaaa_scenario" in
                command_error) return 1 ;;
                noerror_answer) printf '%s\n' '2001:db8::10' ;;
                *) printf '%s' "" ;;
              esac
              ;;
            TXT) printf '%s\n' '"verification-id"' ;;
            *) return 1 ;;
          esac
          ;;
        +noall)
          test "$1 $2 $3 $4" = "+noall +comments +answer AAAA" || return 1
          case "$aaaa_scenario" in
            command_error) return 1 ;;
            missing_status)
              printf '%s\n' ';; ->>HEADER<<- opcode: QUERY, id: 12345'
              return 0
              ;;
            noerror_empty|noerror_answer) status="NOERROR" ;;
            servfail) status="SERVFAIL" ;;
            refused) status="REFUSED" ;;
            unknown_status) status="UNKNOWN" ;;
            *) return 1 ;;
          esac
          printf '%s\n' ";; ->>HEADER<<- opcode: QUERY, status: $status, id: 12345"
          if test "$aaaa_scenario" = "noerror_answer"; then
            printf '%s\n' 'drafts.self-hoster.dev. 300 IN AAAA 2001:db8::10'
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    eval "$APEX_DNS_BLOCK"
  ) >/dev/null 2>&1
}

test_apex_dns() {
  run_apex_block "203.0.113.10" noerror_empty ||
    fail "exact apex A record with a NOERROR-empty AAAA response was rejected"

  if run_apex_block "203.0.113.10
198.51.100.20" noerror_empty; then
    fail "apex DNS accepted an additional A record"
  fi

  if run_apex_block "203.0.113.10" noerror_answer; then
    fail "apex DNS accepted an AAAA record"
  fi

  for scenario in servfail refused missing_status unknown_status command_error; do
    if run_apex_block "203.0.113.10" "$scenario"; then
      fail "apex DNS accepted the AAAA $scenario response"
    fi
  done
}

run_caa_block() {
  scenario="$1"
  log="$TMP_DIR/caa-$scenario.log"
  : > "$log"

  (
    CUSTOM_DOMAIN="drafts.team.example.com"
    DNS_ZONE="example.com"

    dig() {
      for name do :; done
      record_type="$4"
      test "$1 $2 $3" = "+noall +comments +answer" || return 1
      case "$record_type" in CNAME|CAA) ;; *) return 1 ;; esac
      printf '%s %s\n' "$record_type" "$name" >> "$log"

      case "$scenario:$record_type:$name" in
        command_error:CAA:team.example.com | cname_command_error:CNAME:drafts.team.example.com)
          return 1
          ;;
        servfail:CAA:team.example.com | cname_servfail:CNAME:drafts.team.example.com)
          status="SERVFAIL"
          ;;
        refused:CAA:team.example.com)
          status="REFUSED"
          ;;
        missing_status:CAA:team.example.com | cname_missing_status:CNAME:drafts.team.example.com)
          printf '%s\n' ';; ->>HEADER<<- opcode: QUERY, id: 12345'
          return 0
          ;;
        *)
          status="NOERROR"
          ;;
      esac
      printf '%s\n' ";; ->>HEADER<<- opcode: QUERY, status: $status, id: 12345"

      case "$record_type:$scenario:$name" in
        CNAME:cname_success:drafts.team.example.com)
          printf '%s\n' \
            'DRAFTS.TEAM.EXAMPLE.COM. 300 IN CNAME CAA.Target.Example.NET.'
          ;;
        CNAME:cname_ambiguity:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. 300 IN CNAME first.example.net.' \
            'drafts.team.example.com. 300 IN CNAME second.example.net.'
          ;;
        CNAME:cname_loop:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. 300 IN CNAME Alias.Example.NET.'
          ;;
        CNAME:cname_loop:alias.example.net)
          printf '%s\n' \
            'ALIAS.EXAMPLE.NET. 300 IN CNAME DRAFTS.TEAM.EXAMPLE.COM.'
          ;;
        CNAME:cname_invalid_ttl:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. invalid IN CNAME alias.example.net.'
          ;;
        CNAME:cname_invalid_class:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. 300 CH CNAME alias.example.net.'
          ;;
        CNAME:cname_wrong_type:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. 300 IN A 192.0.2.10'
          ;;
        CNAME:cname_misaligned:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. IN CNAME alias.example.net.'
          ;;
        CNAME:cname_unexpected_owner:drafts.team.example.com)
          printf '%s\n' \
            'other.team.example.com. 300 IN CNAME alias.example.net.'
          ;;
        CAA:inherit_noerror:example.com)
          printf '%s\n' 'example.com. 300 IN CAA 0 IsSuE "DiGiCeRt.CoM"'
          ;;
        CAA:cname_success:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "digicert.com"'
          ;;
        CAA:deny_nearer:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "letsencrypt.org"'
          ;;
        CAA:deny_nearer:example.com)
          printf '%s\n' 'example.com. 300 IN CAA 0 issue "digicert.com"'
          ;;
        CAA:unrelated:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 iodef "mailto:security@example.com"'
          ;;
        CAA:denying:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 issue ";"'
          ;;
        CAA:constrained_digicert:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "digicert.com; accounturi=https://example.com/account/123"'
          ;;
        CAA:constrained_digicert_spaced:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "digicert.com ; accounturi=https://example.com/account/123"'
          ;;
        CAA:unknown_critical:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 IN CAA 0 issue "digicert.com"' \
            'team.example.com. 300 IN CAA 128 unknowncritical "x"'
          ;;
        CAA:malformed_flags:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 IN CAA 0 issue "digicert.com"' \
            'team.example.com. 300 IN CAA invalid issue "letsencrypt.org"'
          ;;
        CAA:malformed_fields:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 IN CAA 0 issue "digicert.com"' \
            'team.example.com. 300 IN CAA 0 issue'
          ;;
        CAA:malformed_value:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 IN CAA 0 issue "digicert.com"' \
            'team.example.com. 300 IN CAA 0 iodef mailto:security@example.com'
          ;;
        CAA:caa_invalid_ttl:team.example.com)
          printf '%s\n' \
            'team.example.com. invalid IN CAA 0 issue "digicert.com"'
          ;;
        CAA:caa_invalid_class:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 CH CAA 0 issue "digicert.com"'
          ;;
        CAA:caa_wrong_type:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 IN TXT "ignored"'
          ;;
        CAA:caa_misaligned:team.example.com)
          printf '%s\n' \
            'team.example.com. IN CAA 0 issue "digicert.com"'
          ;;
        CAA:caa_unexpected_owner:team.example.com)
          printf '%s\n' \
            'other.example.com. 300 IN CAA 0 issue "digicert.com"'
          ;;
      esac
    }

    eval "$CAA_POLICY_BLOCK"
  ) >/dev/null 2>&1
}

test_caa_policy() {
  run_caa_block inherit_noerror || fail "inherited DigiCert CAA policy was rejected"

  expected_queries="CNAME drafts.team.example.com
CAA drafts.team.example.com
CNAME team.example.com
CAA team.example.com
CNAME example.com
CAA example.com"
  if test "$(cat "$TMP_DIR/caa-inherit_noerror.log")" != "$expected_queries"; then
    fail "CAA lookup did not walk from the hostname to the effective parent"
  fi

  if run_caa_block deny_nearer; then
    fail "CAA lookup skipped a nearer policy that denies DigiCert"
  fi

  run_caa_block cname_success ||
    fail "normalized CNAME target was not followed before inherited CAA evaluation"
  expected_cname_queries="CNAME drafts.team.example.com
CNAME caa.target.example.net
CAA caa.target.example.net
CNAME team.example.com
CAA team.example.com"
  if test "$(cat "$TMP_DIR/caa-cname_success.log")" != "$expected_cname_queries"; then
    fail "CAA lookup did not follow the normalized CNAME before original-parent walking"
  fi

  for scenario in \
    cname_ambiguity \
    cname_loop \
    cname_wrong_type \
    cname_invalid_ttl \
    cname_invalid_class \
    cname_misaligned \
    cname_unexpected_owner; do
    if run_caa_block "$scenario"; then
      fail "CAA lookup accepted $scenario"
    fi
  done
  test "$(cat "$TMP_DIR/caa-cname_ambiguity.log")" = \
    "CNAME drafts.team.example.com" ||
    fail "CAA lookup continued after ambiguous CNAME targets"
  expected_loop_queries="CNAME drafts.team.example.com
CNAME alias.example.net"
  test "$(cat "$TMP_DIR/caa-cname_loop.log")" = "$expected_loop_queries" ||
    fail "CAA lookup continued after a normalized CNAME loop"

  for scenario in \
    unrelated \
    denying \
    constrained_digicert \
    constrained_digicert_spaced \
    unknown_critical \
    malformed_flags \
    malformed_fields \
    malformed_value \
    caa_invalid_ttl \
    caa_invalid_class \
    caa_wrong_type \
    caa_misaligned \
    caa_unexpected_owner; do
    if run_caa_block "$scenario"; then
      fail "CAA lookup accepted the $scenario policy"
    fi
  done

  for scenario in servfail refused missing_status command_error; do
    if run_caa_block "$scenario"; then
      fail "CAA lookup continued after DNS $scenario"
    fi
    expected_failure_queries="CNAME drafts.team.example.com
CAA drafts.team.example.com
CNAME team.example.com
CAA team.example.com"
    if test "$(cat "$TMP_DIR/caa-$scenario.log")" != "$expected_failure_queries"; then
      fail "CAA lookup walked to a parent after DNS $scenario"
    fi
  done

  for scenario in cname_servfail cname_missing_status cname_command_error; do
    if run_caa_block "$scenario"; then
      fail "CAA lookup continued after $scenario"
    fi
    test "$(cat "$TMP_DIR/caa-$scenario.log")" = \
      "CNAME drafts.team.example.com" ||
      fail "CAA lookup continued after $scenario"
  done
}

run_certificate_block() {
  subject="$1"
  certificate_id="$2"
  binding_id="$3"
  provisioning_state="$4"
  output="$TMP_DIR/certificate-binding.out"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    RESOURCE_GROUP="rg-test"
    CONTAINER_APP="app-test"
    CONTAINER_APP_ENVIRONMENT="env-test"
    CUSTOM_DOMAIN="drafts.self-hoster.dev"
    MANAGED_CERTIFICATE_ID="/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env-test/managedCertificates/cert-one"

    az() {
      normalize_az_args "$@" || return 1
      case "$*" in
        *"env certificate list"*)
          case " $* " in
            *" --managed-certificates-only --certificate $MANAGED_CERTIFICATE_ID --query [].[id,properties.subjectName,properties.provisioningState] --output tsv "*) ;;
            *) return 1 ;;
          esac
          printf '%s\t%s\t%s\n' "$certificate_id" "$subject" "$provisioning_state"
          ;;
        *"hostname list"*)
          printf 'Drafts.Self-Hoster.Dev.\tSniEnabled\t%s\n' "$binding_id"
          ;;
        *)
          return 1
          ;;
      esac
    }

    eval "$CERTIFICATE_BINDING_BLOCK"
  ) >"$output" 2>&1
  certificate_status=$?
  if grep -Eq \
    'drafts\.self-hoster\.dev|managedCertificates/cert-(one|two)|00000000-0000-0000-0000-000000000000' \
    "$output"; then
    return 1
  fi
  return "$certificate_status"
}

test_certificate_binding() {
  certificate_id="/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env-test/managedCertificates/cert-one"
  other_certificate_id="/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env-test/managedCertificates/cert-two"

  run_certificate_block \
    "CN=Drafts.Self-Hoster.Dev." \
    "$certificate_id" \
    "$certificate_id" \
    "Succeeded" ||
    fail "normalized CN certificate subject was not matched"

  if run_certificate_block \
    "CN=other.example.com" \
    "$certificate_id" \
    "$certificate_id" \
    "Succeeded"; then
    fail "certificate verification accepted a different subject"
  fi

  if run_certificate_block \
    "CN=Drafts.Self-Hoster.Dev." \
    "$other_certificate_id" \
    "$certificate_id" \
    "Succeeded"; then
    fail "certificate verification accepted a different managed-certificate resource ID"
  fi

  if run_certificate_block \
    "CN=Drafts.Self-Hoster.Dev." \
    "$certificate_id" \
    "$other_certificate_id" \
    "Succeeded"; then
    fail "certificate verification accepted a binding to a different certificate ID"
  fi

  if run_certificate_block \
    "CN=Drafts.Self-Hoster.Dev." \
    "$certificate_id" \
    "$certificate_id" \
    "Pending"; then
    fail "certificate verification accepted a certificate that had not succeeded"
  fi
}

run_deployed_smoke_block() {
  scenario="$1"
  output="$2"

  (
    if test "$scenario" = "uppercase_origin"; then
      PUBLIC_BASE_URL="https://Drafts.Self-Hoster.Dev"
    else
      PUBLIC_BASE_URL="https://drafts.self-hoster.dev"
    fi
    CUSTOM_DOMAIN="drafts.self-hoster.dev"
    smoke_repo="$TMP_DIR/deployed-smoke-$scenario-repo"
    rm -rf "$smoke_repo"
    mkdir -p "$smoke_repo"
    case "$scenario" in
      success | canary_record_chmod_failure)
        CANARY_RECORD="$TMP_DIR/deployed-smoke-$scenario.canary"
        printf '%s\n' "existing-canary-record" > "$CANARY_RECORD"
        command chmod 644 "$CANARY_RECORD"
        ;;
      canary_record_directory)
        CANARY_RECORD="$TMP_DIR/deployed-smoke-$scenario.canary"
        mkdir -p "$CANARY_RECORD"
        ;;
      canary_record_symlink)
        CANARY_RECORD="$TMP_DIR/deployed-smoke-$scenario.canary"
        printf '%s\n' "existing-canary-record" > "${CANARY_RECORD}.target"
        command ln -s "${CANARY_RECORD}.target" "$CANARY_RECORD"
        ;;
      canary_relative_path)
        CANARY_RECORD="canary.env"
        ;;
      canary_inside_repo)
        CANARY_RECORD="$smoke_repo/canary.env"
        ;;
      canary_traversal_repo)
        mkdir -p "$TMP_DIR/traversal-parent"
        CANARY_RECORD="$TMP_DIR/traversal-parent/../deployed-smoke-$scenario-repo/canary.env"
        ;;
      canary_symlink_parent)
        command ln -s "$smoke_repo" "$TMP_DIR/deployed-smoke-$scenario-link"
        CANARY_RECORD="$TMP_DIR/deployed-smoke-$scenario-link/canary.env"
        ;;
      *)
        unset CANARY_RECORD
        ;;
    esac
    smoke_tmp_dir="$TMP_DIR/deployed-smoke-$scenario-tmp"
    curl_argv_log="$TMP_DIR/deployed-smoke-$scenario-curl-argv.log"
    caller_trap_log="$TMP_DIR/deployed-smoke-$scenario-caller-trap.log"
    caller_trap_snapshot="$TMP_DIR/deployed-smoke-$scenario-caller-traps.txt"
    rm -rf "$smoke_tmp_dir"
    : > "$curl_argv_log"
    : > "$caller_trap_log"

    mktemp() {
      case "$*" in
        "-d")
          mkdir -p "$smoke_tmp_dir" || return 1
          printf '%s\n' "$smoke_tmp_dir"
          ;;
        "${CANARY_RECORD:-}.tmp.XXXXXX")
          command mktemp "$@"
          ;;
        *)
          return 1
          ;;
      esac
    }

    chmod() {
      if test "$scenario" = "canary_record_chmod_failure"; then
        case "$2" in
          "${CANARY_RECORD}.tmp."*) return 1 ;;
        esac
      fi
      command chmod "$@"
    }

    trap 'printf "%s\n" caller-exit >> "$caller_trap_log"' EXIT
    trap 'printf "%s\n" caller-hup >> "$caller_trap_log"' HUP
    trap 'printf "%s\n" caller-int >> "$caller_trap_log"' INT
    trap 'printf "%s\n" caller-term >> "$caller_trap_log"' TERM

    git() {
      test "$*" = "rev-parse --show-toplevel" || return 1
      printf '%s\n' "$smoke_repo"
    }
    terraform() {
      test "$*" = "output -raw bootstrap_api_token"
      test "$scenario" != "token_failure" || return 1
      test "$scenario" != "token_empty" || return 0
      printf '%s\n' "test-token"
    }

    curl() {
      output_file=""
      header_file=""
      authorization_header_file=""
      url=""
      url_count=0
      request=""
      content_type=""
      data=""
      body_source_count=0
      for curl_arg do
        printf '%s\n' "$curl_arg" >> "$curl_argv_log"
        case "$curl_arg" in
          *test-token*) return 1 ;;
        esac
      done
      while test "$#" -gt 0; do
        case "$1" in
          --output)
            test -z "$output_file" || return 1
            shift
            test "$#" -gt 0 || return 1
            output_file="$1"
            ;;
          --dump-header)
            test -z "$header_file" || return 1
            shift
            test "$#" -gt 0 || return 1
            header_file="$1"
            ;;
          --request)
            test -z "$request" || return 1
            shift
            test "$#" -gt 0 || return 1
            request="$1"
            ;;
          --header)
            shift
            test "$#" -gt 0 || return 1
            case "$1" in
              @*)
                test -z "$authorization_header_file" || return 1
                authorization_header_file="${1#@}"
                ;;
              "Authorization: "*) return 1 ;;
              "Content-Type: "*)
                test -z "$content_type" || return 1
                content_type="$1"
                ;;
              *) return 1 ;;
            esac
            ;;
          --data)
            body_source_count=$((body_source_count + 1))
            test "$body_source_count" -eq 1 || return 1
            shift
            test "$#" -gt 0 || return 1
            data="$1"
            ;;
          --write-out)
            shift
            test "$#" -gt 0 || return 1
            test "$1" = '%{http_code}' || return 1
            ;;
          --proto)
            shift
            test "$#" -gt 0 || return 1
            test "$1" = '=https' || return 1
            ;;
          --silent|--show-error|--tlsv1.2)
            ;;
          http://*|https://*)
            test "$url_count" -eq 0 || return 1
            url="$1"
            url_count=1
            ;;
          *)
            return 1
            ;;
        esac
        shift
      done
      test "$url_count" -eq 1 || return 1
      case "$url" in
        */api/uploads)
          test "$body_source_count" -eq 1 || return 1
          ;;
        *)
          test "$body_source_count" -eq 0 || return 1
          ;;
      esac

      case "$url" in
        http://drafts.self-hoster.dev/healthz)
          test "$scenario" != "http_command_failure" || return 1
          test -n "$header_file" || return 1
          case "$scenario" in
            redirect_missing)
              printf 'HTTP/1.1 301 Moved Permanently\r\n\r\n' > "$header_file"
              ;;
            redirect_ambiguous)
              printf \
                'HTTP/1.1 301 Moved Permanently\r\nLocation: https://drafts.self-hoster.dev/healthz\r\nLocation: https://other.example/healthz\r\n\r\n' \
                > "$header_file"
              ;;
            redirect_mismatch)
              printf \
                'HTTP/1.1 301 Moved Permanently\r\nLocation: https://drafts.self-hoster.dev/other\r\n\r\n' \
                > "$header_file"
              ;;
            *)
              printf \
                'HTTP/1.1 301 Moved Permanently\r\nLocation: https://drafts.self-hoster.dev/healthz\r\n\r\n' \
                > "$header_file"
              ;;
          esac
          case "$scenario" in
            http_status_mismatch) printf '%s' "200" ;;
            redirect_status_302) printf '%s' "302" ;;
            redirect_status_307) printf '%s' "307" ;;
            redirect_status_308) printf '%s' "308" ;;
            *) printf '%s' "301" ;;
          esac
          ;;
        https://drafts.self-hoster.dev/healthz)
          test "$scenario" != "health_command_failure" || return 1
          test -n "$output_file" || return 1
          if test "$scenario" = "health_body_mismatch"; then
            printf '%s' '{"ok":false}' > "$output_file"
          else
            printf '%s' '{"ok":true}' > "$output_file"
          fi
          if test "$scenario" = "health_status_mismatch"; then
            printf '%s' "503"
          else
            printf '%s' "200"
          fi
          ;;
        https://drafts.self-hoster.dev/api/uploads | https://Drafts.Self-Hoster.Dev/api/uploads)
          test "$scenario" != "upload_command_failure" || return 1
          test -n "$output_file" || return 1
          test "$request" = "POST" || return 1
          test -f "$authorization_header_file" || return 1
          test "$(LC_ALL=C ls -l "$authorization_header_file" | cut -c1-10)" = \
            "-rw-------" || return 1
          test "$(cat "$authorization_header_file")" = \
            "Authorization: Bearer test-token" || return 1
          test "$content_type" = "Content-Type: application/json" || return 1
          printf '%s\n' "$data" |
            jq -e --arg marker "$SMOKE_MARKER" '
              type == "object" and
              (keys == ["filename", "html"]) and
              .filename == "azure-smoke.html" and
              .html == (
                "<!doctype html><html><head><title>Azure smoke test</title></head><body><h1>" +
                $marker +
                "</h1></body></html>"
              )
            ' >/dev/null ||
            return 1
          case "$scenario" in
            upload_invalid_json)
              printf '%s' '{not-json' > "$output_file"
              ;;
            upload_ok_mismatch)
              printf '%s' \
                '{"ok":false,"draftId":"abc123def456","publicUrl":"https://drafts.self-hoster.dev/d/abc123def456"}' \
                > "$output_file"
              ;;
            upload_draft_id_mismatch)
              printf '%s' \
                '{"ok":true,"draftId":"bad/id","publicUrl":"https://drafts.self-hoster.dev/d/bad/id"}' \
                > "$output_file"
              ;;
            upload_url_mismatch)
              printf '%s' \
                '{"ok":true,"draftId":"abc123def456","publicUrl":"https://other.example/d/abc123def456"}' \
                > "$output_file"
              ;;
            *)
              printf \
                '{"ok":true,"draftId":"abc123def456","publicUrl":"%s/d/abc123def456"}' \
                "$PUBLIC_BASE_URL" > "$output_file"
              ;;
          esac
          if test "$scenario" = "upload_status_mismatch"; then
            printf '%s' "200"
          else
            printf '%s' "201"
          fi
          ;;
        https://drafts.self-hoster.dev/d/abc123def456 | https://Drafts.Self-Hoster.Dev/d/abc123def456)
          test "$scenario" != "fetch_command_failure" || return 1
          test -n "$output_file" || return 1
          case "$scenario" in
            fetch_body_mismatch)
              printf '%s' '<html><body>wrong draft</body></html>' > "$output_file"
              ;;
            fetch_stale_marker)
              printf '%s' \
                '<html><iframe srcdoc="&lt;h1&gt;PATCHPAGE_AZURE_SMOKE_STALE&lt;/h1&gt;"></iframe></html>' \
                > "$output_file"
              ;;
            *)
              printf \
                '<html><iframe srcdoc="&lt;h1&gt;%s&lt;/h1&gt;"></iframe></html>' \
                "$SMOKE_MARKER" > "$output_file"
              ;;
          esac
          if test "$scenario" = "fetch_status_mismatch"; then
            printf '%s' "404"
          else
            printf '%s' "200"
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    smoke_block="$DEPLOYED_SMOKE_BLOCK"
    case "$scenario" in
      upload_body_header_file_mutation)
        if ! smoke_block="$(
          printf '%s\n' "$DEPLOYED_SMOKE_BLOCK" |
            awk '
              $0 == "    --data \"$UPLOAD_PAYLOAD\" \\" {
                replacements++
                print "    --data-binary \"@$AUTH_HEADER_FILE\" \\"
                next
              }
              { print }
              END { if (replacements != 1) exit 1 }
            '
        )"; then
          return 1
        fi
        ;;
      upload_duplicate_body_mutation)
        if ! smoke_block="$(
          printf '%s\n' "$DEPLOYED_SMOKE_BLOCK" |
            awk '
              $0 == "    --data \"$UPLOAD_PAYLOAD\" \\" {
                replacements++
                print
              }
              { print }
              END { if (replacements != 1) exit 1 }
            '
        )"; then
          return 1
        fi
        ;;
    esac
    eval "$smoke_block"
    smoke_status=$?
    trap > "$caller_trap_snapshot"
    mkdir -p "$smoke_tmp_dir"
    : > "$smoke_tmp_dir/reused-after-smoke"
    exit "$smoke_status"
  ) >"$output" 2>&1
}

test_deployed_smoke() {
  success_output="$TMP_DIR/deployed-smoke-success.out"
  run_deployed_smoke_block success "$success_output" ||
    fail "successful deployed smoke was rejected"
  test "$(cat "$success_output")" = "Deployed smoke passed." ||
    fail "successful deployed smoke did not emit only generic success"
  canary_record="$TMP_DIR/deployed-smoke-success.canary"
  test -f "$canary_record" ||
    fail "successful deployed smoke did not write the requested private canary record"
  grep -Fqx 'CANARY_URL=https://drafts.self-hoster.dev/d/abc123def456' "$canary_record" ||
    fail "deployed smoke canary record omitted the verified draft URL"
  grep -Fqx 'CANARY_MARKER=PATCHPAGE_AZURE_SMOKE_deployed-smoke-success-tmp' "$canary_record" ||
    fail "deployed smoke canary record omitted the unique marker"
  canary_mode="$(file_mode "$canary_record")"
  test "$canary_mode" = "600" ||
    fail "deployed smoke canary record is not mode 0600"
  if grep -Fq 'test-token' "$TMP_DIR/deployed-smoke-success-curl-argv.log"; then
    fail "successful deployed smoke exposed the bootstrap token in raw curl argv"
  fi
  grep -Fqx \
    "@$TMP_DIR/deployed-smoke-success-tmp/upload.headers" \
    "$TMP_DIR/deployed-smoke-success-curl-argv.log" ||
    fail "successful deployed smoke did not pass the spaced header-file path intact"
  grep -Fqx 'caller-exit' "$TMP_DIR/deployed-smoke-success-caller-trap.log" ||
    fail "deployed smoke overwrote the caller EXIT trap"
  for caller_signal_trap in caller-hup caller-int caller-term; do
    grep -Fq "$caller_signal_trap" \
      "$TMP_DIR/deployed-smoke-success-caller-traps.txt" ||
      fail "deployed smoke overwrote $caller_signal_trap"
  done
  test -f "$TMP_DIR/deployed-smoke-success-tmp/reused-after-smoke" ||
    fail "a stale deployed-smoke trap removed a caller-reused path"
  test ! -e "$TMP_DIR/deployed-smoke-success-tmp/upload.headers" ||
    fail "successful deployed smoke did not remove its authorization header"

  uppercase_output="$TMP_DIR/deployed-smoke-uppercase-origin.out"
  run_deployed_smoke_block uppercase_origin "$uppercase_output" ||
    fail "uppercase configured upload origin broke normalized health verification"
  test "$(cat "$uppercase_output")" = "Deployed smoke passed." ||
    fail "uppercase configured upload origin did not retain generic success output"

  for scenario in \
    canary_relative_path \
    canary_inside_repo \
    canary_traversal_repo \
    canary_symlink_parent \
    canary_record_directory \
    canary_record_symlink \
    http_command_failure \
    http_status_mismatch \
    redirect_missing \
    redirect_ambiguous \
    redirect_mismatch \
    redirect_status_302 \
    redirect_status_307 \
    redirect_status_308 \
    health_command_failure \
    health_status_mismatch \
    health_body_mismatch \
    token_failure \
    token_empty \
    upload_command_failure \
    upload_body_header_file_mutation \
    upload_duplicate_body_mutation \
    upload_status_mismatch \
    upload_invalid_json \
    upload_ok_mismatch \
    upload_draft_id_mismatch \
    upload_url_mismatch \
    fetch_command_failure \
    fetch_status_mismatch \
    fetch_body_mismatch \
    canary_record_chmod_failure \
    fetch_stale_marker; do
    failure_output="$TMP_DIR/deployed-smoke-$scenario.out"
    if run_deployed_smoke_block "$scenario" "$failure_output"; then
      fail "deployed smoke accepted $scenario"
    fi
    if grep -Fqx 'Deployed smoke passed.' "$failure_output"; then
      fail "deployed smoke printed success after $scenario"
    fi
    test ! -e "$TMP_DIR/deployed-smoke-$scenario-tmp/upload.headers" ||
      fail "deployed smoke retained its authorization header after $scenario"
    case "$scenario" in
      canary_inside_repo | canary_traversal_repo | canary_symlink_parent)
        test ! -e "$TMP_DIR/deployed-smoke-$scenario-repo/canary.env" ||
          fail "deployed smoke wrote a canary record inside the repository after $scenario"
        ;;
    esac
  done
  failed_canary_record="$TMP_DIR/deployed-smoke-canary_record_chmod_failure.canary"
  grep -Fqx 'existing-canary-record' "$failed_canary_record" ||
    fail "failed canary replacement modified the existing record"
  failed_canary_mode="$(
    file_mode "$failed_canary_record"
  )"
  test "$failed_canary_mode" = "644" ||
    fail "failed canary replacement changed the existing record mode"
}

set -- \
  test_state_bootstrap \
  test_deploy_resources \
  test_app_release \
  test_app_rollback \
  test_infrastructure_change \
  test_stale_lease_recovery \
  test_public_safe_runbook_static \
  test_custom_domain_context \
  test_custom_domain_output_guards \
  test_ingress_verification \
  test_hostname_mutation_guard \
  test_apex_dns \
  test_caa_policy \
  test_certificate_binding \
  test_deployed_smoke

for guide_scenario_group in "$@"; do
  "$guide_scenario_group"
done

printf 'guide_commands_test: %s scenario groups passed\n' "$#"
