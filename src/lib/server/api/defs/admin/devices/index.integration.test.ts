// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level integration test for GET/DELETE /api/admin/devices against a
 * real Postgres database.
 *
 * Gap 5 (deferred push-notification test ledger): the admin single-device-
 * revoke route had no route-level test at all. The dead query helpers
 * `revokeDeviceSession`/`revokeSessionById` were removed in commit
 * `2c6a22935` (they were never called from production code — see
 * device-sessions.queries.ts history). This def's DELETE handler never used
 * them either: it revokes by running inline SQL directly against
 * `oauth_refresh_tokens` (a lint-flagged pattern — "Avoid direct SQL in
 * routes" — but the live behaviour, not the removed helpers). Mirrors
 * `push-token.integration.test.ts`: mount() the real def, do NOT mock
 * `getDb()` (the integration Vitest config points `DATABASE_URL` at
 * `lumastra_tests`), and drive it through real HTTP-shaped RequestEvents.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

const flags = vi.hoisted(() => ({ deviceAuth: true }));

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        features: new Proxy(actual.features, {
            get: (target, prop, receiver) =>
                prop === 'deviceAuth' ? flags.deviceAuth : Reflect.get(target, prop, receiver),
        }),
    };
});

import { mount } from '$lib/server/api/mount.js';
import { def as listDef } from '../../users/[id]/devices.js';
import { def as revokeDef } from '../../users/[id]/devices-id.js';
import type postgres from 'postgres';

let sql: postgres.Sql;

const CTX = { surface: 'internal' as const };
const USERNAME_PREFIX = 'itest_admindevices';

interface TargetUser {
    userId: UserId;
    username: string;
    deviceSessionId: string;
}

