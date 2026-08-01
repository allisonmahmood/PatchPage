# Changelog

All notable changes to PatchPage are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Azure workload Blob Storage now defaults to geo-redundant replication (`GRS`). Existing
  environments that still use `LRS` will see an in-place Storage account update on the first
  infrastructure apply after upgrade; review cost and replication behavior before approving.
  PostgreSQL flexible-server backups remain platform-local by default; configure independent
  geo-capable database backups if regional recovery is required.

## [0.1.1] - 2026-07-14

### Added

- Bundled the `patchpage-mint-token` operator skill for minting API tokens and safely
  bootstrapping CLI credentials.
- Added bounded trusted-proxy configuration for canonical client IP attribution, with safe
  direct-connection defaults and guidance for verified reverse-proxy topologies.
- Added opt-in anonymous draft creation for self-hosted servers and the CLI. It remains
  disabled by default, create-only, independently rate limited, and recorded under a
  non-authenticating audit principal.
- Configured tag-driven npm and GHCR release automation to verify exact artifacts before
  publication; build a non-root image with `/data` persistence; bind immutable SemVer and
  revision tags, plus `latest`, to one image digest; permit only bounded reconciliation; and
  require an anonymous, digest-pinned boot smoke test before declaring availability.

### Changed

- The `patchpage` CLI and server now require Node.js 22 or newer. Node 20 reached end of life
  in April 2026 and is no longer supported.
- `patchpage auth set` now reads tokens from a hidden interactive prompt or explicit
  `--token-stdin`, never a positional argument, and rejects empty, multiline, ambiguous, or
  non-interactive prompt input.
- Public quick starts now pin the intended API URL, clear inherited token overrides,
  authenticate through standard input, verify identity, validate content, and stop on any
  failure before upload.
- Azure deployment guidance and verification now cover domain-safe custom hostname and TLS
  setup, exact HTTP-to-HTTPS `301` redirects, and fail-closed detection of resource drift,
  unsafe ingress, DNS or certificate mismatches, and incorrect health, upload, or fetch
  responses.
- Release checks now install and exercise the packed npm CLI artifact end to end, so
  verification covers the package prepared for publication rather than workspace sources.

### Fixed

- JSON metadata now remains intact after interrupted writes, preserves concurrent updates
  within a process, and leaves already-corrupt data untouched.
- CLI token entry now restores terminal settings after success, end of input, interruption,
  or stream and save failures.
- Corrected the Azure Container Registry build context and Dockerfile path used by the
  deployment workflow.

### Security

- Upload handling now enforces authorization, independent authenticated and anonymous rate
  limits, and request size and shape checks before creating drafts with server-generated IDs.
- On Unix, saved CLI credential files are repaired to mode `0600`. Token bootstrap files now
  reject unsafe permissions, symbolic links, and ACL-bearing files, while credential
  workflows keep secrets out of command arguments and shell traces.
- Documented the private vulnerability-reporting process.
- Pre-release privacy checks now run before artifact output or publication and fail closed
  across approved commit and package identity, tracked names and content, npm pack metadata,
  and raw and effective gzip/tar metadata and content. Failures report only opaque categories
  and locations rather than matched private values.

## [0.1.0] - 2026-07-08

Initial public release.

### Added

- `patchpage` CLI with `auth set`, `whoami`, `validate`, and `upload` commands for publishing
  static HTML drafts to a PatchPage server.
- Bundled `patchpage` agent skill for creating safe static HTML artifacts in the Patchy visual
  style and publishing them.
- Self-hosting documentation ([docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)) covering
  configuration, database migration, running the server, and minting API tokens.
