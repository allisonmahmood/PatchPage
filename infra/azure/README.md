# PatchPage Azure self-hosting

This directory is a reusable Azure Container Apps deployment example. It requires an HTTPS public origin on a DNS hostname the deployer owns; it has no default or fallback to the PatchPage maintainer's hosted service.

Terraform creates:

- the resource group, Log Analytics workspace, Container Apps environment, and Container App;
- external platform ingress with insecure HTTP disabled;
- the Azure Container Registry and the app's managed identity and role assignments;
- the Blob Storage account and private container, plus the PostgreSQL server/database; and
- generated application secrets and the Container App environment variables, including `PATCHPAGE_PUBLIC_BASE_URL`, `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS`, the rate-limit settings, and, when configured, `PATCHPAGE_TRUST_PROXY`.

Terraform does **not** create or manage the remote-state resources, container image build, DNS zone or records, Container App custom hostname, managed certificate, or certificate binding. Those steps are deliberately manual and provider-neutral below. Terraform creates the initial Container App ingress and then ignores later changes to the whole ingress block so an apply cannot overwrite the CLI-managed hostname and certificate binding. Resource postconditions and the live check below fail closed if any ignored security or routing invariant drifts. Any intentional ingress change therefore remains HITL: update the lifecycle rule and restore the manual binding as one coordinated operation.

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

if ! az group create \
  --name "$STATE_RESOURCE_GROUP" \
  --location "$STATE_LOCATION" >/dev/null; then
  printf 'Could not create Terraform state resource group %s.\n' \
    "$STATE_RESOURCE_GROUP" >&2
  exit 1
fi
if ! STATE_RESOURCE_GROUP_LOCATION="$(
  az group show \
    --name "$STATE_RESOURCE_GROUP" \
    --query location \
    --output tsv
)"; then
  printf 'Could not verify Terraform state resource group %s.\n' \
    "$STATE_RESOURCE_GROUP" >&2
  exit 1
fi
if test "$STATE_RESOURCE_GROUP_LOCATION" != "$STATE_LOCATION"; then
  printf 'Terraform state resource group %s is in %s, expected %s.\n' \
    "$STATE_RESOURCE_GROUP" \
    "${STATE_RESOURCE_GROUP_LOCATION:-unknown}" \
    "$STATE_LOCATION" >&2
  exit 1
fi
if ! az storage account create \
  --name "$STATE_STORAGE_ACCOUNT" \
  --resource-group "$STATE_RESOURCE_GROUP" \
  --location "$STATE_LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --min-tls-version TLS1_2 \
  --https-only true \
  --allow-blob-public-access false >/dev/null; then
  printf 'Could not create Terraform state storage account %s.\n' \
    "$STATE_STORAGE_ACCOUNT" >&2
  exit 1
fi
if ! STATE_STORAGE_ACCOUNT_PROPERTIES="$(
  az storage account show \
    --name "$STATE_STORAGE_ACCOUNT" \
    --resource-group "$STATE_RESOURCE_GROUP" \
    --output json
)"; then
  printf 'Could not verify Terraform state storage account %s.\n' \
    "$STATE_STORAGE_ACCOUNT" >&2
  exit 1
fi
if ! printf '%s\n' "$STATE_STORAGE_ACCOUNT_PROPERTIES" |
  jq -e \
    --arg location "$STATE_LOCATION" \
    '.location == $location and
     .kind == "StorageV2" and
     .sku.name == "Standard_LRS" and
     .minimumTlsVersion == "TLS1_2" and
     .enableHttpsTrafficOnly == true and
     .allowBlobPublicAccess == false' >/dev/null; then
  printf 'Terraform state storage account %s does not match the required location or security properties.\n' \
    "$STATE_STORAGE_ACCOUNT" >&2
  exit 1
