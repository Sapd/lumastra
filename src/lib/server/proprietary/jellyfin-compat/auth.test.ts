// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for jellyfin-compat/auth.ts's session-lifecycle primitives
 * (security review 2026-09-16, task 6):
 *
 * - `createSession()` denying a disabled/deleted/unresolvable account (C5) —
 *   the seam BOTH `/j` mint routes (`AuthenticateByName`,
 *   `AuthenticateWithQuickConnect`) now inherit from, rather than each
 *   checking `disabled_at`/`deleted_at` itself. The route-level end-to-end
 *   proof for the QuickConnect mint path (the one that had NO check at all
 *   before this fix) lives in
 *   `AuthenticateWithQuickConnect/disabled-user.test.ts`, mirroring
 *   `AuthenticateByName/disabled-user.test.ts`'s own convention; this file
 *   is the seam-level unit coverage `createSession` itself has never had.
 * - `revokeSessionsForUser()`'s coordination-Valkey-outage contract (C29): a
 *   null coordination client must land in `failedStores` via a thrown
 *   error, never a silent `return 0` that `credential-revocation.service.ts`
 *   reads as "swept cleanly."
 * - `revokeSessionsForUser()`'s Quick Connect pending-secret sweep (C5
 *   fan-out): a secret already approved for the target user, but not yet
 *   completed via `AuthenticateWithQuickConnect`, must be revoked alongside
 *   their live sessions — nothing else in the disable fan-out could
 *   otherwise reach it before its own 5-minute TTL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isCoordinationKey } from '$lib/server/cache/valkey.js';

process.env.LUMASTRA_MASTER_KEY = 'e'.repeat(64);

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/database/connection', () => ({
    Database: class {
        getSql(): unknown {
            return {};
        }
    },
}));

vi.mock('$lib/server/database/queries/jellyfin-client-passwords.queries', () => ({
    getPasswordByUserId: { one: vi.fn(async () => null) },
    getPasswordByUsername: { one: vi.fn(async () => null) },
    upsertPassword: { execute: vi.fn(async () => [{ id: 1 }]) },
    updateLastUsed: { execute: vi.fn(async () => []) },
    deletePassword: { execute: vi.fn(async () => []) },
    getUsersWithPasswords: { all: vi.fn(async () => []) },
}));

// Not exercised by any test in this file — stubbed to keep auth.ts's module
// graph light (the real implementations pull in scrypt/AEAD machinery this
// file's tests have no reason to run).
vi.mock('$lib/server/crypto/secret-box', () => ({
    deriveMasterKey: vi.fn(),
    sealSecret: vi.fn(),
    openSecret: vi.fn(),
    isSealed: vi.fn(() => false),
}));

vi.mock('$lib/server/tasks/secrets', () => ({
    jellyfinClientPasswordContext: (userId: string) => userId,
    rotateJellyfinClientPasswords: vi.fn(),
}));

vi.mock('$lib/server/crypto/master-key', () => ({
    resolveMasterKey: vi.fn(() => Buffer.alloc(32)),
}));

const mockResolveTokenUserAccess = vi.fn();
vi.mock('$lib/server/auth/resolve-token-user-access', () => ({
    resolveTokenUserAccess: (...args: unknown[]) => mockResolveTokenUserAccess(...args),
}));

const mockGetCoordinationClient = vi.fn();
const mockGetValkeyClient = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();
const mockCacheDel = vi.fn();
const mockCacheExists = vi.fn();
const mockExpire = vi.fn();
const mockSAdd = vi.fn();
const mockSRem = vi.fn();
const mockSMembers = vi.fn();
// `importOriginal` keeps `isCoordinationKey`/`COORDINATION_KEY_PREFIXES` REAL
// (fix round 1, Important 1): the QC-sweep tests below route their fake
// cacheGet/cacheSet/cacheDel through the genuine classification, so a future
// change to COORDINATION_KEY_PREFIXES that stops classifying `jfcompat:qc:`
// as coordination turns those tests RED again instead of passing silently.
vi.mock('$lib/server/cache/valkey', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return {
        ...actual,
        cacheGet: (...args: unknown[]) => mockCacheGet(...args),
        cacheSet: (...args: unknown[]) => mockCacheSet(...args),
        cacheDel: (...args: unknown[]) => mockCacheDel(...args),
        cacheExists: (...args: unknown[]) => mockCacheExists(...args),
        expire: (...args: unknown[]) => mockExpire(...args),
        sAdd: (...args: unknown[]) => mockSAdd(...args),
        sRem: (...args: unknown[]) => mockSRem(...args),
        sMembers: (...args: unknown[]) => mockSMembers(...args),
        getCoordinationClient: () => mockGetCoordinationClient(),
        getValkeyClient: () => mockGetValkeyClient(),
    };
});

