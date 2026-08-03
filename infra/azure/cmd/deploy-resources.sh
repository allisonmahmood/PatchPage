set -u
set +x
# The initial deployment creates the state account's key access alongside
# everything else, and does all of its container work with that key. It never
# takes the long-lived operation lease -- there is nothing to exclude yet -- but
# it seals the workload binding the later flows compare against, so it needs the
# same binding definition they use.
OPERATION_LEASE_AUTH_MODE=key
. "${PP_OPS_LIB:?run this through the dispatcher: sh infra/azure/ops.sh deploy-resources}/wrappers.sh"
. "$PP_OPS_LIB/diag.sh"
. "$PP_OPS_LIB/lease.sh"
. "$PP_OPS_LIB/plan_gate.sh"
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
  printf 'Could not resolve the private OpenTofu diagnostic root.\n' >&2
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
  printf 'Could not create a private OpenTofu diagnostic directory.\n' >&2
  exit 1
fi
TERRAFORM_DIAGNOSTIC_LOG="$TERRAFORM_DIAGNOSTIC_DIR/terraform.log"
umask 077
if ! { exec 3>>"$TERRAFORM_DIAGNOSTIC_LOG"; } 2>/dev/null ||
  ! chmod 600 "$TERRAFORM_DIAGNOSTIC_LOG" 2>/dev/null; then
  { exec 3>&-; } 2>/dev/null || :
  rm -rf -- "$TERRAFORM_DIAGNOSTIC_DIR" 2>/dev/null || :
  printf 'Could not secure the private OpenTofu diagnostic log.\n' >&2
  exit 1
fi
TERRAFORM_DIAGNOSTICS_COMPLETE=false
TERRAFORM_DIAGNOSTIC_FD_OPEN=true
trap 'tofu_diagnostic_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
unset REPO_ROOT_CANONICAL
unset REPO_ROOT

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the subscription_id in terraform.tfvars}"
STATE_STORAGE_ACCOUNT="${STATE_STORAGE_ACCOUNT:?Set STATE_STORAGE_ACCOUNT from the private state-bootstrap record}"
STATE_KEY="${STATE_KEY:?Set STATE_KEY from the private state-bootstrap record}"
if ! printf '%s\n' "$STATE_STORAGE_ACCOUNT" | grep -Eq '^[a-z0-9]{3,24}$' ||
  ! printf '%s\n' "$STATE_KEY" |
    grep -Eq '^[a-z0-9][a-z0-9._-]{0,126}\.tfstate$'; then
  printf 'The private state-storage identity is invalid.\n' >&2
  exit 1
fi
STATE_CONTAINER="tfstate"
if ! (umask 077 && : > backend.hcl) ||
  ! chmod 600 backend.hcl 2>/dev/null ||
  ! printf \
    'resource_group_name  = "rg-patchpage-tfstate"\nstorage_account_name = "%s"\ncontainer_name       = "%s"\nkey                  = "%s"\n' \
    "$STATE_STORAGE_ACCOUNT" \
    "$STATE_CONTAINER" \
    "$STATE_KEY" > backend.hcl; then
  printf 'Could not write the private OpenTofu backend configuration.\n' >&2
  exit 1
fi
RESUME_INITIAL_DEPLOY="${RESUME_INITIAL_DEPLOY:-false}"
case "$RESUME_INITIAL_DEPLOY" in
  true | false) ;;
  *)
    printf 'RESUME_INITIAL_DEPLOY must be true or false.\n' >&2
    exit 1
    ;;
esac
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

if ! private_tofu init -input=false -reconfigure -backend-config=backend.hcl >&3; then
  printf 'OpenTofu initialization failed.\n' >&2
  exit 1
fi
if ! TERRAFORM_SUBSCRIPTION_LITERAL="$(
  private_tofu console -no-color <<'EOF'
var.subscription_id
EOF
)"; then
  printf 'Could not verify the OpenTofu provider subscription.\n' >&2
  exit 1
fi
if test "$TERRAFORM_SUBSCRIPTION_LITERAL" != "\"$SUBSCRIPTION_ID\""; then
  printf 'The OpenTofu provider subscription does not match the private expected value.\n' >&2
  exit 1
fi
unset TERRAFORM_SUBSCRIPTION_LITERAL

