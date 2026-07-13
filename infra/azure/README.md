# PatchPage Azure self-hosting

This directory is a reusable Azure Container Apps deployment example. It requires an HTTPS public origin on a DNS hostname the deployer owns; it has no default or fallback to the PatchPage maintainer's hosted service.

Terraform creates:

- the resource group, Log Analytics workspace, Container Apps environment, and Container App;
- external platform ingress with insecure HTTP disabled;
- the Azure Container Registry and the app's managed identity and role assignments;
- the Blob Storage account and private container, plus the PostgreSQL server/database; and
- generated application secrets and the Container App environment variables, including `PATCHPAGE_PUBLIC_BASE_URL`.

Terraform does **not** create or manage the remote-state resources, container image build, DNS zone or records, Container App custom hostname, managed certificate, or certificate binding. Those steps are deliberately manual and provider-neutral below. Terraform creates the initial Container App ingress and then ignores later changes to the whole ingress block so an apply cannot overwrite the CLI-managed hostname and certificate binding. Any intentional ingress change therefore remains HITL: update the lifecycle rule and restore the manual binding as one coordinated operation.

## Prerequisites

- Terraform 1.9 or newer.
- Azure CLI, authenticated to the deployer's own Azure account with `az login`.
- Git for the image tag.
- `dig`, `curl`, and `jq` for the verification commands.
- Control of a public DNS hostname. A subdomain with a direct CNAME is recommended.

Do not run this example against a maintainer subscription. Check the available account before creating anything, then set `SUBSCRIPTION_ID` to the exact target subscription. Each mutation section selects and verifies that value before changing Azure resources.

```sh
az account show --query '{subscription:id,tenant:tenantId,user:user.name}' --output table
```

## State bootstrap

Create remote Terraform state once. Set `STATE_STORAGE_ACCOUNT` to a globally unique name containing 3-24 lowercase letters and digits before running the block. Do not commit the generated backend config. The bootstrap deliberately uses storage-account-key authorization because an Azure account with management-plane access does not automatically have Blob data-plane OAuth access. Azure CLI retrieves the key without writing it to the backend config; do not enable shell tracing or CLI debug output for this block.

<!-- guide-test:state-bootstrap -->

```sh
AZURE_DIR="$(git rev-parse --show-toplevel)/infra/azure"
cd "$AZURE_DIR"

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the target Azure subscription ID}"
if ! az account set --subscription "$SUBSCRIPTION_ID"; then
  printf 'Could not select Azure subscription %s.\n' "$SUBSCRIPTION_ID" >&2
  exit 1
fi
if ! ACTIVE_SUBSCRIPTION_ID="$(az account show --query id --output tsv)"; then
  printf 'Could not verify the active Azure subscription.\n' >&2
  exit 1
fi
if test "$ACTIVE_SUBSCRIPTION_ID" != "$SUBSCRIPTION_ID"; then
  printf 'Expected subscription %s, but Azure CLI selected %s.\n' \
    "$SUBSCRIPTION_ID" "$ACTIVE_SUBSCRIPTION_ID" >&2
  exit 1
fi

STATE_RESOURCE_GROUP="rg-patchpage-tfstate"
STATE_LOCATION="centralus"
STATE_STORAGE_ACCOUNT="${STATE_STORAGE_ACCOUNT:?Set STATE_STORAGE_ACCOUNT to a globally unique lowercase name}"
STATE_CONTAINER="tfstate"

if ! printf '%s' "$STATE_STORAGE_ACCOUNT" | grep -Eq '^[a-z0-9]{3,24}$'; then
  printf 'STATE_STORAGE_ACCOUNT must contain 3-24 lowercase letters and digits.\n' >&2
  exit 1
fi

az group create \
  --name "$STATE_RESOURCE_GROUP" \
  --location "$STATE_LOCATION"
az storage account create \
  --name "$STATE_STORAGE_ACCOUNT" \
  --resource-group "$STATE_RESOURCE_GROUP" \
  --location "$STATE_LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --allow-blob-public-access false
if ! az storage container create \
  --name "$STATE_CONTAINER" \
  --account-name "$STATE_STORAGE_ACCOUNT" \
  --auth-mode key; then
  printf 'Could not create Terraform state container %s.\n' "$STATE_CONTAINER" >&2
  exit 1
fi
if ! STATE_CONTAINER_EXISTS="$(
  az storage container exists \
    --name "$STATE_CONTAINER" \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --auth-mode key \
    --query exists \
    --output tsv
)"; then
  printf 'Could not verify Terraform state container %s.\n' "$STATE_CONTAINER" >&2
  exit 1
fi
if test "$STATE_CONTAINER_EXISTS" != "true"; then
  printf 'Terraform state container %s does not exist.\n' "$STATE_CONTAINER" >&2
  exit 1
fi

cat > backend.hcl <<EOF
resource_group_name  = "$STATE_RESOURCE_GROUP"
storage_account_name = "$STATE_STORAGE_ACCOUNT"
container_name       = "$STATE_CONTAINER"
key                  = "patchpage-prod.tfstate"
EOF
```

