// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for `findEventsByItem` (Slice 2 — Per-Item Traceability).
 *
 * Verifies newest-first ordering, the limit clamp (default 50, max 200), and
 * item scoping (no cross-item bleed). Runs against the real `lumastra_tests`
 * Postgres.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    findEventsByItem,
    findAutoRequeuableDeadLetters,
    requeueDeadLetterEventsAuto,
    requeueAllDeadLetterEvents,
    countDeadLetterEvents,
} from './event-outbox.queries.js';

const ITEM_A = '00000000-0000-4000-a000-0000000000a1';
const ITEM_B = '00000000-0000-4000-a000-0000000000b1';

async function insertEvent(
    sql: postgres.Sql,
    mediaItemId: string,
    eventName: string,
): Promise<void> {
    await sql`
        INSERT INTO event_outbox (event_name, media_item_id, payload)
        VALUES (${eventName}, ${mediaItemId}::uuid, ${sql.json({ event: eventName })})
    `;
}

describe('findEventsByItem', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM event_outbox WHERE media_item_id IN (${ITEM_A}::uuid, ${ITEM_B}::uuid)`;
    });

    it('returns events newest-first (by id DESC)', async () => {
        await insertEvent(sql, ITEM_A, 'item.created');
        await insertEvent(sql, ITEM_A, 'file.attached');
        await insertEvent(sql, ITEM_A, 'metadata.changed');

        const rows = await findEventsByItem(sql, ITEM_A, 50);
        expect(rows.map((r) => r.event_name)).toEqual([
            'metadata.changed',
            'file.attached',
            'item.created',
        ]);
    });

    it('scopes strictly to the requested item (no cross-item bleed)', async () => {
        await insertEvent(sql, ITEM_A, 'item.created');
        await insertEvent(sql, ITEM_B, 'item.created');
        await insertEvent(sql, ITEM_B, 'file.attached');

        const rows = await findEventsByItem(sql, ITEM_A, 50);
        expect(rows).toHaveLength(1);
        expect(rows.every((r) => r.event_name === 'item.created')).toBe(true);
    });

    it('clamps the limit to a minimum of 1 and a maximum of 200', async () => {
        for (let i = 0; i < 5; i++) await insertEvent(sql, ITEM_A, `e.${i}`);

        // limit 2 → exactly 2 rows
        expect(await findEventsByItem(sql, ITEM_A, 2)).toHaveLength(2);
        // limit 0 → clamped to 1
        expect(await findEventsByItem(sql, ITEM_A, 0)).toHaveLength(1);
        // huge limit is accepted (clamped to 200, but only 5 exist)
        expect(await findEventsByItem(sql, ITEM_A, 10_000)).toHaveLength(5);
    });

    it('surfaces dead-letter / consumed / retry fields', async () => {
        await sql`
            INSERT INTO event_outbox (
                event_name, media_item_id, payload, attempts, dead_letter, last_error
            ) VALUES (
                'identity.assigned', ${ITEM_A}::uuid, ${sql.json({ event: 'identity.assigned' })},
                3, true, 'handler exploded'
            )
        `;
        const [row] = await findEventsByItem(sql, ITEM_A, 50);
        expect(row.dead_letter).toBe(true);
        expect(row.attempts).toBe(3);
        expect(row.last_error).toBe('handler exploded');
    });
});

describe('dead-letter requeue helpers', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM event_outbox WHERE media_item_id IN (${ITEM_A}::uuid, ${ITEM_B}::uuid)`;
    });

    /** Insert a dead-lettered row and return its id. */
    async function insertDeadLetter(
        mediaItemId: string,
        opts: { lastError?: string | null; autoRequeueCount?: number; attempts?: number } = {},
    ): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO event_outbox (
                event_name, media_item_id, payload, attempts, dead_letter, last_error,
                next_retry_at, auto_requeue_count
            ) VALUES (
                'file.probed', ${mediaItemId}::uuid, ${sql.json({ event: 'file.probed' })},
                ${opts.attempts ?? 8}, true, ${opts.lastError ?? 'write CONNECT_TIMEOUT ai-postgres:5432'},
                NULL, ${opts.autoRequeueCount ?? 0}
            )
            RETURNING id::text AS id
        `;
        return row.id;
    }

    it('findAutoRequeuableDeadLetters returns dead-letters under the budget, oldest-first', async () => {
        const id1 = await insertDeadLetter(ITEM_A, { autoRequeueCount: 0 });
        const id2 = await insertDeadLetter(ITEM_A, { autoRequeueCount: 2 });
        // Over budget (>= 5) — excluded.
        await insertDeadLetter(ITEM_A, { autoRequeueCount: 5 });

        const rows = await findAutoRequeuableDeadLetters(sql, 5, 200);
        const ours = rows.filter((r) => r.id === id1 || r.id === id2);
        expect(ours.map((r) => r.id)).toEqual([id1, id2]); // id ASC
        expect(rows.some((r) => r.auto_requeue_count >= 5)).toBe(false);
    });

    it('requeueDeadLetterEventsAuto clears dead_letter, resets fields, increments the budget counter', async () => {
        const id = await insertDeadLetter(ITEM_A, { autoRequeueCount: 1, attempts: 8 });

        const requeued = await requeueDeadLetterEventsAuto(sql, [id]);
        expect(requeued).toBe(1);

        const [row] = await sql<
            {
                dead_letter: boolean;
                attempts: number;
                last_error: string | null;
                next_retry_at: Date | null;
                auto_requeue_count: number;
            }[]
        >`SELECT dead_letter, attempts, last_error, next_retry_at, auto_requeue_count
            FROM event_outbox WHERE id = ${id}::bigint`;
        expect(row.dead_letter).toBe(false);
        expect(row.attempts).toBe(0);
        expect(row.last_error).toBeNull();
        expect(row.next_retry_at).toBeNull();
        expect(row.auto_requeue_count).toBe(2); // incremented 1 → 2
    });

    it('requeueDeadLetterEventsAuto only touches rows still dead-lettered (idempotent)', async () => {
        const id = await insertDeadLetter(ITEM_A);
        // First requeue flips it out of dead_letter; a second pass is a no-op.
        expect(await requeueDeadLetterEventsAuto(sql, [id])).toBe(1);
        expect(await requeueDeadLetterEventsAuto(sql, [id])).toBe(0);
    });

    it('requeueAllDeadLetterEvents requeues every dead-letter and resets the budget to 0', async () => {
        await insertDeadLetter(ITEM_A, { autoRequeueCount: 4 });
        await insertDeadLetter(ITEM_B, { autoRequeueCount: 5 }); // over auto budget, but manual ignores that
        const before = await countDeadLetterEvents(sql);
        expect(before).toBeGreaterThanOrEqual(2);

        const requeued = await requeueAllDeadLetterEvents(sql);
        expect(requeued).toBe(before);

        // Both of ours are now live again with a fresh budget.
        const rows = await sql<{ auto_requeue_count: number; dead_letter: boolean }[]>`
            SELECT auto_requeue_count, dead_letter FROM event_outbox
             WHERE media_item_id IN (${ITEM_A}::uuid, ${ITEM_B}::uuid)`;
        expect(rows.every((r) => !r.dead_letter)).toBe(true);
        expect(rows.every((r) => r.auto_requeue_count === 0)).toBe(true);
    });
});
