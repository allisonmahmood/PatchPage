# PatchPage Azure self-hosting

This directory is a reusable Azure Container Apps deployment example. It requires an HTTPS public origin on a DNS hostname the deployer owns; it has no default or fallback to the PatchPage maintainer's hosted service.

Terraform creates:

- the resource group, Log Analytics workspace, Container Apps environment, and Container App;
- external platform ingress with insecure HTTP disabled;
- the Azure Container Registry and the app's managed identity and role assignments;
- the Blob Storage account and private container, plus the PostgreSQL server/database; and
- generated application secrets and the Container App environment variables, including `PATCHPAGE_PUBLIC_BASE_URL`, `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS`, the rate-limit settings, and, when configured, `PATCHPAGE_TRUST_PROXY`.

Terraform does **not** create or manage the remote-state resources, container image build, DNS zone or records, Container App custom hostname, managed certificate, or certificate binding. Those steps are deliberately manual and provider-neutral below. Terraform creates the initial Container App ingress and image, then ignores later changes to the whole ingress block and the image leaf. These exceptions prevent an infrastructure apply from overwriting the CLI-managed hostname, certificate binding, or release image. Resource postconditions and the live check below fail closed if any ignored security or routing invariant drifts. Any intentional ingress change therefore remains HITL: update the lifecycle rule and restore the manual binding as one coordinated operation.

The PostgreSQL server/database and Blob Storage account/container are persistent data, not release artifacts. Never delete the workload resource group, run `terraform destroy`, or replace a persistent resource to deploy, roll back, repair state, or repair DNS. Routine releases update only the Container App image by immutable registry digest.

## Prerequisites

- Terraform 1.9 or newer.
- Azure CLI, authenticated to the deployer's own Azure account with `az login`.
- Git for the image tag.
- `dig`, `curl`, `jq`, and `openssl` for the verification commands and workload-binding digest.
- Control of a public DNS hostname. A subdomain with a direct CNAME is recommended.

Do not run this example against a maintainer subscription. Set `SUBSCRIPTION_ID` privately to the exact target subscription. Every mutation block selects it and compares the active account without printing subscription, tenant, or caller details.

## State bootstrap

Create remote Terraform state once. Set `STATE_STORAGE_ACCOUNT` to a globally unique name containing 3-24 lowercase letters and digits and `STATE_KEY` to a unique environment-specific `*.tfstate` object name before running the block. Privately set `OPERATION_PRINCIPAL_ID` to the Microsoft Entra object ID that will run release/rollback operations and `OPERATION_PRINCIPAL_TYPE` to `User` or `ServicePrincipal`. Group principals are deliberately unsupported because Azure's transitive assigned-to inventory does not accept a group object ID. Never place those private values in this guide or a tracked shell file. Never reuse a state key across environments.
This guarded bootstrap intentionally supports one PatchPage workload per Azure subscription: its fixed state resource group and single operation container are bound to one state key/workload tuple. Do not reuse them for a second environment. Use a separate subscription, or design and review separately named state and operation resources before adding another workload.

The bootstrap creates exactly two private containers in the state account: `tfstate` for backend data and an empty, initially unbound `patchpage-operations` container used only for the operation lease. The initial deployment seals that empty operation container to one state/workload tuple before release use; an existing environment does the same during its first safety-guard adoption. Before granting access, the bootstrap inventories every direct, inherited, and group-derived role assignment effective at the exact `tfstate` container and rejects any assignment, including otherwise benign roles, so the operation identity cannot read state or obtain account keys. It separately creates or verifies one direct `Storage Blob Data Contributor` grant at the exact operation container. Other roles scoped only to that sibling container cannot reach `tfstate`. The state account itself receives the `CanNotDelete` management lock; the surrounding fixed resource group does not.

A normal run leaves `RESUME_STATE_BOOTSTRAP=false`. If this exact block failed after creating part of the dedicated state resource group, set it to `true`; the block accepts only the exact state account and a subset of those two intended containers, rejects foreign resources plus any unexpected active or recoverable container and any used or recoverable state key, then continues idempotently. It inventories immediately after resource-group creation and again immediately before the storage-account lock, so a concurrent foreign resource causes a fail-closed stop without locking that resource. Never use resume to adopt an unrelated state account. Do not commit the generated backend config. The bootstrap deliberately uses storage-account-key authorization for initial container provisioning because an Azure account with management-plane access does not automatically have Blob data-plane OAuth access. Azure CLI retrieves the key without writing it to the backend config; do not enable shell tracing or CLI debug output for this block.

<!-- guide-test:state-bootstrap -->

```sh
set +x
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
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
  printf 'Could not verify the Terraform state resource names.\n' >&2
  exit 1
fi
case "$STATE_ACCOUNT_NAME_AVAILABLE:$EXISTING_STATE_RESOURCE_GROUP" in
  true:true | true:false | false:true | false:false) ;;
  *)
    printf 'Azure returned an invalid Terraform state resource preflight result.\n' >&2
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
    printf 'Could not create the Terraform state resource group.\n' >&2
    exit 1
  fi
  if ! inventory_state_resource_group || test "$STATE_RESOURCE_COUNT" -ne 0; then
    printf 'The new Terraform state resource group is not empty.\n' >&2
    exit 1
  fi
fi
if ! STATE_RESOURCE_GROUP_LOCATION="$(
  private_az group show \
    --name "$STATE_RESOURCE_GROUP" \
    --query location \
    --output tsv
)"; then
  printf 'Could not verify the Terraform state resource group.\n' >&2
  exit 1
fi
if test "$STATE_RESOURCE_GROUP_LOCATION" != "$STATE_LOCATION"; then
  printf 'The Terraform state resource-group location does not match the private expected value.\n' >&2
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
    printf 'Could not create the Terraform state storage account.\n' >&2
    exit 1
  fi
fi
if ! STATE_STORAGE_ACCOUNT_PROPERTIES="$(
  private_az storage account show \
    --name "$STATE_STORAGE_ACCOUNT" \
    --resource-group "$STATE_RESOURCE_GROUP" \
    --output json
)"; then
  printf 'Could not verify the Terraform state storage account.\n' >&2
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
  printf 'The Terraform state storage account does not match the required identity or security properties.\n' >&2
  exit 1
fi
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
    test -z "$state_container_name" && continue
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
if ! inspect_state_containers; then
  printf 'Could not inspect the Terraform state account data plane.\n' >&2
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
  printf 'Could not inspect the existing Terraform state deletion lock.\n' >&2
  exit 1
fi
case "$STATE_EXISTING_LOCKS" in
  "") ;;
  *)
    if test "$(printf '%s\n' "$STATE_EXISTING_LOCKS" | wc -l | tr -d ' ')" != "1" ||
      test "$(printf '%s\n' "$STATE_EXISTING_LOCKS" | cut -f1)" != "CanNotDelete" ||
      test "$(printf '%s\n' "$STATE_EXISTING_LOCKS" | cut -f2 | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_STATE_LOCK_ID" | tr '[:upper:]' '[:lower:]')"; then
      printf 'A conflicting Terraform state lock requires explicit operator handling.\n' >&2
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
  printf 'The Terraform state key exists or has recoverable history; use the existing-environment flow.\n' >&2
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
  printf 'Could not read the existing Terraform state retention settings.\n' >&2
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
  printf 'Could not configure Terraform state versioning and soft-delete retention.\n' >&2
  exit 1
fi
if ! STATE_BLOB_PROPERTIES="$(
  private_az storage account blob-service-properties show \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --resource-group "$STATE_RESOURCE_GROUP" \
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
if test "$STATE_CONTAINER_EXISTS" = "false"; then
  if ! private_az storage container create \
    --name "$STATE_CONTAINER" \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --auth-mode key >/dev/null; then
    printf 'Could not create the Terraform state container.\n' >&2
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
  printf 'The Terraform state key exists, has recoverable history, or could not be verified; use the existing-environment flow.\n' >&2
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

if ! STATE_EXISTING_LOCKS="$(
  private_az lock list \
    --resource "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" \
    --query "[?name=='$STATE_LOCK_NAME'].[level,id]" \
    --output tsv
)"; then
  printf 'Could not inspect the existing Terraform state deletion lock.\n' >&2
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
      printf 'A conflicting Terraform state lock requires explicit operator handling.\n' >&2
      exit 1
    fi
    ;;
esac
if ! inventory_state_resource_group ||
  test "$STATE_RESOURCE_COUNT" -ne 1 ||
  test "$STATE_STORAGE_ACCOUNT_EXISTS" != "true"; then
  printf 'The Terraform state resource group contains an unexpected resource.\n' >&2
  exit 1
fi
if test -z "$STATE_EXISTING_LOCKS"; then
  if ! private_az lock create \
    --name "$STATE_LOCK_NAME" \
    --lock-type CanNotDelete \
    --resource "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" >/dev/null; then
    printf 'Could not create the Terraform state-account deletion lock.\n' >&2
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
  printf 'Terraform state-account deletion lock is missing or incorrectly scoped.\n' >&2
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
  printf 'Could not write the private Terraform backend configuration.\n' >&2
  exit 1
fi
```

## Deploy the Azure resources

Copy the example and edit both required values before the first Terraform command:

```sh
AZURE_DIR="$(git rev-parse --show-toplevel)/infra/azure"
cd "$AZURE_DIR"
cp terraform.tfvars.example terraform.tfvars
```

