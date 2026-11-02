// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-PG seam test: `POST /api/oauth/authorize`'s `users.groups` write when
 * the IdP has removed EVERY group from a forward-auth user.
 *
 * The route writes `locals.idpGroups` (the raw groups-header list forward-auth
 * sets beside `authMethod`). It used to skip an empty list, so a user whose
 * IdP groups were all revoked authorized a new device while `users.groups`
 * still carried the old library groups (and an ADMIN_GROUPS entry) — the very
 * column the new device token is later resolved against.
 *
 * Forward-auth's own throttled sync (`syncUserGroupsIfNeeded`) writes the same
 * header list — with or without Valkey — so every case that expects a write
 * first PRIMES that sync's per-worker throttle with the exact list the
 * authorize request will carry (see `primeForwardAuthThrottle`), then puts the
 * stale seed back through the canonical writer. On the authorize request the
 * sync is then a throttle hit and skips, and the route is the only writer the
 * assertions can observe. This models the case the route's awaited write
 * exists for: the throttle has seen this list already, but the column no
 * longer holds it.
 *
 * HISTORY: until forward-auth synced without Valkey, this file relied on
 * `isValkeyReady() === false` alone to silence the sync.
 *
 * FIX ROUND 2 (security review 6, P2, I-C): this used to assert
 * `isValkeyReady() === false` ONCE in a `beforeAll`, before any test ran.
 * That is not the same as Valkey staying down for the WHOLE file: the local
 * dev/test Valkey (`lumastra-valkey`, reachable via `CACHE_URL`) finishes its
 * async connect a moment after the first real request touches
 * `$lib/server/cache/valkey.js`, so by the SECOND test `isValkeyReady()` was
 * actually `true` — the throttled sync (which this fix's route write was
 * never supposed to depend on) did the clearing instead of the route, and the
 * ONE case that exercises a present-but-empty header (`'a PRESENT, EMPTY
 * groups header clears users.groups...'`) passed either way. Reverting the
 * route's gate back to `idpGroups?.length` still passed the file's other two
 * cases (the harness control and the ABSENT-header control are independent
 * of that gate), which is exactly the false-green signature: the one case
 * that should have pinned the fix wasn't actually exercising it. `isValkeyReady`
 * is now mocked to `false` for the ENTIRE file (`importOriginal` keeps every
 * other export real), so the throttled sync's own
 * `if (!isValkeyReady()) return;` short-circuits it on every request in this
 * file, not just the first. FIX ROUND 3 correction: the route's own write
 * does not call `cacheGet`/`setEx` — its cache invalidation goes through
 * `invalidateGroupDerivedCaches()` → `auth-cache-bus.ts`'s
 * `publishAuthCacheInvalidation()` → `publishMessage()`, a different Valkey
 * export the same `importOriginal` spread keeps real. `cacheGet`/`setEx` are
 * what `syncUserGroupsIfNeeded`'s OWN L2 throttle uses, and are never reached
 * in this file because `isValkeyReady()` short-circuits before them. Verified:
 * reverting the route's gate by hand turns exactly that ONE case RED (the
 * other two stay green, as they always did); the committed route (which
 * writes whenever `authMethod === 'forward_auth'` and `idpGroups !==
 * undefined`) is GREEN on all three.
 *
 * Control: an ABSENT groups header (proxy does not forward it) must never
 * write — clearing there would drop age-cap groups and fail open.
 *
 * Drives the REAL chain: `resolveAuth()` (trusted proxy peer, real headers)
 * populates `locals`, then the REAL `POST` handler runs on the same event.
 * Only the device-code service (a leaf) and `$app/environment` are mocked,
 * plus `isValkeyReady` above.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://lumastra:lumastra@127.0.0.1:5432/lumastra_emptyhdr_tests \
 *     npm run test:integration -- src/routes/api/oauth/authorize/authorize-empty-idp-groups.integration.test.ts
 */

import { describe, it, beforeEach, expect, vi, beforeAll, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';

// client-ip.ts snapshots TRUSTED_PROXY_IPS at module load.
vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    // Belt and braces for the `isValkeyReady` mock below: with no URL the real
    // module can never connect either, so an import that bypasses the mock
    // still sees Valkey absent.
    process.env.CACHE_URL = '';
    process.env.TASK_CACHE_URL = '';
});

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

