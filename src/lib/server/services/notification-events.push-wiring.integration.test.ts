// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The wiring between `publishUserEvent` and the push outbox, end to end.
 *
 * This file exists because neither neighbouring suite can reach that branch:
 *
 *  - `notification-events.service.test.ts` mocks `insertNotification` to return
 *    `{ inserted: true, row: {} }`, so `notificationId` is always null there and
 *    the push call is UNREACHABLE, not merely uncovered.
 *  - `user-notifier.service.integration.test.ts` runs with
 *    `FEATURE_PUSH_NOTIFICATIONS` defaulted off.
 *
 * Three conditions on that branch therefore had zero coverage: a non-null
 * `notificationId`, `isUserId` holding, and the id actually matching a committed
 * `user_notifications` row. Typecheck can prove none of them, so a refactor that
 * left `notificationId` permanently null would silently disable push for
 * everyone with every other test still green.
 *
 * The load-bearing assertion is the LAST one in the happy-path case:
 * `user_push_outbox.notification_id` equals the id of the row that actually
 * landed in `user_notifications`. It closes all three conditions at once, and
 * catches an id that is merely non-null but wrong — which the FK would reject
 * anyway, but silently, as a caught-and-logged enqueue failure.
 *
 * Nothing in the notification path is mocked: the real `insertNotification`, the
 * real coalescing index, the real FK. Only the operator flag is, and it is
 * process-global rather than per-notification.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import type { UserId } from '$lib/shared/user-id';

const flags = vi.hoisted(() => ({ push: true }));

// A Proxy, not a spread: `config` is an object of getters that read
// ConfigService, and `{ ...actual.config }` would evaluate every one of them at
// mock time. See the same note in user-push-notifier.service.integration.test.ts.
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get: (target, prop, receiver) =>
                prop === 'FEATURE_PUSH_NOTIFICATIONS'
                    ? flags.push
                    : Reflect.get(target, prop, receiver),
        }),
    };
});

const { publishUserEvent, userEventsHub } = await import('./notification-events.service.js');
const { upsertPushToken } =
    await import('$lib/server/database/queries/user-push-tokens.queries.js');

const TABLES = [
    'user_push_outbox',
    'user_push_tokens',
    'user_devices',
    'user_notifications',
    'user_profiles',
    'users',
] as const;

describe('publishUserEvent → push outbox wiring (integration)', () => {
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
        flags.push = true;
        userEventsHub.consumers.clear();
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
    });

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    async function registerToken(owner: UserId): Promise<void> {
        const [device] = await sql<{ id: string }[]>`
            INSERT INTO user_devices (user_id, device_id, reported_name)
            VALUES (${owner}::uuid, ${`dev-${owner.slice(0, 8)}`}, 'iPhone')
            RETURNING id::text
        `;
        await upsertPushToken(sql, {
            userId: owner,
            deviceId: device.id,
            token: `tok-${owner.slice(0, 8)}`,
            bundleId: 'org.lumastra.app',
            environment: 'sandbox',
            locale: 'en-US',
            payloadVersion: 1,
        });
    }

    // Awaits and discards the persist outcome — these tests assert on what
    // reached the outbox, not on what the emitter reported.
    async function emitNewEpisode(coalesceKey = 'series:s1:s2'): Promise<void> {
        await publishUserEvent({
            userId,
            kind: 'library.new_episode',
            persist: true,
            data: { seriesId: '00000000-0000-0000-0000-0000000000aa', coalesceKey },
        });
    }

    async function notificationIds(): Promise<string[]> {
        const rows = await sql<{ id: string }[]>`
            SELECT id::text FROM user_notifications WHERE user_id = ${userId}::uuid
        `;
        return rows.map((r) => r.id);
    }

    async function outboxRows(): Promise<{ notification_id: string; kind: string }[]> {
        return sql<{ notification_id: string; kind: string }[]>`
            SELECT notification_id::text, kind FROM user_push_outbox
        `;
    }

    // ------------------------------------------------------------------
    // The wiring
    // ------------------------------------------------------------------

    it('enqueues a push row whose notification_id is the row that was just inserted', async () => {
        await registerToken(userId);

        await emitNewEpisode();

        const ids = await notificationIds();
        expect(ids).toHaveLength(1);

        const outbox = await outboxRows();
        expect(outbox).toHaveLength(1);
        expect(outbox[0].kind).toBe('library.new_episode');
        // The assertion this file exists for: the id handed to the outbox is the
        // id Postgres actually assigned, not null and not something else.
        expect(outbox[0].notification_id).toBe(ids[0]);
    });

    /**
     * The `'conflict'` gate, driven through the real coalescing index rather than
     * asserted about in isolation. The second emit finds the unique partial index
     * from 16.191.0 already holding the row, returns early, and must not add a
     * second lock-screen banner for the same season drop.
     */
    it('a coalesced duplicate emit adds no second push row', async () => {
        await registerToken(userId);

        await emitNewEpisode();
        await emitNewEpisode();

        expect(await notificationIds()).toHaveLength(1);
        expect(await outboxRows()).toHaveLength(1);
    });

    /**
     * The same race the sibling suite drives at the durable row, extended one
     * hop: two parallel shards, one row, and exactly one push.
     */
    it('two CONCURRENT emits for one coalesce key produce exactly one push row', async () => {
        await registerToken(userId);

        await Promise.all([emitNewEpisode(), emitNewEpisode()]);

        expect(await notificationIds()).toHaveLength(1);
        expect(await outboxRows()).toHaveLength(1);
    });

    it('still persists the notification when the user has no push token', async () => {
        await emitNewEpisode();

        // The durable row and the live frame are the product; push is a fan-out
        // on top of them and its absence must not disturb either.
        expect(await notificationIds()).toHaveLength(1);
        expect(await outboxRows()).toHaveLength(0);
    });

    it('writes no push row when the operator flag is off, but still persists', async () => {
        await registerToken(userId);
        flags.push = false;

        await emitNewEpisode();

        expect(await notificationIds()).toHaveLength(1);
        expect(await outboxRows()).toHaveLength(0);
    });

    it('writes no push row for a signal kind', async () => {
        await registerToken(userId);

        await publishUserEvent({
            userId,
            kind: 'session_changed',
            data: { sessionId: 'sess-1' },
        });

        expect(await notificationIds()).toHaveLength(0);
        expect(await outboxRows()).toHaveLength(0);
    });
});
