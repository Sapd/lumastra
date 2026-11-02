// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/audiobooks` — the audiobook destination's server load.
 *
 * The first page, the facets and the resume rail are all AWAITED and rendered
 * into the first-paint HTML, matching what `/browse` does for Continue Watching
 * and for the same reason: an unawaited/streamed version leaves the grid empty
 * until a post-hydration fetch lands, which reads as "slow" rather than
 * "loading". The client only fetches again when a filter actually changes.
 *
 * The URL is the whole filter state (`?libraryGroupId`, `?lang`, `?seriesId`, `?authorId`,
 * `?narratorId`, `?letter`,
 * `?sort`), so a deep link and a reload restore the same view — the same
 * contract `/browse` keeps.
 */

import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/database/connection.js';
import {
    getAudiobooksInProgress,
    type AudiobookSort,
} from '$lib/server/database/queries/audiobook-browse.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import {
    audiobookPreviewsForAdmittedIds,
    catalogFacets,
    getCatalogResource,
    listCatalogBooks,
} from '$lib/server/database/queries/audiobook-catalog.queries.js';
import { bookQuery, facetQuery } from '$lib/server/api/defs/audiobooks/catalog-input.js';
import { Logger } from '$lib/server/utils/logger.js';
import { buildAudiobookActivitySection } from '$lib/server/api/defs/recommendations/feed-audiobook-activity-section.js';
import { buildAccessContext } from '$lib/server/api/defs/recommendations/recommender.js';
import { resolveUiLocale } from '$lib/server/utils/ui-locale.js';

import {
    AudiobookBrowseResponseSchema,
    AudiobookFacetsSchema,
} from '$lib/schemas/api-audiobooks-responses';
import { ContributorDetailSchema } from '$lib/schemas/api-audiobook';

const logger = Logger.for('AudiobooksPageSSR');

/** Matches the client's page size — a reset load must not refetch what SSR sent. */
const PAGE_SIZE = 60;
const RESUME_LIMIT = 12;
const ACTIVITY_LIMIT = 10;

const SORTS: readonly AudiobookSort[] = [
    'title_asc',
    'title_desc',
    'added_desc',
    'year_desc',
    'year_asc',
    'series_sequence',
];

function parseSort(value: string | null): AudiobookSort {
    return SORTS.find((sort) => sort === value) ?? 'title_asc';
}

