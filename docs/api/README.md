# API Documentation

This directory contains the OpenAPI specification and client guide for Lumastra's
external API surface.

## Files

| File          | Purpose                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `api-v1.yaml` | OpenAPI spec for `/api/v1/*` — generated from endpoint defs; commit after sync |
| `API.md`      | Client guide: OAuth device flow, HLS, SSE, behavioral notes                    |
| `CLAUDE.md`   | Quick-reference for agents working on this directory                           |

## How the spec is generated

The spec is generated from the endpoint definition files
(`src/lib/server/api/defs/**/*.ts`). Each def file exports a `def` constant built
with `defineEndpoint()`; the generator reads those files and produces the YAML.

```bash
# Regenerate from defs (run after changing any defs/ file)
npm run openapi:generate

# Check in CI that generated files are up-to-date
npx tsx --tsconfig tsconfig.scripts.json scripts/gen-api-routes.ts --check
```

The old `scripts/openapi/routes/` per-domain Zod files are superseded by the defs
layer. `openapi:generate` now reads `src/lib/server/api/defs/` directly.

## Browsing the spec

```bash
# Preview in browser (recommended)
npx @redocly/cli preview-docs docs/api/api-v1.yaml

# Or paste into https://editor.swagger.io
```

## Architecture: endpoint definition layer

All `/api/v1` (and mirrored `/api`) handlers live in one place:

```
src/lib/server/api/
  define.ts        EndpointDef + AuthSpec + ApiContext types; defineEndpoint() factory
  mount.ts         mount(def, ctx) — ONE auth chokepoint; wraps defs into SvelteKit handlers
  problem.ts       problem+json builder; paginate(); ApiProblem.* shortcuts
  principal.ts     Principal type; buildPrincipal(); deriveIsAdmin(); expandScopes()
  index.ts         barrel re-export
  defs/            one file per URL pattern; each exports `def`
    catalog/       media/{id}, series/{id}, people/{id}, media/{id}/rating
    playback/      sessions, stream tokens, watch-state
    recommendations/ trending, feed, similar
    …              (one sub-directory per domain)
```

Route files are **generated** by `scripts/gen-api-routes.ts`, which walks `defs/`
and emits identical one-liners for both surfaces:

```ts
// src/routes/api/v1/media/[id]/+server.ts  (AUTO-GENERATED — do not edit by hand)
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/media-id.js';
export const { GET } = mount(def, { surface: 'v1', imageBase: '/api/v1/image' });
```

The internal (`/api/…`) mirror is generated in the same pass with `surface:
'internal'`. Because both surfaces share one `def`, method parity is structural —
a method cannot exist on one surface and not the other.

### Writing a new endpoint

1. Create `src/lib/server/api/defs/<domain>/<name>.ts`.
2. Export `def = defineEndpoint({ auth: …, handlers: { GET: … } })`.
3. Run `npm run openapi:generate` to update the spec.
4. Run the generator to emit the route files (or let CI `--check` catch it).

See `src/lib/server/api/defs/_readme.ts` for the file-path → route-path mapping
convention.

## Auth conventions

Two URL prefixes, one handler layer:

| Prefix      | Edge gate                            | Token kinds accepted                                                          |
| ----------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `/api/*`    | Reverse-proxy forward auth (IdP)     | Session cookie / IdP headers                                                  |
| `/api/v1/*` | Reverse proxy bypasses (no redirect) | Device JWT · PAT (`pat_`) · Service token (`svc_`) · Stream token (`stream_`) |

Auth is declared per-endpoint via `AuthSpec` and enforced by `enforce()` in
`mount.ts`. `enforce()` reads only `locals.principal` — never the URL prefix —
so the surface is cosmetic only and cannot drive auth decisions.

**AuthSpec kinds:**

