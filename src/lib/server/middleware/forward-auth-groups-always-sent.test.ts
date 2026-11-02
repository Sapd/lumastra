// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * D1 (security runtime pass 2026-09-26): nginx does not forward a header whose
 * value is empty, so behind an nginx `auth_request` edge a user whom the IdP
 * removed from EVERY group arrives with the username header and NO groups
 * header. `4747cdada` made a PRESENT-empty header clear `users.groups` and
 * demote an unpinned admin, but an ABSENT header writes nothing, so on that
 * edge the row kept its admin projection on every token path indefinitely.
 *
 * `FORWARD_AUTH_GROUPS_ALWAYS_SENT` is the operator's statement that their
 * proxy sends the groups header on every authenticated request. With it on,
 * an absent groups header on a request that carries a TRUSTED username header
 * is read as present-empty `[]` and takes the `4747cdada` path. Off (the
 * default) keeps "absent never writes", which is the fail-open guard for
 * age-cap groups on proxies that legitimately omit the header.
 *
 * Harness: `forward-auth-c5-warm-cache-writer.test.ts`'s, driving the REAL
 * `resolveAuth()`. The group sync and the upsert IIFE both dynamic-import
 * `database.service`; two overlapping first imports of a factory mock resolve
 * the second to the REAL module (see that file's `skipThrottledGroupSync`).
 * So each positive test lets exactly ONE writer reach that import: the sync
 * tests answer `anAdminExists()` with false (the IIFE returns before its
 * import, the sync does not consult it), the upsert tests pre-seed the sync's
 * L2 hash for `[]` so the sync skips before its import. Every negative test
 * uses the identical setup as a positive test, so a green negative is not a
 * harness that never reaches the writer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

const mockConfig = vi.hoisted(() => ({
    FEATURE_JELLYFIN_COMPAT: false,
    FEATURE_PUBLIC_SHOWCASE: false,
    AUTH_NATIVE_LOGIN_ENABLED: false,
    AUTH_OIDC_LOGIN_AVAILABLE: false,
    AUTH_OIDC_ENABLED: false,
    AUTH_OIDC_ISSUER: '',
    AUTH_OIDC_CLIENT_ID: '',
    FORWARD_AUTH_ENABLED: true,
    USERHEADER: 'x-authentik-username',
    GROUPHEADER: 'x-authentik-groups',
    NAMEHEADER: 'x-authentik-name',
    FORWARD_AUTH_GROUPS_ALWAYS_SENT: false,
    DEFAULT_USER: 'default',
    ADMIN_GROUPS: ['admins'],
    WATCH_PERMISSION_GROUPS: [],
    LIVETV_GROUPS: [],
    REQUEST_GROUPS: [],
    SOCIAL_REVIEW_GROUPS: [],
    MEDIA_ANNOTATION_GROUPS: [],
    MODERATOR_GROUPS: [],
    LIVETV_HIGH_PRIORITY_GROUPS: [],
    AGE_RATING_GROUP_PREFIX: 'age-',
    ARR_MANAGER_GROUPS: [],
}));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: { deviceAuth: false },
}));

vi.mock('$app/environment', () => ({ dev: false }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/auth/native-session.js', () => ({
    SESSION_COOKIE_NAME: 'lumastra_session',
    readSessionCookie: () => null,
    clearSessionCookie: vi.fn(),
    buildUserContextFromSession: vi.fn(),
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ validate: vi.fn(async () => null) }),
}));

const mockUpsertUser = vi.hoisted(() =>
    vi.fn(
        async (
            _sql: unknown,
            _params: {
                username: string;
                isAdmin: boolean;
                maxAgeRating?: number | null;
                displayName?: string | null;
            },
        ) => ({
            id: '00000000-0000-0000-0000-0000000000d1',
            isAdmin: false,
            demoted: true,
            promoted: false,
        }),
    ),
);

const mockAdminExists = vi.hoisted(() => vi.fn(async () => true));

