// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-PG test of what /setup shows for each setup-lock state (security review
 * 6, ruling S-C5c-2): the wizard while unlocked and admin-less, the "setup is
 * locked" page while locked and admin-less, and the existing redirect home
 * once an admin exists. Drives both route loads unmocked.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://lumastra:lumastra@127.0.0.1:5432/lumastra_setuplock_tests \
 *     npm run test:integration -- src/routes/setup/setup-locked-page.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../tests/integration/setup/test-database.js';
import { appPath } from '$lib/shared/api-urls.js';
import { markSetupCompleted } from '$lib/server/database/queries/users.queries.js';
import { load as setupLoad } from './+page.server.js';
import { load as lockedLoad } from './locked/+page.server.js';

const PREFIX = 'setuplock_page_';
let sql: postgres.Sql;

function fakeEvent(
    path: string,
    opts: { host?: string; peer?: string; headers?: Record<string, string> } = {},
): never {
    // adapter-node builds event.url from the client's Host header (no ORIGIN set).
    const url = new URL(`http://${opts.host ?? 'localhost'}${path}`);
    return {
        request: new Request(url, { headers: opts.headers }),
        url,
        params: {},
        locals: {},
        route: { id: path },
        cookies: { get: () => undefined, getAll: () => [] },
        getClientAddress: () => opts.peer ?? '10.9.8.7',
        setHeaders: () => undefined,
        depends: () => undefined,
    } as never;
}

/** The load's outcome: the redirect location, or 'rendered'. */
async function outcome(run: () => unknown): Promise<string> {
    try {
        await run();
        return 'rendered';
    } catch (e) {
        if (isRedirect(e)) return e.location;
        throw e;
    }
}

async function state(opts: { locked: boolean; admin: boolean }): Promise<void> {
    await sql`DELETE FROM user_access_groups`;
    await sql`DELETE FROM access_groups WHERE is_system = false`;
    await sql`UPDATE users SET is_admin = false, groups = NULL`;
    await sql`DELETE FROM setup_lock`;
    if (opts.admin) {
        await sql`
            INSERT INTO users (username, is_admin, admin_pinned)
            VALUES (${`${PREFIX}${randomUUID().slice(0, 8)}`}, true, true)
        `;
    }
    if (opts.locked) await markSetupCompleted(sql, null);
}

beforeAll(() => {
    sql = getTestDb();
});

beforeEach(async () => {
    await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
});

afterAll(async () => {
    await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
});

describe('/setup and /setup/locked for each setup-lock state', () => {
    it('unlocked, no admin: /setup renders the wizard; /setup/locked sends to /setup', async () => {
        await state({ locked: false, admin: false });
        expect(await outcome(() => setupLoad(fakeEvent('/setup')))).toBe('rendered');
        expect(await outcome(() => lockedLoad(fakeEvent('/setup/locked')))).toBe(appPath('/setup'));
    });

    it('locked, no admin: /setup sends to /setup/locked, which renders', async () => {
        await state({ locked: true, admin: false });
        expect(await outcome(() => setupLoad(fakeEvent('/setup')))).toBe(appPath('/setup/locked'));
        expect(await outcome(() => lockedLoad(fakeEvent('/setup/locked')))).toBe('rendered');
    });

    it('locked, admin exists: both keep the existing redirect home', async () => {
        await state({ locked: true, admin: true });
        expect(await outcome(() => setupLoad(fakeEvent('/setup')))).toBe(appPath('/'));
        expect(await outcome(() => lockedLoad(fakeEvent('/setup/locked')))).toBe(appPath('/'));
    });
});

describe('/setup config-directory disclosure (pre-admin, anonymous)', () => {
    async function configDir(event: never): Promise<string | null> {
        const data = (await setupLoad(event)) as { configDir: string | null };
        return data.configDir;
    }

    it('a remote visitor cannot unlock it with a forged loopback Host header', async () => {
        await state({ locked: false, admin: false });
        for (const host of ['localhost', '127.0.0.1', '127.evil.example']) {
            expect(await configDir(fakeEvent('/setup', { host, peer: '10.9.8.7' }))).toBeNull();
        }
    });

    it('a loopback peer behind a same-host reverse proxy is still remote', async () => {
        await state({ locked: false, admin: false });
        const event = fakeEvent('/setup', {
            peer: '127.0.0.1',
            headers: { 'x-forwarded-for': '198.51.100.20' },
        });
        expect(await configDir(event)).toBeNull();
    });

    it('CONTROL: a direct loopback request (curl localhost on the host) sees it', async () => {
        await state({ locked: false, admin: false });
        for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
            expect(await configDir(fakeEvent('/setup', { peer }))).toEqual(expect.any(String));
        }
    });
});
