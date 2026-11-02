// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomInt, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { lockDeviceSessions } from '$lib/server/database/queries/oauth-refresh-tokens.queries.js';
import { POST as requestCode } from '../../../routes/oauth/device/+server.js';
import { SignJWT } from 'jose';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { config, features } from '$lib/server/config.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { generateAccessToken } from './jwt.js';
import { getRefreshTokenService } from './refresh-token.service.js';
import { getDeviceCodeService, type DeviceCodeResponse } from './device-code.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { GET, POST } from '../../../routes/api/v1/oauth/device/approve/+server.js';
import { POST as exchange } from '../../../routes/oauth/token/+server.js';
import {
    POST as browserApprove,
    DELETE as browserDeny,
} from '../../../routes/api/oauth/authorize/+server.js';
import { load as loadDevicePage } from '../../../routes/device/+page.server.js';
import * as audit from '$lib/server/utils/audit-log.js';
import { getPatService } from './pat.service.js';
import { getServiceTokenService } from './service-token.service.js';
import {
    getDeniedLibraryGroups,
    invalidateLibraryGroupPermissionsCache,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { deviceCodeRequestSchema } from '$lib/schemas/oauth.js';
import {
    revokeDeviceSession,
    revokeDeviceSessionsForUserClient,
} from './device-session-revocation.js';
import { getUserDevices } from '$lib/server/services/user-devices.service.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

const path = '/api/v1/oauth/device/approve';
const handlers = { GET, POST };
const userIds: string[] = [];
const clients: string[] = [];
const codes: string[] = [];
const libraryIds: string[] = [];
const noop = async (): Promise<void> => undefined;
let nextIp = 1;

function event(method: string, token?: string, code?: string, approve = true): RequestEvent {
    const url = new URL(`http://localhost${path}`);
    if (method === 'GET' && code) url.searchParams.set('user_code', code);
    const clientIp = `198.18.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;
    return {
        url,
        request: new Request(url, {
            method,
            headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                'content-type': 'application/json',
            },
            ...(method === 'POST' ? { body: JSON.stringify({ user_code: code, approve }) } : {}),
        }),
        route: { id: path },
        params: {},
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: noop,
            delete: noop,
            serialize: () => '',
        },
        fetch: async () => new Response(null),
        getClientAddress: () => clientIp,
        setHeaders: noop,
        isDataRequest: false,
        isSubRequest: false,
    } as unknown as RequestEvent;
}

async function account(
    scope: string | undefined = 'media',
): Promise<{ id: string; username: string; token: string; deviceSessionId: string }> {
    const sql = getTestDb();
    const username = `approve_${randomUUID().slice(0, 8)}`;
    const [row] = await sql<
        { id: string }[]
    >`INSERT INTO users (username, age_rating_pinned, max_age_rating, groups)
        VALUES (${username}, true, 12, ${['kids']}) RETURNING id`;
    userIds.push(row.id);
    const deviceSessionId = randomUUID();
    await getRefreshTokenService().create({
        userId: toUserId(row.id),
        clientId: 'phone',
        groups: [],
        deviceSessionId,
    });
    const token = await generateAccessToken({
        username,
        clientId: 'phone',
        groups: ['stale-admin'],
        deviceSessionId,
        scope,
    });
    return { id: row.id, username, token, deviceSessionId };
}

async function pending(): Promise<DeviceCodeResponse> {
    const clientId = `tv_${randomUUID()}`;
    clients.push(clientId);
    const result = await getDeviceCodeService().createDeviceCode(
        { clientId, deviceName: 'Apple TV (Living Room)', scope: 'media' },
        'http://localhost',
    );
    codes.push(result.device_code);
    return result;
}

async function run(
    method: 'GET' | 'POST',
    token?: string,
    code?: string,
    approve = true,
): Promise<Response> {
    const e = event(method, token, code, approve);
    const denied = await resolveAuth(e, noop, true);
    return denied ?? handlers[method]!(e);
}

beforeAll(() => {
    vi.spyOn(features, 'deviceAuth', 'get').mockReturnValue(true);
    vi.spyOn(config, 'FEATURE_DEVICE_AUTH', 'get').mockReturnValue(true);
});
afterAll(async () => {
    const sql = getTestDb();
    await sql`DELETE FROM oauth_device_codes WHERE device_code = ANY(${codes})`;
    await sql`DELETE FROM oauth_refresh_tokens WHERE user_id = ANY(${userIds}::uuid[])`;
    await sql`DELETE FROM personal_access_tokens WHERE user_id = ANY(${userIds}::uuid[])`;
    await sql`DELETE FROM service_tokens WHERE owner_user_id = ANY(${userIds}::uuid[])`;
    await sql`DELETE FROM library_group_permissions WHERE library_group_id = ANY(${libraryIds}::uuid[])`;
    await sql`DELETE FROM library_groups WHERE id = ANY(${libraryIds}::uuid[])`;
    invalidateLibraryGroupPermissionsCache();
    await sql`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`;
    vi.restoreAllMocks();
});

describe('bearer device approval', () => {
    it('looks up only display info, approves as the phone user, audits, and preserves live restrictions on exchange', async () => {
        const a = await account();
        const sql = getTestDb();
        const [library] = await sql<{ id: string }[]>`INSERT INTO library_groups (name)
            VALUES (${`adult_${randomUUID()}`}) RETURNING id`;
        libraryIds.push(library.id);
        await sql`INSERT INTO library_group_permissions (library_group_id, allowed_groups)
            VALUES (${library.id}::uuid, ${['adults']})`;
        invalidateLibraryGroupPermissionsCache();
        const p = await pending();
        const log = vi.spyOn(audit, 'auditLog');
        const info = await run('GET', a.token, p.user_code.toLowerCase().replace('-', ''));
        expect(info.status).toBe(200);
        expect(info.headers.get('cache-control')).toBe('no-store');
        expect(await info.json()).toEqual({
            clientId: clients.at(-1),
            deviceName: 'Apple TV (Living Room)',
        });
        expect((await run('POST', a.token, p.user_code)).status).toBe(200);
        const record = await getDeviceCodeService().getByUserCode(p.user_code);
        expect(record?.user_id).toBe(a.id);
        await vi.waitFor(async () => {
            const rows = await sql<
                { actor: string; principal_kind: string; detail: Record<string, unknown> }[]
            >`
                SELECT actor, principal_kind, detail FROM audit_log
                WHERE action = 'oauth.device.approve' AND target = ${record!.device_session_id}`;
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                actor: a.username,
                principal_kind: 'bearer',
                detail: {
                    approverUserId: a.id,
                    clientId: record!.client_id,
                    approvingClientId: 'phone',
                },
            });
        });
        expect(log).toHaveBeenCalledWith(
            'oauth.device.approve',
            expect.any(String),
            expect.objectContaining({
                username: a.username,
                kind: 'bearer',
                credentialId: a.deviceSessionId,
            }),
            expect.objectContaining({
                approverUserId: a.id,
                clientId: clients.at(-1),
                deviceName: 'Apple TV (Living Room)',
                approvingClientId: 'phone',
            }),
        );
        const e = event('POST');
        e.request = new Request('http://localhost/oauth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: p.device_code,
                client_id: record!.client_id,
            }),
        });
        const tokens = await exchange(e as Parameters<typeof exchange>[0]);
        expect(tokens.status).toBe(200);
        const body = (await tokens.json()) as { access_token: string };
        const tv = event('GET', body.access_token);
        expect(await resolveAuth(tv, noop, true)).toBeUndefined();
        expect(tv.locals.user?.userId).toBe(a.id);
        expect(tv.locals.user?.maxAgeRating).toBe(12);
        expect(tv.locals.user?.userGroups).toContain('kids');
        expect(tv.locals.principal?.isAdmin).toBe(false);
        expect(await getDeniedLibraryGroups(sql, toLibraryAccessUser(tv.locals.user))).toContain(
            library.id,
        );
        // Neither token's stale groups nor the approval may widen persisted access.
        const [user] = await sql<
            { groups: string[] }[]
        >`SELECT groups FROM users WHERE id = ${a.id}::uuid`;
        expect(user.groups).toEqual(['kids']);
        expect((await run('POST', a.token, p.user_code)).status).toBe(404);
    });

    it('bounds self-reported labels at issuance', () => {
        expect(deviceCodeRequestSchema.safeParse({ client_id: 'x'.repeat(129) }).success).toBe(
            false,
        );
        expect(
            deviceCodeRequestSchema.safeParse({ client_id: 'tv', device_name: 'x'.repeat(65) })
                .success,
        ).toBe(false);
        expect(
            deviceCodeRequestSchema.safeParse({
                client_id: 'x'.repeat(128),
                device_name: 'x'.repeat(64),
            }).success,
        ).toBe(true);
    });

    async function redeem(p: DeviceCodeResponse): Promise<Response> {
        const record = await getDeviceCodeService().getByUserCode(p.user_code);
        const e = event('POST');
        e.request = new Request('http://localhost/oauth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: p.device_code,
                client_id: record!.client_id,
            }),
        });
        return exchange(e as Parameters<typeof exchange>[0]);
    }

    it.each(['session', 'client', 'device', 'creator'])(
        'refuses self-approval by %s',
        async (kind) => {
            const a = await account();
            const p = await pending();
            const sql = getTestDb();
            if (kind === 'session')
                await sql`UPDATE oauth_device_codes SET device_session_id = ${a.deviceSessionId} WHERE user_code = ${p.user_code}`;
            if (kind === 'creator')
                await sql`UPDATE oauth_device_codes SET created_by_device_session_id = ${a.deviceSessionId}::uuid WHERE user_code = ${p.user_code}`;
            if (kind === 'client')
                await sql`UPDATE oauth_device_codes SET client_id = 'phone' WHERE user_code = ${p.user_code}`;
            if (kind === 'device') {
                await sql`UPDATE oauth_refresh_tokens SET device_id = 'same-device' WHERE device_session_id = ${a.deviceSessionId}`;
                await sql`UPDATE oauth_device_codes SET device_id = 'same-device' WHERE user_code = ${p.user_code}`;
            }
            expect((await run('POST', a.token, p.user_code)).status).toBe(403);
            expect((await getDeviceCodeService().getByUserCode(p.user_code))?.status).toBe(
                'pending',
            );
        },
    );

    it.each(['session', 'client'])(
        'persists lineage through rotation, refuses chaining and cascades %s revocation',
        async (revoke) => {
            const a = await account();
            const sql = getTestDb();
            await sql`UPDATE oauth_refresh_tokens SET device_name = 'Denis iPhone' WHERE device_session_id = ${a.deviceSessionId}`;
            const p = await pending();
            expect((await run('POST', a.token, p.user_code)).status).toBe(200);
            const record = await getDeviceCodeService().getByUserCode(p.user_code);
            expect(record).toHaveProperty('approved_by_device_session_id', a.deviceSessionId);
            const response = await redeem(p);
            expect(response.status).toBe(200);
            const tokens = (await response.json()) as {
                access_token: string;
                refresh_token: string;
            };
            const rotated = await getRefreshTokenService().rotate(tokens.refresh_token);
            expect(rotated.ok).toBe(true);
            const rows =
                await sql`SELECT approved_by_device_session_id FROM oauth_refresh_tokens WHERE device_session_id = ${record!.device_session_id}`;
            expect(rows).toHaveLength(2);
            expect(
                rows.every((row) => row.approved_by_device_session_id === a.deviceSessionId),
            ).toBe(true);
            const devices = await getUserDevices(sql, toUserId(a.id));
            expect(
                devices.find((d) => d.deviceSessionId === record!.device_session_id),
            ).toMatchObject({ approvedByDeviceName: 'Denis iPhone' });
            const other = await pending();
            expect((await run('POST', tokens.access_token, other.user_code)).status).toBe(403);
            // A revoked parent also cuts off a grant already approved but not yet exchanged.
            const later = await pending();
            expect((await run('POST', a.token, later.user_code)).status).toBe(200);
            if (revoke === 'session')
                await revokeDeviceSession(sql, a.deviceSessionId, { userId: toUserId(a.id) });
            else await revokeDeviceSessionsForUserClient(sql, toUserId(a.id), 'phone');
            expect(await getRefreshTokenService().validate(tokens.refresh_token)).toBeNull();
            if (rotated.ok)
                expect(await getRefreshTokenService().validate(rotated.token)).toBeNull();
            expect((await run('GET', tokens.access_token, other.user_code)).status).toBe(401);
            expect((await redeem(later)).status).toBe(400);
        },
    );

    it('records a bearer creator even when requesting a different client id', async () => {
        const a = await account();
        const e = event('POST', a.token);
        e.request = new Request('http://localhost/oauth/device', {
            method: 'POST',
            headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ client_id: `other_${randomUUID()}`, device_name: 'Other app' }),
        });
        const res = await requestCode(e as Parameters<typeof requestCode>[0]);
        expect(res.status).toBe(200);
        const p = (await res.json()) as DeviceCodeResponse;
        codes.push(p.device_code);
        const record = await getDeviceCodeService().getByUserCode(p.user_code);
        expect(record).toHaveProperty('created_by_device_session_id', a.deviceSessionId);
        expect((await run('POST', a.token, p.user_code)).status).toBe(403);
    });

    it('refuses child exchange when parent revocation wins the session lock', async () => {
        const a = await account();
        const p = await pending();
        expect((await run('POST', a.token, p.user_code)).status).toBe(200);
        const blocker = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
        let release!: () => void;
        let acquired!: () => void;
        const locked = new Promise<void>((r) => {
            acquired = r;
        });
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const revocation = blocker.begin(async (tx) => {
            const sql = tx as unknown as postgres.Sql;
            await lockDeviceSessions(sql, [a.deviceSessionId]);
            await sql`UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE device_session_id = ${a.deviceSessionId}`;
            acquired();
            await gate;
        });
        let exchangeResult: Promise<Response> | undefined;
        try {
            await locked;
            exchangeResult = redeem(p);
            // A second connection must actually be waiting on the parent's
            // advisory lock; running two promises on one pool proves no race.
            await vi.waitFor(async () => {
                const [waiter] = await getTestDb()`SELECT count(*)::int AS n FROM pg_locks
                    WHERE locktype = 'advisory' AND NOT granted
                      AND classid = ((hashtextextended(${'oauth_dsess:' + a.deviceSessionId}, 0) >> 32) & 4294967295)::oid
                      AND objid = (hashtextextended(${'oauth_dsess:' + a.deviceSessionId}, 0) & 4294967295)::oid`;
                expect(waiter.n).toBeGreaterThan(0);
            });
        } finally {
            release();
            await revocation;
            await blocker.end();
        }
        expect((await exchangeResult!).status).toBe(400);
        const [count] = await getTestDb()`SELECT count(*)::int AS n FROM oauth_refresh_tokens
            WHERE approved_by_device_session_id = ${a.deviceSessionId}::uuid`;
        expect(count.n).toBe(0);
    });

    it('browser re-login cannot erase child lineage by reusing its device id', async () => {
        const a = await account();
        const p = await pending();
        const deviceId = randomUUID();
        await getTestDb()`UPDATE oauth_device_codes SET device_id = ${deviceId} WHERE user_code = ${p.user_code}`;
        expect((await run('POST', a.token, p.user_code)).status).toBe(200);
        const child = await getDeviceCodeService().getByUserCode(p.user_code);
        expect((await redeem(p)).status).toBe(200);
        const web = await pending();
        await getTestDb()`UPDATE oauth_device_codes SET device_id = ${deviceId} WHERE user_code = ${web.user_code}`;
        expect(await getDeviceCodeService().authorize(web.user_code, toUserId(a.id))).toBe(true);
        const webRecord = await getDeviceCodeService().getByUserCode(web.user_code);
        expect((await redeem(web)).status).toBe(200);
        const devices = await getUserDevices(getTestDb(), toUserId(a.id));
        expect(devices.find((d) => d.deviceSessionId === child!.device_session_id)).toHaveProperty(
            'approvedByDeviceName',
        );
        expect(
            devices.find((d) => d.deviceSessionId === webRecord!.device_session_id),
        ).not.toHaveProperty('approvedByDeviceName');
        await revokeDeviceSession(getTestDb(), a.deviceSessionId, { userId: toUserId(a.id) });
        const remaining = await getUserDevices(getTestDb(), toUserId(a.id));
        expect(remaining.map((d) => d.deviceSessionId)).toEqual([webRecord!.device_session_id]);
    });

    it('audits failed attempts without codes and bounds repeated denial logs', async () => {
        const a = await account();
        const log = vi.spyOn(audit, 'auditLog');
        const start = log.mock.calls.length;
        for (let i = 0; i < 8; i++) await run('POST', a.token, 'XXXX-YYYY');
        const denied = log.mock.calls
            .slice(start)
            .filter((c) => c[0] === 'oauth.device.approve_denied');
        expect(denied.length).toBeGreaterThan(0);
        expect(denied.length).toBeLessThan(8);
        expect(denied[0]).toEqual([
            'oauth.device.approve_denied',
            'device-approval',
            expect.objectContaining({ kind: 'bearer', credentialId: a.deviceSessionId }),
            expect.objectContaining({ reason: 'code_unavailable' }),
        ]);
        expect(JSON.stringify(denied)).not.toContain('XXXX');
        expect(JSON.stringify(denied)).not.toContain('YYYY');
        await vi.waitFor(async () => {
            const rows =
                await getTestDb()`SELECT principal_kind, credential_id, detail FROM audit_log
                WHERE action = 'oauth.device.approve_denied' AND credential_id = ${a.deviceSessionId}`;
            expect(rows.length).toBeGreaterThan(0);
            expect(rows[0]).toMatchObject({
                principal_kind: 'bearer',
                credential_id: a.deviceSessionId,
                detail: { reason: 'code_unavailable' },
            });
            expect(JSON.stringify(rows)).not.toContain('XXXX');
        });
    });

    it('truncates legacy oversized labels in successful audit details', async () => {
        const a = await account();
        const p = await pending();
        const sql = getTestDb();
        await sql`UPDATE oauth_device_codes SET client_id = ${'c'.repeat(200)}, device_name = ${'d'.repeat(100)} WHERE user_code = ${p.user_code}`;
        const log = vi.spyOn(audit, 'auditLog');
        expect((await run('POST', a.token, p.user_code)).status).toBe(200);
        const call = log.mock.calls.findLast((c) => c[0] === 'oauth.device.approve');
        expect(call?.[3]?.clientId).toBe('c'.repeat(128));
        expect(call?.[3]?.deviceName).toBe('d'.repeat(64));
    });

    it.each(['media:read'])('rejects %s tokens for lookup and approval', async (scope) => {
        const a = await account(scope);
        const p = await pending();
        expect((await run('GET', a.token, p.user_code)).status).toBe(403);
        expect((await run('POST', a.token, p.user_code)).status).toBe(403);
    });

    it.each(['pat_fake', 'svc_fake', 'stream_fake'])(
        'rejects invalid %s credentials',
        async (token) => {
            expect((await run('POST', token, 'ABCD-EFGH')).status).toBe(401);
        },
    );

    it('refuses valid PAT and impersonating service tokens on both endpoints', async () => {
        const a = await account();
        const p = await pending();
        const log = vi.spyOn(audit, 'auditLog');
        const pat = await getPatService().create({
            userId: toUserId(a.id),
            name: 'approval regression',
            scopes: ['write'],
            groups: [],
        });
        const service = await getServiceTokenService().create({
            name: `approval_${randomUUID()}`,
            createdBy: a.username,
            ownerUserId: a.id,
            actAsUser: toUserId(a.id),
            scopes: ['write'],
        });
        const start = log.mock.calls.length;
        for (const token of [pat.token, service.token]) {
            expect((await run('GET', token, p.user_code)).status).toBe(403);
            expect((await run('POST', token, p.user_code)).status).toBe(403);
        }
        const denied = log.mock.calls
            .slice(start)
            .filter((c) => c[0] === 'oauth.device.approve_denied');
        for (const kind of ['pat', 'service_token'])
            expect(denied).toContainEqual([
                'oauth.device.approve_denied',
                'device-approval',
                expect.objectContaining({ kind, credentialId: expect.any(String) }),
                expect.objectContaining({ reason: 'credential_forbidden' }),
            ]);
    });

    it('rejects expired tokens and disabled accounts', async () => {
        const a = await account();
        const p = await pending();
        const expired = await new SignJWT({
            username: a.username,
            client_id: 'phone',
            token_type: 'access',
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('Lumastra')
            .setExpirationTime(1)
            .sign(new TextEncoder().encode(config.JWT_SECRET));
        expect((await run('POST', expired, p.user_code)).status).toBe(401);
        await getTestDb()`UPDATE users SET disabled_at = NOW() WHERE id = ${a.id}::uuid`;
        expect((await run('POST', a.token, p.user_code)).status).toBe(401);
    });

    it.each(['expired', 'authorized', 'denied', 'unknown'])(
        'rejects %s codes on both methods',
        async (status) => {
            const a = await account();
            const p = await pending();
            if (status === 'expired')
                await getTestDb()`UPDATE oauth_device_codes SET expires_at = NOW() - INTERVAL '1 second' WHERE user_code = ${p.user_code}`;
            else if (status === 'unknown') await getDeviceCodeService().markAsUsed(p.device_code);
            else
                await getTestDb()`UPDATE oauth_device_codes SET status = ${status} WHERE user_code = ${p.user_code}`;
            expect((await run('GET', a.token, p.user_code)).status).toBe(404);
            expect((await run('POST', a.token, p.user_code)).status).toBe(404);
        },
    );

    it('denies explicitly and refuses subsequent approval', async () => {
        const a = await account();
        const p = await pending();
        expect((await run('POST', a.token, p.user_code, false)).status).toBe(200);
        expect((await getDeviceCodeService().getByUserCode(p.user_code))?.status).toBe('denied');
        expect((await run('POST', a.token, p.user_code)).status).toBe(404);
    });

    it('limits guessing across codes per user, shared between lookup and approval', async () => {
        const a = await account();
        for (let i = 0; i < 10; i++)
            expect(
                (await run(i % 2 ? 'GET' : 'POST', a.token, `ZZZZ-${String(i).padStart(4, '0')}`))
                    .status,
            ).toBe(404);
        const denied = await run('POST', a.token, 'ZZZZ-9999');
        expect(denied.status).toBe(429);
        expect(denied.headers.get('retry-after')).toBeTruthy();
    });

    it('keeps another user from exhausting a code budget', async () => {
        const p = await pending();
        for (let i = 0; i < 10; i++)
            expect(
                (
                    await run(
                        'GET',
                        (await account()).token,
                        i % 2 ? p.user_code : p.user_code.toLowerCase().replace('-', ''),
                    )
                ).status,
            ).toBe(200);
        expect((await run('POST', (await account()).token, p.user_code)).status).toBe(200);
    });

    it.each(['pat', 'service_token', 'stream_token', 'session', 'forward_auth'] as const)(
        'refuses resolved %s identities even with write authority',
        async (kind) => {
            const a = await account();
            const p = await pending();
            const e = event('POST', a.token, p.user_code);
            await resolveAuth(e, noop, true);
            e.locals.principal!.kind = kind;
            expect((await handlers.POST!(e)).status).toBe(403);
        },
    );

    it.each([undefined, 'something-legacy'])(
        'accepts the existing full legacy OAuth grant %s',
        async (scope) => {
            // account() defaults undefined to media; explicitly mint an absent claim here.
            const a = await account();
            const p = await pending();
            const token = await generateAccessToken({
                username: a.username,
                clientId: 'third-party-phone',
                groups: [],
                deviceSessionId: a.deviceSessionId,
                scope,
            });
            expect((await run('POST', token, p.user_code)).status).toBe(200);
        },
    );

    it('freshly refuses a user disabled after bearer authentication, on lookup and approval', async () => {
        const a = await account();
        const p = await pending();
        for (const method of ['GET', 'POST'] as const) {
            const e = event(method, a.token, p.user_code);
            await resolveAuth(e, noop, true);
            await getTestDb()`UPDATE users SET disabled_at = NOW() WHERE id = ${a.id}::uuid`;
            expect((await handlers[method]!(e)).status).toBe(401);
        }
        expect((await getDeviceCodeService().getByUserCode(p.user_code))?.status).toBe('pending');
    });

    it('refuses admin-class scopes on a bearer principal', async () => {
        const a = await account();
        const p = await pending();
        const e = event('POST', a.token, p.user_code);
        await resolveAuth(e, noop, true);
        e.locals.principal!.scopes.push('tokens:admin');
        expect((await handlers.POST!(e)).status).toBe(403);
    });

    it('requires a bearer header even if a user principal is present', async () => {
        const a = await account();
        const p = await pending();
        const e = event('POST', a.token, p.user_code);
        await resolveAuth(e, noop, true);
        e.request.headers.delete('authorization');
        expect((await handlers.POST!(e)).status).toBe(403);
        expect((await run('GET', undefined, p.user_code)).status).toBe(401);
        expect((await run('POST', undefined, p.user_code)).status).toBe(401);
    });

    it('requires an explicit boolean decision and bounds request bodies', async () => {
        const a = await account();
        const p = await pending();
        for (const body of [
            { user_code: p.user_code },
            { user_code: p.user_code, approve: 'true' },
            { user_code: p.user_code, approve: null },
        ]) {
            const e = event('POST', a.token, p.user_code);
            await resolveAuth(e, noop, true);
            e.request = new Request(e.url, {
                method: 'POST',
                headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            const response = await handlers.POST(e);
            expect(response.status).toBe(422);
            expect(response.headers.get('cache-control')).toBe('no-store');
        }
        const e = event('POST', a.token, p.user_code);
        await resolveAuth(e, noop, true);
        e.request = new Request(e.url, {
            method: 'POST',
            headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                user_code: p.user_code,
                approve: true,
                padding: 'x'.repeat(1024),
            }),
        });
        expect((await handlers.POST(e)).status).toBe(413);
        expect((await getDeviceCodeService().getByUserCode(p.user_code))?.status).toBe('pending');
    });

    it('validates the query for SvelteKit HEAD fallback through GET', async () => {
        const a = await account();
        const p = await pending();
        const e = event('GET', a.token, p.user_code);
        e.request = new Request(e.url, {
            method: 'HEAD',
            headers: { authorization: `Bearer ${a.token}` },
        });
        expect(await resolveAuth(e, noop, true)).toBeUndefined();
        expect((await handlers.GET(e)).status).toBe(200);
    });

    it('rejects delegation of a full user token', async () => {
        const a = await account();
        const p = await pending();
        const e = event('POST', a.token, p.user_code);
        await resolveAuth(e, noop, true);
        expect((await delegateToAdmin(e, handlers.POST!)).status).toBe(403);
    });
});

describe('atomic device-code exchange', () => {
    async function prepared() {
        const a = await account();
        const p = await pending();
        expect(await getDeviceCodeService().authorize(p.user_code, toUserId(a.id))).toBe(true);
        const row = (await getDeviceCodeService().getByDeviceCode(p.device_code))!;
        const call = async () => {
            const e = event('POST');
            e.request = new Request('http://localhost/oauth/token', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    device_code: p.device_code,
                    client_id: row.client_id,
                }),
            });
            return exchange(e as Parameters<typeof exchange>[0]);
        };
        return { a, p, row, call };
    }
    it('two polls that read the same approved code mint exactly one refresh token', async () => {
        const { row, call } = await prepared();
        const service = getDeviceCodeService();
        const original = service.getByDeviceCode.bind(service);
        let arrived = 0;
        let release!: () => void;
        const bothRead = new Promise<void>((resolve) => {
            release = resolve;
        });
        const read = vi.spyOn(service, 'getByDeviceCode').mockImplementation(async (code) => {
            const record = await original(code);
            if (++arrived === 2) release();
            await bothRead;
            return record;
        });
        const poll = vi.spyOn(service, 'isPollTooFast').mockResolvedValue(false);
        try {
            const results = await Promise.all([call(), call()]);
            expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
            const rows =
                await getTestDb()`SELECT id FROM oauth_refresh_tokens WHERE device_session_id = ${row.device_session_id}`;
            expect(rows).toHaveLength(1);
        } finally {
            read.mockRestore();
            poll.mockRestore();
        }
    });
    it('failed refresh-token issuance rolls back consumption and permits retry', async () => {
        const { row, p, call } = await prepared();
        const service = getDeviceCodeService();
        const poll = vi.spyOn(service, 'isPollTooFast').mockResolvedValue(false);
        const refresh = getRefreshTokenService();
        const create = refresh.create.bind(refresh);
        const mint = vi.spyOn(refresh, 'create').mockImplementationOnce(async (...args) => {
            await create(...args);
            throw new Error('issuance failed after refresh write');
        });
        try {
            expect((await call()).status).toBe(500);
            expect((await service.getByDeviceCode(p.device_code))?.status).toBe('authorized');
            expect(
                await getTestDb()`SELECT id FROM oauth_refresh_tokens WHERE device_session_id = ${row.device_session_id}`,
            ).toHaveLength(0);
            expect((await call()).status).toBe(200);
            const rows =
                await getTestDb()`SELECT id FROM oauth_refresh_tokens WHERE device_session_id = ${row.device_session_id}`;
            expect(rows).toHaveLength(1);
        } finally {
            mint.mockRestore();
            poll.mockRestore();
        }
    });
});

it('shares an IP budget across browser, bearer, approve, deny and page lookups', async () => {
    const accounts = [await account(), await account(), await account()];
    const ip = `198.19.${randomInt(256)}.${randomInt(1, 255)}`;
    function browserUser(a: { id: string; username: string }): App.Locals['user'] {
        return {
            userId: toUserId(a.id),
            username: a.username,
            groups: '',
            userGroups: [],
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            ownerIsAdmin: false,
            maxAgeRating: 12,
            isAgeRestricted: true,
            isModerator: false,
            liveTvPriority: 'low',
        };
    }
    async function attempt(i: number): Promise<Response> {
        const a = accounts[i % accounts.length];
        const code = `ZZZZ-${String(i).padStart(4, '0')}`;
        const variant = i % 5;
        const e = event(variant === 4 ? 'GET' : 'POST', a.token, code, variant !== 3);
        e.getClientAddress = () => ip;
        // Untrusted forwarded headers must not buy another budget.
        e.request.headers.set('x-forwarded-for', `203.0.113.${i + 1}`);
        if (variant < 2) {
            const method = variant === 0 ? 'POST' : 'DELETE';
            e.request = new Request('http://localhost/api/oauth/authorize', {
                method,
                headers: {
                    'content-type': 'application/json',
                    'x-forwarded-for': `203.0.113.${i + 1}`,
                },
                body: JSON.stringify({ user_code: code }),
            });
            e.locals.user = browserUser(a);
            return (method === 'POST' ? browserApprove : browserDeny)(e as never);
        }
        const denied = await resolveAuth(e, noop, true);
        return denied ?? handlers[variant === 4 ? 'GET' : 'POST']!(e);
    }
    for (let i = 0; i < 20; i++) expect((await attempt(i)).status).toBe(404);
    const limited = await attempt(20);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('content-type')).toContain('application/problem+json');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ status: 429, code: 'rate_limited' });
    const pageEvent = event('GET');
    pageEvent.url = new URL('http://localhost/device?code=ZZZZ-9999');
    const a = accounts[1];
    pageEvent.locals.user = browserUser(a);
    pageEvent.getClientAddress = () => ip;
    await expect(loadDevicePage(pageEvent as never)).rejects.toMatchObject({ status: 429 });
});
