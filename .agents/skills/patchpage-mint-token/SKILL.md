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

Treat whatever you find as a secret: keep it in a shell variable and never print it into
logs, transcripts, or commits.

## Step 2 — mint a scoped token

```bash
API="https://patchpage.example.com"   # your instance
ADMIN_TOKEN="pp_..."                  # from step 1 — do not echo this

NEW_TOKEN=$(curl -sS -X POST "$API/api/tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"laptop agent","scopes":["upload"]}' | jq -r '.token')
```

Name tokens after the machine or agent that will hold them — one token per client keeps
revocation painless.

## Step 3 — save and verify

On the machine that will upload:

```bash
printf '%s' "$NEW_TOKEN" | npx patchpage auth set --token-stdin --api-url "$API"
npx patchpage whoami
```

The explicit stdin path keeps `$NEW_TOKEN` out of process arguments; automation must not
use redirected stdin without `--token-stdin`.

`whoami` calls `GET /api/me` and prints the account, token name, and scopes. Credentials
land in `~/.patchpage/credentials.json`; every save creates or repairs that file to
owner-only permissions on Unix. Omit `--api-url` only when targeting the CLI's built-in
default host.

## Revoking tokens

There is no list or revoke API endpoint yet. Remove the token's row from the `api_tokens`
table (postgres driver) or its entry in the JSON state file (json driver); both drivers
read the store on every request, so the change takes effect immediately.

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
