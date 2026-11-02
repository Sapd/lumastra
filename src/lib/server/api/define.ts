// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * define.ts — EndpointDef + AuthSpec union + defineEndpoint factory.
 *
 * Provides the declarative endpoint definition type that mount.ts consumes.
 *
 * DO NOT add auth logic here — that lives in mount.ts's enforce().
 * DO NOT import route-specific services here — keep this layer pure types.
 */

import type { RequestEvent } from '@sveltejs/kit';
import type { ZodType, output } from 'zod';
// Type-only (erased at compile) — reuses the EXACT shape the colocated
// `_openapi.ts` files export, so migrating a route is just moving its `route`
// object into the def as `docs`. The cycle (openapi.ts → define.ts) is
// type-only and therefore has no runtime edge.
import type { RouteMetadata } from '../openapi.js';

// ---------------------------------------------------------------------------
// REQUEST / INPUT CONTRACT — conventions
// ---------------------------------------------------------------------------
//
// A def may declare an optional `request` slot describing what the endpoint
// reads from the wire. mount()/enforce() validate the request against those
// Zod schemas BEFORE the handler runs and hand the PARSED, TYPED values to the
// handler via `ctx.input`. The handler never re-parses.
//
// CONVENTIONS (keep new defs consistent — these are documentation, not lint):
//
//  - BODIES are camelCase JSON (`application/json`). The ONLY documented
//    exception is the OAuth surface (`/oauth/*`), which keeps snake_case fields
//    and `application/x-www-form-urlencoded` per RFC 6749/8628 — declare such a
//    body schema and the validator will read form-urlencoded automatically when
//    the request Content-Type is form-urlencoded.
//
//  - STANDARD QUERY VOCABULARY (use these names; don't invent synonyms):
//      limit / offset | cursor   pagination (offset XOR cursor per endpoint)
//      scope                     visibility selector (e.g. mine | all)
//      include                   opt-in expansions (CSV: user,playback,…)
//      fields                    sparse-fieldset projection (CSV)
//      sort                      ordering (field or -field for desc)
//      filter                    structured filtering
//
//  - CONTENT-TYPE: JSON bodies are parsed as JSON; OAuth/form bodies as
//    form-urlencoded. A body schema on a method with no/!json body yields
//    `validation_failed` only when fields are actually wrong — an absent body
//    for an optional schema is fine (be lenient).
//
//  - LENIENCY: schemas MUST accept every currently-valid input. Unknown fields
//    are STRIPPED, never rejected (do NOT use `.strict()`). Validate known-field
//    types, required-ness, and obvious bounds only.
//
//  - IDEMPOTENCY-KEY: unsafe operations (POST/PUT/PATCH/DELETE) MAY send an
//    `Idempotency-Key` header. The contract layer ACCEPTS and passes it through
//    on `ctx.idempotencyKey`; actual replay storage is out of scope here.
//
// ---------------------------------------------------------------------------
// Surface context
// ---------------------------------------------------------------------------

/**
 * Declarative request (input) contract for an endpoint.
 *
 * Each slot is an optional Zod schema. When present, mount() parses the
 * corresponding part of the request and rejects malformed input with
 * `validation_failed` BEFORE the handler runs:
 *
 *  - `body`   — parsed from the request body (JSON, or form-urlencoded for
 *               OAuth/form Content-Types). Applies to POST/PUT/PATCH/DELETE.
 *  - `query`  — parsed from `event.url.searchParams` (all values arrive as
 *               strings; use `z.coerce.*` for numbers/booleans).
 *  - `params` — parsed from `event.params` (route params; always strings).
 *
 * Keep schemas LENIENT: strip unknown fields, never `.strict()`.
 */
