# middleware/

Request middleware for authentication, validation, rate limiting, and error handling.

## Files

| File                          | What                                                                                                                                                                                                                                                          | When to read                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `auth.ts`                     | Permission checks for API endpoints                                                                                                                                                                                                                           | Gating an endpoint on a permission                                |
| `forward-auth.ts`             | Forward-auth identity from trusted-proxy headers (`USERHEADER`, `GROUPHEADER`; only with `FORWARD_AUTH_ENABLED` and only from `TRUSTED_PROXY_IPS`, see `identityHeaderVerdict`); one of the sign-in methods next to OIDC, built-in accounts and bearer tokens | Debugging forward auth or the dev `DEFAULT_USER` fallback         |
| `csrf.ts`                     | CSRF origin checks                                                                                                                                                                                                                                            | Changing which requests need a same-origin check                  |
| `feature-flag.ts`             | Feature-flag route gate (404 when the feature is off)                                                                                                                                                                                                         | Hiding a route behind a feature flag                              |
| `immutable-asset-fallback.ts` | Serves hashed client assets from previous builds so tabs left open across a deploy keep working                                                                                                                                                               | Stale-asset 404s after an update                                  |
| `error-handler.ts`            | Global error handler wrapper (`withErrorHandler`)                                                                                                                                                                                                             | Adding error handling to API routes or services                   |
| `id-resolution.ts`            | Media ID resolution middleware (UUID/external ID conversion)                                                                                                                                                                                                  | Building endpoints that accept multiple ID formats                |
| `validate.ts`                 | Zod schema validation middleware (`withValidation`)                                                                                                                                                                                                           | Adding request body validation to API routes                      |
| `library-access.ts`           | Library group permission gate (`withLibraryAccess`)                                                                                                                                                                                                           | Adding library access checks to media item routes                 |
| `media-access.ts`             | Combined library + age-rating gate (`withMediaAccess`, `withAgeGate`, `checkMediaAccess`)                                                                                                                                                                     | Gating playback/jellyfin routes; age gate alone via `withAgeGate` |
| `valkey-rate-limit.ts`        | Valkey-based rate limiting middleware                                                                                                                                                                                                                         | Implementing rate limits on API endpoints                         |

## Tests

| File                        | What                            | When to read                                 |
| --------------------------- | ------------------------------- | -------------------------------------------- |
| `auth.test.ts`              | Auth middleware unit tests      | Debugging auth logic or adding auth features |
| `library-access.test.ts`    | Library access middleware tests | Debugging permission gates or access control |
| `valkey-rate-limit.test.ts` | Rate limiter unit tests         | Debugging rate limiting or adjusting limits  |

## Auth and HTTP traps

- **Never add `export const OPTIONS` to an `/api/v1` route for CORS.** A preflight carries no
  credential, and the `/api/v1` gate in `hooks.server.ts` rejects it before routing, so the handler
  never runs. CORS is answered centrally there (`corsAllowedMethods()`, `applyCorsGrant()`): re-apply
  the grant on every early return (a 401 without it reaches the app as an opaque network error), name
  `Authorization` and `Range` in the allowed headers, gate on `CORS_ALLOWED_ORIGINS` instead of `*`,
  and send `Vary: Origin`.
- **Declaring a def public does not make it reachable.** Every `/api/v1` request also passes
  `isApiV1RequestAuthorized` (`hooks.server.ts`) and the gate in `forward-auth.ts`; neither reads the
  def. A new unauthenticated `/api/v1` endpoint must be added to both, ideally through one shared
  matcher like `isPushRichSignedPath` (`utils/push-rich-paths.ts`), so the two cannot drift. After
  deploying one, call it without credentials and check the error kind: your handler's rejection, not
  the gate's 401. `kind: 'public'` means "no mount-level check", not "open to the internet".
- **Find where a def is mounted before you trust its header comment.** Run
  `grep -rn "defs/<name>" src/routes/`. A def commented "internal only" can also be mounted on
  `/api/v1`. `visibility: 'internal'` does not decide that; derive surface-dependent URLs from
  `ctx.surface`.
- **The internal `/api/*` surface has no anonymous state.** Blank forward-auth identity headers
  resolve to the configured default user, who is an admin. A test expecting 401 there can never
  pass; assert unauthenticated behaviour on `/api/v1/*`.
- **The CSRF guard treats a missing `Content-Type` as a form post.** Body-less cookie requests
  are blocked on purpose, but a request that carries its own `Authorization` header skips the check
  (`csrf.ts`), because a cross-site page cannot set that header without a preflight. Native clients
  that send body-less bearer `POST`s rely on this. When a client hangs with no error, search the
  server log for CSRF 403s in its time window.
- **Form actions and `__data.json` skip layout loads.** A redirect in a `+layout.server.ts` protects
  the plain page render only. Gate in `hooks.server.ts` by `route.id` (see `auth/admin-route-gate.ts`
  and `admin/admin-action-gate.ts`), or in every load and action. A page load that awaits `parent()`
  is covered. For a new privileged surface, add a test that walks every route or action and expects
  a rejection for a plain user (`routes/admin/admin-actions-require-admin.test.ts`).
- **Case-fold every username comparison.** Forward-auth stores usernames folded, while callers pass
  whatever case the client sent. Never compare two usernames with `===`; fold both sides, and seed
  test users in the folded form. Folding a map key means keeping the original case wherever it names
  a file or a tracker.
- **`checkMediaAccess` is not an existence check.** For an admin or an unrestricted user it returns
  `true` for any id, including one that does not exist. The id then reaches a write and fails with
  a foreign-key error (`23503`) or an invalid-UUID error (`22P02`), which becomes a 500 and makes a
  retrying client loop. If a route documents 404 for an unknown id, catch those two codes and map
  them, and answer 404 for denied access too so existence is not leaked. Probe the deployed
  endpoint with a random UUID; mocked gates hide this.
- **Keep the response `Link` header small.** SvelteKit adds one `link` entry per preloaded
  module to page responses, which can exceed a reverse proxy's header buffer (often 4 to 16 KB);
  the proxy then answers 502 while the app logged 200, and only signed-in pages are affected.
  `stripPagePreloadLinkHeader` in `hooks.server.ts` removes it, and
  `tests/response-header-budget.api.spec.ts` pins the budget. SvelteKit's `preload` option cannot do
  this, because it also drops the HTML preload tags.
