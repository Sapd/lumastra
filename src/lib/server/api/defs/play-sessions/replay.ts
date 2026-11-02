// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { checkRateLimit, rateLimitHeaders } from '$lib/server/middleware/valkey-rate-limit.js';
import { processReplayBatch } from '$lib/server/services/music/play-end-batch.service.js';
import {
    ReplayRequestSchema,
    ReplayDocumentedRequestSchema,
    ReplayResponseSchema,
} from '$lib/schemas/play-session-replay.js';
const MUSIC_PLAY_END_MAX_BATCH = 100;

/**
 * Budget is counted in REQUESTS, not events. A client flushing a long
 * offline backlog should pay one unit per full batch, so the natural
 * behaviour (fill the batch) is also the cheap one — charging per event
 * would push clients toward many small requests, which is strictly worse
 * for the server.
 */
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_S = 3600;

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',

    docs: {
        POST: {
            tags: ['Play Sessions'],
            operationId: 'postPlaySessionsReplay',
            summary: 'Report a batch of track play ends',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Replay up to 100 completed music listens. Each item requires eventId (UUID), kind: music, mediaId, startedAt, positionMs, listenedMs and endReason; endedAt, durationMs, playContext and startReported (default false) are optional. A retry is duplicate and never increments counters. listenedMs is the terminal cumulative heard total for this separate replay protocol; zero never counts a play. A positive replay claims the same eventId as live/completion reporting; startReported is advisory, and the durable claim prevents double counting. positionMs and endedAt are advisory; endedAt bounds plausible listenedMs but is not persisted as the event end time. Starts may be at most 90 days old or 5 minutes in the future. Results contain an open reason string: invalid, too_old, too_far_future, not_found, write_failed, not_processed are well-known values. Use retryable for unknown reasons.',
            body: ReplayDocumentedRequestSchema,
            responses: {
                200: {
                    schema: ReplayResponseSchema,
                    description:
                        'Per-event outcomes; check each result rather than the status code',
                },
                401: 'Authentication required',
                422: 'Unusable envelope — not an object, `items` missing/empty, or over the cap',
                429: 'Rate limit exceeded',
                503: 'Database unavailable',
            },
        },
    },

    request: {
        body: ReplayRequestSchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            // `items` carries unknown items by design (see the schema's
            // comment): validating them here would let one bad event 422 the
            // whole flush.
            // mount() normally pre-validates; the manual branch is the
            // fallback for a caller that bypasses it, and must answer 422
            // rather than throwing into a 500.
            let body: { items: unknown[] };
            if (ctx.input?.body) {
                body = ctx.input.body;
            } else {
                try {
                    body = ReplayRequestSchema.parse(await event.request.json());
                } catch {
                    return problem('validation_failed', {
                        error: `Request body must be { items: [...] } with 1-${MUSIC_PLAY_END_MAX_BATCH} entries`,
                    });
                }
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            // DB-availability first, so a caller does not burn budget on
            // requests that could never have succeeded.
            const rl = await checkRateLimit(
                `play-sessions:replay:${user.userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000), {
                    headers: rateLimitHeaders(rl),
                });
            }

            const { results, summary } = await processReplayBatch(sql, user, body.items);

            const response = ReplayResponseSchema.safeParse({ results, summary });
            return json(response.success ? response.data : { results, summary }, {
                headers: rateLimitHeaders(rl),
            });
        },
    },
});
