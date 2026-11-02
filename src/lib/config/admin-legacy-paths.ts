// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Legacy admin route map (admin IA redesign aftermath).
 *
 * The admin IA redesign (~86 commits)
 * moved dozens of admin routes and later deleted the temporary redirect stubs
 * that used to forward old bookmarks to their new homes. This module is the
 * ONE place that still remembers where things went, so:
 *   - `src/routes/admin/+layout.server.ts` can 308-redirect a request that
 *     hits a dead old path instead of 404ing, and
 *   - stale rows in `admin_nav_pins` (raw `href` strings, predate the
 *     redesign) can self-heal instead of permanently pointing nowhere.
 *
 * Every entry below is backed by a real deleted redirect stub, a `git mv`
 * rename, or an explicit decision recorded in the progress doc — see the
 * inline group comments for the commit each batch came from. Routes with no
 * clear single successor (e.g. old catch-all hubs that fanned out to several
 * unrelated destinations with no evidence of a canonical target) were
 * deliberately left out rather than guessed.
 */

import { ADMIN_MEDIA_FILE_ISSUES_PATH } from '$lib/shared/admin-media-links.js';

/**
 * Exact old path -> new path. The target may carry a `?query` and/or a
 * `#anchor` (never both a bare query string on the KEY side — keys are always
 * plain pathnames).
 */
export const ADMIN_LEGACY_PATHS: Record<string, string> = {
    // ---- Library section (step:sections-routing, ea367de17) ----
    '/admin/library': '/admin/library/sources',
    '/admin/stats': '/admin/library/insights',

    // ---- Library > Sources (renamed from "storage") ----
    // "Storage" implied disks, which stopped being true once a library could be
    // a remote AudiobookShelf server whose `path` is an `abs://<id>` sentinel
    // rather than a directory. The page adds and lists media SOURCES; the word
    // also matches `defineMediaSource` and the add-library form's own "Source:"
    // selector. Operator bookmarks and stale `admin_nav_pins` rows are what this
    // entry exists for.
    '/admin/library/storage': '/admin/library/sources',

    // ---- Library > Fix matches (step:fix-matches, 735f56166) ----
    '/admin/operations/reidentify': '/admin/library/fix-matches?view=broken',
    '/admin/integrity': ADMIN_MEDIA_FILE_ISSUES_PATH,
    '/admin/quarantine': '/admin/developer/reconciliation',

    // ---- Tasks section (step:tasks-overview / step:runs / step:pipeline) ----
    '/admin/operations/runs': '/admin/tasks/runs',
    '/admin/runs': '/admin/tasks/runs',
    '/admin/tasks/live': '/admin/tasks/runs',
    '/admin/operations/pipeline': '/admin/tasks/pipeline',
    '/admin/ingest': '/admin/tasks/pipeline',
    '/admin/library/coverage': '/admin/tasks/pipeline?view=completion',

    // ---- System section (step:sections-routing + step:system-health) ----
    '/admin/admin-audit': '/admin/system/audit-log',
    '/admin/instance-profile': '/admin/system/instance',
    '/admin/licensing': '/admin/system/instance',
    '/admin/cost': '/admin/system/cost',
    '/admin/operations/cost': '/admin/system/cost',
    '/admin/operations/health': '/admin/system/health',
    '/admin/system-health': '/admin/system/health',
    '/admin/security': '/admin/system/health#security',
    '/admin/cluster': '/admin/system/health?tab=cluster',

    // ---- Operations hub (deleted wholesale — b45c6b844 + children) ----
    '/admin/operations': '/admin',
    '/admin/queues': '/admin/tasks/runs',

    // ---- Users section (step:sections-routing, ea367de17) ----
    '/admin/sessions': '/admin/users/sessions',
    '/admin/playback-quality': '/admin/users/playback-quality',
    '/admin/api-tokens': '/admin/users/api-tokens',

    // ---- Developer section (step:developer-area, d6ed819aa) ----
    '/admin/audit': '/admin/developer/continue-watching',
    '/admin/audit/continue-watching': '/admin/developer/continue-watching',
    '/admin/cache': '/admin/developer/cache',
    '/admin/crossfade-lab': '/admin/developer/crossfade-lab',
    '/admin/embeddings': '/admin/developer/embeddings',
    '/admin/vod-embeddings': '/admin/developer/vod-embeddings',
    '/admin/sonic-embeddings': '/admin/developer/sonic-embeddings',
    '/admin/operations/extensions': '/admin/developer/registry',
    '/admin/extensions': '/admin/developer/registry',
    '/admin/plugins': '/admin/developer/registry',

    // ---- Settings section (step:settings-area, 63f8aeb0a) ----
    '/admin/configuration': '/admin/settings',
    '/admin/access': '/admin/settings/access',
    '/admin/ai': '/admin/settings/ai',
    '/admin/providers': '/admin/settings/providers',
    '/admin/secrets': '/admin/settings/secrets',
    '/admin/playback': '/admin/settings/playback',
    '/admin/webhooks': '/admin/settings/webhooks',
    '/admin/homepage': '/admin/settings/homepage',
    '/admin/navigation': '/admin/settings/homepage?tab=navigation',
    '/admin/livetv': '/admin/settings/livetv',
    '/admin/livetv/channels': '/admin/settings/livetv?tab=channels',
    '/admin/livetv/proxy': '/admin/settings/livetv?tab=proxy',
    '/admin/radio': '/admin/settings/music?tab=radio',
    '/admin/music': '/admin/settings/music',
    '/admin/music-alchemy': '/admin/settings/music',
    '/admin/music-quick-picks': '/admin/settings/music?tab=quick-picks',
};

