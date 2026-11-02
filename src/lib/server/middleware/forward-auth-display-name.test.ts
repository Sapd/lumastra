// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for display-name population from the forward-auth NAMEHEADER.
 *
 * `GET /api/v1/media/{id}/viewers` publishes `displayName` as "never the login
 * handle", but forward auth never wrote `users.display_name`, so every install
 * fell back to the username. NAMEHEADER closes that gap.
 *
 * The value is chosen by an external IdP and later rendered to OTHER users, so
 * two properties are load-bearing and pinned here:
 *
 *   1. It is read at the SAME trust level as USERHEADER/GROUPHEADER — a header
 *      from a TCP peer outside TRUSTED_PROXY_IPS must never reach the database.
 *   2. It is sanitised (`sanitizeDisplayName`) at the write boundary, so bidi
 *      overrides and zero-width padding can't be used to make one user's label
 *      render as another's.
 *
 * Absence must be a no-op: no header (or no proxy support) leaves display_name
 * untouched and the username fallback in social.queries.ts intact.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Environment (must be set before client-ip.ts is imported) ────────────────
// TRUSTED_PROXIES is captured at module load in utils/client-ip.ts, so the
// allowlist has to exist before the import graph is pulled in. vi.hoisted runs
// ahead of every import.
vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

// ── Module mocks ─────────────────────────────────────────────────────────────

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
    DEFAULT_USER: 'default',
    ADMIN_GROUPS: ['admin'],
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

// No native session cookie → falls through to the forward-auth header path.
vi.mock('$lib/server/auth/native-session.js', () => ({
    SESSION_COOKIE_NAME: 'lumastra_session',
    readSessionCookie: () => null,
    clearSessionCookie: vi.fn(),
    buildUserContextFromSession: vi.fn(),
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ validate: vi.fn(async () => null) }),
}));

const EXISTING_USER_ID = '00000000-0000-0000-0000-0000000000aa';

const mockUpsertUser = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    // An admin exists → the first-run /setup redirect and the provisioning guard
    // both pass, so the steady-state upsert path under test runs.
    adminExists: vi.fn(async () => true),
    getUserByUsername: vi.fn(async () => ({
        id: EXISTING_USER_ID,
        username: 'alice',
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        disabled_at: null,
    })),
    upsertUser: mockUpsertUser,
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

// In-app access layer: pass the synced groups straight through, no extra caps.
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: vi.fn(async (_sql: unknown, _userId: string, groups: string[]) => ({
        inAppGroupNames: [],
        effectiveGroups: groups,
        capabilities: {},
    })),
}));

// Deterministic stand-ins: admin-ness is driven by a sentinel group rather than
// the real ADMIN_GROUPS list (both have their own coverage elsewhere).
vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: (groups: string[] = []) => groups.includes('admin'),
    buildUserPermissions: (
        groups: string[],
        opts?: { isAdminOverride?: boolean; extraCapabilities?: { isAdmin?: boolean } },
    ) => {
        const isAdmin = opts?.isAdminOverride ?? groups.includes('admin');
        return {
            hasWatchPermission: isAdmin,
            hasLiveTvPermission: isAdmin,
            hasRequestPermission: isAdmin,
            isAdmin,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: isAdmin,
            liveTvPriority: isAdmin ? 'high' : 'low',
        };
    },
}));

// Caches always cold so every request re-runs the DB resolution path.
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
    getCachedMaxAge: () => Symbol.for('MAX_AGE_MISS'),
    setCachedMaxAge: () => {},
    invalidateUserMaxAgeCache: () => {},
    MAX_AGE_MISS: Symbol.for('MAX_AGE_MISS'),
}));

