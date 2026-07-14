#!/bin/sh

set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)"
README="$ROOT/infra/azure/README.md"
TMP_ROOT="$(mktemp -d)"
TMP_DIR="$TMP_ROOT/guide commands"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_ROOT"' 0 HUP INT TERM

fail() {
  printf 'guide_commands_test: %s\n' "$1" >&2
  exit 1
}

case "$TMP_DIR" in
  *' '*) ;;
  *) fail "guide harness temporary path does not contain spaces" ;;
esac

if grep -Fq -- '--header "Authorization: Bearer $BOOTSTRAP_API_TOKEN"' "$README"; then
  fail "deployed smoke exposes the bootstrap token in curl argv"
fi

extract_block() {
  marker="<!-- guide-test:$1 -->"
  awk -v marker="$marker" '
    $0 == marker { marked = 1; next }
    marked && $0 == "```sh" { copying = 1; next }
    copying && $0 == "```" { found = 1; exit }
    copying { print }
    END { if (!found) exit 1 }
  ' "$README"
}

HOSTNAME_MUTATION_BLOCK="$(extract_block hostname-mutation)"
STATE_BOOTSTRAP_BLOCK="$(extract_block state-bootstrap)"
DEPLOY_RESOURCES_BLOCK="$(extract_block deploy-resources)"
CUSTOM_DOMAIN_CONTEXT_BLOCK="$(extract_block custom-domain-context)"
INGRESS_VERIFICATION_BLOCK="$(extract_block ingress-verification)"
APEX_DNS_BLOCK="$(extract_block apex-dns)"
CAA_POLICY_BLOCK="$(extract_block caa-policy)"
CERTIFICATE_BINDING_BLOCK="$(extract_block certificate-binding)"
DEPLOYED_SMOKE_BLOCK="$(extract_block deployed-smoke)"

run_state_bootstrap_block() {
  scenario="$1"
  scenario_root="$TMP_DIR/state-$scenario"
  log="$TMP_DIR/state-$scenario.log"
  rm -rf "$scenario_root"
  mkdir -p "$scenario_root/infra/azure"
  : > "$log"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    STATE_STORAGE_ACCOUNT="patchpagestate"

    git() {
      test "$*" = "rev-parse --show-toplevel" || return 1
      printf '%s\n' "$scenario_root"
    }

    az() {
      printf '%s\n' "$*" >> "$log"
      case "$1 $2" in
        "account set")
          return 0
          ;;
        "account show")
          printf '%s\n' "$SUBSCRIPTION_ID"
          ;;
        "group create")
          test "$scenario" != "group_create_failure"
          ;;
        "group show")
          if test "$scenario" = "group_verification_failure"; then
            return 1
          elif test "$scenario" = "group_location_drift"; then
            printf '%s\n' "eastus"
          else
            printf '%s\n' "centralus"
          fi
          ;;
        "storage account")
          case "$3" in
            create)
              test "$scenario" != "account_create_failure"
              ;;
            show)
              test "$scenario" != "account_verification_failure" || return 1
              account_location="centralus"
              account_kind="StorageV2"
              account_sku="Standard_LRS"
              account_tls="TLS1_2"
              account_https="true"
              account_public_blob="false"
              case "$scenario" in
                account_location_drift) account_location="eastus" ;;
                account_kind_drift) account_kind="BlobStorage" ;;
                account_sku_drift) account_sku="Standard_GRS" ;;
                account_tls_drift) account_tls="TLS1_0" ;;
                account_https_drift) account_https="false" ;;
                account_public_blob_drift) account_public_blob="true" ;;
              esac
              printf \
                '{"location":"%s","kind":"%s","sku":{"name":"%s"},"minimumTlsVersion":"%s","enableHttpsTrafficOnly":%s,"allowBlobPublicAccess":%s}\n' \
                "$account_location" \
                "$account_kind" \
                "$account_sku" \
                "$account_tls" \
                "$account_https" \
                "$account_public_blob"
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        "storage container")
          case " $* " in
            *" --auth-mode key "*) ;;
            *) return 1 ;;
          esac
          case "$3" in
            create)
              test "$scenario" != "create_failure"
              ;;
            exists)
              if test "$scenario" = "verification_failure"; then
                return 1
              elif test "$scenario" = "container_missing"; then
                printf '%s\n' "false"
              else
                printf '%s\n' "true"
              fi
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        *)
          return 1
          ;;
      esac
    }

    eval "$STATE_BOOTSTRAP_BLOCK"
  ) >/dev/null 2>&1
}

test_state_bootstrap() {
  for scenario in \
    group_create_failure \
    group_verification_failure \
    group_location_drift \
    account_create_failure \
    account_verification_failure \
    account_location_drift \
    account_kind_drift \
    account_sku_drift \
    account_tls_drift \
    account_https_drift \
    account_public_blob_drift \
    create_failure \
    verification_failure \
    container_missing \
    success; do
    if run_state_bootstrap_block "$scenario"; then
      status=0
    else
      status=$?
    fi

    backend="$TMP_DIR/state-$scenario/infra/azure/backend.hcl"
    case "$scenario" in
      success)
        test "$status" -eq 0 || fail "state bootstrap failed after container verification"
        test -f "$backend" || fail "state bootstrap did not create backend config after verification"
        grep -Fqx \
          'group create --name rg-patchpage-tfstate --location centralus' \
          "$log" ||
          fail "state resource group was not created in the intended location"
        grep -Fqx \
          'group show --name rg-patchpage-tfstate --query location --output tsv' \
          "$log" ||
          fail "state resource group location was not verified"
        grep -Fqx \
          'storage account create --name patchpagestate --resource-group rg-patchpage-tfstate --location centralus --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --https-only true --allow-blob-public-access false' \
          "$log" ||
          fail "state storage account was not created with the required security properties"
        grep -Fqx \
          'storage account show --name patchpagestate --resource-group rg-patchpage-tfstate --output json' \
          "$log" ||
          fail "state storage account properties were not verified"
        grep -Fqx \
          'storage container create --name tfstate --account-name patchpagestate --auth-mode key' \
          "$log" ||
          fail "state container creation did not use key authorization"
        grep -Fqx \
          'storage container exists --name tfstate --account-name patchpagestate --auth-mode key --query exists --output tsv' \
          "$log" ||
          fail "state container verification did not use key authorization"
        ;;
      *)
        test "$status" -ne 0 || fail "state bootstrap succeeded after $scenario"
        test ! -e "$backend" || fail "state bootstrap created backend config after $scenario"
        ;;
    esac
  done
}

