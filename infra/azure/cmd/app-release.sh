set -u
set +x
# The operation lease runs as the operator's own Entra principal in this flow:
# what authorizes a release is a named human who holds the operation-container
# data role, not possession of a storage key. lib/lease.sh refuses to load
# without this, so the choice is made here rather than inherited.
OPERATION_LEASE_AUTH_MODE=login
. "${PP_OPS_LIB:?run this through the dispatcher: sh infra/azure/ops.sh app-release}/wrappers.sh"
. "$PP_OPS_LIB/lease.sh"
. "$PP_OPS_LIB/revision.sh"
: "${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID from the private verified deployment record}"
: "${STATE_STORAGE_ACCOUNT:?Set STATE_STORAGE_ACCOUNT from the private verified state record}"
: "${STATE_CONTAINER:?Set STATE_CONTAINER from the private verified state record}"
: "${STATE_KEY:?Set STATE_KEY from the private verified state record}"
: "${RESOURCE_GROUP:?Set RESOURCE_GROUP from the private verified deployment record}"
: "${CONTAINER_APP:?Set CONTAINER_APP from the private verified deployment record}"
: "${ACR:?Set ACR from the private verified deployment record}"
: "${EXPECTED_STORAGE_ACCOUNT_ID:?Set EXPECTED_STORAGE_ACCOUNT_ID from the private verified deployment record}"
: "${EXPECTED_POSTGRES_SERVER_ID:?Set EXPECTED_POSTGRES_SERVER_ID from the private verified deployment record}"
: "${LOGIN_SERVER:?Set LOGIN_SERVER from the private verified deployment record}"
: "${CONTAINER_APP_FQDN:?Set CONTAINER_APP_FQDN from the private verified deployment record}"
: "${PUBLIC_BASE_URL:?Set PUBLIC_BASE_URL from the private verified deployment record}"
: "${CANARY_URL:?Set CANARY_URL from the private canary record}"
: "${CANARY_MARKER:?Set CANARY_MARKER from the private canary record}"
: "${ROLLBACK_RECORD:?Set ROLLBACK_RECORD to a durable private path outside the repository}"
if ! printf '%s\n' "$PUBLIC_BASE_URL" |
  grep -Eq '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'; then
  printf 'The private release verification endpoints are invalid.\n' >&2
  exit 1
fi
PUBLIC_HOSTNAME="$(
  printf '%s' "${PUBLIC_BASE_URL#https://}" | tr '[:upper:]' '[:lower:]'
)"
case "$CANARY_URL" in
  "$PUBLIC_BASE_URL"/d/*) CANARY_DRAFT_ID="${CANARY_URL#"$PUBLIC_BASE_URL/d/"}" ;;
  *)
    printf 'The private release verification endpoints are invalid.\n' >&2
    exit 1
    ;;
esac
if ! printf '%s\n' "$CANARY_DRAFT_ID" | grep -Eq '^[a-z0-9]{12}$' ||
  test "$CANARY_URL" != "$PUBLIC_BASE_URL/d/$CANARY_DRAFT_ID"; then
  printf 'The private release verification endpoints are invalid.\n' >&2
  exit 1
fi
unset CANARY_DRAFT_ID
if ! printf '%s\n' "$ACR" | grep -Eq '^[a-z0-9]{5,50}$' ||
  test "$LOGIN_SERVER" != "$ACR.azurecr.io"; then
  printf 'The private container-registry identity is invalid.\n' >&2
  exit 1
fi
case "$ROLLBACK_RECORD" in
  /*) ;;
  *)
    printf 'ROLLBACK_RECORD must be an absolute path outside the repository.\n' >&2
    exit 1
    ;;
esac
ROLLBACK_RECORD_NAME="${ROLLBACK_RECORD##*/}"
ROLLBACK_RECORD_PARENT="${ROLLBACK_RECORD%/*}"
test -n "$ROLLBACK_RECORD_PARENT" || ROLLBACK_RECORD_PARENT="/"
if ! printf '%s\n' "$ROLLBACK_RECORD_NAME" |
  grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' ||
  ! ROLLBACK_RECORD_PARENT="$(
    CDPATH= cd -- "$ROLLBACK_RECORD_PARENT" 2>/dev/null && pwd -P
  )"; then
  printf 'ROLLBACK_RECORD must have an existing private parent and safe filename.\n' >&2
  exit 1
