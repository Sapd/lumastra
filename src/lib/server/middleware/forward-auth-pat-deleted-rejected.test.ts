// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Final whole-branch review, blocking finding 1: `handlePatAuth`'s
 * `resolveTokenUserAccess()` check at forward-auth.ts:1276 reads
 * `if (!tokenAccess || tokenAccess.disabled)` — missing `|| tokenAccess.deleted`.
 * Six of the resolver's seven callers (the stream-token branch, the OAuth
 * session branch, jellyfin-compat/middleware.ts, pat-auth.ts,
 * play-token-user.ts, and jellyfin-compat/auth.ts) check both columns; this
 * one, the `/api/v1` PAT producer, does not — against the resolver's own
 * stated contract at resolve-token-user-access.ts:120 ("Every caller that
 * checks `disabled` must check this alongside it").
 *
 * NOT currently exploitable: pat.service.ts's `validate()` already rejects
 * `deleted_at`/`disabled_at` before handlePatAuth ever runs (see
 * pat.service.ts:496-503). This test isolates the resolver check as its own
 * defence-in-depth layer by mocking `pat.service.js`'s `validate()` to
 * return a token for a soft-deleted owner AS IF that upstream guard were
 * absent or buggy — exactly the "sibling implementation of the same
 * decision left unvisited" shape this fix wave exists to close. The
 * pat.service.ts rejection itself is untouched by this test or the fix.
 *
 * Drives the REAL `resolveAuth()` -> `handlePatAuth()` seam (not
 * `resolveTokenUserAccess()` directly), mirroring
 * forward-auth-pat-group-freshness.test.ts's real-Map cache simulation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_JELLYFIN_COMPAT: false,
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
    features: { deviceAuth: true },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// Real, stateful cache simulation (per-username Maps) — same convention as
// forward-auth-pat-group-freshness.test.ts, so resolveRow()'s cache-first
// fast path is exercised faithfully rather than by a vi.fn() stub.
const adminCache = new Map<string, boolean>();
const adminPinnedCache = new Map<string, boolean>();
const disabledCache = new Map<string, boolean>();
const deletedCache = new Map<string, boolean>();
const userIdCache = new Map<string, string>();
const groupsCache = new Map<string, string[]>();

vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: (u: string) => (adminCache.has(u) ? (adminCache.get(u) ?? false) : null),
    setCachedIsAdmin: (u: string, v: boolean) => {
        adminCache.set(u, v);
    },
    getCachedAdminPinned: (u: string) =>
        adminPinnedCache.has(u) ? (adminPinnedCache.get(u) ?? false) : null,
    setCachedAdminPinned: (u: string, v: boolean) => {
        adminPinnedCache.set(u, v);
    },
    getCachedDisabled: (u: string) =>
        disabledCache.has(u) ? (disabledCache.get(u) ?? false) : null,
    setCachedDisabled: (u: string, v: boolean) => {
        disabledCache.set(u, v);
    },
    getCachedDeleted: (u: string) => (deletedCache.has(u) ? (deletedCache.get(u) ?? false) : null),
    setCachedDeleted: (u: string, v: boolean) => {
        deletedCache.set(u, v);
    },
    getCachedUserId: (u: string) => userIdCache.get(u) ?? null,
    setCachedUserId: (u: string, v: string) => {
        userIdCache.set(u, v);
    },
    getCachedGroups: (u: string) => groupsCache.get(u) ?? null,
    setCachedGroups: (u: string, v: string[]) => {
        groupsCache.set(u, v);
    },
    invalidateUserAdminCache: (u: string) => {
        adminCache.delete(u);
        adminPinnedCache.delete(u);
        disabledCache.delete(u);
        deletedCache.delete(u);
        userIdCache.delete(u);
        groupsCache.delete(u);
    },
}));

