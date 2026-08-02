set -u
set +x
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
: "${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID from the private verified deployment record}"
: "${STATE_STORAGE_ACCOUNT:?Set STATE_STORAGE_ACCOUNT from the private verified state record}"
: "${STATE_CONTAINER:?Set STATE_CONTAINER from the private verified state record}"
: "${STATE_KEY:?Set STATE_KEY from the private verified state record}"
: "${RESOURCE_GROUP:?Set RESOURCE_GROUP from the private verified deployment record}"
: "${CONTAINER_APP:?Set CONTAINER_APP from the private verified deployment record}"
: "${ACR:?Set ACR from the private verified deployment record}"
: "${EXPECTED_STORAGE_ACCOUNT_ID:?Set EXPECTED_STORAGE_ACCOUNT_ID from the private verified deployment record}"
: "${EXPECTED_POSTGRES_SERVER_ID:?Set EXPECTED_POSTGRES_SERVER_ID from the private verified deployment record}"
: "${CONFIRM_STALE_OPERATION_LEASE:?Set only after independent second-operator verification}"
if ! printf '%s\n' "$STATE_STORAGE_ACCOUNT" | grep -Eq '^[a-z0-9]{3,24}$' ||
  test "$STATE_CONTAINER" != "tfstate" ||
  ! printf '%s\n' "$STATE_KEY" |
    grep -Eq '^[a-z0-9][a-z0-9._-]{0,126}\.tfstate$' ||
  ! printf '%s\n' "$ACR" | grep -Eq '^[a-z0-9]{5,50}$' ||
  test "$CONFIRM_STALE_OPERATION_LEASE" != "second-operator-confirmed-no-active-operation"; then
  printf 'Stale operation-lease recovery was not safely confirmed.\n' >&2
  exit 1
fi
OPERATION_CONTAINER="patchpage-operations"
EXPECTED_STATE_STORAGE_ACCOUNT_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT"
EXPECTED_OPERATION_CONTAINER_ID="$EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/$OPERATION_CONTAINER"
EXPECTED_ACR_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/$ACR"
EXPECTED_CONTAINER_APP_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/containerApps/$CONTAINER_APP"
WORKLOAD_STORAGE_ACCOUNT="${EXPECTED_STORAGE_ACCOUNT_ID##*/}"
WORKLOAD_POSTGRES_SERVER="${EXPECTED_POSTGRES_SERVER_ID##*/}"
if ! printf '%s\n' "$WORKLOAD_STORAGE_ACCOUNT" | grep -Eq '^[a-z0-9]{3,24}$' ||
  ! printf '%s\n' "$WORKLOAD_POSTGRES_SERVER" |
    grep -Eq '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' ||
  test "$(printf '%s' "$EXPECTED_STORAGE_ACCOUNT_ID" | tr '[:upper:]' '[:lower:]')" != "$(
    printf '%s' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/$WORKLOAD_STORAGE_ACCOUNT" |
      tr '[:upper:]' '[:lower:]'
  )" ||
  test "$(printf '%s' "$EXPECTED_POSTGRES_SERVER_ID" | tr '[:upper:]' '[:lower:]')" != "$(
    printf '%s' "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.DBforPostgreSQL/flexibleServers/$WORKLOAD_POSTGRES_SERVER" |
      tr '[:upper:]' '[:lower:]'
  )"; then
  printf 'Stale operation-lease recovery found an invalid workload identity.\n' >&2
  exit 1
fi
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
  printf 'Stale operation-lease recovery could not bind the expected workload.\n' >&2
  exit 1
