set -u
set +x
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
private_terraform() {
  terraform "$@" 2>&3
}
private_git() {
  git "$@" 2>/dev/null
}
if ! REPO_ROOT="$(private_git rev-parse --show-toplevel)" ||
  ! test -d "$REPO_ROOT/infra/azure" ||
  ! cd "$REPO_ROOT/infra/azure"; then
  printf 'Could not enter the repository Azure directory.\n' >&2
  exit 1
fi
: "${TERRAFORM_DIAGNOSTIC_ROOT:?Set an existing private diagnostic directory outside the repository}"
case "$TERRAFORM_DIAGNOSTIC_ROOT" in
  /*) ;;
  *)
    printf 'TERRAFORM_DIAGNOSTIC_ROOT must be an absolute private directory.\n' >&2
    exit 1
    ;;
esac
if ! REPO_ROOT_CANONICAL="$(
  CDPATH= cd -- "$REPO_ROOT" 2>/dev/null && pwd -P
)" ||
  ! TERRAFORM_DIAGNOSTIC_ROOT="$(
    CDPATH= cd -- "$TERRAFORM_DIAGNOSTIC_ROOT" 2>/dev/null && pwd -P
  )"; then
  printf 'Could not resolve the private Terraform diagnostic root.\n' >&2
  exit 1
fi
case "$TERRAFORM_DIAGNOSTIC_ROOT" in
  "$REPO_ROOT_CANONICAL" | "$REPO_ROOT_CANONICAL"/*)
    printf 'TERRAFORM_DIAGNOSTIC_ROOT must remain outside the repository.\n' >&2
    exit 1
    ;;
esac
if ! TERRAFORM_DIAGNOSTIC_DIR="$(
  umask 077
  mktemp -d "$TERRAFORM_DIAGNOSTIC_ROOT/patchpage-terraform-diagnostics.XXXXXX" 2>/dev/null
)"; then
  printf 'Could not create a private Terraform diagnostic directory.\n' >&2
  exit 1
fi
TERRAFORM_DIAGNOSTIC_LOG="$TERRAFORM_DIAGNOSTIC_DIR/terraform.log"
umask 077
if ! { exec 3>>"$TERRAFORM_DIAGNOSTIC_LOG"; } 2>/dev/null ||
  ! chmod 600 "$TERRAFORM_DIAGNOSTIC_LOG" 2>/dev/null; then
  { exec 3>&-; } 2>/dev/null || :
  rm -rf -- "$TERRAFORM_DIAGNOSTIC_DIR" 2>/dev/null || :
  printf 'Could not secure the private Terraform diagnostic log.\n' >&2
  exit 1
fi
TERRAFORM_DIAGNOSTICS_COMPLETE=false
TERRAFORM_DIAGNOSTIC_FD_OPEN=true
terraform_diagnostic_exit() {
  if test "$TERRAFORM_DIAGNOSTIC_FD_OPEN" = "true"; then
    { exec 3>&-; } 2>/dev/null || :
    TERRAFORM_DIAGNOSTIC_FD_OPEN=false
  fi
  if test "$TERRAFORM_DIAGNOSTICS_COMPLETE" = "true"; then
    if ! rm -rf -- "$TERRAFORM_DIAGNOSTIC_DIR" 2>/dev/null; then
      printf 'Terraform succeeded, but private diagnostic cleanup failed.\n' >&2
    fi
  else
    printf 'Private Terraform diagnostics were retained under the configured diagnostic root.\n' >&2
  fi
}
trap 'terraform_diagnostic_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
unset REPO_ROOT_CANONICAL
unset REPO_ROOT

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?Set the private expected subscription ID}"
STATE_STORAGE_ACCOUNT="${STATE_STORAGE_ACCOUNT:?Set the private state account name}"
STATE_CONTAINER="${STATE_CONTAINER:?Set the private state container name}"
STATE_KEY="${STATE_KEY:?Set the private environment-specific state key}"
EXPECTED_STATE_LINEAGE="${EXPECTED_STATE_LINEAGE:?Set the private expected state lineage}"
EXPECTED_RESOURCE_GROUP_ID="${EXPECTED_RESOURCE_GROUP_ID:?Set the private workload resource-group ID}"
EXPECTED_STORAGE_ACCOUNT_ID="${EXPECTED_STORAGE_ACCOUNT_ID:?Set the private workload Storage account ID}"
EXPECTED_POSTGRES_SERVER_ID="${EXPECTED_POSTGRES_SERVER_ID:?Set the private PostgreSQL server ID}"
EXPECTED_ACR_ID="${EXPECTED_ACR_ID:?Set the private Azure Container Registry ID}"
EXPECTED_CONTAINER_APP_ID="${EXPECTED_CONTAINER_APP_ID:?Set the private Container App ID}"
verify_pinned_revision_stable() {
  stable_gate_pinned_revision="$1"
  stable_gate_expected_image="$2"
  test -n "$stable_gate_pinned_revision" ||
    return 1
  printf '%s\n' "$stable_gate_expected_image" |
    grep -Eq '^.+@sha256:[0-9a-f]{64}$' ||
    return 1
  if ! stable_gate_app_json="$(
    private_az containerapp show \
      --ids "$EXPECTED_CONTAINER_APP_ID" \
      --output json
  )" ||
    ! stable_gate_revision_json="$(
      private_az containerapp revision show \
        --resource-group "$RESOURCE_GROUP" \
        --name "$CONTAINER_APP" \
        --revision "$stable_gate_pinned_revision" \
        --output json
    )" ||
    ! stable_gate_revision_list_json="$(
      private_az containerapp revision list \
        --resource-group "$RESOURCE_GROUP" \
        --name "$CONTAINER_APP" \
        --all \
        --output json
    )"; then
    return 1
  fi
  printf '%s\n' "$stable_gate_app_json" |
    jq -e \
      --arg pinned_revision "$stable_gate_pinned_revision" \
      --arg expected_image "$stable_gate_expected_image" \
      '.properties.configuration.activeRevisionsMode == "Single" and
       .properties.provisioningState == "Succeeded" and
       ($pinned_revision | length) > 0 and
       .properties.latestRevisionName == $pinned_revision and
       .properties.latestReadyRevisionName == $pinned_revision and
       (([.properties.template.containers[]? |
          select(.name == "server")]) as $servers |
        ($servers | length) == 1 and
        $servers[0].image == $expected_image) and
       (.properties.configuration.ingress.traffic as $traffic |
        ($traffic | type) == "array" and
        ($traffic | length) == 1 and
        (($traffic[0].revisionName // "") == "") and
        (($traffic[0].label // "") == "") and
        $traffic[0].latestRevision == true and
        $traffic[0].weight == 100)' >/dev/null &&
    printf '%s\n' "$stable_gate_revision_json" |
      jq -e \
        --arg pinned_revision "$stable_gate_pinned_revision" \
        --arg expected_image "$stable_gate_expected_image" \
        '.name == $pinned_revision and
         .properties.active == true and
         .properties.provisioningState == "Provisioned" and
         .properties.trafficWeight == 100 and
         (([.properties.template.containers[]? |
            select(.name == "server")]) as $servers |
          ($servers | length) == 1 and
          $servers[0].image == $expected_image)' >/dev/null &&
    printf '%s\n' "$stable_gate_revision_list_json" |
      jq -e \
        --arg pinned_revision "$stable_gate_pinned_revision" \
        '[.[]? | select(.properties.active == true) | .name] ==
         [$pinned_revision]' >/dev/null
}
poll_pinned_revision_stable() {
  stable_poll_pinned_revision="$1"
  stable_poll_expected_image="$2"
  stable_poll_attempt=1
  while test "$stable_poll_attempt" -le 120; do
    if ! verify_operation_lease; then
      return 1
    fi
    if verify_pinned_revision_stable \
      "$stable_poll_pinned_revision" \
      "$stable_poll_expected_image"; then
      return 0
    fi
    if test "$stable_poll_attempt" -eq 120; then
      return 1
    fi
    sleep 5
    stable_poll_attempt=$((stable_poll_attempt + 1))
  done
  return 1
}
container_app_readiness_recovery_required() {
  OPERATION_LEASE_ACTIVE=false
  printf 'Container App readiness failed; second-operator recovery is required.\n' >&2
  printf 'The operation lease remains held for second-operator recovery.\n' >&2
  exit 75
}
verify_operation_container() {
  if ! live_operation_container_id="$(
    private_az storage container-rm show \
      --ids "$EXPECTED_OPERATION_CONTAINER_ID" \
      --query id \
      --output tsv
  )" ||
    test "$(printf '%s' "$live_operation_container_id" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_OPERATION_CONTAINER_ID" | tr '[:upper:]' '[:lower:]')" ||
    ! operation_container_exists="$(
    private_az storage container exists \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --name "$OPERATION_CONTAINER" \
      --auth-mode key \
      --query exists \
      --output tsv
  )" || test "$operation_container_exists" != "true" ||
    ! operation_container_blobs="$(
      private_az storage blob list \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --container-name "$OPERATION_CONTAINER" \
        --auth-mode key \
        --include d v \
        --num-results '*' \
        --query '[].name' \
        --output tsv
    )" ||
    test -n "$operation_container_blobs" ||
    ! operation_container_metadata="$(
      private_az storage container metadata show \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --name "$OPERATION_CONTAINER" \
        --auth-mode key \
        --output json
    )"; then
    return 1
  fi
  printf '%s\n' "$operation_container_metadata" |
    jq -e \
      --arg binding "$OPERATION_BINDING_SHA256" \
      'type == "object" and
       length == 1 and
       .patchpage_workload_binding_sha256 == $binding' >/dev/null
}
inspect_state_containers() {
  if ! STATE_CONTAINER_EXISTS="$(
    private_az storage container exists \
      --name "$STATE_CONTAINER" \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --auth-mode key \
      --query exists \
      --output tsv
  )" ||
    ! OPERATION_CONTAINER_EXISTS="$(
      private_az storage container exists \
        --name "$OPERATION_CONTAINER" \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --auth-mode key \
        --query exists \
        --output tsv
    )" ||
    ! STATE_CONTAINER_NAMES="$(
      private_az storage container list \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --auth-mode key \
        --include-deleted true \
        --num-results '*' \
        --query '[].[name,deleted]' \
        --output tsv
    )"; then
    return 1
  fi
  case "$STATE_CONTAINER_EXISTS:$OPERATION_CONTAINER_EXISTS" in
    true:true | true:false | false:true | false:false) ;;
    *) return 1 ;;
  esac
  SEEN_STATE_CONTAINER=false
  SEEN_OPERATION_CONTAINER=false
  while IFS="$(printf '\t')" read -r state_container_name state_container_deleted; do
    if test -z "$state_container_name"; then
      test -z "$state_container_deleted" || return 1
      continue
    fi
    case "$state_container_deleted" in
      "" | false | None | null) ;;
      *) return 1 ;;
    esac
    case "$state_container_name" in
      "$STATE_CONTAINER")
        test "$SEEN_STATE_CONTAINER" = "false" || return 1
        SEEN_STATE_CONTAINER=true
        ;;
      "$OPERATION_CONTAINER")
        test "$SEEN_OPERATION_CONTAINER" = "false" || return 1
        SEEN_OPERATION_CONTAINER=true
        ;;
      *) return 1 ;;
    esac
  done <<EOF
$STATE_CONTAINER_NAMES
EOF
  test "$SEEN_STATE_CONTAINER" = "$STATE_CONTAINER_EXISTS" &&
    test "$SEEN_OPERATION_CONTAINER" = "$OPERATION_CONTAINER_EXISTS"
}
verify_operation_lease() {
  private_az storage container lease renew \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$OPERATION_CONTAINER" \
    --auth-mode key \
    --lease-id "$OPERATION_LEASE_ID" \
    --output none >/dev/null
}
acquire_operation_lease() {
  verify_operation_container || return 1
  private_az storage container lease acquire \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$OPERATION_CONTAINER" \
    --auth-mode key \
    --lease-duration -1 \
    --proposed-lease-id "$OPERATION_LEASE_ID" \
    --output none >/dev/null || return 1
  # Azure now holds the infinite lease, so the EXIT trap owes a release from this
  # point on. Set the flag before the renew-as-proof: a single renew blip must not
  # leave a held lease behind with the trap believing there is nothing to release.
  OPERATION_LEASE_ACTIVE=true
  verify_operation_lease || return 1
}
release_operation_lease() {
  verify_operation_lease || return 1
  private_az storage container lease release \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$OPERATION_CONTAINER" \
    --auth-mode key \
    --lease-id "$OPERATION_LEASE_ID" \
    --output none >/dev/null || return 1
  OPERATION_LEASE_ACTIVE=false
}
operation_lease_exit() {
  if test "${OPERATION_LEASE_ACTIVE:-false}" = "true"; then
    if test "${OPERATION_MUTATION_UNCERTAIN:-false}" = "true"; then
      OPERATION_LEASE_ACTIVE=false
      printf 'The operation lease remains held for second-operator recovery.\n' >&2
    elif ! release_operation_lease; then
      OPERATION_LEASE_RETAINED=true
      printf 'Operation lease cleanup requires second-operator review.\n' >&2
    fi
  fi
}
# Whether the lease outlived the process is not known at any exit site: a site
# that fails while holding it may still get it back from the trap's own release,
# and a site that never acquired it must not claim otherwise. Only the trap
# knows, so only the trap sets the exit status for that case. An exit inside an
# EXIT handler replaces the pending status; it also ends the handler list, so
# this is the last handler in the list and the change-directory and diagnostic
# cleanups before it still finish first.
operation_lease_retention_exit() {
  if test "${OPERATION_LEASE_RETAINED:-false}" = "true"; then
    exit 75
  fi
}
RESOURCE_GROUP="${RESOURCE_GROUP:?Set the expected workload resource-group name}"
if ! printf '%s\n' "$STATE_STORAGE_ACCOUNT" | grep -Eq '^[a-z0-9]{3,24}$' ||
  test "$STATE_CONTAINER" != "tfstate" ||
  ! printf '%s\n' "$STATE_KEY" |
    grep -Eq '^[a-z0-9][a-z0-9._-]{0,126}\.tfstate$'; then
  printf 'The private state-storage identity is invalid.\n' >&2
  exit 1
fi
OPERATION_CONTAINER="patchpage-operations"
EXPECTED_STATE_STORAGE_ACCOUNT_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT"
EXPECTED_OPERATION_CONTAINER_ID="$EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/$OPERATION_CONTAINER"
ACR="${EXPECTED_ACR_ID##*/}"
CONTAINER_APP="${EXPECTED_CONTAINER_APP_ID##*/}"
if ! OPERATION_BINDING_SHA256="$(
  printf '%s\n' \
    'patchpage-operation-binding-v1' \
    "subscription_id=$SUBSCRIPTION_ID" \
    "state_storage_account=$STATE_STORAGE_ACCOUNT" \
    "state_key=$STATE_KEY" \
    "resource_group=$RESOURCE_GROUP" \
    "container_app=$CONTAINER_APP" \
    "acr=$ACR" \
    "operation_container_id=$EXPECTED_OPERATION_CONTAINER_ID" \
    "container_app_id=$EXPECTED_CONTAINER_APP_ID" \
    "acr_id=$EXPECTED_ACR_ID" \
    "storage_account_id=$EXPECTED_STORAGE_ACCOUNT_ID" \
    "postgres_server_id=$EXPECTED_POSTGRES_SERVER_ID" |
    openssl dgst -sha256 -r 2>/dev/null |
    cut -d ' ' -f1
)" ||
  ! printf '%s\n' "$OPERATION_BINDING_SHA256" | grep -Eq '^[0-9a-f]{64}$'; then
  printf 'Could not compute the operation-container workload binding.\n' >&2
  exit 1
