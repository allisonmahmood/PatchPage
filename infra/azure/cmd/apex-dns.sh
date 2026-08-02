set -u
set +x
private_dig() {
  dig "$@" 2>/dev/null
}
DNS_ZONE="${DNS_ZONE:?Set DNS_ZONE to the apex DNS zone you control}"
DNS_ZONE="$(printf '%s\n' "$DNS_ZONE" | sed 's/\.$//' | tr '[:upper:]' '[:lower:]')"

if test "$CUSTOM_DOMAIN" != "$DNS_ZONE"; then
  printf 'DNS_ZONE is not the configured apex hostname.\n' >&2
  exit 1
fi

if ! ACTUAL_A_RECORDS="$(private_dig +short A "$CUSTOM_DOMAIN")"; then
  printf 'The apex A lookup failed.\n' >&2
  exit 1
fi
ACTUAL_A_RECORDS="$(
  printf '%s\n' "$ACTUAL_A_RECORDS" |
    sed '/^$/d' |
    LC_ALL=C sort -u
)"
if test "$ACTUAL_A_RECORDS" != "$CONTAINER_APP_STATIC_IP"; then
  printf 'The apex A RRset does not contain only the expected address.\n' >&2
  exit 1
fi

if ! AAAA_RESPONSE="$(
  private_dig +noall +comments +answer AAAA "$CUSTOM_DOMAIN"
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
  printf 'The apex AAAA lookup returned an unexpected DNS status.\n' >&2
  exit 1
fi

ACTUAL_AAAA_RECORDS="$(
  printf '%s\n' "$AAAA_RESPONSE" |
    awk '$1 !~ /^;/ && toupper($4) == "AAAA" { print }'
)"
if test -n "$ACTUAL_AAAA_RECORDS"; then
  printf 'The apex must not publish an AAAA record.\n' >&2
  exit 1
fi

ACTUAL_VERIFICATION_ID="$(private_dig +short TXT "asuid.$CUSTOM_DOMAIN" | tr -d '"')"
if ! printf '%s\n' "$ACTUAL_VERIFICATION_ID" | grep -Fqx -- "$DOMAIN_VERIFICATION_ID"; then
  printf 'The asuid TXT record has not propagated with the expected value.\n' >&2
  exit 1
fi

VALIDATION_METHOD="HTTP"
