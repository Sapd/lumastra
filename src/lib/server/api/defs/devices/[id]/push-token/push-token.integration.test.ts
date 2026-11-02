// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for PUT/DELETE /devices/{id}/push-token against a real
 * Postgres database.
 *
 * push-token.defs.test.ts mocks `getDeviceIdForSession`, `getUserDeviceByDeviceId`,
 * `upsertPushToken` and `getDb`, and compares against a mock uuid constant on
 * both sides of the write. That mocked shape is exactly what let a real bug
 * ship: `getDeviceIdForSession()` returns `oauth_refresh_tokens.device_id`
 * (client-generated TEXT), while `user_push_tokens.device_id` is
 * `uuid REFERENCES user_devices(id)`. Every real call would have failed on the
 * cast — fixed in 77fb0655c, but nothing mounted this def against Postgres, so
 * the cast itself was never exercised end to end.
 *
 * This suite mounts the real def via `mount()` (same as the unit test) but
 * does NOT mock `getDb()` or the query modules — `getDb()` returns the app's
 * real connection pool, which the integration Vitest config already points at
 * `lumastra_tests` (see vitest.integration.config.ts). `$lib/server/config.js`
 * is still mocked, purely to flip `FEATURE_DEVICE_AUTH` on deterministically —
 * it carries no database configuration.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../tests/integration/setup/test-database.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config.js')>()),
    config: { FEATURE_DEVICE_AUTH: true } as Record<string, unknown>,
    features: {} as Record<string, unknown>,
}));

// auditLog spy — a bare `vi.fn()` that REPLACES the real implementation
// entirely (it does not call through), same pattern as
// plugins/external-install/install.integration.test.ts, so the C4 tests can
// assert the def's own emit decision (call count + args) without also
// exercising the real logger line or the best-effort `audit_log` DB write.
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});

import { mount } from '$lib/server/api/mount.js';
import { def } from './index.js';
import { auditLog } from '$lib/server/utils/audit-log.js';
import type postgres from 'postgres';

let sql: postgres.Sql;

const CTX = { surface: 'v1' as const };
const USERNAME_PREFIX = 'itest_pushtoken';

interface TestPrincipal {
    userId: UserId;
    username: string;
    deviceSessionId: string;
    deviceKey: string;
    deviceUuid: string;
}

async function insertUser(suffix: string): Promise<{ id: UserId; username: string }> {
    const username = `${USERNAME_PREFIX}_${suffix}`;
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username) VALUES (${username}) RETURNING id
    `;
    return { id: toUserId(row.id), username };
}

/** Creates a user with a live device session — mirrors a real signed-in phone. */
async function makePrincipal(suffix: string): Promise<TestPrincipal> {
    const { id: userId, username } = await insertUser(suffix);
    const deviceKey = `itest-device-${suffix}`;
    const deviceSessionId = `itest-session-${suffix}`;

    const [device] = await sql<{ id: string }[]>`
        INSERT INTO user_devices (user_id, device_id, reported_name)
        VALUES (${userId}, ${deviceKey}, 'Integration Test Device')
        RETURNING id
    `;

    await sql`
        INSERT INTO oauth_refresh_tokens (
            user_id, client_id, token_hash, device_id, device_session_id,
            created_at, expires_at
        ) VALUES (
            ${userId}, 'itest-client', ${`itest-hash-${suffix}`}, ${deviceKey},
            ${deviceSessionId}, NOW(), NOW() + INTERVAL '30 days'
        )
    `;

    return { userId, username, deviceSessionId, deviceKey, deviceUuid: device.id };
}

function makeEvent(principal: {
    userId: UserId;
    username: string;
    deviceSessionId: string;
    method?: string;
    rawBody?: string | null;
}): RequestEvent {
    const user = {
        userId: principal.userId,
        username: principal.username,
        groups: '',
        userGroups: [] as string[],
        hasWatchPermission: false,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        isAdmin: false,
        isModerator: false,
        maxAgeRating: null as null | number,
        isAgeRestricted: false,
        liveTvPriority: 'low' as const,
    };

    const url = `http://localhost/api/v1/devices/${principal.deviceSessionId}/push-token`;
    const bodyStr = principal.rawBody ?? null;

    return {
        url: new URL(url),
        request: new Request(url, {
            method: principal.method ?? 'PUT',
            body: bodyStr,
            headers: bodyStr ? { 'content-type': 'application/json' } : undefined,
        }),
        params: { id: principal.deviceSessionId },
        route: { id: '/api/v1/devices/[id]/push-token' as const },
        locals: { user },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const VALID_BODY = {
    token: 'b'.repeat(64),
    bundleId: 'de.hinterthaner.stellar-tvos.ios',
    environment: 'production' as const,
    locale: 'de-DE',
    payloadVersion: 1,
};

async function bodyOf<T = Record<string, unknown>>(res: Response): Promise<T> {
    return (await res.clone().json()) as T;
}

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    vi.mocked(auditLog).mockClear();
    await sql`
        DELETE FROM oauth_refresh_tokens
        WHERE user_id IN (SELECT id FROM users WHERE username LIKE ${USERNAME_PREFIX + '_%'})
    `;
    await sql`
        DELETE FROM user_push_tokens
        WHERE user_id IN (SELECT id FROM users WHERE username LIKE ${USERNAME_PREFIX + '_%'})
    `;
    await sql`
        DELETE FROM user_devices
        WHERE user_id IN (SELECT id FROM users WHERE username LIKE ${USERNAME_PREFIX + '_%'})
    `;
    await sql`DELETE FROM users WHERE username LIKE ${USERNAME_PREFIX + '_%'}`;
});