export interface RequestSchemas {
    body?: ZodType;
    query?: ZodType;
    params?: ZodType;
    /**
     * HTTP methods the `query` schema applies to. Omitted: every method. A def
     * whose GET lists or pages but whose POST creates sets `queryMethods: ['GET']`,
     * so the POST neither validates nor documents list/paging params it ignores.
     */
    queryMethods?: readonly HttpMethod[];
    /**
     * HTTP methods the `body` schema applies to. Omitted: every method that can
     * carry a body (POST, PUT, PATCH, DELETE). A def with a DELETE that takes no
     * body sets `bodyMethods: ['POST', 'PUT']`, so the DELETE neither requires nor
     * documents the create/replace body.
     */
    bodyMethods?: readonly HttpMethod[];
    /**
     * Optional cap (in bytes) on the raw request body, enforced by mount() in
     * `readRequestBody()` BEFORE `JSON.parse` — a declared `Content-Length` over
     * the cap is rejected with `413 payload_too_large` before the body stream is
     * touched at all, and a body read via a streamed reader (not `.text()`) is
     * aborted the moment its accumulated byte count passes the cap (covering a
     * request with no/lying `Content-Length`, e.g. chunked transfer-encoding).
     *
     * Only meaningful when `body` is also declared — a def with no `body` schema
     * never buffers the request through mount() and is unaffected by this field.
     *
     * Defaults to 256 KB when omitted. Most bodies are far smaller than that; set
     * an explicit larger value ONLY for a def whose legitimate bodies exceed it
     * (e.g. a bulk endpoint accepting hundreds of items) — measure the real
     * worst-case size rather than picking a round number defensively.
     */
    maxBodyBytes?: number;
}

/**
 * The parsed, typed request input handed to a handler on `ctx.input`.
 *
 * The generic threads each declared schema's inferred output type through so a
 * handler can read `ctx.input.body.rating` (typed) instead of re-parsing.
 * Slots that were not declared are `undefined`.
 */
export interface ParsedInput<R extends RequestSchemas = RequestSchemas> {
    body: R['body'] extends ZodType ? output<R['body']> : undefined;
    query: R['query'] extends ZodType ? output<R['query']> : undefined;
    params: R['params'] extends ZodType ? output<R['params']> : undefined;
}

/**
 * The cosmetic surface context supplied at each mount() call site.
 *
 * Intentionally a small, NON-generic type. Every route module calls
 * `mount(def, { surface })`, so this literal is assignability-checked
 * ~1500× across the project. Keeping it free of the generic `ParsedInput` / Zod
 * `output<>` machinery (which lives on {@link ApiContext} below) is what keeps
 * the whole-project type-check under tsgo's global relation-complexity budget:
 * folding those conditional types into every mount() call site pushed the
 * combined route graph over the limit (TS2859 "excessive complexity"). See the
 * `ctx` parameter of mount().
 */
export interface SurfaceContext {
    /**
     * Which URL prefix this handler is mounted on — the ONLY input a handler may
     * use to derive a URL. Build every emitted path from it via the helpers in
     * `api-urls.ts` (`apiUrl`, `entityImageUrl`, `buildImageRefs`).
     *
     * This deliberately replaced a hand-written `imageBase` string that was
     * passed at every mount() call site: with no invariant tying it to `surface`
     * it drifted into three values for the same surface, and 39 v1 mounts ended
     * up carrying the internal `/api/image` — emitting `/api/media/...` links
     * from a v1 endpoint. `surface` cannot drift, because mount() is called from
     * the route file that physically defines the prefix.
     */
    surface: 'internal' | 'v1';
}

/**
 * Cosmetic surface context passed to every handler.
 * `surface` MUST NOT influence auth decisions.
 * It may only affect presentation details such as image base URLs.
 */