fi
ADOPT_SAFETY_GUARDS="${ADOPT_SAFETY_GUARDS:-false}"
case "$ADOPT_SAFETY_GUARDS" in
  true | false) ;;
  *)
    printf 'ADOPT_SAFETY_GUARDS must be true or false.\n' >&2
    exit 1
    ;;
esac
if test "$ADOPT_SAFETY_GUARDS" = "true"; then
  OPERATION_PRINCIPAL_ID="${OPERATION_PRINCIPAL_ID:?Set OPERATION_PRINCIPAL_ID to the private operation-principal object ID}"
  OPERATION_PRINCIPAL_TYPE="${OPERATION_PRINCIPAL_TYPE:?Set OPERATION_PRINCIPAL_TYPE to User or ServicePrincipal}"
  if ! printf '%s' "$OPERATION_PRINCIPAL_ID" |
    grep -Eiq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
    printf 'OPERATION_PRINCIPAL_ID must be a valid private object ID.\n' >&2
    exit 1
  fi
  case "$OPERATION_PRINCIPAL_TYPE" in
    User | ServicePrincipal) ;;
    *)
      printf 'OPERATION_PRINCIPAL_TYPE must be User or ServicePrincipal.\n' >&2
      exit 1
      ;;
  esac
fi

if ! private_az account set ||
  ! ACTIVE_SUBSCRIPTION_ID="$(private_az account show --query id --output tsv)" ||
  test "$ACTIVE_SUBSCRIPTION_ID" != "$SUBSCRIPTION_ID"; then
  printf 'The active Azure subscription does not match the private expected value.\n' >&2
  exit 1
