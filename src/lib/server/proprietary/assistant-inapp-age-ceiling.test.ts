// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `assistant-service.ts`'s `resolveUser()` must apply the SAME age ceiling a
 * normal HTTP request gets — its own doc comment promises the RAG access
 * boundary is "identical to a normal HTTP request", age gate included.
 *
 * Before this fix it called `buildUserPermissions(userGroups)` with NO
 * `extraCapabilities`, so the in-app cohort layer never participated. Per
 * `access-control.service.ts`, the in-app layer drives age ONLY through the
 * MIN-merged `max_age_rating` capability (age-NAMED in-app groups are
 * deliberately stripped so a permissive cohort can't RAISE a ceiling) — so a
 * bare `buildUserPermissions(groups)` call drops an in-app-conferred ceiling
 * entirely, permanently, not just during a DB fault. On a standalone (no-IdP)
 * install the in-app cohort IS the age mechanism, which makes this the primary
 * path rather than an edge case.
 *
 * It also merged the per-user pin with `row.max_age_rating ?? derived` — a
 * `??`, not the MIN-merge every other surface uses, and blind to
 * `age_rating_pinned`.
 *
 * `buildUserPermissions` is deliberately NOT mocked here: the whole behaviour
 * under test is its `extraCapabilities` MIN-merge, and a stub returning a
 * constant `maxAgeRating` could not exercise it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Heavy assistant-service dependencies (mirrors assistant-deescalation.test.ts) ---
vi.mock('$lib/server/config', () => ({
    config: {
        ADMIN_GROUPS: ['admin'],
        WATCH_PERMISSION_GROUPS: ['admin'],
        LIVETV_GROUPS: ['livetv'],
        REQUEST_GROUPS: [],
        SOCIAL_REVIEW_GROUPS: [],
        MEDIA_ANNOTATION_GROUPS: [],
        MODERATOR_GROUPS: [],
        LIVETV_HIGH_PRIORITY_GROUPS: [],
        ARR_MANAGER_GROUPS: [],
        AGE_RATING_GROUP_PREFIX: 'age-',
    },
    features: { sessionsPublic: false, audiobooks: false, kavita: false, personalStats: false },
}));

vi.mock('$lib/server/config/domains/ai', () => ({
    getAiConfig: () => ({
        openaiApiKey: 'test-key',
        openaiChatApiKey: 'test-key',
        openaiChatModel: 'gpt-4o',
        assistantName: 'Assistant',
        assistantDailyTokenLimitAdmin: 1_000_000,
        assistantDailyTokenLimitUser: 1_000_000,
    }),
}));

vi.mock('$lib/server/proprietary/assistant-tools/capability', () => ({
    assistantToolsEnabled: () => true,
}));
vi.mock('$lib/server/database/queries/assistant-rag.queries', () => ({
    getUserRecentRatings: async () => [],
    getDailyTokenUsage: async () => 0,
    recordChatTokenUsage: async () => undefined,
    findRelevantMediaByVector: async () => [],
}));
vi.mock('$lib/server/database/queries/user-watch-history.queries', () => ({
    getRecentWatchedWithTitles: { all: async () => [] },
}));
vi.mock('$lib/server/database/queries/assistant.queries', () => ({
    insertUserMessage: async () => undefined,
    insertAssistantMessage: async () => undefined,
}));
vi.mock('$lib/server/proprietary/assistant-tools/dispatch', () => ({
    runAssistantToolLoop: async () => ({ finalText: 'ok' }),
}));
vi.mock('openai', () => ({ default: class OpenAI {} }));
vi.mock('$lib/server/proprietary/assistant-tools/registry', () => ({
    buildAssistantTools: () => [],
}));

// --- The identity/access seam under test -----------------------------------

const USER_ID = '44444444-4444-4444-4444-444444444401';

vi.mock('$lib/server/auth/resolve-user-id.js', () => ({
    resolveUserIdByUsername: async () => USER_ID,
}));

// No age group, no per-user pin: this account's ONLY age restriction is the
// in-app cohort below — precisely the shape a bare buildUserPermissions(groups)
// call silently drops.
const dbRow = {
    id: USER_ID,
    username: 'inapp-only-kid',
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
    getUserByUsername: (_sql: unknown, _u: string) => mockGetUserByUsername(),
}));

const mockResolveEffectiveAccess = vi.fn(
    async (_sql: unknown, _userId: string, syncedGroups: readonly string[]) => ({
        inAppGroupNames: ['kids-cohort'],
        effectiveGroups: [...syncedGroups, 'kids-cohort'],
        capabilities: { maxAgeRating: 6 },
    }),
);
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: [unknown, string, readonly string[]]) =>
        mockResolveEffectiveAccess(...args),
}));

