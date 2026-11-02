// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Actions, PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { getAdminDb } from '$lib/server/database/connection.js';
import { getLibraryGroupsWithCounts } from '$lib/server/database/queries/library-groups.queries.js';
import {
    listAdminMediaItems,
    countAdminMediaItems,
    countAdminMediaViews,
} from '$lib/server/database/queries/admin-media.queries.js';
import { getSeasonCoverageBatch } from '$lib/server/database/queries/series-health.queries.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { features } from '$lib/server/config.js';
import {
    attentionKinds,
    parseMediaBrowserView,
    VIEW_ISSUE,
    viewQueryOptions,
    viewsForScope,
    type MediaBrowserView,
} from '$lib/shared/media-issues.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import {
    getCachedMediaBrowserLibraryGroups,
    getCachedMediaBrowserViewCounts,
} from '$lib/server/services/admin-media-browser-cache.js';
import { issuesForAdminRow } from '$lib/server/services/admin-media-issues.js';
import {
    advancedFilterKeysForDomain,
    defaultSortForType,
    defaultTypeForDomain,
    defaultSearchTypeForDomain,
    domainSupportsProviderIdentity,
    inferDomain,
    LAYOUT_COOKIE,
    PAGE_SIZE_COOKIE,
    parseJumpLetter,
    parseLayout,
    parsePageSize,
    PAGE_SIZES,
    resolveBrowserFilter,
    resolveTypes,
    VALID_SORT_COLS,
    type SortCol,
} from './media-filters.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import { denyUnlessAdmin } from '$lib/server/admin/admin-action-gate.js';

interface LibraryGroup {
    id: string;
    label: string;
    mediaTypes: string[];
}

type BrowserLoadEvent = Pick<Parameters<PageServerLoad>[0], 'url' | 'locals' | 'cookies'>;