if ! TERRAFORM_RESOURCE_GROUP_LITERAL="$(
  private_tofu console -no-color <<'EOF'
"rg-patchpage-${var.environment_name}"
EOF
)"; then
  printf 'Could not verify the OpenTofu workload resource-group name.\n' >&2
  exit 1
fi
if ! TERRAFORM_RESOURCE_GROUP="$(
  printf '%s\n' "$TERRAFORM_RESOURCE_GROUP_LITERAL" |
    jq -er 'select(type == "string" and length > 0)'
)"; then
  printf 'OpenTofu returned an invalid workload resource-group name.\n' >&2
  exit 1
fi
unset TERRAFORM_RESOURCE_GROUP_LITERAL
if ! WORKLOAD_RESOURCE_GROUP_EXISTS="$(
  private_az group exists \
    --name "$TERRAFORM_RESOURCE_GROUP" \
    --output tsv 2>/dev/null
)"; then
  printf 'Could not verify the workload resource group.\n' >&2
  exit 1
fi
if ! STATE_LIST_ERROR="$(
  mktemp "$TERRAFORM_DIAGNOSTIC_DIR/state-list.stderr.XXXXXX" 2>/dev/null
)" ||
  ! { exec 4>"$STATE_LIST_ERROR"; } 2>/dev/null; then
  printf 'Could not create private OpenTofu state diagnostics.\n' >&2
  exit 1
fi
if STATE_ADDRESSES="$(tofu state list 2>&4)"; then
  STATE_LIST_STATUS=0
else
  STATE_LIST_STATUS=$?
fi
{ exec 4>&-; } 2>/dev/null || :
if test "$STATE_LIST_STATUS" -ne 0 &&
  test "$RESUME_INITIAL_DEPLOY" = "false" &&
  grep -Fq 'No state file was found' "$STATE_LIST_ERROR" 2>/dev/null; then
  STATE_ADDRESSES=''
  STATE_LIST_STATUS=0
fi
if ! cat -- "$STATE_LIST_ERROR" >&3 2>/dev/null ||
  ! rm -f -- "$STATE_LIST_ERROR" 2>/dev/null; then
  printf 'Could not preserve the private OpenTofu state diagnostics.\n' >&2
  exit 1
fi
if test "$STATE_LIST_STATUS" -ne 0; then
  printf 'Could not verify the selected OpenTofu state.\n' >&2
  exit 1
fi
unset STATE_LIST_ERROR STATE_LIST_STATUS
case "$WORKLOAD_RESOURCE_GROUP_EXISTS" in
  true | false) ;;
  *)
    printf 'Azure returned an invalid workload resource-group existence result.\n' >&2
    exit 1
    ;;
esac
if test "$RESUME_INITIAL_DEPLOY" = "false"; then
  if test "$WORKLOAD_RESOURCE_GROUP_EXISTS" != "false" ||
    test -n "$STATE_ADDRESSES"; then
    printf 'Initial deployment requires empty state and an unused workload resource group.\n' >&2
    exit 1
  fi
