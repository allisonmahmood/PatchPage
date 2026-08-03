# Tool wrappers shared by the dispatched runbooks.
#
# Sourced by cmd/*.sh through ops.sh, which exports PP_OPS_LIB; see ops.sh.
#
# Every external tool the runbooks call is reached through one of these, and
# each one does the same two things: it names the tool without a path, so the
# test harness's PATH shims can stand in for it, and it closes the tool's
# stderr, so a diagnostic that would otherwise carry a subscription ID, a
# resource ID or a token fragment never reaches the operator's terminal or their
# scrollback. The runbooks report failures themselves, in their own words, from
# the exit status.
#
# A private_terraform() wrapper is deliberately absent. Two of its callers route
# Terraform's stderr to a private diagnostic file on fd 3 rather than discarding
# it, and that wrapper lives in lib/diag.sh with the rest of that plumbing. The two
# commands that merely discard it keep their own one-line copy: sharing a
# definition between exactly two callers, one of which is a sourced command that
# cannot reach lib/ at all, would buy nothing.

private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
private_git() {
  git "$@" 2>/dev/null
}
private_curl() {
  curl "$@" 2>/dev/null
}
private_dig() {
  dig "$@" 2>/dev/null
}