const mockGetByUserCode = vi.fn();
const mockAuthorize = vi.fn();

vi.mock('$lib/server/oauth', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/oauth')>()),
    getDeviceCodeService: () => ({
        getByUserCode: (...args: unknown[]) => mockGetByUserCode(...args),
        authorize: (...args: unknown[]) => mockAuthorize(...args),
        deny: vi.fn(),
    }),
    isDeviceAuthEnabled: vi.fn().mockReturnValue(true),
}));

// FIX ROUND 2 (I-C): force Valkey "not ready" for every request in this file,
// not just at startup — see the file doc comment above. This keeps the
// sync's cross-worker L2 out of the picture, so the in-process throttle that
// `primeForwardAuthThrottle` primes is the only one deciding. `importOriginal`
// keeps every other export (cacheGet/setEx/etc.) real and complete, so a
// future addition to valkey.js's surface can't silently go missing here (the
// repo's own lesson: an incomplete `vi.mock` factory surfaces as a 500/null,
// never as the missing export).
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return {
        ...actual,
        isValkeyReady: () => false,
    };
});

import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access.js';
import { resolveOwnerAdminStatus } from '$lib/server/auth/resolve-owner-admin-status.js';
import { isValkeyReady } from '$lib/server/cache/valkey.js';
import { syncUserGroups } from '$lib/server/services/user-groups.service.js';
import { parseList } from '$lib/server/utils/string-utils.js';
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
    const username = `emptyidp_${randomUUID().slice(0, 8)}`;
    await sql`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${username}, ${groups.includes(ADMIN_GROUP)}, false, ${groups}::text[])
    `;
    createdUsernames.push(username);
    return username;
}

async function storedGroups(username: string): Promise<string[]> {
    const sql = getTestDb();
    const [row] = await sql<{ groups: string[] | null }[]>`
        SELECT groups FROM users WHERE username = ${username}
    `;
    return row?.groups ?? [];
}

function fakeEvent(url: URL, request: Request): RequestEvent {
    return {
        request,
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
}

/**
 * Let forward-auth's throttled sync write `groups` once (a plain forward-auth
 * request), so its per-worker throttle now holds this list's hash; then put
 * `seed` back through the canonical writer, which also drops the caches the
 * token-path readers use. A later request with the same `groups` header is a
 * throttle hit: forward-auth does not write it again.
 */
async function primeForwardAuthThrottle(
    username: string,
    groups: string,
    seed: string[],
): Promise<void> {
    const url = new URL('http://localhost/api/user');
    const headers = new Headers({ accept: 'application/json' });
    headers.set(config.USERHEADER, username);
    headers.set(config.GROUPHEADER, groups);
    const event = fakeEvent(url, new Request(url, { headers }));
    expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();

    const expected = parseList(groups).join('|');
    const deadline = Date.now() + 5000;
    while ((await storedGroups(username)).join('|') !== expected) {
        if (Date.now() > deadline) throw new Error('forward-auth sync never landed');
        await new Promise((r) => setTimeout(r, 25));
    }
    // The throttle entry is set after the write and its identity-ledger step,
    // and the periodic upsert rides the same request; let both finish.
    await new Promise((r) => setTimeout(r, 400));

    await syncUserGroups(getTestDb(), username, seed);
    expect(await storedGroups(username)).toEqual(seed);
}

/** Forward-auth, then the device-authorize POST, on one event. `groups: undefined` = header ABSENT. */
async function authorizeDevice(username: string, groups: string | undefined): Promise<void> {
    const url = new URL('http://localhost/api/oauth/authorize');
    const headers = new Headers({
        accept: 'application/json',
        'content-type': 'application/json',
    });
    headers.set(config.USERHEADER, username);
    if (groups !== undefined) headers.set(config.GROUPHEADER, groups);
    const event = fakeEvent(
        url,
        new Request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ user_code: 'ABCD-1234' }),
        }),
    );

    expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
    expect(event.locals.authMethod).toBe('forward_auth');

    mockGetByUserCode.mockResolvedValue({
        status: 'pending',
        user_id: event.locals.user?.userId,
        client_id: 'client-1',
    });
    mockAuthorize.mockResolvedValue(true);

    const { POST } = (await import('./+server.js')) as unknown as {
        POST: (event: RequestEvent) => Promise<Response>;
    };
    const res = await POST(event);
    expect(res.status).toBe(200);
}

