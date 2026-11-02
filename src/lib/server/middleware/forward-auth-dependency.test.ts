// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockConfig = vi.hoisted(() => ({
    FEATURE_JELLYFIN_COMPAT: false,
    FEATURE_PUBLIC_SHOWCASE: false,
    AUTH_NATIVE_LOGIN_ENABLED: false,
    AUTH_OIDC_ENABLED: false,
    AUTH_OIDC_ISSUER: '',
    AUTH_OIDC_CLIENT_ID: '',
    USERHEADER: 'x-authentik-username',
    GROUPHEADER: 'x-authentik-groups',
    NAMEHEADER: 'x-authentik-name',
    // Mirrors the real derived getter in config.ts so tests keep driving the
    // three underlying flags. The real derivation is pinned separately by
    // config.oidc-login-available.test.ts.
    get AUTH_OIDC_LOGIN_AVAILABLE(): boolean {
        return (
            this.AUTH_OIDC_ENABLED &&
            this.AUTH_OIDC_ISSUER.length > 0 &&
            this.AUTH_OIDC_CLIENT_ID.length > 0
        );
    },
}));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: { deviceAuth: true },
}));

vi.mock('$app/environment', () => ({ dev: false }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

// No native session cookie → falls through to the forward-auth path.
vi.mock('$lib/server/auth/native-session.js', () => ({
    SESSION_COOKIE_NAME: 'lumastra_session',
    readSessionCookie: (cookies: RequestEvent['cookies']) =>
        cookies.get('lumastra_session') ?? null,
    clearSessionCookie: vi.fn(),
    buildUserContextFromSession: () => ({
        userId: '00000000-0000-4000-8000-000000000001',
        username: 'alice',
        userGroups: [],
        ownerIsAdmin: false,
    }),
}));

const validate = vi.hoisted(() => vi.fn());
const revoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ validate, revoke }),
}));
const patValidate = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: patValidate }),
}));

// An admin exists → first-run /setup redirect does NOT fire, so we exercise the
// steady-state branch under test.
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
    getUserByUsername: vi.fn(async () => null),
    upsertUser: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({}) as unknown) },
}));