fi
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
- Keep `trust_proxy = null` for the initial deployment. This omits `PATCHPAGE_TRUST_PROXY` so forwarded client-address headers remain untrusted. Enable it only after completing [the client-IP HITL verification](#4-verify-and-enable-client-ip-attribution).
- Keep `max_html_bytes = 524288` unless you intentionally change the maximum accepted HTML artifact size.
- Keep `allow_anonymous_uploads = false` unless this self-hosted deployment intentionally accepts create-only requests without credentials. Terraform converts the boolean to `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS`; changing it does not enable anonymous uploads on any maintainer-hosted environment.
- Keep the rate-limit defaults unless the deployment needs a different local safety envelope: `protected_api_rate_limit_per_minute = 60`, `authenticated_upload_rate_limit_per_minute = 20`, and `anonymous_create_rate_limit_per_minute = 5`. Each value must be an integer from `1` through `10000`; Terraform wires them to the matching `PATCHPAGE_*_RATE_LIMIT_PER_MINUTE` Container App environment variables.

Terraform rejects the maintainer's domains, localhost/private-style names, reserved example names, and common placeholder values. It also rejects unsafe or malformed trusted-proxy values. The first targeted apply still requires a valid deployer-owned origin even though it only creates the registry.

<!-- guide-test:deploy-resources -->

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

if ! terraform init -backend-config=backend.hcl; then
  printf 'Terraform initialization failed.\n' >&2
  exit 1
fi
if ! terraform apply -target=azurerm_container_registry.patchpage; then
  printf 'Terraform could not create the container registry.\n' >&2
  exit 1
fi

if ! TAG="$(git -C ../.. rev-parse --short HEAD)"; then
  printf 'Could not determine the server image tag from Git.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$TAG" | grep -Eq '^[0-9a-f]{7,40}$'; then
  printf 'Git returned an unexpected server image tag: %s\n' "${TAG:-empty}" >&2
  exit 1
fi
if ! ACR="$(terraform output -raw acr_name)"; then
  printf 'Could not read the container registry name from Terraform.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$ACR" | grep -Eq '^[a-z0-9]{5,50}$'; then
  printf 'Terraform returned an unexpected container registry name: %s\n' \
    "${ACR:-empty}" >&2
  exit 1
fi
if ! LOGIN_SERVER="$(terraform output -raw acr_login_server)"; then
  printf 'Could not read the registry login server from Terraform.\n' >&2
  exit 1
fi
if test "$LOGIN_SERVER" != "$ACR.azurecr.io"; then
  printf 'Terraform returned registry login server %s, expected %s.azurecr.io.\n' \
    "${LOGIN_SERVER:-empty}" "$ACR" >&2
  exit 1
fi

if ! az acr build \
  --registry "$ACR" \
  --image "patchpage-server:$TAG" \
  --file ../../apps/server/Dockerfile \
  ../..; then
  printf 'ACR did not complete the server image build successfully.\n' >&2
  exit 1
fi

if ! printf 'server_image = "%s/patchpage-server:%s"\n' \
  "$LOGIN_SERVER" "$TAG" > server-image.auto.tfvars; then
  printf 'Could not write server-image.auto.tfvars.\n' >&2
  exit 1
fi

if ! terraform apply; then
  printf 'Terraform could not complete the PatchPage deployment.\n' >&2
  exit 1
fi
```

At this point Azure's generated Container App hostname is live over HTTPS, but the deployer-owned hostname and certificate are not configured yet.

## Configure the custom domain and managed certificate

The commands below follow [Microsoft's managed-certificate flow](https://learn.microsoft.com/azure/container-apps/custom-domains-managed-certificates). They read Azure resource names and DNS values from Terraform so there are no copied resource-name placeholders.

Load the outputs and make sure the Azure CLI is using the same subscription:

<!-- guide-test:custom-domain-context -->

```sh
if ! SUBSCRIPTION_ID="$(terraform output -raw subscription_id)" ||
  ! RESOURCE_GROUP="$(terraform output -raw resource_group_name)" ||
  ! CONTAINER_APP="$(terraform output -raw container_app_name)" ||
  ! CONTAINER_APP_ENVIRONMENT="$(terraform output -raw container_app_environment_name)" ||
  ! CONTAINER_APP_FQDN="$(terraform output -raw container_app_fqdn)" ||
  ! CONTAINER_APP_STATIC_IP="$(terraform output -raw container_app_environment_static_ip)" ||
  ! DOMAIN_VERIFICATION_ID="$(terraform output -raw custom_domain_verification_id)" ||
  ! PUBLIC_BASE_URL="$(terraform output -raw public_base_url)" ||
  ! CUSTOM_DOMAIN="$(terraform output -raw custom_domain_hostname)"; then
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

### Verify the Terraform-ignored ingress invariants

Every Terraform plan and apply checks these invariants through resource postconditions. Because Terraform deliberately preserves the CLI-managed custom-domain state by ignoring the complete ingress block, also read the live Azure ingress before DNS or certificate work and after every intentional ingress change.

<!-- guide-test:ingress-verification -->

```sh
if ! LIVE_INGRESS="$(
  az containerapp ingress show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_APP" \
    --output json
)"; then
  printf 'Could not read live Container App ingress.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$LIVE_INGRESS" |
  jq -e '
    type == "object" and
    .external == true and
    .allowInsecure == false and
    .targetPort == 3000 and
    (.transport | type == "string" and ascii_downcase == "auto") and
    (
      .clientCertificateMode == null or
      (
        .clientCertificateMode |
        type == "string" and
        (length == 0 or ascii_downcase == "ignore")
      )
    ) and
    .corsPolicy == null and
    (.exposedPort == null or .exposedPort == 0) and
    (
      .additionalPortMappings == null or
      (.additionalPortMappings | type == "array" and length == 0)
    ) and
    (
      .stickySessions == null or
      (
        .stickySessions |
        type == "object" and
        (.affinity | type == "string" and ascii_downcase == "none")
      )
    ) and
    (
      .ipSecurityRestrictions == null or
      (.ipSecurityRestrictions | type == "array" and length == 0)
    ) and
    (.traffic | type == "array" and length == 1) and
    (.traffic[0].label == null or .traffic[0].label == "") and
    .traffic[0].latestRevision == true and
    .traffic[0].weight == 100
  ' >/dev/null; then
  printf '%s\n' \
    'Live ingress drifted from the required HTTPS-only port, certificate, CORS, IP restriction, exposed-port, sticky-session, and latest-revision routing policy.' >&2
  exit 1
fi
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

Certificate authorities apply the first CAA RRset found while walking from the custom hostname toward the DNS root. At each original tree label, CAA lookup follows and normalizes its CNAME chain first; if that alias-aware lookup is empty, the walk resumes at the original label's parent, as required by RFC 8659. Ambiguous targets, loops, excessive alias depth, command errors, missing status, and every DNS status other than `NOERROR` fail closed. That effective policy, wherever it is inherited from, must allow DigiCert with an unparameterized `issue "digicert.com"` record. Parameterized DigiCert records fail this check because the guide cannot prove that Azure satisfies issuer-specific constraints. Any issuer-critical property outside the standard `issue`, `issuewild`, and `iodef` tags also fails closed because the guide cannot prove DigiCert supports it:

<!-- guide-test:caa-policy -->

```sh
CAA_TREE_NAME="$CUSTOM_DOMAIN"
CAA_LOOKUP_NAME=""
CAA_RECORDS=""

while test -n "$CAA_TREE_NAME"; do
  CAA_QUERY_NAME="$CAA_TREE_NAME"
  CAA_CNAME_SEEN="|"
  CAA_CNAME_HOPS=0

  while :; do
    case "$CAA_CNAME_SEEN" in
      *"|$CAA_QUERY_NAME|"*)
        printf 'CAA lookup encountered a CNAME loop at %s.\n' "$CAA_QUERY_NAME" >&2
        exit 1
        ;;
    esac
    CAA_CNAME_SEEN="$CAA_CNAME_SEEN$CAA_QUERY_NAME|"
    CAA_CNAME_HOPS=$((CAA_CNAME_HOPS + 1))
    if test "$CAA_CNAME_HOPS" -gt 16; then
      printf 'CAA lookup exceeded 16 CNAME hops from %s.\n' "$CAA_TREE_NAME" >&2
      exit 1
    fi

    if ! CNAME_RESPONSE="$(
      dig +noall +comments +answer CNAME "$CAA_QUERY_NAME"
    )"; then
      printf 'CNAME lookup failed for %s during CAA evaluation.\n' \
        "$CAA_QUERY_NAME" >&2
      exit 1
    fi

    CNAME_STATUS="$(
      printf '%s\n' "$CNAME_RESPONSE" |
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
    if test "$CNAME_STATUS" != "NOERROR"; then
      printf 'CNAME lookup for %s returned DNS status %s during CAA evaluation.\n' \
        "$CAA_QUERY_NAME" "${CNAME_STATUS:-unknown}" >&2
      exit 1
    fi

    if ! CNAME_TARGETS="$(
      printf '%s\n' "$CNAME_RESPONSE" |
        awk -v expected="$CAA_QUERY_NAME" '
          $1 ~ /^;/ || NF == 0 { next }
          {
            owner = tolower($1)
            sub(/\.$/, "", owner)
            if (NF != 5 ||
                owner != expected ||
                $2 !~ /^[0-9]+$/ ||
                toupper($3) != "IN" ||
                toupper($4) != "CNAME") {
              exit 1
            }
            target = tolower($5)
            sub(/\.$/, "", target)
            if (target == "") exit 1
            print target
          }
        '
    )"; then
      printf 'CNAME lookup for %s returned malformed or unexpected answer data.\n' \
        "$CAA_QUERY_NAME" >&2
      exit 1
    fi
    CNAME_TARGET_COUNT="$(
      printf '%s\n' "$CNAME_TARGETS" |
        awk 'NF { count++ } END { print count + 0 }'
    )"
    case "$CNAME_TARGET_COUNT" in
      0)
        break
        ;;
      1)
        CNAME_TARGET="$CNAME_TARGETS"
        if test -z "$CNAME_TARGET"; then
          printf 'CAA lookup received an empty CNAME target for %s.\n' \
            "$CAA_QUERY_NAME" >&2
          exit 1
        fi
        CAA_QUERY_NAME="$CNAME_TARGET"
        ;;
      *)
        printf 'CAA lookup received ambiguous CNAME targets for %s.\n' \
          "$CAA_QUERY_NAME" >&2
        exit 1
        ;;
    esac
  done

  if ! CAA_RESPONSE="$(
    dig +noall +comments +answer CAA "$CAA_QUERY_NAME"
  )"; then
    printf 'CAA lookup failed for %s.\n' "$CAA_QUERY_NAME" >&2
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
      "$CAA_QUERY_NAME" "${CAA_STATUS:-unknown}" >&2
    exit 1
  fi


  if ! CAA_RECORDS="$(
    printf '%s\n' "$CAA_RESPONSE" |
      awk -v expected="$CAA_QUERY_NAME" '
        function valid_value(value,    character, escaped, i) {
          if (length(value) < 2 ||
              substr(value, 1, 1) != "\"" ||
              substr(value, length(value), 1) != "\"") {
            return 0
          }
          escaped = 0
          for (i = 2; i < length(value); i++) {
            character = substr(value, i, 1)
            if (escaped) {
              escaped = 0
            } else if (character == "\\") {
              escaped = 1
            } else if (character == "\"") {
              return 0
            }
          }
          return !escaped
        }

        $1 ~ /^;/ || NF == 0 { next }
        {
          owner = tolower($1)
          sub(/\.$/, "", owner)
          if (owner != expected ||
              $2 !~ /^[0-9]+$/ ||
              toupper($3) != "IN" ||
              toupper($4) != "CAA" ||
              NF < 7 ||
              $5 !~ /^[0-9]+$/ ||
              ($5 + 0) > 255 ||
              $6 !~ /^[A-Za-z0-9]+$/ ||
              length($6) > 15) {
            exit 1
          }
          value = ""
          for (i = 7; i <= NF; i++) {
            value = value (i == 7 ? "" : " ") $i
          }
          if (!valid_value(value)) exit 1
          print $5, $6, value
        }
      '
  )"; then
    printf 'CAA lookup for %s returned malformed CAA record data.\n' \
      "$CAA_QUERY_NAME" >&2
    exit 1
  fi
  CAA_LOOKUP_NAME="$CAA_QUERY_NAME"
  test -z "$CAA_RECORDS" || break

  case "$CAA_TREE_NAME" in
    *.*) CAA_TREE_NAME="${CAA_TREE_NAME#*.}" ;;
    *) CAA_TREE_NAME="" ;;
  esac
