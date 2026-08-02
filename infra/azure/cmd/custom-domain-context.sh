set -u
set +x
private_terraform() {
  terraform "$@" 2>/dev/null
}
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
if ! SUBSCRIPTION_ID="$(private_terraform output -raw subscription_id)" ||
  ! RESOURCE_GROUP="$(private_terraform output -raw resource_group_name)" ||
  ! CONTAINER_APP="$(private_terraform output -raw container_app_name)" ||
  ! CONTAINER_APP_ENVIRONMENT="$(private_terraform output -raw container_app_environment_name)" ||
  ! CONTAINER_APP_FQDN="$(private_terraform output -raw container_app_fqdn)" ||
  ! CONTAINER_APP_STATIC_IP="$(private_terraform output -raw container_app_environment_static_ip)" ||
  ! DOMAIN_VERIFICATION_ID="$(private_terraform output -raw custom_domain_verification_id)" ||
  ! PUBLIC_BASE_URL="$(private_terraform output -raw public_base_url)" ||
  ! CUSTOM_DOMAIN="$(private_terraform output -raw custom_domain_hostname)"; then
  printf 'Could not load the required Terraform outputs.\n' >&2
  exit 1
fi

for REQUIRED_OUTPUT in \
  "$SUBSCRIPTION_ID" \
  "$RESOURCE_GROUP" \
  "$CONTAINER_APP" \
  "$CONTAINER_APP_ENVIRONMENT" \
  "$CONTAINER_APP_FQDN" \
  "$CONTAINER_APP_STATIC_IP" \
  "$DOMAIN_VERIFICATION_ID" \
  "$PUBLIC_BASE_URL" \
  "$CUSTOM_DOMAIN"; do
  if test -z "$REQUIRED_OUTPUT"; then
    printf 'Terraform returned an empty required deployment output.\n' >&2
    exit 1
  fi
done
unset REQUIRED_OUTPUT

CUSTOM_DOMAIN="$(
  printf '%s\n' "$CUSTOM_DOMAIN" |
    sed 's/\.$//' |
    tr '[:upper:]' '[:lower:]'
)"
CONTAINER_APP_FQDN="$(
  printf '%s\n' "$CONTAINER_APP_FQDN" |
    sed 's/\.$//' |
    tr '[:upper:]' '[:lower:]'
)"
NORMALIZED_PUBLIC_BASE_URL="$(printf '%s\n' "$PUBLIC_BASE_URL" | tr '[:upper:]' '[:lower:]')"

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
if test "$NORMALIZED_PUBLIC_BASE_URL" != "https://$CUSTOM_DOMAIN"; then
  printf 'The public origin does not match the normalized custom hostname.\n' >&2
  exit 1
fi

printf 'Azure deployment context verified privately.\n'
