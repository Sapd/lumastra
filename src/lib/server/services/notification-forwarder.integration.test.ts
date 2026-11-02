// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `publishUserEvent` → operator webhooks subscribed to
 * `org.lumastra.user.notification`, end to end against the real outbox table.
 *
 * The two gates are the point of this file: a hook only receives forwarded
 * notifications when it NAMED the event (an empty filter means "everything"
 * for every other event and must not here), and only for users who switched
 * forwarding on.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import type { UserId } from '$lib/shared/user-id';

const { publishUserEvent, userEventsHub } = await import('./notification-events.service.js');
const { setNotificationForwarding, listUserNotificationForwardingHooks } =
    await import('$lib/server/database/queries/notification-forwarding.queries.js');
const { WebhookOutbox } = await import('$lib/server/tasks/webhook-outbox.js');

const TABLES = [
    'task_webhook_outbox',
    'task_webhook_hooks',
    'user_push_outbox',
    'user_notifications',
    'user_profiles',
    'users',
] as const;

const EVENT = 'org.lumastra.user.notification';

describe('notification forwarding to operator webhooks (integration)', () => {
    let sql: postgres.Sql;
    let userId: UserId;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TABLES);
        userEventsHub.consumers.clear();
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
    });

    async function insertHook(opts: {
        eventFilter: string[];
        active?: boolean;
        label?: string | null;
    }): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO task_webhook_hooks
                (url, secret_encrypted, event_filter, active, created_by, label)
            VALUES (
                'https://hooks.example.com/x',
                ${Buffer.from([1, 2, 3])},
                ${sql.json(opts.eventFilter)},
                ${opts.active ?? true},
                'test',
                ${opts.label ?? null}
            )
            RETURNING id::text
        `;
        return row.id;
    }

    async function emit(coalesceKey = 'series:s1:s2'): Promise<void> {
        await publishUserEvent({
            userId,
            kind: 'library.new_episode',
            persist: true,
            data: {
                seriesId: '00000000-0000-0000-0000-0000000000aa',
                mediaId: '00000000-0000-0000-0000-0000000000bb',
                seriesTitle: 'Starhaven',
                episodeTitle: 'Hello, Ms. Cobel',
                seasonNumber: 2,
                episodeNumber: 1,
                reason: 'following',
                coalesceKey,
            },
        });
    }

    async function outbox(): Promise<{ hook_id: string; event_id: string; payload: unknown }[]> {
        return sql<{ hook_id: string; event_id: string; payload: unknown }[]>`
            SELECT hook_id::text, event_id, payload FROM task_webhook_outbox
        `;
    }

    it('forwards nothing while the user has not opted in', async () => {
        await insertHook({ eventFilter: [EVENT] });
        await emit();
        expect(await outbox()).toHaveLength(0);
    });

    it('forwards one event per notification to the subscribed hook once opted in', async () => {
        const hookId = await insertHook({ eventFilter: [EVENT], label: 'Telegram' });
        await setNotificationForwarding(sql, userId, true);

        await emit();

        const [notification] = await sql<{ id: string }[]>`
            SELECT id::text FROM user_notifications WHERE user_id = ${userId}::uuid
        `;
        const rows = await outbox();
        expect(rows).toHaveLength(1);
        expect(rows[0].hook_id).toBe(hookId);
        expect(rows[0].event_id).toBe(`user.notification:${notification.id}`);

        const payload = rows[0].payload as {
            type: string;
            data: Record<string, unknown>;
        };
        expect(payload.type).toBe(EVENT);
        expect(payload.data.notificationId).toBe(notification.id);
        expect(payload.data.user).toEqual({
            id: userId,
            username: expect.any(String),
        });
        expect(payload.data.kind).toBe('library.new_episode');
        expect(payload.data.seriesTitle).toBe('Starhaven');
        expect(payload.data.seasonNumber).toBe(2);
        expect(payload.data.episodeNumber).toBe(1);
        expect(payload.data.reason).toBe('following');
        expect(payload.data.title).toBe('Starhaven — S02E01');
    });

    it('never treats an empty event filter ("everything") as a subscription', async () => {
        await insertHook({ eventFilter: [] });
        await insertHook({ eventFilter: ['org.lumastra.task.run.completed'] });
        await setNotificationForwarding(sql, userId, true);

        await emit();

        expect(await outbox()).toHaveLength(0);
    });

    it('skips inactive hooks and lists only active subscribed ones', async () => {
        await insertHook({ eventFilter: [EVENT], active: false, label: 'Old bot' });
        const live = await insertHook({ eventFilter: [EVENT], label: 'Telegram' });
        await setNotificationForwarding(sql, userId, true);

        await emit();

        const rows = await outbox();
        expect(rows.map((r) => r.hook_id)).toEqual([live]);
        expect((await listUserNotificationForwardingHooks(sql)).map((h) => h.label)).toEqual([
            'Telegram',
        ]);
    });

    it('a coalesced duplicate notification is not forwarded twice', async () => {
        await insertHook({ eventFilter: [EVENT] });
        await setNotificationForwarding(sql, userId, true);

        await emit();
        await emit();

        expect(await outbox()).toHaveLength(1);
    });

    it('a disabled account forwards nothing even with the flag left on', async () => {
        await insertHook({ eventFilter: [EVENT] });
        await setNotificationForwarding(sql, userId, true);
        await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${userId}::uuid`;

        await emit();

        expect(await outbox()).toHaveLength(0);
    });

    it('retires already-queued forwards when the user opts out — none is claimed', async () => {
        await insertHook({ eventFilter: [EVENT] });
        await setNotificationForwarding(sql, userId, true);
        await emit();
        expect(await outbox()).toHaveLength(1);

        await setNotificationForwarding(sql, userId, false);
        const result = await new WebhookOutbox(sql).deliveryPass();

        expect(result.delivered + result.failed).toBe(0);
        const [row] = await sql<{ dead: boolean; last_error: string | null }[]>`
            SELECT dead, last_error FROM task_webhook_outbox
        `;
        expect(row.dead).toBe(true);
        expect(row.last_error).toMatch(/^\[retired\] /);
    });

    it('does not forward admin broadcasts — the consent names episodes and requests only', async () => {
        await insertHook({ eventFilter: [EVENT] });
        await setNotificationForwarding(sql, userId, true);

        await publishUserEvent({
            userId,
            kind: 'admin.broadcast',
            persist: true,
            data: { title: 'Maintenance', body: 'Tonight 22:00' },
        });

        expect(await outbox()).toHaveLength(0);
    });
});