fi
if ! LIVE_STATE_STORAGE_ACCOUNT_ID="$(
  private_az storage account show \
    --name "$STATE_STORAGE_ACCOUNT" \
    --resource-group rg-patchpage-tfstate \
    --query id \
    --output tsv
)" ||
  test "$(printf '%s' "$LIVE_STATE_STORAGE_ACCOUNT_ID" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" | tr '[:upper:]' '[:lower:]')"; then
  printf 'The state account is unavailable or does not match the private expected identity.\n' >&2
  exit 1
fi
if ! STATE_BLOB_EXISTS="$(
  private_az storage blob exists \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$STATE_CONTAINER" \
    --name "$STATE_KEY" \
    --auth-mode key \
    --query exists \
    --output tsv
)" ||
  test "$STATE_BLOB_EXISTS" != "true"; then
  printf 'The expected Terraform state blob does not exist.\n' >&2
  exit 1
fi
if ! inspect_state_containers || test "$STATE_CONTAINER_EXISTS" != "true"; then
  printf 'The Terraform state account data plane is unavailable or inconsistent.\n' >&2
  exit 1
fi
if test "$ADOPT_SAFETY_GUARDS" = "false" &&
  { test "$OPERATION_CONTAINER_EXISTS" != "true" ||
    ! verify_operation_container; }; then
  printf 'The operation-lease container is unavailable or invalid.\n' >&2
  exit 1
fi

if ! (umask 077 && : > backend.hcl) ||
  ! chmod 600 backend.hcl 2>/dev/null ||
  ! printf \
    'resource_group_name  = "rg-patchpage-tfstate"\nstorage_account_name = "%s"\ncontainer_name       = "%s"\nkey                  = "%s"\n' \
    "$STATE_STORAGE_ACCOUNT" \
    "$STATE_CONTAINER" \
    "$STATE_KEY" > backend.hcl; then
  printf 'Could not write the private Terraform backend configuration.\n' >&2
  exit 1
fi
if ! private_terraform init -input=false -reconfigure -backend-config=backend.hcl >&3; then
  printf 'Terraform initialization failed.\n' >&2
  exit 1
fi
if ! TERRAFORM_SUBSCRIPTION_LITERAL="$(
  private_terraform console -no-color <<'EOF'
var.subscription_id
EOF
)"; then
  printf 'Could not verify the Terraform provider subscription.\n' >&2
  exit 1
fi
if test "$TERRAFORM_SUBSCRIPTION_LITERAL" != "\"$SUBSCRIPTION_ID\""; then
  printf 'The Terraform provider subscription does not match the private expected value.\n' >&2
  exit 1
fi
unset TERRAFORM_SUBSCRIPTION_LITERAL
if ! TERRAFORM_RESOURCE_GROUP_LITERAL="$(
  private_terraform console -no-color <<'EOF'
"rg-patchpage-${var.environment_name}"
EOF
)"; then
  printf 'Could not verify the Terraform workload resource-group name.\n' >&2
  exit 1
fi
if ! TERRAFORM_RESOURCE_GROUP="$(
  printf '%s\n' "$TERRAFORM_RESOURCE_GROUP_LITERAL" |
    jq -er 'select(type == "string" and length > 0)'
)"; then
  printf 'Terraform returned an invalid workload resource-group name.\n' >&2
  exit 1
fi
unset TERRAFORM_RESOURCE_GROUP_LITERAL
if test "$TERRAFORM_RESOURCE_GROUP" != "$RESOURCE_GROUP"; then
  printf 'The Terraform workload resource-group name does not match the private expected value.\n' >&2
  exit 1
fi
unset TERRAFORM_RESOURCE_GROUP

if ! SECURE_CHANGE_DIR="$(umask 077; mktemp -d \
  "$TERRAFORM_DIAGNOSTIC_ROOT/patchpage-infrastructure-change.XXXXXX" 2>/dev/null)"; then
  printf 'Could not create a secure infrastructure-change directory.\n' >&2
  exit 1
fi
cleanup_infrastructure_change() {
  if test -n "${SECURE_CHANGE_DIR:-}" &&
    ! rm -rf -- "$SECURE_CHANGE_DIR" 2>/dev/null; then
    printf 'Private infrastructure-change cleanup failed.\n' >&2
    return 1
  fi
}
trap 'cleanup_infrastructure_change; terraform_diagnostic_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
STATE_SNAPSHOT="$SECURE_CHANGE_DIR/state.json"
STATE_VALUES="$SECURE_CHANGE_DIR/state-values.json"
INFRA_PLAN="$SECURE_CHANGE_DIR/infrastructure.tfplan"
INFRA_PLAN_JSON="$SECURE_CHANGE_DIR/infrastructure-plan.json"

if ! { private_terraform state pull > "$STATE_SNAPSHOT"; } 2>/dev/null ||
  ! { private_terraform show -json > "$STATE_VALUES"; } 2>/dev/null; then
  printf 'Could not read the selected Terraform state securely.\n' >&2
  exit 1
fi
if test "$(jq -r .lineage "$STATE_SNAPSHOT" 2>/dev/null)" != "$EXPECTED_STATE_LINEAGE"; then
  printf 'Terraform state lineage does not match the private expected value.\n' >&2
  exit 1
fi
for address in \
  azurerm_resource_group.patchpage \
  azurerm_container_registry.patchpage \
  azurerm_storage_account.drafts \
  azurerm_storage_container.drafts \
  azurerm_postgresql_flexible_server.patchpage \
  azurerm_postgresql_flexible_server_database.patchpage \
  azurerm_container_app.server
do
  if ! private_terraform state show "$address" >/dev/null; then
    printf 'Terraform state is missing a required managed resource.\n' >&2
    exit 1
  fi
done

STATE_RESOURCE_GROUP_ID="$(
  jq -r \
    '.values.root_module.resources[] |
     select(.address == "azurerm_resource_group.patchpage") |
     .values.id' \
    "$STATE_VALUES" 2>/dev/null |
    tr '[:upper:]' '[:lower:]'
)"
STATE_STORAGE_ACCOUNT_ID="$(
  jq -r \
    '.values.root_module.resources[] |
     select(.address == "azurerm_storage_account.drafts") |
     .values.id' \
    "$STATE_VALUES" 2>/dev/null |
    tr '[:upper:]' '[:lower:]'
)"
STATE_POSTGRES_SERVER_ID="$(
  jq -r \
    '.values.root_module.resources[] |
     select(.address == "azurerm_postgresql_flexible_server.patchpage") |
     .values.id' \
    "$STATE_VALUES" 2>/dev/null |
    tr '[:upper:]' '[:lower:]'
)"
STATE_ACR_ID="$(
  jq -r \
    '.values.root_module.resources[] |
     select(.address == "azurerm_container_registry.patchpage") |
     .values.id' \
    "$STATE_VALUES" 2>/dev/null |
    tr '[:upper:]' '[:lower:]'
)"
STATE_CONTAINER_APP_ID="$(
  jq -r \
    '.values.root_module.resources[] |
     select(.address == "azurerm_container_app.server") |
     .values.id' \
    "$STATE_VALUES" 2>/dev/null |
    tr '[:upper:]' '[:lower:]'
)"
if test "$STATE_RESOURCE_GROUP_ID" != "$(
    printf '%s' "$EXPECTED_RESOURCE_GROUP_ID" | tr '[:upper:]' '[:lower:]'
  )" ||
  test "$STATE_STORAGE_ACCOUNT_ID" != "$(
    printf '%s' "$EXPECTED_STORAGE_ACCOUNT_ID" | tr '[:upper:]' '[:lower:]'
  )" ||
  test "$STATE_POSTGRES_SERVER_ID" != "$(
    printf '%s' "$EXPECTED_POSTGRES_SERVER_ID" | tr '[:upper:]' '[:lower:]'
  )" ||
  test "$STATE_ACR_ID" != "$(
    printf '%s' "$EXPECTED_ACR_ID" | tr '[:upper:]' '[:lower:]'
  )" ||
  test "$STATE_CONTAINER_APP_ID" != "$(
    printf '%s' "$EXPECTED_CONTAINER_APP_ID" | tr '[:upper:]' '[:lower:]'
  )"; then
  printf 'Terraform state resource identity does not match the private expected values.\n' >&2
  exit 1
