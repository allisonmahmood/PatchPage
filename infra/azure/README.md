# PatchPage Azure self-hosting

This directory is a reusable Azure Container Apps deployment example. It requires an HTTPS public origin on a DNS hostname the deployer owns; it has no default or fallback to the PatchPage maintainer's hosted service.

Terraform creates:

- the resource group, Log Analytics workspace, Container Apps environment, and Container App;
- external platform ingress with insecure HTTP disabled;
- the Azure Container Registry and the app's managed identity and role assignments;
- the Blob Storage account and private container, plus the PostgreSQL server/database; and
- generated application secrets and the Container App environment variables, including `PATCHPAGE_PUBLIC_BASE_URL`.

Terraform does **not** create or manage the remote-state resources, container image build, DNS zone or records, Container App custom hostname, managed certificate, or certificate binding. Those steps are deliberately manual and provider-neutral below.

## Prerequisites

- Terraform 1.9 or newer.
- Azure CLI, authenticated to the deployer's own Azure account with `az login`.
- Git for the image tag.
- `dig`, `curl`, and `jq` for the verification commands.
- Control of a public DNS hostname. A subdomain with a direct CNAME is recommended.

Do not run this example against a maintainer subscription. Check the active account before creating anything:

```sh
az account show --query '{subscription:id,tenant:tenantId,user:user.name}' --output table
```

## State bootstrap

Create remote Terraform state once. Set `STATE_STORAGE_ACCOUNT` to a globally unique name containing 3-24 lowercase letters and digits before running the block. Do not commit the generated backend config.

```sh
AZURE_DIR="$(git rev-parse --show-toplevel)/infra/azure"
cd "$AZURE_DIR"

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
az storage container create \
  --name "$STATE_CONTAINER" \
  --account-name "$STATE_STORAGE_ACCOUNT" \
  --auth-mode login

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

- Set `subscription_id` to the ID shown by `az account show --query id --output tsv`.
- Replace the deliberately invalid `public_base_url` with the deployer's real origin. It must be HTTPS with a public DNS hostname and no credentials, port, path, query, fragment, or trailing slash.

Terraform rejects the maintainer's domains, localhost/private-style names, reserved example names, and common placeholder values. The first targeted apply still requires a valid deployer-owned origin even though it only creates the registry.

```sh
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

az account set --subscription "$SUBSCRIPTION_ID"
test "$PUBLIC_BASE_URL" = "https://$CUSTOM_DOMAIN"

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

if test "$CUSTOM_DOMAIN" != "$DNS_SUBDOMAIN.$DNS_ZONE"; then
  printf 'DNS_ZONE and DNS_SUBDOMAIN do not compose the configured hostname.\n' >&2
  exit 1
fi

ACTUAL_CNAME="$(
  dig +short CNAME "$CUSTOM_DOMAIN" |
    sed -n '1{s/\.$//;p;}'
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

```sh
DNS_ZONE="${DNS_ZONE:?Set DNS_ZONE to the apex DNS zone you control}"

if test "$CUSTOM_DOMAIN" != "$DNS_ZONE"; then
  printf 'DNS_ZONE is not the configured apex hostname.\n' >&2
  exit 1
fi

if ! dig +short A "$CUSTOM_DOMAIN" | grep -Fqx -- "$CONTAINER_APP_STATIC_IP"; then
  printf 'The apex A record has not propagated to %s.\n' "$CONTAINER_APP_STATIC_IP" >&2
  exit 1
fi

ACTUAL_VERIFICATION_ID="$(dig +short TXT "asuid.$CUSTOM_DOMAIN" | tr -d '"')"
if ! printf '%s\n' "$ACTUAL_VERIFICATION_ID" | grep -Fqx -- "$DOMAIN_VERIFICATION_ID"; then
  printf 'The asuid TXT record has not propagated with the expected value.\n' >&2
  exit 1
fi

VALIDATION_METHOD="HTTP"
```

If the DNS zone publishes any CAA records, it must allow DigiCert with `0 issue "digicert.com"`. Check the real zone used above; if the command prints records, the `grep` must also succeed before continuing:

```sh
CAA_RECORDS="$(dig +short CAA "$DNS_ZONE")"
printf '%s\n' "$CAA_RECORDS"
if test -n "$CAA_RECORDS"; then
  if ! printf '%s\n' "$CAA_RECORDS" | grep -F 'issue "digicert.com"'; then
    printf 'The zone publishes CAA records but does not allow DigiCert.\n' >&2
    exit 1
  fi
fi
```

The direct CNAME/A record, public ingress, and DigiCert CAA permission must remain in place for certificate renewal.

### 2. Add the hostname, create the managed certificate, and bind it

`hostname add` registers the validated custom hostname. The subsequent `hostname bind` command finds or creates Azure's free managed certificate, waits for issuance, and binds it to the hostname. For a subdomain, `VALIDATION_METHOD` is `CNAME`; for an apex domain it is `HTTP`.

```sh
VALIDATION_METHOD="${VALIDATION_METHOD:?Run the matching DNS section first}"

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

```sh
az containerapp env certificate list \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP_ENVIRONMENT" \
  --query "[?properties.subjectName=='$CUSTOM_DOMAIN'].{name:name,state:properties.provisioningState,subject:properties.subjectName}" \
  --output table

az containerapp hostname list \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --query "[?name=='$CUSTOM_DOMAIN'].{hostname:name,binding:bindingType,certificate:certificateId}" \
  --output table
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

curl --proto '=https' --tlsv1.2 \
  --fail --silent --show-error \
  "$DRAFT_URL" >/dev/null

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