| Kind          | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `public`      | No auth — only way to ship an un-gated route (greppable)                |
| `user`        | Any authenticated principal (session, PAT, device JWT, svc token)       |
| `admin`       | `principal.isAdmin` — uses `deriveIsAdmin()` two-condition rule         |
| `scope`       | Bearer scope gate; `anyOf` — PAT/svc/admin-session via `scopeGranted()` |
| `selfOrAdmin` | Path param must equal caller's username, or caller is admin             |
| `feature`     | Feature-flag gate — disabled → 404 (resource doesn't exist)             |
| `all` / `any` | Logical AND / OR over sub-specs                                         |

**`deriveIsAdmin()` two-condition rule (fixes the admin-token bug class):**

- Session / forward-auth: DB-authoritative group/pin verdict.
- Token (PAT / svc / device JWT): admin **only if** `ownerIsAdmin AND explicit admin scope`.
  A low-scope PAT owned by an admin is **not** admin.

## Response conventions

### Success

- **Single resource:** bare JSON object — no `{ success, data }` wrapper.
- **Collection:** `{ items: T[], page: { limit, offset?, cursor?, hasMore, total? } }`.
  `hasMore` is mandatory. `total` is opt-in (`?count=true` or when free).
- **Created (201):** resource body + `Location` header.
- **Accepted (202):** `{ accepted: true, … }` + `Location`.
- **No content (204):** empty body.

### Errors — `application/problem+json`

```jsonc
{
    "code": "not_found", // stable machine-parseable contract — switch on this
    "error": "Series not found", // human text — do not parse
    "status": 404,
    "details": [{ "field": "id", "message": "…" }], // validation errors only
    "retryAfter": 60, // seconds (rate_limited / stream_limit only)
}
```

**Closed `code` taxonomy:**

| Code                     | Status | When                                                  |
| ------------------------ | ------ | ----------------------------------------------------- |
| `unauthorized`           | 401    | No credential                                         |
| `invalid_token`          | 401    | Credential present but invalid/expired                |
| `forbidden`              | 403    | Authenticated but lacking permission                  |
| `scope_required`         | 403    | Token present but scope insufficient                  |
| `not_found`              | 404    | Resource absent, or feature disabled                  |
| `conflict`               | 409    | Already exists / operation in-flight / invalid reference                  |
| `gone`                   | 410    | Permanently removed                                   |
| `validation_failed`      | 422    | Semantically invalid request                          |
| `quota_exceeded`         | 422    | Request quota exhausted                               |
| `rate_limited`           | 429    | Too many requests                                     |
| `internal_error`         | 500    | Unhandled server error                                |
| `bad_gateway`            | 502    | Upstream returned unexpected response                 |
| `dependency_unavailable` | 503    | DB / Valkey / external API down — **never** 200+empty |
| `stream_limit`           | 503 (Live), 422 (VOD start) | Stream slot capacity full |

Mounted endpoints translate PostgreSQL SQLSTATE `22P02`, `22003`, and `23514` to
`422 validation_failed`, and `23503` / `23505` to `409 conflict`. Foreign-key
conflicts use the existing `conflict` code consistently (the referenced resource
may be missing or still in use). More precise route validation takes precedence,
such as `404 not_found` for malformed resource IDs and `422 validation_failed`
for unknown client-supplied categories or library groups. Other SQLSTATEs retain
the endpoint's existing error handling. This fallback applies only to `mount()`;
other route wrappers keep their behavior. Mapped errors log only SQLSTATE and
constraint name, never query parameters or driver details.

**Class R responses** (images, HLS segments, SSE, byte-range, 204): success bodies
are non-JSON; pre-stream errors still use problem+json.

## Scope taxonomy

Coarse aliases expand deterministically:

| Alias   | Expands to                                                                |
| ------- | ------------------------------------------------------------------------- |
| `admin` | everything (all fine-grained scopes)                                      |
| `write` | `read` + `media:read/write`, `sessions:read/write`, `requests:read`       |
| `read`  | `tasks:read`, `runs:read`, `media:read`, `sessions:read`, `requests:read` |

`write` does **not** grant `tasks:run` or `webhooks:write` (require explicit grant).

Fine-grained scopes (`tasks:run`, `users:admin`, `library:admin`, `media:admin`,
`livetv:admin`, `providers:admin`, `tokens:admin`, `access:admin`, `playback:admin`,
`metrics:read`, …) must be granted explicitly.

`jellyfin_compat*` scopes are exclusive to PATs for `/j` clients and are never
granted by `write` or `admin` expansion.

## Related files

- `API.md` — OAuth device flow, HLS, SSE, behavioral notes (not endpoint listings)
- `src/lib/server/api/` — foundation layer (define / mount / problem / principal)
- `src/lib/server/api/defs/` — all endpoint definitions
- `scripts/gen-api-routes.ts` — route-file generator
- [OAuth device-flow setup](https://lumastra.org/guides/authentication/) — operator setup
- [OAuth device-flow clients](https://lumastra.org/developers/oauth-clients/) — client implementers

## Apple generation tag selection

The Apple repository's `Sources/API/openapi-generator-config.yaml` contains the
`filter.tags` allowlist. Add `Subtitles` there before the next Apple generation:
subtitle extraction/rendering moved from `Timeline` to `Subtitles`. Keep
`Notifications`, which now also contains series release follows. Operation IDs
and wire behavior are unchanged; this server documentation change needs no
installed Apple app release. The Apple repository is not modified here.
