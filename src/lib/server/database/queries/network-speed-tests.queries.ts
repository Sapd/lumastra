// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure SQL query module for `network_speed_tests` (migrations 16.248.0 + 16.249.0). No side
 * effects, no business logic — the derived numbers are computed by
 * `summariseSpeedTest()` in services/network/speed-test-summary.ts and handed in
 * already summarised, per this codebase's three-tier DB architecture.
 *
 * Every row here is a measurement the CLIENT timed: the download endpoint
 * records nothing, so this table is the only trace a speed test leaves.
 */

import type postgres from 'postgres';
import type { SpeedTestRequestInput, SpeedTestResultInput } from '$lib/schemas/playback.js';
import type { SpeedTestSummary } from '$lib/server/services/network/speed-test-summary.js';
import type { StoredSpeedTestFields } from '$lib/schemas/api-network-responses.js';

/**
 * One stored measurement, exactly as Postgres hands it back.
 *
 * Extends `StoredSpeedTestFields` (declared in `$lib/schemas`) so the columns
 * `toSpeedTestResponse()` projects onto the wire are type-linked to this row and
 * cannot drift — the schemas layer is client-reachable and must not import from
 * `$lib/server`, so the dependency runs this way round.
 */
export interface SpeedTestRow extends StoredSpeedTestFields {
    user_id: string | null;
    device_id: string | null;
    client_info: Record<string, string> | null;
    bytes_requested: number;
    buckets: { ms: number; bytes: number }[];
    /** Cadence only — the profile's nominal inter-request gap, written by the server. Not a pause the client observed or reported. */
    gap_ms: number | null;
    /** Cadence only — the per-request series. NULL for the one-shot modes. */
    requests: SpeedTestRequestInput[] | null;
}

/** What a completed measurement needs in order to be stored. */
export interface InsertSpeedTestInput {
    userId: string;
    deviceId?: string;
    clientInfo?: Record<string, string>;
    result: SpeedTestResultInput;
    summary: SpeedTestSummary;
}

/**
 * Store one measurement and return the stored row.
 *
 * `client_info`, `buckets` and `requests` are jsonb columns, so each goes
 * through `sql.json()` — a bare object would be sent as a Postgres record/array
 * literal and a bare array of objects would not round-trip at all. `requests` is
 * only present for a cadence run, and binds an explicit NULL otherwise rather
 * than an empty array, so "no per-request series" and "a run with no requests"
 * stay distinguishable at rest.
 */
export async function insertSpeedTest(
    sql: postgres.Sql,
    input: InsertSpeedTestInput,
): Promise<SpeedTestRow> {
    const { userId, deviceId, clientInfo, result, summary } = input;
    const requests = result.requests?.length ? result.requests : null;
    const [row] = await sql<SpeedTestRow[]>`
        INSERT INTO network_speed_tests (
            user_id, device_id, client_info, mode,
            bytes_requested, bytes_received, duration_ms, ttfb_ms,
            throughput_bps, min_bucket_bps, stall_ms, aborted, buckets,
            request_count, max_ttfb_ms, min_request_bps, gap_ms, requests
        ) VALUES (
            ${userId}::uuid, ${deviceId ?? null},
            ${clientInfo ? sql.json(clientInfo) : null},
            ${result.mode},
            ${result.bytesRequested}, ${result.bytesReceived},
            ${result.durationMs}, ${result.ttfbMs},
            ${summary.throughputBps}, ${summary.minBucketBps}, ${summary.stallMs},
            ${result.aborted}, ${sql.json(result.buckets)},
            ${summary.requestCount}, ${summary.maxTtfbMs},
            ${summary.minRequestBps}, ${summary.gapMs},
            ${requests ? sql.json(requests) : null}
        )
        RETURNING id, user_id, device_id, client_info, mode,
                  bytes_requested, bytes_received, duration_ms, ttfb_ms,
                  throughput_bps, min_bucket_bps, stall_ms, aborted, buckets,
                  request_count, max_ttfb_ms, min_request_bps, gap_ms, requests,
                  created_at
    `;
    return row;
}

/**
 * This user's most recent measurements, newest first — backs the user-facing
 * history strip. Served by the `(user_id, created_at DESC)` index.
 *
 * `since` is optional: absent means "no lower bound", expressed with the
 * `(${x} IS NULL OR col >= ${x})` idiom already used across this query layer so
 * one statement covers both shapes.
 */
export async function listRecentSpeedTests(
    sql: postgres.Sql,
    userId: string,
    limit = 10,
    since?: Date,
): Promise<SpeedTestRow[]> {
    return sql<SpeedTestRow[]>`
        SELECT id, user_id, device_id, client_info, mode,
               bytes_requested, bytes_received, duration_ms, ttfb_ms,
               throughput_bps, min_bucket_bps, stall_ms, aborted, buckets,
               request_count, max_ttfb_ms, min_request_bps, gap_ms, requests,
               created_at
        FROM network_speed_tests
        WHERE user_id = ${userId}::uuid
          AND (${since ?? null}::timestamptz IS NULL OR created_at >= ${since ?? null}::timestamptz)
        ORDER BY created_at DESC
        LIMIT ${limit}
    `;
}

/**
 * LIMIT-batched retention delete, driven by the telemetry service's
 * `deleteInBatches` loop. Mirrors `prunePlaybackIncidentEvents`: keeps the lock
 * window short so a long-overdue first run cannot stall writes.
 */
export async function pruneSpeedTests(
    sql: postgres.Sql,
    olderThan: Date,
    batch: number,
): Promise<number> {
    const result = await sql`
        DELETE FROM network_speed_tests
        WHERE id IN (
            SELECT id FROM network_speed_tests
            WHERE created_at < ${olderThan}
            LIMIT ${batch}
        )
    `;
    return result.count;
}