fi
if ! private_az resource show --ids "$EXPECTED_STORAGE_ACCOUNT_ID" --output none ||
  ! private_az resource show --ids "$EXPECTED_POSTGRES_SERVER_ID" --output none ||
  ! private_az resource show --ids "$EXPECTED_ACR_ID" --output none ||
  ! private_az resource show --ids "$EXPECTED_CONTAINER_APP_ID" --output none; then
  printf 'A resource recorded in Terraform state is missing from Azure.\n' >&2
  exit 1
fi
EXPECTED_STATE_LOCK_ID="$EXPECTED_STATE_STORAGE_ACCOUNT_ID/providers/Microsoft.Authorization/locks/protect-patchpage-tfstate"
EXPECTED_STORAGE_LOCK_ID="$EXPECTED_STORAGE_ACCOUNT_ID/providers/Microsoft.Authorization/locks/protect-patchpage-drafts"
EXPECTED_POSTGRES_LOCK_ID="$EXPECTED_POSTGRES_SERVER_ID/providers/Microsoft.Authorization/locks/protect-patchpage-postgres"
if ! STATE_EXISTING_LOCK_ROWS="$(
  private_az lock list \
    --resource "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" \
    --query '[].[name,level,id]' \
    --output tsv
)" ||
  ! STORAGE_EXISTING_LOCK_ROWS="$(
    private_az lock list \
      --resource "$EXPECTED_STORAGE_ACCOUNT_ID" \
      --query '[].[name,level,id]' \
      --output tsv
  )" ||
  ! POSTGRES_EXISTING_LOCK_ROWS="$(
    private_az lock list \
      --resource "$EXPECTED_POSTGRES_SERVER_ID" \
      --query '[].[name,level,id]' \
      --output tsv
  )"; then
  printf 'Could not inspect the exact deletion locks.\n' >&2
  exit 1
fi
validate_existing_lock_rows() {
  existing_lock_rows="$1"
  expected_lock_name="$2"
  expected_lock_id="$3"
  if test -z "$existing_lock_rows"; then
    test "$ADOPT_SAFETY_GUARDS" = "true"
    return
  fi
  test "$(printf '%s\n' "$existing_lock_rows" | wc -l | tr -d ' ')" = "1" &&
    test "$(printf '%s\n' "$existing_lock_rows" | cut -f1)" = "$expected_lock_name" &&
    test "$(printf '%s\n' "$existing_lock_rows" | cut -f2)" = "CanNotDelete" &&
    test "$(printf '%s\n' "$existing_lock_rows" | cut -f3 | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$expected_lock_id" | tr '[:upper:]' '[:lower:]')"
}
if ! validate_existing_lock_rows \
  "$STATE_EXISTING_LOCK_ROWS" \
  protect-patchpage-tfstate \
  "$EXPECTED_STATE_LOCK_ID" ||
  ! validate_existing_lock_rows \
    "$STORAGE_EXISTING_LOCK_ROWS" \
    protect-patchpage-drafts \
    "$EXPECTED_STORAGE_LOCK_ID" ||
  ! validate_existing_lock_rows \
    "$POSTGRES_EXISTING_LOCK_ROWS" \
    protect-patchpage-postgres \
    "$EXPECTED_POSTGRES_LOCK_ID";
then
  printf 'An existing deletion lock is missing, foreign, or incorrectly scoped.\n' >&2
  exit 1
fi
unset -f validate_existing_lock_rows
if test "$ADOPT_SAFETY_GUARDS" = "true"; then
  OPERATION_CONTAINER_WAS_PRESENT="$OPERATION_CONTAINER_EXISTS"
  if test "$OPERATION_CONTAINER_EXISTS" = "false" &&
    ! private_az storage container create \
      --name "$OPERATION_CONTAINER" \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --public-access off \
      --auth-mode key \
      --fail-on-exist \
      --metadata patchpage_workload_binding_sha256="$OPERATION_BINDING_SHA256" >/dev/null; then
    printf 'Could not create the private operation-lease container.\n' >&2
    exit 1
  fi
  if ! inspect_state_containers ||
    test "$STATE_CONTAINER_EXISTS" != "true" ||
    test "$OPERATION_CONTAINER_EXISTS" != "true"; then
    printf 'Could not verify the dedicated state-account containers.\n' >&2
    exit 1
  fi
  if ! OPERATION_CONTAINER_BLOBS="$(
    private_az storage blob list \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --container-name "$OPERATION_CONTAINER" \
      --auth-mode key \
      --include d v \
      --num-results '*' \
      --query '[].name' \
      --output tsv
  )" || test -n "$OPERATION_CONTAINER_BLOBS"; then
    printf 'The operation-lease container is unavailable or not empty.\n' >&2
    exit 1
  fi
  if ! OPERATION_CONTAINER_METADATA="$(
    private_az storage container metadata show \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --name "$OPERATION_CONTAINER" \
      --auth-mode key \
      --output json
  )"; then
    printf 'Could not inspect the operation-container workload binding.\n' >&2
    exit 1
  fi
  seal_operation_container_binding() {
    if ! OPERATION_BINDING_LEASE_HEX="$(
      od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
    )" ||
      ! printf '%s\n' "$OPERATION_BINDING_LEASE_HEX" |
        grep -Eq '^[0-9a-f]{32}$' ||
      ! OPERATION_BINDING_LEASE_ID="$(
        printf '%s\n' "$OPERATION_BINDING_LEASE_HEX" |
          sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/'
      )"; then
      return 1
    fi
    unset OPERATION_BINDING_LEASE_HEX
    if ! private_az storage container lease acquire \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --container-name "$OPERATION_CONTAINER" \
      --auth-mode key \
      --lease-duration 60 \
      --proposed-lease-id "$OPERATION_BINDING_LEASE_ID" \
      --output none >/dev/null; then
      return 1
    fi
    if ! OPERATION_CONTAINER_METADATA="$(
      private_az storage container metadata show \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --name "$OPERATION_CONTAINER" \
        --auth-mode key \
        --output json
    )" ||
      ! printf '%s\n' "$OPERATION_CONTAINER_METADATA" |
        jq -e 'type == "object" and length == 0' >/dev/null ||
      ! private_az storage container metadata update \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --name "$OPERATION_CONTAINER" \
        --auth-mode key \
        --lease-id "$OPERATION_BINDING_LEASE_ID" \
        --metadata patchpage_workload_binding_sha256="$OPERATION_BINDING_SHA256" \
        --output none >/dev/null ||
      ! OPERATION_CONTAINER_METADATA="$(
        private_az storage container metadata show \
          --account-name "$STATE_STORAGE_ACCOUNT" \
          --name "$OPERATION_CONTAINER" \
          --auth-mode key \
          --output json
      )" ||
      ! printf '%s\n' "$OPERATION_CONTAINER_METADATA" |
        jq -e \
          --arg binding "$OPERATION_BINDING_SHA256" \
          'type == "object" and
           length == 1 and
           .patchpage_workload_binding_sha256 == $binding' >/dev/null; then
      private_az storage container lease release \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --container-name "$OPERATION_CONTAINER" \
        --auth-mode key \
        --lease-id "$OPERATION_BINDING_LEASE_ID" \
        --output none >/dev/null || :
      return 1
    fi
    private_az storage container lease release \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --container-name "$OPERATION_CONTAINER" \
      --auth-mode key \
      --lease-id "$OPERATION_BINDING_LEASE_ID" \
      --output none >/dev/null
  }
  if printf '%s\n' "$OPERATION_CONTAINER_METADATA" |
    jq -e \
      --arg binding "$OPERATION_BINDING_SHA256" \
      'type == "object" and
       length == 1 and
       .patchpage_workload_binding_sha256 == $binding' >/dev/null; then
    :
  elif test "$OPERATION_CONTAINER_WAS_PRESENT" = "true" &&
    printf '%s\n' "$OPERATION_CONTAINER_METADATA" |
      jq -e 'type == "object" and length == 0' >/dev/null; then
    if ! seal_operation_container_binding; then
      printf 'Could not atomically seal the operation-container workload binding.\n' >&2
      exit 1
    fi
  else
    printf 'The operation container contains a foreign workload binding.\n' >&2
    exit 1
  fi
  if ! verify_operation_container; then
    printf 'The operation-container workload binding is invalid.\n' >&2
    exit 1
  fi
  unset OPERATION_BINDING_LEASE_ID
  unset -f seal_operation_container_binding

  OPERATION_CONTAINER_RESOURCE_ID="$EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/$OPERATION_CONTAINER"
  STATE_CONTAINER_RESOURCE_ID="$EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/$STATE_CONTAINER"
  STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID="/subscriptions/$SUBSCRIPTION_ID/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe"
  read_operation_role_assignments() {
    private_az role assignment list \
      --assignee-object-id "$OPERATION_PRINCIPAL_ID" \
      --role "$STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID" \
      --scope "$OPERATION_CONTAINER_RESOURCE_ID" \
      --include-inherited \
      --include-groups \
      --fill-principal-name false \
      --fill-role-definition-name false \
      --output json
  }
  read_state_role_assignments() {
    private_az role assignment list \
      --assignee-object-id "$OPERATION_PRINCIPAL_ID" \
      --scope "$STATE_CONTAINER_RESOURCE_ID" \
      --include-inherited \
      --include-groups \
      --fill-principal-name false \
      --fill-role-definition-name false \
      --output json
  }
  if ! OPERATION_ROLE_ASSIGNMENTS="$(read_operation_role_assignments)" ||
    ! OPERATION_ROLE_ASSIGNMENT_COUNT="$(
      printf '%s\n' "$OPERATION_ROLE_ASSIGNMENTS" | jq -er 'length'
    )" ||
    ! STATE_ROLE_ASSIGNMENTS="$(read_state_role_assignments)" ||
    ! printf '%s\n' "$STATE_ROLE_ASSIGNMENTS" |
      jq -e 'length == 0' >/dev/null; then
    printf 'Could not prove the operation principal has no Terraform state access.\n' >&2
    exit 1
  fi
  case "$OPERATION_ROLE_ASSIGNMENT_COUNT" in
    0)
      if ! private_az role assignment create \
        --assignee-object-id "$OPERATION_PRINCIPAL_ID" \
        --assignee-principal-type "$OPERATION_PRINCIPAL_TYPE" \
        --role "$STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID" \
        --scope "$OPERATION_CONTAINER_RESOURCE_ID" \
        --output none >/dev/null; then
        printf 'Could not grant operation-principal access.\n' >&2
        exit 1
      fi
      ;;
    1) ;;
    *)
      printf 'Operation-principal access is ambiguous.\n' >&2
      exit 1
      ;;
  esac
  if ! OPERATION_ROLE_ASSIGNMENTS="$(read_operation_role_assignments)" ||
    ! printf '%s\n' "$OPERATION_ROLE_ASSIGNMENTS" |
      jq -e \
        --arg principal_id "$(printf '%s' "$OPERATION_PRINCIPAL_ID" | tr '[:upper:]' '[:lower:]')" \
        --arg role_id "$(printf '%s' "$STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID" | tr '[:upper:]' '[:lower:]')" \
        --arg scope "$(printf '%s' "$OPERATION_CONTAINER_RESOURCE_ID" | tr '[:upper:]' '[:lower:]')" \
        'length == 1 and
         (.[0].principalId | ascii_downcase) == $principal_id and
         (.[0].roleDefinitionId | ascii_downcase) == $role_id and
         (.[0].scope | ascii_downcase) == $scope' >/dev/null ||
    ! STATE_ROLE_ASSIGNMENTS="$(read_state_role_assignments)" ||
    ! printf '%s\n' "$STATE_ROLE_ASSIGNMENTS" |
      jq -e 'length == 0' >/dev/null; then
    printf 'Operation-principal access is missing, incorrectly scoped, or can reach Terraform state.\n' >&2
    exit 1
  fi
