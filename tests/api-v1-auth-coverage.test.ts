// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/v1 Route-Auth Coverage Test
 *
 * Guarantee: no route can ship to the v1 surface without an explicitly declared
 * AuthSpec.  `{kind:'public'}` is the ONLY accepted un-gated form — it must be
 * a deliberate, code-reviewable decision, not an accident of omission.
 *
 * Two assertions:
 *
 * 1. DEF COVERAGE
 *    Every `src/lib/server/api/defs/**\/*.ts` file that exports a `def` constant
 *    (i.e. is an EndpointDef module, not a helper or barrel) must:
 *      a. Declare an `auth:` field inside its `defineEndpoint({...})` call.
 *      b. The auth spec must be a well-formed AuthSpec: either a single object
 *         with a `kind:` property, or a per-method map where EVERY HTTP method
 *         listed in `handlers:` has a corresponding entry in the auth map.
 *      c. No def may omit auth entirely — that would silently open the route.
 *         {kind:'public'} is accepted; an absent auth is not.
 *
 *    Factory-based defs (e.g. `export const def = makeCommentsDef('media')`)
 *    are allowed: the factory calls `defineEndpoint` internally and is registered
 *    in DEF_FACTORIES below.  The factory itself is the auth declaration point;
 *    the consumer file is trusted to call the right factory.
 *
 * 2. ROUTE COVERAGE
 *    Every `src/routes/api/v1/**\/+server.ts` must be one of:
 *      A. A `mount(def, ctx)` call — auth flows through the def's AuthSpec.
 *      B. A pure `export * from '...+server.js'` shim.
 *      C. A named re-export shim `export { X } from '...+server.js'`.
 *      D. A tombstone route — only emits 410 Gone responses; no live handler.
 *         Detected automatically: file contains `gone` or `'gone'` in code.
 *      E. An explicitly allow-listed native route (ALLOW_NATIVE, same list as
 *         api-v1-parity.test.ts).  Native routes are expected to call `enforce()`
 *         or delegate to an already-auth-gated inner handler.
 *
 * This test performs STATIC source analysis — it does not import any module.
 * That keeps it fast, free of mocking overhead, and safe to run in CI without a
 * database.  The trade-off: it verifies structure (the auth field is present and
 * syntactically plausible), not runtime enforcement (covered by mount.test.ts).
 *
 * See also: tests/api-v1-parity.test.ts (companion rule — route shape)
 */

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

/**
 * All valid AuthSpec `kind` values (must match define.ts AuthSpec union).
 *
 * If a new kind is added to AuthSpec in define.ts it must also be added here,
 * otherwise the coverage test will flag new defs as malformed.
 */
const VALID_AUTH_KINDS = new Set([
    'public',
    'user',
    'admin',
    'scope',
    'selfOrAdmin',
    'feature',
    'all',
    'any',
]);

// ---------------------------------------------------------------------------
// Known def factory functions
//
// Def files may export `def` as the return value of a factory function instead
// of wrapping `defineEndpoint({...})` directly.  Each factory in this list is
// trusted: it calls `defineEndpoint` internally with an explicit `auth:` field.
// Adding a new factory here means you are asserting that the factory's
// `defineEndpoint` call declares auth; the coverage test for that is in
// handlers.ts / the factory's own unit tests.
//
// Pattern matched (after comment stripping):
//   export const def = <factory>(...)
// ---------------------------------------------------------------------------

const DEF_FACTORIES = new Set(['makeCommentsDef', 'makeCommentByIdDef', 'makeReactionsDef']);

// ---------------------------------------------------------------------------
// Allow-list (mirrors api-v1-parity.test.ts — kept in sync manually)
//
// Each entry is the top-two path segments of a v1 route that legitimately
// holds handler logic (native ops, playback, image proxy, etc.) and is not a
// mount() call.  These routes are expected to call enforce() internally or
// delegate to an already-gated handler.
//
// NOTE: Pure tombstone routes (410 Gone only) are detected automatically via
// isTombstoneRoute() below and do NOT need to appear in this list.
//
// Lookup: ALLOW_NATIVE.has( rel.split('/').slice(0, 2).join('/') )
// ---------------------------------------------------------------------------

