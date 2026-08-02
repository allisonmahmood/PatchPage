#!/bin/sh
# PatchPage Azure operations CLI.
#
# ops.sh is a dispatcher and nothing else. Every subcommand is a script under
# infra/azure/cmd/ whose body is the operator runbook that infra/azure/README.md
# used to carry inline. Each cmd/*.sh is exactly one `set -u` line followed by
# that verbatim body, so the guide and the executable stay the same text and a
# line number in a shell diagnostic still points at the documented step.
#
# ops.sh never inspects, rewrites, retries or wraps a command. It validates the
# name and hands the process over with exec, so the operator sees exactly the
# runbook's own output and exit status.

set -u

case "$0" in
  */*) ops_dir="${0%/*}" ;;
  *) ops_dir="." ;;
esac
ops_dir="$(CDPATH= cd -- "$ops_dir" && pwd)" || exit 1
ops_cmd_dir="$ops_dir/cmd"

# One line per command: <name>|<one-line purpose>. This list is the whole
# command surface; a name that is not here is not dispatchable.
ops_each_command() {
  while IFS='|' read -r ops_name ops_purpose; do
    test -n "$ops_name" || continue
    "$1" "$ops_name" "$ops_purpose"
  done <<'OPS_COMMANDS'
state-bootstrap|Create and verify the Terraform state account, containers, operation RBAC and locks.
deploy-resources|Plan and apply the first workload deployment, then seal the operation binding and locks.
app-release|Build, push and roll a new immutable server image forward under the operation lease.
app-rollback|Return the Container App to the recorded pre-release image under the operation lease.
infrastructure-change|Adopt, plan and apply a reviewed no-delete infrastructure change.
stale-lease-recovery|Second-operator break, reacquire and release of an abandoned operation lease.
custom-domain-context|Verify the custom-domain deployment context. SOURCE cmd/custom-domain-context.sh to keep its values.
ingress-verification|Prove the Container App ingress is external, HTTPS-only and on the expected port.
apex-dns|Prove the apex A/AAAA and asuid records match the verified Container App.
caa-policy|Prove the CNAME target and CAA policy permit the managed certificate issuer.
hostname-mutation|Add the custom hostname and bind a managed certificate. SOURCE cmd/hostname-mutation.sh to keep MANAGED_CERTIFICATE_ID.
certificate-binding|Bind the managed certificate to the custom hostname with SNI.
deployed-smoke|Prove the deployed origin serves health, upload and fetch end to end.
OPS_COMMANDS
}

ops_print_command() {
  printf '  %-21s %s\n' "$1" "$2"
}

ops_match_command() {
  test "$1" != "$ops_wanted" || ops_found=1
}

ops_usage() {
  printf 'usage: sh infra/azure/ops.sh <command>\n'
  printf '       sh infra/azure/ops.sh --help\n'
  printf '\n'
  printf 'Runs one PatchPage Azure operator runbook. Export the command'\''s documented\n'
  printf 'input variables first; infra/azure/README.md states them per command.\n'
  printf '\n'
  printf 'Two commands hand values forward to the commands after them. A child\n'
  printf 'process cannot do that, so the guide has the operator source those two\n'
  printf 'straight from cmd/ instead; they are dispatchable here as standalone\n'
  printf 'verifications, which discard the values.\n'
  printf '\n'
  printf 'Commands:\n'
  ops_each_command ops_print_command
  printf '\n'
  printf 'Exit codes:\n'
  printf '  0   Success. The operation completed and released anything it held.\n'
  printf '  1   Failed, and safe to retry after fixing the reported problem. No\n'
  printf '      operation lease is still held: it was never acquired, or it was\n'
  printf '      released cleanly on the way out.\n'
  printf '  75  The operation lease is DELIBERATELY RETAINED. STOP. Do not retry,\n'
  printf '      do not rerun any flow, and do not break the lease. A mutation may\n'
  printf '      still be in flight, so a second authorized operator must first\n'
  printf '      prove the original process is gone and then run stale-lease-recovery.\n'
  printf '      75 is EX_TEMPFAIL, chosen so an automated caller that treats\n'
  printf '      nonzero-as-retryable is forced to special-case this one code.\n'
}

if test "$#" -eq 0; then
  ops_usage >&2
  exit 1
fi

case "$1" in
  -h | --help | help)
    ops_usage
    exit 0
    ;;
esac

ops_wanted="$1"
shift
ops_found=0
ops_each_command ops_match_command
if test "$ops_found" -ne 1; then
  printf 'ops.sh: unknown command: %s\n' "$ops_wanted" >&2
  ops_usage >&2
  exit 1
fi
if test "$#" -ne 0; then
  printf 'ops.sh: %s takes no arguments\n' "$ops_wanted" >&2
  exit 1
fi
test -f "$ops_cmd_dir/$ops_wanted.sh" || {
  printf 'ops.sh: missing command script for %s\n' "$ops_wanted" >&2
  exit 1
}

exec sh "$ops_cmd_dir/$ops_wanted.sh"
