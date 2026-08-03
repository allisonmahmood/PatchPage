set -u
set +x
# Same privilege model as infrastructure-plan, whose session this completes.
OPERATION_LEASE_AUTH_MODE=key
. "${PP_OPS_LIB:?run this through the dispatcher: sh infra/azure/ops.sh infrastructure-apply}/wrappers.sh"
. "$PP_OPS_LIB/diag.sh"
. "$PP_OPS_LIB/lease.sh"
. "$PP_OPS_LIB/revision.sh"
. "$PP_OPS_LIB/state_inspect.sh"
. "$PP_OPS_LIB/plan_gate.sh"
. "$PP_OPS_LIB/infra_change.sh"

# The applied half. It re-derives three facts before it mutates anything, and
# refuses on any one of them:
#
#   the lease is still ours -- renewed with the ID the session recorded, which
#   only the container this session leased will accept, so a lease that was
#   broken and reacquired between the review and now fails here rather than
#   letting this apply land on an environment somebody else has been changing;
#
#   the saved plan is the reviewed plan -- rehashed and compared with the digest
#   taken at review time, so an edited or regenerated plan is refused;
#
#   the approval names these actions -- recomputed from the inventory the
#   session recorded, not from a fresh render, so the token proves a second
#   operator read this plan's actions.
#
# Only then does it run the same pre-apply recheck, apply, readiness proof and
# lease release the merged command runs, out of the same library, against the
# exact saved plan file.
: "${INFRA_CHANGE_APPROVAL_SHA256:?Set INFRA_CHANGE_APPROVAL_SHA256 to the token infrastructure-plan printed and a second operator approved}"
# Safety-guard adoption creates locks, seals the operation container and
# migrates a legacy image. All of that belongs to the run a second operator
# reviews, and none of it is described by a plan that has already been reviewed,
# so this command refuses the flag rather than quietly ignoring it.
case "${ADOPT_SAFETY_GUARDS:-false}" in
  false) ;;
  *)
    printf 'Safety-guard adoption belongs to infrastructure-plan; this command applies a plan that was already reviewed.\n' >&2
    exit 1
    ;;
esac
infra_change_begin
infra_session_locate
# The session is read before the workspace is opened, so "there is no reviewed
# plan" is answered by the one thing that can answer it rather than by whatever
# `tofu init` happens to say first. It is the same diagnosability property
# infrastructure-abandon has: the command that closes or completes a session
# must not be able to fail for a reason that has nothing to do with the session.
infra_session_load
infra_change_open_workspace
# The exact bytes the review approved. infra_change_apply_phase applies
# $INFRA_PLAN, and this is the one assignment that decides which plan that is:
# the session's copy, never the workspace this process could have replanned in.
INFRA_PLAN="$INFRA_SESSION_PLAN"
# The two checks that need nothing but the session come first, and deliberately
# before this process touches the lease at all. A mistyped token or a plan that
# no longer hashes to its recorded digest then costs nothing: this command exits
# 1 having held nothing and released nothing, and the session is left exactly as
# the plan left it -- still holding the lease, still reviewable, still closable
# by infrastructure-abandon. Doing the renew-as-proof first would mean a typo
# handed the environment back and forced a replan.
#
# So "nothing is still held" in the exit-code contract keeps its meaning here:
# it is about what a failing run left behind, and a run that never took the
# lease leaves nothing. The lease the plan session is holding is not this run's.
infra_session_verify_plan
infra_session_verify_approval
OPERATION_LEASE_ACTIVE=false
OPERATION_LEASE_RETAINED=false
OPERATION_MUTATION_UNCERTAIN=false
trap 'operation_lease_exit; cleanup_infrastructure_change; tofu_diagnostic_exit; operation_lease_retention_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# Renew-as-proof, before the flag that makes the trap owe a release. Only the
# container this session leased accepts this lease ID, so a renew that succeeds
# is proof that the environment has stood still since the review; one that fails
# means it has not, and this command must not apply a plan of a world that moved.
if ! verify_operation_lease; then
  printf 'The reviewed plan is no longer holding the operation lease; the environment moved since the review. Abandon this session and plan again.\n' >&2
  exit 1
fi
OPERATION_LEASE_ACTIVE=true
infra_change_apply_phase
if ! infra_session_discard; then
  exit 1
fi
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