/**
 * Prefix moves — whole subtrees that relocated wholesale, where the tail
 * after the matched prefix is a real identifier that still resolves at the
 * new location (a media id / task id). Checked only when `ADMIN_LEGACY_PATHS`
 * has no exact hit. Longest-prefix-wins, though today's table has no
 * overlapping prefixes.
 */
export const ADMIN_LEGACY_PREFIXES: Record<string, string> = {
    // /admin/media/<id> -> /admin/library/media/<id> (ea367de17, R100 rename)
    '/admin/media': '/admin/library/media',
    // /admin/operations/jobs/<taskId> -> /admin/tasks/<taskId> (94a27dde4, git mv)
    '/admin/operations/jobs': '/admin/tasks',
};

/**
 * Resolve a legacy admin pathname to its current location.
 *
 * Exact matches win first; then the longest matching prefix. Returns `null`
 * when `pathname` isn't a known legacy path — callers should treat that as
 * "not legacy" and leave it alone. Current, valid admin-nav paths are never
 * keys in `ADMIN_LEGACY_PATHS`/`ADMIN_LEGACY_PREFIXES` (see the colocated
 * test), so this always returns `null` for them.
 */
export function resolveLegacyAdminPath(pathname: string): string | null {
    const exact = ADMIN_LEGACY_PATHS[pathname];
    if (exact) return exact;

    let bestPrefix: string | null = null;
    let bestTarget: string | null = null;
    for (const [prefix, target] of Object.entries(ADMIN_LEGACY_PREFIXES)) {
        const isMatch = pathname === prefix || pathname.startsWith(`${prefix}/`);
        if (isMatch && (bestPrefix === null || prefix.length > bestPrefix.length)) {
            bestPrefix = prefix;
            bestTarget = target;
        }
    }
    if (bestPrefix === null || bestTarget === null) return null;

    const rest = pathname.slice(bestPrefix.length);
    return `${bestTarget}${rest}`;
}

/**
 * Append an incoming `location.search` (e.g. `?foo=bar`, may be `''`) to a
 * resolved legacy target, correctly handling targets that already carry
 * their own `?query` and/or `#anchor`: the incoming query is merged with the
 * target's own query (if any) and always placed BEFORE the anchor.
 *
 * Shared by the redirect layer (`+layout.server.ts`, whole incoming URL) and
 * the pin self-heal path (a pinned `href`'s own leftover query string).
 */
export function appendLegacySearch(target: string, search: string): string {
    if (!search || search === '?') return target;

    const hashIndex = target.indexOf('#');
    const base = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const anchor = hashIndex === -1 ? '' : target.slice(hashIndex);
    const incoming = search.startsWith('?') ? search.slice(1) : search;
    if (!incoming) return target;

    const joinedBase = base.includes('?') ? `${base}&${incoming}` : `${base}?${incoming}`;
    return `${joinedBase}${anchor}`;
}
