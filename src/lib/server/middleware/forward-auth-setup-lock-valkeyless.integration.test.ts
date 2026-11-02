// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-PG seam test: on an install WITHOUT Valkey, an IdP demotion of the
 * forward-auth genesis admin leaves the first-run setup gate closed (security
 * review 6, ruling S-C5c-2).
 *
 * Since forward-auth syncs `users.groups` without Valkey, an IdP demotion now
 * also clears the groups column there. Before the setup lock, that stale
 * column was the only thing keeping the gate closed on a Valkey-less install;
 * with it gone the demotion left zero admins and reopened setup.
 *
 * Valkey is genuinely absent (CACHE_URL / TASK_CACHE_URL blanked before any
 * module snapshots them), as in forward-auth-valkeyless-group-sync.integration
 * .test.ts. The Valkey path and the other setup surfaces are covered by
 * services/setup-lock.integration.test.ts.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://lumastra:lumastra@127.0.0.1:5432/lumastra_setuplock_tests \
 *     npm run test:integration -- src/lib/server/middleware/forward-auth-setup-lock-valkeyless.integration.test.ts
 */

import { describe, it, beforeEach, expect, afterAll, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';

vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    process.env.CACHE_URL = '';
    process.env.TASK_CACHE_URL = '';
});

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

// A setup attempt that wrongly succeeds must not write the developer's settings.json.
vi.mock('$lib/server/config/config.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config/config.service.js')>()),
    saveConfig: vi.fn(async () => undefined),
}));

import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { resolveAuth, invalidateAdminExistsCache } from '$lib/server/middleware/forward-auth.js';
import { config } from '$lib/server/config.js';
import { adminExists } from '$lib/server/database/queries/users.queries.js';
import {
    completeForwardAuthSetup,
    completeNativeSetup,
} from '$lib/server/services/native-auth.service.js';

// Forward auth is opt-in (FORWARD_AUTH_ENABLED). config.ts snapshots process.env
// before this file's hoisted block runs, so turn it on per test instead.
beforeEach(() => {
    vi.spyOn(config, 'FORWARD_AUTH_ENABLED', 'get').mockReturnValue(true);
});

const ADMIN_GROUP = config.ADMIN_GROUPS[0] ?? 'admin';
const PREFIX = 'setuplock_vkless_';
const noopMigration = async (): Promise<void> => undefined;

async function realValkeyReady(): Promise<boolean> {
    const real = await vi.importActual<typeof import('$lib/server/cache/valkey.js')>(
        '$lib/server/cache/valkey.js',
    );
    return real.isValkeyReady();
}

async function userRow(username: string): Promise<{ is_admin: boolean; groups: string[] | null }> {
    const sql = getTestDb();
    const [row] = await sql<{ is_admin: boolean; groups: string[] | null }[]>`
        SELECT is_admin, groups FROM users WHERE username = ${username}
    `;
    return row;
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for: ${what}`);
}

async function forwardAuthRequest(username: string, groups: string): Promise<void> {
    const url = new URL('http://localhost/api/user');
    const headers = new Headers({ accept: 'application/json' });
    headers.set(config.USERHEADER, username);
    headers.set(config.GROUPHEADER, groups);
    const event = {
        request: new Request(url, { headers }),
        url,
        params: {},
        locals: {},
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
    } as unknown as RequestEvent;
    expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
    expect(event.locals.authMethod).toBe('forward_auth');
}

afterAll(async () => {
    await getTestDb()`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
});

describe('setup lock — Valkey-less forward-auth genesis-admin demotion', () => {
    it('an IdP demotion (empty groups header) clears users.groups and setup stays closed', async () => {
        const rogue = `${PREFIX}rogue_${randomUUID().slice(0, 8)}`;
        const sql = getTestDb();
        expect(await realValkeyReady()).toBe(false);

        // Admin-less, unlocked install; then first-run setup via forward-auth.
        await sql`DELETE FROM user_access_groups`;
        await sql`DELETE FROM access_groups WHERE is_system = false`;
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        await sql`DELETE FROM setup_lock`;
        invalidateAdminExistsCache();
        const genesis = `${PREFIX}${randomUUID().slice(0, 8)}`;
        expect(
            await completeForwardAuthSetup(sql, {
                username: genesis,
                groups: [ADMIN_GROUP],
                isAdmin: true,
            }),
        ).toEqual({ ok: true, oidcConfigDiscarded: false });

        // The IdP still asserts the admin group: groups land in the column.
        await forwardAuthRequest(genesis, ADMIN_GROUP);
        await waitFor(
            async () => ((await userRow(genesis)).groups ?? []).includes(ADMIN_GROUP),
            'admin group synced without Valkey',
        );

        // The IdP drops every group.
        await forwardAuthRequest(genesis, '');
        await waitFor(async () => !(await userRow(genesis)).is_admin, 'genesis demoted');
        await waitFor(
            async () => ((await userRow(genesis)).groups ?? []).length === 0,
            'users.groups cleared without Valkey',
        );

        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
        const setup = await completeNativeSetup(sql, {
            username: rogue,
            password: 'Correct-Horse-Battery-42!',
        });
        expect(setup).toMatchObject({ ok: false, status: 409 });
        expect(await realValkeyReady()).toBe(false);
    });
});
