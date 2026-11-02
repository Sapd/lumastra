// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C3 backstop, fix round 1 (Important #2, security review 2026-09-16
 * reviewer finding): `admin-kind-v1-dual-mount.test.ts`'s parameterised
 * 11-def check builds its `Principal` with `buildPrincipal({…
 * ownerIsAdmin: false …})` directly — it INJECTS the post-fix verdict, so it
 * would have passed identically even against the unfixed `forward-auth.ts`
 * (it exercises `mount.ts`'s never-buggy `{kind:'admin'}` branch in
 * isolation, which is a legitimate and still-useful breadth check, but is
 * NOT itself a regression test for C2/C3).
 *
 * This file is the ONE seam case that actually closes that gap: a raw PAT
 * token, for a pin-demoted owner, driven through the REAL `resolveAuth()` ->
 * `mount(def, {surface:'v1'})` chain for one of the eleven defs
 * (`watch-stats.ts`, chosen because it is v1-only — no internal `/api/admin`
 * twin — so there is exactly one mount to check). This one WOULD have been
 * RED against the unfixed `handlePatAuth` (see the task report's RED/GREEN
 * evidence for this file). `admin-kind-v1-dual-mount.test.ts` remains the
 * breadth backstop across all eleven defs and both mounts; this file is the
 * depth proof that the breadth check's fixture is not vacuous.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: { ...actual.config, ADMIN_GROUPS: ['admins'] },
        features: { ...actual.features, deviceAuth: true },
    };
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const mockPatValidate = vi.fn();
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        validate: (...args: unknown[]) => mockPatValidate(...args),
        hasScope: () => true,
    }),
}));

const mockGetSql = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

const mockGetUserByUsername = vi.fn<(...args: unknown[]) => unknown>();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (...args: unknown[]) => mockGetUserByUsername(...args),
    upsertUser: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: async (
        _sql: unknown,
        _userId: string,
        syncedGroups: readonly string[],
    ) => ({ inAppGroupNames: [], effectiveGroups: [...syncedGroups], capabilities: {} }),
}));

// resolveTokenUserAccess() (now also consulted by handlePatAuth for the
// age-rating axis — security review C9/C10, 2026-09-15/16) opens its own
// `new Database().getSql()` handle, separate from aiDbService above.
vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): Record<string, never> {
            return {};
        }
    }
    return { Database: MockDatabase };
});

const { MAX_AGE_MISS_SENTINEL } = vi.hoisted(() => ({
    MAX_AGE_MISS_SENTINEL: Symbol('max-age-miss'),
}));
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
    getCachedMaxAge: () => MAX_AGE_MISS_SENTINEL,
    setCachedMaxAge: () => {},
}));

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
    invalidateUserAdminCache: () => {},
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => false),
    getKeysByPattern: vi.fn(async () => []),
    cacheGet: vi.fn(async () => null),
    setEx: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

// Import AFTER mocks.
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { mount } from '$lib/server/api/mount.js';
import { def as watchStatsDef } from './watch-stats.js';

const OWNER_ID = '99999999-9999-9999-9999-999999999999';

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/v1/admin/watch-stats');
    const request = new Request(url, {
        method: 'GET',
        headers: { authorization: 'Bearer pat_demotedwatchstats' },
    });
    return {
        request,
        url,
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
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const noopMigration = async (): Promise<void> => undefined;

describe('GET /api/v1/admin/watch-stats — pin-demoted admin-scoped PAT is 403 THROUGH resolveAuth + mount() (C3 seam depth check)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
    });

    it('403s a PAT whose owner is pin-demoted with a stale admin group', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: OWNER_ID,
            username: 'demoted-watchstats-owner',
            is_admin: false,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['admins'], // stale IdP group — pin must override it
            disabled_at: null,
            deleted_at: null,
        });
        mockPatValidate.mockResolvedValue({
            id: 99,
            userId: OWNER_ID,
            username: 'demoted-watchstats-owner',
            name: 'demoted-watchstats-owner-pat',
            scopes: ['admin'],
            groups: ['admins'],
            jellyfinUserId: null,
            tokenPrefix: 'pat_demotedwatchstats',
            allowedIps: null,
        });

        const event = makeEvent();

        // Step 1: the REAL forward-auth seam builds event.locals.principal.
        const authResult = await resolveAuth(event, noopMigration, true);
        expect(authResult).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('pat');
        expect(event.locals.principal?.isAdmin).toBe(false);

        // Step 2: the REAL mount()-wrapped def handler consumes that Principal.
        const { GET } = mount(watchStatsDef, { surface: 'v1' });
        const response = await GET!(event);

        expect(response.status).toBe(403);
    });
});
