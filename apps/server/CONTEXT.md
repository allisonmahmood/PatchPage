# Hosting

The service that receives uploads and serves published pages. Includes its supporting packages `@patchpage/db`, `@patchpage/storage`, and `@patchpage/config`.

## Language

**Self-service token**:
An auth token the server mints for anyone who asks, on instances that allow it; it controls exactly the drafts it creates.
_Avoid_: anonymous token, first-run token

**Self-service minting**:
The zero-input, server-side operation that creates a self-service token and returns its plaintext exactly once.
_Avoid_: signup, registration, anonymous uploads (retired — there is no upload without a token)

**Principal**:
The internal ownership row behind a token, one per self-service mint. Plumbing, never surfaced to users.
_Avoid_: account (in product language)
