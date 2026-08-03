set -u
set +x
. "${PP_OPS_LIB:?run this through the dispatcher: sh infra/azure/ops.sh state-bootstrap}/wrappers.sh"
. "$PP_OPS_LIB/state_inspect.sh"
if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  ! test -d "$REPO_ROOT/infra/azure" ||
  ! cd "$REPO_ROOT/infra/azure"; then
  printf 'Could not enter the repository Azure directory.\n' >&2
  exit 1
fi
unset REPO_ROOT

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the target Azure subscription ID}"
if ! private_az account set; then
  printf 'Could not select the expected Azure subscription.\n' >&2
  exit 1
fi
if ! ACTIVE_SUBSCRIPTION_ID="$(private_az account show --query id --output tsv)"; then
  printf 'Could not verify the active Azure subscription.\n' >&2
  exit 1
fi
if test "$ACTIVE_SUBSCRIPTION_ID" != "$SUBSCRIPTION_ID"; then
  printf 'The active Azure subscription does not match the private expected value.\n' >&2
  exit 1
fi

STATE_RESOURCE_GROUP="rg-patchpage-tfstate"
STATE_LOCATION="centralus"
STATE_STORAGE_ACCOUNT="${STATE_STORAGE_ACCOUNT:?Set STATE_STORAGE_ACCOUNT to a globally unique lowercase name}"
STATE_CONTAINER="tfstate"
OPERATION_CONTAINER="patchpage-operations"
OPERATION_PRINCIPAL_ID="${OPERATION_PRINCIPAL_ID:?Set OPERATION_PRINCIPAL_ID to the private operation-principal object ID}"
OPERATION_PRINCIPAL_TYPE="${OPERATION_PRINCIPAL_TYPE:?Set OPERATION_PRINCIPAL_TYPE to User or ServicePrincipal}"
STATE_KEY="${STATE_KEY:?Set STATE_KEY to a unique environment-specific .tfstate object name}"
RESUME_STATE_BOOTSTRAP="${RESUME_STATE_BOOTSTRAP:-false}"
case "$RESUME_STATE_BOOTSTRAP" in
  true | false) ;;
  *)
    printf 'RESUME_STATE_BOOTSTRAP must be true or false.\n' >&2
    exit 1
    ;;
esac

if ! printf '%s' "$STATE_STORAGE_ACCOUNT" | grep -Eq '^[a-z0-9]{3,24}$'; then
  printf 'STATE_STORAGE_ACCOUNT must contain 3-24 lowercase letters and digits.\n' >&2
  exit 1
fi
if ! printf '%s' "$STATE_KEY" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,126}\.tfstate$'; then
  printf 'STATE_KEY must be a safe environment-specific name ending in .tfstate.\n' >&2
  exit 1
fi
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
if ! STATE_ACCOUNT_NAME_AVAILABLE="$(
  private_az storage account check-name \
    --name "$STATE_STORAGE_ACCOUNT" \
    --query nameAvailable \
    --output tsv
)" ||
  ! EXISTING_STATE_RESOURCE_GROUP="$(
    private_az group exists \
      --name "$STATE_RESOURCE_GROUP" \
      --output tsv
  )"; then
  printf 'Could not verify the OpenTofu state resource names.\n' >&2
  exit 1
fi
case "$STATE_ACCOUNT_NAME_AVAILABLE:$EXISTING_STATE_RESOURCE_GROUP" in
  true:true | true:false | false:true | false:false) ;;
  *)
    printf 'Azure returned an invalid OpenTofu state resource preflight result.\n' >&2
    exit 1
    ;;
esac
STATE_STORAGE_ACCOUNT_EXISTS=false
EXPECTED_STATE_STORAGE_ACCOUNT_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$STATE_RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT"
inventory_state_resource_group() {
  if ! STATE_RESOURCE_IDS="$(
    private_az resource list \
      --resource-group "$STATE_RESOURCE_GROUP" \
      --query '[].id' \
      --output tsv
  )"; then
    return 1
  fi
  STATE_STORAGE_ACCOUNT_EXISTS=false
  STATE_RESOURCE_COUNT=0
  while IFS= read -r state_resource_id; do
    test -z "$state_resource_id" && continue
    STATE_RESOURCE_COUNT=$((STATE_RESOURCE_COUNT + 1))
    if test "$(
        printf '%s' "$state_resource_id" | tr '[:upper:]' '[:lower:]'
      )" != "$(
        printf '%s' "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" | tr '[:upper:]' '[:lower:]'
      )"; then
      return 1
    fi
    STATE_STORAGE_ACCOUNT_EXISTS=true
  done <<EOF
