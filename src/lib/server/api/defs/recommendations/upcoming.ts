// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ApiSurface } from '$lib/shared/api-urls.js';
import { buildMediaPreviews } from '$lib/server/services/media-preview.service.js';
import type { MediaPreview } from '$lib/schemas/api-media-preview.js';
import { buildPreviewIdentity, isCatalogUuid } from '$lib/server/services/media-handle.js';
import {
    filterAccessibleMediaIds,
    restrictedAccess,
    type MediaAccessBoundary,
} from '$lib/server/utils/media-access-batch.js';

/**
 * GET /api/v1/upcoming
 *
 * Query params:
 *   view    — 'episodes' | 'alerts' | 'calendar'  (default: 'episodes')
 *   limit   — page size (1–100, default 10)
 *   start   — ISO date (calendar view only)
 *   end     — ISO date (calendar view only)
 *
 * Response shape — all views return { items, page } (UpcomingResponseSchema):
 *   episodes/alerts → { items: MediaPreview[], page: PageBlock }
 *   calendar        → { items: MediaItem[], page: PageBlock }  (date-range driven)
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import type { SurfaceContext } from '$lib/server/api/define.js';
import { config } from '$lib/server/config.js';
import { z } from 'zod';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';

import { buildAccessContext } from './recommender.js';
import type { ResolvedMetadataLanguages } from '$lib/server/utils/metadata-language-resolve.js';
import { UpcomingResponseSchema } from '$lib/schemas/api-recommender-responses';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import type { UserId } from '$lib/shared/user-id.js';

export const UpcomingQuerySchemaFromDocs = z.object({
    view: z
        .enum(['episodes', 'alerts', 'calendar'])
        .optional()
        .meta({ description: 'View mode (default: episodes)' }),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .meta({ description: 'Maximum results (default 10, including calendar view)' }),
    offset: z.coerce
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Calendar view only: number of items to skip'),
    start: z.string().optional().meta({ description: 'ISO 8601 start date (calendar view only)' }),
    end: z.string().optional().meta({ description: 'ISO 8601 end date (calendar view only)' }),
});

export const UpcomingQuerySchema = z.object({
    view: z.enum(['episodes', 'alerts', 'calendar']).optional().default('episodes'),
    limit: z.coerce.number().int().min(1).max(100).optional().default(10),
    offset: z.coerce
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Calendar view only: number of items to skip'),
    // Calendar view date range
    start: z.string().optional(),
    end: z.string().optional(),
});

/**
 * Stringify a Sonarr series ID for the `ids.sonarr` provider map.
 *
 * `RecommendedMediaRefSchema.ids` is `z.record(string, string)`, while the rows
 * this runs over come from Sonarr's OWN calendar API via
 * `transformSonarrToMediaItem`, which yields numeric series IDs (see
 * `sonarrSeriesId?: number` in `$lib/server/types.ts`). So this MUST run on
 * every path that reads `sonarrSeriesId`, not just the cached-episodes path, or
 * a raw number leaks onto the wire and fails strict client decoding (e.g. tvOS
 * OpenAPI codegen).
 *
 * "Sonarr's calendar API" here means the live arr instance, NOT this app's own
 * `/api/calendar` (or `GET /upcoming?view=calendar`, which delegates to it).
 * That surface is DB-backed and puts the parent series' `media_items` UUID in
 * `seriesMediaId` — with `sonarrSeriesId` kept as a legacy alias of the same
 * UUID string. Those rows never reach this function: the calendar view returns
 * from `handleCalendarView` before `buildUpcomingItems` is ever called. The
 * `string` arm below is defensive, not that path.
 */
export function stringifySonarrId(raw: number | string | null | undefined): string {
    return raw != null ? String(raw) : '';
}

/**
 * One Sonarr calendar row, in the shape both call sites hold it.
 *
 * The cache stores raw PRE-map Sonarr-shaped rows, so the cached payload and
 * the freshly-transformed array are structurally identical — one type and one
 * mapper serve both. `externalIds` is produced by `transformSonarrToMediaItem`
 * (see transformers.ts) and was previously undeclared here, which is precisely
 * why the tvdb/tmdb ids it computes were being dropped on the floor.
 */
export type UpcomingSonarrRow = {
    seasonNumber?: number;
    seriesName?: string;
    title?: string;
    episodeNumber?: number;
    sonarrAirDate?: string;
    sonarrHasFile?: boolean;
    overview?: string;
    /** Raw Sonarr numeric series ID (transformSonarrToMediaItem / server/types.ts). */
    sonarrSeriesId?: number | string;
    /** Series-level provider ids ({tvdb, tmdb, imdb}) from the Sonarr payload. */
    externalIds?: ExternalIds;
};