const { createSession, revokeSessionsForUser } = await import('./auth.js');

beforeEach(() => {
    vi.clearAllMocks();
    mockCacheSet.mockResolvedValue(undefined);
    mockCacheDel.mockResolvedValue(0);
    mockCacheExists.mockResolvedValue(false);
    mockExpire.mockResolvedValue(true);
    mockSAdd.mockResolvedValue(0);
    mockSRem.mockResolvedValue(0);
    mockSMembers.mockResolvedValue([]);
    mockCacheGet.mockResolvedValue(null);
});

function baseSession(overrides: Partial<Parameters<typeof createSession>[0]> = {}) {
    return {
        userId: 'user-1',
        username: 'alice',
        isAdmin: false,
        groups: [] as string[],
        displayName: null,
        deviceId: 'dev-1',
        deviceName: 'Test Device',
        clientName: 'Test Client',
        clientVersion: '1.0',
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

describe('createSession — disabled/deleted account denial (C5)', () => {
    it('returns null and writes no session key when the account is disabled', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            userGroups: [],
            disabled: true,
            deleted: false,
            permissions: {} as never,
        });

        const token = await createSession(baseSession());

        expect(token).toBeNull();
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it('returns null and writes no session key when the account is soft-deleted', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            userGroups: [],
            disabled: false,
            deleted: true,
            permissions: {} as never,
        });

        const token = await createSession(baseSession());

        expect(token).toBeNull();
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it('returns null when the account is unresolvable (no such users row / DB error)', async () => {
        mockResolveTokenUserAccess.mockResolvedValue(null);

        const token = await createSession(baseSession());

        expect(token).toBeNull();
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it('mints a real token and writes the session key for an active account', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            userGroups: [],
            disabled: false,
            deleted: false,
            permissions: {} as never,
        });

        const token = await createSession(baseSession());

        expect(token).not.toBeNull();
        expect(token).toMatch(/^[a-f0-9]{64}$/);
        expect(mockCacheSet).toHaveBeenCalledWith(
            `jfcompat:session:${token}`,
            expect.any(String),
            expect.any(Number),
        );
    });
});

describe('revokeSessionsForUser — coordination Valkey outage (C29)', () => {
    it('throws instead of returning 0 when the coordination client is null', async () => {
        mockGetCoordinationClient.mockReturnValue(null);

        await expect(revokeSessionsForUser('user-1')).rejects.toThrow();
        expect(mockCacheDel).not.toHaveBeenCalled();
    });
});

/**
 * A minimal stand-in for a GlideClient's `.scan()` against a given in-memory
 * "keyspace" — cursor-based like the real thing (always converges in one
 * page here), matching the shape `scanKeysMatchingUserId` (auth.ts) expects.
 */
function makeScanningClient(store: Map<string, string>): { scan: ReturnType<typeof vi.fn> } {
    return {
        scan: vi.fn(async (cursor: string, opts: { match: string }) => {
            if (cursor !== '0') return ['0', []];
            const prefix = opts.match.replace(/\*$/, '');
            return ['0', Array.from(store.keys()).filter((k) => k.startsWith(prefix))];
        }),
    };
}