export interface ApiContext<R extends RequestSchemas = RequestSchemas> extends SurfaceContext {
    /**
     * Parsed + validated request input — present whenever the def declared a
     * `request` schema for the slot. Slots without a declared schema are
     * `undefined`. mount() populates this before calling the handler.
     *
     * Existing handlers that ignore it are unaffected (additive, optional).
     */
    input?: ParsedInput<R>;
    /**
     * `Idempotency-Key` request header value, passed through verbatim when the
     * client supplied one on an unsafe operation. Storage/replay is out of
     * scope for the contract layer — this is observation only.
     */
    idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Scope taxonomy
// ---------------------------------------------------------------------------

/**
 * All recognised API scopes.
 *
 * The set is intentionally narrow for this foundation layer.
 *
 * - `read`/`write`/`admin` are documented coarse aliases that expand
 *   deterministically via expandScopes() in mount.ts.
 * - `write` does NOT grant task/webhook-class scopes.
 * - `admin` grants everything.
 *
 * NOTE: the wire format stays string[] — no DB migration required.
 */
export type ApiScope =
    | 'read'
    | 'write'
    | 'admin'
    | 'tasks:read'
    | 'tasks:run'
    | 'tasks:admin'
    | 'runs:read'
    | 'webhooks:write'
    | 'media:read'
    | 'media:write'
    | 'sessions:read'
    | 'sessions:write'
    | 'requests:read' // read own requests + quota
    | 'requests:admin' // read all requests across users (scope=all)
    | 'users:read' // read user list + profiles (granted by users:admin)
    | 'users:admin' // user lifecycle + per-user config
    | 'access:admin' // access groups, library-group-permissions
    | 'tokens:admin' // mint/list/revoke PATs and service-tokens on behalf of others
    | 'library:read' // read-only library/group/path info (granted by library:admin)
    | 'library:admin' // library/group/path CRUD + validate-path + reports
    | 'media:admin' // per-item management (metadata, rescan, chapters, images write, delete)
    | 'livetv:admin' // sources/channels/categories/backup-groups CRUD, layout, proxy
    | 'providers:read' // read metadata-provider config (granted by providers:admin)
    | 'providers:admin' // metadata-provider config, integration keys, radio-station CRUD
    | 'playback:read' // transcode-capabilities, playback-quality stats
    | 'playback:admin' // playback-quality resets, ffmpeg-job cancel
    | 'metrics:read' // pure observability scrape endpoints (system-metrics, task metrics, trends)
    // The integration service-token grant (/api/v1/integrations/*). Never in
    // expandScopes('admin'): only a token minted with it holds it, and the
    // integration handlers check `integrationTokenDenial()` on top.
    | 'integrations:read'
    // The debug-report service-token grant (/api/v1/admin/debug-report and its
    // drill-downs). Never in expandScopes('admin'): only a token minted with it
    // holds it, and the report handlers check `diagnosticsAccessDenial()` on top.
    | 'diagnostics:read';

// ---------------------------------------------------------------------------
// AuthSpec union
// ---------------------------------------------------------------------------

/**
 * Declarative auth specification for an endpoint or a single HTTP method.
 *
 * `enforce()` in mount.ts maps every variant onto EXISTING auth primitives —
 * it invents no new policy.
 *
 * The closed discriminated union means every variant is greppable and testable.
 * Prefer the narrowest spec that correctly gates the endpoint.
 */
export type AuthSpec =
    /**
     * No auth required. This is the ONLY way to ship an un-gated endpoint —
     * it must be an explicit, reviewable decision.
     */
    | { kind: 'public' }

    /**
     * Any authenticated user (session, PAT, device JWT, service token).
     * Checks `locals.user` only — does not validate bearer scopes.
     */
    | { kind: 'user' }

    /**
     * Admin-only. Uses `locals.user.isAdmin` OR an admin-scoped PAT/svc token
     * (via deriveIsAdmin semantics). NEVER use `{kind:'group',anyOf:['admin']}`
     * as a shortcut.
     */
    | { kind: 'admin' }

