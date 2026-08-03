# The operation lease: one definition of the mutual exclusion every mutating
# runbook runs under.
#
# Sourced by cmd/*.sh through ops.sh, which exports PP_OPS_LIB; see ops.sh.
# Requires lib/wrappers.sh.
#
# The lease is an infinite lease on the `patchpage-operations` blob container.
# Holding it is what makes "no two operators mutate this environment at once"
# true, and the container's metadata carries the workload binding digest that
# makes "and this is the environment you meant" true. Both halves used to exist
# once per mutating runbook. They are one definition here because a divergence
# between two copies of a mutual-exclusion primitive is not a difference in
# behaviour anyone would notice until two operators collided.
#
# --- the auth mode is a privilege model, not drift ---------------------------
#
# The runbooks do not agree on how to authenticate to the data plane, and they
# should not. app-release and app-rollback run as the operator, whose Entra
# principal holds the operation-container data role, and use `--auth-mode
# login`: their whole safety argument is that a human with a named identity took
# the lease. infrastructure-change runs where a storage account key is already
# in hand for the Terraform backend, and uses `--auth-mode key`.
#
# That difference is deliberate, it is a difference in who is allowed to do
# this, and collapsing it to one value would silently widen or narrow authority.
# So it is an explicit input: each command sets OPERATION_LEASE_AUTH_MODE before
# sourcing this file, and the choice is visible at the top of the command rather
# than buried in a wrapper. The guard below refuses to load without it, so a new
# command cannot inherit whichever mode happened to be written here.
: "${OPERATION_LEASE_AUTH_MODE:?set OPERATION_LEASE_AUTH_MODE to login or key before sourcing lib/lease.sh}"
case "$OPERATION_LEASE_AUTH_MODE" in
  login | key) ;;
  *)
    printf 'lib/lease.sh: OPERATION_LEASE_AUTH_MODE must be login or key.\n' >&2
    exit 1
    ;;
esac

# --- the workload binding wire format ----------------------------------------
#
# Prints the SHA-256 of the `patchpage-operation-binding-v1` tuple, or fails
# without printing anything. The digest is written into the operation
# container's metadata when a deployment seals it, and recomputed and compared
# by every later flow that takes the lease: it is what stops a correctly-held
# lease on the wrong environment from looking like a correctly-held lease on the
# right one.
#
# This tuple is a wire format. A digest recorded against a live environment was
# produced by whatever this text said on the day that environment was sealed, so
# a change to the field order, a label, or the record separator strands every
# already-sealed environment behind a comparison that can no longer succeed.
# tests/guide_commands_test.sh pins the exact bytes to a golden digest computed
# from fixed fixture inputs; that test is the reason this is safe to have one
# copy of, and it fails on any edit to the lines below.
#
# The hex check is part of the mechanism, not the caller's business: an empty or
# truncated digest that reached a metadata comparison would compare equal to
# another empty digest.
operation_binding_sha256() {
  operation_binding_digest="$(
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
  )" || return 1
  printf '%s\n' "$operation_binding_digest" | grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s\n' "$operation_binding_digest"
}

# --- taking and giving back the lease ----------------------------------------

# Returns 0 when the operation container is the one the private record names,
# is empty, and carries exactly the expected workload binding and nothing else.
# The emptiness check is not fussiness: the container is a lock, not storage, so
# anything inside it means something else is using it as something it is not.
#
# The identity comparison case-folds both sides. Azure echoes resource IDs back
# with whatever casing whoever created them used -- `resourceGroups` and
# `resourcegroups` denote the same resource -- so a case-sensitive `!=` on an ID
# read back from the API is a false mismatch waiting to happen. It is written
# out here rather than called through a shared helper on purpose: roughly forty
# other gates in these runbooks fold exactly the same way, and a helper with one
# caller is not a shared definition, it is a second place to look while the
# other forty copies go on existing. Issue #77 converts all of them together.
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
      --auth-mode "$OPERATION_LEASE_AUTH_MODE" \
      --query exists \
      --output tsv
  )" || test "$operation_container_exists" != "true" ||
    ! operation_container_blobs="$(
      private_az storage blob list \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --container-name "$OPERATION_CONTAINER" \
        --auth-mode "$OPERATION_LEASE_AUTH_MODE" \
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
        --auth-mode "$OPERATION_LEASE_AUTH_MODE" \
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
    --auth-mode "$OPERATION_LEASE_AUTH_MODE" \
    --lease-id "$OPERATION_LEASE_ID" \
    --output none >/dev/null
}
acquire_operation_lease() {
  verify_operation_container || return 1
  private_az storage container lease acquire \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --container-name "$OPERATION_CONTAINER" \
    --auth-mode "$OPERATION_LEASE_AUTH_MODE" \
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
    --auth-mode "$OPERATION_LEASE_AUTH_MODE" \
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
# this runs last and any cleanup before it still finishes first.
operation_lease_retention_exit() {
  if test "${OPERATION_LEASE_RETAINED:-false}" = "true"; then
    exit 75
  fi
}
