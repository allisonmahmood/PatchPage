#!/bin/sh

set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)"
README="$ROOT/infra/azure/README.md"
TMP_ROOT="$(mktemp -d)"
TMP_DIR="$TMP_ROOT/guide commands"
mkdir -p "$TMP_DIR"
# Both spellings of the harness root. On macOS mktemp hands back a /var/folders
# path that is a symlink to /private/var/folders, and a runbook that resolved a
# private directory with `pwd -P` would print the second one.
TMP_ROOT_PHYSICAL="$(CDPATH= cd -- "$TMP_ROOT" && pwd -P)"

# Set PP_KEEP_TMP=1 to keep the scenario command logs, stdout/stderr captures
# and mock state for inspection; tests/canonicalize_guide_logs.sh turns what is
# left behind into a diffable form.
guide_cleanup() {
  if test -n "${PP_KEEP_TMP:-}"; then
    printf 'guide_commands_test: PP_KEEP_TMP set, preserving %s\n' "$TMP_ROOT" >&2
    return 0
  fi
  rm -rf "$TMP_ROOT"
}
trap guide_cleanup 0 HUP INT TERM

fail() {
  printf 'guide_commands_test: %s\n' "$1" >&2
  exit 1
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

# --- the no-private-output sweep ---------------------------------------------
#
# Every documented command makes the same promise about its own output: an
# operator watching it, and an AI agent reading it back, learn nothing about the
# environment they did not already have to know in order to run it. Failure
# messages are generic on purpose, and the private values are in the operator's
# record rather than on the terminal.
#
# That promise used to be kept by a grep copied into eight scenario loops, each
# with a slightly different pattern list and each covering only the flow it sat
# in. A command that grew a new printf was covered if somebody remembered to
# extend the right list; a command written next year was covered if somebody
# remembered to write one. The promise is universal, so the check is now too:
# the driver runs it over every scenario's captured stdout and stderr after
# every group, and a new command is covered the moment its first scenario runs.
#
# The pattern is the union of the eight lists it replaces. The harness's own
# temporary root is checked alongside it, which subsumes the two hand-written
# "exposed the private diagnostic path" assertions -- a private diagnostic,
# session or plan directory can only be somewhere under that root.
#
# What is deliberately not here: a bare 64-hex-character pattern. The workload
# binding digest is 64 hex and must never be printed -- but so is the
# infrastructure review token, which is printed on purpose and is the whole
# mechanism of the second-operator approval. A universal ban would have to be a
# ban on the approval flow. The release and rollback flows have no reason to
# print any 64-hex string, so they keep that one conjunct in their own stanzas,
# which is the only thing left in them.
GUIDE_PRIVATE_OUTPUT_PATTERN='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|sha256:[0-9a-f]{64}|patchpagestate|patchpagedrafts|patchpage-prod\.tfstate|patchpage-operations|patchpage-db|patchpage-app|acrpatchpageabc123|rg-patchpage-tfstate|rg-patchpage-workload|rg-test|app-test|env-test|drafts\.self-hoster\.dev|203\.0\.113\.10|verification-id|private-(az|tofu|rollback|infra-az|infra-tofu)-diagnostic|pp_[A-Za-z0-9]|[Aa]ccount[Kk]ey'

# Returns 0 when the given capture contains a private value, 1 when it is clean.
# Reports status rather than calling fail so the check itself can be meta-tested.
guide_private_output_leaks() {
  grep -Eq "$GUIDE_PRIVATE_OUTPUT_PATTERN" "$1"
}

# The one interesting case in the exit-code contract ops.sh --help states: a
# command that deliberately keeps the operation lease exits 75, and nothing else
# does. 75 is EX_TEMPFAIL, picked so a caller that treats "nonzero" as
# "retryable" has to special-case the one code where retrying is exactly wrong.
#
# The expectation is derived from the retention message the flow itself prints,
# not from a hand-kept list of scenario names, so a new retaining path is held
# to the contract the moment it is written. Both directions are checked: a
# retained lease must exit 75, and 75 must mean a retained lease.
#
# Two distinct messages mean "the lease is still held". The first is the
# deliberate hand-off after a mutation whose result could not be proved. The
# second is the EXIT trap reporting that its own release attempt failed: the
# lease is just as held, and the process must not claim otherwise by exiting 1.
# Only the trap can tell the two apart from a plain failure, because only the
# trap knows whether the final release succeeded.
GUIDE_RETAINED_LEASE_EXITS=0
assert_retained_lease_exit_code() {
  # flow scenario status output-file
  if grep -Fq 'The operation lease remains held for second-operator recovery.' "$4" ||
    grep -Fq 'Operation lease cleanup requires second-operator review.' "$4"; then
    GUIDE_RETAINED_LEASE_EXITS=$((GUIDE_RETAINED_LEASE_EXITS + 1))
    test "$3" -eq 75 ||
      fail "$1 kept the operation lease after $2 but exited $3 instead of 75"
  else
    test "$3" -ne 75 ||
      fail "$1 exited 75 after $2 without keeping the operation lease"
  fi
}

case "$TMP_DIR" in
  *' '*) ;;
  *) fail "guide harness temporary path does not contain spaces" ;;
esac

if grep -Fq -- '--header "Authorization: Bearer $BOOTSTRAP_API_TOKEN"' \
  "$ROOT/infra/azure/cmd/deployed-smoke.sh"; then
  fail "deployed smoke exposes the bootstrap token in curl argv"
fi

# --- the operations CLI under test -------------------------------------------
#
# The runbooks this harness drives are infra/azure/cmd/*.sh, reached the way an
# operator reaches them: `sh infra/azure/ops.sh <command>`. The guide documents
# that invocation and nothing else, so there is no extraction step and no
# generated copy of the runbook text to keep in sync.

GUIDE_OPS="$ROOT/infra/azure/ops.sh"
GUIDE_CMD_DIR="$ROOT/infra/azure/cmd"
GUIDE_LIB_DIR="$ROOT/infra/azure/lib"
GUIDE_COMMANDS="state-bootstrap deploy-resources app-release app-rollback
infrastructure-change infrastructure-plan infrastructure-apply
infrastructure-abandon stale-lease-recovery custom-domain-context
ingress-verification apex-dns caa-policy hostname-mutation certificate-binding
deployed-smoke"

# The shared safety mechanisms. Each of these was several copies inside cmd/*.sh
# and is now one definition; they are part of the executable surface and are
# held to the same rules as the commands, which is why they are named here
# rather than discovered by globbing.
GUIDE_LIBS="wrappers lease revision diag plan_gate state_inspect dns infra_change"

test -f "$GUIDE_OPS" || fail "infra/azure/ops.sh is missing"
sh -n "$GUIDE_OPS" || fail "infra/azure/ops.sh is not valid POSIX shell"
for guide_command in $GUIDE_COMMANDS; do
  test -f "$GUIDE_CMD_DIR/$guide_command.sh" ||
    fail "infra/azure/cmd/$guide_command.sh is missing"
  sh -n "$GUIDE_CMD_DIR/$guide_command.sh" ||
    fail "infra/azure/cmd/$guide_command.sh is not valid POSIX shell"
  # ops.sh must be able to reach every command file, and must reject anything
  # else, or a runbook could be present and undispatchable.
  sh "$GUIDE_OPS" --help | grep -Fq -- "  $guide_command " ||
    fail "ops.sh --help does not list $guide_command"
done
if sh "$GUIDE_OPS" not-a-command >/dev/null 2>&1; then
  fail "ops.sh dispatched an unknown command"
fi
for guide_cmd_file in "$GUIDE_CMD_DIR"/*.sh; do
  guide_cmd_name="${guide_cmd_file##*/}"
  guide_cmd_name="${guide_cmd_name%.sh}"
  case " $(printf '%s' "$GUIDE_COMMANDS" | tr '\n' ' ') " in
    *" $guide_cmd_name "*) ;;
    *) fail "infra/azure/cmd/$guide_cmd_name.sh is not a dispatchable command" ;;
  esac
done

for guide_lib in $GUIDE_LIBS; do
  test -f "$GUIDE_LIB_DIR/$guide_lib.sh" ||
    fail "infra/azure/lib/$guide_lib.sh is missing"
  sh -n "$GUIDE_LIB_DIR/$guide_lib.sh" ||
    fail "infra/azure/lib/$guide_lib.sh is not valid POSIX shell"
done
# Nothing may sit in lib/ that this harness is not holding to those rules.
for guide_lib_file in "$GUIDE_LIB_DIR"/*.sh; do
  guide_lib_name="${guide_lib_file##*/}"
  guide_lib_name="${guide_lib_name%.sh}"
  case " $GUIDE_LIBS " in
    *" $guide_lib_name "*) ;;
    *) fail "infra/azure/lib/$guide_lib_name.sh is not a declared shared library" ;;
  esac
done

# --- mock shims --------------------------------------------------------------
#
# az, tofu, terraform, git, curl, dig, mktemp, cat, rm, chmod, jq and sleep are
# executables under tests/mocks, not shell functions. Each runbook runs as a
# child process with the mock directory first on PATH, so a documented command
# reaches a mock exactly the way it would reach the real tool. Because a shim is
# a separate process it cannot read the runbook's shell variables: everything it
# needs is exported below, recomputed from those exports, or kept in a file
# under the per-scenario state directory.
#
# mktemp, cat, rm, chmod and jq have to fall through to the real tool for every
# call they are not injecting a failure into, and the mock directory is first on
# PATH, so they need the PATH the harness started from.

GUIDE_MOCK_DIR="$ROOT/infra/azure/tests/mocks"
PP_MOCK_DIR="$GUIDE_MOCK_DIR"
PP_MOCK_REAL_PATH="$PATH"
export PP_MOCK_DIR PP_MOCK_REAL_PATH
GUIDE_MOCK_PATH="$GUIDE_MOCK_DIR:$PATH"
GUIDE_WRAPPER_DIR="$TMP_ROOT/wrappers"
GUIDE_PART_DIR="$TMP_ROOT/wrapper-parts"
mkdir -p "$GUIDE_WRAPPER_DIR" "$GUIDE_PART_DIR"

for guide_mock in mocklib.sh az tofu terraform git curl dig mktemp cat rm chmod jq sleep; do
  test -f "$GUIDE_MOCK_DIR/$guide_mock" ||
    fail "guide harness mock $guide_mock is missing"
  case "$guide_mock" in
    mocklib.sh) ;;
    *)
      test -x "$GUIDE_MOCK_DIR/$guide_mock" ||
        fail "guide harness mock $guide_mock is not executable"
      ;;
  esac
  sh -n "$GUIDE_MOCK_DIR/$guide_mock" ||
    fail "guide harness mock $guide_mock is not valid POSIX shell"
done

# The log canonicalizer is developer tooling rather than a shim, but CI runs
# only this harness, so syntax-check it here for the same reason.
GUIDE_CANONICALIZER="$ROOT/infra/azure/tests/canonicalize_guide_logs.sh"
test -f "$GUIDE_CANONICALIZER" ||
  fail "guide log canonicalizer is missing"
sh -n "$GUIDE_CANONICALIZER" ||
  fail "guide log canonicalizer is not valid POSIX shell"

# Wrapper scripts are assembled from parts on disk rather than from shell
# variables: bash 3.2 mis-parses a quoted here-document inside a command
# substitution when the document contains case patterns.
write_wrapper_part() {
  printf '%s\n' "$2" > "$GUIDE_PART_DIR/$1"
}

# Empties and exports the state directory the shims use instead of the shell
# variables the old function mocks carried.
prepare_mock_state() {
  PP_MOCK_STATE="$1"
  rm -rf "$PP_MOCK_STATE"
  mkdir -p "$PP_MOCK_STATE"
  export PP_MOCK_STATE
}

# Runs one ops.sh command as a child process with the shims first on PATH, which
# is exactly the documented operator invocation. The caller has already exported
# the scenario environment.
run_ops_command() {
  PATH="$GUIDE_MOCK_PATH"
  export PATH
  sh "$GUIDE_OPS" "$1"
}

# Same, plus the completion marker the assembled block scripts used to append
# after the runbook text. A runbook that reaches its last line exits 0, and
# every early exit in these runbooks is a failure exit, so "the command reported
# success" and "control reached the end of the runbook" are the same event --
# with one exception, called out where it bites: app-release's already-deployed
# no-op guard exits 0 deliberately, so it now records completed where the
# in-process trailer could tell the two apart. test_app_release pins that guard
# directly instead.
run_ops_command_completed() {
  PATH="$GUIDE_MOCK_PATH"
  export PATH
  sh "$GUIDE_OPS" "$1"
  guide_command_status=$?
  if test "$guide_command_status" -eq 0; then
    printf '%s\n' completed >> "$PP_MOCK_LOG"
  fi
  return "$guide_command_status"
}

# Writes a wrapper script from parts and runs it with the shims on PATH. Used by
# the two commands whose contract is stated about the shell that calls them.
run_ops_wrapper() {
  guide_wrapper="$GUIDE_WRAPPER_DIR/$1"
  shift
  {
    printf '%s\n' 'set -u'
    for wrapper_part do
      cat "$GUIDE_PART_DIR/$wrapper_part"
    done
  } > "$guide_wrapper"
  PATH="$GUIDE_MOCK_PATH"
  export PATH
  sh "$guide_wrapper"
}

# --- wrapper parts -----------------------------------------------------------
#
# The mocks that used to be shell functions injected ahead of the README block
# (mktemp, cat, rm, chmod, jq, sleep) are PATH shims now: a runbook is a real
# script and nothing can be injected into it. What is left here is the part of
# each old block script that was never the runbook -- the roles the *calling*
# shell plays, which the wrapper scripts below still play.

# The deployed-smoke command is the one place where the shell that runs the
# runbook is itself under test: the runbook must not clobber the caller's traps
# and must not remove a path the caller reuses. The caller role stays in a
# wrapper script that sets the traps, runs the command, snapshots the traps and
# propagates the exit status, so the assertion keeps its original meaning with
# ops.sh as the tested child.
cat > "$GUIDE_PART_DIR/smoke-caller-traps" <<'GUIDE_WRAPPER_PART'
trap 'printf "%s\n" caller-exit >> "$PP_MOCK_CALLER_TRAP_LOG"' EXIT
trap 'printf "%s\n" caller-hup >> "$PP_MOCK_CALLER_TRAP_LOG"' HUP
trap 'printf "%s\n" caller-int >> "$PP_MOCK_CALLER_TRAP_LOG"' INT
trap 'printf "%s\n" caller-term >> "$PP_MOCK_CALLER_TRAP_LOG"' TERM
GUIDE_WRAPPER_PART

cat > "$GUIDE_PART_DIR/smoke-trailer" <<'GUIDE_WRAPPER_PART'
smoke_status=$?
trap > "$PP_MOCK_CALLER_TRAP_SNAPSHOT"
mkdir -p "$PP_MOCK_SMOKE_TMP_DIR"
: > "$PP_MOCK_SMOKE_TMP_DIR/reused-after-smoke"
exit "$smoke_status"
GUIDE_WRAPPER_PART

# The custom-domain context command is the only one whose contract is stated in
# terms of the variables it leaves behind, so the guide tells the operator to
# source it into the shell the later custom-domain commands run in. This test
# sources it the same way and then checks those variables; the dispatched
# `sh ops.sh custom-domain-context` form is what test_custom_domain_output_guards
# drives. Chained with && so each check bites regardless of errexit.
cat > "$GUIDE_PART_DIR/custom-domain-context-trailer" <<'GUIDE_WRAPPER_PART'
test "$CUSTOM_DOMAIN" = "drafts.self-hoster.dev" &&
  test "$CONTAINER_APP_FQDN" = "app.azurecontainerapps.io" &&
  test "$NORMALIZED_PUBLIC_BASE_URL" = "https://drafts.self-hoster.dev"
GUIDE_WRAPPER_PART

write_wrapper_part custom-domain-context-source \
  ". \"$GUIDE_CMD_DIR/custom-domain-context.sh\""
write_wrapper_part hostname-mutation-source \
  ". \"$GUIDE_CMD_DIR/hostname-mutation.sh\""

# The two sourced commands run in the operator's own shell, so the options they
# set for themselves are borrowed and have to be given back. Driving both
# directions matters: a file that restored nothing would still pass a test that
# only ever sources it from a shell that already had `set -u` on.
write_wrapper_part caller-nounset-off 'set +u'
write_wrapper_part caller-nounset-on 'set -u'

cat > "$GUIDE_PART_DIR/sourced-status" <<'GUIDE_WRAPPER_PART'
sourced_status=$?
test "$sourced_status" -eq 0 || exit 1
GUIDE_WRAPPER_PART

cat > "$GUIDE_PART_DIR/sourced-trailer-nounset-off" <<'GUIDE_WRAPPER_PART'
case $- in
  *u*) exit 1 ;;
esac
exit 0
GUIDE_WRAPPER_PART

cat > "$GUIDE_PART_DIR/sourced-trailer-nounset-on" <<'GUIDE_WRAPPER_PART'
case $- in
  *u*) ;;
  *) exit 1 ;;
esac
exit 0
GUIDE_WRAPPER_PART

# hostname-mutation's whole reason for being sourced: the certificate ID the
# bind returned has to be in the caller when the certificate-binding command
# reads it. Checked before the option check so a file that handed nothing
# forward cannot pass by restoring options tidily.
cat > "$GUIDE_PART_DIR/hostname-mutation-forwarded-value" <<'GUIDE_WRAPPER_PART'
test "$MANAGED_CERTIFICATE_ID" = "$PP_MOCK_EXPECTED_CERTIFICATE_ID" || exit 1
GUIDE_WRAPPER_PART

cat > "$GUIDE_PART_DIR/custom-domain-context-forwarded-value" <<'GUIDE_WRAPPER_PART'
test "$CUSTOM_DOMAIN" = "drafts.self-hoster.dev" || exit 1
GUIDE_WRAPPER_PART

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
    export SUBSCRIPTION_ID STATE_STORAGE_ACCOUNT STATE_CONTAINER \
      OPERATION_PRINCIPAL_ID OPERATION_PRINCIPAL_TYPE STATE_KEY \
      RESUME_STATE_BOOTSTRAP

    PP_MOCK_GROUP="state"
    PP_MOCK_SCENARIO="$scenario"
    PP_MOCK_LOG="$log"
    PP_MOCK_REPO_ROOT="$scenario_root"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG PP_MOCK_REPO_ROOT
    prepare_mock_state "$TMP_DIR/state-$scenario.mockstate"

    # Seed the mock state files that used to be shell variables initialized
    # before the eval: which containers and role assignments already exist.
    case "$scenario" in
      resume_account_success | resume_exact_operation_role | resume_retention_preserved | \
        resume_foreign_container | \
        resume_deleted_container | resume_stronger_state_lock | \
        state_key_history_*)
        : > "$PP_MOCK_STATE/state-container-created"
        : > "$PP_MOCK_STATE/operation-container-created"
        ;;
    esac
    if test "$scenario" = "resume_exact_operation_role"; then
      : > "$PP_MOCK_STATE/role-assignment-created"
    fi

    run_ops_command state-bootstrap
  ) >"$output" 2>&1
}

