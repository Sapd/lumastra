// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test: revoking a device cuts off its access JWT and its stream tokens.
 *
 * Drives a real device-flow access JWT through `resolveAuth()` (the JWT branch
 * of forward-auth) against real Postgres, and revokes devices through the real
 * API defs (`POST /api/v1/auth/logout` and the admin `DELETE
 * /api/v1/users/{userId}/devices/{deviceSessionId}`). Nothing on the auth path is mocked except
 * `$app/environment` and the `features.deviceAuth` getter.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { features } from '$lib/server/config.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { mount } from '$lib/server/api/mount.js';
import { def as logoutDef } from '$lib/server/api/defs/auth/logout.js';
import { def as adminDevicesDef } from '$lib/server/api/defs/users/[id]/devices-id.js';
import { generateAccessToken } from '$lib/server/oauth/jwt.js';
import { getRefreshTokenService } from '$lib/server/oauth/refresh-token.service.js';
import {
    mintPlaybackGrant,
    renewPlaybackGrant,
    validatePlaybackGrant,
} from '$lib/server/services/playback-grant.js';
import {
    _resetDeviceSessionLivenessForTests,
    checkDeviceSessionLiveness,
} from '$lib/server/oauth/device-session-liveness.js';
import {
    revokeAllDeviceSessionsForUser,
    revokeDeviceSession,
    revokeDeviceSessionsForUserClient,
} from '$lib/server/oauth/device-session-revocation.js';
import { deleteUser } from '$lib/server/services/admin-user.service.js';
import { lockDeviceSessions } from '$lib/server/database/queries/oauth-refresh-tokens.queries.js';
import { def as userDevicesDef } from '$lib/server/api/defs/devices/[id]/index.js';
import { def as devicesDef } from '$lib/server/api/defs/devices/[id]/index.js';
import { def as userDevicesAllDef } from '$lib/server/api/defs/devices/revoke-all.js';
import { POST as legacyLogoutPost } from '../../../routes/api/auth/logout/+server.js';
import { revokeAllCredentialsForUser } from '$lib/server/services/credential-revocation.service.js';
import { createHash } from 'node:crypto';

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

const V1_URL = 'http://localhost/api/v1/devices';
const LOGOUT_URL = 'http://localhost/api/v1/auth/logout';
const CLIENT_IP = '127.0.0.1';
const noopMigration = async (): Promise<void> => undefined;

const createdUserIds: string[] = [];

interface Device {
    userId: UserId;
    username: string;
    deviceSessionId: string;
    refreshToken: string;
    jwt: string;
}