    /**
     * Bearer-token scope gate. Requires any one of `anyOf` scopes.
     * Consumes `authenticate()` + `scopeGranted()` from tasks/api-auth.ts
     * (or, when `locals.principal` is already set, `scopeGranted()` directly
     * against `principal.scopes` — mount.ts's `{kind:'scope'}` branch).
     * Works for PAT (`pat_`), service tokens (`svc_`), admin sessions (which
     * synthesise scopes=['admin']) — AND a PLAIN NON-ADMIN SESSION. A
     * non-admin session with no token scopes gets `rawScopes =
     * ['read','write']` (principal.ts), expanded by `expandScopes()`.
     * Reachability for such a session is NOT just what `expandScopes()`
     * literally adds to the array — `scopeGranted()` (tasks/api-auth.ts) has
     * its OWN `tokenScopes.includes('read')` / `.includes('write')`
     * shortcuts on several cases, and the raw `'read'`/`'write'` strings
     * stay in the expanded array (expansion adds, never removes). The full
     * EXHAUSTIVE set of scopes a plain non-admin session can satisfy today
     * is `media:read`, `media:write`, `sessions:read`, `sessions:write`,
     * `requests:read` (`runs:read` left it 2026-10-07) — this is not a paraphrase, it is
     * the literal `SAFE_NON_ADMIN_SCOPES` allowlist in
     * `defs-scope-non-admin-sweep.test.ts`, kept there rather than restated
     * here so there is exactly one place it can drift. A scope in `anyOf` is
     * NOT an operator-only gate unless it is in that set — this docstring
     * used to omit the non-admin session entirely, which is exactly what
     * let findings C2/C4/C5 (2026-09-17 security review 4) recur after
     * 2026-09-12 C16 fixed the same shape once. See `expand-scopes.test.ts`
     * for the current expansion and `defs-scope-non-admin-sweep.test.ts` for
     * the durable guard against a new def repeating this mistake.
     */
    | { kind: 'scope'; anyOf: ApiScope[] }

    /**
     * The request user must equal the {param} path param, OR be admin.
     * Reuses the predicate from requireSelfOrAdmin in middleware/auth.ts.
     */
    | { kind: 'selfOrAdmin'; param: string }

    /**
     * Feature-flag gate. When the flag is disabled the request receives
     * `404 not_found` (feature-off ≠ forbidden; it doesn't exist). When
     * enabled, `then` is evaluated as the real auth spec.
     */
    | { kind: 'feature'; flag: string; then: AuthSpec }

    /**
     * Logical AND — all sub-specs must pass.
     * Stops at first failure and returns that response.
     */
    | { kind: 'all'; specs: AuthSpec[] }

    /**
     * Logical OR — any one sub-spec must pass.
     * Returns success if any spec passes; returns the last failure otherwise.
     */
    | { kind: 'any'; specs: AuthSpec[] };

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

/**
 * A single HTTP method handler.
 *
 * Receives the SvelteKit RequestEvent AND the surface ApiContext. When the def
 * declares a `request` schema, the parsed/typed input is available on
 * `ctx.input` (typed via the `R` generic). Handlers that ignore `ctx.input`
 * keep working unchanged — the generic defaults to the open shape.
 */
export type ApiHandler<R extends RequestSchemas = RequestSchemas> = (
    event: RequestEvent,
    ctx: ApiContext<R>,
) => Response | Promise<Response>;

// ---------------------------------------------------------------------------
// EndpointDef
// ---------------------------------------------------------------------------

/**
 * Complete, self-contained definition of one endpoint (one URL pattern).
 *
 * `auth` may be:
 * - A single AuthSpec applied to ALL methods defined in `handlers`.
 * - A per-method map for methods that need different auth (e.g. GET is user,
 *   DELETE is admin). Methods not listed in the map inherit `fallbackAuth`
 *   when provided, or throw a compile-time-like error at mount time.
 *
 * `raw` (optional): mark this endpoint as a "Class R" response (image bytes,
 * HLS segments, SSE, redirects, 204). Class R error responses (pre-stream
 * failures) still use problem+json; mid-stream errors are transport-native.
 */
export interface EndpointDef<R extends RequestSchemas = RequestSchemas> {
    /**
     * Auth for all methods, OR a per-method override map.
     *
     * When a per-method map is used, every method key in `handlers` MUST appear
     * in the map (no silent defaults). `enforce()` throws at runtime if a method
     * is called without a corresponding spec.
     */
    auth: AuthSpec | Partial<Record<HttpMethod, AuthSpec>>;