run_deploy_resources_block() {
  scenario="$1"
  scenario_root="$TMP_DIR/deploy-$scenario"
  log="$TMP_DIR/deploy-$scenario.log"
  rm -rf "$scenario_root"
  mkdir -p "$scenario_root/infra/azure"
  : > "$log"

  (
    SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
    cd "$scenario_root/infra/azure"

    git() {
      case "$*" in
        "rev-parse --show-toplevel") printf '%s\n' "$scenario_root" ;;
        "-C ../.. rev-parse --short HEAD")
          test "$scenario" != "git_failure" || return 1
          test "$scenario" != "git_empty" || return 0
          printf '%s\n' "d761896"
          ;;
        *) return 1 ;;
      esac
    }

    terraform() {
      printf 'terraform %s\n' "$*" >> "$log"
      case "$*" in
        "init -backend-config=backend.hcl")
          test "$scenario" != "init_failure"
          ;;
        "apply -target=azurerm_container_registry.patchpage")
          test "$scenario" != "target_apply_failure"
          ;;
        "output -raw acr_name")
          test "$scenario" != "acr_output_failure" || return 1
          test "$scenario" != "acr_output_empty" || return 0
          if test "$scenario" = "unexpected_acr_name"; then
            printf '%s\n' "not-an-acr-name"
          else
            printf '%s\n' "acrpatchpageabc123"
          fi
          ;;
        "output -raw acr_login_server")
          test "$scenario" != "login_output_failure" || return 1
          test "$scenario" != "login_output_empty" || return 0
          if test "$scenario" = "unexpected_login_server"; then
            printf '%s\n' "other.azurecr.io"
          else
            printf '%s\n' "acrpatchpageabc123.azurecr.io"
          fi
          ;;
        "apply")
          test "$scenario" != "final_apply_failure"
          ;;
        *)
          return 1
          ;;
      esac
    }

    az() {
      printf 'az %s\n' "$*" >> "$log"
      case "$1 $2" in
        "account set") return 0 ;;
        "account show") printf '%s\n' "$SUBSCRIPTION_ID" ;;
        "acr build") test "$scenario" != "build_failure" ;;
        *) return 1 ;;
      esac
    }

    set +e
    eval "$DEPLOY_RESOURCES_BLOCK"
    printf '%s\n' completed >> "$log"
  ) >/dev/null 2>&1
}

test_deploy_resources() {
  for scenario in \
    init_failure \
    target_apply_failure \
    git_failure \
    git_empty \
    acr_output_failure \
    acr_output_empty \
    unexpected_acr_name \
    login_output_failure \
    login_output_empty \
    unexpected_login_server \
    build_failure \
    final_apply_failure \
    success; do
    if run_deploy_resources_block "$scenario"; then
      status=0
    else
      status=$?
    fi

    image_vars="$TMP_DIR/deploy-$scenario/infra/azure/server-image.auto.tfvars"
    case "$scenario" in
      success)
        test "$status" -eq 0 || fail "guarded deployment rejected successful commands"
        test -f "$image_vars" || fail "successful build did not write server image variables"
        grep -Fqx \
          'server_image = "acrpatchpageabc123.azurecr.io/patchpage-server:d761896"' \
          "$image_vars" ||
          fail "deployment wrote an unexpected server image reference"
        grep -Fqx \
          'az acr build --registry acrpatchpageabc123 --image patchpage-server:d761896 --file ../../apps/server/Dockerfile ../..' \
          "$TMP_DIR/deploy-$scenario.log" ||
          fail "deployment used unexpected ACR build arguments"
        grep -Fqx completed "$TMP_DIR/deploy-$scenario.log" ||
          fail "successful deployment did not complete"
        ;;
      final_apply_failure)
        test "$status" -ne 0 || fail "deployment masked the final Terraform apply failure"
        test -f "$image_vars" ||
          fail "verified successful build did not write image variables before final apply"
        ;;
      *)
        test "$status" -ne 0 || fail "deployment masked $scenario"
        test ! -e "$image_vars" ||
          fail "deployment wrote image variables after $scenario"
        ;;
    esac

    if test "$scenario" != "success" && grep -q '^completed$' "$TMP_DIR/deploy-$scenario.log"; then
      fail "deployment continued after $scenario"
    fi
  done
}

test_custom_domain_context() {
  if ! (
    expected_subscription="00000000-0000-0000-0000-000000000000"

    terraform() {
      case "$*" in
        "output -raw subscription_id") printf '%s\n' "$expected_subscription" ;;
        "output -raw resource_group_name") printf '%s\n' "rg-test" ;;
        "output -raw container_app_name") printf '%s\n' "app-test" ;;
        "output -raw container_app_environment_name") printf '%s\n' "env-test" ;;
        "output -raw container_app_fqdn") printf '%s\n' "APP.AZURECONTAINERAPPS.IO." ;;
        "output -raw container_app_environment_static_ip") printf '%s\n' "203.0.113.10" ;;
        "output -raw custom_domain_verification_id") printf '%s\n' "verification-id" ;;
        "output -raw public_base_url") printf '%s\n' "https://DRAFTS.SELF-HOSTER.DEV" ;;
        "output -raw custom_domain_hostname") printf '%s\n' "DRAFTS.SELF-HOSTER.DEV." ;;
        *) return 1 ;;
      esac
    }

    az() {
      case "$1 $2" in
        "account set") return 0 ;;
        "account show") printf '%s\n' "$expected_subscription" ;;
        *) return 1 ;;
      esac
    }

    eval "$CUSTOM_DOMAIN_CONTEXT_BLOCK"
    test "$CUSTOM_DOMAIN" = "drafts.self-hoster.dev"
    test "$CONTAINER_APP_FQDN" = "app.azurecontainerapps.io"
    test "$NORMALIZED_PUBLIC_BASE_URL" = "https://drafts.self-hoster.dev"
  ) >/dev/null 2>&1; then
    fail "Terraform hostnames were not normalized before DNS and certificate checks"
  fi
}

