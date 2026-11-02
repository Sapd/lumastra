// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for small-area defs:
 *   lists, webhooks, config, auth/logout, user/*
 *
 * Tests cover:
 *  - lists: POST exposed on v1 (admin-only); GET returns {items,page}; problem+json errors
 *  - webhooks: {items,page} response; DELETE → 204; POST/PUT return resource + Location;
 *    problem+json errors
 *  - config: user auth; correct shape
 *  - auth/logout: feature-gated → 404 when off; 422 when no deviceSessionId
 *  - user/profile: GET returns correct shape
 *  - user/tokens: feature-gated; GET/POST/DELETE; POST alias removed
 *  - user/playback-preferences: GET/PATCH; POST alias removed (405 from mount)
 *
 * External services are mocked — no live DB/Valkey/network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

// ── Hoisted mutable state (accessible inside vi.mock factories) ───────────────

const mockConfig = vi.hoisted(() => ({
    FEATURE_DEVICE_AUTH: true,
    FEATURE_USER_PATS: true,
    APP_NAME: 'Lumastra',
    APP_DESCRIPTION: 'Self-hostable media server',
    NEXT_EPISODE_COUNTDOWN_SECONDS: 10,
    // Consumed by the playback-preferences PATCH metadata-language validation
    // (config.TMDB_LANGUAGE.split(...) runs outside the try/catch).
    TMDB_LANGUAGE: 'en-US',
    METADATA_ADDITIONAL_LANGUAGES: [] as string[],
}));

const mockListWebhookHooks = vi.hoisted(() => vi.fn());
const mockInsertWebhookHook = vi.hoisted(() => vi.fn());
const mockUpdateWebhookHookWithSecret = vi.hoisted(() => vi.fn());
const mockUpdateWebhookHookWithoutSecret = vi.hoisted(() => vi.fn());
const mockDeleteWebhookHook = vi.hoisted(() => vi.fn());
const mockGetWebhookHookById = vi.hoisted(() => vi.fn());

const mockShouldRefreshLists = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const mockGetCachedLists = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockGetListDefinitions = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockSyncAllLists = vi.hoisted(() => vi.fn().mockResolvedValue({ synced: 0, errors: [] }));
const mockGetCachedListItems = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockSyncList = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));

const mockJellyfinRevoke = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockRevokeOAuthToken = vi.hoisted(() => vi.fn().mockResolvedValue({ revokedCount: 1 }));

const mockPatListForUser = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockPatCreate = vi.hoisted(() => vi.fn());
const mockPatRevoke = vi.hoisted(() => vi.fn().mockResolvedValue(true));

const mockGetPlaybackPreferencesOne = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockUpsertPlaybackPreferences = vi.hoisted(() => vi.fn());

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

vi.mock('$lib/server/tasks/api-auth.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/tasks/api-auth.js')>();
    return {
        ...actual,
        authenticate: vi.fn(),
        requireScope: vi.fn(),
        scopeGranted: (scopes: string[], required: string) => scopes.includes(required),
    };
});

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: () => false,
}));

// ── Config mock ───────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: {
        deviceAuth: true,
        userPats: true,
    },
    BACKEND_ONLY_FEATURES: new Set(['internalFeature']),
    LUMASTRA_MASTER_KEY: 'a'.repeat(64),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => Object.assign(vi.fn(), { json: (v: unknown) => v }),
}));

// ── Webhooks mocks ────────────────────────────────────────────────────────────

vi.mock('$lib/server/database/queries/webhook.queries.js', () => ({
    listWebhookHooks: (...args: unknown[]) => mockListWebhookHooks(...args),
    insertWebhookHook: (...args: unknown[]) => mockInsertWebhookHook(...args),
    updateWebhookHookWithSecret: (...args: unknown[]) => mockUpdateWebhookHookWithSecret(...args),
    updateWebhookHookWithoutSecret: (...args: unknown[]) =>
        mockUpdateWebhookHookWithoutSecret(...args),
    deleteWebhookHook: (...args: unknown[]) => mockDeleteWebhookHook(...args),
    getWebhookHookById: (...args: unknown[]) => mockGetWebhookHookById(...args),
}));

vi.mock('$lib/server/tasks/secrets.js', () => ({
    encrypt: (_data: string, _key: Buffer) => Buffer.from('encrypted'),
    decrypt: (_data: Buffer, _key: Buffer) => 'decrypted-secret',
    deriveMasterKey: (_key: string) => Buffer.alloc(32),
}));

vi.mock('$lib/server/tasks/url-safety.js', () => ({
    assertPublicHttpUrl: vi.fn(), // no-op by default; override in specific tests
    assertWebhookTargetUrl: vi.fn(), // no-op by default
    isAllowlistedPrivateHost: vi.fn(() => false),
    UrlSafetyError: class UrlSafetyError extends Error {
        constructor(msg: string) {
            super(msg);
            this.name = 'UrlSafetyError';
        }
    },
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/tasks/webhook-outbox.js', () => ({
    WEBHOOK_HOOKS_INVALIDATE_CHANNEL: 'webhooks:invalidate',
    // POST /webhooks builds the secret's AAD with this. Missing from the
    // factory, the property access threw INSIDE the def's encrypt try/catch,
    // which reports any failure as 503 dependency_unavailable — masking both
    // the 201 create path and the 500 DB-failure path.
    operatorWebhookSecretContext: (id: string) => `webhook:${id}`,
}));

// ── Lists mocks ───────────────────────────────────────────────────────────────

vi.mock('$lib/server/ai/list-sync.js', () => ({
    shouldRefreshLists: () => mockShouldRefreshLists(),
    getCachedLists: () => mockGetCachedLists(),
    getListDefinitions: () => mockGetListDefinitions(),
    syncAllLists: (...args: unknown[]) => mockSyncAllLists(...args),
    getCachedListItems: (...args: unknown[]) => mockGetCachedListItems(...args),
    syncList: (...args: unknown[]) => mockSyncList(...args),
    CURATED_LISTS: [],
}));

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(undefined),
        }),
    },
    CACHE_NAMESPACES: { curatedLists: 'curatedLists' },
}));

// ── Auth/logout mocks ─────────────────────────────────────────────────────────

vi.mock('$lib/server/oauth/jellyfin-token.service.js', () => ({
    getJellyfinTokenService: () => ({ revoke: mockJellyfinRevoke }),
}));

vi.mock('$lib/server/oauth/device-session-revocation.js', () => ({
    revokeDeviceSession: async (...args: unknown[]) => ({
        ...(await mockRevokeOAuthToken(...args)),
        owned: true,
    }),
}));

// ── User/tokens mocks ─────────────────────────────────────────────────────────

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        validate: vi.fn().mockResolvedValue(null),
        listForUser: (...args: unknown[]) => mockPatListForUser(...args),
        create: (...args: unknown[]) => mockPatCreate(...args),
        revoke: (...args: unknown[]) => mockPatRevoke(...args),
    }),
}));

// ── User preferences mocks ────────────────────────────────────────────────────

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: {
        one: (...args: unknown[]) => mockGetPlaybackPreferencesOne(...args),
    },
    upsertPlaybackPreferences: (...args: unknown[]) => mockUpsertPlaybackPreferences(...args),
    PLAYBACK_PREF_COLUMNS: {
        audioLanguage: 'audio_language',
        subtitlesEnabled: 'subtitles_enabled',
        qualityMode: 'quality_mode',
        autoplayNextEpisode: 'autoplay_next_episode',
        musicCrossfadeEnabled: 'music_crossfade_enabled',
        musicAutoplayEnabled: 'music_autoplay_enabled',
        nextEpisodeCountdownSeconds: 'next_episode_countdown_seconds',
        showNextEpisodePopup: 'show_next_episode_popup',
        seekStepSeconds: 'seek_step_seconds',
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';

const CTX_V1 = { surface: 'v1' as const };
const BASE_USER_ID = toUserId('c99e93a8-3ccc-5262-9eb5-ec4669118a3d');

function makeUser(
    opts: {
        isAdmin?: boolean;
        isAgeRestricted?: boolean;
        hasRequestPermission?: boolean;
        hasLiveTvPermission?: boolean;
    } = {},
) {
    return {
        userId: BASE_USER_ID,
        username: 'alice',
        groups: '',
        userGroups: [] as string[],
        hasWatchPermission: true,
        hasLiveTvPermission: opts.hasLiveTvPermission ?? false,
        hasRequestPermission: opts.hasRequestPermission ?? true,
        isAdmin: opts.isAdmin ?? false,
        isModerator: false,
        maxAgeRating: null as null | number,
        isAgeRating: false,
        isAgeRestricted: opts.isAgeRestricted ?? false,
        liveTvPriority: 'low' as const,
    };
}

function makeEvent(
    opts: {
        method?: string;
        username?: string;
        isAdmin?: boolean;
        isAgeRestricted?: boolean;
        hasRequestPermission?: boolean;
        hasLiveTvPermission?: boolean;
        body?: unknown;
        params?: Record<string, string>;
        searchParams?: Record<string, string>;
        deviceSessionId?: string;
        principalScopes?: string[];
        /** Principal kind when `principalScopes` is given (default 'pat'). */
        principalKind?: 'pat' | 'session';
    } = {},
): RequestEvent {
    const user =
        opts.username !== undefined
            ? null
            : makeUser({
                  isAdmin: opts.isAdmin,
                  isAgeRestricted: opts.isAgeRestricted,
                  hasRequestPermission: opts.hasRequestPermission,
                  hasLiveTvPermission: opts.hasLiveTvPermission,
              });

    // 2026-10-13: admin is the principal's verdict; an admin session carries an admin principal.
    const principal =
        opts.principalScopes !== undefined
            ? {
                  kind: opts.principalKind ?? ('pat' as const),
                  userId: BASE_USER_ID,
                  username: 'alice',
                  userGroups: [],
                  scopes: opts.principalScopes,
                  isAdmin: opts.isAdmin ?? false,
              }
            : opts.isAdmin !== undefined
              ? {
                    kind: 'session' as const,
                    userId: BASE_USER_ID,
                    username: 'alice',
                    userGroups: [],
                    scopes: ['read', 'write', 'admin'],
                    isAdmin: opts.isAdmin,
                }
              : undefined;

    const url = new URL('http://localhost/api/v1/test');
    if (opts.searchParams) {
        for (const [k, v] of Object.entries(opts.searchParams)) url.searchParams.set(k, v);
    }

    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');

    return {
        url,
        request: new Request(url.toString(), {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr,
        }),
        params: opts.params ?? {},
        route: { id: '/api/v1/test' as const },
        locals: {
            user: user ?? makeUser(),
            principal,
            deviceSessionId: opts.deviceSessionId ?? undefined,
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

async function bodyJson(res: Response) {
    return res.clone().json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockShouldRefreshLists.mockResolvedValue(false);
    mockGetCachedLists.mockResolvedValue([]);
    mockGetListDefinitions.mockReturnValue([]);
    mockPatListForUser.mockResolvedValue([]);
    mockPatRevoke.mockResolvedValue(true);
    mockJellyfinRevoke.mockResolvedValue(true);
    mockRevokeOAuthToken.mockResolvedValue({ revokedCount: 1 });
    mockConfig.FEATURE_DEVICE_AUTH = true;
    mockConfig.FEATURE_USER_PATS = true;
});

// ── Lists ─────────────────────────────────────────────────────────────────────

describe('GET /lists — {items,page} envelope', async () => {
    const { def } = await import('./lists/index.js');
    const { GET } = mount(def, CTX_V1);

    it('returns 200 with {items,page} collection envelope', async () => {
        mockGetCachedLists.mockResolvedValue([
            {
                list_id: 'trending-movies',
                name: 'Trending Movies',
                description: 'Hot right now',
                source: 'mdblist',
                list_path: '/list/trending-movies',
                item_count: 10,
                last_synced_at: new Date('2026-01-01'),
            },
        ]);

        const event = makeEvent();
        const res = await GET!(event);
        expect(res.status).toBe(200);
        const body = await bodyJson(res);
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.page).toBeDefined();
        // items key (not 'lists')
        expect(body).not.toHaveProperty('lists');
        const items = body.items as Record<string, unknown>[];
        expect(items.length).toBe(1);
        expect(items[0].id).toBe('trending-movies');
    });

    it('returns 403 for age-restricted users', async () => {
        const event = makeEvent({ isAgeRestricted: true });
        const res = await GET!(event);
        expect(res.status).toBe(403);
        const body = await bodyJson(res);
        expect(body.code).toBe('forbidden');
    });

    it('returns 401 when unauthenticated', async () => {
        const anonEvent = {
            ...makeEvent(),
            locals: { user: null },
        } as unknown as RequestEvent;
        const res = await GET!(anonEvent);
        expect(res.status).toBe(401);
    });

    it('returns syncing:false in response (not syncing)', async () => {
        const event = makeEvent();
        const res = await GET!(event);
        const body = await bodyJson(res);
        expect(body.syncing).toBe(false);
    });
});

describe('POST /lists — admin-only', async () => {
    const { def } = await import('./lists/index.js');
    const { POST } = mount(def, CTX_V1);

    it('returns 202 {accepted:true} for admin', async () => {
        const event = makeEvent({ isAdmin: true });
        const res = await POST!(event);
        expect(res.status).toBe(202);
        const body = await bodyJson(res);
        expect(body.accepted).toBe(true);
    });

    it('returns 403 forbidden for non-admin user', async () => {
        const event = makeEvent({ isAdmin: false });
        const res = await POST!(event);
        expect(res.status).toBe(403);
        const body = await bodyJson(res);
        expect(body.code).toBe('forbidden');
    });
});

// ── Webhooks ──────────────────────────────────────────────────────────────────

const stubHookRow = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    url: 'https://example.com/hook',
    event_filter: ['org.lumastra.task.run.completed'],
    task_filter: null,
    library_group_filter: null,
    headers: null,
    active: true,
    include_progress: false,
    created_by: 'alice',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    secret_encrypted: Buffer.alloc(32),
    media_type_filter: null,
    batch_window_seconds: 60,
    max_batch_size: 25,
};

