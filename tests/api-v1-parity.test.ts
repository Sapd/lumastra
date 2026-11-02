// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/v1 Parity Lint Test
 *
 * Asserts every `src/routes/api/v1/**\/+server.ts` is one of:
 *   A) A pure `export * from '...+server.js'` mount
 *   B) A named re-export shim `export { X, Y } from '...+server.js'`
 *   C) A def-layer mount() call
 *   D) A tombstone route — only emits 410 Gone; no live handler logic
 *   E) An explicitly allow-listed native ops/token route
 *      (routes that contain real handler logic and live only on v1)
 *
 * The test fails if someone adds business logic to a shim file that should
 * remain a thin re-export mount.  Add the route to ALLOW_NATIVE only when
 * the logic genuinely belongs on v1 exclusively (ops surfaces, token endpoints,
 * image proxy, playback, livetv fork, section-proxy adapters, etc.).
 *
 * Pure tombstone routes (only emit 410 Gone) are detected automatically and
 * do not need to appear in ALLOW_NATIVE.
 *
 * Allow-list uses the top-two path segments of the route's rel path:
 *   rel = 'tasks/[taskId]/run'  →  check key = 'tasks/[taskId]'
 *   rel = 'scheduler'           →  check key = 'scheduler'
 */

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';

// ── Regexes ──────────────────────────────────────────────────────────────────

/**
 * Matches a file whose only non-comment content is a single
 * `export * from '...+server.js'` line.
 */
const PURE_MOUNT_RE = /^export\s+\*\s+from\s+['"][^'"]+\+server\.js['"]\s*;?$/;

/**
 * Matches a named re-export shim: `export { A, B } from '...+server.js'`.
 * These are acceptable interim forms (they break method parity but contain
 * no handler logic).
 */
const NAMED_SHIM_RE = /^export\s+\{[^}]+\}\s+from\s+['"][^'"]+\+server\.js['"]\s*;?$/;

/**
 * Matches a file that uses mount(def, ctx) — def-layer mounts.
 * These contain handler logic declared in the def file, not inline shims.
 * They are acceptable: auth is declared in the def's AuthSpec.
 */