test_state_bootstrap() {
  grep -Fq -- '--role "$STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID"' \
    "$GUIDE_CMD_DIR/state-bootstrap.sh" ||
    fail "state bootstrap does not filter operation RBAC by the official built-in role ID"
  grep -Fq -- '--include-inherited' "$GUIDE_CMD_DIR/state-bootstrap.sh" ||
    fail "state bootstrap does not inspect inherited operation RBAC"
  grep -Fq -- '--include-groups' "$GUIDE_CMD_DIR/state-bootstrap.sh" ||
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
    malformed_container_row \
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
      malformed_container_row)
        # A container-list row whose leading field is empty: `<tab>false`.
        #
        # This is the row the two copies of inspect_state_containers appeared to
        # disagree about before they were collapsed into lib/state_inspect.sh.
        # infrastructure-change carried an extra branch rejecting an empty name
        # that still had a deleted flag; state-bootstrap skipped any empty name
        # outright. Reading the two side by side, the second looks like a safety
        # check that had quietly stopped being one.
        #
        # It is not, and this scenario is where that was settled. The loop reads
        # with IFS set to a single tab, and tab is IFS white space, so a leading
        # tab is absorbed rather than delimiting an empty first field: this row
        # parses as name=false, deleted=empty, in every shell the harness runs
        # under. An empty name therefore always arrives with an empty deleted
        # column, the extra branch can never fire, and the two copies were
        # already behaviourally identical. The strict text is what survived the
        # merge, so the branch is kept as defence in depth against a future edit
        # to the splitting.
        #
        # Be precise about what this scenario pins. With the strict branch in
        # place the row is rejected either way -- through the unknown-name arm
        # as it parses today, through the empty-name arm if the splitting
        # changed -- so the verdict below does not move on a splitting change
        # alone. It moves only if the splitting changes *and* the strict branch
        # is dropped, which is exactly the pair that would let `<tab>false` be
        # skipped in silence.
        test "$status" -ne 0 ||
          fail "state bootstrap accepted a container inventory row it could not interpret"
        test ! -e "$backend" ||
          fail "state bootstrap wrote a backend config after an uninterpretable container inventory row"
        grep -Fq 'Could not verify the dedicated state containers.' \
          "$TMP_DIR/state-$scenario.out" ||
          fail "state bootstrap did not reject the malformed container inventory row"
        ;;
      *)
        test "$status" -ne 0 || fail "state bootstrap succeeded after $scenario"
        test ! -e "$backend" || fail "state bootstrap created backend config after $scenario"
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
    EXPECTED_OPERATION_AUTH_MODE="key"
    case "$scenario" in
      resume_*) RESUME_INITIAL_DEPLOY="true" ;;
      *) RESUME_INITIAL_DEPLOY="false" ;;
    esac
    export SUBSCRIPTION_ID STATE_STORAGE_ACCOUNT STATE_KEY FULL_SHA \
      IMAGE_DIGEST_VALUE TERRAFORM_DIAGNOSTIC_ROOT EXPECTED_OPERATION_AUTH_MODE \
      RESUME_INITIAL_DEPLOY

    PP_MOCK_GROUP="deploy"
    PP_MOCK_SCENARIO="$scenario"
    PP_MOCK_LOG="$log"
    PP_MOCK_REPO_ROOT="$scenario_root"
    PP_MOCK_SCENARIO_ROOT="$scenario_root"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG PP_MOCK_REPO_ROOT \
      PP_MOCK_SCENARIO_ROOT
    prepare_mock_state "$TMP_DIR/deploy-$scenario.mockstate"

    cd "$scenario_root/infra/azure"
    printf '%s\n' \
      'resource_group_name = "foreign"' \
      'storage_account_name = "foreignstate"' \
      'container_name = "foreign"' \
      'key = "foreign.tfstate"' > backend.hcl

    run_ops_command_completed deploy-resources
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
          'tofu init -input=false -reconfigure -backend-config=backend.hcl' \
          "$log" ||
          fail "deployment did not reconfigure OpenTofu to the verified backend"
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
            /^tofu plan -target=azurerm_container_registry\.patchpage -input=false -out=.*\/registry-target\.tfplan$/ {
              sub(/^tofu plan -target=azurerm_container_registry\.patchpage -input=false -out=/, "")
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
        grep -Fqx "tofu show -json $target_plan" "$log" ||
          fail "deployment did not inspect the registry-target plan"
        grep -Fqx "tofu apply -input=false $target_plan" "$log" ||
          fail "deployment did not apply the reviewed registry-target plan"
        initial_plan="$(
          awk '
            /^tofu plan -input=false -out=.*\/initial\.tfplan$/ {
              sub(/^tofu plan -input=false -out=/, "")
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
        test "$(grep -Fxc "tofu show -json $initial_plan" "$log")" -eq 1 ||
          fail "deployment did not capture the saved plan JSON exactly once"
        grep -Fqx "tofu apply -input=false $initial_plan" "$log" ||
          fail "deployment did not apply the reviewed saved plan"
        awk '
          /^tofu apply -input=false .*\/initial\.tfplan$/ { stage = 1; next }
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
          grep -Fqx 'OpenTofu succeeded, but private diagnostic cleanup failed.' "$output" ||
            fail "deployment cleanup failure did not emit only its generic error"
        else
          test ! -d "$(cat "$diagnostic_path_file")" ||
            fail "successful deployment retained private OpenTofu diagnostics"
        fi
        ;;
      resume_partial_rg_success | resume_target_complete_success)
        test "$status" -eq 0 || fail "guarded deployment rejected $scenario"
        test -f "$image_vars" ||
          fail "resumed deployment did not write digest-based image variables"
        target_plan="$(
          awk '
            /^tofu plan -target=azurerm_container_registry\.patchpage -input=false -out=.*\/registry-target\.tfplan$/ {
              sub(/^tofu plan -target=azurerm_container_registry\.patchpage -input=false -out=/, "")
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
        grep -Fqx "tofu show -json $target_plan" "$log" ||
          fail "resumed deployment did not inspect its registry-target plan"
        grep -Fqx "tofu apply -input=false $target_plan" "$log" ||
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
          fail "resumed deployment retained private OpenTofu diagnostics"
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
        if grep -Eq '^tofu apply -input=false .*/initial\.tfplan$' "$log"; then
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
        if grep -Eq '^tofu apply -input=false .*/registry-target\.tfplan$' "$log"; then
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
    if test "$scenario" = "final_apply_failure"; then
      # A half-applied deployment is the same "stop, a second operator must
      # act" state the retained-lease paths report, and it gets the same exit
      # code for the same reason: rerunning is exactly the wrong response, so
      # the one code a nonzero-is-retryable caller has to special-case is the
      # one this has to use.
      test "$status" -eq 75 ||
        fail "deployment partial-apply freeze exited $status instead of 75"
      grep -Fq 'Stop: do not rerun either automated flow' "$output" ||
        fail "deployment partial-apply freeze omitted its stop instruction"
      test -f "$diagnostic_path_file" ||
        fail "failed deployment lost its private diagnostic location"
      diagnostic_log="$(cat "$diagnostic_path_file")/terraform.log"
      test -f "$diagnostic_log" ||
        fail "failed deployment did not preserve OpenTofu diagnostics"
      diagnostic_mode="$(
        file_mode "$diagnostic_log"
      )"
      test "$diagnostic_mode" = "600" ||
        fail "failed deployment diagnostic log is not mode 0600"
      grep -Fq 'private-tofu-diagnostic apply -input=false' "$diagnostic_log" ||
        fail "failed deployment diagnostic log omitted provider diagnostics"
    fi
  done
}

# The binding tuple the operation container is sealed with. The release,
# rollback, infrastructure and stale-lease flows all recompute it from the same
# documented inputs, so computing it here keeps the mock's answer independent
# of the block instead of echoing the block's own variable back.
guide_operation_binding_sha256() {
  printf '%s\n' \
    'patchpage-operation-binding-v1' \
    "subscription_id=$SUBSCRIPTION_ID" \
    "state_storage_account=$STATE_STORAGE_ACCOUNT" \
    "state_key=$1" \
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
      guide_operation_binding_sha256 patchpage-prod.tfstate
    )"
    ROLLBACK_RECORD="$TMP_DIR/release-$scenario.rollback.env"
    case "$scenario" in
      rollback_record_directory)
        mkdir -p "$ROLLBACK_RECORD"
        ;;
      rollback_record_symlink)
        printf '%s\n' "existing-rollback-record" > "${ROLLBACK_RECORD}.target"
        ln -s "${ROLLBACK_RECORD}.target" "$ROLLBACK_RECORD"
        ;;
      *)
        printf '%s\n' "existing-rollback-record" > "$ROLLBACK_RECORD"
        chmod 644 "$ROLLBACK_RECORD"
        ;;
    esac
    export SUBSCRIPTION_ID STATE_STORAGE_ACCOUNT STATE_CONTAINER STATE_KEY \
      RESOURCE_GROUP CONTAINER_APP ACR EXPECTED_STORAGE_ACCOUNT_ID \
      EXPECTED_POSTGRES_SERVER_ID LOGIN_SERVER CONTAINER_APP_FQDN \
      PUBLIC_BASE_URL CANARY_URL CANARY_MARKER FULL_SHA \
      ROLLBACK_DIGEST_VALUE RELEASE_DIGEST_VALUE ROLLBACK_IMAGE_VALUE \
      RELEASE_IMAGE_VALUE OLD_REVISION_NAME NEW_REVISION_NAME \
      LATER_REVISION_NAME EXPECTED_OPERATION_BINDING_SHA256 ROLLBACK_RECORD

    PP_MOCK_GROUP="release"
    PP_MOCK_SCENARIO="$scenario"
    PP_MOCK_LOG="$log"
    PP_MOCK_REPO_ROOT="$scenario_root"
    PP_MOCK_REPO_ROOT_CANONICAL="$scenario_root_canonical"
    PP_MOCK_APP_CURRENT_IMAGE="$ROLLBACK_IMAGE_VALUE"
    PP_MOCK_APP_UPDATED_IMAGE="$RELEASE_IMAGE_VALUE"
    PP_MOCK_APP_SHOW_COUNT_FILE="containerapp-show-count"
    PP_MOCK_APP_UPDATED_FLAG="release-updated"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG PP_MOCK_REPO_ROOT \
      PP_MOCK_REPO_ROOT_CANONICAL PP_MOCK_APP_CURRENT_IMAGE \
      PP_MOCK_APP_UPDATED_IMAGE PP_MOCK_APP_SHOW_COUNT_FILE \
      PP_MOCK_APP_UPDATED_FLAG
    prepare_mock_state "$TMP_DIR/release-$scenario.mockstate"

    run_ops_command_completed app-release
  ) >"$output" 2>&1
}

test_app_release() {
  release_retained_start="$GUIDE_RETAINED_LEASE_EXITS"
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
    operation_lease_acquire_ok_renew_fails \
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
    assert_retained_lease_exit_code "app release" "$scenario" "$status" \
      "$TMP_DIR/release-$scenario.out"
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
      # This is the one guard in the guide that exits 0 on purpose, so the
      # completion marker cannot separate "stopped here" from "ran to the end"
      # now that the runbook is a child process and only its exit status crosses
      # back. Pin the guard on what it actually did: giving the lease back was
      # the last thing it did, and nothing followed.
      no_op_last_command="$(grep '^az ' "$log" | sed -n '$p')"
      case "$no_op_last_command" in
        'az storage container lease release '*) ;;
        *) fail "app release continued past its already-deployed digest guard" ;;
      esac
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
        operation_lease_renew_failure | operation_lease_acquire_ok_renew_fails | \
        preexisting_pending_revision | \
        preexisting_failed_revision | prelease_locked_image_mismatch)
        if grep -Eq '^az acr build |^az containerapp update ' "$log"; then
          fail "app release built or updated after fail-closed preflight $scenario"
        fi
        ;;
    esac

    if grep -Eq \
      '^tofu |^az (network|postgres|resource delete|group delete|lock delete) ' \
      "$log"; then
      fail "app release attempted OpenTofu, DNS, Storage, PostgreSQL, or destructive resource mutation"
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
      operation_lease_acquire_ok_renew_fails)
        # Acquire succeeded, so Azure holds the infinite lease even though the
        # renew-as-proof blipped. The EXIT trap must still release it.
        if grep -Fq 'az containerapp update ' "$log"; then
          fail "app release updated the image after rejecting $scenario"
        fi
        # Qualify the release against the infinite operation lease: a bare release
        # line could otherwise be satisfied by an unrelated finite binding lease.
        renew_blip_acquire_line="$(
          grep -nE '^az storage container lease acquire .* --lease-duration -1 ' "$log" |
            sed -n '1s/:.*//p'
        )"
        renew_blip_release_line="$(
          grep -nE '^az storage container lease release ' "$log" | sed -n '$s/:.*//p'
        )"
        if test -z "$renew_blip_acquire_line" || test -z "$renew_blip_release_line" ||
          test "$renew_blip_release_line" -le "$renew_blip_acquire_line"; then
          fail "app release orphaned the acquired operation lease after a renew blip"
        fi
        ;;
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
    # The identifiers are the driver's sweep now. What stays here is the bare
    # 64-hex conjunct, which cannot be universal: the infrastructure review
    # token is 64 hex and is printed on purpose. This flow has no such token and
    # no reason to print any 64-hex string, so the workload binding digest
    # reaching its output is a leak with no legitimate reading.
    if grep -Eq '[0-9a-f]{64}' "$output"; then
      fail "app release exposed a workload-binding hash after $scenario"
    fi
  done
  test "$((GUIDE_RETAINED_LEASE_EXITS - release_retained_start))" -ge 5 ||
    fail "app release never exercised a deliberately retained operation lease"
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
      guide_operation_binding_sha256 patchpage-prod.tfstate
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
    export SUBSCRIPTION_ID STATE_STORAGE_ACCOUNT STATE_CONTAINER STATE_KEY \
      RESOURCE_GROUP CONTAINER_APP ACR EXPECTED_STORAGE_ACCOUNT_ID \
      EXPECTED_POSTGRES_SERVER_ID LOGIN_SERVER CONTAINER_APP_FQDN \
      PUBLIC_BASE_URL CANARY_URL CANARY_MARKER \
      ROLLBACK_DIGEST_VALUE RELEASE_DIGEST_VALUE ROLLBACK_IMAGE_VALUE \
      RELEASE_IMAGE_VALUE OLD_REVISION_NAME NEW_REVISION_NAME \
      LATER_REVISION_NAME EXPECTED_OPERATION_BINDING_SHA256 ROLLBACK_RECORD

    PP_MOCK_GROUP="rollback"
    PP_MOCK_SCENARIO="$scenario"
    PP_MOCK_LOG="$log"
    PP_MOCK_REPO_ROOT="$scenario_root"
    PP_MOCK_APP_CURRENT_IMAGE="$RELEASE_IMAGE_VALUE"
    PP_MOCK_APP_UPDATED_IMAGE="$ROLLBACK_IMAGE_VALUE"
    PP_MOCK_APP_SHOW_COUNT_FILE="rollback-app-show-count"
    PP_MOCK_APP_UPDATED_FLAG="rollback-updated"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG PP_MOCK_REPO_ROOT \
      PP_MOCK_APP_CURRENT_IMAGE PP_MOCK_APP_UPDATED_IMAGE \
      PP_MOCK_APP_SHOW_COUNT_FILE PP_MOCK_APP_UPDATED_FLAG
    prepare_mock_state "$TMP_DIR/rollback-$scenario.mockstate"

    run_ops_command_completed app-rollback
  ) >"$output" 2>&1
}

test_app_rollback() {
  rollback_retained_start="$GUIDE_RETAINED_LEASE_EXITS"
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
    operation_lease_acquire_ok_renew_fails \
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
    assert_retained_lease_exit_code "app rollback" "$scenario" "$status" "$output"
    if test "$scenario" = "success" || test "$scenario" = "update_failure"; then
      grep -Fqx \
        'az containerapp update --resource-group rg-patchpage-workload --name patchpage-app --container-name server --image acrpatchpageabc123.azurecr.io/patchpage-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --query properties.latestRevisionName --output tsv' \
        "$log" ||
        fail "rollback did not target only the expected Container App and digest"
    fi
    # As for app release: the identifiers and the producer diagnostics are the
    # driver's sweep, and the bare 64-hex conjunct is what only this flow can
    # say.
    if grep -Eq '[0-9a-f]{64}' "$output"; then
      fail "rollback exposed a workload-binding hash"
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
      operation_lease_acquire_ok_renew_fails)
        # Acquire succeeded, so Azure holds the infinite lease even though the
        # renew-as-proof blipped. The EXIT trap must still release it.
        if grep -Fq 'az containerapp update ' "$log"; then
          fail "rollback updated after fail-closed preflight $scenario"
        fi
        # Qualify the release against the infinite operation lease: a bare release
        # line could otherwise be satisfied by an unrelated finite binding lease.
        renew_blip_acquire_line="$(
          grep -nE '^az storage container lease acquire .* --lease-duration -1 ' "$log" |
            sed -n '1s/:.*//p'
        )"
        renew_blip_release_line="$(
          grep -nE '^az storage container lease release ' "$log" | sed -n '$s/:.*//p'
        )"
        if test -z "$renew_blip_acquire_line" || test -z "$renew_blip_release_line" ||
          test "$renew_blip_release_line" -le "$renew_blip_acquire_line"; then
          fail "rollback orphaned the acquired operation lease after a renew blip"
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
  test "$((GUIDE_RETAINED_LEASE_EXITS - rollback_retained_start))" -ge 5 ||
    fail "app rollback never exercised a deliberately retained operation lease"
}