// Preserve the concrete return shape for SvelteKit's generated PageData.
const loadBrowserData = (async ({ url, locals, cookies }: BrowserLoadEvent) => {
    if (!localsIsAdmin(locals)) {
        throw error(403, 'Admin access required');
    }

    // Heavy admin media-browser read (counts, view counts, library groups) — run on the
    // dedicated admin pool, isolated from the playback hot path on the web pool.
    const sql = getAdminDb();
    if (!sql) {
        throw error(503, 'Database not available');
    }

    const query = url.searchParams.get('q')?.trim() ?? '';
    const searchScope: 'title' | 'metadata' =
        url.searchParams.get('scope') === 'metadata' ? 'metadata' : 'title';
    const domain =
        url.searchParams.get('domain') ?? inferDomain(url.searchParams.get('type') ?? 'main');
    const typeFilter =
        url.searchParams.get('type') ??
        (query ? defaultSearchTypeForDomain(domain) : defaultTypeForDomain(domain));
    // Reaches SQL as `::uuid`: anything else (a typo, a corrupt saved filter)
    // raised a cast error and 500'd the whole browser.
    const rawLibraryGroupId = url.searchParams.get('library') ?? '';
    const libraryGroupId = isUuid(rawLibraryGroupId) ? rawLibraryGroupId : '';
    const showUnavailable = url.searchParams.get('unavailable') === '1';
    const showDismissed = url.searchParams.get('dismissed') === '1';
    // Remembered per browser in cookies (see PAGE_SIZE_COOKIE). `cookies` is
    // optional-chained because the unit tests drive load() with a bare event.
    const PAGE_SIZE = parsePageSize(
        url.searchParams.get('page_size') ?? cookies?.get(PAGE_SIZE_COOKIE),
    );
    const layout = parseLayout(url.searchParams.get('layout') ?? cookies?.get(LAYOUT_COOKIE));
    // Derive offset from the ?page=N param via parsePagination so that the
    // upper-bound clamp from the shared utility is applied (prevents astronomically
    // large offsets from a crafted URL). The frontend uses ?page=N with a fixed
    // PAGE_SIZE, so we convert page → offset before calling parsePagination.
    const MAX_PAGE = 10_000;
    const syntheticUrl = new URL(url.toString());
    const rawPageNum = parseInt(url.searchParams.get('page') ?? '1', 10);
    const clampedPage = Math.min(MAX_PAGE, Math.max(1, isNaN(rawPageNum) ? 1 : rawPageNum));
    syntheticUrl.searchParams.set('offset', String((clampedPage - 1) * PAGE_SIZE));
    syntheticUrl.searchParams.set('limit', String(PAGE_SIZE));
    const { limit: _limit, offset } = parsePagination(syntheticUrl, {
        defaultLimit: PAGE_SIZE,
        maxLimit: PAGE_SIZES[PAGE_SIZES.length - 1],
    });
    const pageNum = Math.floor(offset / PAGE_SIZE) + 1;

    // `VALID_SORT_COLS` and `SortCol` are imported from `media-filters.ts`: a
    // route file may only export reserved names, so declared here the whitelist
    // could not be imported and the test asserting `defaultSortForType` stays
    // inside it had to re-type the list by hand.
    const rawSort = url.searchParams.get('sort') ?? '';
    const rawOrder = url.searchParams.get('order') ?? '';
    // Resolved server-side ONLY. The client reads what it is sent rather than
    // mirroring this table — two copies would drift.
    const fallback = defaultSortForType(typeFilter);
    // The FALLBACK passes through the same whitelist as the user-supplied value.
    // Casting `fallback.sort` straight to `SortCol` let a per-type default name a
    // column this list does not carry, and the invariant this whitelist states
    // would then be enforced only by accident, downstream — `admin-media.queries.ts`
    // happens to end its sort lookup in `?? sortColumns.title`. Enforce it here.
    // `defaultSortForType` now returns `SortCol`, so the compiler enforces it too;
    // this stays as the runtime backstop and needs no assertion to do so.
    const fallbackSort: SortCol = VALID_SORT_COLS.includes(fallback.sort) ? fallback.sort : 'title';
    const sortBy = (
        (VALID_SORT_COLS as readonly string[]).includes(rawSort) ? rawSort : fallbackSort
    ) as SortCol;
    const sortDir: 'asc' | 'desc' =
        rawOrder === 'desc' ? 'desc' : rawOrder === 'asc' ? 'asc' : fallback.order;

    // Advanced filters
    // Provider-identity filters are neutralised for domains that do not offer
    // them (audiobooks, music). Enforced HERE, not only in the UI: hiding a
    // checkbox does not clear its query param, so a `?missing_tmdb=1` carried in
    // from the Video tab would otherwise filter the Audiobooks tab down to
    // nothing with no visible chip to explain it. The client strips the params
    // from the URL on switch; this is what makes a hand-edited or bookmarked URL
    // behave the same way.
    const providerIdentity = domainSupportsProviderIdentity(domain);
    const missingTmdb = providerIdentity && url.searchParams.get('missing_tmdb') === '1';
    const missingJf = providerIdentity && url.searchParams.get('missing_jf') === '1';
    const missingPoster = url.searchParams.get('missing_poster') === '1';
    const missingOverview = url.searchParams.get('missing_overview') === '1';
    const hasEmbedding = providerIdentity && url.searchParams.get('has_embedding') === '1';
    const locked = url.searchParams.get('locked') === '1';
    const localOnly = url.searchParams.get('local_only') === '1';
    const customPoster = url.searchParams.get('custom_poster') === '1';
    const rawAddedSince = url.searchParams.get('added_since') ?? '';
    const rawUpdatedSince = url.searchParams.get('updated_since') ?? '';
    // The single-value `?filter=` param — the deep-link target for Health's
    // file-health/integrity findings and, since the music-hygiene work, for each
    // music-hygiene finding. One param with one value rather than a `?x=1`
    // toggle per finding; `resolveBrowserFilter` owns the mapping so it is
    // unit-testable and so the value names cannot drift from the server
    // predicates that key off them.
    //
    // A value this build does not know degrades to "no filter" rather than
    // erroring: a bookmark from a newer version must render a list, not a 500.
    const { fileIssues, musicHygiene } = resolveBrowserFilter(url.searchParams.get('filter'));

    /** Resolve a date preset (24h, 7d, 30d) or ISO date string to an ISO date. */
    function resolveDate(value: string): string | undefined {
        if (!value) return undefined;
        const presets: Record<string, number> = {
            '24h': 24 * 3600_000,
            '7d': 7 * 86400_000,
            '30d': 30 * 86400_000,
        };
        // Own keys only: `presets['constructor']` is a function, and
        // Date.now() minus it is NaN, which toISOString() throws on.
        if (Object.hasOwn(presets, value)) {
            return new Date(Date.now() - presets[value]).toISOString();
        }
        const parsed = Date.parse(value);
        if (!isNaN(parsed)) return new Date(parsed).toISOString();
        return undefined;
    }

    const addedSince = resolveDate(rawAddedSince);
    const updatedSince = resolveDate(rawUpdatedSince);

    const isUnidentified = domain === 'unidentified';
    const types = resolveTypes(typeFilter, domain);

    // Saved views (spec 2026-09-27-media-browser-triage-design.md §2). A view
    // the scope cannot have (Unidentified under Music, Not in Jellyfin with
    // sync off) falls back to All rather than rendering an always-empty list.
    const jellyfinEnabled = features.jellyfinSync;
    const viewScope = { types, jellyfinEnabled };
    const availableViews = viewsForScope(viewScope);
    const requestedView = parseMediaBrowserView(url.searchParams.get('view'));
    if (requestedView !== 'all' && !availableViews.includes(requestedView)) {
        const target = new URL(url);
        target.searchParams.delete('view');
        throw redirect(303, target.pathname + target.search);
    }
    const view: MediaBrowserView = requestedView;
    const now = new Date();
    const viewOpts = viewQueryOptions(view, viewScope, now);
    const viewAttentionKinds = attentionKinds(viewScope);
    const recentSince = viewQueryOptions('recent', viewScope, now).addedSince!;
    const queryOpts = {
        types,
        query: query || undefined,
        searchScope,
        libraryGroupId: libraryGroupId || undefined,
        // Files lost and Needs attention list rows whose files disappeared;
        // every other view keeps the toggle's meaning.
        showUnavailable: showUnavailable || viewOpts.includeUnavailable,
        unidentified: isUnidentified,
        // NOT clamped to the unidentified domain. Dismissal is no longer only a
        // "failed TMDB match" state: the AudiobookShelf sweep dismisses books
        // that disappear upstream (an availability observation may never write
        // `status = 'deleted'`), so dismissed rows accumulate in the normal
        // browse domains by design. Clamping here would make them invisible in
        // every admin view and purgeable only via `psql`. The matching clamp in
        // `admin-media.queries.ts` was removed with this one — either alone is a
        // silent no-op.
        showDismissed,
        missingTmdb: missingTmdb || undefined,
        missingJf: missingJf || undefined,
        missingPoster: missingPoster || undefined,
        missingOverview: missingOverview || undefined,
        hasEmbedding: hasEmbedding || undefined,
        locked: locked || undefined,
        localOnly: localOnly || undefined,
        customPoster: customPoster || undefined,
        addedSince: addedSince ?? viewOpts.addedSince,
        updatedSince,
        issue: viewOpts.issue,
        attentionKinds: viewOpts.attentionKinds,
        fileIssues: fileIssues || undefined,
        musicHygiene: musicHygiene ?? undefined,
    };

    // A–Z jump (triage spec §5): count the rows that sort before the letter
    // under the list's own order, then redirect to the page they fill. Only
    // meaningful for an ascending title sort without a search (a search
    // orders by relevance); anything else lands on page 1.
    const jump = parseJumpLetter(url.searchParams.get('jump'));
    if (jump !== null) {
        let targetPage = 1;
        if (jump !== '#' && sortBy === 'title' && sortDir === 'asc' && !query) {
            const before = await countAdminMediaItems(sql, { ...queryOpts, titleBefore: jump });
            targetPage = Math.floor(before / PAGE_SIZE) + 1;
        }
        const target = new URL(url);
        target.searchParams.delete('jump');
        if (targetPage > 1) target.searchParams.set('page', String(targetPage));
        else target.searchParams.delete('page');
        throw redirect(303, target.pathname + target.search);
    }

    // Fetch count, page, library groups, and view counts in a single parallel batch.
    // The last two are filter-independent and dominated every navigation's
    // latency, so they come from a short-TTL shared cache — see
    // `admin-media-browser-cache.ts` for the measurements.
    // File-health/integrity/quarantine counts used to feed the removed domain
    // tabs' badges (admin IA redesign, spec §3.2) — those tabs are gone, replaced
    // by the "has file issues" filter above, so their dedicated counts are no
    // longer computed here (System → Health owns the aggregate summary instead).
    const [total, results, groups, viewCounts] = await Promise.all([
        countAdminMediaItems(sql, queryOpts),
        listAdminMediaItems(sql, {
            ...queryOpts,
            limit: PAGE_SIZE,
            offset,
            sortBy,
            sortDir,
        }),
        getCachedMediaBrowserLibraryGroups(async (): Promise<LibraryGroup[]> =>
            (await getLibraryGroupsWithCounts(sql)).map((g) => ({
                id: g.id,
                label: g.name,
                mediaTypes: g.media_types,
            })),
        ),
        getCachedMediaBrowserViewCounts(
            [
                domain,
                typeFilter,
                libraryGroupId || '-',
                showDismissed ? 'd' : '-',
                jellyfinEnabled ? 'jf' : '-',
            ].join(':'),
            () =>
                countAdminMediaViews(
                    sql,
                    {
                        types,
                        libraryGroupId: libraryGroupId || undefined,
                        showDismissed,
                        unidentified: isUnidentified,
                    },
                    {
                        views: availableViews.map((id) => ({ id, issue: VIEW_ISSUE[id] })),
                        attentionKinds: viewAttentionKinds,
                        recentSince,
                    },
                ),
        ),
    ]);

    const coverage = await getSeasonCoverageBatch(
        sql,
        getPrimaryExternalIdProvider(),
        results.filter((row) => row.media_type === 'tv').map((row) => row.id),
    ).catch(() => []);
    const libraryGroups: LibraryGroup[] = groups;

    // The selected view's pill shows the list's own fresh total whenever the
    // list and the count cover the same population — no search, no advanced
    // filter, no "include catalog-only" toggle. The other pills come from the
    // 60 s cache; this one therefore drops the moment a fix removes a row,
    // instead of lagging up to the cache TTL beside a list that already has.
    const listMatchesCountScope =
        !query &&
        !showUnavailable &&
        !missingTmdb &&
        !missingJf &&
        !missingPoster &&
        !missingOverview &&
        !hasEmbedding &&
        !locked &&
        !localOnly &&
        !customPoster &&
        !rawAddedSince &&
        !rawUpdatedSince &&
        !fileIssues &&
        !musicHygiene;
    const viewCountsOut: Record<string, number> =
        listMatchesCountScope && view in viewCounts ? { ...viewCounts, [view]: total } : viewCounts;

    // Build active filters object for the frontend (snake_case keys match URL params)
    const activeFilters = {
        missing_tmdb: missingTmdb,
        missing_jf: missingJf,
        missing_poster: missingPoster,
        missing_overview: missingOverview,
        has_embedding: hasEmbedding,
        locked,
        local_only: localOnly,
        custom_poster: customPoster,
        added_since: rawAddedSince,
        updated_since: rawUpdatedSince,
        file_issues: fileIssues,
        // The finding id itself, not a boolean: the chip has to name WHICH
        // finding is filtering the list, and the heuristic one has to be
        // labelled as a heuristic rather than reading as a defect list.
        music_hygiene: musicHygiene,
    };

    return {
        items: results.map((r) => ({
            id: r.id,
            title: r.title ?? 'Untitled',
            originalTitle: r.original_title ?? undefined,
            englishTitle: r.english_title ?? undefined,
            year: r.year ?? undefined,
            mediaType: r.media_type,
            status: r.status ?? undefined,
            seasonNumber: r.season_number ?? undefined,
            episodeNumber: r.episode_number ?? undefined,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            externalIds: {
                ...(r.jellyfin_id ? { jellyfin: r.jellyfin_id } : {}),
                ...(r.tmdb_id ? { tmdb: String(r.tmdb_id) } : {}),
                internal: r.id,
            },
            tmdbId: r.tmdb_id ?? undefined,
            childCount: r.child_count ?? 0,
            episodeCoverage:
                r.media_type === 'tv'
                    ? coverage.filter((season) => season.seriesId === r.id)
                    : undefined,
            hasFiles: r.has_files,
            metadataLocked: r.metadata_locked,
            isLocalOnly: r.is_local_only,
            hasPoster: r.has_poster,
            hasOverview: r.has_overview,
            fileIssues:
                (r.health_issue_types?.length ?? 0) > 0 || (r.integrity_issues?.length ?? 0) > 0
                    ? {
                          health: r.health_issue_types ?? [],
                          // Verbatim reasons behind each type — the tooltip
                          // shows these so an admin sees what ffmpeg actually
                          // said, and about which file.
                          healthDetails: (r.health_issue_details ?? []).map((d) => ({
                              type: d.type,
                              detail: d.detail ?? undefined,
                              filePath: d.file_path ?? undefined,
                              expectedDuration: d.expected_duration ?? undefined,
                              actualDuration: d.actual_duration ?? undefined,
                          })),
                          integrity: r.integrity_issues ?? [],
                      }
                    : undefined,
            runtimeSeconds: r.runtime_seconds ?? undefined,
            overview: r.overview
                ? r.overview.length > 100
                    ? r.overview.slice(0, 100) + '…'
                    : r.overview
                : undefined,
            fileCount: r.file_count ?? 0,
            bookAuthor: r.book_author ?? undefined,
            bookNarrator: r.book_narrator ?? undefined,
            bookSeries: r.book_series ?? undefined,
            bookSeriesSequence: r.book_series_sequence ?? undefined,
            artistTitle: r.artist_title ?? undefined,
            albumTitle: r.album_title ?? undefined,
            seriesTitle: r.series_title ?? undefined,
            seasonTitle: r.season_title ?? undefined,
            genericParentTitle: r.generic_parent_title ?? undefined,
            genericRootTitle: r.generic_root_title ?? undefined,
            isDuplicate: r.is_duplicate,
            issues: issuesForAdminRow(r, jellyfinEnabled),
        })),
        total,
        page: pageNum,
        pageSize: PAGE_SIZE,
        query,
        searchScope,
        typeFilter,
        libraryGroupId,
        libraryGroups,
        showUnavailable,
        showDismissed,
        domain,
        sort: sortBy,
        order: sortDir,
        activeFilters,
        // `supportsProviderIdentity` and `showsBookColumns` used to be returned
        // here. The per-(domain, type) column plan superseded them: `+page.svelte`
        // asks `columnAppliesTo(key, domain, typeFilter)`, which resolves both
        // from `data.domain` itself. They had no consumers left.
        advancedFilterKeys: advancedFilterKeysForDomain(domain),
        view,
        availableViews,
        viewCounts: viewCountsOut,
        jellyfinEnabled,
        layout,
    };
}) satisfies PageServerLoad;

export const load: PageServerLoad = (event) => loadBrowserData(event);

export const actions: Actions = {
    refreshSingleActQueue: async ({ url, locals, cookies }) => {
        const denied = denyUnlessAdmin(locals);
        if (denied) return denied;
        // The shared loader applies the page's explicit admin gate before it
        // reads any browser data. This action only returns that authoritative
        // read; it never changes catalog state.
        let browserData = await loadBrowserData({ url, locals, cookies });
        const requestedPage = Math.max(
            1,
            Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1,
        );
        const lastPage = Math.max(1, Math.ceil(browserData.total / browserData.pageSize));

        if (requestedPage > lastPage) {
            const correctedUrl = new URL(url);
            correctedUrl.searchParams.set('page', String(lastPage));
            browserData = await loadBrowserData({
                url: correctedUrl,
                locals,
                cookies,
            });
        }

        return {
            success: true,
            browserData,
            correctedPage: browserData.page,
        };
    },
};