// SECURITY REVIEW 2026-09-16, task 6 fix round 1 (Important 1): the QC sweep's
// SCAN always used getCoordinationClient() — but before this round's fix,
// `jfcompat:qc:` was not in COORDINATION_KEY_PREFIXES, so real cacheSet()
// calls (Initiate/Authorize) routed QC secrets to the EVICTABLE cache client
// via pickClient(), while this sweep scanned the noeviction coordination
// client, which held nothing. The prior version of these tests could not
// catch that: a single mocked `cacheGet` returned data for a key string
// regardless of which "client" the SCAN came from, collapsing the two
// instances into one and hiding the mismatch.
//
// These tests use TWO DISTINCT client mocks (`coordinationClient` scans
// `coordinationStore`, `cacheClient` scans `cacheStore`), and route the fake
// cacheGet/cacheSet/cacheDel through the REAL, unmocked `isCoordinationKey()`
// (imported above — this module's `vi.mock` preserves it via `importOriginal`).
// A future change that stops classifying `jfcompat:qc:` as coordination would
// make `seedQcSecret` place data in `cacheStore` while the sweep keeps
// scanning only `coordinationClient` — turning these RED again, which is the
// whole point.
describe('revokeSessionsForUser — Quick Connect pending-secret sweep (C5 fan-out)', () => {
    let coordinationStore: Map<string, string>;
    let cacheStore: Map<string, string>;
    let coordinationClient: ReturnType<typeof makeScanningClient>;
    let cacheClient: ReturnType<typeof makeScanningClient>;

    beforeEach(() => {
        coordinationStore = new Map();
        cacheStore = new Map();
        coordinationClient = makeScanningClient(coordinationStore);
        cacheClient = makeScanningClient(cacheStore);
        mockGetCoordinationClient.mockReturnValue(coordinationClient);
        mockGetValkeyClient.mockReturnValue(cacheClient);
        // Mirrors pickClient(): route by the REAL classification, exactly
        // like production cacheGet/cacheSet/cacheDel do.
        mockCacheGet.mockImplementation(
            async (key: string) =>
                (isCoordinationKey(key) ? coordinationStore : cacheStore).get(key) ?? null,
        );
        mockCacheDel.mockImplementation(async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            let n = 0;
            for (const k of keys) {
                if (coordinationStore.delete(k)) n++;
                if (cacheStore.delete(k)) n++;
            }
            return n;
        });
    });

    /** Seeds a QC secret via the SAME real classification cacheSet() applies in production. */
    function seedQcSecret(secret: string, code: string, userId: string | null): void {
        const key = `jfcompat:qc:secret:${secret}`;
        const value = JSON.stringify({
            code,
            authenticated: userId !== null,
            userId,
            username: userId !== null ? 'alice' : null,
            isAdmin: false,
            groups: [] as string[],
            displayName: null,
        });
        (isCoordinationKey(key) ? coordinationStore : cacheStore).set(key, value);
    }

    it('finds and deletes a pending QC secret + its code key on the client it actually lives on', async () => {
        seedQcSecret('sec-1', '123456', 'user-1');

        const count = await revokeSessionsForUser('user-1');

        expect(count).toBe(1);
        expect(coordinationClient.scan).toHaveBeenCalled();
        expect(cacheClient.scan).not.toHaveBeenCalled();
        expect(mockCacheDel).toHaveBeenCalledWith([
            'jfcompat:qc:secret:sec-1',
            'jfcompat:qc:code:123456',
        ]);
        expect(coordinationStore.has('jfcompat:qc:secret:sec-1')).toBe(false);
    });

    it('does not touch a QC secret pending for a DIFFERENT user', async () => {
        seedQcSecret('sec-2', '654321', 'someone-else');

        const count = await revokeSessionsForUser('user-1');

        expect(count).toBe(0);
        expect(coordinationStore.has('jfcompat:qc:secret:sec-2')).toBe(true);
    });

    it('ignores an unauthorized (userId: null) pending QC secret', async () => {
        seedQcSecret('sec-3', '111111', null);

        const count = await revokeSessionsForUser('user-1');

        expect(count).toBe(0);
    });

    // The regression this whole describe block guards against: a QC secret
    // that (hypothetically) landed on the CACHE client — the pre-fix routing
    // — is invisible to the sweep, because revokeSessionsForUser() only ever
    // asks the coordination client for QC keys. This is what made the old
    // sweep a silent no-op: it returned 0 for exactly this reason, not
    // because there was nothing pending.
    it('is blind to a QC secret placed directly on the cache client (proves the sweep only asks coordination)', async () => {
        cacheStore.set(
            'jfcompat:qc:secret:sec-4',
            JSON.stringify({
                code: '444444',
                authenticated: true,
                userId: 'user-1',
                username: 'alice',
                isAdmin: false,
                groups: [] as string[],
                displayName: null,
            }),
        );

        const count = await revokeSessionsForUser('user-1');

        expect(count).toBe(0);
        expect(cacheClient.scan).not.toHaveBeenCalled();
    });
});