fi
ROLLBACK_RECORD="$ROLLBACK_RECORD_PARENT/$ROLLBACK_RECORD_NAME"
if ! REPO_ROOT="$(private_git rev-parse --show-toplevel)" ||
  ! REPO_ROOT="$(CDPATH= cd -- "$REPO_ROOT" 2>/dev/null && pwd -P)"; then
  printf 'Could not locate the canonical release repository root.\n' >&2
  exit 1
fi
case "$ROLLBACK_RECORD" in
  "$REPO_ROOT" | "$REPO_ROOT"/*)
    printf 'ROLLBACK_RECORD must remain outside the repository.\n' >&2
    exit 1
    ;;
esac
if test -L "$ROLLBACK_RECORD" ||
  { test -e "$ROLLBACK_RECORD" && ! test -f "$ROLLBACK_RECORD"; }; then
  printf 'ROLLBACK_RECORD must be absent or an existing regular file, never a directory or symbolic link.\n' >&2
  exit 1
fi
case "$CANARY_MARKER" in
  *[![:space:]]*) ;;
  *)
    printf 'CANARY_MARKER must contain a non-whitespace character.\n' >&2
    exit 1
    ;;
esac
if ! printf '%s\n' "$STATE_STORAGE_ACCOUNT" | grep -Eq '^[a-z0-9]{3,24}$' ||
  test "$STATE_CONTAINER" != "tfstate" ||
  ! printf '%s\n' "$STATE_KEY" |
    grep -Eq '^[a-z0-9][a-z0-9._-]{0,126}\.tfstate$'; then
  printf 'The private state-storage identity is invalid.\n' >&2
  exit 1
fi
OPERATION_CONTAINER="patchpage-operations"

if ! private_az account set ||
  ! ACTIVE_SUBSCRIPTION_ID="$(private_az account show --query id --output tsv)" ||
  test "$ACTIVE_SUBSCRIPTION_ID" != "$SUBSCRIPTION_ID"; then
  printf 'The active Azure subscription does not match the private expected value.\n' >&2
  exit 1
fi
EXPECTED_ACR_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/$ACR"
if ! LIVE_ACR_ID="$(
  private_az acr show \
    --name "$ACR" \
    --resource-group "$RESOURCE_GROUP" \
    --query id \
    --output tsv
)" ||
  test "$(printf '%s' "$LIVE_ACR_ID" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_ACR_ID" | tr '[:upper:]' '[:lower:]')" ||
  ! LIVE_ACR_LOGIN_SERVER="$(
    private_az acr show \
      --name "$ACR" \
      --resource-group "$RESOURCE_GROUP" \
      --query loginServer \
      --output tsv
  )" ||
  test "$LIVE_ACR_LOGIN_SERVER" != "$ACR.azurecr.io" ||
  test "$LIVE_ACR_LOGIN_SERVER" != "$LOGIN_SERVER"; then
  printf 'The private container-registry identity is invalid.\n' >&2
  exit 1
fi
EXPECTED_STATE_STORAGE_ACCOUNT_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT"
EXPECTED_OPERATION_CONTAINER_ID="$EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/$OPERATION_CONTAINER"
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
  printf 'A protected workload identity is invalid.\n' >&2
  exit 1
fi
EXPECTED_STORAGE_LOCK_ID="$EXPECTED_STORAGE_ACCOUNT_ID/providers/Microsoft.Authorization/locks/protect-patchpage-drafts"
EXPECTED_POSTGRES_LOCK_ID="$EXPECTED_POSTGRES_SERVER_ID/providers/Microsoft.Authorization/locks/protect-patchpage-postgres"
if ! STORAGE_LOCK_PROPERTIES="$(
  private_az lock show \
    --ids "$EXPECTED_STORAGE_LOCK_ID" \
    --query '[[level,id]]' \
    --output tsv
)" ||
  test "$(printf '%s\n' "$STORAGE_LOCK_PROPERTIES" | cut -f1)" != "CanNotDelete" ||
  test "$(printf '%s\n' "$STORAGE_LOCK_PROPERTIES" | cut -f2 | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_STORAGE_LOCK_ID" | tr '[:upper:]' '[:lower:]')" ||
  ! POSTGRES_LOCK_PROPERTIES="$(
    private_az lock show \
      --ids "$EXPECTED_POSTGRES_LOCK_ID" \
      --query '[[level,id]]' \
      --output tsv
  )" ||
  test "$(printf '%s\n' "$POSTGRES_LOCK_PROPERTIES" | cut -f1)" != "CanNotDelete" ||
  test "$(printf '%s\n' "$POSTGRES_LOCK_PROPERTIES" | cut -f2 | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_POSTGRES_LOCK_ID" | tr '[:upper:]' '[:lower:]')"; then
  printf 'An exact persistent-resource deletion lock is missing or incorrect.\n' >&2
  exit 1
fi
if ! CONTAINER_APP_PROPERTIES="$(
  private_az containerapp show \
    --ids "$EXPECTED_CONTAINER_APP_ID" \
    --output json
)" ||
  ! printf '%s\n' "$CONTAINER_APP_PROPERTIES" |
    jq -e \
      --arg expected_id "$(printf '%s' "$EXPECTED_CONTAINER_APP_ID" | tr '[:upper:]' '[:lower:]')" \
      --arg fqdn "$CONTAINER_APP_FQDN" \
      --arg public_base_url "$PUBLIC_BASE_URL" \
      --arg public_hostname "$PUBLIC_HOSTNAME" \
      '(.id | type == "string" and ascii_downcase == $expected_id) and
       .properties.configuration.ingress.fqdn == $fqdn and
       (([.properties.template.containers[]? | select(.name == "server")]) as $servers |
        ($servers | length) == 1 and
        ([$servers[0].env[]? |
          select(.name == "PATCHPAGE_PUBLIC_BASE_URL") |
          .value]) == [$public_base_url]) and
       ([.properties.configuration.ingress.customDomains[]? |
         select(
           .name == $public_hostname and
           .bindingType == "SniEnabled" and
           (.certificateId | type == "string" and length > 0)
         )] | length) == 1' >/dev/null ||
  ! ROLLBACK_IMAGE_REF="$(
    printf '%s\n' "$CONTAINER_APP_PROPERTIES" |
      jq -er \
        '[.properties.template.containers[]? | select(.name == "server")] |
         select(length == 1) |
         .[0].image |
         select(type == "string" and length > 0)'
  )"; then
  printf 'The Container App endpoint binding is missing or inconsistent.\n' >&2
  exit 1
fi
if ! OPERATION_BINDING_SHA256="$(operation_binding_sha256)"; then
  printf 'Could not compute the operation-container workload binding.\n' >&2
  exit 1
fi

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
trap 'operation_lease_exit; operation_lease_retention_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ! acquire_operation_lease; then
  printf 'The operation lease could not be established and verified; second-operator review may be required.\n' >&2
  exit 1
fi
if ! PREFLIGHT_CONTAINER_APP_PROPERTIES="$(
  private_az containerapp show \
    --ids "$EXPECTED_CONTAINER_APP_ID" \
    --output json
)" ||
  ! PREUPDATE_REVISION_NAME="$(
    printf '%s\n' "$PREFLIGHT_CONTAINER_APP_PROPERTIES" |
      jq -er \
        '.properties.latestRevisionName |
         select(type == "string" and length > 0)'
  )" ||
  ! LOCKED_ROLLBACK_IMAGE_REF="$(
    printf '%s\n' "$PREFLIGHT_CONTAINER_APP_PROPERTIES" |
      jq -er \
        '[.properties.template.containers[]? | select(.name == "server")] |
         select(length == 1) |
         .[0].image |
         select(type == "string" and length > 0)'
  )" ||
  test "$LOCKED_ROLLBACK_IMAGE_REF" != "$ROLLBACK_IMAGE_REF" ||
  ! verify_pinned_revision_stable \
    "$PREUPDATE_REVISION_NAME" \
    "$ROLLBACK_IMAGE_REF"; then
  printf 'The current Container App revision is not stable for release.\n' >&2
  exit 1
fi
if ! GIT_STATUS="$(private_git -C "$REPO_ROOT" status --porcelain)" ||
  test -n "$GIT_STATUS" ||
  ! TAG="$(private_git -C "$REPO_ROOT" rev-parse HEAD)" ||
  ! printf '%s\n' "$TAG" | grep -Eq '^[0-9a-f]{40}$'; then
  printf 'Release builds require a clean Git worktree and full commit ID.\n' >&2
  exit 1
fi
if ! RELEASE_BUILD_NONCE="$(
  od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
)" ||
  ! printf '%s\n' "$RELEASE_BUILD_NONCE" | grep -Eq '^[0-9a-f]{32}$'; then
  printf 'Could not create a unique release image tag.\n' >&2
  exit 1
fi
RELEASE_BUILD_TAG="$TAG-$RELEASE_BUILD_NONCE"
unset RELEASE_BUILD_NONCE
if ! private_az acr build \
  --registry "$ACR" \
  --image "patchpage-server:$RELEASE_BUILD_TAG" \
  --build-arg "REVISION=$TAG" \
  --file "$REPO_ROOT/apps/server/Dockerfile" \
  "$REPO_ROOT" >/dev/null 2>&1; then
  printf 'ACR did not complete the server image build successfully.\n' >&2
  exit 1
fi
if ! IMAGE_DIGEST="$(
  private_az acr manifest show-metadata \
    --registry "$ACR" \
    --name "patchpage-server:$RELEASE_BUILD_TAG" \
    --query digest \
    --output tsv
)" ||
  ! printf '%s\n' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  printf 'Could not resolve the release image to a valid registry digest.\n' >&2
  exit 1
fi
IMAGE_REF="$LOGIN_SERVER/patchpage-server@$IMAGE_DIGEST"
unset RELEASE_BUILD_TAG
if test "$IMAGE_REF" = "$ROLLBACK_IMAGE_REF"; then
  if ! verify_operation_lease ||
    ! verify_pinned_revision_stable \
      "$PREUPDATE_REVISION_NAME" \
      "$ROLLBACK_IMAGE_REF"; then
    printf 'The operation lease or stable revision changed before the no-op release check.\n' >&2
    exit 1
  fi
  if ! release_operation_lease; then
    printf 'Operation lease release failed; second-operator review is required.\n' >&2
    exit 1
  fi
  trap - 0 HUP INT TERM
  printf 'Release image is already deployed; no update is required.\n'
  exit 0
fi
case "$ROLLBACK_IMAGE_REF" in
  "$LOGIN_SERVER/patchpage-server@sha256:"*) ;;
  *) printf 'The currently deployed image is not an expected digest reference.\n' >&2; exit 1 ;;
esac
ROLLBACK_DIGEST="${ROLLBACK_IMAGE_REF##*@}"
if ! printf '%s\n' "$ROLLBACK_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
  ! VERIFIED_ROLLBACK_DIGEST="$(
    private_az acr manifest show-metadata \
      --registry "$ACR" \
      --name "patchpage-server@$ROLLBACK_DIGEST" \
      --query digest \
      --output tsv
  )" ||
  test "$VERIFIED_ROLLBACK_DIGEST" != "$ROLLBACK_DIGEST"; then
  printf 'The rollback image digest is unavailable in the expected registry.\n' >&2
  exit 1
fi

if ! ROLLBACK_RECORD_TEMP="$(
  mktemp "${ROLLBACK_RECORD}.tmp.XXXXXX" 2>/dev/null
)"; then
  printf 'Could not create the private rollback record.\n' >&2
  exit 1
fi
if ! chmod 600 "$ROLLBACK_RECORD_TEMP" 2>/dev/null; then
  rm -f -- "$ROLLBACK_RECORD_TEMP" 2>/dev/null || :
  printf 'Could not secure the private rollback record.\n' >&2
  exit 1
fi
if ! (umask 077 && printf 'ROLLBACK_IMAGE_REF=%s\nRELEASE_IMAGE_REF=%s\n' \
  "$ROLLBACK_IMAGE_REF" \
  "$IMAGE_REF" > "$ROLLBACK_RECORD_TEMP") 2>/dev/null ||
  ! mv -f -- "$ROLLBACK_RECORD_TEMP" "$ROLLBACK_RECORD" 2>/dev/null; then
  rm -f -- "$ROLLBACK_RECORD_TEMP" 2>/dev/null || :
  printf 'Could not write the private rollback record.\n' >&2
  exit 1
fi
unset ROLLBACK_RECORD_TEMP
printf 'Private rollback record created.\n'

if ! verify_operation_lease ||
  ! verify_pinned_revision_stable \
    "$PREUPDATE_REVISION_NAME" \
    "$ROLLBACK_IMAGE_REF"; then
  printf 'The operation lease or stable revision changed before release.\n' >&2
  exit 1
fi

OPERATION_MUTATION_UNCERTAIN=true
if ! UPDATED_REVISION_NAME="$(
  private_az containerapp update \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --container-name server \
  --image "$IMAGE_REF" \
  --query properties.latestRevisionName \
  --output tsv
)"; then
  printf 'Container App image update failed.\n' >&2
  exit 75
fi
if test -z "$UPDATED_REVISION_NAME" ||
  test "$UPDATED_REVISION_NAME" = "$PREUPDATE_REVISION_NAME"; then
  container_app_readiness_recovery_required
fi
if ! poll_pinned_revision_stable \
  "$UPDATED_REVISION_NAME" \
  "$IMAGE_REF"; then
  container_app_readiness_recovery_required
fi
EXPECTED_HEALTH_RESPONSE='{"ok":true}
200'
if ! NATIVE_HEALTH_RESPONSE="$(
  private_curl --proto '=https' --tlsv1.2 \
    --fail --silent --show-error \
    --connect-timeout 15 --max-time 120 \
    --write-out '\n%{http_code}' \
    "https://$CONTAINER_APP_FQDN/healthz"
)" ||
  test "$NATIVE_HEALTH_RESPONSE" != "$EXPECTED_HEALTH_RESPONSE" ||
  ! PUBLIC_HEALTH_RESPONSE="$(
    private_curl --proto '=https' --tlsv1.2 \
      --fail --silent --show-error \
      --connect-timeout 15 --max-time 120 \
      --write-out '\n%{http_code}' \
      "$PUBLIC_BASE_URL/healthz"
  )" ||
  test "$PUBLIC_HEALTH_RESPONSE" != "$EXPECTED_HEALTH_RESPONSE"; then
  printf 'Release health verification failed.\n' >&2
  exit 75
fi
unset EXPECTED_HEALTH_RESPONSE NATIVE_HEALTH_RESPONSE PUBLIC_HEALTH_RESPONSE
if ! CANARY_BODY="$(
  private_curl --proto '=https' --tlsv1.2 \
    --fail --silent --show-error \
    --connect-timeout 15 --max-time 120 \
    "$CANARY_URL"
)"; then
  printf 'Pre-existing canary request failed.\n' >&2
  exit 75
fi
if ! printf '%s\n' "$CANARY_BODY" |
  grep -F -- "$CANARY_MARKER" >/dev/null; then
  printf 'Pre-existing canary marker verification failed.\n' >&2
  exit 75
fi
if ! verify_pinned_revision_stable \
  "$UPDATED_REVISION_NAME" \
  "$IMAGE_REF"; then
  container_app_readiness_recovery_required
fi
OPERATION_MUTATION_UNCERTAIN=false
if ! release_operation_lease; then
  printf 'Operation lease release failed; second-operator review is required.\n' >&2
  exit 1
fi
trap - 0 HUP INT TERM
unset -f acquire_operation_lease operation_lease_exit release_operation_lease
unset -f operation_lease_retention_exit
unset -f verify_operation_container verify_operation_lease
unset -f container_app_readiness_recovery_required
unset -f poll_pinned_revision_stable verify_pinned_revision_stable
