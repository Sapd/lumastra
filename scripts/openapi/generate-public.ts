// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// scripts/openapi/generate-public.ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { z } from 'zod';
import { isLenientBatchDocs } from './lenient-batch.js';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import type { RouteMetadata, MethodMetadata, ResponseDef } from '../../src/lib/server/openapi';
import {
    BEARER_AUTH,
    NO_AUTH,
    apiErrorResponse,
    binaryResponse,
    textResponse,
    sseResponse,
    buildResponseHeaders,
} from './helpers';
import { requiredGrantForAuth } from './required-grant';
import { deprecationProblem } from '../../src/lib/server/api/deprecation';
import { ACCEPTED_DRIFT, driftKey, lookupAcceptedDrift, type DriftSlot } from './accepted-drift';

/**
 * A KEPT-drift row: `chooseSlot` kept the hand-authored `_openapi.ts` value for
 * one request slot because letting the def win would lose a documented contract
 * detail. Collected structurally (not just as a string) so the reporter can
 * classify each row against the ACCEPTED-DRIFT allowlist AFTER collection —
 * allowlisted rows print as ACCEPTED-DRIFT and drop out of the pending tally;
 * everything else still reports loudly. `loudNote` is the exact pre-allowlist
 * message, reused verbatim for pending (non-allowlisted) rows.
 */
interface KeptDriftRow {
    method: string;
    path: string;
    slot: DriftSlot;
    loudNote: string;
}

const ROOT = resolve(import.meta.dirname, '../..');
const PUBLIC_API_DIR = resolve(ROOT, 'src/routes/api/v1');

// ============================================================================
// Path conversion: filesystem → OpenAPI
// ============================================================================

/**
 * Convert SvelteKit filesystem path to OpenAPI path.
 *
 * src/routes/api/v1/playback/[itemId]/hls/+server.ts
 * → /api/v1/playback/{itemId}/hls
 *
 * src/routes/api/v1/media/[id]/images/[role]/[index]/+server.ts
 * → /api/v1/media/{id}/images/{role}/{index}
 */
function filePathToOpenApiPath(filePath: string): string {
    const rel = relative(resolve(ROOT, 'src/routes'), filePath);
    // Remove +server.ts
    const dir = dirname(rel);
    // Convert [param] → {param}, [...param] → {param}
    const segments = dir
        .split('/')
        .filter((seg) => !seg.startsWith('('))
        .map((seg) => {
            if (seg.startsWith('[...') && seg.endsWith(']')) {
                return `{${seg.slice(4, -1)}}`;
            }
            if (seg.startsWith('[') && seg.endsWith(']')) {
                return `{${seg.slice(1, -1)}}`;
            }
            return seg;
        });
    return '/' + segments.join('/');
}

/**
 * Extract path parameter Zod schema from OpenAPI path string.
 * /public-api/playback/{itemId}/hls → z.object({ itemId: z.string() })
 */
function extractPathParams(
    openApiPath: string,
): z.ZodObject<Record<string, z.ZodString>> | undefined {
    const params: Record<string, z.ZodString> = {};
    const matches = Array.from(openApiPath.matchAll(/\{(\w+)\}/g));
    for (const match of matches) {
        params[match[1]] = z.string().min(1);
    }
    if (Object.keys(params).length === 0) return undefined;
    return z.object(params);
}

/**
 * Merge an `_openapi.ts` `params:` override onto the path params auto-derived
 * from the route's `{segment}`s. The derived params are all `z.string()`; a
 * route may override the TYPE of specific segments (e.g. a numeric `width` →
 * `z.coerce.number().int()`) by declaring just those keys in `method.params`.
 *
 * Only keys that already exist as path segments are overridden — extra keys in
 * the override are ignored so a stray declaration can't invent a phantom path
 * parameter. Returns the derived object unchanged when there is no override.
 */
function mergePathParams(
    derived: z.ZodObject<Record<string, z.ZodString>> | undefined,
    override: z.ZodObject | undefined,
): z.ZodObject | undefined {
    if (!derived || !override) return derived;
    const overrideShape = override.shape as Record<string, z.ZodType>;
    const merged: Record<string, z.ZodType> = { ...derived.shape };
    for (const key of Object.keys(merged)) {
        if (key in overrideShape) merged[key] = overrideShape[key];
    }
    return z.object(merged);
}

// ============================================================================
// Re-export resolution
// ============================================================================

const RE_EXPORT_PATTERN = /export\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g;

/**
 * Check if a file is a pure re-export and return the source path.
 * Returns null if the file has its own handler logic.
 * Warns if multiple different re-export sources are detected.
 */
function resolveReExportSource(
    filePath: string,
    source: string,
    warnings: string[],
): string | null {
    // Skip files that define their own handlers (have function bodies).
    // A destructured `export const { GET } = mount(` is also an own handler —
    // the real metadata lives in the colocated _openapi.ts, not in the def file.
    if (
        source.includes('async (') ||
        source.includes('async({') ||
        source.includes('RequestHandler =') ||
        source.includes('mount(')
    ) {
        // Check if it ALSO has a re-export (some files do both)
        // If it has its own handler definitions, it's a custom implementation
        const hasOwnHandler =
            /export\s+const\s+(GET|POST|PUT|DELETE|PATCH)\s*[=:]/.test(source) ||
            /export\s+const\s+\{[^}]*\}\s*=\s*mount\(/.test(source);
        if (hasOwnHandler) return null;
    }

    const matches = Array.from(source.matchAll(RE_EXPORT_PATTERN));
    if (matches.length === 0) return null;

    // Warn if multiple different source files
    const sources = [...new Set(matches.map((m) => m[1]))];
    if (sources.length > 1) {
        warnings.push(
            `Multiple re-export sources in ${relative(ROOT, filePath)}: ${sources.join(', ')}`,
        );
    }

    const match = matches[0];

    const importPath = match[1];
    // Resolve relative import to absolute path.
    //
    // `$lib/…` is resolved explicitly. Left to `resolve(dir, …)` it produced a
    // path INSIDE the route directory (`…/[ino]/$lib/server/services/x.ts`),
    // which then failed `readFileSync` — and the caller's failure branch counts
    // the route as undocumented and `continue`s BEFORE it ever looks for an
    // `_openapi.ts`. That is why the three audiobook byte routes reported as
    // "missing both _openapi.ts and def.docs" with no name attached: the
    // "missing" was a broken alias, not a missing file.
    const dir = dirname(filePath);
    let resolved = importPath.startsWith('$lib/')
        ? resolve(ROOT, 'src', importPath.slice('$'.length))
        : resolve(dir, importPath);

    // Handle .js → .ts extension mapping
    if (resolved.endsWith('.js')) {
        resolved = resolved.slice(0, -3) + '.ts';
    }

    // Handle bare directory imports → +server.ts
    if (!resolved.endsWith('.ts')) {
        resolved = resolve(resolved, '+server.ts');
    }

    return resolved;
}

// ============================================================================
// Auth detection
// ============================================================================

