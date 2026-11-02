// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A service token minted BY a service token used to be stored with
 * `created_by = 'service:<minter>'`. That is not a user, so
 * `ServiceTokenService.isCreatorActive()` rejected every request with 401
 * "Invalid or expired service token".
 *
 * Now the child is owned by the minting token's owner (the human behind it),
 * `created_via_token_id` records the minter, and the child can never get more
 * than the minter (scopes, paths, methods, IPs, forceNonAdmin, expiry,
 * actAsUser).
 *
 * Drives the real chain end to end: resolveAuth() (forward-auth) ->
 * mount(def, {surface:'v1'}) for the mint, then resolveAuth() + a real v1 def
 * for the child. Only `$app/environment` and the `features.deviceAuth` getter
 * are stubbed (same as cross-surface-bearer.seam.integration.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll, vi, type MockInstance } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getServiceTokenService } from '$lib/server/oauth/service-token.service.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { mount } from '$lib/server/api/mount.js';
import { config, features } from '$lib/server/config.js';
import { def as serviceTokensDef } from './index.js';
import { def as changeTimelineDef } from '$lib/server/api/defs/admin/system/change-timeline.js';

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

const svc = getServiceTokenService();
const ADMIN_GROUP = config.ADMIN_GROUPS[0] ?? 'admin';
const MINT_URL = 'http://localhost/api/v1/service-tokens';
const ALLOWED_PATH = '/api/v1/admin/system/change-timeline';

const v1ServiceTokens = mount(serviceTokensDef, { surface: 'v1' });
const v1ChangeTimeline = mount(changeTimelineDef, { surface: 'v1' });
const noopMigration = async (): Promise<void> => undefined;

const createdUsernames = new Set<string>();

async function insertUser(opts: { prefix: string; isAdmin: boolean }): Promise<{
    id: string;
    username: string;
}> {
    const sql = getTestDb();
    const username = `itest_mint_${opts.prefix}_${randomUUID().slice(0, 8)}`;
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${username}, ${opts.isAdmin}, ${opts.isAdmin},
                ${opts.isAdmin ? [ADMIN_GROUP] : ['users']}::text[])
        RETURNING id
    `;
    createdUsernames.add(username);
    return { id: row.id, username };
}

function makeEvent(opts: {
    url: string;
    method?: string;
    token: string;
    body?: unknown;
}): RequestEvent {
    const url = new URL(opts.url);
    const headers = new Headers({ authorization: `Bearer ${opts.token}` });
    if (opts.body !== undefined) headers.set('content-type', 'application/json');
    const request = new Request(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return {
        route: { id: url.pathname },
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
        request,
        url,
        params: {},
        locals: {},
    } as unknown as RequestEvent;
}

/** POST /api/v1/service-tokens with `token` as the caller. */
async function mintVia(token: string, body: Record<string, unknown>): Promise<Response> {
    const event = makeEvent({ url: MINT_URL, method: 'POST', token, body });
    const denied = await resolveAuth(event, noopMigration, true);
    if (denied) return denied;
    return v1ServiceTokens.POST!(event);
}

/** GET `path` with `token`: resolveAuth, then the change-timeline def when allowed. */
async function getWith(
    token: string,
    path: string,
): Promise<{ event: RequestEvent; response: Response }> {
    const event = makeEvent({ url: `http://localhost${path}`, token });
    const denied = await resolveAuth(event, noopMigration, true);
    if (denied) return { event, response: denied };
    if (path !== ALLOWED_PATH) return { event, response: new Response(null, { status: 200 }) };
    return { event, response: await v1ChangeTimeline.GET!(event) };
}

async function rowOf(id: number): Promise<{
    created_by: string;
    owner_user_id: string | null;
    created_via_token_id: number | null;
}> {
    const sql = getTestDb();
    const [row] = await sql<
        { created_by: string; owner_user_id: string | null; created_via_token_id: number | null }[]
    >`
        SELECT created_by, owner_user_id, created_via_token_id FROM service_tokens WHERE id = ${id}
    `;
    return row;
}

async function mintedId(res: Response): Promise<{ id: number; token: string }> {
    const body = (await res.json()) as { id: number; token: string };
    // The 201 contract: `id` is the numeric serial.
    expect(typeof body.id).toBe('number');
    return { id: body.id, token: body.token };
}

let deviceAuthSpy: MockInstance;

beforeAll(() => {
    deviceAuthSpy = vi.spyOn(features, 'deviceAuth', 'get').mockReturnValue(true);
});