fi
unset LIVE_STATE_STORAGE_ACCOUNT_ID OPERATION_CONTAINER_BLOBS
unset OPERATION_CONTAINER_METADATA OPERATION_CONTAINER_WAS_PRESENT
unset OPERATION_CONTAINER_EXISTS OPERATION_CONTAINER_RESOURCE_ID
unset OPERATION_PRINCIPAL_ID OPERATION_PRINCIPAL_TYPE
unset OPERATION_ROLE_ASSIGNMENT_COUNT OPERATION_ROLE_ASSIGNMENTS
unset SEEN_OPERATION_CONTAINER SEEN_STATE_CONTAINER STATE_CONTAINER_EXISTS
unset STATE_CONTAINER_NAMES STATE_CONTAINER_RESOURCE_ID STATE_ROLE_ASSIGNMENTS
unset STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID
unset -f inspect_state_containers read_operation_role_assignments
unset -f read_state_role_assignments
if ! OPERATION_LEASE_HEX="$(
  od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
)" ||
  ! printf '%s\n' "$OPERATION_LEASE_HEX" | grep -Eq '^[0-9a-f]{32}$' ||
  ! OPERATION_LEASE_ID="$(
    printf '%s\n' "$OPERATION_LEASE_HEX" |
      sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/'
  )" ||
  ! printf '%s\n' "$OPERATION_LEASE_ID" |
    grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  printf 'Could not create an operation lease owner.\n' >&2
  exit 1
fi
unset OPERATION_LEASE_HEX
OPERATION_LEASE_ACTIVE=false
OPERATION_LEASE_RETAINED=false
OPERATION_MUTATION_UNCERTAIN=false
trap 'operation_lease_exit; cleanup_infrastructure_change; terraform_diagnostic_exit; operation_lease_retention_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ! acquire_operation_lease; then
  printf 'The operation lease could not be established and verified; second-operator review may be required.\n' >&2
  exit 1
fi
WORKLOAD_STORAGE_ACCOUNT_NAME="${EXPECTED_STORAGE_ACCOUNT_ID##*/}"
if ! printf '%s\n' "$WORKLOAD_STORAGE_ACCOUNT_NAME" |
  grep -Eq '^[a-z0-9]{3,24}$' ||
  ! TERRAFORM_STORAGE_RETENTION_DAYS="$(
    private_terraform console -no-color <<'EOF'
var.storage_delete_retention_days
EOF
  )" ||
  ! printf '%s\n' "$TERRAFORM_STORAGE_RETENTION_DAYS" |
    grep -Eq '^[0-9]+$' ||
  ! WORKLOAD_BLOB_PROPERTIES="$(
    private_az storage account blob-service-properties show \
      --account-name "$WORKLOAD_STORAGE_ACCOUNT_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --output json
  )" ||
  ! LIVE_WORKLOAD_BLOB_RETENTION_DAYS="$(
    printf '%s\n' "$WORKLOAD_BLOB_PROPERTIES" |
      jq -er '.deleteRetentionPolicy.days // 0'
  )" ||
  ! LIVE_WORKLOAD_CONTAINER_RETENTION_DAYS="$(
    printf '%s\n' "$WORKLOAD_BLOB_PROPERTIES" |
      jq -er '.containerDeleteRetentionPolicy.days // 0'
  )"; then
  printf 'Could not compare Terraform and live workload Storage retention.\n' >&2
  exit 1
fi
if test "$TERRAFORM_STORAGE_RETENTION_DAYS" -lt "$LIVE_WORKLOAD_BLOB_RETENTION_DAYS" ||
  test "$TERRAFORM_STORAGE_RETENTION_DAYS" -lt "$LIVE_WORKLOAD_CONTAINER_RETENTION_DAYS"; then
  printf 'Terraform would shorten live workload Storage retention; raise the private configured value and restart.\n' >&2
  exit 1
fi
unset LIVE_WORKLOAD_BLOB_RETENTION_DAYS LIVE_WORKLOAD_CONTAINER_RETENTION_DAYS
unset TERRAFORM_STORAGE_RETENTION_DAYS WORKLOAD_BLOB_PROPERTIES
unset WORKLOAD_STORAGE_ACCOUNT_NAME
if test "$ADOPT_SAFETY_GUARDS" = "true"; then
  if ! ADOPTION_BLOB_PROPERTIES="$(
    private_az storage account blob-service-properties show \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --resource-group rg-patchpage-tfstate \
      --output json
  )" ||
    ! ADOPTION_BLOB_RETENTION_DAYS="$(
      printf '%s\n' "$ADOPTION_BLOB_PROPERTIES" |
        jq -er '[.deleteRetentionPolicy.days // 0, 30] | max'
    )" ||
    ! ADOPTION_CONTAINER_RETENTION_DAYS="$(
      printf '%s\n' "$ADOPTION_BLOB_PROPERTIES" |
        jq -er '[.containerDeleteRetentionPolicy.days // 0, 30] | max'
    )"; then
    printf 'Could not read the existing Terraform state retention settings.\n' >&2
    exit 1
  fi
  if ! private_az storage account blob-service-properties update \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --resource-group rg-patchpage-tfstate \
    --enable-versioning true \
    --enable-delete-retention true \
    --delete-retention-days "$ADOPTION_BLOB_RETENTION_DAYS" \
    --enable-container-delete-retention true \
    --container-delete-retention-days "$ADOPTION_CONTAINER_RETENTION_DAYS" \
    --set deleteRetentionPolicy.allowPermanentDelete=false >/dev/null; then
    printf 'Could not adopt Terraform state retention safeguards.\n' >&2
    exit 1
  fi
  if test -z "$STATE_EXISTING_LOCK_ROWS" &&
    ! private_az lock create \
      --name protect-patchpage-tfstate \
      --lock-type CanNotDelete \
      --resource "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" >/dev/null; then
    printf 'Could not adopt the Terraform state deletion lock.\n' >&2
    exit 1
  fi
  if test -z "$STORAGE_EXISTING_LOCK_ROWS" &&
    ! private_az lock create \
      --name protect-patchpage-drafts \
      --lock-type CanNotDelete \
      --notes "Protects persistent blob data from accidental deletion." \
      --resource "$EXPECTED_STORAGE_ACCOUNT_ID" >/dev/null; then
    printf 'Could not adopt the workload Storage-account deletion lock.\n' >&2
    exit 1
  fi
  if test -z "$POSTGRES_EXISTING_LOCK_ROWS" &&
    ! private_az lock create \
      --name protect-patchpage-postgres \
      --lock-type CanNotDelete \
      --notes "Protects persistent database data from accidental deletion." \
      --resource "$EXPECTED_POSTGRES_SERVER_ID" >/dev/null; then
    printf 'Could not adopt the PostgreSQL-server deletion lock.\n' >&2
    exit 1
  fi
  unset ADOPTION_BLOB_PROPERTIES ADOPTION_BLOB_RETENTION_DAYS
  unset ADOPTION_CONTAINER_RETENTION_DAYS
