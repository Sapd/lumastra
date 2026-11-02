// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/network/speed-test.ts — GET /network/speed-test
 *
 * Streams an incompressible payload of exactly `bytes` bytes so the CLIENT can
 * time its own download. The answer to "is my line or the server the problem?"
 * has to be measured from the client's side of the wire, which is why the
 * measurement lives here and not in a server-side metric.
 *
 * ## This endpoint records NOTHING
 *
 * No telemetry, no database write, not even a duration. A server-side timer
 * would measure the server's write to a socket buffer, not the user's line, so
 * recording one would only invite someone to trust the wrong number later. The
 * client posts its own timings to `/network/speed-test/results` instead, and
 * that is the sole trace a speed test leaves.
 *
 * `Cache-Control: no-store` and `X-Accel-Buffering: no` are both load-bearing: a
 * cached or proxy-buffered response measures the cache, not the network.
 *
 * ## Two rate limits, split by payload size
 *
 * A flat ceiling cannot serve both shapes of test. `cadence` makes 8 requests in
 * ~35 s, so a limit of 6 would cut a run off mid-flight; but raising the limit
 * to 40 at the 64 MiB size would licence 2.5 GiB of egress per user per minute.
 * So the bound is on the SIZE, not just the count:
 *
 *   - `bytes <= 4 MiB` (a cadence chunk) → `speedtest:get:small:<user>`, 40 / 60 s
 *   - anything larger (single 16 MiB, long 64 MiB) → `speedtest:get:large:<user>`, 6 / 60 s
 *
 * Worst case is therefore 40 x 4 MiB + 6 x 64 MiB = 544 MiB per user per minute,
 * and a caller cannot spend the generous budget on the expensive payload. A
 * hostile caller with a valid session can already stream video, so this is a
 * bound on accidental amplification rather than a security boundary.
 *
 * ## Why `Sec-Fetch-Site` is checked
 *
 * This is a GET that authenticates on ambient cookies, so without a check any
 * page on the internet could point an `<img>`/`fetch` at it and spend a
 * logged-in victim's rate limit — up to 544 MiB/min off their line, from their
 * own browser. `Sec-Fetch-Site` is set by the user agent and unsettable by page
 * script, so a `cross-site` value is conclusive and gets a 403. It is only
 * honoured when PRESENT: native clients (tvOS/iOS, curl) send no `Sec-Fetch-*`
 * at all, and an absent header must stay as good as same-origin or every native
 * speed test would 403.
 *
 * Auth: {kind:'user'} — any authenticated user.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { SPEED_TEST_CADENCE_CHUNK_BYTES, speedTestQuerySchema } from '$lib/schemas/playback.js';
import { speedTestStream } from '$lib/server/services/network/speed-test-payload.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';

/**
 * Largest payload that counts as "small" — one cadence chunk. A cadence run asks
 * for exactly this size 8 times, so the size test and the generous count belong
 * to the same profile by construction.
 */
const SMALL_REQUEST_MAX_BYTES = SPEED_TEST_CADENCE_CHUNK_BYTES;

const RATE_LIMIT_MAX_SMALL = 40;
const RATE_LIMIT_MAX_LARGE = 6;
const RATE_LIMIT_WINDOW_S = 60;

export const def = defineEndpoint({
    auth: { kind: 'user' },
    // The body is a raw byte stream, not JSON — nothing for the response
    // envelope/conformance layer to shape.
    raw: true,

    docs: {
        GET: {
            tags: ['Network'],
            summary: 'Download a network speed-test payload',
            stability: 'beta',
            description:
                'Streams an incompressible payload of exactly `bytes` bytes (1 MiB–64 MiB, default 16 MiB) ' +
                'for the client to time itself. The server records nothing about the transfer — post the ' +
                'measured result to `/network/speed-test/results` to store it. Uncacheable and unbuffered ' +
                'by design. Rate-limited per user and per payload size: 40 requests per 60 seconds for ' +
                '`bytes` up to 4 MiB (what a `cadence` run asks for, 8 times), 6 per 60 seconds for ' +
                'anything larger.',
            query: speedTestQuerySchema,
            responses: {
                200: {
                    binary: ['application/octet-stream'],
                    description: 'Incompressible test payload of exactly `bytes` bytes.',
                },
                401: 'Authentication required',
                403: 'Cross-site request (browser-reported `Sec-Fetch-Site: cross-site`)',
                422: 'Invalid `bytes` (outside the 1 MiB–64 MiB range)',
                429: 'Rate limit exceeded',
            },
        },
    },

    request: {
        /** `bytes` — coerced int, 1 MiB…64 MiB, defaulting to 16 MiB. */
        query: speedTestQuerySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            // See the module header: a cookie-authenticated GET that streams
            // 64 MiB is a cross-site weapon unless browser-initiated cross-site
            // requests are refused. Absent header = not a browser = allowed.
            if (event.request.headers.get('Sec-Fetch-Site') === 'cross-site') {
                return ApiProblem.forbidden('Cross-site speed tests are not allowed');
            }

            const { bytes } = ctx.input!.query;

            // Separate buckets, so a burst of cadence chunks cannot spend the
            // budget a 64 MiB download would need — and vice versa.
            const small = bytes <= SMALL_REQUEST_MAX_BYTES;
            const rl = await checkRateLimit(
                `speedtest:get:${small ? 'small' : 'large'}:${userId}`,
                small ? RATE_LIMIT_MAX_SMALL : RATE_LIMIT_MAX_LARGE,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000));
            }

            // The request signal closes the stream when the client gives up, so
            // an abandoned 64 MiB download stops generating bytes immediately
            // instead of filling a socket nobody is reading.
            return new Response(speedTestStream(bytes, event.request.signal), {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': String(bytes),
                    'Cache-Control': 'no-store',
                    'X-Accel-Buffering': 'no',
                },
            });
        },
    },
});