afterAll(async () => {
    deviceAuthSpy.mockRestore();
    const sql = getTestDb();
    const usernames = Array.from(createdUsernames);
    if (usernames.length === 0) return;
    await sql`
        DELETE FROM service_tokens
        WHERE LOWER(created_by) = ANY(${usernames.map((u) => u.toLowerCase())}::text[])
           OR act_as_user IN (SELECT id FROM users WHERE username = ANY(${usernames}::text[]))
    `;
    await sql`DELETE FROM users WHERE username = ANY(${usernames}::text[])`;
});

describe('service token minted by a service token', () => {
    let owner: { id: string; username: string };
    let reader: { id: string; username: string };
    let minter: { id: number; token: string };

    beforeAll(async () => {
        owner = await insertUser({ prefix: 'owner', isAdmin: true });
        reader = await insertUser({ prefix: 'reader', isAdmin: false });
        minter = await svc.create({
            name: `test-minter-${randomUUID().slice(0, 6)}`,
            createdBy: owner.username,
            scopes: ['admin'],
        });
    });

    it('is owned by the minter’s human owner and works on its allowed path', async () => {
        const res = await mintVia(minter.token, {
            name: 'test-integrations',
            scopes: ['admin'],
            allowedPathPrefixes: [ALLOWED_PATH],
            allowedMethods: ['GET'],
        });
        expect(res.status).toBe(201);
        const child = await mintedId(res);

        expect(await rowOf(child.id)).toEqual({
            created_by: owner.username,
            owner_user_id: owner.id,
            created_via_token_id: minter.id,
        });

        const inside = await getWith(child.token, ALLOWED_PATH);
        expect(inside.response.status).toBe(200);
        expect(inside.event.locals.principal?.userId).toBe(owner.id);

        const outside = await getWith(child.token, '/api/v1/admin/system/other');
        expect(outside.response.status).toBe(403);
    });

    it('an impersonating read child acts as its target', async () => {
        const res = await mintVia(minter.token, {
            name: 'test-catalog',
            scopes: ['read'],
            actAsUserId: reader.id,
            allowedPathPrefixes: ['/api/v1/search', '/api/v1/media/'],
            allowedMethods: ['GET'],
        });
        expect(res.status).toBe(201);
        const child = await mintedId(res);
        expect((await rowOf(child.id)).created_by).toBe(owner.username);
        expect((await rowOf(child.id)).owner_user_id).toBe(owner.id);

        const inside = await getWith(child.token, '/api/v1/media/abc');
        expect(inside.response.status).toBe(200);
        expect(inside.event.locals.principal?.userId).toBe(reader.id);
        expect(inside.event.locals.principal?.isAdmin).toBe(false);

        const outside = await getWith(child.token, '/api/v1/series/abc');
        expect(outside.response.status).toBe(403);
    });

    it('lists the child as "created by <owner> via token <minter>"', async () => {
        const res = await mintVia(minter.token, { name: 'listed', scopes: ['read'] });
        const child = await mintedId(res);
        const item = (await svc.listAll()).find((t) => t.id === child.id);
        expect(item?.owner?.userId).toBe(owner.id);
        expect(item?.createdVia?.tokenId).toBe(minter.id);
        expect(item?.createdVia?.tokenName).toBe((await svc.getById(minter.id))?.name);
        expect((await svc.getById(child.id))?.createdVia?.tokenId).toBe(minter.id);
    });

    describe('escalation is rejected', () => {
        let restricted: { id: number; token: string };

        beforeAll(async () => {
            restricted = await svc.create({
                name: `restricted-${randomUUID().slice(0, 6)}`,
                createdBy: owner.username,
                scopes: ['admin'],
                allowedPathPrefixes: ['/api/v1/service-tokens', '/api/v1/admin/system/'],
                allowedMethods: ['GET', 'POST'],
                expiresInDays: 30,
            });
        });

        const within = {
            scopes: ['read'],
            allowedPathPrefixes: [ALLOWED_PATH],
            allowedMethods: ['GET'],
            expiresInDays: 7,
        };

        it('control: a child inside the envelope is minted', async () => {
            const res = await mintVia(restricted.token, { name: 'ok', ...within });
            expect(res.status).toBe(201);
        });

        it.each([
            ['no path restriction', { allowedPathPrefixes: undefined }],
            ['a path outside the minter', { allowedPathPrefixes: ['/api/v1/media/'] }],
            ['no method restriction', { allowedMethods: undefined }],
            ['a method the minter lacks', { allowedMethods: ['GET', 'DELETE'] }],
            ['no expiry', { expiresInDays: undefined }],
            ['an expiry after the minter’s', { expiresInDays: 60 }],
        ])('%s -> 403, nothing minted', async (_label, override) => {
            const sql = getTestDb();
            const [{ n: before }] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM service_tokens WHERE created_via_token_id = ${restricted.id}
            `;
            const res = await mintVia(restricted.token, { name: 'esc', ...within, ...override });
            expect(res.status).toBe(403);
            const [{ n: after }] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM service_tokens WHERE created_via_token_id = ${restricted.id}
            `;
            expect(after).toBe(before);
        });

        it('a minter without the admin scope cannot mint', async () => {
            const writer = await svc.create({
                name: `writer-${randomUUID().slice(0, 6)}`,
                createdBy: owner.username,
                scopes: ['write'],
            });
            const res = await mintVia(writer.token, { name: 'esc', scopes: ['read'] });
            expect(res.status).toBe(403);
        });
    });

    describe('actAsUser', () => {
        let adminTarget: { id: string; username: string };
        let impersonating: { id: number; token: string };

        beforeAll(async () => {
            adminTarget = await insertUser({ prefix: 'admintarget', isAdmin: true });
            impersonating = await svc.create({
                name: `imp-${randomUUID().slice(0, 6)}`,
                createdBy: owner.username,
                scopes: ['admin'],
                actAsUser: toUserId(adminTarget.id),
            });
        });

        it('an impersonating minter may mint for its own target', async () => {
            const res = await mintVia(impersonating.token, {
                name: 'same-target',
                scopes: ['read'],
                actAsUserId: adminTarget.id,
            });
            expect(res.status).toBe(201);
            const child = await mintedId(res);
            expect(await rowOf(child.id)).toEqual({
                created_by: owner.username,
                owner_user_id: owner.id,
                created_via_token_id: impersonating.id,
            });
        });

        it('an impersonating minter may not mint for another user', async () => {
            const res = await mintVia(impersonating.token, {
                name: 'other-target',
                scopes: ['read'],
                actAsUserId: reader.id,
            });
            expect(res.status).toBe(403);
        });

        it('an impersonating minter may not mint a non-impersonating (owner) token', async () => {
            const res = await mintVia(impersonating.token, { name: 'owner', scopes: ['read'] });
            expect(res.status).toBe(403);
        });

        it('an unknown actAsUser is still a validation error', async () => {
            const res = await mintVia(minter.token, {
                name: 'ghost',
                scopes: ['read'],
                actAsUserId: randomUUID(),
            });
            expect(res.status).toBe(422);
        });
    });

    it('a token minted by a user is unchanged (no created_via_token_id)', async () => {
        const direct = await svc.create({
            name: 'direct',
            createdBy: owner.username,
            scopes: ['read'],
        });
        expect(await rowOf(direct.id)).toEqual({
            created_by: owner.username,
            owner_user_id: owner.id,
            created_via_token_id: null,
        });
        const item = await svc.getById(direct.id);
        expect(item?.createdVia).toBeNull();
        const used = await getWith(direct.token, '/api/v1/media/abc');
        expect(used.response.status).toBe(200);
    });

    describe('integrations:read (API package 15)', () => {
        it('an admin minter cannot mint integrations:read (it does not hold the grant)', async () => {
            const sql = getTestDb();
            const [{ n: before }] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM service_tokens WHERE created_via_token_id = ${minter.id}
            `;
            const res = await mintVia(minter.token, {
                name: 'integrations',
                scopes: ['integrations:read'],
            });
            expect(res.status).toBe(403);
            const [{ n: after }] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM service_tokens WHERE created_via_token_id = ${minter.id}
            `;
            expect(after).toBe(before);
        });

        it('authenticates only under /api/v1/integrations/, carrying the owner verdict', async () => {
            const token = await svc.create({
                name: `integrations-${randomUUID().slice(0, 6)}`,
                createdBy: owner.username,
                scopes: ['integrations:read'],
            });

            const inside = await getWith(token.token, '/api/v1/integrations/watch-history');
            expect(inside.response.status).toBe(200);
            expect(inside.event.locals.principal?.tokenOwnerIsAdmin).toBe(true);
            expect(inside.event.locals.principal?.isAdmin).toBe(false);

            for (const path of ['/api/v1/me/stats', '/api/v1/media/abc', ALLOWED_PATH]) {
                const outside = await getWith(token.token, path);
                expect(outside.response.status).toBe(403);
            }
        });

        it('loses the owner verdict when the owner is no longer admin', async () => {
            const demoted = await insertUser({ prefix: 'demoted', isAdmin: false });
            const token = await svc.create({
                name: `integrations-demoted-${randomUUID().slice(0, 6)}`,
                createdBy: demoted.username,
                scopes: ['integrations:read'],
            });
            const res = await getWith(token.token, '/api/v1/integrations/upcoming');
            expect(res.event.locals.principal?.tokenOwnerIsAdmin).toBe(false);
        });
    });
});