const { MAX_AGE_MISS_SENTINEL } = vi.hoisted(() => ({
    MAX_AGE_MISS_SENTINEL: Symbol('max-age-miss'),
}));
const maxAgeCache = new Map<string, number | null>();
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
    getCachedMaxAge: (u: string) =>
        maxAgeCache.has(u) ? maxAgeCache.get(u) : MAX_AGE_MISS_SENTINEL,
    setCachedMaxAge: (u: string, v: number | null) => {
        maxAgeCache.set(u, v);
    },
    invalidateUserMaxAgeCache: (u: string) => {
        maxAgeCache.delete(u);
    },
}));

vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): Record<string, never> {
            return {};
        }
    }
    return { Database: MockDatabase };
});

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: async (
        _sql: unknown,
        _userId: string,
        syncedGroups: readonly string[],
    ) => ({ inAppGroupNames: [], effectiveGroups: [...syncedGroups], capabilities: {} }),
}));

const PAT_OWNER_ID = '22222222-2222-2222-2222-222222222299';

// The "database row" behind getUserByUsername — this test's whole point is
// that `deleted_at` is non-null here (a soft-deleted account) while
// `disabled_at` stays null, so ONLY the missing `.deleted` check (not
// `.disabled`) is what's under test.
const dbRow = {
    id: PAT_OWNER_ID,
    username: 'soft-deleted-pat-owner',
    is_admin: false,
    admin_pinned: false,
    max_age_rating: null as number | null,
    age_rating_pinned: false,
    groups: ['some-group'] as string[],
    disabled_at: null as Date | null,
    deleted_at: new Date('2026-09-01T00:00:00Z') as Date | null,
};
const mockGetUserByUsername = vi.fn(async () => ({ ...dbRow }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: () => mockGetUserByUsername(),
}));

// pat.service.js's validate() is mocked to return a token for the
// soft-deleted owner AS IF its own deleted_at/disabled_at rejection
// (pat.service.ts:496-503) were not there — isolating handlePatAuth's own
// resolveTokenUserAccess() check as the thing under test.
const mockPatValidate = vi.fn(async () => ({
    id: 1,
    userId: PAT_OWNER_ID,
    username: 'soft-deleted-pat-owner',
    name: 'soft-deleted-pat',
    scopes: ['read'],
    groups: ['some-group'],
    jellyfinUserId: null,
    tokenPrefix: 'pat_deleted',
    allowedIps: null,
}));
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        validate: () => mockPatValidate(),
        hasScope: () => true,
    }),
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn() }),
}));
vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({ validate: vi.fn(), getStatus: vi.fn() }),
}));
vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => true),
    getKeysByPattern: vi.fn(async () => []),
    cacheGet: vi.fn(async () => null),
    setEx: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => null) },
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/v1/media');
    const headers = new Headers({ authorization: 'Bearer pat_deleted_token' });
    return {
        url,
        request: new Request(url, { headers }),
        params: {},
        route: { id: url.pathname },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const noopMigration = async (): Promise<void> => undefined;

describe('resolveAuth /api/v1 — PAT for a soft-deleted owner must be rejected even if pat.service.ts did not', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        adminCache.clear();
        adminPinnedCache.clear();
        disabledCache.clear();
        deletedCache.clear();
        userIdCache.clear();
        groupsCache.clear();
        maxAgeCache.clear();
        dbRow.disabled_at = null;
        dbRow.deleted_at = new Date('2026-09-01T00:00:00Z');
        mockGetUserByUsername.mockImplementation(async () => ({ ...dbRow }));
        mockPatValidate.mockImplementation(async () => ({
            id: 1,
            userId: PAT_OWNER_ID,
            username: 'soft-deleted-pat-owner',
            name: 'soft-deleted-pat',
            scopes: ['read'],
            groups: [...dbRow.groups],
            jellyfinUserId: null,
            tokenPrefix: 'pat_deleted',
            allowedIps: null,
        }));
    });

    it('rejects (401) a PAT whose owner is soft-deleted (deleted_at set, disabled_at NULL)', async () => {
        const event = makeEvent();
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeDefined();
        expect(result?.status).toBe(401);
        // Must not have set an authenticated user context for a deleted owner.
        expect(event.locals.user).toBeUndefined();
    });
});