else
  if test -z "$STATE_ADDRESSES"; then
    printf 'Initial-deployment resume requires partial registry-target state.\n' >&2
    exit 1
  fi
  if ! printf '%s\n' "$STATE_ADDRESSES" |
    while IFS= read -r address; do
      case "$address" in
        data.azurerm_client_config.current | \
        random_string.unique | \
        azurerm_resource_group.patchpage | \
        azurerm_container_registry.patchpage) ;;
        *) exit 1 ;;
      esac
    done; then
    printf 'Initial-deployment resume found state beyond the registry target.\n' >&2
    exit 1
  fi
  RESUME_HAS_RESOURCE_GROUP=false
  RESUME_HAS_ACR=false
  RESUME_HAS_RANDOM=false
  if printf '%s\n' "$STATE_ADDRESSES" |
    grep -Fqx 'random_string.unique'; then
    RESUME_HAS_RANDOM=true
  fi
  if printf '%s\n' "$STATE_ADDRESSES" |
    grep -Fqx 'azurerm_resource_group.patchpage'; then
    RESUME_HAS_RESOURCE_GROUP=true
  fi
  if printf '%s\n' "$STATE_ADDRESSES" |
    grep -Fqx 'azurerm_container_registry.patchpage'; then
    RESUME_HAS_ACR=true
  fi
  if test "$RESUME_HAS_ACR" = "true" &&
    { test "$RESUME_HAS_RESOURCE_GROUP" != "true" ||
      test "$RESUME_HAS_RANDOM" != "true"; }; then
    printf 'Initial-deployment resume found registry state without its resource-group and random-name dependencies.\n' >&2
    exit 1
  fi
  if test "$RESUME_HAS_RESOURCE_GROUP" != "$WORKLOAD_RESOURCE_GROUP_EXISTS"; then
    printf 'Initial-deployment resume resource-group state does not match Azure.\n' >&2
    exit 1
  fi
  if test "$RESUME_HAS_RESOURCE_GROUP" = "true"; then
    if ! RESUME_RESOURCE_GROUP="$(private_tofu output -raw resource_group_name)" ||
      test "$RESUME_RESOURCE_GROUP" != "$TERRAFORM_RESOURCE_GROUP" ||
      ! RESUME_LIVE_RESOURCE_GROUP_ID="$(
        private_az group show \
          --name "$RESUME_RESOURCE_GROUP" \
          --query id \
          --output tsv
      )"; then
      printf 'Could not prove the resumed workload resource group.\n' >&2
      exit 1
    fi
    RESUME_EXPECTED_RESOURCE_GROUP_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESUME_RESOURCE_GROUP"
    if test "$(
        printf '%s' "$RESUME_LIVE_RESOURCE_GROUP_ID" | tr '[:upper:]' '[:lower:]'
      )" != "$(
        printf '%s' "$RESUME_EXPECTED_RESOURCE_GROUP_ID" | tr '[:upper:]' '[:lower:]'
      )"; then
      printf 'The resumed workload resource group does not match the private expected identity.\n' >&2
      exit 1
    fi
  fi
  RESUME_EXPECTED_ACR_ID=""
  if test "$RESUME_HAS_ACR" = "true"; then
    if ! RESUME_ACR="$(private_tofu output -raw acr_name)" ||
      ! printf '%s\n' "$RESUME_ACR" | grep -Eq '^[a-z0-9]{5,50}$' ||
      ! RESUME_LIVE_ACR_ID="$(
        private_az acr show \
          --name "$RESUME_ACR" \
          --resource-group "$TERRAFORM_RESOURCE_GROUP" \
          --query id \
          --output tsv
      )"; then
      printf 'Could not prove the resumed container registry.\n' >&2
      exit 1
    fi
    RESUME_EXPECTED_ACR_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$TERRAFORM_RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/$RESUME_ACR"
    if test "$(
        printf '%s' "$RESUME_LIVE_ACR_ID" | tr '[:upper:]' '[:lower:]'
      )" != "$(
        printf '%s' "$RESUME_EXPECTED_ACR_ID" | tr '[:upper:]' '[:lower:]'
      )"; then
      printf 'The resumed container registry does not match the private expected identity.\n' >&2
      exit 1
    fi
  fi
  if test "$RESUME_HAS_RESOURCE_GROUP" = "true"; then
    if ! RESUME_RESOURCE_IDS="$(
      private_az resource list \
        --resource-group "$RESUME_RESOURCE_GROUP" \
        --query '[].id' \
        --output tsv
    )"; then
      printf 'Could not inventory the resumed workload resource group.\n' >&2
      exit 1
    fi
    RESUME_ACR_RESOURCE_SEEN=false
    while IFS= read -r resume_resource_id; do
      test -z "$resume_resource_id" && continue
      if test -z "$RESUME_EXPECTED_ACR_ID" ||
        test "$(
          printf '%s' "$resume_resource_id" | tr '[:upper:]' '[:lower:]'
        )" != "$(
          printf '%s' "$RESUME_EXPECTED_ACR_ID" | tr '[:upper:]' '[:lower:]'
        )"; then
        printf 'Initial-deployment resume found a live resource beyond the registry target.\n' >&2
        exit 1
      fi
      RESUME_ACR_RESOURCE_SEEN=true
    done <<EOF