// Always-cold user caches so the resolver takes its DB branch every time.
const { caches } = vi.hoisted(() => ({
    caches: {
        admin: new Map<string, boolean>(),
        adminPinned: new Map<string, boolean>(),
        disabled: new Map<string, boolean>(),
        deleted: new Map<string, boolean>(),
        userId: new Map<string, string>(),
        groups: new Map<string, string[]>(),
        maxAge: new Map<string, number | null>(),
    },
}));

vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: (u: string) => (caches.admin.has(u) ? (caches.admin.get(u) ?? false) : null),
    setCachedIsAdmin: (u: string, v: boolean) => void caches.admin.set(u, v),
    getCachedAdminPinned: (u: string) =>
        caches.adminPinned.has(u) ? (caches.adminPinned.get(u) ?? false) : null,
    setCachedAdminPinned: (u: string, v: boolean) => void caches.adminPinned.set(u, v),
    getCachedDisabled: (u: string) =>
        caches.disabled.has(u) ? (caches.disabled.get(u) ?? false) : null,
    setCachedDisabled: (u: string, v: boolean) => void caches.disabled.set(u, v),
    getCachedDeleted: (u: string) =>
        caches.deleted.has(u) ? (caches.deleted.get(u) ?? false) : null,
    setCachedDeleted: (u: string, v: boolean) => void caches.deleted.set(u, v),
    getCachedUserId: (u: string) => caches.userId.get(u) ?? null,
    setCachedUserId: (u: string, v: string) => void caches.userId.set(u, v),
    getCachedGroups: (u: string) => caches.groups.get(u) ?? null,
    setCachedGroups: (u: string, v: string[]) => void caches.groups.set(u, v),
}));

const { MAX_AGE_MISS_SENTINEL } = vi.hoisted(() => ({
    MAX_AGE_MISS_SENTINEL: Symbol('max-age-miss'),
}));
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
    getCachedMaxAge: (u: string) =>
        caches.maxAge.has(u) ? caches.maxAge.get(u) : MAX_AGE_MISS_SENTINEL,
    setCachedMaxAge: (u: string, v: number | null) => void caches.maxAge.set(u, v),
}));

vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): Record<string, never> {
            return {};
        }
    }
    return { Database: MockDatabase, getDb: () => ({}) };
});

const { resolveUser } = await import('./assistant-service.js');

describe('assistant resolveUser() — the RAG access boundary must carry the in-app age ceiling', () => {
    beforeEach(() => {
        for (const c of Object.values(caches)) c.clear();
        mockResolveEffectiveAccess.mockClear();
        mockGetUserByUsername.mockClear();
    });

    it('applies an in-app-cohort-conferred max_age_rating that no group or per-user pin supplies', async () => {
        const user = await resolveUser({} as never, 'inapp-only-kid');

        // The bug: this resolved maxAgeRating:null / isAgeRestricted:false,
        // handing the RAG pipeline an unrestricted boundary for a user the
        // HTTP path caps at 6.
        expect(user?.maxAgeRating).toBe(6);
        expect(user?.isAgeRestricted).toBe(true);
        expect(mockResolveEffectiveAccess).toHaveBeenCalled();
    });

    it('takes the MOST RESTRICTIVE of a permissive per-user pin and a stricter in-app cohort', async () => {
        // A pin of 18 must NOT raise the cohort's ceiling of 6. The pre-fix
        // `row.max_age_rating ?? derived` returned the pin (18) outright.
        mockGetUserByUsername.mockResolvedValueOnce({
            ...dbRow,
            max_age_rating: 18,
            age_rating_pinned: true,
        });

        const user = await resolveUser({} as never, 'inapp-only-kid');

        expect(user?.maxAgeRating).toBe(6);
        expect(user?.isAgeRestricted).toBe(true);
    });

    it('fails closed (null) when the access layer cannot resolve the user row', async () => {
        mockGetUserByUsername.mockResolvedValueOnce(null as never);

        const user = await resolveUser({} as never, 'inapp-only-kid');

        // Pre-fix this returned a fully UNRESTRICTED context built from `[]`
        // groups rather than refusing to answer.
        expect(user).toBeNull();
    });

    it('fails closed (null) for a disabled user row (C5)', async () => {
        // Pre-fix: `resolveUser` only checked `if (!access) return null;` and
        // never read `access.disabled`, so a disabled account's RAG bridge
        // stayed open as long as its `users.id` still resolved.
        mockGetUserByUsername.mockResolvedValueOnce({
            ...dbRow,
            disabled_at: new Date(),
        });

        const user = await resolveUser({} as never, 'inapp-only-kid');

        expect(user).toBeNull();
    });

    it('fails closed (null) for a soft-deleted user row (C5)', async () => {
        mockGetUserByUsername.mockResolvedValueOnce({
            ...dbRow,
            deleted_at: new Date(),
        });

        const user = await resolveUser({} as never, 'inapp-only-kid');

        expect(user).toBeNull();
    });
});
