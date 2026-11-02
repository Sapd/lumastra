// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Persistence hole (pre-release review 2026-10-21): `denyUnlessMayMint` only
 * checks that the caller HOLDS the scopes it asks for. A device JWT for
 * `scope=media` holds `write`, so a third-party app the user approved could
 * POST /api/v1/me/pats and mint a long-lived `write` PAT that keeps working
 * after the device / app is revoked. The same applied to a PAT or an act-as
 * service token minting PATs, and to the other credential mutations (linked
 * accounts, notification webhook set/clear, PAT revoke).
 *
 * Rule under test: credential mutations need an interactive session; every
 * bearer credential (device JWT, PAT, service token) is refused with 403
 * `forbidden` / `reason: session_required` BEFORE anything is written.
 *
 * Drives a REAL credential through resolveAuth() and the REAL mounted defs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { config, features } from '$lib/server/config.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { generateAccessToken } from '$lib/server/oauth/jwt.js';
import { getRefreshTokenService } from '$lib/server/oauth/refresh-token.service.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { getServiceTokenService } from '$lib/server/oauth/service-token.service.js';
import { mount } from '$lib/server/api/mount.js';
import { toUserId } from '$lib/shared/user-id.js';
import { def as patsDef } from '$lib/server/api/defs/user/pats.js';
import { def as patsIdDef } from '$lib/server/api/defs/user/pats-id.js';
import { def as linksProviderDef } from '$lib/server/api/defs/user/links/provider.js';
import { def as linksAuthorizeDef } from '$lib/server/api/defs/user/links/authorize.js';
import { def as grantsDef } from '$lib/server/api/defs/devices/grants/index.js';
import { def as grantsUsernameDef } from '$lib/server/api/defs/devices/grants/[username].js';
import { def as dataResetDef } from '$lib/server/api/defs/user/data-reset.js';
import { def as revokeAllDef } from '$lib/server/api/defs/devices/revoke-all.js';
import { def as webhookDef } from '$lib/server/api/defs/user/notification-webhook.js';

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

const noopMigration = async (): Promise<void> => undefined;
const patsRoute = mount(patsDef, { surface: 'v1' });
const patsIdRoute = mount(patsIdDef, { surface: 'v1' });
const linksProviderRoute = mount(linksProviderDef, { surface: 'v1' });
const linksAuthorizeRoute = mount(linksAuthorizeDef, { surface: 'v1' });
const webhookRoute = mount(webhookDef, { surface: 'v1' });
const grantsRoute = mount(grantsDef, { surface: 'v1' });
const grantsUsernameRoute = mount(grantsUsernameDef, { surface: 'v1' });
const dataResetRoute = mount(dataResetDef, { surface: 'v1' });
const revokeAllRoute = mount(revokeAllDef, { surface: 'v1' });

const usernames: string[] = [];

async function newUser(): Promise<{ id: string; username: string }> {
    const sql = getTestDb();
    const username = `itest_sess_${randomUUID().slice(0, 8)}`;
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username, groups) VALUES (${username}, ${[]}::text[]) RETURNING id
    `;
    usernames.push(username);
    return { id: row.id, username };
}

type Cred = { token: string; userId: string };

async function deviceCred(scope: string): Promise<Cred> {
    const u = await newUser();
    const deviceSessionId = randomUUID();
    await getRefreshTokenService().create({
        userId: toUserId(u.id),
        clientId: 'itest-client',
        groups: [],
        deviceSessionId,
    });
    const token = await generateAccessToken({
        username: u.username,
        clientId: 'itest-client',
        groups: [],
        deviceSessionId,
        scope,
    });
    return { token, userId: u.id };
}

async function patCred(): Promise<Cred> {
    const u = await newUser();
    const { token } = await getPatService().create({
        userId: toUserId(u.id),
        name: 'itest',
        scopes: ['read', 'write'],
        groups: [],
    });
    return { token, userId: u.id };
}

async function serviceCred(): Promise<Cred> {
    const u = await newUser();
    const { token } = await getServiceTokenService().create({
        name: 'itest-svc',
        createdBy: u.username,
        actAsUser: toUserId(u.id),
        scopes: ['read', 'write'],
    });
    return { token, userId: u.id };
}

function makeEvent(
    path: string,
    method: string,
    token: string,
    body?: unknown,
    params: Record<string, string> = {},
): RequestEvent {
    const u = new URL(`http://localhost${path}`);
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return {
        url: u,
        request: new Request(u, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
        route: { id: u.pathname },
        params,
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => undefined,
            delete: () => undefined,
            serialize: () => '',
        },
        fetch: async () => new Response(null),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
}

async function call(
    handler: (e: RequestEvent) => Promise<Response> | Response,
    event: RequestEvent,
): Promise<Response> {
    const denied = await resolveAuth(event, noopMigration, true);
    if (denied) return denied;
    return handler(event);
}

async function expectSessionRequired(res: Response): Promise<void> {
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('forbidden');
    expect(body.reason).toBe('session_required');
}