$RESUME_RESOURCE_IDS
EOF
    if test "$RESUME_HAS_ACR" = "true" &&
      test "$RESUME_ACR_RESOURCE_SEEN" != "true"; then
      printf 'The resumed registry state does not match the live resource inventory.\n' >&2
      exit 1
    fi
  fi
  unset RESUME_ACR RESUME_ACR_RESOURCE_SEEN RESUME_EXPECTED_ACR_ID
  unset RESUME_EXPECTED_RESOURCE_GROUP_ID RESUME_HAS_ACR RESUME_HAS_RANDOM
  unset RESUME_HAS_RESOURCE_GROUP RESUME_LIVE_ACR_ID RESUME_LIVE_RESOURCE_GROUP_ID
  unset RESUME_RESOURCE_GROUP RESUME_RESOURCE_IDS resume_resource_id
fi
if ! SECURE_TARGET_DIR="$(umask 077; mktemp -d \
  "$TERRAFORM_DIAGNOSTIC_ROOT/patchpage-registry-target.XXXXXX" 2>/dev/null)"; then
  printf 'Could not create a secure registry-target plan directory.\n' >&2
  exit 1
fi
cleanup_registry_target_plan() {
  if test -n "${SECURE_TARGET_DIR:-}" &&
    ! rm -rf -- "$SECURE_TARGET_DIR" 2>/dev/null; then
    printf 'Private registry-target plan cleanup failed.\n' >&2
    return 1
  fi
}
trap 'cleanup_registry_target_plan; tofu_diagnostic_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
REGISTRY_TARGET_PLAN="$SECURE_TARGET_DIR/registry-target.tfplan"
REGISTRY_TARGET_PLAN_JSON="$SECURE_TARGET_DIR/registry-target.json"
if ! private_tofu plan \
  -target=azurerm_container_registry.patchpage \
  -input=false \
  -out="$REGISTRY_TARGET_PLAN" >&3 ||
  ! { private_tofu show -json "$REGISTRY_TARGET_PLAN" > "$REGISTRY_TARGET_PLAN_JSON"; } 2>/dev/null; then
  printf 'OpenTofu could not create or inspect the registry-target plan.\n' >&2
  exit 1
fi
if ! plan_gate_accepts < "$REGISTRY_TARGET_PLAN_JSON"; then
  printf 'The registry-target plan contains a delete or replacement action.\n' >&2
  exit 1
fi
if ! private_tofu apply -input=false "$REGISTRY_TARGET_PLAN" >&3; then
  printf 'OpenTofu could not create or resume the resource group and container registry.\n' >&2
  exit 1
fi
if ! cleanup_registry_target_plan; then
  exit 1
fi
SECURE_TARGET_DIR=''
trap 'tofu_diagnostic_exit' 0
unset STATE_ADDRESSES WORKLOAD_RESOURCE_GROUP_EXISTS

if ! RESOURCE_GROUP="$(private_tofu output -raw resource_group_name)" ||
  test -z "$RESOURCE_GROUP"; then
  printf 'Could not load the workload resource group from OpenTofu.\n' >&2
  exit 1
fi
if test "$RESOURCE_GROUP" != "$TERRAFORM_RESOURCE_GROUP"; then
  printf 'OpenTofu returned an unexpected workload resource-group name.\n' >&2
  exit 1
fi
if ! LIVE_RESOURCE_GROUP_ID="$(
  private_az group show \
    --name "$RESOURCE_GROUP" \
    --query id \
    --output tsv 2>/dev/null
)"; then
  printf 'Could not verify the live workload resource group.\n' >&2
  exit 1
fi
EXPECTED_RESOURCE_GROUP_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP"
if test "$(
    printf '%s' "$LIVE_RESOURCE_GROUP_ID" | tr '[:upper:]' '[:lower:]'
  )" != "$(
    printf '%s' "$EXPECTED_RESOURCE_GROUP_ID" | tr '[:upper:]' '[:lower:]'
  )"; then
  printf 'The live workload resource group does not match the private expected identity.\n' >&2
  exit 1
fi
unset LIVE_RESOURCE_GROUP_ID EXPECTED_RESOURCE_GROUP_ID

if ! GIT_STATUS="$(private_git -C ../.. status --porcelain)" ||
  test -n "$GIT_STATUS" ||
  ! TAG="$(private_git -C ../.. rev-parse HEAD)" ||
  ! printf '%s\n' "$TAG" | grep -Eq '^[0-9a-f]{40}$'; then
  printf 'Initial builds require a clean Git worktree and full commit ID.\n' >&2
  exit 1
