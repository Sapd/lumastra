// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F15 / F22 / F45 — File scanner creates media items without
 * stage coverage.
 *
 * Original finding: resolveOrCreateMediaItem(), findOrCreateSeriesHierarchy(),
 * and processAudioFile() insert new media_items rows but never called
 * afterCreated(). No item.created event was emitted and
 * StageStateService.seedRowsForCreate() was never invoked, so coverage relied
 * entirely on the stage-sweep self-heal phase (50 items / 60s tick).
 *
 * Fix (F45): migration 16.31.0 adds an AFTER INSERT trigger on media_items that
 * emits item.created into event_outbox — gated by the event_outbox feature
 * flag, exactly like every other pipeline trigger. This makes coverage
 * impossible to forget: ANY media_items INSERT (scanner, admin tooling, a code
 * path nobody has written yet) durably enqueues item.created. The dispatcher
 * then seeds stage coverage from the live registry (F22), which a SQL trigger
 * cannot do because stage applicability lives in TypeScript.
 *
 * This test asserts the durable, registry-independent guarantee the trigger
 * provides: a bare INSERT emits item.created in the same transaction.
 *
 * Citations: migrations/16.31.0_media_items_created_trigger.ts,
 *            services/pipeline-event-dispatcher.service.ts (handleRow seed),
 *            services/media-lifecycle.service.ts:509
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.runIf(RUN)('F15/F22/F45 — media_items INSERT emits item.created via DB trigger', () => {
    let sql: postgres.Sql;
    let cleanupIds: string[] = [];
    let priorFlag: string | null = null;

    beforeAll(async () => {
        sql = getTestDb();
        try {
            await sql`SELECT 1 FROM media_items LIMIT 0`;
            await sql`SELECT 1 FROM event_outbox LIMIT 0`;
            await sql`SELECT 1 FROM feature_flags LIMIT 0`;
        } catch {
            throw new Error('Required tables missing — run db:test:migrate first');
        }
        // The trigger is gated by the event_outbox feature flag. Remember
        // the prior value and force it on for the duration of this suite.
        const rows = await sql<{ value: string }[]>`
                SELECT value FROM feature_flags WHERE key = 'event_outbox_enabled'
            `;
        priorFlag = rows[0]?.value ?? null;
        await sql`
                INSERT INTO feature_flags (key, value)
                VALUES ('event_outbox_enabled', 'on')
                ON CONFLICT (key) DO UPDATE SET value = 'on'
            `;
    });

    afterAll(async () => {
        // Restore the flag to its prior value so the suite leaves no trace.
        if (priorFlag === null) {
            await sql`DELETE FROM feature_flags WHERE key = 'event_outbox_enabled'`;
        } else {
            await sql`
                    UPDATE feature_flags SET value = ${priorFlag}
                    WHERE key = 'event_outbox_enabled'
                `;
        }
        await closeTestDb();
    });

    beforeEach(async () => {
        if (cleanupIds.length > 0) {
            await sql`DELETE FROM event_outbox WHERE media_item_id = ANY(${cleanupIds}::uuid[])`;
            await sql`DELETE FROM media_item_stage_state WHERE media_item_id = ANY(${cleanupIds}::uuid[])`;
            await sql`DELETE FROM external_ids WHERE media_id = ANY(${cleanupIds}::uuid[])`;
            await sql`DELETE FROM media_items WHERE id = ANY(${cleanupIds}::uuid[])`;
            cleanupIds = [];
        }
    });

    it('a bare media_items INSERT emits an item.created outbox event', async () => {
        // This is exactly what the scanner's resolveOrCreateMediaItem /
        // findOrCreateSeriesHierarchy / processAudioFile do: a direct
        // INSERT into media_items with no app-side afterCreated() call.
        const mediaId = crypto.randomUUID();
        cleanupIds.push(mediaId);
        await sql`
                INSERT INTO media_items (id, media_type, title)
                VALUES (${mediaId}, 'movie', 'Repro Movie')
            `;

        const events = await sql<{ event_name: string; payload: unknown }[]>`
                SELECT event_name, payload FROM event_outbox
                WHERE media_item_id = ${mediaId} AND event_name = 'item.created'
            `;

        // The DB trigger fires in the same transaction as the INSERT, so
        // coverage is impossible to forget regardless of which code path
        // performed the insert.
        expect(events.length).toBe(1);
        expect((events[0].payload as { event: string }).event).toBe('item.created');
    });

    it('a soft-dismissed media_items INSERT does NOT emit item.created', async () => {
        // A soft-dismissed item must not re-enter the pipeline on INSERT.
        const mediaId = crypto.randomUUID();
        cleanupIds.push(mediaId);
        await sql`
                INSERT INTO media_items (id, media_type, title, is_dismissed)
                VALUES (${mediaId}, 'movie', 'Dismissed Repro Movie', true)
            `;

        const events = await sql`
                SELECT 1 FROM event_outbox
                WHERE media_item_id = ${mediaId} AND event_name = 'item.created'
            `;
        expect(events.length).toBe(0);
    });

    it('item.created emission is suppressed when the outbox flag is off', async () => {
        // Mirror the gate every pipeline trigger respects: when the
        // feature flag is off, emit_pipeline_event no-ops, so the trigger
        // writes nothing. (The app-side afterCreated() hook seeds coverage
        // synchronously on that code path instead.)
        await sql`
                UPDATE feature_flags SET value = 'off'
                WHERE key = 'event_outbox_enabled'
            `;
        try {
            const mediaId = crypto.randomUUID();
            cleanupIds.push(mediaId);
            await sql`
                    INSERT INTO media_items (id, media_type, title)
                    VALUES (${mediaId}, 'movie', 'Flag Off Repro Movie')
                `;
            const events = await sql`
                    SELECT 1 FROM event_outbox
                    WHERE media_item_id = ${mediaId} AND event_name = 'item.created'
                `;
            expect(events.length).toBe(0);
        } finally {
            await sql`
                    UPDATE feature_flags SET value = 'on'
                    WHERE key = 'event_outbox_enabled'
                `;
        }
    });
});