async function insertUser(): Promise<{ userId: UserId; username: string }> {
    const sql = getTestDb();
    const username = `itest_dsl_${randomUUID().slice(0, 8)}`;
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username) VALUES (${username}) RETURNING id
    `;
    createdUserIds.push(row.id);
    return { userId: toUserId(row.id), username };
}

/** A device-flow login: refresh-token row + access JWT for the same session. */
async function loginDevice(user: { userId: UserId; username: string }): Promise<Device> {
    const deviceSessionId = randomUUID();
    const refreshToken = await getRefreshTokenService().create({
        userId: user.userId,
        clientId: 'itest-client',
        groups: [],
        deviceSessionId,
    });
    const jwt = await generateAccessToken({
        username: user.username,
        clientId: 'itest-client',
        groups: [],
        deviceSessionId,
    });
    return { ...user, deviceSessionId, refreshToken, jwt };
}

function makeEvent(url: string, opts: { token?: string; method?: string } = {}): RequestEvent {
    const u = new URL(url);
    const headers = new Headers();
    if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
    return {
        url: u,
        request: new Request(u, { method: opts.method ?? 'GET', headers }),
        route: { id: u.pathname },
        params: {
            id:
                /\/users\/([^/]+)\/devices\//.exec(u.pathname)?.[1] ??
                /\/devices\/([^/]+)$/.exec(u.pathname)?.[1],
            deviceSessionId: /\/users\/[^/]+\/devices\/([^/]+)$/.exec(u.pathname)?.[1],
        },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => undefined,
            delete: () => undefined,
            serialize: () => '',
        },
        fetch: async () => new Response(null),
        getClientAddress: () => CLIENT_IP,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
}

/** Status the JWT branch answers with; 200 when it lets the request through. */
async function authStatus(jwt: string): Promise<number> {
    const res = await resolveAuth(makeEvent(V1_URL, { token: jwt }), noopMigration, true);
    return res ? res.status : 200;
}

const grantMediaIds = new Map<string, string>();
const grantFixtureMediaIds = new Set<string>();
async function mintStreamToken(
    device: Pick<Device, 'userId' | 'deviceSessionId'>,
): Promise<string> {
    const mediaId = randomUUID();
    await getTestDb()`INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${mediaId}, 'Device liveness grant fixture', 'movie', 'active', true)`;
    grantFixtureMediaIds.add(mediaId);
    const result = await mintPlaybackGrant({
        userId: device.userId,
        mediaId,
        kind: 'video',
        playbackSessionId: null,
        clientIp: CLIENT_IP,
        deviceSessionId: device.deviceSessionId,
    });
    grantMediaIds.set(result.token, mediaId);
    return result.token;
}

async function streamTokenValid(token: string): Promise<boolean> {
    const mediaId = grantMediaIds.get(token);
    if (!mediaId) throw new Error('Unknown grant fixture');
    return !(
        'reason' in
        (await validatePlaybackGrant(token, {
            clientIp: CLIENT_IP,
            route: { kind: 'video', mediaId },
        }))
    );
}

async function streamRowActive(token: string): Promise<boolean> {
    const [row] = await getTestDb()<{ is_active: boolean }[]>`
        SELECT is_active FROM hls_playback_tokens
        WHERE token_hash = ${createHash('sha256').update(token).digest('hex')}
    `;
    return row.is_active;
}

/** The revoke's rows only — no tombstone, no stream-token sweep. */
async function revokeRowsOnly(deviceSessionId: string): Promise<void> {
    await getTestDb()`
        UPDATE oauth_refresh_tokens SET revoked_at = NOW()
        WHERE device_session_id = ${deviceSessionId} AND revoked_at IS NULL
    `;
}

describe('device session liveness (access JWT + stream tokens)', () => {
    beforeAll(() => {
        vi.spyOn(features, 'deviceAuth', 'get').mockReturnValue(true);
    });

    beforeEach(() => {
        _resetDeviceSessionLivenessForTests();
    });

    afterAll(async () => {
        const sql = getTestDb();
        if (createdUserIds.length > 0) {
            await sql`DELETE FROM hls_playback_tokens WHERE user_id = ANY(${createdUserIds}::uuid[])`;
            await sql`DELETE FROM oauth_refresh_tokens WHERE user_id = ANY(${createdUserIds}::uuid[])`;
            for (const mediaId of grantFixtureMediaIds)
                await sql`DELETE FROM media_items WHERE id = ${mediaId}`;
            grantMediaIds.clear();
            grantFixtureMediaIds.clear();
            await sql`DELETE FROM users WHERE id = ANY(${createdUserIds}::uuid[])`;
        }
        vi.restoreAllMocks();
    });

    it('logout via the real def rejects the same JWT on the next request (cached verdict evicted)', async () => {
        const device = await loginDevice(await insertUser());

        // Accepted, and the "live" verdict is now cached on this replica.
        expect(await authStatus(device.jwt)).toBe(200);
        expect(await authStatus(device.jwt)).toBe(200);

        // Log out with the JWT itself, through the real middleware + def.
        const event = makeEvent(LOGOUT_URL, { token: device.jwt, method: 'POST' });
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        const res = await mount(logoutDef, { surface: 'v1' }).POST!(event);
        expect(res.status).toBe(204);

        // Within the 60 s cache window: only the local eviction makes this 401.
        expect(await authStatus(device.jwt)).toBe(401);
    });

    it('refresh rotation never makes the session look revoked', async () => {
        const device = await loginDevice(await insertUser());
        const service = getRefreshTokenService();

        const first = await service.rotate(device.refreshToken);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        // The second rotation revokes the first token (its successor was used).
        const second = await service.rotate(first.token);
        expect(second.ok).toBe(true);

        _resetDeviceSessionLivenessForTests(); // force the DB verdict
        expect(await authStatus(device.jwt)).toBe(200);
    });

    it('admin revoke of device A leaves device B (same user) working, and ends only A’s stream tokens', async () => {
        const user = await insertUser();
        const a = await loginDevice(user);
        const b = await loginDevice(user);
        const streamA = await mintStreamToken(a);
        const streamB = await mintStreamToken(b);

        expect(await authStatus(a.jwt)).toBe(200);
        expect(await authStatus(b.jwt)).toBe(200);
        expect(await streamTokenValid(streamA)).toBe(true);
        expect(await streamTokenValid(streamB)).toBe(true);

        const url = new URL(
            `http://localhost/api/v1/users/${user.userId}/devices/${a.deviceSessionId}`,
        );
        const adminEvent = makeEvent(url.toString(), { method: 'DELETE' });
        (adminEvent.locals as unknown as Record<string, unknown>).user = {
            userId: toUserId('00000000-0000-0000-0000-0000000000ad'),
            username: 'admin-operator',
            groups: '',
            userGroups: [],
            hasWatchPermission: false,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            isAdmin: true,
            isModerator: false,
            maxAgeRating: null,
            isAgeRestricted: false,
            liveTvPriority: 'low',
        };
        (adminEvent.locals as unknown as Record<string, unknown>).principal = {
            kind: 'session',
            username: 'admin-operator',
            isAdmin: true,
            scopes: ['admin'],
        };
        const res = await mount(adminDevicesDef, { surface: 'internal' }).DELETE!(adminEvent);
        expect(res.status).toBe(204);

        expect(await authStatus(a.jwt)).toBe(401);
        expect(await authStatus(b.jwt)).toBe(200);
        expect(await streamTokenValid(streamA)).toBe(false);
        expect(await streamTokenValid(streamB)).toBe(true);

        // And from the DB alone (cold cache), as another replica would see it.
        _resetDeviceSessionLivenessForTests();
        expect(await authStatus(a.jwt)).toBe(401);
        expect(await authStatus(b.jwt)).toBe(200);
    });

    it('revoke-all for a user cuts off every device session of that user', async () => {
        const user = await insertUser();
        const a = await loginDevice(user);
        const b = await loginDevice(user);
        expect(await authStatus(a.jwt)).toBe(200);
        expect(await authStatus(b.jwt)).toBe(200);

        await getRefreshTokenService().revokeAllForUser(user.userId);

        expect(await authStatus(a.jwt)).toBe(401);
        expect(await authStatus(b.jwt)).toBe(401);
    });
    // ── Every revoke path, at the seam, with a warmed live cache ────────────

    /** Drive a v1 def with `caller`'s JWT through the real middleware. */
    async function callV1(
        handler: (e: RequestEvent) => Promise<Response> | Response,
        url: string,
        method: string,
        callerJwt: string,
    ): Promise<Response> {
        const event = makeEvent(url, { token: callerJwt, method });
        const auth = await resolveAuth(event, noopMigration, true);
        if (auth) return auth;
        return await handler(event);
    }

    async function unrevokedRows(deviceSessionId: string): Promise<number> {
        const [row] = await getTestDb()<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM oauth_refresh_tokens
            WHERE device_session_id = ${deviceSessionId} AND revoked_at IS NULL
        `;
        return row.n;
    }

    it('DELETE /user/devices/{id} (from device B) cuts off device A only', async () => {
        const user = await insertUser();
        const a = await loginDevice(user);
        const b = await loginDevice(user);
        expect(await authStatus(a.jwt)).toBe(200);
        const res = await callV1(
            mount(userDevicesDef, { surface: 'v1' }).DELETE!,
            `http://localhost/api/v1/devices/${a.deviceSessionId}`,
            'DELETE',
            b.jwt,
        );
        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');
        expect(await authStatus(a.jwt)).toBe(401);
        expect(await authStatus(b.jwt)).toBe(200);
    });

    it('DELETE /devices/{id} cuts off the device', async () => {
        const user = await insertUser();
        const a = await loginDevice(user);
        const b = await loginDevice(user);
        expect(await authStatus(a.jwt)).toBe(200);
        const res = await callV1(
            mount(devicesDef, { surface: 'v1' }).DELETE!,
            `http://localhost/api/v1/devices/${a.deviceSessionId}`,
            'DELETE',
            b.jwt,
        );
        expect(res.status).toBe(204);
        expect(await authStatus(a.jwt)).toBe(401);
        expect(await authStatus(b.jwt)).toBe(200);
    });

    it("DELETE /user/devices/{id} with another user's session is a 404 and cuts nothing", async () => {
        const victim = await loginDevice(await insertUser());
        const attacker = await loginDevice(await insertUser());
        const stream = await mintStreamToken(victim);
        expect(await authStatus(victim.jwt)).toBe(200);
        const res = await callV1(
            mount(userDevicesDef, { surface: 'v1' }).DELETE!,
            `http://localhost/api/v1/devices/${victim.deviceSessionId}`,
            'DELETE',
            attacker.jwt,
        );
        expect(res.status).toBe(404);
        expect(await authStatus(victim.jwt)).toBe(200);
        expect(await streamTokenValid(stream)).toBe(true);
    });

    it('POST /devices/revoke-all cuts off every device of the user (revokeAll RETURNING session ids)', async () => {
        const user = await insertUser();
        const a = await loginDevice(user);
        const b = await loginDevice(user);
        const other = await loginDevice(await insertUser());
        expect(await authStatus(a.jwt)).toBe(200);
        expect(await authStatus(b.jwt)).toBe(200);
        expect(await authStatus(other.jwt)).toBe(200);
        // Sign-out-everywhere needs an interactive session (a bearer gets 403
        // session_required), so drive the handler as the user's web session.
        const event = makeEvent('http://localhost/api/v1/devices/revoke-all', { method: 'POST' });
        Object.assign(event.locals as unknown as Record<string, unknown>, {
            user: { userId: user.userId, username: user.username },
            principal: { kind: 'session', userId: user.userId, username: user.username },
        });
        const res = await mount(userDevicesAllDef, { surface: 'v1' }).POST!(event);
        expect(res.status).toBe(200);
        expect(await authStatus(a.jwt)).toBe(401);
        expect(await authStatus(b.jwt)).toBe(401);
        expect(await authStatus(other.jwt)).toBe(200);
    });

    it('legacy POST /api/auth/logout cuts off the calling device', async () => {
        const user = await insertUser();
        const device = await loginDevice(user);
        expect(await authStatus(device.jwt)).toBe(200);
        const event = makeEvent('http://localhost/api/auth/logout', { method: 'POST' });
        Object.assign(event.locals as unknown as Record<string, unknown>, {
            user: {
                userId: user.userId,
                username: user.username,
                groups: '',
                userGroups: [],
                isAdmin: false,
            },
            deviceSessionId: device.deviceSessionId,
        });
        const res = await legacyLogoutPost(event as Parameters<typeof legacyLogoutPost>[0]);
        expect(res.status).toBe(200);
        expect(await authStatus(device.jwt)).toBe(401);
    });

    it('RefreshTokenService.revokeByDeviceSessionId (token-reuse path) cuts off the JWT', async () => {
        const device = await loginDevice(await insertUser());
        expect(await authStatus(device.jwt)).toBe(200);
        await getRefreshTokenService().revokeByDeviceSessionId(device.deviceSessionId);
        expect(await authStatus(device.jwt)).toBe(401);
    });

    it("RefreshTokenService.revokeForUserClient cuts off that client's devices", async () => {
        const device = await loginDevice(await insertUser());
        expect(await authStatus(device.jwt)).toBe(200);
        await getRefreshTokenService().revokeForUserClient(device.userId, 'itest-client');
        expect(await authStatus(device.jwt)).toBe(401);
    });

    it('credential-revocation fan-out cuts off both devices of the user', async () => {
        const user = await insertUser();
        const a = await loginDevice(user);
        const b = await loginDevice(user);
        const streamA = await mintStreamToken(a);
        expect(await authStatus(a.jwt)).toBe(200);
        expect(await authStatus(b.jwt)).toBe(200);
        expect(await streamTokenValid(streamA)).toBe(true);
        await revokeAllCredentialsForUser(getTestDb(), user.userId, user.username);
        expect(await authStatus(a.jwt)).toBe(401);
        expect(await authStatus(b.jwt)).toBe(401);
        expect(await streamTokenValid(streamA)).toBe(false);
    });

    it('a retried revoke still ends a stream token the first attempt left behind', async () => {
        const user = await insertUser();
        const device = await loginDevice(user);
        // First attempt revoked the rows but its cut-off never ran (simulated
        // with a raw UPDATE), leaving the stream token active in the DB.
        const stream = await mintStreamToken(device);
        await getTestDb()`
            UPDATE oauth_refresh_tokens SET revoked_at = NOW()
            WHERE device_session_id = ${device.deviceSessionId}
        `;
        const result = await revokeDeviceSession(getTestDb(), device.deviceSessionId, {
            userId: user.userId,
        });
        expect(result).toEqual({ revokedCount: 0, owned: true });
        const [row] = await getTestDb()<{ is_active: boolean }[]>`
            SELECT is_active FROM hls_playback_tokens
            WHERE token_hash = ${createHash('sha256').update(stream).digest('hex')}
        `;
        expect(row.is_active).toBe(false);
    });

    it('superseded-but-unrevoked and expired-but-unrevoked rows still count as live', async () => {
        const device = await loginDevice(await insertUser());
        await getTestDb()`
            UPDATE oauth_refresh_tokens
            SET superseded_at = NOW(), expires_at = NOW() - INTERVAL '1 minute'
            WHERE device_session_id = ${device.deviceSessionId}
        `;
        _resetDeviceSessionLivenessForTests();
        expect(await authStatus(device.jwt)).toBe(200);
    });

    it('an account JWT in ?api_key= is never accepted on media routes, before or after logout', async () => {
        const device = await loginDevice(await insertUser());
        const url = `http://localhost/api/v1/playback/00000000-0000-0000-0000-000000000001/hls?api_key=${device.jwt}`;
        expect((await resolveAuth(makeEvent(url), noopMigration, true))?.status).toBe(401);
        await revokeDeviceSession(getTestDb(), device.deviceSessionId, { userId: device.userId });
        expect((await resolveAuth(makeEvent(url), noopMigration, true))?.status).toBe(401);
    });

    // ── Revoke vs rotation race (advisory lock) ─────────────────────────────

    it('a revoke racing a rotation (rotation holds the lock) still revokes the successor', async () => {
        const device = await loginDevice(await insertUser());
        const sql = getTestDb();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        // Connection 1: what rotate() does, held open — lock, insert the
        // successor, supersede the presented row, then wait.
        const rotation = sql.begin(async (tx) => {
            const t = tx as unknown as typeof sql;
            await lockDeviceSessions(t, [device.deviceSessionId]);
            const [succ] = await t<{ id: number }[]>`
                INSERT INTO oauth_refresh_tokens (
                    token_hash, user_id, client_id, expires_at, device_session_id
                ) VALUES (
                    ${'itest-successor-' + device.deviceSessionId}, ${device.userId}::uuid,
                    'itest-client', NOW() + INTERVAL '30 days', ${device.deviceSessionId}
                ) RETURNING id
            `;
            await t`
                UPDATE oauth_refresh_tokens SET superseded_at = NOW(), superseded_by = ${succ.id}
                WHERE device_session_id = ${device.deviceSessionId} AND id <> ${succ.id}
            `;
            await gate;
        });
        // Connection 2: the revoke, which must wait for the lock.
        await new Promise((r) => setTimeout(r, 200));
        const revoke = revokeDeviceSession(sql, device.deviceSessionId, { userId: device.userId });
        await new Promise((r) => setTimeout(r, 300));
        release();
        await rotation;
        await revoke;

        expect(await unrevokedRows(device.deviceSessionId)).toBe(0);
        _resetDeviceSessionLivenessForTests(); // as if the tombstone expired
        expect(await authStatus(device.jwt)).toBe(401);
    });

    it('a rotation racing a revoke (revoke holds the lock) is refused', async () => {
        const device = await loginDevice(await insertUser());
        const sql = getTestDb();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const revoke = sql.begin(async (tx) => {
            const t = tx as unknown as typeof sql;
            await lockDeviceSessions(t, [device.deviceSessionId]);
            await t`
                UPDATE oauth_refresh_tokens SET revoked_at = NOW()
                WHERE device_session_id = ${device.deviceSessionId} AND revoked_at IS NULL
            `;
            await gate;
        });
        await new Promise((r) => setTimeout(r, 200));
        const rotation = getRefreshTokenService().rotate(device.refreshToken);
        await new Promise((r) => setTimeout(r, 300));
        release();
        await revoke;
        const result = await rotation;

        expect(result.ok).toBe(false);
        expect(await unrevokedRows(device.deviceSessionId)).toBe(0);
    });

    it('a login landing right after a revoke-all commits is not cut off', async () => {
        const sql = getTestDb();
        const user = await insertUser();
        const a = await loginDevice(user);
        const b = randomUUID();
        // Deterministic interleaving: a statement trigger inserts device B's
        // first refresh-token row right after the revoke's UPDATE, inside the
        // revoke transaction, so B is committed live but is not one the
        // revoke revoked — as a device-code grant committing between the
        // revoke's commit and its cut-off listing would be.
        await sql`CREATE TABLE IF NOT EXISTS itest_pending_login (user_id uuid, device_session_id text)`;
        await sql`
            CREATE OR REPLACE FUNCTION itest_insert_pending_login() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                INSERT INTO oauth_refresh_tokens
                    (token_hash, user_id, client_id, expires_at, device_session_id)
                SELECT 'itest-late-' || p.device_session_id, p.user_id, 'itest-client',
                       NOW() + INTERVAL '30 days', p.device_session_id
                FROM itest_pending_login p
                WHERE EXISTS (SELECT 1 FROM revoked_rows r WHERE r.user_id = p.user_id);
                DELETE FROM itest_pending_login p
                WHERE EXISTS (SELECT 1 FROM revoked_rows r WHERE r.user_id = p.user_id);
                RETURN NULL;
            END $$
        `;
        await sql`
            CREATE OR REPLACE TRIGGER itest_pending_login_trg
            AFTER UPDATE ON oauth_refresh_tokens
            REFERENCING NEW TABLE AS revoked_rows
            FOR EACH STATEMENT EXECUTE FUNCTION itest_insert_pending_login()
        `;
        try {
            await sql`INSERT INTO itest_pending_login VALUES (${user.userId}::uuid, ${b})`;
            const result = await revokeAllDeviceSessionsForUser(sql, user.userId);
            expect(result.deviceSessionIds).toEqual([a.deviceSessionId]);
        } finally {
            await sql`DROP TRIGGER IF EXISTS itest_pending_login_trg ON oauth_refresh_tokens`;
            await sql`DROP FUNCTION IF EXISTS itest_insert_pending_login()`;
            await sql`DROP TABLE IF EXISTS itest_pending_login`;
        }
        expect(await unrevokedRows(b)).toBe(1);

        const bJwt = await generateAccessToken({
            username: user.username,
            clientId: 'itest-client',
            groups: [],
            deviceSessionId: b,
        });
        expect(await authStatus(a.jwt)).toBe(401);
        expect(await authStatus(bJwt)).toBe(200);
    });

    // ── Stream tokens the revoke's sweep did not end ────────────────────────

    it('a stream token minted on a replica that has not heard of the revoke fails validation', async () => {
        const device = await loginDevice(await insertUser());
        // Replica A revoked and swept; replica B (no tombstone) mints after the sweep.
        await revokeRowsOnly(device.deviceSessionId);
        _resetDeviceSessionLivenessForTests();
        const stream = await mintStreamToken(device);
        expect(await streamRowActive(stream)).toBe(true);

        expect(await streamTokenValid(stream)).toBe(false);
        expect(await streamRowActive(stream)).toBe(true); // DB liveness check denies without relying on a local sweep
    });

    it('a stream-token refresh racing the revoke sweep does not leave a working token', async () => {
        const device = await loginDevice(await insertUser());
        const old = await mintStreamToken(device);
        // Rows revoked, sweep not yet run: the token-only refresh still succeeds.
        await revokeRowsOnly(device.deviceSessionId);
        _resetDeviceSessionLivenessForTests();
        const [grant] = await getTestDb()<
            { id: string }[]
        >`SELECT id FROM hls_playback_tokens WHERE token_hash = ${createHash('sha256').update(old).digest('hex')}`;
        const refreshed = await renewPlaybackGrant(grant.id, device.userId, 'v1', old);
        expect(refreshed).toBeNull();
        expect(await streamTokenValid(old)).toBe(false);
    });

    it('a cached stream token stops once this replica learns of the revoke from the DB', async () => {
        const device = await loginDevice(await insertUser());
        const stream = await mintStreamToken(device);
        expect(await streamTokenValid(stream)).toBe(true); // now cached
        await revokeRowsOnly(device.deviceSessionId); // row stays active
        _resetDeviceSessionLivenessForTests();
        expect(await checkDeviceSessionLiveness(device.deviceSessionId)).toBe('revoked');

        expect(await streamTokenValid(stream)).toBe(false);
    });

    it('a playback grant mint right after a local revoke is refused', async () => {
        const device = await loginDevice(await insertUser());
        await revokeDeviceSession(getTestDb(), device.deviceSessionId, { userId: device.userId });
        await expect(mintStreamToken(device)).rejects.toThrow('Device session has been revoked');
    });

    it('a cookie stream token with a client-chosen device id (no refresh rows) stays valid', async () => {
        const user = await insertUser();
        const token = await mintStreamToken({
            ...user,
            deviceSessionId: `airplay-${randomUUID()}`,
        });
        expect(await streamTokenValid(token)).toBe(true);
    });

    it('a revoke-all / revoke-by-client racing a rotation (rotation holds the lock) revokes the successor', async () => {
        for (const revokeVia of ['user', 'client'] as const) {
            const device = await loginDevice(await insertUser());
            const sql = getTestDb();
            let release: () => void = () => undefined;
            const gate = new Promise<void>((r) => {
                release = r;
            });
            const rotation = sql.begin(async (tx) => {
                const t = tx as unknown as typeof sql;
                await lockDeviceSessions(t, [device.deviceSessionId]);
                await t`
                    INSERT INTO oauth_refresh_tokens (
                        token_hash, user_id, client_id, expires_at, device_session_id
                    ) VALUES (
                        ${'itest-successor-' + revokeVia + device.deviceSessionId},
                        ${device.userId}::uuid, 'itest-client', NOW() + INTERVAL '30 days',
                        ${device.deviceSessionId}
                    )
                `;
                await gate;
            });
            await new Promise((r) => setTimeout(r, 200));
            const revoke =
                revokeVia === 'user'
                    ? revokeAllDeviceSessionsForUser(sql, device.userId)
                    : revokeDeviceSessionsForUserClient(sql, device.userId, 'itest-client');
            await new Promise((r) => setTimeout(r, 300));
            release();
            await rotation;
            await revoke;

            expect(await unrevokedRows(device.deviceSessionId)).toBe(0);
        }
    });

    it('creating a refresh token while a revoke of the same session holds the lock is refused', async () => {
        const device = await loginDevice(await insertUser());
        const sql = getTestDb();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const revoke = sql.begin(async (tx) => {
            const t = tx as unknown as typeof sql;
            await lockDeviceSessions(t, [device.deviceSessionId]);
            await t`
                UPDATE oauth_refresh_tokens SET revoked_at = NOW()
                WHERE device_session_id = ${device.deviceSessionId} AND revoked_at IS NULL
            `;
            await gate;
        });
        await new Promise((r) => setTimeout(r, 200));
        const create = getRefreshTokenService().create({
            userId: device.userId,
            clientId: 'itest-client',
            groups: [],
            deviceSessionId: device.deviceSessionId,
        });
        const settled = create.then(
            () => 'created',
            (err: unknown) => String(err),
        );
        await new Promise((r) => setTimeout(r, 300));
        release();
        await revoke;

        expect(await settled).toContain('Device session has been revoked');
        expect(await unrevokedRows(device.deviceSessionId)).toBe(0);
    });

    it('deleting the user cuts off its device JWT and cached stream token at once', async () => {
        const user = await insertUser();
        const device = await loginDevice(user);
        const stream = await mintStreamToken(device);
        expect(await authStatus(device.jwt)).toBe(200); // live verdict cached
        expect(await streamTokenValid(stream)).toBe(true); // stream token cached

        const res = await deleteUser(getTestDb(), {
            targetUsername: user.username,
            actingUsername: 'itest-admin',
        });
        expect(res.ok).toBe(true);

        expect(await authStatus(device.jwt)).toBe(401);
        expect(await streamTokenValid(stream)).toBe(false);
    });

    it('creating a refresh token for an already-revoked (reused) session is refused', async () => {
        const device = await loginDevice(await insertUser());
        await revokeDeviceSession(getTestDb(), device.deviceSessionId, { userId: device.userId });
        await expect(
            getRefreshTokenService().create({
                userId: device.userId,
                clientId: 'itest-client',
                groups: [],
                deviceSessionId: device.deviceSessionId,
            }),
        ).rejects.toThrow('Device session has been revoked');
        expect(await unrevokedRows(device.deviceSessionId)).toBe(0);
    });
});
