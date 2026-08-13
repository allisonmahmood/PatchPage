---
name: patchpage-mint-token
description: Mint PatchPage API tokens as the server operator and wire them into the CLI.
metadata:
  internal: true
triggers:
  - "mint a patchpage token"
  - "patchpage token"
  - "patchpage auth is not set up"
  - "patchpage upload is unauthorized"
---

# Minting PatchPage API Tokens

Use this skill when an agent or a new machine needs authenticated upload and update access
to a PatchPage server that the user operates. Servers require an `upload`-scoped API token
by default. An operator may opt in to anonymous creation, but anonymous callers cannot own
or update drafts, so credentials remain the path for stable per-file draft workflows.

This is an operator-side skill. It lives in the repo for people who run their own
PatchPage server; it is intentionally hidden from the public skill install
(`metadata.internal`) and is not shipped in the npm package. If your user does not operate
the target server, stop: only the server operator can issue tokens. The CLI's default host,
`https://post.patchyhq.com`, is the maintainer's private instance, does not issue public
tokens, and must not be assumed to accept anonymous uploads — self-host instead (see
`docs/SELF_HOSTING.md`).

## How token issuance works

- Every deployment has a bootstrap credential: the `PATCHPAGE_BOOTSTRAP_API_TOKEN`
  environment variable on the server becomes a real API token with `admin` and `upload`
  scopes on startup or migration.
- Any token with the `admin` scope can mint further tokens via `POST /api/tokens`.
- Minted tokens default to the `upload` scope. `admin` satisfies every scope check; grant
  it only to tokens that need to mint other tokens.
- The token value (`pp_...`) appears once, in the mint response. It is not retrievable
  later.

## Step 1 — find an admin token

Look wherever the deployment defines the server's environment. Common spots, depending on
how the operator deploys:

- a `.env` or compose file next to the server (`PATCHPAGE_BOOTSTRAP_API_TOKEN=...`)
- the hosting platform's secret store or app-settings dashboard
- infrastructure-as-code variables, outputs, or state, if the token is generated there
- a previously minted `admin`-scoped token the operator saved

Treat whatever you find as a secret: acquire it through a non-echoing prompt or directly
from the secret store, and never print it into logs, transcripts, or commits.

## Step 2 — mint, save, and verify a scoped token

Requires Node.js 22 or newer.

