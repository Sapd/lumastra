// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * FIX ROUND 1 (Important #3, security review 2026-09-16): the C9 finding's
 * full path trace runs `GET /j/Videos/{itemId}/master.m3u8` -> the REAL
 * `withJellyfinAuth` middleware (populates `locals.user` via
 * `resolveTokenUserAccess`) -> the REAL `checkMediaAccess` gate
 * (`media-access.ts`), which reads `locals.user.isAgeRestricted`/
 * `maxAgeRating`. `middleware.test.ts`'s coverage only proves the FIRST half
 * (the middleware populates the field correctly) — it does not prove this
 * ROUTE actually reads `locals.user` and 404s. `server.test.ts` in this same
 * directory mocks BOTH `withJellyfinAuth` (identity passthrough) AND
 * `checkMediaAccess` wholesale, so it cannot catch a regression in the wiring
 * between them either — a reviewer's first-round scope call that this
 * coverage was unnecessary was rejected for exactly that reason.
 *
 * This file drives the REAL `withJellyfinAuth` and the REAL `checkMediaAccess`
 * (unmocked) with a pinned session user (age_rating_pinned=true,
 * max_age_rating=6, no age group) against an 18-rated item, and asserts 404.
 * Only the DB/cache LEAVES are mocked: the Valkey session lookup, the
 * `users` row read `resolveTokenUserAccess` needs, the in-app access layer,
 * and the two SQL reads `checkMediaAccess` performs (library-group
 * restrictions — mocked to "none configured" so only the age axis is under
 * test — and the item's `age_rating`).
 *
 * A DENIED request never reaches `startHlsPlayback` (the route returns 404
 * immediately after `checkMediaAccess`), so the HLS transcoding pipeline
 * needs no mocking here — that is a deliberate scope boundary, not an
 * oversight: this file proves the age gate is WIRED, not the transcoder's
 * own behavior (which has its own extensive test coverage elsewhere).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks — DB/cache leaves only; withJellyfinAuth and checkMediaAccess
//    are the REAL implementations. ───────────────────────────────────────────

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            ...actual.config,
            ADMIN_GROUPS: ['admin-group'],
            AGE_RATING_GROUP_PREFIX: 'age-',
            UNRATED_CONTENT_VISIBLE: true,
        },
        features: { ...actual.features, ffmpegAvailable: true },
    };
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// Valkey session lookup (jellyfin-compat/auth.ts) — this test injects the
// session directly rather than exercising real Valkey.
const SESSION_USER = {
    userId: 'aaaaaaaa-0000-4000-a000-000000000001',
    username: 'kid-account',
    isAdmin: false,
    groups: [] as string[],
    displayName: 'Kid Account',
    deviceId: 'dev-1',
    deviceName: 'AppleTV',
    clientName: 'Swiftfin tvOS',
    clientVersion: '1.0',
    createdAt: '2024-01-01T00:00:00Z',
};
vi.mock('$lib/server/proprietary/jellyfin-compat/auth', () => ({
    validateSession: vi.fn(async () => SESSION_USER),
    revokeSession: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/pat-auth', () => ({
    validateJellyfinCompatPat: vi.fn(async () => null),
}));

// resolveTokenUserAccess's own DB/cache dependencies — cache always cold so
// the test is driven deterministically via mockGetUserByUsername.
vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: () => null,
    setCachedIsAdmin: () => {},
    getCachedAdminPinned: () => null,
    setCachedAdminPinned: () => {},
    getCachedDisabled: () => null,
    setCachedDisabled: () => {},
    getCachedDeleted: () => null,
    setCachedDeleted: () => {},
    getCachedUserId: () => null,
    setCachedUserId: () => {},
    getCachedGroups: () => null,
    setCachedGroups: () => {},
}));
const { MAX_AGE_MISS_SENTINEL } = vi.hoisted(() => ({
    MAX_AGE_MISS_SENTINEL: Symbol('max-age-miss'),
}));
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
    getCachedMaxAge: () => MAX_AGE_MISS_SENTINEL,
    setCachedMaxAge: () => {},
}));

const mockGetUserByUsername = vi.fn(async (username: string) => ({
    id: '00000000-0000-0000-0000-000000000001',
    username,
    is_admin: false,
    admin_pinned: false,
    // The pin under test: capped at 6, no age group.
    max_age_rating: 6,
    age_rating_pinned: true,
    groups: [] as string[],
    disabled_at: null,
    deleted_at: null,
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (username: string) => mockGetUserByUsername(username),
}));

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: async (
        _sql: unknown,
        _userId: string,
        syncedGroups: readonly string[],
    ) => ({ inAppGroupNames: [], effectiveGroups: [...syncedGroups], capabilities: {} }),
}));

vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): Record<string, never> {
            return {};
        }
    }
    // getDb() is ALSO imported directly from this module by unrelated
    // services pulled in transitively through the route's import graph
    // (e.g. watch-history.service.ts's module-scope singleton) — export it
    // alongside Database so those modules don't see `undefined` at import
    // time. Returns null (matching the module's own "no pool yet" shape),
    // which is safe: nothing this test exercises calls it.
    return { Database: MockDatabase, getDb: () => null };
});

vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

// checkMediaAccess's library-axis dependency: no restrictions configured, so
// isMediaAccessible() short-circuits to true without touching media_items —
// this test is about the AGE axis only.
vi.mock('$lib/server/database/queries/library-group-permissions.queries.js', () => ({
    getAllLibraryGroupPermissions: async () => [],
}));

// checkMediaAccess's age-axis dependency: getDb() returns a `sql` used as a
// tagged template by getAgeRating() (`SELECT age_rating FROM media_items ...`).
// The item under test is rated 18.
const mockSql = vi.fn(async () => [{ age_rating: 18 }]);
vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => mockSql,
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { GET } from './+server';

const ITEM_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

function makeEvent(): RequestEvent {
    const url = new URL(`https://example.test/j/Videos/${ITEM_ID}/master.m3u8`);
    return {
        params: { itemId: ITEM_ID },
        route: { id: '/(proprietary)/j/Videos/[itemId]/master.m3u8' },
        url,
        request: {
            headers: {
                get: (name: string) =>
                    name.toLowerCase() === 'x-emby-authorization'
                        ? 'MediaBrowser Token=session-tok'
                        : null,
            },
            method: 'GET',
        },
        locals: {},
        cookies: { get: vi.fn(), set: vi.fn() },
        getClientAddress: () => '127.0.0.1',
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
}

describe('GET /j/Videos/[itemId]/master.m3u8 — C9 age gate is actually wired (fix round 1, Important #3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            username: 'kid-account',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: 6,
            age_rating_pinned: true,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });
        mockSql.mockResolvedValue([{ age_rating: 18 }]);
    });

    it('a pinned user (max_age_rating=6, no age group) requesting an 18-rated item gets 404, via the REAL middleware + REAL checkMediaAccess', async () => {
        const response = await (GET as unknown as (event: RequestEvent) => Promise<Response>)(
            makeEvent(),
        );

        expect(response.status).toBe(404);
    });
});
