// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
/**
 * defs/music/text-search.ts — `GET /api/v1/music/text-search` on the redesign
 * contract.
 *
 * Text-to-Sound semantic search: embeds the query string with the MSCLAP CLAP
 * text encoder, then runs kNN over `media_audio_embeddings` to find tracks
 * whose AUDIO is closest to the text description in the joint CLAP space.
 *
 * This is the v1 surfacing of the legacy `/api/music/text-search`, which
 * returned a bespoke `{ success:true, tracks }` (no pagination, internal-only).
 * The v1 shape is the canonical collection envelope `{ items, page }` where
 * each item is a self-describing track handle (canonical `id` + `type:'track'`
 * + self-describing `images{}` hrefs with size presets) plus a per-result
 * `similarityScore`.
 *
 * Pagination: kNN returns the single best top-N by cosine similarity; there is
 * no stable offset window, so `page` reports `{ limit, truncated }`
 * (truncated is true only when the backend yielded more
 * than `limit` candidates).
 *
 * Gating (via the def's `feature` AuthSpec): `features.textToSound` must be on
 * (FEATURE_MUSIC_TEXT_SOUND && sonicEmbeddings) — a disabled feature 404s, as
 * with every other v1 feature-gated def. Then any authenticated caller.
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
import { embedTextQuery } from '$lib/server/services/sonic-embedding.service.js';
import { textSoundSearch } from '$lib/server/database/queries/text-sound-search.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { musicTextSearchQuerySchema } from '$lib/schemas/api-music-responses.js';
import { MusicTextSearchResponseSchema } from '$lib/schemas/api-music-responses.js';
import { musicSearchRowToTrack } from '$lib/server/utils/music-track-mapper.js';

const logger = Logger.for('MusicTextSearchV1Def');

/** A single v1 music semantic-search result — a self-describing track handle. */

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Music', 'Search'],
            summary: 'Text-to-sound semantic search',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Embeds the query string with the CLAP text encoder and runs kNN over the audio ' +
                'embeddings to find tracks whose AUDIO is closest to the text description ' +
                '(e.g. "calm piano"). Returns a `{ items, page }` collection of self-describing ' +
                'track handles (canonical `id` + `type:"track"` + `images{}` size presets) plus ' +
                'a per-result `similarityScore`. Requires the `textToSound` feature ' +
                '(returns 404 when disabled). A down dependency returns ' +
                '`503 dependency_unavailable` (never an empty 200).',
            query: musicTextSearchQuerySchema,
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
    auth: { kind: 'feature', flag: 'textToSound', then: { kind: 'user' } },

    // Shares the `music:semantic-search` budget with the sibling
    // lyrics-search def (C21 fix-plan finding), enforced by mount() — see
    // define.ts `rateLimit` (Task 5, C5).
    rateLimit: {
        limit: 30,
        windowSec: 60,
        keyBy: (event) =>
            `music:semantic-search:${event.locals.user?.userId ?? event.locals.principal?.username ?? 'anonymous'}`,
    },

    request: {
        query: musicTextSearchQuerySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const parsed = musicTextSearchQuerySchema.safeParse(
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

            const surface = ctx.surface;

            try {
                // Embed the query text using the CLAP text encoder.
                const embedding = await embedTextQuery(q);
                if (!embedding) {
                    return ApiProblem.dependencyUnavailable('Failed to generate text embedding');
                }

                const accessCtx = await buildSearchAccessContext(sql, user);

                // Fetch limit+1 to detect truncated without a second round-trip.
                const rows = await textSoundSearch(
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

                logger.debug('Text-to-sound search complete', {
                    username: user.username,
                    query: q.slice(0, 100),
                    count: items.length,
                });

                return json({ items, page: { limit, truncated } });
            } catch (error) {
                logger.error('Text-to-sound search failed', error as Error, { query: q });
                return ApiProblem.dependencyUnavailable('Search backend is unavailable');
            }
        },
    },
});