const DEF_MOUNT_RE = /\bmount\s*\(/;

// ── Allow-list ────────────────────────────────────────────────────────────────
//
// Each entry is the top-two path segments of a route that legitimately holds
// handler logic on the v1 surface.  Keep this list as short as possible —
// every entry is a future migration target.
//
// Lookup: ALLOW_NATIVE.has( rel.split('/').slice(0, 2).join('/') )
//
// Groups:
//   • Catch-all / diagnostics
//   • Ops surfaces: tasks, runs, queues, scheduler
//   • Token/OAuth surfaces: webhooks, admin/secrets
//   • Session & playback (v1-native: stream-tokens, telemetry, HLS, subtitles/{index},
//     trickplay — these have stream-token auth not forwarded)
//   • LiveTV fork (copied handler, uses locals.imageBase)
//   • Library ops (ingest/scan/paths — implementation files keep singular prefix)
//   • Plugins (external plugin management — admin-scoped)
//   • Music native routes (stream handler)
//   • Misc session native routes
//   • Watch-Together v1-native sessions listing
//   • Admin invariants / system-health

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
    'admin/secrets', // master-key rotation
    'admin/system-health', // invariant checks
    'admin/watch-stats', // requireAdmin — admin watch-stats aggregates

    // ── Requests (def-mounted via mount()) ────────────────────────────────
    // These use mount(def, ctx) with handler logic in defs/requests/*.ts —
    // they are NOT shims re-exporting /api/request/* but standalone def mounts.
    'requests', // top-level create + list
    'requests/quota', // quota endpoint
    'requests/[id]', // per-request (dismiss sub-route)

    // ── Config (branding + feature flags for tvOS / CLI clients) ──────────

    // ── Devices resource (def-mounted via mount()) ────────────────────────
    //    devices/+server.ts         → GET/DELETE devices?scope=mine
    //    devices/[id]/heartbeat     → POST devices/{id}/heartbeat
    //    devices/[id]/actions       → GET/POST devices/{id}/actions
    //    devices/[id]/actions/[id]  → PATCH devices/{id}/actions/{id}
    'devices', // top-level listing + revoke
    'devices/[id]', // all sub-routes: heartbeat, actions, actions/[actionId]

    // ── Job-system ops (scope-gated; internal projections retained) ───────
    'runs/history', // DELETE /api/v1/runs/history — task-run history pruning
    'queues/[queue]',
    'runs', // top-level runs list/stream
    'runs/[id]', // individual run + cancel + logs (renamed from [runId])
    'runs/cancel-by-task',
    'runs/cancel', // bulk cancel by task
    'runs/stream',
    'runs/groups', // internal grouped projection; both API mounts retain runs:read
    'scheduler',
    'tasks', // top-level task list
    'tasks/[taskId]', // all task sub-routes (state/run/settings/failures…)

    // ── Webhooks ──────────────────────────────────────────────────────────
    'webhooks', // top-level list + create
    'webhooks/[id]', // individual webhook + test

    // ── Playback (v1-native: stream-token auth, HLS, subtitles, telemetry) ─
    'playback/[id]', // requireAuth — HLS, avp, session, subtitles/[index], trickplay…
    'playback/grants', // stream token auth, all sub-routes
    'playback/previews', // ephemeral hover transcode
    'playback/telemetry',

    // ── Library ops (scope-gated; implementation files keep singular prefix) ─
    //    Canonical paths are /api/v1/libraries/{ingest,paths,scan} (re-export shims).
    //    The singular library/ routes remain as the implementation target.
    'library/ingest',
    'library/paths',
    'library/scan',

    // ── Plugins (external plugin management, admin-scoped) ────────────────
    'plugins/external',

    // ── Music native routes ───────────────────────────────────────────────
    //    music/tracks: stream handler uses createMusicStreamHandlers; lyrics named shim
    'music/tracks',
    'music/sonic-mixes', // cluster shuffle stream: createClusterShuffleHandlers wraps createMusicStreamHandlers, requireAuth

    // ── Session native ────────────────────────────────────────────────────
    //    sessions: unified read view (?scope=mine|all)
    'sessions',
    'sessions/[id]', // cancel sub-route

    // ── Watch state ──────────────────────────────────────────────────────
    'watch-state/[id]', // GET/PATCH unified watch+favorite+rating state

    // ── Watch-Together v1-native ──────────────────────────────────────────
    //    [code]/send-to-device: v1-only media-access check
    //    sessions: public session listing (bare {items,page} envelope, §8.3)
    'watch-together/[code]', // covers [code]/send-to-device
    'watch-together/parties',

    // ── Catalog domain (def-layer mounts, not pure shims) ─────────────────
    //    people/[id]: mount(peopleIdDef, ctx) — emitted by gen-api-routes.
    //    Contains a mount() call; handler logic is declared in the def.
    //    The old person/[personId] shim is kept for backward compat.
    'people/[id]',

    // ── Playlists domain (def-layer mounts, not shims) ────────────────────
    //    playlists: mount(def) — GET/POST collection (bare + {items,page}).
    //    playlists/[id]/members: mount(def) — GET/POST members by UUID (Q8).
    //    playlists/[id]/members/[memberId]: mount(def) — PUT/DELETE by UUID.
    //      Parity gap fix: PUT (role change) was missing from the old v1 shim.
    //      [username] routes removed; v1 surface now uses UUID everywhere (Q8).
    'playlists',
    'playlists/[id]',

    // ── Pre-existing def-layer mounts from other domains ──────────────────
    //    These were added to v1 in this branch before the recommendations
    //    domain work.  They use mount(def, ctx) and contain no shim logic.
    'libraries/[id]', // images/{role} endpoint
    'media/[id]', // images/{role} endpoint
    'music/sessions', // music play-session surface
    'queues/[class]', // job-system queue endpoint
    'users/[id]', // images/avatar endpoint
    'music/radio', // radio station images/{role} endpoint

    // ── Recommendations domain (def-layer mounts, not shims) ──────────────
    //    Tier-2 data-plane endpoints + /feed SDUI composition.
    //    Collapses: for-you/*, ai/suggestions*, mood-recommendations*,
    //    trending, upcoming, calendar, keywords, continue-watching.
    //    All mounted via mount(def, ctx) with handler logic in defs/recommendations/*.ts.
    'trending', // GET /trending?window=&type= (replaces shim)
    'recommendations', // GET /recommendations?type= (replaces shim)
    'upcoming', // GET /upcoming?view= (replaces shim; collapses calendar)
    'continue-watching', // GET collection (new); [id] is the canonical sub-route
    'keywords', // GET /keywords?mode= (new; collapses for-you/keywords*)
    'feed', // GET /feed SDUI (new)
    'mood-recommendations/suggestions', // tombstone (collapsed into /recommendations?type=mood)

    // ── Auth domain (def-layer mounts) ────────────────────────────────────
    //    auth/logout: mount(def) — POST revoke device + Jellyfin token.
    //    Feature-gated: FEATURE_DEVICE_AUTH.
    'auth/logout',

    // ── Lists domain (def-layer mounts) ────────────────────────────────────
    //    lists: mount(def) — GET curated lists; POST admin sync trigger.
    //    lists/[id]: mount(def) — GET items for a specific list (N2 rename).
    //    Note: old [list_id] route removed; [id] is the canonical param name.
    'lists',
    'lists/[id]',

    // ── User domain (def-layer mounts) ────────────────────────────────────
    //    me: mount(def) — GET self-scoped user profile.
    //    me/playback-preferences: mount(def) — GET/PATCH (POST alias removed).
    //    me/pats: mount(def) — GET/POST/DELETE PATs (FEATURE_USER_PATS).
    'me',
    'me/playback-preferences',
    'me/pats',

    // ── Requests domain (def-layer mounts) ────────────────────────────────
    //    requests: mount(def) — GET/POST collection endpoint.
    //    requests/quota: mount(def) — GET user quota (tv→series rename).
    //    requests/[id]: covers requests/{id}/dismiss sub-route.
    'requests',
    'requests/quota',
    'requests/[id]',

    // ── Admin domain (def-layer mounts or enforce() calls) ────────────────
    //    All routes on the v1 admin surface are either mount(def, ctx) or call
    //    enforce() directly.  They are not shims re-exporting /api/admin/*.
    //    access/groups: mount(def) — GET/POST access-groups (access:admin scope).
    //    library-groups: mount(def) — library-group CRUD.
    //    library-paths: mount(def) — library-path CRUD.
    //    service-tokens: mount(def) — service-token management.
    //    users: mount(def) — user listing + create (users:admin scope).
    //    me/links: mount(def) — integration links (user scope).
    //    server: mount(def) — bootstrap with optional credential.
    //    setup/onboarding: mount(def) — onboarding (admin scope).
    //    stats/*: mount(def) — user stats (user/selfOrAdmin scope).
    //    notifications/*: mount(def) — notification inbox (user scope).
    //    pats: enforce() — admin PAT listing (tokens:admin scope).
    //    integrations/keys: enforce() — integration-key CRUD (providers:admin).
    //    providers: enforce() — provider listing (providers:read scope).
    //    admin/providers: enforce() — provider reconnect (providers:admin).
    //    libraries/coverage etc.: enforce() — library ops (library:admin scope).
    //    plugins/internal: enforce() — internal plugin management (admin).
    //    livetv/admin: enforce() — LiveTV admin surface (livetv:admin scope).
    //    system-metrics: enforce() — Prometheus scrape (metrics:read scope).
    //    tasks/audit etc.: enforce() — task audit/metrics/observability surfaces.
    //    request/*: 410 Gone tombstones (old /request/* paths).
    //    events: mount(def) — per-user SSE (user scope).
    //    radio/stations: enforce()+delegateToAdmin() — radio station CRUD (providers:admin).
    'access/groups', // GET/POST collection + PATCH/DELETE by id
    'library-groups', // mount(def) — library-group CRUD
    'library-groups/[id]', // mount(def) — single library-group
    'library-paths', // mount(def) — library-path CRUD
    'library-paths/[id]', // mount(def) — single library-path
    'service-tokens', // mount(def) — service-token management
    'service-tokens/[id]', // mount(def) — single service-token
    'users', // mount(def) — user listing/create
    'me/links', // mount(def) — integration account links
    'server', // mount(def) — server bootstrap
    'setup/onboarding', // mount(def) — onboarding dismiss
    'me/stats', // mount(def) — personal stats
    'stats/users', // mount(def) — per-user stats (selfOrAdmin)
    'notifications', // mount(def) — notification inbox
    'notifications/[id]', // mount(def) — per-notification + mark-read
    'notifications/read-all', // mount(def) — mark-all-read
    'notifications/unread-count', // mount(def) — unread badge count
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
    'radio/stations', // mount(def) — radio station CRUD (providers:admin)
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return true when a +server.ts file is a pure tombstone: it only emits 410
 * Gone responses and has no live handler logic.
 *
 * Detection: after comment stripping, the source references `gone` (as a
 * string literal used by `ApiProblem.gone()` / `problem('gone', ...)`).
 * Additionally verify no live auth middleware is present so a mixed file that
 * has both a gone stub and a real handler is not silently skipped.
 *
 * Tombstones require no auth: they return 410 unconditionally without running
 * any business logic that could leak data.
 */
function isTombstoneRoute(body: string): boolean {
    if (!/\bgone\b/.test(body)) return false;

    const hasLiveAuth =
        /\brequireAuth\b/.test(body) ||
        /\brequireAdmin\b/.test(body) ||
        /\brequireSelfOrAdmin\b/.test(body) ||
        /\benforce\s*\(/.test(body);

    return !hasLiveAuth;
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe('/api/v1 route parity', () => {
    it('every +server.ts is a pure export-star mount, a named re-export shim, a tombstone, or an allow-listed native route', async () => {
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
            // Derive the route-relative path (no leading slash, no +server.ts)
            const rel = file
                .replace(/^.*\/src\/routes\/api\/v1\//, '')
                .replace(/\/\+server\.ts$/, '');

            // Top two segments for the allow-list lookup
            const top2 = rel.split('/').slice(0, 2).join('/');

            if (ALLOW_NATIVE.has(top2) || ALLOW_NATIVE.has(rel)) continue;

            // Strip single-line and block comments, then trim whitespace
            const body = readFileSync(file, 'utf8')
                .replace(/\/\/[^\n]*/g, '')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .trim();

            if (PURE_MOUNT_RE.test(body)) continue; // ideal form
            if (NAMED_SHIM_RE.test(body)) continue; // acceptable interim form
            if (DEF_MOUNT_RE.test(body)) continue; // def-layer mount (auth in def's AuthSpec)
            if (isTombstoneRoute(body)) continue; // pure 410 Gone — no live handler

            violations.push(
                `${rel}/+server.ts — expected a pure 'export *' mount or named re-export shim from ../api/…+server.js, ` +
                    `or add '${top2}' to ALLOW_NATIVE if this is intentional v1-only handler logic`,
            );
        }

        expect(violations, violations.join('\n')).toHaveLength(0);
    });
});