/** Narrow an unknown cached row to {@link UpcomingSonarrRow} without trusting its fields. */
function asSonarrRow(raw: unknown): UpcomingSonarrRow {
    const e = (raw ?? {}) as Record<string, unknown>;
    const ext = e.externalIds;
    return {
        seasonNumber: typeof e.seasonNumber === 'number' ? e.seasonNumber : undefined,
        seriesName: typeof e.seriesName === 'string' ? e.seriesName : undefined,
        title: typeof e.title === 'string' ? e.title : undefined,
        episodeNumber: typeof e.episodeNumber === 'number' ? e.episodeNumber : undefined,
        sonarrAirDate: typeof e.sonarrAirDate === 'string' ? e.sonarrAirDate : undefined,
        overview: typeof e.overview === 'string' ? e.overview : undefined,
        sonarrSeriesId:
            typeof e.sonarrSeriesId === 'number' || typeof e.sonarrSeriesId === 'string'
                ? e.sonarrSeriesId
                : undefined,
        externalIds: ext && typeof ext === 'object' ? (ext as ExternalIds) : undefined,
    };
}

/** Resolve series and episode identities after cache reads; unresolvable rows are dropped. */
export async function buildUpcomingItems(
    sql: postgres.Sql,
    rows: UpcomingSonarrRow[],
    surface: ApiSurface = 'v1',
    access?: MediaAccessBoundary,
): Promise<MediaPreview[]> {
    const { batchResolvePrimaryExternalId } =
        await import('$lib/server/database/queries/external-ids.queries.js');

    // Alerts/episodes are series-only (Radarr rows are filtered out upstream by
    // the `!item.seasonNumber` guard), so every lookup is media_type 'tv'.
    // Provider ids are NOT unique across media types — the composite
    // (external_id, media_type) key is mandatory here, not defensive.
    const tmdbIds = [
        ...new Set(
            rows
                .map((row) => getExternalIdFor(row.externalIds, 'tmdb'))
                .filter((id): id is string => id != null),
        ),
    ];
    const resolved = tmdbIds.length
        ? await batchResolvePrimaryExternalId(
              sql,
              tmdbIds.map((tmdbId) => ({ tmdbId, mediaType: 'tv' })),
          )
        : new Map<string, string>();

    const candidateSeriesIds = [
        ...new Set([
            ...resolved.values(),
            ...rows
                .map((row) => getExternalIdFor(row.externalIds, 'internal'))
                .filter(isCatalogUuid),
        ]),
    ];
    // A series the caller may not open is never exposed as a library row: it falls back to
    // the provider handle, exactly like a title that is not in the library at all.
    const accessible = access
        ? await filterAccessibleMediaIds(sql, candidateSeriesIds, access)
        : new Set(candidateSeriesIds);
    const seriesIds = candidateSeriesIds.filter((id) => accessible.has(id));
    const episodes = seriesIds.length
        ? await sql<
              Array<{
                  id: string;
                  series_id: string;
                  season_number: number;
                  episode_number: number;
                  has_files: boolean;
              }>
          >`
        SELECT ep.id, se.parent_id AS series_id, ep.season_number, ep.episode_number, ep.has_files
        FROM media_items ep JOIN media_items se ON se.id = ep.parent_id
        WHERE se.parent_id = ANY(${seriesIds}::uuid[]) AND ep.media_type = 'episode' AND ep.status = 'active'
        ORDER BY ep.id`
        : [];
    const byCoordinates = new Map(
        episodes.map((ep) => [`${ep.series_id}:${ep.season_number}:${ep.episode_number}`, ep]),
    );
    return buildMediaPreviews(
        sql,
        surface,
        rows.flatMap((row) => {
            const tmdbId = getExternalIdFor(row.externalIds, 'tmdb');
            const candidateUuid = isCatalogUuid(getExternalIdFor(row.externalIds, 'internal'))
                ? getExternalIdFor(row.externalIds, 'internal')
                : tmdbId
                  ? resolved.get(`${tmdbId}:tv`)
                  : undefined;
            const identity = buildPreviewIdentity({
                uuid: candidateUuid && accessible.has(candidateUuid) ? candidateUuid : undefined,
                provider: 'tmdb',
                providerId: tmdbId,
                type: 'series',
            });
            if (!identity) return [];
            const episode = byCoordinates.get(
                `${identity.catalogId}:${row.seasonNumber}:${row.episodeNumber}`,
            );
            if (!config.SHOW_UNAVAILABLE_MEDIA && !episode?.has_files) return [];
            return [
                {
                    id: episode?.id,
                    type: 'episode',
                    title: row.title ?? '',
                    overview: row.overview,
                    ids: {},
                    context: {
                        series: { ...identity, title: row.seriesName ?? '' },
                        seasonNumber: row.seasonNumber,
                        episodeNumber: row.episodeNumber,
                        airDate: row.sonarrAirDate,
                    },
                    isAvailable: episode?.has_files ?? false,
                    hasFile: episode?.has_files ?? false,
                    canRequest: false,
                    reason: {
                        kind: 'upcoming',
                        label:
                            row.seasonNumber != null
                                ? `S${row.seasonNumber}E${row.episodeNumber ?? 0}`
                                : undefined,
                    },
                },
            ];
        }),
    );
}

