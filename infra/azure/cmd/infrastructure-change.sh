set -u
set +x
# This flow already holds a storage account key for the OpenTofu backend, and
# takes the operation lease with it. That is a different privilege model from
# the release flows, which authenticate as the operator's own principal, so
# lib/lease.sh takes it as an explicit input rather than assuming either one.
OPERATION_LEASE_AUTH_MODE=key
. "${PP_OPS_LIB:?run this through the dispatcher: sh infra/azure/ops.sh infrastructure-change}/wrappers.sh"
. "$PP_OPS_LIB/diag.sh"
. "$PP_OPS_LIB/lease.sh"
. "$PP_OPS_LIB/revision.sh"
. "$PP_OPS_LIB/state_inspect.sh"
. "$PP_OPS_LIB/plan_gate.sh"
. "$PP_OPS_LIB/infra_change.sh"

# The one-shot path: plan, report, and -- on the approved rerun -- apply, in one
# process. It is the phases of lib/infra_change.sh in the order they ran in when
# this file carried them inline, which is what keeps every scenario written
# against that inline flow describing this one.
#
# The review still crosses two runs of this command rather than one, and it
# still crosses them as a token rather than as a plan: an approved rerun replans
# against current state and recomputes the token, so it applies actions equal to
# the ones that were approved but never the same plan file. Where that
# distinction matters -- where the plan itself has to be the reviewed artefact,
# and the environment has to be held still between the review and the apply --
# infrastructure-plan and infrastructure-apply are the flow to use.
infra_change_begin
infra_change_open_workspace
infra_change_plan_phase
infra_change_review_token
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
  infra_change_complete
  exit 0
fi
unset INFRA_ACTION_SUMMARY INFRA_CHANGE_REVIEW_SHA256
infra_change_apply_phase
infra_change_complete
unset TERRAFORM_DIAGNOSTIC_DIR TERRAFORM_DIAGNOSTIC_LOG
unset TERRAFORM_DIAGNOSTICS_COMPLETE TERRAFORM_DIAGNOSTIC_FD_OPEN
unset -f cleanup_infrastructure_change tofu_diagnostic_exit
unset -f acquire_operation_lease operation_lease_exit release_operation_lease
unset -f operation_lease_retention_exit
unset -f verify_operation_container verify_operation_lease
unset -f container_app_readiness_recovery_required
unset -f poll_pinned_revision_stable verify_pinned_revision_stable
unset -f infra_change_begin infra_change_open_workspace infra_change_plan_phase
unset -f infra_change_review_token infra_change_apply_phase infra_change_complete
