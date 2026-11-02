// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildMediaPreview } from '$lib/server/services/media-preview.service.js';
import { buildPreviewIdentity } from '$lib/server/services/media-handle.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/resolver.js';
import type { MediaPreview } from '$lib/schemas/api-media-preview.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';

/**
 * calendar-delegate.ts — the `?view=calendar` branch of `GET /upcoming`.
 *
 * Returns the standard { items, page } envelope (same as the other /upcoming
 * views) so the response contract matches UpcomingResponseSchema for all views.
 * The rows come from the same feed as `GET /api/calendar`
 * (services/calendar-feed.service.ts); only the paging limits and the public
 * row shape are specific to this endpoint.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import type { CalendarRow } from '$lib/server/database/queries/calendar.queries.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Calendar rows use episode/movie types and resolvable series handles. */
export function canonicalizeCalendarRow(
    item: CalendarRow,
): (MediaPreview & { monitored: boolean; hasFile: boolean }) | null {
    const series =
        item.media_type === 'episode'
            ? buildPreviewIdentity({
                  uuid: item.series_id,
                  provider: 'tmdb',
                  providerId: item.tmdb_id,
                  type: 'series',
              })
            : null;
    if (item.media_type === 'episode' && !series) return null;
    const preview = buildMediaPreview({
        id: item.id,
        type: item.media_type,
        title: item.title,
        ids: item.media_type === 'movie' && item.tmdb_id ? { tmdb: item.tmdb_id } : {},
        overview: item.overview,
        year: item.year,
        context: {
            ...(series && { series: { ...series, title: item.series_name ?? '' } }),
            seasonNumber: item.season_number ?? undefined,
            episodeNumber: item.episode_number ?? undefined,
            airDate: item.premiere_date ?? undefined,
        },
        isAvailable: item.source !== 'monitored' && item.has_files,
        hasFile: item.has_files,
        reason: { kind: 'upcoming' },
    });
    return preview
        ? { ...preview, monitored: item.source === 'monitored', hasFile: item.has_files }
        : null;
}

/**
 * Handle the `?view=calendar` branch of `GET /upcoming`.
 */
export async function handleCalendarView(
    event: RequestEvent,
    surface: ApiSurface = 'v1',
    maxLimit: number = MAX_LIMIT,
    defaultLimit: number = DEFAULT_LIMIT,
): Promise<Response> {
    // Gate the whole endpoint for age-restricted profiles, matching the
    // primary calendar handler (the query age-filters too, but this is the
    // explicit endpoint-level gate).
    if (event.locals.user?.isAgeRestricted) {
        return ApiProblem.forbidden('This content is not available for age-restricted profiles');
    }
    // The endpoint is user-gated; a request without a user context must not
    // read the feed with an access boundary built from nothing.
    if (!event.locals.user) {
        return ApiProblem.unauthorized();
    }

    const url = event.url;
    const rawLimit = url.searchParams.get('limit');
    const rawOffset = url.searchParams.get('offset');
    const limit = rawLimit
        ? Math.min(Math.max(parseInt(rawLimit, 10) || defaultLimit, 1), maxLimit)
        : defaultLimit;
    const offset = rawOffset ? Math.max(parseInt(rawOffset, 10) || 0, 0) : 0;

    try {
        const { getDb } = await import('$lib/server/database/connection.js');
        const { json } = await import('@sveltejs/kit');
        const { loadCalendarFeed, overlayCalendarTranslations, parseCalendarRange } =
            await import('$lib/server/services/calendar-feed.service.js');

        const range = parseCalendarRange(
            url.searchParams.get('start'),
            url.searchParams.get('end'),
        );
        if (!range.ok) return range.response;

        const sql = getDb();
        if (!sql) {
            return ApiProblem.dependencyUnavailable('Database not available');
        }

        const rows = await loadCalendarFeed(sql, event.locals.user, range.start, range.end);
        // Resolve identities before paging so dropped rows do not create phantom pages.
        const items = rows.map(canonicalizeCalendarRow).filter((item) => item !== null);
        const pagedItems = items.slice(offset, offset + limit);
        const hasMore = items.length > offset + limit;
        const translated = pagedItems.map((item) => ({
            id: item.catalogId,
            title: item.title,
            overview: item.overview,
        }));
        await overlayCalendarTranslations(sql, event.locals.user.userId, translated);
        pagedItems.forEach((item, index) => {
            item.title = translated[index].title;
            item.overview = translated[index].overview;
        });
        const images = await resolveImageSets(
            sql,
            surface,
            pagedItems.map((item) => ({ id: item.id, mediaType: item.type })),
        );
        for (const item of pagedItems) {
            const set = images.get(item.id) ?? {};
            item.images =
                item.type === 'episode' && item.catalogId === null && set.thumb
                    ? { ...set, thumb: { ...set.thumb, source: 'series' } }
                    : set;
        }

        return json(paginate(pagedItems, { limit, offset, hasMore }));
    } catch {
        return ApiProblem.dependencyUnavailable('Calendar data unavailable');
    }
}