/** Overlay catalog episode translations on fresh preview objects. */
export async function overlayUpcomingItems(
    sql: postgres.Sql,
    items: MediaPreview[],
    langs: ResolvedMetadataLanguages | undefined,
): Promise<void> {
    if (!langs || (!langs.titleLang && !langs.textLang) || items.length === 0) return;
    const [{ applyTranslationOverlay }, { UUID_RE }] = await Promise.all([
        import('$lib/server/utils/translation-overlay.js'),
        import('$lib/utils/id-patterns.js'),
    ]);
    await applyTranslationOverlay(sql, items, langs, {
        id: (it) => (UUID_RE.test(it.catalogId ?? '') ? (it.catalogId ?? '') : null),
        setTitle: (it, v) => {
            it.title = v;
        },
    });
}

/** Who the upcoming-episodes list is built for — the caller, or an integration's target user. */
export interface UpcomingEpisodesTarget {
    userId: UserId;
    username: string;
    /** Library groups the user may not open; null = no restriction. */
    deniedGroupIds: string[] | null;
    /** null = no age limit. */
    maxAgeRating: number | null;
    allowUnrated: boolean;
    langs?: ResolvedMetadataLanguages;
}

export type UpcomingEpisodesResult =
    | { ok: true; items: MediaPreview[]; truncated: boolean }
    | { ok: false; reason: 'upstream_unavailable' };

/** The window the Sonarr/Radarr calendar is fetched (and cached) for. */
export const UPCOMING_EPISODES_WINDOW_DAYS = 30;

/**
 * Upcoming, unwatched episodes of the series a user watches or explicitly
 * follows, from the Sonarr/Radarr calendar, behind that user's library and age
 * boundary.
 *
 * Shared by `GET /api/v1/upcoming?view=episodes|alerts` (the caller) and
 * `GET /api/v1/integrations/upcoming` (an integration asking for one user), so
 * a bot answering "what's new for me" sees exactly what the app shows that
 * user. `days` narrows the window after the cache; it never changes what is
 * cached.
 */
