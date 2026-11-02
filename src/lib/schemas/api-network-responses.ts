// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Response schemas for the network measurement endpoints
 * (`POST /network/speed-test/results`, and the history strip that reads the same
 * rows back). Single source of truth per this codebase's Zod-schemas convention.
 *
 * Deliberately NARROWER than `SpeedTestRow`: `device_id`, `client_info` and the
 * raw per-bucket and per-request series stay server-side. Either series is a
 * fingerprint of the subject's line, and the caller already has its own copy —
 * it just sent it. The per-request AGGREGATES (count, worst TTFB, worst request)
 * do go out: they are what makes a cadence result readable.
 */

import { z } from 'zod';
import { speedTestModeSchema, type SpeedTestMode } from './playback.js';

/**
 * The stored-row fields {@link toSpeedTestResponse} reads.
 *
 * Declared HERE rather than imported from the query layer because nothing under
 * `src/lib/schemas/**` may reach into `$lib/server/**` — these modules are
 * client-reachable. The dependency is inverted instead: `SpeedTestRow` in
 * `network-speed-tests.queries.ts` EXTENDS this interface, so the two shapes
 * cannot drift apart without a type error.
 */
export interface StoredSpeedTestFields {
    id: number;
    mode: SpeedTestMode;
    bytes_received: number;
    duration_ms: number;
    ttfb_ms: number;
    throughput_bps: number;
    min_bucket_bps: number | null;
    stall_ms: number;
    request_count: number | null;
    max_ttfb_ms: number | null;
    min_request_bps: number | null;
    aborted: boolean;
    created_at: Date;
}

export const SpeedTestResultResponseSchema = z
    .object({
        id: z.number().describe('Row id (network_speed_tests.id)'),
        mode: speedTestModeSchema.describe(
            'Which shape of test produced this row: `single` (16 MiB), `long` (64 MiB, 60 s cap) or `cadence` (8 sequential 4 MiB fetches 2 s apart)',
        ),
        throughputBps: z
            .number()
            .describe(
                'Bits per second over the transfer window (TTFB excluded). For `cadence` the denominator is the SUM of the per-request transfer windows, so the deliberate pauses are excluded',
            ),
        ttfbMs: z.number().describe('Time to first byte the client measured'),
        minBucketBps: z
            .number()
            .nullable()
            .describe(
                'Slowest 250 ms bucket after the first, in bits per second — null with fewer than two buckets',
            ),
        stallMs: z.number().describe('Total duration of buckets that carried zero bytes'),
        requestCount: z
            .number()
            .nullable()
            .describe('How many downloads the run made — 1 for `single`/`long`'),
        maxTtfbMs: z
            .number()
            .nullable()
            .describe('`cadence` only — the worst first byte across the run; null otherwise'),
        minRequestBps: z
            .number()
            .nullable()
            .describe(
                '`cadence` only — the slowest single request in bits per second; null otherwise',
            ),
        bytesReceived: z.number().describe('Bytes the client actually received'),
        durationMs: z.number().describe('Wall-clock duration the client measured'),
        aborted: z.boolean().describe('True when the client gave up before the payload completed'),
        createdAt: z.string().describe('ISO timestamp the measurement was stored'),
    })
    .meta({
        id: 'SpeedTestResult',
        description: 'One client-timed network speed measurement.',
    });

/** Most-recent-first history for one user. */
export const SpeedTestSummaryListSchema = z.array(SpeedTestResultResponseSchema);

export type SpeedTestResultResponse = z.infer<typeof SpeedTestResultResponseSchema>;

/** Project a stored row onto the wire shape. */
export function toSpeedTestResponse(row: StoredSpeedTestFields): SpeedTestResultResponse {
    return {
        id: row.id,
        mode: row.mode,
        throughputBps: row.throughput_bps,
        ttfbMs: row.ttfb_ms,
        minBucketBps: row.min_bucket_bps,
        stallMs: row.stall_ms,
        requestCount: row.request_count,
        maxTtfbMs: row.max_ttfb_ms,
        minRequestBps: row.min_request_bps,
        bytesReceived: row.bytes_received,
        durationMs: row.duration_ms,
        aborted: row.aborted,
        createdAt: row.created_at.toISOString(),
    };
}
