# The guide has the operator source this file, because MANAGED_CERTIFICATE_ID
# has to survive into the shell the certificate binding runs in and a child
# process cannot hand a variable back. That makes the caller's shell options
# part of what this file borrows and must return: leaving `set -u` on turns the
# operator's next unset variable into a dead session. `set +x` is deliberately
# not restored -- keeping tracing off is the point of setting it.
case $- in
  *u*) hostname_mutation_saved_nounset=on ;;
  *) hostname_mutation_saved_nounset=off ;;
esac
set -u
set +x
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
VALIDATION_METHOD="${VALIDATION_METHOD:?Run the matching DNS section first}"
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?Load the OpenTofu outputs first}"

if ! private_az account set; then
  printf 'Could not select the expected Azure subscription.\n' >&2
  exit 1
fi
if ! ACTIVE_SUBSCRIPTION_ID="$(private_az account show --query id --output tsv)"; then
  printf 'Could not verify the active Azure subscription.\n' >&2
  exit 1
fi
if test "$ACTIVE_SUBSCRIPTION_ID" != "$SUBSCRIPTION_ID"; then
  printf 'The active Azure subscription does not match the private expected value.\n' >&2
  exit 1
fi

if ! private_az containerapp hostname add \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --hostname "$CUSTOM_DOMAIN" >/dev/null; then
  printf 'Could not add the expected custom hostname to the Container App.\n' >&2
  exit 1
fi

if ! MANAGED_CERTIFICATE_ID="$(
  private_az containerapp hostname bind \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --hostname "$CUSTOM_DOMAIN" \
  --environment "$CONTAINER_APP_ENVIRONMENT" \
  --validation-method "$VALIDATION_METHOD" \
  --query "[?name=='$CUSTOM_DOMAIN'].certificateId | [0]" \
  --output tsv
)"; then
  printf 'Could not create and bind the expected managed certificate.\n' >&2
  exit 1
fi
if test -z "$MANAGED_CERTIFICATE_ID"; then
  printf 'Azure did not return the bound managed-certificate resource ID.\n' >&2
  exit 1
fi
if test "$hostname_mutation_saved_nounset" = "off"; then
  set +u
fi
unset hostname_mutation_saved_nounset
