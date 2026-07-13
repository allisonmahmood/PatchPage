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
STATE_BOOTSTRAP_BLOCK="$(extract_block state-bootstrap)"
CUSTOM_DOMAIN_CONTEXT_BLOCK="$(extract_block custom-domain-context)"
APEX_DNS_BLOCK="$(extract_block apex-dns)"
CAA_POLICY_BLOCK="$(extract_block caa-policy)"
CERTIFICATE_BINDING_BLOCK="$(extract_block certificate-binding)"
UPLOAD_SMOKE_BLOCK="$(extract_block upload-smoke)"

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
        "group create"|"storage account")
          return 0
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
  for scenario in create_failure verification_failure container_missing success; do
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
      printf '%s\n' "$name" >> "$log"
      case "$1" in
        +short)
          case "$scenario:$name" in
            inherit_noerror:example.com) printf '%s\n' '0 issue "digicert.com"' ;;
            deny_nearer:team.example.com) printf '%s\n' '0 issue "letsencrypt.org"' ;;
            deny_nearer:example.com) printf '%s\n' '0 issue "digicert.com"' ;;
            *) printf '%s' "" ;;
          esac
          ;;
        +noall)
          test "$1 $2 $3 $4" = "+noall +comments +answer CAA" || return 1
          case "$scenario:$name" in
            servfail:team.example.com) status="SERVFAIL" ;;
            refused:team.example.com) status="REFUSED" ;;
            *) status="NOERROR" ;;
          esac
          printf '%s\n' ";; ->>HEADER<<- opcode: QUERY, status: $status, id: 12345"
          case "$scenario:$name" in
            inherit_noerror:example.com)
              printf '%s\n' 'example.com. 300 IN CAA 0 IsSuE "DiGiCeRt.CoM"'
              ;;
            deny_nearer:team.example.com)
              printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "letsencrypt.org"'
              ;;
            deny_nearer:example.com)
              printf '%s\n' 'example.com. 300 IN CAA 0 issue "digicert.com"'
              ;;
            unrelated:team.example.com)
              printf '%s\n' 'team.example.com. 300 IN CAA 0 iodef "mailto:security@example.com"'
              ;;
            denying:team.example.com)
              printf '%s\n' 'team.example.com. 300 IN CAA 0 issue ";"'
              ;;
            constrained_digicert:team.example.com)
              printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "digicert.com; accounturi=https://example.com/account/123"'
              ;;
            constrained_digicert_spaced:team.example.com)
              printf '%s\n' 'team.example.com. 300 IN CAA 0 issue "digicert.com ; accounturi=https://example.com/account/123"'
              ;;
            unknown_critical:team.example.com)
              printf '%s\n' \
                'team.example.com. 300 IN CAA 0 issue "digicert.com"' \
                'team.example.com. 300 IN CAA 128 unknowncritical "x"'
              ;;
          esac
          ;;
        *)
          return 1
          ;;
      esac
    }

    eval "$CAA_POLICY_BLOCK"
  ) >/dev/null 2>&1
}

test_caa_policy() {
  run_caa_block inherit_noerror || fail "inherited DigiCert CAA policy was rejected"

  expected_queries="drafts.team.example.com
team.example.com
example.com"
  if test "$(cat "$TMP_DIR/caa-inherit_noerror.log")" != "$expected_queries"; then
    fail "CAA lookup did not walk from the hostname to the effective parent"
  fi

  if run_caa_block deny_nearer; then
    fail "CAA lookup skipped a nearer policy that denies DigiCert"
  fi

  for scenario in unrelated denying constrained_digicert constrained_digicert_spaced unknown_critical; do
    if run_caa_block "$scenario"; then
      fail "CAA lookup accepted the $scenario policy"
    fi
  done

  for scenario in servfail refused; do
    if run_caa_block "$scenario"; then
      fail "CAA lookup continued after DNS $scenario"
    fi
    expected_failure_queries="drafts.team.example.com
team.example.com"
    if test "$(cat "$TMP_DIR/caa-$scenario.log")" != "$expected_failure_queries"; then
      fail "CAA lookup walked to a parent after DNS $scenario"
    fi
  done
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

test_state_bootstrap
test_custom_domain_context
test_hostname_mutation_guard
test_apex_dns
test_caa_policy
test_certificate_binding
test_upload_smoke

printf 'guide_commands_test: 7 scenario groups passed\n'
