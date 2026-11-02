// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/series.ts — GET /user/series
 *
 * Returns a paginated list of series the authenticated user has started
 * watching, with per-series progress computed server-side.
 *
 * Query parameters:
 *   status  — filter: 'in_progress' | 'completed' | 'not_started'
 *   limit   — max items per page (default 50, max 200)
 *   offset  — pagination offset (default 0)
 *   sort    — 'last_watched' | 'progress' | 'name'  (default 'last_watched')
 *   cursor  — opt-in keyset cursor (sort='last_watched' only). When present,
 *             offset is ignored. Internal surface only — no `docs:` block, so
 *             this endpoint is NOT on the documented v1 contract (Gate 0:
 *             shipped speculatively, no confirmed consumer).
 *
 * Response: { items, page }  (standard paginated envelope via paginate()).
 *   Offset mode keeps `page.total` and, when the request is cursor-eligible
 *   (sort='last_watched') and there is a next page, additionally emits
 *   `page.nextCursor` as a bootstrap value (Gate J1). Cursor mode drops `page.total`
 *   (Gate C — no cheap keyset total) and emits `page.nextCursor` when hasMore.
 *
 * Auth: {kind:'user'} — self-scoped, no admin escalation.
 * Errors: problem+json, incl. 503 dependency_unavailable on DB-down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate, type PageBlock } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import {
    computeAllSeriesProgress,
    type SeriesProgressCursor,
    type SeriesProgressPage,
} from '$lib/server/database/queries/watch-state.queries.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('UserSeriesDef');

const SORT_VALUES = ['last_watched', 'progress', 'name'] as const;
type SeriesSort = (typeof SORT_VALUES)[number];