async function insertTargetUser(suffix: string): Promise<TargetUser> {
    const username = `${USERNAME_PREFIX}_${suffix}`;
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username) VALUES (${username}) RETURNING id
    `;
    const userId = toUserId(row.id);
    const deviceSessionId = `itest-session-${suffix}`;

    await sql`
        INSERT INTO oauth_refresh_tokens (
            user_id, client_id, token_hash, device_id, device_session_id,
            created_at, expires_at
        ) VALUES (
            ${userId}, 'itest-client', ${`itest-hash-${suffix}`}, ${`itest-device-${suffix}`},
            ${deviceSessionId}, NOW(), NOW() + INTERVAL '30 days'
        )
    `;

    return { userId, username, deviceSessionId };
}

/** The caller: an admin operator, never the target user. */
function makeAdminEvent(query: Record<string, string>, method = 'GET'): RequestEvent {
    const url = new URL('http://localhost/api/admin/devices');
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    return {
        url,
        request: new Request(url.toString(), { method }),
        params: { id: query.userId, deviceSessionId: query.id },
        route: { id: '/api/admin/devices' as const },
        locals: {
            user: {
                userId: toUserId('00000000-0000-0000-0000-0000000000ad'),
                username: 'admin-operator',
                groups: '',
                userGroups: [] as string[],
                hasWatchPermission: false,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: true,
                isModerator: false,
                maxAgeRating: null as null | number,
                isAgeRestricted: false,
                liveTvPriority: 'low' as const,
            },
            principal: {
                kind: 'session',
                username: 'admin-operator',
                isAdmin: true,
                scopes: ['admin'],
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

function makeNonAdminEvent(query: Record<string, string>, method = 'DELETE'): RequestEvent {
    const event = makeAdminEvent(query, method);
    const locals = event.locals as unknown as {
        user: { ownerIsAdmin: boolean };
        principal: { isAdmin: boolean; scopes: string[] };
    };
    locals.user.ownerIsAdmin = false;
    locals.principal.isAdmin = false;
    locals.principal.scopes = ['read', 'write'];
    return event;
}

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
    flags.deviceAuth = true;
    await sql`
        DELETE FROM oauth_refresh_tokens
        WHERE user_id IN (SELECT id FROM users WHERE username LIKE ${USERNAME_PREFIX + '_%'})
    `;
    await sql`
        DELETE FROM user_devices
        WHERE user_id IN (SELECT id FROM users WHERE username LIKE ${USERNAME_PREFIX + '_%'})
    `;
    await sql`DELETE FROM users WHERE username LIKE ${USERNAME_PREFIX + '_%'}`;
});

describe('admin/devices def against a real database', () => {
    it('DELETE revokes the target session — oauth_refresh_tokens.revoked_at is set', async () => {
        const target = await insertTargetUser('revoke-a');

        const { DELETE } = mount(revokeDef, CTX);
        const res = await DELETE!(
            makeAdminEvent({ userId: target.userId, id: target.deviceSessionId }, 'DELETE'),
        );

        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');

        const [row] = await sql<{ revoked_at: Date | null }[]>`
            SELECT revoked_at FROM oauth_refresh_tokens
            WHERE device_session_id = ${target.deviceSessionId} AND user_id = ${target.userId}
        `;
        expect(row.revoked_at).not.toBeNull();
    });

    it('DELETE is idempotent-safe: revoking an already-revoked session 404s rather than double-revoking', async () => {
        const target = await insertTargetUser('revoke-twice');

        const { DELETE } = mount(revokeDef, CTX);
        const first = await DELETE!(
            makeAdminEvent({ userId: target.userId, id: target.deviceSessionId }, 'DELETE'),
        );
        expect(first.status).toBe(204);

        const second = await DELETE!(
            makeAdminEvent({ userId: target.userId, id: target.deviceSessionId }, 'DELETE'),
        );
        expect(second.status).toBe(404);
        const body = await bodyOf<{ code: string }>(second);
        expect(body.code).toBe('not_found');
    });

    it('DELETE returns 404 for a device session that does not belong to the named user', async () => {
        const owner = await insertTargetUser('owner');
        const stranger = await insertTargetUser('stranger');

        const { DELETE } = mount(revokeDef, CTX);
        // stranger's username, owner's session id — must not cross-revoke.
        const res = await DELETE!(
            makeAdminEvent({ userId: stranger.userId, id: owner.deviceSessionId }, 'DELETE'),
        );
        expect(res.status).toBe(404);

        const [row] = await sql<{ revoked_at: Date | null }[]>`
            SELECT revoked_at FROM oauth_refresh_tokens
            WHERE device_session_id = ${owner.deviceSessionId} AND user_id = ${owner.userId}
        `;
        expect(row.revoked_at).toBeNull();
    });

    it('DELETE returns 404 for an unknown username', async () => {
        const { DELETE } = mount(revokeDef, CTX);
        const res = await DELETE!(
            makeAdminEvent(
                { userId: '11111111-1111-4111-8111-111111111111', id: 'whatever' },
                'DELETE',
            ),
        );
        expect(res.status).toBe(404);
    });

    it('DELETE returns 403 for a non-admin caller — the auth gate, not the handler, decides', async () => {
        const target = await insertTargetUser('non-admin-caller');

        const { DELETE } = mount(revokeDef, CTX);
        const res = await DELETE!(
            makeNonAdminEvent({ userId: target.userId, id: target.deviceSessionId }, 'DELETE'),
        );
        expect(res.status).toBe(403);

        // Never reached the handler — the session must still be live.
        const [row] = await sql<{ revoked_at: Date | null }[]>`
            SELECT revoked_at FROM oauth_refresh_tokens
            WHERE device_session_id = ${target.deviceSessionId} AND user_id = ${target.userId}
        `;
        expect(row.revoked_at).toBeNull();
    });

    it('DELETE returns 503 dependency_unavailable when device auth is disabled', async () => {
        const target = await insertTargetUser('feature-off');
        flags.deviceAuth = false;

        const { DELETE } = mount(revokeDef, CTX);
        const res = await DELETE!(
            makeAdminEvent({ userId: target.userId, id: target.deviceSessionId }, 'DELETE'),
        );
        expect(res.status).toBe(503);
        const body = await bodyOf<{ code: string }>(res);
        expect(body.code).toBe('dependency_unavailable');
    });

    it('GET lists the session for the named user', async () => {
        const target = await insertTargetUser('list-a');

        const { GET } = mount(listDef, CTX);
        const res = await GET!(makeAdminEvent({ userId: target.userId }, 'GET'));

        expect(res.status).toBe(200);
        const body = await bodyOf<{ items: unknown[]; page: { total: number } }>(res);
        expect(body.page.total).toBe(1);
        expect(body.items).toHaveLength(1);
    });
});
