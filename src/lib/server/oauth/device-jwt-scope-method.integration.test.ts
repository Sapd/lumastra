// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test (release review 2026-10-21, finding 1): a device JWT issued for
 * `scope=media:read` is read-only on /api/v1 like a `read` PAT: any non-GET/HEAD
 * request is refused with 403 `forbidden` / `reason: scope_insufficient` BEFORE
 * a `{kind:'user'}` def (device grants, device commands, revoke-all, ...) can
 * run. `media` and an absent scope (full grant) still write.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { features } from '$lib/server/config.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { generateAccessToken } from '$lib/server/oauth/jwt.js';
import { getRefreshTokenService } from '$lib/server/oauth/refresh-token.service.js';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

const noopMigration = async (): Promise<void> => undefined;
const createdUserIds: string[] = [];

async function deviceJwt(scope?: string): Promise<string> {
    const sql = getTestDb();
    const username = `itest_scope_${randomUUID().slice(0, 8)}`;
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username) VALUES (${username}) RETURNING id
    `;
    createdUserIds.push(row.id);
    const deviceSessionId = randomUUID();
    await getRefreshTokenService().create({
        userId: toUserId(row.id),
        clientId: 'itest-client',
        groups: [],
        deviceSessionId,
    });
    return generateAccessToken({
        username,
        clientId: 'itest-client',
        groups: [],
        deviceSessionId,
        scope,
    });
}

function makeEvent(path: string, method: string, token: string): RequestEvent {
    const u = new URL(`http://localhost${path}`);
    return {
        url: u,
        request: new Request(u, { method, headers: { authorization: `Bearer ${token}` } }),
        route: { id: u.pathname },
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

async function run(path: string, method: string, token: string) {
    const res = await resolveAuth(makeEvent(path, method, token), noopMigration, true);
    if (!res) return { status: 200 as number, body: null as Record<string, unknown> | null };
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('device JWT scope vs HTTP method on /api/v1', () => {
    beforeAll(() => {
        vi.spyOn(features, 'deviceAuth', 'get').mockReturnValue(true);
    });
    afterAll(async () => {
        const sql = getTestDb();
        await sql`DELETE FROM oauth_refresh_tokens WHERE user_id = ANY(${createdUserIds}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${createdUserIds}::uuid[])`;
    });

    it.each([
        ['POST', '/api/v1/devices/grants'],
        ['POST', '/api/v1/devices/revoke-all'],
        ['DELETE', '/api/v1/devices/grants/someone'],
        ['POST', `/api/v1/devices/${randomUUID()}/commands`],
    ])('media:read cannot %s %s', async (method, path) => {
        const { status, body } = await run(path, method, await deviceJwt('media:read'));
        expect(status).toBe(403);
        expect(body?.code).toBe('forbidden');
        expect(body?.reason).toBe('scope_insufficient');
    });

    it('media:read can still GET', async () => {
        expect((await run('/api/v1/devices', 'GET', await deviceJwt('media:read'))).status).toBe(
            200,
        );
    });

    it.each([['media'], [undefined], ['something-unknown']])(
        'scope %s (full grant) is not stopped by the method gate',
        async (scope) => {
            const { status } = await run(
                '/api/v1/devices/grants',
                'POST',
                await deviceJwt(scope),
            );
            expect(status).toBe(200);
        },
    );
});
