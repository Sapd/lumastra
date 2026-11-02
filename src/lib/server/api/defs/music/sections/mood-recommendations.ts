// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
/**
 * GET /api/music/sections/mood-recommendations?mood=<key>&limit=<n>
 * Also published at GET /api/v1/music/mood-recommendations (beta).
 *
 * Returns music tracks ranked by cosine similarity, in CLAP audio-embedding
 * space, to the pre-computed MSCLAP mood vector for the given mood key.
 * Requires the `mood_vectors` table to have an `msclap-2023` row for the key
 * (populated via the `mood-vector-generation` task) — no match returns an
 * empty track list, by design (no text-space fallback).
 *
 * Query params:
 *   mood   - Bare mood key (e.g. "chill", "workout"). The 'music:' namespace
 *            prefix is added server-side before the DB lookup.
 *   limit  - Max tracks to return (default 20, capped at 50).
 *   cursor - Opt-in keyset cursor for pagination. Present → bypasses the
 *            cache (uncached pgvector keyset scan), so cursor requests are
 *            rate limited per user.
 *
 * Response: { items: MoodTrack[], mood: string, page: { limit, hasMore, nextCursor? } }
 *   feature off → 404 not_found
 *   DB-down     → 503 dependency_unavailable
 *   Missing mood → 422 validation_failed
 *   Rate limited → 429 rate_limited
 *
 * Gating: features.sonicQueue (mood vectors are populated by that path).
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { features } from '$lib/server/config.js';
import { checkRateLimit, withRateLimitHeaders } from '$lib/server/middleware/valkey-rate-limit.js';
import {
    getMusicMoodRecommendations,
    type MoodRecommendationRow,
    type MoodRecommendationsCursor,
} from '$lib/server/database/queries/music-recommendations.queries.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { toMusicTrack } from '$lib/server/services/music/track-projection.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import {
    buildMoodPage,
    decodeMoodCursor,
    getCachedMoodPage,
    DEFAULT_MOOD_PAGE_LIMIT,
} from '$lib/server/services/music/mood-page.service.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { toString } from '$lib/utils/data-extraction.js';
import { MusicMoodRecommendationsResponseSchema } from '$lib/schemas/api-music-responses.js';
import { musicMoodVectorKey } from '$lib/server/database/queries/sonic-queue.queries.js';

// Shared with music/moods, which reads this same default page for cover art.
const DEFAULT_LIMIT = DEFAULT_MOOD_PAGE_LIMIT;
const MAX_LIMIT = 50;

/**
 * Per-user rate limit: the ?cursor= path bypasses the cache by design and is
 * an uncached pgvector keyset scan a token can page through indefinitely.
 */
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_S = 60;

const QuerySchema = z.object({
    mood: z.string().min(1, 'mood is required').meta({
        description:
            'Bare mood key, e.g. `chill`. Take it from `GET /api/v1/music/moods`: the set is per-install, and an unknown key returns an empty `items` array, not an error.',
    }),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
    // Opt-in keyset cursor (E2). Present → keyset continuation; cache bypassed.
    cursor: z.string().optional(),
});

