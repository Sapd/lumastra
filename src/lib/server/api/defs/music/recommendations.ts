// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/music/recommendations
 * Also published at POST /api/v1/music/recommendations (beta).
 *
 * Stateless: the client sends what it is playing and what it played, the
 * server answers what to play next. Replaces GET /music/queue and
 * GET /music/queue/bootstrap.
 *
 * - With `context.currentTrackId`: smart queue pick (sonic, metadata or
 *   popularity fallback) plus up to three alternatives.
 * - Without it, for a `mood` seed: cold start, the first track of a mood radio.
 *   Rate limited per user (uncacheable full-library scan).
 *
 * Errors: unknown/inaccessible track → 404; a non-mood seed without a current
 * track → 422; DB down → 503 dependency_unavailable (never 200-empty).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getMoodBootstrapTrack,
    getTrackDetail,
    isMediaItemOfType,
} from '$lib/server/database/queries/music.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { checkRateLimit, withRateLimitHeaders } from '$lib/server/middleware/valkey-rate-limit.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toMusicTrack } from '$lib/server/services/music/track-projection.js';
import {
    recommendNext,
    type RecommendationSeed,
} from '$lib/server/services/music/recommendations.service.js';
import {
    MusicRecommendationsRequestSchema,
    MusicRecommendationsResponseSchema,
    type MusicRecommendationSeed,
} from '$lib/schemas/api-music-responses.js';

/**
 * Per-user rate limit for the cold-start path: the underlying query sorts by an
 * expression containing random() over non-indexable JSONB predicates plus a
 * per-row cosine — a sequential scan of the whole embedded music library. It is
 * uncacheable (mood is free-form) and nothing else throttles authenticated
 * /api/v1 traffic, so this path needs its own limiter.
 */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_S = 60;

/** Cold-start picks to try before answering 404 when each pick is inaccessible. */
const MOOD_BOOTSTRAP_ATTEMPTS = 3;

function toRetrievalSeed(
    seed: MusicRecommendationSeed | undefined,
): RecommendationSeed | undefined {
    if (!seed) return undefined;
    if (seed.type === 'artist') return { type: 'artist', artistId: seed.id };
    if (seed.type === 'album') return { type: 'album', albumId: seed.id };
    return seed;
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { body: MusicRecommendationsRequestSchema },
    docs: {
        POST: {
            tags: ['Music'],
            summary: 'Recommend the next track',
            stability: 'beta',
            auth: 'bearer',
            description: `Stateless radio / autoplay. Send the track that is playing now (\`context.currentTrackId\`) and what the listener already played, skipped or queued; the answer is the track to play next plus up to three alternatives to offer as "up next" choices. Call it again each time a track starts.

\`source\` says how the pick was made: \`sonic\` (audio embeddings), \`metadata\` (text embedding plus audio features), \`fallback\` (no embedding matched: popularity/genre pick) or \`mood\` (cold start).

Cold start: with a \`mood\` seed and no \`currentTrackId\`, \`next\` is the first track of a mood radio and \`alternatives\` is empty; mood keys come from \`GET /api/v1/music/moods\`. This path is rate limited to ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_S}s per user. A \`genre\`, \`artist\` or \`album\` seed needs a \`currentTrackId\` (start a track of that artist or album first) and otherwise answers 422.

What a seed does: on the sonic path (audio embeddings) only a \`mood\` seed reaches retrieval. An \`artist\`, \`album\` or \`genre\` seed only biases the metadata path; on every path any explicit seed switches off the same-genre listening-streak signal. Omit \`seed\` for ordinary autoplay: the pick already stays in-genre through the listening streak and the taste centroid over \`history\`/\`upcoming\`. \`next\` is absent when nothing fits.`,
            body: MusicRecommendationsRequestSchema,
            responses: {
                200: {
                    schema: MusicRecommendationsResponseSchema,
                    description: 'The next track, alternatives and how the pick was made',
                },
                401: 'Authentication required',
                404: 'Unknown or inaccessible track or seed id, or no track available for the mood',
                422: 'Invalid body, or a genre/artist/album seed without a current track',
                429: 'Rate limit exceeded (cold start)',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const body = ctx.input!.body;
            const context = body.context ?? {};
            const seed = body.seed;

            const trackId = context.currentTrackId;
            if (!trackId && seed?.type !== 'mood') {
                return ApiProblem.validationFailed([
                    {
                        field: 'context.currentTrackId',
                        message:
                            'currentTrackId is required unless the seed is a mood seed. For an artist, album or genre seed, start a track of it first and send that track as currentTrackId.',
                    },
                ]);
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // -----------------------------------------------------------------
            // Cold start: no current track, mood seed only
            // -----------------------------------------------------------------
            if (!trackId && seed?.type === 'mood') {
                // DB-availability is checked before the rate limit: a request
                // that can only 503 must not burn the caller's budget.
                const rl = await checkRateLimit(
                    `music:queue-bootstrap:${user.userId}`,
                    RATE_LIMIT_MAX,
                    RATE_LIMIT_WINDOW_S,
                );
                if (!rl.allowed) {
                    return withRateLimitHeaders(
                        ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000)),
                        rl,
                    );
                }

                // The mood query picks from the whole library (random() in the
                // score), so a pick the caller may not see is retried a few times.
                let row: Awaited<ReturnType<typeof getMoodBootstrapTrack>> = null;
                for (let attempt = 0; attempt < MOOD_BOOTSTRAP_ATTEMPTS; attempt++) {
                    const pick = await getMoodBootstrapTrack(sql, seed.mood, user.userId);
                    if (!pick) break;
                    if (await checkMediaAccess(sql, pick.id, user)) {
                        row = pick;
                        break;
                    }
                }
                if (!row) return ApiProblem.notFound('No tracks available for this mood');

                const imageSets = await resolveImageSets(sql, ctx.surface, [
                    { id: row.id, mediaType: 'track' },
                ]);
                return withRateLimitHeaders(
                    json({
                        next: toMusicTrack(row, imageSets.get(row.id) ?? {}),
                        alternatives: [],
                        source: 'mood',
                    }),
                    rl,
                );
            }

            // -----------------------------------------------------------------
            // Smart queue
            // -----------------------------------------------------------------
            if (!trackId) return ApiProblem.validationFailed('currentTrackId is required');

            if (seed?.type === 'artist' || seed?.type === 'album') {
                const label = seed.type === 'artist' ? 'Artist' : 'Album';
                if (
                    !(await checkMediaAccess(sql, seed.id, user)) ||
                    !(await isMediaItemOfType(sql, seed.id, seed.type))
                ) {
                    return ApiProblem.notFound(`${label} not found`);
                }
            }

            const currentTrack = await getTrackDetail(sql, trackId);
            if (!currentTrack) return ApiProblem.notFound('Track not found');
            if (!(await checkMediaAccess(sql, trackId, user))) {
                return ApiProblem.notFound('Track not found');
            }

            const result = await recommendNext(sql, user, ctx.surface, {
                currentTrack,
                exclude: context.exclude ?? [],
                history: context.history ?? [],
                skipped: context.skipped ?? [],
                upcoming: context.upcoming ?? [],
                seed: toRetrievalSeed(seed),
                crossfade: context.crossfade,
                startedBy: context.startedBy,
            });
            return json(result);
        },
    },
});