async function patCount(userId: string): Promise<number> {
    const sql = getTestDb();
    const [r] = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM personal_access_tokens
        WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
    `;
    return Number(r.n);
}

describe('credential mutations need an interactive session', () => {
    beforeAll(() => {
        vi.spyOn(features, 'deviceAuth', 'get').mockReturnValue(true);
        vi.spyOn(features, 'userPats', 'get').mockReturnValue(true);
        vi.spyOn(config, 'FEATURE_USER_PATS', 'get').mockReturnValue(true);
        vi.spyOn(config, 'FEATURE_USER_NOTIFICATION_WEBHOOKS', 'get').mockReturnValue(true);
        vi.spyOn(config, 'FEATURE_DEVICE_AUTH', 'get').mockReturnValue(true);
    });
    afterAll(async () => {
        const sql = getTestDb();
        await sql`DELETE FROM service_tokens WHERE LOWER(created_by) = ANY(${usernames.map((u) => u.toLowerCase())}::text[])`;
        await sql`DELETE FROM device_control_grants WHERE owner_user_id IN (SELECT id FROM users WHERE username = ANY(${usernames}::text[]))`;
        await sql`DELETE FROM personal_access_tokens WHERE user_id IN (SELECT id FROM users WHERE username = ANY(${usernames}::text[]))`;
        await sql`DELETE FROM oauth_refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE username = ANY(${usernames}::text[]))`;
        await sql`DELETE FROM users WHERE username = ANY(${usernames}::text[])`;
    });

    const makers: [string, () => Promise<Cred>][] = [
        ['device JWT scope=media', () => deviceCred('media')],
        ['PAT read+write', patCred],
        ['act-as service token', serviceCred],
    ];

    it.each(makers)('%s cannot mint a write PAT (persistence)', async (_n, make) => {
        const cred = await make();
        const before = await patCount(cred.userId);
        const res = await call(
            patsRoute.POST!,
            makeEvent('/api/v1/me/pats', 'POST', cred.token, {
                name: 'persist',
                scopes: ['write'],
            }),
        );
        await expectSessionRequired(res);
        expect(await patCount(cred.userId)).toBe(before);
    });

    it.each(makers)('%s cannot revoke a PAT', async (_n, make) => {
        const cred = await make();
        const victim = await getPatService().create({
            userId: toUserId(cred.userId),
            name: 'victim',
            scopes: ['read'],
            groups: [],
        });
        const res = await call(
            patsIdRoute.DELETE!,
            makeEvent('/api/v1/me/pats/' + victim.id, 'DELETE', cred.token, undefined, {
                id: String(victim.id),
            }),
        );
        await expectSessionRequired(res);
    });

    it.each(makers)('%s cannot change linked accounts', async (_n, make) => {
        const cred = await make();
        await expectSessionRequired(
            await call(
                linksProviderRoute.DELETE!,
                makeEvent('/api/v1/me/links/mal', 'DELETE', cred.token, undefined, {
                    provider: 'mal',
                }),
            ),
        );
        await expectSessionRequired(
            await call(
                linksAuthorizeRoute.POST!,
                makeEvent(
                    '/api/v1/me/links/mal/authorize',
                    'POST',
                    cred.token,
                    {},
                    { provider: 'mal' },
                ),
            ),
        );
    });

    it.each(makers)('%s cannot set or clear the notification webhook', async (_n, make) => {
        const cred = await make();
        await expectSessionRequired(
            await call(
                webhookRoute.POST!,
                makeEvent('/api/v1/me/notification-webhook', 'POST', cred.token, {
                    url: 'https://example.org/hook',
                }),
            ),
        );
        await expectSessionRequired(
            await call(
                webhookRoute.DELETE!,
                makeEvent('/api/v1/me/notification-webhook', 'DELETE', cred.token),
            ),
        );
    });

    it.each(makers)('%s cannot reset account data or sign out everywhere', async (_n, make) => {
        const cred = await make();
        await expectSessionRequired(
            await call(
                dataResetRoute.POST!,
                makeEvent('/api/v1/user/data/reset', 'POST', cred.token, {
                    action: 'music-history',
                    confirm: true,
                }),
            ),
        );
        await expectSessionRequired(
            await call(
                revokeAllRoute.POST!,
                makeEvent('/api/v1/devices/revoke-all', 'POST', cred.token),
            ),
        );
        // The credential is still alive: nothing was revoked.
        const sql = getTestDb();
        const [row] = await sql<{ n: string }[]>`
            SELECT COUNT(*)::text AS n FROM oauth_refresh_tokens
            WHERE user_id = ${cred.userId}::uuid AND revoked_at IS NULL
        `;
        if (_n.startsWith('device')) expect(Number(row.n)).toBeGreaterThan(0);
    });

    it.each(makers)('%s cannot add or remove a device control grant', async (_n, make) => {
        const cred = await make();
        const other = await newUser();
        const sql = getTestDb();
        const grants = async (): Promise<number> => {
            const [r] = await sql<{ n: string }[]>`
                SELECT COUNT(*)::text AS n FROM device_control_grants
                WHERE owner_user_id = ${cred.userId}::uuid
            `;
            return Number(r.n);
        };
        await expectSessionRequired(
            await call(
                grantsRoute.POST!,
                makeEvent('/api/v1/devices/grants', 'POST', cred.token, {
                    username: other.username,
                }),
            ),
        );
        expect(await grants()).toBe(0);

        // A pre-existing grant cannot be removed by a bearer either.
        await sql`
            INSERT INTO device_control_grants (owner_user_id, grantee_user_id)
            VALUES (${cred.userId}::uuid, ${other.id}::uuid)
        `;
        await expectSessionRequired(
            await call(
                grantsUsernameRoute.DELETE!,
                makeEvent(
                    '/api/v1/devices/grants/' + other.username,
                    'DELETE',
                    cred.token,
                    undefined,
                    {
                        username: other.username,
                    },
                ),
            ),
        );
        expect(await grants()).toBe(1);
        await sql`DELETE FROM device_control_grants WHERE owner_user_id = ${cred.userId}::uuid`;
    });

    it('a bearer can still LIST its own PATs (read-only)', async () => {
        const cred = await patCred();
        const res = await call(patsRoute.GET!, makeEvent('/api/v1/me/pats', 'GET', cred.token));
        expect(res.status).toBe(200);
    });
});