    /**
     * SPEC/DOC VISIBILITY — does NOT affect routing or auth.
     *
     * Every route stays mounted on `/api/v1/*` and reachable exactly as today;
     * this flag ONLY controls which generated OpenAPI spec the route is
     * published into:
     *
     *  - `'public'`   (default) → the published `docs/api/api-v1.yaml`
     *                  consumed by 3rd-party device/script/operator-automation
     *                  clients.
     *  - `'internal'` → `docs/api/internal-api.yaml` (human-dashboard-only
     *                  endpoints with no automation value).
     *
     * CLASSIFICATION RULE: mark a route `'internal'` only when a 3rd-party
     * client would never plausibly call it (admin/secrets, system-health
     * invariants, dashboard-only curation, monitoring blobs, setup/onboarding,
     * etc.). When genuinely ambiguous, leave it `'public'` (under-hiding is
     * safer than hiding a useful endpoint).
     *
     * This is a RUNTIME classification field. The spec generator does NOT use it
     * for the published-surface split — that is driven solely by the route
     * metadata's `visibility` (the def's `docs.visibility`, carried over from the
     * old `_openapi.ts`). Many public routes carry `visibility:'internal'` here
     * for their own classification while remaining public in the spec.
     */
    visibility?: 'public' | 'internal';

    /**
     * Declarative REQUEST / INPUT contract for this endpoint.
     *
     * When present, mount() validates the request body/query/params against
     * these Zod schemas BEFORE invoking the handler and exposes the parsed,
     * typed values on `ctx.input`. On a schema failure the request is rejected
     * with `problem('validation_failed', { details })` carrying field-level
     * issues — the handler is never called.
     *
     * The schema applies to BOTH the `/api/*` and `/api/v1/*` mounts by
     * construction, since a single def is mounted onto both surfaces.
     *
     * Keep schemas LENIENT (strip unknown fields, no `.strict()`): they MUST
     * accept every currently-valid input or they introduce a regression.
     */
    request?: R;

    /**
     * OPENAPI DOC METADATA — the single source for this route's published spec.
     *
     * Holds the SAME object shape the colocated `_openapi.ts` files export as
     * `const route: RouteMetadata` (per-method `{ tags, summary, description?,
     * stability?, auth?, query?, body?, params?, responses }` plus a route-level
     * `visibility?`). Migrating a route off its `_openapi.ts` sibling is simply
     * moving that `route` object here as `docs` and deleting the sibling.
     *
     * NOT INERT AT RUNTIME. Two consumers:
     *   - the OpenAPI generator (`scripts/openapi/generate-public.ts`), which
     *     prefers `def.docs` over an imported `_openapi.ts` when present;
     *   - mount()'s response-conformance gate, which parses each 2xx body
     *     against `docs[method].responses[status].schema` and emits the STRIPPED
     *     result in dev + prod, so the wire matches the published spec
     *     (`additionalProperties: false`) instead of leaking undeclared fields
     *     that break strict decoders. Declaring a response schema here therefore
     *     makes it AUTHORITATIVE on the wire — an undeclared field is dropped.
     *
     * REQUEST SLOTS: a `docs[method].query/body/params` schema, when set, is the
     * explicit documented contract for that slot; when omitted the generator
     * falls back to this def's `request.query/body/params` (the runtime-validated
     * schema). No superset reconciliation is performed for `docs`-sourced routes.
     *
     * Single `RouteMetadata` — for a def mounted at ONE route. A def mounted at
     * more than one path with DIFFERENT docs per mount uses `docsByPath` instead.
     */
    docs?: RouteMetadata;

