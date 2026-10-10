# Publishing

The `npx patchpage` package and its bundled skill — the tool agents use to put pages up. An agent, not a human, is the expected operator; the CLI's output is its interface.

## Language

**Instance**:
A PatchPage server that drafts are published to, identified by its API URL. The official instance is the default; self-hosted instances are first-class. A token and a cached draft each belong to exactly one instance.
_Avoid_: the server (ambiguous with the hosting codebase), host, backend

**Auto-mint**:
The publishing flow's act of requesting a self-service token from the target instance when it holds no token for that instance, announcing the mint as it happens. Never silent, and never triggered while any token is configured — a rejected token is an error, not a reason to mint again.
_Avoid_: anonymous upload (retired), silent fallback, registration

**State dir**:
The per-user directory where the CLI keeps everything it remembers between runs: instance choice, credentials, the draft cache, and the default style.
_Avoid_: config directory, dotfiles

**Default style**:
The user-level style preference captured during onboarding and kept in the state dir; it applies whenever a project does not declare its own house style.
_Avoid_: house style (a project's own style, which overrides it), theme, template

**Mint announcement**:
The line the publishing flow prints when auto-mint fires: which instance, where the token was saved, and how to keep an existing identity instead. It is the signal an agent relays to the user, and the lazy cue to suggest onboarding.
_Avoid_: warning (it reports success, not a problem)

**Onboarding**:
The agent-led first-time setup conversation — one question capturing the default style, then publishing the welcome draft. Hosting is assumed to be the official instance and never asked; the own-instance path opens only when the user asserts their own deployment. Asked for by the setup prompt, or suggested after a mint announcement; always optional.
_Avoid_: signup, registration, setup wizard

**Setup prompt**:
The copy-paste block on the website and README that a user hands their agent to get started: install the skill, run onboarding through to the welcome draft, and establish the "make this a PatchPage" habit. Its onboarding sentence is the sole primary trigger — installing the skill runs nothing by itself. Written to be readable by the human pasting it, so it doubles as a plain description of what they are authorizing.
_Avoid_: install snippet (older internal name), install command (only one of its parts)

**Publishing key**:
What an auth token is called in front of the user — "your publishing key, saved on this machine". *Token*, *instance*, and *mint* stay out of user-facing copy except on the own-instance path, where operator vocabulary is correct.
_Avoid_: token (in user-facing copy), password, account

**Draft cache**:
The per-instance record linking a local file to the draft it produced, so republishing the same file updates that draft instead of creating a new one.
_Avoid_: upload history, manifest

**Onboarding probe**:
The local-only report of what publishing state this machine already holds for the resolved instance — `status --json`. Onboarding reads it once to skip questions it can already answer; it reaches no instance, and it answers rather than passing or failing, so it is never a per-session check.
_Avoid_: health check, status check, doctor, preflight