$STATE_RESOURCE_IDS
EOF
}
if test "$RESUME_STATE_BOOTSTRAP" = "false"; then
  if test "$STATE_ACCOUNT_NAME_AVAILABLE" != "true" ||
    test "$EXISTING_STATE_RESOURCE_GROUP" != "false"; then
    printf 'State bootstrap requires an unused account name and absent state resource group.\n' >&2
    exit 1
  fi
else
  if test "$EXISTING_STATE_RESOURCE_GROUP" != "true"; then
    printf 'State-bootstrap resume requires the dedicated state resource group.\n' >&2
    exit 1
  fi
  if ! inventory_state_resource_group; then
    printf 'Could not inspect the resumed state resource group.\n' >&2
    exit 1
  fi
  if test "$STATE_STORAGE_ACCOUNT_EXISTS" = "true"; then
    if test "$STATE_ACCOUNT_NAME_AVAILABLE" != "false"; then
      printf 'The resumed state account identity is inconsistent with global name availability.\n' >&2
      exit 1
    fi
  elif test "$STATE_ACCOUNT_NAME_AVAILABLE" != "true"; then
    printf 'The requested state account name belongs outside the resumed resource group.\n' >&2
    exit 1
  fi
fi
if test "$EXISTING_STATE_RESOURCE_GROUP" = "false"; then
  if ! private_az group create \
    --name "$STATE_RESOURCE_GROUP" \
    --location "$STATE_LOCATION" >/dev/null; then
    printf 'Could not create the OpenTofu state resource group.\n' >&2
    exit 1
  fi
  if ! inventory_state_resource_group || test "$STATE_RESOURCE_COUNT" -ne 0; then
    printf 'The new OpenTofu state resource group is not empty.\n' >&2
    exit 1
  fi
fi
if ! STATE_RESOURCE_GROUP_LOCATION="$(
  private_az group show \
    --name "$STATE_RESOURCE_GROUP" \
    --query location \
    --output tsv
)"; then
  printf 'Could not verify the OpenTofu state resource group.\n' >&2
  exit 1
fi
if test "$STATE_RESOURCE_GROUP_LOCATION" != "$STATE_LOCATION"; then
  printf 'The OpenTofu state resource-group location does not match the private expected value.\n' >&2
  exit 1
fi
if test "$STATE_STORAGE_ACCOUNT_EXISTS" = "false"; then
  if ! private_az storage account create \
    --name "$STATE_STORAGE_ACCOUNT" \
    --resource-group "$STATE_RESOURCE_GROUP" \
    --location "$STATE_LOCATION" \
    --sku Standard_GRS \
    --kind StorageV2 \
    --min-tls-version TLS1_2 \
    --https-only true \
    --allow-blob-public-access false >/dev/null; then
    printf 'Could not create the OpenTofu state storage account.\n' >&2
    exit 1
  fi
fi
if ! STATE_STORAGE_ACCOUNT_PROPERTIES="$(
  private_az storage account show \
    --name "$STATE_STORAGE_ACCOUNT" \
    --resource-group "$STATE_RESOURCE_GROUP" \
    --output json
)"; then
  printf 'Could not verify the OpenTofu state storage account.\n' >&2
  exit 1
fi
EXPECTED_STATE_STORAGE_ACCOUNT_ID_LOWER="$(
  printf '%s' "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" | tr '[:upper:]' '[:lower:]'
)"
if ! printf '%s\n' "$STATE_STORAGE_ACCOUNT_PROPERTIES" |
  jq -e \
    --arg expected_id "$EXPECTED_STATE_STORAGE_ACCOUNT_ID_LOWER" \
    --arg location "$STATE_LOCATION" \
    '(.id | ascii_downcase) == $expected_id and
     .location == $location and
     .kind == "StorageV2" and
     .sku.name == "Standard_GRS" and
     .minimumTlsVersion == "TLS1_2" and
     .enableHttpsTrafficOnly == true and
     .allowBlobPublicAccess == false' >/dev/null; then
  printf 'The OpenTofu state storage account does not match the required identity or security properties.\n' >&2
  exit 1
fi
if ! inspect_state_containers; then
  printf 'Could not inspect the OpenTofu state account data plane.\n' >&2
  exit 1
fi
STATE_LOCK_NAME="protect-patchpage-tfstate"
EXPECTED_STATE_LOCK_ID="$EXPECTED_STATE_STORAGE_ACCOUNT_ID/providers/Microsoft.Authorization/locks/$STATE_LOCK_NAME"
if ! STATE_EXISTING_LOCKS="$(
  private_az lock list \
    --resource "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" \
    --query "[?name=='$STATE_LOCK_NAME'].[level,id]" \
    --output tsv
)"; then
  printf 'Could not inspect the existing OpenTofu state deletion lock.\n' >&2
  exit 1