// Import-time-heavy modules the middleware pulls in transitively but that this
// path never exercises (they read config keys absent from the mock above).
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

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: vi.fn(async () => ({
        inAppGroupNames: [],
        effectiveGroups: [],
        capabilities: {},
    })),
}));
vi.mock('$lib/server/oauth/jwt.js', () => ({ verifyAccessToken: vi.fn() }));
vi.mock('$lib/server/oauth/device-approval-audit.js', () => ({
    auditDeviceApprovalFailure: vi.fn(async () => undefined),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { clearSessionCookie } from '$lib/server/auth/native-session.js';
import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makePageEvent(path = '/', extraHeaders?: Record<string, string>): RequestEvent {
    const url = new URL('http://localhost' + path);
    const request = new Request(url, {
        headers: new Headers({ accept: 'text/html', ...extraHeaders }),
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
    validate.mockReset();
    patValidate.mockReset();
    mockConfig.AUTH_NATIVE_LOGIN_ENABLED = false;
    mockConfig.AUTH_OIDC_ENABLED = false;
    mockConfig.AUTH_OIDC_ISSUER = '';
    mockConfig.AUTH_OIDC_CLIENT_ID = '';
});

describe('dependency failures during authentication', () => {
    it.each(['/api/auth/check', '/api/admin/system-status', '/watch/movie', '/admin'])(
        '%s returns retryable 503 and preserves the cookie',
        async (path) => {
            const event = makePageEvent(path);
            event.cookies.get = () => 'session_token';
            validate.mockRejectedValue(
                Object.assign(new Error('CONNECTION_CLOSED'), { code: 'ECONNREFUSED' }),
            );
            const response = await resolveAuth(event, noopMigration, true);
            expect(response?.status).toBe(503);
            expect(response?.headers.get('retry-after')).toBe('5');
            expect(response?.headers.get('X-Lumastra-Auth-Retry')).toBe('true');
            expect(response?.headers.get('location')).toBeNull();
            expect(response?.headers.get('content-type')).toContain('application/problem+json');
            expect(await response?.json()).toMatchObject({
                code: 'dependency_unavailable',
                status: 503,
            });
            expect(clearSessionCookie).not.toHaveBeenCalled();
            expect(event.locals.user).toBeUndefined();
        },
    );

    it('authenticates the same cookie on the next request once the dependency recovers', async () => {
        const event = makePageEvent('/api/auth/check');
        event.cookies.get = () => 'session_token';
        validate.mockRejectedValueOnce(
            Object.assign(new Error('connection closed'), { code: 'ECONNREFUSED' }),
        );
        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(503);
        validate.mockResolvedValue({
            user_id: '00000000-0000-4000-8000-000000000001',
            session_id: 's1',
            username: 'alice',
            groups: [],
        });
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.authMethod).toBe('session');
        expect(clearSessionCookie).not.toHaveBeenCalled();
    });

    it('returns 503 if access lookup fails after validating the session row', async () => {
        const { resolveEffectiveAccess } =
            await import('$lib/server/services/access-control.service.js');
        vi.mocked(resolveEffectiveAccess).mockRejectedValueOnce(
            Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
        );
        const event = makePageEvent('/api/auth/check');
        event.cookies.get = () => 'session_token';
        validate.mockResolvedValue({
            user_id: 'u1',
            session_id: 's1',
            username: 'alice',
            groups: [],
        });
        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(503);
        expect(clearSessionCookie).not.toHaveBeenCalled();
    });

    it('keeps login renderable if the startup schema check is unavailable', async () => {
        const event = makePageEvent('/login');
        expect(
            await resolveAuth(
                event,
                async () => {
                    throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
                },
                false,
            ),
        ).toBeUndefined();
    });

    it('allows the login page to render with an unverifiable cookie, preserving it', async () => {
        const event = makePageEvent('/login');
        event.cookies.get = () => 'session_token';
        validate.mockRejectedValue(
            Object.assign(new Error('connection closed'), { code: 'ECONNREFUSED' }),
        );
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(clearSessionCookie).not.toHaveBeenCalled();
    });

    it('Apple JWT user lookup failures are temporary, while invalid JWTs remain 401', async () => {
        const { verifyAccessToken } = await import('$lib/server/oauth/jwt.js');
        const { getUserByUsername } = await import('$lib/server/database/queries/users.queries.js');
        vi.mocked(verifyAccessToken).mockResolvedValue({ username: 'alice' } as never);
        vi.mocked(getUserByUsername).mockRejectedValueOnce(
            Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
        );
        const event = makePageEvent('/api/v1/media', { authorization: 'Bearer jwt-test' });
        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(503);
        vi.mocked(verifyAccessToken).mockResolvedValue(null);
        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(401);
    });

    it('a confirmed invalid cookie is still cleared and denied', async () => {
        const event = makePageEvent('/api/auth/check');
        event.cookies.get = () => 'session_token';
        validate.mockResolvedValue(null);
        const response = await resolveAuth(event, noopMigration, true);
        expect(response?.status).toBe(401);
        expect(clearSessionCookie).toHaveBeenCalledOnce();
    });

    it('keeps unrelated bearer validation errors unauthorized and throttled', async () => {
        const { checkRateLimit } = await import('$lib/server/middleware/valkey-rate-limit.js');
        patValidate.mockRejectedValue(new TypeError('bad token metadata'));
        const event = makePageEvent('/api/v1/media', { authorization: 'Bearer pat_test' });
        const response = await resolveAuth(event, noopMigration, true);
        expect(response?.status).toBe(401);
        expect(await response?.json()).toMatchObject({ code: 'invalid_token' });
        expect(checkRateLimit).toHaveBeenCalledWith(
            expect.stringContaining('auth_fail'),
            expect.any(Number),
            expect.any(Number),
        );
    });

    it('native logout still revokes the original cookie when the auth lookup is unavailable', async () => {
        let cookie: string | undefined = 'session_token';
        const event = makePageEvent('/api/auth/native/logout');
        event.request = new Request(event.url, { method: 'POST' });
        event.cookies.get = () => cookie;
        vi.mocked(clearSessionCookie).mockImplementationOnce(() => {
            cookie = undefined;
        });
        validate.mockRejectedValue(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        const { POST } = await import('../../../routes/api/auth/native/logout/+server.js');
        expect((await POST(event as never)).status).toBe(200);
        expect(revoke).toHaveBeenCalledWith('session_token');
        expect(cookie).toBeUndefined();
    });

    it.each(['/api/auth/logout'])(
        'preserves the browser cookie for bearer device logout POST %s',
        async (path) => {
            const event = makePageEvent(path);
            event.request = new Request(event.url, { method: 'POST' });
            event.cookies.get = () => 'session_token';
            validate.mockRejectedValue(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
            await resolveAuth(event, noopMigration, true);
            expect(clearSessionCookie).not.toHaveBeenCalled();
        },
    );

    it('bearer dependency errors are 503, not invalid_token', async () => {
        const event = makePageEvent('/api/v1/media', { authorization: 'Bearer pat_test' });
        patValidate.mockRejectedValue(
            Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        );
        const response = await resolveAuth(event, noopMigration, true);
        expect(response?.status).toBe(503);
        expect(response?.headers.get('retry-after')).toBe('5');
    });
});

it.each([false, true])(
    'audits device-approval auth rejections including dependency outages (unavailable=%s)',
    async (unavailable) => {
        const { auditDeviceApprovalFailure } =
            await import('$lib/server/oauth/device-approval-audit.js');
        const event = makePageEvent('/api/v1/oauth/device/approve', {
            authorization: 'Bearer pat_test',
        });
        event.request = new Request(event.url, { method: 'POST', headers: event.request.headers });
        if (unavailable) {
            patValidate.mockRejectedValueOnce(
                Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
            );
        } else {
            patValidate.mockResolvedValueOnce(null);
        }
        const response = await resolveAuth(event, noopMigration, true);
        expect(response?.status).toBe(unavailable ? 503 : 401);
        expect(auditDeviceApprovalFailure).toHaveBeenCalledWith(event, response);
        expect(event.locals.principal).toBeUndefined();
        expect(event.locals.user).toBeUndefined();
    },
);
