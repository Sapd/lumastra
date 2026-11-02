// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Webhook Query Module
 *
 * Tests CRUD operations for task_webhook_hooks against a real PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    listWebhookHooks,
    getWebhookHookById,
    insertWebhookHook,
    updateWebhookHookWithSecret,
    updateWebhookHookWithoutSecret,
    deleteWebhookHook,
    type WebhookHookRow,
} from './webhook.queries.js';

describe('Webhook Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_webhook_hooks WHERE created_by LIKE 'test_webhook_%'`;
    });

    function makeCreatedBy(): string {
        return `test_webhook_${crypto.randomUUID()}`;
    }

    it('returns delivery state per hook, ignoring unattempted events and other hooks', async () => {
        const create = async () =>
            insertWebhookHook(sql, {
                id: crypto.randomUUID(),
                url: 'https://example.com/hook',
                secretEncrypted: Buffer.from('secret'),
                eventFilter: [],
                taskFilter: null,
                libraryGroupFilter: null,
                headers: null,
                active: true,
                includeProgress: false,
                createdBy: makeCreatedBy(),
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });
        const id = await create();
        const other = await create();
        const delivered = new Date('2026-01-01T00:00:00Z');
        await sql`
            INSERT INTO task_webhook_outbox (hook_id, event_id, payload, attempts,
                next_attempt_at, delivered_at, last_status, last_error, dead, created_at)
            VALUES
                (${id}::uuid, 'success', '{}'::jsonb, 0, NOW(), ${delivered}, 204, NULL, false, ${delivered}),
                (${id}::uuid, 'failed', '{}'::jsonb, 1, NOW(), NULL, 410, 'secret upstream body', true, ${new Date('2026-01-02')}),
                (${id}::uuid, 'pending', '{}'::jsonb, 0, NOW(), NULL, NULL, NULL, false, NOW()),
                (${other}::uuid, 'other', '{}'::jsonb, 1, NOW(), NULL, 500, 'other failure', true, NOW())
        `;
        for (const hook of [
            (await listWebhookHooks(sql)).find((h) => h.id === id),
            await getWebhookHookById(sql, id),
        ]) {
            expect(hook).toMatchObject({
                last_status: 410,
                last_error: 'secret upstream body',
                last_delivered_at: delivered,
                dead_count: 1,
            });
        }
        const fresh = await create();
        expect(await getWebhookHookById(sql, fresh)).toMatchObject({
            last_status: null,
            last_error: null,
            last_delivered_at: null,
            dead_count: 0,
        });
        // A successful retry clears a former error and becomes the last result.
        await sql`UPDATE task_webhook_outbox SET delivered_at = NOW(), last_status = 202,
            last_error = NULL, dead = false WHERE hook_id = ${id}::uuid AND event_id = 'failed'`;
        expect(await getWebhookHookById(sql, id)).toMatchObject({
            last_status: 202,
            last_error: null,
            dead_count: 0,
        });
    });

    it('clears retained dead deliveries after recovery and counts only subsequent failures', async () => {
        const id = await insertWebhookHook(sql, {
            id: crypto.randomUUID(),
            url: 'https://example.com/recovery',
            secretEncrypted: Buffer.from('secret'),
            eventFilter: [],
            taskFilter: null,
            libraryGroupFilter: null,
            headers: null,
            active: true,
            includeProgress: false,
            createdBy: makeCreatedBy(),
            mediaTypeFilter: null,
            batchWindowSeconds: 60,
            maxBatchSize: 25,
        });
        await sql`INSERT INTO task_webhook_outbox
            (hook_id, event_id, payload, next_attempt_at, attempts, last_status, last_error, dead, created_at)
            VALUES (${id}::uuid, 'retained-dead', '{}'::jsonb, NOW(), 8, 410, 'gone', true, '2026-01-01')`;
        await sql`INSERT INTO task_webhook_outbox
            (hook_id, event_id, payload, next_attempt_at, delivered_at, last_status, created_at)
            VALUES (${id}::uuid, 'recovered', '{}'::jsonb, NOW(), '2026-01-03', 204, '2026-01-02')`;
        for (const hook of [
            (await listWebhookHooks(sql)).find((h) => h.id === id),
            await getWebhookHookById(sql, id),
        ]) {
            expect(hook).toMatchObject({ last_status: 204, last_error: null, dead_count: 0 });
        }
        await sql`INSERT INTO task_webhook_outbox
            (hook_id, event_id, payload, next_attempt_at, attempts, last_status, last_error, dead, created_at)
            VALUES (${id}::uuid, 'new-dead', '{}'::jsonb, NOW(), 8, 500, 'down', true, '2026-01-04')`;
        for (const hook of [
            (await listWebhookHooks(sql)).find((h) => h.id === id),
            await getWebhookHookById(sql, id),
        ]) {
            expect(hook).toMatchObject({ last_status: 500, last_error: 'down', dead_count: 1 });
        }
    });

    it('orders an old event retry by its actual attempt time after a newer success', async () => {
        const id = await insertWebhookHook(sql, {
            id: crypto.randomUUID(),
            url: 'https://example.com/retry',
            secretEncrypted: Buffer.from('secret'),
            eventFilter: [],
            taskFilter: null,
            libraryGroupFilter: null,
            headers: null,
            active: true,
            includeProgress: false,
            createdBy: makeCreatedBy(),
            mediaTypeFilter: null,
            batchWindowSeconds: 60,
            maxBatchSize: 25,
        });
        await sql`INSERT INTO task_webhook_outbox
            (hook_id, event_id, payload, next_attempt_at, attempts, last_status, last_error, dead, created_at, last_attempt_at, delivered_at)
            VALUES (${id}::uuid, 'old-retry', '{}'::jsonb, NOW(), 8, 410, 'gone again', true, '2026-01-01', '2026-01-05', NULL),
                (${id}::uuid, 'new-success', '{}'::jsonb, NOW(), 0, 204, NULL, false, '2026-01-02', '2026-01-04', '2026-01-04')`;
        for (const hook of [
            (await listWebhookHooks(sql)).find((h) => h.id === id),
            await getWebhookHookById(sql, id),
        ]) {
            expect(hook).toMatchObject({
                last_status: 410,
                last_error: 'gone again',
                dead_count: 1,
            });
        }
        // A successful retry of an older event must likewise clear a newer dead event.
        await sql`UPDATE task_webhook_outbox SET delivered_at = '2026-01-06',
            last_attempt_at = '2026-01-06', last_status = 202, last_error = NULL, dead = false
            WHERE hook_id = ${id}::uuid AND event_id = 'new-success'`;
        expect(await getWebhookHookById(sql, id)).toMatchObject({
            last_status: 202,
            last_error: null,
            dead_count: 0,
        });
    });

    it('uses ordered indexes rather than sorting each hook outbox', async () => {
        await sql.begin(async (tx) => {
            await tx`SET LOCAL enable_seqscan = off`;
            const explain = ((strings: TemplateStringsArray, ...values: unknown[]) => {
                const parts = [...strings];
                if (parts[0].includes('SELECT h.*')) parts[0] = 'EXPLAIN (FORMAT JSON) ' + parts[0];
                return tx(Object.assign(parts, { raw: parts }), ...(values as never[]));
            }) as postgres.Sql;
            const plan = await getWebhookHookById(explain, crypto.randomUUID());
            const json = JSON.stringify(plan);
            expect(json).not.toContain('"Node Type":"Sort"');
            expect(json).not.toContain('"Node Type":"Incremental Sort"');
            expect(json).toContain('idx_webhook_outbox_latest_attempt');
            const indexes =
                await tx`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema()
                AND indexname = 'idx_webhook_outbox_hook_created'`;
            expect(indexes[0]?.indexdef).toContain('(hook_id, created_at DESC)');
        });
    });

    // ========================================================================
    // insertWebhookHook
    // ========================================================================

    describe('insertWebhookHook', () => {
        it('inserts and returns a UUID id', async () => {
            const id = await insertWebhookHook(sql, {
                id: crypto.randomUUID(),
                url: 'https://example.com/webhook',
                secretEncrypted: Buffer.from('test-secret'),
                eventFilter: ['task.started'],
                taskFilter: null,
                libraryGroupFilter: null,
                headers: null,
                active: true,
                includeProgress: false,
                createdBy: makeCreatedBy(),
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            expect(id).toBeTruthy();
            expect(typeof id).toBe('string');
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        });

        it('stores JSONB fields correctly', async () => {
            const createdBy = makeCreatedBy();
            const eventFilter = ['task.started', 'task.completed', 'task.failed'];
            const taskFilter = ['transcode', 'sync_images'];
            const libraryGroupFilter = ['movies', 'tv_shows', 'music'];
            const headers = {
                Authorization: 'Bearer token123',
                'X-Custom': 'value',
            };

            const id = await insertWebhookHook(sql, {
                id: crypto.randomUUID(),
                url: 'https://example.com/jsonb',
                secretEncrypted: Buffer.from('jsonb-secret'),
                eventFilter,
                taskFilter,
                libraryGroupFilter,
                headers,
                active: true,
                includeProgress: true,
                createdBy,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            const hooks = await listWebhookHooks(sql);
            const hook = hooks.find((h) => h.id === id);
            expect(hook).toBeDefined();
            expect(hook!.event_filter).toEqual(eventFilter);
            expect(hook!.task_filter).toEqual(taskFilter);
            expect(hook!.library_group_filter).toEqual(libraryGroupFilter);
            expect(hook!.headers).toEqual(headers);
        });
    });

    // ========================================================================
    // listWebhookHooks
    // ========================================================================

    describe('listWebhookHooks', () => {
        it('returns inserted hooks ordered by created_at DESC', async () => {
            const createdBy1 = makeCreatedBy();
            const createdBy2 = makeCreatedBy();
            const createdBy3 = makeCreatedBy();

            await insertWebhookHook(sql, {
                id: crypto.randomUUID(),
                url: 'https://example.com/hook1',
                secretEncrypted: Buffer.from('secret1'),
                eventFilter: [],
                taskFilter: null,
                libraryGroupFilter: null,
                headers: null,
                active: true,
                includeProgress: false,
                createdBy: createdBy1,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });
            await new Promise((r) => setTimeout(r, 20));
            await insertWebhookHook(sql, {
                id: crypto.randomUUID(),
                url: 'https://example.com/hook2',
                secretEncrypted: Buffer.from('secret2'),
                eventFilter: [],
                taskFilter: null,
                libraryGroupFilter: null,
                headers: null,
                active: true,
                includeProgress: false,
                createdBy: createdBy2,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });
            await new Promise((r) => setTimeout(r, 20));
            await insertWebhookHook(sql, {
                id: crypto.randomUUID(),
                url: 'https://example.com/hook3',
                secretEncrypted: Buffer.from('secret3'),
                eventFilter: [],
                taskFilter: null,
                libraryGroupFilter: null,
                headers: null,
                active: true,
                includeProgress: false,
                createdBy: createdBy3,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            const hooks = await listWebhookHooks(sql);
            const testHooks = hooks.filter(
                (h) =>
                    h.created_by === createdBy1 ||
                    h.created_by === createdBy2 ||
                    h.created_by === createdBy3,
            );

            expect(testHooks.length).toBe(3);
            expect(testHooks[0].created_by).toBe(createdBy3);
            expect(testHooks[1].created_by).toBe(createdBy2);
            expect(testHooks[2].created_by).toBe(createdBy1);
        });
    });

    // ========================================================================
    // updateWebhookHookWithSecret
    // ========================================================================

    describe('updateWebhookHookWithSecret', () => {
        it('updates all fields including secret_encrypted and returns the id', async () => {
            const createdBy = makeCreatedBy();
            const id = await insertWebhookHook(sql, {
                id: crypto.randomUUID(),
                url: 'https://old.example.com',
                secretEncrypted: Buffer.from('old-secret'),
                eventFilter: ['old.event'],
                taskFilter: ['oldtask'],
                libraryGroupFilter: ['oldlib'],
                headers: { 'X-Old': 'old' },
                active: false,
                includeProgress: false,
                createdBy,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            const updatedId = await updateWebhookHookWithSecret(sql, {
                id,
                url: 'https://new.example.com',
                secretEncrypted: Buffer.from('new-secret'),
                eventFilter: ['new.event'],
                taskFilter: ['newtask'],
                libraryGroupFilter: ['newlib'],
                headers: { 'X-New': 'new' },
                active: true,
                includeProgress: true,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            expect(updatedId).toBe(id);

            const hooks = await listWebhookHooks(sql);
            const hook = hooks.find((h) => h.id === id);
            expect(hook).toBeDefined();
            expect(hook!.url).toBe('https://new.example.com');
            expect(hook!.active).toBe(true);
            expect(hook!.include_progress).toBe(true);
            expect(hook!.event_filter).toEqual(['new.event']);
            expect(hook!.task_filter).toEqual(['newtask']);
            expect(hook!.library_group_filter).toEqual(['newlib']);
            expect(hook!.headers).toEqual({ 'X-New': 'new' });
            expect(hook!.secret_encrypted).toEqual(Buffer.from('new-secret'));
        });

        it('returns null for non-existent id', async () => {
            const result = await updateWebhookHookWithSecret(sql, {
                id: crypto.randomUUID(),
                url: 'https://example.com',
                secretEncrypted: Buffer.from('secret'),
                eventFilter: [],
                taskFilter: null,
                libraryGroupFilter: null,
                headers: null,
                active: true,
                includeProgress: false,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // updateWebhookHookWithoutSecret
    // ========================================================================

    describe('updateWebhookHookWithoutSecret', () => {
        it('updates fields without touching secret_encrypted', async () => {
            const createdBy = makeCreatedBy();
            const originalSecret = Buffer.from('original-secret');
            const id = await insertWebhookHook(sql, {
                id: crypto.randomUUID(),
                url: 'https://original.example.com',
                secretEncrypted: originalSecret,
                eventFilter: ['orig.event'],
                taskFilter: null,
                libraryGroupFilter: null,
                headers: null,
                active: true,
                includeProgress: false,
                createdBy,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            const updatedId = await updateWebhookHookWithoutSecret(sql, {
                id,
                url: 'https://updated.example.com',
                eventFilter: ['updated.event'],
                taskFilter: ['updatedtask'],
                libraryGroupFilter: ['updatedlib'],
                headers: { 'X-Updated': 'yes' },
                active: false,
                includeProgress: true,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            expect(updatedId).toBe(id);

            const rows = await sql<WebhookHookRow[]>`
                SELECT * FROM task_webhook_hooks WHERE id = ${id}::uuid
            `;
            expect(rows.length).toBe(1);
            expect(rows[0].url).toBe('https://updated.example.com');
            expect(rows[0].secret_encrypted).toEqual(originalSecret);
        });

        it('returns null for non-existent id', async () => {
            const result = await updateWebhookHookWithoutSecret(sql, {
                id: crypto.randomUUID(),
                url: 'https://example.com',
                eventFilter: [],
                taskFilter: null,
                libraryGroupFilter: null,
                headers: null,
                active: true,
                includeProgress: false,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // deleteWebhookHook
    // ========================================================================

    describe('deleteWebhookHook', () => {
        it('deletes and returns the deleted id', async () => {
            const createdBy = makeCreatedBy();
            const id = await insertWebhookHook(sql, {
                id: crypto.randomUUID(),
                url: 'https://delete.example.com',
                secretEncrypted: Buffer.from('delete-secret'),
                eventFilter: [],
                taskFilter: null,
                libraryGroupFilter: null,
                headers: null,
                active: true,
                includeProgress: false,
                createdBy,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            const deletedId = await deleteWebhookHook(sql, id);
            expect(deletedId).toBe(id);
        });

        it('returns null for non-existent id', async () => {
            const result = await deleteWebhookHook(sql, crypto.randomUUID());
            expect(result).toBeNull();
        });

        it('no longer includes the deleted hook in listWebhookHooks', async () => {
            const createdBy = makeCreatedBy();
            const id = await insertWebhookHook(sql, {
                id: crypto.randomUUID(),
                url: 'https://delete-list.example.com',
                secretEncrypted: Buffer.from('secret'),
                eventFilter: [],
                taskFilter: null,
                libraryGroupFilter: null,
                headers: null,
                active: true,
                includeProgress: false,
                createdBy,
                mediaTypeFilter: null,
                batchWindowSeconds: 60,
                maxBatchSize: 25,
            });

            const before = await listWebhookHooks(sql);
            expect(before.some((h) => h.id === id)).toBe(true);

            await deleteWebhookHook(sql, id);

            const after = await listWebhookHooks(sql);
            expect(after.some((h) => h.id === id)).toBe(false);
        });
    });
});