fi
case "$STATE_EXISTING_LOCKS" in
  "") ;;
  *)
    if test "$(printf '%s\n' "$STATE_EXISTING_LOCKS" | wc -l | tr -d ' ')" != "1" ||
      test "$(printf '%s\n' "$STATE_EXISTING_LOCKS" | cut -f1)" != "CanNotDelete" ||
      test "$(printf '%s\n' "$STATE_EXISTING_LOCKS" | cut -f2 | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_STATE_LOCK_ID" | tr '[:upper:]' '[:lower:]')"; then
      printf 'A conflicting OpenTofu state lock requires explicit operator handling.\n' >&2
      exit 1
    fi
    ;;
esac
verify_unused_state_key() {
  if ! STATE_KEY_MATCHES="$(
    private_az storage blob list \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --container-name "$STATE_CONTAINER" \
      --auth-mode key \
      --prefix "$STATE_KEY" \
      --include d v \
      --num-results '*' \
      --query "[?name=='$STATE_KEY'].name" \
      --output tsv
  )"; then
    return 1
  fi
  test -z "$STATE_KEY_MATCHES"
}
if test "$STATE_CONTAINER_EXISTS" = "true" &&
  ! verify_unused_state_key; then
  printf 'The OpenTofu state key exists or has recoverable history; use the existing-environment flow.\n' >&2
  exit 1
fi
if ! CURRENT_STATE_BLOB_PROPERTIES="$(
  private_az storage account blob-service-properties show \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --resource-group "$STATE_RESOURCE_GROUP" \
    --output json
)" ||
  ! STATE_BLOB_RETENTION_DAYS="$(
    printf '%s\n' "$CURRENT_STATE_BLOB_PROPERTIES" |
      jq -er '[.deleteRetentionPolicy.days // 0, 30] | max'
  )" ||
  ! STATE_CONTAINER_RETENTION_DAYS="$(
    printf '%s\n' "$CURRENT_STATE_BLOB_PROPERTIES" |
      jq -er '[.containerDeleteRetentionPolicy.days // 0, 30] | max'
  )"; then
  printf 'Could not read the existing OpenTofu state retention settings.\n' >&2
  exit 1
fi
if ! private_az storage account blob-service-properties update \
  --account-name "$STATE_STORAGE_ACCOUNT" \
  --resource-group "$STATE_RESOURCE_GROUP" \
  --enable-versioning true \
  --enable-delete-retention true \
  --delete-retention-days "$STATE_BLOB_RETENTION_DAYS" \
  --enable-container-delete-retention true \
  --container-delete-retention-days "$STATE_CONTAINER_RETENTION_DAYS" \
  --set deleteRetentionPolicy.allowPermanentDelete=false >/dev/null; then
  printf 'Could not configure OpenTofu state versioning and soft-delete retention.\n' >&2
  exit 1
fi
if ! STATE_BLOB_PROPERTIES="$(
  private_az storage account blob-service-properties show \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --resource-group "$STATE_RESOURCE_GROUP" \
    --output json
)"; then
  printf 'Could not verify OpenTofu state versioning and soft-delete retention.\n' >&2
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
  printf 'OpenTofu state versioning or soft-delete retention is below the required baseline.\n' >&2
  exit 1
fi
if test "$STATE_CONTAINER_EXISTS" = "false"; then
  if ! private_az storage container create \
    --name "$STATE_CONTAINER" \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --auth-mode key >/dev/null; then
    printf 'Could not create the OpenTofu state container.\n' >&2
    exit 1
  fi
fi
if test "$OPERATION_CONTAINER_EXISTS" = "false"; then
  if ! private_az storage container create \
    --name "$OPERATION_CONTAINER" \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --auth-mode key >/dev/null; then
    printf 'Could not create the operation-lease container.\n' >&2
    exit 1
  fi
fi
if ! inspect_state_containers; then
  printf 'Could not verify the dedicated state containers.\n' >&2
  exit 1
fi
if test "$STATE_CONTAINER_EXISTS" != "true" ||
  test "$OPERATION_CONTAINER_EXISTS" != "true"; then
  printf 'A dedicated state container is missing.\n' >&2
  exit 1
fi
if ! OPERATION_CONTAINER_METADATA="$(
  private_az storage container metadata show \
    --name "$OPERATION_CONTAINER" \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --auth-mode key \
    --output json
)" ||
  ! printf '%s\n' "$OPERATION_CONTAINER_METADATA" |
    jq -e 'type == "object" and length == 0' >/dev/null; then
  printf 'The operation-lease container contains foreign metadata.\n' >&2
  exit 1
fi
if ! verify_unused_state_key; then
  printf 'The OpenTofu state key exists, has recoverable history, or could not be verified; use the existing-environment flow.\n' >&2
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
  printf 'The operation-lease container is not empty.\n' >&2
  exit 1
fi

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
  printf 'Could not prove the operation principal has no OpenTofu state access.\n' >&2
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
  printf 'Operation-principal access is missing, incorrectly scoped, or can reach OpenTofu state.\n' >&2
  exit 1
