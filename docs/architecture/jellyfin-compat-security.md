# Jellyfin-compat (`/j`) & Subsonic (`/subsonic`) — security posture

> **Audience:** maintainers and operators. This documents _why_ the Jellyfin /
> Subsonic compatibility surfaces are reachable without the central auth gate,
> what the residual security disadvantages are, and the compensating controls
> that bound them. It is the reference for the deliberate compatibility trade-offs.

## TL;DR

The compat layers (`/j/*` for Jellyfin clients, `/subsonic/*` for OpenSubsonic
clients) are the **only** route prefixes that bypass the central forward-auth
gate. They have to: third-party clients authenticate _per request_ using their
own protocols (Emby token header, `api_key` query param, Subsonic `u/t/s`), not
via the SvelteKit session cookie or a forward-auth header that the
gate understands. Everything else (`/api/*`, all pages) still **fails closed**
at the gate. Within the compat surface, auth correctness is enforced **per
route** instead of centrally, which is the core disadvantage — mitigated by the
controls below.

## Why these surfaces can't use the central gate

`resolveAuth()` (`src/lib/server/middleware/forward-auth.ts`) dispatches by URL
prefix. For `/j/*` and `/subsonic/*` it returns `undefined` (pass-through) —
**no central authentication** — because:

- **Jellyfin clients** (Swiftfin, Streamyfin, Infuse, Android TV, Jellyseerr)
  send credentials as an `X-Emby-Authorization` / `Authorization` header _or_ as
  an `api_key` / `token` query parameter (AVPlayer/HLS can't set headers, so the
  token rides in the URL). The central gate only understands the session cookie
  and trusted forward-auth headers, so it would reject every legitimate client.
- **Subsonic clients** send `u` + (`t`+`s` token/salt | `p` password | `apiKey`)
  as query params on every request.
- **Image and HLS-segment requests are issued by headerless `<img>` tags and
  media players**, which cannot carry a session cookie or bearer header at all.

So each compat route must self-authenticate. The shared primitives are
`withJellyfinAuth` (`src/lib/server/jellyfin-compat/middleware.ts`)
and `parseSubsonicAuth` / `validateApiKey`
(`src/lib/server/subsonic-compat/`).

## Cross-origin Jellyfin clients

`compat/jellyfin-cors.ts` grants browser cross-origin API access only when an
administrator opts in with `JELLYFIN_COMPAT_CORS_ORIGINS` (Admin → Settings →
Connections → Jellyfin, or the environment). The default is an empty list:
no CORS headers and OPTIONS follows ordinary routing (normally 405). Native
clients and browsers hosted on the server's own origin need no grant. This
replaces the previous unconditional wildcard grant; existing installations
without an explicit value now have CORS disabled.

Configure comma-separated exact HTTP(S) origins, e.g.
`https://web.example,https://web2.example:8443`, without paths or trailing slashes.
Matching includes scheme and port; subdomains and opaque `null` origins are not
implicitly trusted. An explicit `*` grants every origin. Allowed origins receive
204 preflights permitting Jellyfin authorization, content-type and range headers;
API errors and media responses carry the same origin grant, expose range,
length, ETag and retry headers, and vary by Origin. Denied origins receive no
grant. `Access-Control-Allow-Credentials` is never sent. The feature kill switch
returns 404 even for allowed preflights.

Opt-in also exposes cross-origin login endpoints to each allowed origin. With
`*`, **any website can attempt logins and trigger account lockouts**. Prefer an
exact origin for a separately hosted jellyfin-web. CORS controls what browsers
can read; it does not replace authentication, login rate limits or network access
controls. This setting is independent of native API CORS settings.

This grant is safe only while `/j` stays **cookie-blind**: `resolveAuth()`
passes through before native-session or forward-auth resolution, and
`withJellyfinAuth` requires an explicit Jellyfin session token or eligible PAT.
A native/OIDC cookie, even with a populated native identity, cannot authorize
any protected `/j` handler. Play/file tokens remain explicit credentials.
Do not add native-cookie authentication to `/j`; it is exempt from the cookie
CSRF origin guard precisely because browsers cannot supply its credentials
ambiently. Other surfaces retain their existing CORS and CSRF policies.

Caller-state `/Users/{userId}/...` aliases (`PlayedItems`, `FavoriteItems`,
`PlayingItems`, `Items` including scoped listings/UserData, and personalized
`Suggestions`) check the path against the authenticated caller (both compact
and hyphenated UUIDs); only an admin principal may use a foreign path.
Caller-scoped alias handlers continue to act for that caller. This shared check
does not cover user images: authenticated clients may read other users' avatars
for user pickers and Watch Together, with private caching and the existing
anonymous silhouette behavior. User DTO, configuration and password handlers
keep their own authorization checks.

## Inherent disadvantages

1. **No central fail-closed backstop.** A `/j` route that forgets
   `withJellyfinAuth` runs for an anonymous caller. (The `/api/*` tree cannot
   have this class of bug — the gate 401s it regardless.)
