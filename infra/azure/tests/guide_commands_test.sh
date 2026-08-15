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

# Returns 0 when one of the given captures contains a private value, naming the
# first offender on stdout, and 1 when they are all clean. Reports status rather
# than calling fail so the check itself can be meta-tested, and takes the whole
# set rather than one file so the sweep and the meta-test run the same code: a
# per-file loop over eighteen groups was some thirty thousand grep spawns, and
# the batch form that fixed that is only trustworthy if it is the form the
# meta-test exercises.
guide_private_output_leaks() {
  guide_output_leak_hit="$(
    grep -lE "$GUIDE_PRIVATE_OUTPUT_PATTERN" "$@" 2>/dev/null | sed -n '1p'
  )"
  test -n "$guide_output_leak_hit" || return 1
  printf '%s\n' "$guide_output_leak_hit"
}

# The same shape for the harness's own temporary root, which is the other half
# of the promise: a private diagnostic, session or plan directory can only be
# somewhere under it, so a capture naming it has exposed a private path. Both
# spellings are checked because macOS hands back a /var/folders path that is a
# symlink to /private/var/folders, and a runbook that resolved a directory with
# `pwd -P` would print the second.
guide_private_path_leaks() {
  guide_path_leak_hit="$(
    {
      grep -lF "$TMP_ROOT" "$@" 2>/dev/null
      grep -lF "$TMP_ROOT_PHYSICAL" "$@" 2>/dev/null
    } | sed -n '1p'
  )"
  test -n "$guide_path_leak_hit" || return 1
  printf '%s\n' "$guide_path_leak_hit"
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
          'storage blob list --account-name patchpagestate --container-name patchpage-operations --auth-mode key --include dv --num-results * --query [].name --output tsv' \
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
          "storage blob list --account-name patchpagestate --container-name tfstate --auth-mode key --prefix patchpage-prod.tfstate --include dv --num-results * --query [?name=='patchpage-prod.tfstate'].name --output tsv" \
          "$log" ||
          fail "state bootstrap did not prove the backend key lacks current, deleted, or versioned history"
        grep -Fqx \
          'lock create --name protect-patchpage-tfstate --lock-type CanNotDelete --resource /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate' \
          "$log" ||
          fail "state storage-account deletion lock was not created at exact scope"
        grep -Fqx \
          "lock list --resource /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate --query [?name=='protect-patchpage-tfstate'].[[level,id]] --output tsv" \
          "$log" ||
          fail "state storage-account deletion lock was not inspected before mutation"
        grep -Fqx \
          'lock show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-tfstate/providers/Microsoft.Storage/storageAccounts/patchpagestate/providers/Microsoft.Authorization/locks/protect-patchpage-tfstate --query [[level,id]] --output tsv' \
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
          stage == 6 && /^az lock show --ids .*\/Microsoft\.Storage\/storageAccounts\/patchpagedrafts\/providers\/Microsoft\.Authorization\/locks\/protect-patchpage-drafts --query \[\[level,id\]\] --output tsv$/ { stage = 7; next }
          stage == 7 && /^az lock create --name protect-patchpage-postgres --lock-type CanNotDelete --resource .*\/Microsoft\.DBforPostgreSQL\/flexibleServers\/patchpage-postgres$/ { stage = 8; next }
          stage == 8 && /^az lock show --ids .*\/Microsoft\.DBforPostgreSQL\/flexibleServers\/patchpage-postgres\/providers\/Microsoft\.Authorization\/locks\/protect-patchpage-postgres --query \[\[level,id\]\] --output tsv$/ { stage = 9 }
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
      public_base_credentials) PUBLIC_BASE_URL="https://user@example.com" ;;
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
        'az storage blob list --account-name patchpagestate --container-name patchpage-operations --auth-mode login --include dv --num-results * --query [].name --output tsv' \
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
        'az lock show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.Storage/storageAccounts/patchpagedrafts/providers/Microsoft.Authorization/locks/protect-patchpage-drafts --query [[level,id]] --output tsv' \
        "$log" ||
        fail "app release did not prove the exact workload Storage lock"
      grep -Fqx \
        'az lock show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-postgres/providers/Microsoft.Authorization/locks/protect-patchpage-postgres --query [[level,id]] --output tsv' \
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
      public_base_credentials) PUBLIC_BASE_URL="https://user@example.com" ;;
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
        'az lock show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.Storage/storageAccounts/patchpagedrafts/providers/Microsoft.Authorization/locks/protect-patchpage-drafts --query [[level,id]] --output tsv' \
        "$log" ||
        fail "rollback did not prove the exact workload Storage lock"
      grep -Fqx \
        'az lock show --ids /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-patchpage-workload/providers/Microsoft.DBforPostgreSQL/flexibleServers/patchpage-postgres/providers/Microsoft.Authorization/locks/protect-patchpage-postgres --query [[level,id]] --output tsv' \
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
        'az storage blob list --account-name patchpagestate --container-name patchpage-operations --auth-mode key --include dv --num-results * --query [].name --output tsv' \
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
# operation lease must exit 75, and a run that exits 75 must say so.
#
# infrastructure-plan is the one command that ends with the lease deliberately
# held and still exits 0, and it is worth being clear about what keeps that
# exception narrow, because it is not this assertion. This assertion only knows
# the two retention messages; the plan's hand-off message is a third string it
# has never heard of, so the plan passes here the way any non-retaining run
# does. What pins the plan is the standalone grep for
# 'The operation lease is held for this session.' further down, together with
# the group-wide check that this group contributed nothing to
# GUIDE_RETAINED_LEASE_EXITS. A plan that started printing a *retention*
# message would be caught here; a plan that stopped saying anything about the
# lease at all would be caught there.
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

  # --- a session a crash left half-written ------------------------------------
  #
  # infra_session_create writes seven things one after another. A process killed
  # between two of them, or a disk that fills, leaves a directory complete
  # enough to stop the next plan -- a session is open -- and incomplete enough
  # to fail a load that insists on all seven. Every command then refuses: plan
  # because a session is open, apply and abandon because the session will not
  # load, and the operation lease stays held with nothing able to give it back.
  # Abandoning is the way out of that, so abandoning must not require the six
  # fields it never reads.
  guide_session_setup session_partial
  guide_session_run_plan session_partial
  test "$session_status" -eq 0 ||
    fail "infrastructure plan failed before the half-written-session scenario"
  guide_session_lease_is_held ||
    fail "infrastructure plan left nothing holding the environment before the half-written-session scenario"
  session_partial_lease="$(cat "$session_dir/lease")"
  rm -f "$session_dir/plan.tfplan" "$session_dir/plan.sha256" \
    "$session_dir/revision" "$session_dir/locked-image" ||
    fail "could not simulate a half-written session"
  for session_field in lease inventory planned-image; do
    test -f "$session_dir/$session_field" ||
      fail "the half-written-session scenario did not leave $session_field behind"
  done
  guide_session_run session_partial infrastructure-abandon abandon
  test "$session_status" -eq 0 ||
    fail "infrastructure abandon refused a half-written session, leaving it unclosable"
  grep -Fqx 'Infrastructure session abandoned.' "$session_output" ||
    fail "infrastructure abandon did not report closing the half-written session"
  test ! -e "$session_dir" ||
    fail "infrastructure abandon left the half-written session behind"
  # The lease is why any of this matters, and the one surviving field that names
  # it is enough to prove it and give it back.
  if guide_session_lease_is_held; then
    fail "infrastructure abandon cleared a half-written session without giving back its operation lease"
  fi
  grep -Fqx \
    "az storage container lease release --account-name patchpagestate --container-name patchpage-operations --auth-mode key --lease-id $session_partial_lease --output none" \
    "$session_log" ||
    fail "infrastructure abandon did not release the exact lease the half-written session recorded"
  # And the referral cycle is broken where it matters: a plan can be opened
  # again, which is the whole point of having closed the session.
  guide_session_run session_partial infrastructure-plan replan
  test "$session_status" -eq 0 ||
    fail "infrastructure plan still could not open a session after the half-written one was abandoned"
  test -d "$session_dir" ||
    fail "the plan after the abandoned half-written session left no session behind"

  # --- a session too damaged to name a lease ----------------------------------
  #
  # Below the one field abandon needs. There is no lease it could prove or hand
  # back, so it clears the record and says so, and it must not guess at an ID:
  # what is left is a container whose lease only stale-lease-recovery can reach.
  guide_session_setup session_partial_no_lease
  guide_session_run_plan session_partial_no_lease
  test "$session_status" -eq 0 ||
    fail "infrastructure plan failed before the unnameable-lease scenario"
  rm -f "$session_dir/lease" "$session_dir/plan.sha256" ||
    fail "could not simulate a session that lost its lease field"
  guide_session_run session_partial_no_lease infrastructure-abandon abandon
  test "$session_status" -eq 0 ||
    fail "infrastructure abandon refused a session that had lost its lease field"
  grep -Fq 'clearing the session record only' "$session_output" ||
    fail "infrastructure abandon did not say it was clearing the record only"
  test ! -e "$session_dir" ||
    fail "infrastructure abandon kept a session it could not read a lease from"
  for session_lease_verb in renew release; do
    if grep -Fq "az storage container lease $session_lease_verb " "$session_log"; then
      fail "infrastructure abandon sent a lease $session_lease_verb for a lease the session never named"
    fi
  done
  guide_session_lease_is_held ||
    fail "infrastructure abandon released a lease it could not name"

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
    acquire_ok_transit_fails \
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
        acquire_ok_transit_fails)
          # Azure granted the acquire and the answer was lost coming back. The
          # container is leased under this recovery's own ID, this recovery has
          # been told it failed, and no other process can ever name that ID --
          # so if this run does not release it, nothing short of another break
          # will. The release the exit trap sends blind is what makes the leak
          # recoverable, and it is why a refused acquire is not a reason to
          # stop calling Azure.
          transit_lease_id="$(
            sed -n 's/^az storage container lease acquire .* --proposed-lease-id \([^ ]*\) --output none$/\1/p' "$log"
          )"
          test -n "$transit_lease_id" ||
            fail "the recoverer proposed no lease ID during $scenario"
          grep -Fqx \
            "az storage container lease release --account-name patchpagestate --container-name patchpage-operations --auth-mode login --lease-id $transit_lease_id --output none" \
            "$log" ||
            fail "the recoverer left behind the lease its refused acquire had in fact been granted during $scenario"
          # And the leak is actually gone, not merely aimed at: the container
          # the mock is keeping is unleased again.
          test ! -e "$TMP_DIR/stale-lease-$scenario.mockstate/operation-lease-id" ||
            fail "the operation container is still leased after $scenario"
          # Still exit 1, not 75: nothing was ever confirmed taken, so retrying
          # is the right advice.
          test "$status" -eq 1 ||
            fail "the recoverer exited $status instead of 1 during $scenario"
          ;;
        concurrent_recovery)
          # The losing side of the race. Its break landed, a second recoverer
          # took the container back in that instant, and its own acquire was
          # refused. Three things have to be true of what it did next.
          #
          # First: it gave up recovering, and everything it sent after the
          # refused acquire is one release of the ID it minted itself. That
          # release is deliberate and safe to send blind -- Azure matches a
          # release against the live lease ID exactly, so against the winner's
          # lease it is a 409 that changes nothing, and against the residue of
          # an acquire that was granted but lost in transit it is the only
          # thing that clears it. What is forbidden is anything else: a renew,
          # a second break, a metadata write, a second acquire. Asserting on
          # the whole tail rather than a list of verbs fails on ones nobody has
          # written yet.
          grep -Fq 'az storage container lease break ' "$log" ||
            fail "the losing recoverer never reached the lease break, so $scenario proved nothing"
          test "$(
            grep -cF 'az storage container lease acquire ' "$log" | tr -d ' '
          )" = "1" ||
            fail "the losing recoverer did not attempt exactly one acquire during $scenario"
          loser_lease_id="$(
            sed -n 's/^az storage container lease acquire .* --proposed-lease-id \([^ ]*\) --output none$/\1/p' "$log"
          )"
          test -n "$loser_lease_id" ||
            fail "the losing recoverer proposed no lease ID during $scenario"
          loser_acquire_line="$(
            grep -nF 'az storage container lease acquire ' "$log" |
              sed -n '1s/:.*//p'
          )"
          loser_tail="$(tail -n "+$((loser_acquire_line + 1))" "$log")"
          test "$loser_tail" = \
            "az storage container lease release --account-name patchpagestate --container-name patchpage-operations --auth-mode login --lease-id $loser_lease_id --output none" ||
            fail "the losing recoverer's calls after its refused acquire were not one release of its own lease during $scenario"
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
  # Exactly one winner. This is implied by the two per-run assertions above --
  # success must print the completion line, and the loser must not -- so it
  # catches nothing they would let through today, and it is kept anyway rather
  # than dressed up as independent. It is the only place the cross-run property
  # is stated as a property, so relaxing either per-run assertion later does not
  # quietly take the pair invariant with it, and the failure message names the
  # thing that actually went wrong instead of one run's output.
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
  #
  # Both anchors are the whole statement and both are required to appear exactly
  # once. A pin that took the first line merely *mentioning* /dev/urandom is a
  # pin a comment can satisfy: writing prose about the minting above the break
  # would leave the ordering true of the prose while the code moved below it,
  # and the pin would go on passing. Uniqueness is what forecloses that, and it
  # is not hypothetical -- it is how this check was first found to be defeated.
  stale_lease_source="$GUIDE_CMD_DIR/stale-lease-recovery.sh"
  stale_lease_mint_statement='od -An -N16 -tx1 /dev/urandom'
  stale_lease_break_statement='private_az storage container lease break \'
  test "$(
    grep -cF "$stale_lease_mint_statement" "$stale_lease_source" | tr -d ' '
  )" = "1" ||
    fail "stale operation lease recovery does not mint its lease ID in exactly one place, so the source-order pin cannot say where that place is"
  test "$(
    grep -cF "$stale_lease_break_statement" "$stale_lease_source" | tr -d ' '
  )" = "1" ||
    fail "stale operation lease recovery does not break the lease in exactly one place, so the source-order pin cannot say where that place is"
  stale_lease_mint_line="$(
    grep -nF "$stale_lease_mint_statement" "$stale_lease_source" |
      sed -n '1s/:.*//p'
  )"
  stale_lease_source_break_line="$(
    grep -nF "$stale_lease_break_statement" "$stale_lease_source" |
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
# move with it. The guide-side rule is guide_fences_document_only_ops_commands
# below, which says the guide has no shell left for this one to scan.
#
# Exactly what this guarantees: none of these 13 tools -- az, terraform, tofu,
# git, curl, dig, jq, openssl, mktemp, chmod, sleep, cat, rm -- is named by an
# absolute path.
#
# Twelve of them have a shim in tests/mocks: az, terraform, tofu, git, curl,
# dig, jq, mktemp, chmod, sleep, cat and rm. For those, an absolute path is the
# one bypass that would fail silently, because the real tool would answer and
# the command would still look like it passed. openssl is the thirteenth and has
# no shim -- the digest helpers in lib/ run the runner's real openssl -- and the
# jq shim delegates everything it does not special-case to the real jq through
# mock_real, so both of those binaries are the runner's own. They are still in
# the list because the rule being enforced is PATH resolution, not mocking:
# `/usr/bin/openssl` is a guess about where a tool lives that is wrong on plenty
# of the machines an operator would run this from.
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

