# Private Terraform diagnostics on fd 3.
#
# Sourced by cmd/*.sh through ops.sh, which exports PP_OPS_LIB; see ops.sh.
#
# Terraform's stderr is the most useful output either Terraform runbook produces
# and the least safe to show: it quotes resource IDs, backend configuration and
# occasionally attribute values. The two commands that run Terraform against
# real state therefore open fd 3 onto a file inside a private diagnostic
# directory and route Terraform's stderr there, so the detail survives for an
# operator who goes looking for it and never lands in a terminal, a CI log or a
# scrollback buffer.
#
# The trap side is the reason this is shared rather than copied. It has to hold
# two things at once: close fd 3 exactly once even if the handler runs twice,
# and delete the diagnostics only when the run is known to have succeeded. The
# retention message on the else branch is not an error -- it is the runbook
# telling the operator where to look, and it fires on every failing exit,
# including the ones that also keep the operation lease.
#
# The two commands that only discard Terraform's stderr keep their own one-line
# private_terraform, for the reason given in lib/wrappers.sh.

private_terraform() {
  terraform "$@" 2>&3
}

# Requires TERRAFORM_DIAGNOSTIC_FD_OPEN, TERRAFORM_DIAGNOSTICS_COMPLETE and
# TERRAFORM_DIAGNOSTIC_DIR, all set by the command before it installs the trap.
terraform_diagnostic_exit() {
  if test "$TERRAFORM_DIAGNOSTIC_FD_OPEN" = "true"; then
    { exec 3>&-; } 2>/dev/null || :
    TERRAFORM_DIAGNOSTIC_FD_OPEN=false
  fi
  if test "$TERRAFORM_DIAGNOSTICS_COMPLETE" = "true"; then
    if ! rm -rf -- "$TERRAFORM_DIAGNOSTIC_DIR" 2>/dev/null; then
      printf 'Terraform succeeded, but private diagnostic cleanup failed.\n' >&2
    fi
  else
    printf 'Private Terraform diagnostics were retained under the configured diagnostic root.\n' >&2
  fi
}
