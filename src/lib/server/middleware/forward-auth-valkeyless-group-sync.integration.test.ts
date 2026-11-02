// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-PG seam test: forward-auth's `users.groups` sync on an install WITHOUT
 * Valkey.
 *
 * The throttle in `syncUserGroupsIfNeeded` used to be Valkey-only: with no
 * Valkey client it returned before the write, so on such an install the IdP
 * groups header never reached `users.groups`. Every token-path reader derives
 * access from that column (`resolveTokenUserAccess`, `resolveOwnerAdminStatus`,
 * Watch Together's participant subject), so PAT and device tokens kept
 * whatever group set (and age cap) was last written by some other path.
 *
 * Valkey is made genuinely ABSENT for this whole file, not mocked: `CACHE_URL`
 * and `TASK_CACHE_URL` are blanked before any module snapshots them, so
 * `connectValkey()` has no URL and the real `isValkeyReady()` stays false on
 * every request. `afterEach` re-checks that against the REAL module
 * (`vi.importActual`) — a lazily-connecting Valkey mid-file would otherwise
 * turn these tests into a Valkey-path test without anyone noticing.
 *
 * Drives the REAL `resolveAuth()` with a trusted proxy peer and real Postgres.
 * Only `$app/environment` is mocked, to reach the non-dev forward-auth path.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://lumastra:lumastra@127.0.0.1:5432/lumastra_valkeyless_tests \
 *     npm run test:integration -- src/lib/server/middleware/forward-auth-valkeyless-group-sync.integration.test.ts
 */

import { describe, it, beforeEach, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';

vi.hoisted(() => {
    // client-ip.ts snapshots TRUSTED_PROXY_IPS at module load — the 127.0.0.1
    // peer below is the trusted reverse proxy.
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    // A Valkey-less install. valkey.ts snapshots both at module load.
    process.env.CACHE_URL = '';
    process.env.TASK_CACHE_URL = '';
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
import { config } from '$lib/server/config.js';

// Forward auth is opt-in (FORWARD_AUTH_ENABLED). config.ts snapshots process.env
// before this file's hoisted block runs, so turn it on per test instead.
beforeEach(() => {
    vi.spyOn(config, 'FORWARD_AUTH_ENABLED', 'get').mockReturnValue(true);
});

const ADMIN_GROUP = config.ADMIN_GROUPS[0] ?? 'admin';
const AGE_12 = `${config.AGE_RATING_GROUP_PREFIX}12`;
const createdUsernames: string[] = [];
const noopMigration = async (): Promise<void> => undefined;

async function realValkeyReady(): Promise<boolean> {
    const real = await vi.importActual<typeof import('$lib/server/cache/valkey.js')>(
        '$lib/server/cache/valkey.js',
    );
    return real.isValkeyReady();
}

async function insertUser(
    groups: string[],
    opts: {
        adminPinned?: boolean;
        isAdmin?: boolean;
        ageRatingPinned?: boolean;
        maxAge?: number | null;
    } = {},
): Promise<string> {
    const sql = getTestDb();
    const username = `vkless_${randomUUID().slice(0, 8)}`;
    await sql`
        INSERT INTO users (username, is_admin, admin_pinned, age_rating_pinned, max_age_rating, groups)
        VALUES (
            ${username},
            ${opts.isAdmin ?? groups.includes(ADMIN_GROUP)},
            ${opts.adminPinned ?? false},
            ${opts.ageRatingPinned ?? false},
            ${opts.maxAge ?? null},
            ${groups}::text[]
        )
    `;
    createdUsernames.push(username);
    return username;
}

interface StoredRow {
    groups: string[];
    is_admin: boolean;
    max_age_rating: number | null;
    groups_updated_at: Date | null;
}

async function storedRow(username: string): Promise<StoredRow> {
    const sql = getTestDb();
    const [row] = await sql<
        {
            groups: string[] | null;
            is_admin: boolean;
            max_age_rating: number | null;
            groups_updated_at: Date | null;
        }[]
    >`
        SELECT groups, is_admin, max_age_rating, groups_updated_at
        FROM users WHERE username = ${username}
    `;
    return {
        groups: row?.groups ?? [],
        is_admin: row?.is_admin === true,
        max_age_rating: row?.max_age_rating ?? null,
        groups_updated_at: row?.groups_updated_at ?? null,
    };
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for: ${what}`);
}

/** Give fire-and-forget writers time to land (or, for a control, to NOT land). */
async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 400));
}

/** A forward-auth API request from the trusted proxy. `groups: undefined` = header ABSENT. */
async function forwardAuthRequest(username: string, groups: string | undefined): Promise<void> {
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
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
    const res = await resolveAuth(event, noopMigration, true);
    expect(res).toBeUndefined();
    expect(event.locals.authMethod).toBe('forward_auth');
}

beforeAll(async () => {
    expect(await realValkeyReady()).toBe(false);
    // The periodic upsert (is_admin / max_age_rating) is skipped until an
    // admin exists (first-run guard, cached per worker). Seed a pinned admin
    // so the upsert half of the sync runs in this file too.
    const sql = getTestDb();
    const username = `vkless_admin_${randomUUID().slice(0, 8)}`;
    await sql`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${username}, true, true, '{}'::text[])
    `;
    createdUsernames.push(username);
});

afterEach(async () => {
    // Guard against a vacuous pass: every assertion in this file is about the
    // Valkey-less path, so Valkey must still be absent after the requests ran.
    expect(await realValkeyReady()).toBe(false);
});

afterAll(async () => {
    const sql = getTestDb();
    if (createdUsernames.length > 0) {
        await sql`DELETE FROM users WHERE username = ANY(${createdUsernames}::text[])`;
    }
});

describe('forward-auth group sync without Valkey', () => {
    it('a changed header lands in users.groups and reaches the token path', async () => {
        const u = await insertUser(['library-films']);
        expect((await resolveTokenUserAccess(u))?.userGroups).toEqual(['library-films']);

        await forwardAuthRequest(u, 'library-music');

        await waitFor(
            async () => (await storedRow(u)).groups.join('|') === 'library-music',
            'users.groups replaced by the header',
        );
        expect((await resolveTokenUserAccess(u))?.userGroups).toEqual(['library-music']);
    });

    it('an age group in the header caps the token path; an ABSENT header writes nothing', async () => {
        // Both rows start with NO age group (as a stale row would after the
        // IdP added one). Unpinned, so the token cap derives from users.groups.
        const capped = await insertUser(['library-films']);
        const absent = await insertUser(['library-films']);
        for (const u of [capped, absent]) {
            expect((await resolveTokenUserAccess(u))?.permissions.maxAgeRating).toBeNull();
        }

        await Promise.all([
            forwardAuthRequest(capped, `library-films|${AGE_12}`),
            forwardAuthRequest(absent, undefined),
        ]);

        await waitFor(
            async () => (await storedRow(capped)).groups.includes(AGE_12),
            'age group written for the header user',
        );
        expect((await resolveTokenUserAccess(capped))?.permissions.maxAgeRating).toBe(12);

        // Control: the absent-header row is byte-for-byte unchanged.
        await settle();
        const untouched = await storedRow(absent);
        expect(untouched.groups).toEqual(['library-films']);
        expect(untouched.groups_updated_at).toBeNull();
    });

    it('an absent header never removes an age group (the fail-open guard)', async () => {
        const kid = await insertUser(['library-films', AGE_12]);
        expect((await resolveTokenUserAccess(kid))?.permissions.maxAgeRating).toBe(12);

        await forwardAuthRequest(kid, undefined);
        await settle();

        expect((await storedRow(kid)).groups).toEqual(['library-films', AGE_12]);
        expect((await resolveTokenUserAccess(kid))?.permissions.maxAgeRating).toBe(12);
    });

    it('a PRESENT, EMPTY header clears users.groups and demotes an unpinned groups-only admin', async () => {
        const u = await insertUser([ADMIN_GROUP, 'library-films']);
        const sql = getTestDb();
        expect((await resolveOwnerAdminStatus(sql, u))?.isAdmin).toBe(true);

        await forwardAuthRequest(u, '');

        await waitFor(
            async () => (await storedRow(u)).groups.length === 0,
            'users.groups cleared by the empty header',
        );
        await waitFor(async () => !(await storedRow(u)).is_admin, 'unpinned is_admin demoted');
        expect((await resolveTokenUserAccess(u))?.permissions.ownerIsAdmin).toBe(false);
        expect((await resolveOwnerAdminStatus(sql, u))?.isAdmin).toBe(false);
    });

    it('a pinned row keeps its pinned admin and age values while its groups follow the header', async () => {
        // Pinned admin, pinned age ceiling 16. The header drops the admin group
        // and carries age-12: the pins must win on both axes.
        const u = await insertUser([ADMIN_GROUP], {
            isAdmin: true,
            adminPinned: true,
            ageRatingPinned: true,
            maxAge: 16,
        });
        const sql = getTestDb();

        await forwardAuthRequest(u, `library-music|${AGE_12}`);

        await waitFor(
            async () => (await storedRow(u)).groups.join('|') === `library-music|${AGE_12}`,
            'groups synced for the pinned row',
        );
        await settle();
        const row = await storedRow(u);
        expect(row.is_admin).toBe(true);
        expect(row.max_age_rating).toBe(16);
        expect((await resolveOwnerAdminStatus(sql, u))?.isAdmin).toBe(true);
    });

    it('the in-process throttle: an unchanged header does not re-write, a changed one does at once', async () => {
        const u = await insertUser(['library-films']);

        await forwardAuthRequest(u, 'library-music');
        await waitFor(
            async () => (await storedRow(u)).groups.join('|') === 'library-music',
            'first sync',
        );
        const first = (await storedRow(u)).groups_updated_at;
        expect(first).not.toBeNull();

        // Same groups, different order and case: the hash is order- and
        // case-insensitive, so this is a throttled no-op.
        await forwardAuthRequest(u, 'Library-Music');
        await settle();
        expect((await storedRow(u)).groups_updated_at?.getTime()).toBe(first?.getTime());

        // Changed groups inside the TTL: written immediately.
        await forwardAuthRequest(u, 'library-music|library-shows');
        await waitFor(
            async () => (await storedRow(u)).groups.join('|') === 'library-music|library-shows',
            'changed header written inside the throttle window',
        );
    });
});
