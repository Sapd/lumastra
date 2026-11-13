// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    isLiveTvRouteId,
    isLiveTvCleanupRequest,
    isSyntheticLiveTvIdentity,
    liveTvRouteGate,
    userAllowsLiveTv,
} from '$lib/server/auth/livetv-user-policy.js';
/**
 * mount.ts — the ONE auth chokepoint for /api/v1 endpoints.
 *
 * mount(def, ctx) wraps every handler defined in an EndpointDef with:
 *   1. enforce(spec, event)  — maps AuthSpec onto EXISTING primitives (no new policy)
 *   2. withErrorHandler      — converts unhandled throws to problem+json 500s
 *
 * Route files become thin one-liners:
 *   export const { GET, POST } = mount(def, { surface: 'v1' });
 *
 * Design invariants:
 * - enforce() NEVER reads the URL prefix to make auth decisions.
 * - enforce() NEVER invents new policy — it delegates to authenticate(),
 *   scopeGranted(), requireScope() from tasks/api-auth.ts and the
 *   locals.user / locals.user.isAdmin primitives that resolveAuth populates.
 * - Every method exported from mount() MUST have an explicit AuthSpec.
 *   If no spec is found for a method, the request is rejected 403 (fail-closed).
 */

import {
    AuthDependencyUnavailableError,
    authUnavailableResponse,
} from '$lib/server/auth/dependency-unavailable.js';

import {
    restrictImageRequest,
    runImageProviderBudget,
} from '$lib/server/services/image-proxy/work-budget.js';
import { untypedBodyOnCookieAuth } from '$lib/server/middleware/validate.js';
import { isRedirect } from '@sveltejs/kit';
import { apiUrl } from '$lib/shared/api-urls.js';
import { deprecationHeaders, fillPathParams, withDeprecationHeaders } from './deprecation.js';
import type { DeprecationInfo } from '../openapi.js';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import type { ZodType } from 'zod';
import { Logger } from '$lib/server/utils/logger.js';
import type {
    ApiContext,
    AuthSpec,
    EndpointDef,
    HttpMethod,
    ParsedInput,
    RequestSchemas,
    SurfaceContext,
} from './define.js';
import { ApiProblem, problem, AISuggestionRateLimitError } from './problem.js';
import type { ValidationDetail } from './problem.js';
import { authenticate, requireScope, scopeGranted } from '$lib/server/tasks/api-auth.js';
import type { ApiScope as TaskApiScope } from '$lib/server/tasks/api-auth.js';
import { buildPrincipal } from './principal.js';
import type { Principal } from './principal.js';
import { config, features } from '$lib/server/config.js';
import {
    checkRateLimit,
    IMAGE_ENCODE_RATE_LIMIT,
    rateLimitHeaders as buildRateLimitHeaders,
} from '$lib/server/middleware/valkey-rate-limit.js';
import {
    DEFAULT_MAX_BODY_BYTES,
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    isPayloadTooLargeError,
    readBoundedBodyText,
    restoreRequestBody,
} from '$lib/server/utils/bounded-body-reader.js';
import { isDelegatedAdmin } from '$lib/server/api/delegate.js';

import { countConformance } from './conformance-counter.js';

const logger = Logger.for('ApiMount');
const stripWarnings = new Map<string, number>();

// ---------------------------------------------------------------------------
// enforce() — the single auth chokepoint
// ---------------------------------------------------------------------------

/**
 * Evaluate an AuthSpec for the given event.
 *
 * Returns null when auth passes (proceed to handler).
 * Returns a Response when auth fails (short-circuit).
 *
 * Reads from `locals.principal` when available (the preferred path — ensures a
 * single, consistent identity regardless of credential kind). Falls back to
 * `locals.user` and Bearer-header parsing for requests that pre-date the
 * Principal population (e.g. legacy routes not yet through resolveAuth).
 *
 * This function NEVER reads the URL prefix to make auth decisions.
 */
