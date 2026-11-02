// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Real credentials → resolveAuth → mounted app/web handlers → PostgreSQL. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { config, features } from '$lib/server/config.js';
import { applyActivitySharingDefault } from '$lib/server/database/queries/activity-sharing.queries.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { generateAccessToken } from '$lib/server/oauth/jwt.js';
import { getRefreshTokenService } from '$lib/server/oauth/refresh-token.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import {
    StreamPrivacyResponseSchema,
    type StreamPrivacyResponse,
} from '$lib/schemas/api-user-responses.js';
import { GET, PATCH } from '../../../../../routes/api/v1/me/privacy/+server.js';
import { POST } from '../../../../../routes/api/user/stream-privacy/+server.js';

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

interface TestUser {
    id: string;
    username: string;
    token: string;
}
const users: TestUser[] = [];
let alice: TestUser;
let bob: TestUser;
let readPat: string;

async function newUser(): Promise<TestUser> {
    const username = `itest_privacy_${randomUUID().slice(0, 8)}`;
    const [row] = await getTestDb()<{ id: string }[]>`
        INSERT INTO users (username, groups) VALUES (${username}, ${[]}::text[]) RETURNING id
    `;
    const { token } = await getPatService().create({
        userId: toUserId(row.id),
        name: 'privacy-test',
        scopes: ['write'],
        groups: [],
    });
    const user = { id: row.id, username, token };
    users.push(user);
    return user;
}

