// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit coverage for the `getDb() -> null` branch of `enqueueUserPush`.
 *
 * `user-push-notifier.service.integration.test.ts` covers the gate against a
 * real Postgres connection end to end, but never exercises `getDb()` itself
 * returning null (the integration harness always points `DATABASE_URL` at a
 * live `lumastra_tests` database — see tests/integration/setup/vitest.setup.ts).
 * `getDb()` returning null is a real, reachable branch in production
 * (`DATABASE_URL` unset, or the lazy pool failing to establish — see
 * database/connection.ts), and `enqueueUserPush` must still honour its
 * "never throws" contract and simply skip the enqueue, exactly like the
 * FEATURE_PUSH_NOTIFICATIONS-off and no-active-token gates above it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/config.js', () => ({
    config: { FEATURE_PUSH_NOTIFICATIONS: true } as Record<string, unknown>,
}));

vi.mock('$lib/server/licensing/entitlements.js', () => ({
    getEffectiveEntitlements: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(),
}));

vi.mock('$lib/server/database/queries/user-push-outbox.queries.js', () => ({
    enqueuePushOutbox: vi.fn(),
}));

vi.mock('$lib/server/database/queries/user-push-tokens.queries.js', () => ({
    userHasActivePushToken: vi.fn(),
}));

import { getDb } from '$lib/server/database/connection.js';
import { getEffectiveEntitlements } from '$lib/server/licensing/entitlements.js';
import { enqueuePushOutbox } from '$lib/server/database/queries/user-push-outbox.queries.js';
import { userHasActivePushToken } from '$lib/server/database/queries/user-push-tokens.queries.js';
import { enqueueUserPush } from './user-push-notifier.service.js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000001');

describe('enqueueUserPush — getDb() branches', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getEffectiveEntitlements).mockResolvedValue({
            modules: new Set(['push']),
        } as never);
    });

    it('returns early — without ever reading a push token or writing the outbox — when getDb() returns null', async () => {
        vi.mocked(getDb).mockReturnValue(null);

        await expect(
            enqueueUserPush({
                userId: USER_ID,
                notificationId: 'nid-1',
                kind: 'library.new_episode',
            }),
        ).resolves.toBeUndefined();

        expect(userHasActivePushToken).not.toHaveBeenCalled();
        expect(enqueuePushOutbox).not.toHaveBeenCalled();
    });

    it('proceeds past the DB gate — and reaches the token check — when getDb() returns a connection', async () => {
        const fakeSql = { marker: 'fake-sql' } as never;
        vi.mocked(getDb).mockReturnValue(fakeSql);
        vi.mocked(userHasActivePushToken).mockResolvedValue(true);
        vi.mocked(enqueuePushOutbox).mockResolvedValue(true);

        await enqueueUserPush({
            userId: USER_ID,
            notificationId: 'nid-1',
            kind: 'library.new_episode',
        });

        expect(userHasActivePushToken).toHaveBeenCalledWith(fakeSql, USER_ID);
        expect(enqueuePushOutbox).toHaveBeenCalledWith(fakeSql, {
            userId: USER_ID,
            notificationId: 'nid-1',
            kind: 'library.new_episode',
        });
    });
});
