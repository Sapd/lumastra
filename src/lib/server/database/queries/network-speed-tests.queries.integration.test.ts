// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for network-speed-tests.queries.ts against real Postgres.
 *
 * The def-level unit tests mock `insertSpeedTest` away, so nothing there ever
 * executes this module's SQL. That matters more than usual here:
 *
 *  - `${deviceId ?? null}` binds an explicit NULL rather than letting the column
 *    default apply — a bound NULL against a NOT NULL column has broken every
 *    write on main before, so the absent-optionals case is exercised explicitly.
 *  - `client_info`, `buckets` and `requests` are jsonb. A bare object would be
 *    sent as a Postgres record literal and a bare array of objects would not
 *    round-trip at all; only a real driver + real column proves `sql.json()` is
 *    right.
 *  - `mode` is `NOT NULL DEFAULT 'single'` and the cadence aggregates
 *    (`request_count`, `max_ttfb_ms`, `min_request_bps`, `gap_ms`) are nullable,
 *    so which mode fills which column is only provable against the real table.
 *  - `min_bucket_bps` is a nullable double, and `id` is a bigint that the
 *    connection's `types.bigint` override is supposed to hand back as a NUMBER.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    insertSpeedTest,
    listRecentSpeedTests,
    pruneSpeedTests,
    type SpeedTestRow,
} from './network-speed-tests.queries.js';
import type { SpeedTestResultInput } from '$lib/schemas/playback.js';
import type { SpeedTestSummary } from '$lib/server/services/network/speed-test-summary.js';

const USER_A = '00000000-0000-0000-0000-0000000a0001';
const USER_B = '00000000-0000-0000-0000-0000000a0002';

const RESULT: SpeedTestResultInput = {
    bytesRequested: 1_048_576,
    bytesReceived: 1_000_000,
    durationMs: 1500,
    ttfbMs: 500,
    aborted: false,
    mode: 'single',
    buckets: [
        { ms: 250, bytes: 100_000 },
        { ms: 250, bytes: 0 },
    ],
};

const SUMMARY: SpeedTestSummary = {
    throughputBps: 8_000_000,
    minBucketBps: 0,
    stallMs: 250,
    requestCount: 1,
    maxTtfbMs: null,
    minRequestBps: null,
    gapMs: null,
};

/** A cadence run (migration 16.249.0): no buckets, a per-request series instead. */
const CADENCE_RESULT: SpeedTestResultInput = {
    bytesRequested: 8 * 1024 * 1024,
    bytesReceived: 1_500_000,
    durationMs: 4_600,
    ttfbMs: 100,
    aborted: false,
    mode: 'cadence',
    buckets: [],
    requests: [
        { bytes: 1_000_000, ttfbMs: 100, durationMs: 1_100 },
        { bytes: 500_000, ttfbMs: 500, durationMs: 1_500 },
    ],
};

const CADENCE_SUMMARY: SpeedTestSummary = {
    throughputBps: 6_000_000,
    minBucketBps: null,
    stallMs: 0,
    requestCount: 2,
    maxTtfbMs: 500,
    minRequestBps: 4_000_000,
    gapMs: 2000,
};

