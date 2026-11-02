// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for MediaAddedNotifier — staging handler + flush loop.
 *
 * Three scenarios:
 *   1. Staging happens when outside the 48h initializing window.
 *   2. Staging is suppressed when inside the 48h initializing window.
 *   3. flushTick coalesces staged rows into one task_webhook_outbox row and
 *      deletes the media_added_pending rows.
 *
 * Runs against the real `lumastra_tests` Postgres.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { handleMediaBecamePlayable, MediaAddedNotifier } from './media-added-notifier.service.js';
import { insertPendingMediaAdded } from '$lib/server/database/queries/media-added-pending.queries.js';
import { WebhookOutbox } from '$lib/server/tasks/webhook-outbox.js';

// ── Unique suffix isolates this suite's rows from other concurrent tests ──────

const SUITE = `mab-${Date.now().toString(36)}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Insert a minimal library_groups + library_paths row so that
 * `isInitializingWindow` has a MIN(created_at) to evaluate against.
 *
 * @param ageDays  How many days in the past to back-date created_at.
 *                 Positive → older than now (outside the 48 h window when > 2).
 *                 0 → NOW() (inside the 48 h window).
 */
async function seedLibraryPath(
    sql: postgres.Sql,
    suffix: string,
    ageDays: number,
): Promise<{ groupId: string; pathId: string }> {
    const groupId = randomUUID();
    const pathId = randomUUID();

    await sql`
        INSERT INTO library_groups (id, name)
        VALUES (${groupId}::uuid, ${'mab-group-' + suffix})
    `;

    const createdAt = ageDays > 0 ? sql`NOW() - (${ageDays} * INTERVAL '1 day')` : sql`NOW()`;

    await sql`
        INSERT INTO library_paths (id, path, media_type, library_group_id, created_at)
        VALUES (
            ${pathId}::uuid,
            ${'/mab-test/' + suffix},
            'movie',
            ${groupId}::uuid,
            ${createdAt}
        )
    `;

    return { groupId, pathId };
}

/** Insert a minimal media_items movie row. Returns its UUID. */
async function seedMediaItem(
    sql: postgres.Sql,
    suffix: string,
    hasFiles: boolean,
): Promise<string> {
    const id = randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title, has_files)
        VALUES (${id}::uuid, 'movie', ${'mab-movie-' + suffix}, ${hasFiles})
    `;
    return id;
}

/**
 * Insert an active task_webhook_hooks row subscribed to
 * `org.lumastra.media.item.added` with no media-type or library-group filter.
 * Returns the hook id.
 */
async function seedWebhookHook(sql: postgres.Sql, suffix: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO task_webhook_hooks
            (url, secret_encrypted, event_filter, task_filter,
             library_group_filter, media_type_filter, headers,
             active, include_progress, created_by,
             batch_window_seconds, max_batch_size)
        VALUES (
            ${'https://example.com/webhook/' + suffix},
            ${Buffer.alloc(32, 0)},
            ${sql.json(['org.lumastra.media.item.added'])},
            NULL,
            NULL,
            NULL,
            NULL,
            true,
            false,
            ${'mab-test-' + suffix},
            0,
            100
        )
        RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('seedWebhookHook: no id returned');
    return id;
}

/** Minimal payload builder for handleMediaBecamePlayable. */
function becamePlayablePayload(mediaId: string): {
    event: 'media.becamePlayable';
    mediaId: string;
    mediaType: string;
} {
    return { event: 'media.becamePlayable', mediaId, mediaType: 'movie' };
}

// ── Suite-level cleanup IDs ───────────────────────────────────────────────────

