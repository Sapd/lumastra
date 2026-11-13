// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { LayoutServerLoad } from './$types';
import { config, features, devFeaturesEnabled } from '$lib/server/config';
import { getAiConfig } from '$lib/server/config/domains/ai.js';
import { loadProviderSearchIndex } from '$lib/server/admin/provider-search-index';
import { getDb } from '$lib/server/database/connection.js';
import { getNavPins, adminNavPins } from '$lib/server/database/queries';
import { getAdminUiPrefs } from '$lib/server/database/queries/admin-ui-prefs.queries.js';
import type { AdminNavStyle } from '$lib/config/admin-nav.js';
import { getAllAdminNavPaths } from '$lib/config/admin-nav.js';
import { resolveLegacyAdminPath, appendLegacySearch } from '$lib/config/admin-legacy-paths.js';
import { Logger } from '$lib/server/utils/logger.js';
import { appPath } from '$lib/shared/api-urls.js';
import {
    UPLOADABLE_LIBRARY_TYPES,
    LIBRARY_UPLOAD_NAV_DEP,
} from '$lib/shared/uploadable-library-types.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('AdminLegacyNav');

export const load: LayoutServerLoad = async ({ locals, parent, depends }) => {
    if (!localsIsAdmin(locals)) {
        redirect(303, appPath('/'));
    }

    // NOTE: the admin IA legacy-path REDIRECT lives in hooks.server.ts
    // (adminLegacyRedirectHandle), NOT here — this layout load never runs for
    // paths with no matching route (SvelteKit 404s first), and dead legacy
    // URLs by definition have no route. Only the PIN self-healing below uses
    // resolveLegacyAdminPath in this file.

    // Pull the root layout's full feature flags so admin pages can read
    // jellyfinSync / quickConnect / etc. via `$page.data.features`. SvelteKit
    // overwrites parent fields on shallow conflict, so without this merge the
    // tiny admin-only object below would mask the 35+ flags the root sets.
    const parentData = await parent();
    const parentFeatures = (parentData as { features?: App.PageData['features'] }).features ?? {};

    // Load pinned nav items
    let navPins: Array<{ href: string; label: string; sortOrder: number }> = [];
    // Per-admin-user UI preferences (admin IA redesign, spec §4). Defaults to
    // 'sidebar' when the table/row doesn't exist yet (fail open).
    let navStyle: AdminNavStyle = 'sidebar';
    // Library → Upload only applies with an enabled library of an uploadable
    // type — hide the tab otherwise. Sources re-runs this via the dep key
    // when an edit flips the answer. Fail open: a probe error keeps it shown.
    depends(LIBRARY_UPLOAD_NAV_DEP);
    let libraryUpload = true;
    const sql = getDb();
    if (sql) {
        try {
            const [row] = await sql<{ has: boolean }[]>`
                SELECT EXISTS (
                    SELECT 1 FROM library_paths
                    WHERE enabled AND media_type = ANY(${[...UPLOADABLE_LIBRARY_TYPES]})
                ) AS has
            `;
            libraryUpload = row?.has === true;
        } catch (err) {
            logger.warn('Library upload nav probe failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        try {
            const rows = await getNavPins.all(sql, {});
            const validPaths = getAllAdminNavPaths();
            navPins = (
                await Promise.all(
                    rows.map(async (r) => {
                        // Compare/resolve on the pathname only — a pin's href may
                        // carry its own `?query`/`#anchor` that a legacy target
                        // (or the validity check) shouldn't have to know about.
                        // Only an app-relative /admin path is a pin. The API enforces
                        // this on write; a row that got in another way (e.g.
                        // `//host/admin/…`, which parses to an /admin pathname) must
                        // not be handed back as a link.
                        if (!r.href.startsWith('/admin/')) return null;
                        let pathname = r.href;
                        let search = '';
                        let hash = '';
                        try {
                            const parsed = new URL(r.href, 'http://admin-nav-pin.internal');
                            pathname = parsed.pathname;
                            search = parsed.search;
                            hash = parsed.hash;
                        } catch {
                            // Not a parseable URL — fall back to treating the raw
                            // string as the pathname (best effort).
                        }

                        if (validPaths.has(pathname)) {
                            return { href: r.href, label: r.label, sortOrder: r.sort_order };
                        }

                        const legacy = resolveLegacyAdminPath(pathname);
                        if (legacy) {
                            let newHref = appendLegacySearch(legacy, search);
                            if (hash && !newHref.includes('#')) newHref += hash;
                            try {
                                await adminNavPins.updateNavPinHref.execute(sql, {
                                    oldHref: r.href,
                                    newHref,
                                });
                            } catch (err) {
                                logger.warn('Failed to self-heal legacy nav pin href', {
                                    oldHref: r.href,
                                    newHref,
                                    error: err instanceof Error ? err.message : String(err),
                                });
                            }
                            return { href: newHref, label: r.label, sortOrder: r.sort_order };
                        }

                        // Neither a currently-valid admin path nor a known legacy
                        // one — hide it (the redirect layer above would 404/loop
                        // on it) rather than silently deleting a user's pin.
                        logger.warn('Hiding admin nav pin with unresolvable href', {
                            href: r.href,
                        });
                        return null;
                    }),
                )
            ).filter((p): p is { href: string; label: string; sortOrder: number } => p !== null);
            // Two rows can land on one href: two legacy paths that heal to the
            // same page, or a legacy pin next to a pin already on its target
            // (the heal UPDATE then no-ops on the unique href). Every renderer
            // keys its {#each} on href, and a repeated key throws — keep the first.
            const seenHrefs = new Set<string>();
            navPins = navPins.filter((p) => {
                if (seenHrefs.has(p.href)) return false;
                seenHrefs.add(p.href);
                return true;
            });
        } catch (err) {
            // Fail open — use defaults if table doesn't exist yet
            logger.warn('Admin nav pins load failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        const userId = locals.user?.userId;
        if (userId) {
            try {
                const prefs = await getAdminUiPrefs(sql, userId);
                if (prefs?.nav_style === 'mega') navStyle = 'mega';
            } catch {
                // Fail open — table may not exist before the migration runs
            }
        }
    }

    const ai = getAiConfig();
    // Fail open like the probes above: this lists plugin providers, and one
    // throwing must not turn every /admin page into a 500 (Health included).
    const providerIndex = await loadProviderSearchIndex().catch((err: unknown) => {
        logger.warn('Admin provider search index failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    });
    // Showcase nav visibility. Gated on the operator's showcase master switch,
    // which DEFAULTS OFF, so the entry is hidden by default (and would be a dead
    // link in a tree where the route is removed). Shown only when turned on.
    const showcaseEnabled = config.FEATURE_PUBLIC_SHOWCASE;
    return {
        user: locals.user ? { ...locals.user, isAdmin: localsIsAdmin(locals) } : locals.user,
        // Use DB-authoritative isAdmin so manually promoted users see admin tabs
        isAdmin: localsIsAdmin(locals),
        // Default user for the dev mode switcher, which only renders in dev builds
        defaultUser: dev ? config.DEFAULT_USER : undefined,
        // API key availability for conditional feature display
        apiKeys: {
            hasTmdb: !!config.TMDB_API_KEY,
            hasMdblist: !!config.MDBLIST_API_KEY,
            hasVoyage: ai.hasVoyage,
            hasOpenai: ai.hasOpenai,
        },
        // Feature flags for conditional tab display. liveTvSource is an
        // admin-only config string (not a public flag) so we add it on top
        // of the inherited public feature set.
        features: {
            ...parentFeatures,
            ffmpegAvailable: features.ffmpegAvailable,
            liveTvSource: config.LIVETV_SOURCE,
            // The stream proxy is an opt-in compose profile; without it there is nothing
            // to poll for Live TV viewer status.
            liveTvProxyConfigured: Boolean(config.STREAM_PROXY_URL),
            // Re-declared explicitly (not just inherited via the spread) so
            // AdminNav's enterprise nav-item gating gets a typed boolean
            // instead of `unknown` — the spread's source is cast to
            // Record<string, unknown> and loses its concrete keys.
            trainingAssignments: features.trainingAssignments,
            assessment: features.assessment,
            showcase: showcaseEnabled,
            libraryUpload,
        },
        navPins,
        // Admin IA redesign (spec §4): per-user nav style + developer-tools gate.
        uiPrefs: { navStyle },
        devToolsEnabled: config.SHOW_DEVELOPER_TOOLS,
        providerIndex,
        devFeaturesEnabled,
    };
};
