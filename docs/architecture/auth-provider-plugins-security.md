<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Auth-provider plugins — security posture

Companion to `jellyfin-compat-security.md`. Same question, different surface:
this one is about the only plugin contract that is reachable **before**
authentication.

Operator-facing configuration lives at https://lumastra.org/guides/plugins/;
the author-facing contract at https://lumastra.org/developers/plugins/ §6e.
This page is the reasoning behind both.

## TL;DR

- A plugin verifies credentials. **Everything else is the host's decision** —
  which user this is, whether one may be created, which groups survive, whether
  the account may log in at all.
- Three env-only gates (`AUTH_PLUGIN_PROVIDERS`, `AUTH_PLUGIN_PROVISION`,
  `AUTH_PLUGIN_ADMIN_ASSERT`) all default to empty. An installed auth plugin is
  **inert** until an operator names it. The same gates cover both kinds.
- The contract **fails closed**, deliberately opposite to `authorizePlayback`.
- No plugin JavaScript renders on `/login`, ever. `browserUi` is refused by the
  contract validator, not by convention.

## Why this surface is pre-auth at all

`/api/auth/plugin/<id>/login` (credentials) and `/start` + `/callback`
(redirect) exist to establish a session, so they cannot require one. `isPluginAuthPublicPath()` in `src/lib/server/middleware/forward-auth.ts`
carves out exactly `/api/auth/plugin/` and nothing else;
`forward-auth-plugin-auth-path.test.ts` pins the near-misses that must stay
gated (`/api/auth/plugin-admin/secrets`, `/api/auth/plugins`,
`/api/auth/pluginx`, and the bare `/api/auth/plugin`).

That prefix is the whole exemption. Every other plugin surface — admin routes,
settings, secrets — stays behind the central gate.

## Inherent disadvantages

1. **Third-party code runs on an unauthenticated path.** An attacker can reach
   a plugin's verify function without an account, subject only to rate limits.
2. **The plugin sees the raw password.** Inherent to being a bind verifier.
   There is no way to check a password against LDAP without having it.
3. **No sandbox.** As everywhere in this plugin system, a signature means full
   host trust. An auth plugin could exfiltrate the passwords it is handed. That
   is a property of installing it, not of this route.

## Compensating controls

| Control                                                 | Where                     | What it stops                                                                                                                                         |
| ------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator allowlist, re-read per request                 | `isAuthProviderEnabled`   | Installing an auth plugin cannot open a login path. Removing an id closes it with no restart — which matters because plugin _unload_ is restart-only. |
| 404, never 401/403, for a non-allowlisted id            | the route                 | Enumerating which plugins a deployment runs                                                                                                           |
| `verifyCredentials` not called before the gate          | the route                 | An unlisted plugin receiving credentials at all                                                                                                       |
| Fail-closed normalisation                               | `normalizeVerdict`        | A throw, a 10s timeout, or a malformed verdict becoming a session                                                                                     |
| Mandatory stable `subject`                              | `normalizeVerdict`        | Binding an account to a mutable key (username/email). A success without one is discarded, never guessed at.                                           |
| Admin-group stripping by default                        | `stripAdminGroups`        | A plugin asserting itself into admin. Group mapping still works; admin does not flow.                                                                 |
| `isAdmin: false` on provisioning, unconditionally       | `resolvePluginIdentity`   | A plugin minting the account that administers the box                                                                                                 |
| Refusal to provision before an admin exists             | `resolvePluginIdentity`   | A plugin becoming the first-run door instead of `/setup`                                                                                              |
| Suspension check in the ROUTE                           | the route                 | A disabled account logging in through a side door. Deliberately not in the identity mapper, so no future caller of that mapper can skip it.           |
| `database` and `browserUi` refused                      | `defineAuthProvider`      | Raw SQL in identity mapping; third-party JS beside the native password field                                                                          |
| Bounded inputs (username ≤128, password ≤1024)          | the route                 | Unbounded payloads reaching a plugin's protocol parser                                                                                                |
| Native-equivalent rate limits on the **strict** peer IP | the route                 | XFF rotation dodging the per-IP bucket                                                                                                                |
| `isSafeProviderRedirect` on the plugin's URL            | `plugin-auth-redirect.ts` | `javascript:`/`data:`/relative targets, and plaintext http to a public host, from a mistyped authorize URL                                            |
| Refusing to start when the tx store is down             | `/start`                  | Stranding a user at a provider whose callback can never succeed                                                                                       |
| One shared `establishPluginSession`                     | `plugin-auth-session.ts`  | The two kinds' account checks drifting apart                                                                                                          |
| Outage does not consume the per-account budget          | the route                 | A flapping directory locking users out of the _fallback_ login too                                                                                    |

## The redirect kind

`/start` → the provider → `/callback`. The host generates `state`, binds it to
the browser, and holds every piece of flow context server-side; the plugin
returns a URL and, later, a verdict.

Three independent checks at the callback, none of which substitutes for
another:

| Check                                       | Proves                                             |
| ------------------------------------------- | -------------------------------------------------- |
| query `state` == HttpOnly cookie            | the same browser started this flow (login-CSRF)    |
| server-side transaction consumed via GETDEL | it is not a replay                                 |
| `pluginId` stored inside that transaction   | the state was not minted by a _different_ provider |

The third is easy to miss. The binding cookie is scoped to the whole
`/api/auth/plugin` path, so without it a state issued by provider A is
presentable at provider B's callback. A mismatch still **consumes** the record —
returning it to the store would leave a live state the attacker now knows about.

`txData` is stored server-side rather than in the cookie. `HttpOnly` prevents a
page _reading_ a cookie; it does not prevent a client _sending_ one, so a
cookie-carried `txData` would reach `completeLogin` as attacker-controlled input
that the plugin believes it wrote itself.

Both routes emit `Referrer-Policy: no-referrer` and `Cache-Control: no-store`,
because the callback URL carries the provider's authorization code.

## Why fail-closed here and fail-open in `authorizePlayback`

They look like the same shape and are not. A playback veto that fails open
means a broken plugin cannot black out the library — the worst case is that an
authorised viewer watches something. An auth check that fails open is an
authentication bypass. The asymmetry is intentional and is called out in both
modules' headers so a future refactor does not "harmonise" them.

## Accepted residual risk

- **A trusted auth plugin can steal passwords.** Not mitigated, and not
  mitigable without a sandbox. `allowedDomains` bounds where they can travel by
  the plugin's own declaration, which is a disclosure, not a restriction.
- **Timing.** The route does not equalise timing between "no such account
  here" and "the directory rejected it"; the plugin's own latency dominates and
  is outside host control. Native login _does_ equalise, because there the host
  owns the comparison.
- **A redirect provider's authorize URL is followed on its say-so.**
  `isSafeProviderRedirect` bounds it to https (plus http-to-loopback), which
  catches a malformed URL and stops `javascript:`, but a _malicious_ signed
  plugin can still send the browser to any https host it likes. As with the
  password above, that is a property of having installed it.

## Operator guidance

- Leave `AUTH_PLUGIN_ADMIN_ASSERT` empty unless you specifically want a
  directory to govern who administers this server.
- Keep native login enabled as a fallback while trialling a provider. If the
  directory goes down, the outage carve-out on the per-account budget is what
  keeps that fallback usable.
- Removing an id from `AUTH_PLUGIN_PROVIDERS` is the kill switch, and it is
  immediate. Uninstalling the plugin is not — that waits for a restart.

## What this does not change

The central gate still protects every other route. This carve-out is one path
prefix, one contract, and one env allowlist, all of which are tested.