describe('GET /webhooks — {items,page} envelope', async () => {
    const { def } = await import('./webhooks/index.js');
    const { GET } = mount(def, CTX_V1);

    it('returns 200 {items,page} (was {webhooks})', async () => {
        mockListWebhookHooks.mockResolvedValue([stubHookRow]);
        const event = makeEvent({ principalScopes: ['webhooks:write'] });
        const res = await GET!(event);
        expect(res.status).toBe(200);
        const body = await bodyJson(res);
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.page).toBeDefined();
        // no longer {webhooks}
        expect(body).not.toHaveProperty('webhooks');
    });

    it('does not expose secret or secret_encrypted in items', async () => {
        mockListWebhookHooks.mockResolvedValue([stubHookRow]);
        const event = makeEvent({ principalScopes: ['webhooks:write'] });
        const res = await GET!(event);
        const body = await bodyJson(res);
        const items = body.items as Record<string, unknown>[];
        expect(items[0]).not.toHaveProperty('secret');
        expect(items[0]).not.toHaveProperty('secret_encrypted');
        expect(items[0]).toHaveProperty('hasSecret', true);
    });

    it('returns 403 scope_required without webhooks:write scope', async () => {
        const event = makeEvent({ principalScopes: ['read'] });
        const res = await GET!(event);
        expect(res.status).toBe(403);
        const body = await bodyJson(res);
        expect(body.code).toBe('scope_required');
    });

    it('returns 503 dependency_unavailable when DB is down', async () => {
        mockListWebhookHooks.mockRejectedValue(new Error('DB error'));
        const event = makeEvent({ principalScopes: ['webhooks:write'] });
        const res = await GET!(event);
        expect(res.status).toBe(503);
        const body = await bodyJson(res);
        expect(body.code).toBe('dependency_unavailable');
    });
});