# Returns 0 when the guide's shell fences carry nothing but the documented
# command invocations, 1 otherwise. Takes the guide file and the space-separated
# command names so the check itself can be meta-tested against a sabotaged copy.
# Deliberately reports status instead of calling fail.
#
# This replaces a 40-line ceiling on ```sh fences. That heuristic was a proxy
# for "no runbook was re-inlined" and it was sized against the runbooks that
# happened to move -- the smallest was 45 lines -- so it accepted anything
# shorter, and it read only ```sh. Both gaps were real: the guide still carried
# a 32-line subdomain DNS runbook that no command owns and no test ever ran, and
# the same block in a ```bash or bare ``` fence would have passed at any length.
#
# The rule now is a whitelist rather than a size, which is the version that
# cannot be satisfied by writing a smaller runbook. Inside a shell fence, a line
# may be exactly one of:
#
#   * blank, or a comment;
#   * `sh infra/azure/ops.sh <command>`, where <command> is dispatchable;
#   * `. infra/azure/cmd/custom-domain-context.sh` or
#     `. infra/azure/cmd/hostname-mutation.sh` -- the two commands the guide has
#     the operator source, because a child process cannot hand values back.
#
# Nothing else: no assignment prefixes, no exports, no pipelines, no
# redirections. The narrower whitelist is deliberate. Every input a command
# takes is stated in that command's table, so an assignment inside a fence is a
# second place for the same fact to live, and a whitelist clause with no fence
# exercising it is a clause nothing keeps honest. A guide that physically cannot
# hold an executable line cannot regrow the surface PR B moved out.
#
# Four independent statements, because any one alone rots:
#
#   1. no `guide-test` marker survives -- the extraction markers the harness
#      used to key on;
#   2. every line of every shell fence is on the whitelist above;
#   3. every dispatchable command is documented by at least one such line, so
#      shrinking the guide cannot quietly drop a command's section;
#   4. no fence in the guide is spelled with tildes or with four or more
#      backticks.
#
# What counts as a shell fence is decided fail-closed, and that direction is the
# whole point. An allowlist of shell info strings -- sh, bash, bare -- makes
# every info string nobody thought of a way past the check: ```shell and
# ```console are what a runbook actually arrives labelled as, and ```Sh and
# ```sh {.line-numbers} are what an editor or a docs pipeline produces from a
# fence that was ```sh yesterday. So the set that is enumerated is the other
# one: the guide uses txt, hcl and sql for data, and a fence is a shell fence
# unless its info string is one of those three. Classification takes the first
# whitespace-separated word of the info string, lowercased, so an attribute
# suffix cannot smuggle a shell fence past as an unknown language, and casing
# cannot either.
#
# Data fences are skipped but still drive the open/closed state machine, so a
# bare closing ``` is never read as an opening one. Fences are matched after
# trimming, because the guide indents the two inside a numbered list.
#
# Statement 4 is what keeps that state machine honest about the fences it does
# not model. A ~~~ fence, or a ```` fence wrapping content that itself contains
# ```, is a real CommonMark fence this scanner would walk straight through --
# its body would be read as prose, and a runbook inside it would never be seen.
# Rather than model them, the guide is not permitted to contain them: it has
# none today, none is needed, and a rejection is a far smaller thing to be wrong
# about than a silently unscanned block.
guide_fences_document_only_ops_commands() {
  awk -v command_list=" $2 " '
    function trim(s) {
      sub(/^[ \t]+/, "", s)
      sub(/[ \t]+$/, "", s)
      return s
    }
    function is_command(name) {
      return index(command_list, " " name " ") > 0
    }
    function is_data_language(info) {
      return info == "txt" || info == "hcl" || info == "sql"
    }
    /^<!-- guide-test:/ { marker = 1 }
    {
      line = trim($0)
      if (substr(line, 1, 3) == "~~~" || substr(line, 1, 4) == "````") {
        exotic_fence = 1
        next
      }
      if (substr(line, 1, 3) == "```") {
        if (in_fence) {
          in_fence = 0
          shell_fence = 0
        } else {
          info = trim(substr(line, 4))
          split(info, info_words, /[ \t]+/)
          in_fence = 1
          shell_fence = !is_data_language(tolower(info_words[1]))
        }
        next
      }
      if (!in_fence || !shell_fence) next
      if (line == "" || substr(line, 1, 1) == "#") next
      if (line ~ /^sh infra\/azure\/ops\.sh [a-z][a-z0-9-]*$/) {
        name = line
        sub(/^sh infra\/azure\/ops\.sh /, "", name)
        if (is_command(name)) {
          documented[name] = 1
          next
        }
      }
      if (line ~ /^\. infra\/azure\/cmd\/(custom-domain-context|hostname-mutation)\.sh$/) {
        name = line
        sub(/^\. infra\/azure\/cmd\//, "", name)
        sub(/\.sh$/, "", name)
        if (is_command(name)) {
          documented[name] = 1
          next
        }
      }
      impure = 1
    }
    END {
      # An unclosed fence would leave the rest of the file unscanned, and an
      # empty command list would make statement 3 vacuous. Both are failures.
      name_count = split(command_list, names, " ")
      if (in_fence || name_count == 0) {
        exit 1
      }
      for (i = 1; i <= name_count; i++) {
        if (!(names[i] in documented)) undocumented = 1
      }
      exit (marker || impure || undocumented || exotic_fence) ? 1 : 0
    }
  ' "$1"
}

# Returns 0 when every input a documented command hard-requires is named in that
# command's section of the guide, 1 otherwise. Takes the guide, the cmd
# directory and the space-separated command names so the check itself can be
# meta-tested against sabotaged copies.
# Deliberately reports status instead of calling fail.
#
# The fence check above says the guide may hold nothing but invocation lines.
# That makes the input tables load-bearing: they are now the only place an
# operator -- or an AI agent reading this repository without a human present --
# can learn what to export before running a command. A table that is missing a
# row is therefore not a documentation nit, it is a command that stops with a
# `${VAR:?}` message and no stated way to satisfy it, and nothing in the harness
# noticed. Auditing the tables against the commands by hand is what found the
# `VALIDATION_METHOD` row this branch added; this is that audit, as a check.
#
# The rule: for every dispatchable command, every `${VAR:?}` name in its cmd
# file appears somewhere in that command's section of the guide, wrapped in
# backticks. A command's section is the text between the previous command's
# invocation line and its own -- the same invocation lines the fence check
# whitelists, which is what makes the two checks agree on where a section ends.
#
# Deliberately the section rather than the table alone. Two commands are
# documented as `. cmd/<name>.sh` because they hand values into the operator's
# shell, and a command run afterwards reads some of those values rather than
# taking them from the operator: `hostname-mutation` guards `SUBSCRIPTION_ID`,
# which the sourced context sets, and its section states that in prose on
# purpose -- putting it in the table would tell the operator to export a value
# the context already computed. Requiring the table would make the guide wrong
# in order to make the check simple.
#
# `PP_OPS_LIB` is the one name excluded, and it is excluded everywhere: ops.sh
# exports it before sourcing a command, so its guard exists to catch a cmd file
# run directly instead of through the dispatcher. It is not an operator input
# and no table should list it.
#
# The limitation, stated rather than hidden: only the cmd file is scanned. A
# guard inside infra/azure/lib is not seen, so an input reachable only through a
# library is not covered -- `EXPECTED_STATE_LINEAGE` and the other infrastructure
# expectations are documented but not proven documented by this. Extending the
# scan to the libraries means deciding which of a library's guards are reachable
# from which command, which is a call graph, not a grep. What is covered is
# every input a command states for itself, which is where both of this branch's
# table errors were.
guide_states_every_command_input() {
  awk -v cmd_dir="$2" -v command_list=" $3 " '
    function trim(s) {
      sub(/^[ \t]+/, "", s)
      sub(/[ \t]+$/, "", s)
      return s
    }
    {
      line = trim($0)
      name = ""
      if (line ~ /^sh infra\/azure\/ops\.sh [a-z][a-z0-9-]*$/) {
        name = line
        sub(/^sh infra\/azure\/ops\.sh /, "", name)
      } else if (line ~ /^\. infra\/azure\/cmd\/[a-z][a-z0-9-]*\.sh$/) {
        name = line
        sub(/^\. infra\/azure\/cmd\//, "", name)
        sub(/\.sh$/, "", name)
      }
      if (name != "" && index(command_list, " " name " ") > 0) {
        # First invocation wins, so a command named twice cannot borrow the
        # section of the one before it.
        if (!(name in section)) section[name] = section_text
        section_text = ""
        next
      }
      section_text = section_text "\n" $0
    }
    END {
      name_count = split(command_list, names, " ")
      # An empty command list would make every loop below vacuous, and so would
      # a guide in which no command is invoked or a cmd file that cannot be
      # read. All three are failures rather than silent passes.
      if (name_count == 0) exit 1
      for (i = 1; i <= name_count; i++) {
        documented_command = names[i]
        if (!(documented_command in section)) {
          broken = 1
          continue
        }
        source_path = cmd_dir "/" documented_command ".sh"
        read_any = 0
        while ((getline source_line < source_path) > 0) {
          read_any = 1
          rest = source_line
          while ((at = index(rest, "${")) > 0) {
            rest = substr(rest, at + 2)
            if (!match(rest, /^[A-Z][A-Z0-9_]*:[?]/)) continue
            guard = substr(rest, 1, RLENGTH - 2)
            if (guard == "PP_OPS_LIB") continue
            checked++
            if (index(section[documented_command], "`" guard "`") == 0) {
              broken = 1
            }
          }
        }
        close(source_path)
        if (!read_any) broken = 1
      }
      if (checked == 0) broken = 1
      exit broken ? 1 : 0
    }
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

# Returns 0 when each of the consumption budget's notification blocks names the
# action group that matches its own threshold, 1 otherwise. Takes the directory
# holding kill_switch.tf so the check itself can be meta-tested against a
# sabotaged copy. Deliberately reports status instead of calling fail.
#
# The generic resource-scoped scan used for the two metric alerts cannot express
# this. A budget carries two notification blocks -- the breaker at 100% pointing
# at the kill group, and the advisory at the cost target pointing at the notice
# group -- so a scan that asks "does this resource mention the kill group
# anywhere" stays green after the two groups are swapped. That swap is the whole
# mistake worth catching: it would turn the ~$100 advisory into an outage and
# leave the $200 breaker merely sending mail, and both notifications would still
# look entirely reasonable in isolation.
#
# So the pairing is what gets asserted, per block and in both directions:
# whichever notification names the kill group must be the 100% one, whichever
# notification is the 100% one must name the kill group, there must be exactly
# one of it, at least one notification must reach the notice group, and no
# notification may name a group this check has never heard of.
budget_notifications_pair_threshold_with_action_group() {
  awk '
    BEGIN {
      kill_group = "[azurerm_monitor_action_group.kill_switch.id]"
      notice_group = "[azurerm_monitor_action_group.operator_notice.id]"
    }
    $0 == "resource \"azurerm_consumption_budget_subscription\" \"circuit_breaker\" {" {
      in_resource = 1
      depth = 1
      next
    }
    in_resource {
      line = $0
      opens = gsub(/\{/, "{", line)
      line = $0
      closes = gsub(/\}/, "}", line)
      if (!in_notification && $0 ~ /^[[:space:]]*notification[[:space:]]*\{[[:space:]]*$/) {
        in_notification = 1
        notification_depth = 1
        seen_threshold = ""
        seen_groups = ""
        depth += opens - closes
        next
      }
      if (in_notification) {
        # threshold_type is not threshold: the character after the name has to
        # be whitespace or the equals sign, which "_" is not.
        if (match($0, /^[[:space:]]*threshold[[:space:]]*=[[:space:]]*/)) {
          rest = substr($0, RSTART + RLENGTH)
          gsub(/[[:space:]]+$/, "", rest)
          seen_threshold = rest
        }
        if (match($0, /^[[:space:]]*contact_groups[[:space:]]*=[[:space:]]*/)) {
          rest = substr($0, RSTART + RLENGTH)
          gsub(/[[:space:]]+$/, "", rest)
          seen_groups = rest
        }
        notification_depth += opens - closes
        if (notification_depth <= 0) {
          in_notification = 0
          if (seen_groups == kill_group) {
            kill_notifications++
            if (seen_threshold != "100") broken = 1
          } else if (seen_groups == notice_group) {
            notice_notifications++
            if (seen_threshold == "100") broken = 1
          } else {
            broken = 1
          }
          if (seen_threshold == "100" && seen_groups != kill_group) broken = 1
        }
      }
      depth += opens - closes
      if (depth <= 0) {
        exit (broken || kill_notifications != 1 || notice_notifications < 1) ? 1 : 0
      }
    }
    END {
      if (!in_resource) exit 1
      exit (broken || kill_notifications != 1 || notice_notifications < 1) ? 1 : 0
    }
  ' "$1"/*.tf
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

# --- what stays static here, and why ------------------------------------------
#
# Every other group in this harness proves a behaviour by running a command.
# This one reads files, so it is worth stating exactly which guards are static
# because nothing behavioural can reach them, and which are static because there
# is no behaviour to reach in the first place. The distinction matters when the
# next person asks why these were not converted with the rest.
#
# Blocked on capabilities OpenTofu does not have:
#
#   * The Container App image precondition. `expect_failures` cannot isolate it
#     from the postcondition on the same resource, and neither override_resource
#     nor a seeded `command = apply` run reaches it. Both routes were tried
#     during #73 and both are written out in full at the prevent_destroy check
#     below -- verified, not assumed. Convert this if the test framework ever
#     gains per-condition failure expectations.
#   * lifecycle prevent_destroy. It is a meta-argument: no plan carries it as a
#     value, so a plan-time assertion has nothing to read.
#
# Static because the subject is a file rather than a process: guide fence
# purity, absolute tool paths in the CLI sources, traps in the two sourced
# commands, and the per-command operation-lease auth-mode declarations. A
# document and a source line have no behaviour to drive. What keeps these
# honest instead is that each is a status-returning function run against a
# deliberately sabotaged copy of what it reads, so the check is itself under
# test even though its subject is not executed.
#
# Already converted, and the reason this list is worth keeping current:
# management-lock scope. #73 moved it to persistent_data_invariants.tftest.hcl
# once override_resource made per-address ids possible, and the static half
# below is now a second layer rather than the only one. That is the direction
# the two blocked guards should travel if the mock framework gains finer
# control; they are blocked on capability, not on effort.
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

  # The runbooks left the guide, and nothing may bring one back: a re-inlined
  # block would be documentation the harness never runs.
  guide_command_names="$(printf '%s' "$GUIDE_COMMANDS" | tr '\n' ' ')"
  guide_fences_document_only_ops_commands "$README" "$guide_command_names" ||
    fail "the Azure guide carries a guide-test marker, a shell fence line that is not a documented command invocation, no invocation for some command, or a tilde or four-backtick fence"

  # Meta-test each statement separately, otherwise one of them could rot into
  # decoration behind another. Every probe starts from an unmodified copy of the
  # guide, and that copy is asserted to pass first, so each rejection below is
  # attributable to its own sabotage rather than to the copying.
  fence_probe_dir="$TMP_DIR/guide-fence-probe"
  rm -rf "$fence_probe_dir"
  mkdir -p "$fence_probe_dir" ||
    fail "could not create the guide-fence probe directory"
  cp "$README" "$fence_probe_dir/clean.md" ||
    fail "could not copy the guide for the fence probes"
  guide_fences_document_only_ops_commands "$fence_probe_dir/clean.md" \
    "$guide_command_names" ||
    fail "the guide-fence check rejects an unmodified copy of the guide"

  # Statement 1: the extraction markers.
  {
    cat "$README" &&
      printf '%s\n' '<!-- guide-test:app-release -->'
  } > "$fence_probe_dir/marker.md" ||
    fail "could not build the guide-test marker probe"
  if guide_fences_document_only_ops_commands "$fence_probe_dir/marker.md" \
    "$guide_command_names"; then
    fail "the guide-fence check accepts a surviving guide-test marker"
  fi

  # Statement 2, in each of the three fence spellings a runbook could arrive in.
  # The rogue block is deliberately far shorter than any runbook that moved:
  # size is exactly what the check this replaced was measuring, so a five-line
  # block is the proof that it no longer is.
  for fence_probe_info in sh bash ''; do
    fence_probe_name="${fence_probe_info:-bare}"
    {
      cat "$README" &&
        printf '%s\n' '```'"$fence_probe_info" &&
        printf '%s\n' \
          'RESOURCE_GROUP="${RESOURCE_GROUP:?Set the resource group}"' \
          'if ! az containerapp show --name "$CONTAINER_APP" >/dev/null; then' \
          '  printf %s\\n "The Container App is missing." >&2' \
          '  exit 1' \
          'fi' &&
        printf '%s\n' '```'
    } > "$fence_probe_dir/rogue-$fence_probe_name.md" ||
      fail "could not build the rogue $fence_probe_name fence probe"
    if guide_fences_document_only_ops_commands \
      "$fence_probe_dir/rogue-$fence_probe_name.md" "$guide_command_names"; then
      fail "the guide-fence check accepts a five-line runbook in a $fence_probe_name fence"
    fi
  done

  # Statement 2, in the info strings an allowlist of shell languages would have
  # let through. These are the reason the classification is fail-closed: each is
  # a plausible way for the very same runbook to arrive labelled, and under
  # `shell_fence = (info == "" || info == "sh" || info == "bash")` every one of
  # them was skipped entirely rather than scanned.
  for fence_probe_info in shell console Sh 'sh {.line-numbers}'; do
    {
      cat "$README" &&
        printf '%s\n' '```'"$fence_probe_info" &&
        printf '%s\n' \
          'RESOURCE_GROUP="${RESOURCE_GROUP:?Set the resource group}"' \
          'if ! az containerapp show --name "$CONTAINER_APP" >/dev/null; then' \
          '  printf %s\\n "The Container App is missing." >&2' \
          '  exit 1' \
          'fi' &&
        printf '%s\n' '```'
    } > "$fence_probe_dir/unknown-info.md" ||
      fail "could not build the unknown-info-string fence probe"
    if guide_fences_document_only_ops_commands \
      "$fence_probe_dir/unknown-info.md" "$guide_command_names"; then
      fail "the guide-fence check accepts a runbook in a fence labelled: $fence_probe_info"
    fi
  done

  # And the other direction for the same statement: the three info strings the
  # guide really uses for data must keep passing, or fail-closed would just mean
  # the check rejects the guide it is written against. The content is data, not
  # shell, and each is appended on its own so a failure names the language.
  for fence_probe_info in txt hcl sql; do
    {
      cat "$README" &&
        printf '%s\n' '```'"$fence_probe_info" &&
        printf '%s\n' \
          'azurerm_resource_group.patchpage' \
          'trust_proxy = "2"' \
          'SELECT draft_versions.source_ip FROM draft_versions;' &&
        printf '%s\n' '```'
    } > "$fence_probe_dir/data-$fence_probe_info.md" ||
      fail "could not build the $fence_probe_info data-fence probe"
    guide_fences_document_only_ops_commands \
      "$fence_probe_dir/data-$fence_probe_info.md" "$guide_command_names" ||
      fail "the guide-fence check rejects data content in a $fence_probe_info fence"
  done

  # Statement 4: the two fence spellings the scanner does not model. Both would
  # be walked straight through -- their bodies read as prose -- so the guide is
  # not permitted to contain them at all. The bodies here are deliberately inert,
  # so only statement 4 can be what turns each probe red.
  {
    cat "$README" &&
      printf '%s\n' '~~~sh' 'az containerapp update --name "$CONTAINER_APP"' '~~~'
  } > "$fence_probe_dir/tilde.md" ||
    fail "could not build the tilde-fence probe"
  if guide_fences_document_only_ops_commands "$fence_probe_dir/tilde.md" \
    "$guide_command_names"; then
    fail "the guide-fence check accepts a tilde fence"
  fi
  {
    cat "$README" &&
      printf '%s\n' '````sh' 'az containerapp update --name "$CONTAINER_APP"' '````'
  } > "$fence_probe_dir/four-backtick.md" ||
    fail "could not build the four-backtick-fence probe"
  if guide_fences_document_only_ops_commands \
    "$fence_probe_dir/four-backtick.md" "$guide_command_names"; then
    fail "the guide-fence check accepts a four-backtick fence"
  fi

  # Statement 2, subsumption: the probe the 40-line ceiling was meta-tested
  # with. The replacement is only allowed to be a replacement if what the old
  # check caught, it still catches.
  {
    cat "$README" &&
      printf '%s\n' '```sh' &&
      awk 'NR > 1 && NR <= 60' "$GUIDE_CMD_DIR/hostname-mutation.sh" &&
      printf '%s\n' '```'
  } > "$fence_probe_dir/inlined.md" ||
    fail "could not build the re-inlined runbook probe"
  if guide_fences_document_only_ops_commands "$fence_probe_dir/inlined.md" \
    "$guide_command_names"; then
    fail "the guide-fence check accepts a re-inlined runbook fence"
  fi

  # Statement 2, the near misses. These are the lines most likely to be added in
  # good faith, and each is one clause away from allowed: an export the tables
  # already state, an assignment prefix on an otherwise valid invocation, and an
  # invocation of a name ops.sh would refuse to dispatch.
  for fence_probe_line in \
    'export STATE_KEY=patchpage-prod.tfstate' \
    'STATE_KEY=x sh infra/azure/ops.sh app-release' \
    'sh infra/azure/ops.sh state-boostrap'; do
    {
      cat "$README" &&
        printf '%s\n' '```sh' "$fence_probe_line" '```'
    } > "$fence_probe_dir/near-miss.md" ||
      fail "could not build the near-miss fence probe"
    if guide_fences_document_only_ops_commands "$fence_probe_dir/near-miss.md" \
      "$guide_command_names"; then
      fail "the guide-fence check accepts the fence line: $fence_probe_line"
    fi
  done

  # Statement 3: a shrink that drops a command's section. Removing the one
  # invocation line leaves a guide that is still pure and still marker-free, so
  # only this statement can be what turns it red.
  awk '$0 != "sh infra/azure/ops.sh deployed-smoke"' "$README" \
    > "$fence_probe_dir/undocumented.md" ||
    fail "could not build the undocumented-command probe"
  if cmp -s "$README" "$fence_probe_dir/undocumented.md"; then
    fail "the undocumented-command probe did not remove an invocation"
  fi
  if guide_fences_document_only_ops_commands \
    "$fence_probe_dir/undocumented.md" "$guide_command_names"; then
    fail "the guide-fence check accepts a guide that documents no way to run a command"
  fi

  # And the two degenerate inputs the END block guards, which no sabotage of the
  # guide itself can reach: an unclosed fence, and an empty command list that
  # would make statement 3 vacuous.
  {
    cat "$README" && printf '%s\n' '```sh'
  } > "$fence_probe_dir/unclosed.md" ||
    fail "could not build the unclosed-fence probe"
  if guide_fences_document_only_ops_commands "$fence_probe_dir/unclosed.md" \
    "$guide_command_names"; then
    fail "the guide-fence check accepts an unclosed shell fence"
  fi
  if guide_fences_document_only_ops_commands "$fence_probe_dir/clean.md" ""; then
    fail "the guide-fence check passes vacuously when given no command names"
  fi
  rm -rf "$fence_probe_dir"
  rm -rf "$restricted_path_probe_dir"

  # With the shell gone from the guide, the input tables are the only thing left
  # telling an operator what to export. So they are tied to the commands: a
  # `${VAR:?}` a command hard-requires must be named where that command is
  # documented.
  guide_states_every_command_input "$README" "$GUIDE_CMD_DIR" \
    "$guide_command_names" ||
    fail "a documented command hard-requires an input its section of the Azure guide never names"

  # Meta-tested from both sides, because the check has two moving parts and each
  # can rot alone: the guide can lose a row, and a command can grow a guard.
  # Both probes start from copies asserted to pass first.
  command_input_probe_dir="$TMP_DIR/command-input-probe"
  rm -rf "$command_input_probe_dir"
  mkdir -p "$command_input_probe_dir/cmd" ||
    fail "could not create the command-input probe directory"
  cp "$README" "$command_input_probe_dir/clean.md" ||
    fail "could not copy the guide for the command-input probes"
  for command_input_probe_command in $GUIDE_COMMANDS; do
    cp "$GUIDE_CMD_DIR/$command_input_probe_command.sh" \
      "$command_input_probe_dir/cmd/$command_input_probe_command.sh" ||
      fail "could not populate the command-input probe"
  done
  guide_states_every_command_input "$command_input_probe_dir/clean.md" \
    "$command_input_probe_dir/cmd" "$guide_command_names" ||
    fail "the command-input check rejects unmodified copies of the guide and the commands"

  # The guide side: a table row removed. `VALIDATION_METHOD` is the row this
  # branch added, and hostname-mutation's section names it nowhere else, so its
  # absence is the whole difference.
  awk '$0 !~ /^\| `VALIDATION_METHOD` \|/' "$README" \
    > "$command_input_probe_dir/dropped-row.md" ||
    fail "could not build the dropped-table-row probe"
  if cmp -s "$README" "$command_input_probe_dir/dropped-row.md"; then
    fail "the dropped-table-row probe did not remove a row"
  fi
  if guide_states_every_command_input \
    "$command_input_probe_dir/dropped-row.md" "$command_input_probe_dir/cmd" \
    "$guide_command_names"; then
    fail "the command-input check accepts a guide missing a required input's table row"
  fi

  # The command side: a new guard added to a command whose table nobody updated.
  {
    cat "$GUIDE_CMD_DIR/deployed-smoke.sh" &&
      printf '%s\n' 'PATCHPAGE_PROBE_INPUT="${PATCHPAGE_PROBE_INPUT:?probe}"'
  } > "$command_input_probe_dir/cmd/deployed-smoke.sh" ||
    fail "could not build the undocumented-guard probe"
  if guide_states_every_command_input "$command_input_probe_dir/clean.md" \
    "$command_input_probe_dir/cmd" "$guide_command_names"; then
    fail "the command-input check accepts a command guarding an input the guide never names"
  fi
  cp "$GUIDE_CMD_DIR/deployed-smoke.sh" \
    "$command_input_probe_dir/cmd/deployed-smoke.sh" ||
    fail "could not restore the undocumented-guard probe"
  # Green again once the guard is removed, so the rejection above is
  # attributable to the added guard rather than to anything else in the copy.
  guide_states_every_command_input "$command_input_probe_dir/clean.md" \
    "$command_input_probe_dir/cmd" "$guide_command_names" ||
    fail "the command-input check stays red after the added guard is removed"

  # And the degenerate inputs: an empty command list, and a command whose file
  # the check cannot read. Either would otherwise be a silent pass.
  if guide_states_every_command_input "$command_input_probe_dir/clean.md" \
    "$command_input_probe_dir/cmd" ""; then
    fail "the command-input check passes vacuously when given no command names"
  fi
  rm -f "$command_input_probe_dir/cmd/apex-dns.sh" ||
    fail "could not build the missing-command-file probe"
  if guide_states_every_command_input "$command_input_probe_dir/clean.md" \
    "$command_input_probe_dir/cmd" "$guide_command_names"; then
    fail "the command-input check passes when a command's file cannot be read"
  fi
  rm -rf "$command_input_probe_dir"

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

  # Which action group each cost trigger is pointed at.
  #
  # Exactly the gap the lock scopes above have, for exactly the same reason.
  # Under the per-type mock_resource defaults in the tftest suites, every
  # azurerm_monitor_action_group mocks to one id, so a plan assertion that "the
  # egress tripwire fires the kill action group" is equally satisfied by a
  # tripwire wired to the notice group. tests/cost_posture.tftest.hcl closes
  # that behaviourally with per-address override_resource ids; this closes it
  # again by reading the expression rather than its value, and the two fail for
  # different reasons.
  #
  # Two entries, and the second is the one that matters most. The blob size
  # alarm must notify and must never kill: 50 GiB of stored drafts is a slow,
  # cheap, recoverable problem, and quietly repointing that alarm at the kill
  # group would convert an operator's reading task into an outage. Stating the
  # non-kill wiring here means it cannot drift silently in either direction.
  #
  # Both entries are metric alerts, whose `action` block carries exactly one
  # action_group_id, so "this resource names that group" is the whole of the
  # wiring and a resource-scoped scan says everything there is to say.
  #
  # The consumption budget is deliberately not an entry here. It carries two
  # notification blocks naming two different groups, so the same scan could only
  # assert that the kill group appears *somewhere* inside it -- which stays
  # green if the 100% and 50% groups are swapped, the one mistake worth
  # catching. It gets its own block-aware check below instead.
  #
  # resource|attribute|expected_expression
  for cost_trigger_spec in \
    'azurerm_monitor_metric_alert.egress_tripwire|action_group_id|azurerm_monitor_action_group.kill_switch.id' \
    'azurerm_monitor_metric_alert.blob_capacity|action_group_id|azurerm_monitor_action_group.operator_notice.id'; do
    trigger_resource="${cost_trigger_spec%%|*}"
    trigger_remainder="${cost_trigger_spec#*|}"
    trigger_attribute="${trigger_remainder%%|*}"
    expected_target="${trigger_remainder#*|}"
    resource_type="${trigger_resource%%.*}"
    resource_name="${trigger_resource#*.}"
    if ! awk -v rtype="$resource_type" -v rname="$resource_name" \
      -v attr="$trigger_attribute" -v expected="$expected_target" '
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
        if (match($0, "^[[:space:]]*" attr "[[:space:]]*=[[:space:]]*")) {
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
      fail "cost trigger $trigger_resource does not point $trigger_attribute at $expected_target"
    fi
  done

  # The budget's two notifications, each paired with the group that matches its
  # own threshold. See the function's comment for why the generic scan above
  # cannot say this.
  budget_notifications_pair_threshold_with_action_group "$azure_tf_dir" ||
    fail "the consumption budget's notifications are not each paired with the action group matching their threshold"

  # Meta-test it: swapping the kill and notice groups between the two
  # notifications must be rejected. Without this the check could quietly become
  # the weaker "mentions the kill group somewhere" scan it exists to replace.
  budget_probe_dir="$TMP_DIR/budget-notification-probe"
  rm -rf "$budget_probe_dir"
  mkdir -p "$budget_probe_dir" ||
    fail "could not create the budget notification probe directory"
  sed -e 's/azurerm_monitor_action_group\.kill_switch\.id/PP_SWAP_PLACEHOLDER/g' \
    -e 's/azurerm_monitor_action_group\.operator_notice\.id/azurerm_monitor_action_group.kill_switch.id/g' \
    -e 's/PP_SWAP_PLACEHOLDER/azurerm_monitor_action_group.operator_notice.id/g' \
    "$azure_tf_dir/kill_switch.tf" > "$budget_probe_dir/kill_switch.tf" ||
    fail "could not build the swapped budget notification probe"
  if cmp -s "$azure_tf_dir/kill_switch.tf" "$budget_probe_dir/kill_switch.tf"; then
    fail "the budget notification probe did not swap anything"
  fi
  if budget_notifications_pair_threshold_with_action_group "$budget_probe_dir"; then
    fail "the budget notification check accepts the kill and notice groups swapped"
  fi
  rm -rf "$budget_probe_dir"

  # The kill switch's privilege, which is the whole of what makes it
  # fail-closed. The role carries stop and not start, so the automation is
  # mechanically unable to bring the service back and restoring it is an
  # operator decision in the permission model rather than only in the runbook's
  # prose. cost_posture.tftest.hcl asserts the action list; this states the
  # absent action by name, so a future edit that adds start has to delete a line
  # that says why it must not.
  if awk '
    $0 == "resource \"azurerm_role_definition\" \"kill_switch\" {" {
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
      if ($0 ~ /containerApps\/start\/action/) {
        found_start = 1
      }
      if (depth <= 0) {
        exit found_start ? 0 : 1
      }
    }
    END { exit found_start ? 0 : 1 }
  ' "$azure_tf_dir"/*.tf; then
    fail "the kill switch role grants a Container App start action; restoring service must stay an operator decision"
  fi

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

# The capture name is a parameter because all five calls used to write the same
# certificate-binding.out, so four of the five were overwritten before the
# central sweep ever looked at them and only the last scenario's output was
# swept. The inline grep below still guards this flow's own three values; the
# names are what put the other four captures in front of the universal check.
run_certificate_block() {
  certificate_case="$1"
  subject="$2"
  certificate_id="$3"
  binding_id="$4"
  provisioning_state="$5"
  output="$TMP_DIR/certificate-binding-$certificate_case.out"

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

  run_certificate_block normalized_subject \
    "CN=Drafts.Self-Hoster.Dev." \
    "$certificate_id" \
    "$certificate_id" \
    "Succeeded" ||
    fail "normalized CN certificate subject was not matched"

  if run_certificate_block foreign_subject \
    "CN=other.example.com" \
    "$certificate_id" \
    "$certificate_id" \
    "Succeeded"; then
    fail "certificate verification accepted a different subject"
  fi

  if run_certificate_block foreign_certificate_id \
    "CN=Drafts.Self-Hoster.Dev." \
    "$other_certificate_id" \
    "$certificate_id" \
    "Succeeded"; then
    fail "certificate verification accepted a different managed-certificate resource ID"
  fi

  if run_certificate_block foreign_binding_id \
    "CN=Drafts.Self-Hoster.Dev." \
    "$certificate_id" \
    "$other_certificate_id" \
    "Succeeded"; then
    fail "certificate verification accepted a binding to a different certificate ID"
  fi

  if run_certificate_block pending_certificate \
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

# The running total of captures swept, not the count for one group. Every group
# writes its captures into the one $TMP_DIR and none of them are ever removed,
# so the set this recounts after each group is cumulative and the last group's
# count is the total. That accumulation is what the exact pin at the bottom is
# pinning, and it is an assumption rather than a fact the code enforces: a group
# that started cleaning up after itself, or a capture path that collided with an
# earlier group's, would lower this number rather than raise it. The pin turns
# either into a failure instead of a silently smaller sweep, which is the only
# defence there is -- so a scenario added or removed means changing that number
# deliberately.
GUIDE_PRIVATE_OUTPUT_SWEPT=0
guide_sweep_private_output() {
  guide_sweep_group="$1"
  guide_sweep_count=0
  for guide_sweep_capture in "$TMP_DIR"/*.out; do
    test -f "$guide_sweep_capture" || continue
    guide_sweep_count=$((guide_sweep_count + 1))
  done
  GUIDE_PRIVATE_OUTPUT_SWEPT="$guide_sweep_count"
  test "$guide_sweep_count" -gt 0 || return 0
  # Two batched checks over the whole set rather than two per capture: this runs
  # after every group, and per-file it would be some thirty thousand process
  # spawns in a CI job whose whole point is to be cheap enough to be required.
  # Both are the meta-tested functions, so what runs here in bulk is the code the
  # probes above proved rejects each shape of private value.
  if guide_sweep_hit="$(guide_private_output_leaks "$TMP_DIR"/*.out)"; then
    fail "a private value reached ${guide_sweep_hit##*/}, seen after $guide_sweep_group"
  fi
  if guide_sweep_hit="$(guide_private_path_leaks "$TMP_DIR"/*.out)"; then
    fail "a private harness path reached ${guide_sweep_hit##*/}, seen after $guide_sweep_group"
  fi
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
if guide_private_output_leaks "$guide_sweep_probe_dir/clean" >/dev/null; then
  fail "the private-output sweep rejects a generic runbook message"
fi
if guide_private_path_leaks "$guide_sweep_probe_dir/clean" >/dev/null; then
  fail "the private-path sweep rejects a generic runbook message"
fi
# One probe per alternative in the pattern, not one per shape of value. The
# pattern replaced eight hand-written stanzas whose lists were not identical,
# and an alternative that no probe reaches is an alternative that can be deleted
# -- or mistyped into never matching -- with every group still green. Each probe
# is written to match exactly one alternative, so removing that alternative from
# the pattern turns this loop red rather than being absorbed by a neighbour.
guide_sweep_probe_case=0
for guide_sweep_probe_value in \
  'active subscription 00000000-0000-0000-0000-000000000000 mismatched' \
  'recorded binding sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'state account patchpagestate is unavailable' \
  'blob account patchpagedrafts is unavailable' \
  'state key patchpage-prod.tfstate is missing' \
  'container patchpage-operations is already leased' \
  'server patchpage-db refused the connection' \
  'app patchpage-app has no ready revision' \
  'registry acrpatchpageabc123 login failed' \
  'group rg-patchpage-tfstate not found' \
  'could not read rg-patchpage-workload' \
  'group rg-test not found' \
  'container app app-test not found' \
  'managed environment env-test not found' \
  'hostname drafts.self-hoster.dev did not resolve' \
  'apex A record 203.0.113.10 is wrong' \
  'expected TXT record verification-id was absent' \
  'private-az-diagnostic account show' \
  'private-tofu-diagnostic plan -input=false' \
  'private-rollback-diagnostic containerapp show' \
  'private-infra-az-diagnostic account show' \
  'private-infra-tofu-diagnostic plan -input=false' \
  'token pp_abcdef' \
  'BlobEndpoint=x;AccountKey=secret'; do
  guide_sweep_probe_case=$((guide_sweep_probe_case + 1))
  printf '%s\n' "$guide_sweep_probe_value" \
    > "$guide_sweep_probe_dir/leak-$guide_sweep_probe_case"
  guide_private_output_leaks "$guide_sweep_probe_dir/leak-$guide_sweep_probe_case" \
    >/dev/null ||
    fail "the private-output sweep accepts a capture containing $guide_sweep_probe_value"
done
test "$guide_sweep_probe_case" -eq 24 ||
  fail "the private-output sweep meta-test lost one of its cases"
# The harness-root half, which subsumes the two hand-written "exposed the
# private diagnostic path" assertions and had no meta-test of its own. Both
# spellings are probed. On Linux they are the same string, and on macOS the
# physical one contains the logical one, so this proves the pair catches either
# spelling rather than proving each grep is separately load-bearing -- which is
# the most the platform allows and is stated here rather than implied.
printf 'diagnostics retained under %s/private-run\n' "$TMP_ROOT" \
  > "$guide_sweep_probe_dir/path-leak-logical"
guide_private_path_leaks "$guide_sweep_probe_dir/path-leak-logical" >/dev/null ||
  fail "the private-path sweep accepts a capture naming the harness temporary root"
printf 'diagnostics retained under %s/private-run\n' "$TMP_ROOT_PHYSICAL" \
  > "$guide_sweep_probe_dir/path-leak-physical"
guide_private_path_leaks "$guide_sweep_probe_dir/path-leak-physical" >/dev/null ||
  fail "the private-path sweep accepts a capture naming the resolved harness temporary root"
rm -rf "$guide_sweep_probe_dir"

for guide_scenario_group in "$@"; do
  "$guide_scenario_group"
  guide_sweep_private_output "$guide_scenario_group"
done

# Exact, so a scenario whose output stopped being captured -- or a group that
# silently stopped running -- cannot leave the sweep passing over less than it
# used to. Adding scenarios means updating this number.
test "$GUIDE_PRIVATE_OUTPUT_SWEPT" -eq 550 ||
  fail "the private-output sweep examined $GUIDE_PRIVATE_OUTPUT_SWEPT scenario captures, not the expected 550"

printf 'guide_commands_test: %s scenario groups passed, %s captures swept\n' \
  "$#" "$GUIDE_PRIVATE_OUTPUT_SWEPT"
