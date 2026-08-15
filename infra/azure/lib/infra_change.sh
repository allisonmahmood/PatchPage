# The existing-environment infrastructure change, as phases three commands
# share.
#
# Sourced by cmd/*.sh through ops.sh, which exports PP_OPS_LIB; see ops.sh.
# Requires lib/wrappers.sh, lib/diag.sh, lib/lease.sh, lib/revision.sh,
# lib/state_inspect.sh and lib/plan_gate.sh, and a caller that has set
# OPERATION_LEASE_AUTH_MODE before loading lib/lease.sh.
#
# --- why this file exists ----------------------------------------------------
#
# There is one infrastructure change and there are two moments in it: the plan
# that a second operator reviews, and the apply of exactly that plan. Those two
# moments used to be two runs of one command, joined by a token and separated by
# a full replan, because a shell variable cannot outlive a process. That is the
# `infrastructure-change` command, and it is still here: for one operator at one
# terminal it is the shortest safe path, and it is the flow the harness's twenty
# scenarios describe.
#
# What it cannot do is hand the reviewed plan itself forward. The approved run
# replans against current state and compares the new action inventory to the
# recorded token, so an unchanged environment yields an equal token and an
# equivalent plan -- but never the same plan file. `infrastructure-plan` and
# `infrastructure-apply` exist for the case where that matters: the plan is
# written to a private session, its SHA-256 is recorded, and the apply refuses
# anything else. The operation lease is held across the two commands, which is
# what makes the second one an apply of the first one's world rather than of a
# world that moved.
#
# The phases below are the bodies those three commands run, in the order they
# ran in when there was only one command. They are functions rather than three
# copies for the reason lib/ exists at all: a divergence between two copies of
# an infrastructure safety gate is not a difference anyone notices until the day
# it matters. `infrastructure-change` calls them in exactly its original order,
# which is what the unchanged scenario logs prove.
#
# Each phase exits rather than returning on failure. That is deliberate and it
# is what the carved bodies already did: every gate in this flow is fail-closed,
# and a phase that returned a status would let a caller decide to continue past
# one. The EXIT trap the phases install is what unwinds the diagnostic log, the
# secure directory and the operation lease.

infra_change_begin() {
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
  if ! OPERATION_BINDING_SHA256="$(operation_binding_sha256)"; then
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
    printf 'The expected OpenTofu state blob does not exist.\n' >&2
    exit 1
  fi
  if ! inspect_state_containers || test "$STATE_CONTAINER_EXISTS" != "true"; then
    printf 'The OpenTofu state account data plane is unavailable or inconsistent.\n' >&2
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
    printf 'Could not write the private OpenTofu backend configuration.\n' >&2
    exit 1
  fi
  if ! private_tofu init -input=false -reconfigure -backend-config=backend.hcl >&3; then
    printf 'OpenTofu initialization failed.\n' >&2
    exit 1
  fi
  # Every console evaluation in this flow is read-only and already serialized
  # by the operation lease. -lock=false matters beyond that: with a real
  # backend, taking the state lock prints "Acquiring/Releasing state lock"
  # chatter on stdout, and these checks compare stdout literally.
  if ! TERRAFORM_SUBSCRIPTION_LITERAL="$(
    private_tofu console -no-color -lock=false <<'EOF'
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
    private_tofu console -no-color -lock=false <<'EOF'
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
  if test "$TERRAFORM_RESOURCE_GROUP" != "$RESOURCE_GROUP"; then
    printf 'The OpenTofu workload resource-group name does not match the private expected value.\n' >&2
    exit 1
  fi
  unset TERRAFORM_RESOURCE_GROUP
}

infra_change_open_workspace() {
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
  trap 'cleanup_infrastructure_change; tofu_diagnostic_exit' 0
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  STATE_SNAPSHOT="$SECURE_CHANGE_DIR/state.json"
  STATE_VALUES="$SECURE_CHANGE_DIR/state-values.json"
  INFRA_PLAN="$SECURE_CHANGE_DIR/infrastructure.tfplan"
  INFRA_PLAN_JSON="$SECURE_CHANGE_DIR/infrastructure-plan.json"
}

