// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-PG seam test: forward-auth's throttled `users.groups` sync when the IdP
 * removes EVERY group from a user.
 *
 * Authentik's outpost always sets its groups header, to `groups.join('|')` —
 * so a user with no groups arrives with the header PRESENT and EMPTY (Traefik
 * `forwardAuth` copies it through verbatim). The sync used to skip an empty
 * list, so `users.groups` kept the last non-empty value forever and every
 * token path that reads the column (`resolveTokenUserAccess`,
 * `resolveOwnerAdminStatus`) kept the old library groups, and the admin
 * verdict when one of them was an ADMIN_GROUPS entry.
 *
 * The control is the hard constraint: an ABSENT groups header (a proxy that
 * does not forward it, or a route that strips it) must never write. Clearing
 * there would drop age-cap group memberships and fail open.
 *
 * Drives the REAL `resolveAuth()` with a trusted proxy peer, real Postgres and
 * real Valkey (the sync's L2 hash cache, without which it never writes).
 * Only `$app/environment` is mocked, to reach the non-dev forward-auth path.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://lumastra:lumastra@127.0.0.1:5432/lumastra_emptyhdr_tests \
 *     npm run test:integration -- src/lib/server/middleware/forward-auth-empty-groups-header.integration.test.ts
 */

import { describe, it, beforeEach, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';

// client-ip.ts snapshots TRUSTED_PROXY_IPS at module load — set it before any
// import resolves so the 127.0.0.1 peer below is the trusted reverse proxy.
vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
});

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access.js';
import { resolveOwnerAdminStatus } from '$lib/server/auth/resolve-owner-admin-status.js';
import { connectValkey, cacheDel } from '$lib/server/cache/valkey.js';
import { config } from '$lib/server/config.js';

// Forward auth is opt-in (FORWARD_AUTH_ENABLED). config.ts snapshots process.env
// before this file's hoisted block runs, so turn it on per test instead.
beforeEach(() => {
    vi.spyOn(config, 'FORWARD_AUTH_ENABLED', 'get').mockReturnValue(true);
});

const ADMIN_GROUP = config.ADMIN_GROUPS[0] ?? 'admin';
const createdUsernames: string[] = [];
const noopMigration = async (): Promise<void> => undefined;

async function insertUser(groups: string[]): Promise<string> {
    const sql = getTestDb();
    const username = `emptyhdr_${randomUUID().slice(0, 8)}`;
    await sql`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${username}, ${groups.includes(ADMIN_GROUP)}, false, ${groups}::text[])
    `;
    createdUsernames.push(username);
    // A stale L2 hash from an earlier run would make the sync skip the write.
    await cacheDel(`user:groups:hash:${username}`);
    return username;
}