run_infrastructure_change_block() {
  scenario="$1"
  # The second-operator review token this run is replaying an approval for.
  # Empty is the state every first run is in: nothing has been reviewed yet, so
  # the command may plan and report but must not apply.
  infrastructure_approval="${2:-}"
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
    CONTAINER_APP="patchpage-app"
    ACR="acrpatchpageabc123"
    LEGACY_IMAGE_TAG="1111111"
    LEGACY_IMAGE_DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    IMMUTABLE_IMAGE="acrpatchpageabc123.azurecr.io/patchpage-server@$LEGACY_IMAGE_DIGEST"
    OLD_REVISION_NAME="patchpage-app--stable"
    ADOPTION_REVISION_NAME="patchpage-app--adopted"
    POSTAPPLY_REVISION_NAME="patchpage-app--infra"
    LATER_REVISION_NAME="patchpage-app--later"
    EXPECTED_OPERATION_BINDING_SHA256="$(
      guide_operation_binding_sha256 "$STATE_KEY"
    )"
    TERRAFORM_DIAGNOSTIC_ROOT="$diagnostic_root"
    case "$scenario" in
      adoption_*) ADOPT_SAFETY_GUARDS="true" ;;
      invalid_adopt_value) ADOPT_SAFETY_GUARDS="yes" ;;
      *) ADOPT_SAFETY_GUARDS="false" ;;
    esac
    case "$scenario" in
      adoption_digest_current | adoption_legacy_digest_missing) ;;
      adoption_legacy_digest_mismatch)
        EXPECTED_LEGACY_IMAGE_DIGEST="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ;;
      adoption_*) EXPECTED_LEGACY_IMAGE_DIGEST="$LEGACY_IMAGE_DIGEST" ;;
    esac
    export SUBSCRIPTION_ID STATE_STORAGE_ACCOUNT STATE_CONTAINER STATE_KEY \
      OPERATION_PRINCIPAL_ID OPERATION_PRINCIPAL_TYPE \
      EXPECTED_OPERATION_AUTH_MODE EXPECTED_STATE_LINEAGE \
      EXPECTED_RESOURCE_GROUP_ID EXPECTED_STORAGE_ACCOUNT_ID \
      EXPECTED_POSTGRES_SERVER_ID EXPECTED_ACR_ID EXPECTED_CONTAINER_APP_ID \
      RESOURCE_GROUP CONTAINER_APP ACR LEGACY_IMAGE_TAG LEGACY_IMAGE_DIGEST \
      IMMUTABLE_IMAGE OLD_REVISION_NAME ADOPTION_REVISION_NAME \
      POSTAPPLY_REVISION_NAME LATER_REVISION_NAME \
      EXPECTED_OPERATION_BINDING_SHA256 TERRAFORM_DIAGNOSTIC_ROOT \
      ADOPT_SAFETY_GUARDS
    if test -n "${EXPECTED_LEGACY_IMAGE_DIGEST:-}"; then
      export EXPECTED_LEGACY_IMAGE_DIGEST
    fi
    # The block reads these as required private inputs, so an absent value has
    # to be absent from the child's environment too.
    case "$scenario" in
      adoption_operation_principal_id_missing) unset OPERATION_PRINCIPAL_ID ;;
      adoption_operation_principal_id_invalid)
        OPERATION_PRINCIPAL_ID="not-a-guid"
        export OPERATION_PRINCIPAL_ID
        ;;
      adoption_operation_principal_type_missing) unset OPERATION_PRINCIPAL_TYPE ;;
      adoption_operation_principal_type_invalid)
        OPERATION_PRINCIPAL_TYPE="Application"
        export OPERATION_PRINCIPAL_TYPE
        ;;
      adoption_operation_principal_group)
        OPERATION_PRINCIPAL_TYPE="Group"
        export OPERATION_PRINCIPAL_TYPE
        ;;
    esac

    case "$scenario" in
      plan_review_stale_token)
        # A well-formed token that no plan of this state ever produced: the
        # approval an operator would carry over from a plan that has since
        # drifted.
        INFRA_CHANGE_APPROVAL_SHA256="0000000000000000000000000000000000000000000000000000000000000000"
        export INFRA_CHANGE_APPROVAL_SHA256
        ;;
      *)
        if test -n "$infrastructure_approval"; then
          INFRA_CHANGE_APPROVAL_SHA256="$infrastructure_approval"
          export INFRA_CHANGE_APPROVAL_SHA256
        fi
        ;;
    esac

    PP_MOCK_GROUP="infrastructure"
    PP_MOCK_SCENARIO="$scenario"
    PP_MOCK_LOG="$log"
    PP_MOCK_REPO_ROOT="$scenario_root"
    PP_MOCK_SCENARIO_ROOT="$scenario_root"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG PP_MOCK_REPO_ROOT \
      PP_MOCK_SCENARIO_ROOT
    prepare_mock_state "$TMP_DIR/infrastructure-$scenario.mockstate"
    case "$scenario" in
      adoption_existing_unbound_success | adoption_binding_update_failure | \
        adoption_binding_concurrent_metadata | adoption_foreign_binding)
        : > "$PP_MOCK_STATE/operation-container-created"
        ;;
      adoption_*) ;;
      *) : > "$PP_MOCK_STATE/operation-container-created" ;;
    esac

    run_ops_command_completed infrastructure-change
  ) >"$output" 2>&1
}

test_infrastructure_change() {
  infrastructure_retained_start="$GUIDE_RETAINED_LEASE_EXITS"
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
      grep -Fq "$address" "$GUIDE_LIB_DIR/infra_change.sh" ||
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
    operation_lease_acquire_ok_renew_fails \
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
    plan_review_unapproved \
    plan_review_stale_token \
    success; do
    if run_infrastructure_change_block "$scenario"; then
      status=0
    else
      status=$?
    fi

    log="$TMP_DIR/infrastructure-$scenario.log"
    output="$TMP_DIR/infrastructure-$scenario.out"

    # Every scenario that gets past the plan now stops at the second-operator
    # review gate, so the scenarios below -- all written against a flow that ran
    # through to apply -- are replayed with the approval that run printed. The
    # token is read back from the run that produced it rather than hardcoded,
    # which is also what pins the property the gate depends on: two plans of the
    # same state render the same inventory and therefore the same token, so an
    # approval survives exactly one replay of an unchanged plan.
    case "$scenario" in
      plan_review_unapproved | plan_review_stale_token) ;;
      *)
        infrastructure_review_token="$(
          sed -n 's/^INFRA_CHANGE_APPROVAL_SHA256=//p' "$output"
        )"
        if test -n "$infrastructure_review_token"; then
          if run_infrastructure_change_block "$scenario" "$infrastructure_review_token"; then
            status=0
          else
            status=$?
          fi
        fi
        ;;
    esac

    assert_retained_lease_exit_code "infrastructure change" "$scenario" "$status" \
      "$output"
    diagnostic_path_file="$TMP_DIR/infrastructure-$scenario/diagnostic-dir"
    if test "$scenario" = "plan_review_unapproved" ||
      test "$scenario" = "plan_review_stale_token"; then
      infrastructure_review_token="$(
        sed -n 's/^INFRA_CHANGE_APPROVAL_SHA256=//p' "$output"
      )"
      printf '%s\n' "$infrastructure_review_token" | grep -Eq '^[0-9a-f]{64}$' ||
        fail "infrastructure change did not print a review token after $scenario"
      if grep -Eq '^tofu apply ' "$log"; then
        fail "infrastructure change applied without a matching approval after $scenario"
      fi
      grep -Eq '^az storage container lease release ' "$log" ||
        fail "infrastructure change kept the operation lease at the review gate after $scenario"
      if test "$scenario" = "plan_review_unapproved"; then
        test "$status" -eq 0 ||
          fail "infrastructure change plan-and-report exited $status instead of 0"
        grep -Fqx completed "$log" ||
          fail "infrastructure change plan-and-report did not complete"
        test ! -d "$(cat "$diagnostic_path_file")" ||
          fail "infrastructure change plan-and-report retained private OpenTofu diagnostics"
        # What makes the approval an approval of *these* actions: the token is
        # the digest of exactly the inventory text printed above it, recomputed
        # here from that text rather than taken on trust. A token that were a
        # constant, a nonce, or a digest of anything else fails this.
        infrastructure_reviewed_actions="$(
          sed -n '/^Second operator:/q;p' "$output"
        )"
        test -n "$infrastructure_reviewed_actions" ||
          fail "infrastructure change asked for approval without rendering an action inventory"
        test "$infrastructure_review_token" = "$(
          printf '%s\n' "$infrastructure_reviewed_actions" |
            openssl dgst -sha256 -r |
            cut -d ' ' -f1
        )" ||
          fail "the infrastructure review token is not the digest of the reviewed action inventory"
      else
        test "$status" -eq 1 ||
          fail "infrastructure change stale approval exited $status instead of 1"
        grep -Fq 'The second-operator approval does not match this plan' "$output" ||
          fail "infrastructure change did not report the approval/plan mismatch"
        if grep -q '^completed$' "$log"; then
          fail "infrastructure change continued after $scenario"
        fi
      fi
    elif test "$scenario" = "success" ||
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
          /^tofu plan -input=false -out=.*\/infrastructure\.tfplan$/ {
            sub(/^tofu plan -input=false -out=/, "")
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
      test "$(grep -Fxc "tofu show -json $infra_plan" "$log")" -eq 1 ||
        fail "infrastructure change did not capture the saved plan JSON exactly once"
      test "$(grep -Fxc "tofu apply -input=false $infra_plan" "$log")" -eq 1 ||
        fail "infrastructure change did not apply exactly the reviewed saved plan"
      test -f "$diagnostic_path_file" ||
        fail "successful infrastructure change did not create a private diagnostic location"
      if test "$scenario" = "infra_diagnostic_cleanup_failure"; then
        test -d "$(cat "$diagnostic_path_file")" ||
          fail "infrastructure cleanup-failure scenario unexpectedly removed diagnostics"
        grep -Fqx 'OpenTofu succeeded, but private diagnostic cleanup failed.' "$output" ||
          fail "infrastructure cleanup failure did not emit only its generic error"
      else
        test ! -d "$(cat "$diagnostic_path_file")" ||
          fail "successful infrastructure change retained private OpenTofu diagnostics"
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
            'tofu import -input=false azurerm_management_lock.drafts_storage /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.Storage/storageAccounts/patchpagedrafts/providers/Microsoft.Authorization/locks/protect-patchpage-drafts' \
            "$log" ||
            fail "safety adoption did not bind the Storage lock to OpenTofu state"
          grep -Fqx \
            'tofu import -input=false azurerm_management_lock.patchpage_postgres /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-db/providers/Microsoft.Authorization/locks/protect-patchpage-postgres' \
            "$log" ||
            fail "safety adoption did not bind the PostgreSQL lock to OpenTofu state"
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
          plan_line="$(grep -nE '^tofu plan ' "$log" | sed -n '1s/:.*//p')"
          apply_line="$(grep -nE '^tofu apply ' "$log" | sed -n '1s/:.*//p')"
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
        grep -Eq '^tofu apply -input=false .*/infrastructure\.tfplan$' "$log"; then
        fail "infrastructure change reached apply after $scenario"
      fi
      if grep -q '^completed$' "$log"; then
        fail "infrastructure change continued after $scenario"
      fi
    fi
    if grep -Eq \
      'private-infra-(az|tofu)-diagnostic|22222222-2222-4222-8222-222222222222|33333333-3333-3333-3333-333333333333|44444444-4444-4444-4444-444444444444|patchpagestate' \
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
        if grep -Eq '^az storage container lease acquire |^tofu (plan|apply) ' "$log"; then
          fail "safety adoption reached the lease or OpenTofu after unsafe operation-storage preflight $scenario"
        fi
        ;;
      adoption_binding_update_failure | adoption_binding_concurrent_metadata)
        if grep -Eq \
          '^az storage container lease acquire .* --lease-duration -1 |^tofu (plan|apply) ' \
          "$log"; then
          fail "safety adoption reached the operation lease or OpenTofu after $scenario"
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
        if grep -Eq '^tofu (plan|apply) ' "$log"; then
          fail "safety adoption planned after a management-lock state import failed"
        fi
        ;;
      adoption_legacy_digest_missing | adoption_legacy_digest_mismatch)
        if grep -Fq 'az containerapp update ' "$log"; then
          fail "safety adoption updated a legacy tag without the separately verified digest"
        fi
        ;;
      adoption_image_config_mismatch)
        if grep -Eq '^tofu (plan|apply) ' "$log"; then
          fail "safety adoption planned after OpenTofu rejected the synchronized image"
        fi
        ;;
      operation_lease_acquire_ok_renew_fails)
        # Acquire succeeded, so Azure holds the infinite lease even though the
        # renew-as-proof blipped. The EXIT trap must still release it.
        if grep -Eq '^tofu (plan|apply) ' "$log"; then
          fail "infrastructure change planned or applied after rejecting $scenario"
        fi
        # Qualify the release against the infinite operation lease: the finite
        # binding lease in this flow also acquires and releases, so a bare release
        # line could be satisfied by that one after a reordering.
        renew_blip_acquire_line="$(
          grep -nE '^az storage container lease acquire .* --lease-duration -1 ' "$log" |
            sed -n '1s/:.*//p'
        )"
        renew_blip_release_line="$(
          grep -nE '^az storage container lease release ' "$log" | sed -n '$s/:.*//p'
        )"
        if test -z "$renew_blip_acquire_line" || test -z "$renew_blip_release_line" ||
          test "$renew_blip_release_line" -le "$renew_blip_acquire_line"; then
          fail "infrastructure change orphaned the acquired operation lease after a renew blip"
        fi
        ;;
      operation_container_id_mismatch | operation_container_missing | operation_container_nonempty | operation_lease_held | \
        operation_lease_acquire_failure | operation_lease_renew_failure)
        if grep -Eq '^tofu (plan|apply) ' "$log"; then
          fail "infrastructure change planned or applied after rejecting $scenario"
        fi
        ;;
      operation_lease_release_failure)
        grep -Eq '^tofu apply -input=false .*/infrastructure\.tfplan$' "$log" ||
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
        fail "readiness recovery lost the private OpenTofu diagnostic location"
      readiness_diagnostic_dir="$(cat "$diagnostic_path_file")"
      test -d "$readiness_diagnostic_dir" ||
        fail "readiness recovery removed private OpenTofu diagnostics"
      test -f "$readiness_diagnostic_dir/terraform.log" ||
        fail "readiness recovery did not preserve the OpenTofu log"
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
    if test "$scenario" = "plan_failure"; then
      test -f "$diagnostic_path_file" ||
        fail "failed infrastructure change lost its private diagnostic location"
      diagnostic_log="$(cat "$diagnostic_path_file")/terraform.log"
      test -f "$diagnostic_log" ||
        fail "failed infrastructure change did not preserve OpenTofu diagnostics"
      diagnostic_mode="$(
        file_mode "$diagnostic_log"
      )"
      test "$diagnostic_mode" = "600" ||
        fail "failed infrastructure diagnostic log is not mode 0600"
      grep -Fq 'private-infra-tofu-diagnostic plan -input=false' "$diagnostic_log" ||
        fail "failed infrastructure diagnostic log omitted provider diagnostics"
    fi
  done
  test "$((GUIDE_RETAINED_LEASE_EXITS - infrastructure_retained_start))" -ge 3 ||
    fail "infrastructure change never exercised a deliberately retained operation lease"
}

# --- the infrastructure plan/apply session ------------------------------------
#
# infrastructure-plan, infrastructure-apply and infrastructure-abandon are one
# flow across three processes, so unlike every other group here a scenario is a
# *sequence* of commands sharing one mock state directory, one command log and
# one session root. That sharing is the point: the operation lease the plan
# takes has to still be there when the apply renews it, and the only way to test
# that is to let one process's state be the next process's world.
#
# The scenarios are the ways the handoff can be wrong, not the ways the plan can
# be wrong -- the plan half is the same library the twenty infrastructure-change
# scenarios already drive, and re-testing it here would only pin it twice.

# The bytes tests/mocks/tofu writes for a saved plan, and their SHA-256. Both
# are stated here rather than computed, so a change to either side of the
# session's integrity check has to be made deliberately in two places.
GUIDE_SESSION_PLAN_BYTES="patchpage-mock-infrastructure-plan"
GUIDE_SESSION_PLAN_SHA256="8f0c4197a0e5fa9fa8d7f60dc2fb7e7a2213ed4fa05945fa35f5490a2911f733"

guide_session_paths() {
  session_scenario="$1"
  session_root="$TMP_DIR/session-$session_scenario-root"
  session_repo="$TMP_DIR/session-$session_scenario-repo"
  session_diagnostics="$TMP_DIR/session-$session_scenario-diagnostics"
  session_dir="$session_root/patchpage-infrastructure-session"
}

guide_session_setup() {
  guide_session_paths "$1"
  rm -rf "$session_root" "$session_repo" "$session_diagnostics"
  mkdir -p "$session_root" "$session_repo/infra/azure" "$session_diagnostics"
  session_root="$(CDPATH= cd -- "$session_root" && pwd -P)"
  session_diagnostics="$(CDPATH= cd -- "$session_diagnostics" && pwd -P)"
  session_dir="$session_root/patchpage-infrastructure-session"
  prepare_mock_state "$TMP_DIR/session-$1.mockstate"
  # Every session scenario runs against an environment whose operation
  # container is already sealed; adoption is infrastructure-change's subject.
  : > "$PP_MOCK_STATE/operation-container-created"
}