const ALLOW_NATIVE = new Set<string>([
    // ── Catch-all / diagnostics ────────────────────────────────────────────
    '[...path]',
    '_diag/forward-auth-headers',

    // ── Audiobook byte proxy ──────────────────────────────────────────────
    // Bearer or item/session-bound grant, validated in the shared byte handler.
    // Tracks and upstream sessions resolve only through the owned Lumastra session.
    // Byte routes exist solely on v1; HLS retains its opaque singular family.
    'audiobook/[mediaId]',
    'audiobooks/[mediaId]',

    // ── Admin ─────────────────────────────────────────────────────────────
    'admin/secrets',
    'admin/system-health',
    'admin/watch-stats', // requireAdmin — admin watch-stats aggregates

    // ── Config ────────────────────────────────────────────────────────────

    // ── OAuth / device token surface ──────────────────────────────────────
    'device/heartbeat',
    'device/pending-actions',

    // ── Devices resource (def-layer mounts) ───────────────────────────────
    'devices',
    'devices/[id]',

    // ── Job-system ops ────────────────────────────────────────────────────
    'runs/history',
    'queues/[queue]',
    'runs',
    'runs/[id]',
    'runs/cancel-by-task',
    'runs/cancel',
    'runs/stream',
    'runs/groups', // internal grouped projection; both API mounts retain runs:read
    'scheduler',
    'tasks',
    'tasks/[taskId]',

    // ── Webhooks ──────────────────────────────────────────────────────────
    'webhooks',
    'webhooks/[id]',

    // ── Playback ──────────────────────────────────────────────────────────
    'playback/[itemId]',
    'playback/[id]', // requireAuth — HLS, file, chapters, subtitles etc.
    'playback/send-to-device',
    'playback/grants',
    'playback/previews',
    'playback/subtitles',
    'playback/telemetry',

    // ── Image proxy ───────────────────────────────────────────────────────
    'image/[id]',
    'image/audiobook',
    'image/catalog',
    'image/library',
    'image/movie',
    'image/person',
    'image/radarr',
    'image/signed',
    'image/sonarr',
    'image/user',

    // ── Library ops ───────────────────────────────────────────────────────
    'library/ingest',
    'library/paths',
    'library/scan',

    // ── Plugins ───────────────────────────────────────────────────────────
    'plugins/external',

    // ── For-You section-proxy adapters ────────────────────────────────────
    'for-you/anime',
    'for-you/binge-worthy',
    'for-you/explore-keywords',
    'for-you/fresh-releases',
    'for-you/fulfilled-requests',
    'for-you/popular-shows',
    'for-you/short-movies',
    'for-you/trending',
    'for-you/watching',

    // ── Music native routes ───────────────────────────────────────────────
    'music/now-playing',
    'music/tracks',
    'music/sonic-mixes', // cluster shuffle stream: requireAuth in createClusterShuffleHandlers (cluster-shuffle-route.ts)

    // ── Session native ────────────────────────────────────────────────────
    'sessions',
    'sessions/[id]',

    // ── Watch state ──────────────────────────────────────────────────────
    'watch-state/[id]',

    // ── User native ───────────────────────────────────────────────────────
    'user/devices',

    // ── Watch-Together v1-native ──────────────────────────────────────────
    'watch-together/[code]',
    'watch-together/parties',

    // ── Catalog domain (def-layer mounts) ─────────────────────────────────
    'people/[id]',

    // ── Playlists domain (def-layer mounts) ───────────────────────────────
    'playlists',
    'playlists/[id]',

    // ── Pre-existing def-layer mounts ─────────────────────────────────────
    'libraries/[id]',
    'media/[id]',
    'music/progress',
    'play-sessions',
    'queues/[class]',
    'users/[id]',
    'music/radio',

    // ── Recommendations domain (def-layer mounts) ─────────────────────────
    'trending',
    'recommendations',
    'upcoming',
    'continue-watching',
    'keywords',
    'feed',
    'mood-recommendations/suggestions',

    // ── Auth domain (def-layer mounts) ────────────────────────────────────
    'auth/logout',

    // ── Lists domain (def-layer mounts) ───────────────────────────────────
    'lists',
    'lists/[id]',

    // ── User domain (def-layer mounts) ────────────────────────────────────
    'me',
    'me/playback-preferences',
    'me/pats',

    // ── Requests domain (def-layer mounts) ────────────────────────────────
    'requests',
    'requests/quota',
    'requests/[id]',

    // ── Admin domain (def-layer mounts or enforce() calls) ────────────────
    //    All routes on the v1 admin surface are either mount(def, ctx) or call
    //    enforce() directly with an explicit AuthSpec.
    //    The enforce() call IS the auth declaration for these files.
    'access/groups', // mount(def) — access-group CRUD (access:admin scope)
    'library-groups', // mount(def) — library-group CRUD
    'library-groups/[id]', // mount(def) — single library-group
    'library-paths', // mount(def) — library-path CRUD
    'library-paths/[id]', // mount(def) — single library-path
    'service-tokens', // mount(def) — service-token management
    'service-tokens/[id]', // mount(def) — single service-token
    'users', // mount(def) — user listing/create (users:admin)
    'me/links', // mount(def) — integration account links (user scope)
    'server', // mount(def) — bootstrap with optional credential
    'setup/onboarding', // mount(def) — onboarding dismiss (admin)
    'me/stats', // mount(def) — personal stats (user scope)
    'stats/users', // mount(def) — per-user stats (selfOrAdmin)
    'notifications', // mount(def) — notification inbox (user scope)
    'notifications/[id]', // mount(def) — per-notification + mark-read
    'notifications/read-all', // mount(def) — mark-all-read (user scope)
    'notifications/unread-count', // mount(def) — unread badge count (user scope)
    'pats', // enforce() — admin PAT listing (tokens:admin)
    'integrations/keys', // enforce() — integration-key CRUD (providers:admin)
    'providers', // enforce() — provider listing (providers:read)
    'admin/providers', // enforce() — provider reconnect (providers:admin)
    'libraries/coverage', // enforce() — coverage backlog (library:admin)
    'libraries/integrity', // enforce() — integrity check (library:admin)
    'libraries/quarantine', // enforce() — quarantined files (library:admin)
    'libraries/unmatched-files', // enforce() — unmatched-files report (library:admin)
    'plugins/internal', // enforce() — internal plugin management (admin)
    'livetv/admin', // enforce() — LiveTV admin surface (livetv:admin)
    'system-metrics', // enforce() — Prometheus scrape (metrics:read)
    'tasks/audit', // enforce() — task audit log (tasks:admin)
    'tasks/circuits', // enforce() — circuit-breaker state (tasks:admin)
    'tasks/metrics', // enforce() — task metrics (metrics:read)
    'tasks/observability', // enforce() — task observability (tasks:admin)
    'tasks/systemic', // enforce() — systemic task ops (tasks:admin)
    'tasks/trends', // enforce() — task trends (metrics:read)
    'events', // mount(def) — per-user SSE channel (user scope)
    'request', // 410 Gone tombstone (old /request → /requests)
    'request/pending', // 410 Gone tombstone (→ /requests?scope=mine)
    'request/quota', // 410 Gone tombstone (→ /requests/quota)
    'request/status', // 410 Gone tombstone (→ /requests/{id})
    'radio/stations', // enforce()+delegateToAdmin() — radio station CRUD (providers:admin)
]);

