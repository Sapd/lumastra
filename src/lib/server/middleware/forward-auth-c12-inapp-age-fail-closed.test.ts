// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-17, C12: `resolveInAppAccess()`
 * (forward-auth.ts:270-360ish) is the single shared producer for THREE auth
 * surfaces — the service-token impersonation branch (exercised here), the
 * native/OIDC session-cookie path, and the main forward-auth header path.
 * All three feed its `extraCapabilities` into the SAME
 * `buildUserPermissions()`/`mergeMaxAge()` most-restrictive (MIN) merge, so a
 * failure inside `resolveEffectiveAccess()` (the access-control DB read,
 * independent of the users-table read `resolveDbAuth`/the impersonation
 * row-fetch already does) produces the IDENTICAL "restriction silently
 * dropped" outcome on all three — one shared function, one bug, three
 * surfaces, not three independent copies. This test drives the
 * impersonation surface as the real producer; the other two share the
 * outcome because they call the exact same `resolveInAppAccess()` with the
 * exact same error-path return value (see that function's own doc comment).
 *
 * Before the fix, `resolveInAppAccess()`'s catch block returned
 * `extraCapabilities: {}` on ANY error — silently dropping an in-app
 * cohort's MIN-merged `max_age_rating` restriction rather than merely
 * leaving it unavailable-and-cached. For an account whose ONLY age
 * restriction is in-app-cohort-conferred (no direct `users.age_rating_pinned`),
 * that meant `mergeMaxAge`/`buildUserPermissions` saw NO restriction from
 * this layer during the failure window: the account browsed/streamed above
 * its configured ceiling for as long as the fault lasted — a fail-OPEN on
 * the age axis specifically (every other, additive axis correctly fails
 * closed to "no extra capability").
 *
 * This file deliberately does NOT mock `$lib/server/auth.js` (unlike
 * forward-auth.test.ts's shared mock, which stubs `buildUserPermissions` to
 * always return `maxAgeRating: null` — a simplification that cannot exercise
 * this merge at all) — the REAL `buildUserPermissions`/`mergeMaxAge` must run
 * for this test to mean anything, since the bug and the fix both live in
 * what `resolveInAppAccess` feeds into that real merge.
 *
 * Drives the REAL `resolveAuth()` -> `handleServiceTokenAuth()` seam (token
 * validation, per-token gates, impersonation-target row fetch, in-app merge,
 * UserContext construction) — not `resolveInAppAccess()` directly.
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

// The impersonation-target row fetch — its own dedicated `new
// Database().getSql()` tagged-template query (NOT the resolveInAppAccess
// path). No direct per-user pin: age_rating_pinned:false, max_age_rating:null
// — this account's only possible age restriction is in-app-cohort-conferred.
const mockImpersonationRow = {
    username: 'in-app-only-target',
    groups: [] as string[],
    disabled_at: null as Date | null,
    deleted_at: null as Date | null,
    is_admin: false,
    admin_pinned: false,
    max_age_rating: null as number | null,
    age_rating_pinned: false,
};
const mockSqlQuery = vi.fn(async () => [mockImpersonationRow]);
vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): typeof mockSqlQuery {
            return mockSqlQuery;
        }
    }
    return { Database: MockDatabase };
});

// resolveInAppAccess's OWN sql source. Controllable per test: a truthy
// stand-in (default) lets it proceed past the `!sql` guard into the
// try/resolveEffectiveAccess() call (the "cold cache + DB error" branch);
// `null` drives the OTHER fixed error path — "DB wholly unavailable" — so
// both of `resolveInAppAccess`'s two return points are exercised, not just
// the catch block (review round 1, Minor 8).
const mockAiGetSql = vi.fn(async (): Promise<object | null> => ({}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => mockAiGetSql() },
}));

// The in-app access DB read — mocked to THROW, simulating the DB hiccup on
// a cold access-cache. Real `resolveInAppAccess` catches this.
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

const mockSvcValidate = vi.fn();
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: (...args: unknown[]) => mockSvcValidate(...args) }),
}));
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn(), hasScope: () => true }),
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

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/v1/media');
    const headers = new Headers({ authorization: 'Bearer svc_imp_inappxyz' });
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

describe('resolveAuth /api/v1 — service token impersonation: resolveInAppAccess must fail CLOSED on the age axis during a DB error (C12)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSqlQuery.mockResolvedValue([mockImpersonationRow]);
        mockImpersonationRow.username = 'in-app-only-target';
        mockImpersonationRow.groups = [];
        mockImpersonationRow.disabled_at = null;
        mockImpersonationRow.deleted_at = null;
        mockImpersonationRow.is_admin = false;
        mockImpersonationRow.admin_pinned = false;
        mockImpersonationRow.max_age_rating = null;
        mockImpersonationRow.age_rating_pinned = false;
        mockResolveEffectiveAccess.mockRejectedValue(
            Object.assign(new Error('access-control DB read failed (simulated)'), {
                code: 'CONNECTION_CLOSED',
            }),
        );
        mockAiGetSql.mockResolvedValue({});
        mockSvcValidate.mockResolvedValue({
            id: 11,
            name: 'grafana',
            createdBy: 'admin-owner',
            actAsUser: '77777777-7777-7777-7777-777777777777',
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['read'],
            tokenPrefix: 'svc_imp_inapp',
            isAdmin: false,
        });
    });

    it('returns 503 without establishing an identity when access resolution throws', async () => {
        const event = makeEvent();
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(503);
        expect(result?.headers.get('Retry-After')).toBe('5');
        expect(event.locals.user).toBeUndefined();
        // resolveEffectiveAccess must actually have been reached (this test
        // exercises the try/catch branch, not the `!sql` early return).
        expect(mockResolveEffectiveAccess).toHaveBeenCalled();
    });

    // Review round 1, Minor 8: the `!sql` early return
    // (`resolveInAppAccess`'s OTHER fixed error path — "DB wholly
    // unavailable" rather than "DB read threw") was untested. Same fix,
    // same assertion, different trigger.
    it('returns 503 when the access database handle is unavailable', async () => {
        mockAiGetSql.mockResolvedValue(null);

        const event = makeEvent();
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(503);
        expect(result?.headers.get('Retry-After')).toBe('5');
        expect(event.locals.user).toBeUndefined();
        // resolveEffectiveAccess must NOT have been reached — the `!sql`
        // guard returns before it would be called.
        expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
    });
});