# Runs one command of a session. The step name only names the output file, so a
# scenario can run the same command twice and keep both captures.
run_infrastructure_session_command() {
  session_scenario="$1"
  session_command="$2"
  session_step="$3"
  session_approval="${4:-}"
  session_root_override="${5:-$session_root}"
  output="$TMP_DIR/session-$session_scenario-$session_step.out"
  # One log per step, not per scenario. What the three processes of a session
  # share is the mock state -- the operation lease, the plan marker -- and that
  # is the sharing under test. Their command logs are separate so an assertion
  # about what the apply did cannot be satisfied by something the plan did.
  session_log="$TMP_DIR/session-$session_scenario-$session_step.log"
  : > "$session_log"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    STATE_STORAGE_ACCOUNT="patchpagestate"
    STATE_CONTAINER="tfstate"
    STATE_KEY="patchpage-prod.tfstate"
    EXPECTED_OPERATION_AUTH_MODE="key"
    EXPECTED_STATE_LINEAGE="11111111-1111-1111-1111-111111111111"
    EXPECTED_RESOURCE_GROUP_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-workload"
    EXPECTED_STORAGE_ACCOUNT_ID="$EXPECTED_RESOURCE_GROUP_ID/providers/Microsoft.Storage/storageAccounts/patchpagedrafts"
    EXPECTED_POSTGRES_SERVER_ID="$EXPECTED_RESOURCE_GROUP_ID/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-db"
    EXPECTED_ACR_ID="$EXPECTED_RESOURCE_GROUP_ID/providers/Microsoft.ContainerRegistry/registries/acrpatchpageabc123"
    EXPECTED_CONTAINER_APP_ID="$EXPECTED_RESOURCE_GROUP_ID/providers/Microsoft.App/containerApps/patchpage-app"
    RESOURCE_GROUP="rg-patchpage-workload"
    CONTAINER_APP="patchpage-app"
    ACR="acrpatchpageabc123"
    LEGACY_IMAGE_TAG="1111111"
    LEGACY_IMAGE_DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    IMMUTABLE_IMAGE="acrpatchpageabc123.azurecr.io/patchpage-server@$LEGACY_IMAGE_DIGEST"
    OLD_REVISION_NAME="patchpage-app--stable"
    ADOPTION_REVISION_NAME="patchpage-app--adopted"
    POSTAPPLY_REVISION_NAME="patchpage-app--infra"
    LATER_REVISION_NAME="patchpage-app--later"
    EXPECTED_OPERATION_BINDING_SHA256="$(
      guide_operation_binding_sha256 "$STATE_KEY"
    )"
    TERRAFORM_DIAGNOSTIC_ROOT="$session_diagnostics"
    INFRA_CHANGE_SESSION_ROOT="$session_root_override"
    ADOPT_SAFETY_GUARDS="false"
    export SUBSCRIPTION_ID STATE_STORAGE_ACCOUNT STATE_CONTAINER STATE_KEY \
      EXPECTED_OPERATION_AUTH_MODE EXPECTED_STATE_LINEAGE \
      EXPECTED_RESOURCE_GROUP_ID EXPECTED_STORAGE_ACCOUNT_ID \
      EXPECTED_POSTGRES_SERVER_ID EXPECTED_ACR_ID EXPECTED_CONTAINER_APP_ID \
      RESOURCE_GROUP CONTAINER_APP ACR LEGACY_IMAGE_TAG LEGACY_IMAGE_DIGEST \
      IMMUTABLE_IMAGE OLD_REVISION_NAME ADOPTION_REVISION_NAME \
      POSTAPPLY_REVISION_NAME LATER_REVISION_NAME \
      EXPECTED_OPERATION_BINDING_SHA256 TERRAFORM_DIAGNOSTIC_ROOT \
      INFRA_CHANGE_SESSION_ROOT ADOPT_SAFETY_GUARDS
    if test -n "$session_approval"; then
      INFRA_CHANGE_APPROVAL_SHA256="$session_approval"
      export INFRA_CHANGE_APPROVAL_SHA256
    fi

    PP_MOCK_GROUP="infrastructure"
    PP_MOCK_SCENARIO="$session_scenario"
    PP_MOCK_LOG="$session_log"
    PP_MOCK_REPO_ROOT="$session_repo"
    PP_MOCK_SCENARIO_ROOT="$session_repo"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG PP_MOCK_REPO_ROOT \
      PP_MOCK_SCENARIO_ROOT

    run_ops_command_completed "$session_command"
  ) >"$output" 2>&1
}

# The recorded operation lease, read back from the session the way the apply
# reads it. Used to state, from outside the commands, whether the container is
# still leased to the plan.
guide_session_lease_is_held() {
  test -f "$PP_MOCK_STATE/operation-lease-id"
}

# Runs one session command, records its status, and holds it to the exit-code
# contract every other flow here is held to: a run that says it kept the
# operation lease must exit 75, and a run that exits 75 must say so. The session
# commands are the first ones that can end with the lease deliberately held
# *without* being in that state -- infrastructure-plan holds it and exits 0 --
# so putting them through the same assertion is what keeps that exception to
# exactly the one message that names it.
guide_session_run() {
  if run_infrastructure_session_command "$@"; then
    session_status=0
  else
    session_status=$?
  fi
  session_output="$TMP_DIR/session-$1-$3.out"
  session_log="$TMP_DIR/session-$1-$3.log"
  assert_retained_lease_exit_code "infrastructure session $2" "$1" \
    "$session_status" "$session_output"
}

guide_session_run_plan() {
  guide_session_run "$1" infrastructure-plan plan
  session_plan_output="$TMP_DIR/session-$1-plan.out"
  session_token="$(
    sed -n 's/^INFRA_CHANGE_APPROVAL_SHA256=//p' "$session_plan_output"
  )"
}

test_infrastructure_session() {
  session_retained_start="$GUIDE_RETAINED_LEASE_EXITS"

  # --- the handoff itself ----------------------------------------------------
  guide_session_setup session_success
  guide_session_run_plan session_success
  test "$session_status" -eq 0 ||
    fail "infrastructure plan rejected the session handoff"
  printf '%s\n' "$session_token" | grep -Eq '^[0-9a-f]{64}$' ||
    fail "infrastructure plan did not print a well-formed review token"
  test -d "$session_dir" ||
    fail "infrastructure plan did not leave a session behind"
  test "$(file_mode "$session_dir")" = "700" ||
    fail "the infrastructure session directory is not private"
  for session_field in plan.tfplan plan.sha256 inventory lease revision \
    locked-image planned-image; do
    test -f "$session_dir/$session_field" ||
      fail "the infrastructure session is missing $session_field"
    test "$(file_mode "$session_dir/$session_field")" = "600" ||
      fail "the infrastructure session field $session_field is not private"
  done
  test "$(cat "$session_dir/plan.tfplan")" = "$GUIDE_SESSION_PLAN_BYTES" ||
    fail "the infrastructure session did not preserve the saved plan"
  test "$(cat "$session_dir/plan.sha256")" = "$GUIDE_SESSION_PLAN_SHA256" ||
    fail "the infrastructure session recorded the wrong plan digest"
  # The whole reason the session exists: the environment is still held.
  guide_session_lease_is_held ||
    fail "infrastructure plan gave the operation lease back and left nothing holding the reviewed plan's world still"
  test "$(cat "$session_dir/lease")" = "$(cat "$PP_MOCK_STATE/operation-lease-id")" ||
    fail "the infrastructure session recorded a lease it is not holding"
  grep -Fq 'The operation lease is held for this session.' "$session_plan_output" ||
    fail "infrastructure plan did not say the lease is still held"
  if grep -Fq 'tofu apply ' "$session_log"; then
    fail "infrastructure plan applied something"
  fi

  guide_session_run session_success infrastructure-apply apply "$session_token"
  test "$session_status" -eq 0 ||
    fail "infrastructure apply rejected its own session"
  # The exact saved plan file, not a path this process could have replanned to.
  grep -Fqx "tofu apply -input=false $session_dir/plan.tfplan" "$session_log" ||
    fail "infrastructure apply did not apply the exact plan file the session preserved"
  test ! -e "$session_dir" ||
    fail "infrastructure apply left the session behind"
  if guide_session_lease_is_held; then
    fail "infrastructure apply did not give the operation lease back"
  fi

  # --- a plan that is not the plan that was reviewed --------------------------
  guide_session_setup session_tampered_plan
  guide_session_run_plan session_tampered_plan
  test "$session_status" -eq 0 ||
    fail "infrastructure plan failed before the tamper scenario could tamper"
  printf '%s\n' "tampered" >> "$session_dir/plan.tfplan" ||
    fail "could not tamper with the saved plan"
  guide_session_run session_tampered_plan infrastructure-apply apply \
    "$session_token"
  test "$session_status" -ne 0 ||
    fail "infrastructure apply accepted a saved plan that had been edited"
  grep -Fq 'is not the plan that was reviewed' "$session_output" ||
    fail "infrastructure apply did not name the plan-integrity failure"
  if grep -Fq 'tofu apply ' "$session_log"; then
    fail "infrastructure apply applied a tampered plan"
  fi
  # Refused before the lease was touched: the session is intact and still holds
  # the environment, so the operator can review again or abandon.
  test -d "$session_dir" ||
    fail "infrastructure apply discarded a session it refused"
  guide_session_lease_is_held ||
    fail "infrastructure apply gave back a lease it never took"

  # --- an approval that names other actions ----------------------------------
  guide_session_setup session_wrong_token
  guide_session_run_plan session_wrong_token
  test "$session_status" -eq 0 || fail "infrastructure plan failed before the token scenario"
  guide_session_run session_wrong_token infrastructure-apply apply \
    "0000000000000000000000000000000000000000000000000000000000000000"
  test "$session_status" -ne 0 ||
    fail "infrastructure apply accepted an approval for other actions"
  if grep -Fq 'tofu apply ' "$session_log"; then
    fail "infrastructure apply applied an unapproved plan"
  fi
  guide_session_lease_is_held ||
    fail "a refused approval cost the session its operation lease"

  # --- the lease was recovered between the review and the apply ---------------
  #
  # A second operator proved this session's process was gone and ran
  # stale-lease-recovery. The saved plan is still on disk and still hashes
  # correctly; what it no longer describes is an environment nobody has touched.
  guide_session_setup session_stale_lease
  guide_session_run_plan session_stale_lease
  test "$session_status" -eq 0 || fail "infrastructure plan failed before the stale-lease scenario"
  rm -f "$PP_MOCK_STATE/operation-lease-id" ||
    fail "could not simulate the recovered operation lease"
  guide_session_run session_stale_lease infrastructure-apply apply \
    "$session_token"
  test "$session_status" -ne 0 ||
    fail "infrastructure apply applied a reviewed plan after its lease was recovered"
  grep -Fq 'no longer holding the operation lease' "$session_output" ||
    fail "infrastructure apply did not name the lost lease"
  if grep -Fq 'tofu apply ' "$session_log"; then
    fail "infrastructure apply applied a plan whose lease it could not renew"
  fi

  # --- no session at all ------------------------------------------------------
  guide_session_setup session_missing
  guide_session_run session_missing infrastructure-apply apply \
    "0000000000000000000000000000000000000000000000000000000000000000"
  test "$session_status" -ne 0 ||
    fail "infrastructure apply ran without a reviewed plan"
  grep -Fq 'No reviewed infrastructure plan is open' "$session_output" ||
    fail "infrastructure apply did not name the missing session"

  # --- abandoning -------------------------------------------------------------
  guide_session_setup session_abandon
  guide_session_run_plan session_abandon
  test "$session_status" -eq 0 || fail "infrastructure plan failed before the abandon scenario"
  guide_session_run session_abandon infrastructure-abandon abandon
  test "$session_status" -eq 0 || fail "infrastructure abandon refused an open session"
  grep -Fqx 'Infrastructure session abandoned.' "$session_output" ||
    fail "infrastructure abandon did not report completion"
  test ! -e "$session_dir" || fail "infrastructure abandon left the session behind"
  if guide_session_lease_is_held; then
    fail "infrastructure abandon did not give the operation lease back"
  fi
  # It loads no OpenTofu at all: a session must stay closable when the thing it
  # was planning against is what is broken.
  if grep -Fq 'tofu ' "$session_log"; then
    fail "infrastructure abandon ran OpenTofu"
  fi

  # --- abandoning a session whose lease is already gone -----------------------
  guide_session_setup session_abandon_recovered
  guide_session_run_plan session_abandon_recovered
  test "$session_status" -eq 0 ||
    fail "infrastructure plan failed before the recovered-abandon scenario"
  rm -f "$PP_MOCK_STATE/operation-lease-id" ||
    fail "could not simulate the recovered operation lease"
  guide_session_run session_abandon_recovered infrastructure-abandon abandon
  test "$session_status" -eq 0 ||
    fail "infrastructure abandon escalated over a lease that was already recovered"
  test ! -e "$session_dir" ||
    fail "infrastructure abandon kept a session whose lease was already gone"

  # --- a second session over an open one --------------------------------------
  guide_session_setup session_reopen
  guide_session_run_plan session_reopen
  test "$session_status" -eq 0 || fail "infrastructure plan failed before the reopen scenario"
  session_first_lease="$(cat "$session_dir/lease")"
  guide_session_run session_reopen infrastructure-plan replan
  test "$session_status" -ne 0 ||
    fail "infrastructure plan opened a second session over an open one"
  grep -Fq 'An infrastructure session is already open' "$session_output" ||
    fail "infrastructure plan did not name the open session"
  test "$(cat "$session_dir/lease")" = "$session_first_lease" ||
    fail "the refused second plan overwrote the open session"
  guide_session_lease_is_held ||
    fail "the refused second plan released the open session's lease"

  # --- a session root inside the repository -----------------------------------
  #
  # A saved plan is a complete description of an environment, and one written
  # inside the repository is one `git add -A` away from being published. The
  # refusal has to land before anything is planned or leased.
  guide_session_setup session_inside_repo
  guide_session_run session_inside_repo infrastructure-plan plan "" \
    "$session_repo/infra"
  test "$session_status" -ne 0 ||
    fail "infrastructure plan wrote its session inside the repository"
  grep -Fq 'must remain outside the repository' "$session_output" ||
    fail "infrastructure plan did not name the in-repository session root"
  if grep -Fq 'az storage container lease acquire ' "$session_log"; then
    fail "infrastructure plan took the operation lease before vetting its session root"
  fi

  # No session command may retain a lease, so this group must contribute nothing
  # to the retained-lease count. Stated rather than assumed: a session command
  # that started exiting 75 would otherwise pass silently.
  test "$GUIDE_RETAINED_LEASE_EXITS" -eq "$session_retained_start" ||
    fail "an infrastructure session command retained the operation lease"

  # The two facts an operator cannot discover from the commands' own output: the
  # lease is deliberately held between the plan and the apply, and the saved
  # plan is what the apply checks rather than a fresh one.
  grep -Fq 'the operation lease stays held' "$README" ||
    fail "the infrastructure session guidance omits that the lease is held across the review"
  grep -Fq 'still hashes to the digest recorded at review time' "$README" ||
    fail "the infrastructure session guidance omits the saved-plan integrity check"
  grep -Fq 'What it cannot carry forward is the plan itself' "$README" ||
    fail "the guide no longer says what the one-shot flow does not carry between its two runs"
}

# The lease ID the winning recoverer holds in the concurrent-recovery scenario.
GUIDE_CONCURRENT_RECOVERY_LEASE_ID="99999999-9999-9999-9999-999999999999"

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
    export SUBSCRIPTION_ID STATE_STORAGE_ACCOUNT STATE_CONTAINER STATE_KEY \
      RESOURCE_GROUP CONTAINER_APP ACR EXPECTED_STORAGE_ACCOUNT_ID \
      EXPECTED_POSTGRES_SERVER_ID
    if test "$scenario" != "confirmation_missing"; then
      CONFIRM_STALE_OPERATION_LEASE="second-operator-confirmed-no-active-operation"
      export CONFIRM_STALE_OPERATION_LEASE
    fi

    PP_MOCK_GROUP="stale-lease"
    PP_MOCK_SCENARIO="$scenario"
    PP_MOCK_LOG="$log"
    # This flow names its lease failures without the operation_lease_ prefix
    # the release, rollback, deploy and infrastructure flows use.
    PP_MOCK_LEASE_SCENARIO_PREFIX=""
    PP_MOCK_OPERATION_BINDING_SHA256="$(
      guide_operation_binding_sha256 "$STATE_KEY"
    )"
    # The lease the *other* recoverer holds in the concurrent scenario. It is a
    # fixed value the harness knows, so the loser's log can be checked for ever
    # having named it: a loser that somehow released the winner's lease would be
    # doing the one thing the single-flight rule exists to prevent.
    PP_MOCK_CONCURRENT_LEASE_ID="$GUIDE_CONCURRENT_RECOVERY_LEASE_ID"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG \
      PP_MOCK_LEASE_SCENARIO_PREFIX PP_MOCK_OPERATION_BINDING_SHA256 \
      PP_MOCK_CONCURRENT_LEASE_ID
    prepare_mock_state "$TMP_DIR/stale-lease-$scenario.mockstate"

    run_ops_command_completed stale-lease-recovery
  ) >"$output" 2>&1
}

test_stale_lease_recovery() {
  stale_lease_retained_start="$GUIDE_RETAINED_LEASE_EXITS"
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
    concurrent_recovery \
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
    # Recovery holds a lease of its own between acquire and release, so it is
    # held to the same contract as the flows it recovers: if its own release
    # fails, the container is left leased and the caller must be told to stop
    # rather than to retry.
    assert_retained_lease_exit_code "stale lease recovery" "$scenario" "$status" \
      "$output"
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
      case "$scenario" in
        operation_container_lookup_failure | operation_container_identity_mismatch | \
          binding_lookup_failure | foreign_binding)
          if grep -Fq 'az storage container lease break ' "$log"; then
            fail "stale operation lease recovery broke a lease after $scenario"
          fi
          ;;
        concurrent_recovery)
          # The losing side of the race. Its break landed, a second recoverer
          # took the container back in that instant, and its own acquire was
          # refused. Three things have to be true of what it did next.
          #
          # First: it stopped. The refused acquire has to be the last thing it
          # sent, so the assertion is on the final logged call rather than on a
          # list of forbidden verbs -- a future release, renew, break or
          # metadata write would all fail this, including ones nobody has
          # written yet.
          grep -Fq 'az storage container lease break ' "$log" ||
            fail "the losing recoverer never reached the lease break, so $scenario proved nothing"
          test "$(
            grep -cF 'az storage container lease acquire ' "$log" | tr -d ' '
          )" = "1" ||
            fail "the losing recoverer did not attempt exactly one acquire during $scenario"
          case "$(tail -n 1 "$log")" in
            'az storage container lease acquire '*) ;;
            *)
              fail "the losing recoverer kept calling Azure after its acquire was refused during $scenario"
              ;;
          esac
          # Second: it never named the winner's lease. Releasing or renewing the
          # lease the other operator is holding is the precise harm the
          # single-flight rule exists to prevent.
          if grep -Fq "$GUIDE_CONCURRENT_RECOVERY_LEASE_ID" "$log"; then
            fail "the losing recoverer touched the winning recoverer's lease during $scenario"
          fi
          # Third: it did not claim success, on stdout or through the exit code.
          if grep -Fq 'Operation lease recovery completed.' "$output"; then
            fail "the losing recoverer claimed success during $scenario"
          fi
          test "$status" -eq 1 ||
            fail "the losing recoverer exited $status instead of 1 during $scenario"
          ;;
      esac
    fi
  done
  # Exactly one winner, asserted across the pair rather than inside either run:
  # the point of the change is that two recoverers cannot both come away
  # believing they hold the lease, and neither run alone can say that.
  stale_lease_winners=0
  for stale_lease_outcome in success concurrent_recovery; do
    if grep -Fqx 'Operation lease recovery completed.' \
      "$TMP_DIR/stale-lease-$stale_lease_outcome.out"; then
      stale_lease_winners=$((stale_lease_winners + 1))
    fi
  done
  test "$stale_lease_winners" -eq 1 ||
    fail "two concurrent recoverers produced $stale_lease_winners winners, not exactly one"

  # The single-flight property itself: nothing may sit between the break and the
  # acquire. Every call this command makes is logged, so "adjacent in the log"
  # is "nothing was sent in between" -- which is the whole of the window a
  # second recoverer could have used.
  stale_lease_success_log="$TMP_DIR/stale-lease-success.log"
  stale_lease_break_line="$(
    grep -nF 'az storage container lease break ' "$stale_lease_success_log" |
      sed -n '1s/:.*//p'
  )"
  stale_lease_acquire_line="$(
    grep -nF 'az storage container lease acquire ' "$stale_lease_success_log" |
      sed -n '1s/:.*//p'
  )"
  test -n "$stale_lease_break_line" && test -n "$stale_lease_acquire_line" ||
    fail "stale operation lease recovery did not both break and acquire"
  test "$((stale_lease_break_line + 1))" -eq "$stale_lease_acquire_line" ||
    fail "stale operation lease recovery sent a call between the lease break and the reacquire"

  # The log can only show the calls that were made, and minting a lease ID makes
  # none -- it is an od, a grep and a sed. Those three process spawns are real
  # time between the break and the acquire all the same, so where the minting
  # sits is pinned in the source instead.
  stale_lease_source="$GUIDE_CMD_DIR/stale-lease-recovery.sh"
  stale_lease_mint_line="$(
    grep -nF '/dev/urandom' "$stale_lease_source" | sed -n '1s/:.*//p'
  )"
  stale_lease_source_break_line="$(
    grep -nF 'private_az storage container lease break' "$stale_lease_source" |
      sed -n '1s/:.*//p'
  )"
  test -n "$stale_lease_mint_line" && test -n "$stale_lease_source_break_line" ||
    fail "stale operation lease recovery no longer mints a lease ID or breaks a lease"
  test "$stale_lease_mint_line" -lt "$stale_lease_source_break_line" ||
    fail "stale operation lease recovery mints its lease ID after the break, reopening the window a second recoverer breaks into"

  test "$((GUIDE_RETAINED_LEASE_EXITS - stale_lease_retained_start))" -ge 1 ||
    fail "stale lease recovery never exercised a lease it could not give back"
  grep -Fq 'A second authorized operator must independently verify' "$README" ||
    fail "stale operation lease guidance omitted second-operator verification"
  grep -Fq 'An infinite lease survives `SIGKILL`' "$README" ||
    fail "stale operation lease guidance omitted uncatchable-kill behavior"
}