export async function getUpcomingEpisodesForUser(
    sql: postgres.Sql,
    ctx: UpcomingEpisodesTarget,
    opts: {
        limit: number;
        refresh: boolean;
        days?: number;
        surface?: ApiSurface;
    },
): Promise<UpcomingEpisodesResult> {
    const access = restrictedAccess({
        deniedGroupIds: ctx.deniedGroupIds ?? [],
        maxAgeRating: ctx.maxAgeRating,
        allowUnrated: ctx.allowUnrated,
    });
    const horizon = opts.days !== undefined ? Date.now() + opts.days * 24 * 60 * 60 * 1000 : null;
    const withinDays = (rows: UpcomingSonarrRow[]): UpcomingSonarrRow[] =>
        horizon === null
            ? rows
            : rows.filter((r) => {
                  const t = Date.parse(r.sonarrAirDate ?? '');
                  return Number.isFinite(t) && t <= horizon;
              });

    const { getWatchedSeriesFromDb, getFollowedSeriesFromDb, getWatchedEpisodeKeys } =
        await import('$lib/server/database/queries/watch-state.queries.js');
    const { fuzzyTitleMatch } = await import('$lib/server/utils/string-utils.js');
    const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache');

    const upcomingCache = cacheManager.for(CACHE_NAMESPACES.upcomingEpisodes);
    // v2: explicitly followed series joined the filter (2026-10-02).
    // v3: muted series are matched by id (excluded-series-match.ts).
    // v4: retain the complete window so any supported limit has an honest truncated flag.
    const cacheKey = 'episodes:user:v4';

    if (opts.refresh) {
        await upcomingCache.delete(cacheKey, ctx.userId);
    }

    if (!opts.refresh) {
        const cached = await upcomingCache.get<unknown[]>(cacheKey, ctx.userId);
        if (cached) {
            const rows = withinDays(cached.map(asSonarrRow));
            const previews = await buildUpcomingItems(sql, rows, opts.surface, access);
            const items = previews.slice(0, opts.limit);
            await overlayUpcomingItems(sql, items, ctx.langs);
            return { ok: true, items, truncated: previews.length > opts.limit };
        }
    }

    // The caller's real library boundary. This used to be rebuilt here from a
    // user object WITHOUT `isAdmin`/`userGroups`, which `getDeniedLibraryGroups`
    // read as "a non-admin in no group" — so admins and group members lost every
    // series in a group-restricted library from this list.
    const accessCtx = {
        deniedGroupIds: ctx.deniedGroupIds,
        ageRating:
            ctx.maxAgeRating !== null
                ? { maxAgeRating: ctx.maxAgeRating, allowUnrated: ctx.allowUnrated }
                : null,
    };

    const watchedSeriesRows = await getWatchedSeriesFromDb.all(sql, {
        userId: ctx.userId,
        deniedGroupIds: accessCtx.deniedGroupIds,
        ageRating: accessCtx.ageRating,
    });
    // Explicitly followed series count as watched here: a user who asked to be
    // told about a series they have not started yet expects it in this list.
    const followedSeriesRows = await getFollowedSeriesFromDb.all(sql, {
        userId: ctx.userId,
        deniedGroupIds: accessCtx.deniedGroupIds,
        ageRating: accessCtx.ageRating,
    });
    const watchedSeries = [
        ...new Set([
            ...watchedSeriesRows.map((r: { series_name: string }) => r.series_name),
            ...followedSeriesRows.map((r: { series_name: string }) => r.series_name),
        ]),
    ];

    if (watchedSeries.length === 0) {
        return { ok: true, items: [], truncated: false };
    }

    const watchedEpisodesRaw = await getWatchedEpisodeKeys.all(sql, { userId: ctx.userId });
    const watchedEpisodeKeys = new Set(
        watchedEpisodesRaw.map(
            (e: { series_name: string; season_number: number; episode_number: number }) =>
                `${e.series_name}|S${e.season_number}E${e.episode_number}`,
        ),
    );

    const { getExcludedSeriesKeys } = await import('$lib/server/utils/excluded-series.js');
    const { isMonitoredSeriesExcluded } =
        await import('$lib/server/utils/excluded-series-match.js');
    const exclusions = await getExcludedSeriesKeys(ctx.username);

    const { sonarrClient, radarrClient } = await import('$lib/server/sonarr.js');
    const { transformSonarrToMediaItem } = await import('$lib/server/transformers.js');

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + UPCOMING_EPISODES_WINDOW_DAYS);

    const [sonarrCal, radarrCal] = await Promise.allSettled([
        sonarrClient.getCalendar(startDate, endDate),
        radarrClient.getCalendar(startDate, endDate),
    ]);

    const bothFailed = sonarrCal.status === 'rejected' && radarrCal.status === 'rejected';
    if (bothFailed) {
        return { ok: false, reason: 'upstream_unavailable' };
    }

    const allItems = [
        ...(sonarrCal.status === 'fulfilled' ? sonarrCal.value : []),
        ...(radarrCal.status === 'fulfilled' ? radarrCal.value : []),
    ];

    const calendarData = transformSonarrToMediaItem(allItems);

    // Uses the module-level UpcomingSonarrRow (which declares
    // `externalIds`) rather than a local type — the local one omitted
    // that field, so the tvdb/tmdb ids transformSonarrToMediaItem
    // computes were silently discarded before reaching the mapper.
    type MediaItem = UpcomingSonarrRow;

    const filtered = calendarData
        .filter((item: MediaItem) => {
            if (!item.seasonNumber) return false;
            if (
                isMonitoredSeriesExcluded(
                    exclusions,
                    getExternalIdFor(item.externalIds, 'tmdb'),
                    getExternalIdFor(item.externalIds, 'tvdb'),
                )
            ) {
                return false;
            }
            const isFollowed = watchedSeries.some((ws: string) =>
                item.seriesName ? fuzzyTitleMatch(ws, item.seriesName) : false,
            );
            if (!isFollowed) return false;
            const episodeKey = `${(item.seriesName ?? '').toLowerCase()}|S${item.seasonNumber}E${
                item.episodeNumber ?? 0
            }`;
            return !watchedEpisodeKeys.has(episodeKey);
        })
        .sort((a: MediaItem, b: MediaItem) => {
            const aDate = new Date(a.sonarrAirDate ?? '').getTime();
            const bDate = new Date(b.sonarrAirDate ?? '').getTime();
            const now = Date.now();
            const aIsRecent = aDate >= now - 7 * 24 * 60 * 60 * 1000 && aDate <= now;
            const bIsRecent = bDate >= now - 7 * 24 * 60 * 60 * 1000 && bDate <= now;
            if (aIsRecent && !bIsRecent) return -1;
            if (!aIsRecent && bIsRecent) return 1;
            if (aIsRecent && bIsRecent) return bDate - aDate;
            return aDate - bDate;
        });

    if (!bothFailed) {
        await upcomingCache.set(cacheKey, filtered, undefined, ctx.userId);
    }

    const inWindow = withinDays(filtered);
    const previews = await buildUpcomingItems(sql, inWindow, opts.surface, access);
    const items = previews.slice(0, opts.limit);

    await overlayUpcomingItems(sql, items, ctx.langs);

    return { ok: true, items, truncated: previews.length > opts.limit };
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Upcoming'],
            summary: 'Get upcoming releases and episodes',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Paginated episode MediaPreviews with context.series, seasonNumber, episodeNumber and airDate. Calendar view includes movies, monitored and hasFile. IDs are resolvable opaque handles; reason.label is display text only.',
            query: UpcomingQuerySchemaFromDocs,
            responses: {
                200: {
                    schema: UpcomingResponseSchema,
                    description: 'Upcoming items',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        query: UpcomingQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            if (event.url.searchParams.has('refresh'))
                return ApiProblem.validationFailed('Use POST /upcoming/refresh');
            const raw = {
                view: event.url.searchParams.get('view') ?? undefined,
                limit: event.url.searchParams.get('limit') ?? undefined,
                offset: event.url.searchParams.get('offset') ?? undefined,
                start: event.url.searchParams.get('start') ?? undefined,
                end: event.url.searchParams.get('end') ?? undefined,
            };
            return handleUpcoming(event, ctx, raw);
        },
    },
});