fi

if ! STATE_LOCK_PROPERTIES="$(
  private_az lock show \
    --ids "$EXPECTED_STATE_LOCK_ID" \
    --query '[level,id]' \
    --output tsv
)" ||
  test "$(printf '%s\n' "$STATE_LOCK_PROPERTIES" | cut -f1)" != "CanNotDelete" ||
  test "$(printf '%s\n' "$STATE_LOCK_PROPERTIES" | cut -f2 | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_STATE_LOCK_ID" | tr '[:upper:]' '[:lower:]')"; then
  printf 'The Terraform state-account deletion lock is missing or incorrectly scoped.\n' >&2
  exit 1
fi
if ! STATE_BLOB_PROPERTIES="$(
  private_az storage account blob-service-properties show \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --resource-group rg-patchpage-tfstate \
    --output json
)"; then
  printf 'Could not verify Terraform state versioning and soft-delete retention.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$STATE_BLOB_PROPERTIES" |
  jq -e \
    '.isVersioningEnabled == true and
     .deleteRetentionPolicy.enabled == true and
     (.deleteRetentionPolicy.allowPermanentDelete // false) == false and
     .deleteRetentionPolicy.days >= 30 and
     .containerDeleteRetentionPolicy.enabled == true and
     .containerDeleteRetentionPolicy.days >= 30' >/dev/null; then
  printf 'Terraform state versioning or soft-delete retention is below the required baseline.\n' >&2
  exit 1
fi
if ! STORAGE_LOCK_PROPERTIES="$(
  private_az lock show \
    --ids "$EXPECTED_STORAGE_LOCK_ID" \
    --query '[level,id]' \
    --output tsv
)" ||
  test "$(printf '%s\n' "$STORAGE_LOCK_PROPERTIES" | cut -f1)" != "CanNotDelete" ||
  test "$(printf '%s\n' "$STORAGE_LOCK_PROPERTIES" | cut -f2 | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_STORAGE_LOCK_ID" | tr '[:upper:]' '[:lower:]')" ||
  ! POSTGRES_LOCK_PROPERTIES="$(
    private_az lock show \
      --ids "$EXPECTED_POSTGRES_LOCK_ID" \
      --query '[level,id]' \
      --output tsv
  )" ||
  test "$(printf '%s\n' "$POSTGRES_LOCK_PROPERTIES" | cut -f1)" != "CanNotDelete" ||
  test "$(printf '%s\n' "$POSTGRES_LOCK_PROPERTIES" | cut -f2 | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_POSTGRES_LOCK_ID" | tr '[:upper:]' '[:lower:]')"; then
  printf 'An exact persistent-resource deletion lock is missing or incorrect.\n' >&2
  exit 1
fi
ensure_managed_lock_state() {
  managed_lock_address="$1"
  managed_lock_id="$2"
  if private_terraform state show "$managed_lock_address" >/dev/null; then
    return 0
  fi
  test "$ADOPT_SAFETY_GUARDS" = "true" &&
    private_terraform import -input=false \
      "$managed_lock_address" \
      "$managed_lock_id" >&3
}
if ! ensure_managed_lock_state \
  azurerm_management_lock.drafts_storage \
  "$EXPECTED_STORAGE_LOCK_ID" ||
  ! ensure_managed_lock_state \
    azurerm_management_lock.patchpage_postgres \
    "$EXPECTED_POSTGRES_LOCK_ID"; then
  printf 'The persistent-resource locks are not bound to this Terraform state.\n' >&2
  exit 1
fi
if ! { private_terraform show -json > "$STATE_VALUES"; } 2>/dev/null; then
  printf 'Could not verify the managed-lock state bindings.\n' >&2
  exit 1
fi
managed_lock_state_id() {
  jq -er \
    --arg address "$1" \
    '.values.root_module.resources[] |
     select(.address == $address) |
     .values.id |
     select(type == "string" and length > 0)' \
    "$STATE_VALUES" 2>/dev/null |
    tr '[:upper:]' '[:lower:]'
}
if ! STATE_STORAGE_LOCK_ID="$(
  managed_lock_state_id azurerm_management_lock.drafts_storage
)" ||
  ! STATE_POSTGRES_LOCK_ID="$(
    managed_lock_state_id azurerm_management_lock.patchpage_postgres
  )" ||
  test "$STATE_STORAGE_LOCK_ID" != "$(
    printf '%s' "$EXPECTED_STORAGE_LOCK_ID" | tr '[:upper:]' '[:lower:]'
  )" ||
  test "$STATE_POSTGRES_LOCK_ID" != "$(
    printf '%s' "$EXPECTED_POSTGRES_LOCK_ID" | tr '[:upper:]' '[:lower:]'
  )"; then
  printf 'A Terraform management-lock binding has an unexpected identity.\n' >&2
  exit 1