# Returns 0 when every given shell source reaches its tools through PATH, 1 when
# one of them names a tool by absolute path. The harness only proves a
# documented command because that command resolves to a shim in tests/mocks; an
# absolute path such as /usr/bin/az would run the real tool and silently take
# the step out of the harness's reach. Takes the files so the check itself can
# be meta-tested against a sabotaged copy.
# Deliberately reports status instead of calling fail.
#
# The runbooks are executables now, so this scans ops.sh and cmd/*.sh whole
# rather than the guide's ```sh fences: the shell moved, and the rule has to
# move with it. PR E turns the guide-side check into fence purity.
#
# Exactly what this guarantees: none of the 13 tools the harness mocks -- az,
# terraform, tofu, git, curl, dig, jq, openssl, mktemp, chmod, sleep, cat, rm --
# is named by an absolute path. That is the one bypass that would fail silently,
# because the real tool would answer and the command would still look like it
# passed.
#
# What it deliberately does not catch: `command -p az`, which resolves against
# the implementation-defined default PATH, and a `PATH=/usr/bin az ...`
# assignment prefix. Both are left to CI rather than pattern-matched here: no
# real az, terraform or dig exists on the runner, so either construct fails
# loudly on the very first documented command instead of quietly passing. A
# regex for them would also have to model shell quoting to avoid false
# positives on prose and on the guide's own PATH-setting examples.
ops_sources_reach_tools_through_path() {
  awk '
    $0 ~ "(^|[^[:alnum:]_./-])/([[:alnum:]_.-]+/)*(az|terraform|tofu|git|curl|dig|jq|openssl|mktemp|chmod|sleep|cat|rm)([^[:alnum:]_./-]|$)" {
      absolute_tool_path = 1
    }
    END { exit absolute_tool_path ? 1 : 0 }
  ' "$@"
}

# Returns 0 when the guide no longer carries any of the runbooks that moved into
# cmd/, 1 otherwise. Two independent statements, because either one alone rots:
# no `guide-test` marker survives, and no ```sh fence is anywhere near
# block-sized. The smallest runbook that moved is 45 lines, so a 40-line ceiling
# cannot be satisfied by a re-inlined runbook. Takes the guide file so the check
# itself can be meta-tested against a sabotaged copy.
# Deliberately reports status instead of calling fail.
# Returns 0 when none of the given files mentions `trap`, 1 when one does. Two
# of the commands are documented as `. cmd/<name>.sh`, so they run in the
# operator's own shell. A trap installed there is installed on that shell: no
# process ends to take it down, and it would fire on whatever the operator ran
# next, or silently replace a handler they were relying on. Nothing in either
# file needs one -- neither creates anything to clean up -- so the rule is that
# the word does not appear in them at all, in code or in prose, which is the
# version of it that cannot be argued with. Takes the files so the check itself
# can be meta-tested against a sabotaged copy.
# Deliberately reports status instead of calling fail.
sourced_commands_install_no_trap() {
  awk '
    $0 ~ "(^|[^[:alnum:]_])trap([^[:alnum:]_]|$)" { installs_trap = 1 }
    END { exit installs_trap ? 1 : 0 }
  ' "$@"
}

guide_carries_no_moved_runbook() {
  awk '
    /^<!-- guide-test:/ { marker = 1 }
    $0 == "```sh" { fence = NR; next }
    $0 == "```" && fence { if (NR - fence - 1 > 40) oversized = 1; fence = 0 }
    END { exit (marker || oversized) ? 1 : 0 }
  ' "$1"
}

# Returns 0 when every scenario name the merged release/rollback Container App
# mocks treat as flow-specific is used by exactly one of the two flows, 1
# otherwise. Takes the harness file and the az shim so the check itself can be
# meta-tested against a sabotaged copy.
# Deliberately reports status instead of calling fail.
#
# az_containerapp_show and az_containerapp_revision in tests/mocks/az serve both
# flows from one implementation. The two scenario lists overlap heavily, and
# that is fine: a shared name drives an assertion both flows make. What would
# not be fine is a name that means one thing to release and another to rollback,
# because the merged case arm would fire in a flow it was never written for. The
# names below are the ones those arms special-case, so each must stay exclusive
# to its flow -- and must still be referenced in the merged functions, so the
# pin cannot rot into a check of names nothing reads any more.
merged_containerapp_scenarios_are_flow_exclusive() {
  awk -v harness="$1" -v az_mock="$2" \
    -v release_only_names="deployed_image_mismatch deployed_image_show_failure prelease_locked_image_mismatch preupdate_image_mismatch rollback_image_show_failure rollback_image_invalid rollback_digest_invalid" \
    -v rollback_only_names="stale_current_image postupdate_image_mismatch" '
    BEGIN {
      release_only_count = split(release_only_names, release_only, " ")
      rollback_only_count = split(rollback_only_names, rollback_only, " ")
    }
    FILENAME == harness {
      if ($0 == "test_app_release() {") { flow = "release"; next }
      if ($0 == "test_app_rollback() {") { flow = "rollback"; next }
      if (flow != "" && $0 == "  for scenario in \\") { collecting = 1; next }
      if (collecting) {
        gsub(/\\/, " ")
        gsub(/;/, " ")
        for (i = 1; i <= NF; i++) {
          if ($i == "do") { collecting = 0; flow = ""; break }
          used[flow " " $i] = 1
        }
      }
      next
    }
    FILENAME == az_mock {
      if ($0 == "az_containerapp_show() {") { in_merged = 1 }
      else if (in_merged && $0 ~ /^# -----/) { in_merged = 0 }
      if (in_merged) { merged = merged " " $0 }
      next
    }
    END {
      broken = 0
      # Both lists must have been found at all, or every check below is vacuous.
      if (!used["release success"] || !used["rollback success"]) { broken = 1 }
      for (i = 1; i <= release_only_count; i++) {
        name = release_only[i]
        if (!used["release " name] || used["rollback " name]) { broken = 1 }
        if (merged !~ ("[^[:alnum:]_]" name "[^[:alnum:]_]")) { broken = 1 }
      }
      for (i = 1; i <= rollback_only_count; i++) {
        name = rollback_only[i]
        if (!used["rollback " name] || used["release " name]) { broken = 1 }
        if (merged !~ ("[^[:alnum:]_]" name "[^[:alnum:]_]")) { broken = 1 }
      }
      exit broken ? 1 : 0
    }
  ' "$1" "$2"
}

# Returns 0 when the Container App create-time image gate delegates to
# local.server_image_is_managed_digest, 1 otherwise. Takes the directory holding
# container_app.tf so the check itself can be meta-tested against a sabotaged copy.
# Deliberately reports status instead of calling fail.
#
# Only preconditions inside resource "azurerm_container_app" "server" count: an
# unscoped scan would accept a neutered real gate as long as some other resource
# carried the pinned line.
server_image_precondition_is_pinned() {
  awk '
    $0 == "resource \"azurerm_container_app\" \"server\" {" {
      in_resource = 1
      next
    }
    in_resource && $0 == "}" {
      in_resource = 0
      in_precondition = 0
      next
    }
    in_resource && $0 ~ /^[[:space:]]*precondition \{[[:space:]]*$/ {
      in_precondition = 1
      depth = 1
      next
    }
    in_precondition {
      line = $0
      opens = gsub(/\{/, "{", line)
      line = $0
      closes = gsub(/\}/, "}", line)
      depth += opens - closes
      if ($0 ~ /^[[:space:]]*condition[[:space:]]*=[[:space:]]*local\.server_image_is_managed_digest[[:space:]]*$/) {
        found = 1
      }
      if (depth <= 0) {
        in_precondition = 0
      }
    }
    END {
      if (!found) exit 1
    }
  ' "$1/container_app.tf"
}

# Returns 0 when every command that loads the shared operation-lease library
# declares its data-plane auth mode, and declares the one it is supposed to, 1
# otherwise. Takes the cmd directory so the check itself can be meta-tested
# against a sabotaged copy.
# Deliberately reports status instead of calling fail.
#
# Collapsing four copies of the lease into one definition merged two different
# privilege models into one code path, and the parameter that keeps them apart
# is an ordinary shell variable. Left unpinned, a command could be edited to
# take the lease with a storage account key where it used to require the
# operator's own Entra principal -- a real widening of who can mutate the
# environment -- and nothing in the flow tests would notice, because both modes
# work. So the assignment each command makes is pinned here by name.
#
# The list is exact in both directions: a command that loads lease.sh and is not
# named below fails too, so a new mutating command cannot quietly inherit
# whichever mode happens to be convenient.
#
# One honest caveat about two of the eight entries. deploy-resources and
# stale-lease-recovery load lease.sh only for operation_binding_sha256(), which
# never reads OPERATION_LEASE_AUTH_MODE; every data-plane call they make names
# its mode as a literal `--auth-mode key` / `--auth-mode login` flag in the
# command file itself. Their declaration is therefore a statement of the
# privilege model those literals implement, not the thing that enforces it --
# the literals are pinned by the flow log assertions below, and widening one of
# them turns those scenarios red on its own. For app-release, app-rollback and
# the four infrastructure commands, which do take, hold or give back the lease
# through this library, the declaration is the only thing standing between a
# lease taken as a named human and a lease taken with an account key.
operation_lease_auth_modes_are_pinned() {
  awk -v cmd_dir="$1" \
    -v all_commands="$(printf '%s' "$GUIDE_COMMANDS" | tr '\n' ' ')" \
    -v expected="app-release=login app-rollback=login stale-lease-recovery=login infrastructure-change=key infrastructure-plan=key infrastructure-apply=key infrastructure-abandon=key deploy-resources=key" '
    BEGIN {
      count = split(expected, pairs, " ")
      for (i = 1; i <= count; i++) {
        split(pairs[i], pair, "=")
        want[pair[1]] = pair[2]
      }
      total = split(all_commands, names, " ")
      for (i = 1; i <= total; i++) {
        name = names[i]
        if (name == "") { continue }
        path = cmd_dir "/" name ".sh"
        sources_lease = 0
        declared = ""
        while ((getline line < path) > 0) {
          if (index(line, "/lease.sh\"") > 0) { sources_lease = 1 }
          if (index(line, "OPERATION_LEASE_AUTH_MODE=") == 1) {
            sub(/^OPERATION_LEASE_AUTH_MODE=/, "", line)
            declared = line
          }
        }
        close(path)
        if (name in want) {
          if (!sources_lease || declared != want[name]) { exit 1 }
          seen[name] = 1
        } else if (sources_lease) {
          # A command loading the lease without being pinned above.
          exit 1
        }
      }
      for (name in want) {
        if (!(name in seen)) { exit 1 }
      }
      exit 0
    }
  '
}

# --- the operation-binding wire format ---------------------------------------
#
# `patchpage-operation-binding-v1` is the tuple whose SHA-256 is written into
# the operation container's metadata when a deployment seals it, and re-derived
# and compared on every later flow that takes the operation lease. It is a wire
# format in the strict sense: the digest recorded against a live environment was
# produced by whatever the tuple looked like on the day that environment was
# sealed. Change the field order, a label spelling, or the separator, and every
# already-sealed environment stops matching its own binding -- the flows fail
# closed, which is the safe direction, but they fail closed permanently and no
# rerun fixes it. Recovery means hand-editing production blob metadata.
#
# So the tuple is pinned to a literal digest computed from fixed inputs, and the
# pin is checked against every source that builds the tuple. The inputs are
# spelled out in GUIDE_BINDING_FIXTURE_* below and are exactly the values the
# release scenario already uses, so the constant can be recomputed by hand:
#
#   printf '%s\n' 'patchpage-operation-binding-v1' subscription_id=... |
#     openssl dgst -sha256 -r | cut -d ' ' -f1
#
# This is deliberately a golden constant rather than a cross-comparison between
# the copies. Copies agreeing with each other is what a mechanical edit across
# all of them produces; agreeing with a number written down before the edit is
# what a mechanical edit cannot produce.
GUIDE_OPERATION_BINDING_GOLDEN_SHA256=a753a80055615fc8c9f0ec837982c6221142b0bf52a1516189a33436d5552a05

# The fixture inputs the golden digest above was computed from. Every field of
# the tuple is fed by one of these, so no field can change spelling or position
# without moving the digest.
GUIDE_BINDING_FIXTURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
GUIDE_BINDING_FIXTURE_STATE_STORAGE_ACCOUNT="patchpagestate"
GUIDE_BINDING_FIXTURE_STATE_KEY="patchpage-prod.tfstate"
GUIDE_BINDING_FIXTURE_RESOURCE_GROUP="rg-patchpage-workload"
GUIDE_BINDING_FIXTURE_CONTAINER_APP="patchpage-app"
GUIDE_BINDING_FIXTURE_ACR="acrpatchpageabc123"

# Prints the tuple-building pipeline as it appears in one shell source: the
# `printf` line that opens it, the tuple lines, and the hashing tail. Extracting
# and evaluating the real text is the point -- a test that rebuilt the tuple
# itself would only pin its own copy, and would stay green while every shipped
# copy drifted. The pipeline is located by the version marker rather than by a
# function name, so it is found wherever it lives: inline in a cmd file today,
# inside a lib function tomorrow.
#
# A tuple line is recognised by its exact source form -- the version marker
# alone on a continued line, single-quoted -- not by the marker appearing
# anywhere. Prose that names the marker, including the comment above, must not
# register as a copy of the tuple.
GUIDE_BINDING_TUPLE_MARKER="patchpage-operation-binding-v1"

guide_binding_tuple_pipeline() {
  awk -v marker="$GUIDE_BINDING_TUPLE_MARKER" '
    BEGIN { opening = sprintf("%c", 39) marker sprintf("%c", 39) " \\" }
    capturing {
      print
      if (index($0, "cut -d") > 0) { exit }
      next
    }
    {
      trimmed = $0
      sub(/^[[:space:]]+/, "", trimmed)
    }
    trimmed == opening {
      print previous_line
      print
      capturing = 1
      next
    }
    { previous_line = $0 }
  ' "$1"
}

# Counts the tuple-opening lines in one source, using the same strict form.
guide_binding_tuple_count() {
  awk -v marker="$GUIDE_BINDING_TUPLE_MARKER" '
    BEGIN { opening = sprintf("%c", 39) marker sprintf("%c", 39) " \\" }
    {
      trimmed = $0
      sub(/^[[:space:]]+/, "", trimmed)
      if (trimmed == opening) { found++ }
    }
    END { print found + 0 }
  ' "$1"
}

# Evaluates an extracted pipeline against the fixture inputs and prints the
# digest. Run inside a command substitution, so the fixture assignments cannot
# leak into the harness. $1 is bound too: the harness's own copy takes the state
# key as a positional parameter, and the cmd copies ignore it.
guide_binding_digest_of_pipeline() {
  (
    guide_binding_pipeline_text="$1"
    SUBSCRIPTION_ID="$GUIDE_BINDING_FIXTURE_SUBSCRIPTION_ID"
    STATE_STORAGE_ACCOUNT="$GUIDE_BINDING_FIXTURE_STATE_STORAGE_ACCOUNT"
    STATE_KEY="$GUIDE_BINDING_FIXTURE_STATE_KEY"
    RESOURCE_GROUP="$GUIDE_BINDING_FIXTURE_RESOURCE_GROUP"
    CONTAINER_APP="$GUIDE_BINDING_FIXTURE_CONTAINER_APP"
    ACR="$GUIDE_BINDING_FIXTURE_ACR"
    EXPECTED_OPERATION_CONTAINER_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/$STATE_STORAGE_ACCOUNT/blobServices/default/containers/patchpage-operations"
    EXPECTED_CONTAINER_APP_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/containerApps/$CONTAINER_APP"
    EXPECTED_ACR_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/$ACR"
    EXPECTED_STORAGE_ACCOUNT_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/patchpagedrafts"
    EXPECTED_POSTGRES_SERVER_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-postgres"
    set -- "$STATE_KEY"
    eval "$guide_binding_pipeline_text" 2>/dev/null
  )
}

# --- the plan gate as a pure filter ------------------------------------------
#
# lib/plan_gate.sh is the one piece of the operations CLI with no environment,
# no network and no Azure in it: an OpenTofu plan rendering goes in on stdin,
# a verdict comes out as an exit status. That is what makes it testable the way
# the rest of this file cannot be -- directly, on fixtures, one verdict at a
# time, without driving a deployment to reach it.
#
# It is run here the documented standalone way, as `sh lib/plan_gate.sh`, with
# the harness's own PATH rather than the mock PATH. Nothing is mocked because
# nothing needs to be: if this ever required a shim, it would have stopped being
# a pure filter.
GUIDE_PLAN_GATE_PROTECTED="azurerm_storage_account.drafts azurerm_storage_container.drafts azurerm_postgresql_flexible_server.patchpage azurerm_postgresql_flexible_server_database.patchpage"

# plan_gate_verdict <fixture-path> [protected-address...]
plan_gate_verdict() {
  plan_gate_fixture="$1"
  shift
  sh "$GUIDE_LIB_DIR/plan_gate.sh" "$@" < "$plan_gate_fixture"
}

test_plan_gate_filter() {
  plan_gate_fixture_dir="$ROOT/infra/azure/tests/fixtures/plan_gate"
  test -d "$plan_gate_fixture_dir" ||
    fail "the plan-gate fixtures are missing"

  # fixture|protected-list-applies|expected-verdict
  #
  # Both columns of the protected question are exercised on the same fixture,
  # because the difference between them is the whole reason the address list is
  # an argument: the initial deployment is supposed to create the protected
  # resources, and every later change must never.
  plan_gate_cases_checked=0
  for plan_gate_case in \
    'clean.json|protected|accept' \
    'clean.json|none|accept' \
    'delete.json|protected|reject' \
    'delete.json|none|reject' \
    'replace.json|protected|reject' \
    'replace.json|none|reject' \
    'replace_create_before_destroy.json|protected|reject' \
    'replace_create_before_destroy.json|none|reject' \
    'create_on_protected.json|protected|reject' \
    'create_on_protected.json|none|accept' \
    'create_on_unprotected.json|protected|accept' \
    'create_on_unprotected.json|none|accept' \
    'malformed.json|protected|reject' \
    'malformed.json|none|reject'; do
    plan_gate_fixture_name="${plan_gate_case%%|*}"
    plan_gate_rest="${plan_gate_case#*|}"
    plan_gate_scope="${plan_gate_rest%%|*}"
    plan_gate_expected="${plan_gate_rest#*|}"
    plan_gate_path="$plan_gate_fixture_dir/$plan_gate_fixture_name"
    test -f "$plan_gate_path" ||
      fail "plan-gate fixture $plan_gate_fixture_name is missing"

    plan_gate_status=0
    if test "$plan_gate_scope" = "protected"; then
      plan_gate_verdict "$plan_gate_path" $GUIDE_PLAN_GATE_PROTECTED ||
        plan_gate_status=$?
    else
      plan_gate_verdict "$plan_gate_path" || plan_gate_status=$?
    fi

    case "$plan_gate_expected" in
      accept)
        test "$plan_gate_status" -eq 0 ||
          fail "the plan gate rejected $plan_gate_fixture_name with the $plan_gate_scope address list; it should accept it"
        ;;
      reject)
        test "$plan_gate_status" -eq 1 ||
          fail "the plan gate answered $plan_gate_status for $plan_gate_fixture_name with the $plan_gate_scope address list; it should reject it with 1"
        ;;
    esac
    plan_gate_cases_checked=$((plan_gate_cases_checked + 1))
  done
  test "$plan_gate_cases_checked" -eq 14 ||
    fail "the plan-gate fixture table did not run every case"

  # Sabotage each fixture in the direction that should flip its verdict. A gate
  # that answered by ignoring its input would satisfy the table above as long as
  # the table happened to agree with its fixed answer; these prove each verdict
  # is actually being read out of the plan.
  plan_gate_probe_dir="$TMP_DIR/plan-gate-probe"
  rm -rf "$plan_gate_probe_dir"
  mkdir -p "$plan_gate_probe_dir" ||
    fail "could not create the plan-gate probe directory"

  # A clean plan turned destructive must flip accept -> reject.
  sed 's/"update"/"delete"/' "$plan_gate_fixture_dir/clean.json" \
    > "$plan_gate_probe_dir/clean-turned-destructive.json" ||
    fail "could not build the destructive plan-gate probe"
  if cmp -s "$plan_gate_fixture_dir/clean.json" \
    "$plan_gate_probe_dir/clean-turned-destructive.json"; then
    fail "the destructive plan-gate probe did not change any action"
  fi
  if plan_gate_verdict "$plan_gate_probe_dir/clean-turned-destructive.json" \
    $GUIDE_PLAN_GATE_PROTECTED; then
    fail "the plan gate accepts a plan whose only edit was to introduce a delete"
  fi

  # A destructive plan made harmless must flip reject -> accept, or the gate is
  # rejecting for some reason other than the delete.
  sed 's/"delete"/"update"/' "$plan_gate_fixture_dir/delete.json" \
    > "$plan_gate_probe_dir/delete-defused.json" ||
    fail "could not build the defused plan-gate probe"
  if cmp -s "$plan_gate_fixture_dir/delete.json" \
    "$plan_gate_probe_dir/delete-defused.json"; then
    fail "the defused plan-gate probe did not change any action"
  fi
  plan_gate_verdict "$plan_gate_probe_dir/delete-defused.json" \
    $GUIDE_PLAN_GATE_PROTECTED ||
    fail "the plan gate rejects a plan with no delete and no protected create"

  # A protected create moved onto an unprotected address must flip
  # reject -> accept, or the gate is not reading the address at all.
  sed 's/azurerm_postgresql_flexible_server\.patchpage/azurerm_container_registry.patchpage/' \
    "$plan_gate_fixture_dir/create_on_protected.json" \
    > "$plan_gate_probe_dir/create-moved.json" ||
    fail "could not build the relocated protected-create plan-gate probe"
  if cmp -s "$plan_gate_fixture_dir/create_on_protected.json" \
    "$plan_gate_probe_dir/create-moved.json"; then
    fail "the relocated protected-create probe did not change any address"
  fi
  plan_gate_verdict "$plan_gate_probe_dir/create-moved.json" \
    $GUIDE_PLAN_GATE_PROTECTED ||
    fail "the plan gate rejects a create on an address that is not protected"

  # An unprotected create moved onto a protected address must flip
  # accept -> reject.
  sed 's/azurerm_container_registry\.patchpage/azurerm_storage_container.drafts/' \
    "$plan_gate_fixture_dir/create_on_unprotected.json" \
    > "$plan_gate_probe_dir/create-protected.json" ||
    fail "could not build the promoted protected-create plan-gate probe"
  if cmp -s "$plan_gate_fixture_dir/create_on_unprotected.json" \
    "$plan_gate_probe_dir/create-protected.json"; then
    fail "the promoted protected-create probe did not change any address"
  fi
  if plan_gate_verdict "$plan_gate_probe_dir/create-protected.json" \
    $GUIDE_PLAN_GATE_PROTECTED; then
    fail "the plan gate accepts a create on a protected address"
  fi

  # The gate must be pure: the same fixture must get the same verdict with the
  # environment the runbooks rely on stripped out entirely. Anything that read
  # the environment would answer differently here, or fail.
  plan_gate_stripped_status=0
  env -i "PATH=$PATH" sh "$GUIDE_LIB_DIR/plan_gate.sh" $GUIDE_PLAN_GATE_PROTECTED \
    < "$plan_gate_fixture_dir/clean.json" || plan_gate_stripped_status=$?
  test "$plan_gate_stripped_status" -eq 0 ||
    fail "the plan gate needs the environment: it answered $plan_gate_stripped_status for a clean plan with an empty environment"
  plan_gate_stripped_status=0
  env -i "PATH=$PATH" sh "$GUIDE_LIB_DIR/plan_gate.sh" $GUIDE_PLAN_GATE_PROTECTED \
    < "$plan_gate_fixture_dir/delete.json" || plan_gate_stripped_status=$?
  test "$plan_gate_stripped_status" -eq 1 ||
    fail "the plan gate needs the environment: it answered $plan_gate_stripped_status for a destructive plan with an empty environment"

  rm -rf "$plan_gate_probe_dir"
}