export async function enforce(spec: AuthSpec, event: RequestEvent): Promise<Response | null> {
    switch (spec.kind) {
        case 'public':
            return null;

        case 'user': {
            // Prefer Principal (populated for all credential paths by resolveAuth).
            // Fall back to locals.user for backward compatibility.
            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!username) {
                return ApiProblem.unauthorized();
            }
            return null;
        }

        case 'admin': {
            // PRIMARY PATH: use locals.principal.isAdmin when available.
            // This is computed by deriveIsAdmin() in principal.ts and handles BOTH
            // session (group/pin verdict) and token (ownerIsAdmin + scope) paths
            // correctly — fixing the admin-token-rejected bug class.
            //
            // AUTHORITATIVE: when a Principal exists, resolveAuth already ran and
            // its verdict is final — we must NOT fall through to locals.user.
            // locals.user.isAdmin is derived from the user's live GROUPS alone
            // (buildUserPermissions), so for token credentials it ignores the
            // token's scopes entirely. Falling back re-granted admin to:
            //   - a device-flow JWT held by an admin (tvOS/TV clients — a shared
            //     room device with no lock screen must never carry admin), and
            //   - a low-scope PAT owned by an admin — the exact bug class
            //     deriveIsAdmin() documents as closed.
            // See principal.ts: "enforce({kind:'admin'}) reads ONLY this field".
            if (event.locals.principal) {
                // A delegateToAdmin() handoff carries the outer gate's decision.
                if (isDelegatedAdmin(event)) return null;
                return event.locals.principal.isAdmin ? null : ApiProblem.forbidden();
            }

            // (There is no user-flag fallback: without a principal nothing is
            // admin, see localsIsAdmin. Only a Bearer credential can still
            // supply one below.)

            // TERTIARY PATH: token-only Bearer clients where neither locals.principal
            // nor locals.user has been populated by resolveAuth (e.g. legacy /api/admin/*
            // routes that don't yet go through mount()). This is the narrowing fallback
            // for routes that have NOT been migrated to mount() yet.
            //
            // R5: MUST materialise event.locals.principal here, not just return a
            // boolean — ~132 of 176 admin defs are kind:'admin', and forward-auth's
            // "Bearer exception" (hooks.server.ts) deliberately never builds a
            // Principal for a Bearer caller on /api/admin/*. Without this, every
            // audited action taken by a Bearer PAT/service-token admin caller on
            // one of those defs fell through auditActor()'s
            // `principalBeforeDelegation(event) ?? locals.principal ?? locals.user`
            // to `{username: null}` → actor:'system', principal_kind/credential_id
            // both NULL — the exact stolen-credential-unattributable scenario R5
            // exists to close. Mirrors the case 'scope' C20 fallback above,
            // including credentialId: the resolved token's own id.
            //
            // Fix round 1 (Important #3) — INVARIANT, read before adding a
            // {kind:'any'} def that puts {kind:'admin'} ahead of a weaker
            // arm: `event.locals.principal = bearerPrincipal` below is a
            // SIDE EFFECT that also fires on the FORBIDDEN path (isAdmin
            // false) — it is not exclusive to the "admin, proceed" branch.
            // A later arm in the SAME `case 'any'` loop (see enforce()
            // above) that reads `locals.principal` (e.g. {kind:'user'}) can
            // therefore still see an identity this arm just denied.
            //
            // resolveBearerAdminPrincipal() ALSO short-circuits to `null`
            // (item 15) — skipping this side effect entirely — when the
            // token carries no admin-class scope at all, since deriveIsAdmin
            // could never be true for it anyway. That's a safe optimisation
            // for every CURRENT caller (all four only ever consult
            // `.isAdmin`), but it means a `null` short-circuit and a
            // resolved-but-non-admin Principal are NOT observationally
            // identical to a LATER {kind:'any'} arm: a ['read']-scoped
            // token hits the short-circuit (no side effect, a later
            // {kind:'user'} arm sees nothing), while a ['users:admin']
            // -scoped token does NOT (isAdminClassScope is broader than
            // deriveIsAdmin's own admin/tasks:admin check — see
            // resolve-bearer-principal.ts), still pays the DB round trip,
            // still gets a non-admin Principal, and a later {kind:'user'}
            // arm DOES see it. Two non-admin tokens, different outcomes on
            // the same def, purely from where the coarse short-circuit
            // predicate lands.
            //
            // Not currently reachable (defs/users/search.ts is the one real
            // {kind:'admin'} + {kind:'user'}-fallback `any` def, and it is
            // `visibility:'internal'` with no /api/v1 mount, outside
            // hooks.server.ts's /api/admin/* Bearer exception) — but a
            // future def with that shape reachable via Bearer would inherit
            // this inconsistency. If you add one, either don't rely on the
            // admin arm's failure-path side effect, or revisit this
            // short-circuit.
            const bearerPrincipal = await resolveBearerAdminPrincipal(event);
            if (bearerPrincipal) {
                event.locals.principal = bearerPrincipal;
                // isAdmin comes from buildPrincipal()'s deriveIsAdmin() — the
                // owner's real admin status AND an admin-class scope — never
                // from the fact that this def declared kind:'admin'.
                return bearerPrincipal.isAdmin ? null : ApiProblem.forbidden();
            }

            return ApiProblem.forbidden();
        }

        case 'scope': {
            // When a Principal is available, check its expanded scope set first.
            // This avoids a redundant token re-validation for the common path where
            // the identity was already established by resolveAuth. Falls back to
            // authenticate() + scopeGranted() for token-only callers without a
            // Principal (task/ops routes that do their own authenticate()).
            const principal = event.locals.principal;
            if (principal) {
                const expandedScopes = principal.scopes; // already expanded at build time
                const granted = spec.anyOf.some((required) =>
                    scopeGranted(expandedScopes, required as TaskApiScope),
                );
                if (!granted) {
                    return ApiProblem.scopeRequired(spec.anyOf as string[]);
                }
                return null;
            }

            // Fallback: delegate to authenticate() + scopeGranted() from tasks/api-auth.ts.
            // authenticate() also accepts admin sessions (synthesises scopes=['admin']).
            try {
                const auth = await authenticate(event);
                requireScope(auth, ...(spec.anyOf as TaskApiScope[]));
                // C20: materialise locals.principal from the resolved identity
                // when no Principal exists yet (Bearer PAT/svc callers on
                // /api/admin/* — forward-auth's "Bearer exception" deliberately
                // never builds one there, see hooks.server.ts). Without this,
                // handlers reading event.locals.principal / event.locals.user
                // for caller identity (upload-session attribution, ownership
                // checks) saw nothing and fell back to ad hoc sentinels.
                //
                // This paragraph argues isAdmin cannot be granted TOO WIDELY
                // here, no matter what ownerIsAdmin represents: deriveIsAdmin()
                // ALSO requires an explicit 'admin' or 'tasks:admin' scope, so
                // a users:admin-only (or any non-admin-scoped) token can never
                // become isAdmin:true here even if ownerIsAdmin were wrong in
                // the permissive direction. As of security review 2026-09-23
                // (C6), ownerIsAdmin IS the full Formula-A verdict (group
                // membership OR the in-app `admin` capability, pin-aware), so
                // the OTHER direction — under-granting an in-app-only admin,
                // which the pre-C6 group-only formula did — is also closed
                // (review 5 §3 C6, the outage-class half of this finding).
                //
                // Fix round 1 (Critical): ownerIsAdmin is CONSUMED from
                // auth.identity.ownerIsAdmin — resolved by authenticate()'s
                // call into the shared producer (token-identity.ts's
                // resolveTokenIdentity(), which itself calls
                // resolveOwnerAdminStatus() / resolveOwnerIsAdminFailClosed()
                // or resolveInAppAccess()+buildUserPermissions(), per axis —
                // see ApiAuth.identity's doc comment in tasks/api-auth.ts)
                // — never re-derived here with a raw
                // isUserAdmin(auth.identity.userGroups) call. For an
                // IMPERSONATING service token, userGroups is a REAL user's
                // live IdP groups; a pin-demoted admin (admin_pinned:true,
                // is_admin:false) whose stale groups still include the admin
                // group would make a raw isUserAdmin() check here return
                // true where the resolved formula says false.
                if (!event.locals.principal && auth.identity) {
                    event.locals.principal = buildPrincipal({
                        kind: auth.tokenKind === 'pat' ? 'pat' : 'service_token',
                        userId: auth.identity.userId,
                        username: auth.identity.username,
                        userGroups: auth.identity.userGroups,
                        tokenScopes: auth.scopes,
                        sessionIsAdmin: false,
                        ownerIsAdmin: auth.identity.ownerIsAdmin,
                        // The credential's REAL forceNonAdmin kill-switch.
                        // PATs have carried this column since migration
                        // 16.255.0 too (`validated.forceNonAdmin` on the PAT
                        // branch of authenticate()) — it is not service-token
                        // only. A service token's synthetic identity carries a
                        // synthesized ['admin'] userGroups (see
                        // ApiAuth.identity's doc comment) purely FROM the
                        // token's own admin scope — without threading this
                        // through, a sandboxed (forceNonAdmin) admin-scoped
                        // token would make ownerIsAdmin true here with
                        // nothing left to veto it into isAdmin:false.
                        forceNonAdmin: auth.forceNonAdmin ?? false,
                        // R5: the specific credential's own id, so an audited
                        // action reached via this fallback is attributable to
                        // the exact PAT/service token, not just its username.
                        credentialId: auth.tokenId,
                    });
                }
                return null;
            } catch (err) {
                // ApiAuthError(401) → unauthorized/invalid_token
                // ApiAuthError(403) → scope_required
                // Any other throw  → re-throw (becomes 500 in withErrorHandler)
                if (err && typeof err === 'object' && 'statusCode' in err) {
                    const apiErr = err as { statusCode: number; message: string };
                    if (apiErr.statusCode === 401) {
                        return problem('unauthorized', { error: apiErr.message });
                    }
                    if (apiErr.statusCode === 403) {
                        return ApiProblem.scopeRequired(spec.anyOf as string[]);
                    }
                }
                throw err;
            }
        }

        case 'selfOrAdmin': {
            // All authenticated callers of this gate have a resolved principal.
            // An owner projection alone must not supply identity or admin authority.
            const principal = event.locals.principal;
            const username = principal?.username;
            if (!username) {
                return ApiProblem.unauthorized();
            }
            const paramValue = (event.params as Record<string, string | undefined>)[spec.param];
            if (!paramValue) {
                return ApiProblem.notFound(`Path parameter '${spec.param}' is missing`);
            }
            // 'me' / 'user' are conventional "current user" aliases.
            //
            // The name comparison folds case: forward-auth lowercases every
            // identity it reads ("Normalize username to lowercase for consistent
            // storage/lookup across all tables"), while a path param carries
            // whatever spelling the caller used — so a user whose IdP name is
            // `TestUserNonAdmin` was denied their OWN data, because the
            // authenticated name had become `testusernonadmin`.
            // getUserIdByUsername() already compares case-insensitively for this
            // exact reason; this is the same rule at the gate.
            const isSelf =
                username.toLowerCase() === paramValue.toLowerCase() ||
                paramValue === 'me' ||
                paramValue === 'user';
            const isAdmin = principal?.isAdmin === true;
            if (!isSelf && !isAdmin) {
                return ApiProblem.forbidden();
            }
            return null;
        }

        case 'feature': {
            const enabled =
                (spec.flag === 'FEATURE_LIVETV' && isLiveTvCleanupRequest(event)) ||
                isFeatureEnabled(spec.flag);
            if (!enabled) {
                // Feature disabled → resource does not exist for the caller
                return spec.flag === 'FEATURE_LIVETV'
                    ? ApiProblem.notFound()
                    : ApiProblem.notFound(`Feature '${spec.flag}' is not enabled`);
            }
            return enforce(spec.then, event);
        }

        case 'all': {
            for (const sub of spec.specs) {
                const result = await enforce(sub, event);
                if (result !== null) return result;
            }
            return null;
        }

        case 'any': {
            let lastFailure: Response | null = null;
            for (const sub of spec.specs) {
                const result = await enforce(sub, event);
                if (result === null) return null;
                lastFailure = result;
            }
            return lastFailure ?? ApiProblem.forbidden();
        }

        default: {
            // Exhaustiveness guard — TypeScript narrows this to `never` when all
            // variants are handled. If a new AuthSpec kind is added without updating
            // enforce(), this throws at runtime rather than silently passing.
            const exhaustive: never = spec;
            logger.error('Unknown AuthSpec kind', undefined, { spec: exhaustive });
            return ApiProblem.internalError('Unknown auth spec kind');
        }
    }
}