run_custom_domain_output_guard_block() {
  scenario="$1"
  log="$TMP_DIR/custom-domain-output-$scenario.log"
  : > "$log"

  (
    expected_subscription="00000000-0000-0000-0000-000000000000"

    terraform() {
      output_name="$3"
      test "$scenario" != "failure_$output_name" || return 1
      test "$scenario" != "empty_$output_name" || return 0
      case "$output_name" in
        subscription_id) printf '%s\n' "$expected_subscription" ;;
        resource_group_name) printf '%s\n' "rg-test" ;;
        container_app_name) printf '%s\n' "app-test" ;;
        container_app_environment_name) printf '%s\n' "env-test" ;;
        container_app_fqdn) printf '%s\n' "app.azurecontainerapps.io" ;;
        container_app_environment_static_ip) printf '%s\n' "203.0.113.10" ;;
        custom_domain_verification_id) printf '%s\n' "verification-id" ;;
        public_base_url) printf '%s\n' "https://drafts.self-hoster.dev" ;;
        custom_domain_hostname) printf '%s\n' "drafts.self-hoster.dev" ;;
        *) return 1 ;;
      esac
    }

    az() {
      printf 'az %s\n' "$*" >> "$log"
      case "$1 $2" in
        "account set") return 0 ;;
        "account show") printf '%s\n' "$expected_subscription" ;;
        *) return 1 ;;
      esac
    }

    set +e
    eval "$CUSTOM_DOMAIN_CONTEXT_BLOCK"
    printf '%s\n' completed >> "$log"
  ) >/dev/null 2>&1
}

test_custom_domain_output_guards() {
  output_names="subscription_id
resource_group_name
container_app_name
container_app_environment_name
container_app_fqdn
container_app_environment_static_ip
custom_domain_verification_id
public_base_url
custom_domain_hostname"

  for output_name in $output_names; do
    for mode in failure empty; do
      scenario="${mode}_$output_name"
      if run_custom_domain_output_guard_block "$scenario"; then
        status=0
      else
        status=$?
      fi
      test "$status" -ne 0 || fail "custom-domain context masked $scenario"
      if grep -q '^az ' "$TMP_DIR/custom-domain-output-$scenario.log"; then
        fail "custom-domain context called Azure after $scenario"
      fi
      if grep -q '^completed$' "$TMP_DIR/custom-domain-output-$scenario.log"; then
        fail "custom-domain context continued after $scenario"
      fi
    done
  done
}

run_ingress_verification_block() {
  scenario="$1"
  log="$TMP_DIR/ingress-$scenario.log"
  : > "$log"

  (
    RESOURCE_GROUP="rg-test"
    CONTAINER_APP="app-test"

    az() {
      printf '%s\n' "$*" >> "$log"
      test "$scenario" != "command_failure" || return 1
      test "$*" = \
        "containerapp ingress show --resource-group rg-test --name app-test --output json" ||
        return 1

      external="true"
      allow_insecure="false"
      target_port="3000"
      transport='"Auto"'
      traffic='[{"latestRevision":true,"weight":100}]'
      client_certificate_mode='"Ignore"'
      cors_policy="null"
      exposed_port="null"
      ip_security_restrictions="null"
      additional_port_mappings="null"
      sticky_sessions="null"
      case "$scenario" in
        malformed_json)
          printf '%s\n' '{not-json'
          return 0
          ;;
        external_drift) external="false" ;;
        insecure_drift) allow_insecure="true" ;;
        target_port_drift) target_port="8080" ;;
        transport_drift) transport='"http2"' ;;
        missing_transport) transport="null" ;;
        client_certificate_accept_drift) client_certificate_mode='"Accept"' ;;
        client_certificate_require_drift) client_certificate_mode='"Require"' ;;
        null_client_certificate) client_certificate_mode="null" ;;
        cors_drift) cors_policy='{"allowedOrigins":["https://other.example"]}' ;;
        exposed_port_drift) exposed_port="8443" ;;
        additional_port_drift)
          additional_port_mappings='[{"external":true,"targetPort":9000,"exposedPort":9000}]'
          ;;
        sticky_session_drift) sticky_sessions='{"affinity":"sticky"}' ;;
        ip_restriction_drift)
          ip_security_restrictions='[{"action":"Allow","ipAddressRange":"192.0.2.0/24","name":"unexpected"}]'
          ;;
        empty_traffic) traffic='[]' ;;
        multiple_traffic)
          traffic='[{"latestRevision":true,"weight":50},{"latestRevision":false,"weight":50}]'
          ;;
        empty_label_dynamic)
          traffic='[{"label":"","latestRevision":true,"revisionName":"","weight":100}]'
          ;;
        pinned_revision)
          traffic='[{"latestRevision":false,"revisionName":"app-test--old","weight":100}]'
          ;;
        label_drift)
          traffic='[{"label":"canary","latestRevision":true,"weight":100}]'
          ;;
        weight_drift) traffic='[{"latestRevision":true,"weight":90}]' ;;
      esac
      printf \
        '{"external":%s,"allowInsecure":%s,"targetPort":%s,"transport":%s,"clientCertificateMode":%s,"corsPolicy":%s,"exposedPort":%s,"additionalPortMappings":%s,"stickySessions":%s,"ipSecurityRestrictions":%s,"traffic":%s}\n' \
        "$external" "$allow_insecure" "$target_port" "$transport" \
        "$client_certificate_mode" "$cors_policy" "$exposed_port" \
        "$additional_port_mappings" "$sticky_sessions" \
        "$ip_security_restrictions" "$traffic"
    }

    eval "$INGRESS_VERIFICATION_BLOCK"
  ) >/dev/null 2>&1
}