test_operation_binding_wire_format() {
  binding_fixture_dir="$TMP_DIR/operation-binding-wire-format"
  rm -rf "$binding_fixture_dir"
  mkdir -p "$binding_fixture_dir" ||
    fail "could not create the operation-binding fixture directory"

  # Every executable source, plus the harness itself: the harness carries its
  # own independent copy of the tuple, and that copy is held to the same wire
  # format even though it is deliberately not shared with the runbooks.
  set -- "$GUIDE_OPS"
  for guide_command in $GUIDE_COMMANDS; do
    set -- "$@" "$GUIDE_CMD_DIR/$guide_command.sh"
  done
  for guide_lib_file in "$GUIDE_LIB_DIR"/*.sh; do
    test -f "$guide_lib_file" || continue
    set -- "$@" "$guide_lib_file"
  done
  set -- "$@" "$ROOT/infra/azure/tests/guide_commands_test.sh"

  binding_sources=0
  for binding_source do
    # One tuple per source. Two would mean the extraction below silently checked
    # the first and ignored a second that could say something different.
    binding_marker_count="$(guide_binding_tuple_count "$binding_source")"
    test "$binding_marker_count" -ne 0 || continue
    binding_sources=$((binding_sources + 1))
    test "$binding_marker_count" -eq 1 ||
      fail "${binding_source##*/} builds the operation-binding tuple $binding_marker_count times; there must be exactly one"

    binding_pipeline="$(guide_binding_tuple_pipeline "$binding_source")" ||
      fail "could not extract the operation-binding tuple from ${binding_source##*/}"
    case "$binding_pipeline" in
      *"cut -d"*) ;;
      *)
        fail "the operation-binding tuple in ${binding_source##*/} does not end in the documented hashing tail"
        ;;
    esac

    binding_digest="$(
      guide_binding_digest_of_pipeline "$binding_pipeline"
    )" ||
      fail "could not evaluate the operation-binding tuple from ${binding_source##*/}"
    test "$binding_digest" = "$GUIDE_OPERATION_BINDING_GOLDEN_SHA256" ||
      fail "${binding_source##*/} builds an operation-binding tuple whose digest is $binding_digest, not the pinned $GUIDE_OPERATION_BINDING_GOLDEN_SHA256"
  done

  # The scan must have found something, or every assertion above is vacuous.
  test "$binding_sources" -ge 2 ||
    fail "the operation-binding wire-format pin found only $binding_sources source(s); the runbooks and the harness both build the tuple"

  # The harness's own copy is reached the way the flows reach it -- by calling
  # it -- as well as by extraction, so a copy that was edited into something the
  # extractor cannot see still has to produce the pinned digest.
  binding_called_digest="$(
    SUBSCRIPTION_ID="$GUIDE_BINDING_FIXTURE_SUBSCRIPTION_ID" \
      STATE_STORAGE_ACCOUNT="$GUIDE_BINDING_FIXTURE_STATE_STORAGE_ACCOUNT" \
      RESOURCE_GROUP="$GUIDE_BINDING_FIXTURE_RESOURCE_GROUP" \
      CONTAINER_APP="$GUIDE_BINDING_FIXTURE_CONTAINER_APP" \
      ACR="$GUIDE_BINDING_FIXTURE_ACR" \
      EXPECTED_STORAGE_ACCOUNT_ID="/subscriptions/$GUIDE_BINDING_FIXTURE_SUBSCRIPTION_ID/resourceGroups/$GUIDE_BINDING_FIXTURE_RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/patchpagedrafts" \
      EXPECTED_POSTGRES_SERVER_ID="/subscriptions/$GUIDE_BINDING_FIXTURE_SUBSCRIPTION_ID/resourceGroups/$GUIDE_BINDING_FIXTURE_RESOURCE_GROUP/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-postgres" \
      guide_operation_binding_sha256 "$GUIDE_BINDING_FIXTURE_STATE_KEY"
  )" ||
    fail "could not call the harness's own operation-binding tuple builder"
  test "$binding_called_digest" = "$GUIDE_OPERATION_BINDING_GOLDEN_SHA256" ||
    fail "the harness's operation-binding tuple builder returns $binding_called_digest, not the pinned $GUIDE_OPERATION_BINDING_GOLDEN_SHA256"

  # Sabotage the pin in three independent directions. A golden hash that no
  # mutation can move is a constant the test is comparing against itself.
  binding_probe_source="$GUIDE_LIB_DIR/lease.sh"
  test "$(guide_binding_tuple_count "$binding_probe_source")" -eq 1 ||
    fail "the operation-binding sabotage probe source no longer builds the tuple"

  # 1. A relabelled field. Same values, same order, different wire format.
  sed 's/state_key=/state_key_v2=/' "$binding_probe_source" \
    > "$binding_fixture_dir/relabelled.sh" ||
    fail "could not build the relabelled operation-binding probe"
  if cmp -s "$binding_probe_source" "$binding_fixture_dir/relabelled.sh"; then
    fail "the relabelled operation-binding probe did not change any label"
  fi
  binding_probe_digest="$(
    guide_binding_digest_of_pipeline \
      "$(guide_binding_tuple_pipeline "$binding_fixture_dir/relabelled.sh")"
  )"
  test "$binding_probe_digest" != "$GUIDE_OPERATION_BINDING_GOLDEN_SHA256" ||
    fail "the operation-binding pin accepts a relabelled tuple field"

  # 2. Two fields transposed. Same labels, same values, different order.
  awk '
    !done && index($0, "container_app=") > 0 { held = $0; next }
    !done && held != "" && index($0, "acr=") > 0 {
      print
      print held
      held = ""
      done = 1
      next
    }
    { print }
    END { if (!done) exit 1 }
  ' "$binding_probe_source" > "$binding_fixture_dir/transposed.sh" ||
    fail "could not build the transposed operation-binding probe"
  if cmp -s "$binding_probe_source" "$binding_fixture_dir/transposed.sh"; then
    fail "the transposed operation-binding probe did not reorder any field"
  fi
  binding_probe_digest="$(
    guide_binding_digest_of_pipeline \
      "$(guide_binding_tuple_pipeline "$binding_fixture_dir/transposed.sh")"
  )"
  test "$binding_probe_digest" != "$GUIDE_OPERATION_BINDING_GOLDEN_SHA256" ||
    fail "the operation-binding pin accepts a transposed tuple field order"

  # 3. A changed record separator. Same fields in the same order, joined
  # differently -- the drift a reader is least likely to notice in a diff.
  awk '
    BEGIN {
      quote = sprintf("%c", 39)
      from = "printf " quote "%s\\n" quote
      to = "printf " quote "%s " quote
    }
    {
      at = index($0, from)
      if (at > 0) {
        $0 = substr($0, 1, at - 1) to substr($0, at + length(from))
        changed = 1
      }
      print
    }
    END { if (!changed) exit 1 }
  ' "$binding_probe_source" > "$binding_fixture_dir/separator.sh" ||
    fail "could not build the separator operation-binding probe"
  if cmp -s "$binding_probe_source" "$binding_fixture_dir/separator.sh"; then
    fail "the separator operation-binding probe did not change the separator"
  fi
  binding_probe_digest="$(
    guide_binding_digest_of_pipeline \
      "$(guide_binding_tuple_pipeline "$binding_fixture_dir/separator.sh")"
  )"
  test "$binding_probe_digest" != "$GUIDE_OPERATION_BINDING_GOLDEN_SHA256" ||
    fail "the operation-binding pin accepts a changed tuple record separator"

  rm -rf "$binding_fixture_dir"
}