// ---------------------------------------------------------------------------
// enforceRateLimit() — the single def-level rate-limit chokepoint
// ---------------------------------------------------------------------------

/**
 * Enforce a def's optional `rateLimit` field (see {@link EndpointDef.rateLimit}
 * in define.ts). Called by mount() AFTER `enforce()` succeeds and BEFORE
 * request-body validation, so:
 *   - a caller that fails auth is never charged against the budget, and
 *   - a caller already over budget is rejected before its body is parsed.
 *
 * Returns null when the request is within budget, or when the def declares
 * no `rateLimit` at all (the overwhelming majority of defs). Image-provider
 * budgets are checked lazily at the upstream boundary instead. Returns the
 * problem+json 429 Response when over budget — the SAME `rate_limited` shape
 * `withMountErrorHandler` already produces when a handler THROWS a 429, so a
 * def-level limit and a handler-thrown one are indistinguishable on the wire.
 */
async function enforceRateLimit(
    def: EndpointDef,
    event: RequestEvent,
    providerWork = false,
): Promise<Response | null> {
    const rl = def.rateLimit;
    if (!rl || (rl.work === 'image-provider' && !providerWork)) return null;

    const key = rl.keyBy
        ? rl.keyBy(event)
        : `${event.locals.principal?.username ?? event.locals.user?.username ?? 'anonymous'}:${event.url.pathname}`;

    const result = await checkRateLimit(
        key,
        typeof rl.limit === 'function' ? rl.limit(event) : rl.limit,
        rl.windowSec,
    );
    if (result.allowed) return null;

    const retryAfter = Math.max(0, Math.ceil(result.resetAt - Date.now() / 1000));
    return ApiProblem.rateLimited(retryAfter, { headers: buildRateLimitHeaders(result) });
}

// ---------------------------------------------------------------------------
// mount() — wraps an EndpointDef into SvelteKit RequestHandlers
// ---------------------------------------------------------------------------

/**
 * Mount an EndpointDef onto a specific surface (internal or v1).
 *
 * Returns a partial record of SvelteKit RequestHandlers keyed by HTTP method,
 * suitable for re-export from a +server.ts file:
 *
 * ```ts
 * // src/routes/api/v1/series/[id]/+server.ts
 * import { mount } from '$lib/server/api/mount.js';
 * import { def } from '$lib/server/api/defs/series.js';
 * export const { GET, PUT, DELETE } = mount(def, { surface: 'v1' });
 * ```
 *
 * Every exported handler:
 *   1. Resolves the AuthSpec for this method.
 *   2. Calls enforce() — returns the error Response on failure.
 *   3. Calls the domain handler with (event, ctx).
 *   4. Wraps the entire call in withMountErrorHandler() so unhandled throws
 *      become problem+json 500 responses instead of SvelteKit 500 HTML pages.
 */