## Deploy the Azure resources

Copy the example and edit both required values before the first Terraform command:

```sh
AZURE_DIR="$(git rev-parse --show-toplevel)/infra/azure"
cd "$AZURE_DIR"
cp terraform.tfvars.example terraform.tfvars
```

- Set `subscription_id` to the target subscription ID and export the same value as `SUBSCRIPTION_ID` in the shell.
- Replace the deliberately invalid `public_base_url` with the deployer's real origin. It must be HTTPS with a public DNS hostname and no credentials, port, path, query, fragment, or trailing slash.

Terraform rejects the maintainer's domains, localhost/private-style names, reserved example names, and common placeholder values. The first targeted apply still requires a valid deployer-owned origin even though it only creates the registry.

```sh
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the subscription_id in terraform.tfvars}"
if ! az account set --subscription "$SUBSCRIPTION_ID"; then
  printf 'Could not select Azure subscription %s.\n' "$SUBSCRIPTION_ID" >&2
  exit 1
fi
if ! ACTIVE_SUBSCRIPTION_ID="$(az account show --query id --output tsv)"; then
  printf 'Could not verify the active Azure subscription.\n' >&2
  exit 1
fi
if test "$ACTIVE_SUBSCRIPTION_ID" != "$SUBSCRIPTION_ID"; then
  printf 'Expected subscription %s, but Azure CLI selected %s.\n' \
    "$SUBSCRIPTION_ID" "$ACTIVE_SUBSCRIPTION_ID" >&2
  exit 1
fi

terraform init -backend-config=backend.hcl
terraform apply -target=azurerm_container_registry.patchpage

TAG="$(git -C ../.. rev-parse --short HEAD)"
ACR="$(terraform output -raw acr_name)"
LOGIN_SERVER="$(terraform output -raw acr_login_server)"

az acr build \
  --registry "$ACR" \
  --image "patchpage-server:$TAG" \
  --file apps/server/Dockerfile \
  ../..

cat > server-image.auto.tfvars <<EOF
server_image = "$LOGIN_SERVER/patchpage-server:$TAG"
EOF

terraform apply
```

At this point Azure's generated Container App hostname is live over HTTPS, but the deployer-owned hostname and certificate are not configured yet.

## Configure the custom domain and managed certificate