test_public_safe_runbook_static() {
  # The runbooks are files under cmd/ now, so every check that is really about
  # the shell reads those files; the checks that are about what the guide says
  # still read the guide. GUIDE_SHELL_SOURCES is the whole executable surface.
  set -- "$GUIDE_OPS"
  for guide_command in $GUIDE_COMMANDS; do
    set -- "$@" "$GUIDE_CMD_DIR/$guide_command.sh"
  done
  for guide_lib in $GUIDE_LIBS; do
    set -- "$@" "$GUIDE_LIB_DIR/$guide_lib.sh"
  done
  GUIDE_SHELL_SOURCES_COUNT="$#"
  test "$GUIDE_SHELL_SOURCES_COUNT" -eq 25 ||
    fail "the operations CLI is not ops.sh plus the 16 documented commands and the 8 shared libraries"

  if grep -Eiq 'If[-]Match|e[t]ag|patchpageOperation[L]ock|private_az r[e]st' \
    "$README" "$@"; then
    fail "Azure guide retains the unsupported Container App tag/conditional-REST mutex"
  fi
  # Every private_az must pin the subscription, and there must be exactly three
  # of them. lib/wrappers.sh holds the definition the dispatched commands share;
  # custom-domain-context and hostname-mutation keep their own because the guide
  # has the operator *source* them, so they run with the operator's $0 and
  # cannot locate lib/ at all. Three is therefore the whole justified population,
  # and a fourth means a command has grown a private copy again -- which is the
  # shape of the divergence this library exists to prevent.
  if ! awk '
    $0 == "private_az() {" {
      getline
      wrappers++
      if ($0 != "  az \"$@\" --subscription \"$SUBSCRIPTION_ID\" 2>/dev/null") exit 1
    }
    END { if (wrappers != 3) exit 1 }
  ' "$@"; then
    fail "the private_az wrappers are not exactly the shared one plus the two sourced commands, each pinning the explicit subscription"
  fi
  if grep -Eq -- \
    'az account show[^|;]*(--query[ =]+['"'"'"]?(user|tenantId|environmentName)|--output json)' \
    "$README" "$@"; then
    fail "Azure guide queries caller details instead of only the active subscription ID"
  fi
  if grep -Eq -- \
    'tofu state pull[[:space:]]*>[[:space:]]*[^[:space:]"$]|tofu show[[:space:]]+"\$[^"]*PLAN"|tofu plan[[:space:]]+-out=[^[:space:]"$]' \
    "$README" "$@"; then
    fail "Azure guide writes raw OpenTofu state or plan output to a repository-visible path"
  fi
  if grep -Eq '(^|[;&|][[:space:]]*)echo[[:space:]].*\$(IMAGE|.*_ID|RESOURCE_GROUP|STATE_)' \
    "$GUIDE_CMD_DIR/app-release.sh" "$GUIDE_CMD_DIR/infrastructure-change.sh" \
    "$GUIDE_CMD_DIR/infrastructure-plan.sh" "$GUIDE_CMD_DIR/infrastructure-apply.sh" \
    "$GUIDE_CMD_DIR/infrastructure-abandon.sh" "$GUIDE_LIB_DIR/infra_change.sh"; then
    fail "new runbook commands directly echo a sensitive image or resource value"
  fi
  # The release flow never runs OpenTofu. That has to be asserted over what it
  # actually loads, not just its own file: the shared libraries it sources are
  # as much a part of it as its own lines, and a private_tofu arriving in
  # one of them would put OpenTofu back into the release path invisibly.
  #
  # Both binary names are matched. `terraform` is no longer invoked anywhere, so
  # the alternation costs nothing -- and it is what keeps this assertion from
  # going quietly vacuous if a stale Terraform call is ever reintroduced here.
  #
  # The excluded leading class deliberately keeps `_` out of it: the wrappers are
  # named private_tofu/private_terraform, so treating `_` as a word character
  # would let the exact call this assertion exists to catch -- a wrapper-form
  # `private_tofu output` in the release path -- pass straight through. Excluding
  # only alphanumerics still cannot match `tofu_diagnostic_exit` or
  # `trap 'tofu_diagnostic_exit' 0`, because the required trailing space is what
  # separates a command invocation from an identifier that merely starts with the
  # binary's name.
  if grep -Eq '(^|[^[:alnum:]])(tofu|terraform) ' \
    "$GUIDE_CMD_DIR/app-release.sh" \
    "$GUIDE_LIB_DIR/wrappers.sh" \
    "$GUIDE_LIB_DIR/lease.sh" \
    "$GUIDE_LIB_DIR/revision.sh"; then
    fail "app release command contains an OpenTofu or Terraform command"
  fi
  if grep -Eq \
    'Could not select Azure subscription %s|Expected subscription %s|Could not add hostname %s|Could not bind a managed certificate for %s|empty managed certificate ID for %s|No SNI binding for %s uses exact certificate ID %s' \
    "$README" "$@"; then
    fail "Azure guide retains a verbose hostname or certificate error that exposes private values"
  fi
  ops_sources_reach_tools_through_path "$@" ||
    fail "an operations CLI source names a tool by absolute path and would bypass the harness shims"

  # Meta-test the check above: a sabotaged copy that calls a tool by absolute
  # path must be rejected, otherwise the restricted-PATH rule is decorative.
  restricted_path_probe_dir="$TMP_DIR/restricted-path-probe"
  rm -rf "$restricted_path_probe_dir"
  mkdir -p "$restricted_path_probe_dir" ||
    fail "could not create the restricted-PATH probe directory"
  awk '
    { print }
    NR == 1 {
      sabotaged = 1
      print "/usr/bin/az account show --query id --output tsv"
    }
    END { if (!sabotaged) exit 1 }
  ' "$GUIDE_CMD_DIR/state-bootstrap.sh" \
    > "$restricted_path_probe_dir/state-bootstrap.sh" ||
    fail "could not build the absolute-tool-path probe"
  if cmp -s "$GUIDE_CMD_DIR/state-bootstrap.sh" \
    "$restricted_path_probe_dir/state-bootstrap.sh"; then
    fail "the absolute-tool-path probe did not sabotage anything"
  fi
  if ops_sources_reach_tools_through_path \
    "$restricted_path_probe_dir/state-bootstrap.sh"; then
    fail "the restricted-PATH check accepts an absolute tool path in an operations CLI source"
  fi

  operation_lease_auth_modes_are_pinned "$GUIDE_CMD_DIR" ||
    fail "a command that loads the shared operation lease does not declare the data-plane auth mode it is pinned to"

  # Meta-test the check above in both directions: a command whose declared mode
  # was widened from the operator's own principal to a storage key must be
  # rejected, and so must one that loads the lease while declaring nothing.
  auth_mode_probe_dir="$TMP_DIR/operation-lease-auth-mode-probe"
  rm -rf "$auth_mode_probe_dir"
  mkdir -p "$auth_mode_probe_dir" ||
    fail "could not create the operation-lease auth-mode probe directory"
  for auth_mode_probe_command in $GUIDE_COMMANDS; do
    cp "$GUIDE_CMD_DIR/$auth_mode_probe_command.sh" \
      "$auth_mode_probe_dir/$auth_mode_probe_command.sh" ||
      fail "could not populate the operation-lease auth-mode probe"
  done
  operation_lease_auth_modes_are_pinned "$auth_mode_probe_dir" ||
    fail "the operation-lease auth-mode check rejects an unmodified copy of the commands"

  sed 's/^OPERATION_LEASE_AUTH_MODE=login$/OPERATION_LEASE_AUTH_MODE=key/' \
    "$GUIDE_CMD_DIR/app-release.sh" > "$auth_mode_probe_dir/app-release.sh" ||
    fail "could not build the widened operation-lease auth-mode probe"
  if cmp -s "$GUIDE_CMD_DIR/app-release.sh" "$auth_mode_probe_dir/app-release.sh"; then
    fail "the widened operation-lease auth-mode probe did not change the mode"
  fi
  if operation_lease_auth_modes_are_pinned "$auth_mode_probe_dir"; then
    fail "the operation-lease auth-mode check accepts a release flow widened to storage-key auth"
  fi

  grep -v '^OPERATION_LEASE_AUTH_MODE=' "$GUIDE_CMD_DIR/app-release.sh" \
    > "$auth_mode_probe_dir/app-release.sh" ||
    fail "could not build the undeclared operation-lease auth-mode probe"
  if operation_lease_auth_modes_are_pinned "$auth_mode_probe_dir"; then
    fail "the operation-lease auth-mode check accepts a command that declares no auth mode"
  fi
  rm -rf "$auth_mode_probe_dir"

  # The runbooks left the guide in this change, and nothing may bring one back:
  # a re-inlined block would be documentation the harness never runs.
  guide_carries_no_moved_runbook "$README" ||
    fail "the Azure guide still carries a guide-test marker or a runbook-sized shell fence"

  # Meta-test both halves of that check separately, otherwise one of them could
  # rot into decoration behind the other.
  moved_runbook_probe_dir="$TMP_DIR/moved-runbook-probe"
  rm -rf "$moved_runbook_probe_dir"
  mkdir -p "$moved_runbook_probe_dir" ||
    fail "could not create the moved-runbook probe directory"
  {
    cat "$README" &&
      printf '%s\n' '<!-- guide-test:app-release -->'
  } > "$moved_runbook_probe_dir/marker.md" ||
    fail "could not build the guide-test marker probe"
  if guide_carries_no_moved_runbook "$moved_runbook_probe_dir/marker.md"; then
    fail "the moved-runbook check accepts a surviving guide-test marker"
  fi
  {
    cat "$README" &&
      printf '%s\n' '```sh' &&
      awk 'NR > 1 && NR <= 60' "$GUIDE_CMD_DIR/hostname-mutation.sh" &&
      printf '%s\n' '```'
  } > "$moved_runbook_probe_dir/inlined.md" ||
    fail "could not build the re-inlined runbook probe"
  if guide_carries_no_moved_runbook "$moved_runbook_probe_dir/inlined.md"; then
    fail "the moved-runbook check accepts a re-inlined runbook fence"
  fi
  rm -rf "$moved_runbook_probe_dir"
  rm -rf "$restricted_path_probe_dir"

  # The two sourced commands run in the operator's shell, where a trap would
  # outlive the command instead of being torn down with a process.
  sourced_commands_install_no_trap \
    "$GUIDE_CMD_DIR/custom-domain-context.sh" \
    "$GUIDE_CMD_DIR/hostname-mutation.sh" ||
    fail "a command the guide has the operator source installs a trap in their shell"

  sourced_trap_probe_dir="$TMP_DIR/sourced-trap-probe"
  rm -rf "$sourced_trap_probe_dir"
  mkdir -p "$sourced_trap_probe_dir" ||
    fail "could not create the sourced-trap probe directory"
  cp "$GUIDE_CMD_DIR/hostname-mutation.sh" \
    "$sourced_trap_probe_dir/hostname-mutation.sh" ||
    fail "could not build the sourced-trap probe"
  sourced_commands_install_no_trap "$sourced_trap_probe_dir/hostname-mutation.sh" ||
    fail "the sourced-trap check rejects an unmodified sourced command"
  printf '%s\n' "trap 'printf leaked' 0" \
    >> "$sourced_trap_probe_dir/hostname-mutation.sh" ||
    fail "could not sabotage the sourced-trap probe"
  if sourced_commands_install_no_trap "$sourced_trap_probe_dir/hostname-mutation.sh"; then
    fail "the sourced-trap check accepts a sourced command that installs a trap"
  fi
  rm -rf "$sourced_trap_probe_dir"

  guide_harness_file="$ROOT/infra/azure/tests/guide_commands_test.sh"
  merged_containerapp_scenarios_are_flow_exclusive \
    "$guide_harness_file" "$GUIDE_MOCK_DIR/az" ||
    fail "a scenario name the merged release/rollback Container App mocks special-case is used by both flows"

  # Meta-test the check above: a copy that adds a release-only scenario name to
  # the rollback list must be rejected, otherwise the merged-dispatch invariant
  # is decorative.
  flow_exclusive_probe_dir="$TMP_DIR/flow-exclusive-probe"
  rm -rf "$flow_exclusive_probe_dir"
  mkdir -p "$flow_exclusive_probe_dir" ||
    fail "could not create the merged-dispatch probe directory"
  awk '
    { print }
    !sabotaged && in_rollback && $0 == "  for scenario in \\" {
      sabotaged = 1
      print "    rollback_digest_invalid \\"
    }
    $0 == "test_app_rollback() {" { in_rollback = 1 }
    END { if (!sabotaged) exit 1 }
  ' "$guide_harness_file" > "$flow_exclusive_probe_dir/guide_commands_test.sh" ||
    fail "could not build the merged-dispatch probe"
  if cmp -s "$guide_harness_file" "$flow_exclusive_probe_dir/guide_commands_test.sh"; then
    fail "the merged-dispatch probe did not sabotage anything"
  fi
  if merged_containerapp_scenarios_are_flow_exclusive \
    "$flow_exclusive_probe_dir/guide_commands_test.sh" "$GUIDE_MOCK_DIR/az"; then
    fail "the merged-dispatch check accepts a release-only scenario name in the rollback list"
  fi
  rm -rf "$flow_exclusive_probe_dir"

  # Lifecycle prevent_destroy is a meta-argument and is invisible to plan-time
  # tofu test assertions. Statically require the expected blocks.
  #
  # --- what #73 settled about moving these to behavioural guards ---------------
  #
  # Management-lock scope: moved, and this check is now the second layer rather
  # than the only one. The obstacle was that mock_resource defaults supply one
  # constant id per resource *type*, so every azurerm_storage_account in the
  # configuration mocks to the same id and an assertion on the lock's scope
  # pinned the mock instead of the wiring. OpenTofu's override_resource is
  # per-address, which removes exactly that obstacle:
  # tests/persistent_data_invariants.tftest.hcl now gives the two protected
  # parents distinct ids and asserts each lock's scope against its own. Swapping
  # the two locks' scopes turns both runs red, and re-scoping one to the resource
  # group turns that one red. This static check stays because it reads the
  # expression rather than its value, so the two fail for different reasons.
  #
  # Container App precondition isolation: not achievable, and the static pin
  # below remains the only guard. `expect_failures` for
  # azurerm_container_app.server is satisfied by the postcondition on the same
  # resource, so deleting the precondition keeps such a run green -- verified,
  # not assumed. Isolating it needs a run where the precondition fails while the
  # postcondition holds, and neither route exists here:
  #
  #   * override_resource cannot supply one. The postcondition reads
  #     self.template[0].container[0].image, which is configured rather than
  #     computed, and OpenTofu refuses it -- "Non-computed field `image` is not
  #     allowed to be overridden". Overriding the enclosing block fails first
  #     with "Blocks can be overridden only by objects".
  #   * Seeding prior state with a `command = apply` run would work -- with the
  #     image ignored by lifecycle.ignore_changes, the planned image stays the
  #     valid prior one while an invalid var.server_image fails the precondition,
  #     and the run does go red when the precondition is deleted. But the file
  #     cannot then be torn down: tofu test's cleanup destroy hits
  #     prevent_destroy on six resources, fails unconditionally, exits 2 and
  #     writes errored_test.tfstate into this directory. The guard that makes
  #     the other half of this function necessary is what makes that route
  #     unusable.
  #
  # Reaching the precondition behaviourally therefore means weakening a real
  # protection to test another one, which is the wrong trade. The predicate
  # itself stays independently asserted through the server_image_is_managed_digest
  # output in tests/server_image_invariants.tftest.hcl; what only this static
  # check can say is that the resource's precondition is still wired to it.
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

  # The Container App create-time server_image gate is invisible to plan-time
  # `tofu test`: expect_failures on azurerm_container_app.server is satisfied by
  # the postcondition, so deleting or neutering the precondition alone stays green.
  # Statically require the precondition to delegate to the named local that
  # server_image_invariants.tftest.hcl asserts through its output.
  server_image_precondition_is_pinned "$azure_tf_dir" ||
    fail "the Container App server_image precondition does not evaluate local.server_image_is_managed_digest"

  # Meta-test the check above: a neutered precondition in a scratch copy must be
  # rejected, otherwise the static assertion is decorative.
  precondition_probe_dir="$TMP_DIR/server-image-precondition-probe"
  rm -rf "$precondition_probe_dir"
  mkdir -p "$precondition_probe_dir" ||
    fail "could not create the server_image precondition probe directory"
  sed 's/^\([[:space:]]*\)condition[[:space:]]*=[[:space:]]*local\.server_image_is_managed_digest[[:space:]]*$/\1condition = length(var.server_image) >= 0/' \
    "$azure_tf_dir/container_app.tf" > "$precondition_probe_dir/container_app.tf" ||
    fail "could not build the neutered server_image precondition probe"
  if cmp -s "$azure_tf_dir/container_app.tf" "$precondition_probe_dir/container_app.tf"; then
    fail "the server_image precondition probe did not neuter anything"
  fi
  if server_image_precondition_is_pinned "$precondition_probe_dir"; then
    fail "the server_image precondition static check accepts a neutered precondition"
  fi

  # Meta-test the resource scoping too: neutering the real gate while a decoy
  # resource elsewhere in the file carries the pinned line must still be rejected.
  {
    cat "$precondition_probe_dir/container_app.tf" &&
      printf '%s\n' \
        '' \
        'resource "azurerm_container_app" "decoy" {' \
        '  lifecycle {' \
        '    precondition {' \
        '      condition     = local.server_image_is_managed_digest' \
        '      error_message = "decoy"' \
        '    }' \
        '  }' \
        '}'
  } > "$precondition_probe_dir/decoy.tf" ||
    fail "could not build the decoyed server_image precondition probe"
  mv "$precondition_probe_dir/decoy.tf" "$precondition_probe_dir/container_app.tf" ||
    fail "could not install the decoyed server_image precondition probe"
  grep -Fqx '      condition     = local.server_image_is_managed_digest' \
    "$precondition_probe_dir/container_app.tf" ||
    fail "the decoyed server_image precondition probe carries no decoy"
  if server_image_precondition_is_pinned "$precondition_probe_dir"; then
    fail "the server_image precondition static check accepts a decoy outside the Container App"
  fi
  rm -rf "$precondition_probe_dir"
}

test_custom_domain_context() {
  context_output="$TMP_DIR/custom-domain-context.out"
  if ! (
    PP_MOCK_GROUP="custom-domain"
    PP_MOCK_SCENARIO=""
    PP_MOCK_LOG=""
    PP_MOCK_EXPECTED_SUBSCRIPTION="00000000-0000-0000-0000-000000000000"
    # This block derives SUBSCRIPTION_ID from OpenTofu instead of taking it as
    # an input, so the subscription guard needs the expected value separately.
    PP_MOCK_SUBSCRIPTION_ID="$PP_MOCK_EXPECTED_SUBSCRIPTION"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG \
      PP_MOCK_EXPECTED_SUBSCRIPTION PP_MOCK_SUBSCRIPTION_ID
    prepare_mock_state "$TMP_DIR/custom-domain-context.mockstate"

    # The trailer inside the block script checks the normalized hostnames the
    # block is contracted to leave behind; see the custom-domain-context-trailer block part.
    run_ops_wrapper custom-domain-context \
      custom-domain-context-source custom-domain-context-trailer
  ) >"$context_output" 2>&1; then
    fail "OpenTofu hostnames were not normalized before DNS and certificate checks"
  fi
  test "$(cat "$context_output")" = "Azure deployment context verified privately." ||
    fail "custom-domain context exposed deployment details instead of generic success"

  # The run above sources it from a shell that already has `set -u` on, which
  # cannot tell "restored it" from "never touched it". This one sources it from
  # a shell that does not, where leaving the option on would be the operator's
  # next unset variable killing their session.
  for caller_nounset in off on; do
    context_output="$TMP_DIR/custom-domain-context-nounset-$caller_nounset.out"
    if ! (
      PP_MOCK_GROUP="custom-domain"
      PP_MOCK_SCENARIO=""
      PP_MOCK_LOG=""
      PP_MOCK_EXPECTED_SUBSCRIPTION="00000000-0000-0000-0000-000000000000"
      PP_MOCK_SUBSCRIPTION_ID="$PP_MOCK_EXPECTED_SUBSCRIPTION"
      export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG \
        PP_MOCK_EXPECTED_SUBSCRIPTION PP_MOCK_SUBSCRIPTION_ID
      prepare_mock_state "$TMP_DIR/custom-domain-context-nounset-$caller_nounset.mockstate"

      run_ops_wrapper "custom-domain-context-nounset-$caller_nounset" \
        "caller-nounset-$caller_nounset" \
        custom-domain-context-source \
        sourced-status \
        custom-domain-context-forwarded-value \
        "sourced-trailer-nounset-$caller_nounset"
    ) >"$context_output" 2>&1; then
      fail "sourcing custom-domain-context left the caller's set -u $caller_nounset state changed or lost its values"
    fi
  done
}

