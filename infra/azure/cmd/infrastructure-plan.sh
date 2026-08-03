set -u
set +x
# Same privilege model as infrastructure-change, and for the same reason: this
# flow already holds a storage account key for the OpenTofu backend and takes
# the operation lease with it, which is a different model from the release
# flows. lib/lease.sh takes it as an explicit input; see lib/lease.sh.
OPERATION_LEASE_AUTH_MODE=key
. "${PP_OPS_LIB:?run this through the dispatcher: sh infra/azure/ops.sh infrastructure-plan}/wrappers.sh"
. "$PP_OPS_LIB/diag.sh"
. "$PP_OPS_LIB/lease.sh"
. "$PP_OPS_LIB/revision.sh"
. "$PP_OPS_LIB/state_inspect.sh"
. "$PP_OPS_LIB/plan_gate.sh"
. "$PP_OPS_LIB/infra_change.sh"

# The reviewed half of an existing-environment infrastructure change. It runs
# every gate infrastructure-change runs before its review gate -- the same
# phases, in the same order, out of the same library -- and then stops with the
# plan preserved instead of discarded.
#
# Two things leave this command that did not leave the merged one.
#
# The saved plan itself, with its SHA-256, so infrastructure-apply applies the
# bytes that were reviewed rather than a fresh plan that merely renders the same
# inventory. Those two are only the same thing while nothing moves, and "nothing
# moved" is precisely what a review cannot check for itself.
#
# And the operation lease, still held. That is the point of the session and it
# is a deliberate exception to the exit-code contract's "a 0 released everything
# it held": between the review and the apply, this environment has an owner, and
# an infrastructure change that gave the lease back at the review gate would be
# inviting a release, a rollback or a second infrastructure change into the
# window its own plan is describing. The lease is given back by
# infrastructure-apply on success, or by infrastructure-abandon on a decision
# not to proceed. Nothing else may take it: a second operator who believes this
# session is dead has to prove it and run stale-lease-recovery, exactly as for
# any other retained lease.
infra_change_begin
infra_session_locate
# ../.. is the repository root: infra_change_begin left this process in the
# repository's infra/azure, which is where the OpenTofu configuration is and
# where every phase below expects to be standing.
infra_session_require_outside_repo ../..
infra_session_require_absent
infra_change_open_workspace
infra_change_plan_phase
infra_change_review_token
infra_session_create
printf 'Second operator: review the action inventory above against the private environment record and the backup/restore evidence, then run infrastructure-apply against this same session with INFRA_CHANGE_APPROVAL_SHA256 set to the token below.\n'
printf 'INFRA_CHANGE_APPROVAL_SHA256=%s\n' "$INFRA_CHANGE_REVIEW_SHA256"
printf 'The operation lease is held for this session. infrastructure-apply gives it back on success; infrastructure-abandon gives it back without applying.\n'
unset INFRA_ACTION_SUMMARY INFRA_CHANGE_REVIEW_SHA256
# The lease outlives this process on purpose, so the EXIT trap is owed nothing
# and must not offer it back. This is the one place in these runbooks where
# OPERATION_LEASE_ACTIVE is lowered over a lease that is still held, and it is
# safe here for the one reason it is nowhere else: the holder is recorded in the
# session, and the two commands that close the session are the two that read it.
OPERATION_LEASE_ACTIVE=false
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