    /**
     * Per-mount OpenAPI docs for a def deliberately mounted at MORE THAN ONE
     * route path (e.g. a `/seasons` collection and a `/seasons/{n}` node that
     * branch on a route param, whose summaries + 200 schemas differ). A single
     * `docs` cannot express both, so the generator calls this with the route's
     * OpenAPI path (`{param}` form, e.g. `/api/v1/series/{id}/seasons`) and uses
     * the returned metadata for THAT mount. Return `undefined` to defer to the
     * route's `_openapi.ts` — that is how a shared def owns its public mounts
     * while an internal mount keeps a sibling `_openapi.ts`. Checked BEFORE
     * `docs`.
     *
     * NOT INERT AT RUNTIME — same two consumers as `docs`, with the same
     * precedence. mount() derives the `{param}`-form path from `event.route.id`
     * and calls this to find the response schema governing the mount actually
     * being served, so a def that documents itself per-path is conformance-gated
     * exactly like a `docs`-only def. Returning `undefined` for a path opts that
     * mount out of BOTH the spec and the runtime gate.
     */
    docsByPath?: (openApiPath: string) => RouteMetadata | undefined;

    /** The HTTP method handlers for this endpoint. */
    handlers: Partial<Record<HttpMethod, ApiHandler<R>>>;

    /**
     * Class R flag: this endpoint returns non-JSON success responses.
     * Error responses (pre-stream) still use problem+json.
     */
    raw?: boolean;

    /**
     * Optional Valkey rate limit enforced by mount() for EVERY method on this
     * def, on BOTH the internal and v1 surfaces (a single def is mounted on
     * both, and both get the SAME budget since they share the key by
     * default). Checked after auth succeeds — so a caller that fails auth is
     * never charged — and before request-body validation, so an over-budget
     * caller is rejected before its body is parsed. Image-provider budgets
     * explicitly defer charging until upstream work, allowing cache/local hits.
     *
     * Prefer this over hand-wrapping the exported handler with
     * `withValkeyRateLimit()` at each +server.ts call site: a docstring
     * claiming "rate-limited via Valkey" next to a bare `mount(def, {...})`
     * is unverifiable and can silently rot (the playlist bulk endpoints lost
     * their wrapper in a def migration and nothing caught it — see the C5
     * fix-plan finding). A `rateLimit` field is provably enforced for every
     * mount of the def, by construction.
     */
    rateLimit?: EndpointRateLimit;
}

/**
 * Declarative per-def rate limit — see {@link EndpointDef.rateLimit}.
 */
export interface EndpointRateLimit {
    /** Max requests allowed per window, optionally selected from the authenticated identity. */
    limit: number | ((event: RequestEvent) => number);
    /** Defer charging until the image service actually needs upstream provider work. */
    work?: 'image-provider';
    /** Window size, in seconds. */
    windowSec: number;
    /**
     * Rate-limit key deriver, called once per request. Defaults to
     * `${username}:${pathname}` (falling back to `'anonymous'` when
     * unauthenticated) when omitted — most defs should supply their own,
     * scoped to the resource being protected (e.g. a shared budget across
     * sibling mutation endpoints, as the playlist bulk defs do) rather than
     * relying on the per-route default.
     */
    keyBy?: (event: RequestEvent) => string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * defineEndpoint — identity helper that types the definition and serves as a
 * greppable annotation for code-gen and lint.
 *
 * Usage (no request contract):
 * ```ts
 * export const def = defineEndpoint({
 *   auth: { kind: 'user' },
 *   handlers: {
 *     GET: async (event, ctx) => { ... },
 *   },
 * });
 * ```
 *
 * Usage (declarative request contract — typed input via ctx.input):
 * ```ts
 * export const def = defineEndpoint({
 *   auth: { kind: 'user' },
 *   request: {
 *     body: z.object({ rating: z.number().min(0).max(10) }),
 *     query: z.object({ include: z.string().optional() }),
 *   },
 *   handlers: {
 *     PUT: async (event, ctx) => {
 *       const { rating } = ctx.input!.body; // typed; already validated
 *       ...
 *     },
 *   },
 * });
 * ```
 *
 * The generic `R` is inferred from the `request` slot so `ctx.input` is typed
 * per-def without any explicit type annotation at the call site.
 */
export function defineEndpoint<R extends RequestSchemas = RequestSchemas>(
    d: EndpointDef<R>,
): EndpointDef<R> {
    return d;
}