/** The stored row before the request: an UNPINNED admin whose IdP groups are gone. */
const STALE_ADMIN_ROW = {
    id: '00000000-0000-0000-0000-0000000000d1',
    username: 'offboarded',
    is_admin: true,
    admin_pinned: false,
    groups: ['admins'],
    max_age_rating: null,
    age_rating_pinned: false,
    disabled_at: null,
    deleted_at: null,
};

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: mockAdminExists,
    getUserByUsername: vi.fn(async () => STALE_ADMIN_ROW),
    upsertUser: mockUpsertUser,
}));

// Statically imported by forward-auth.ts, so never raced by a dynamic import.
const mockSyncUserGroups = vi.hoisted(() =>
    vi.fn(async (_sql: unknown, _username: string, _groups: string[]) => undefined),
);
vi.mock('$lib/server/services/user-groups.service.js', () => ({
    syncUserGroups: mockSyncUserGroups,
    invalidateGroupDerivedCaches: vi.fn(),
}));

// The sync's best-effort identity-ledger write after `syncUserGroups`.
vi.mock('$lib/server/services/user-identity.service.js', () => ({
    recordIdentityBestEffort: vi.fn(async () => undefined),
    PROVIDER_FORWARD_AUTH: 'forward_auth',
}));

vi.mock('$lib/server/database/queries/oauth-admin.queries.js', () => ({
    upsertUserGroups: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    ensureUserProfileExists: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({}) as unknown) },
}));

const mockResolveEffectiveAccess = vi.fn();
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: unknown[]) => mockResolveEffectiveAccess(...args),
}));

const MAX_AGE_MISS_SENTINEL = vi.hoisted(() => Symbol.for('MAX_AGE_MISS'));

vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: () => null,
    setCachedIsAdmin: () => {},
    getCachedAdminPinned: () => null,
    setCachedAdminPinned: () => {},
    getCachedDisabled: () => null,
    setCachedDisabled: () => {},
    getCachedUserId: () => null,
    setCachedUserId: () => {},
    invalidateUserAdminCache: () => {},
}));

vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    getCachedMaxAge: () => MAX_AGE_MISS_SENTINEL,
    setCachedMaxAge: () => {},
    invalidateUserMaxAgeCache: () => {},
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
}));

const mockL2Hashes = vi.hoisted(() => new Map<string, string>());
const mockIsValkeyReady = vi.hoisted(() => vi.fn(() => false));

vi.mock('$lib/server/cache/valkey.js', () => ({
    isValkeyReady: () => mockIsValkeyReady(),
    cacheGet: vi.fn(async (key: string) => mockL2Hashes.get(key) ?? null),
    setEx: vi.fn(async () => undefined),
    getValkeyClient: vi.fn(() => null),
}));

vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({ validate: vi.fn(), getStatus: vi.fn() }),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth, invalidateAdminExistsCache } from './forward-auth.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(headers: Record<string, string>, peer = '127.0.0.1'): RequestEvent {
    const url = new URL('http://localhost/api/user');
    const request = new Request(url, {
        headers: new Headers({ accept: 'application/json', ...headers }),
    });
    return {
        url,
        request,
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
        getClientAddress: () => peer,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const noopMigration = async (): Promise<void> => undefined;

/** Username header only — what nginx forwards for a user with no IdP groups. */
const NO_GROUPS_HEADER = { 'x-authentik-username': 'offboarded' };

/** Only the throttled sync reaches `database.service` (see the file header). */
function onlyTheSyncWrites(): void {
    mockAdminExists.mockImplementation(async () => false);
}

/** Only the upsert IIFE reaches `database.service`: the sync's L2 already holds `[]`. */
function onlyTheUpsertWrites(): void {
    mockIsValkeyReady.mockReturnValue(true);
    mockL2Hashes.set('user:groups:hash:offboarded', JSON.stringify([]));
}

/** Let fire-and-forget writers that WOULD run get there before asserting they did not. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.FORWARD_AUTH_GROUPS_ALWAYS_SENT = false;
    mockIsValkeyReady.mockReturnValue(false);
    mockL2Hashes.clear();
    mockAdminExists.mockImplementation(async () => true);
    mockResolveEffectiveAccess.mockReset();
    mockResolveEffectiveAccess.mockResolvedValue({
        inAppGroupNames: [],
        effectiveGroups: [],
        capabilities: {},
    });
    // anAdminExists() caches `true` per module instance.
    invalidateAdminExistsCache();
});

describe('FORWARD_AUTH_GROUPS_ALWAYS_SENT on — absent groups header from a trusted proxy', () => {
    beforeEach(() => {
        mockConfig.FORWARD_AUTH_GROUPS_ALWAYS_SENT = true;
    });

    it('syncs users.groups to [] and exposes locals.idpGroups = []', async () => {
        onlyTheSyncWrites();
        const event = makeEvent(NO_GROUPS_HEADER);

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.authMethod).toBe('forward_auth');
        // The device-authorize route persists exactly this list.
        expect(event.locals.idpGroups).toEqual([]);

        await vi.waitFor(() => expect(mockSyncUserGroups).toHaveBeenCalled());
        expect(mockSyncUserGroups.mock.calls[0]?.slice(1)).toEqual(['offboarded', []]);
    });

    it('runs the periodic upsert with isAdmin: false (demotes the unpinned admin)', async () => {
        onlyTheUpsertWrites();
        const event = makeEvent(NO_GROUPS_HEADER);

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(false);

        await vi.waitFor(() => expect(mockUpsertUser).toHaveBeenCalled());
        expect(mockUpsertUser.mock.calls[0]?.[1]).toMatchObject({
            username: 'offboarded',
            isAdmin: false,
        });
    });

    it('a PRESENT non-empty header is still synced verbatim', async () => {
        onlyTheSyncWrites();
        const event = makeEvent({ ...NO_GROUPS_HEADER, 'x-authentik-groups': 'Users|age-12' });

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.idpGroups).toEqual(['Users', 'age-12']);

        await vi.waitFor(() => expect(mockSyncUserGroups).toHaveBeenCalled());
        expect(mockSyncUserGroups.mock.calls[0]?.slice(1)).toEqual([
            'offboarded',
            ['Users', 'age-12'],
        ]);
    });

    it('an UNTRUSTED peer is never read as [] — no identity, no write', async () => {
        onlyTheSyncWrites();
        const event = makeEvent(NO_GROUPS_HEADER, '203.0.113.9');

        const res = await resolveAuth(event, noopMigration, true);
        expect(res).toBeInstanceOf(Response);
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.idpGroups).toBeUndefined();

        await settle();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });

    it('an UNTRUSTED peer is never read as [] — upsert setup', async () => {
        onlyTheUpsertWrites();
        const event = makeEvent(NO_GROUPS_HEADER, '203.0.113.9');

        expect(await resolveAuth(event, noopMigration, true)).toBeInstanceOf(Response);

        await settle();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });
});

describe('FORWARD_AUTH_GROUPS_ALWAYS_SENT off (default) — absent header never writes', () => {
    it('no sync, locals.idpGroups undefined', async () => {
        onlyTheSyncWrites();
        const event = makeEvent(NO_GROUPS_HEADER);

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.authMethod).toBe('forward_auth');
        expect(event.locals.idpGroups).toBeUndefined();

        await settle();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
    });

    it('no upsert', async () => {
        onlyTheUpsertWrites();
        const event = makeEvent(NO_GROUPS_HEADER);

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();

        await settle();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });

    it('control: a PRESENT-empty header still syncs [] with the flag off (4747cdada)', async () => {
        onlyTheSyncWrites();
        const event = makeEvent({ ...NO_GROUPS_HEADER, 'x-authentik-groups': '' });

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.idpGroups).toEqual([]);

        await vi.waitFor(() => expect(mockSyncUserGroups).toHaveBeenCalled());
        expect(mockSyncUserGroups.mock.calls[0]?.slice(1)).toEqual(['offboarded', []]);
    });
});
