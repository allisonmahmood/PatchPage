# patchpage

Command-line uploader for [PatchPage](https://github.com/allisonmahmood/PatchPage), a self-hostable service for publishing static HTML drafts behind unlisted, link-viewable URLs. Uploads are token-gated; draft URLs are public and unlisted by default.

The CLI defaults to the host `https://post.patchyhq.com`, which is the maintainer's private instance and does not offer public token signup. To use PatchPage yourself, deploy your own server and point the CLI at it with `--api-url` or the `PATCHPAGE_API_URL` environment variable. See the [self-hosting guide](https://github.com/allisonmahmood/PatchPage/blob/main/docs/SELF_HOSTING.md).

## Install and use

Run without installing:

```sh
npx patchpage validate ./plan.html
npx patchpage auth set --api-url https://patchpage.example.com
npx patchpage upload ./plan.html
```

Or install globally:

```sh
npm install -g patchpage
patchpage upload ./plan.html
```

## Commands

### `patchpage auth set [--token-stdin] [--api-url <url>]`

Save an API token to local state. By default, `auth set` requires a terminal and reads the token from a non-echoing prompt. Pass `--api-url` to also store the base URL of a self-hosted instance, so later commands don't need the flag.

```sh
patchpage auth set --api-url https://post.example.com
```

Automation must select redirected input explicitly; a non-TTY invocation without `--token-stdin` fails:

```sh
printf '%s' "$TOKEN" | patchpage auth set --token-stdin --api-url https://post.example.com
```

### `patchpage whoami [--api-url <url>]`

Verify the stored credentials against the server. Prints the account, the token name, and the token's scopes.

```sh
patchpage whoami
# Account: Bootstrap Account (acct_bootstrap)
# API token: laptop (tok_1a2b3c...)
# Scopes: upload
```

### `patchpage validate <file>`

Validate an HTML file locally without uploading. Exits non-zero if validation fails; prints warnings otherwise.

```sh
patchpage validate ./plan.html
```

### `patchpage upload <file> [--draft <draft-id>] [--new] [--api-url <url>]`

Validate the file, then upload it. On success it prints the public URL, the draft ID, and the version number.

```sh
patchpage upload ./plan.html
# Uploaded draft
# URL: https://post.example.com/d/k7f2m9x1a3b8
# Draft ID: k7f2m9x1a3b8
# Version: 1
```

By default, uploading a file the CLI has seen before updates that same draft (a new version). Use `--new` to force a brand-new draft, or `--draft <draft-id>` to target a specific existing draft.

## Flags

- `--api-url <url>` — override the API base URL for this command (available on `auth set`, `whoami`, and `upload`).
- `--token-stdin` — on `auth set`, read exactly one non-empty token from redirected stdin. This is the explicit automation path and is rejected when stdin is a terminal.
- `--new` — on `upload`, always create a new draft instead of updating the one previously uploaded from this path.
- `--draft <draft-id>` — on `upload`, add a new version to a specific draft.

## Environment variables

- `PATCHPAGE_API_URL` — API base URL. Overrides the stored config; overridden by `--api-url`. Default: `https://post.patchyhq.com`.
- `PATCHPAGE_API_TOKEN` — API token for ordinary authenticated commands such as `whoami` and `upload`. It overrides stored credentials and is useful in CI; `auth set` does not read it.
- `PATCHPAGE_STATE_DIR` — directory for the CLI's config, credentials, and draft cache. Default: `~/.patchpage`.

## State

The CLI stores state under `~/.patchpage` (or `PATCHPAGE_STATE_DIR`):

- `config.json` — the saved API base URL.
- `credentials.json` — the saved API token. On Unix, every save creates or repairs this file to owner-only (`0600`) permissions.
- `drafts.json` — a per-path cache mapping uploaded files to their draft IDs, so re-uploading updates the same draft.

## Agent skill

This package bundles an agent skill at `skills/patchpage/SKILL.md` that teaches an assistant to produce safe static HTML artifacts in the Patchy visual style and publish them with this CLI.

## Self-hosting

See the [self-hosting guide](https://github.com/allisonmahmood/PatchPage/blob/main/docs/SELF_HOSTING.md) to deploy your own PatchPage server and mint tokens.

## License

MIT
