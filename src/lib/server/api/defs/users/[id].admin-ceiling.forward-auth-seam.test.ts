// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C2 backstop (security review 2026-09-15): `PATCH /api/v1/users/{self}
 * {isAdmin:true}` must 403 for an admin-scoped PAT whose owner has been
 * pin-demoted (admin_pinned:true, is_admin:false) even though their STALE
 * `users.groups` still lists an admin group — and `users.is_admin` must stay
 * unchanged.
 *
 * `[id].admin-ceiling.test.ts` (same directory) already covers the ceiling
 * LOGIC inside the handler, but it hand-builds `Principal` via
 * `buildPrincipal()` directly and calls `def.handlers.PATCH!` directly,
 * bypassing both `mount()` and `resolveAuth()` — so it injects `ownerIsAdmin`
 * as a test input rather than letting forward-auth.ts DERIVE it. That shape
 * is exactly why C2 shipped: forward-auth.ts's `handlePatAuth` built a raw,
 * group-only `ownerIsAdmin` and no test drove that real code path with a
 * pin-demoted fixture. This file drives the REAL seam instead:
 *
 *   raw PAT token -> resolveAuth() (forward-auth.ts, unmocked) ->
 *   event.locals.principal -> mount(def, {surface:'v1'}) -> requireAdminCeiling()
 *
 * Only the DB/cache/service LEAVES are mocked; `resolve-owner-admin-status.ts`,
 * `principal.ts`, `mount.ts`, `token-minting.ts`, and `auth.ts` all run for real.
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
const mockUpsertUser = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
const mockGetUserById = vi.fn<(...args: unknown[]) => unknown>();
const mockSetIsAdmin = vi.fn<(...args: unknown[]) => unknown>();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (...args: unknown[]) => mockGetUserByUsername(...args),
    upsertUser: (...args: unknown[]) => mockUpsertUser(...args),
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
    setIsAdmin: (...args: unknown[]) => mockSetIsAdmin(...args),
    setMaxAgeRating: vi.fn(),
}));

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: async (
        _sql: unknown,
        _userId: string,
        syncedGroups: readonly string[],
    ) => ({ inAppGroupNames: [], effectiveGroups: [...syncedGroups], capabilities: {} }),
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

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));

// Import AFTER mocks.
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { mount } from '$lib/server/api/mount.js';
import { def } from './[id].js';

const SELF_ID = '11111111-1111-1111-1111-111111111199';

function makeEvent(): RequestEvent {
    const url = new URL(`http://localhost/api/v1/users/${SELF_ID}`);
    const request = new Request(url, {
        method: 'PATCH',
        headers: {
            authorization: 'Bearer pat_demotedowner',
            'content-type': 'application/json',
        },
        body: JSON.stringify({ isAdmin: true }),
    });
    return {
        request,
        url,
        params: { id: SELF_ID },
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

describe('PATCH /api/v1/users/{self} {isAdmin:true} — pin-demoted PAT owner gets 403 THROUGH resolveAuth (C2 backstop)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({} as never);
        mockGetUserById.mockResolvedValue({
            id: SELF_ID,
            username: 'demoted-owner',
            is_admin: false,
            admin_pinned: true,
            disabled_at: null,
            deleted_at: null,
        });
        mockSetIsAdmin.mockResolvedValue(undefined);
    });

    it('403s and never calls setIsAdmin, for a PAT whose owner is pin-demoted with a stale admin group', async () => {
        // The owner has admin_pinned:true, is_admin:false, but a STALE
        // users.groups entry still lists the admin group — the exact state
        // setIsAdmin(false) produces (security review report, C2 Principal
        // section). A pre-fix forward-auth.ts would have derived
        // ownerIsAdmin from groups alone and granted admin here.
        mockGetUserByUsername.mockResolvedValue({
            id: SELF_ID,
            username: 'demoted-owner',
            is_admin: false,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['admins'],
            disabled_at: null,
            deleted_at: null,
        });
        mockPatValidate.mockResolvedValue({
            id: 42,
            userId: SELF_ID,
            username: 'demoted-owner',
            name: 'demoted-owner-pat',
            scopes: ['admin'],
            groups: ['admins'],
            jellyfinUserId: null,
            tokenPrefix: 'pat_demotedowner',
            allowedIps: null,
        });

        const event = makeEvent();

        // Step 1: the REAL forward-auth seam builds event.locals.principal.
        const authResult = await resolveAuth(event, noopMigration, true);
        expect(authResult).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('pat');
        // This is the C2 assertion in miniature: ownerIsAdmin must NOT come
        // from the stale 'admins' group.
        expect(event.locals.principal?.isAdmin).toBe(false);

        // Step 2: the REAL mount()-wrapped def handler consumes that Principal.
        const { PATCH } = mount(def, { surface: 'v1' });
        const response = await PATCH!(event);

        expect(response.status).toBe(403);
        expect(mockSetIsAdmin).not.toHaveBeenCalled();
    });
});
