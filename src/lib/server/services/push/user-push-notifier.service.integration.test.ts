// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the push ENQUEUE gate against the real test DB.
 *
 * The gate is the whole subject: `enqueueUserPush` writes at most one
 * `user_push_outbox` row, and only when the feature flag, the `push` licence
 * module, a pushable kind and an active device token all hold. Everything below
 * the licence boundary is real — `user_push_outbox.notification_id` carries a
 * `UNIQUE` constraint AND an FK to `user_notifications`, so idempotence and the
 * never-throws contract are proved against the actual schema rather than a stub.
 *
 * Only two things are mocked, and both are process-global rather than
 * per-notification: the operator feature flag and the licence entitlements.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { LicenseModule } from '$lib/server/licensing/entitlements.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import type { UserId } from '$lib/shared/user-id';

/**
 * The operator kill switch, readable per-test.
 *
 * Mutable rather than hard-coded `true`: a Proxy that always answers `true`
 * makes the flag check in the service untestable — delete the `if` and every
 * assertion still passes. `flags.push` is what the flag-off case flips.
 */
const flags = vi.hoisted(() => ({ push: true }));

/**
 * Override exactly one flag through a Proxy rather than spreading `config`.
 *
 * `config` is an object of GETTERS that read ConfigService; `{ ...actual.config }`
 * would evaluate every one of them at mock time — hundreds of unrelated reads,
 * any of which could throw or cache a value before the harness has finished
 * booting. The Proxy leaves the rest of the object untouched and lazy.
 */
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

const entitlements = vi.hoisted(() => ({
    modules: new Set<string>(['push']),
}));

vi.mock('$lib/server/licensing/entitlements.js', () => ({
    getEffectiveEntitlements: async () => entitlements,
}));

const { enqueueUserPush, isPushNotificationKind } = await import('./user-push-notifier.service.js');
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

describe('enqueueUserPush (integration)', () => {
    let sql: postgres.Sql;
    let userA: UserId;
    let nid: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TABLES);
        flags.push = true;
        entitlements.modules = new Set(['push']);
        userA = generateTestUserId();
        await ensureTestUser(sql, userA);
        nid = await makeNotification(userA);
    });

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /**
     * A real `user_notifications` row. The outbox FKs this column, so a
     * synthetic UUID would make every "writes one row" assertion fail for the
     * wrong reason — and would hide the FK from the suite entirely.
     */
    async function makeNotification(userId: UserId): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO user_notifications (user_id, kind, payload)
            VALUES (${userId}::uuid, 'library.new_episode', ${sql.json({ seriesId: 's1' })})
            RETURNING id::text
        `;
        return row.id;
    }

    /** An active APNs token for `userId`, hung off a real `user_devices` row. */
    async function registerToken(userId: UserId): Promise<void> {
        const [device] = await sql<{ id: string }[]>`
            INSERT INTO user_devices (user_id, device_id, reported_name)
            VALUES (${userId}::uuid, ${`dev-${userId.slice(0, 8)}`}, 'iPhone')
            RETURNING id::text
        `;
        await upsertPushToken(sql, {
            userId,
            deviceId: device.id,
            token: `tok-${userId.slice(0, 8)}`,
            bundleId: 'org.lumastra.app',
            environment: 'sandbox',
            locale: 'en-US',
            payloadVersion: 1,
        });
    }

    async function countOutboxRows(): Promise<number> {
        const [row] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM user_push_outbox
        `;
        return row.n;
    }

    // ------------------------------------------------------------------
    // The gate
    // ------------------------------------------------------------------

    it('writes one row when the flag, entitlement and a token are all present', async () => {
        await registerToken(userA);
        await enqueueUserPush({ userId: userA, notificationId: nid, kind: 'library.new_episode' });
        expect(await countOutboxRows()).toBe(1);
    });

    it('writes nothing when the user has no active token', async () => {
        await enqueueUserPush({ userId: userA, notificationId: nid, kind: 'library.new_episode' });
        expect(await countOutboxRows()).toBe(0);
    });

    it('writes nothing when the operator feature flag is off', async () => {
        await registerToken(userA);
        flags.push = false;
        await enqueueUserPush({ userId: userA, notificationId: nid, kind: 'library.new_episode' });
        expect(await countOutboxRows()).toBe(0);
    });

    it('writes nothing when the push entitlement is absent', async () => {
        await registerToken(userA);
        entitlements.modules = new Set([]);
        await enqueueUserPush({ userId: userA, notificationId: nid, kind: 'library.new_episode' });
        expect(await countOutboxRows()).toBe(0);
    });

    it('writes nothing for a signal kind', async () => {
        await registerToken(userA);
        await enqueueUserPush({ userId: userA, notificationId: nid, kind: 'session_changed' });
        expect(await countOutboxRows()).toBe(0);
    });

    it('is idempotent for the same notification', async () => {
        await registerToken(userA);
        const opts = { userId: userA, notificationId: nid, kind: 'library.new_episode' };
        await enqueueUserPush(opts);
        await enqueueUserPush(opts);
        expect(await countOutboxRows()).toBe(1);
    });

    /**
     * The never-throws contract, driven by a DB error rather than by taking the
     * DB away: an unknown `notificationId` violates the outbox's FK, so the
     * INSERT genuinely raises inside `enqueuePushOutbox`. `publishUserEvent`
     * calls this outside a try/catch while an emitter may be inside the pipeline
     * dispatcher's transaction, so an escaping rejection would fail an event
     * whose durable row and live frame have already landed.
     */
    it('never throws when the enqueue itself fails', async () => {
        await registerToken(userA);
        await expect(
            enqueueUserPush({
                userId: userA,
                notificationId: '00000000-0000-0000-0000-0000000000ff',
                kind: 'library.new_episode',
            }),
        ).resolves.toBeUndefined();
        expect(await countOutboxRows()).toBe(0);
    });

    // ------------------------------------------------------------------
    // Kind classification
    // ------------------------------------------------------------------

    it('classifies only the durable notification kinds as pushable', () => {
        expect(isPushNotificationKind('library.new_episode')).toBe(true);
        expect(isPushNotificationKind('request.available')).toBe(true);
        expect(isPushNotificationKind('session_changed')).toBe(false);
        expect(isPushNotificationKind('device.state')).toBe(false);
    });
});

// Type-only assertion: the entitlement string the service gates on is a real
// `LicenseModule`, so renaming the module in entitlements.ts breaks the build
// here rather than silently disabling push at runtime.
const _pushModule: LicenseModule = 'push';
void _pushModule;