async function storedRow(username: string): Promise<{ groups: string[]; is_admin: boolean }> {
    const sql = getTestDb();
    const [row] = await sql<{ groups: string[] | null; is_admin: boolean }[]>`
        SELECT groups, is_admin FROM users WHERE username = ${username}
    `;
    return { groups: row?.groups ?? [], is_admin: row?.is_admin === true };
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for: ${what}`);
}

/**
 * A forward-auth API request, from the trusted proxy unless `peer` says
 * otherwise. `groups: undefined` = header ABSENT.
 */
async function forwardAuthRequest(
    username: string,
    groups: string | undefined,
    peer = '127.0.0.1',
): Promise<void> {
    const url = new URL('http://localhost/api/user');
    const headers = new Headers({ accept: 'application/json' });
    headers.set(config.USERHEADER, username);
    if (groups !== undefined) headers.set(config.GROUPHEADER, groups);
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
        getClientAddress: () => peer,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
    const res = await resolveAuth(event, noopMigration, true);
    if (peer !== '127.0.0.1') {
        // Untrusted peer: the identity headers are discarded, no identity.
        expect(res).toBeInstanceOf(Response);
        expect(event.locals.user).toBeUndefined();
        return;
    }
    expect(res).toBeUndefined();
    expect(event.locals.authMethod).toBe('forward_auth');
}

beforeAll(async () => {
    // This file covers the Valkey (L2-throttled) path; the Valkey-less path is
    // forward-auth-valkeyless-group-sync.integration.test.ts. Fail loudly
    // rather than silently test the other one.
    expect(await connectValkey()).toBe(true);
    // The periodic upsert is skipped until an admin exists (first-run guard),
    // and a `false` answer is cached. On a fresh test DB that would silently
    // skip the demotion under test, so seed a pinned admin before any request.
    const sql = getTestDb();
    const username = `emptyhdr_admin_${randomUUID().slice(0, 8)}`;
    await sql`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${username}, true, true, '{}'::text[])
    `;
    createdUsernames.push(username);
});

afterAll(async () => {
    const sql = getTestDb();
    if (createdUsernames.length > 0) {
        await sql`DELETE FROM users WHERE username = ANY(${createdUsernames}::text[])`;
    }
});

describe('forward-auth group sync — IdP removed every group', () => {
    it('harness control: a changed NON-empty header lands in users.groups', async () => {
        // Proves the fire-and-forget writer actually runs in this harness, so a
        // timeout in the tests below is about the empty list, not the plumbing.
        const u = await insertUser(['library-films']);
        await forwardAuthRequest(u, 'library-music');
        await waitFor(
            async () => (await storedRow(u)).groups.join('|') === 'library-music',
            'users.groups replaced by the new non-empty header',
        );
    });

    it('a PRESENT, EMPTY groups header clears users.groups and demotes a groups-only admin; an ABSENT header writes nothing', async () => {
        const cleared = await insertUser([ADMIN_GROUP, 'library-films']);
        const untouched = await insertUser([ADMIN_GROUP, 'library-films']);
        const sql = getTestDb();

        // Control: both start with library groups and admin on the token paths,
        // so the assertions below are about the WRITE, not the read.
        for (const u of [cleared, untouched]) {
            expect((await resolveTokenUserAccess(u))?.userGroups).toEqual(
                expect.arrayContaining([ADMIN_GROUP, 'library-films']),
            );
            expect((await resolveOwnerAdminStatus(sql, u))?.isAdmin).toBe(true);
        }

        // Fired together: once the empty-header user's write has landed, the
        // absent-header user's request has had the same time to (not) write.
        await Promise.all([
            forwardAuthRequest(cleared, ''),
            forwardAuthRequest(untouched, undefined),
        ]);

        await waitFor(
            async () => (await storedRow(cleared)).groups.length === 0,
            'users.groups cleared for the empty-header user',
        );
        // The periodic upsert rides the same gate: the unpinned is_admin
        // column follows the (now empty) groups.
        await waitFor(
            async () => !(await storedRow(cleared)).is_admin,
            'users.is_admin demoted for the empty-header user',
        );

        expect((await resolveTokenUserAccess(cleared))?.userGroups).toEqual([]);
        expect((await resolveTokenUserAccess(cleared))?.permissions.ownerIsAdmin).toBe(false);
        expect((await resolveOwnerAdminStatus(sql, cleared))?.isAdmin).toBe(false);

        // Absent header: nothing written, token paths unchanged.
        expect(await storedRow(untouched)).toEqual({
            groups: [ADMIN_GROUP, 'library-films'],
            is_admin: true,
        });
        expect((await resolveTokenUserAccess(untouched))?.userGroups).toEqual(
            expect.arrayContaining([ADMIN_GROUP, 'library-films']),
        );
        expect((await resolveOwnerAdminStatus(sql, untouched))?.isAdmin).toBe(true);
    });

    it('a present header that parses to no groups ("|") also clears', async () => {
        const u = await insertUser(['library-films']);
        await forwardAuthRequest(u, '|');
        await waitFor(
            async () => (await storedRow(u)).groups.length === 0,
            'users.groups cleared for a separator-only header',
        );
        expect((await resolveTokenUserAccess(u))?.userGroups).toEqual([]);
    });
});

/**
 * D1 (security runtime pass 2026-09-26): nginx does not forward an empty
 * header, so behind an nginx `auth_request` edge the present-empty path above
 * is unreachable — the app sees NO groups header. With
 * FORWARD_AUTH_GROUPS_ALWAYS_SENT on, an absent header on a trusted request
 * that carries the username header is read as present-empty.
 */
describe('FORWARD_AUTH_GROUPS_ALWAYS_SENT — absent groups header behind an edge that drops empty headers', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    function flag(on: boolean): void {
        vi.spyOn(config, 'FORWARD_AUTH_GROUPS_ALWAYS_SENT', 'get').mockReturnValue(on);
    }

    it('flag on: an ABSENT header from the trusted proxy clears users.groups and demotes on every token path; an untrusted peer writes nothing', async () => {
        flag(true);
        const cleared = await insertUser([ADMIN_GROUP, 'library-films']);
        const untrusted = await insertUser([ADMIN_GROUP, 'library-films']);
        const sql = getTestDb();

        for (const u of [cleared, untrusted]) {
            expect((await resolveOwnerAdminStatus(sql, u))?.isAdmin).toBe(true);
        }

        await Promise.all([
            forwardAuthRequest(cleared, undefined),
            forwardAuthRequest(untrusted, undefined, '203.0.113.9'),
        ]);

        await waitFor(
            async () => (await storedRow(cleared)).groups.length === 0,
            'users.groups cleared for the absent-header user (flag on)',
        );
        await waitFor(
            async () => !(await storedRow(cleared)).is_admin,
            'users.is_admin demoted for the absent-header user (flag on)',
        );
        expect((await resolveTokenUserAccess(cleared))?.userGroups).toEqual([]);
        expect((await resolveTokenUserAccess(cleared))?.permissions.ownerIsAdmin).toBe(false);
        expect((await resolveOwnerAdminStatus(sql, cleared))?.isAdmin).toBe(false);

        // Forged headers from an untrusted peer are dropped before the flag is read.
        expect(await storedRow(untrusted)).toEqual({
            groups: [ADMIN_GROUP, 'library-films'],
            is_admin: true,
        });
        expect((await resolveOwnerAdminStatus(sql, untrusted))?.isAdmin).toBe(true);
    });

    it('flag off (default): an ABSENT header still writes nothing', async () => {
        flag(false);
        const untouched = await insertUser([ADMIN_GROUP, 'library-films']);
        const timing = await insertUser([ADMIN_GROUP, 'library-films']);

        // `timing` (present-empty) is the clock: once its write lands, the
        // absent-header request has had the same time to (not) write.
        await Promise.all([
            forwardAuthRequest(untouched, undefined),
            forwardAuthRequest(timing, ''),
        ]);
        await waitFor(
            async () => !(await storedRow(timing)).is_admin,
            'present-empty control demoted',
        );

        expect(await storedRow(untouched)).toEqual({
            groups: [ADMIN_GROUP, 'library-films'],
            is_admin: true,
        });
    });
});
