// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Public API kill-switch at the edge (resolveAuth), seeded from the SCHEMA
 * default rather than a hand-written flag: on a fresh install /api/v1 and
 * /oauth/* must be reachable (the native iPhone/iPad/Apple TV apps sign in via
 * the device flow and register push tokens on /api/v1), and turning
 * FEATURE_DEVICE_AUTH off must close both surfaces. The route-level half
 * (/oauth/device through the real config stack) lives in
 * src/routes/api/setup/preferences/server.public-api.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { configSchema } from '$lib/config/schema.js';

const schemaDefault = vi.hoisted(() => ({ value: undefined as unknown }));

const mockConfig = vi.hoisted(() => ({
    FEATURE_DEVICE_AUTH: true,
    JWT_SECRET: 'x'.repeat(64),
    FEATURE_JELLYFIN_COMPAT: false,
    FEATURE_PUBLIC_SHOWCASE: false,
    AUTH_NATIVE_LOGIN_ENABLED: true,
    AUTH_OIDC_ENABLED: false,
    AUTH_OIDC_ISSUER: '',
    AUTH_OIDC_CLIENT_ID: '',
    AUTH_OIDC_LOGIN_AVAILABLE: false,
    USERHEADER: 'x-authentik-username',
    GROUPHEADER: 'x-authentik-groups',
    NAMEHEADER: 'x-authentik-name',
}));

// Same derivation as the real `features.deviceAuth` getter (config.ts).
vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: {
        get deviceAuth(): boolean {
            return mockConfig.FEATURE_DEVICE_AUTH && !!mockConfig.JWT_SECRET;
        },
    },
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
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ validate: vi.fn(async () => null) }),
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
    getUserByUsername: vi.fn(async () => null),
    upsertUser: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({}) as unknown) },
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

function makeEvent(
    path: string,
    method = 'GET',
    extraHeaders: Record<string, string> = {},
): RequestEvent {
    const url = new URL('http://localhost' + path);
    const request = new Request(url, {
        method,
        headers: new Headers({ accept: 'application/json', ...extraHeaders }),
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
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const noopMigration = async (): Promise<void> => undefined;

beforeEach(() => {
    vi.clearAllMocks();
    schemaDefault.value = configSchema.find((s) => s.key === 'FEATURE_DEVICE_AUTH')?.defaultValue;
    mockConfig.FEATURE_DEVICE_AUTH = schemaDefault.value === true;
});

describe('Public API at the edge — fresh-install default', () => {
    it('the schema default is ON', () => {
        expect(schemaDefault.value).toBe(true);
    });

    it('/oauth/device and /oauth/token pass through to their routes', async () => {
        expect(
            await resolveAuth(makeEvent('/oauth/device', 'POST'), noopMigration, true),
        ).toBeUndefined();
        expect(
            await resolveAuth(makeEvent('/oauth/token', 'POST'), noopMigration, true),
        ).toBeUndefined();
    });

    it('/api/v1 is live: an unauthenticated call gets a 401 challenge, not the disabled 503', async () => {
        const res = await resolveAuth(makeEvent('/api/v1/me'), noopMigration, true);
        expect(res?.status).toBe(401);
    });
});

describe('Bearer on /api/admin/* — the carve-out that default-on makes reachable', () => {
    // forward-auth defers a Bearer /api/admin/* request to the route's own
    // requireAdmin() (token scope check) only while features.deviceAuth is on.
    // Default-on makes that path live on every fresh install, so pin both sides.
    const bearer = { authorization: 'Bearer pat_not_a_real_token' };

    it('default ON: defers to the route (no edge verdict)', async () => {
        const res = await resolveAuth(
            makeEvent('/api/admin/users', 'GET', bearer),
            noopMigration,
            true,
        );
        expect(res).toBeUndefined();
    });

    it('OFF: the edge answers 401 before any route runs', async () => {
        mockConfig.FEATURE_DEVICE_AUTH = false;
        const res = await resolveAuth(
            makeEvent('/api/admin/users', 'GET', bearer),
            noopMigration,
            true,
        );
        expect(res?.status).toBe(401);
    });

    it('a non-Bearer Authorization header is never deferred, even with the default on', async () => {
        const res = await resolveAuth(
            makeEvent('/api/admin/users', 'GET', { authorization: 'Basic Zm9vOmJhcg==' }),
            noopMigration,
            true,
        );
        expect(res?.status).toBe(401);
    });
});

describe('Public API at the edge — turned off', () => {
    beforeEach(() => {
        mockConfig.FEATURE_DEVICE_AUTH = false;
    });

    it('/oauth/* answers 400 unsupported_grant_type', async () => {
        const res = await resolveAuth(makeEvent('/oauth/device', 'POST'), noopMigration, true);
        expect(res?.status).toBe(400);
        expect(await res?.json()).toMatchObject({
            error: 'unsupported_grant_type',
            error_description: 'Device authorization is not enabled',
        });
    });

    it('/api/v1 answers 503 "Public API is not enabled"', async () => {
        const res = await resolveAuth(makeEvent('/api/v1/me'), noopMigration, true);
        expect(res?.status).toBe(503);
        expect(JSON.stringify(await res?.json())).toContain('Public API is not enabled');
    });

    it('a missing signing secret closes it even with the flag on', async () => {
        mockConfig.FEATURE_DEVICE_AUTH = true;
        mockConfig.JWT_SECRET = '';
        try {
            const res = await resolveAuth(makeEvent('/api/v1/me'), noopMigration, true);
            expect(res?.status).toBe(503);
        } finally {
            mockConfig.JWT_SECRET = 'x'.repeat(64);
        }
    });
});
