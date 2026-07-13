#!/bin/sh

set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)"
README="$ROOT/infra/azure/README.md"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

fail() {
  printf 'guide_commands_test: %s\n' "$1" >&2
  exit 1
}

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
CUSTOM_DOMAIN_CONTEXT_BLOCK="$(extract_block custom-domain-context)"
APEX_DNS_BLOCK="$(extract_block apex-dns)"
CAA_POLICY_BLOCK="$(extract_block caa-policy)"
CERTIFICATE_BINDING_BLOCK="$(extract_block certificate-binding)"
UPLOAD_SMOKE_BLOCK="$(extract_block upload-smoke)"

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

test_hostname_mutation_guard() {
  expected_subscription="00000000-0000-0000-0000-000000000000"

  for scenario in set_failure wrong_selection success; do
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
            return 0
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
  aaaa_records="$2"

  (
    DNS_ZONE="drafts.self-hoster.dev"
    CUSTOM_DOMAIN="drafts.self-hoster.dev"
    CONTAINER_APP_STATIC_IP="203.0.113.10"
    DOMAIN_VERIFICATION_ID="verification-id"

    dig() {
      case "$2" in
        A) printf '%s\n' "$a_records" ;;
        AAAA) printf '%s\n' "$aaaa_records" ;;
        TXT) printf '%s\n' '"verification-id"' ;;
        *) return 1 ;;
      esac
    }

    eval "$APEX_DNS_BLOCK"
  ) >/dev/null 2>&1
}

test_apex_dns() {
  run_apex_block "203.0.113.10" "" || fail "exact apex A record was rejected"

  if run_apex_block "203.0.113.10
198.51.100.20" ""; then
    fail "apex DNS accepted an additional A record"
  fi

  if run_apex_block "203.0.113.10" "2001:db8::10"; then
    fail "apex DNS accepted an AAAA record"
  fi
}

run_caa_block() {
  scenario="$1"
  log="$TMP_DIR/caa-$scenario.log"
  : > "$log"

  (
    CUSTOM_DOMAIN="drafts.team.example.com"
    DNS_ZONE="example.com"

    dig() {
      name="$3"
      printf '%s\n' "$name" >> "$log"
      case "$scenario:$name" in
        allow_parent:example.com) printf '%s\n' '0 issue "digicert.com"' ;;
        deny_nearer:team.example.com) printf '%s\n' '0 issue "letsencrypt.org"' ;;
        deny_nearer:example.com) printf '%s\n' '0 issue "digicert.com"' ;;
        *) printf '%s' "" ;;
      esac
    }

    eval "$CAA_POLICY_BLOCK"
  ) >/dev/null 2>&1
}

test_caa_policy() {
  run_caa_block allow_parent || fail "inherited DigiCert CAA policy was rejected"

  expected_queries="drafts.team.example.com
team.example.com
example.com"
  if test "$(cat "$TMP_DIR/caa-allow_parent.log")" != "$expected_queries"; then
    fail "CAA lookup did not walk from the hostname to the effective parent"
  fi

  if run_caa_block deny_nearer; then
    fail "CAA lookup skipped a nearer policy that denies DigiCert"
  fi
}

run_certificate_block() {
  subject="$1"

  (
    RESOURCE_GROUP="rg-test"
    CONTAINER_APP="app-test"
    CONTAINER_APP_ENVIRONMENT="env-test"
    CUSTOM_DOMAIN="drafts.self-hoster.dev"

    az() {
      case "$*" in
        *"env certificate list"*)
          printf 'cert-one\t%s\tSucceeded\n' "$subject"
          ;;
        *"hostname list"*)
          printf 'Drafts.Self-Hoster.Dev.\tSniEnabled\t/certificates/cert-one\n'
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
  run_certificate_block "CN=Drafts.Self-Hoster.Dev." ||
    fail "normalized CN certificate subject was not matched"

  if run_certificate_block "CN=other.example.com"; then
    fail "certificate verification accepted a different subject"
  fi
}

run_upload_block() {
  fetch_status="$1"
  output="$2"

  (
    PUBLIC_BASE_URL="https://drafts.self-hoster.dev"

    terraform() {
      test "$*" = "output -raw bootstrap_api_token"
      printf '%s\n' "test-token"
    }

    curl() {
      for last_arg do :; done
      case "$last_arg" in
        */api/uploads)
          printf '%s\n' '{"publicUrl":"https://drafts.self-hoster.dev/d/draft-test"}'
          ;;
        */d/draft-test)
          return "$fetch_status"
          ;;
        *)
          return 1
          ;;
      esac
    }

    eval "$UPLOAD_SMOKE_BLOCK"
  ) >"$output" 2>&1
}

test_upload_smoke() {
  success_output="$TMP_DIR/upload-success.out"
  run_upload_block 0 "$success_output" || fail "successful upload smoke was rejected"
  grep -Fqx 'https://drafts.self-hoster.dev/d/draft-test' "$success_output" ||
    fail "successful upload smoke did not print the draft URL"

  failure_output="$TMP_DIR/upload-failure.out"
  if run_upload_block 1 "$failure_output"; then
    fail "upload smoke ignored final draft-fetch failure"
  fi
  if grep -Fqx 'https://drafts.self-hoster.dev/d/draft-test' "$failure_output"; then
    fail "upload smoke printed success after draft-fetch failure"
  fi
}

test_custom_domain_context
test_hostname_mutation_guard
test_apex_dns
test_caa_policy
test_certificate_binding
test_upload_smoke

printf 'guide_commands_test: 6 scenario groups passed\n'