- Set `subscription_id` to the target subscription ID and export the same value as `SUBSCRIPTION_ID` in the shell.
- Replace the deliberately invalid `public_base_url` with the deployer's real origin. It must be HTTPS with a public DNS hostname and no credentials, port, path, query, fragment, or trailing slash.
- Keep `trust_proxy = null` for the initial deployment. This omits `PATCHPAGE_TRUST_PROXY` so forwarded client-address headers remain untrusted. Enable it only after completing [the client-IP HITL verification](#4-verify-and-enable-client-ip-attribution).
- Keep `max_html_bytes = 524288` unless you intentionally change the maximum accepted HTML artifact size.
- Keep `allow_anonymous_uploads = false` unless this self-hosted deployment intentionally accepts create-only requests without credentials. Terraform converts the boolean to `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS`; changing it does not enable anonymous uploads on any maintainer-hosted environment.
- Keep the rate-limit defaults unless the deployment needs a different local safety envelope: `protected_api_rate_limit_per_minute = 60`, `authenticated_upload_rate_limit_per_minute = 20`, and `anonymous_create_rate_limit_per_minute = 5`. Each value must be an integer from `1` through `10000`; Terraform wires them to the matching `PATCHPAGE_*_RATE_LIMIT_PER_MINUTE` Container App environment variables.

Terraform rejects the maintainer's domains, localhost/private-style names, reserved example names, common placeholder values, unsafe trusted-proxy values, and any Container App image that is not an immutable lowercase SHA-256 digest reference. The checked-in quickstart default exists only so the targeted registry bootstrap can run before the deployment image exists; every plan that includes the Container App must override it with the generated immutable image value. A normal first run leaves `RESUME_INITIAL_DEPLOY=false` and requires both empty state and an absent workload resource group. If this exact block failed during its targeted registry apply, set `RESUME_INITIAL_DEPLOY=true`: the block accepts only the registry target's data, random suffix, resource-group, and registry addresses; proves every already-managed live resource before mutation; reruns that fixed target; and then resumes through the same no-delete saved-plan gate. It rejects any broader or completed deployment state; use the existing-environment flow instead.
Before running the block, export the exact `STATE_STORAGE_ACCOUNT` and environment-specific `STATE_KEY` recorded by bootstrap, and set `TERRAFORM_DIAGNOSTIC_ROOT` to an existing private directory outside the repository. The block writes provider output to a randomized mode-0600 log below that root. After the saved final apply, it privately reads the exact workload resource IDs from Terraform, seals the empty operation container to the state/workload tuple with key authorization, and creates or verifies `CanNotDelete` only on the workload Storage account and PostgreSQL server. It rejects every foreign or inherited lock and never locks the workload resource group. On any failure or abort it preserves the log and prints only a generic reminder; inspect the configured root only in the private operator shell. A successful final apply plus safeguard verification removes the diagnostic directory.

<!-- guide-test:deploy-resources -->

```sh
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
  printf 'Could not write the private Terraform backend configuration.\n' >&2
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
  printf 'Could not create private Terraform state diagnostics.\n' >&2
  exit 1
fi
if STATE_ADDRESSES="$(terraform state list 2>&4)"; then
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
  printf 'Could not preserve the private Terraform state diagnostics.\n' >&2
  exit 1
fi
if test "$STATE_LIST_STATUS" -ne 0; then
  printf 'Could not verify the selected Terraform state.\n' >&2
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
    if ! RESUME_RESOURCE_GROUP="$(private_terraform output -raw resource_group_name)" ||
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
    if ! RESUME_ACR="$(private_terraform output -raw acr_name)" ||
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
trap 'cleanup_registry_target_plan; terraform_diagnostic_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
REGISTRY_TARGET_PLAN="$SECURE_TARGET_DIR/registry-target.tfplan"
REGISTRY_TARGET_PLAN_JSON="$SECURE_TARGET_DIR/registry-target.json"
if ! private_terraform plan \
  -target=azurerm_container_registry.patchpage \
  -input=false \
  -out="$REGISTRY_TARGET_PLAN" >&3 ||
  ! { private_terraform show -json "$REGISTRY_TARGET_PLAN" > "$REGISTRY_TARGET_PLAN_JSON"; } 2>/dev/null; then
  printf 'Terraform could not create or inspect the registry-target plan.\n' >&2
  exit 1
fi
if ! jq -e \
  '[.resource_changes[] |
    select(.change.actions | index("delete"))] |
   length == 0' "$REGISTRY_TARGET_PLAN_JSON" >/dev/null 2>&1; then
  printf 'The registry-target plan contains a delete or replacement action.\n' >&2
  exit 1
fi
if ! private_terraform apply -input=false "$REGISTRY_TARGET_PLAN" >&3; then
  printf 'Terraform could not create or resume the resource group and container registry.\n' >&2
  exit 1
fi
if ! cleanup_registry_target_plan; then
  exit 1
fi
SECURE_TARGET_DIR=''
trap 'terraform_diagnostic_exit' 0
unset STATE_ADDRESSES WORKLOAD_RESOURCE_GROUP_EXISTS

if ! RESOURCE_GROUP="$(private_terraform output -raw resource_group_name)" ||
  test -z "$RESOURCE_GROUP"; then
  printf 'Could not load the workload resource group from Terraform.\n' >&2
  exit 1
fi
if test "$RESOURCE_GROUP" != "$TERRAFORM_RESOURCE_GROUP"; then
  printf 'Terraform returned an unexpected workload resource-group name.\n' >&2
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
if ! ACR="$(private_terraform output -raw acr_name)"; then
  printf 'Could not read the container registry name from Terraform.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$ACR" | grep -Eq '^[a-z0-9]{5,50}$'; then
  printf 'Terraform returned an unexpected container registry name.\n' >&2
  exit 1
fi
if ! LOGIN_SERVER="$(private_terraform output -raw acr_login_server)"; then
  printf 'Could not read the registry login server from Terraform.\n' >&2
  exit 1
fi
if test "$LOGIN_SERVER" != "$ACR.azurecr.io"; then
  printf 'Terraform returned an unexpected registry login server.\n' >&2
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
  printf 'Could not create a secure Terraform plan directory.\n' >&2
  exit 1
fi
cleanup_initial_plan() {
  if test -n "${SECURE_PLAN_DIR:-}" &&
    ! rm -rf -- "$SECURE_PLAN_DIR" 2>/dev/null; then
    printf 'Private initial-plan cleanup failed.\n' >&2
    return 1
  fi
}
trap 'cleanup_initial_plan; terraform_diagnostic_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
INITIAL_PLAN="$SECURE_PLAN_DIR/initial.tfplan"
INITIAL_PLAN_JSON="$SECURE_PLAN_DIR/initial.json"

if ! private_terraform plan -input=false -out="$INITIAL_PLAN" >&3; then
  printf 'Terraform could not create the initial deployment plan.\n' >&2
  exit 1
fi
if ! { private_terraform show -json "$INITIAL_PLAN" > "$INITIAL_PLAN_JSON"; } 2>/dev/null; then
  printf 'Could not inspect the saved initial deployment plan.\n' >&2
  exit 1
fi
if ! jq -e \
  '[.resource_changes[] |
    select(.change.actions | index("delete"))] |
   length == 0' "$INITIAL_PLAN_JSON" >/dev/null 2>&1; then
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
if ! private_terraform apply -input=false "$INITIAL_PLAN" >&3; then
  printf 'Terraform may have persisted a partial deployment. Stop: do not rerun either automated flow, delete resources, or replace state; preserve private diagnostics for second-operator recovery.\n' >&2
  exit 1
fi
terraform_resource_id() {
  printf '%s\n' "$1" |
    private_terraform console -no-color |
    jq -er 'select(type == "string" and length > 0)'
}
if ! EXPECTED_STORAGE_ACCOUNT_ID="$(
  terraform_resource_id 'azurerm_storage_account.drafts.id'
)" ||
  ! EXPECTED_POSTGRES_SERVER_ID="$(
    terraform_resource_id 'azurerm_postgresql_flexible_server.patchpage.id'
  )" ||
  ! EXPECTED_CONTAINER_APP_ID="$(
    terraform_resource_id 'azurerm_container_app.server.id'
  )" ||
  ! FINAL_ACR_ID="$(
    terraform_resource_id 'azurerm_container_registry.patchpage.id'
  )" ||
  ! CONTAINER_APP="$(private_terraform output -raw container_app_name)";
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
  ! printf '%s\n' "$OPERATION_BINDING_SHA256" | grep -Eq '^[0-9a-f]{64}$' ||
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
unset -f ensure_exact_can_not_delete_lock terraform_resource_id
unset FINAL_ACR_ID EXPECTED_CONTAINER_APP_PATH LIVE_OPERATION_CONTAINER_ID
unset OPERATION_CONTAINER_BLOBS OPERATION_CONTAINER_EXISTS OPERATION_CONTAINER_METADATA
unset WORKLOAD_POSTGRES_SERVER WORKLOAD_STORAGE_ACCOUNT
if ! cleanup_initial_plan; then
  exit 1
fi
SECURE_PLAN_DIR=''
TERRAFORM_DIAGNOSTICS_COMPLETE=true
terraform_diagnostic_exit
trap - 0 HUP INT TERM
unset TERRAFORM_DIAGNOSTIC_DIR TERRAFORM_DIAGNOSTIC_LOG
unset TERRAFORM_DIAGNOSTICS_COMPLETE TERRAFORM_DIAGNOSTIC_FD_OPEN
unset -f cleanup_initial_plan cleanup_registry_target_plan terraform_diagnostic_exit
```
If the final saved-plan apply reports a partial deployment, `RESUME_INITIAL_DEPLOY` is intentionally not a recovery mechanism: it accepts only registry-target state. Freeze mutations, preserve the remote state and private provider diagnostics, and have a second operator reconcile every state address to its exact live Azure resource ID before reviewing a new no-delete completion plan. Do not remove, forget, import over, or replace a persistent resource to make a plan pass.


At this point Azure's generated Container App hostname is live over HTTPS, but the deployer-owned hostname and certificate are not configured yet.

## Normal app-only releases and rollback

Complete the custom-domain, managed-certificate, deployed-smoke, and private-canary steps below before using this routine release flow. Terraform ignores the Container App image leaf in addition to its existing CLI-owned ingress exception. A routine release therefore uses `az containerapp update` and never initializes, plans, or applies Terraform. Run it with a release identity that can build in the expected ACR, update the expected Container App, and use the dedicated operation-lease container, but cannot remove management locks, delete the resource group, read Terraform state, or administer PostgreSQL or workload Blob data.

Set the following values privately from the same verified deployment and state records before a release: `SUBSCRIPTION_ID`, `STATE_STORAGE_ACCOUNT`, `STATE_CONTAINER`, `STATE_KEY`, `RESOURCE_GROUP`, `CONTAINER_APP`, `ACR`, `EXPECTED_STORAGE_ACCOUNT_ID`, `EXPECTED_POSTGRES_SERVER_ID`, `LOGIN_SERVER`, `CONTAINER_APP_FQDN`, `PUBLIC_BASE_URL`, `CANARY_URL`, and `CANARY_MARKER`. `STATE_CONTAINER` must be the bootstrap-recorded `tfstate` container; the operation container name is fixed as `patchpage-operations`. Set `ROLLBACK_RECORD` to a durable private path outside the repository. The canary must predate the release. Release and rollback need management read only on the exact operation container, Container App, registry, and the two private lock IDs; they do not read the parent state Storage account.

The release, rollback, and infrastructure blocks share a documented Azure Storage container lease on the dedicated empty `patchpage-operations` container. Its sole immutable metadata value is the SHA-256 digest of a versioned tuple containing the subscription, state account and key, workload resource group, Container App, ACR, operation-container ID, and exact workload IDs. Every workflow recomputes and exactly verifies that binding before lease acquisition; a state record mixed with another environment therefore cannot serialize or mutate this workload. Each process proposes a cryptographically random GUID, acquires an infinite lease, and proves ownership by renewing with that exact ID before mutations. Release and exit cleanup also use only that exact ID. Missing or non-empty operation storage, foreign metadata, a held or unexpected lease state, and acquire, renew, or release failures all stop the workflow with generic public output. Authorization is deliberately separate: release, rollback, and stale recovery use Microsoft Entra login as the least-privileged operation principal, while initial deployment, first adoption, and later infrastructure verification use state-account-key authorization. The bootstrap grants `Storage Blob Data Contributor` to the private release/rollback operation principal at this container's exact resource scope only; that role must never be granted on `tfstate`, the state account, the workload account, or either resource group.

Container Apps can expose a new template and `latestRevisionName` before that revision is ready. In Single revision mode, the old revision can continue receiving all traffic while the new revision provisions. The workflows therefore pin the exact stable revision before mutation, require the update-returned or post-apply-observed revision to match Azure's `latestReadyRevisionName`, become the sole active provisioned 100%-traffic revision, and contain the exact immutable image. They do not require a warm replica because the service intentionally permits scale to zero; release and rollback immediately prove wake-up and serving behavior through the native/public health and canary requests. The same exact revision pin is rechecked before releasing the operation lease, so a later revision never satisfies an earlier operation's gate. If a mutation's result or post-mutation readiness cannot be proved, the workflow deliberately leaves the infinite lease held and emits a generic recovery-required error; use only the documented second-operator stale-lease recovery after independently proving the original process is gone.

<!-- guide-test:app-release -->

```sh
set +x
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
private_git() {
  git "$@" 2>/dev/null
}
private_curl() {
  curl "$@" 2>/dev/null
}
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
  exit 1
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
      --auth-mode login \
      --query exists \
      --output tsv
  )" || test "$operation_container_exists" != "true" ||
    ! operation_container_blobs="$(
      private_az storage blob list \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --container-name "$OPERATION_CONTAINER" \
        --auth-mode login \
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
        --auth-mode login \
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
verify_operation_lease() {
  private_az storage container lease renew \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$OPERATION_CONTAINER" \
    --auth-mode login \
    --lease-id "$OPERATION_LEASE_ID" \
    --output none >/dev/null
}
acquire_operation_lease() {
  verify_operation_container || return 1
  private_az storage container lease acquire \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$OPERATION_CONTAINER" \
    --auth-mode login \
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
    --auth-mode login \
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
      printf 'Operation lease cleanup requires second-operator review.\n' >&2
    fi
  fi
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
OPERATION_MUTATION_UNCERTAIN=false
trap 'operation_lease_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ! acquire_operation_lease; then
  printf 'The operation lease is unavailable; second-operator review may be required.\n' >&2
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
  --file apps/server/Dockerfile \
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
  exit 1
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
  exit 1
fi
unset EXPECTED_HEALTH_RESPONSE NATIVE_HEALTH_RESPONSE PUBLIC_HEALTH_RESPONSE
if ! CANARY_BODY="$(
  private_curl --proto '=https' --tlsv1.2 \
    --fail --silent --show-error \
    --connect-timeout 15 --max-time 120 \
    "$CANARY_URL"
)"; then
  printf 'Pre-existing canary request failed.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$CANARY_BODY" |
  grep -F -- "$CANARY_MARKER" >/dev/null; then
  printf 'Pre-existing canary marker verification failed.\n' >&2
  exit 1
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
unset -f verify_operation_container verify_operation_lease
unset -f container_app_readiness_recovery_required
unset -f poll_pinned_revision_stable verify_pinned_revision_stable
```

Keep `ROLLBACK_RECORD` until the release is verified. The record contains exactly the immutable pre-release `ROLLBACK_IMAGE_REF` and the immutable new `RELEASE_IMAGE_REF`. Set its private absolute path again, keep the verified deployment variables in the shell, and run this complete block. It disables tracing before reading the record, validates both exact lines without sourcing them as shell code, repeats the subscription, lock, and registry checks, acquires the shared operation mutex, and refuses rollback unless the current image still equals `RELEASE_IMAGE_REF`:

<!-- guide-test:app-rollback -->

```sh
set +x
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
private_git() {
  git "$@" 2>/dev/null
}
private_curl() {
  curl "$@" 2>/dev/null
}
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
  exit 1
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
      --auth-mode login \
      --query exists \
      --output tsv
  )" || test "$operation_container_exists" != "true" ||
    ! operation_container_blobs="$(
      private_az storage blob list \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --container-name "$OPERATION_CONTAINER" \
        --auth-mode login \
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
        --auth-mode login \
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
verify_operation_lease() {
  private_az storage container lease renew \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$OPERATION_CONTAINER" \
    --auth-mode login \
    --lease-id "$OPERATION_LEASE_ID" \
    --output none >/dev/null
}
acquire_operation_lease() {
  verify_operation_container || return 1
  private_az storage container lease acquire \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$OPERATION_CONTAINER" \
    --auth-mode login \
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
    --auth-mode login \
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
      printf 'Operation lease cleanup requires second-operator review.\n' >&2
    fi
  fi
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
: "${LOGIN_SERVER:?Set LOGIN_SERVER from the private verified deployment record}"
: "${CONTAINER_APP_FQDN:?Set CONTAINER_APP_FQDN from the private verified deployment record}"
: "${PUBLIC_BASE_URL:?Set PUBLIC_BASE_URL from the private verified deployment record}"
: "${CANARY_URL:?Set CANARY_URL from the private canary record}"
: "${CANARY_MARKER:?Set CANARY_MARKER from the private canary record}"
: "${ROLLBACK_RECORD:?Set ROLLBACK_RECORD to the durable private release record}"
if ! printf '%s\n' "$PUBLIC_BASE_URL" |
  grep -Eq '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'; then
  printf 'The private rollback verification endpoints are invalid.\n' >&2
  exit 1
fi
PUBLIC_HOSTNAME="$(
  printf '%s' "${PUBLIC_BASE_URL#https://}" | tr '[:upper:]' '[:lower:]'
)"
case "$CANARY_URL" in
  "$PUBLIC_BASE_URL"/d/*) CANARY_DRAFT_ID="${CANARY_URL#"$PUBLIC_BASE_URL/d/"}" ;;
  *)
    printf 'The private rollback verification endpoints are invalid.\n' >&2
    exit 1
    ;;
esac
if ! printf '%s\n' "$CANARY_DRAFT_ID" | grep -Eq '^[a-z0-9]{12}$' ||
  test "$CANARY_URL" != "$PUBLIC_BASE_URL/d/$CANARY_DRAFT_ID"; then
  printf 'The private rollback verification endpoints are invalid.\n' >&2
  exit 1
fi
unset CANARY_DRAFT_ID
case "$CANARY_MARKER" in
  *[![:space:]]*) ;;
  *)
    printf 'CANARY_MARKER must contain a non-whitespace character.\n' >&2
    exit 1
    ;;
esac
if ! printf '%s\n' "$ACR" | grep -Eq '^[a-z0-9]{5,50}$' ||
  test "$LOGIN_SERVER" != "$ACR.azurecr.io"; then
  printf 'The private container-registry identity is invalid.\n' >&2
  exit 1
fi
case "$ROLLBACK_RECORD" in
  /*) ;;
  *)
    printf 'ROLLBACK_RECORD must be an absolute private path.\n' >&2
    exit 1
    ;;
esac
if test -L "$ROLLBACK_RECORD"; then
  printf 'ROLLBACK_RECORD must not be a symbolic link.\n' >&2
  exit 1
fi
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
if ! ROLLBACK_RECORD_LINE_COUNT="$(
  { wc -l < "$ROLLBACK_RECORD"; } 2>/dev/null | tr -d '[:space:]'
)" ||
  test "$ROLLBACK_RECORD_LINE_COUNT" != "2"; then
  printf 'The private rollback record has an invalid format.\n' >&2
  exit 1
fi
if ! ROLLBACK_RECORD_VALUE="$(cat -- "$ROLLBACK_RECORD" 2>/dev/null)"; then
  printf 'Could not read the private rollback record.\n' >&2
  exit 1
fi
ROLLBACK_IMAGE_REF="$(
  printf '%s\n' "$ROLLBACK_RECORD_VALUE" |
    sed -n '1s/^ROLLBACK_IMAGE_REF=//p'
)"
RELEASE_IMAGE_REF="$(
  printf '%s\n' "$ROLLBACK_RECORD_VALUE" |
    sed -n '2s/^RELEASE_IMAGE_REF=//p'
)"
if test "$ROLLBACK_RECORD_VALUE" != "ROLLBACK_IMAGE_REF=$ROLLBACK_IMAGE_REF
RELEASE_IMAGE_REF=$RELEASE_IMAGE_REF"; then
  printf 'The private rollback record has an invalid format.\n' >&2
  exit 1
fi
unset ROLLBACK_RECORD_LINE_COUNT
case "$ROLLBACK_IMAGE_REF" in
  "$LOGIN_SERVER/patchpage-server@sha256:"*) ;;
  *)
    printf 'The rollback record does not contain an expected registry digest reference.\n' >&2
    exit 1
    ;;
esac
case "$RELEASE_IMAGE_REF" in
  "$LOGIN_SERVER/patchpage-server@sha256:"*) ;;
  *)
    printf 'The rollback record does not contain an expected release digest reference.\n' >&2
    exit 1
    ;;
esac
ROLLBACK_DIGEST="${ROLLBACK_IMAGE_REF##*@}"
RELEASE_DIGEST="${RELEASE_IMAGE_REF##*@}"
if ! printf '%s\n' "$ROLLBACK_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
  ! printf '%s\n' "$RELEASE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  printf 'The rollback record contains an invalid image digest.\n' >&2
  exit 1
fi
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
  ! PREFLIGHT_CURRENT_IMAGE_REF="$(
    printf '%s\n' "$CONTAINER_APP_PROPERTIES" |
      jq -er \
        '[.properties.template.containers[]? | select(.name == "server")] |
         select(length == 1) |
         .[0].image |
         select(type == "string" and length > 0)'
  )" ||
  test "$PREFLIGHT_CURRENT_IMAGE_REF" != "$RELEASE_IMAGE_REF"; then
  printf 'The Container App endpoint binding is missing or inconsistent.\n' >&2
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
OPERATION_MUTATION_UNCERTAIN=false
trap 'operation_lease_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ! acquire_operation_lease; then
  printf 'The operation lease is unavailable; second-operator review may be required.\n' >&2
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
  ! CURRENT_IMAGE_REF="$(
    printf '%s\n' "$PREFLIGHT_CONTAINER_APP_PROPERTIES" |
      jq -er \
        '[.properties.template.containers[]? | select(.name == "server")] |
         select(length == 1) |
         .[0].image |
         select(type == "string" and length > 0)'
  )" ||
  test "$CURRENT_IMAGE_REF" != "$RELEASE_IMAGE_REF" ||
  ! verify_pinned_revision_stable \
    "$PREUPDATE_REVISION_NAME" \
    "$RELEASE_IMAGE_REF"; then
  printf 'The rollback record is stale or the current revision is not stable.\n' >&2
  exit 1
fi
if ! VERIFIED_ROLLBACK_DIGEST="$(
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
if ! verify_operation_lease ||
  ! verify_pinned_revision_stable \
    "$PREUPDATE_REVISION_NAME" \
    "$RELEASE_IMAGE_REF"; then
  printf 'The operation lease or stable revision changed before rollback.\n' >&2
  exit 1
fi
OPERATION_MUTATION_UNCERTAIN=true
if ! UPDATED_REVISION_NAME="$(
  private_az containerapp update \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --container-name server \
  --image "$ROLLBACK_IMAGE_REF" \
  --query properties.latestRevisionName \
  --output tsv
)"; then
  printf 'Container App rollback failed.\n' >&2
  exit 1
fi
if test -z "$UPDATED_REVISION_NAME" ||
  test "$UPDATED_REVISION_NAME" = "$PREUPDATE_REVISION_NAME"; then
  container_app_readiness_recovery_required
fi
if ! poll_pinned_revision_stable \
  "$UPDATED_REVISION_NAME" \
  "$ROLLBACK_IMAGE_REF"; then
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
  printf 'Rollback health verification failed.\n' >&2
  exit 1
fi
unset EXPECTED_HEALTH_RESPONSE NATIVE_HEALTH_RESPONSE PUBLIC_HEALTH_RESPONSE
if ! CANARY_BODY="$(
  private_curl --proto '=https' --tlsv1.2 \
    --fail --silent --show-error \
    --connect-timeout 15 --max-time 120 \
    "$CANARY_URL"
)"; then
  printf 'Pre-existing canary request failed.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$CANARY_BODY" |
  grep -F -- "$CANARY_MARKER" >/dev/null; then
  printf 'Pre-existing canary marker verification failed.\n' >&2
  exit 1
fi
if ! verify_pinned_revision_stable \
  "$UPDATED_REVISION_NAME" \
  "$ROLLBACK_IMAGE_REF"; then
  container_app_readiness_recovery_required
fi
OPERATION_MUTATION_UNCERTAIN=false
if ! release_operation_lease; then
  printf 'Operation lease release failed; second-operator review is required.\n' >&2
  exit 1
fi
trap - 0 HUP INT TERM
unset -f acquire_operation_lease operation_lease_exit release_operation_lease
unset -f verify_operation_container verify_operation_lease
unset -f container_app_readiness_recovery_required
unset -f poll_pinned_revision_stable verify_pinned_revision_stable
unset ROLLBACK_RECORD_VALUE VERIFIED_ROLLBACK_DIGEST
```

The rollback block completes the deployed-image, native/public health, and pre-existing canary checks while it still owns the exact operation lease, then re-reads the final image before releasing that lease. Keep using the separate ignored-ingress invariant procedure after intentional ingress changes. Never roll back by running Terraform, selecting a mutable tag, deleting infrastructure, changing DNS, or pointing the public hostname at another environment.

## Existing-environment infrastructure changes

An image release is not an infrastructure change. PostgreSQL, Blob Storage, identities, networking, state, backup, locks, DNS, and certificates require a separate reviewed maintenance window. Before planning, privately set the expected subscription, backend key, state lineage, resource-group ID, Storage account ID, PostgreSQL server ID, registry ID, and Container App ID. The infrastructure operator must already be authorized to retrieve the state-account key for backend/state verification; this block uses that same key authorization to recompute and verify the operation-container workload binding and use the shared lease. Stop on any mismatch; never repair state by deleting the live resource.

Deployments created before these safety guards exist can use this same flow without replacing state or infrastructure. Set `ADOPT_SAFETY_GUARDS=true` only for that first reviewed run. For that adoption run only, privately set `OPERATION_PRINCIPAL_ID` and `OPERATION_PRINCIPAL_TYPE` for the least-privileged identity that will run release and rollback operations; it does not have to be the infrastructure caller. Before any adoption mutation, the block proves the existing state lineage and every exact live resource ID and rejects foreign locks. It creates a missing private operation container with its workload-binding metadata atomically, or seals an existing empty container only when it has no metadata; it never overwrites foreign metadata or container data. It grants only exact-container Blob access, raises state retention without shortening any longer live setting, creates only the two exact persistent-resource locks plus the separate state-account lock, and imports the two Terraform-managed workload locks at their deterministic IDs before planning. A partially completed adoption can be rerun: already imported exact lock addresses are verified rather than re-imported. It also resolves a legacy image tag to a separately verified registry digest, updates only the exact Container App under the shared lease, and atomically writes `server-image.auto.tfvars` as mode `0600` so Terraform agrees before planning.
Before running this flow, set `TERRAFORM_DIAGNOSTIC_ROOT` to an existing private directory outside the repository. Provider output remains in a randomized mode-0600 log below that root across the review pause. Failure or abort preserves it and emits only a generic reminder; a successful saved-plan apply removes it.

Required base state addresses before the first safety-guard adoption:

```txt
azurerm_resource_group.patchpage
azurerm_storage_account.drafts
azurerm_storage_container.drafts
azurerm_postgresql_flexible_server.patchpage
azurerm_container_registry.patchpage
azurerm_postgresql_flexible_server_database.patchpage
azurerm_container_app.server
```
After adoption, and for every normal infrastructure run, state must also contain `azurerm_management_lock.drafts_storage` and `azurerm_management_lock.patchpage_postgres` at the exact live lock IDs. The block imports them only in explicit adoption mode and otherwise fails if either binding is absent or mismatched.


<!-- guide-test:infrastructure-change -->

```sh
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
  exit 1
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
      printf 'Operation lease cleanup requires second-operator review.\n' >&2
    fi
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
OPERATION_MUTATION_UNCERTAIN=false
trap 'operation_lease_exit; cleanup_infrastructure_change; terraform_diagnostic_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ! acquire_operation_lease; then
  printf 'The operation lease is unavailable; second-operator review may be required.\n' >&2
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
      exit 1
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
if ! jq -r \
  '.resource_changes[] |
   select(.change.actions != ["no-op"]) |
   "\(.address): \(.change.actions | join(","))"' \
  "$INFRA_PLAN_JSON" 2>/dev/null; then
  printf 'Could not render the infrastructure action summary.\n' >&2
  exit 1
fi
```

Require a second operator to compare the private environment record, backup/restore evidence, and exact address/action inventory. Apply only the saved plan from the same shell after approval:

```sh
set +x
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
  exit 1
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
unset -f verify_operation_container verify_operation_lease
unset -f container_app_readiness_recovery_required
unset -f poll_pinned_revision_stable verify_pinned_revision_stable
```

### Recover an abandoned operation lease

An infinite lease survives `SIGKILL`, terminal loss, and operator-machine loss. Never break it merely because a command failed: the original process may still be mutating Azure. If the owner-specific exit trap could not release it, stop release, rollback, and infrastructure work. A second authorized operator must independently verify that the first process is gone, compare the live image and private operation record, and explicitly accept responsibility for recovery. Only that second operator runs the block below with the same private state and workload inputs used by release. It proves the exact operation-container management ID and recomputed immutable workload binding with Microsoft Entra login, without reading the parent state account, before it breaks the abandoned lease. It then proves recovery by acquiring, renewing, and releasing a new cryptographically random GUID lease. Any container-identity/binding mismatch, missing/non-empty container, or break, acquire, renew, or release failure remains fail-closed.

<!-- guide-test:stale-lease-recovery -->

```sh
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
```


Source-local retention is not an independent backup. Before accepting durable production data or changing a persistent resource, configure independently protected Blob and PostgreSQL backups outside the workload resource group, document the accepted RPO/RTO, and complete an isolated end-to-end restore. Re-run that drill at least every 90 days. Geo-replication improves regional availability but replicates deletion; management locks protect control-plane deletion but not Blob data-plane deletion.

Workload Storage defaults to geo-redundant replication (`GRS`). Existing environments that still use `LRS` will plan an in-place Storage account update on the first infrastructure apply after that default change; review cost and replication behavior before approving. PostgreSQL flexible-server backups remain platform-local by default (`geo_redundant_backup_enabled` is unset); regional database recovery therefore depends on the independent backup drill above rather than Storage GRS symmetry.

PostgreSQL backup retention defaults to 35 days (`postgres_backup_retention_days`). Existing environments left on the platform default (about 7 days) will plan an in-place flexible-server update on the first infrastructure apply after that default change; review the added backup storage cost before approving.

## Configure the custom domain and managed certificate

The commands below follow [Microsoft's managed-certificate flow](https://learn.microsoft.com/azure/container-apps/custom-domains-managed-certificates). They read Azure resource names and DNS values from Terraform so there are no copied resource-name placeholders.

Load the outputs and make sure the Azure CLI is using the same subscription:

<!-- guide-test:custom-domain-context -->

```sh
set +x
private_terraform() {
  terraform "$@" 2>/dev/null
}
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
if ! SUBSCRIPTION_ID="$(private_terraform output -raw subscription_id)" ||
  ! RESOURCE_GROUP="$(private_terraform output -raw resource_group_name)" ||
  ! CONTAINER_APP="$(private_terraform output -raw container_app_name)" ||
  ! CONTAINER_APP_ENVIRONMENT="$(private_terraform output -raw container_app_environment_name)" ||
  ! CONTAINER_APP_FQDN="$(private_terraform output -raw container_app_fqdn)" ||
  ! CONTAINER_APP_STATIC_IP="$(private_terraform output -raw container_app_environment_static_ip)" ||
  ! DOMAIN_VERIFICATION_ID="$(private_terraform output -raw custom_domain_verification_id)" ||
  ! PUBLIC_BASE_URL="$(private_terraform output -raw public_base_url)" ||
  ! CUSTOM_DOMAIN="$(private_terraform output -raw custom_domain_hostname)"; then
  printf 'Could not load the required Terraform outputs.\n' >&2
  exit 1
fi

for REQUIRED_OUTPUT in \
  "$SUBSCRIPTION_ID" \
  "$RESOURCE_GROUP" \
  "$CONTAINER_APP" \
  "$CONTAINER_APP_ENVIRONMENT" \
  "$CONTAINER_APP_FQDN" \
  "$CONTAINER_APP_STATIC_IP" \
  "$DOMAIN_VERIFICATION_ID" \
  "$PUBLIC_BASE_URL" \
  "$CUSTOM_DOMAIN"; do
  if test -z "$REQUIRED_OUTPUT"; then
    printf 'Terraform returned an empty required deployment output.\n' >&2
    exit 1
  fi
done
unset REQUIRED_OUTPUT

CUSTOM_DOMAIN="$(
  printf '%s\n' "$CUSTOM_DOMAIN" |
    sed 's/\.$//' |
    tr '[:upper:]' '[:lower:]'
)"
CONTAINER_APP_FQDN="$(
  printf '%s\n' "$CONTAINER_APP_FQDN" |
    sed 's/\.$//' |
    tr '[:upper:]' '[:lower:]'
)"
NORMALIZED_PUBLIC_BASE_URL="$(printf '%s\n' "$PUBLIC_BASE_URL" | tr '[:upper:]' '[:lower:]')"

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
if test "$NORMALIZED_PUBLIC_BASE_URL" != "https://$CUSTOM_DOMAIN"; then
  printf 'The public origin does not match the normalized custom hostname.\n' >&2
  exit 1
fi

printf 'Azure deployment context verified privately.\n'
```

### Verify the Terraform-ignored ingress invariants

Every Terraform plan and apply checks these invariants through resource postconditions. Because Terraform deliberately preserves the CLI-managed custom-domain state by ignoring the complete ingress block, also read the live Azure ingress before DNS or certificate work and after every intentional ingress change.

<!-- guide-test:ingress-verification -->

```sh
set +x
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
if ! LIVE_INGRESS="$(
  private_az containerapp ingress show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_APP" \
    --output json
)"; then
  printf 'Could not read live Container App ingress.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$LIVE_INGRESS" |
  jq -e '
    type == "object" and
    .external == true and
    .allowInsecure == false and
    .targetPort == 3000 and
    (.transport | type == "string" and ascii_downcase == "auto") and
    (
      .clientCertificateMode == null or
      (
        .clientCertificateMode |
        type == "string" and
        (length == 0 or ascii_downcase == "ignore")
      )
    ) and
    .corsPolicy == null and
    (.exposedPort == null or .exposedPort == 0) and
    (
      .additionalPortMappings == null or
      (.additionalPortMappings | type == "array" and length == 0)
    ) and
    (
      .stickySessions == null or
      (
        .stickySessions |
        type == "object" and
        (.affinity | type == "string" and ascii_downcase == "none")
      )
    ) and
    (
      .ipSecurityRestrictions == null or
      (.ipSecurityRestrictions | type == "array" and length == 0)
    ) and
    (.traffic | type == "array" and length == 1) and
    (.traffic[0].label == null or .traffic[0].label == "") and
    .traffic[0].latestRevision == true and
    .traffic[0].weight == 100
  ' >/dev/null; then
  printf '%s\n' \
    'Live ingress drifted from the required HTTPS-only port, certificate, CORS, IP restriction, exposed-port, sticky-session, and latest-revision routing policy.' >&2
  exit 1
fi
```

### 1. Create and verify DNS records

Use the DNS provider that is authoritative for the deployer's domain. Do not proxy the record while Azure issues or renews the managed certificate.

For a subdomain, create these records:

| Type | Host | Value |
| --- | --- | --- |
| CNAME | the relative subdomain label | `$CONTAINER_APP_FQDN` |
| TXT | `asuid.` plus the relative subdomain label | `$DOMAIN_VERIFICATION_ID` |

The CNAME must point directly to the generated Container App FQDN, without an intermediate CNAME or proxy. Set the real zone and relative label in the shell, then verify public DNS propagation:

```sh
set +x
private_dig() {
  dig "$@" 2>/dev/null
}
DNS_ZONE="${DNS_ZONE:?Set DNS_ZONE to the DNS zone you control}"
DNS_SUBDOMAIN="${DNS_SUBDOMAIN:?Set DNS_SUBDOMAIN to the relative hostname label}"
DNS_ZONE="$(printf '%s\n' "$DNS_ZONE" | sed 's/\.$//' | tr '[:upper:]' '[:lower:]')"
DNS_SUBDOMAIN="$(printf '%s\n' "$DNS_SUBDOMAIN" | sed 's/^\.*//;s/\.*$//' | tr '[:upper:]' '[:lower:]')"

if test "$CUSTOM_DOMAIN" != "$DNS_SUBDOMAIN.$DNS_ZONE"; then
  printf 'DNS_ZONE and DNS_SUBDOMAIN do not compose the configured hostname.\n' >&2
  exit 1
fi

ACTUAL_CNAME="$(
  private_dig +short CNAME "$CUSTOM_DOMAIN" |
    sed -n '1{s/\.$//;p;}' |
    tr '[:upper:]' '[:lower:]'
)"
if test "$ACTUAL_CNAME" != "$CONTAINER_APP_FQDN"; then
  printf 'The CNAME has not propagated to the expected target.\n' >&2
  exit 1
fi

ACTUAL_VERIFICATION_ID="$(private_dig +short TXT "asuid.$CUSTOM_DOMAIN" | tr -d '"')"
if ! printf '%s\n' "$ACTUAL_VERIFICATION_ID" | grep -Fqx -- "$DOMAIN_VERIFICATION_ID"; then
  printf 'The asuid TXT record has not propagated with the expected value.\n' >&2
  exit 1
fi

VALIDATION_METHOD="CNAME"
```

For an apex domain instead, create these records:

| Type | Host | Value |
| --- | --- | --- |
| A | `@` | `$CONTAINER_APP_STATIC_IP` |
| TXT | `asuid` | `$DOMAIN_VERIFICATION_ID` |

Set the real apex zone in the shell and verify propagation:

<!-- guide-test:apex-dns -->

```sh
set +x
private_dig() {
  dig "$@" 2>/dev/null
}
DNS_ZONE="${DNS_ZONE:?Set DNS_ZONE to the apex DNS zone you control}"
DNS_ZONE="$(printf '%s\n' "$DNS_ZONE" | sed 's/\.$//' | tr '[:upper:]' '[:lower:]')"

if test "$CUSTOM_DOMAIN" != "$DNS_ZONE"; then
  printf 'DNS_ZONE is not the configured apex hostname.\n' >&2
  exit 1
fi

if ! ACTUAL_A_RECORDS="$(private_dig +short A "$CUSTOM_DOMAIN")"; then
  printf 'The apex A lookup failed.\n' >&2
  exit 1
fi
ACTUAL_A_RECORDS="$(
  printf '%s\n' "$ACTUAL_A_RECORDS" |
    sed '/^$/d' |
    LC_ALL=C sort -u
)"
if test "$ACTUAL_A_RECORDS" != "$CONTAINER_APP_STATIC_IP"; then
  printf 'The apex A RRset does not contain only the expected address.\n' >&2
  exit 1
fi

if ! AAAA_RESPONSE="$(
  private_dig +noall +comments +answer AAAA "$CUSTOM_DOMAIN"
)"; then
  printf 'The apex AAAA lookup failed.\n' >&2
  exit 1
fi

AAAA_STATUS="$(
  printf '%s\n' "$AAAA_RESPONSE" |
    awk '
      /^;; ->>HEADER<<-/ {
        for (i = 1; i <= NF; i++) {
          if ($i == "status:") {
            status = $(i + 1)
            sub(/,$/, "", status)
            print status
            exit
          }
        }
      }
    '
)"
if test "$AAAA_STATUS" != "NOERROR"; then
  printf 'The apex AAAA lookup returned an unexpected DNS status.\n' >&2
  exit 1
fi

ACTUAL_AAAA_RECORDS="$(
  printf '%s\n' "$AAAA_RESPONSE" |
    awk '$1 !~ /^;/ && toupper($4) == "AAAA" { print }'
)"
if test -n "$ACTUAL_AAAA_RECORDS"; then
  printf 'The apex must not publish an AAAA record.\n' >&2
  exit 1
fi

ACTUAL_VERIFICATION_ID="$(private_dig +short TXT "asuid.$CUSTOM_DOMAIN" | tr -d '"')"
if ! printf '%s\n' "$ACTUAL_VERIFICATION_ID" | grep -Fqx -- "$DOMAIN_VERIFICATION_ID"; then
  printf 'The asuid TXT record has not propagated with the expected value.\n' >&2
  exit 1
fi

VALIDATION_METHOD="HTTP"
```

Certificate authorities apply the first CAA RRset found while walking from the custom hostname toward the DNS root. At each original tree label, CAA lookup follows and normalizes its CNAME chain first; if that alias-aware lookup is empty, the walk resumes at the original label's parent, as required by RFC 8659. Ambiguous targets, loops, excessive alias depth, command errors, missing status, and every DNS status other than `NOERROR` fail closed. That effective policy, wherever it is inherited from, must allow DigiCert with an unparameterized `issue "digicert.com"` record. Parameterized DigiCert records fail this check because the guide cannot prove that Azure satisfies issuer-specific constraints. Any issuer-critical property outside the standard `issue`, `issuewild`, and `iodef` tags also fails closed because the guide cannot prove DigiCert supports it:

<!-- guide-test:caa-policy -->

```sh
set +x
private_dig() {
  dig "$@" 2>/dev/null
}
CAA_TREE_NAME="$CUSTOM_DOMAIN"
CAA_LOOKUP_NAME=""
CAA_RECORDS=""

while test -n "$CAA_TREE_NAME"; do
  CAA_QUERY_NAME="$CAA_TREE_NAME"
  CAA_CNAME_SEEN="|"
  CAA_CNAME_HOPS=0

  while :; do
    case "$CAA_CNAME_SEEN" in
      *"|$CAA_QUERY_NAME|"*)
        printf 'CAA lookup encountered a CNAME loop.\n' >&2
        exit 1
        ;;
    esac
    CAA_CNAME_SEEN="$CAA_CNAME_SEEN$CAA_QUERY_NAME|"
    CAA_CNAME_HOPS=$((CAA_CNAME_HOPS + 1))
    if test "$CAA_CNAME_HOPS" -gt 16; then
      printf 'CAA lookup exceeded the maximum CNAME depth.\n' >&2
      exit 1
    fi

    if ! CNAME_RESPONSE="$(
      private_dig +noall +comments +answer CNAME "$CAA_QUERY_NAME"
    )"; then
      printf 'CNAME lookup failed during CAA evaluation.\n' >&2
      exit 1
    fi

    CNAME_STATUS="$(
      printf '%s\n' "$CNAME_RESPONSE" |
        awk '
          /^;; ->>HEADER<<-/ {
            for (i = 1; i <= NF; i++) {
              if ($i == "status:") {
                status = $(i + 1)
                sub(/,$/, "", status)
                print status
                exit
              }
            }
          }
        '
    )"
    if test "$CNAME_STATUS" != "NOERROR"; then
      printf 'CNAME lookup returned an unexpected DNS status during CAA evaluation.\n' >&2
      exit 1
    fi

    if ! CNAME_TARGETS="$(
      printf '%s\n' "$CNAME_RESPONSE" |
        awk -v expected="$CAA_QUERY_NAME" '
          $1 ~ /^;/ || NF == 0 { next }
          {
            owner = tolower($1)
            sub(/\.$/, "", owner)
            if (NF != 5 ||
                owner != expected ||
                $2 !~ /^[0-9]+$/ ||
                toupper($3) != "IN" ||
                toupper($4) != "CNAME") {
              exit 1
            }
            target = tolower($5)
            sub(/\.$/, "", target)
            if (target == "") exit 1
            print target
          }
        '
    )"; then
      printf 'CNAME lookup returned malformed or unexpected answer data.\n' >&2
      exit 1
    fi
    CNAME_TARGET_COUNT="$(
      printf '%s\n' "$CNAME_TARGETS" |
        awk 'NF { count++ } END { print count + 0 }'
    )"
    case "$CNAME_TARGET_COUNT" in
      0)
        break
        ;;
      1)
        CNAME_TARGET="$CNAME_TARGETS"
        if test -z "$CNAME_TARGET"; then
          printf 'CAA lookup received an empty CNAME target.\n' >&2
          exit 1
        fi
        CAA_QUERY_NAME="$CNAME_TARGET"
        ;;
      *)
        printf 'CAA lookup received ambiguous CNAME targets.\n' >&2
        exit 1
        ;;
    esac
  done

  if ! CAA_RESPONSE="$(
    private_dig +noall +comments +answer CAA "$CAA_QUERY_NAME"
  )"; then
    printf 'CAA lookup failed.\n' >&2
    exit 1
  fi

  CAA_STATUS="$(
    printf '%s\n' "$CAA_RESPONSE" |
      awk '
        /^;; ->>HEADER<<-/ {
          for (i = 1; i <= NF; i++) {
            if ($i == "status:") {
              status = $(i + 1)
              sub(/,$/, "", status)
              print status
              exit
            }
          }
        }
      '
  )"
  if test "$CAA_STATUS" != "NOERROR"; then
    printf 'CAA lookup returned an unexpected DNS status.\n' >&2
    exit 1
  fi


  if ! CAA_RECORDS="$(
    printf '%s\n' "$CAA_RESPONSE" |
      awk -v expected="$CAA_QUERY_NAME" '
        function valid_value(value,    character, escaped, i) {
          if (length(value) < 2 ||
              substr(value, 1, 1) != "\"" ||
              substr(value, length(value), 1) != "\"") {
            return 0
          }
          escaped = 0
          for (i = 2; i < length(value); i++) {
            character = substr(value, i, 1)
            if (escaped) {
              escaped = 0
            } else if (character == "\\") {
              escaped = 1
            } else if (character == "\"") {
              return 0
            }
          }
          return !escaped
        }

        $1 ~ /^;/ || NF == 0 { next }
        {
          owner = tolower($1)
          sub(/\.$/, "", owner)
          if (owner != expected ||
              $2 !~ /^[0-9]+$/ ||
              toupper($3) != "IN" ||
              toupper($4) != "CAA" ||
              NF < 7 ||
              $5 !~ /^[0-9]+$/ ||
              ($5 + 0) > 255 ||
              $6 !~ /^[A-Za-z0-9]+$/ ||
              length($6) > 15) {
            exit 1
          }
          value = ""
          for (i = 7; i <= NF; i++) {
            value = value (i == 7 ? "" : " ") $i
          }
          if (!valid_value(value)) exit 1
          print $5, $6, value
        }
      '
  )"; then
    printf 'CAA lookup returned malformed CAA record data.\n' >&2
    exit 1
  fi
  CAA_LOOKUP_NAME="$CAA_QUERY_NAME"
  test -z "$CAA_RECORDS" || break

  case "$CAA_TREE_NAME" in
    *.*) CAA_TREE_NAME="${CAA_TREE_NAME#*.}" ;;
    *) CAA_TREE_NAME="" ;;
  esac
done

if test -n "$CAA_RECORDS"; then
  if ! printf '%s\n' "$CAA_RECORDS" |
    awk '
      {
        tag = tolower($2)
        flags = $1 + 0
        if ((int(flags / 128) % 2) == 1 &&
            tag != "issue" && tag != "issuewild" && tag != "iodef") {
          unsupported_critical = 1
        }
        value = ""
        for (i = 3; i <= NF; i++) {
          value = value (i == 3 ? "" : " ") $i
        }
        if (length(value) >= 2 && substr(value, 1, 1) == "\"" &&
            substr(value, length(value), 1) == "\"") {
          value = substr(value, 2, length(value) - 2)
        }
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        value = tolower(value)
        if (tag == "issue" && value == "digicert.com") found = 1
      }
      END { exit found && !unsupported_critical ? 0 : 1 }
    '; then
    printf 'The effective CAA policy does not allow DigiCert.\n' >&2
    exit 1
  fi
  printf 'CAA policy verification passed.\n'
else
  printf 'No inherited CAA policy was found.\n'
fi
```

The direct CNAME/A record, public ingress, and DigiCert CAA permission must remain in place for certificate renewal.

### 2. Add the hostname, create the managed certificate, and bind it

`hostname add` registers the validated custom hostname. The subsequent `hostname bind` command finds or creates Azure's free managed certificate, waits for issuance, and binds it to the hostname. For a subdomain, `VALIDATION_METHOD` is `CNAME`; for an apex domain it is `HTTP`.

<!-- guide-test:hostname-mutation -->

```sh
set +x
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
VALIDATION_METHOD="${VALIDATION_METHOD:?Run the matching DNS section first}"
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?Load the Terraform outputs first}"

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

if ! private_az containerapp hostname add \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --hostname "$CUSTOM_DOMAIN" >/dev/null; then
  printf 'Could not add the expected custom hostname to the Container App.\n' >&2
  exit 1
fi

if ! MANAGED_CERTIFICATE_ID="$(
  private_az containerapp hostname bind \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --hostname "$CUSTOM_DOMAIN" \
  --environment "$CONTAINER_APP_ENVIRONMENT" \
  --validation-method "$VALIDATION_METHOD" \
  --query "[?name=='$CUSTOM_DOMAIN'].certificateId | [0]" \
  --output tsv
)"; then
  printf 'Could not create and bind the expected managed certificate.\n' >&2
  exit 1
fi
if test -z "$MANAGED_CERTIFICATE_ID"; then
  printf 'Azure did not return the bound managed-certificate resource ID.\n' >&2
  exit 1
fi
```

Certificate issuance can take several minutes. The bind command captured the exact managed-certificate resource ID selected by Azure. After issuance, confirm that this exact resource succeeded for the normalized hostname and that the SNI binding still points to the same ID:

<!-- guide-test:certificate-binding -->

```sh
set +x
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
MANAGED_CERTIFICATE_ID="${MANAGED_CERTIFICATE_ID:?Run the hostname binding block first}"

if ! MANAGED_CERTIFICATES="$(
  private_az containerapp env certificate list \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_APP_ENVIRONMENT" \
    --managed-certificates-only \
    --certificate "$MANAGED_CERTIFICATE_ID" \
    --query '[].[id,properties.subjectName,properties.provisioningState]' \
    --output tsv
)"; then
  printf 'Could not read the expected bound managed certificate.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$MANAGED_CERTIFICATES" |
  awk -F '\t' \
    -v expected_domain="$CUSTOM_DOMAIN" \
    -v expected_id="$MANAGED_CERTIFICATE_ID" '
    {
      rows++
      id = $1
      subject = tolower($2)
      sub(/^cn=/, "", subject)
      sub(/\.$/, "", subject)
      if (id == expected_id && subject == expected_domain &&
          tolower($3) == "succeeded") exact_matches++
    }
    END { exit rows == 1 && exact_matches == 1 ? 0 : 1 }
  '; then
  printf 'The bound managed certificate does not match the expected private values.\n' >&2
  exit 1
fi

if ! HOSTNAME_BINDINGS="$(
  private_az containerapp hostname list \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_APP" \
    --query '[].[name,bindingType,certificateId]' \
    --output tsv
)"; then
  printf 'Could not list Container App hostname bindings.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$HOSTNAME_BINDINGS" |
  awk -F '\t' \
    -v expected_domain="$CUSTOM_DOMAIN" \
    -v expected_id="$MANAGED_CERTIFICATE_ID" '
    {
      hostname = tolower($1)
      sub(/\.$/, "", hostname)
      if (hostname == expected_domain) {
        hostname_rows++
        if (tolower($2) == "snienabled" && $3 == expected_id) exact_matches++
      }
    }
    END { exit hostname_rows == 1 && exact_matches == 1 ? 0 : 1 }
  '; then
  printf 'The expected SNI hostname binding is not present.\n' >&2
  exit 1
fi
```

### 3. Verify HTTPS and the configured upload origin

Set `CANARY_RECORD` to a private path outside the repository if this first successful smoke should become the durable pre-release canary. The block writes the URL and marker there with mode `0600`; it never prints either value.
Terraform disables insecure ingress. Verify the exact HTTPS redirect, health response, authenticated upload response, configured draft origin, and fetched draft content as one fail-closed smoke. This uses the sensitive bootstrap token from Terraform state; do not enable shell tracing or paste its value into logs.

<!-- guide-test:deployed-smoke -->

```sh
(
set +x
private_terraform() {
  terraform "$@" 2>/dev/null
}
private_curl() {
  curl "$@" 2>/dev/null
}
private_git() {
  git "$@" 2>/dev/null
}
if test -n "${CANARY_RECORD:-}"; then
  case "$CANARY_RECORD" in
    /*) ;;
    *)
      printf 'CANARY_RECORD must be an absolute private path outside the repository.\n' >&2
      exit 1
      ;;
  esac
  CANARY_RECORD_NAME="${CANARY_RECORD##*/}"
  CANARY_RECORD_PARENT="${CANARY_RECORD%/*}"
  test -n "$CANARY_RECORD_PARENT" || CANARY_RECORD_PARENT="/"
  if ! printf '%s\n' "$CANARY_RECORD_NAME" |
    grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' ||
    ! CANARY_RECORD_PARENT="$(
      CDPATH= cd -- "$CANARY_RECORD_PARENT" 2>/dev/null && pwd -P
    )"; then
    printf 'CANARY_RECORD must have an existing private parent and safe filename.\n' >&2
    exit 1
  fi
  CANARY_RECORD="$CANARY_RECORD_PARENT/$CANARY_RECORD_NAME"
  if ! REPO_ROOT="$(private_git rev-parse --show-toplevel)" ||
    ! REPO_ROOT="$(CDPATH= cd -- "$REPO_ROOT" 2>/dev/null && pwd -P)"; then
    printf 'Could not locate the canonical repository root for CANARY_RECORD.\n' >&2
    exit 1
  fi
  case "$CANARY_RECORD" in
    "$REPO_ROOT" | "$REPO_ROOT"/*)
      printf 'CANARY_RECORD must remain outside the repository.\n' >&2
      exit 1
      ;;
  esac
  if test -L "$CANARY_RECORD" ||
    { test -e "$CANARY_RECORD" && ! test -f "$CANARY_RECORD"; }; then
    printf 'CANARY_RECORD must be absent or an existing regular file, never a directory or symbolic link.\n' >&2
    exit 1
  fi
  unset CANARY_RECORD_NAME CANARY_RECORD_PARENT REPO_ROOT
fi
if ! SMOKE_TMP_DIR="$(mktemp -d)"; then
  printf 'Could not create a temporary directory for the deployed smoke.\n' >&2
  exit 1
fi
UPLOAD_HEADER_FILE=''
CANARY_RECORD_TEMP=''
SMOKE_MARKER="PATCHPAGE_AZURE_SMOKE_${SMOKE_TMP_DIR##*/}"

smoke_cleanup() {
  unset BOOTSTRAP_API_TOKEN
  if test -n "$CANARY_RECORD_TEMP"; then
    rm -f -- "$CANARY_RECORD_TEMP" 2>/dev/null
  fi
  rm -rf "$SMOKE_TMP_DIR"
}
trap 'smoke_cleanup' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

smoke_fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

EXPECTED_HEALTH_URL="https://$CUSTOM_DOMAIN/healthz"
if ! HTTP_STATUS="$(
  private_curl --silent --show-error \
    --output /dev/null \
    --dump-header "$SMOKE_TMP_DIR/http.headers" \
    --write-out '%{http_code}' \
    "http://$CUSTOM_DOMAIN/healthz"
)"; then
  smoke_fail 'The HTTP health request failed.'
fi
if test "$HTTP_STATUS" != "301"; then
  smoke_fail "Expected HTTP status 301, received HTTP $HTTP_STATUS."
fi
if ! HTTP_LOCATION="$(
  awk '
    tolower($1) == "location:" {
      value = $0
      sub(/^[^:]*:[[:space:]]*/, "", value)
      sub(/\r$/, "", value)
      locations++
      location = value
    }
    END {
      if (locations != 1) exit 1
      print location
    }
  ' "$SMOKE_TMP_DIR/http.headers"
)"; then
  smoke_fail 'The HTTP response did not contain exactly one Location header.'
fi
if test "$HTTP_LOCATION" != "$EXPECTED_HEALTH_URL"; then
  smoke_fail 'The HTTP redirect Location did not match the expected private URL.'
fi

if ! HTTPS_HEALTH_STATUS="$(
  private_curl --proto '=https' --tlsv1.2 \
    --silent --show-error \
    --output "$SMOKE_TMP_DIR/health.body" \
    --write-out '%{http_code}' \
    "$EXPECTED_HEALTH_URL"
)"; then
  smoke_fail 'The HTTPS health request failed.'
fi
if test "$HTTPS_HEALTH_STATUS" != "200"; then
  smoke_fail "Expected HTTPS health status 200, received $HTTPS_HEALTH_STATUS."
fi
if ! HTTPS_HEALTH_BODY="$(cat "$SMOKE_TMP_DIR/health.body")"; then
  smoke_fail 'Could not read the HTTPS health response body.'
fi
if test "$HTTPS_HEALTH_BODY" != '{"ok":true}'; then
  smoke_fail 'The HTTPS health response body was unexpected.'
fi

if ! BOOTSTRAP_API_TOKEN="$(private_terraform output -raw bootstrap_api_token)"; then
  smoke_fail 'Could not read the bootstrap API token from Terraform.'
fi
if test -z "$BOOTSTRAP_API_TOKEN"; then
  smoke_fail 'Terraform returned an empty bootstrap API token.'
fi
UPLOAD_HEADER_FILE="$SMOKE_TMP_DIR/upload.headers"
if ! (umask 077 && printf 'Authorization: Bearer %s\n' \
  "$BOOTSTRAP_API_TOKEN" > "$UPLOAD_HEADER_FILE") 2>/dev/null ||
   ! chmod 600 "$UPLOAD_HEADER_FILE"; then
  smoke_fail 'Could not create the protected upload authorization header.'
fi
unset BOOTSTRAP_API_TOKEN
if ! UPLOAD_PAYLOAD="$(
  jq -cn --arg marker "$SMOKE_MARKER" \
    '{
      html: (
        "<!doctype html><html><head><title>Azure smoke test</title></head><body><h1>" +
        $marker +
        "</h1></body></html>"
      ),
      filename: "azure-smoke.html"
    }'
)"; then
  smoke_fail 'Could not safely encode the unique smoke upload payload.'
fi

if ! UPLOAD_STATUS="$(
  private_curl --proto '=https' --tlsv1.2 \
    --silent --show-error \
    --output "$SMOKE_TMP_DIR/upload.json" \
    --write-out '%{http_code}' \
    --request POST \
    --header "@$UPLOAD_HEADER_FILE" \
    --header "Content-Type: application/json" \
    --data "$UPLOAD_PAYLOAD" \
    "$PUBLIC_BASE_URL/api/uploads"
)"; then
  smoke_fail 'The authenticated upload request failed.'
fi
if test "$UPLOAD_STATUS" != "201"; then
  smoke_fail "Expected upload status 201, received $UPLOAD_STATUS."
fi
if ! DRAFT_URL="$(
  jq -er \
    --arg origin "$PUBLIC_BASE_URL" \
    'select(.ok == true) |
     select((.draftId | type) == "string") |
     select(.draftId | test("^[a-z0-9]{12}$")) |
     select(.publicUrl == ($origin + "/d/" + .draftId)) |
     .publicUrl' \
    "$SMOKE_TMP_DIR/upload.json"
)"; then
  smoke_fail 'Upload response did not contain the exact configured-origin draft URL.'
fi

if ! DRAFT_STATUS="$(
  private_curl --proto '=https' --tlsv1.2 \
    --silent --show-error \
    --output "$SMOKE_TMP_DIR/draft.html" \
    --write-out '%{http_code}' \
    "$DRAFT_URL"
)"; then
  smoke_fail 'The uploaded draft fetch failed.'
fi
if test "$DRAFT_STATUS" != "200"; then
  smoke_fail "Expected uploaded draft status 200, received $DRAFT_STATUS."
fi
if ! grep -Fq -- "$SMOKE_MARKER" "$SMOKE_TMP_DIR/draft.html"; then
  smoke_fail 'The fetched draft did not contain this run’s exact smoke marker.'
fi

if test -n "${CANARY_RECORD:-}"; then
  if ! CANARY_RECORD_TEMP="$(
    mktemp "${CANARY_RECORD}.tmp.XXXXXX" 2>/dev/null
  )" ||
    ! chmod 600 "$CANARY_RECORD_TEMP" 2>/dev/null; then
    smoke_fail 'Could not create the private canary record.'
  fi
  if ! (umask 077 && printf 'CANARY_URL=%s\nCANARY_MARKER=%s\n' \
    "$DRAFT_URL" "$SMOKE_MARKER" > "$CANARY_RECORD_TEMP") 2>/dev/null ||
    ! mv -f -- "$CANARY_RECORD_TEMP" "$CANARY_RECORD" 2>/dev/null; then
    smoke_fail 'Could not write the private canary record.'
  fi
  CANARY_RECORD_TEMP=''
fi
printf 'Deployed smoke passed.\n'
)
```

Repository tests execute these guide blocks against failure-injection stubs, but they do not contact Azure or public DNS. DNS, certificate, HTTPS, and upload acceptance against the deployer's real subscription and zone remains intentionally human-in-the-loop.

### 4. Verify and enable client IP attribution

Terraform cannot determine Azure Container Apps' forwarding chain or prove which peer addresses reach this application. The `trust_proxy` default is therefore `null`: the Container App receives no `PATCHPAGE_TRUST_PROXY` variable, Fastify ignores `X-Forwarded-For`, and persisted upload `source_ip` values identify the direct socket peer. Do not replace this default with a guessed Azure hop count or network.

Complete this verification in the real deployment:

1. Inventory every reachable path to the Container App: the generated `*.azurecontainerapps.io` hostname, the custom hostname, and any CDN, WAF, gateway, or additional reverse proxy. A fixed hop count is valid only if every path that remains reachable has the same depth.
2. With `trust_proxy = null`, send controlled authenticated uploads from an independently known public client address through each path. The resulting `draft_versions.source_ip` shows the socket peer seen by PatchPage. PatchPage deliberately does not persist the raw `X-Forwarded-For` chain, so inspect that header at the application boundary with an approved temporary diagnostic revision or equivalent ingress observability. Remove temporary header logging after the observation and do not log API tokens.
3. Record the socket peer, the right-to-left forwarded chain, whether each proxy overwrites or appends incoming forwarding headers, and whether the observed path is invariant. Repeat enough requests and revisions to detect changing peer addresses.
4. Choose either a decimal count from `1` through `32` for a proven fixed-depth path, or comma-separated literal IP/CIDR entries for stable, verified proxy source networks. Terraform rejects deprecated `::` plus dotted-IPv4 transitional aliases, IPv4-mapped IPv6 aliases, and CIDR lists whose effective union covers an entire address family. Do not use broad address ranges merely because they include the observed peer.
5. Set the observed value in `terraform.tfvars`, review the environment change, and apply it:

   ```hcl
   # Example form only; use the value established by the observation above.
   trust_proxy = "2"
   ```

   Apply this as an existing-environment infrastructure change through the saved-plan and no-delete gate above. Do not run an ad hoc `terraform apply`.

6. From the same known client, perform a new authenticated upload through every reachable path while supplying a canary header such as `X-Forwarded-For: 198.51.100.123`. Query the matching upload and confirm that both persisted fields equal the independently known client address and never the spoof canary:

   ```sql
   SELECT
     draft_versions.source_ip AS version_source_ip,
     upload_events.source_ip AS event_source_ip
   FROM draft_versions
   JOIN upload_events
     ON upload_events.draft_version_id = draft_versions.id
   WHERE draft_versions.draft_id = 'replace-with-the-canary-draft-id'
   ORDER BY upload_events.created_at DESC
   LIMIT 1;
   ```

7. If any path attributes the spoof value, a proxy peer, or a different header position, restore `trust_proxy = null` and correct the topology or trust rule before using the address for audit.

This verification remains an operator responsibility after deploy. Repeat it whenever Azure ingress behavior, DNS paths, custom domains, CDN/WAF layers, proxy source ranges, or Container App networking changes. Repository and Terraform tests validate parsing and environment wiring only; they do not establish the hosted trust boundary.

## Intentional retirement

There is no routine teardown command for a durable PatchPage environment. Retiring only the app while retaining PostgreSQL and Blob data is a separate operation and must not touch the persistent resources.

A full data retirement requires:

1. Freeze writes and name the exact private subscription, backend key, state lineage, environment, and resource IDs.
2. Verify current independent Blob and PostgreSQL recovery points outside the target scope and complete an isolated end-to-end restore.
3. Export and approve the exact address inventory from the verified state. `prevent_destroy` is expected to block a destroy plan at this point.
4. In a separate reviewed change, intentionally remove the relevant `prevent_destroy` rules.
5. Generate a saved destroy plan, extract its delete-address manifest, and require an exact match with the pre-approved inventory and scope.
6. Remove only the two out-of-band exact-resource locks (`protect-patchpage-drafts` and `protect-patchpage-postgres`) just in time with a separately authorized identity.
7. Apply only the approved saved plan. Never manually delete the PostgreSQL database first and never delete the resource group first.
8. Verify the state account and state history, independent backups, DNS zone, nameservers, and certificates that are outside the retirement scope still exist.

Never use retirement to repair state, DNS, certificates, image rollout, or environment naming. Never improvise deletion in the portal or CLI.

## Security notes

- Do not commit `terraform.tfvars`, `backend.hcl`, `.terraform/`, saved plans, state snapshots, private canary/rollback records, or generated deployment notes.
- Terraform state and saved plans contain generated secrets. Keep state in the private protected account, create plans only in mode-0700 temporary directories, and never upload either as CI or public artifacts.
- The Blob container is private; public draft viewing goes through the PatchPage server.
- The server uses managed identity for Blob access in production.
- Uploads require API tokens by default. Anonymous creation remains disabled unless this deployment explicitly sets `allow_anonymous_uploads = true`.
- Keep `trust_proxy = null` until the live forwarding chain has passed the HITL verification above; an incorrect trust rule permits spoofed audit attribution.
- Never paste subscription or tenant IDs, caller details, Activity Log claims, state lineage, resource IDs, domain-verification values, certificate rows, unlisted draft URLs, tokens, connection strings, storage keys, or backup evidence into public issues, PRs, logs, or chat.
- Management locks and `prevent_destroy` reduce accidental control-plane deletion; they are not authorization boundaries and do not replace independently tested backups.