beforeAll(() => {
    // Sanity check on the mock above (FIX ROUND 2, I-C): `isValkeyReady` is
    // mocked `false` for the whole file, not asserted true only once here —
    // this just confirms the mock actually took, so the sync's L2 never
    // answers and `primeForwardAuthThrottle`'s in-process throttle decides.
    expect(isValkeyReady()).toBe(false);
});

afterAll(async () => {
    const sql = getTestDb();
    if (createdUsernames.length > 0) {
        await sql`DELETE FROM users WHERE username = ANY(${createdUsernames}::text[])`;
    }
});

describe('POST /api/oauth/authorize — IdP removed every group', () => {
    it('harness control: a changed NON-empty groups header is written', async () => {
        const u = await insertUser(['library-films']);
        await primeForwardAuthThrottle(u, 'library-music', ['library-films']);
        await authorizeDevice(u, 'library-music');
        expect(await storedGroups(u)).toEqual(['library-music']);
    });

    it('a PRESENT, EMPTY groups header clears users.groups; token paths lose the groups and admin', async () => {
        const u = await insertUser([ADMIN_GROUP, 'library-films']);
        const sql = getTestDb();
        await primeForwardAuthThrottle(u, '', [ADMIN_GROUP, 'library-films']);

        // Control: library groups and admin are recognised BEFORE the write.
        expect((await resolveTokenUserAccess(u))?.userGroups).toEqual(
            expect.arrayContaining([ADMIN_GROUP, 'library-films']),
        );
        expect((await resolveOwnerAdminStatus(sql, u))?.isAdmin).toBe(true);

        await authorizeDevice(u, '');

        expect(await storedGroups(u)).toEqual([]);
        expect((await resolveTokenUserAccess(u))?.userGroups).toEqual([]);
        expect((await resolveTokenUserAccess(u))?.permissions.ownerIsAdmin).toBe(false);
        expect((await resolveOwnerAdminStatus(sql, u))?.isAdmin).toBe(false);
    });

    it('an ABSENT groups header under FORWARD_AUTH_GROUPS_ALWAYS_SENT clears users.groups like a present-empty one (D1)', async () => {
        // nginx drops an empty header, so this is what an nginx `auth_request`
        // edge forwards for a user with no IdP groups. Primed with '' — the
        // same `[]` hash — so forward-auth's own sync is a throttle hit and
        // the route is the only writer observed.
        const spy = vi
            .spyOn(config, 'FORWARD_AUTH_GROUPS_ALWAYS_SENT', 'get')
            .mockReturnValue(true);
        try {
            const u = await insertUser([ADMIN_GROUP, 'library-films']);
            const sql = getTestDb();
            await primeForwardAuthThrottle(u, '', [ADMIN_GROUP, 'library-films']);
            expect((await resolveOwnerAdminStatus(sql, u))?.isAdmin).toBe(true);

            await authorizeDevice(u, undefined);

            expect(await storedGroups(u)).toEqual([]);
            expect((await resolveTokenUserAccess(u))?.userGroups).toEqual([]);
            expect((await resolveTokenUserAccess(u))?.permissions.ownerIsAdmin).toBe(false);
            expect((await resolveOwnerAdminStatus(sql, u))?.isAdmin).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    it('an ABSENT groups header writes nothing', async () => {
        const u = await insertUser([ADMIN_GROUP, 'library-films']);
        const sql = getTestDb();

        await authorizeDevice(u, undefined);

        expect(await storedGroups(u)).toEqual([ADMIN_GROUP, 'library-films']);
        expect((await resolveTokenUserAccess(u))?.userGroups).toEqual(
            expect.arrayContaining([ADMIN_GROUP, 'library-films']),
        );
        expect((await resolveOwnerAdminStatus(sql, u))?.isAdmin).toBe(true);
    });
});