done

if test -n "$CAA_RECORDS"; then
  printf 'Effective CAA policy at %s:\n%s\n' "$CAA_LOOKUP_NAME" "$CAA_RECORDS"
  if ! printf '%s\n' "$CAA_RECORDS" |
    awk '
      {
        tag = tolower($2)
        flags = $1 + 0
        if ((int(flags / 128) % 2) == 1 &&
            tag != "issue" && tag != "issuewild" && tag != "iodef") {
          unsupported_critical = 1
        }
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
      END { exit found && !unsupported_critical ? 0 : 1 }
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

if ! az containerapp hostname add \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --hostname "$CUSTOM_DOMAIN" >/dev/null; then
  printf 'Could not add custom hostname %s to the Container App.\n' \
    "$CUSTOM_DOMAIN" >&2
  exit 1
fi

if ! MANAGED_CERTIFICATE_ID="$(
  az containerapp hostname bind \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_APP" \
  --hostname "$CUSTOM_DOMAIN" \
  --environment "$CONTAINER_APP_ENVIRONMENT" \
  --validation-method "$VALIDATION_METHOD" \
  --query "[?name=='$CUSTOM_DOMAIN'].certificateId | [0]" \
  --output tsv
)"; then
  printf 'Could not create and bind the managed certificate for %s.\n' \
    "$CUSTOM_DOMAIN" >&2
  exit 1