describe('push-token def against a real database', () => {
    it('PUT writes a row keyed by the user_devices uuid, not the client-generated device id', async () => {
        const alice = await makePrincipal('put-a');

        const { PUT } = mount(def, CTX);
        const res = await PUT!(makeEvent({ ...alice, rawBody: JSON.stringify(VALID_BODY) }));

        expect(res.status).toBe(200);
        const body = await bodyOf<{ deviceId: string; registered: boolean }>(res);
        expect(body.registered).toBe(true);
        // Response keeps the client-facing id, NOT the internal uuid.
        expect(body.deviceId).toBe(alice.deviceKey);

        const rows = await sql<{ device_id: string; user_id: string; token: string }[]>`
            SELECT device_id, user_id, token FROM user_push_tokens
            WHERE token = ${VALID_BODY.token}
        `;
        expect(rows).toHaveLength(1);
        // This is the assertion the mocked def test could never make: a real
        // uuid-typed column actually holding the user_devices.id uuid, reached
        // through the real Postgres cast — not the client text key and not the
        // device session id.
        expect(rows[0].device_id).toBe(alice.deviceUuid);
        expect(rows[0].device_id).not.toBe(alice.deviceKey);
        expect(rows[0].device_id).not.toBe(alice.deviceSessionId);
        expect(rows[0].user_id).toBe(alice.userId);
    });

    it('DELETE removes the row written by PUT', async () => {
        const bob = await makePrincipal('delete-a');

        const { PUT, DELETE } = mount(def, CTX);
        const putRes = await PUT!(makeEvent({ ...bob, rawBody: JSON.stringify(VALID_BODY) }));
        expect(putRes.status).toBe(200);

        const before = await sql`
            SELECT 1 FROM user_push_tokens WHERE device_id = ${bob.deviceUuid}
        `;
        expect(before).toHaveLength(1);

        const delRes = await DELETE!(makeEvent({ ...bob, method: 'DELETE', rawBody: null }));
        expect(delRes.status).toBe(200);
        const delBody = await bodyOf<{ registered: boolean }>(delRes);
        expect(delBody.registered).toBe(false);

        const after = await sql`
            SELECT 1 FROM user_push_tokens WHERE device_id = ${bob.deviceUuid}
        `;
        expect(after).toHaveLength(0);
    });

    it('a device session belonging to another user returns 404, not the owner-only conflict', async () => {
        const owner = await makePrincipal('owner');
        const intruder = await makePrincipal('intruder');

        const { PUT } = mount(def, CTX);
        // intruder's identity, but owner's deviceSessionId in the path.
        const res = await PUT!(
            makeEvent({
                userId: intruder.userId,
                username: intruder.username,
                deviceSessionId: owner.deviceSessionId,
                rawBody: JSON.stringify(VALID_BODY),
            }),
        );

        expect(res.status).toBe(404);
        const body = await bodyOf<{ code: string; error: string }>(res);
        expect(body.code).toBe('not_found');
        expect(body.error).toBe('Device session not found');

        const rows = await sql`
            SELECT 1 FROM user_push_tokens WHERE token = ${VALID_BODY.token}
        `;
        expect(rows).toHaveLength(0);
    });

    // C4 (security review 6): last-registrant-wins is the documented design
    // (`2026-08-11-apns-push-design.md:157-161,792-793,819-822`) and is NOT
    // refused here — only audited.
    describe('C4 — audits a cross-user rebind', () => {
        it('emits exactly one push_token.rebind event, with the previous owner and its active state', async () => {
            const alice = await makePrincipal('rebind-a');
            const bob = await makePrincipal('rebind-b');

            const { PUT } = mount(def, CTX);
            const firstRes = await PUT!(
                makeEvent({ ...alice, rawBody: JSON.stringify(VALID_BODY) }),
            );
            expect(firstRes.status).toBe(200);
            expect(auditLog).not.toHaveBeenCalled();

            // Same APNs token, different account — the handed-over-device case.
            const secondRes = await PUT!(
                makeEvent({ ...bob, rawBody: JSON.stringify(VALID_BODY) }),
            );
            expect(secondRes.status).toBe(200);

            const [row] = await sql<{ id: string }[]>`
                SELECT id FROM user_push_tokens WHERE token = ${VALID_BODY.token}
            `;
            expect(auditLog).toHaveBeenCalledTimes(1);
            // The real actor: bob is the caller who performed this PUT (no
            // `locals.principal`/delegation on the synthetic event, so
            // `auditActor()` falls back to `{ username: locals.user.username }`
            // — see `audit-log.ts`'s `auditActor()`).
            expect(auditLog).toHaveBeenCalledWith(
                'push_token.rebind',
                row.id,
                { username: bob.username },
                {
                    previousUserId: alice.userId,
                    newUserId: bob.userId,
                    previousWasActive: true,
                },
            );
        });

        it('emits nothing when a user re-registers its own token (control)', async () => {
            const alice = await makePrincipal('rebind-self');

            const { PUT } = mount(def, CTX);
            await PUT!(makeEvent({ ...alice, rawBody: JSON.stringify(VALID_BODY) }));
            const res = await PUT!(makeEvent({ ...alice, rawBody: JSON.stringify(VALID_BODY) }));

            expect(res.status).toBe(200);
            expect(auditLog).not.toHaveBeenCalled();
        });

        it('emits nothing on a first registration (control)', async () => {
            const alice = await makePrincipal('rebind-first');

            const { PUT } = mount(def, CTX);
            const res = await PUT!(makeEvent({ ...alice, rawBody: JSON.stringify(VALID_BODY) }));

            expect(res.status).toBe(200);
            expect(auditLog).not.toHaveBeenCalled();
        });
    });
});