const groupIds: string[] = [];
const pathIds: string[] = [];
const mediaItemIds: string[] = [];
const hookIds: string[] = [];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MediaAddedNotifier integration', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    // `isInitializingWindow` reads the GLOBAL MIN(library_paths.created_at), so a
    // stale old path seeded by an earlier test would defeat the suppression test's
    // NOW() path. Clear library_paths before each test so each one fully owns the
    // initializing-window state and the suite is order-independent.
    beforeEach(async () => {
        await sql`DELETE FROM library_paths`;
    });

    afterAll(async () => {
        // Clean up in dependency order: pending rows, outbox rows, media items,
        // hooks, library paths, library groups.
        if (mediaItemIds.length > 0) {
            await sql`
                DELETE FROM media_added_pending
                WHERE media_item_id = ANY(${mediaItemIds}::uuid[])
            `;
            await sql`
                DELETE FROM task_webhook_outbox
                WHERE hook_id = ANY(${hookIds}::uuid[])
            `;
            await sql`
                DELETE FROM media_items
                WHERE id = ANY(${mediaItemIds}::uuid[])
            `;
        }
        if (hookIds.length > 0) {
            await sql`DELETE FROM task_webhook_hooks WHERE id = ANY(${hookIds}::uuid[])`;
        }
        if (pathIds.length > 0) {
            await sql`DELETE FROM library_paths WHERE id = ANY(${pathIds}::uuid[])`;
        }
        if (groupIds.length > 0) {
            await sql`DELETE FROM library_groups WHERE id = ANY(${groupIds}::uuid[])`;
        }
        await closeTestDb();
    });

    // ── Test 1: Staging happens OUTSIDE the init window ──────────────────────

    it('stages a pending row when the library is older than 48h', async () => {
        const suffix = `${SUITE}-t1`;

        // library_path created 3 days ago → outside the 48h window
        const { groupId, pathId } = await seedLibraryPath(sql, suffix, 3);
        groupIds.push(groupId);
        pathIds.push(pathId);

        const hookId = await seedWebhookHook(sql, suffix);
        hookIds.push(hookId);

        // Seed item with has_files=false, then flip it to simulate
        // the has_files trigger payload.
        const mediaId = await seedMediaItem(sql, suffix, false);
        mediaItemIds.push(mediaId);

        await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaId}::uuid`;

        await handleMediaBecamePlayable(sql, becamePlayablePayload(mediaId));

        const rows = await sql<{ hook_id: string; media_item_id: string }[]>`
            SELECT hook_id::text, media_item_id::text
            FROM media_added_pending
            WHERE media_item_id = ${mediaId}::uuid
        `;

        expect(rows).toHaveLength(1);
        expect(rows[0]?.hook_id).toBe(hookId);
    });

    // ── Test 2: Staging suppressed INSIDE the init window ────────────────────

    it('suppresses staging when the library was created less than 48h ago', async () => {
        const suffix = `${SUITE}-t2`;

        // library_path created NOW → inside the 48h window
        const { groupId, pathId } = await seedLibraryPath(sql, suffix, 0);
        groupIds.push(groupId);
        pathIds.push(pathId);

        const hookId = await seedWebhookHook(sql, suffix);
        hookIds.push(hookId);

        const mediaId = await seedMediaItem(sql, suffix, false);
        mediaItemIds.push(mediaId);

        await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaId}::uuid`;

        await handleMediaBecamePlayable(sql, becamePlayablePayload(mediaId));

        const rows = await sql<{ media_item_id: string }[]>`
            SELECT media_item_id::text
            FROM media_added_pending
            WHERE media_item_id = ${mediaId}::uuid
        `;

        expect(rows).toHaveLength(0);
    });

    // ── Test 3: flushTick coalesces pending rows into outbox ─────────────────

    it('flushTick writes one outbox row and deletes pending rows for the hook', async () => {
        const suffix = `${SUITE}-t3`;

        // Use an old library path so isInitializingWindow returns false.
        const { groupId, pathId } = await seedLibraryPath(sql, suffix, 3);
        groupIds.push(groupId);
        pathIds.push(pathId);

        const hookId = await seedWebhookHook(sql, suffix);
        hookIds.push(hookId);

        const mediaId = await seedMediaItem(sql, suffix, true);
        mediaItemIds.push(mediaId);

        // Insert a pending row directly — equivalent to what staging would do.
        const pendingPayload = {
            mediaType: 'movie' as const,
            title: 'mab-movie-' + suffix,
            year: null,
            internalId: mediaId,
            externalIds: {},
            posterPath: `/api/media/${mediaId}/image/poster`,
            libraryGroupId: null,
        };
        await insertPendingMediaAdded(sql, {
            hookId,
            mediaItemId: mediaId,
            payload: pendingPayload,
        });

        // batch_window_seconds=0 (set in seedWebhookHook) means the row is
        // immediately due for flush.

        const outbox = new WebhookOutbox(sql);
        const notifier = new MediaAddedNotifier(sql, outbox, () => true);

        await notifier.flushTick();

        // One outbox row for the hook.
        const outboxRows = await sql<
            { hook_id: string; payload: { type: string; data: { items: unknown[] } } }[]
        >`
            SELECT hook_id::text,
                   payload
            FROM task_webhook_outbox
            WHERE hook_id = ${hookId}::uuid
        `;

        expect(outboxRows).toHaveLength(1);
        const outboxRow = outboxRows[0]!;
        expect(outboxRow.payload.type).toBe('org.lumastra.media.item.added');
        expect(outboxRow.payload.data.items).toHaveLength(1);

        // Pending row should have been deleted.
        const pendingRows = await sql<{ id: string }[]>`
            SELECT id FROM media_added_pending
            WHERE hook_id = ${hookId}::uuid
              AND media_item_id = ${mediaId}::uuid
        `;
        expect(pendingRows).toHaveLength(0);
    });
});
