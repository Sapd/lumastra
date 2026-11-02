// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
/**
 * defs/music/tracks.ts — `GET /api/music/tracks` and `GET /api/v1/music/tracks`.
 *
 * The flat, library-wide track list: the third browse collection alongside
 * /music/albums and /music/artists, and the one an Apple-Music-style "Songs"
 * row needs. Until this existed the only routes to a track were
 * /music/text-search (which requires a query, is CLAP semantic search, and is
 * feature-gated) or an album-/artist-scoped listing — so there was no way to
 * browse the library's tracks at all.
 *
 * This is NOT new query capability. `getTracksPaged` has backed Subsonic
 * `search3`'s empty-term branch for a long time — that is how Symfonium
 * enumerates the whole library — it simply had no HTTP surface of its own and
 * no sort/filter parameters. Cost is not the reason it was missing: on the
 * production library (~24k tracks) a full COUNT runs in about 4 ms.
 *
 * Unlike /music/albums and /music/artists — whose v1 defs are thin delegates
 * wrapping bespoke `requireAuth` handlers, kept that way to preserve their
 * byte-exact 401 bodies — this def owns its handler and is mounted directly on
 * both surfaces, so the two can never drift.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getTracksPaged,
    countTracksPaged,
    type TrackBrowseSort,
} from '$lib/server/database/queries/music.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { MusicTracksResponseSchema } from '$lib/schemas/api-music-responses.js';
import { toIsoTimestamp, toMusicTrack } from '$lib/server/services/music/track-projection.js';

const logger = Logger.for('MusicTracksDef');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().meta({
        description: 'Maximum items to return (default: 50, max: 200)',
    }),
    offset: z.coerce.number().int().min(0).optional().meta({
        description: 'Offset for pagination (default: 0)',
    }),
    sort: z
        .enum(['alpha', 'artist', 'recent'])
        .optional()
        .meta({
            description:
                'alpha (title A-Z, default), artist (artist → album year → disc order), ' +
                'recent (recently added first)',
        }),
    genre: z.string().optional().meta({
        description: "Genre tag, case-insensitive, matched against the track's own tags",
    }),
    artist: z
        .string()
        .optional()
        .meta({
            description:
                'Artist UUID or display name. The UUID form is credit-aware — it matches ' +
                'tracks credited via additional_artist_ids as well as the album→artist ' +
                'hierarchy — and is strongly preferred: name matching cannot see credited ' +
                'artists, which is why /music/albums?artist=<name> returns nothing for most ' +
                'of this library.',
        }),
    includeTotal: z.enum(['1', 'true']).optional().meta({
        description: 'Include page.total (an extra COUNT). Omit on infinite-scroll pages.',
    }),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { query: QuerySchema },

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Browse music tracks',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns a paginated, library-wide list of tracks. Filter by genre or ' +
                'artist, sort by title, artist, or recently added. This is the flat ' +
                'browse collection that backs a "Songs" index row; for query-driven ' +
                'search use /music/text-search instead.',
            query: QuerySchema,
            responses: {
                200: {
                    schema: MusicTracksResponseSchema,
                    description: 'Paginated track list',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const url = event.url;
            const sortParam = url.searchParams.get('sort');
            const sort: TrackBrowseSort =
                sortParam === 'artist' || sortParam === 'recent' || sortParam === 'alpha'
                    ? sortParam
                    : 'alpha';
            const genre = url.searchParams.get('genre') ?? undefined;
            const artist = url.searchParams.get('artist') ?? undefined;
            const includeTotalParam = url.searchParams.get('includeTotal');
            const includeTotal = includeTotalParam === '1' || includeTotalParam === 'true';

            const { limit, offset } = parsePagination(url, {
                defaultLimit: DEFAULT_LIMIT,
                maxLimit: MAX_LIMIT,
            });

            const accessCtx = await buildSearchAccessContext(sql, user);
            const access = searchAccessBoundary(accessCtx);
            const browseOptions = { sort, genre, artist };

            // Over-fetch one row to derive hasMore without a COUNT — same trick
            // as /music/albums and /music/artists. The COUNT only happens when
            // the caller explicitly asks for a total.
            const [rows, total] = await Promise.all([
                getTracksPaged(sql, user.userId, limit + 1, offset, access, browseOptions),
                includeTotal
                    ? countTracksPaged(sql, access, browseOptions)
                    : Promise.resolve(undefined),
            ]);

            const hasMore = rows.length > limit;
            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                rows.slice(0, limit).map((row) => ({ id: row.id, mediaType: 'track' })),
            );
            const items = rows.slice(0, limit).map((row) => ({
                ...toMusicTrack(row, imageSets.get(row.id) ?? {}),
                // getTracksPaged aliases track.created_at as last_played_at.
                addedAt: toIsoTimestamp(row.last_played_at),
            }));

            logger.debug('Tracks browsed', {
                username: user.username,
                count: items.length,
                hasMore,
                sort,
                genre,
                artist,
                includeTotal,
            });

            // `total !== undefined`, not truthiness: an empty result set has a
            // total of 0, and dropping it would look like "not requested".
            return json(
                paginate(items, {
                    limit,
                    offset,
                    hasMore,
                    ...(total !== undefined ? { total } : {}),
                }),
            );
        },
    },
});
