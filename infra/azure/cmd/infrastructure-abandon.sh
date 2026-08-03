set -u
set +x
# Same privilege model as the session it is closing.
OPERATION_LEASE_AUTH_MODE=key
. "${PP_OPS_LIB:?run this through the dispatcher: sh infra/azure/ops.sh infrastructure-abandon}/wrappers.sh"
. "$PP_OPS_LIB/lease.sh"
. "$PP_OPS_LIB/infra_change.sh"

# The decision not to proceed. A reviewed plan that will not be applied still
# has an operation lease held against it, and that lease is the reason nothing
# else can release, roll back or change this environment. Abandoning is how it
# is given back without applying anything.
#
# This command deliberately loads none of OpenTofu, the state account, the plan
# gate or the revision proof. It never plans, never applies and never reads
# state, so requiring any of that to work would mean a session could become
# impossible to close for reasons that have nothing to do with the lease -- and
# the whole cost of an unclosable session is paid by whoever needs the
# environment next.
#
# What it does prove is correspondence: the lease ID is renewed before it is
# released, and only the container this session actually leased will accept that
# ID. A renew that succeeds is therefore proof that the recorded lease and the
# live lease are the same lease, which is the fact worth having before
# releasing one.
#
# For the same reason it reads one field rather than the seven a plan records.
# The other six describe a change this command will never make, and a session
# missing any of them -- a plan killed between writing the digest and writing
# the revision, a disk that filled -- is precisely the session that has to be
# closable: infrastructure-plan already refuses to open a second one over it,
# so a load gate here would leave the lease held with no command able to give
# it back. A session too damaged to yield even a lease ID is still cleared; it
# names nothing this command could release.
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?Set the private expected subscription ID}"
STATE_STORAGE_ACCOUNT="${STATE_STORAGE_ACCOUNT:?Set the private state account name}"
if ! printf '%s\n' "$STATE_STORAGE_ACCOUNT" | grep -Eq '^[a-z0-9]{3,24}$'; then
  printf 'The private state-storage identity is invalid.\n' >&2
  exit 1
fi
OPERATION_CONTAINER="patchpage-operations"
infra_session_locate
if ! test -e "$INFRA_SESSION_DIR"; then
  printf 'No infrastructure session is open; there is nothing to abandon.\n' >&2
  exit 1
fi
INFRA_SESSION_LEASE_USABLE=true
infra_session_load_lease || INFRA_SESSION_LEASE_USABLE=false
if ! private_az account set ||
  ! ACTIVE_SUBSCRIPTION_ID="$(private_az account show --query id --output tsv)" ||
  test "$ACTIVE_SUBSCRIPTION_ID" != "$SUBSCRIPTION_ID"; then
  printf 'The active Azure subscription does not match the private expected value.\n' >&2
  exit 1
fi
unset ACTIVE_SUBSCRIPTION_ID
OPERATION_LEASE_ACTIVE=false
OPERATION_LEASE_RETAINED=false
OPERATION_MUTATION_UNCERTAIN=false
trap 'operation_lease_exit; operation_lease_retention_exit' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# The renew is asked first and separately, because "we do not hold it" and "we
# could not give it back" are different outcomes and only one of them is a stop.
# A lease that is already gone -- a second operator recovered it, say -- leaves
# nothing to release and no reason to escalate, so the session record is cleared
# and this exits 0. A lease that is held and will not release is the retained
# case the exit-code contract covers, and it exits 75 with the session left
# intact for whoever picks it up.
# A session that recorded no usable lease ID takes the same branch, and for the
# same reason: there is no lease this command could prove or give back, so the
# record is all there is to clear.
if test "$INFRA_SESSION_LEASE_USABLE" != "true" || ! verify_operation_lease; then
  printf 'The session no longer holds the operation lease; clearing the session record only.\n'
else
  OPERATION_LEASE_ACTIVE=true
  if ! release_operation_lease; then
    OPERATION_LEASE_ACTIVE=false
    OPERATION_LEASE_RETAINED=true
    printf 'Operation lease cleanup requires second-operator review.\n' >&2
    exit 1
  fi
fi
if ! infra_session_discard; then
  exit 1
fi
trap - 0 HUP INT TERM
unset INFRA_SESSION_LEASE_USABLE
unset -f infra_session_load_lease
unset -f operation_lease_exit release_operation_lease
unset -f operation_lease_retention_exit
unset -f verify_operation_container verify_operation_lease
printf 'Infrastructure session abandoned.\n'
