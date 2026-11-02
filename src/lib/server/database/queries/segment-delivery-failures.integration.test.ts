// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration coverage for segment-delivery-failures.queries.
 *
 * These exercise the three things that cannot be checked without a real
 * Postgres and would each silently break the feature:
 *
 *  1. The upsert's ON CONFLICT target must match the partial-expression unique
 *     index exactly, COALESCE included. If it does not, Postgres raises
 *     "no unique or exclusion constraint matching the ON CONFLICT
 *     specification" — at runtime, on the segment hot path.
 *  2. A NULL stream_variant must still aggregate. NULL never equals NULL in a
 *     unique index, so without the COALESCE every variant-less failure inserts
 *     a fresh row — the unbounded growth this table exists to avoid.
 *  3. The CASE-guarded join must tolerate a non-UUID play_session_id. A plain
 *     `col ~ pattern AND col::uuid = …` throws "invalid input syntax for type
 *     uuid" even with the regex ANDed in front, because Postgres does not
 *     guarantee short-circuit evaluation in a JOIN's ON clause — the exact
 *     trap playback-incident-events.queries.ts documents.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    recordSegmentDeliveryFailure,
    listSegmentDeliveryFailures,
    deleteSegmentDeliveryFailures,
    pruneSegmentDeliveryFailures,
} from './segment-delivery-failures.queries.js';
import type postgres from 'postgres';

const PSID = 'TEST-SEG-0001-0000-0000-000000000001';

describe('segment-delivery-failures.queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM segment_delivery_failures WHERE play_session_id LIKE 'TEST-SEG-%'`;
        await closeTestDb();
    });

    it('aggregates a repeated failure onto one row instead of inserting again', async () => {
        const input = {
            playSessionId: PSID,
            category: 'gone' as const,
            httpStatus: 404,
            resourceKind: 'segment' as const,
            streamVariant: 'video_0',
        };
        await recordSegmentDeliveryFailure(sql, input);
        await recordSegmentDeliveryFailure(sql, input);
        await recordSegmentDeliveryFailure(sql, input);

        const { rows, total } = await listSegmentDeliveryFailures(sql, {
            playSessionId: PSID,
            limit: 50,
            offset: 0,
        });

        expect(total).toBe(1);
        expect(rows[0].occurrences).toBe(3);
        // A retry storm must not move first_seen_at — it is what dates the onset.
        expect(rows[0].last_seen_at.getTime()).toBeGreaterThanOrEqual(
            rows[0].first_seen_at.getTime(),
        );
    });

    it('aggregates when stream_variant is NULL (the COALESCE in the index)', async () => {
        const input = {
            playSessionId: PSID,
            category: 'gone' as const,
            httpStatus: 404,
            resourceKind: 'master_playlist' as const,
            streamVariant: null,
        };
        await recordSegmentDeliveryFailure(sql, input);
        await recordSegmentDeliveryFailure(sql, input);

        const { rows } = await listSegmentDeliveryFailures(sql, {
            playSessionId: PSID,
            limit: 50,
            offset: 0,
        });
        const masterRow = rows.find((r) => r.resource_kind === 'master_playlist');
        expect(masterRow?.occurrences).toBe(2);
    });

    it('keeps distinct categories and statuses as separate rows', async () => {
        await recordSegmentDeliveryFailure(sql, {
            playSessionId: PSID,
            category: 'not_ready',
            httpStatus: 503,
            resourceKind: 'segment',
            streamVariant: 'video_0',
        });

        const { rows } = await listSegmentDeliveryFailures(sql, {
            playSessionId: PSID,
            limit: 50,
            offset: 0,
        });
        expect(rows.some((r) => r.category === 'not_ready' && r.http_status === 503)).toBe(true);
        expect(rows.some((r) => r.category === 'gone' && r.http_status === 404)).toBe(true);
    });

    it('matches a play session id case-insensitively', async () => {
        // The stored id keeps the native client's UPPERCASE spelling; an
        // operator pasting the lowercase id from play_sessions must still find it.
        const { total } = await listSegmentDeliveryFailures(sql, {
            playSessionId: PSID.toLowerCase(),
            limit: 50,
            offset: 0,
        });
        expect(total).toBeGreaterThan(0);
    });

    it('does not throw when a stored play_session_id is not a UUID', async () => {
        await recordSegmentDeliveryFailure(sql, {
            playSessionId: 'TEST-SEG-not-a-uuid',
            category: 'bad_request',
            httpStatus: 400,
            resourceKind: 'other',
            streamVariant: null,
        });

        // The guarded cast in the join must not attempt ::uuid on this row.
        await expect(
            listSegmentDeliveryFailures(sql, { limit: 50, offset: 0 }),
        ).resolves.toBeDefined();

        const { rows } = await listSegmentDeliveryFailures(sql, {
            playSessionId: 'TEST-SEG-not-a-uuid',
            limit: 50,
            offset: 0,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].user_id).toBeNull();
    });

    it('prunes by last_seen_at and clears by play session', async () => {
        const pruned = await pruneSegmentDeliveryFailures(sql, new Date(Date.now() + 60_000));
        expect(pruned).toBeGreaterThan(0);

        await recordSegmentDeliveryFailure(sql, {
            playSessionId: PSID,
            category: 'gone',
            httpStatus: 410,
            resourceKind: 'segment',
            streamVariant: 'audio_1',
        });
        const cleared = await deleteSegmentDeliveryFailures(sql, { playSessionId: PSID });
        expect(cleared).toBe(1);
    });

    it('clears only the rows matching category, not the whole table', async () => {
        const other = 'TEST-SEG-0001-0000-0000-000000000002';
        await recordSegmentDeliveryFailure(sql, {
            playSessionId: PSID,
            category: 'gone',
            httpStatus: 410,
            resourceKind: 'segment',
            streamVariant: 'audio_1',
        });
        await recordSegmentDeliveryFailure(sql, {
            playSessionId: other,
            category: 'server_error',
            httpStatus: 500,
            resourceKind: 'segment',
            streamVariant: 'audio_1',
        });

        const cleared = await deleteSegmentDeliveryFailures(sql, { category: 'server_error' });

        expect(cleared).toBeGreaterThanOrEqual(1);
        const { rows } = await listSegmentDeliveryFailures(sql, {
            playSessionId: PSID,
            limit: 50,
            offset: 0,
        });
        expect(rows).toHaveLength(1);
    });
});
