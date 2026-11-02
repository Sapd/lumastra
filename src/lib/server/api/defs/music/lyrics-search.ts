// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
/**
 * defs/music/lyrics-search.ts — `GET /api/v1/music/lyrics-search` on the
 * redesign contract.
 *
 * Semantic lyrics search: embeds the query text with the configured
 * text-embedding provider (Voyage/OpenAI), then runs kNN over
 * `media_lyrics_embeddings` to find tracks whose LYRICS are semantically
 * similar to the query.
 *
 * This is the v1 surfacing of the legacy `/api/music/lyrics-search`, which
 * returned a bespoke `{ success:true, tracks }` (no pagination, internal-only).
 * The v1 shape is the canonical `{ items, page }` envelope where each item is a
 * self-describing track handle (canonical `id` + `type:'track'` + self-
 * describing `images{}` hrefs) plus a per-result `similarityScore`.
 *
 * Pagination: kNN returns the single best top-N by cosine similarity; there is
 * no stable offset window, so `page` reports `{ limit, truncated }`.
 *
 * Gating (via the def's `feature` AuthSpec): `features.lyricsSearch` must be on
 * — a disabled feature 404s. Then any authenticated caller.
 *
 * Errors → problem+json. A down dependency (DB / embedding provider) yields
 * `503 dependency_unavailable` — NEVER a 200 with an empty array.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { generateVoyageQueryEmbedding, isVoyageAvailable } from '$lib/server/ai/voyage.js';
import { searchByLyricsEmbedding } from '$lib/server/database/queries/lyrics-search.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { musicLyricsSearchQuerySchema } from '$lib/schemas/api-music-responses.js';
import { MusicTextSearchResponseSchema } from '$lib/schemas/api-music-responses.js';
import { musicSearchRowToTrack } from '$lib/server/utils/music-track-mapper.js';

const logger = Logger.for('MusicLyricsSearchV1Def');

/** A single v1 music semantic-search result — a self-describing track handle. */

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Music', 'Search'],
            summary: 'Semantic lyrics search',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Embeds the query text with the configured text-embedding provider and runs kNN ' +
                'over the lyrics embeddings to find tracks whose LYRICS are semantically similar ' +
                'to the query. Returns a `{ items, page }` collection of self-describing track ' +
                'handles (canonical `id` + `type:"track"` + `images{}` size presets) plus a ' +
                'per-result `similarityScore`. Requires the `lyricsSearch` feature ' +
                '(returns 404 when disabled). A down dependency returns ' +
                '`503 dependency_unavailable` (never an empty 200).',
            query: musicLyricsSearchQuerySchema,
            responses: {
                200: {
                    schema: MusicTextSearchResponseSchema,
                    description: 'Semantic search results',
                },
                401: 'Authentication required',
                404: 'Feature not enabled',
                422: 'Validation failed',
                503: 'Search dependency unavailable',
                500: 'Internal server error',
            },
        },
    },

    // Feature-gate first (404 when off), then require an authenticated caller.
    auth: { kind: 'feature', flag: 'lyricsSearch', then: { kind: 'user' } },

    // The query embedding call is now SSRF-guarded (voyage.ts's default
    // fetch — see embedding-fetch-context.ts), but it is still an
    // unthrottled per-request external API call directly reachable by any
    // authenticated user. Shares the `music:semantic-search` budget with the
    // sibling text-search def (C21 fix-plan finding), enforced by mount()
    // — see define.ts `rateLimit` (Task 5, C5).
    rateLimit: {
        limit: 30,
        windowSec: 60,
        keyBy: (event) =>
            `music:semantic-search:${event.locals.user?.userId ?? event.locals.principal?.username ?? 'anonymous'}`,
    },

    request: {
        query: musicLyricsSearchQuerySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const parsed = musicLyricsSearchQuerySchema.safeParse(
                Object.fromEntries(event.url.searchParams),
            );
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { limit } = parsed.data;
            const q = parsed.data.q.trim();
            if (q.length < 1) {
                return ApiProblem.validationFailed([
                    { field: 'q', message: 'Query parameter "q" is required' },
                ]);
            }

            if (!isVoyageAvailable()) {
                return ApiProblem.dependencyUnavailable('Embedding provider not configured');
            }

            const surface = ctx.surface;

            try {
                // Embed the query text with the 'query' input type.
                const embedding = await generateVoyageQueryEmbedding(q);
                if (!embedding) {
                    return ApiProblem.dependencyUnavailable('Failed to generate query embedding');
                }

                const accessCtx = await buildSearchAccessContext(sql, user);

                // Fetch limit+1 to detect truncated without a second round-trip.
                const rows = await searchByLyricsEmbedding(
                    sql,
                    embedding,
                    limit + 1,
                    searchAccessBoundary(accessCtx),
                );

                const truncated = rows.length > limit;
                const imageSets = await resolveImageSets(
                    sql,
                    surface,
                    rows.slice(0, limit).map((row) => ({ id: row.media_id, mediaType: 'track' })),
                );
                const items = rows.slice(0, limit).map((row) => ({
                    ...musicSearchRowToTrack(row, imageSets.get(row.media_id) ?? {}),
                    similarityScore: Math.round(row.similarity_score * 10000) / 10000,
                }));

                logger.debug('Lyrics search complete', {
                    username: user.username,
                    query: q.slice(0, 100),
                    count: items.length,
                });

                return json({ items, page: { limit, truncated } });
            } catch (error) {
                logger.error('Lyrics search failed', error as Error, { query: q });
                return ApiProblem.dependencyUnavailable('Search backend is unavailable');
            }
        },
    },
});