The commands below follow [Microsoft's managed-certificate flow](https://learn.microsoft.com/azure/container-apps/custom-domains-managed-certificates). They read Azure resource names and DNS values from Terraform so there are no copied resource-name placeholders.

Load the outputs and make sure the Azure CLI is using the same subscription:

<!-- guide-test:custom-domain-context -->

```sh
SUBSCRIPTION_ID="$(terraform output -raw subscription_id)"
RESOURCE_GROUP="$(terraform output -raw resource_group_name)"
CONTAINER_APP="$(terraform output -raw container_app_name)"
CONTAINER_APP_ENVIRONMENT="$(terraform output -raw container_app_environment_name)"
CONTAINER_APP_FQDN="$(terraform output -raw container_app_fqdn)"
CONTAINER_APP_STATIC_IP="$(terraform output -raw container_app_environment_static_ip)"
DOMAIN_VERIFICATION_ID="$(terraform output -raw custom_domain_verification_id)"
PUBLIC_BASE_URL="$(terraform output -raw public_base_url)"
CUSTOM_DOMAIN="$(terraform output -raw custom_domain_hostname)"

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

if ! az account set --subscription "$SUBSCRIPTION_ID"; then
  printf 'Could not select Azure subscription %s.\n' "$SUBSCRIPTION_ID" >&2
  exit 1
fi
if ! ACTIVE_SUBSCRIPTION_ID="$(az account show --query id --output tsv)"; then
  printf 'Could not verify the active Azure subscription.\n' >&2
  exit 1
fi
if test "$ACTIVE_SUBSCRIPTION_ID" != "$SUBSCRIPTION_ID"; then
  printf 'Expected subscription %s, but Azure CLI selected %s.\n' \
    "$SUBSCRIPTION_ID" "$ACTIVE_SUBSCRIPTION_ID" >&2
  exit 1
fi
if test "$NORMALIZED_PUBLIC_BASE_URL" != "https://$CUSTOM_DOMAIN"; then
  printf 'The public origin does not match the normalized custom hostname.\n' >&2
  exit 1
fi

printf 'Custom hostname: %s\nCNAME target: %s\nA target: %s\nTXT verification value: %s\n' \
  "$CUSTOM_DOMAIN" \
  "$CONTAINER_APP_FQDN" \
  "$CONTAINER_APP_STATIC_IP" \
  "$DOMAIN_VERIFICATION_ID"
```

### 1. Create and verify DNS records

Use the DNS provider that is authoritative for the deployer's domain. Do not proxy the record while Azure issues or renews the managed certificate.

For a subdomain, create these records:

| Type | Host | Value |
| --- | --- | --- |
| CNAME | the relative subdomain label | `$CONTAINER_APP_FQDN` |
| TXT | `asuid.` plus the relative subdomain label | `$DOMAIN_VERIFICATION_ID` |

The CNAME must point directly to the generated Container App FQDN, without an intermediate CNAME or proxy. Set the real zone and relative label in the shell, then verify public DNS propagation:

```sh
DNS_ZONE="${DNS_ZONE:?Set DNS_ZONE to the DNS zone you control}"
DNS_SUBDOMAIN="${DNS_SUBDOMAIN:?Set DNS_SUBDOMAIN to the relative hostname label}"
DNS_ZONE="$(printf '%s\n' "$DNS_ZONE" | sed 's/\.$//' | tr '[:upper:]' '[:lower:]')"
DNS_SUBDOMAIN="$(printf '%s\n' "$DNS_SUBDOMAIN" | sed 's/^\.*//;s/\.*$//' | tr '[:upper:]' '[:lower:]')"

if test "$CUSTOM_DOMAIN" != "$DNS_SUBDOMAIN.$DNS_ZONE"; then
  printf 'DNS_ZONE and DNS_SUBDOMAIN do not compose the configured hostname.\n' >&2
  exit 1
fi

ACTUAL_CNAME="$(
  dig +short CNAME "$CUSTOM_DOMAIN" |
    sed -n '1{s/\.$//;p;}' |
    tr '[:upper:]' '[:lower:]'
)"
if test "$ACTUAL_CNAME" != "$CONTAINER_APP_FQDN"; then
  printf 'CNAME has not propagated to %s.\n' "$CONTAINER_APP_FQDN" >&2
  exit 1
fi

ACTUAL_VERIFICATION_ID="$(dig +short TXT "asuid.$CUSTOM_DOMAIN" | tr -d '"')"
if ! printf '%s\n' "$ACTUAL_VERIFICATION_ID" | grep -Fqx -- "$DOMAIN_VERIFICATION_ID"; then
  printf 'The asuid TXT record has not propagated with the expected value.\n' >&2
  exit 1
fi

VALIDATION_METHOD="CNAME"
```

For an apex domain instead, create these records:

| Type | Host | Value |
| --- | --- | --- |
| A | `@` | `$CONTAINER_APP_STATIC_IP` |
| TXT | `asuid` | `$DOMAIN_VERIFICATION_ID` |

Set the real apex zone in the shell and verify propagation:

<!-- guide-test:apex-dns -->

```sh
DNS_ZONE="${DNS_ZONE:?Set DNS_ZONE to the apex DNS zone you control}"
DNS_ZONE="$(printf '%s\n' "$DNS_ZONE" | sed 's/\.$//' | tr '[:upper:]' '[:lower:]')"

if test "$CUSTOM_DOMAIN" != "$DNS_ZONE"; then
  printf 'DNS_ZONE is not the configured apex hostname.\n' >&2
  exit 1
fi

if ! ACTUAL_A_RECORDS="$(dig +short A "$CUSTOM_DOMAIN")"; then
  printf 'The apex A lookup failed.\n' >&2
  exit 1
fi
ACTUAL_A_RECORDS="$(
  printf '%s\n' "$ACTUAL_A_RECORDS" |
    sed '/^$/d' |
    LC_ALL=C sort -u
)"
if test "$ACTUAL_A_RECORDS" != "$CONTAINER_APP_STATIC_IP"; then
  printf 'The apex A RRset must contain only %s; received:\n%s\n' \
    "$CONTAINER_APP_STATIC_IP" "$ACTUAL_A_RECORDS" >&2
  exit 1
fi

if ! AAAA_RESPONSE="$(
  dig +noall +comments +answer AAAA "$CUSTOM_DOMAIN"
)"; then
  printf 'The apex AAAA lookup failed.\n' >&2
  exit 1
fi

AAAA_STATUS="$(
  printf '%s\n' "$AAAA_RESPONSE" |
    awk '
      /^;; ->>HEADER<<-/ {
        for (i = 1; i <= NF; i++) {
          if ($i == "status:") {
            status = $(i + 1)
            sub(/,$/, "", status)
            print status
            exit
          }
        }
      }
    '
)"
if test "$AAAA_STATUS" != "NOERROR"; then
  printf 'The apex AAAA lookup returned DNS status %s.\n' \
    "${AAAA_STATUS:-unknown}" >&2
  exit 1
fi

ACTUAL_AAAA_RECORDS="$(
  printf '%s\n' "$AAAA_RESPONSE" |
    awk '$1 !~ /^;/ && toupper($4) == "AAAA" { print }'
)"
if test -n "$ACTUAL_AAAA_RECORDS"; then
  printf 'The apex must not publish an AAAA record; received:\n%s\n' \
    "$ACTUAL_AAAA_RECORDS" >&2
  exit 1
fi

ACTUAL_VERIFICATION_ID="$(dig +short TXT "asuid.$CUSTOM_DOMAIN" | tr -d '"')"
if ! printf '%s\n' "$ACTUAL_VERIFICATION_ID" | grep -Fqx -- "$DOMAIN_VERIFICATION_ID"; then
  printf 'The asuid TXT record has not propagated with the expected value.\n' >&2
  exit 1
fi

VALIDATION_METHOD="HTTP"
```

Certificate authorities apply the first CAA RRset found while walking from the custom hostname toward the DNS root. The check continues to a parent only when the current label returns `NOERROR` without a CAA answer; any other DNS status is a hard failure. That effective policy, wherever it is inherited from, must allow DigiCert with an unparameterized `issue "digicert.com"` record. Parameterized DigiCert records fail this check because the guide cannot prove that Azure satisfies issuer-specific constraints:

<!-- guide-test:caa-policy -->

```sh
CAA_LOOKUP_NAME="$CUSTOM_DOMAIN"
CAA_RECORDS=""

while test -n "$CAA_LOOKUP_NAME"; do
  if ! CAA_RESPONSE="$(
    dig +noall +comments +answer CAA "$CAA_LOOKUP_NAME"
  )"; then
    printf 'CAA lookup failed for %s.\n' "$CAA_LOOKUP_NAME" >&2
    exit 1
  fi

  CAA_STATUS="$(
    printf '%s\n' "$CAA_RESPONSE" |
      awk '
        /^;; ->>HEADER<<-/ {
          for (i = 1; i <= NF; i++) {
            if ($i == "status:") {
              status = $(i + 1)
              sub(/,$/, "", status)
              print status
              exit
            }
          }
        }
      '
  )"
  if test "$CAA_STATUS" != "NOERROR"; then
    printf 'CAA lookup for %s returned DNS status %s.\n' \
      "$CAA_LOOKUP_NAME" "${CAA_STATUS:-unknown}" >&2
    exit 1
  fi

  CAA_RECORDS="$(
    printf '%s\n' "$CAA_RESPONSE" |
      awk '
        $1 !~ /^;/ && toupper($4) == "CAA" {
          for (i = 5; i <= NF; i++) {
            printf "%s%s", (i == 5 ? "" : " "), $i
          }
          print ""
        }
      '
  )"
  test -z "$CAA_RECORDS" || break

  case "$CAA_LOOKUP_NAME" in
    *.*) CAA_LOOKUP_NAME="${CAA_LOOKUP_NAME#*.}" ;;
    *) CAA_LOOKUP_NAME="" ;;
  esac
done

if test -n "$CAA_RECORDS"; then
  printf 'Effective CAA policy at %s:\n%s\n' "$CAA_LOOKUP_NAME" "$CAA_RECORDS"
  if ! printf '%s\n' "$CAA_RECORDS" |
    awk '
      {
        tag = tolower($2)
        value = ""
        for (i = 3; i <= NF; i++) {
          value = value (i == 3 ? "" : " ") $i
        }
        if (length(value) >= 2 && substr(value, 1, 1) == "\"" &&
            substr(value, length(value), 1) == "\"") {
          value = substr(value, 2, length(value) - 2)
        }
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        value = tolower(value)
        if (tag == "issue" && value == "digicert.com") found = 1
      }
      END { exit found ? 0 : 1 }
    '; then
    printf 'The effective CAA policy does not allow DigiCert.\n' >&2
    exit 1
  fi
else
  printf 'No CAA policy is published for %s or its parent labels.\n' "$CUSTOM_DOMAIN"
fi
```

The direct CNAME/A record, public ingress, and DigiCert CAA permission must remain in place for certificate renewal.

### 2. Add the hostname, create the managed certificate, and bind it

`hostname add` registers the validated custom hostname. The subsequent `hostname bind` command finds or creates Azure's free managed certificate, waits for issuance, and binds it to the hostname. For a subdomain, `VALIDATION_METHOD` is `CNAME`; for an apex domain it is `HTTP`.

<!-- guide-test:hostname-mutation -->

```sh
VALIDATION_METHOD="${VALIDATION_METHOD:?Run the matching DNS section first}"
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?Load the Terraform outputs first}"

if ! az account set --subscription "$SUBSCRIPTION_ID"; then
  printf 'Could not select Azure subscription %s.\n' "$SUBSCRIPTION_ID" >&2
  exit 1
fi
if ! ACTIVE_SUBSCRIPTION_ID="$(az account show --query id --output tsv)"; then
  printf 'Could not verify the active Azure subscription.\n' >&2
  exit 1
fi
if test "$ACTIVE_SUBSCRIPTION_ID" != "$SUBSCRIPTION_ID"; then
  printf 'Expected subscription %s, but Azure CLI selected %s.\n' \
    "$SUBSCRIPTION_ID" "$ACTIVE_SUBSCRIPTION_ID" >&2
  exit 1
fi

az containerapp hostname add \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --hostname "$CUSTOM_DOMAIN"

az containerapp hostname bind \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --hostname "$CUSTOM_DOMAIN" \
  --environment "$CONTAINER_APP_ENVIRONMENT" \
  --validation-method "$VALIDATION_METHOD"
```

Certificate issuance can take several minutes. Confirm both the managed certificate and SNI hostname binding in Azure:

<!-- guide-test:certificate-binding -->

```sh
if ! MANAGED_CERTIFICATES="$(
  az containerapp env certificate list \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_APP_ENVIRONMENT" \
    --managed-certificates-only \
    --query '[].[name,properties.subjectName,properties.provisioningState]' \
    --output tsv
)"; then
  printf 'Could not list Azure managed certificates.\n' >&2
  exit 1
fi
printf '%s\n' "$MANAGED_CERTIFICATES"
if ! printf '%s\n' "$MANAGED_CERTIFICATES" |
  awk -v expected="$CUSTOM_DOMAIN" '
    {
      subject = tolower($2)
      sub(/^cn=/, "", subject)
      sub(/\.$/, "", subject)
      if (subject == expected && tolower($3) == "succeeded") found = 1
    }
    END { exit found ? 0 : 1 }
  '; then
  printf 'No succeeded managed certificate matches %s.\n' "$CUSTOM_DOMAIN" >&2
  exit 1
fi

if ! HOSTNAME_BINDINGS="$(
  az containerapp hostname list \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_APP" \
    --query '[].[name,bindingType,certificateId]' \
    --output tsv
)"; then
  printf 'Could not list Container App hostname bindings.\n' >&2
  exit 1
fi
printf '%s\n' "$HOSTNAME_BINDINGS"
if ! printf '%s\n' "$HOSTNAME_BINDINGS" |
  awk -v expected="$CUSTOM_DOMAIN" '
    {
      hostname = tolower($1)
      sub(/\.$/, "", hostname)
      if (hostname == expected && tolower($2) == "snienabled" && $3 != "") found = 1
    }
    END { exit found ? 0 : 1 }
  '; then
  printf 'No SNI certificate binding matches %s.\n' "$CUSTOM_DOMAIN" >&2
  exit 1
fi
```

### 3. Verify HTTPS and the configured upload origin

Terraform disables insecure ingress. Verify that HTTP redirects and that the deployer-owned hostname presents a valid HTTPS certificate:

```sh
HTTP_STATUS="$(
  curl --silent --output /dev/null --write-out '%{http_code}' \
    "http://$CUSTOM_DOMAIN/healthz"
)"
case "$HTTP_STATUS" in
  301|302|307|308) ;;
  *)
    printf 'Expected an HTTPS redirect, received HTTP %s\n' "$HTTP_STATUS" >&2
    exit 1
    ;;
esac

curl --proto '=https' --tlsv1.2 \
  --fail --silent --show-error \
  "$PUBLIC_BASE_URL/healthz"
```

Finally, perform one authenticated upload and assert that the server returns a draft URL on exactly the configured origin. This uses the sensitive bootstrap token from Terraform state; do not enable shell tracing or paste its value into logs.

<!-- guide-test:upload-smoke -->

```sh
set +x
BOOTSTRAP_API_TOKEN="$(terraform output -raw bootstrap_api_token)"

UPLOAD_RESPONSE="$(
  curl --proto '=https' --tlsv1.2 \
    --fail-with-body --silent --show-error \
    --request POST \
    --header "Authorization: Bearer $BOOTSTRAP_API_TOKEN" \
    --header "Content-Type: application/json" \
    --data '{"html":"<!doctype html><html><head><title>Azure smoke test</title></head><body><h1>OK</h1></body></html>","filename":"azure-smoke.html"}' \
    "$PUBLIC_BASE_URL/api/uploads"
)"

DRAFT_URL="$(printf '%s' "$UPLOAD_RESPONSE" | jq -er '.publicUrl')"
case "$DRAFT_URL" in
  "$PUBLIC_BASE_URL"/d/*) ;;
  *)
    printf 'Unexpected draft origin: %s\n' "$DRAFT_URL" >&2
    exit 1
    ;;
esac

if ! curl --proto '=https' --tlsv1.2 \
  --fail --silent --show-error \
  "$DRAFT_URL" >/dev/null; then
  printf 'The uploaded draft could not be fetched.\n' >&2
  unset BOOTSTRAP_API_TOKEN
  exit 1
fi

printf '%s\n' "$DRAFT_URL"
unset BOOTSTRAP_API_TOKEN
```

These DNS, certificate, HTTPS, and upload checks require the deployer's real Azure subscription and DNS zone. They are intentionally human-in-the-loop and are not performed by Terraform validation or repository tests.

## Security notes

- Do not commit `terraform.tfvars`, `backend.hcl`, `.terraform/`, or generated deployment notes.
- Terraform state contains generated secrets. Keep it in the private Azure state storage account.
- The Blob container is private; public draft viewing goes through the PatchPage server.
- The server uses managed identity for Blob access in production.
- Uploads require API tokens. Anonymous uploads remain disabled.
