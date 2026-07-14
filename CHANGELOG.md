# Changelog

All notable changes to PatchPage are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Bounded trusted-proxy configuration for canonical client IP attribution, with safe direct
  defaults and deployment guidance for verified reverse-proxy topologies.
- Release automation for the intended supported
  `ghcr.io/allisonmahmood/patchpage-server` image, with immutable version and commit tags,
  a moving `latest` tag, a non-root runtime, and `/data` persistence.
- Opt-in anonymous draft creation for self-hosted servers and the CLI, disabled by default,
  create-only, independently rate limited, and backed by a non-authenticating audit principal.

### Changed

- The `patchpage` CLI and server now require Node.js 22 or newer. Node 20 reached
  end-of-life in April 2026 and is no longer supported.

## [0.1.0] - 2026-07-08

Initial public release.

### Added

- `patchpage` CLI with `auth set`, `whoami`, `validate`, and `upload` commands for publishing
  static HTML drafts to a PatchPage server.
- Bundled `patchpage` agent skill for creating safe static HTML artifacts in the Patchy visual
  style and publishing them.
- Self-hosting documentation ([docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)) covering
  configuration, database migration, running the server, and minting API tokens.