2. **Internet-reachable by design.** When the deployment is internet-exposed,
   the whole compat surface is reachable by anyone, not just LAN clients.
3. **Intentionally-public discovery endpoints.** A few endpoints _must_ answer
   unauthenticated to let a client connect at all (server handshake, branding,
   `<img>` artwork). These cannot be locked without breaking clients.
4. **Protocol-mandated fingerprinting.** Jellyfin clients verify they are
   talking to a Jellyfin server (name, version, id). We must emulate those, so
   the server is identifiable as Lumastra-emulating-Jellyfin. This is
   unavoidable for compatibility.

## Compensating controls (what we do about it)

| Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Where                                                                                                                                                                    | Mitigates                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `withJellyfinAuth` on **every** data / streaming route — accepts header **or** `api_key`/`token`/`ApiKey` query param                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `jellyfin-compat/middleware.ts`                                                                                                                                          | #1 — anonymous reads of catalog/user/stream data  |
| **HLS segments require auth + play-session ownership.** `/j/Videos/[id]/hls/[...path]` is wrapped in `withJellyfinAuth({pat:'deny'})` and passes the authenticated username to `verifyPlaySessionOwnership` — a `PlaySessionId` whose `play_sessions` row exists and is owned by a _different_ user gets 404. The playlist propagates `api_key` into segment URLs, so this is transparent to clients. **Accepted caveat:** the request is always authenticated, but in the brief warm-up window before the `play_sessions` row is written, ownership can't be checked and the segment is allowed (native HLS aborts the whole rendition on a 404). Residual: an _authenticated_ user who learns another user's live `PlaySessionId` (unguessable client UUID) could fetch its segments during that window — bounded, never anonymous.                            | `routes/j/Videos/.../hls/[...path]/+server.ts`, `handlers/hls/lumastra-segment-handler.ts`                                                                               | #1 — anonymous media streaming                    |
| **Token-path streaming re-checks access at serve time.** The direct-stream / play-token paths in `/j/Videos/[id]/stream` and `/j/Audio/[id]/stream` bypass `withJellyfinAuth` (token in the URL — ExoPlayer/AVPlayer can't set headers), so they call `checkMediaAccess` again before serving. A play token is issued at `PlaybackInfo` (access-checked then) and is renewable, so without this a user whose library/age access was revoked after issuance would keep streaming. This re-check is only as good as the `UserContext` it runs against: `buildPlayTokenUserContext` (and the music stream-token path's `handleStreamToken`) resolve `userGroups`/`maxAgeRating`/`isAgeRestricted` **live from the DB on every call** (`resolveTokenUserAccess`, mirroring the forward-auth cookie session's own derivation) rather than from a login-time snapshot. | `routes/j/Videos/[id]/stream/+server.ts`, `routes/j/Audio/[id]/stream/+server.ts`, `jellyfin-compat/play-token-user.ts`, `auth/resolve-token-user-access.ts` | #1 — revoked access still streaming               |
| **Existence-oracle collapse.** Avatar (`/j/UserImage`, `/j/Users/[id]/Images`; real avatars need a Jellyfin credential, see "User avatars" below) and item-artwork (`/j/Items/[id]/Images`, public, Jellyfin parity) endpoints: an **unknown id returns the same default image (200)** as a known-without-artwork — never a distinguishable 404. Probing arbitrary UUIDs reveals no account/item existence.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `routes/j/UserImage`, `routes/j/Users/[id]/Images`, `routes/j/Items/[id]/Images`, `utils/default-avatar.ts`                                                              | #2/#3 — user/item enumeration                     |
| **Kill switch.** `FEATURE_JELLYFIN_COMPAT` (default **on**) gates the entire `/j` surface in `resolveAuth()` — when off, every `/j/*` path returns a clean `404` before pass-through. Operators who don't use Jellyfin clients can disable the surface entirely.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `forward-auth.ts`, `config.ts`, `src/lib/config/schema.ts`                                                                                                               | #1/#2 — shrink attack surface to zero when unused |
| **Login-path timing equalization.** `/j/Users/AuthenticateByName` runs the full scrypt verify against a dummy hash even for unknown users, so timing doesn't distinguish "no such user" from "wrong password".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `jellyfin-compat/auth.ts` `validatePassword`                                                                                                                             | username enumeration via timing                   |
| **Failed-auth rate limiting (per IP).** 60 failures / 60 s on both `/j/*` and `/api/v1/*`, escalating to 429.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `jellyfin-compat/middleware.ts`, `valkey-rate-limit.ts`                                                                                                                  | credential / token brute force                    |
| **Constant-time credential compare.** Subsonic token (`t`/`s`) and api-key checks use `timingSafeEqual`; empty/derivable/`enc:`/`MD5('')` cases all fail closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `subsonic-compat/auth.ts`                                                                                                                                                | Subsonic auth bypass / timing                     |
| **Spoofed, static `System/Info/Public`.** Returns a fixed emulated Jellyfin version + a stable synthetic server id — **no real hostname, OS, or build**. `Users/Public` returns `[]` (no user list).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `jellyfin-compat/serializers/system.ts`, `routes/j/Users/Public`                                                                                                         | minimizes #4 fingerprinting                       |

## Accepted residual risk

These are **deliberately accepted** trade-offs (closing them would break
clients), documented so the decision is explicit and reviewable:

- **App fingerprinting.** `System/Info/Public`, Subsonic error envelopes, and
  `getOpenSubsonicExtensions` reveal that this is a Lumastra deployment emulating
  Jellyfin/Subsonic, plus the emulated version. Required for clients to connect.
- **Public artwork (content, not existence).** A real poster is viewable by an
  anonymous caller **only if they already know the exact internal UUID** (random,
  non-enumerable, and the existence oracle is collapsed). This matches upstream
  Jellyfin, whose image endpoints are unauthenticated so `<img>` tags work. The
  _enumeration_ signal is removed; the _content_ of a known id is not gated. What
  a poster reveals is that a title with that id is in the library; nothing needs
  item art before login (`/j/Users/Public` lists nobody), so this stays a
  deliberate parity trade-off. Chapter frames (`/Items/{id}/Images/Chapter/{n}`)
  are cut from the user's own video file and need a Jellyfin session.
- **User avatars (changed 2026-10-21).** `GET /j/UserImage` and
  `GET /j/Users/{id}/Images/{type}` return the real avatar **only with a valid
  Jellyfin credential** (`api_key`/`ApiKey`/`token` query, `X-Emby-Token`,
  `X-MediaBrowser-Token`, or `Token=` in `Authorization`/`X-Emby-Authorization`).
  Without one, or with one that does not validate, every id (existing or not)
  gets the same generic silhouette, never an uploaded avatar and never initials.
  Upstream Jellyfin serves these unauthenticated, but no pre-login screen needs
  them here (the public user list is empty). Residual risk and cost: a client
  that cannot attach a credential to an `<img>` request (for example Seerr's
  browser page loading `/UserImage`) shows the silhouette instead of the avatar.
  The native `/api/v1/users/{id}/images/**` routes are authenticated outright (401).
  Responses are `Cache-Control: private` and vary on the credential headers.
- **Library tile art (signed tag).** A library's mosaic is the exception: knowing
  a library-group UUID is not enough. `/j/Items/[id]/Images` serves it only when
  `?tag=` is an HMAC (`JWT_SECRET`) that `/j/UserViews` minted for that library,
  and UserViews lists only groups the user is not denied
  (`jellyfin-compat/library-image-tag.ts`). Tags rotate weekly and stay valid
  7–14 days, so a user removed from a library can keep loading its mosaic for
  at most that long — no longer than an image they had already cached.
- **Stored client logs (`/j` ClientLog).** An authenticated Jellyfin app can
  upload a crash report, which is now kept as an admin-readable `log_bundle`
  (`source: jellyfin`) instead of being discarded. It goes through the same
  server-side scrub, 2 MiB cap, per-user daily byte budget, per-device limit (5),
  30-day retention and `FEATURE_CLIENT_LOG_BUNDLES` switch as native bundles, so
  it adds no new anonymous surface. The content is client-supplied text; treat it
  as untrusted when displaying it.

## Operator guidance

- **Not using Jellyfin clients?** Set `FEATURE_JELLYFIN_COMPAT=false` to disable
  the entire `/j` surface (returns 404). Likewise leave Subsonic compat off if
  unused.
- **Keep the app behind your reverse proxy.** The compat surface is most exposed
  on an internet-facing deployment; restricting `/j` and `/subsonic` at the
  proxy to known client networks (where feasible) further shrinks exposure.
- **Pin the proxy.** Forward-auth headers are read only with `FORWARD_AUTH_ENABLED=true`;
  with it on, set `TRUSTED_PROXY_IPS` (or `LUMASTRA_TRUST_ANY_PROXY` for a
  single host) so forged forward-auth headers are rejected — this protects the
  _non-compat_ surface that the central gate guards.
- **Lock `/metrics`.** It is fail-closed by default; only a configured
  `LUMASTRA_METRICS_BEARER_TOKEN` or explicit `LUMASTRA_METRICS_PUBLIC=true`
  exposes it.

## Where the central gate still protects everything else

For completeness: `/api/*` (the ~600 first-party routes) and all HTML pages are
**not** part of this trade-off. In production, with no native session cookie and
no trusted forward-auth header, `handleForwardAuth` → `handleMissingAuthHeaders`
returns `401` (API) or a login redirect (pages). `/api/v1/*` adds an app-layer
backstop in `hooks.server.ts` (`isApiV1RequestAuthorized`), and `/api/admin/*`
fails closed `403` for non-admins. The compat surfaces are the explicit
exception, governed by the controls above.