test_ingress_verification() {
  run_ingress_verification_block success ||
    fail "documented ingress verification rejected the intended live ingress"
  grep -Fqx \
    'containerapp ingress show --resource-group rg-test --name app-test --output json' \
    "$TMP_DIR/ingress-success.log" ||
    fail "documented ingress verification did not read the live ingress"
  run_ingress_verification_block null_client_certificate ||
    fail "documented ingress verification rejected Azure's null client-certificate default"
  run_ingress_verification_block empty_label_dynamic ||
    fail "documented ingress verification rejected AzureRM's empty dynamic-route fields"

  for scenario in \
    command_failure \
    malformed_json \
    external_drift \
    insecure_drift \
    target_port_drift \
    transport_drift \
    missing_transport \
    client_certificate_accept_drift \
    client_certificate_require_drift \
    cors_drift \
    exposed_port_drift \
    additional_port_drift \
    sticky_session_drift \
    ip_restriction_drift \
    empty_traffic \
    multiple_traffic \
    pinned_revision \
    label_drift \
    weight_drift; do
    if run_ingress_verification_block "$scenario"; then
      fail "documented ingress verification accepted $scenario"
    fi
  done
}

test_hostname_mutation_guard() {
  expected_subscription="00000000-0000-0000-0000-000000000000"
  expected_certificate_id="/subscriptions/$expected_subscription/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env-test/managedCertificates/cert-one"

  for scenario in \
    set_failure \
    wrong_selection \
    hostname_add_failure \
    hostname_bind_failure \
    empty_certificate_id \
    success; do
    log="$TMP_DIR/hostname-$scenario.log"
    : > "$log"

    if (
      SUBSCRIPTION_ID="$expected_subscription"
      ACTIVE_SUBSCRIPTION_ID=""
      RESOURCE_GROUP="rg-test"
      CONTAINER_APP="app-test"
      CONTAINER_APP_ENVIRONMENT="env-test"
      CUSTOM_DOMAIN="drafts.self-hoster.dev"
      VALIDATION_METHOD="CNAME"

      az() {
        printf '%s\n' "$*" >> "$log"
        case "$1 $2" in
          "account set")
            test "$scenario" != "set_failure"
            ;;
          "account show")
            if test "$scenario" = "wrong_selection"; then
              printf '%s\n' "11111111-1111-1111-1111-111111111111"
            else
              printf '%s\n' "$expected_subscription"
            fi
            ;;
          "containerapp hostname")
            case "$3" in
              add)
                test "$scenario" != "hostname_add_failure"
                ;;
              bind)
                test "$scenario" != "hostname_bind_failure" || return 1
                test "$scenario" != "empty_certificate_id" || return 0
                printf '%s\n' "$expected_certificate_id"
                ;;
              *)
                return 1
                ;;
            esac
            ;;
          *)
            return 1
            ;;
        esac
      }

      eval "$HOSTNAME_MUTATION_BLOCK"
    ) >/dev/null 2>&1; then
      status=0
    else
      status=$?
    fi

    case "$scenario" in
      success)
        test "$status" -eq 0 || fail "hostname mutations failed after valid subscription selection"
        test "$(grep -c '^containerapp hostname' "$log")" -eq 2 ||
          fail "valid subscription selection did not run both hostname mutations"
        grep -Fqx \
          "containerapp hostname bind --resource-group rg-test --name app-test --hostname drafts.self-hoster.dev --environment env-test --validation-method CNAME --query [?name=='drafts.self-hoster.dev'].certificateId | [0] --output tsv" \
          "$log" ||
          fail "hostname bind did not capture its exact certificate resource ID"
        ;;
      hostname_bind_failure|empty_certificate_id)
        test "$status" -ne 0 || fail "hostname mutations succeeded after $scenario"
        test "$(grep -c '^containerapp hostname' "$log")" -eq 2 ||
          fail "hostname bind guard did not run after a successful hostname add"
        ;;
      hostname_add_failure)
        test "$status" -ne 0 || fail "hostname mutations succeeded after $scenario"
        test "$(grep -c '^containerapp hostname' "$log")" -eq 1 ||
          fail "hostname bind ran after hostname add failed"
        ;;
      *)
        test "$status" -ne 0 || fail "hostname mutations succeeded after $scenario"
        if grep -q '^containerapp hostname' "$log"; then
          fail "hostname mutation ran after $scenario"
        fi
        ;;
    esac
  done
}

run_apex_block() {
  a_records="$1"
  aaaa_scenario="$2"

  (
    DNS_ZONE="drafts.self-hoster.dev"
    CUSTOM_DOMAIN="drafts.self-hoster.dev"
    CONTAINER_APP_STATIC_IP="203.0.113.10"
    DOMAIN_VERIFICATION_ID="verification-id"

    dig() {
      case "$1" in
        +short)
          case "$2" in
            A) printf '%s\n' "$a_records" ;;
            AAAA)
              case "$aaaa_scenario" in
                command_error) return 1 ;;
                noerror_answer) printf '%s\n' '2001:db8::10' ;;
                *) printf '%s' "" ;;
              esac
              ;;
            TXT) printf '%s\n' '"verification-id"' ;;
            *) return 1 ;;
          esac
          ;;
        +noall)
          test "$1 $2 $3 $4" = "+noall +comments +answer AAAA" || return 1
          case "$aaaa_scenario" in
            command_error) return 1 ;;
            missing_status)
              printf '%s\n' ';; ->>HEADER<<- opcode: QUERY, id: 12345'
              return 0
              ;;
            noerror_empty|noerror_answer) status="NOERROR" ;;
            servfail) status="SERVFAIL" ;;
            refused) status="REFUSED" ;;
            unknown_status) status="UNKNOWN" ;;
            *) return 1 ;;
          esac
          printf '%s\n' ";; ->>HEADER<<- opcode: QUERY, status: $status, id: 12345"
          if test "$aaaa_scenario" = "noerror_answer"; then
            printf '%s\n' 'drafts.self-hoster.dev. 300 IN AAAA 2001:db8::10'
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    eval "$APEX_DNS_BLOCK"
  ) >/dev/null 2>&1
}

test_apex_dns() {
  run_apex_block "203.0.113.10" noerror_empty ||
    fail "exact apex A record with a NOERROR-empty AAAA response was rejected"

  if run_apex_block "203.0.113.10
198.51.100.20" noerror_empty; then
    fail "apex DNS accepted an additional A record"
  fi

  if run_apex_block "203.0.113.10" noerror_answer; then
    fail "apex DNS accepted an AAAA record"
  fi

  for scenario in servfail refused missing_status unknown_status command_error; do
    if run_apex_block "203.0.113.10" "$scenario"; then
      fail "apex DNS accepted the AAAA $scenario response"
    fi
  done
}