fi
unset GIT_STATUS
if ! ACR="$(private_tofu output -raw acr_name)"; then
  printf 'Could not read the container registry name from OpenTofu.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$ACR" | grep -Eq '^[a-z0-9]{5,50}$'; then
  printf 'OpenTofu returned an unexpected container registry name.\n' >&2
  exit 1
fi
if ! LOGIN_SERVER="$(private_tofu output -raw acr_login_server)"; then
  printf 'Could not read the registry login server from OpenTofu.\n' >&2
  exit 1
fi
if test "$LOGIN_SERVER" != "$ACR.azurecr.io"; then
  printf 'OpenTofu returned an unexpected registry login server.\n' >&2
  exit 1
fi
if ! LIVE_ACR_ID="$(
  private_az acr show \
    --name "$ACR" \
    --resource-group "$RESOURCE_GROUP" \
    --query id \
    --output tsv 2>/dev/null
)"; then
  printf 'Could not verify the live container registry.\n' >&2
  exit 1
fi
EXPECTED_ACR_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/$ACR"
if test "$(
    printf '%s' "$LIVE_ACR_ID" | tr '[:upper:]' '[:lower:]'
  )" != "$(
    printf '%s' "$EXPECTED_ACR_ID" | tr '[:upper:]' '[:lower:]'
  )"; then
  printf 'The live container registry does not match the private expected identity.\n' >&2
  exit 1
fi
unset LIVE_ACR_ID EXPECTED_ACR_ID TERRAFORM_RESOURCE_GROUP RESUME_INITIAL_DEPLOY

if ! INITIAL_BUILD_NONCE="$(
  od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
)" ||
  ! printf '%s\n' "$INITIAL_BUILD_NONCE" | grep -Eq '^[0-9a-f]{32}$'; then
  printf 'Could not create a unique initial image tag.\n' >&2
  exit 1
fi
INITIAL_BUILD_TAG="$TAG-$INITIAL_BUILD_NONCE"
unset INITIAL_BUILD_NONCE
if ! private_az acr build \
  --registry "$ACR" \
  --image "patchpage-server:$INITIAL_BUILD_TAG" \
  --build-arg "REVISION=$TAG" \
  --file apps/server/Dockerfile \
  ../.. >/dev/null 2>&1; then
  printf 'ACR did not complete the server image build successfully.\n' >&2
  exit 1
fi
if ! IMAGE_DIGEST="$(
  private_az acr manifest show-metadata \
    --registry "$ACR" \
    --name "patchpage-server:$INITIAL_BUILD_TAG" \
    --query digest \
    --output tsv
)"; then
  printf 'Could not resolve the built image to a registry digest.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  printf 'ACR returned an invalid image digest.\n' >&2
  exit 1
fi
IMAGE_REF="$LOGIN_SERVER/patchpage-server@$IMAGE_DIGEST"
unset INITIAL_BUILD_TAG

if ! (umask 077 && printf 'server_image = "%s"\n' \
  "$IMAGE_REF" > server-image.auto.tfvars); then
  printf 'Could not write server-image.auto.tfvars.\n' >&2
  exit 1
fi

if ! SECURE_PLAN_DIR="$(umask 077; mktemp -d \
  "$TERRAFORM_DIAGNOSTIC_ROOT/patchpage-initial-plan.XXXXXX" 2>/dev/null)"; then
  printf 'Could not create a secure OpenTofu plan directory.\n' >&2
  exit 1
fi
cleanup_initial_plan() {
  if test -n "${SECURE_PLAN_DIR:-}" &&
    ! rm -rf -- "$SECURE_PLAN_DIR" 2>/dev/null; then
    printf 'Private initial-plan cleanup failed.\n' >&2
    return 1
  fi
}
trap 'cleanup_initial_plan; tofu_diagnostic_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
INITIAL_PLAN="$SECURE_PLAN_DIR/initial.tfplan"
INITIAL_PLAN_JSON="$SECURE_PLAN_DIR/initial.json"

if ! private_tofu plan -input=false -out="$INITIAL_PLAN" >&3; then
  printf 'OpenTofu could not create the initial deployment plan.\n' >&2
  exit 1