fi
if test -z "$MANAGED_CERTIFICATE_ID"; then
  printf 'Azure did not return the bound managed-certificate resource ID for %s.\n' \
    "$CUSTOM_DOMAIN" >&2
  exit 1
fi
```

Certificate issuance can take several minutes. The bind command captured the exact managed-certificate resource ID selected by Azure. After issuance, confirm that this exact resource succeeded for the normalized hostname and that the SNI binding still points to the same ID:

<!-- guide-test:certificate-binding -->

```sh
MANAGED_CERTIFICATE_ID="${MANAGED_CERTIFICATE_ID:?Run the hostname binding block first}"

if ! MANAGED_CERTIFICATES="$(
  az containerapp env certificate list \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_APP_ENVIRONMENT" \
    --managed-certificates-only \
    --certificate "$MANAGED_CERTIFICATE_ID" \
    --query '[].[id,properties.subjectName,properties.provisioningState]' \
    --output tsv
)"; then
  printf 'Could not read bound managed certificate %s.\n' \
    "$MANAGED_CERTIFICATE_ID" >&2
  exit 1
fi
printf '%s\n' "$MANAGED_CERTIFICATES"
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
  printf 'Bound managed certificate %s has not succeeded exactly for %s.\n' \
    "$MANAGED_CERTIFICATE_ID" "$CUSTOM_DOMAIN" >&2
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
  printf 'No SNI binding for %s uses exact certificate ID %s.\n' \
    "$CUSTOM_DOMAIN" "$MANAGED_CERTIFICATE_ID" >&2
  exit 1