run_caa_block() {
  scenario="$1"
  log="$TMP_DIR/caa-$scenario.log"
  : > "$log"

  (
    CUSTOM_DOMAIN="drafts.team.example.com"
    DNS_ZONE="example.com"

    dig() {
      for name do :; done
      record_type="$4"
      test "$1 $2 $3" = "+noall +comments +answer" || return 1
      case "$record_type" in CNAME|CAA) ;; *) return 1 ;; esac
      printf '%s %s\n' "$record_type" "$name" >> "$log"

      case "$scenario:$record_type:$name" in
        command_error:CAA:team.example.com | cname_command_error:CNAME:drafts.team.example.com)
          return 1
          ;;
        servfail:CAA:team.example.com | cname_servfail:CNAME:drafts.team.example.com)
          status="SERVFAIL"
          ;;
        refused:CAA:team.example.com)
          status="REFUSED"
          ;;
        missing_status:CAA:team.example.com | cname_missing_status:CNAME:drafts.team.example.com)
          printf '%s\n' ';; ->>HEADER<<- opcode: QUERY, id: 12345'
          return 0
          ;;
        *)
          status="NOERROR"
          ;;
      esac
      printf '%s\n' ";; ->>HEADER<<- opcode: QUERY, status: $status, id: 12345"

      case "$record_type:$scenario:$name" in
        CNAME:cname_success:drafts.team.example.com)
          printf '%s\n' \
            'DRAFTS.TEAM.EXAMPLE.COM. 300 IN CNAME CAA.Target.Example.NET.'
          ;;
        CNAME:cname_ambiguity:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. 300 IN CNAME first.example.net.' \
            'drafts.team.example.com. 300 IN CNAME second.example.net.'
          ;;
        CNAME:cname_loop:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. 300 IN CNAME Alias.Example.NET.'
          ;;
        CNAME:cname_loop:alias.example.net)
          printf '%s\n' \
            'ALIAS.EXAMPLE.NET. 300 IN CNAME DRAFTS.TEAM.EXAMPLE.COM.'
          ;;
        CNAME:cname_invalid_ttl:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. invalid IN CNAME alias.example.net.'
          ;;
        CNAME:cname_invalid_class:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. 300 CH CNAME alias.example.net.'
          ;;
        CNAME:cname_wrong_type:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. 300 IN A 192.0.2.10'
          ;;
        CNAME:cname_misaligned:drafts.team.example.com)
          printf '%s\n' \
            'drafts.team.example.com. IN CNAME alias.example.net.'
          ;;
        CNAME:cname_unexpected_owner:drafts.team.example.com)
          printf '%s\n' \
            'other.team.example.com. 300 IN CNAME alias.example.net.'
          ;;
        CAA:inherit_noerror:example.com)
          printf '%s\n' 'example.com. 300 IN CAA 0 IsSuE "DiGiCeRt.CoM"'
          ;;
        CAA:cname_success:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "digicert.com"'
          ;;
        CAA:deny_nearer:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "letsencrypt.org"'
          ;;
        CAA:deny_nearer:example.com)
          printf '%s\n' 'example.com. 300 IN CAA 0 issue "digicert.com"'
          ;;
        CAA:unrelated:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 iodef "mailto:security@example.com"'
          ;;
        CAA:denying:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 issue ";"'
          ;;
        CAA:constrained_digicert:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "digicert.com; accounturi=https://example.com/account/123"'
          ;;
        CAA:constrained_digicert_spaced:team.example.com)
          printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "digicert.com ; accounturi=https://example.com/account/123"'
          ;;
        CAA:unknown_critical:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 IN CAA 0 issue "digicert.com"' \
            'team.example.com. 300 IN CAA 128 unknowncritical "x"'
          ;;
        CAA:malformed_flags:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 IN CAA 0 issue "digicert.com"' \
            'team.example.com. 300 IN CAA invalid issue "letsencrypt.org"'
          ;;
        CAA:malformed_fields:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 IN CAA 0 issue "digicert.com"' \
            'team.example.com. 300 IN CAA 0 issue'
          ;;
        CAA:malformed_value:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 IN CAA 0 issue "digicert.com"' \
            'team.example.com. 300 IN CAA 0 iodef mailto:security@example.com'
          ;;
        CAA:caa_invalid_ttl:team.example.com)
          printf '%s\n' \
            'team.example.com. invalid IN CAA 0 issue "digicert.com"'
          ;;
        CAA:caa_invalid_class:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 CH CAA 0 issue "digicert.com"'
          ;;
        CAA:caa_wrong_type:team.example.com)
          printf '%s\n' \
            'team.example.com. 300 IN TXT "ignored"'
          ;;
        CAA:caa_misaligned:team.example.com)
          printf '%s\n' \
            'team.example.com. IN CAA 0 issue "digicert.com"'
          ;;
        CAA:caa_unexpected_owner:team.example.com)
          printf '%s\n' \
            'other.example.com. 300 IN CAA 0 issue "digicert.com"'
          ;;
      esac
    }

    eval "$CAA_POLICY_BLOCK"
  ) >/dev/null 2>&1
}