fi
unset STATE_POSTGRES_LOCK_ID STATE_STORAGE_LOCK_ID
unset -f ensure_managed_lock_state managed_lock_state_id
unset EXPECTED_POSTGRES_LOCK_ID EXPECTED_STATE_LOCK_ID EXPECTED_STORAGE_LOCK_ID
unset POSTGRES_EXISTING_LOCK_ROWS POSTGRES_LOCK_PROPERTIES
unset STATE_EXISTING_LOCK_ROWS STATE_LOCK_PROPERTIES
unset STORAGE_EXISTING_LOCK_ROWS STORAGE_LOCK_PROPERTIES
if test "$ADOPT_SAFETY_GUARDS" = "true"; then
  ADOPTION_ACR_NAME="${EXPECTED_ACR_ID##*/}"
  ADOPTION_CONTAINER_APP_NAME="${EXPECTED_CONTAINER_APP_ID##*/}"
  if ! printf '%s\n' "$ADOPTION_ACR_NAME" |
    grep -Eq '^[a-z0-9]{5,50}$' ||
    ! printf '%s\n' "$ADOPTION_CONTAINER_APP_NAME" |
      grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$' ||
    ! ADOPTION_LOGIN_SERVER="$(
      private_az acr show \
        --name "$ADOPTION_ACR_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --query loginServer \
        --output tsv
    )" ||
    test "$ADOPTION_LOGIN_SERVER" != "$ADOPTION_ACR_NAME.azurecr.io" ||
    ! verify_operation_lease ||
    ! ADOPTION_CONTAINER_APP_PROPERTIES="$(
      private_az containerapp show \
        --ids "$EXPECTED_CONTAINER_APP_ID" \
        --output json
    )" ||
    ! ADOPTION_PREUPDATE_REVISION="$(
      printf '%s\n' "$ADOPTION_CONTAINER_APP_PROPERTIES" |
        jq -er \
          '.properties.latestRevisionName |
           select(type == "string" and length > 0)'
    )" ||
    ! ADOPTION_CURRENT_IMAGE="$(
      printf '%s\n' "$ADOPTION_CONTAINER_APP_PROPERTIES" |
        jq -er \
          '[.properties.template.containers[]? | select(.name == "server")] |
           select(length == 1) |
           .[0].image |
           select(type == "string" and length > 0)'
    )"; then
    printf 'Could not verify the legacy release image in the expected deployment.\n' >&2
    exit 1
  fi
  ADOPTION_IMAGE_UPDATE_REQUIRED=false
  case "$ADOPTION_CURRENT_IMAGE" in
    "$ADOPTION_LOGIN_SERVER/patchpage-server@sha256:"*)
      ADOPTION_IMAGE_DIGEST="${ADOPTION_CURRENT_IMAGE##*@}"
      ;;
    "$ADOPTION_LOGIN_SERVER/patchpage-server:"*)
      ADOPTION_IMAGE_TAG="${ADOPTION_CURRENT_IMAGE#"$ADOPTION_LOGIN_SERVER/patchpage-server:"}"
      EXPECTED_LEGACY_IMAGE_DIGEST="${EXPECTED_LEGACY_IMAGE_DIGEST:?Set EXPECTED_LEGACY_IMAGE_DIGEST from a separately verified legacy release record}"
      if ! printf '%s\n' "$ADOPTION_IMAGE_TAG" |
        grep -Eq '^[0-9a-f]{7,40}$' ||
        ! printf '%s\n' "$EXPECTED_LEGACY_IMAGE_DIGEST" |
          grep -Eq '^sha256:[0-9a-f]{64}$' ||
        ! ADOPTION_IMAGE_DIGEST="$(
          private_az acr manifest show-metadata \
            --registry "$ADOPTION_ACR_NAME" \
            --name "patchpage-server:$ADOPTION_IMAGE_TAG" \
            --query digest \
            --output tsv
        )" ||
        test "$ADOPTION_IMAGE_DIGEST" != "$EXPECTED_LEGACY_IMAGE_DIGEST"; then
        printf 'The legacy release is not an expected resolvable commit image tag.\n' >&2
        exit 1
      fi
      ADOPTION_IMAGE_UPDATE_REQUIRED=true
      ;;
    *)
      printf 'The legacy release image is outside the expected registry repository.\n' >&2
      exit 1
      ;;
  esac
  if ! printf '%s\n' "$ADOPTION_IMAGE_DIGEST" |
    grep -Eq '^sha256:[0-9a-f]{64}$' ||
    ! ADOPTION_VERIFIED_DIGEST="$(
      private_az acr manifest show-metadata \
        --registry "$ADOPTION_ACR_NAME" \
        --name "patchpage-server@$ADOPTION_IMAGE_DIGEST" \
        --query digest \
        --output tsv
    )" ||
    test "$ADOPTION_VERIFIED_DIGEST" != "$ADOPTION_IMAGE_DIGEST"; then
    printf 'Could not verify the legacy release digest in the expected registry.\n' >&2
    exit 1
  fi
  ADOPTION_DIGEST_IMAGE="$ADOPTION_LOGIN_SERVER/patchpage-server@$ADOPTION_IMAGE_DIGEST"
  if test "$ADOPTION_IMAGE_UPDATE_REQUIRED" = "true"; then
    if ! verify_operation_lease ||
      ! ADOPTION_PREUPDATE_PROPERTIES="$(
        private_az containerapp show \
          --ids "$EXPECTED_CONTAINER_APP_ID" \
          --output json
      )" ||
      ! ADOPTION_LOCKED_REVISION="$(
        printf '%s\n' "$ADOPTION_PREUPDATE_PROPERTIES" |
          jq -er \
            '.properties.latestRevisionName |
             select(type == "string" and length > 0)'
      )" ||
      ! ADOPTION_LOCKED_IMAGE="$(
        printf '%s\n' "$ADOPTION_PREUPDATE_PROPERTIES" |
          jq -er \
            '[.properties.template.containers[]? |
              select(.name == "server")] |
             select(length == 1) |
             .[0].image |
             select(type == "string" and length > 0)'
      )" ||
      test "$ADOPTION_LOCKED_REVISION" != "$ADOPTION_PREUPDATE_REVISION" ||
      test "$ADOPTION_LOCKED_IMAGE" != "$ADOPTION_CURRENT_IMAGE"; then
      printf 'Could not migrate the legacy release to its verified immutable digest.\n' >&2
      exit 1
    fi
    OPERATION_MUTATION_UNCERTAIN=true
    if ! ADOPTION_UPDATED_REVISION="$(
      private_az containerapp update \
        --resource-group "$RESOURCE_GROUP" \
        --name "$ADOPTION_CONTAINER_APP_NAME" \
        --container-name server \
        --image "$ADOPTION_DIGEST_IMAGE" \
        --query properties.latestRevisionName \
        --output tsv
    )"; then
      printf 'Could not migrate the legacy release to its verified immutable digest.\n' >&2
      exit 75
    fi
    if test -z "$ADOPTION_UPDATED_REVISION" ||
      test "$ADOPTION_UPDATED_REVISION" = "$ADOPTION_PREUPDATE_REVISION"; then
      container_app_readiness_recovery_required
    fi
    if ! poll_pinned_revision_stable \
      "$ADOPTION_UPDATED_REVISION" \
      "$ADOPTION_DIGEST_IMAGE"; then
      container_app_readiness_recovery_required
    fi
    OPERATION_MUTATION_UNCERTAIN=false
  fi
  unset ADOPTION_ACR_NAME ADOPTION_CONTAINER_APP_NAME ADOPTION_CURRENT_IMAGE
  unset ADOPTION_CONTAINER_APP_PROPERTIES ADOPTION_DIGEST_IMAGE
  unset ADOPTION_IMAGE_DIGEST ADOPTION_PREUPDATE_PROPERTIES
  unset ADOPTION_LOCKED_IMAGE ADOPTION_LOCKED_REVISION
  unset ADOPTION_PREUPDATE_REVISION ADOPTION_UPDATED_REVISION
  unset ADOPTION_IMAGE_TAG ADOPTION_IMAGE_UPDATE_REQUIRED ADOPTION_LOGIN_SERVER
  unset ADOPTION_VERIFIED_DIGEST
fi

LOCKED_CONTAINER_APP_NAME="${EXPECTED_CONTAINER_APP_ID##*/}"
if ! verify_operation_lease ||
  ! LOCKED_CONTAINER_APP_PROPERTIES="$(
    private_az containerapp show \
      --ids "$EXPECTED_CONTAINER_APP_ID" \
      --output json
  )" ||
  ! LOCKED_CONTAINER_APP_REVISION="$(
    printf '%s\n' "$LOCKED_CONTAINER_APP_PROPERTIES" |
      jq -er \
        '.properties.latestRevisionName |
         select(type == "string" and length > 0)'
  )" ||
  ! LOCKED_CONTAINER_APP_IMAGE="$(
    printf '%s\n' "$LOCKED_CONTAINER_APP_PROPERTIES" |
      jq -er \
        '[.properties.template.containers[]? | select(.name == "server")] |
         select(length == 1) |
         .[0].image |
         select(type == "string" and length > 0)'
  )" ||
  ! verify_pinned_revision_stable \
    "$LOCKED_CONTAINER_APP_REVISION" \
    "$LOCKED_CONTAINER_APP_IMAGE"; then
  printf 'Could not pin a stable Container App revision before planning.\n' >&2
  exit 1
fi
SERVER_IMAGE_VARS="server-image.auto.tfvars"
SERVER_IMAGE_VARS_TEMP="$SECURE_CHANGE_DIR/server-image.auto.tfvars"
if test -L "$SERVER_IMAGE_VARS" ||
  { test -e "$SERVER_IMAGE_VARS" && ! test -f "$SERVER_IMAGE_VARS"; }; then
  printf 'The server image variable file must be absent or a regular file.\n' >&2
  exit 1
fi
if ! (umask 077 && printf 'server_image = "%s"\n' \
  "$LOCKED_CONTAINER_APP_IMAGE" > "$SERVER_IMAGE_VARS_TEMP") 2>/dev/null ||
  ! chmod 600 "$SERVER_IMAGE_VARS_TEMP" 2>/dev/null ||
  ! mv -f -- "$SERVER_IMAGE_VARS_TEMP" "$SERVER_IMAGE_VARS" 2>/dev/null; then
  rm -f -- "$SERVER_IMAGE_VARS_TEMP" 2>/dev/null || :
  printf 'Could not synchronize the private server image variable.\n' >&2
  exit 1
fi
if ! TERRAFORM_SERVER_IMAGE_LITERAL="$(
  private_terraform console -no-color <<'EOF'
var.server_image
EOF
)" ||
  test "$TERRAFORM_SERVER_IMAGE_LITERAL" != "\"$LOCKED_CONTAINER_APP_IMAGE\""; then
  printf 'Terraform did not resolve the synchronized immutable server image.\n' >&2
  exit 1
fi
unset SERVER_IMAGE_VARS SERVER_IMAGE_VARS_TEMP TERRAFORM_SERVER_IMAGE_LITERAL

