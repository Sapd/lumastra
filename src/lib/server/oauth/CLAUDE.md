# oauth/

OAuth 2.0, Personal Access Tokens (PATs), service tokens, and JWT authentication.

## Files

| File                              | What                                                 | When to read                       |
| --------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| `device-code.service.ts`          | OAuth device code flow (TV/device authentication)    | Implementing device authentication |
| `index.ts`                        | OAuth module exports                                 | Importing OAuth services           |
| `jellyfin-permissions.service.ts` | Jellyfin permission syncing (user roles)             | Syncing permissions with Jellyfin  |
| `jellyfin-token.service.ts`       | Jellyfin token management (per-user tokens)          | Managing Jellyfin API tokens       |
| `jwt.ts`                          | JWT token creation and verification                  | Creating or validating JWTs        |
| `pat.service.ts`                  | Personal Access Token service (creation, validation) | Implementing PAT authentication    |
| `refresh-token.service.ts`        | OAuth refresh token rotation                         | Implementing token refresh flow    |
| `service-token.service.ts`        | Service token management (server-to-server auth)     | Using service tokens               |
| `streaming-session.service.ts`    | Streaming session tokens (short-lived playback)      | Authenticating streaming sessions  |

## Tests

| File                                | What                          | When to read                      |
| ----------------------------------- | ----------------------------- | --------------------------------- |
| `api-tokens.integration.test.ts`    | API token integration tests   | Testing token flows end-to-end    |
| `api-tokens.validation.test.ts`     | API token validation tests    | Testing token validation logic    |
| `jwt.test.ts`                       | JWT unit tests                | Testing JWT creation/verification |
| `pat.service.test.ts`               | PAT service tests             | Testing PAT functionality         |
| `service-token.service.test.ts`     | Service token tests           | Testing service token logic       |
| `streaming-session.service.test.ts` | Streaming session token tests | Testing streaming auth            |

## `disabled_at` — every token→user resolution must honour it

`users.disabled_at` is a hard, local kill-switch (see `base-schema.ts` and
`users.queries.ts` `setUserDisabled`). It is NOT limited to native
login/sessions or the forward-auth cookie path — **every** place that resolves
a token/credential to a user identity must deny when the resolved user is
disabled, with the same failure shape as "unknown credential" (no
enumeration): `pat.service.ts` `validate()`, `service-token.service.ts` (both
the `act_as_user` impersonation lookup and the non-impersonating token's
`owner_user_id` owner, checked by id in `validate()`), the JWT bearer
path in `forward-auth.ts` (via its `isUsernameDisabled()` helper, cache-first
with a DB fallback), the device-code and refresh-token grants in
`routes/oauth/token/+server.ts`, and the proprietary `/j` and Subsonic compat
auth paths (`jellyfin-client-passwords.queries.ts` `getPasswordByUsername`,
`subsonic-client-passwords.queries.ts` `getTokenByUsername`/`getTokenByValue`,
and the `/j` middleware's live re-check). A new token type or resolution path
added to this directory needs the same predicate — see security review
2026-09-13, C2.

`credential-revocation.service.ts` (`src/lib/server/services/`) is the
companion fan-out: on disable / admin password-reset / self password-change /
delete, it revokes every credential class a user holds (native sessions,
refresh tokens, PATs, Jellyfin OAuth device tokens, service-token
impersonation grants, /j sessions, Subsonic token) so a still-valid credential
minted BEFORE the disable can't simply keep working until this predicate
happens to be consulted.
