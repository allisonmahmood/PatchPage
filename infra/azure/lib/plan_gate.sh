# The plan gate: does this OpenTofu plan destroy anything?
#
# Sourced by cmd/*.sh through ops.sh, which exports PP_OPS_LIB; see ops.sh.
#
# This is deliberately a pure filter and the only thing in lib/ that is. It
# reads a `tofu show -json` rendering on stdin, takes the protected
# resource addresses as arguments, and answers on the exit status. It reads no
# environment, opens no network connection, and calls neither az nor tofu.
#
#   plan_gate_accepts [protected-address...] < plan.json
#     exit 0  nothing is destroyed, and no protected address is being created
#     exit 1  otherwise, including unreadable or malformed input
#
# Being pure is what makes it testable: tests/fixtures/plan_gate/*.json are
# checked against it directly, one fixture per verdict, instead of the gate
# being reachable only by driving a whole deployment. It also makes it runnable
# by hand as a read-only second opinion on a plan an operator is looking at:
#
#   tofu show -json saved.tfplan | sh infra/azure/lib/plan_gate.sh \
#     azurerm_storage_account.drafts azurerm_postgresql_flexible_server.patchpage
#
# --- what counts as destruction ----------------------------------------------
#
# Any `delete` in a resource's action list. That covers a plain destroy and it
# covers a replacement, because OpenTofu renders a replacement as delete plus
# create -- in either order, depending on whether the resource is
# create-before-destroy. Matching on the word rather than on a specific action
# tuple is why `plan_replacement` and `plan_delete` are the same verdict here.
#
# --- why creating a protected resource is also destruction --------------------
#
# The four protected addresses are the ones holding data that cannot be
# regenerated: the drafts Storage account and container, and the PostgreSQL
# server and database. OpenTofu planning to *create* one of those against an
# environment that already exists does not mean "make a new thing"; it means
# OpenTofu cannot see the existing one -- the state was lost, truncated, or
# points somewhere else -- and applying would either fail on the management lock
# or, worse, succeed against an empty replacement. Either way the operator's
# next move is to fix the state, not to apply.
#
# The caller supplies the list because the answer differs by flow, and that
# difference is real rather than drift: the initial deployment is the one run
# that is *supposed* to create them, so it passes no protected addresses. Every
# later infrastructure change passes all four. Making the list an argument keeps
# that decision at the call site, where the reason for it is visible.
plan_gate_accepts() {
  jq -e --arg protected "$*" '
    ($protected | split(" ") | map(select(length > 0))) as $protected_addresses |
    [.resource_changes[] |
     . as $resource |
     select(
       ($resource.change.actions | index("delete")) or
       (
         ($protected_addresses | index($resource.address)) and
         ($resource.change.actions | index("create"))
       )
     )] |
    length == 0' >/dev/null 2>&1 || return 1
}

# Standalone use. When ops.sh dispatches a command, $0 is that command's path,
# so sourcing this file never trips the guard.
case "$0" in
  */plan_gate.sh | plan_gate.sh)
    plan_gate_accepts "$@"
    ;;
esac