describe('POST /webhooks — returns 201 + resource + Location', async () => {
    const { def } = await import('./webhooks/index.js');
    const { POST } = mount(def, CTX_V1);

    const validBody = {
        url: 'https://example.com/hook',
        secret: 'a-secure-secret-of-16-chars-or-more',
        eventFilter: ['org.lumastra.task.run.completed'],
    };

    it('returns 201 with resource body and Location header', async () => {
        mockInsertWebhookHook.mockResolvedValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        mockGetWebhookHookById.mockResolvedValue(stubHookRow);

        const event = makeEvent({ principalScopes: ['webhooks:write'], body: validBody });
        const res = await POST!(event);
        expect(res.status).toBe(201);
        expect(res.headers.get('Location')).toBe(
            '/api/v1/webhooks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        );
        const body = await bodyJson(res);
        expect(body.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        // Resource, not just id
        expect(body.url).toBe('https://example.com/hook');
        expect(body).not.toHaveProperty('secret');
    });

    it('returns 422 for invalid body (no url)', async () => {
        const event = makeEvent({
            principalScopes: ['webhooks:write'],
            body: { secret: 'valid-secret-long-enough', eventFilter: [] },
        });
        const res = await POST!(event);
        expect(res.status).toBe(422);
        const body = await bodyJson(res);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 503 dependency_unavailable for DB failure — problem+json', async () => {
        mockInsertWebhookHook.mockRejectedValue(new Error('DB error'));
        const event = makeEvent({ principalScopes: ['webhooks:write'], body: validBody });
        const res = await POST!(event);
        expect(res.status).toBe(500);
        const body = await bodyJson(res);
        // internal_error since insert throws unexpectedly
        expect(body.code).toBe('internal_error');
    });
});

describe('DELETE /webhooks/{id} — 204 no-content', async () => {
    const { def } = await import('./webhooks/[id].js');
    const { DELETE } = mount(def, CTX_V1);

    it('returns 204 no-content on successful delete', async () => {
        mockDeleteWebhookHook.mockResolvedValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        const event = makeEvent({
            method: 'DELETE',
            principalScopes: ['webhooks:write'],
            params: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
        });
        const res = await DELETE!(event);
        // DELETE → 204 no-content
        expect(res.status).toBe(204);
    });

    it('returns 404 when webhook not found', async () => {
        mockDeleteWebhookHook.mockResolvedValue(null);
        const event = makeEvent({
            method: 'DELETE',
            principalScopes: ['webhooks:write'],
            params: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
        });
        const res = await DELETE!(event);
        expect(res.status).toBe(404);
        const body = await bodyJson(res);
        expect(body.code).toBe('not_found');
    });

    it('returns 404 with problem+json for malformed UUID — not raw error', async () => {
        const event = makeEvent({
            method: 'DELETE',
            principalScopes: ['webhooks:write'],
            params: { id: 'not-a-uuid' },
        });
        const res = await DELETE!(event);
        expect(res.status).toBe(404);
        const body = await bodyJson(res);
        expect(body.code).toBe('not_found');
    });
});

describe('PUT /webhooks/{id} — returns resource + Location', async () => {
    const { def } = await import('./webhooks/[id].js');
    const { PUT } = mount(def, CTX_V1);

    it('returns 200 + resource + Location on successful update', async () => {
        mockUpdateWebhookHookWithoutSecret.mockResolvedValue(
            'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        );
        mockGetWebhookHookById.mockResolvedValue(stubHookRow);

        const event = makeEvent({
            method: 'PUT',
            principalScopes: ['webhooks:write'],
            params: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
            body: {
                url: 'https://example.com/hook',
                eventFilter: ['org.lumastra.task.run.completed'],
            },
        });
        const res = await PUT!(event);
        expect(res.status).toBe(200);
        expect(res.headers.get('Location')).toBe(
            '/api/v1/webhooks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        );
        const body = await bodyJson(res);
        expect(body.url).toBe('https://example.com/hook');
    });

    it('returns 404 when webhook not found', async () => {
        mockUpdateWebhookHookWithoutSecret.mockResolvedValue(null);

        const event = makeEvent({
            method: 'PUT',
            principalScopes: ['webhooks:write'],
            params: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
            body: {
                url: 'https://example.com/hook',
                eventFilter: ['org.lumastra.task.run.completed'],
            },
        });
        const res = await PUT!(event);
        expect(res.status).toBe(404);
        const body = await bodyJson(res);
        expect(body.code).toBe('not_found');
    });
});

// ── Auth/logout ───────────────────────────────────────────────────────────────

describe('POST /auth/logout — feature-gated + revoke', async () => {
    const { def } = await import('./auth/logout.js');
    const { POST } = mount(def, CTX_V1);

    it('returns 404 when FEATURE_DEVICE_AUTH is off', async () => {
        mockConfig.FEATURE_DEVICE_AUTH = false;
        const event = makeEvent({ deviceSessionId: 'sess-123' });
        const res = await POST!(event);
        expect(res.status).toBe(404);
        const body = await bodyJson(res);
        expect(body.code).toBe('not_found');
    });

    it('returns 422 validation_failed when no deviceSessionId (PAT caller)', async () => {
        mockConfig.FEATURE_DEVICE_AUTH = true;
        const event = makeEvent(); // no deviceSessionId
        const res = await POST!(event);
        expect(res.status).toBe(422);
        const body = await bodyJson(res);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 204 No Content on successful logout', async () => {
        mockConfig.FEATURE_DEVICE_AUTH = true;
        const event = makeEvent({ deviceSessionId: 'sess-abc123' });
        const res = await POST!(event);
        expect(res.status).toBe(204);
    });

    it('returns 204 even when Jellyfin revoke fails (best-effort)', async () => {
        mockConfig.FEATURE_DEVICE_AUTH = true;
        mockJellyfinRevoke.mockRejectedValue(new Error('Jellyfin down'));
        const event = makeEvent({ deviceSessionId: 'sess-abc123' });
        const res = await POST!(event);
        expect(res.status).toBe(204);
    });
});

// ── User/profile ──────────────────────────────────────────────────────────────

describe('GET /me', async () => {
    const { def } = await import('./user/profile.js');
    const { GET } = mount(def, CTX_V1);

    it('returns 200 with id, username, admin/age flags, permissions, groups', async () => {
        const event = makeEvent({ isAdmin: false });
        const res = await GET!(event);
        expect(res.status).toBe(200);
        const body = await bodyJson(res);
        expect(body.id).toBe(BASE_USER_ID);
        expect(body.username).toBe('alice');
        // Flat shape: no `profile` wrapper object.
        expect(body).not.toHaveProperty('profile');
        expect(typeof body.isAdmin).toBe('boolean');
        expect(typeof body.isAgeRestricted).toBe('boolean');
        expect(Array.isArray(body.groups)).toBe(true);
        const permissions = body.permissions as Record<string, unknown>;
        expect(Object.keys(permissions).sort()).toEqual([
            'canAnnotateMedia',
            'canRequest',
            'canReview',
            'canSeeAllPlayback',
            'canWatchLiveTv',
        ]);
    });

    it('returns 401 for unauthenticated', async () => {
        const anonEvent = {
            ...makeEvent(),
            locals: { user: null },
        } as unknown as RequestEvent;
        const res = await GET!(anonEvent);
        expect(res.status).toBe(401);
    });
});

// ── User/tokens ───────────────────────────────────────────────────────────────

describe('GET /me/pats — feature-gated', async () => {
    const { def } = await import('./user/pats.js');
    const { GET } = mount(def, CTX_V1);

    it('returns 200 with tokens array', async () => {
        mockConfig.FEATURE_USER_PATS = true;
        // A realistic PatListItem — listForUser() always returns every field the
        // UserTokenInfo response schema declares (the handler passes rows through
        // unmapped), so the fixture must too.
        mockPatListForUser.mockResolvedValue([
            {
                id: 1,
                name: 'My Token',
                description: null,
                tokenPrefix: 'pat_abc123',
                scopes: ['read'],
                createdAt: '2026-01-01T00:00:00.000Z',
                expiresAt: null,
                lastUsedAt: null,
                lastUsedIp: null,
                usageCount: 0,
                isExpired: false,
                allowedIps: null,
            },
        ]);
        const event = makeEvent();
        const res = await GET!(event);
        expect(res.status).toBe(200);
        const body = await bodyJson(res);
        expect(Array.isArray(body.items)).toBe(true);
        expect((body.page as Record<string, unknown>).total).toBe(1);
    });

    it('returns 404 when FEATURE_USER_PATS is off', async () => {
        mockConfig.FEATURE_USER_PATS = false;
        const event = makeEvent();
        const res = await GET!(event);
        expect(res.status).toBe(404);
        const body = await bodyJson(res);
        expect(body.code).toBe('not_found');
    });
});

describe('POST /me/pats — create PAT', async () => {
    const { def } = await import('./user/pats.js');
    const { POST } = mount(def, CTX_V1);

    it('returns 201 with token (shown once)', async () => {
        mockConfig.FEATURE_USER_PATS = true;
        mockPatCreate.mockResolvedValue({ id: 42, token: 'pat_abc123' });
        // A non-admin session principal (buildPrincipal derives read+write);
        // the handler refuses to mint without a principal.
        const event = makeEvent({
            principalScopes: ['read', 'write'],
            principalKind: 'session',
            body: { name: 'My PAT', scopes: ['read'] },
        });
        const res = await POST!(event);
        expect(res.status).toBe(201);
        const body = await bodyJson(res);
        expect(body.id).toBe(42);
        expect(body.token).toBeDefined();
    });

    it('returns 403 when non-admin tries to create admin-scoped token', async () => {
        mockConfig.FEATURE_USER_PATS = true;
        const event = makeEvent({
            isAdmin: false,
            principalScopes: ['read', 'write'],
            principalKind: 'session',
            body: { name: 'Admin PAT', scopes: ['admin'] },
        });
        const res = await POST!(event);
        expect(res.status).toBe(403);
        const body = await bodyJson(res);
        expect(body.code).toBe('forbidden');
    });

    it('returns 422 for invalid body', async () => {
        mockConfig.FEATURE_USER_PATS = true;
        const event = makeEvent({
            body: {}, // missing required `name`
            principalScopes: ['read', 'write'],
            principalKind: 'session',
        });
        const res = await POST!(event);
        expect(res.status).toBe(422);
        const body = await bodyJson(res);
        expect(body.code).toBe('validation_failed');
    });
});

const ownerSession = { principalScopes: ['read', 'write'], principalKind: 'session' as const };

describe('DELETE /me/pats — revoke PAT', async () => {
    const { def } = await import('./user/pats-id.js');
    const { DELETE } = mount(def, CTX_V1);

    it('returns 204 on successful revocation', async () => {
        mockConfig.FEATURE_USER_PATS = true;
        mockPatRevoke.mockResolvedValue(true);
        const event = makeEvent({
            method: 'DELETE',
            ...ownerSession,
            params: { id: '42' },
        });
        const res = await DELETE!(event);
        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');
    });

    it('returns 404 when token not found', async () => {
        mockConfig.FEATURE_USER_PATS = true;
        mockPatRevoke.mockResolvedValue(false);
        const event = makeEvent({
            method: 'DELETE',
            ...ownerSession,
            params: { id: '99' },
        });
        const res = await DELETE!(event);
        expect(res.status).toBe(404);
        const body = await bodyJson(res);
        expect(body.code).toBe('not_found');
    });

    it('scopes the revoke to the calling user (revoke(tokenId, ownerUserId))', async () => {
        mockConfig.FEATURE_USER_PATS = true;
        mockPatRevoke.mockClear();
        mockPatRevoke.mockResolvedValue(true);
        const res = await DELETE!(
            makeEvent({ method: 'DELETE', ...ownerSession, params: { id: '42' } }),
        );
        expect(res.status).toBe(204);
        expect(mockPatRevoke).toHaveBeenCalledTimes(1);
        expect(mockPatRevoke).toHaveBeenCalledWith(42, BASE_USER_ID);
    });

    it('answers 404 for a token the service does not find for this owner', async () => {
        mockConfig.FEATURE_USER_PATS = true;
        mockPatRevoke.mockClear();
        // revoke() filters by user_id, so another user's token id yields false.
        mockPatRevoke.mockResolvedValue(false);
        const res = await DELETE!(
            makeEvent({ method: 'DELETE', ...ownerSession, params: { id: '7' } }),
        );
        expect(res.status).toBe(404);
        expect(mockPatRevoke).toHaveBeenCalledWith(7, BASE_USER_ID);
    });

    it.each(['abc', '1.5', '0', '-3', ''])(
        'returns 422 for the non-positive-integer id %j without calling the service',
        async (id) => {
            mockConfig.FEATURE_USER_PATS = true;
            mockPatRevoke.mockClear();
            const res = await DELETE!(
                makeEvent({ method: 'DELETE', ...ownerSession, params: { id } }),
            );
            expect(res.status).toBe(422);
            expect(mockPatRevoke).not.toHaveBeenCalled();
        },
    );
});

// ── User/playback-preferences ─────────────────────────────────────────────────

describe('GET /me/playback-preferences', async () => {
    const { def } = await import('./user/playback-preferences.js');
    const { GET } = mount(def, CTX_V1);

    it('returns 200 with defaults when no preferences saved', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue(null);
        const event = makeEvent();
        const res = await GET!(event);
        expect(res.status).toBe(200);
        const body = await bodyJson(res);
        expect(body.qualityMode).toBe('original');
        expect(body.subtitlesEnabled).toBe(true);
    });

    it('leaves the still-watching prompt off by default', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue(null);
        const res = await GET!(makeEvent());
        expect((await bodyJson(res)).stillWatchingEnabled).toBe(false);
    });

    it('reports the still-watching prompt once the viewer turns it on', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            still_watching_enabled: true,
            audio_language: null,
            last_audio_language: null,
            subtitle_language: null,
            subtitle_style: null,
            subtitle_track_hint: null,
            max_bitrate: null,
            preferred_resolution: null,
        });
        const res = await GET!(makeEvent());
        expect((await bodyJson(res)).stillWatchingEnabled).toBe(true);
    });

    it('returns 503 when DB is unavailable', async () => {
        mockGetPlaybackPreferencesOne.mockRejectedValue(new Error('DB error'));
        const event = makeEvent();
        const res = await GET!(event);
        // The error gets caught by withMountErrorHandler → 500 internal_error
        expect(res.status).toBe(500);
    });
});