export function mount(
    def: EndpointDef,
    ctx: SurfaceContext,
): Partial<Record<HttpMethod, RequestHandler>> {
    const out: Partial<Record<HttpMethod, RequestHandler>> = {};

    for (const [methodStr, handler] of Object.entries(def.handlers) as [
        HttpMethod,
        (typeof def.handlers)[HttpMethod],
    ][]) {
        if (!handler) continue;
        const method = methodStr as HttpMethod;
        const spec = resolveAuthSpec(def.auth, method);

        const run = withMountErrorHandler(method, async (event: RequestEvent) => {
            // Step 1: auth
            const authResult = await enforce(spec, event);
            if (authResult !== null) return authResult;

            // Some routes acquire an identity after hooks. Viewer policy applies here too;
            // admin configuration and owner-checked cleanup are separate capabilities.
            if (isLiveTvRouteId(event.route?.id ?? null) && !isLiveTvCleanupRequest(event)) {
                if (event.locals.user) {
                    const denied = liveTvRouteGate(event);
                    if (denied) return denied;
                } else if (
                    event.locals.principal?.username &&
                    !isSyntheticLiveTvIdentity(event.locals.principal) &&
                    !(await userAllowsLiveTv(event.locals.principal.username))
                ) {
                    return ApiProblem.notFound();
                }
            }

            // Step 1.5: optional per-def rate limit (see define.ts `rateLimit`).
            const rateLimitResult = await enforceRateLimit(def, event);
            if (rateLimitResult !== null) return rateLimitResult;

            // Step 2: request (input) contract — parse + validate before handler.
            // On failure returns a validation_failed Response (handler not called).
            const parsed = await validateRequest(def.request, event);
            if (parsed instanceof Response) return parsed;

            // Step 3: per-request ApiContext — base surface ctx + parsed input +
            // Idempotency-Key passthrough. Handlers that ignore these are unaffected.
            const requestCtx: ApiContext = {
                ...ctx,
                input: parsed,
                idempotencyKey: event.request.headers.get('idempotency-key') ?? undefined,
            };

            // Step 4: domain handler
            // CPU admission is lazy: ordinary API calls allocate no counters.
            // Include avatars/uploads and raw image defs that have no provider limit.
            const response = await runImageProviderBudget(
                () =>
                    def.rateLimit?.work === 'image-provider'
                        ? enforceRateLimit(def, event, true)
                        : Promise.resolve(null),
                async () => handler(event, requestCtx),
                async () => {
                    const policy = IMAGE_ENCODE_RATE_LIMIT;
                    const result = await checkRateLimit(
                        policy.keyBy(event),
                        policy.limit(event),
                        policy.windowSec,
                    );
                    return result.allowed
                        ? null
                        : ApiProblem.rateLimited(
                              Math.max(0, Math.ceil(result.resetAt - Date.now() / 1000)),
                              { headers: buildRateLimitHeaders(result) },
                          );
                },
                restrictImageRequest(event),
                event.request.signal,
            );

            // Step 5: response (output) contract. Conformance-strips the 2xx body
            // to its declared schema in dev + prod (so the wire matches the
            // published spec); gates drift as a thrown failure in test. On a hard
            // schema failure it logs and passes the ORIGINAL through — never 500.
            return finalizeResponse(def, method, response, event);
        });

        // Step 6: a deprecated operation says so on EVERY response, errors and
        // early auth/validation exits included (RFC 9745 Deprecation, RFC 8594
        // Sunset, successor Link). Wraps the whole pipeline for that reason.
        out[method] = async (event: RequestEvent) => {
            const response = await run(event);
            let docs: ReturnType<typeof resolveRouteDocs>;
            try {
                docs = resolveRouteDocs(def, event);
            } catch {
                return response; // A throwing docsByPath never breaks the request.
            }
            // An explicit HEAD handler shares its GET's documentation.
            const methodDocs = docs?.[(method === 'HEAD' ? 'GET' : method) as DocsMethod];
            const deprecation: DeprecationInfo | undefined =
                methodDocs?.stability === 'deprecated' ? methodDocs.deprecation : undefined;
            if (!deprecation) return response;
            const replacement = fillPathParams(deprecation.replacement, event.params);
            return withDeprecationHeaders(
                response,
                deprecationHeaders(
                    deprecation,
                    replacement ? apiUrl(ctx.surface, replacement) : null,
                ),
            );
        };
    }

    return out;
}

// ---------------------------------------------------------------------------
// Response (output) contract — gate (test) + conformance strip (dev + prod)
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link finalizeResponse} when response drift is detected while
 * `NODE_ENV === 'test'`, so a drifting route FAILS its test instead of only
 * logging. It escapes {@link withMountErrorHandler} unchanged (see there) so it
 * surfaces to the test runner rather than being converted into a 500.
 *
 * It is NEVER thrown in dev or production, so re-throwing it from the error
 * handler is safe in every environment.
 */
export class ResponseContractViolation extends Error {
    constructor(
        message: string,
        readonly detail: {
            method: HttpMethod;
            status: number;
            undeclaredFields?: string[];
            issues?: Array<{ path: string; code: string; message: string }>;
        },
    ) {
        super(message);
        this.name = 'ResponseContractViolation';
    }
}

/** Result of inspecting a response against its declared schema (null = not auditable). */
type ResponseInspection = {
    body: unknown;
    undeclared: string[];
    result: ReturnType<ZodType['safeParse']>;
} | null;

/**
 * Convert a SvelteKit route id to the OpenAPI `{param}` path form.
 *
 * `/api/v1/me/music/pinned-genres/[genre]` → `/api/v1/me/music/pinned-genres/{genre}`
 *
 * MIRRORS `filePathToOpenApiPath()` in scripts/openapi/generate-public.ts (and
 * its twin in check-response-contract.ts) SEGMENT FOR SEGMENT, deliberately
 * including its rough edges: route groups (`(private)`) are NOT stripped and
 * `[[optional]]` / `[x=matcher]` segments are not special-cased. That is the
 * point — `docsByPath` predicates are written against the string the GENERATOR
 * produces, so the runtime must produce the SAME string or a def would be
 * documented under one path and validated under another. A SvelteKit route id
 * is the route directory path relative to `src/routes`, which is exactly what
 * the generator derives from the `+server.ts` file path.
 */
export function routeIdToOpenApiPath(routeId: string): string {
    return routeId
        .split('/')
        .map((seg) => {
            if (seg.startsWith('[...') && seg.endsWith(']')) return `{${seg.slice(4, -1)}}`;
            if (seg.startsWith('[') && seg.endsWith(']')) return `{${seg.slice(1, -1)}}`;
            return seg;
        })
        .join('/');
}

/**
 * Resolve the OpenAPI metadata that governs THIS mount of a def.
 *
 * Mirrors the generator's precedence (generate-public.ts:~1019): `docsByPath`
 * WINS when it claims the path, `docs` is the fallback. A def mounted at more
 * than one path (a collection and a `{param}` node) can only express its
 * per-mount response schemas via `docsByPath`, so reading `docs` alone left
 * those defs with NO runtime response contract at all.
 *
 * Returns undefined when `event.route.id` is absent (SvelteKit populates it at
 * routing time, before the endpoint handler runs — but synthetic events in unit
 * tests may omit it). Absent route id → `docs` only, i.e. exactly the old
 * behaviour, never a crash.
 */
type DocsMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

const docsByPathCache = new WeakMap<EndpointDef, Map<string, EndpointDef['docs']>>();

function resolveRouteDocs(def: EndpointDef, event: RequestEvent): EndpointDef['docs'] {
    if (def.docsByPath) {
        const routeId = event.route?.id;
        if (routeId) {
            // `docsByPath` is a pure function of the path; cache it so the
            // response audit and the deprecation step share one call per mount.
            let perDef = docsByPathCache.get(def);
            if (!perDef) docsByPathCache.set(def, (perDef = new Map()));
            if (!perDef.has(routeId)) {
                perDef.set(routeId, def.docsByPath(routeIdToOpenApiPath(routeId)));
            }
            const perPath = perDef.get(routeId);
            if (perPath) return perPath;
        }
    }
    return def.docs;
}

/**
 * Inspect a response against the schema its def documents for that status,
 * WITHOUT ever throwing: a non-JSON body, a consumed stream, a `docsByPath`
 * that throws, or a schema that throws all resolve to `null` so this layer can
 * never break the request it inspects. Returns both the structural
 * undeclared-key walk and the safeParse result so the caller can gate (test),
 * log (dev), and strip (dev/prod) from a single body read.
 */