test_caa_policy() {
  run_caa_block inherit_noerror || fail "inherited DigiCert CAA policy was rejected"

  expected_queries="CNAME drafts.team.example.com
CAA drafts.team.example.com
CNAME team.example.com
CAA team.example.com
CNAME example.com
CAA example.com"
  if test "$(cat "$TMP_DIR/caa-inherit_noerror.log")" != "$expected_queries"; then
    fail "CAA lookup did not walk from the hostname to the effective parent"
  fi

  if run_caa_block deny_nearer; then
    fail "CAA lookup skipped a nearer policy that denies DigiCert"
  fi

  run_caa_block cname_success ||
    fail "normalized CNAME target was not followed before inherited CAA evaluation"
  expected_cname_queries="CNAME drafts.team.example.com
CNAME caa.target.example.net
CAA caa.target.example.net
CNAME team.example.com
CAA team.example.com"
  if test "$(cat "$TMP_DIR/caa-cname_success.log")" != "$expected_cname_queries"; then
    fail "CAA lookup did not follow the normalized CNAME before original-parent walking"
  fi

  for scenario in \
    cname_ambiguity \
    cname_loop \
    cname_wrong_type \
    cname_invalid_ttl \
    cname_invalid_class \
    cname_misaligned \
    cname_unexpected_owner; do
    if run_caa_block "$scenario"; then
      fail "CAA lookup accepted $scenario"
    fi
  done
  test "$(cat "$TMP_DIR/caa-cname_ambiguity.log")" = \
    "CNAME drafts.team.example.com" ||
    fail "CAA lookup continued after ambiguous CNAME targets"
  expected_loop_queries="CNAME drafts.team.example.com
CNAME alias.example.net"
  test "$(cat "$TMP_DIR/caa-cname_loop.log")" = "$expected_loop_queries" ||
    fail "CAA lookup continued after a normalized CNAME loop"

  for scenario in \
    unrelated \
    denying \
    constrained_digicert \
    constrained_digicert_spaced \
    unknown_critical \
    malformed_flags \
    malformed_fields \
    malformed_value \
    caa_invalid_ttl \
    caa_invalid_class \
    caa_wrong_type \
    caa_misaligned \
    caa_unexpected_owner; do
    if run_caa_block "$scenario"; then
      fail "CAA lookup accepted the $scenario policy"
    fi
  done

  for scenario in servfail refused missing_status command_error; do
    if run_caa_block "$scenario"; then
      fail "CAA lookup continued after DNS $scenario"
    fi
    expected_failure_queries="CNAME drafts.team.example.com
CAA drafts.team.example.com
CNAME team.example.com
CAA team.example.com"
    if test "$(cat "$TMP_DIR/caa-$scenario.log")" != "$expected_failure_queries"; then
      fail "CAA lookup walked to a parent after DNS $scenario"
    fi
  done

  for scenario in cname_servfail cname_missing_status cname_command_error; do
    if run_caa_block "$scenario"; then
      fail "CAA lookup continued after $scenario"
    fi
    test "$(cat "$TMP_DIR/caa-$scenario.log")" = \
      "CNAME drafts.team.example.com" ||
      fail "CAA lookup continued after $scenario"
  done
}

run_certificate_block() {
  subject="$1"
  certificate_id="$2"
  binding_id="$3"
  provisioning_state="$4"

  (
    RESOURCE_GROUP="rg-test"
    CONTAINER_APP="app-test"
    CONTAINER_APP_ENVIRONMENT="env-test"
    CUSTOM_DOMAIN="drafts.self-hoster.dev"
    MANAGED_CERTIFICATE_ID="/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env-test/managedCertificates/cert-one"

    az() {
      case "$*" in
        *"env certificate list"*)
          case " $* " in
            *" --managed-certificates-only --certificate $MANAGED_CERTIFICATE_ID --query [].[id,properties.subjectName,properties.provisioningState] --output tsv "*) ;;
            *) return 1 ;;
          esac
          printf '%s\t%s\t%s\n' "$certificate_id" "$subject" "$provisioning_state"
          ;;
        *"hostname list"*)
          printf 'Drafts.Self-Hoster.Dev.\tSniEnabled\t%s\n' "$binding_id"
          ;;
        *)
          return 1
          ;;
      esac
    }

    eval "$CERTIFICATE_BINDING_BLOCK"
  ) >/dev/null 2>&1
}

test_certificate_binding() {
  certificate_id="/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env-test/managedCertificates/cert-one"
  other_certificate_id="/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env-test/managedCertificates/cert-two"

  run_certificate_block \
    "CN=Drafts.Self-Hoster.Dev." \
    "$certificate_id" \
    "$certificate_id" \
    "Succeeded" ||
    fail "normalized CN certificate subject was not matched"

  if run_certificate_block \
    "CN=other.example.com" \
    "$certificate_id" \
    "$certificate_id" \
    "Succeeded"; then
    fail "certificate verification accepted a different subject"
  fi

  if run_certificate_block \
    "CN=Drafts.Self-Hoster.Dev." \
    "$other_certificate_id" \
    "$certificate_id" \
    "Succeeded"; then
    fail "certificate verification accepted a different managed-certificate resource ID"
  fi

  if run_certificate_block \
    "CN=Drafts.Self-Hoster.Dev." \
    "$certificate_id" \
    "$other_certificate_id" \
    "Succeeded"; then
    fail "certificate verification accepted a binding to a different certificate ID"
  fi

  if run_certificate_block \
    "CN=Drafts.Self-Hoster.Dev." \
    "$certificate_id" \
    "$certificate_id" \
    "Pending"; then
    fail "certificate verification accepted a certificate that had not succeeded"
  fi
}