export async function handleUpcoming(
    event: RequestEvent,
    endpointCtx: SurfaceContext,
    raw: unknown,
    refresh = false,
): Promise<Response> {
    const parsed = UpcomingQuerySchema.safeParse(raw);
    if (!parsed.success) {
        return ApiProblem.validationFailed(
            parsed.error.issues.map((e) => ({
                field: e.path.join('.'),
                message: e.message,
            })),
        );
    }
    const q = parsed.data;

    const ctx = await buildAccessContext(event);
    if (!ctx) return ApiProblem.unauthorized();

    // Age-restricted users cannot receive Sonarr/Radarr calendar data
    if (ctx.isAgeRestricted) {
        return ApiProblem.forbidden(
            'Upcoming content is not available for age-restricted profiles',
        );
    }

    if (q.view === 'calendar') {
        // Delegate to the existing calendar handler which has the full date-range logic.
        // This keeps backward-compat with clients that already call /calendar while
        // exposing the same data through the new canonical path.
        const calendarHandler =
            await import('$lib/server/api/defs/recommendations/calendar-delegate.js');
        const calendarUrl = new URL(event.url);
        calendarUrl.search = '';
        for (const key of ['start', 'end', 'offset', 'limit'] as const) {
            if (q[key] !== undefined) calendarUrl.searchParams.set(key, String(q[key]));
        }
        return calendarHandler.handleCalendarView(
            { ...event, url: calendarUrl },
            endpointCtx.surface,
            100,
            q.limit,
        );
    }

    // episodes (for-you/new-episodes) and alerts (upcoming) share the same
    // Sonarr/DB backend.  The view param maps to the existing handler logic.
    const { getDb } = await import('$lib/server/database/connection.js');
    const sql = getDb();
    if (!sql) {
        return ApiProblem.dependencyUnavailable('Database not available');
    }

    const result = await getUpcomingEpisodesForUser(sql, ctx, {
        limit: q.limit,
        surface: endpointCtx.surface,
        refresh,
    });
    if (!result.ok) return ApiProblem.dependencyUnavailable('Upcoming data unavailable');

    return json({
        items: result.items,
        page: { limit: q.limit, offset: 0, truncated: result.truncated },
    });
}