async function inspectResponse(
    def: EndpointDef,
    method: HttpMethod,
    response: Response,
    event: RequestEvent,
): Promise<ResponseInspection> {
    try {
        const docs = resolveRouteDocs(def, event);
        const responseDef =
            docs?.[method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH']?.responses?.[
                response.status
            ];
        if (!responseDef || typeof responseDef === 'string') return null;
        if (!('schema' in responseDef) || !responseDef.schema) return null;

        // Only JSON bodies are schema-describable here (binary/text/SSE skip).
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) return null;

        const body: unknown = await response.clone().json();

        // Undeclared keys must be found STRUCTURALLY, not via safeParse.
        // A plain z.object() is "strip" mode at runtime: it silently discards
        // unknown keys and safeParse SUCCEEDS. So the runtime schema is lenient
        // while the spec generated from that same schema is strict — which is
        // precisely why this drift is invisible until a strict client hits it.
        const undeclared = collectUndeclaredKeys(responseDef.schema, body);
        const result = responseDef.schema.safeParse(body);
        return { body, undeclared, result };
    } catch {
        // Never let this layer affect the request — a non-JSON body, a consumed
        // stream, or a schema that throws must all be harmless here.
        return null;
    }
}

/** Rebuild a JSON response with a new body, preserving status + headers. */
function rebuildJsonResponse(original: Response, data: unknown): Response {
    const headers = new Headers(original.headers);
    // The stripped body has a different length; drop the stale header so the
    // runtime recomputes it.
    headers.delete('content-length');
    return new Response(JSON.stringify(data), {
        status: original.status,
        statusText: original.statusText,
        headers,
    });
}

/**
 * Finalize a handler's response against the schema its def documents. Two
 * concerns, driven off a single body read:
 *
 * CONFORMANCE (STEP 1) — enforced in dev AND production. `parse()` the 2xx body
 * against its declared schema and emit the PARSED result, so what goes on the
 * wire cannot diverge from the published spec (`additionalProperties:false`).
 * On a HARD failure (missing required field / wrong type) log loudly and pass
 * the ORIGINAL response through UNCHANGED — never 500, because several routes
 * still have missing-required bugs and turning those into outages is worse than
 * the mismatch. Keep it observable and revertible.
 *
 * GATE (STEP 2) — in test only. Any drift (undeclared key OR hard mismatch)
 * THROWS {@link ResponseContractViolation} so a drifting route fails its test.
 * Conformance stripping is skipped in test: the gate is the enforcement
 * mechanism there, and silently stripping would both mask what the gate exists
 * to surface and perturb exact-body assertions.
 *
 * WHY THIS EXISTS
 * ---------------
 * zod-openapi v5 + Zod 4 emit `additionalProperties: false` for a plain
 * `z.object()` in RESPONSE position, so the published spec is STRICT even
 * though nobody wrote `.strict()`. Meanwhile nothing here validated or stripped
 * the response — whatever a service built went out verbatim. ONE undeclared key
 * therefore made a strict decoder (tvOS/Swift) fail the WHOLE response. That is
 * how `GET /api/v1/search` shipped `album` + `duration` and returned empty for
 * every music-hit query while the server reported nothing wrong.
 */
async function finalizeResponse(
    def: EndpointDef,
    method: HttpMethod,
    response: Response,
    /**
     * The live request — supplies `event.route.id` (so a `docsByPath` def can be
     * resolved to the mount it is actually serving) and `event.url.pathname`, so
     * a conformance/drift log names the route it came from.
     */
    event: RequestEvent,
): Promise<Response> {
    const routePath = event.url.pathname;
    // Read the env directly rather than importing `dev` from config.js — mount()
    // is mocked by dozens of suites that stub config.js with a partial object.
    const nodeEnv = process.env.NODE_ENV;
    const isTest = nodeEnv === 'test';
    const isProd = nodeEnv === 'production';

    const inspection = await inspectResponse(def, method, response, event);
    if (!inspection) return response;

    const { undeclared, result } = inspection;
    const hasDrift = !result.success || undeclared.length > 0;

    // ---- GATE (test only): fail the test on any drift ----
    if (hasDrift && isTest) {
        if (undeclared.length > 0) {
            throw new ResponseContractViolation(
                `RESPONSE CONTRACT DRIFT on ${method} ${response.status} — undeclared field(s): ` +
                    `${undeclared.join(', ')}. The generated spec carries ` +
                    'additionalProperties:false, so a strict decoder (tvOS/Swift) fails the ' +
                    'ENTIRE response. Declare these fields on the response schema.',
                { method, status: response.status, undeclaredFields: undeclared },
            );
        }
        throw new ResponseContractViolation(
            `Response does not match its documented schema on ${method} ${response.status}`,
            {
                method,
                status: response.status,
                issues: result.success
                    ? []
                    : result.error.issues.slice(0, 5).map((i) => ({
                          path: i.path.join('.'),
                          code: i.code,
                          message: i.message,
                      })),
            },
        );
    }

    if (!isTest) {
        const route = event.route?.id ?? null;
        if (!result.success) {
            countConformance(
                method,
                route,
                'mismatch',
                result.error.issues
                    .slice(0, 5)
                    .map((issue) => `${issue.path.join('.')}:${issue.code}`),
            );
        } else if (response.status >= 200 && response.status < 300 && undeclared.length > 0) {
            countConformance(method, route, 'stripped', undeclared.slice(0, 5));
            if (isProd && route) {
                const now = Date.now();
                const last = stripWarnings.get(route);
                if (last === undefined || now - last >= 3_600_000) {
                    stripWarnings.set(route, now);
                    logger.warn('RESPONSE CONFORMANCE — stripped undeclared fields', {
                        route,
                        method,
                        status: response.status,
                        undeclaredFields: undeclared.slice(0, 5),
                    });
                }
            }
        }
    }

    // ---- OBSERVE (dev only): log drift loudly without a second, prod-only log ----
    if (hasDrift && !isTest && !isProd) {
        if (undeclared.length > 0) {
            // NOTE the `undefined` 2nd arg: Logger.error is (message, error?, data?)
            // while Logger.warn is (message, data?, error?) — the slots are SWAPPED
            // between them. Passing data positionally as the 2nd arg here silently
            // drops it (it lands in the Error slot and logs as `undefined`), which
            // is exactly what made the first real prod hit of this log unreadable.
            logger.error(
                'RESPONSE CONTRACT DRIFT — undeclared field(s) will break strict clients',
                undefined,
                {
                    method,
                    status: response.status,
                    undeclaredFields: undeclared,
                    hint:
                        'The generated spec carries additionalProperties:false, so a strict ' +
                        'decoder (tvOS/Swift) fails the ENTIRE response. Declare these fields ' +
                        'on the response schema.',
                },
            );
        } else {
            logger.warn('Response does not match its documented schema', {
                method,
                status: response.status,
                issues: result.success
                    ? []
                    : result.error.issues.slice(0, 5).map((i) => ({
                          path: i.path.join('.'),
                          code: i.code,
                          message: i.message,
                      })),
            });
        }
    }

    // ---- CONFORM (dev + prod): strip 2xx bodies to the declared shape ----
    // Skipped in test — the gate above is the enforcement mechanism there.
    if (isTest) return response;

    const is2xx = response.status >= 200 && response.status < 300;
    if (!is2xx) return response;

    if (result.success) {
        // Emit the PARSED (stripped) body — undeclared keys are dropped so the
        // wire matches the published spec exactly.
        return rebuildJsonResponse(response, result.data);
    }

    // HARD failure (missing required / wrong type): do NOT 500. Log loudly (in
    // prod; dev already logged the mismatch above) and pass the ORIGINAL through.
    if (isProd) {
        // `undefined` 2nd arg — see the note on the DRIFT log above; Logger.error
        // is (message, error?, data?), unlike Logger.warn.
        logger.error(
            'RESPONSE CONFORMANCE — body failed its declared schema; passing the original ' +
                'through unstripped (missing-required/wrong-type is a handler bug, not an outage)',
            undefined,
            {
                route: routePath,
                method,
                status: response.status,
                issues: result.error.issues.slice(0, 5).map((i) => ({
                    path: i.path.join('.'),
                    code: i.code,
                    message: i.message,
                })),
            },
        );
    }
    return response;
}