describe('network-speed-tests.queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`DELETE FROM network_speed_tests WHERE user_id IN (${USER_A}::uuid, ${USER_B}::uuid)`;
        await sql`
            INSERT INTO users (id, username) VALUES
                (${USER_A}::uuid, 'test-speedtest-a'),
                (${USER_B}::uuid, 'test-speedtest-b')
            ON CONFLICT DO NOTHING
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM network_speed_tests WHERE user_id IN (${USER_A}::uuid, ${USER_B}::uuid)`;
        await sql`DELETE FROM users WHERE username LIKE 'test-speedtest-%'`;
        await closeTestDb();
    });

    it('inserts a full row and round-trips both jsonb columns', async () => {
        const row = await insertSpeedTest(sql, {
            userId: USER_A,
            deviceId: 'device-abc',
            clientInfo: { ua: 'vitest', conn: '4g' },
            result: RESULT,
            summary: SUMMARY,
        });

        // bigint identity column — the connection's types.bigint override must
        // hand this back as a JS number, not the string postgres.js defaults to.
        expect(typeof row.id).toBe('number');
        expect(row.id).toBeGreaterThan(0);
        expect(row.user_id).toBe(USER_A);
        expect(row.device_id).toBe('device-abc');
        // jsonb → object (not a string, which is what a non-sql.json() bind gives)
        expect(row.client_info).toEqual({ ua: 'vitest', conn: '4g' });
        expect(row.buckets).toEqual([
            { ms: 250, bytes: 100_000 },
            { ms: 250, bytes: 0 },
        ]);
        expect(row.mode).toBe('single');
        // A single run fills request_count only; the cadence aggregates stay NULL
        // so nothing reads a per-request number off a run that had one request.
        expect(row.request_count).toBe(1);
        expect(row.max_ttfb_ms).toBeNull();
        expect(row.min_request_bps).toBeNull();
        expect(row.gap_ms).toBeNull();
        expect(row.requests).toBeNull();
        expect(row.bytes_requested).toBe(1_048_576);
        expect(row.bytes_received).toBe(1_000_000);
        expect(row.duration_ms).toBe(1500);
        expect(row.ttfb_ms).toBe(500);
        expect(row.throughput_bps).toBe(8_000_000);
        expect(row.min_bucket_bps).toBe(0);
        expect(row.stall_ms).toBe(250);
        expect(row.aborted).toBe(false);
        expect(row.created_at).toBeInstanceOf(Date);

        // The jsonb really is jsonb, and really is the shape claimed above.
        const [typed] = await sql<{ ci: string; bk: string; n: number }[]>`
            SELECT jsonb_typeof(client_info) AS ci,
                   jsonb_typeof(buckets) AS bk,
                   jsonb_array_length(buckets)::int AS n
            FROM network_speed_tests WHERE id = ${row.id}
        `;
        expect(typed.ci).toBe('object');
        expect(typed.bk).toBe('array');
        expect(typed.n).toBe(2);
    });

    it('inserts with deviceId/clientInfo absent — the bound NULL is accepted', async () => {
        const row = await insertSpeedTest(sql, {
            userId: USER_A,
            result: { ...RESULT, aborted: true, buckets: [] },
            summary: {
                throughputBps: 1_000,
                minBucketBps: null,
                stallMs: 0,
                requestCount: 1,
                maxTtfbMs: null,
                minRequestBps: null,
                gapMs: null,
            },
        });

        expect(row.device_id).toBeNull();
        expect(row.client_info).toBeNull();
        expect(row.min_bucket_bps).toBeNull();
        expect(row.aborted).toBe(true);
        // `buckets` is NOT NULL DEFAULT '[]' — an empty array must store as an
        // empty jsonb array, not as NULL and not as the default by omission.
        expect(row.buckets).toEqual([]);
        expect(row.stall_ms).toBe(0);
    });

    it('stores a cadence run: mode, per-request aggregates and the jsonb series', async () => {
        const row = await insertSpeedTest(sql, {
            userId: USER_A,
            result: CADENCE_RESULT,
            summary: CADENCE_SUMMARY,
        });

        // The cleanup is in `finally` because the later listing/prune tests count
        // USER_A's rows: a failed assertion here must not leave this row behind
        // and turn one failure into four.
        try {
            expect(row.mode).toBe('cadence');
            expect(row.request_count).toBe(2);
            expect(row.max_ttfb_ms).toBe(500);
            expect(row.min_request_bps).toBe(4_000_000);
            expect(row.gap_ms).toBe(2000);
            // `requests` is jsonb: a bare array of objects would not round-trip,
            // so this is the only check that `sql.json()` is applied to it too.
            expect(row.requests).toEqual(CADENCE_RESULT.requests);
            // Cadence carries no bucket series, and the bucket-derived numbers
            // must be absent rather than zero-looking.
            expect(row.buckets).toEqual([]);
            expect(row.min_bucket_bps).toBeNull();
            expect(row.stall_ms).toBe(0);

            const [typed] = await sql<{ rq: string; n: number }[]>`
                SELECT jsonb_typeof(requests) AS rq, jsonb_array_length(requests)::int AS n
                FROM network_speed_tests WHERE id = ${row.id}
            `;
            expect(typed.rq).toBe('array');
            expect(typed.n).toBe(2);
        } finally {
            await sql`DELETE FROM network_speed_tests WHERE id = ${row.id}`;
        }
    });

    it('lists this user only, newest first, honouring the limit', async () => {
        await insertSpeedTest(sql, { userId: USER_B, result: RESULT, summary: SUMMARY });

        const mine = await listRecentSpeedTests(sql, USER_A);
        expect(mine.length).toBe(2); // the two rows inserted above, not USER_B's
        expect(mine.every((r: SpeedTestRow) => r.user_id === USER_A)).toBe(true);
        // Newest first.
        expect(mine[0].created_at.getTime()).toBeGreaterThanOrEqual(mine[1].created_at.getTime());

        const capped = await listRecentSpeedTests(sql, USER_A, 1);
        expect(capped.length).toBe(1);
        expect(capped[0].id).toBe(mine[0].id);
    });

    it('`since` filters by created_at, and an absent `since` is a no-op', async () => {
        // Backdate one of USER_A's rows well past any plausible `since`.
        const all = await listRecentSpeedTests(sql, USER_A);
        const oldest = all[all.length - 1];
        await sql`
            UPDATE network_speed_tests SET created_at = now() - interval '10 days'
            WHERE id = ${oldest.id}
        `;

        const recent = await listRecentSpeedTests(
            sql,
            USER_A,
            10,
            new Date(Date.now() - 24 * 60 * 60 * 1000),
        );
        expect(recent.map((r: SpeedTestRow) => r.id)).not.toContain(oldest.id);

        // Same call without `since` still returns everything — the
        // `(${x} IS NULL OR …)` branch must not filter when the bound value is NULL.
        const unbounded = await listRecentSpeedTests(sql, USER_A, 10);
        expect(unbounded.map((r: SpeedTestRow) => r.id)).toContain(oldest.id);
        expect(unbounded.length).toBeGreaterThan(recent.length);
    });

    it('prunes only rows older than the cutoff, and respects the batch size', async () => {
        const before = await listRecentSpeedTests(sql, USER_A, 100);
        const oldIds = before
            .filter((r: SpeedTestRow) => r.created_at.getTime() < Date.now() - 24 * 60 * 60 * 1000)
            .map((r: SpeedTestRow) => r.id);
        expect(oldIds.length).toBe(1); // the row backdated by the previous test

        // A batch of 0 must delete nothing — proves the LIMIT is really applied
        // and the subquery is not a full-table delete.
        const noop = await pruneSpeedTests(sql, new Date(), 0);
        expect(noop).toBe(0);

        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const deleted = await pruneSpeedTests(sql, cutoff, 1000);
        expect(deleted).toBe(1);

        const after = await listRecentSpeedTests(sql, USER_A, 100);
        expect(after.map((r: SpeedTestRow) => r.id)).not.toContain(oldIds[0]);
        expect(after.length).toBe(before.length - 1);

        // USER_B's recent row is untouched by a cutoff-scoped prune.
        expect((await listRecentSpeedTests(sql, USER_B, 100)).length).toBe(1);
    });
});