const SeriesQuery = z.object({
    /** Filter by completion status */
    status: z.enum(['in_progress', 'completed', 'not_started']).optional(),
    /** Sort order */
    sort: z.enum(SORT_VALUES).optional(),
    /** Pagination — coerce from string; parsePagination() clamps */
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
    /** Opt-in keyset cursor (sort='last_watched' only); when present offset is ignored. */
    cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Per-feed cursor codec (F9c). Wraps the shared keyset-cursor builder with a
// feed tag so a cursor minted for another feed (e.g. /browse/genre) cannot be
// decoded-and-run here, and with a NULL marker so Gate D2b can carry the
// last_watched_at-IS-NULL group instead of hiding it.
//   'sv:' — series value group (non-null last_watched_at)
//   'sn:' — series NULL group   (last_watched_at IS NULL, ordered by id)
// The shared codec's `ts` slot is unused in the NULL case; the tag carries the
// null-ness, so a fixed '-' placeholder keeps the (ts:id) shape intact.
// ---------------------------------------------------------------------------

const SERIES_CURSOR_TAG_VALUE = 'sv:';
const SERIES_CURSOR_TAG_NULL = 'sn:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeSeriesCursor(cursor: SeriesProgressCursor): string {
    if (cursor.lastWatchedAt === null) {
        return SERIES_CURSOR_TAG_NULL + encodeKeysetCursor({ ts: '-', id: cursor.seriesMediaId });
    }
    return (
        SERIES_CURSOR_TAG_VALUE +
        encodeKeysetCursor({ ts: cursor.lastWatchedAt, id: cursor.seriesMediaId })
    );
}

function decodeSeriesCursor(raw: string): SeriesProgressCursor | null {
    const isNull = raw.startsWith(SERIES_CURSOR_TAG_NULL);
    const isValue = raw.startsWith(SERIES_CURSOR_TAG_VALUE);
    if (!isNull && !isValue) return null; // untagged or a different feed's cursor
    const core = decodeKeysetCursor(raw.slice(3));
    if (!core) return null;
    // Validate both halves before they reach Postgres — a decodable-but-bogus
    // cursor would otherwise 500 (22007 / 22P02) instead of a clean 422.
    if (!UUID_RE.test(core.id)) return null;
    if (isNull) return { lastWatchedAt: null, seriesMediaId: core.id };
    if (Number.isNaN(Date.parse(core.ts))) return null;
    return { lastWatchedAt: core.ts, seriesMediaId: core.id };
}

interface SeriesProgressRow {
    series_media_id: string;
    series_name: string;
    total_seasons: number | null;
    total_episodes: number;
    watched_episodes: number;
    progress_pct: number;
    completion_status: string;
    current_season: number | null;
    current_episode: number | null;
    last_watched_at: string | null;
    first_watched_at: string | null;
    last_watched_at_cursor?: string;
}

function mapItem(row: SeriesProgressRow): Record<string, unknown> {
    return {
        seriesId: row.series_media_id,
        seriesName: row.series_name,
        totalSeasons: row.total_seasons,
        totalEpisodes: row.total_episodes,
        watchedEpisodes: row.watched_episodes,
        progressPercentage: row.progress_pct,
        completionStatus: row.completion_status,
        currentSeason: row.current_season,
        currentEpisode: row.current_episode,
        lastWatchedAt: row.last_watched_at,
        firstWatchedAt: row.first_watched_at,
    };
}

function nextSeriesCursor(row: SeriesProgressRow): string {
    return encodeSeriesCursor({
        lastWatchedAt: row.last_watched_at_cursor ?? null,
        seriesMediaId: row.series_media_id,
    });
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: {
        query: SeriesQuery,
    },
    handlers: {
        /**
         * GET /user/series
         *
         * Returns a paginated { items, page } envelope of series progress rows
         * for the authenticated user.
         */
        GET: async (event, _ctx) => {
            const { locals, url } = event;
            const userId = locals.principal?.userId ?? locals.user?.userId;
            const username = locals.principal?.username ?? locals.user?.username;
            if (!userId || !username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is unavailable');
            }

            const status = (url.searchParams.get('status') ?? undefined) as
                'not_started' | 'in_progress' | 'completed' | undefined;

            // F9b: the handler reads sort straight off the URL. Historically an
            // unrecognized value bypassed the SeriesQuery enum and silently fell
            // through to last_watched; normalize explicitly so that stays true
            // (offset behaviour byte-identical) and the cursor guard below sees a
            // validated sort.
            const rawSort = url.searchParams.get('sort');
            const sort: SeriesSort = SORT_VALUES.includes(rawSort as SeriesSort)
                ? (rawSort as SeriesSort)
                : 'last_watched';

            const { limit, offset } = parsePagination(url, { defaultLimit: 50, maxLimit: 200 });

            const cursorParam = url.searchParams.get('cursor') ?? undefined;
            let page: SeriesProgressPage;
            if (cursorParam) {
                // Gate B1: cursor only for the default last_watched sort.
                if (sort !== 'last_watched') {
                    return ApiProblem.validationFailed(
                        'cursor is only valid for sort=last_watched',
                    );
                }
                // Gate D2b carries the NULL group, so there is NO status=not_started
                // scope rule — cursor pages uniformly for every status.
                const decoded = decodeSeriesCursor(cursorParam);
                if (!decoded) return ApiProblem.validationFailed('Invalid cursor');
                page = { mode: 'cursor', cursor: decoded };
            } else {
                page = { mode: 'offset', offset };
            }

            const rows = (await computeAllSeriesProgress(sql, userId, {
                status,
                availableOnly: true,
                limit,
                sort,
                page,
            })) as SeriesProgressRow[];

            if (page.mode === 'cursor') {
                // LIMIT n+1 lookahead: drive hasMore without a second query, and
                // drop page.total entirely (Gate C).
                const hasMore = rows.length > limit;
                const pageRows = rows.slice(0, limit);
                const items = pageRows.map(mapItem);
                const pageBlock: PageBlock = { limit, hasMore };
                if (hasMore && pageRows.length > 0) {
                    pageBlock.nextCursor = nextSeriesCursor(pageRows[pageRows.length - 1]);
                }
                logger.debug('Retrieved user series list (cursor)', {
                    username,
                    status,
                    count: items.length,
                });
                return json(paginate(items, pageBlock));
            }

            const items = rows.map(mapItem);
            // Offset mode keeps its total (second, unbounded query) for back-compat.
            const allRows = await computeAllSeriesProgress(sql, userId, {
                status,
                availableOnly: true,
            });
            const total = allRows.length;
            const hasMore = offset + items.length < total;
            const pageBlock: PageBlock = { limit, offset, hasMore, total };
            // Gate J1 bootstrap: when the request is cursor-eligible
            // (sort=last_watched) and there is a next page, hand back a cursor so a
            // client can switch into keyset paging. offset still produced this page.
            if (sort === 'last_watched' && hasMore && rows.length > 0) {
                pageBlock.nextCursor = nextSeriesCursor(rows[rows.length - 1]);
            }
            logger.debug('Retrieved user series list', {
                username,
                status,
                count: items.length,
                total,
            });
            return json(paginate(items, pageBlock));
        },
    },
});