/**
 * Walk a Zod schema alongside an actual value and collect every key present in
 * the value but absent from the schema — i.e. every key the generated spec's
 * `additionalProperties: false` would reject.
 *
 * Returns dotted paths (`items[].album`) so the log points at the real location
 * rather than just a bare field name.
 *
 * Deliberately CONSERVATIVE: anything whose shape can't be established with
 * certainty (unions, records, any/unknown, lazy/recursive schemas) is skipped
 * rather than guessed at. A false positive here would send someone chasing a
 * non-bug, which is worse than staying quiet — the static checker and the
 * generated spec remain the authorities.
 */
function collectUndeclaredKeys(schema: unknown, value: unknown, path = ''): string[] {
    if (value === null || value === undefined) return [];

    // Unwrap optional/nullable/default/readonly/catch wrappers.
    let node = schema as { def?: { type?: string; innerType?: unknown; element?: unknown } };
    const WRAPPERS = new Set([
        'optional',
        'nullable',
        'default',
        'readonly',
        'catch',
        'nonoptional',
        'prefault',
    ]);
    let guard = 0;
    while (node?.def && WRAPPERS.has(node.def.type ?? '') && guard++ < 10) {
        node = node.def.innerType as typeof node;
    }
    const type = node?.def?.type;

    if (type === 'array') {
        if (!Array.isArray(value)) return [];
        const element = node.def?.element;
        const found = new Set<string>();
        for (const item of value) {
            for (const k of collectUndeclaredKeys(element, item, `${path}[]`)) found.add(k);
        }
        return [...found];
    }

    if (type === 'object') {
        if (typeof value !== 'object' || Array.isArray(value)) return [];
        const shape = (node as unknown as { shape: Record<string, unknown> }).shape;
        if (!shape) return [];
        const out: string[] = [];
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            const declared = shape[key];
            if (declared === undefined) {
                out.push(path ? `${path}.${key}` : key);
                continue;
            }
            out.push(...collectUndeclaredKeys(declared, child, path ? `${path}.${key}` : key));
        }
        return out;
    }

    // Everything else (record/any/unknown/union/lazy/primitives) tolerates or
    // cannot be resolved — say nothing.
    return [];
}

// ---------------------------------------------------------------------------
// Request (input) contract validation
// ---------------------------------------------------------------------------

/**
 * Validate the request against a def's declarative `request` schemas.
 *
 * Runs AFTER auth and BEFORE the handler. For each declared slot:
 *   - body   — read from the request body (JSON, or form-urlencoded when the
 *              Content-Type is form-urlencoded — the OAuth/form exception).
 *   - query  — read from `event.url.searchParams` (all values are strings).
 *   - params — read from `event.params` (route params; always strings).
 *
 * On ANY schema failure, returns a `validation_failed` problem+json Response
 * carrying field-level details (path + message). On success, returns the
 * parsed/typed `ParsedInput` to attach to `ctx.input`.
 *
 * SAFETY: schemas are expected to be lenient (strip unknown fields, no
 * `.strict()`), so this never rejects a currently-valid input by surprise — it
 * only enforces the known-field contract the def author declared.
 */
async function validateRequest(
    request: RequestSchemas | undefined,
    event: RequestEvent,
): Promise<ParsedInput | Response> {
    const empty: ParsedInput = {
        body: undefined,
        query: undefined,
        params: undefined,
    };
    if (!request) return empty;

    const issues: ValidationDetail[] = [];
    const result: { body: unknown; query: unknown; params: unknown } = {
        body: undefined,
        query: undefined,
        params: undefined,
    };

    // params — from route params (always present as strings)
    if (request.params) {
        const raw = { ...(event.params as Record<string, string | undefined>) };
        const parsed = runSchema(request.params, raw, 'params', issues);
        result.params = parsed;
    }

    // query — from URL searchParams (string values; arrays for repeated keys)
    if (request.query && methodListed(request.queryMethods, event.request.method)) {
        const raw = searchParamsToObject(event.url.searchParams);
        const parsed = runSchema(request.query, raw, 'query', issues);
        result.query = parsed;
    }

    // body — JSON or form-urlencoded depending on Content-Type.
    // Only methods that carry a body are body-validated; GET/HEAD/OPTIONS skip
    // it so a def whose body schema targets its POST/PUT does not reject its GET.
    //
    // BODY DOUBLE-READ SAFETY: reading the body here consumes the underlying
    // stream, which would make a handler's own `event.request.json()/.text()/
    // .formData()` throw "Body already read". readRequestBody() therefore buffers
    // the raw body and reconstructs `event.request` so the handler still sees the
    // original body. We only do this when a `request.body` schema is declared —
    // streaming/upload handlers (no body schema) are never buffered.
    if (
        request.body &&
        methodCanHaveBody(event.request.method) &&
        methodListed(request.bodyMethods, event.request.method)
    ) {
        const maxBodyBytes = request.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

        // Cheap pre-check: a declared Content-Length over the cap is rejected
        // WITHOUT touching the body stream at all (see checkDeclaredBodySize).
        const declaredTooLarge = checkDeclaredBodySize(event, maxBodyBytes);
        if (declaredTooLarge) return declaredTooLarge;

        const bodyRaw = await readRequestBody(event, issues, maxBodyBytes);
        if (bodyRaw === BODY_TOO_LARGE) {
            return ApiProblem.payloadTooLarge();
        }
        if (bodyRaw !== BODY_ERROR) {
            const parsed = runSchema(request.body, bodyRaw, 'body', issues);
            result.body = parsed;
        }
    }

    if (issues.length > 0) {
        return problem('validation_failed', { details: issues });
    }

    return result as ParsedInput;
}

