// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { musicSearchRowToTrack } from '$lib/server/utils/music-track-mapper.js';

/**
 * defs/music/sonic-path.ts
 *
 * GET /api/music/path?from=<uuid>&to=<uuid>&steps=<n> — also published at
 * GET /api/v1/music/path (beta).
 *
 * Returns an ordered sonic bridge of N tracks interpolated between two seeds
 * in the MSCLAP-2023 audio-embedding space.
 *
 * Gating: features.sonicEmbeddings (FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS).
 * Auth:   any authenticated user.
 *
 * Response shape (bare object — not a paginated collection):
 *   { fromId, toId, stepCount, steps: SonicPathStep[] }
 *   Each step's track carries a canonical `images{}` href map (no flat coverArtUrl).
 *
 * Errors → application/problem+json.
 *   503 dependency_unavailable when the AI-DB is down (NEVER 200-empty).
 *   404 not_found when either seed track is not accessible to the caller.
 *   422 validation_failed when a seed has no embedding yet.
 *   429 rate_limited — this is uncached pgvector interpolation; capped at
 *       RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_S per user.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { checkRateLimit, withRateLimitHeaders } from '$lib/server/middleware/valkey-rate-limit.js';
import {
    buildSonicPath,
    SONIC_PATH_DEFAULT_STEPS,
    SONIC_PATH_MIN_STEPS,
    SONIC_PATH_MAX_STEPS,
    type SonicPathStep as QueryStep,
} from '$lib/server/database/queries/sonic-path.queries.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { Logger } from '$lib/server/utils/logger.js';
import { SonicPathResponseSchema } from '$lib/schemas/api-music-responses.js';

const logger = Logger.for('SonicPathDef');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const querySchema = z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    steps: z.coerce
        .number()
        .int()
        .min(SONIC_PATH_MIN_STEPS)
        .max(SONIC_PATH_MAX_STEPS)
        .optional()
        .default(SONIC_PATH_DEFAULT_STEPS),
});

/** Per-user rate limit: sonic-path is uncached pgvector interpolation. */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_S = 60;

// ---------------------------------------------------------------------------
// Row → track item transformer
// ---------------------------------------------------------------------------

function stepToItem(step: QueryStep, images: ImageSet) {
    return musicSearchRowToTrack(step, images);
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'sonicEmbeddings', then: { kind: 'user' } },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Build a sonic bridge between two tracks',
            stability: 'beta',
            auth: 'bearer',
            description: `Returns an ordered sequence of tracks interpolating between two seed tracks in MSCLAP audio-embedding space — a gradual transition rather than a similarity neighbourhood. Requires the sonicEmbeddings feature. Rate limited to ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_S} seconds per user.`,
            query: querySchema,
            responses: {
                200: { schema: SonicPathResponseSchema, description: 'Ordered sonic path' },
                401: 'Authentication required',
                404: 'Seed track not found, not accessible, or sonicEmbeddings disabled',
                429: 'Rate limit exceeded',
                503: 'Database unavailable',
            },
        },
    },

    request: {
        query: querySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            // DB-availability is checked before the rate limit: every request is
            // guaranteed to 503 while the DB is down, so checking the limit first
            // would burn an authenticated caller's Valkey rate-limit budget on
            // requests that can never succeed anyway.
            const rl = await checkRateLimit(
                `music:sonic-path:${user.userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return withRateLimitHeaders(
                    ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000)),
                    rl,
                );
            }

            const fromId = event.url.searchParams.get('from');
            const toId = event.url.searchParams.get('to');

            if (!fromId) {
                return ApiProblem.validationFailed([
                    { field: 'from', message: 'Missing required param: from' },
                ]);
            }
            if (!toId) {
                return ApiProblem.validationFailed([
                    { field: 'to', message: 'Missing required param: to' },
                ]);
            }
            if (fromId === toId) {
                return ApiProblem.validationFailed([
                    { field: 'to', message: 'from and to must differ' },
                ]);
            }

            const stepsParam = event.url.searchParams.get('steps');
            const steps = stepsParam
                ? Math.min(
                      Math.max(
                          parseInt(stepsParam, 10) || SONIC_PATH_DEFAULT_STEPS,
                          SONIC_PATH_MIN_STEPS,
                      ),
                      SONIC_PATH_MAX_STEPS,
                  )
                : SONIC_PATH_DEFAULT_STEPS;

            const [fromOk, toOk] = await Promise.all([
                checkMediaAccess(sql, fromId, user),
                checkMediaAccess(sql, toId, user),
            ]);
            if (!fromOk) return ApiProblem.notFound('Track (from) not found or not accessible');
            if (!toOk) return ApiProblem.notFound('Track (to) not found or not accessible');

            const accessCtx = await buildSearchAccessContext(sql, user);

            const { steps: bridgeSteps, missingEmbedding } = await buildSonicPath(
                sql,
                fromId,
                toId,
                steps,
                // Explicit projection onto the required-by-shape boundary. The
                // context was previously handed over whole and happened to be
                // structurally assignable to the old permissive pick — which is
                // exactly the silent-permissiveness the boundary type removes.
                searchAccessBoundary(accessCtx),
            );

            if (missingEmbedding === 'from') {
                return ApiProblem.validationFailed([
                    {
                        field: 'from',
                        message:
                            'The start track has no audio embedding. Generate sonic embeddings in Admin → Sonic Embeddings first.',
                    },
                ]);
            }
            if (missingEmbedding === 'to') {
                return ApiProblem.validationFailed([
                    {
                        field: 'to',
                        message:
                            'The end track has no audio embedding. Generate sonic embeddings in Admin → Sonic Embeddings first.',
                    },
                ]);
            }

            logger.debug('Sonic path built', {
                username: user.username,
                fromId,
                toId,
                requestedSteps: steps,
                actualSteps: bridgeSteps.length,
            });

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                bridgeSteps.map((row) => ({ id: row.media_id, mediaType: 'track' })),
            );
            return withRateLimitHeaders(
                json({
                    fromId,
                    toId,
                    stepCount: bridgeSteps.length,
                    steps: bridgeSteps.map((s) => ({
                        id: s.media_id,
                        step: s.step,
                        similarityScore: s.similarity_score,
                        track: stepToItem(s, imageSets.get(s.media_id) ?? {}),
                    })),
                }),
                rl,
            );
        },
    },
});