// ── Opt-in keyset cursor (E2) ─────────────────────────────────────────────────
// Per-feed 'mr:' tag (F9c) so a cursor minted for another feed cannot
// decode-and-run here. distance is exact float8 text via the shared codec; id is
// the unique tiebreak. Ordering: (distance ASC, track.id ASC).
function toMoodTrack(row: MoodRecommendationRow, images: ImageSet) {
    return { ...toMusicTrack(row, images), similarityScore: row.similarity };
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { query: QuerySchema },

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get mood-ranked track recommendations',
            stability: 'beta',
            auth: 'bearer',
            description: `Returns library tracks ranked by cosine similarity to a mood vector in CLAP audio-embedding space. List the selectable moods with \`GET /api/v1/music/moods\`. Requires the sonicQueue feature. Supports keyset pagination via \`cursor\`; cursor requests bypass the cache. All requests (including cache hits) are rate limited to ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_S}s per user. An empty \`items\` array always means nothing matched for the caller; a failed lookup is a 5xx, never an empty list.`,
            query: QuerySchema,
            responses: {
                200: {
                    schema: MusicMoodRecommendationsResponseSchema,
                    description: 'Mood-ranked tracks with an optional keyset cursor',
                },
                401: 'Authentication required',
                404: 'sonicQueue feature is not enabled',
                422: 'Invalid cursor',
                429: 'Rate limit exceeded',
                500: 'Lookup failed — transient, retry',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            if (!event.locals.user) return ApiProblem.unauthorized();

            if (!features.sonicQueue) {
                return ApiProblem.notFound('Mood recommendations are not available');
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            // DB-availability is checked before the rate limit: every request is
            // guaranteed to 503 while the DB is down, so checking the limit
            // first would burn an authenticated caller's Valkey rate-limit
            // budget on requests that can never succeed anyway.
            const rl = await checkRateLimit(
                `music:mood-recs:${event.locals.user.userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return withRateLimitHeaders(
                    ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000)),
                    rl,
                );
            }

            const moodParam = toString(event.url.searchParams.get('mood'));
            if (!moodParam) {
                return ApiProblem.validationFailed('Missing required query parameter: mood');
            }

            const { limit } = parsePagination(event.url, {
                defaultLimit: DEFAULT_LIMIT,
                maxLimit: MAX_LIMIT,
            });

            // Opt-in keyset cursor (E2). Present → keyset continuation, cache
            // bypassed; 422 on malformed rather than a 500 from a bad ::float8.
            const cursorParam = toString(event.url.searchParams.get('cursor'));
            let cursor: MoodRecommendationsCursor | null = null;
            if (cursorParam) {
                cursor = decodeMoodCursor(cursorParam);
                if (!cursor) return ApiProblem.validationFailed('Invalid cursor');
            }

            const moodKey = musicMoodVectorKey(moodParam);

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const access = {
                deniedGroupIds: accessCtx.deniedGroupIds,
                ageRating: accessCtx.ageRating,
            };

            // Cursor mode (Gate E2): bypass the cache (cursor strings are
            // ~unique → ~0 hit rate). Fetch limit+1 to detect hasMore and mint
            // the next cursor. F8: getMusicMoodRecommendations propagates DB
            // errors (no swallow-to-[]), so a transient failure surfaces here
            // rather than silently ending the client's pagination.
            if (cursor) {
                const rows = await getMusicMoodRecommendations(sql, moodKey, limit + 1, access, {
                    cursor,
                });
                const page = buildMoodPage(rows, limit);
                const imageSets = await resolveImageSets(
                    sql,
                    ctx.surface,
                    page.rows.map((row) => ({ id: row.id, mediaType: 'track' })),
                );
                return withRateLimitHeaders(
                    json({
                        items: page.rows.map((row) =>
                            toMoodTrack(row, imageSets.get(row.id) ?? {}),
                        ),
                        mood: moodParam,
                        page: {
                            limit,
                            hasMore: Boolean(page.nextCursor),
                            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                        },
                    }),
                    rl,
                );
            }

            // Default (offset-mode) path — cached; shared with GET music/moods,
            // which reads the same default page to pick each mood's cover art.
            const cached = await getCachedMoodPage(sql, moodParam, limit, accessCtx);

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                cached.rows.map((row) => ({ id: row.id, mediaType: 'track' })),
            );
            return withRateLimitHeaders(
                json({
                    items: cached.rows.map((row) => toMoodTrack(row, imageSets.get(row.id) ?? {})),
                    mood: moodParam,
                    page: {
                        limit,
                        hasMore: Boolean(cached.nextCursor),
                        ...(cached.nextCursor ? { nextCursor: cached.nextCursor } : {}),
                    },
                }),
                rl,
            );
        },
    },
});