fi
```

### 3. Verify HTTPS and the configured upload origin

Terraform disables insecure ingress. Verify the exact HTTPS redirect, health response, authenticated upload response, configured draft origin, and fetched draft content as one fail-closed smoke. This uses the sensitive bootstrap token from Terraform state; do not enable shell tracing or paste its value into logs.

<!-- guide-test:deployed-smoke -->

```sh
(
set +x
if ! SMOKE_TMP_DIR="$(mktemp -d)"; then
  printf 'Could not create a temporary directory for the deployed smoke.\n' >&2
  exit 1
fi
AUTH_HEADER_FILE=''
SMOKE_MARKER="PATCHPAGE_AZURE_SMOKE_${SMOKE_TMP_DIR##*/}"

smoke_cleanup() {
  unset BOOTSTRAP_API_TOKEN
  rm -rf "$SMOKE_TMP_DIR"
}
trap 'smoke_cleanup' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

smoke_fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

EXPECTED_HEALTH_URL="https://$CUSTOM_DOMAIN/healthz"
if ! HTTP_STATUS="$(
  curl --silent --show-error \
    --output /dev/null \
    --dump-header "$SMOKE_TMP_DIR/http.headers" \
    --write-out '%{http_code}' \
    "http://$CUSTOM_DOMAIN/healthz"
)"; then
  smoke_fail 'The HTTP health request failed.'
fi
if test "$HTTP_STATUS" != "301"; then
  smoke_fail "Expected HTTP status 301, received HTTP $HTTP_STATUS."