// Valkey not ready → syncUserGroupsIfNeeded returns before any DB work, leaving
// the upsert branch as the only writer under test.
vi.mock('$lib/server/cache/valkey.js', () => ({
    isValkeyReady: vi.fn(() => false),
    cacheGet: vi.fn(async () => null),
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

import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeEvent(headers: Record<string, string>, peer = '127.0.0.1'): RequestEvent {
    const url = new URL('http://localhost/browse');
    const request = new Request(url, {
        headers: new Headers({ accept: 'text/html', ...headers }),
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

/**
 * Encode a UTF-8 string the way it actually arrives on the wire.
 *
 * HTTP header values are bytes, and both `Headers` and Node's parser treat them
 * as Latin-1 — a proxy forwarding "Fjörn" or a U+202E override delivers the raw
 * UTF-8 bytes, which surface as mojibake. `decodeProxyHeaderValue` repairs that
 * on the way in, so tests must feed it the same byte-level shape rather than a
 * JS string that `new Headers()` would reject outright.
 */
function asHeaderBytes(value: string): string {
    return Buffer.from(value, 'utf8').toString('latin1');
}

const noopMigration = async (): Promise<void> => undefined;

/**
 * The upsert is deliberately fire-and-forget (`void (async () => …)()`), so it
 * lands a few microtasks after resolveAuth resolves. Drain them.
 */
async function flushFireAndForget(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** The params of the last upsertUser call, or null if it never ran. */
function lastUpsertParams(): { username: string; displayName?: string | null } | null {
    const calls = mockUpsertUser.mock.calls as unknown as [unknown, Record<string, unknown>][];
    const last = calls.at(-1);
    if (!last) return null;
    return last[1] as { username: string; displayName?: string | null };
}

const IDENTITY = {
    'x-authentik-username': 'alice',
    'x-authentik-groups': 'users',
};

beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.NAMEHEADER = 'x-authentik-name';
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('forward auth — NAMEHEADER → users.display_name', () => {
    it('persists the display name when the trusted proxy sends the header', async () => {
        const event = makeEvent({ ...IDENTITY, 'x-authentik-name': 'Alice Example' });

        await resolveAuth(event, noopMigration, true);
        await flushFireAndForget();

        expect(event.locals.user?.username).toBe('alice');
        expect(lastUpsertParams()).toMatchObject({
            username: 'alice',
            displayName: 'Alice Example',
        });
    });

    it('passes displayName: null when the header is absent (no regression, no overwrite)', async () => {
        const event = makeEvent(IDENTITY);

        await resolveAuth(event, noopMigration, true);
        await flushFireAndForget();

        // null (not undefined) so the SQL COALESCE branch is the one that runs —
        // it keeps whatever name the row already has.
        expect(lastUpsertParams()?.displayName).toBeNull();
    });

    it('passes displayName: null when NAMEHEADER is configured empty (feature off)', async () => {
        mockConfig.NAMEHEADER = '';
        const event = makeEvent({ ...IDENTITY, 'x-authentik-name': 'Alice Example' });

        await resolveAuth(event, noopMigration, true);
        await flushFireAndForget();

        expect(lastUpsertParams()?.displayName).toBeNull();
    });

    it('strips bidi overrides and zero-width padding before the value reaches the DB', async () => {
        // Written as escapes because the characters are invisible:
        // U+202E (RLO) reverses rendered order, U+200B (ZWSP) pads — together
        // they let a hostile label render like a familiar one in the
        // "who else watched this" list.
        const event = makeEvent({
            ...IDENTITY,
            'x-authentik-name': asHeaderBytes('A\u202Elice\u200B Example'),
        });

        await resolveAuth(event, noopMigration, true);
        await flushFireAndForget();

        const displayName = lastUpsertParams()?.displayName;
        expect(displayName).toBe('Alice Example');
        expect(displayName).not.toMatch(/[\u200B-\u200F\u202A-\u202E]/);
    });

    it('drops a display name that sanitises away to nothing', async () => {
        const event = makeEvent({
            ...IDENTITY,
            'x-authentik-name': asHeaderBytes('\u200B\u200B'),
        });

        await resolveAuth(event, noopMigration, true);
        await flushFireAndForget();

        expect(lastUpsertParams()?.displayName).toBeNull();
    });

    it('drops an unexpanded reverse-proxy placeholder instead of storing it', async () => {
        const event = makeEvent({
            ...IDENTITY,
            'x-authentik-name': '{http.reverse_proxy.header.x-authentik-name}',
        });

        await resolveAuth(event, noopMigration, true);
        await flushFireAndForget();

        expect(lastUpsertParams()?.displayName).toBeNull();
    });

    it('NEVER honors a display name from a peer outside TRUSTED_PROXY_IPS', async () => {
        // Untrusted TCP peer: identity headers are discarded wholesale, so the
        // name must not survive either — otherwise any client that can reach the
        // app directly picks the label everyone else sees.
        const event = makeEvent(
            { ...IDENTITY, 'x-authentik-name': 'Administrator' },
            '203.0.113.9',
        );

        await resolveAuth(event, noopMigration, true);
        await flushFireAndForget();

        expect(event.locals.user).toBeUndefined();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });
});