/** Sentinel returned by readRequestBody() when the body itself is unreadable. */
const BODY_ERROR = Symbol('body-parse-error');

/**
 * Reject a request whose DECLARED `Content-Length` already exceeds `maxBytes`,
 * before any part of the body is read. This is the cheap, no-stream-touch path:
 * a caller who is honest about a huge body never costs us a single read.
 *
 * Returns null when there is no Content-Length header (chunked
 * transfer-encoding, or a client that omits it) — that case is still bounded by
 * the streamed cap enforced in readBoundedBodyText() (see
 * bounded-body-reader.ts, shared with middleware/validate.ts).
 */
function checkDeclaredBodySize(event: RequestEvent, maxBytes: number): Response | null {
    if (isDeclaredContentLengthOverCap(event.request, maxBytes)) {
        return ApiProblem.payloadTooLarge();
    }
    return null;
}

/** True when the slot's method list is absent (all methods) or names this method. */
function methodListed(methods: readonly string[] | undefined, method: string): boolean {
    return methods === undefined || methods.includes(method.toUpperCase());
}

/** Methods that may carry a request body (and therefore get body validation). */
function methodCanHaveBody(method: string): boolean {
    const m = method.toUpperCase();
    return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

/**
 * Read + decode the request body for validation.
 *
 * - `application/x-www-form-urlencoded` → object of form fields. This is the
 *   documented OAuth/form exception (snake_case + form-urlencoded per RFC
 *   6749/8628).
 * - everything else (incl. missing Content-Type) → parsed as JSON.
 *
 * An empty body is decoded to `{}` so optional-only schemas pass. A malformed
 * JSON body pushes a single `body` issue and returns the BODY_ERROR sentinel.
 *
 * TRANSPARENT BODY CONSUMPTION (fixes the systemic double-read bug):
 * reading the body here would otherwise consume the request stream and make a
 * handler's own `event.request.json()/.text()/.formData()` throw "Body already
 * read". To stay transparent, we buffer the raw body TEXT once and then call
 * restoreRequestBody() to reconstruct `event.request` from that buffer, so the
 * handler re-reads the SAME body natively.
 *
 * NOTE on multipart: `multipart/form-data` is NOT round-trippable through text
 * (boundary/binary semantics), so it is parsed as JSON-default here only if it
 * ever carried a body schema — but in practice the sole multipart handler
 * (avatar upload) declares NO `request.body`, so readRequestBody() is never
 * invoked for it and its streaming `formData()` read is untouched. We therefore
 * restrict the form fast-path to `x-www-form-urlencoded`, which we can rebuild
 * exactly from the buffered text.
 */
async function readRequestBody(
    event: RequestEvent,
    issues: ValidationDetail[],
    maxBytes: number,
): Promise<unknown> {
    const contentType = (event.request.headers.get('content-type') ?? '').toLowerCase();
    const isUrlEncodedForm = contentType.includes('application/x-www-form-urlencoded');

    // A body with NO Content-Type on a cookie-authenticated request is the CORS
    // simple-request shape a cross-site page can send with the victim's cookies.
    // Never guess "JSON" for it (security review 2026-09-12, C1); Bearer requests
    // carry no cookie and are unaffected. Same rule as middleware/validate.ts.
    if (untypedBodyOnCookieAuth(event.request)) {
        issues.push({
            field: 'body',
            message: 'Content-Type header is required for a request body',
        });
        return BODY_ERROR;
    }

    // Buffer the raw body text ONCE, aborting mid-stream if it exceeds maxBytes
    // (covers a missing/lying Content-Length — the declared-size check above only
    // catches an HONEST oversized header). This consumes the original stream; we
    // immediately restore a fresh, re-readable request below.
    let text: string;
    try {
        const read = await readBoundedBodyText(event.request, maxBytes);
        if (read === BODY_TOO_LARGE) return BODY_TOO_LARGE;
        text = read;
    } catch {
        issues.push({ field: 'body', message: 'Unable to read request body' });
        return BODY_ERROR;
    }

    // Make the buffered body transparently re-readable by the handler.
    restoreRequestBody(event, text);

    if (isUrlEncodedForm) {
        // Rebuild the form object from the buffered text (no second stream read).
        try {
            const params = new URLSearchParams(text);
            const obj: Record<string, string> = {};
            for (const [key, value] of params.entries()) {
                obj[key] = value;
            }
            return obj;
        } catch {
            issues.push({ field: 'body', message: 'Malformed form-encoded body' });
            return BODY_ERROR;
        }
    }

    // Default: JSON. Tolerate an empty body (treat as {}).
    if (text.trim() === '') return {};
    try {
        return JSON.parse(text);
    } catch {
        issues.push({ field: 'body', message: 'Request body must be valid JSON' });
        return BODY_ERROR;
    }
}

/**
 * Convert URLSearchParams to a plain object suitable for Zod parsing.
 *
 * Repeated keys collapse to a string[] (so a schema can use `z.array(...)` or a
 * coercion). Single keys stay scalar strings. All values are strings — schemas
 * that want numbers/booleans should use `z.coerce.*`.
 */
function searchParamsToObject(sp: URLSearchParams): Record<string, string | string[]> {
    const obj: Record<string, string | string[]> = {};
    for (const key of new Set(sp.keys())) {
        const all = sp.getAll(key);
        obj[key] = all.length > 1 ? all : all[0];
    }
    return obj;
}

/**
 * Run one Zod schema and collect field-level issues into `issues`.
 *
 * Field paths are prefixed with the slot name (`body.rating`, `query.limit`,
 * `params.id`) so a client can locate the offending value across all slots.
 * Returns the parsed value on success, or `undefined` on failure (the caller
 * relies on `issues.length` to decide the overall outcome).
 */
function runSchema(
    schema: ZodType,
    raw: unknown,
    slot: 'body' | 'query' | 'params',
    issues: ValidationDetail[],
): unknown {
    const result = schema.safeParse(raw);
    if (result.success) return result.data;

    for (const issue of result.error.issues) {
        const path = issue.path.length > 0 ? `${slot}.${issue.path.join('.')}` : slot;
        issues.push({ field: path, message: issue.message });
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the AuthSpec for a specific HTTP method.
 *
 * When `auth` is a single AuthSpec, it applies to all methods.
 * When `auth` is a per-method map, the method MUST be present — if it is not,
 * we fail-closed with forbidden() rather than accidentally opening the route.
 */
function resolveAuthSpec(auth: EndpointDef['auth'], method: HttpMethod): AuthSpec {
    if ('kind' in auth) {
        // Single spec applies to all methods
        return auth as AuthSpec;
    }
    // Per-method map
    const map = auth as Partial<Record<HttpMethod, AuthSpec>>;
    const spec = map[method];
    if (!spec) {
        // Fail-closed: no spec → treat as forbidden
        logger.warn(`No AuthSpec defined for method ${method} — failing closed`);
        return { kind: 'admin' }; // most restrictive safe default
    }
    return spec;
}

/**
 * Wrap a handler with error handling that converts unhandled throws into
 * problem+json 500 responses (never HTML 500 pages on the v1 surface).
 */
function withMountErrorHandler(
    method: HttpMethod,
    handler: (event: RequestEvent) => Promise<Response>,
): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        try {
            return await handler(event);
        } catch (err) {
            if (err instanceof AuthDependencyUnavailableError) return authUnavailableResponse();
            // Redirects are framework control flow; let SvelteKit handle them.
            if (isRedirect(err)) throw err;

            // The test-mode response-contract gate must reach the test runner,
            // not be converted into a 500. It is never thrown in dev/prod.
            if (err instanceof ResponseContractViolation) throw err;

            const statusCode = (err as { statusCode?: number })?.statusCode;

            if (statusCode === 401) {
                return problem('unauthorized', {
                    error: (err as Error).message,
                });
            }
            if (statusCode === 403) {
                return problem('forbidden', {
                    error: (err as Error).message,
                });
            }
            // Services signal client-side faults by throwing an Error carrying a
            // `statusCode` (upload-session.service.ts, the ancillary def, …).
            // Only 401/403 were translated, so everything else — an unsupported
            // MIME type, a conflicting session, a saturated quota — escaped as
            // `internal_error`, telling the caller the server broke when the
            // request was at fault. Map the rest of the taxonomy too. 400 has no
            // code of its own (see ProblemCode): a malformed request is 422
            // `validation_failed`.
            if (statusCode === 400 || statusCode === 422) {
                return ApiProblem.validationFailed((err as Error).message);
            }
            if (statusCode === 404) {
                return ApiProblem.notFound((err as Error).message);
            }
            if (statusCode === 409) {
                return problem('conflict', { error: (err as Error).message });
            }
            // adapter-node's BODY_SIZE_LIMIT rejects `request.formData()` with a
            // SvelteKitError carrying `status` 413 (not `statusCode`) — an
            // oversized upload, not a server fault.
            if (isPayloadTooLargeError(err)) {
                return ApiProblem.payloadTooLarge();
            }
            if (statusCode === 429) {
                if (err instanceof AISuggestionRateLimitError) {
                    return ApiProblem.rateLimited(err.retryAfter);
                }
                return problem('rate_limited', { error: (err as Error).message });
            }
            if (statusCode === 503) {
                return ApiProblem.dependencyUnavailable((err as Error).message);
            }

            // Last-resort input/constraint mapping for mounted endpoints only.
            // Explicit service status codes and responses from local catches win.
            // Never log the driver error: detail/query/parameters can contain input.
            if (
                typeof err === 'object' &&
                err !== null &&
                'code' in err &&
                typeof err.code === 'string'
            ) {
                let response: Response | undefined;
                switch (err.code) {
                    case '22P02': // invalid text representation
                    case '22003': // numeric value out of range
                    case '23514': // check constraint
                        response = ApiProblem.validationFailed('Invalid database value');
                        break;
                    case '23503': // foreign key (missing or still-referenced resource)
                        response = ApiProblem.conflict(
                            'Referenced resource is missing or still in use',
                        );
                        break;
                    case '23505': // unique constraint
                        response = ApiProblem.conflict('Resource already exists');
                        break;
                }
                if (response) {
                    const constraint =
                        'constraint_name' in err && typeof err.constraint_name === 'string'
                            ? err.constraint_name
                            : undefined;
                    logger.warn('Database request constraint rejected', {
                        sqlstate: err.code,
                        constraint,
                    });
                    return response;
                }
            }

            logger.error(`Unhandled error in ${method} handler`, err as Error, {
                path: event.url.pathname,
            });
            return ApiProblem.internalError();
        }
    };
}

/**
 * Resolve a full `Principal` from a Bearer PAT or service token, for the
 * `{kind:'admin'}` TERTIARY fallback (no Principal/locals.user populated by
 * resolveAuth — see enforce() above).
 *
 * Thin wrapper around the shared `resolveBearerAdminPrincipal()` helper
 * (`$lib/server/auth/resolve-bearer-principal.ts`) — `middleware/auth.ts`'s
 * `requireAdmin()` uses the SAME
 * helper, so every Bearer-only admin fallback resolves one consistent
 * `Principal` instead of each re-deriving its own.
 *
 * R5: returns the built `Principal` (not just a boolean) so the caller can
 * stash it on `event.locals.principal` — otherwise a Bearer admin caller on
 * one of the ~132 `kind:'admin'` defs leaves `principal`/`user` both unset
 * for the whole request, and any `auditLog()` call downstream attributes the
 * action to `'system'` with no credential recorded at all. `isAdmin` on the
 * returned Principal is `buildPrincipal()`'s own `deriveIsAdmin()` verdict —
 * ownerIsAdmin AND an admin-class scope — never assumed true just because
 * this helper was reached from a `kind:'admin'` def.
 */
async function resolveBearerAdminPrincipal(event: RequestEvent): Promise<Principal | null> {
    const { resolveBearerAdminPrincipal: resolveShared } =
        await import('$lib/server/auth/resolve-bearer-principal.js');
    return resolveShared(event);
}

/**
 * Resolve a feature flag from the server config.
 *
 * Resolution order (first boolean wins):
 *   1. A `FEATURE_*` property on the config object (e.g. flag `playlists` →
 *      `config.FEATURE_PLAYLISTS`). This is the original, env-backed path.
 *   2. The `config.features` namespace (e.g. flag `textToSound` →
 *      `config.features.textToSound`). Some feature flags are EXPRESSED only as
 *      composed getters on `features` — they have no flat `FEATURE_<UPPER>`
 *      key (e.g. `textToSound = FEATURE_MUSIC_TEXT_SOUND && sonicEmbeddings`,
 *      `lyricsSearch`). This matches the legacy `requireFeature(flag)` middleware,
 *      which reads `features[flag]` — so a `{kind:'feature'}` AuthSpec gates a
 *      mounted route identically to its hand-written predecessor.
 *
 * Unknown flags return `false` (fail-closed) so a typo doesn't accidentally
 * enable a route.
 */
function isFeatureEnabled(flag: string): boolean {
    const key = flag.startsWith('FEATURE_') ? flag : `FEATURE_${flag.toUpperCase()}`;
    const value = (config as unknown as Record<string, unknown>)[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'function') {
        const result = (value as () => unknown)();
        return typeof result === 'boolean' ? result : false;
    }

    // Fallback: the `features` namespace (composed getters with no flat key).
    // `features` getters resolve to a boolean on property access.
    const nsValue = (features as unknown as Record<string, unknown>)[flag];
    if (typeof nsValue === 'boolean') return nsValue;
    return false;
}

// ---------------------------------------------------------------------------
// Re-export scopeGranted for use in handler logic (avoids double-import)
// ---------------------------------------------------------------------------
export { scopeGranted };