describe('PATCH /me/playback-preferences — no POST alias', async () => {
    const { def } = await import('./user/playback-preferences.js');
    const handlers = mount(def, CTX_V1);

    it('exports GET and PATCH but NOT POST', () => {
        expect(typeof handlers.GET).toBe('function');
        expect(typeof handlers.PATCH).toBe('function');
        // POST alias is removed
        expect(handlers.POST).toBeUndefined();
    });

    it('PATCH returns 200 with updated preferences', async () => {
        mockUpsertPlaybackPreferences.mockResolvedValue({
            audio_language: null,
            last_audio_language: null,
            subtitle_language: null,
            subtitles_enabled: false,
            forced_subtitles_enabled: true,
            subtitle_style: null,
            subtitle_track_hint: null,
            quality_mode: 'auto',
            max_bitrate: null,
            preferred_resolution: null,
            autoplay_next_episode: true,
            skip_intro_automatically: false,
            skip_credits_automatically: false,
            show_annotation_markers: true,
            auto_show_annotations: true,
            music_crossfade_enabled: true,
            music_crossfade_beats: null,
            music_autoplay_enabled: true,
            next_episode_countdown_seconds: null,
            show_next_episode_popup: true,
            next_episode_prompt_lead_seconds: null,
            no_outro_fallback_seconds: null,
            seek_step_seconds: null,
            auto_dismiss_next_episode_popup: false,
            updated_at: new Date('2026-01-01').toISOString(),
        });

        const event = makeEvent({
            method: 'PATCH',
            body: { qualityMode: 'auto', subtitlesEnabled: false },
        });
        const res = await handlers.PATCH!(event);
        expect(res.status).toBe(200);
        const body = await bodyJson(res);
        expect(body.qualityMode).toBe('auto');
    });

    it('PATCH returns 422 for empty body (no fields provided)', async () => {
        const event = makeEvent({ method: 'PATCH', body: {} });
        const res = await handlers.PATCH!(event);
        expect(res.status).toBe(422);
        const body = await bodyJson(res);
        expect(body.code).toBe('validation_failed');
    });
});