run_deployed_smoke_block() {
  scenario="$1"
  output="$2"

  (
    if test "$scenario" = "uppercase_origin"; then
      PUBLIC_BASE_URL="https://Drafts.Self-Hoster.Dev"
    else
      PUBLIC_BASE_URL="https://drafts.self-hoster.dev"
    fi
    CUSTOM_DOMAIN="drafts.self-hoster.dev"
    smoke_tmp_dir="$TMP_DIR/deployed-smoke-$scenario-tmp"
    curl_argv_log="$TMP_DIR/deployed-smoke-$scenario-curl-argv.log"
    caller_trap_log="$TMP_DIR/deployed-smoke-$scenario-caller-trap.log"
    caller_trap_snapshot="$TMP_DIR/deployed-smoke-$scenario-caller-traps.txt"
    rm -rf "$smoke_tmp_dir"
    : > "$curl_argv_log"
    : > "$caller_trap_log"

    mktemp() {
      test "$*" = "-d" || return 1
      mkdir -p "$smoke_tmp_dir" || return 1
      printf '%s\n' "$smoke_tmp_dir"
    }

    trap 'printf "%s\n" caller-exit >> "$caller_trap_log"' EXIT
    trap 'printf "%s\n" caller-hup >> "$caller_trap_log"' HUP
    trap 'printf "%s\n" caller-int >> "$caller_trap_log"' INT
    trap 'printf "%s\n" caller-term >> "$caller_trap_log"' TERM

    terraform() {
      test "$*" = "output -raw bootstrap_api_token"
      test "$scenario" != "token_failure" || return 1
      test "$scenario" != "token_empty" || return 0
      printf '%s\n' "test-token"
    }

    curl() {
      output_file=""
      header_file=""
      authorization_header_file=""
      url=""
      url_count=0
      request=""
      content_type=""
      data=""
      body_source_count=0
      for curl_arg do
        printf '%s\n' "$curl_arg" >> "$curl_argv_log"
        case "$curl_arg" in
          *test-token*) return 1 ;;
        esac
      done
      while test "$#" -gt 0; do
        case "$1" in
          --output)
            test -z "$output_file" || return 1
            shift
            test "$#" -gt 0 || return 1
            output_file="$1"
            ;;
          --dump-header)
            test -z "$header_file" || return 1
            shift
            test "$#" -gt 0 || return 1
            header_file="$1"
            ;;
          --request)
            test -z "$request" || return 1
            shift
            test "$#" -gt 0 || return 1
            request="$1"
            ;;
          --header)
            shift
            test "$#" -gt 0 || return 1
            case "$1" in
              @*)
                test -z "$authorization_header_file" || return 1
                authorization_header_file="${1#@}"
                ;;
              "Authorization: "*) return 1 ;;
              "Content-Type: "*)
                test -z "$content_type" || return 1
                content_type="$1"
                ;;
              *) return 1 ;;
            esac
            ;;
          --data)
            body_source_count=$((body_source_count + 1))
            test "$body_source_count" -eq 1 || return 1
            shift
            test "$#" -gt 0 || return 1
            data="$1"
            ;;
          --write-out)
            shift
            test "$#" -gt 0 || return 1
            test "$1" = '%{http_code}' || return 1
            ;;
          --proto)
            shift
            test "$#" -gt 0 || return 1
            test "$1" = '=https' || return 1
            ;;
          --silent|--show-error|--tlsv1.2)
            ;;
          http://*|https://*)
            test "$url_count" -eq 0 || return 1
            url="$1"
            url_count=1
            ;;
          *)
            return 1
            ;;
        esac
        shift
      done
      test "$url_count" -eq 1 || return 1
      case "$url" in
        */api/uploads)
          test "$body_source_count" -eq 1 || return 1
          ;;
        *)
          test "$body_source_count" -eq 0 || return 1
          ;;
      esac

      case "$url" in
        http://drafts.self-hoster.dev/healthz)
          test "$scenario" != "http_command_failure" || return 1
          test -n "$header_file" || return 1
          case "$scenario" in
            redirect_missing)
              printf 'HTTP/1.1 301 Moved Permanently\r\n\r\n' > "$header_file"
              ;;
            redirect_ambiguous)
              printf \
                'HTTP/1.1 301 Moved Permanently\r\nLocation: https://drafts.self-hoster.dev/healthz\r\nLocation: https://other.example/healthz\r\n\r\n' \
                > "$header_file"
              ;;
            redirect_mismatch)
              printf \
                'HTTP/1.1 301 Moved Permanently\r\nLocation: https://drafts.self-hoster.dev/other\r\n\r\n' \
                > "$header_file"
              ;;
            *)
              printf \
                'HTTP/1.1 301 Moved Permanently\r\nLocation: https://drafts.self-hoster.dev/healthz\r\n\r\n' \
                > "$header_file"
              ;;
          esac
          case "$scenario" in
            http_status_mismatch) printf '%s' "200" ;;
            redirect_status_302) printf '%s' "302" ;;
            redirect_status_307) printf '%s' "307" ;;
            redirect_status_308) printf '%s' "308" ;;
            *) printf '%s' "301" ;;
          esac
          ;;
        https://drafts.self-hoster.dev/healthz)
          test "$scenario" != "health_command_failure" || return 1
          test -n "$output_file" || return 1
          if test "$scenario" = "health_body_mismatch"; then
            printf '%s' '{"ok":false}' > "$output_file"
          else
            printf '%s' '{"ok":true}' > "$output_file"
          fi
          if test "$scenario" = "health_status_mismatch"; then
            printf '%s' "503"
          else
            printf '%s' "200"
          fi
          ;;
        https://drafts.self-hoster.dev/api/uploads | https://Drafts.Self-Hoster.Dev/api/uploads)
          test "$scenario" != "upload_command_failure" || return 1
          test -n "$output_file" || return 1
          test "$request" = "POST" || return 1
          test -f "$authorization_header_file" || return 1
          test "$(LC_ALL=C ls -l "$authorization_header_file" | cut -c1-10)" = \
            "-rw-------" || return 1
          test "$(cat "$authorization_header_file")" = \
            "Authorization: Bearer test-token" || return 1
          test "$content_type" = "Content-Type: application/json" || return 1
          printf '%s\n' "$data" |
            jq -e --arg marker "$SMOKE_MARKER" '
              type == "object" and
              (keys == ["filename", "html"]) and
              .filename == "azure-smoke.html" and
              .html == (
                "<!doctype html><html><head><title>Azure smoke test</title></head><body><h1>" +
                $marker +
                "</h1></body></html>"
              )
            ' >/dev/null ||
            return 1
          case "$scenario" in
            upload_invalid_json)
              printf '%s' '{not-json' > "$output_file"
              ;;
            upload_ok_mismatch)
              printf '%s' \
                '{"ok":false,"draftId":"abc123def456","publicUrl":"https://drafts.self-hoster.dev/d/abc123def456"}' \
                > "$output_file"
              ;;
            upload_draft_id_mismatch)
              printf '%s' \
                '{"ok":true,"draftId":"bad/id","publicUrl":"https://drafts.self-hoster.dev/d/bad/id"}' \
                > "$output_file"
              ;;
            upload_url_mismatch)
              printf '%s' \
                '{"ok":true,"draftId":"abc123def456","publicUrl":"https://other.example/d/abc123def456"}' \
                > "$output_file"
              ;;
            *)
              printf \
                '{"ok":true,"draftId":"abc123def456","publicUrl":"%s/d/abc123def456"}' \
                "$PUBLIC_BASE_URL" > "$output_file"
              ;;
          esac
          if test "$scenario" = "upload_status_mismatch"; then
            printf '%s' "200"
          else
            printf '%s' "201"
          fi
          ;;
        https://drafts.self-hoster.dev/d/abc123def456 | https://Drafts.Self-Hoster.Dev/d/abc123def456)
          test "$scenario" != "fetch_command_failure" || return 1
          test -n "$output_file" || return 1
          case "$scenario" in
            fetch_body_mismatch)
              printf '%s' '<html><body>wrong draft</body></html>' > "$output_file"
              ;;
            fetch_stale_marker)
              printf '%s' \
                '<html><iframe srcdoc="&lt;h1&gt;PATCHPAGE_AZURE_SMOKE_STALE&lt;/h1&gt;"></iframe></html>' \
                > "$output_file"
              ;;
            *)
              printf \
                '<html><iframe srcdoc="&lt;h1&gt;%s&lt;/h1&gt;"></iframe></html>' \
                "$SMOKE_MARKER" > "$output_file"
              ;;
          esac
          if test "$scenario" = "fetch_status_mismatch"; then
            printf '%s' "404"
          else
            printf '%s' "200"
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    smoke_block="$DEPLOYED_SMOKE_BLOCK"
    case "$scenario" in
      upload_body_header_file_mutation)
        if ! smoke_block="$(
          printf '%s\n' "$DEPLOYED_SMOKE_BLOCK" |
            awk '
              $0 == "    --data \"$UPLOAD_PAYLOAD\" \\" {
                replacements++
                print "    --data-binary \"@$AUTH_HEADER_FILE\" \\"
                next
              }
              { print }
              END { if (replacements != 1) exit 1 }
            '
        )"; then
          return 1
        fi
        ;;
      upload_duplicate_body_mutation)
        if ! smoke_block="$(
          printf '%s\n' "$DEPLOYED_SMOKE_BLOCK" |
            awk '
              $0 == "    --data \"$UPLOAD_PAYLOAD\" \\" {
                replacements++
                print
              }
              { print }
              END { if (replacements != 1) exit 1 }
            '
        )"; then
          return 1
        fi
        ;;
    esac
    eval "$smoke_block"
    smoke_status=$?
    trap > "$caller_trap_snapshot"
    mkdir -p "$smoke_tmp_dir"
    : > "$smoke_tmp_dir/reused-after-smoke"
    exit "$smoke_status"
  ) >"$output" 2>&1
}