fi

if ! STATE_EXISTING_LOCKS="$(
  private_az lock list \
    --resource "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" \
    --query "[?name=='$STATE_LOCK_NAME'].[level,id]" \
    --output tsv
)"; then
  printf 'Could not inspect the existing OpenTofu state deletion lock.\n' >&2
  exit 1
fi
case "$STATE_EXISTING_LOCKS" in
  "") ;;
  *)
    if test "$(printf '%s\n' "$STATE_EXISTING_LOCKS" | wc -l | tr -d ' ')" != "1" ||
      test "$(printf '%s\n' "$STATE_EXISTING_LOCKS" | cut -f1)" != "CanNotDelete" ||
      test "$(
        printf '%s\n' "$STATE_EXISTING_LOCKS" | cut -f2 | tr '[:upper:]' '[:lower:]'
      )" != "$(
        printf '%s' "$EXPECTED_STATE_LOCK_ID" | tr '[:upper:]' '[:lower:]'
      )"; then
      printf 'A conflicting OpenTofu state lock requires explicit operator handling.\n' >&2
      exit 1
    fi
    ;;
esac
if ! inventory_state_resource_group ||
  test "$STATE_RESOURCE_COUNT" -ne 1 ||
  test "$STATE_STORAGE_ACCOUNT_EXISTS" != "true"; then
  printf 'The OpenTofu state resource group contains an unexpected resource.\n' >&2
  exit 1
fi
if test -z "$STATE_EXISTING_LOCKS"; then
  if ! private_az lock create \
    --name "$STATE_LOCK_NAME" \
    --lock-type CanNotDelete \
    --resource "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" >/dev/null; then
    printf 'Could not create the OpenTofu state-account deletion lock.\n' >&2
    exit 1
  fi
fi
if ! STATE_LOCK_PROPERTIES="$(
  private_az lock show \
    --ids "$EXPECTED_STATE_LOCK_ID" \
    --query '[level,id]' \
    --output tsv
)" ||
  test "$(printf '%s\n' "$STATE_LOCK_PROPERTIES" | cut -f1)" != "CanNotDelete" ||
  test "$(
    printf '%s\n' "$STATE_LOCK_PROPERTIES" | cut -f2 | tr '[:upper:]' '[:lower:]'
  )" != "$(
    printf '%s' "$EXPECTED_STATE_LOCK_ID" | tr '[:upper:]' '[:lower:]'
  )"; then
  printf 'OpenTofu state-account deletion lock is missing or incorrectly scoped.\n' >&2
  exit 1
fi
unset CURRENT_STATE_BLOB_PROPERTIES EXPECTED_STATE_LOCK_ID
unset EXPECTED_STATE_STORAGE_ACCOUNT_ID_LOWER EXISTING_STATE_RESOURCE_GROUP
unset OPERATION_CONTAINER_BLOBS OPERATION_CONTAINER_EXISTS OPERATION_CONTAINER_METADATA
unset OPERATION_CONTAINER_RESOURCE_ID OPERATION_PRINCIPAL_ID OPERATION_PRINCIPAL_TYPE
unset OPERATION_ROLE_ASSIGNMENT_COUNT OPERATION_ROLE_ASSIGNMENTS
unset STATE_CONTAINER_RESOURCE_ID STATE_ROLE_ASSIGNMENTS
unset RESUME_STATE_BOOTSTRAP SEEN_OPERATION_CONTAINER SEEN_STATE_CONTAINER
unset STATE_ACCOUNT_NAME_AVAILABLE STATE_BLOB_RETENTION_DAYS STATE_CONTAINER_EXISTS
unset STATE_CONTAINER_NAMES STATE_CONTAINER_RETENTION_DAYS STATE_EXISTING_LOCKS
unset STATE_KEY_MATCHES STATE_LOCK_PROPERTIES STATE_RESOURCE_COUNT STATE_RESOURCE_IDS
unset STATE_STORAGE_ACCOUNT_EXISTS STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID
unset -f inspect_state_containers inventory_state_resource_group
unset -f read_operation_role_assignments read_state_role_assignments verify_unused_state_key

if ! (umask 077 && : > backend.hcl) ||
  ! chmod 600 backend.hcl 2>/dev/null ||
  ! printf \
    'resource_group_name  = "%s"\nstorage_account_name = "%s"\ncontainer_name       = "%s"\nkey                  = "%s"\n' \
    "$STATE_RESOURCE_GROUP" \
    "$STATE_STORAGE_ACCOUNT" \
    "$STATE_CONTAINER" \
    "$STATE_KEY" > backend.hcl; then
  printf 'Could not write the private OpenTofu backend configuration.\n' >&2
  exit 1
fi