fi
if ! { private_tofu show -json "$INITIAL_PLAN" > "$INITIAL_PLAN_JSON"; } 2>/dev/null; then
  printf 'Could not inspect the saved initial deployment plan.\n' >&2
  exit 1
fi
# No protected addresses: this is the one run that is supposed to create the
# drafts Storage account and the PostgreSQL server, so creating them is the
# expected outcome here rather than the sign of lost state it is everywhere else.
if ! plan_gate_accepts < "$INITIAL_PLAN_JSON"; then
  printf 'The initial deployment plan contains a delete or replacement action.\n' >&2
  exit 1
fi
if ! jq -r \
  '.resource_changes[] |
   select(.change.actions != ["no-op"]) |
   "\(.address): \(.change.actions | join(","))"' \
  "$INITIAL_PLAN_JSON" 2>/dev/null; then
  printf 'Could not render the initial deployment action summary.\n' >&2
  exit 1
fi
if ! private_tofu apply -input=false "$INITIAL_PLAN" >&3; then
  printf 'OpenTofu may have persisted a partial deployment. Stop: do not rerun either automated flow, delete resources, or replace state; preserve private diagnostics for second-operator recovery.\n' >&2
  exit 75
fi
tofu_resource_id() {
  printf '%s\n' "$1" |
    private_tofu console -no-color |
    jq -er 'select(type == "string" and length > 0)'
}
if ! EXPECTED_STORAGE_ACCOUNT_ID="$(
  tofu_resource_id 'azurerm_storage_account.drafts.id'
)" ||
  ! EXPECTED_POSTGRES_SERVER_ID="$(
    tofu_resource_id 'azurerm_postgresql_flexible_server.patchpage.id'
  )" ||
  ! EXPECTED_CONTAINER_APP_ID="$(
    tofu_resource_id 'azurerm_container_app.server.id'
  )" ||
  ! FINAL_ACR_ID="$(
    tofu_resource_id 'azurerm_container_registry.patchpage.id'
  )" ||
  ! CONTAINER_APP="$(private_tofu output -raw container_app_name)";
then
  printf 'Could not load the protected deployment identities.\n' >&2
  exit 1
fi
EXPECTED_ACR_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/$ACR"
EXPECTED_CONTAINER_APP_PATH="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/containerApps/$CONTAINER_APP"
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
  )" ||
  test "$(printf '%s' "$EXPECTED_CONTAINER_APP_ID" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_CONTAINER_APP_PATH" | tr '[:upper:]' '[:lower:]')" ||
  test "$(printf '%s' "$FINAL_ACR_ID" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_ACR_ID" | tr '[:upper:]' '[:lower:]')"; then
  printf 'A protected deployment identity is outside the expected workload.\n' >&2
  exit 1
fi

OPERATION_CONTAINER="patchpage-operations"
EXPECTED_STATE_STORAGE_ACCOUNT_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT"
EXPECTED_OPERATION_CONTAINER_ID="$EXPECTED_STATE_STORAGE_ACCOUNT_ID/blobServices/default/containers/$OPERATION_CONTAINER"
if ! LIVE_OPERATION_CONTAINER_ID="$(
  private_az storage container-rm show \
    --ids "$EXPECTED_OPERATION_CONTAINER_ID" \
    --query id \
    --output tsv
)" ||
  test "$(printf '%s' "$LIVE_OPERATION_CONTAINER_ID" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_OPERATION_CONTAINER_ID" | tr '[:upper:]' '[:lower:]')" ||
  ! OPERATION_CONTAINER_EXISTS="$(
    private_az storage container exists \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --name "$OPERATION_CONTAINER" \
      --auth-mode key \
      --query exists \
      --output tsv
  )" ||
  test "$OPERATION_CONTAINER_EXISTS" != "true" ||
  ! OPERATION_CONTAINER_BLOBS="$(
    private_az storage blob list \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --container-name "$OPERATION_CONTAINER" \
      --auth-mode key \
      --include d v \
      --num-results '*' \
      --query '[].name' \
      --output tsv
  )" ||
  test -n "$OPERATION_CONTAINER_BLOBS";
then
  printf 'The operation-lease container is unavailable or invalid.\n' >&2
  exit 1
fi
if ! OPERATION_BINDING_SHA256="$(operation_binding_sha256)" ||
  ! OPERATION_CONTAINER_METADATA="$(
    private_az storage container metadata show \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --name "$OPERATION_CONTAINER" \
      --auth-mode key \
      --output json
  )";