fi
if ! HTTP_LOCATION="$(
  awk '
    tolower($1) == "location:" {
      value = $0
      sub(/^[^:]*:[[:space:]]*/, "", value)
      sub(/\r$/, "", value)
      locations++
      location = value
    }
    END {
      if (locations != 1) exit 1
      print location
    }
  ' "$SMOKE_TMP_DIR/http.headers"
)"; then
  smoke_fail 'The HTTP response did not contain exactly one Location header.'
fi
if test "$HTTP_LOCATION" != "$EXPECTED_HEALTH_URL"; then
  smoke_fail "Expected redirect Location $EXPECTED_HEALTH_URL, received $HTTP_LOCATION."
fi

if ! HTTPS_HEALTH_STATUS="$(
  curl --proto '=https' --tlsv1.2 \
    --silent --show-error \
    --output "$SMOKE_TMP_DIR/health.body" \
    --write-out '%{http_code}' \
    "$EXPECTED_HEALTH_URL"
)"; then
  smoke_fail 'The HTTPS health request failed.'
fi
if test "$HTTPS_HEALTH_STATUS" != "200"; then
  smoke_fail "Expected HTTPS health status 200, received $HTTPS_HEALTH_STATUS."
fi
if ! HTTPS_HEALTH_BODY="$(cat "$SMOKE_TMP_DIR/health.body")"; then
  smoke_fail 'Could not read the HTTPS health response body.'
fi
if test "$HTTPS_HEALTH_BODY" != '{"ok":true}'; then
  smoke_fail "Unexpected HTTPS health body: $HTTPS_HEALTH_BODY"
fi

if ! BOOTSTRAP_API_TOKEN="$(terraform output -raw bootstrap_api_token)"; then
  smoke_fail 'Could not read the bootstrap API token from Terraform.'
fi
if test -z "$BOOTSTRAP_API_TOKEN"; then
  smoke_fail 'Terraform returned an empty bootstrap API token.'
fi
AUTH_HEADER_FILE="$SMOKE_TMP_DIR/upload.headers"
if ! (umask 077 && printf 'Authorization: Bearer %s\n' \
  "$BOOTSTRAP_API_TOKEN" > "$AUTH_HEADER_FILE") ||
   ! chmod 600 "$AUTH_HEADER_FILE"; then
  smoke_fail 'Could not create the protected upload authorization header.'
fi
unset BOOTSTRAP_API_TOKEN
if ! UPLOAD_PAYLOAD="$(
  jq -cn --arg marker "$SMOKE_MARKER" \
    '{
      html: (
        "<!doctype html><html><head><title>Azure smoke test</title></head><body><h1>" +
        $marker +
        "</h1></body></html>"
      ),
      filename: "azure-smoke.html"
    }'
)"; then
  smoke_fail 'Could not safely encode the unique smoke upload payload.'
fi

if ! UPLOAD_STATUS="$(
  curl --proto '=https' --tlsv1.2 \
    --silent --show-error \
    --output "$SMOKE_TMP_DIR/upload.json" \
    --write-out '%{http_code}' \
    --request POST \
    --header "@$AUTH_HEADER_FILE" \
    --header "Content-Type: application/json" \
    --data "$UPLOAD_PAYLOAD" \
    "$PUBLIC_BASE_URL/api/uploads"
)"; then
  smoke_fail 'The authenticated upload request failed.'
fi
if test "$UPLOAD_STATUS" != "201"; then
  smoke_fail "Expected upload status 201, received $UPLOAD_STATUS."
fi
if ! DRAFT_URL="$(
  jq -er \
    --arg origin "$PUBLIC_BASE_URL" \
    'select(.ok == true) |
     select((.draftId | type) == "string") |
     select(.draftId | test("^[a-z0-9]{12}$")) |
     select(.publicUrl == ($origin + "/d/" + .draftId)) |
     .publicUrl' \
    "$SMOKE_TMP_DIR/upload.json"
)"; then
  smoke_fail 'Upload response did not contain the exact configured-origin draft URL.'
fi

if ! DRAFT_STATUS="$(
  curl --proto '=https' --tlsv1.2 \
    --silent --show-error \
    --output "$SMOKE_TMP_DIR/draft.html" \
    --write-out '%{http_code}' \
    "$DRAFT_URL"
)"; then
  smoke_fail 'The uploaded draft fetch failed.'