/** 'A'-'Z' or '#'; anything else is treated as no filter rather than an error. */
function parseLetter(value: string | null): string | undefined {
    if (!value) return undefined;
    const upper = value.toUpperCase();
    return upper === '#' || /^[A-Z]$/.test(upper) ? upper : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async (event) => {
    const { locals, url } = event;
    const group = url.searchParams.get('libraryGroupId');
    const language = url.searchParams.get('lang') ?? undefined;
    const validId = (key: string): string | undefined => {
        const value = url.searchParams.get(key);
        return value && UUID.test(value) ? value : undefined;
    };
    const series = validId('seriesId');
    // Credit filters compose with each other and the visible library scope.
    const author = validId('authorId');
    const narrator = validId('narratorId');
    const letter = parseLetter(url.searchParams.get('letter'));
    // Drilling into a series defaults to reading order; only an explicit ?sort
    // overrides it. Anywhere else, sequence order is meaningless.
    const requestedSort = url.searchParams.has('sort')
        ? parseSort(url.searchParams.get('sort'))
        : series
          ? 'series_sequence'
          : 'title_asc';
    // Reading order only exists inside a series; the sort <select> has no such
    // option elsewhere, so a stale ?sort=series_sequence would render a dropdown
    // that shows "Title (A-Z)" while applying a different order.
    const sort = requestedSort === 'series_sequence' && !series ? 'title_asc' : requestedSort;

    const libraryGroupId = group && UUID.test(group) ? group : undefined;
    const empty = {
        loadError: false,
        items: [],
        totalCount: 0,
        hasMore: false,
        shelves: [],
        languages: [],
        letterCounts: [],
        resume: [],
        filter: {
            group: libraryGroupId ?? null,
            language: language ?? null,
            series: series ?? null,
            author: author ?? null,
            narrator: narrator ?? null,
            letter: letter ?? null,
            sort,
        },
        filterNames: { author: null, narrator: null, series: null },
        pageSize: PAGE_SIZE,
        audiobookActivity: null,
    };

    const sql = getDb();
    if (!sql || !locals.user) return { ...empty, loadError: !sql };

    try {
        const access = searchAccessBoundary(await buildSearchAccessContext(sql, locals.user));
        // Read in-process, not through `event.fetch`: a sub-request forwards only the
        // cookie/authorization headers, not the proxy identity (forward-auth), so the
        // API answered 401 for those users. The query strings are parsed by the same
        // zod schemas the /audiobooks endpoints use, so defaults and validation cannot
        // drift from the API; the query functions are the ones its handlers call.
        const viewer = { access, viewerId: locals.user.userId, surface: 'internal' as const };
        const listQuery = bookQuery.parse({
            sort: sort === 'series_sequence' ? 'series' : sort.split('_')[0],
            order: sort.endsWith('desc') ? 'desc' : 'asc',
            limit: PAGE_SIZE,
            offset: 0,
            libraryGroupId,
            lang: language || undefined,
            seriesId: series,
            authorId: author,
            narratorId: narrator,
            letter,
            collapse: series ? undefined : 'series',
        });
        const facetInput = facetQuery.parse({
            libraryGroupId,
            lang: language || undefined,
            seriesId: series,
            authorId: author,
            narratorId: narrator,
            collapse: series ? undefined : 'series',
        });

        const resourceName = async (
            resource: 'author' | 'narrator' | 'series',
            id: string | undefined,
        ): Promise<string | null> => {
            if (!id) return null;
            const detail = await getCatalogResource(sql, { ...viewer, resource, id });
            if (!detail) return null;
            const result = ContributorDetailSchema.safeParse(detail);
            return result.success ? result.data.name : null;
        };

        // `buildAccessContext` reads the request's own principal and returns null
        // for an unauthenticated one; the guard above already established a user,
        // so null here means the recommender could not build a context and the
        // rail is simply skipped.
        const activityCtx = await buildAccessContext(event);

        const [page, facets, resume, audiobookActivity, authorName, narratorName, seriesLabel] =
            await Promise.all([
                listCatalogBooks(sql, { ...listQuery, ...viewer }).then((data) =>
                    AudiobookBrowseResponseSchema.parse(data),
                ),
                catalogFacets(sql, { ...facetInput, ...viewer, limit: PAGE_SIZE, offset: 0 }).then(
                    (data) => AudiobookFacetsSchema.parse(data),
                ),
                getAudiobooksInProgress(sql, {
                    userId: locals.user.userId,
                    access,
                    limit: RESUME_LIMIT,
                }),
                // Built HERE rather than fetched from /feed, and deliberately
                // NOT gated on the viewer's own listening: /feed applies that
                // gate because the rail competes with every other row there,
                // whereas arriving on /audiobooks has already established the
                // context. Someone who has never opened a book is exactly who
                // "what is your circle listening to" is for.
                activityCtx
                    ? buildAudiobookActivitySection(
                          activityCtx,
                          'internal',
                          resolveUiLocale(event),
                          ACTIVITY_LIMIT,
                      ).catch(() => null)
                    : Promise.resolve(null),
                resourceName('author', author),
                resourceName('narrator', narrator),
                resourceName('series', series),
            ]);

        return {
            loadError: false,
            items: page.items,
            totalCount: page.page.total ?? page.items.length,
            hasMore: page.page.hasMore,
            ...facets,
            resume: await audiobookPreviewsForAdmittedIds(
                sql,
                resume.map((row) => row.mediaId),
                locals.user.userId,
                'internal',
            ),
            filter: {
                group: libraryGroupId ?? null,
                language: language ?? null,
                series: series ?? null,
                author: author ?? null,
                narrator: narrator ?? null,
                letter: letter ?? null,
                sort,
            },
            filterNames: { author: authorName, narrator: narratorName, series: seriesLabel },
            pageSize: PAGE_SIZE,
            audiobookActivity,
        };
    } catch (err) {
        // Keep the selected scope and working chrome, but distinguish a failed
        // load from an empty library so the viewer can retry.
        logger.warn(
            'Audiobooks SSR load failed; rendering an empty destination',
            err instanceof Error ? err : undefined,
        );
        return { ...empty, loadError: true };
    }
};
