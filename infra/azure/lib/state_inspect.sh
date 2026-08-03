# The OpenTofu state account's data plane: what containers exist, and is that
# exactly what the private record says should exist?
#
# Sourced by cmd/*.sh through ops.sh, which exports PP_OPS_LIB; see ops.sh.
# Requires lib/wrappers.sh.
#
# state-bootstrap and infrastructure-change both have to answer this, and the
# answer has to be the same in both, because both go on to write to the state
# account on the strength of it. It is an allow-list, not a search: the account
# is expected to hold the state container and the operation container and
# nothing else, so an unrecognised name, a duplicate, or a soft-deleted
# container is a failure rather than something to skip past. Something else is
# using this account, or something already went wrong here.
#
# --- the malformed row -------------------------------------------------------
#
# `az storage container list --query '[].[name,deleted]' --output tsv` yields one
# tab-separated row per container. A row whose name field is empty is not a
# container: it is the CLI having emitted something this loop cannot interpret.
#
# The two copies of this function looked like they disagreed about that, and
# that apparent disagreement is what this restructure was named after. The
# infrastructure-change copy rejected an empty name that still carried a
# `deleted` value; the state-bootstrap copy ran `test -z "$name" && continue`
# and skipped any empty name, which reads like a safety check that had quietly
# stopped being one.
#
# They were in fact equivalent, and it is worth writing down why, because the
# reason is not visible in either copy. The loop below reads with IFS set to a
# single tab. Tab is IFS white space, so a run of leading tabs is absorbed
# rather than delimiting an empty first field: a row spelled `<tab>false`
# parses as name=false with an empty deleted column, not as an empty name with
# deleted=false. An empty name can therefore only come from a row that is empty
# or all tabs, and in both of those the deleted column is empty too -- so the
# extra branch's `return 1` is unreachable through this data path.
#
# The strict text is what is kept, for two reasons: it is the variant that
# states the intent, and it is the one that still holds if the splitting ever
# changes -- switching to `IFS=` with explicit parsing, or moving to a query
# that emits a different column set, would make an empty name with a live
# deleted flag reachable, and this reads it as a failure rather than as nothing.
# The `malformed_container_row` scenario in the harness feeds exactly this row,
# and it is worth being precise about what it does and does not pin. With the
# strict branch in place the row is rejected either way -- through the
# unknown-name arm as it parses today, through the empty-name arm if the
# splitting ever changed -- so the shipped text's verdict does not move on a
# splitting change alone. What the scenario catches is the combination: the
# strict branch dropped *and* the row parsing the other way. That pair is the
# only way `<tab>false` gets certified as nothing to see, and it is the pair
# this file is defending against.
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
