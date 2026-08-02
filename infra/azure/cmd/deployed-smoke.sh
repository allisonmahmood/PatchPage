set -u
(
set +x
private_terraform() {
  terraform "$@" 2>/dev/null
}
. "${PP_OPS_LIB:?run this through the dispatcher: sh infra/azure/ops.sh deployed-smoke}/wrappers.sh"
if test -n "${CANARY_RECORD:-}"; then
  case "$CANARY_RECORD" in
    /*) ;;
    *)
      printf 'CANARY_RECORD must be an absolute private path outside the repository.\n' >&2
      exit 1
      ;;
  esac
  CANARY_RECORD_NAME="${CANARY_RECORD##*/}"
  CANARY_RECORD_PARENT="${CANARY_RECORD%/*}"
  test -n "$CANARY_RECORD_PARENT" || CANARY_RECORD_PARENT="/"
  if ! printf '%s\n' "$CANARY_RECORD_NAME" |
    grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' ||
    ! CANARY_RECORD_PARENT="$(
      CDPATH= cd -- "$CANARY_RECORD_PARENT" 2>/dev/null && pwd -P
    )"; then
    printf 'CANARY_RECORD must have an existing private parent and safe filename.\n' >&2
    exit 1
  fi
  CANARY_RECORD="$CANARY_RECORD_PARENT/$CANARY_RECORD_NAME"
  if ! REPO_ROOT="$(private_git rev-parse --show-toplevel)" ||
    ! REPO_ROOT="$(CDPATH= cd -- "$REPO_ROOT" 2>/dev/null && pwd -P)"; then
    printf 'Could not locate the canonical repository root for CANARY_RECORD.\n' >&2
    exit 1
  fi
  case "$CANARY_RECORD" in
    "$REPO_ROOT" | "$REPO_ROOT"/*)
      printf 'CANARY_RECORD must remain outside the repository.\n' >&2
      exit 1
      ;;
  esac
  if test -L "$CANARY_RECORD" ||
    { test -e "$CANARY_RECORD" && ! test -f "$CANARY_RECORD"; }; then
    printf 'CANARY_RECORD must be absent or an existing regular file, never a directory or symbolic link.\n' >&2
    exit 1
  fi
  unset CANARY_RECORD_NAME CANARY_RECORD_PARENT REPO_ROOT
fi
if ! SMOKE_TMP_DIR="$(mktemp -d)"; then
  printf 'Could not create a temporary directory for the deployed smoke.\n' >&2
  exit 1
fi
UPLOAD_HEADER_FILE=''
CANARY_RECORD_TEMP=''
SMOKE_MARKER="PATCHPAGE_AZURE_SMOKE_${SMOKE_TMP_DIR##*/}"

smoke_cleanup() {
  unset BOOTSTRAP_API_TOKEN
  if test -n "$CANARY_RECORD_TEMP"; then
    rm -f -- "$CANARY_RECORD_TEMP" 2>/dev/null
  fi
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
  private_curl --silent --show-error \
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
  smoke_fail 'The HTTP redirect Location did not match the expected private URL.'
fi

if ! HTTPS_HEALTH_STATUS="$(
  private_curl --proto '=https' --tlsv1.2 \
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
  smoke_fail 'The HTTPS health response body was unexpected.'
fi

if ! BOOTSTRAP_API_TOKEN="$(private_terraform output -raw bootstrap_api_token)"; then
  smoke_fail 'Could not read the bootstrap API token from Terraform.'
fi
if test -z "$BOOTSTRAP_API_TOKEN"; then
  smoke_fail 'Terraform returned an empty bootstrap API token.'
fi
UPLOAD_HEADER_FILE="$SMOKE_TMP_DIR/upload.headers"
if ! (umask 077 && printf 'Authorization: Bearer %s\n' \
  "$BOOTSTRAP_API_TOKEN" > "$UPLOAD_HEADER_FILE") 2>/dev/null ||
   ! chmod 600 "$UPLOAD_HEADER_FILE"; then
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
  private_curl --proto '=https' --tlsv1.2 \
    --silent --show-error \
    --output "$SMOKE_TMP_DIR/upload.json" \
    --write-out '%{http_code}' \
    --request POST \
    --header "@$UPLOAD_HEADER_FILE" \
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
  private_curl --proto '=https' --tlsv1.2 \
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

if test -n "${CANARY_RECORD:-}"; then
  if ! CANARY_RECORD_TEMP="$(
    mktemp "${CANARY_RECORD}.tmp.XXXXXX" 2>/dev/null
  )" ||
    ! chmod 600 "$CANARY_RECORD_TEMP" 2>/dev/null; then
    smoke_fail 'Could not create the private canary record.'
  fi
  if ! (umask 077 && printf 'CANARY_URL=%s\nCANARY_MARKER=%s\n' \
    "$DRAFT_URL" "$SMOKE_MARKER" > "$CANARY_RECORD_TEMP") 2>/dev/null ||
    ! mv -f -- "$CANARY_RECORD_TEMP" "$CANARY_RECORD" 2>/dev/null; then
    smoke_fail 'Could not write the private canary record.'
  fi
  CANARY_RECORD_TEMP=''
fi
printf 'Deployed smoke passed.\n'
)
