// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-PG seam tests for the persistent setup lock (security review 6, ruling
 * S-C5c-2).
 *
 * The threat: the forward-auth genesis admin is unpinned by design (S-C5c), so
 * an IdP-side demotion (an empty groups header, a renamed admin group, an
 * ADMIN_GROUPS typo) leaves zero admins. Without the lock that reopened the
 * public first-run surfaces: `POST /api/auth/native/setup` minted a password
 * admin for anyone, `POST /api/setup/oidc-config` repointed the IdP, and the
 * OIDC callback treated the next sign-in as first run.
 *
 * Drives the REAL `resolveAuth()` (trusted proxy peer, real Postgres, real
 * Valkey), the REAL route handlers and the REAL bootstrap services. Mocked:
 * `$app/environment` (non-dev forward-auth path), `saveConfig` (so a refused
 * surface that wrongly succeeds cannot write the developer's settings.json),
 * and the OIDC token exchange `handleCallback` (no IdP here).
 *
 * The Valkey-less variant of the demotion is
 * `middleware/forward-auth-setup-lock-valkeyless.integration.test.ts`.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://lumastra:lumastra@127.0.0.1:5432/lumastra_setuplock_tests \
 *     npm run test:integration -- src/lib/server/services/setup-lock.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import postgresConnect from 'postgres';
import { randomUUID } from 'node:crypto';

vi.hoisted(() => {
    // client-ip.ts snapshots TRUSTED_PROXY_IPS at module load.
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
});

// `savedConfig` stands in for settings.json: the mocked saveConfig records into
// it and the config service's get() reads it back, so the pre-admin OIDC discard
// sees what an earlier request saved.
const { mockSaveConfig, mockHandleCallback, mockDiscovery, savedConfig } = vi.hoisted(() => {
    const savedConfig = new Map<string, unknown>();
    return {
        savedConfig,
        mockSaveConfig: vi.fn(async (updates: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(updates)) savedConfig.set(key, value);
        }),
        mockHandleCallback: vi.fn(),
        mockDiscovery: vi.fn(),
    };
});

vi.mock('openid-client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('openid-client')>()),
    discovery: (...args: unknown[]) => mockDiscovery(...args),
}));

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

vi.mock('$lib/server/config/config.service.js', async (importOriginal) => {
    const { getSettingDefinition } = await import('$lib/config/schema.js');
    return {
        ...(await importOriginal<typeof import('$lib/server/config/config.service.js')>()),
        saveConfig: (updates: Record<string, unknown>) => mockSaveConfig(updates),
        get: (key: string) =>
            savedConfig.has(key) ? savedConfig.get(key) : getSettingDefinition(key)?.defaultValue,
        isEnvOverridden: () => false,
    };
});

vi.mock('$lib/server/services/oidc.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/oidc.service.js')>()),
    handleCallback: (...a: unknown[]) => mockHandleCallback(...a),
}));

import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../tests/integration/setup/test-database.js';
import { resolveAuth, invalidateAdminExistsCache } from '$lib/server/middleware/forward-auth.js';
import { cacheDel, connectValkey } from '$lib/server/cache/valkey.js';
import { config } from '$lib/server/config.js';
import { adminExists, FIRST_ADMIN_LOCK_KEY } from '$lib/server/database/queries/users.queries.js';
import { completeForwardAuthSetup } from './native-auth.service.js';
import { resolveOrProvisionOidcUser } from './oidc.service.js';
import { reconcileSetupLock } from './setup-lock.service.js';
import type { OidcClaims } from './oidc-claims.js';
import { POST as nativeSetupPOST } from '../../../routes/api/auth/native/setup/+server.js';
import { POST as oidcConfigPOST } from '../../../routes/api/setup/oidc-config/+server.js';
import { GET as oidcCallbackGET } from '../../../routes/auth/oidc/callback/+server.js';
import { LoggerInstance } from '$lib/server/utils/logger.js';

// Forward auth is opt-in (FORWARD_AUTH_ENABLED). config.ts snapshots process.env
// before this file's hoisted block runs, so turn it on per test instead.
beforeEach(() => {
    vi.spyOn(config, 'FORWARD_AUTH_ENABLED', 'get').mockReturnValue(true);
});

const ADMIN_GROUP = config.ADMIN_GROUPS[0] ?? 'admin';
const PREFIX = 'setuplock_';
const ISSUER = 'https://idp.setuplock.test.example.com/';
const noopMigration = async (): Promise<void> => undefined;