if ! private_terraform plan -input=false -out="$INFRA_PLAN" >&3; then
  printf 'Terraform could not create the infrastructure plan.\n' >&2
  exit 1
fi
if ! { private_terraform show -json "$INFRA_PLAN" > "$INFRA_PLAN_JSON"; } 2>/dev/null; then
  printf 'Could not inspect the saved infrastructure plan.\n' >&2
  exit 1
fi
PLANNED_ACR_NAME="${EXPECTED_ACR_ID##*/}"
if ! printf '%s\n' "$PLANNED_ACR_NAME" | grep -Eq '^[a-z0-9]{5,50}$' ||
  ! PLANNED_CONTAINER_APP_IMAGE="$(
    jq -er \
      '.planned_values.root_module.resources[] |
       select(.address == "azurerm_container_app.server") |
       .values.template[0].container[0].image' \
      "$INFRA_PLAN_JSON" 2>/dev/null
  )"; then
  printf 'Could not read the planned Container App image safely.\n' >&2
  exit 1
fi
case "$PLANNED_CONTAINER_APP_IMAGE" in
  "$PLANNED_ACR_NAME.azurecr.io/patchpage-server@sha256:"*)
    PLANNED_CONTAINER_APP_DIGEST="${PLANNED_CONTAINER_APP_IMAGE##*@}"
    ;;
  *)
    printf 'The infrastructure plan does not retain an expected immutable Container App image.\n' >&2
    exit 1
    ;;
esac
if ! printf '%s\n' "$PLANNED_CONTAINER_APP_DIGEST" |
  grep -Eq '^sha256:[0-9a-f]{64}$' ||
  test "$PLANNED_CONTAINER_APP_IMAGE" != "$LOCKED_CONTAINER_APP_IMAGE"; then
  printf 'The infrastructure plan contains an invalid Container App image digest.\n' >&2
  exit 1
fi
unset PLANNED_ACR_NAME PLANNED_CONTAINER_APP_DIGEST
if ! jq -e \
  '[.resource_changes[] |
    . as $resource |
    select(
      ($resource.change.actions | index("delete")) or
      (
        (
          $resource.address == "azurerm_storage_account.drafts" or
          $resource.address == "azurerm_storage_container.drafts" or
          $resource.address == "azurerm_postgresql_flexible_server.patchpage" or
          $resource.address == "azurerm_postgresql_flexible_server_database.patchpage"
        ) and
        ($resource.change.actions | index("create"))
      )
    )] |
   length == 0' "$INFRA_PLAN_JSON" >/dev/null 2>&1; then
  printf 'The infrastructure plan deletes a resource or recreates protected persistent data.\n' >&2
  exit 1
fi
if ! INFRA_ACTION_SUMMARY="$(
  jq -r \
    '.resource_changes[] |
     select(.change.actions != ["no-op"]) |
     "\(.address): \(.change.actions | join(","))"' \
    "$INFRA_PLAN_JSON" 2>/dev/null
)"; then
  printf 'Could not render the infrastructure action summary.\n' >&2
  exit 1
fi
test -z "$INFRA_ACTION_SUMMARY" || printf '%s\n' "$INFRA_ACTION_SUMMARY"
set +x

# The second-operator plan review. It cannot be a prompt: this is one
# non-interactive command, and the operator who runs it is the one who must not
# be the one who approves it. It is a content address instead. The token below
# is the SHA-256 digest of exactly the action inventory just printed, so an
# approval names the actions it approves and nothing else.
#
# A rerun replans against current state and recomputes the token from the new
# inventory. If the actions changed in between, the recorded approval no longer
# matches and this fails closed asking for a fresh review -- which is stronger
# than the same-shell pause it replaces, because that pause could not tell that
# the world had moved under the saved plan.
#
# The token is printed and nothing else is. It is computed over Terraform
# resource addresses and action words, which carry no subscription, tenant or
# resource identifier, and a digest would not give them back if they did.
if ! INFRA_CHANGE_REVIEW_SHA256="$(
  printf '%s\n' "$INFRA_ACTION_SUMMARY" |
    openssl dgst -sha256 -r 2>/dev/null |
    cut -d ' ' -f1
)" ||
  ! printf '%s\n' "$INFRA_CHANGE_REVIEW_SHA256" | grep -Eq '^[0-9a-f]{64}$'; then
  printf 'Could not compute the second-operator review token.\n' >&2
  exit 1
fi
if test "${INFRA_CHANGE_APPROVAL_SHA256:-}" != "$INFRA_CHANGE_REVIEW_SHA256"; then
  if test -n "${INFRA_CHANGE_APPROVAL_SHA256:-}"; then
    printf 'The second-operator approval does not match this plan: the actions changed since that review, or the recorded token is not the one that review printed.\n' >&2
  fi
  printf 'Second operator: review the action inventory above against the private environment record and the backup/restore evidence, then rerun this command with INFRA_CHANGE_APPROVAL_SHA256 set to the token below.\n'
  printf 'INFRA_CHANGE_APPROVAL_SHA256=%s\n' "$INFRA_CHANGE_REVIEW_SHA256"
  if test -n "${INFRA_CHANGE_APPROVAL_SHA256:-}"; then
    exit 1
  fi
  # Nothing was applied and nothing is owed: this run planned and reported,
  # which is the whole of what an unapproved run is allowed to do, so it gives
  # the lease back and completes the same way a successful run does.
  if ! release_operation_lease; then
    printf 'Operation lease release failed; second-operator review is required.\n' >&2
    exit 1
  fi
  if ! cleanup_infrastructure_change; then
    exit 1
  fi
  SECURE_CHANGE_DIR=''
  TERRAFORM_DIAGNOSTICS_COMPLETE=true
  terraform_diagnostic_exit
  trap - 0 HUP INT TERM
  exit 0
fi
unset INFRA_ACTION_SUMMARY INFRA_CHANGE_REVIEW_SHA256
PREAPPLY_CONTAINER_APP_NAME="${EXPECTED_CONTAINER_APP_ID##*/}"
if ! verify_operation_lease ||
  ! verify_pinned_revision_stable \
    "$LOCKED_CONTAINER_APP_REVISION" \
    "$LOCKED_CONTAINER_APP_IMAGE" ||
  test "$LOCKED_CONTAINER_APP_IMAGE" != "$PLANNED_CONTAINER_APP_IMAGE"; then
  printf 'The stable Container App revision changed after planning; discard the plan and serialize the workflows.\n' >&2
  exit 1
fi
OPERATION_MUTATION_UNCERTAIN=true
if ! private_terraform apply -input=false "$INFRA_PLAN" >&3; then
  printf 'Terraform could not apply the reviewed infrastructure plan.\n' >&2
  exit 75
fi
if ! POSTAPPLY_CONTAINER_APP_PROPERTIES="$(
  private_az containerapp show \
    --ids "$EXPECTED_CONTAINER_APP_ID" \
    --output json
)" ||
  ! POSTAPPLY_CONTAINER_APP_REVISION="$(
    printf '%s\n' "$POSTAPPLY_CONTAINER_APP_PROPERTIES" |
      jq -er \
        '.properties.latestRevisionName |
         select(type == "string" and length > 0)'
  )"; then
  container_app_readiness_recovery_required
fi
if ! poll_pinned_revision_stable \
  "$POSTAPPLY_CONTAINER_APP_REVISION" \
  "$PLANNED_CONTAINER_APP_IMAGE"; then
  container_app_readiness_recovery_required
fi
if ! verify_pinned_revision_stable \
  "$POSTAPPLY_CONTAINER_APP_REVISION" \
  "$PLANNED_CONTAINER_APP_IMAGE"; then
  container_app_readiness_recovery_required
fi
OPERATION_MUTATION_UNCERTAIN=false
if ! release_operation_lease; then
  printf 'Operation lease release failed; second-operator review is required.\n' >&2
  exit 1
fi
if ! cleanup_infrastructure_change; then
  exit 1
fi
SECURE_CHANGE_DIR=''
TERRAFORM_DIAGNOSTICS_COMPLETE=true
terraform_diagnostic_exit
trap - 0 HUP INT TERM
unset TERRAFORM_DIAGNOSTIC_DIR TERRAFORM_DIAGNOSTIC_LOG
unset TERRAFORM_DIAGNOSTICS_COMPLETE TERRAFORM_DIAGNOSTIC_FD_OPEN
unset -f cleanup_infrastructure_change terraform_diagnostic_exit
unset -f acquire_operation_lease operation_lease_exit release_operation_lease
unset -f operation_lease_retention_exit
unset -f verify_operation_container verify_operation_lease
unset -f container_app_readiness_recovery_required
unset -f poll_pinned_revision_stable verify_pinned_revision_stable