infra_change_plan_phase() {
  if ! { private_tofu state pull > "$STATE_SNAPSHOT"; } 2>/dev/null ||
    ! { private_tofu show -json > "$STATE_VALUES"; } 2>/dev/null; then
    printf 'Could not read the selected OpenTofu state securely.\n' >&2
    exit 1
  fi
  if test "$(jq -r .lineage "$STATE_SNAPSHOT" 2>/dev/null)" != "$EXPECTED_STATE_LINEAGE"; then
    printf 'OpenTofu state lineage does not match the private expected value.\n' >&2
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
    if ! private_tofu state show "$address" >/dev/null; then
      printf 'OpenTofu state is missing a required managed resource.\n' >&2
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
    printf 'OpenTofu state resource identity does not match the private expected values.\n' >&2
    exit 1
  fi
  if ! private_az resource show --ids "$EXPECTED_STORAGE_ACCOUNT_ID" --output none ||
    ! private_az resource show --ids "$EXPECTED_POSTGRES_SERVER_ID" --output none ||
    ! private_az resource show --ids "$EXPECTED_ACR_ID" --output none ||
    ! private_az resource show --ids "$EXPECTED_CONTAINER_APP_ID" --output none; then
    printf 'A resource recorded in OpenTofu state is missing from Azure.\n' >&2
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
        --include dv \
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
  trap 'operation_lease_exit; cleanup_infrastructure_change; tofu_diagnostic_exit; operation_lease_retention_exit' 0
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
      private_tofu console -no-color -lock=false <<'EOF'
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
    printf 'Could not compare OpenTofu and live workload Storage retention.\n' >&2
    exit 1
  fi
  if test "$TERRAFORM_STORAGE_RETENTION_DAYS" -lt "$LIVE_WORKLOAD_BLOB_RETENTION_DAYS" ||
    test "$TERRAFORM_STORAGE_RETENTION_DAYS" -lt "$LIVE_WORKLOAD_CONTAINER_RETENTION_DAYS"; then
    printf 'OpenTofu would shorten live workload Storage retention; raise the private configured value and restart.\n' >&2
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
      printf 'Could not read the existing OpenTofu state retention settings.\n' >&2
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
      printf 'Could not adopt OpenTofu state retention safeguards.\n' >&2
      exit 1
    fi
    if test -z "$STATE_EXISTING_LOCK_ROWS" &&
      ! private_az lock create \
        --name protect-patchpage-tfstate \
        --lock-type CanNotDelete \
        --resource "$EXPECTED_STATE_STORAGE_ACCOUNT_ID" >/dev/null; then
      printf 'Could not adopt the OpenTofu state deletion lock.\n' >&2
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
    printf 'The OpenTofu state-account deletion lock is missing or incorrectly scoped.\n' >&2
    exit 1
  fi
  if ! STATE_BLOB_PROPERTIES="$(
    private_az storage account blob-service-properties show \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --resource-group rg-patchpage-tfstate \
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
    if private_tofu state show "$managed_lock_address" >/dev/null; then
      return 0
    fi
    test "$ADOPT_SAFETY_GUARDS" = "true" &&
      private_tofu import -input=false \
        "$managed_lock_address" \
        "$managed_lock_id" >&3
  }
  if ! ensure_managed_lock_state \
    azurerm_management_lock.drafts_storage \
    "$EXPECTED_STORAGE_LOCK_ID" ||
    ! ensure_managed_lock_state \
      azurerm_management_lock.patchpage_postgres \
      "$EXPECTED_POSTGRES_LOCK_ID"; then
    printf 'The persistent-resource locks are not bound to this OpenTofu state.\n' >&2
    exit 1
  fi
  if ! { private_tofu show -json > "$STATE_VALUES"; } 2>/dev/null; then
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
    printf 'A OpenTofu management-lock binding has an unexpected identity.\n' >&2
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
    private_tofu console -no-color -lock=false <<'EOF'
