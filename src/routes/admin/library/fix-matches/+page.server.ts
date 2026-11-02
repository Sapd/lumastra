// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ONE identity workbench (admin IA redesign, spec §3.2). Replaces:
 *   - Library → "Unmatched Files" tab      → "Never matched" view (client-fetched,
 *     see NeverMatchedPanel.svelte — same population, same pagination/search UX)
 *   - Media browser → "Unidentified" tab   → folded into "Never matched" (same
 *     underlying media_items population once Jellyfin sync is not in play; see
 *     progress log decision)
 *   - /admin/operations/reidentify          → "Broken match" view (this load
 *     function — ported near-verbatim from the deleted route's +page.server.ts)
 *
 * Only the "Broken match" view is server-loaded: a paginated list narrowed by
 * ?q= (title) and ?type= (movie | series) in the URL. "Never matched" keeps its
 * own client-side fetch/search/sort/filter flow (NeverMatchedPanel.svelte); only
 * its total is loaded here so both tab badges show whichever tab is open.
 *
 * ?library=<libraryGroupId> scopes the WHOLE page — both views and both tab
 * badges — to one library (the library page's Issues section links here with
 * it). An id that names no library is ignored rather than showing an empty page.
 */

import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import {
    loadReidentifyQueue,
    countReidentifyItems,
} from '$lib/server/database/queries/ingest-map.queries.js';
import { countPersonalMediaItems } from '$lib/server/database/queries/media-items.queries.js';
import { getAllLibraryGroups } from '$lib/server/database/queries/library-groups.queries.js';
import { classifyBrokenMatch } from '$lib/components/admin/library/fix-matches-cause.js';
import type { BrokenMatchData } from '$lib/components/admin/library/fix-matches-types.js';
import type { PageServerLoad } from './$types';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const PAGE_SIZE = 48;

// Declared as a `type` (not `interface`) so it carries an implicit index
// signature and satisfies SvelteKit's `Record<string, …>` load-return
// constraint — an `interface` has no index signature and fails with TS2322.
export type FixMatchesPageData = {
    brokenMatch: BrokenMatchData;
    /** "Never matched" total for its tab badge; null when the count failed. */
    neverMatchedTotal: number | null;
    /** Every library, for the page's library filter. */
    libraries: FixMatchesLibraryOption[];
    /** The library the page is scoped to (?library=), or null for all libraries. */
    libraryGroupId: string | null;
};

export type FixMatchesLibraryOption = { id: string; name: string };

function parseMediaType(raw: string | null): 'movie' | 'series' | undefined {
    return raw === 'movie' || raw === 'series' ? raw : undefined;
}

export const load: PageServerLoad = async ({ url, locals }): Promise<FixMatchesPageData> => {
    // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
    // IdP groups misses both non-group admin paths — the `admin_pinned` DB
    // override and the in-app `admin` capability (see buildUserPermissions).
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }

    const rawOffset = url.searchParams.get('offset');
    const parsed = rawOffset !== null ? Number.parseInt(rawOffset, 10) : 0;
    const requested = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    const search = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    const mediaType = parseMediaType(url.searchParams.get('type'));
    const requestedLibrary = url.searchParams.get('library');
    const empty = { search, mediaType };

    const sql = getDb();
    if (!sql) {
        return {
            brokenMatch: {
                items: [],
                total: 0,
                ...empty,
                offset: requested,
                pageSize: PAGE_SIZE,
                dbError: 'Database unavailable',
            },
            neverMatchedTotal: null,
            libraries: [],
            libraryGroupId: null,
        };
    }

    let libraries: FixMatchesLibraryOption[] = [];
    let libraryGroupId: string | null = null;
    try {
        libraries = (await getAllLibraryGroups(sql)).map((g) => ({
            id: g.id,
            name: g.display_name?.trim() || g.name,
        }));
        // Only a known id filters: it also keeps a malformed value out of the
        // ::uuid cast in the queries.
        if (requestedLibrary && libraries.some((l) => l.id === requestedLibrary)) {
            libraryGroupId = requestedLibrary;
        }
        const filters = {
            search: search || undefined,
            mediaType,
            libraryGroupId: libraryGroupId ?? undefined,
        };
        const [total, neverMatchedTotal] = await Promise.all([
            countReidentifyItems(sql, filters),
            countPersonalMediaItems(sql, { libraryGroupId: filters.libraryGroupId }).catch(
                () => null,
            ),
        ]);
        // Clamp to the last populated page so a too-large ?offset (manual URL, or
        // items resolved/accepted since the link was made) doesn't strand the user
        // on a blank page.
        const lastPageOffset = total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
        const offset = Math.min(requested, lastPageOffset);
        const rows = await loadReidentifyQueue(sql, {
            limit: PAGE_SIZE,
            offset,
            ...filters,
        });
        return {
            brokenMatch: {
                items: rows.map((r) => ({
                    mediaItemId: r.media_item_id,
                    title: r.title,
                    seriesId: r.series_id ?? undefined,
                    seriesTitle: r.series_title ?? undefined,
                    seasonNumber: r.season_number ?? undefined,
                    episodeNumber: r.episode_number ?? undefined,
                    type: r.media_type,
                    stageId: r.stage_id,
                    errorMessage: r.error_message ?? undefined,
                    cause: classifyBrokenMatch({
                        errorMessage: r.error_message,
                        errorCode: r.error_code,
                    }),
                    deadSince: r.dead_since.toISOString(),
                    year: r.year ?? undefined,
                    filePath: r.file_path ?? undefined,
                    seasonCount: r.season_count ?? undefined,
                    episodeCount: r.episode_count ?? undefined,
                })),
                total,
                ...empty,
                offset,
                pageSize: PAGE_SIZE,
                dbError: null,
            },
            neverMatchedTotal,
            libraries,
            libraryGroupId,
        };
    } catch (err) {
        return {
            brokenMatch: {
                items: [],
                total: 0,
                ...empty,
                offset: requested,
                pageSize: PAGE_SIZE,
                dbError:
                    err instanceof Error ? err.message : 'Failed to load re-identification queue',
            },
            neverMatchedTotal: null,
            libraries,
            libraryGroupId,
        };
    }
};
