// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/network/speed-test-results.ts — POST /network/speed-test/results
 *
 * Stores the timings a client measured for itself while downloading
 * `/network/speed-test`. The download endpoint records nothing, so this row is
 * the entire trace of a speed test.
 *
 * Three shapes arrive here, named by `mode`: `single` (16 MiB, the default and
 * what a pre-modes client posts), `long` (64 MiB over up to 60 s) and `cadence`
 * (8 sequential 4 MiB fetches 2 s apart). A cadence run carries a per-request
 * list instead of a bucket series, and the server summarises it over the summed
 * in-flight time so the deliberate pauses never read as stalls. The schema
 * enforces the pairing: `requests` is REQUIRED for cadence and REFUSED for the
 * one-shot modes, so a client cannot post a mode it did not actually run.
 *
 * The numbers are the CLIENT'S CLAIM, not a server observation: a caller can
 * post whatever it likes. That is acceptable because the row is scoped to the
 * caller's own user and is only ever read back as "what your client reported",
 * never as an authority on anything. What the server does own is the derived
 * maths — `summariseSpeedTest()` computes throughput/min-bucket/stall from the
 * raw counters here rather than trusting a client-supplied summary, so every
 * stored row is derived the same way.
 *
 * Rate-limited to 6 requests / 60 s per user, matching the download it reports
 * on.
 *
 * Auth: {kind:'user'} — any authenticated user.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { speedTestResultSchema } from '$lib/schemas/playback.js';
import {
    SpeedTestResultResponseSchema,
    toSpeedTestResponse,
} from '$lib/schemas/api-network-responses.js';
import { summariseSpeedTest } from '$lib/server/services/network/speed-test-summary.js';
import { insertSpeedTest } from '$lib/server/database/queries/network-speed-tests.queries.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';

const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_S = 60;

export const def = defineEndpoint({
    auth: { kind: 'user' },

    docs: {
        POST: {
            tags: ['Network'],
            summary: 'Store a client-timed speed-test result',
            stability: 'beta',
            description:
                'Records the timings the client measured while downloading `/network/speed-test`. ' +
                'Throughput, slowest-bucket/slowest-request and stall totals are derived server-side ' +
                'from the raw counters — a client-supplied summary is not accepted. `mode` defaults to ' +
                '`single`; `requests` is required when `mode` is `cadence` and rejected otherwise ' +
                '(`422`). For `cadence` the throughput denominator is the summed per-request transfer ' +
                'time, so the 2 s pauses are excluded. Rate-limited to 6 requests per 60 seconds per user.',
            body: speedTestResultSchema,
            responses: {
                201: {
                    schema: SpeedTestResultResponseSchema,
                    description: 'The stored measurement, with the derived numbers.',
                },
                401: 'Authentication required',
                422: 'Invalid result payload',
                429: 'Rate limit exceeded',
                503: 'Database unavailable',
            },
        },
    },

    request: {
        /**
         * POST body — speedTestResultSchema. Required: bytesRequested,
         * bytesReceived, durationMs, ttfbMs, buckets (max 240). Optional:
         * aborted (defaults false), mode (defaults 'single'), requests (max 64),
         * deviceId, clientInfo. Cross-field refinements reject
         * bytesReceived > bytesRequested, ttfbMs > durationMs, a cadence run
         * without `requests`, and `requests` on a single/long run.
         */
        body: speedTestResultSchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const rl = await checkRateLimit(
                `speedtest:post:${userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000));
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const result = ctx.input!.body;
            // The whole validated result, `mode` and `requests` included — the
            // summary branches on the mode rather than being told which maths to
            // use, so there is one place that decision can be made.
            const summary = summariseSpeedTest(result);

            const row = await insertSpeedTest(sql, {
                userId,
                deviceId: result.deviceId,
                clientInfo: result.clientInfo,
                result,
                summary,
            });

            return json(SpeedTestResultResponseSchema.parse(toSpeedTestResponse(row)), {
                status: 201,
            });
        },
    },
});