var.server_image
EOF
  )" ||
    test "$TERRAFORM_SERVER_IMAGE_LITERAL" != "\"$LOCKED_CONTAINER_APP_IMAGE\""; then
    printf 'OpenTofu did not resolve the synchronized immutable server image.\n' >&2
    exit 1
  fi
  unset SERVER_IMAGE_VARS SERVER_IMAGE_VARS_TEMP TERRAFORM_SERVER_IMAGE_LITERAL

  if ! private_tofu plan -input=false -out="$INFRA_PLAN" >&3; then
    printf 'OpenTofu could not create the infrastructure plan.\n' >&2
    exit 1
  fi
  if ! { private_tofu show -json "$INFRA_PLAN" > "$INFRA_PLAN_JSON"; } 2>/dev/null; then
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
  # Every one of the four protected addresses is passed: an infrastructure change
  # is never the run that legitimately creates persistent data, so OpenTofu
  # planning to create one of them means it has lost sight of the existing one.
  if ! plan_gate_accepts \
    azurerm_storage_account.drafts \
    azurerm_storage_container.drafts \
    azurerm_postgresql_flexible_server.patchpage \
    azurerm_postgresql_flexible_server_database.patchpage \
    < "$INFRA_PLAN_JSON"; then
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
}

infra_change_review_token() {
  if ! INFRA_CHANGE_REVIEW_SHA256="$(
    printf '%s\n' "$INFRA_ACTION_SUMMARY" |
      openssl dgst -sha256 -r 2>/dev/null |
      cut -d ' ' -f1
  )" ||
    ! printf '%s\n' "$INFRA_CHANGE_REVIEW_SHA256" | grep -Eq '^[0-9a-f]{64}$'; then
    printf 'Could not compute the second-operator review token.\n' >&2
    exit 1
  fi
}

infra_change_apply_phase() {
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
  if ! private_tofu apply -input=false "$INFRA_PLAN" >&3; then
    printf 'OpenTofu could not apply the reviewed infrastructure plan.\n' >&2
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
}

infra_change_complete() {
  if ! cleanup_infrastructure_change; then
    exit 1
  fi
  SECURE_CHANGE_DIR=''
  TERRAFORM_DIAGNOSTICS_COMPLETE=true
  tofu_diagnostic_exit
  trap - 0 HUP INT TERM
}

# --- the plan/apply session --------------------------------------------------
#
# What `infrastructure-plan` leaves behind, and what `infrastructure-apply`
# refuses to proceed without. Seven fields, none of which the apply trusts
# without re-deriving it:
#
#   plan.tfplan     the exact saved plan, byte for byte
#   plan.sha256     its digest at review time. The apply rehashes the file and
#                   compares, so a plan that was edited or regenerated between
#                   the review and the apply is refused rather than applied.
#   inventory       the rendered action inventory the second operator read. The
#                   approval token is recomputed from this rather than stored,
#                   so a token that matches is a token that approved exactly
#                   these actions -- storing the token would only prove the
#                   operator can copy a string back.
#   lease           the operation lease the plan is still holding. The apply
#                   renews it as proof that this session, and not something that
#                   happened after it, owns the environment.
#   revision        the Container App revision the plan pinned
#   locked-image    the image on that revision
#   planned-image   the image the plan produced. The plan already proved it
#                   equal to locked-image; both are recorded so the apply's
#                   pre-apply recheck reads the same two values it always read,
#                   and so a session whose fields disagree is caught there.
#
# The directory is 0700 under an operator-supplied root, the same shape and for
# the same reason as the diagnostic root: a saved plan is a complete description
# of an environment.
#
# It is created with mkdir rather than mktemp -d for two reasons. Its name has
# to be one the operator can hand to the next command -- that is what a session
# is -- and mkdir on an existing directory fails, so a second plan cannot open a
# second session over an open one. That refusal is deliberate: the open session
# is holding the operation lease, and the way to clear it is
# infrastructure-abandon.
INFRA_SESSION_DIR_NAME="patchpage-infrastructure-session"

# Prints the SHA-256 of a file, or fails without printing anything. Reads from
# standard input rather than naming the file to openssl, so the digest line
# carries no path to parse around, and refuses anything that is not 64 hex
# characters for the same reason lib/lease.sh does: a truncated digest compares
# equal to another truncated digest.
infra_session_sha256() {
  infra_session_digest="$(
    openssl dgst -sha256 -r < "$1" 2>/dev/null | cut -d ' ' -f1
  )" || return 1
  printf '%s\n' "$infra_session_digest" | grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s\n' "$infra_session_digest"
}