test_deployed_smoke() {
  success_output="$TMP_DIR/deployed-smoke-success.out"
  run_deployed_smoke_block success "$success_output" ||
    fail "successful deployed smoke was rejected"
  grep -Fqx 'https://drafts.self-hoster.dev/d/abc123def456' "$success_output" ||
    fail "successful deployed smoke did not print the exact draft URL"
  if grep -Fq 'test-token' "$TMP_DIR/deployed-smoke-success-curl-argv.log"; then
    fail "successful deployed smoke exposed the bootstrap token in raw curl argv"
  fi
  grep -Fqx \
    "@$TMP_DIR/deployed-smoke-success-tmp/upload.headers" \
    "$TMP_DIR/deployed-smoke-success-curl-argv.log" ||
    fail "successful deployed smoke did not pass the spaced header-file path intact"
  grep -Fqx 'caller-exit' "$TMP_DIR/deployed-smoke-success-caller-trap.log" ||
    fail "deployed smoke overwrote the caller EXIT trap"
  for caller_signal_trap in caller-hup caller-int caller-term; do
    grep -Fq "$caller_signal_trap" \
      "$TMP_DIR/deployed-smoke-success-caller-traps.txt" ||
      fail "deployed smoke overwrote $caller_signal_trap"
  done
  test -f "$TMP_DIR/deployed-smoke-success-tmp/reused-after-smoke" ||
    fail "a stale deployed-smoke trap removed a caller-reused path"
  test ! -e "$TMP_DIR/deployed-smoke-success-tmp/upload.headers" ||
    fail "successful deployed smoke did not remove its authorization header"

  uppercase_output="$TMP_DIR/deployed-smoke-uppercase-origin.out"
  run_deployed_smoke_block uppercase_origin "$uppercase_output" ||
    fail "uppercase configured upload origin broke normalized health verification"
  grep -Fqx 'https://Drafts.Self-Hoster.Dev/d/abc123def456' "$uppercase_output" ||
    fail "uppercase configured upload origin was not asserted exactly"

  for scenario in \
    http_command_failure \
    http_status_mismatch \
    redirect_missing \
    redirect_ambiguous \
    redirect_mismatch \
    redirect_status_302 \
    redirect_status_307 \
    redirect_status_308 \
    health_command_failure \
    health_status_mismatch \
    health_body_mismatch \
    token_failure \
    token_empty \
    upload_command_failure \
    upload_body_header_file_mutation \
    upload_duplicate_body_mutation \
    upload_status_mismatch \
    upload_invalid_json \
    upload_ok_mismatch \
    upload_draft_id_mismatch \
    upload_url_mismatch \
    fetch_command_failure \
    fetch_status_mismatch \
    fetch_body_mismatch \
    fetch_stale_marker; do
    failure_output="$TMP_DIR/deployed-smoke-$scenario.out"
    if run_deployed_smoke_block "$scenario" "$failure_output"; then
      fail "deployed smoke accepted $scenario"
    fi
    if grep -Fqx \
      'https://drafts.self-hoster.dev/d/abc123def456' \
      "$failure_output"; then
      fail "deployed smoke printed success after $scenario"
    fi
    test ! -e "$TMP_DIR/deployed-smoke-$scenario-tmp/upload.headers" ||
      fail "deployed smoke retained its authorization header after $scenario"
  done
}

test_state_bootstrap
test_deploy_resources
test_custom_domain_context
test_custom_domain_output_guards
test_ingress_verification
test_hostname_mutation_guard
test_apex_dns
test_caa_policy
test_certificate_binding
test_deployed_smoke

printf 'guide_commands_test: 11 scenario groups passed\n'