let sql: postgres.Sql;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * An install with no admin by any setup-gate term and no setup lock: the
 * shared test DB keeps rows from other files, so reset every admin source
 * (column, users.groups, in-app memberships) and the lock itself.
 */
async function resetToAdminLessUnlocked(): Promise<void> {
    await sql`DELETE FROM user_access_groups`;
    await sql`DELETE FROM access_groups WHERE is_system = false`;
    await sql`UPDATE users SET is_admin = false, groups = NULL`;
    await sql`DELETE FROM setup_lock`;
    invalidateAdminExistsCache();
}

async function lockRow(): Promise<{ completed_by: string | null } | null> {
    const rows = await sql<{ completed_by: string | null }[]>`
        SELECT completed_by FROM setup_lock WHERE id = 1
    `;
    return rows[0] ?? null;
}

async function userRow(
    username: string,
): Promise<{ id: string; is_admin: boolean; groups: string[] | null } | null> {
    const rows = await sql<{ id: string; is_admin: boolean; groups: string[] | null }[]>`
        SELECT id, is_admin, groups FROM users WHERE username = ${username}
    `;
    return rows[0] ?? null;
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for: ${what}`);
}

function fakeEvent(request: Request, clientAddress: string): RequestEvent {
    return {
        request,
        url: new URL(request.url),
        params: {},
        locals: {},
        // A real request to these paths carries a matched route id; resolveAuth's
        // unrouted-path guard (event.route.id === null) only fires on a genuine
        // 404, so give the event the concrete path as its route id.
        route: { id: new URL(request.url).pathname },
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => undefined,
            delete: () => undefined,
            serialize: () => '',
        },
        fetch: async () => new Response(null),
        getClientAddress: () => clientAddress,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
}

/** A client address no earlier run has used, so the setup rate limit never trips. */
function freshIp(): string {
    const b = randomUUID().replace(/-/g, '');
    return `10.${parseInt(b.slice(0, 2), 16)}.${parseInt(b.slice(2, 4), 16)}.${parseInt(b.slice(4, 6), 16)}`;
}

/** A forward-auth API request from the trusted proxy carrying `groups`. */
async function forwardAuthRequest(username: string, groups: string): Promise<void> {
    await cacheDel(`user:groups:hash:${username}`);
    const url = new URL('http://localhost/api/user');
    const headers = new Headers({ accept: 'application/json' });
    headers.set(config.USERHEADER, username);
    headers.set(config.GROUPHEADER, groups);
    const event = fakeEvent(new Request(url, { headers }), '127.0.0.1');
    const res = await resolveAuth(event, noopMigration, true);
    expect(res).toBeUndefined();
    expect(event.locals.authMethod).toBe('forward_auth');
}

/** Complete first-run setup through the forward-auth path on an admin-less, unlocked DB. */
async function forwardAuthGenesisAdmin(): Promise<string> {
    await resetToAdminLessUnlocked();
    const username = `${PREFIX}genesis_${randomUUID().slice(0, 8)}`;
    const result = await completeForwardAuthSetup(sql, {
        username,
        groups: [ADMIN_GROUP],
        isAdmin: true,
    });
    expect(result).toEqual({ ok: true, oidcConfigDiscarded: false });
    const row = await userRow(username);
    expect(row?.is_admin).toBe(true);
    return username;
}

async function postNativeSetup(username: string): Promise<Response> {
    const request = new Request('http://localhost/api/auth/native/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'native', username, password: 'Correct-Horse-Battery-42!' }),
    });
    return nativeSetupPOST(fakeEvent(request, freshIp()) as never);
}

async function postOidcConfig(): Promise<Response> {
    const request = new Request('http://localhost/api/setup/oidc-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            issuer: 'https://attacker.example.com/',
            clientId: 'attacker-client',
            clientSecret: 'attacker-secret',
        }),
    });
    return oidcConfigPOST(fakeEvent(request, freshIp()) as never);
}

function oidcClaims(subject: string, groups: string[]): OidcClaims {
    return {
        issuer: ISSUER,
        subject,
        email: null,
        emailVerified: false,
        preferredUsername: `${PREFIX}${subject}`,
        name: null,
        groups,
    };
}

/** The OIDC callback route, with only the token exchange stubbed out. */
async function oidcCallback(claims: OidcClaims): Promise<Response> {
    mockHandleCallback.mockResolvedValueOnce({ claims, returnTo: '/', sessionId: null });
    const request = new Request('http://localhost/auth/oidc/callback?code=c&state=s');
    return oidcCallbackGET(fakeEvent(request, freshIp()) as never);
}

/**
 * Every public first-run surface must treat the install as set up. Soft
 * assertions, so one run shows the state of every surface; the native setup
 * attempt runs last because on failure it creates an admin.
 */
async function expectSetupClosed(): Promise<void> {
    expect.soft(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);

    mockSaveConfig.mockClear();
    const oidcConfig = await postOidcConfig();
    expect.soft(oidcConfig.status).toBe(404);
    expect.soft(mockSaveConfig).not.toHaveBeenCalled();

    // firstRun=false: a signed-in IdP user WITHOUT the admin group is an
    // ordinary post-setup login, not a refused "first user must be admin".
    const subject = `nonadmin_${randomUUID().slice(0, 8)}`;
    const callback = await oidcCallback(oidcClaims(subject, ['users']));
    expect.soft(callback.headers.get('location')).toBe('/');

    const rogue = `${PREFIX}rogue_${randomUUID().slice(0, 8)}`;
    const nativeSetup = await postNativeSetup(rogue);
    expect.soft(nativeSetup.status).toBe(409);
    expect.soft(await userRow(rogue)).toBeNull();
}

beforeAll(async () => {
    sql = getTestDb();
    // The demotion rides the Valkey-throttled group sync in this file; the
    // Valkey-less path has its own file. Fail loudly instead of silently
    // testing the other path.
    expect(await connectValkey()).toBe(true);
});

beforeEach(() => {
    mockSaveConfig.mockClear();
    mockHandleCallback.mockReset();
    savedConfig.clear();
    mockDiscovery.mockReset().mockResolvedValue({
        serverMetadata: () => ({
            issuer: 'https://attacker.example.com/',
            authorization_endpoint: 'https://attacker.example.com/authorize',
            token_endpoint: 'https://attacker.example.com/token',
            jwks_uri: 'https://attacker.example.com/jwks',
        }),
    });
});

afterAll(async () => {
    await sql`DELETE FROM user_identities WHERE user_id IN (SELECT id FROM users WHERE username LIKE ${PREFIX + '%'})`;
    await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
});

// ── RED at HEAD: an IdP demotion of the genesis admin reopened setup ─────────

describe('setup lock — forward-auth genesis admin demoted at the IdP', () => {
    it('a PRESENT, EMPTY groups header demotes the genesis admin and setup stays closed', async () => {
        const genesis = await forwardAuthGenesisAdmin();

        await forwardAuthRequest(genesis, '');
        await waitFor(async () => (await userRow(genesis))?.is_admin === false, 'genesis demoted');
        expect((await userRow(genesis))?.groups ?? []).toEqual([]);

        await expectSetupClosed();
    });

    it('a RENAMED admin group demotes the genesis admin and setup stays closed', async () => {
        const genesis = await forwardAuthGenesisAdmin();

        await forwardAuthRequest(genesis, `${ADMIN_GROUP}-renamed`);
        await waitFor(async () => (await userRow(genesis))?.is_admin === false, 'genesis demoted');
        expect((await userRow(genesis))?.groups).toEqual([`${ADMIN_GROUP}-renamed`]);

        await expectSetupClosed();
    });
});

// ── Controls and the three bootstrap paths ───────────────────────────────────

describe('setup lock — first run and the bootstrap paths', () => {
    it('CONTROL: an admin-less install with no lock row keeps setup open; native setup then writes the lock', async () => {
        await resetToAdminLessUnlocked();
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(false);

        const username = `${PREFIX}native_${randomUUID().slice(0, 8)}`;
        const res = await postNativeSetup(username);
        expect(res.status).toBe(200);
        const admin = await userRow(username);
        expect(admin?.is_admin).toBe(true);
        expect(await lockRow()).toEqual({ completed_by: admin?.id });
    });

    it('forward-auth setup writes the lock with the genesis admin', async () => {
        const genesis = await forwardAuthGenesisAdmin();
        expect(await lockRow()).toEqual({ completed_by: (await userRow(genesis))?.id });
    });

    it('OIDC first-run provisioning writes the lock with the new admin', async () => {
        await resetToAdminLessUnlocked();
        const subject = `first_${randomUUID().slice(0, 8)}`;
        const resolved = await resolveOrProvisionOidcUser(sql, oidcClaims(subject, [ADMIN_GROUP]), {
            firstRunRequiresAdmin: true,
        });
        expect(resolved.linkType).toBe('provisioned');
        expect(resolved.isAdmin).toBe(true);
        expect(await lockRow()).toEqual({ completed_by: resolved.userId });
    });

    it('an OIDC first-run sign-in of an EXISTING account that the IdP now makes admin writes the lock', async () => {
        const subject = `returning_${randomUUID().slice(0, 8)}`;
        const first = await resolveOrProvisionOidcUser(sql, oidcClaims(subject, ['users']), {
            firstRunRequiresAdmin: false,
        });
        expect(first.isAdmin).toBe(false);

        await resetToAdminLessUnlocked();
        const again = await resolveOrProvisionOidcUser(sql, oidcClaims(subject, [ADMIN_GROUP]), {
            firstRunRequiresAdmin: true,
        });
        expect(again.linkType).toBe('existing-identity');
        expect(again.isAdmin).toBe(true);
        expect(await lockRow()).toEqual({ completed_by: first.userId });
    });

    it('erasing the admin who completed setup keeps the lock (completed_by is nulled)', async () => {
        const genesis = await forwardAuthGenesisAdmin();
        await sql`DELETE FROM users WHERE username = ${genesis}`;
        expect(await lockRow()).toEqual({ completed_by: null });
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
    });
});

// ── SETUP_UNLOCK recovery ────────────────────────────────────────────────────

describe('setup lock — SETUP_UNLOCK recovery', () => {
    async function lockedAndAdminLess(): Promise<void> {
        await forwardAuthGenesisAdmin();
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        invalidateAdminExistsCache();
        expect(await lockRow()).not.toBeNull();
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
    }

    it('a locked install with zero admins stays locked without an unlock request', async () => {
        await lockedAndAdminLess();
        const outcome = await reconcileSetupLock(sql, {
            unlockRequested: false,
            adminGroupNames: config.ADMIN_GROUPS,
        });
        expect(outcome).toBe('unchanged');
        expect(await lockRow()).not.toBeNull();
    });

    it('unlock with zero admins opens setup; the next admin (native) re-locks it', async () => {
        await lockedAndAdminLess();
        const outcome = await reconcileSetupLock(sql, {
            unlockRequested: true,
            adminGroupNames: config.ADMIN_GROUPS,
        });
        expect(outcome).toBe('unlocked');
        expect(await lockRow()).toBeNull();
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(false);

        const username = `${PREFIX}recovered_${randomUUID().slice(0, 8)}`;
        expect((await postNativeSetup(username)).status).toBe(200);
        expect(await lockRow()).toEqual({ completed_by: (await userRow(username))?.id });
    });

    it('unlock with zero admins, then forward-auth setup re-locks it', async () => {
        await lockedAndAdminLess();
        expect(
            await reconcileSetupLock(sql, {
                unlockRequested: true,
                adminGroupNames: config.ADMIN_GROUPS,
            }),
        ).toBe('unlocked');
        const username = `${PREFIX}fa_recovered_${randomUUID().slice(0, 8)}`;
        expect(
            await completeForwardAuthSetup(sql, { username, groups: [ADMIN_GROUP], isAdmin: true }),
        ).toEqual({ ok: true, oidcConfigDiscarded: false });
        expect(await lockRow()).toEqual({ completed_by: (await userRow(username))?.id });
    });

    it('unlock with zero admins, then OIDC first-run re-locks it', async () => {
        await lockedAndAdminLess();
        expect(
            await reconcileSetupLock(sql, {
                unlockRequested: true,
                adminGroupNames: config.ADMIN_GROUPS,
            }),
        ).toBe('unlocked');
        const resolved = await resolveOrProvisionOidcUser(
            sql,
            oidcClaims(`recovered_${randomUUID().slice(0, 8)}`, [ADMIN_GROUP]),
            { firstRunRequiresAdmin: true },
        );
        expect(await lockRow()).toEqual({ completed_by: resolved.userId });
    });

    it('an IdP promotion after an unlock, in a worker still caching "an admin exists", re-locks setup', async () => {
        const genesis = await forwardAuthGenesisAdmin();
        // From here on this process caches "an admin exists" (forward-auth's
        // anAdminExists never re-checks a cached true), like a running worker
        // when the operator uses scripts/setup-unlock.ts without a restart.
        await forwardAuthRequest(genesis, '');
        await waitFor(async () => (await userRow(genesis))?.is_admin === false, 'genesis demoted');
        expect(
            await reconcileSetupLock(sql, {
                unlockRequested: true,
                adminGroupNames: config.ADMIN_GROUPS,
            }),
        ).toBe('unlocked');

        await forwardAuthRequest(genesis, ADMIN_GROUP);
        await waitFor(async () => (await userRow(genesis))?.is_admin === true, 'genesis promoted');
        await waitFor(async () => (await lockRow()) !== null, 'setup lock written again');
        expect(await lockRow()).toEqual({ completed_by: (await userRow(genesis))?.id });
    });

    it('unlock is ignored while an admin exists', async () => {
        await forwardAuthGenesisAdmin();
        const outcome = await reconcileSetupLock(sql, {
            unlockRequested: true,
            adminGroupNames: config.ADMIN_GROUPS,
        });
        expect(outcome).toBe('unlock-ignored');
        expect(await lockRow()).not.toBeNull();
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
    });

    it('an admin with no lock row (created by a path that did not write it) is re-locked at boot', async () => {
        const genesis = await forwardAuthGenesisAdmin();
        await sql`DELETE FROM setup_lock`;
        const outcome = await reconcileSetupLock(sql, {
            unlockRequested: false,
            adminGroupNames: config.ADMIN_GROUPS,
        });
        expect(outcome).toBe('relocked');
        expect(await lockRow()).toEqual({ completed_by: null });
        expect((await userRow(genesis))?.is_admin).toBe(true);
    });
});

// ── Review fixes (ruling SL-fix) ─────────────────────────────────────────────

const LAST_ADMIN_DEMOTED_PREFIX =
    'IdP group sync demoted the last admin; first-run setup stays locked';

describe('setup lock — review fixes', () => {
    it('M1: a brand-new IdP admin row after an unlock (worker caching "an admin exists") writes the lock; its later demotion keeps setup closed', async () => {
        const genesis = await forwardAuthGenesisAdmin();
        await forwardAuthRequest(genesis, '');
        await waitFor(async () => (await userRow(genesis))?.is_admin === false, 'genesis demoted');
        expect(
            await reconcileSetupLock(sql, {
                unlockRequested: true,
                adminGroupNames: config.ADMIN_GROUPS,
            }),
        ).toBe('unlocked');

        // A user never seen before arrives with the admin group: auto-provisioned
        // as admin (a NEW row, so no promotion transition).
        const newcomer = `${PREFIX}newcomer_${randomUUID().slice(0, 8)}`;
        await forwardAuthRequest(newcomer, ADMIN_GROUP);
        await waitFor(
            async () => (await userRow(newcomer))?.is_admin === true,
            'newcomer is admin',
        );
        await waitFor(
            async () => (await lockRow()) !== null,
            'setup lock written for the new admin',
        );
        expect(await lockRow()).toEqual({ completed_by: (await userRow(newcomer))?.id });

        await forwardAuthRequest(newcomer, '');
        await waitFor(
            async () => (await userRow(newcomer))?.is_admin === false,
            'newcomer demoted',
        );
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
    });

    it('M1: an OIDC sign-in that provisions a new admin while the lock is missing writes it', async () => {
        const genesis = await forwardAuthGenesisAdmin();
        await sql`DELETE FROM setup_lock`;
        const resolved = await resolveOrProvisionOidcUser(
            sql,
            oidcClaims(`late_admin_${randomUUID().slice(0, 8)}`, [ADMIN_GROUP]),
            { firstRunRequiresAdmin: false },
        );
        expect(resolved.isAdmin).toBe(true);
        expect(await lockRow()).toEqual({ completed_by: resolved.userId });
        expect((await userRow(genesis))?.is_admin).toBe(true);
    });

    it('M2: forward-auth setup for a username pinned as non-admin answers 409 and writes no lock', async () => {
        await resetToAdminLessUnlocked();
        const pinned = `${PREFIX}pinned_${randomUUID().slice(0, 8)}`;
        await sql`
            INSERT INTO users (username, is_admin, admin_pinned) VALUES (${pinned}, false, true)
        `;
        const result = await completeForwardAuthSetup(sql, {
            username: pinned,
            groups: [ADMIN_GROUP],
            isAdmin: true,
        });
        expect(result).toMatchObject({ ok: false, status: 409 });
        if (!result.ok) expect(result.message).toContain('pinned as a non-admin');
        expect(await lockRow()).toBeNull();
        expect((await userRow(pinned))?.is_admin).toBe(false);
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(false);
    });

    it('M4: a forward-auth demotion of the last admin logs the pinned warning (control)', async () => {
        const warn = vi.spyOn(LoggerInstance.prototype, 'warn');
        try {
            const genesis = await forwardAuthGenesisAdmin();
            await forwardAuthRequest(genesis, '');
            await waitFor(
                async () =>
                    warn.mock.calls.some((c) => String(c[0]).startsWith(LAST_ADMIN_DEMOTED_PREFIX)),
                'last-admin warning logged',
            );
        } finally {
            warn.mockRestore();
        }
    });

    it('M4: an OIDC sign-in that drops the last admin out of the admin group logs the same warning', async () => {
        await resetToAdminLessUnlocked();
        const subject = `oidc_genesis_${randomUUID().slice(0, 8)}`;
        const first = await resolveOrProvisionOidcUser(sql, oidcClaims(subject, [ADMIN_GROUP]), {
            firstRunRequiresAdmin: true,
        });
        expect(first.isAdmin).toBe(true);

        const warn = vi.spyOn(LoggerInstance.prototype, 'warn');
        try {
            await resolveOrProvisionOidcUser(sql, oidcClaims(subject, ['users']), {
                firstRunRequiresAdmin: false,
            });
            expect(
                warn.mock.calls.some((c) => String(c[0]).startsWith(LAST_ADMIN_DEMOTED_PREFIX)),
            ).toBe(true);
        } finally {
            warn.mockRestore();
        }
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
    });
});

// ── OIDC first run takes FIRST_ADMIN_LOCK_KEY ────────────────────────────────

describe('setup lock — OIDC first-run serializes on the first-admin lock', () => {
    it('blocks while another bootstrap holds FIRST_ADMIN_LOCK_KEY, then provisions and locks', async () => {
        await resetToAdminLessUnlocked();
        const w = postgresConnect(getTestDatabaseUrl(), { max: 1, onnotice: () => {} });
        try {
            let releaseHold: () => void = () => undefined;
            const holdReleased = new Promise<void>((resolve) => {
                releaseHold = resolve;
            });
            let lockHeld: () => void = () => undefined;
            const lockHeldP = new Promise<void>((resolve) => {
                lockHeld = resolve;
            });
            const holder = w.begin(async (t) => {
                await t`SELECT pg_advisory_xact_lock(hashtext(${FIRST_ADMIN_LOCK_KEY}))`;
                lockHeld();
                await holdReleased;
            });
            await lockHeldP;

            const subject = `race_${randomUUID().slice(0, 8)}`;
            const provisioning = resolveOrProvisionOidcUser(
                sql,
                oidcClaims(subject, [ADMIN_GROUP]),
                { firstRunRequiresAdmin: true },
            );

            let blocked = false;
            for (let i = 0; i < 100; i++) {
                const r = await sql<{ n: number }[]>`
                    SELECT count(*)::int AS n
                    FROM pg_locks
                    WHERE locktype = 'advisory'
                      AND NOT granted
                      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                `;
                if (r[0].n > 0) {
                    blocked = true;
                    break;
                }
                await new Promise((res) => setTimeout(res, 20));
            }
            // Released before asserting, so a RED run cannot leave the holder open.
            releaseHold();
            await holder;
            const resolved = await provisioning;

            expect(blocked).toBe(true);
            expect(resolved.isAdmin).toBe(true);
            expect(await lockRow()).toEqual({ completed_by: resolved.userId });
        } finally {
            await w.end();
        }
    });
});

// ── OIDC settings saved before an admin existed ──────────────────────────────

describe('setup lock — OIDC config written before the first admin', () => {
    it.each(['ENOTFOUND', 'SELF_SIGNED_CERT_IN_CHAIN', 'invalid discovery'])(
        'a failed discovery leaves a previous configuration untouched: %s',
        async (failure) => {
            await resetToAdminLessUnlocked();
            savedConfig.set('AUTH_OIDC_ENABLED', false);
            savedConfig.set('AUTH_OIDC_ISSUER', 'https://previous.example.com/');
            savedConfig.set('AUTH_OIDC_CLIENT_SECRET', 'previous-secret');
            const previous = new Map(savedConfig);
            if (failure === 'invalid discovery') {
                mockDiscovery.mockResolvedValueOnce({
                    serverMetadata: () => ({ issuer: 'https://attacker.example.com/' }),
                });
            } else {
                const cause = Object.assign(
                    new Error('https://user:password@idp.example.com/?key=attacker-secret'),
                    { code: failure },
                );
                mockDiscovery.mockRejectedValueOnce(new TypeError('fetch failed', { cause }));
            }
            const response = await postOidcConfig();
            expect(response.status).toBe(422);
            const body = await response.text();
            expect(body).toMatch(
                failure === 'SELF_SIGNED_CERT_IN_CHAIN'
                    ? /NODE_EXTRA_CA_CERTS/
                    : failure === 'ENOTFOUND'
                      ? /unreachable/i
                      : /discovery.*invalid/i,
            );
            expect(body).not.toContain('password');
            expect(body).not.toContain('attacker-secret');
            expect(mockSaveConfig).not.toHaveBeenCalled();
            expect(savedConfig).toEqual(previous);
        },
    );

    it('a visitor-planted OIDC provider is removed when the operator completes native setup', async () => {
        await resetToAdminLessUnlocked();
        // Anyone can reach the unonboarded instance and save their own IdP.
        expect((await postOidcConfig()).status).toBe(200);
        expect(savedConfig.get('AUTH_OIDC_ISSUER')).toBe('https://attacker.example.com/');

        const owner = `${PREFIX}owner_${randomUUID().slice(0, 8)}`;
        const res = await postNativeSetup(owner);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ oidcConfigDiscarded: true });

        // Without the reset the attacker's IdP stayed live, and its next new user
        // with the admin group claim was provisioned as an admin.
        expect(savedConfig.get('AUTH_OIDC_ENABLED')).toBe(false);
        expect(savedConfig.get('AUTH_OIDC_ISSUER')).toBe('');
        expect(savedConfig.get('AUTH_OIDC_CLIENT_ID')).toBe('');
        expect(savedConfig.get('AUTH_OIDC_CLIENT_SECRET')).toBe('');
    });

    it('CONTROL: native setup with no OIDC saved changes no OIDC setting', async () => {
        await resetToAdminLessUnlocked();
        const res = await postNativeSetup(`${PREFIX}plain_${randomUUID().slice(0, 8)}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ oidcConfigDiscarded: false });
        expect([...savedConfig.keys()].filter((k) => k.startsWith('AUTH_OIDC_'))).toEqual([]);
    });

    it('an oidc-config write waits on FIRST_ADMIN_LOCK_KEY and is refused once setup closed under it', async () => {
        await resetToAdminLessUnlocked();
        const w = postgresConnect(getTestDatabaseUrl(), { max: 1, onnotice: () => {} });
        try {
            let releaseHold: () => void = () => undefined;
            const holdReleased = new Promise<void>((resolve) => {
                releaseHold = resolve;
            });
            let lockHeld: () => void = () => undefined;
            const lockHeldP = new Promise<void>((resolve) => {
                lockHeld = resolve;
            });
            // Stands in for a bootstrap path finishing setup while the write is
            // between its first admin check and saveConfig.
            const holder = w.begin(async (t) => {
                await t`SELECT pg_advisory_xact_lock(hashtext(${FIRST_ADMIN_LOCK_KEY}))`;
                lockHeld();
                await holdReleased;
                await t`INSERT INTO setup_lock (id) VALUES (1)`;
            });
            await lockHeldP;

            const write = postOidcConfig();
            let blocked = false;
            for (let i = 0; i < 100; i++) {
                const r = await sql<{ n: number }[]>`
                    SELECT count(*)::int AS n
                    FROM pg_locks
                    WHERE locktype = 'advisory'
                      AND NOT granted
                      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                `;
                if (r[0].n > 0) {
                    blocked = true;
                    break;
                }
                await new Promise((res) => setTimeout(res, 20));
            }
            releaseHold();
            await holder;
            const res = await write;

            expect(blocked).toBe(true);
            expect(res.status).toBe(404);
            expect(mockSaveConfig).not.toHaveBeenCalled();
        } finally {
            await w.end();
            await sql`DELETE FROM setup_lock`;
        }
    });
});
