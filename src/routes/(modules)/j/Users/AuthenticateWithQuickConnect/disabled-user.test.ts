// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-16, task 6, C5 — end-to-end coverage that
 * `POST /j/Users/AuthenticateWithQuickConnect` refuses to mint a session for
 * a DISABLED (or soft-deleted) account, even though the Quick Connect secret
 * itself is already `authenticated: true`. Mirrors
 * `j/Users/AuthenticateByName/disabled-user.test.ts`'s convention: this
 * drives the REAL route handler and the REAL `createSession()` (the shared
 * mint primitive both `/j` auth routes now go through — see its own
 * comment for why the check lives there and not in either route), faking
 * only the Valkey cache and the DB query modules `resolveTokenUserAccess`
 * reads through.
 *
 * Before this fix, this route had NO `users` query of its own at all (it
 * reads an already-approved Quick Connect secret straight out of Valkey and
 * called `createSession()` unconditionally) — no test of any kind existed
 * for this route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.LUMASTRA_MASTER_KEY = 'e'.repeat(64);

const { mockAllowsLiveTv } = vi.hoisted(() => ({
    mockAllowsLiveTv: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({ userAllowsLiveTv: mockAllowsLiveTv }));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

// The QC secret data this test controls, keyed by cache key. A real Valkey
// stand-in would be overkill — the route only ever GETs the secret once and
// DELETEs both QC keys at the end, so a plain in-memory map is enough to
// also prove "no session key was written" (SESSION_KEY_PREFIX is never
// touched via cacheSet).
const { qcStore } = vi.hoisted(() => ({ qcStore: new Map<string, string>() }));
const mockCacheSet = vi.fn(async (_key: string, _value: string, _ttlSeconds: number) => undefined);
const mockCacheDel = vi.fn(async (_key: string | string[]) => 0);
vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: vi.fn(async (key: string) => qcStore.get(key) ?? null),
    cacheSet: (...args: [string, string, number]) => mockCacheSet(...args),
    cacheDel: (...args: [string | string[]]) => mockCacheDel(...args),
    cacheExists: vi.fn(async () => false),
    expire: vi.fn(async () => true),
    sAdd: vi.fn(async () => 0),
    sRem: vi.fn(async () => 0),
    sMembers: vi.fn(async () => []),
    getCoordinationClient: vi.fn(() => null),
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => false),
    getKeysByPattern: vi.fn(async () => []),
    del: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    parseEmbyAuthHeader: () => ({}),
}));

vi.mock('$lib/server/jellyfin-compat/user-playback-preferences', () => ({
    loadUserPlaybackPreferences: vi.fn(async () => null),
}));
vi.mock('$lib/server/jellyfin-compat/serializers/user', () => ({
    serializeUser: (u: { id: string; username: string; hasLiveTvPermission: boolean }) => ({
        Id: u.id,
        Name: u.username,
        Policy: { EnableLiveTvAccess: u.hasLiveTvPermission },
    }),
}));

vi.mock('$lib/server/jellyfin-compat/playback-utils', () => ({
    clampJellyfinDeviceId: (raw: unknown) => (typeof raw === 'string' ? raw : ''),
}));

// Avoids dragging the task-system module graph in for a route that never
// touches password rotation.
vi.mock('$lib/server/tasks/secrets', () => ({
    jellyfinClientPasswordContext: (userId: string) => userId,
    rotateJellyfinClientPasswords: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    Database: class {
        getSql(): unknown {
            return {};
        }
    },
}));

// createSession() is not exercised via a password join here (Quick Connect
// has none) — it goes through `resolveTokenUserAccess`, so this route's
// disabled/deleted seam is proven by faking THAT resolver's DB row, exactly
// like resolve-token-user-access.test.ts.
const mockGetUserByUsername = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (...args: unknown[]) => mockGetUserByUsername(...args),
}));

// auth.ts also statically imports the client-password query module (used by
// the sibling AuthenticateByName path) — stubbed, never exercised here.
vi.mock('$lib/server/database/queries/jellyfin-client-passwords.queries', () => ({
    getPasswordByUserId: { one: vi.fn(async () => null) },
    getPasswordByUsername: { one: vi.fn(async () => null) },
    upsertPassword: { execute: vi.fn(async () => [{ id: 1 }]) },
    updateLastUsed: { execute: vi.fn(async () => []) },
    deletePassword: { execute: vi.fn(async () => []) },
    getUsersWithPasswords: { all: vi.fn(async () => []) },
}));

const mockResolveEffectiveAccess = vi.fn(
    async (_sql: unknown, _userId: string, syncedGroups: string[]) => ({
        inAppGroupNames: [] as string[],
        effectiveGroups: syncedGroups,
        capabilities: {},
    }),
);
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: [unknown, string, string[]]) =>
        mockResolveEffectiveAccess(...args),
}));

// Deterministic group-name config, mirroring resolve-token-user-access.test.ts —
// buildUserPermissions (pulled in by resolveTokenUserAccess) runs for REAL.
vi.mock('$lib/server/config.js', () => ({
    config: {
        ADMIN_GROUPS: ['admin-group'],
        AGE_RATING_GROUP_PREFIX: 'age-',
        WATCH_PERMISSION_GROUPS: [],
        LIVETV_GROUPS: [],
        REQUEST_GROUPS: [],
        SOCIAL_REVIEW_GROUPS: [],
        MEDIA_ANNOTATION_GROUPS: [],
        MODERATOR_GROUPS: [],
        LIVETV_HIGH_PRIORITY_GROUPS: [],
    },
}));

function dbRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: 'u1',
        username: 'gatekept',
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        groups: [] as string[],
        disabled_at: null,
        deleted_at: null,
        ...overrides,
    };
}

const { POST } = await import('./+server.js');

function makeEvent(secret: string): Parameters<typeof POST>[0] {
    const url = new URL('http://localhost/j/Users/AuthenticateWithQuickConnect');
    const headers = new Headers({ 'content-type': 'application/json' });
    const body = JSON.stringify({ Secret: secret });
    const request = new Request(url, { method: 'POST', headers, body });

    return {
        url,
        request,
        params: {},
        route: { id: null },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => '203.0.113.10',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
    mockAllowsLiveTv.mockReset().mockResolvedValue(true);
    qcStore.clear();
    vi.clearAllMocks();
    mockResolveEffectiveAccess.mockImplementation(
        async (_sql: unknown, _userId: string, syncedGroups: string[]) => ({
            inAppGroupNames: [],
            effectiveGroups: syncedGroups,
            capabilities: {},
        }),
    );
});

// `resolveTokenUserAccess` (which `createSession` now goes through) caches
// its verdict per USERNAME in the real, process-wide user-admin-cache /
// user-max-age-cache singletons (not mocked here — see the module doc
// comment on why a warm cache is exactly the thing task 6's C6 fix makes
// safe to rely on). Each test below therefore uses its OWN username/userId
// so a cached verdict from one test can never leak into another's — using
// the SAME username across a "disabled" test and the "control" test would
// let the first test's cached `disabled:true` silently answer the second.
function seedApprovedSecret(
    secret: string,
    code: string,
    opts: { userId: string; username: string },
): void {
    qcStore.set(
        `jfcompat:qc:secret:${secret}`,
        JSON.stringify({
            code,
            authenticated: true,
            userId: opts.userId,
            username: opts.username,
            isAdmin: false,
            groups: [],
            displayName: null,
        }),
    );
    qcStore.set(`jfcompat:qc:code:${code}`, secret);
}

describe('POST /j/Users/AuthenticateWithQuickConnect: disabled/deleted user rejected at session mint (C5)', () => {
    it('refuses completion for a disabled user (401, no session key written)', async () => {
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ username: 'gatekept-disabled', disabled_at: new Date() }),
        );
        seedApprovedSecret('sec-1', '111111', {
            userId: 'u-disabled',
            username: 'gatekept-disabled',
        });

        const response = await POST(makeEvent('sec-1'));

        expect(response.status).toBe(401);
        // No `jfcompat:session:*` key was ever written.
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it('refuses completion for a soft-deleted user (401, no session key written)', async () => {
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ username: 'gatekept-deleted', deleted_at: new Date() }),
        );
        seedApprovedSecret('sec-2', '222222', {
            userId: 'u-deleted',
            username: 'gatekept-deleted',
        });

        const response = await POST(makeEvent('sec-2'));

        expect(response.status).toBe(401);
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it('still cleans up the single-use QC secret + code keys even when denied', async () => {
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ username: 'gatekept-cleanup', disabled_at: new Date() }),
        );
        seedApprovedSecret('sec-3', '333333', {
            userId: 'u-cleanup',
            username: 'gatekept-cleanup',
        });

        await POST(makeEvent('sec-3'));

        expect(mockCacheDel).toHaveBeenCalledWith('jfcompat:qc:secret:sec-3');
        expect(mockCacheDel).toHaveBeenCalledWith('jfcompat:qc:code:333333');
    });

    it('accepts the SAME approved secret once the user is NOT disabled (control)', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow({ username: 'gatekept-active' }));
        seedApprovedSecret('sec-4', '444444', { userId: 'u-active', username: 'gatekept-active' });

        const response = await POST(makeEvent('sec-4'));

        expect(response.status).toBe(200);
        // createSession() writes the session key AND (via indexSessionForUser)
        // the per-user index's "built" marker — assert the session key
        // specifically was written, rather than the total call count.
        const sessionKeyWrites = mockCacheSet.mock.calls.filter(([key]) =>
            key.startsWith('jfcompat:session:'),
        );
        expect(sessionKeyWrites).toHaveLength(1);
        expect(JSON.parse(sessionKeyWrites[0]![1])).toMatchObject({ origin: 'quick_connect' });
    });
});

it('keeps the approved Quick Connect secret retryable when the account lookup is unavailable', async () => {
    seedApprovedSecret('sec-retry', '555555', { userId: 'u-retry', username: 'retry-user' });
    mockGetUserByUsername.mockRejectedValueOnce(
        Object.assign(new Error('down'), { code: 'ECONNRESET' }),
    );
    const response = await POST(makeEvent('sec-retry'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(mockCacheDel).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
});

it('hides Live TV immediately on Quick Connect sign-in', async () => {
    mockAllowsLiveTv.mockResolvedValue(false);
    mockGetUserByUsername.mockResolvedValue(
        dbRow({ username: 'tv-disabled-quickconnect', is_admin: true }),
    );
    seedApprovedSecret('sec-tv', '999999', {
        userId: 'u-tv',
        username: 'tv-disabled-quickconnect',
    });
    const data = JSON.parse(qcStore.get('jfcompat:qc:secret:sec-tv')!);
    qcStore.set('jfcompat:qc:secret:sec-tv', JSON.stringify({ ...data, isAdmin: true }));
    const response = await POST(makeEvent('sec-tv'));
    expect(response.status).toBe(200);
    expect((await response.json()).User.Policy.EnableLiveTvAccess).toBe(false);
});