fi
if ! private_az account set ||
  ! ACTIVE_SUBSCRIPTION_ID="$(private_az account show --query id --output tsv)" ||
  test "$ACTIVE_SUBSCRIPTION_ID" != "$SUBSCRIPTION_ID" ||
  ! LIVE_OPERATION_CONTAINER_ID="$(
    private_az storage container-rm show \
      --ids "$EXPECTED_OPERATION_CONTAINER_ID" \
      --query id \
      --output tsv
  )" ||
  test "$(printf '%s' "$LIVE_OPERATION_CONTAINER_ID" | tr '[:upper:]' '[:lower:]')" != "$(
    printf '%s' "$EXPECTED_OPERATION_CONTAINER_ID" |
      tr '[:upper:]' '[:lower:]'
  )" ||
  ! OPERATION_CONTAINER_EXISTS="$(
    private_az storage container exists \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --name "$OPERATION_CONTAINER" \
      --auth-mode login \
      --query exists \
      --output tsv
  )" || test "$OPERATION_CONTAINER_EXISTS" != "true" ||
  ! OPERATION_CONTAINER_BLOBS="$(
    private_az storage blob list \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --container-name "$OPERATION_CONTAINER" \
      --auth-mode login \
      --include d v \
      --num-results '*' \
      --query '[].name' \
      --output tsv
  )" || test -n "$OPERATION_CONTAINER_BLOBS" ||
  ! OPERATION_CONTAINER_METADATA="$(
    private_az storage container metadata show \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --name "$OPERATION_CONTAINER" \
      --auth-mode login \
      --output json
  )" ||
  ! printf '%s\n' "$OPERATION_CONTAINER_METADATA" |
    jq -e \
      --arg binding "$OPERATION_BINDING_SHA256" \
      'type == "object" and
       length == 1 and
       .patchpage_workload_binding_sha256 == $binding' >/dev/null; then
  printf 'The abandoned operation lease could not be verified safely.\n' >&2
  exit 1
fi
if ! private_az storage container lease break \
  --account-name "$STATE_STORAGE_ACCOUNT" \
  --container-name "$OPERATION_CONTAINER" \
  --auth-mode login \
  --lease-break-period 0 \
  --output none >/dev/null; then
  printf 'Operation lease recovery failed closed.\n' >&2
  exit 1
fi
if ! RECOVERY_LEASE_HEX="$(
  od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
)" ||
  ! printf '%s\n' "$RECOVERY_LEASE_HEX" | grep -Eq '^[0-9a-f]{32}$' ||
  ! RECOVERY_LEASE_ID="$(
    printf '%s\n' "$RECOVERY_LEASE_HEX" |
      sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/'
  )"; then
  printf 'Operation lease recovery failed closed.\n' >&2
  exit 1
fi
RECOVERY_LEASE_ACTIVE=true
release_recovery_lease() {
  if test "${RECOVERY_LEASE_ACTIVE:-false}" = "true" &&
    private_az storage container lease release \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --container-name "$OPERATION_CONTAINER" \
      --auth-mode login \
      --lease-id "$RECOVERY_LEASE_ID" \
      --output none >/dev/null; then
    RECOVERY_LEASE_ACTIVE=false
  fi
}
trap 'release_recovery_lease' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ! private_az storage container lease acquire \
  --account-name "$STATE_STORAGE_ACCOUNT" \
  --container-name "$OPERATION_CONTAINER" \
  --auth-mode login \
  --lease-duration -1 \
  --proposed-lease-id "$RECOVERY_LEASE_ID" \
  --output none >/dev/null ||
  ! private_az storage container lease renew \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$OPERATION_CONTAINER" \
    --auth-mode login \
    --lease-id "$RECOVERY_LEASE_ID" \
    --output none >/dev/null ||
  ! private_az storage container lease release \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$OPERATION_CONTAINER" \
    --auth-mode login \
    --lease-id "$RECOVERY_LEASE_ID" \
    --output none >/dev/null; then
  printf 'Operation lease recovery failed closed.\n' >&2
  exit 1
fi
RECOVERY_LEASE_ACTIVE=false
trap - 0 HUP INT TERM
unset -f release_recovery_lease
printf 'Operation lease recovery completed.\n'