fi
if test "$DRAFT_STATUS" != "200"; then
  smoke_fail "Expected uploaded draft status 200, received $DRAFT_STATUS."
fi
if ! grep -Fq -- "$SMOKE_MARKER" "$SMOKE_TMP_DIR/draft.html"; then
  smoke_fail 'The fetched draft did not contain this run’s exact smoke marker.'
fi

printf '%s\n' "$DRAFT_URL"
)
```

Repository tests execute these guide blocks against failure-injection stubs, but they do not contact Azure or public DNS. DNS, certificate, HTTPS, and upload acceptance against the deployer's real subscription and zone remains intentionally human-in-the-loop.

### 4. Verify and enable client IP attribution

Terraform cannot determine Azure Container Apps' forwarding chain or prove which peer addresses reach this application. The `trust_proxy` default is therefore `null`: the Container App receives no `PATCHPAGE_TRUST_PROXY` variable, Fastify ignores `X-Forwarded-For`, and persisted upload `source_ip` values identify the direct socket peer. Do not replace this default with a guessed Azure hop count or network.

Complete this verification in the real deployment:

1. Inventory every reachable path to the Container App: the generated `*.azurecontainerapps.io` hostname, the custom hostname, and any CDN, WAF, gateway, or additional reverse proxy. A fixed hop count is valid only if every path that remains reachable has the same depth.
2. With `trust_proxy = null`, send controlled authenticated uploads from an independently known public client address through each path. The resulting `draft_versions.source_ip` shows the socket peer seen by PatchPage. PatchPage deliberately does not persist the raw `X-Forwarded-For` chain, so inspect that header at the application boundary with an approved temporary diagnostic revision or equivalent ingress observability. Remove temporary header logging after the observation and do not log API tokens.
3. Record the socket peer, the right-to-left forwarded chain, whether each proxy overwrites or appends incoming forwarding headers, and whether the observed path is invariant. Repeat enough requests and revisions to detect changing peer addresses.
4. Choose either a decimal count from `1` through `32` for a proven fixed-depth path, or comma-separated literal IP/CIDR entries for stable, verified proxy source networks. Terraform rejects deprecated `::` plus dotted-IPv4 transitional aliases, IPv4-mapped IPv6 aliases, and CIDR lists whose effective union covers an entire address family. Do not use broad address ranges merely because they include the observed peer.
5. Set the observed value in `terraform.tfvars`, review the environment change, and apply it:

   ```hcl
   # Example form only; use the value established by the observation above.
   trust_proxy = "2"
   ```

   ```sh
   terraform plan
   terraform apply
   ```

6. From the same known client, perform a new authenticated upload through every reachable path while supplying a canary header such as `X-Forwarded-For: 198.51.100.123`. Query the matching upload and confirm that both persisted fields equal the independently known client address and never the spoof canary:

   ```sql
   SELECT
     draft_versions.source_ip AS version_source_ip,
     upload_events.source_ip AS event_source_ip
   FROM draft_versions
   JOIN upload_events
     ON upload_events.draft_version_id = draft_versions.id
   WHERE draft_versions.draft_id = 'replace-with-the-canary-draft-id'
   ORDER BY upload_events.created_at DESC
   LIMIT 1;
   ```

7. If any path attributes the spoof value, a proxy peer, or a different header position, restore `trust_proxy = null` and correct the topology or trust rule before using the address for audit.

This verification remains an operator responsibility after deploy. Repeat it whenever Azure ingress behavior, DNS paths, custom domains, CDN/WAF layers, proxy source ranges, or Container App networking changes. Repository and Terraform tests validate parsing and environment wiring only; they do not establish the hosted trust boundary.

## Security notes

- Do not commit `terraform.tfvars`, `backend.hcl`, `.terraform/`, or generated deployment notes.
- Terraform state contains generated secrets. Keep it in the private Azure state storage account.
- The Blob container is private; public draft viewing goes through the PatchPage server.
- The server uses managed identity for Blob access in production.
- Uploads require API tokens by default. Anonymous creation remains disabled unless this deployment explicitly sets `allow_anonymous_uploads = true`.
- Keep `trust_proxy = null` until the live forwarding chain has passed the HITL verification above; an incorrect trust rule permits spoofed audit attribution.
