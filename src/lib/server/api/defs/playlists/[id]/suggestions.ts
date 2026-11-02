// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * playlists/{id}/suggestions — playlist-driven track recommendations.
 *
 * GET playlists/{id}/suggestions?count=6
 *
 * Returns `{ items, source, page }` with public Track DTOs and a limit-only
 * `{ limit, truncated }` page block.
 *
 * Auth: {kind:'user'} — playlist membership/public check enforced inside the handler.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * GET /playlists/{id}/suggestions query schema.
 *
 * `count` — number of suggestions (1–50, handler defaults to 6).
 */
const SuggestionsQuerySchema = z.object({
    count: z.coerce.number().int().min(1).max(50).optional(),
});
import { aiDbService } from '$lib/server/services/database.service.js';
import { parseInteger } from '$lib/utils/data-extraction.js';
import {
    getPlaylistSuggestionsFull,
    getPlaylistSuggestionsViaSonic,
    countPlaylistSonicEmbeddings,
    type PlaylistSuggestionFullRow,
} from '$lib/server/database/queries/music.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';
import { features } from '$lib/server/config.js';
import { normalizeTitle } from '$lib/server/database/queries/music-title-normalize.js';
import { effectiveArtistKey } from '$lib/server/utils/music-artist-key.js';
import { TrackSchema } from '$lib/schemas/api-music-dto.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toMusicTrack } from '$lib/server/services/music/track-projection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getUserRole } from '$lib/server/utils/playlist-utils.js';

export const SuggestionsResponseSchema = z.object({
    items: z.array(TrackSchema),
    source: z.enum(['sonic', 'metadata']),
    page: z.object({
        limit: z.number().int(),
        truncated: z.boolean(),
    }),
});

const logger = Logger.for('PlaylistSuggestionsAPI');

const SONIC_COVERAGE_THRESHOLD = 3;
const MAX_COUNT = 50;

function pickDiversePlaylistSuggestions(
    rows: PlaylistSuggestionFullRow[],
    count: number,
): PlaylistSuggestionFullRow[] {
    const MAX_ARTIST = 2;
    const seenTitles = new Set<string>();
    const artistCounts = new Map<string, number>();
    const result: PlaylistSuggestionFullRow[] = [];

    for (const row of rows) {
        if (result.length >= count) break;

        const normTitle = normalizeTitle(row.title ?? '');
        if (normTitle && seenTitles.has(normTitle)) continue;

        const aKey = effectiveArtistKey({
            id: row.id,
            artistName: row.artist_title ?? null,
            fallbackId: null,
        });
        const artistN = artistCounts.get(aKey) ?? 0;
        if (artistN >= MAX_ARTIST) continue;

        if (normTitle) seenTitles.add(normTitle);
        artistCounts.set(aKey, artistN + 1);
        result.push(row);
    }

    return result;
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Playlists'],
            summary: 'Get playlist track suggestions',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns playlist-aware track recommendations for an accessible playlist. Pending invitations confer no access. source reports the recommendation algorithm; the page has no continuation.',
            query: SuggestionsQuerySchema,
            responses: {
                200: { schema: SuggestionsResponseSchema, description: 'Track suggestions' },
                401: 'Authentication required',
                404: 'Playlist not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        query: SuggestionsQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const playlistIdRaw = event.params.id;
            if (!playlistIdRaw) return ApiProblem.validationFailed('Playlist ID missing');

            const playlistId = parseInteger(playlistIdRaw);
            if (playlistId === undefined || playlistId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Playlist id must be a positive integer' },
                ]);
            }

            const countRaw = event.url.searchParams.get('count');
            const count = Math.min(parseInteger(countRaw ?? '') ?? 6, MAX_COUNT);

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // Verify the caller can access this playlist.
            const { role } = await getUserRole(sql, playlistId, null, user.userId);
            if (!role) {
                return ApiProblem.notFound('Playlist not found');
            }

            // Over-fetch to give the diversity pass a meaningful pool.
            const fetchLimit = count * 4;

            let source: 'sonic' | 'metadata' = 'metadata';
            let rawRows;

            if (features.sonicEmbeddings) {
                const sonicCount = await countPlaylistSonicEmbeddings(sql, playlistId);
                if (sonicCount >= SONIC_COVERAGE_THRESHOLD) {
                    const sonicRows = await getPlaylistSuggestionsViaSonic(
                        sql,
                        playlistId,
                        fetchLimit,
                    );
                    if (sonicRows.length > 0) {
                        rawRows = sonicRows;
                        source = 'sonic';
                    }
                }
            }

            if (!rawRows) {
                rawRows = await getPlaylistSuggestionsFull(sql, playlistId, fetchLimit);
            }

            const accessCtx = await buildSearchAccessContext(sql, user);
            const accessFiltered = await filterAccessibleRows(
                sql,
                rawRows,
                searchAccessBoundary(accessCtx),
            );

            const candidates = pickDiversePlaylistSuggestions(accessFiltered, count + 1);
            const truncated = candidates.length > count;
            const rows = candidates.slice(0, count);

            logger.debug('Playlist suggestions computed', {
                username: user.username,
                playlistId,
                count: rows.length,
                source,
            });

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                rows.map((row) => ({ id: row.id, mediaType: 'track' })),
            );
            const items = rows.map((row) =>
                toMusicTrack({ ...row, custom_metadata: {} }, imageSets.get(row.id) ?? {}),
            );

            return json({ items, source, page: { limit: count, truncated } });
        },
    },
});
