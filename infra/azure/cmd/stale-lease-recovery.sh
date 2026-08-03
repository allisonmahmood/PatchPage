set -u
set +x
# Second-operator recovery authenticates as that operator's own principal: the
# whole point of this command is that a *different* named human is now acting.
OPERATION_LEASE_AUTH_MODE=login
. "${PP_OPS_LIB:?run this through the dispatcher: sh infra/azure/ops.sh stale-lease-recovery}/wrappers.sh"
. "$PP_OPS_LIB/lease.sh"
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
if ! OPERATION_BINDING_SHA256="$(operation_binding_sha256)"; then
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
# --- single-flight break and reacquire ---------------------------------------
#
# Breaking a lease and taking it back are two calls, and everything a recoverer
# does between them is time in which a *second* recoverer can break the lease
# this one is about to acquire. That window used to contain the lease-ID
# generation below -- an od, a grep and a sed, three process spawns -- so two
# operators who started recovery together could both break a live lease and both
# report success, which is exactly the mutual exclusion this container exists to
# provide being handed to two people at once.
#
# The identity is therefore minted first, and the acquire follows the break with
# nothing between them but a shell assignment: no subprocess, no network call,
# nothing that can fail or block. The acquire is then the arbiter. Whichever
# recoverer reaches it while the other holds the container is refused by Azure,
# and a refused recoverer gives up rather than recovering: it releases its own
# lease ID -- see the trap below for why that is safe to send blind -- and
# exits 1 without touching the container's binding.
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
# RECOVERY_LEASE_ACTIVE starts false and is raised in the one statement before
# the acquire, so a failed break -- which cannot have granted anything -- leaves
# the trap with nothing to give back. From the acquire onwards it stays
# optimistic on purpose: an acquire whose result is unknown may still have been
# granted, so the exit trap offers the lease back.
#
# RECOVERY_LEASE_ACQUIRED is the narrower fact -- Azure confirmed the acquire --
# and only that fact turns a failed release into the exit-75 stop. Without it an
# acquire that was refused outright would report a lease this recovery never
# held.
#
# The losing side of the race still sends its release, and that is deliberate.
# A refused acquire has two indistinguishable causes: the winner got there
# first, or Azure granted this acquire and the answer was lost in transit. Only
# the second leaves an infinite lease held by this process, and only a release
# clears it -- so the release is sent either way.
#
# It is safe to send blind because an Azure container-lease release names the
# lease ID it is releasing and Azure matches it exactly. The loser holds
# RECOVERY_LEASE_ID, which it minted from the system random device above and
# which no other process has ever seen. If the winner holds the container, the
# loser's release names an ID that is not the live lease and Azure answers 409
# LeaseIdMismatchWithLeaseOperation: nothing is released, the winner is
# untouched, and the loser exits 1 having changed nothing. If instead the grant
# did land and was lost, the ID matches, the leak is cleaned, and the container
# is left free for the next recovery. There is no third outcome, so refusing to
# send the release only ever preserved the leak.
#
# The exit code is unchanged: RECOVERY_LEASE_ACQUIRED, not the release result,
# is what turns a failed release into the exit-75 stop, so a loser whose blind
# release is rejected still exits 1 -- nothing was confirmed taken, and retrying
# after the winner finishes is safe.
#
# The reverse interleaving is a known and accepted case. A acquires; B breaks
# and acquires; A's renew then fails because A no longer holds anything. A's
# trap sends its release, Azure rejects it -- A's ID is not B's -- and because
# A's acquire had been confirmed, A exits 75 with the retention message while
# in fact holding nothing. The exactly-one-winner property still holds: B holds
# the lease and B alone reports success. The message is conservative in the safe
# direction -- it sends an operator to look at a container that is genuinely
# leased, just not by A -- and the remedy it names is this same command.
RECOVERY_LEASE_ACTIVE=false
RECOVERY_LEASE_ACQUIRED=false
release_recovery_lease() {
  if test "${RECOVERY_LEASE_ACTIVE:-false}" = "true"; then
    if private_az storage container lease release \
      --account-name "$STATE_STORAGE_ACCOUNT" \
      --container-name "$OPERATION_CONTAINER" \
      --auth-mode login \
      --lease-id "$RECOVERY_LEASE_ID" \
      --output none >/dev/null; then
      RECOVERY_LEASE_ACTIVE=false
    elif test "${RECOVERY_LEASE_ACQUIRED:-false}" = "true"; then
      printf 'The operation lease remains held for second-operator recovery.\n' >&2
      exit 75
    fi
  fi
}
trap 'release_recovery_lease' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ! private_az storage container lease break \
  --account-name "$STATE_STORAGE_ACCOUNT" \
  --container-name "$OPERATION_CONTAINER" \
  --auth-mode login \
  --lease-break-period 0 \
  --output none >/dev/null; then
  printf 'Operation lease recovery failed closed.\n' >&2
  exit 1
fi
RECOVERY_LEASE_ACTIVE=true
if ! private_az storage container lease acquire \
  --account-name "$STATE_STORAGE_ACCOUNT" \
  --container-name "$OPERATION_CONTAINER" \
  --auth-mode login \
  --lease-duration -1 \
  --proposed-lease-id "$RECOVERY_LEASE_ID" \
  --output none >/dev/null; then
  printf 'Operation lease recovery failed closed.\n' >&2
  exit 1
fi
RECOVERY_LEASE_ACQUIRED=true
if ! private_az storage container lease renew \
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