function event(method: string, token?: string, body?: unknown, query = ''): RequestEvent {
    const url = new URL(`http://localhost/api/v1/me/privacy${query}`);
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return {
        url,
        request: new Request(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
        route: { id: '/api/v1/me/privacy' },
        params: {},
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
    method: 'GET' | 'PATCH',
    token?: string,
    body?: unknown,
    query = '',
): Promise<Response> {
    const request = event(method, token, body, query);
    const denied = await resolveAuth(request, async () => undefined, true);
    if (denied) return denied;
    return (method === 'GET' ? GET! : PATCH!)(request);
}

async function read(token = alice.token): Promise<StreamPrivacyResponse> {
    const response = await call('GET', token);
    expect(response.status).toBe(200);
    return StreamPrivacyResponseSchema.parse(await response.json());
}

async function deviceToken(scope: string): Promise<string> {
    const deviceSessionId = randomUUID();
    await getRefreshTokenService().create({
        userId: toUserId(alice.id),
        clientId: 'privacy-test',
        groups: [],
        deviceSessionId,
    });
    return generateAccessToken({
        username: alice.username,
        clientId: 'privacy-test',
        groups: [],
        deviceSessionId,
        scope,
    });
}

describe('/api/v1/me/privacy', () => {
    beforeAll(async () => {
        vi.spyOn(features, 'deviceAuth', 'get').mockReturnValue(true);
        vi.spyOn(config, 'FEATURE_DEVICE_AUTH', 'get').mockReturnValue(true);
        alice = await newUser();
        bob = await newUser();
        readPat = (
            await getPatService().create({
                userId: toUserId(alice.id),
                name: 'privacy-read',
                scopes: ['read'],
                groups: [],
            })
        ).token;
    });
    beforeEach(async () => {
        await getTestDb()`UPDATE users SET hide_streams = true, share_listening_activity = false,
            share_audiobook_activity = false, privacy_prefs_updated_at = NULL,
            sharing_explicitly_set_by_user = false
            WHERE id = ANY(${users.map((user) => user.id)}::uuid[])`;
    });
    afterAll(async () => {
        const ids = users.map((user) => user.id);
        const sql = getTestDb();
        await sql`DELETE FROM personal_access_tokens WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM oauth_refresh_tokens WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
        vi.restoreAllMocks();
    });

    it('GET/PATCH round-trips all three preferences for the caller with a PAT', async () => {
        expect(await read()).toMatchObject({
            hideFromOthers: true,
            shareListeningActivity: false,
            shareAudiobookActivity: false,
        });
        const response = await call('PATCH', alice.token, {
            hideFromOthers: false,
            shareListeningActivity: true,
            shareAudiobookActivity: true,
        });
        expect(response.status).toBe(200);
        const updated = StreamPrivacyResponseSchema.parse(await response.json());
        expect(updated).toMatchObject({
            hideFromOthers: false,
            shareListeningActivity: true,
            shareAudiobookActivity: true,
        });
        expect(await read()).toEqual(updated);
        const [row] = await getTestDb()<{ saved: boolean }[]>`
            SELECT privacy_prefs_updated_at IS NOT NULL AS saved, sharing_explicitly_set_by_user FROM users WHERE id = ${alice.id}::uuid
        `;
        expect(row.saved).toBe(true);
    });

    it.each([
        { hideFromOthers: true },
        { hideFromOthers: false },
        { shareListeningActivity: true },
        { shareListeningActivity: false },
        { shareAudiobookActivity: true },
        { shareAudiobookActivity: false },
    ])(
        'protects the public self-service choice %j from later default applications',
        async (body) => {
            expect((await call('PATCH', alice.token, body)).status).toBe(200);
            const sql = getTestDb();
            const [chosen] = await sql`SELECT * FROM users WHERE id = ${alice.id}::uuid`;
            expect(chosen.sharing_explicitly_set_by_user).toBe(true);
            expect(chosen.privacy_prefs_updated_at).not.toBeNull();
            // Apply both defaults to an exact copy of the saved row, isolated from
            // other integration users. The production bulk query sees the same marker.
            await sql.begin(async (tx) => {
                await tx`CREATE TEMP TABLE users (LIKE public.users INCLUDING ALL) ON COMMIT DROP`;
                await tx`INSERT INTO users SELECT * FROM public.users WHERE id = ${alice.id}::uuid`;
                expect(await applyActivitySharingDefault(tx, true)).toBe(0);
                expect(await applyActivitySharingDefault(tx, false)).toBe(0);
                expect(await tx`SELECT * FROM users WHERE id = ${alice.id}::uuid`).toEqual([
                    chosen,
                ]);
            });
        },
    );

    it('partial updates (including false) keep every omitted field and preserve a hidden audiobook opt-in', async () => {
        for (const body of [
            { shareListeningActivity: true },
            { shareAudiobookActivity: true },
            { shareListeningActivity: false },
        ]) {
            expect((await call('PATCH', alice.token, body)).status).toBe(200);
        }
        expect(await read()).toMatchObject({
            hideFromOthers: true,
            shareListeningActivity: false,
            shareAudiobookActivity: true,
        });
    });

    it.each([
        {},
        undefined,
        { username: 'someone' },
        { hideFromOthers: null },
        { shareAudiobookActivity: 'true' },
    ])('rejects an empty or invalid update %j with 422 before writing', async (body) => {
        const before = await read();
        const response = await call('PATCH', alice.token, body);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: 'validation_failed' });
        expect(await read()).toEqual(before);
        const [row] = await getTestDb()<{ saved: boolean }[]>`
                SELECT privacy_prefs_updated_at IS NOT NULL AS saved, sharing_explicitly_set_by_user FROM users WHERE id = ${alice.id}::uuid
            `;
        expect(row.saved).toBe(false);
        expect(row).toMatchObject({ sharing_explicitly_set_by_user: false });
    });

    it('cannot read or update another user through query/body selectors', async () => {
        await getTestDb()`UPDATE users SET hide_streams = false, share_listening_activity = true,
            share_audiobook_activity = true WHERE id = ${bob.id}::uuid`;
        const otherBefore = await read(bob.token);
        const selected = await call(
            'GET',
            alice.token,
            undefined,
            `?username=${bob.username}&userId=${bob.id}`,
        );
        expect(await selected.json()).toEqual(await read());
        const response = await call(
            'PATCH',
            alice.token,
            {
                hideFromOthers: false,
                username: bob.username,
                userId: bob.id,
            },
            `?username=${bob.username}`,
        );
        expect(response.status).toBe(200);
        expect(await read(bob.token)).toEqual(otherBefore);
        expect((await read()).hideFromOthers).toBe(false);
    });

    it('allows an actual device media token to GET and PATCH without an interactive session', async () => {
        const token = await deviceToken('media');
        expect(await read(token)).toEqual(await read());
        const response = await call('PATCH', token, { hideFromOthers: false });
        expect(response.status).toBe(200);
        expect((await read(token)).hideFromOthers).toBe(false);
    });

    it.each(['PAT', 'device'])(
        'applies the global v1 method restriction to a read-only %s',
        async (kind) => {
            const token = kind === 'PAT' ? readPat : await deviceToken('media:read');
            const before = await read(token);
            const response = await call('PATCH', token, { hideFromOthers: false });
            expect(response.status).toBe(403);
            expect(await read()).toEqual(before);
        },
    );

    it('requires authentication', async () => {
        expect((await call('GET')).status).toBe(401);
        expect((await call('PATCH', undefined, { hideFromOthers: false })).status).toBe(401);
    });

    it('keeps the internal web POST working against the same stored preferences', async () => {
        const request = event('POST', undefined, { shareAudiobookActivity: true });
        request.locals.principal = buildPrincipal({
            kind: 'session',
            userId: toUserId(alice.id),
            username: alice.username,
            userGroups: [],
            sessionIsAdmin: false,
        });
        const response = await POST!(request);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(await read());
        expect((await read()).shareAudiobookActivity).toBe(true);
    });
});
