set -u
set +x
private_dig() {
  dig "$@" 2>/dev/null
}
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
        printf 'CAA lookup encountered a CNAME loop.\n' >&2
        exit 1
        ;;
    esac
    CAA_CNAME_SEEN="$CAA_CNAME_SEEN$CAA_QUERY_NAME|"
    CAA_CNAME_HOPS=$((CAA_CNAME_HOPS + 1))
    if test "$CAA_CNAME_HOPS" -gt 16; then
      printf 'CAA lookup exceeded the maximum CNAME depth.\n' >&2
      exit 1
    fi

    if ! CNAME_RESPONSE="$(
      private_dig +noall +comments +answer CNAME "$CAA_QUERY_NAME"
    )"; then
      printf 'CNAME lookup failed during CAA evaluation.\n' >&2
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
      printf 'CNAME lookup returned an unexpected DNS status during CAA evaluation.\n' >&2
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
      printf 'CNAME lookup returned malformed or unexpected answer data.\n' >&2
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
          printf 'CAA lookup received an empty CNAME target.\n' >&2
          exit 1
        fi
        CAA_QUERY_NAME="$CNAME_TARGET"
        ;;
      *)
        printf 'CAA lookup received ambiguous CNAME targets.\n' >&2
        exit 1
        ;;
    esac
  done

  if ! CAA_RESPONSE="$(
    private_dig +noall +comments +answer CAA "$CAA_QUERY_NAME"
  )"; then
    printf 'CAA lookup failed.\n' >&2
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
    printf 'CAA lookup returned an unexpected DNS status.\n' >&2
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
    printf 'CAA lookup returned malformed CAA record data.\n' >&2
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
  printf 'CAA policy verification passed.\n'
else
  printf 'No inherited CAA policy was found.\n'
fi
