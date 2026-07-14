# patchpage

Command-line uploader for [PatchPage](https://github.com/allisonmahmood/PatchPage), a self-hostable service for publishing static HTML drafts behind unlisted, link-viewable URLs. Self-hosted servers require upload tokens by default and may opt in to anonymous creation; draft viewer URLs are public and unlisted in either mode.

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

### `patchpage upload <file> [--draft <draft-id>] [--new] [--anonymous] [--api-url <url>]`

Validate the file, then upload it. On success it prints the public URL, the draft ID, and the version number.

```sh
patchpage upload ./plan.html
# Uploaded draft
# URL: https://post.example.com/d/k7f2m9x1a3b8
# Draft ID: k7f2m9x1a3b8
# Version: 1
```

Credential selection is deterministic: `--anonymous` bypasses all credentials; otherwise `PATCHPAGE_API_TOKEN` wins over the stored token; when neither exists, the CLI automatically attempts an anonymous create. Authenticated uploads keep the per-file draft cache and update behavior. Anonymous uploads always omit `draftId`, ignore cached IDs, and do not write results to the update cache. A server accepts them only when its operator has explicitly enabled anonymous uploads; self-hosting defaults to disabled, and this documentation does not claim the maintainer's hosted instance has enabled them.

With credentials, uploading a file the CLI has seen before updates that same draft (a new version). If that cached draft is unavailable, the upload fails; pass `--new` to create a brand-new draft with a server-generated ID. `--draft <draft-id>` is update-only: it can add a version to an existing active draft owned by your account, but it never creates a draft at a caller-chosen ID. Unknown, unavailable, or unowned targets fail with the same generic update error. `--draft` cannot be used in anonymous mode, and authentication failures are never retried anonymously. `--new` can be combined with `--anonymous`.

## Flags

- `--api-url <url>` — override the API base URL for this command (available on `auth set`, `whoami`, and `upload`).
- `--token-stdin` — on `auth set`, read exactly one non-empty token from redirected stdin. This is the explicit automation path and is rejected when stdin is a terminal.
- `--new` — on `upload`, always create a new draft with a server-generated ID instead of updating the one previously uploaded from this path. It cannot be combined with `--draft`.
- `--draft <draft-id>` — on `upload`, update a specific existing draft. This is update-only and never creates a new draft. It cannot be combined with `--new`.
- `--anonymous` — on `upload`, bypass environment and stored credentials and force a create-only request. It cannot be combined with `--draft`.

## Environment variables

- `PATCHPAGE_API_URL` — API base URL. Overrides the stored config; overridden by `--api-url`. Default: `https://post.patchyhq.com`.
- `PATCHPAGE_API_TOKEN` — API token for ordinary authenticated commands such as `whoami` and `upload`. It overrides stored credentials and is useful in CI; `auth set` does not read it. When neither it nor a stored token exists, `upload` attempts anonymous creation.
- `PATCHPAGE_STATE_DIR` — directory for the CLI's config, credentials, and draft cache. Default: `~/.patchpage`.

## State

The CLI stores state under `~/.patchpage` (or `PATCHPAGE_STATE_DIR`):

- `config.json` — the saved API base URL.
- `credentials.json` — the saved API token. On Unix, every save creates or repairs this file to owner-only (`0600`) permissions.
- `drafts.json` — a per-path cache mapping authenticated uploads to their draft IDs, so later authenticated uploads update the same draft. Anonymous uploads neither consume nor update this cache.

## Agent skill

This package bundles an agent skill at `skills/patchpage/SKILL.md` that teaches an assistant to produce safe static HTML artifacts in the Patchy visual style and publish them with this CLI.

## Self-hosting

See the [self-hosting guide](https://github.com/allisonmahmood/PatchPage/blob/main/docs/SELF_HOSTING.md) to deploy your own PatchPage server and mint tokens.

## Security

Report vulnerabilities privately by following the [PatchPage security policy](https://github.com/allisonmahmood/PatchPage/blob/main/SECURITY.md).

## License

MIT