/**
 * Does a def's RUNTIME auth spec require a credential?
 *
 * Fixes a documentation defect that shipped to third parties: `security` was
 * emitted from the per-operation docs annotation, falling back to
 * `detectAuth(handlerSource)` — a grep for `requireAuth`/`requireAdmin`. That
 * heuristic works for hand-written routes and is blind to def-mounted ones,
 * whose auth is a structured `auth: { kind: 'scope', anyOf: [...] }` object. So
 * 83 of 502 documented operations (36 of them mutating) declared NO security
 * while the runtime denied them correctly, and the omission landed precisely on
 * the SCOPE-GATED ones — the more privileged an endpoint, the likelier the
 * published spec told a client author it needed no credential.
 *
 * `public` is the only kind that is genuinely un-gated, and it stays that way:
 * /oauth/token and /oauth/device must keep NO_AUTH.
 */
function authSpecRequiresCredential(spec: unknown): boolean {
    if (!spec || typeof spec !== 'object') return false;
    const kind = (spec as { kind?: unknown }).kind;
    switch (kind) {
        case 'public':
            return false;
        case 'user':
        case 'admin':
        case 'scope':
        case 'selfOrAdmin':
            return true;
        case 'feature':
            // The flag decides WHETHER the gate applies, `then` is the gate.
            return authSpecRequiresCredential((spec as { then?: unknown }).then);
        case 'all': {
            // Every gate must pass, so one credential-requiring gate is enough.
            const specs = (spec as { specs?: unknown[] }).specs ?? [];
            return specs.some(authSpecRequiresCredential);
        }
        case 'any': {
            // Any ONE gate may pass: a public alternative makes it reachable
            // without a credential.
            const specs = (spec as { specs?: unknown[] }).specs ?? [];
            return specs.length > 0 && specs.every(authSpecRequiresCredential);
        }
        default:
            return false;
    }
}

/**
 * `kind: 'public'` does NOT reliably mean unauthenticated.
 *
 * Five defs declare `public` on purpose and then authenticate IN THE HANDLER,
 * so they can emit a custom error body that mount()'s declarative gate would
 * preempt. `defs/library/ingest.ts` is the clearest case: it declares
 * `{kind:'public'}`, calls `authenticate()` + `requireScope(auth,'tasks:run')`
 * itself, has a colocated test pinning its self-documenting 403 — and its own
 * description says "Requires an admin PAT or service token with `tasks:run`
 * scope". Emitting NO_AUTH for it would be a new documentation defect in place
 * of the old one.
 *
 * This is a text search, so a def that only MENTIONS authenticate() in a comment
 * counts. That bias is deliberate: over-stating auth in a published spec is far
 * safer than telling a third-party client author no credential is needed.
 */
