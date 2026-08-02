set -u
set +x
. "${PP_OPS_LIB:?run this through the dispatcher: sh infra/azure/ops.sh certificate-binding}/wrappers.sh"
MANAGED_CERTIFICATE_ID="${MANAGED_CERTIFICATE_ID:?Run the hostname binding block first}"

if ! MANAGED_CERTIFICATES="$(
  private_az containerapp env certificate list \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_APP_ENVIRONMENT" \
    --managed-certificates-only \
    --certificate "$MANAGED_CERTIFICATE_ID" \
    --query '[].[id,properties.subjectName,properties.provisioningState]' \
    --output tsv
)"; then
  printf 'Could not read the expected bound managed certificate.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$MANAGED_CERTIFICATES" |
  awk -F '\t' \
    -v expected_domain="$CUSTOM_DOMAIN" \
    -v expected_id="$MANAGED_CERTIFICATE_ID" '
    {
      rows++
      id = $1
      subject = tolower($2)
      sub(/^cn=/, "", subject)
      sub(/\.$/, "", subject)
      if (id == expected_id && subject == expected_domain &&
          tolower($3) == "succeeded") exact_matches++
    }
    END { exit rows == 1 && exact_matches == 1 ? 0 : 1 }
  '; then
  printf 'The bound managed certificate does not match the expected private values.\n' >&2
  exit 1
fi

if ! HOSTNAME_BINDINGS="$(
  private_az containerapp hostname list \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_APP" \
    --query '[].[name,bindingType,certificateId]' \
    --output tsv
)"; then
  printf 'Could not list Container App hostname bindings.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$HOSTNAME_BINDINGS" |
  awk -F '\t' \
    -v expected_domain="$CUSTOM_DOMAIN" \
    -v expected_id="$MANAGED_CERTIFICATE_ID" '
    {
      hostname = tolower($1)
      sub(/\.$/, "", hostname)
      if (hostname == expected_domain) {
        hostname_rows++
        if (tolower($2) == "snienabled" && $3 == expected_id) exact_matches++
      }
    }
    END { exit hostname_rows == 1 && exact_matches == 1 ? 0 : 1 }
  '; then
  printf 'The expected SNI hostname binding is not present.\n' >&2
  exit 1
fi