infra_session_locate() {
  : "${INFRA_CHANGE_SESSION_ROOT:?Set an existing private session directory outside the repository}"
  case "$INFRA_CHANGE_SESSION_ROOT" in
    /*) ;;
    *)
      printf 'INFRA_CHANGE_SESSION_ROOT must be an absolute private directory.\n' >&2
      exit 1
      ;;
  esac
  if ! INFRA_SESSION_ROOT="$(
    CDPATH= cd -- "$INFRA_CHANGE_SESSION_ROOT" 2>/dev/null && pwd -P
  )"; then
    printf 'Could not resolve the private infrastructure session root.\n' >&2
    exit 1
  fi
  INFRA_SESSION_DIR="$INFRA_SESSION_ROOT/$INFRA_SESSION_DIR_NAME"
  INFRA_SESSION_PLAN="$INFRA_SESSION_DIR/plan.tfplan"
}

# The containment rule belongs to the command that writes, which is only ever
# infrastructure-plan: a saved plan inside the repository is a saved plan one
# `git add -A` away from being published. The apply and the abandon read and
# remove a directory this already vetted, so they do not repeat it and do not
# need to know where the repository is.
infra_session_require_outside_repo() {
  if ! infra_session_repo_root="$(
    CDPATH= cd -- "$1" 2>/dev/null && pwd -P
  )"; then
    printf 'Could not resolve the repository root.\n' >&2
    exit 1
  fi
  case "$INFRA_SESSION_ROOT" in
    "$infra_session_repo_root" | "$infra_session_repo_root"/*)
      printf 'INFRA_CHANGE_SESSION_ROOT must remain outside the repository.\n' >&2
      exit 1
      ;;
  esac
  unset infra_session_repo_root
}

infra_session_write_field() {
  (umask 077 && printf '%s\n' "$2" > "$INFRA_SESSION_DIR/$1") 2>/dev/null &&
    chmod 600 "$INFRA_SESSION_DIR/$1" 2>/dev/null
}

# Reading is deliberately permissive about emptiness: a plan with no changes
# renders an empty action inventory, and that empty inventory is a real review
# artefact whose token an operator can approve. The fields where emptiness would
# be meaningless are shape-checked by infra_session_load instead.
infra_session_read_field() {
  test -f "$INFRA_SESSION_DIR/$1" || return 1
  cat "$INFRA_SESSION_DIR/$1"
}

infra_session_require_absent() {
  if test -e "$INFRA_SESSION_DIR"; then
    printf 'An infrastructure session is already open; complete it with infrastructure-apply or clear it with infrastructure-abandon.\n' >&2
    exit 1
  fi
}

infra_session_create() {
  if ! (umask 077 && mkdir "$INFRA_SESSION_DIR") 2>/dev/null ||
    ! chmod 700 "$INFRA_SESSION_DIR" 2>/dev/null; then
    printf 'Could not open a private infrastructure session; an earlier session may still be open, in which case abandon it first.\n' >&2
    exit 1
  fi
  if ! (umask 077 && cp -- "$INFRA_PLAN" "$INFRA_SESSION_PLAN") 2>/dev/null ||
    ! chmod 600 "$INFRA_SESSION_PLAN" 2>/dev/null ||
    ! INFRA_SESSION_PLAN_SHA256="$(infra_session_sha256 "$INFRA_SESSION_PLAN")" ||
    ! infra_session_write_field plan.sha256 "$INFRA_SESSION_PLAN_SHA256" ||
    ! infra_session_write_field inventory "$INFRA_ACTION_SUMMARY" ||
    ! infra_session_write_field lease "$OPERATION_LEASE_ID" ||
    ! infra_session_write_field revision "$LOCKED_CONTAINER_APP_REVISION" ||
    ! infra_session_write_field locked-image "$LOCKED_CONTAINER_APP_IMAGE" ||
    ! infra_session_write_field planned-image "$PLANNED_CONTAINER_APP_IMAGE"; then
    # A half-written session is worse than none: it is complete enough to make
    # infrastructure-plan refuse to open another, and incomplete enough that a
    # command reading all seven fields would refuse it too. The directory this
    # call created is therefore removed before the failure is reported, so the
    # only states an operator can be left in are "an open session" and "no
    # session". infrastructure-abandon covers the residue if even this fails.
    rm -rf -- "$INFRA_SESSION_DIR" 2>/dev/null
    printf 'Could not record the reviewed infrastructure plan.\n' >&2
    exit 1
  fi
}

# The one field infrastructure-abandon needs, read without the all-seven gate
# infra_session_load applies. Abandoning is not planning or applying: it does
# not need the plan, its digest, the inventory or the revision pins, and a
# session that lost any of those is exactly the session that most needs closing.
# Requiring the full set would make a partial session unclosable -- plan refuses
# because one is open, apply and abandon refuse because it will not load -- and
# the lease would stay held with no command able to give it back.
#
# The lease field is still shape-checked, because a malformed ID is not
# something to send to Azure and a session with no usable lease is a session
# whose record is simply cleared.
infra_session_load_lease() {
  test -d "$INFRA_SESSION_DIR" || return 1
  OPERATION_LEASE_ID="$(infra_session_read_field lease)" || return 1
  printf '%s\n' "$OPERATION_LEASE_ID" |
    grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}

infra_session_load() {
  if ! test -d "$INFRA_SESSION_DIR" ||
    ! test -f "$INFRA_SESSION_PLAN" ||
    ! INFRA_SESSION_PLAN_SHA256="$(infra_session_read_field plan.sha256)" ||
    ! INFRA_ACTION_SUMMARY="$(infra_session_read_field inventory)" ||
    ! OPERATION_LEASE_ID="$(infra_session_read_field lease)" ||
    ! LOCKED_CONTAINER_APP_REVISION="$(infra_session_read_field revision)" ||
    ! LOCKED_CONTAINER_APP_IMAGE="$(infra_session_read_field locked-image)" ||
    ! PLANNED_CONTAINER_APP_IMAGE="$(infra_session_read_field planned-image)"; then
    printf 'No reviewed infrastructure plan is open; run the plan command first.\n' >&2
    exit 1
  fi
  if ! printf '%s\n' "$INFRA_SESSION_PLAN_SHA256" | grep -Eq '^[0-9a-f]{64}$' ||
    ! printf '%s\n' "$OPERATION_LEASE_ID" |
      grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ||
    test -z "$LOCKED_CONTAINER_APP_REVISION" ||
    test -z "$LOCKED_CONTAINER_APP_IMAGE" ||
    test -z "$PLANNED_CONTAINER_APP_IMAGE"; then
    printf 'The open infrastructure session is malformed.\n' >&2
    exit 1
  fi
}

# The integrity check the session exists for. The plan file is rehashed here and
# compared with the digest taken when the second operator reviewed it, so the
# bytes that reach `tofu apply` are the bytes that were approved -- not a plan
# regenerated against a state that has since moved, and not an edited one.
infra_session_verify_plan() {
  if ! INFRA_SESSION_LIVE_SHA256="$(infra_session_sha256 "$INFRA_SESSION_PLAN")" ||
    test "$INFRA_SESSION_LIVE_SHA256" != "$INFRA_SESSION_PLAN_SHA256"; then
    printf 'The saved infrastructure plan is not the plan that was reviewed; discard this session and plan again.\n' >&2
    exit 1
  fi
  unset INFRA_SESSION_LIVE_SHA256
}

# The approval, checked against the inventory the session recorded rather than
# against a freshly rendered one. infra_change_review_token derives the token
# from INFRA_ACTION_SUMMARY, which infra_session_load has already restored.
infra_session_verify_approval() {
  infra_change_review_token
  if test "${INFRA_CHANGE_APPROVAL_SHA256:-}" != "$INFRA_CHANGE_REVIEW_SHA256"; then
    printf 'The second-operator approval does not match the reviewed action inventory this session recorded.\n' >&2
    exit 1
  fi
  unset INFRA_CHANGE_REVIEW_SHA256
}

infra_session_discard() {
  if test -n "${INFRA_SESSION_DIR:-}" &&
    ! rm -rf -- "$INFRA_SESSION_DIR" 2>/dev/null; then
    printf 'Private infrastructure session cleanup failed.\n' >&2
    return 1
  fi
}