function defSourceSelfAuthenticates(defSource: string): boolean {
    return /\b(authenticate|requireScope|requireAuth|requireAdmin)\s*\(/.test(defSource);
}

/** Resolve `def.auth`, which may be a single spec or a per-method map. */
function defAuthForMethod(defAuth: unknown, httpMethod: string): unknown {
    if (!defAuth || typeof defAuth !== 'object') return undefined;
    if ('kind' in (defAuth as Record<string, unknown>)) return defAuth;
    const perMethod = defAuth as Record<string, unknown>;
    return perMethod[httpMethod] ?? perMethod[httpMethod.toUpperCase()];
}

function detectAuth(source: string): 'bearer' | 'none' {
    if (source.includes('requireAuth') || source.includes('requireAdmin')) {
        return 'bearer';
    }
    return 'none';
}

// ============================================================================
// GUARD C — request-body validation detection (conservative)
// ============================================================================

/**
 * Heuristic: does the handler source for a write route VALIDATE a request body?
 * Used by GUARD C to catch write routes whose handler reads/validates a body but
 * whose `_openapi.ts` forgot `body:` (so requestBody is missing from the spec —
 * the PUT /watch-state/{id} bug class).
 *
 * Deliberately CONSERVATIVE — only fires on the two unambiguous body-validation
 * shapes the codebase actually uses, so action-only POSTs (e.g. a "refresh" with
 * no body) don't produce false positives:
 *
 *   1. Direct handlers wrap with `withValidation(...)` AND pass a `{ body: Schema }`
 *      option:  matches /withValidation\s*\(/ AND /\bbody:\s*[A-Za-z_]/.
 *   2. Def-mounted handlers declare a request body in their def:
 *      `request: { ... body: Schema ... }`.
 *
 * Both must reference an identifier after `body:` (a schema), not `body: undefined`
 * or a bare word in prose, hence the `[A-Za-z_]` lookahead.
 */
function handlerValidatesBody(handlerSource: string): boolean {
    const hasWithValidationBody =
        /withValidation\s*\(/.test(handlerSource) && /\bbody:\s*[A-Za-z_]/.test(handlerSource);
    // Def-mounted: `request: { ... body: Schema }`. Match a `body:` that appears
    // inside a `request:` block (defs put query/body under `request:`).
    const hasDefRequestBody =
        /request:\s*\{/.test(handlerSource) && /\bbody:\s*[A-Za-z_]/.test(handlerSource);
    return hasWithValidationBody || hasDefRequestBody;
}

// ============================================================================
// GUARD D — request-query validation detection (conservative)
// ============================================================================

/**
 * Resolve the def source for a `mount(def, ...)`-based route, so GUARD D can
 * see query validation that lives in the def file instead of the (usually
 * 3-line) `+server.ts` mount() call.
 *
 * GUARD C's body detection never needed this: request bodies on def-mounted
 * routes in this codebase are declared by hand in `_openapi.ts` today, so
 * `handlerSource` (the `+server.ts` text) was enough. Query omission is the
 * newer, unnoticed drift this guard exists to catch — several def-mounted
 * routes (`/sessions`, `/playlists`, ...) validate `request.query` in the def
 * but the short mount() call never mentions `query:`, so scanning only
 * `handlerSource` would silently miss them. This mirrors
 * `resolveReExportSource()`'s import-path resolution (relative/`.js`→`.ts`/
 * bare-directory → `index.ts`) but keys off `import { def } from '...'`
 * instead of `export { X } from '...'`, and additionally understands the
 * `$lib/...` alias used by every def import in this codebase.
 */
function resolveMountedDefPath(filePath: string, source: string): string | null {
    if (!/mount\s*\(\s*def\b/.test(source)) return null;
    const importMatch = source.match(/import\s*\{\s*def\s*\}\s*from\s*['"]([^'"]+)['"]/);
    if (!importMatch) return null;

    const importPath = importMatch[1];
    let resolved = importPath.startsWith('$lib/')
        ? resolve(ROOT, 'src/lib', importPath.slice('$lib/'.length))
        : resolve(dirname(filePath), importPath);

    if (resolved.endsWith('.js')) {
        resolved = resolved.slice(0, -3) + '.ts';
    }
    if (!resolved.endsWith('.ts')) {
        resolved = resolve(resolved, 'index.ts');
    }
    return resolved;
}

function resolveMountedDefSource(filePath: string, source: string): string | null {
    const resolved = resolveMountedDefPath(filePath, source);
    if (!resolved) return null;
    try {
        return readFileSync(resolved, 'utf-8');
    } catch {
        return null;
    }
}

/**
 * Structural signature of a Zod schema for cheap equality comparison. Used only
 * to decide whether a def-sourced slot actually DIFFERS from the `_openapi.ts`
 * value (so we log real disagreements, not every def-mounted route). Compares
 * the INPUT JSON Schema (matters for `z.coerce.*`). Returns null when the schema
 * is absent or not representable — callers must treat null as "can't compare".
 */
function schemaSignature(schema: z.ZodType | undefined): string | null {
    if (!schema) return null;
    try {
        return JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
    } catch {
        return null;
    }
}

/**
 * Heuristic: does the source for a route VALIDATE query parameters? Used by
 * GUARD D to catch routes whose handler/def reads a query but whose
 * `_openapi.ts` forgot `query:` (so query parameters are missing from the
 * spec — generated clients have no way to know they can send them).
 *
 * Deliberately CONSERVATIVE — exact structural twin of `handlerValidatesBody`,
 * just for `query:` instead of `body:`:
 *
 *   1. Direct handlers wrap with `withValidation(...)` AND pass a
 *      `{ query: Schema }` option: matches /withValidation\s*\(/ AND
 *      /\bquery:\s*[A-Za-z_]/.
 *   2. Def-mounted handlers declare a request query in their def:
 *      `request: { ... query: Schema ... }`.
 *
 * Both must reference an identifier after `query:` (a schema), not
 * `query: undefined` or a bare word in prose, hence the `[A-Za-z_]` lookahead.
 *
 * KNOWN GAP: this does NOT detect raw `url.searchParams.get(...)` reads in
 * hand-written handlers that skip both `withValidation` and a def entirely.
 * Those routes must be audited manually — catching
 * ad-hoc searchParams reads is out of scope for this conservative guard.
 */
function handlerValidatesQuery(source: string): boolean {
    const hasWithValidationQuery =
        /withValidation\s*\(/.test(source) && /\bquery:\s*[A-Za-z_]/.test(source);
    const hasDefRequestQuery = /request:\s*\{/.test(source) && /\bquery:\s*[A-Za-z_]/.test(source);
    return hasWithValidationQuery || hasDefRequestQuery;
}

// ============================================================================
// Response conversion
// ============================================================================

export function convertResponse(
    statusCode: number,
    def: ResponseDef,
    context = '',
): Record<string, unknown> {
    if (typeof def === 'string') {
        // Simple description-only response (204, simple errors)
        if (statusCode === 204) {
            return { description: def };
        }
        return apiErrorResponse(def, statusCode);
    }

    // Description-only error response with an explicit problem `code`
    // override (no `headers`/`schema`/`binary`/`text`/`sse` key) — e.g. a 503
    // the handler actually sends as `stream_limit`, not the status-default
    // `dependency_unavailable`.
    if ('code' in def) {
        return apiErrorResponse(def.description, statusCode, def.code);
    }

    // Optional custom response headers (e.g. X-Trickplay-* on byte surfaces),
    // shared by every object-shaped response variant below.
    const headers = buildResponseHeaders(def.headers);
    const withHeaders = (response: Record<string, unknown>): Record<string, unknown> =>
        headers ? { ...response, headers } : response;

    if ('schema' in def) {
        // Keep custom problem extensions without changing legacy JSON response metadata.
        return withHeaders({
            description:
                def.description ?? (statusCode >= 400 ? 'Error response' : 'Successful response'),
            content: {
                [def.contentType ?? 'application/json']: {
                    schema: def.schema,
                },
            },
        });
    }

    if ('binary' in def) {
        return withHeaders(
            binaryResponse(
                def.binary,
                def.description ?? 'Binary response',
                `${context}${context ? ' ' : ''}[${statusCode}]`.trim(),
            ),
        );
    }

    if ('text' in def) {
        return withHeaders(textResponse(def.text, def.description ?? 'Text response'));
    }

    if ('sse' in def) {
        return withHeaders(sseResponse(def.description ?? 'Server-Sent Events stream'));
    }

    // Header-only, no-body response (e.g. a 304 that still sets ETag). No
    // `content` key at all — unlike every branch above, there is no body to
    // document.
    if ('headers' in def) {
        return withHeaders({ description: def.description });
    }

    return { description: 'Unknown response type' };
}

/**
 * Default stability tier from the OpenAPI path when a route doesn't declare
 * one. Core primitives → stable; UI-aggregation/discovery → beta;
 * auth-bypass/device/streaming → protocol. Everything else → beta.
 */
type StabilityTier = 'stable' | 'beta' | 'protocol';

const PROTOCOL_PREFIXES = ['/api/v1/livetv/channels/'];

const PROTOCOL_SUBSTRINGS = ['/stream', '/hls', '/avp/', '/heartbeat', '/telemetry'];

const STABLE_PREFIXES = [
    '/api/v1/search',
    '/api/v1/media',
    '/api/v1/people',
    '/api/v1/users',
    '/api/v1/libraries',
    '/api/v1/series',
    '/api/v1/seasons',
    '/api/v1/episodes',
    '/api/v1/music',
    '/api/v1/playback/',
    '/api/v1/sessions',
    '/api/v1/watchlist',
    '/api/v1/history',
    '/api/v1/server',
    '/api/v1/requests',
];

const BETA_PREFIXES = [
    '/api/v1/trending',
    '/api/v1/continue-watching',
    '/api/v1/recommendations',
    '/api/v1/feed',
    '/api/v1/upcoming',
    '/api/v1/playlists',
];

function defaultStability(openApiPath: string): StabilityTier {
    if (
        PROTOCOL_PREFIXES.some((p) => openApiPath.startsWith(p)) ||
        PROTOCOL_SUBSTRINGS.some((s) => openApiPath.includes(s))
    ) {
        return 'protocol';
    }
    if (BETA_PREFIXES.some((p) => openApiPath.startsWith(p))) return 'beta';
    if (STABLE_PREFIXES.some((p) => openApiPath.startsWith(p))) return 'stable';
    return 'beta';
}

/**
 * The request contract read directly off a def-mounted route's `def.request`
 * (the SAME Zod object mount() validates at runtime).
 */
interface DefRequest {
    query?: z.ZodType;
    body?: z.ZodType;
    params?: z.ZodType;
    queryMethods?: readonly string[];
    bodyMethods?: readonly string[];
}

/**
 * The FINAL, already-resolved request schemas for one method — the output of
 * {@link chooseRequestSlots} after reconciling the def-sourced contract with the
 * hand-authored `_openapi.ts`. Passed to {@link buildMethodSpec} for def-mounted
 * routes; `undefined` for hand-written routes (which use `_openapi.ts` verbatim).
 */
interface ResolvedRequest {
    query?: z.ZodType;
    body?: z.ZodType;
    params?: z.ZodType;
}

const WRITE_HTTP_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * The set of named request keys a slot schema documents (query/body param
 * names), used to decide whether the def-sourced schema is a strict SUPERSET of
 * the hand-authored one (so def can win without LOSING a documented param).
 *
 * Returns:
 *  - a `Set` of top-level property names for an object schema,
 *  - an empty `Set` for an object schema with no documented properties (e.g. a
 *    lenient `z.looseObject({})` mount-gate → `properties: {}`),
 *  - `null` when the schema is absent or not a keyable object (array/union/…),
 *    which callers treat as "can't prove coverage".
 */
/**
 * The per-key JSON-Schema constraint keywords that carry PUBLISHED-CONTRACT
 * meaning: if `_openapi.ts` declares one on a key and the def's schema for that
 * key lacks it, letting the def win would silently downgrade the spec. Compared
 * by exact (keyword,value) pair. `minimum`/`maximum` equal to the JS safe-integer
 * sentinels are IGNORED (they are `z.int()` noise the generator strips anyway).
 */
const CONSTRAINT_KEYWORDS = [
    'enum',
    'const',
    'format',
    'pattern',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'multipleOf',
] as const;
const SAFE_INT_MAX = 9007199254740991;
const SAFE_INT_MIN = -9007199254740991;

/**
 * A structural profile of a request-slot schema, computed from its INPUT JSON
 * Schema, used to decide whether a def-sourced schema can win WITHOUT losing any
 * documented contract detail (a key, a required flag, or a per-key constraint).
 *
 * `keys === null` marks a schema that is present but NOT a keyable object
 * (union / discriminatedUnion / array / …). Such a schema can't be proven a
 * superset key-by-key, so the caller must NOT let a def override it.
 */
interface SlotProfile {
    keys: Set<string> | null;
    required: Set<string>;
    /** key → set of `keyword:value` constraint tokens found anywhere in that key's subtree. */
    constraints: Map<string, Set<string>>;
    /** key → description text `_openapi` attached (for description recovery). */
    descriptions: Map<string, string>;
}

/** Collect published-contract constraint tokens from a JSON-Schema subtree. */
function collectConstraints(node: unknown, out: Set<string>): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) collectConstraints(item, out);
        return;
    }
    const rec = node as Record<string, unknown>;
    for (const kw of CONSTRAINT_KEYWORDS) {
        if (!(kw in rec)) continue;
        const v = rec[kw];
        if (kw === 'minimum' && v === SAFE_INT_MIN) continue; // z.int() noise
        if (kw === 'maximum' && v === SAFE_INT_MAX) continue; // z.int() noise
        out.add(`${kw}:${JSON.stringify(v)}`);
    }
    // Recurse into the shapes that carry a key's real constraint (nullable
    // `anyOf`, `items`, etc.) — but NOT into `properties`, so a key's profile
    // never absorbs its siblings' or children's object-property constraints.
    for (const sub of ['anyOf', 'oneOf', 'allOf', 'items', 'not', 'then', 'else']) {
        if (sub in rec) collectConstraints(rec[sub], out);
    }
}

function slotProfile(schema: z.ZodType | undefined): SlotProfile | null {
    if (!schema) return null;
    let js: Record<string, unknown>;
    try {
        js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
            string,
            unknown
        >;
    } catch {
        return null;
    }
    const props = js.properties;
    const required = new Set<string>(Array.isArray(js.required) ? (js.required as string[]) : []);
    const constraints = new Map<string, Set<string>>();
    const descriptions = new Map<string, string>();
    if (props && typeof props === 'object' && !Array.isArray(props)) {
        const keys = new Set(Object.keys(props));
        for (const [k, sub] of Object.entries(props as Record<string, unknown>)) {
            const cset = new Set<string>();
            collectConstraints(sub, cset);
            constraints.set(k, cset);
            const d = (sub as Record<string, unknown>)?.description;
            if (typeof d === 'string' && d.length > 0) descriptions.set(k, d);
        }
        return { keys, required, constraints, descriptions };
    }
    // Present object with NO documented properties (e.g. lenient z.looseObject({})).
    if (js.type === 'object') return { keys: new Set(), required, constraints, descriptions };
    // Present but un-keyable (union / array / …).
    return { keys: null, required, constraints, descriptions };
}

/**
 * Merge `_openapi.ts`'s per-key descriptions onto the WINNING def object schema
 * for keys that the def documents without a description of their own. This
 * recovers the human doc text `_openapi` carried (which plain def Zod usually
 * lacks) WITHOUT touching the runtime contract — descriptions are pure metadata.
 * Net-new def keys with no `_openapi` counterpart legitimately stay undescribed.
 *
 * Returns the def schema unchanged when it is not a plain keyable object or when
 * nothing needed merging (so byte output is untouched in that case).
 */
function mergeDescriptions(defSchema: z.ZodType, openapiProfile: SlotProfile): z.ZodType {
    const shape = (defSchema as unknown as { shape?: Record<string, z.ZodType> }).shape;
    if (!shape || typeof shape !== 'object') return defSchema;
    let changed = false;
    const nextShape: Record<string, z.ZodType> = {};
    for (const [key, keySchema] of Object.entries(shape)) {
        const existing = (keySchema as unknown as { description?: unknown }).description;
        const hasDesc = typeof existing === 'string' && existing.length > 0;
        const donor = openapiProfile.descriptions.get(key);
        if (!hasDesc && donor) {
            nextShape[key] = keySchema.describe(donor);
            changed = true;
        } else {
            nextShape[key] = keySchema;
        }
    }
    if (!changed) return defSchema;
    return z.object(nextShape);
}

/**
 * Choose the schema for one request slot, reconciling the def-sourced schema
 * against the hand-authored `_openapi.ts` one. The GOAL is drift-impossibility
 * (source from the def, which is what mount() validates) WITHOUT ever losing a
 * documented contract detail — key, required flag, OR per-key constraint. A def
 * may win over a PRESENT `_openapi` slot ONLY when ALL hold:
 *   (a) def key-set ⊇ `_openapi` key-set,
 *   (b) def required-set ⊇ `_openapi` required-set (no required→optional
 *       downgrade), AND
 *   (c) def preserves every per-key enum/min/max/format/pattern/… `_openapi`
 *       declared (no constraint erasure).
 * Otherwise the richer `_openapi` is KEPT and the conflict logged.
 *
 * Rules (in order):
 *  1. No def schema         → keep `_openapi.ts`.
 *  2. No `_openapi` schema   → use the def (a previously-hidden param, now exposed).
 *  3. `_openapi` is a present object with NO documented keys (lenient/opaque) →
 *     use the def. NOTE: an un-keyable `_openapi` (union/array) is NOT this case —
 *     it falls to rule 5 so a rich union body is never erased by a lenient def.
 *  4. def satisfies (a)+(b)+(c) → use the def (superset, no loss); recover
 *     descriptions from `_openapi`.
 *  5. Otherwise → KEEP `_openapi.ts`, log the exact reason (dropped keys /
 *     required downgrade / lost constraints) for a later cleanup phase.
 */
function chooseSlot(
    name: 'query' | 'body' | 'params',
    defSchema: z.ZodType | undefined,
    openapiSchema: z.ZodType | undefined,
    opLabel: string,
    notes: string[],
    method: string,
    openApiPath: string,
    keptRows: KeptDriftRow[],
): z.ZodType | undefined {
    // Record a KEPT row structurally so the reporter can later split it into
    // ACCEPTED-DRIFT (allowlisted) vs pending-reconcile. `detail` is the reason
    // clause; the loud note is byte-identical to the pre-allowlist wording so
    // non-allowlisted rows report exactly as before.
    const recordKept = (detail: string): void => {
        keptRows.push({
            method,
            path: openApiPath,
            slot: name,
            loudNote: `${opLabel}: ${name} KEPT _openapi.ts — ${detail} (def is a lenient/partial gate; reconcile in cleanup phase)`,
        });
    };
    if (!defSchema) return openapiSchema; // rule 1
    if (!openapiSchema) {
        notes.push(`${opLabel}: ${name} GAINED from def (absent in _openapi.ts)`);
        return defSchema; // rule 2
    }

    if (name === 'body' && isLenientBatchDocs(defSchema, openapiSchema)) {
        notes.push(
            `${opLabel}: body uses typed lenient-batch documentation (runtime validates records individually)`,
        );
        return openapiSchema;
    }

    const dp = slotProfile(defSchema);
    const op = slotProfile(openapiSchema);
    const differ = (() => {
        const a = schemaSignature(defSchema);
        const b = schemaSignature(openapiSchema);
        return a !== null && b !== null && a !== b;
    })();

    // rule 3: _openapi is a present object documenting NO keys → nothing to lose.
    // (Un-keyable _openapi — op.keys === null — deliberately does NOT qualify.)
    if (op && op.keys !== null && op.keys.size === 0) {
        if (differ)
            notes.push(`${opLabel}: ${name} sourced from def (def wins over empty _openapi.ts)`);
        return defSchema;
    }

    // rule 5a (union hole): _openapi present but un-keyable (union/array) → keep it.
    if (!op || op.keys === null) {
        recordKept('_openapi schema is a union/array the def cannot be proven to cover');
        return openapiSchema;
    }

    // Evaluate the three superset conditions against the keyed _openapi profile.
    const droppedKeys = dp?.keys ? [...op.keys].filter((k) => !dp.keys!.has(k)) : [...op.keys];
    const lostRequired = [...op.required].filter((k) => !(dp?.required.has(k) ?? false));
    const lostConstraints: string[] = [];
    for (const [key, ocons] of op.constraints) {
        const dcons = dp?.constraints.get(key) ?? new Set<string>();
        for (const c of ocons) if (!dcons.has(c)) lostConstraints.push(`${key}{${c}}`);
    }

    const keysOk = dp?.keys != null && droppedKeys.length === 0;
    const requiredOk = lostRequired.length === 0;
    const constraintsOk = lostConstraints.length === 0;

    // rule 4: def is a true superset (keys + required + constraints) → def wins.
    if (keysOk && requiredOk && constraintsOk) {
        if (differ) {
            const added = dp?.keys ? [...dp.keys].filter((k) => !op.keys!.has(k)) : [];
            const suffix = added.length ? ` (adds [${added.join(', ')}])` : '';
            notes.push(`${opLabel}: ${name} sourced from def, superset of _openapi.ts${suffix}`);
        }
        return mergeDescriptions(defSchema, op);
    }

    // rule 5: def would lose a documented detail → keep _openapi, log the reason.
    const reasons: string[] = [];
    if (droppedKeys.length) reasons.push(`drop keys [${droppedKeys.join(', ')}]`);
    if (lostRequired.length)
        reasons.push(`downgrade required→optional [${lostRequired.join(', ')}]`);
    if (lostConstraints.length) reasons.push(`lose constraints [${lostConstraints.join(', ')}]`);
    recordKept(`def would ${reasons.join('; ')}`);
    return openapiSchema;
}

/**
 * Reconcile a def-mounted route's `def.request` with its `_openapi.ts` metadata
 * for ONE HTTP method, producing the final query/body/params schemas plus a
 * review log. Body is only considered for methods that can carry one (mount()
 * validates `request.body` solely for POST/PUT/PATCH/DELETE), so a def body
 * schema never emits a spurious requestBody on a GET. Params from the def simply
 * refine the typing of existing `{segment}`s (they can never add/remove a path
 * param), so the def always wins there when present.
 */
function chooseRequestSlots(
    method: MethodMetadata,
    defRequest: DefRequest,
    httpMethod: string,
    openApiPath: string,
    opLabel: string,
    notes: string[],
    keptRows: KeptDriftRow[],
): ResolvedRequest {
    const isWrite = (WRITE_HTTP_METHODS as readonly string[]).includes(httpMethod);
    const query = chooseSlot(
        'query',
        defRequest.queryMethods && !defRequest.queryMethods.includes(httpMethod)
            ? undefined
            : defRequest.query,
        method.query,
        opLabel,
        notes,
        httpMethod,
        openApiPath,
        keptRows,
    );
    const body = chooseSlot(
        'body',
        isWrite && (!defRequest.bodyMethods || defRequest.bodyMethods.includes(httpMethod))
            ? defRequest.body
            : undefined,
        method.body,
        opLabel,
        notes,
        httpMethod,
        openApiPath,
        keptRows,
    );

    // Params run through the SAME no-loss reconciliation, but each candidate is
    // first merged onto the URL-derived floor (`z.string().min(1)` per `{segment}`)
    // so the comparison is against exactly what the route emitted BEFORE. A def
    // `params` override that dropped a key/format/pattern/min the baseline had —
    // e.g. a plain `z.string()` that erases the `{id}` `minLength:1` floor, or a
    // missing `{id}` UUID `format` — loses the constraint check and keeps the
    // baseline. mergePathParams only touches real path segments, so no phantom
    // params. The result is already URL-merged (buildMethodSpec re-merge is a no-op).
    const urlBase = extractPathParams(openApiPath);
    const openapiParams = mergePathParams(urlBase, method.params);
    const defParams = defRequest.params
        ? mergePathParams(urlBase, defRequest.params as z.ZodObject | undefined)
        : undefined;
    const params = chooseSlot(
        'params',
        defParams,
        openapiParams,
        opLabel,
        notes,
        httpMethod,
        openApiPath,
        keptRows,
    );
    return { query, body, params };
}

/**
 * Spec fields for the deprecation policy, or the reason the docs are invalid.
 * `stability: 'deprecated'` and a `deprecation` block go together: one without
 * the other would make the spec and the runtime headers (mount.ts) disagree.
 */
export function deprecationSpecFields(
    stability: string,
    deprecation: MethodMetadata['deprecation'],
): Record<string, unknown> | string {
    if (stability !== 'deprecated') {
        return deprecation ? "a deprecation block needs stability 'deprecated'" : {};
    }
    if (!deprecation) return "stability 'deprecated' needs a deprecation block (since, replacement)";
    const problem = deprecationProblem(deprecation);
    if (problem) return `deprecation block: ${problem}`;
    return { deprecated: true, 'x-deprecation': deprecation };
}

function buildMethodSpec(
    method: MethodMetadata,
    openApiPath: string,
    handlerSource: string,
    httpMethod = '',
    resolved?: ResolvedRequest,
    defRuntimeAuth?: unknown,
    defSource?: string,
): Record<string, unknown> {
    // The RUNTIME auth spec is authoritative when it requires a credential: the
    // docs annotation and the handler-source grep both miss def-mounted gates.
    // See authSpecRequiresCredential.
    const runtimeRequiresCredential =
        authSpecRequiresCredential(defAuthForMethod(defRuntimeAuth, httpMethod)) ||
        (defSource !== undefined && defSourceSelfAuthenticates(defSource));
    const auth = method.auth === 'bearer-or-grant'
        ? 'bearer-or-grant'
        : runtimeRequiresCredential
          ? 'bearer'
          : (method.auth ?? detectAuth(handlerSource));

    // For def-mounted routes the caller passes the already-reconciled `resolved`
    // schemas; hand-written routes leave it undefined and use `_openapi.ts` (the
    // exact pre-Phase-1 behaviour, byte-for-byte).
    const useResolved = resolved !== undefined;
    const query = useResolved ? resolved.query : method.query;
    const body = useResolved ? resolved.body : method.body;
    const paramsOverride = useResolved ? resolved.params : method.params;

    // Path params: URL-template–derived string params, refined by the chosen
    // `params` override. mergePathParams only touches keys that are real path
    // segments, so an over-broad override can't invent a phantom path parameter.
    const pathParams = mergePathParams(
        extractPathParams(openApiPath),
        paramsOverride as z.ZodObject | undefined,
    );

    const stability = method.stability ?? defaultStability(openApiPath);

    const spec: Record<string, unknown> = {
        tags: method.tags,
        summary: method.summary,
        'x-stability': stability,
    };

    if (method.description) {
        spec.description = method.description;
    }

    const deprecationSpec = deprecationSpecFields(stability, method.deprecation);
    if (typeof deprecationSpec === 'string') throw new Error(`${httpMethod} ${openApiPath}: ${deprecationSpec}`);
    Object.assign(spec, deprecationSpec);

    // Explicit operationId override (preserved by addOperationIds, which only
    // auto-derives when operationId is absent). Used to disambiguate a genuine
    // cross-doc collision without changing the auto-derived camelCase elsewhere.
    if (method.operationId) {
        spec.operationId = method.operationId;
    }

    spec.security = auth === 'bearer-or-grant'
        ? [{ bearerAuth: [] }, { grant: [] }]
        : auth === 'bearer' ? BEARER_AUTH : NO_AUTH;

    // Mintable token grant a PAT / service token needs, from the runtime gate.
    const requiredGrant = requiredGrantForAuth(defAuthForMethod(defRuntimeAuth, httpMethod), httpMethod);
    if (requiredGrant && auth === 'bearer') spec['x-required-grant'] = requiredGrant;

    // Request params (path + query + header)
    //
    // `header` is sourced straight from `method.headers` (never reconciled
    // through `chooseRequestSlots`/`resolved` like query/body/params are):
    // there is no runtime-validated `def.request.headers` slot to reconcile
    // against — mount() does not parse headers — so `docs[method].headers`
    // is always authoritative on its own, same as a hand-written
    // `_openapi.ts`'s `query`/`params` was before def-mounted routes existed.
    const requestParams: Record<string, unknown> = {};
    if (pathParams) requestParams.path = pathParams;
    if (query) requestParams.query = query;
    if (method.headers) requestParams.header = method.headers;
    if (Object.keys(requestParams).length > 0) {
        spec.requestParams = requestParams;
    }

    // Request body
    if (body) {
        spec.requestBody = {
            ...(method.bodyRequired !== undefined ? { required: method.bodyRequired } : {}),
            content: {
                'application/json': { schema: body },
            },
        };
    }

    // Responses
    const responses: Record<string, unknown> = {};
    const responseContext = `${httpMethod} ${openApiPath}`.trim();
    for (const [code, def] of Object.entries(method.responses)) {
        responses[code] = convertResponse(Number(code), def, responseContext);
    }

    // Auto-add common errors based on auth
    if (auth !== 'none') {
        if (!responses['401']) responses['401'] = apiErrorResponse('Authentication required', 401);
        if (!responses['500']) responses['500'] = apiErrorResponse('Internal server error', 500);
    } else {
        if (!responses['500']) responses['500'] = apiErrorResponse('Internal server error', 500);
    }

    spec.responses = responses;
    return spec;
}

// ============================================================================
// Main collection function
// ============================================================================

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

export interface CollectionResult {
    /** Routes whose _openapi.ts visibility is 'public' (default). */
    routes: ZodOpenApiPathsObject;
    /**
     * Routes whose _openapi.ts visibility is 'internal'. These are still
     * mounted on /api/v1/* and reachable as today — this only diverts them
     * from the published api-v1.yaml into internal-api.yaml.
     */
    internalRoutes: ZodOpenApiPathsObject;
    /** Tags collected from PUBLIC routes only (drives api-v1.yaml tag list). */
    tags: Array<{ name: string; description?: string }>;
    warnings: string[];
    /**
     * GUARD B — `_openapi.ts` files that EXIST but threw on dynamic-import.
     * Distinct from genuinely-absent `_openapi.ts` (which is `stats.missing`):
     * an import failure means the route was SILENTLY DROPPED from the spec even
     * though the author wrote metadata for it. The classic cause is the file
     * (transitively) importing a def, which pulls the server runtime
     * (cache/tasks/lua) and throws under tsx. `generate.ts --check` fails on any
     * entry here. Each entry is a human-readable `<file>: <error>` line.
     */
    importFailures: string[];
    /**
     * GUARD C — public write routes (PUT/POST/PATCH) whose handler validates a
     * request body but whose built operation has no requestBody (the
     * `_openapi.ts` forgot `body:`). The requestBody would be missing from the
     * spec → client codegen produces a body-less call. `--check` fails on these.
     */
    bodyOmissions: string[];
    /**
     * Public operations without an explicit `stability` in their docs. The
     * path-prefix default only applies to internal-spec operations: the public
     * label is a promise to third parties, so it is always chosen by hand.
     */
    unlabelledPublic: string[];
    /**
     * GUARD D — public routes whose handler/def validates query parameters but
     * whose built operation has no `query:` (the `_openapi.ts` forgot it, or
     * the def's `request.query` was never spread into it). Query parameters
     * would be missing from the spec → client codegen has no way to send them.
     * `--check` fails on these. See `handlerValidatesQuery()` for the known
     * gap (raw `searchParams.get()` reads are not detected).
     */
    queryOmissions: string[];
    /**
     * Phase 1 — human-review log of def-mounted routes whose request contract is
     * now sourced from `def.request` (the runtime-validated Zod object) instead
     * of `_openapi.ts`. Two kinds of entry:
     *   - "GAINED": the def declares a query/body the `_openapi.ts` never did, so
     *     the spec now exposes previously-hidden request parameters (the point of
     *     the change).
     *   - "DIFFERS": both declare the slot but the schemas are structurally
     *     different — the def wins; review the `_openapi.ts` value for staleness.
     * Informational only (never fails `--check`); printed by generate.ts.
     *
     * NOTE: KEPT rows ("… reconcile in cleanup phase") are NO LONGER routed here.
     * They are collected structurally and split into {@link acceptedDrift} vs
     * {@link pendingDrift} against the E1 allowlist (`accepted-drift.ts`). This
     * array now carries only the GAINED / def-superset / def-wins informational
     * notes.
     */
    defDisagreements: string[];
    /**
     * ACCEPTED-DRIFT — KEPT rows on the E1 allowlist (`accepted-drift.ts`). Each
     * is a permanent, individually-adjudicated false-alarm (def is an intentional
     * lenient/partial gate; handler re-validates). Printed for visibility but
     * EXCLUDED from the pending-reconcile tally. Report-only: the KEPT slot still
     * keeps `_openapi.ts` verbatim, so the generated yaml is byte-identical.
     */
    acceptedDrift: string[];
    /**
     * PENDING drift — KEPT rows that are NOT on the E1 allowlist. These still
     * report loudly (verbatim pre-allowlist wording), so genuinely-new drift is
     * no longer buried among the 19 permanent false-alarms. Informational (does
     * not fail `--check`), matching the prior KEPT-note behaviour.
     */
    pendingDrift: string[];
    /**
     * STALE allowlist entries — rows in `accepted-drift.ts` that did NOT match
     * any KEPT row this run (the drift they described is gone, or the row key no
     * longer matches). Surfaced so the allowlist can be pruned; the allowlist and
     * the live KEPT set must not silently diverge. Informational only.
     */
    staleAllowlist: string[];
    stats: {
        total: number;
        withMetadata: number;
        reExports: number;
        custom: number;
        missing: number;
        /** Count of routes diverted to internal-api.yaml via visibility. */
        internal: number;
    };
}

/**
 * Walk the /api/v1 routes directory and collect OpenAPI metadata.
 */
export async function collectPublicRoutes(): Promise<CollectionResult> {
    const entries = readdirSync(PUBLIC_API_DIR, {
        withFileTypes: true,
        recursive: true,
    });
    const files = entries
        .filter((e) => e.name === '+server.ts')
        .map((e) => join(e.parentPath ?? (e as unknown as { path: string }).path, e.name))
        .sort(); // deterministic order

    const routes: ZodOpenApiPathsObject = {};
    const internalRoutes: ZodOpenApiPathsObject = {};
    const tagSet = new Map<string, string>(); // name → description
    const warnings: string[] = [];
    const importFailures: string[] = []; // GUARD B
    const bodyOmissions: string[] = []; // GUARD C
    const unlabelledPublic: string[] = [];
    const queryOmissions: string[] = []; // GUARD D
    const defDisagreements: string[] = []; // Phase 1 def-source review log (non-KEPT notes)
    const keptRows: KeptDriftRow[] = []; // KEPT slots — classified against the allowlist below
    let reExportCount = 0;
    let customCount = 0;
    let missingCount = 0;
    let internalCount = 0;

    for (const filePath of files) {
        const openApiPath = filePathToOpenApiPath(filePath);
        const source = readFileSync(filePath, 'utf-8');

        // Determine where to find the route metadata
        let metadataFilePath = filePath;
        let handlerSource = source; // for auth detection

        const reExportTarget = resolveReExportSource(filePath, source, warnings);
        if (reExportTarget) {
            reExportCount++;
            try {
                metadataFilePath = reExportTarget;
                handlerSource = readFileSync(reExportTarget, 'utf-8');
            } catch {
                warnings.push(
                    `Re-export target not found: ${reExportTarget} (from ${relative(ROOT, filePath)})`,
                );
                missingCount++;
                continue;
            }
        } else {
            customCount++;
        }

        // ------------------------------------------------------------------
        // Phase 2: import the def UP-FRONT (for def-mounted routes) to read
        // BOTH its runtime request contract (`def.request`) AND its inline
        // OpenAPI doc metadata (`def.docs`) — the migrated single-source form
        // that replaces the colocated `_openapi.ts`. A def that EXISTS but
        // throws on import is LOUD: it joins GUARD B's importFailures so
        // `--check` fails rather than silently dropping the route.
        // ------------------------------------------------------------------
        let defRequest: DefRequest | undefined;
        let defDocs: RouteMetadata | undefined;
        let defRuntimeAuth: unknown;
        let defSourceText: string | undefined;
        const defPath = resolveMountedDefPath(filePath, source);
        if (defPath && existsSync(defPath)) {
            try {
                const defMod = await import(defPath);
                const def = defMod.def as
                    | {
                          request?: DefRequest;
                          docs?: RouteMetadata;
                          docsByPath?: (openApiPath: string) => RouteMetadata | undefined;
                          auth?: unknown;
                      }
                    | undefined;
                defRuntimeAuth = def?.auth;
                // Read for the in-handler-auth check above.
                defSourceText = readFileSync(defPath, 'utf8');
                if (def?.request) {
                    defRequest = {
                        query: def.request.query,
                        body: def.request.body,
                        params: def.request.params,
                        queryMethods: def.request.queryMethods,
                        bodyMethods: def.request.bodyMethods,
                    };
                }
                // A def mounted at multiple paths supplies `docsByPath` (called
                // with THIS route's OpenAPI path); it may return undefined to defer
                // to the route's _openapi.ts (e.g. an internal mount). Single-mount
                // routes use `docs`. `docsByPath` wins when it claims the path.
                if (def?.docsByPath) defDocs = def.docsByPath(openApiPath);
                if (!defDocs && def?.docs) defDocs = def.docs;
            } catch (err) {
                importFailures.push(
                    `${relative(ROOT, defPath)} (def for ${openApiPath}): ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        // Look for _openapi.ts sibling file (avoids importing +server.ts
        // which has SvelteKit dependencies that can't resolve outside the build)
        //
        // The ROUTE's own directory wins over the re-export target's. A route that
        // re-exports a shared handler module (the audiobook byte routes all
        // re-export `audiobook-stream-routes.ts`) has nowhere else to put its
        // metadata: one `_openapi.ts` beside the shared module could only describe
        // one of the three paths, and they have different parameters, responses and
        // meanings.
        const routeDir = dirname(filePath);
        const handlerDir = existsSync(join(routeDir, '_openapi.ts'))
            ? routeDir
            : dirname(metadataFilePath);
        const openapiFilePath = join(handlerDir, '_openapi.ts');
        let openapiRoute: RouteMetadata | undefined;

        if (existsSync(openapiFilePath)) {
            try {
                const mod = await import(openapiFilePath);
                openapiRoute = mod.route as RouteMetadata | undefined;
            } catch (err) {
                // GUARD B: the file EXISTS but threw → the route is silently
                // dropped from the spec. Track this distinctly from a genuinely
                // absent _openapi.ts (stats.missing) so --check can fail on it.
                const msg = `${relative(ROOT, openapiFilePath)} (serves ${openApiPath}): ${err instanceof Error ? err.message : String(err)}`;
                importFailures.push(msg);
                warnings.push(`Failed to import ${msg}`);
            }
        }

        // COVERAGE: a route is covered by its `_openapi.ts` `route` export OR by
        // its def's inline `docs`. Prefer `def.docs` (migrated single-source form)
        // over `_openapi.ts` when both exist. `def.docs` is a DROP-IN replacement:
        // whichever wins becomes `routeMeta`, and the reconciliation/build path
        // below is byte-for-byte identical regardless of provenance.
        const routeMeta: RouteMetadata | undefined = defDocs ?? openapiRoute;

        if (!routeMeta) {
            missingCount++;
            warnings.push(
                `No _openapi.ts or def.docs in ${relative(ROOT, handlerDir)}/ (serves ${openApiPath})`,
            );
            continue;
        }

        // SPEC/DOC visibility: 'internal' defaults this path's methods to
        // internal-api.yaml. Defaults to 'public'. Does NOT affect routing/auth.
        //
        // Read ONLY docs visibility (method override, then route default) from
        // `_openapi.ts` or `def.docs`. `def.visibility` is deliberately NOT consulted:
        // many public routes carry `visibility:'internal'` on their def for an
        // internal RUNTIME classification while the published route is 'public',
        // and the historical generator honored ONLY the `_openapi.ts` value.
        // Consulting `def.visibility` here wrongly diverted such routes to
        // internal-api.yaml the moment they were migrated to `def.docs`.
        // Build path item from route metadata
        const pathItem: Record<string, unknown> = {};
        const internalPathItem: Record<string, unknown> = {};

        // GUARD C pre-pass: does this route's handler validate a request body,
        // and does ANY method already declare `body:`? If the handler validates a
        // body but NO method declares one, a write method that omits `body:` is a
        // genuine omission. If SOME method declares `body:`, the validation is
        // "accounted for" — don't flag the other (action-only) write methods,
        // keeping the heuristic conservative.
        const writeMethods = ['PUT', 'POST', 'PATCH'] as const;
        const fileValidatesBody = handlerValidatesBody(handlerSource);
        const anyMethodDeclaresBody = writeMethods.some((m) => routeMeta?.[m]?.body !== undefined);

        // GUARD D pre-pass: does this route's handler/def validate query params
        // (checked over `handlerSource` PLUS the resolved def source for
        // `mount(def, ...)` routes — see resolveMountedDefSource), and does ANY
        // method already declare `query:`? Unlike GUARD C, this applies to ALL
        // HTTP methods (not just writes) — query params are used by GET too.
        // If SOME method declares `query:`, the validation is "accounted for" —
        // don't flag the other methods, keeping the heuristic conservative.
        const defSource = resolveMountedDefSource(filePath, source);
        const querySource = defSource ? `${handlerSource}\n${defSource}` : handlerSource;
        const fileValidatesQuery = handlerValidatesQuery(querySource);
        const anyMethodDeclaresQuery = HTTP_METHODS.some(
            (m) => routeMeta?.[m]?.query !== undefined,
        );

        // Request-contract provenance for GUARD C/D suppression (the def already
        // supplies the slot, so an omitted `_openapi.ts`/`docs` slot is not a gap).
        const defProvidesQuery = defRequest?.query !== undefined;
        const defProvidesBody = defRequest?.body !== undefined;

        for (const httpMethod of HTTP_METHODS) {
            const methodMeta = routeMeta[httpMethod];
            if (!methodMeta) continue;
            const methodIsInternal = (methodMeta.visibility ?? routeMeta.visibility) === 'internal';

            // Request-slot resolution. `def.docs` is a DROP-IN replacement for
            // the sibling `_openapi.ts`: once `routeMeta` is chosen (def.docs ??
            // imported _openapi route), the code path below is byte-for-byte
            // identical regardless of provenance. For any def-mounted route
            // (`defRequest` present) the SAME Phase-1 reconciliation runs between
            // `def.request` and `routeMeta[method]` — so moving a `route` object
            // verbatim into `def.docs` yields the identical output it produced
            // when it lived in the sibling file. Hand-written routes (no def)
            // pass `undefined` → `_openapi.ts` verbatim.
            const resolved = defRequest
                ? chooseRequestSlots(
                      methodMeta,
                      defRequest,
                      httpMethod,
                      openApiPath,
                      `${httpMethod} ${openApiPath}`,
                      defDisagreements,
                      keptRows,
                  )
                : undefined;

            if (!methodIsInternal && methodMeta.stability === undefined) {
                unlabelledPublic.push(`${httpMethod} ${openApiPath}`);
            }

            const targetPathItem = methodIsInternal ? internalPathItem : pathItem;
            targetPathItem[httpMethod.toLowerCase()] = buildMethodSpec(
                methodMeta,
                openApiPath,
                handlerSource,
                httpMethod,
                resolved,
                defRuntimeAuth,
                defSourceText,
            );

            // GUARD C: a public write method whose handler validates a body but
            // whose metadata declares no `body:` → requestBody missing from spec.
            // Suppressed when the def supplies the body (it's now in the spec).
            if (
                !methodIsInternal &&
                fileValidatesBody &&
                !anyMethodDeclaresBody &&
                !defProvidesBody &&
                (writeMethods as readonly string[]).includes(httpMethod) &&
                methodMeta.body === undefined
            ) {
                bodyOmissions.push(
                    `${httpMethod} ${openApiPath} validates a request body but its _openapi.ts declares no \`body:\` (requestBody will be missing from the spec)`,
                );
            }

            // GUARD D: a public method whose handler/def validates query params
            // but whose metadata declares no `query:` → parameters missing from spec.
            // Suppressed when the def supplies the query (it's now in the spec).
            if (
                !methodIsInternal &&
                fileValidatesQuery &&
                !anyMethodDeclaresQuery &&
                !defProvidesQuery &&
                methodMeta.query === undefined
            ) {
                queryOmissions.push(
                    `${httpMethod} ${openApiPath} validates a query but its _openapi.ts declares no \`query:\` (parameters will be missing from the spec)`,
                );
            }

            // Collect tags from PUBLIC routes only — internal-route tags must
            // not pollute the published api-v1.yaml tag list.
            if (!methodIsInternal) {
                for (const tag of methodMeta.tags) {
                    if (!tagSet.has(tag)) {
                        tagSet.set(tag, '');
                    }
                }
            }
        }

        if (Object.keys(pathItem).length > 0) {
            routes[openApiPath] = pathItem;
        }
        if (Object.keys(internalPathItem).length > 0) {
            internalRoutes[openApiPath] = internalPathItem;
            internalCount++;
        }
    }

    // Build sorted tags array
    const tags = Array.from(tagSet.keys())
        .sort()
        .map((name) => ({ name }));

    // ------------------------------------------------------------------
    // Classify each KEPT slot against the E1 ACCEPTED-DRIFT allowlist.
    // Allowlisted rows → acceptedDrift (verified permanent false-alarm, kept OUT
    // of the pending tally). Everything else → pendingDrift (still loud). Any
    // allowlist entry that matched NO KEPT row this run → staleAllowlist, so the
    // allowlist and the live KEPT set can't silently diverge. Report-only: the
    // slot schema already returned is unchanged, so the yaml is byte-identical.
    // ------------------------------------------------------------------
    const acceptedDrift: string[] = [];
    const pendingDrift: string[] = [];
    const matchedAllowlistKeys = new Set<string>();
    for (const row of keptRows) {
        const entry = lookupAcceptedDrift(row.method, row.path, row.slot);
        if (entry) {
            matchedAllowlistKeys.add(driftKey(row.method, row.path, row.slot));
            acceptedDrift.push(
                `${row.method} ${row.path}: ${row.slot} ACCEPTED-DRIFT (E1 verdict #${entry.verdict}): ${entry.reason}`,
            );
        } else {
            pendingDrift.push(row.loudNote);
        }
    }
    const staleAllowlist = ACCEPTED_DRIFT.filter(
        (entry) => !matchedAllowlistKeys.has(driftKey(entry.method, entry.path, entry.slot)),
    ).map(
        (entry) =>
            `${entry.method} ${entry.path}: ${entry.slot} (E1 verdict #${entry.verdict}) — allowlisted but no matching KEPT row this run (drift resolved or key changed; prune this entry)`,
    );

    return {
        routes,
        internalRoutes,
        tags,
        warnings,
        importFailures,
        bodyOmissions,
        unlabelledPublic,
        queryOmissions,
        defDisagreements,
        acceptedDrift,
        pendingDrift,
        staleAllowlist,
        stats: {
            total: files.filter((f) => f.endsWith('+server.ts')).length,
            withMetadata: files.filter((f) => f.endsWith('+server.ts')).length - missingCount,
            reExports: reExportCount,
            custom: customCount,
            missing: missingCount,
            internal: internalCount,
        },
    };
}