then
  printf 'Could not verify the operation-container workload binding.\n' >&2
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
  jq -e 'type == "object" and length == 0' >/dev/null; then
  if ! seal_operation_container_binding; then
    printf 'Could not atomically seal the operation-container workload binding.\n' >&2
    exit 1
  fi
elif ! printf '%s\n' "$OPERATION_CONTAINER_METADATA" |
  jq -e \
    --arg binding "$OPERATION_BINDING_SHA256" \
    'type == "object" and
     length == 1 and
     .patchpage_workload_binding_sha256 == $binding' >/dev/null; then
  printf 'The operation container is bound to a foreign workload.\n' >&2
  exit 1
fi
if ! OPERATION_CONTAINER_METADATA="$(
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
  printf 'Could not verify the sealed operation-container workload binding.\n' >&2
  exit 1
fi
unset OPERATION_BINDING_LEASE_ID
unset -f seal_operation_container_binding

ensure_exact_can_not_delete_lock() {
  protected_resource_id="$1"
  protected_lock_name="$2"
  expected_protected_lock_id="$protected_resource_id/providers/Microsoft.Authorization/locks/$protected_lock_name"
  if ! protected_lock_rows="$(
    private_az lock list \
      --resource "$protected_resource_id" \
      --query '[].[name,level,id]' \
      --output tsv
  )"; then
    return 1
  fi
  case "$protected_lock_rows" in
    "")
      private_az lock create \
        --name "$protected_lock_name" \
        --lock-type CanNotDelete \
        --resource "$protected_resource_id" >/dev/null ||
        return 1
      ;;
    *)
      test "$(printf '%s\n' "$protected_lock_rows" | wc -l | tr -d ' ')" = "1" ||
        return 1
      test "$(printf '%s\n' "$protected_lock_rows" | cut -f1)" = "$protected_lock_name" ||
        return 1
      test "$(printf '%s\n' "$protected_lock_rows" | cut -f2)" = "CanNotDelete" ||
        return 1
      test "$(printf '%s\n' "$protected_lock_rows" | cut -f3 | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$expected_protected_lock_id" | tr '[:upper:]' '[:lower:]')" ||
        return 1
      ;;
  esac
  protected_lock_properties="$(
    private_az lock show \
      --ids "$expected_protected_lock_id" \
      --query '[level,id]' \
      --output tsv
  )" ||
    return 1
  test "$(printf '%s\n' "$protected_lock_properties" | cut -f1)" = "CanNotDelete" &&
    test "$(printf '%s\n' "$protected_lock_properties" | cut -f2 | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$expected_protected_lock_id" | tr '[:upper:]' '[:lower:]')"
}
if ! ensure_exact_can_not_delete_lock \
  "$EXPECTED_STORAGE_ACCOUNT_ID" \
  protect-patchpage-drafts ||
  ! ensure_exact_can_not_delete_lock \
    "$EXPECTED_POSTGRES_SERVER_ID" \
    protect-patchpage-postgres;
then
  printf 'The exact persistent-resource deletion locks are missing or conflicting.\n' >&2
  exit 1
fi
unset -f ensure_exact_can_not_delete_lock tofu_resource_id
unset FINAL_ACR_ID EXPECTED_CONTAINER_APP_PATH LIVE_OPERATION_CONTAINER_ID
unset OPERATION_CONTAINER_BLOBS OPERATION_CONTAINER_EXISTS OPERATION_CONTAINER_METADATA
unset WORKLOAD_POSTGRES_SERVER WORKLOAD_STORAGE_ACCOUNT
if ! cleanup_initial_plan; then
  exit 1
fi
SECURE_PLAN_DIR=''
TERRAFORM_DIAGNOSTICS_COMPLETE=true
tofu_diagnostic_exit
trap - 0 HUP INT TERM
unset TERRAFORM_DIAGNOSTIC_DIR TERRAFORM_DIAGNOSTIC_LOG
unset TERRAFORM_DIAGNOSTICS_COMPLETE TERRAFORM_DIAGNOSTIC_FD_OPEN
unset -f cleanup_initial_plan cleanup_registry_target_plan tofu_diagnostic_exit