run_custom_domain_output_guard_block() {
  scenario="$1"
  log="$TMP_DIR/custom-domain-output-$scenario.log"
  output="$TMP_DIR/custom-domain-output-$scenario.out"
  : > "$log"

  (
    PP_MOCK_GROUP="custom-domain-guard"
    PP_MOCK_SCENARIO="$scenario"
    PP_MOCK_LOG="$log"
    PP_MOCK_EXPECTED_SUBSCRIPTION="00000000-0000-0000-0000-000000000000"
    # This block derives SUBSCRIPTION_ID from OpenTofu instead of taking it as
    # an input, so the subscription guard needs the expected value separately.
    PP_MOCK_SUBSCRIPTION_ID="$PP_MOCK_EXPECTED_SUBSCRIPTION"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG \
      PP_MOCK_EXPECTED_SUBSCRIPTION PP_MOCK_SUBSCRIPTION_ID
    prepare_mock_state "$TMP_DIR/custom-domain-output-$scenario.mockstate"

    run_ops_command_completed custom-domain-context
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
    done
  done
  for scenario in account_set_failure account_show_failure subscription_mismatch; do
    if run_custom_domain_output_guard_block "$scenario"; then
      fail "custom-domain context accepted $scenario"
    fi
    if grep -q '^completed$' "$TMP_DIR/custom-domain-output-$scenario.log"; then
      fail "custom-domain context continued after $scenario"
    fi
  done
}

run_ingress_verification_block() {
  scenario="$1"
  log="$TMP_DIR/ingress-$scenario.log"
  output="$TMP_DIR/ingress-$scenario.out"
  : > "$log"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    RESOURCE_GROUP="rg-test"
    CONTAINER_APP="app-test"
    export SUBSCRIPTION_ID RESOURCE_GROUP CONTAINER_APP

    PP_MOCK_GROUP="ingress"
    PP_MOCK_SCENARIO="$scenario"
    PP_MOCK_LOG="$log"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG
    prepare_mock_state "$TMP_DIR/ingress-$scenario.mockstate"

    run_ops_command ingress-verification
  ) >"$output" 2>&1
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
      export SUBSCRIPTION_ID ACTIVE_SUBSCRIPTION_ID RESOURCE_GROUP \
        CONTAINER_APP CONTAINER_APP_ENVIRONMENT CUSTOM_DOMAIN VALIDATION_METHOD

      PP_MOCK_GROUP="hostname"
      PP_MOCK_SCENARIO="$scenario"
      PP_MOCK_LOG="$log"
      PP_MOCK_EXPECTED_SUBSCRIPTION="$expected_subscription"
      PP_MOCK_EXPECTED_CERTIFICATE_ID="$expected_certificate_id"
      export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG \
        PP_MOCK_EXPECTED_SUBSCRIPTION PP_MOCK_EXPECTED_CERTIFICATE_ID
      prepare_mock_state "$TMP_DIR/hostname-$scenario.mockstate"

      run_ops_command hostname-mutation
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

  # The guide documents this one as `. cmd/hostname-mutation.sh`, so the calling
  # shell is part of its contract in two ways: MANAGED_CERTIFICATE_ID has to
  # arrive there for the certificate-binding command to read, and the options
  # the file set for its own use have to be handed back. The dispatched runs
  # above cannot see either, because a child process shares neither.
  for caller_nounset in off on; do
    log="$TMP_DIR/hostname-sourced-$caller_nounset.log"
    : > "$log"
    output="$TMP_DIR/hostname-sourced-$caller_nounset.out"

    if ! (
      SUBSCRIPTION_ID="$expected_subscription"
      ACTIVE_SUBSCRIPTION_ID=""
      RESOURCE_GROUP="rg-test"
      CONTAINER_APP="app-test"
      CONTAINER_APP_ENVIRONMENT="env-test"
      CUSTOM_DOMAIN="drafts.self-hoster.dev"
      VALIDATION_METHOD="CNAME"
      export SUBSCRIPTION_ID ACTIVE_SUBSCRIPTION_ID RESOURCE_GROUP \
        CONTAINER_APP CONTAINER_APP_ENVIRONMENT CUSTOM_DOMAIN VALIDATION_METHOD

      PP_MOCK_GROUP="hostname"
      PP_MOCK_SCENARIO="success"
      PP_MOCK_LOG="$log"
      PP_MOCK_EXPECTED_SUBSCRIPTION="$expected_subscription"
      PP_MOCK_EXPECTED_CERTIFICATE_ID="$expected_certificate_id"
      export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG \
        PP_MOCK_EXPECTED_SUBSCRIPTION PP_MOCK_EXPECTED_CERTIFICATE_ID
      prepare_mock_state "$TMP_DIR/hostname-sourced-$caller_nounset.mockstate"

      run_ops_wrapper "hostname-sourced-$caller_nounset" \
        "caller-nounset-$caller_nounset" \
        hostname-mutation-source \
        sourced-status \
        hostname-mutation-forwarded-value \
        "sourced-trailer-nounset-$caller_nounset"
    ) >"$output" 2>&1; then
      fail "sourcing hostname-mutation lost MANAGED_CERTIFICATE_ID or left the caller's set -u $caller_nounset state changed"
    fi
  done
}

# One apex run per (A-record set, AAAA scenario) pair, so its captures are
# numbered. They exist for one reason: until this change these three blocks
# threw their output away, which meant the flows with the *most* private values
# in scope -- the hostname, the static IP, the domain verification ID -- were
# the three the sweep could not see at all.
GUIDE_APEX_CAPTURE=0

run_apex_block() {
  a_records="$1"
  aaaa_scenario="$2"
  GUIDE_APEX_CAPTURE=$((GUIDE_APEX_CAPTURE + 1))
  output="$TMP_DIR/apex-$GUIDE_APEX_CAPTURE.out"

  (
    DNS_ZONE="drafts.self-hoster.dev"
    CUSTOM_DOMAIN="drafts.self-hoster.dev"
    CONTAINER_APP_STATIC_IP="203.0.113.10"
    DOMAIN_VERIFICATION_ID="verification-id"
    export DNS_ZONE CUSTOM_DOMAIN CONTAINER_APP_STATIC_IP DOMAIN_VERIFICATION_ID

    PP_MOCK_GROUP="apex"
    PP_MOCK_SCENARIO="$aaaa_scenario"
    PP_MOCK_LOG=""
    PP_MOCK_APEX_A_RECORDS="$a_records"
    PP_MOCK_APEX_AAAA_SCENARIO="$aaaa_scenario"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG PP_MOCK_APEX_A_RECORDS \
      PP_MOCK_APEX_AAAA_SCENARIO
    prepare_mock_state "$TMP_DIR/apex.mockstate"

    run_ops_command apex-dns
  ) >"$output" 2>&1
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
  output="$TMP_DIR/caa-$scenario.out"
  : > "$log"

  (
    CUSTOM_DOMAIN="drafts.team.example.com"
    DNS_ZONE="example.com"
    export CUSTOM_DOMAIN DNS_ZONE

    PP_MOCK_GROUP="caa"
    PP_MOCK_SCENARIO="$scenario"
    PP_MOCK_LOG="$log"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG
    prepare_mock_state "$TMP_DIR/caa-$scenario.mockstate"

    run_ops_command caa-policy
  ) >"$output" 2>&1
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
    export SUBSCRIPTION_ID RESOURCE_GROUP CONTAINER_APP \
      CONTAINER_APP_ENVIRONMENT CUSTOM_DOMAIN MANAGED_CERTIFICATE_ID

    PP_MOCK_GROUP="certificate"
    PP_MOCK_SCENARIO=""
    PP_MOCK_LOG=""
    PP_MOCK_CERTIFICATE_SUBJECT="$subject"
    PP_MOCK_CERTIFICATE_ID="$certificate_id"
    PP_MOCK_CERTIFICATE_BINDING_ID="$binding_id"
    PP_MOCK_CERTIFICATE_PROVISIONING_STATE="$provisioning_state"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG \
      PP_MOCK_CERTIFICATE_SUBJECT PP_MOCK_CERTIFICATE_ID \
      PP_MOCK_CERTIFICATE_BINDING_ID PP_MOCK_CERTIFICATE_PROVISIONING_STATE
    prepare_mock_state "$TMP_DIR/certificate-binding.mockstate"

    run_ops_command certificate-binding
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
    export PUBLIC_BASE_URL CUSTOM_DOMAIN
    smoke_repo="$TMP_DIR/deployed-smoke-$scenario-repo"
    rm -rf "$smoke_repo"
    mkdir -p "$smoke_repo"
    case "$scenario" in
      success | canary_record_chmod_failure)
        CANARY_RECORD="$TMP_DIR/deployed-smoke-$scenario.canary"
        printf '%s\n' "existing-canary-record" > "$CANARY_RECORD"
        chmod 644 "$CANARY_RECORD"
        ;;
      canary_record_directory)
        CANARY_RECORD="$TMP_DIR/deployed-smoke-$scenario.canary"
        mkdir -p "$CANARY_RECORD"
        ;;
      canary_record_symlink)
        CANARY_RECORD="$TMP_DIR/deployed-smoke-$scenario.canary"
        printf '%s\n' "existing-canary-record" > "${CANARY_RECORD}.target"
        ln -s "${CANARY_RECORD}.target" "$CANARY_RECORD"
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
        ln -s "$smoke_repo" "$TMP_DIR/deployed-smoke-$scenario-link"
        CANARY_RECORD="$TMP_DIR/deployed-smoke-$scenario-link/canary.env"
        ;;
      *)
        unset CANARY_RECORD
        ;;
    esac
    if test -n "${CANARY_RECORD:-}"; then
      export CANARY_RECORD
    fi
    smoke_tmp_dir="$TMP_DIR/deployed-smoke-$scenario-tmp"
    curl_argv_log="$TMP_DIR/deployed-smoke-$scenario-curl-argv.log"
    caller_trap_log="$TMP_DIR/deployed-smoke-$scenario-caller-trap.log"
    caller_trap_snapshot="$TMP_DIR/deployed-smoke-$scenario-caller-traps.txt"
    rm -rf "$smoke_tmp_dir"
    : > "$curl_argv_log"
    : > "$caller_trap_log"

    PP_MOCK_GROUP="smoke"
    PP_MOCK_SCENARIO="$scenario"
    PP_MOCK_LOG=""
    PP_MOCK_REPO_ROOT="$smoke_repo"
    PP_MOCK_SMOKE_TMP_DIR="$smoke_tmp_dir"
    PP_MOCK_CURL_ARGV_LOG="$curl_argv_log"
    PP_MOCK_CALLER_TRAP_LOG="$caller_trap_log"
    PP_MOCK_CALLER_TRAP_SNAPSHOT="$caller_trap_snapshot"
    # The block derives its unique marker from the temporary directory the
    # mocked mktemp -d hands out, which the curl shim cannot read from the
    # block's environment.
    PP_MOCK_SMOKE_MARKER="PATCHPAGE_AZURE_SMOKE_${smoke_tmp_dir##*/}"
    export PP_MOCK_GROUP PP_MOCK_SCENARIO PP_MOCK_LOG PP_MOCK_REPO_ROOT \
      PP_MOCK_SMOKE_TMP_DIR PP_MOCK_CURL_ARGV_LOG PP_MOCK_CALLER_TRAP_LOG \
      PP_MOCK_CALLER_TRAP_SNAPSHOT PP_MOCK_SMOKE_MARKER
    prepare_mock_state "$TMP_DIR/deployed-smoke-$scenario.mockstate"

    # Two scenarios prove that the upload request's shape is load-bearing, by
    # sabotaging it. The runbook is a file now, so the sabotage produces a
    # scratch copy of the whole CLI -- ops.sh beside its own cmd/ directory --
    # and the wrapper dispatches through that copy instead. ops.sh resolves cmd/
    # relative to itself, so the scratch tree is a complete, self-consistent CLI
    # and the invocation under test stays `sh <ops.sh> deployed-smoke`.
    smoke_ops="$GUIDE_OPS"
    case "$scenario" in
      upload_body_header_file_mutation | upload_duplicate_body_mutation)
        smoke_ops_root="$TMP_DIR/deployed-smoke-$scenario-ops"
        rm -rf "$smoke_ops_root"
        mkdir -p "$smoke_ops_root/cmd" "$smoke_ops_root/lib" || return 1
        cp "$GUIDE_OPS" "$smoke_ops_root/ops.sh" || return 1
        # ops.sh derives PP_OPS_LIB from its own location, so a scratch CLI is
        # only self-consistent if the shared libraries come with it. Copying
        # them rather than pointing at the real lib/ keeps the scratch tree
        # genuinely standalone, which is what makes the sabotage below a
        # sabotage of this CLI and not of the one under test everywhere else.
        for smoke_lib in $GUIDE_LIBS; do
          cp "$GUIDE_LIB_DIR/$smoke_lib.sh" "$smoke_ops_root/lib/$smoke_lib.sh" ||
            return 1
        done
        smoke_ops="$smoke_ops_root/ops.sh"
        ;;
    esac
    case "$scenario" in
      upload_body_header_file_mutation)
        # Send the authorization header file as the request body. The runbook
        # names that file in $UPLOAD_HEADER_FILE, so the substituted line is a
        # line the sabotaged runbook can actually execute -- which is the whole
        # point: the mutated argv has to reach curl for curl's argv contract to
        # be the thing that rejects it.
        awk '
          $0 == "    --data \"$UPLOAD_PAYLOAD\" \\" {
            replacements++
            print "    --data-binary \"@$UPLOAD_HEADER_FILE\" \\"
            next
          }
          { print }
          END { if (replacements != 1) exit 1 }
        ' "$GUIDE_CMD_DIR/deployed-smoke.sh" \
          > "$smoke_ops_root/cmd/deployed-smoke.sh" || return 1
        ;;
      upload_duplicate_body_mutation)
        awk '
          $0 == "    --data \"$UPLOAD_PAYLOAD\" \\" {
            replacements++
            print
          }
          { print }
          END { if (replacements != 1) exit 1 }
        ' "$GUIDE_CMD_DIR/deployed-smoke.sh" \
          > "$smoke_ops_root/cmd/deployed-smoke.sh" || return 1
        ;;
    esac
    write_wrapper_part "deployed-smoke-$scenario-dispatch" \
      "sh \"$smoke_ops\" deployed-smoke"
    run_ops_wrapper "deployed-smoke-$scenario" \
      smoke-caller-traps "deployed-smoke-$scenario-dispatch" smoke-trailer
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
      upload_body_header_file_mutation | upload_duplicate_body_mutation)
        # These two are the sabotage scenarios, and they run out of a scratch
        # copy of the CLI. A scratch tree that is missing something -- lib/,
        # most easily -- dies at a source line long before the mutated upload
        # is reached, and every assertion above still passes: a green test
        # proving nothing. So pin the failure reason rather than the failure.
        #
        # The mutated argv has to have actually reached curl, and the run has
        # to have died at the upload rather than on the way there. Between them
        # those two facts say the scratch CLI was complete and the sabotage is
        # what stopped it.
        grep -Fqx 'https://drafts.self-hoster.dev/api/uploads' \
          "$TMP_DIR/deployed-smoke-$scenario-curl-argv.log" ||
          fail "deployed smoke never attempted the upload during $scenario, so the sabotage proved nothing"
        grep -Fq 'The authenticated upload request failed.' "$failure_output" ||
          fail "deployed smoke did not fail at the sabotaged upload during $scenario"
        if grep -Fq 'No such file or directory' "$failure_output"; then
          fail "deployed smoke failed on an incomplete scratch CLI during $scenario, not on the sabotage"
        fi
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
  test_infrastructure_session \
  test_stale_lease_recovery \
  test_operation_binding_wire_format \
  test_plan_gate_filter \
  test_public_safe_runbook_static \
  test_custom_domain_context \
  test_custom_domain_output_guards \
  test_ingress_verification \
  test_hostname_mutation_guard \
  test_apex_dns \
  test_caa_policy \
  test_certificate_binding \
  test_deployed_smoke

GUIDE_PRIVATE_OUTPUT_SWEPT=0
guide_sweep_private_output() {
  guide_sweep_group="$1"
  guide_sweep_count=0
  for guide_sweep_capture in "$TMP_DIR"/*.out; do
    test -f "$guide_sweep_capture" || continue
    guide_sweep_count=$((guide_sweep_count + 1))
    if guide_private_output_leaks "$guide_sweep_capture"; then
      fail "a private value reached ${guide_sweep_capture##*/}, seen after $guide_sweep_group"
    fi
    if grep -Fq "$TMP_ROOT" "$guide_sweep_capture" ||
      grep -Fq "$TMP_ROOT_PHYSICAL" "$guide_sweep_capture"; then
      fail "a private harness path reached ${guide_sweep_capture##*/}, seen after $guide_sweep_group"
    fi
  done
  GUIDE_PRIVATE_OUTPUT_SWEPT="$guide_sweep_count"
}

# Meta-test the sweep before any of it is trusted. A pattern that matched
# nothing would let every capture through and every group would pass, so the
# check is shown to reject one capture of each shape it exists to catch, and to
# accept a message of the shape the runbooks actually print.
guide_sweep_probe_dir="$TMP_DIR/private-output-probe"
mkdir -p "$guide_sweep_probe_dir" ||
  fail "could not create the private-output probe directory"
printf 'The active Azure subscription does not match the private expected value.\n' \
  > "$guide_sweep_probe_dir/clean"
if guide_private_output_leaks "$guide_sweep_probe_dir/clean"; then
  fail "the private-output sweep rejects a generic runbook message"
fi
guide_sweep_probe_case=0
for guide_sweep_probe_value in \
  'active subscription 00000000-0000-0000-0000-000000000000 mismatched' \
  'state account patchpagestate is unavailable' \
  'could not read rg-patchpage-workload' \
  'image acrpatchpageabc123.azurecr.io/patchpage-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'private-az-diagnostic account show' \
  'token pp_abcdef' \
  'BlobEndpoint=x;AccountKey=secret'; do
  guide_sweep_probe_case=$((guide_sweep_probe_case + 1))
  printf '%s\n' "$guide_sweep_probe_value" \
    > "$guide_sweep_probe_dir/leak-$guide_sweep_probe_case"
  guide_private_output_leaks "$guide_sweep_probe_dir/leak-$guide_sweep_probe_case" ||
    fail "the private-output sweep accepts a capture containing $guide_sweep_probe_value"
done
test "$guide_sweep_probe_case" -eq 7 ||
  fail "the private-output sweep meta-test lost one of its cases"
rm -rf "$guide_sweep_probe_dir"

for guide_scenario_group in "$@"; do
  "$guide_scenario_group"
  guide_sweep_private_output "$guide_scenario_group"
done

# Exact, so a scenario whose output stopped being captured -- or a group that
# silently stopped running -- cannot leave the sweep passing over less than it
# used to. Adding scenarios means updating this number.
test "$GUIDE_PRIVATE_OUTPUT_SWEPT" -eq 540 ||
  fail "the private-output sweep examined $GUIDE_PRIVATE_OUTPUT_SWEPT scenario captures, not the expected 540"

printf 'guide_commands_test: %s scenario groups passed, %s captures swept\n' \
  "$#" "$GUIDE_PRIVATE_OUTPUT_SWEPT"
