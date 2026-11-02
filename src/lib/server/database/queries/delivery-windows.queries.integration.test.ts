// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for delivery-windows.queries.ts against real Postgres.
 *
 * Two things here exist only at the driver + real-column level:
 *
 *  - Every metadata field is read through a REGEX-GUARDED cast. `metadata` is
 *    client-controlled jsonb, so one row with `bytes: 'undefined'` — or with an
 *    object, which `->>` renders as JSON text — would make a bare
 *    `::double precision` raise 22P02 and abort the WHOLE select, 500ing the
 *    incident drawer for every incident on that session. A mock cannot raise
 *    22P02; only real Postgres can prove the guard is what stands in between.
 *  - The ordering is a subquery: newest `limit` rows by `recorded_at DESC`,
 *    RETURNED oldest → newest. A single `ORDER BY recorded_at ASC LIMIT n` would
 *    silently hand back the n OLDEST windows of a long session instead, which no
 *    unit test of the SQL string would notice.
 *
 * Run: npm run test:integration src/lib/server/database/queries/delivery-windows.queries.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
    createAndInsertTestMovie,
} from '../../../../../tests/integration/fixtures/index.js';
import { listDeliveryWindows } from './delivery-windows.queries.js';

const DEVICE_ID = 'delivery_windows_device';

describe('delivery-windows.queries', () => {
    let sql: postgres.Sql;
    let userId: string;
    let playSessionId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    /**
     * `playback_telemetry.play_session_id` FKs to `play_sessions(id)`, which in
     * turn requires a real `media_items` row — build the full chain so the
     * telemetry insert below doesn't 23503 against an orphan session id.
     */
    async function seedPlaySession(): Promise<void> {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        await sql`
            INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (
                ${playSessionId}::uuid,
                ${mediaId}::uuid,
                ${userId}::uuid,
                ${DEVICE_ID},
                '0.0.0.0'::inet,
                'direct'
            )
        `;
    }

    beforeEach(async () => {
        userId = generateTestUserId('delivery_windows_user');
        playSessionId = randomUUID();
        await sql`TRUNCATE TABLE playback_telemetry, play_sessions RESTART IDENTITY CASCADE`;
        await ensureTestUser(sql, userId);
        await seedPlaySession();
    });

    /** One `delivery_window` row at `secondsAgo` before now. */
    async function seed(
        secondsAgo: number,
        throughputBps: number,
        metadata: Record<string, unknown>,
    ): Promise<void> {
        await sql`
            INSERT INTO playback_telemetry (
                play_session_id, user_id, source, metric_type, value, metadata, recorded_at
            ) VALUES (
                ${playSessionId}::uuid,
                ${userId}::uuid,
                'client',
                'delivery_window',
                ${throughputBps},
                ${sql.json(metadata as unknown as postgres.JSONValue)},
                now() - (${secondsAgo}::text || ' seconds')::interval
            )
        `;
    }

    it('reads a plain decimal and rejects anything else as null, without throwing', async () => {
        await seed(60, 20_000_000, {
            bytes: '7340032',
            segments: '4',
            mediaSec: '24.0',
            minSegBps: '1500000.5',
            engine: 'hls_js',
        });
        // The 22P02 payloads: free text, an empty string, a comma decimal, and an
        // object (which `->>` hands back as the JSON text `{"delta":2}`).
        await seed(30, 18_000_000, {
            bytes: 'undefined',
            segments: '',
            mediaSec: '24,0',
            overdue: { delta: 2 },
            engine: '',
        });

        const rows = await listDeliveryWindows(sql, playSessionId);

        expect(rows.length).toBe(2);
        const [older, newer] = rows;

        expect(older.bytes).toBe(7_340_032);
        expect(older.segments).toBe(4);
        expect(older.mediaSec).toBe(24);
        expect(older.minSegBps).toBe(1_500_000.5);
        expect(older.engine).toBe('hls_js');

        // Non-numeric reads as UNKNOWN, never as 0 — a window that delivered 0
        // bytes is a very different claim from one whose client did not say.
        expect(newer.bytes).toBeNull();
        expect(newer.segments).toBeNull();
        expect(newer.mediaSec).toBeNull();
        expect(newer.overdue).toBeNull();
        // NULLIF('') on engine, so an empty string is unknown too.
        expect(newer.engine).toBeNull();
        // `value` is a real double column, so the headline is never guessed away.
        expect(newer.throughputBps).toBe(18_000_000);
    });

    it('returns the NEWEST rows, ordered oldest → newest', async () => {
        // Five windows, one per minute. A limit of 3 must keep the three most
        // recent (180/120/60 s ago) and return them ascending.
        for (const ago of [300, 240, 180, 120, 60]) {
            await seed(ago, ago * 100_000, { bytes: String(ago) });
        }

        const rows = await listDeliveryWindows(sql, playSessionId, 3);

        expect(rows.map((r) => r.bytes)).toEqual([180, 120, 60]);
        const times = rows.map((r) => new Date(r.recordedAt).getTime());
        expect(times[0]).toBeLessThan(times[1]);
        expect(times[1]).toBeLessThan(times[2]);
        // recordedAt is serialised, not handed back as a Date.
        expect(typeof rows[0].recordedAt).toBe('string');
    });

    it('a non-uuid session id matches nothing instead of raising 22P02', async () => {
        await seed(60, 20_000_000, { bytes: '1' });

        // `playback_incident_events.play_session_id` is free text, so this really
        // does reach the query in production.
        await expect(listDeliveryWindows(sql, 'not-a-uuid')).resolves.toEqual([]);
        await expect(listDeliveryWindows(sql, '')).resolves.toEqual([]);
    });

    it('matches an UPPERCASE uuid — incident rows carry both cases', async () => {
        await seed(60, 20_000_000, { bytes: '1' });

        const rows = await listDeliveryWindows(sql, playSessionId.toUpperCase());
        expect(rows.length).toBe(1);
    });
});
