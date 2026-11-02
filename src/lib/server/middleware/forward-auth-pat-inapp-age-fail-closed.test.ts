// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-17, C12, review round 1 (Important 1): the
 * reviewer confirmed `resolve-token-user-access.ts`'s private
 * `resolveInAppAccessSafe()` (`:266-311`ish) has the IDENTICAL fail-open
 * shape the first C12 pass fixed in `forward-auth.ts`'s `resolveInAppAccess`
 * — on a `resolveEffectiveAccess()` error it returned `capabilities: {}`,
 * silently dropping an in-app cohort's MIN-merged `max_age_rating`
 * restriction instead of leaving it unavailable. This function backs
 * `resolveTokenUserAccess()`, which is the SHARED resolver behind all seven
 * token-derived-`UserContext` producers (HLS segments, music tracks, `/j`
 * play tokens, and — driven here — `/api/v1` PAT auth).
 *
 * This is NOT the same producer the original C12 test
 * (`forward-auth-c12-inapp-age-fail-closed.test.ts`) exercises: that file
 * drives the service-token IMPERSONATION branch, which fetches its row
 * directly and calls `resolveInAppAccess()` (forward-auth.ts's own copy) —
 * it never calls `resolveTokenUserAccess()` at all (by design; see that
 * function's own doc comment on why the impersonation branch stayed
 * id-keyed). This file drives `handlePatAuth()`, which DOES fully delegate
 * to `resolveTokenUserAccess()` (security review 2026-09-16, fix round 1) —
 * a genuinely different code path reaching the sibling copy of the bug.
 *
 * Deliberately does NOT mock `$lib/server/auth.js` — the REAL
 * `buildUserPermissions`/`mergeMaxAge` must run for this test to mean
 * anything (see the sibling C12 test file's doc comment for why the shared
 * `forward-auth.test.ts` mock of `buildUserPermissions` cannot be reused
 * here).
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

// Real, stateful cache simulation (per-username Maps) so resolveRow()'s
// cache-first fast path is exercised faithfully and always misses (a fresh
// Map, never pre-populated) — same convention as
// forward-auth-pat-deleted-rejected.test.ts and
// forward-auth-pat-group-freshness.test.ts. A cold cache is exactly the
// "cold cache + DB error" scenario the finding names.
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

const PAT_OWNER_ID = '33333333-3333-3333-3333-333333333399';

// No direct per-user pin (age_rating_pinned:false) and no age group — this
// account's ONLY possible age restriction is in-app-cohort-conferred, which
// is exactly what resolveEffectiveAccess would supply on a healthy call.
const dbRow = {
    id: PAT_OWNER_ID,
    username: 'in-app-only-pat-owner',
    is_admin: false,
    admin_pinned: false,
    max_age_rating: null as number | null,
    age_rating_pinned: false,
    groups: [] as string[],
    disabled_at: null as Date | null,
    deleted_at: null as Date | null,
};
const mockGetUserByUsername = vi.fn(async () => ({ ...dbRow }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: () => mockGetUserByUsername(),
}));

// The in-app access DB read — mocked to THROW, simulating the DB hiccup on
// a cold access-cache. Real `resolveInAppAccessSafe` (resolve-token-user-
// access.ts) catches this.
const mockResolveEffectiveAccess = vi.fn(
    async (_sql: unknown, _userId: string, _syncedGroups: readonly string[]) => {
        throw Object.assign(new Error('access-control DB read failed (simulated)'), {
            code: 'CONNECTION_CLOSED',
        });
    },
);
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: [unknown, string, readonly string[]]) =>
        mockResolveEffectiveAccess(...args),
}));

const mockPatValidate = vi.fn();
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
    const headers = new Headers({ authorization: 'Bearer pat_inapp_only_token' });
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

describe('resolveAuth /api/v1 — PAT: resolveTokenUserAccess (via resolveInAppAccessSafe) must fail CLOSED on the age axis during a DB error (C12, review round 1 Important 1)', () => {
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
        dbRow.deleted_at = null;
        dbRow.max_age_rating = null;
        dbRow.age_rating_pinned = false;
        dbRow.groups = [];
        mockGetUserByUsername.mockImplementation(async () => ({ ...dbRow }));
        mockResolveEffectiveAccess.mockImplementation(async () => {
            throw Object.assign(new Error('access-control DB read failed (simulated)'), {
                code: 'CONNECTION_CLOSED',
            });
        });
        mockPatValidate.mockImplementation(async () => ({
            id: 1,
            userId: PAT_OWNER_ID,
            username: 'in-app-only-pat-owner',
            name: 'in-app-only-pat',
            scopes: ['read'],
            groups: [...dbRow.groups],
            jellyfinUserId: null,
            tokenPrefix: 'pat_inapp',
            allowedIps: null,
        }));
    });

    it('denies temporarily rather than fabricating an age ceiling when access resolution fails', async () => {
        const event = makeEvent();
        const result = await resolveAuth(event, noopMigration, true);
        expect(result?.status).toBe(503);
        expect(result?.headers.get('Retry-After')).toBe('5');
        expect(event.locals.user).toBeUndefined();
        expect(mockResolveEffectiveAccess).toHaveBeenCalled();
    });
});
