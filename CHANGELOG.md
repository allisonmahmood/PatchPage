# Changelog

All notable changes to PatchPage are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-08

Initial public release.

### Added

- `patchpage` CLI with `auth set`, `whoami`, `validate`, and `upload` commands for publishing
  static HTML drafts to a PatchPage server.
- Bundled `patchpage` agent skill for creating safe static HTML artifacts in the Patchy visual
  style and publishing them.
- Self-hosting documentation ([docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)) covering
  configuration, database migration, running the server, and minting API tokens.