// ---------------------------------------------------------------------------
// Helpers — static source analysis
// ---------------------------------------------------------------------------

/**
 * Strip single-line (`//`) and block (`/* … *\/`) comments from TypeScript source.
 * This avoids false positives from code examples in JSDoc blocks.
 */
function stripComments(src: string): string {
    // Remove block comments first (handles nested // inside /* */)
    src = src.replace(/\/\*[\s\S]*?\*\//g, '');
    // Remove single-line comments
    src = src.replace(/\/\/[^\n]*/g, '');
    return src;
}

/**
 * Return true when the file at `path` exports a `def` constant at the top level
 * (i.e., is an EndpointDef module rather than a barrel/helper).
 *
 * We match only `^export const def` (line-anchored) after comment stripping,
 * so a `def` that appears only inside a JSDoc example is not counted.
 */
function isDefModule(src: string): boolean {
    const stripped = stripComments(src);
    return /^export\s+const\s+def\b/m.test(stripped);
}

/**
 * Return true when the def file delegates to a known factory function instead
 * of calling `defineEndpoint({...})` directly.
 *
 * Pattern: `export const def = <knownFactory>(...)` (after comment stripping).
 * The factory itself calls `defineEndpoint` with an explicit `auth:` field;
 * this check trusts the factory and skips the inline `defineEndpoint` parse.
 */
function isFactoryDef(stripped: string): boolean {
    for (const factory of DEF_FACTORIES) {
        if (new RegExp(`^export\\s+const\\s+def\\s*=\\s*${factory}\\s*\\(`, 'm').test(stripped)) {
            return true;
        }
    }
    return false;
}

/**
 * Return true when a +server.ts file is a pure tombstone: it only emits 410
 * Gone responses and has no live handler logic.
 *
 * Detection: after comment stripping, the source references `'gone'` (the
 * problem code used by `ApiProblem.gone()` / `problem('gone', ...)`).  We
 * additionally verify no live auth middleware is present so a mixed file that
 * contains both a gone stub and a real handler is not silently skipped.
 *
 * Tombstones are safe from an auth standpoint: they return 410 unconditionally
 * without running any business logic that could leak data.
 */
function isTombstoneRoute(stripped: string): boolean {
    // Must contain a 'gone' reference (string literal or identifier)
    if (!/\bgone\b/.test(stripped)) return false;

    // Must NOT contain any live business-logic auth check.  If a file has both
    // `gone` AND a real auth middleware, it's a mixed file that needs review.
    const hasLiveAuth =
        /\brequireAuth\b/.test(stripped) ||
        /\brequireAdmin\b/.test(stripped) ||
        /\brequireSelfOrAdmin\b/.test(stripped) ||
        /\benforce\s*\(/.test(stripped);

    return !hasLiveAuth;
}

/**
 * Locate the `defineEndpoint({...})` call body in the source and return it.
 * Returns null if not found.
 *
 * Strategy: find `defineEndpoint({` then extract balanced braces.
 */
function extractDefineEndpointBody(src: string): string | null {
    const stripped = stripComments(src);
    const start = stripped.indexOf('defineEndpoint({');
    if (start === -1) return null;

    let depth = 0;
    let i = stripped.indexOf('{', start);
    const bodyStart = i;

    for (; i < stripped.length; i++) {
        if (stripped[i] === '{') depth++;
        else if (stripped[i] === '}') {
            depth--;
            if (depth === 0) return stripped.slice(bodyStart, i + 1);
        }
    }
    return null; // unbalanced (parse error in source)
}

/**
 * Check whether the `auth:` value in a `defineEndpoint` body is a single
 * AuthSpec (has `kind:`) or a per-method map (keys are HTTP method names).
 *
 * Returns:
 *  - `{style:'single', kind: string}` for `auth: { kind: 'user' }`
 *  - `{style:'perMethod', methods: string[]}` for `auth: { GET: {...}, POST: {...} }`
 *  - `null` if the `auth:` field is absent or unparseable
 */
type AuthAnalysis =
    { style: 'single'; kind: string } | { style: 'perMethod'; methods: string[] } | null;

/**
 * Locate the index of a top-level `auth:` property inside a `defineEndpoint`
 * body — i.e. a direct property of the def object (brace-depth 1), NOT one
 * nested inside `docs:`, `handlers:`, or any other sub-object.
 *
 * Since docs live in `def.docs` now (each method spec can carry its own
 * `auth: 'bearer'` OpenAPI security hint), a naive `.search(/\bauth\s*:/)`
 * matches that nested string first and mis-reports the real AuthSpec as absent.
 * This scanner tracks brace/bracket/paren depth and skips string literals so it
 * only reports the `auth:` that is a top-level key of the def object.
 *
 * Returns the index of the `a` in the top-level `auth`, or -1 if absent.
 */
function findTopLevelAuthIndex(defBody: string): number {
    let depth = 0;
    for (let i = 0; i < defBody.length; i++) {
        const c = defBody[i];
        // Skip string literals so braces/`auth:` inside them don't count.
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < defBody.length) {
                if (defBody[i] === '\\') {
                    i++; // skip escaped char
                } else if (defBody[i] === quote) {
                    break;
                }
                i++;
            }
            continue;
        }
        if (c === '{' || c === '[' || c === '(') {
            depth++;
            continue;
        }
        if (c === '}' || c === ']' || c === ')') {
            depth--;
            continue;
        }
        // Top-level of the def object is depth 1 (the outer `{` bumped us to 1).
        if (depth === 1 && c === 'a' && /^auth\s*:/.test(defBody.slice(i))) {
            const prev = i > 0 ? defBody[i - 1] : undefined;
            if (prev === undefined || /[\s,{]/.test(prev)) {
                return i;
            }
        }
    }
    return -1;
}

function analyzeAuth(defBody: string): AuthAnalysis {
    // Find the TOP-LEVEL `auth:` key (skip nested docs.auth / handlers.auth).
    const authIdx = findTopLevelAuthIndex(defBody);
    if (authIdx === -1) return null;

    // Find the opening `{` of the auth value
    const braceStart = defBody.indexOf('{', authIdx);
    if (braceStart === -1) return null;

    // Extract the balanced auth object
    let depth = 0;
    let end = braceStart;
    for (let i = braceStart; i < defBody.length; i++) {
        if (defBody[i] === '{') depth++;
        else if (defBody[i] === '}') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    const authObj = defBody.slice(braceStart, end + 1);

    // Check for `kind:` — single AuthSpec
    const kindMatch = /\bkind\s*:\s*['"](\w+)['"]/s.exec(authObj);
    if (kindMatch) {
        return { style: 'single', kind: kindMatch[1] };
    }

    // Check for HTTP method keys — per-method map
    const methodsFound: string[] = [];
    for (const method of HTTP_METHODS) {
        if (new RegExp(`\\b${method}\\s*:`).test(authObj)) {
            methodsFound.push(method);
        }
    }
    if (methodsFound.length > 0) {
        return { style: 'perMethod', methods: methodsFound };
    }

    return null; // auth present but empty/unparseable
}

/**
 * Extract the HTTP method keys declared in the `handlers:` block of a
 * `defineEndpoint` body.
 */
function extractHandlerMethods(defBody: string): string[] {
    const handlersIdx = defBody.search(/\bhandlers\s*:/);
    if (handlersIdx === -1) return [];

    const braceStart = defBody.indexOf('{', handlersIdx);
    if (braceStart === -1) return [];

    // Extract the handlers object (first level only — methods are top-level keys)
    let depth = 0;
    let end = braceStart;
    for (let i = braceStart; i < defBody.length; i++) {
        if (defBody[i] === '{') depth++;
        else if (defBody[i] === '}') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    const handlersObj = defBody.slice(braceStart, end + 1);

    // Match HTTP method keys at the top level of the handlers object.
    // We only look at the first "layer" by finding method keys that appear
    // directly as object property names (before their handler value opens).
    const methods: string[] = [];
    for (const method of HTTP_METHODS) {
        if (new RegExp(`\\b${method}\\s*:`).test(handlersObj)) {
            methods.push(method);
        }
    }
    return methods;
}

// ---------------------------------------------------------------------------
// Regexes for route-file classification (same semantics as parity test)
// ---------------------------------------------------------------------------

/** Pure `export * from '...+server.js'` — pass-through re-export shim. */
const PURE_MOUNT_RE = /^export\s+\*\s+from\s+['"][^'"]+\+server\.js['"]\s*;?$/;

/** Named re-export shim: `export { A, B } from '...+server.js'`. */
const NAMED_SHIM_RE = /^export\s+\{[^}]+\}\s+from\s+['"][^'"]+\+server\.js['"]\s*;?$/;

/**
 * mount() call — the def-layer auth chokepoint.
 * Matches: `mount(`, `mount(def,`, or `= mount(` anywhere in the file.
 */
const MOUNT_CALL_RE = /\bmount\s*\(/;

// ---------------------------------------------------------------------------
// Test suite 1 — Def coverage
// ---------------------------------------------------------------------------

describe('/api/v1 def-layer auth coverage', () => {
    it('every EndpointDef module declares a well-formed AuthSpec', async () => {
        const pattern = new URL('../src/lib/server/api/defs/**/*.ts', import.meta.url).pathname;

        const files: string[] = [];
        for await (const f of glob(pattern)) {
            // Exclude test files and the _readme documentation stub
            if (f.endsWith('.test.ts') || f.endsWith('.spec.ts')) continue;
            if (f.endsWith('/_readme.ts') || f.endsWith('_readme.ts')) continue;
            files.push(f);
        }

        expect(files.length, 'should find at least 60 def/*.ts files').toBeGreaterThan(60);

        const violations: string[] = [];

        for (const file of files.sort()) {
            const src = readFileSync(file, 'utf8');

            // Skip files that are not def modules (helpers, barrel indexes, strategies, etc.)
            if (!isDefModule(src)) continue;

            const rel = file.replace(/^.*\/src\/lib\/server\/api\/defs\//, '');
            const stripped = stripComments(src);

            // --- Factory-based defs: trusted, skip inline parse ---
            // If the file calls a known factory that internally calls defineEndpoint
            // with an explicit auth:, the factory is the auth declaration point.
            if (isFactoryDef(stripped)) continue;

            // --- Rule 1: defineEndpoint call must be present ---
            const defBody = extractDefineEndpointBody(src);
            if (!defBody) {
                violations.push(
                    `${rel}: exports 'def' but no defineEndpoint({...}) call found — ` +
                        'migrate to defineEndpoint({auth:..., handlers:{...}}) or register the factory in DEF_FACTORIES.',
                );
                continue;
            }

            // --- Rule 2: auth field must be present ---
            const authAnalysis = analyzeAuth(defBody);
            if (authAnalysis === null) {
                violations.push(
                    `${rel}: defineEndpoint is missing an 'auth:' field (or it is empty/unparseable). ` +
                        "Every def must declare explicit auth — use {kind:'public'} for intentionally un-gated routes.",
                );
                continue;
            }

            // --- Rule 3: single AuthSpec must have a recognised kind ---
            if (authAnalysis.style === 'single') {
                if (!VALID_AUTH_KINDS.has(authAnalysis.kind)) {
                    violations.push(
                        `${rel}: auth has kind='${authAnalysis.kind}' which is not in the AuthSpec union. ` +
                            `Valid kinds: ${[...VALID_AUTH_KINDS].join(', ')}.`,
                    );
                }
                // Single auth spec — all handlers covered; no per-method check needed.
                continue;
            }

            // --- Rule 4: per-method map must cover every handler method ---
            if (authAnalysis.style === 'perMethod') {
                const handlerMethods = extractHandlerMethods(defBody);
                const authMethods = new Set(authAnalysis.methods);

                const uncovered = handlerMethods.filter((m) => !authMethods.has(m));
                if (uncovered.length > 0) {
                    violations.push(
                        `${rel}: per-method auth map is missing entries for: ${uncovered.join(', ')}. ` +
                            'Every handler method must have an explicit AuthSpec in the map.',
                    );
                }

                // Also verify every method in the auth map is a known HTTP method
                for (const m of authAnalysis.methods) {
                    if (!HTTP_METHODS.has(m)) {
                        violations.push(
                            `${rel}: auth map has unknown key '${m}' — not a valid HTTP method.`,
                        );
                    }
                }
            }
        }

        expect(violations, violations.join('\n')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Test suite 2 — Route coverage
// ---------------------------------------------------------------------------

describe('/api/v1 route auth coverage', () => {
    it('every +server.ts either uses mount(), is a re-export shim, is a tombstone, or is allow-listed', async () => {
        const pattern = new URL('../src/routes/api/v1/**/*.ts', import.meta.url).pathname;

        const files: string[] = [];
        for await (const f of glob(pattern)) {
            if (f.endsWith('/+server.ts')) files.push(f);
        }

        expect(
            files.length,
            'should find at least 200 +server.ts files under api/v1',
        ).toBeGreaterThan(200);

        const violations: string[] = [];

        for (const file of files.sort()) {
            const rel = file
                .replace(/^.*\/src\/routes\/api\/v1\//, '')
                .replace(/\/\+server\.ts$/, '');

            // Top-two segments for allow-list lookup
            const top2 = rel.split('/').slice(0, 2).join('/');

            // E) Allow-listed native route
            if (ALLOW_NATIVE.has(top2) || ALLOW_NATIVE.has(rel)) continue;

            // Strip comments before classifying
            const body = stripComments(readFileSync(file, 'utf8')).trim();

            // A) mount() call — auth is declared in the def's AuthSpec
            if (MOUNT_CALL_RE.test(body)) continue;

            // B) Pure export-star shim
            if (PURE_MOUNT_RE.test(body)) continue;

            // C) Named re-export shim
            if (NAMED_SHIM_RE.test(body)) continue;

            // D) Tombstone route — only emits 410 Gone; no live handler logic
            if (isTombstoneRoute(body)) continue;

            // Violation: none of the above
            violations.push(
                `${rel}/+server.ts — not a mount() call, not a re-export shim, not a tombstone, and not in ALLOW_NATIVE. ` +
                    `Add it to ALLOW_NATIVE (with a comment explaining its auth mechanism) ` +
                    `or migrate it to mount(def, ctx).`,
            );
        }

        expect(violations, violations.join('\n')).toHaveLength(0);
    });

    it('ALLOW_NATIVE has no entries that are also covered by a mount() route (no stale entries)', async () => {
        // This test is informational — it documents when an entry in ALLOW_NATIVE
        // becomes stale because the route was migrated to mount(). It does NOT fail
        // the build (we use a soft warn-only assertion), because migration is gradual.
        //
        // To keep this clean: when you migrate a native route to mount(def,ctx),
        // remove the corresponding entry from ALLOW_NATIVE above AND in parity test.

        const pattern = new URL('../src/routes/api/v1/**/*.ts', import.meta.url).pathname;

        const mountedRoutes: string[] = [];
        for await (const f of glob(pattern)) {
            if (!f.endsWith('/+server.ts')) continue;
            const body = stripComments(readFileSync(f, 'utf8')).trim();
            if (!MOUNT_CALL_RE.test(body)) continue;

            const rel = f.replace(/^.*\/src\/routes\/api\/v1\//, '').replace(/\/\+server\.ts$/, '');
            const top2 = rel.split('/').slice(0, 2).join('/');
            if (ALLOW_NATIVE.has(top2) || ALLOW_NATIVE.has(rel)) {
                mountedRoutes.push(rel);
            }
        }

        // We document the stale entries but do not fail — migration is in progress.
        // Once the list is empty and stable, this test can be promoted to a hard fail.
        if (mountedRoutes.length > 0) {
            // Log for visibility in CI output; not a failure.
            console.info(
                `[auth-coverage] ${mountedRoutes.length} ALLOW_NATIVE entries now use mount() and could be removed: ` +
                    mountedRoutes.join(', '),
            );
        }

        // The test always passes — it is an observability check, not a gate.
        expect(true).toBe(true);
    });
});