<!-- guide-test:operator-mint:start -->
```bash
(
set +x
API="https://patchpage.example.com" # your instance
PATCHPAGE_API_URL=$API
export PATCHPAGE_API_URL
unset PATCHPAGE_API_TOKEN
MINT_TMP_DIR=''
AUTH_HEADER_FILE=''
RESPONSE_FILE=''
MINTED_TOKEN_FILE=''
MINT_PRESERVE=false
ADMIN_TOKEN=''
NEW_TOKEN=''

mint_cleanup() {
  unset ADMIN_TOKEN NEW_TOKEN
  if test -n "$AUTH_HEADER_FILE"; then
    rm -f "$AUTH_HEADER_FILE"
  fi
  if test -n "$MINT_TMP_DIR" &&
     test "$MINT_PRESERVE" != true; then
    rm -rf "$MINT_TMP_DIR"
  fi
}
trap 'mint_cleanup' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Admin token: ' > /dev/tty
if ! IFS= read -r -s ADMIN_TOKEN < /dev/tty; then
  ADMIN_TOKEN=''
  IFS= read -r -s ADMIN_TOKEN ||
    test -n "$ADMIN_TOKEN" || {
      printf '\nCould not read the admin token.\n' > /dev/tty
      exit 1
    }
fi
printf '\n' > /dev/tty
if test -z "$ADMIN_TOKEN"; then
  printf 'The admin token must not be empty.\n' >&2
  exit 1
fi
if ! MINT_TMP_DIR="$(mktemp -d)" || ! chmod 700 "$MINT_TMP_DIR"; then
  printf 'Could not create the token-mint temporary directory.\n' >&2
  exit 1
fi
AUTH_HEADER_FILE="$MINT_TMP_DIR/auth.headers"
RESPONSE_FILE="$MINT_TMP_DIR/response.json"
MINTED_TOKEN_FILE="$MINT_TMP_DIR/minted-upload-token"
if ! (umask 077; printf 'Authorization: Bearer %s\n' \
  "$ADMIN_TOKEN" > "$AUTH_HEADER_FILE") ||
   ! chmod 600 "$AUTH_HEADER_FILE" ||
   ! (umask 077; : > "$RESPONSE_FILE") ||
   ! chmod 600 "$RESPONSE_FILE"; then
  printf 'Could not create protected token-mint files.\n' >&2
  exit 1
fi
unset ADMIN_TOKEN

if ! curl --fail --silent --show-error --request POST \
  --output "$RESPONSE_FILE" \
  --header "@$AUTH_HEADER_FILE" \
  --header "content-type: application/json" \
  --data '{"name":"laptop agent","scopes":["upload"]}' \
  "$API/api/tokens"; then
  printf 'Could not mint the scoped token.\n' >&2
  exit 1
fi
MINT_PRESERVE=true
if ! rm -f "$AUTH_HEADER_FILE"; then
  MINT_PRESERVE=false
  printf 'Could not remove the temporary administrator authorization header.\n' >&2
  exit 1
fi
AUTH_HEADER_FILE=''
if ! (umask 077; set -C; jq -er \
  '.token | select(type == "string" and length > 0)' \
  "$RESPONSE_FILE" > "$MINTED_TOKEN_FILE") ||
   ! chmod 600 "$MINTED_TOKEN_FILE"; then
  printf 'Token extraction failed. Inspect the protected response at %s\n' \
    "$RESPONSE_FILE" >&2
  exit 1
fi

NEW_TOKEN=''
IFS= read -r NEW_TOKEN < "$MINTED_TOKEN_FILE" ||
  test -n "$NEW_TOKEN" || {
    printf 'Credential handoff failed. Recover the minted token from %s\n' \
      "$MINTED_TOKEN_FILE" >&2
    exit 1
  }
if test -z "$NEW_TOKEN"; then
  printf 'Credential handoff failed. Recover the minted token from %s\n' \
    "$MINTED_TOKEN_FILE" >&2
  exit 1
fi
if printf '%s' "$NEW_TOKEN" | npx --yes patchpage auth set --token-stdin --api-url "$API"; then
  unset NEW_TOKEN
else
  auth_status=$?
  unset NEW_TOKEN
  printf 'Credential save failed. Recover the minted token from %s\n' \
    "$MINTED_TOKEN_FILE" >&2
  exit "$auth_status"
fi
if ! npx --yes patchpage whoami; then
  printf 'Credential verification failed. Recover the minted token from %s\n' \
    "$MINTED_TOKEN_FILE" >&2
  exit 1
fi
MINT_PRESERVE=false
)
```
<!-- guide-test:operator-mint:end -->

## Step 3 — retain only the saved credential

The scoped token is minted, captured, and consumed inside one `set +x` subshell, so an
inherited xtrace setting cannot print the admin token, mint response, extracted token, or
stdin handoff. The explicit stdin path keeps the token out of process arguments. Once the
server returns a token, extraction, save, or verification failure retains the protected
response or token and prints only its recovery path. Full success removes every temporary
secret.

Name tokens after the machine or agent that will hold them — one token per client keeps
revocation painless.

`whoami` calls `GET /api/me` and prints the account, token name, and scopes. Credentials
land in `~/.patchpage/credentials.json`; every save creates or repairs that file to
owner-only permissions on Unix. Omit `--api-url` only when targeting the CLI's built-in
default host.

## Revoking tokens

There is no list or revoke API endpoint yet. Revoke by setting the token's `revoked_at`
timestamp — `UPDATE api_tokens SET revoked_at = now() WHERE id = '...'` (postgres driver)
or setting `revokedAt` on its entry in the JSON state file (json driver); both drivers
read the store on every request, so the change takes effect immediately. Never DELETE the
row: `draft_versions` references it, so postgres rejects the delete for any token that has
uploaded — and revocation is a state we keep for the audit trail, not an erasure.

## Pitfalls

- Do the whole mint in one compound shell command so tokens stay in variables; `set -x`,
  echoed commands, and pasted API responses all leak them.
- The mint response is the only time the token value is visible. Capture `.token`, or mint
  a fresh one.
- Never pass a token positionally to `patchpage auth set`; use the hidden prompt for a
  person or explicit `--token-stdin` for automation.
- Tokens gate authenticated publishing, ownership, and updates. Optional anonymous access
  is create-only. Draft view URLs stay public and unlisted in either mode.
- Do not hand the bootstrap token to CLI clients; mint per-client `upload` tokens instead.
