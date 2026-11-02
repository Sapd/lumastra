// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-23, C3 (`PATCH /api/v1/users/{id}` writes
 * `max_age_rating` with no cache invalidation, on any replica) + Shape B (the
 * v1 def is a second write surface for the same columns as the admin def,
 * and every control was added to the admin sibling alone).
 *
 * `user-max-age-cache.js` is deliberately UNMOCKED here (unlike the sibling
 * `.admin-ceiling.*` unit tests) so this test observes the REAL cache
 * eviction and the REAL cross-replica publish via `auth-cache-bus.ts`, not a
 * stubbed invalidator that would pass even if the def never called it.
 * `describe.each` runs the SAME assertions against both PATCH handlers: the
 * admin def (`defs/admin/users/[username]/index.ts`) is the GREEN control —
 * it already invalidates today — so a failure isolated to the v1 def proves
 * the def, not the assertion, is what is broken (memory: "a signal without a
 * comparison is not evidence").
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import type { ApiContext } from '$lib/server/api/define.js';
import type { UserRow } from '$lib/server/database/queries/users.queries.js';

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));

const mockGetUserById = vi.fn();
const mockGetUserByUsername = vi.fn();
const mockSetMaxAgeRating = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
    getUserByUsername: (...args: unknown[]) => mockGetUserByUsername(...args),
    setMaxAgeRating: (...args: unknown[]) => mockSetMaxAgeRating(...args),
    unpinAgeRating: vi.fn(),
    syncAgeRatingFromGroups: vi.fn(),
    setIsAdmin: vi.fn(),
    unpinAdmin: vi.fn(),
    syncAdminFromGroups: vi.fn(),
    adminCreateUser: vi.fn(),
    setUserPassword: vi.fn(),
    setUserDisabled: vi.fn(),
}));

vi.mock('$lib/server/database/queries/access-groups.queries.js', () => ({
    countOtherEffectiveAdmins: vi.fn(),
    isLastEffectiveAdmin: vi.fn(),
    withLastAdminGuardLock: (_sql: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    invalidateUserAdminCache: vi.fn(),
}));

// Deliberately NOT mocking $lib/server/cache/user-max-age-cache.js — this
// test exercises the REAL cache + the REAL auth-cache-bus publish path.

const mockPublishMessage = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: (...args: unknown[]) => mockPublishMessage(...args),
    subscribeToChannel: vi.fn(async () => undefined),
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => false),
}));

vi.mock('$lib/server/services/credential-revocation.service.js', () => ({
    revokeAllCredentialsForUser: vi.fn(async () => ({ failedStores: [] })),
    narrowAdminScopedCredentialsForUser: vi.fn(async () => ({ failedStores: [] })),
    restoreAdminScopedCredentialsForUser: vi.fn(async () => ({ failedStores: [] })),
}));

vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, config: { ...actual.config, ADMIN_GROUPS: [] } };
});

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({ checkRateLimit: vi.fn() }));
vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIpStrict: vi.fn() }));

// Import AFTER mocks.
import { def as usersIdDef } from './[id].js';
import { def as adminUsersDef } from '../admin/users/[username]/index.js';
import {
    getCachedMaxAge,
    setCachedMaxAge,
    MAX_AGE_MISS,
} from '$lib/server/cache/user-max-age-cache.js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');
const USERNAME = 'kid';

function userRow(overrides: Partial<UserRow> = {}): UserRow {
    return {
        id: USER_ID,
        username: USERNAME,
        is_admin: false,
        admin_pinned: false,
        max_age_rating: 18,
        age_rating_pinned: true,
        display_name: null,
        email: null,
        hide_streams: false,
        groups: [],
        groups_updated_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        last_seen_at: null,
        disabled_at: null,
        deleted_at: null,
        avatar_data: null,
        avatar_content_type: null,
        ...overrides,
    };
}

const adminSession = buildPrincipal({
    kind: 'session',
    userId: toUserId('00000000-0000-0000-0000-000000000099'),
    username: 'root',
    userGroups: ['admins'],
    sessionIsAdmin: true,
});

type Case = {
    name: string;
    callPatch: (body: unknown) => Promise<Response>;
};

const v1Case: Case = {
    name: 'v1 def (defs/users/[id].ts)',
    callPatch: async (body: unknown) => {
        const PATCH = usersIdDef.handlers.PATCH!;
        const event = {
            request: new Request(`http://localhost/api/v1/users/${USER_ID}`, { method: 'PATCH' }),
            url: new URL(`http://localhost/api/v1/users/${USER_ID}`),
            params: { id: USER_ID },
            locals: { principal: adminSession, user: undefined },
        } as unknown as RequestEvent;
        const ctx = { surface: 'v1', input: { body } } as unknown as ApiContext;
        return PATCH(event, ctx);
    },
};

const adminCase: Case = {
    name: 'admin def (defs/admin/users/[username]/index.ts) — GREEN control',
    callPatch: async (body: unknown) => {
        const PATCH = adminUsersDef.handlers.PATCH!;
        const event = {
            request: new Request(`http://localhost/api/admin/users/${USERNAME}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }),
            url: new URL(`http://localhost/api/admin/users/${USERNAME}`),
            params: { username: USERNAME },
            locals: { principal: adminSession, user: undefined },
        } as unknown as RequestEvent;
        const ctx = { surface: 'internal' } as unknown as ApiContext;
        return PATCH(event, ctx);
    },
};

describe.each([v1Case, adminCase])(
    '$name: PATCH {maxAgeRating:6} invalidates user-max-age-cache cross-replica',
    ({ callPatch }) => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockGetUserById.mockResolvedValue(userRow());
            mockGetUserByUsername.mockResolvedValue(userRow());
            mockSetMaxAgeRating.mockResolvedValue(userRow({ max_age_rating: 6 }));
            mockPublishMessage.mockResolvedValue(true);
        });

        it('evicts the warm cache entry and publishes a user-max-age invalidation', async () => {
            // Seed the cache exactly like a warm replica would have it.
            setCachedMaxAge(USERNAME, 18);
            expect(getCachedMaxAge(USERNAME)).toBe(18);

            const res = await callPatch({ maxAgeRating: 6 });
            expect(res.status).toBeLessThan(300);

            // RED at HEAD for the v1 def: it called the bare query with no
            // invalidation, so the entry stayed warm at the stale value.
            expect(getCachedMaxAge(USERNAME)).toBe(MAX_AGE_MISS);

            expect(mockPublishMessage).toHaveBeenCalledWith(
                'auth:cache:invalidate',
                expect.stringContaining('"kind":"user-max-age"'),
            );
        });
    },
);
