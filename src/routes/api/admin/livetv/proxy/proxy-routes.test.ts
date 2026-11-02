// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level tests for the migrated Live TV proxy admin endpoints.
 *
 * These routes are now thin `mount(def)` re-exports of the defs under
 * src/lib/server/api/defs/livetv/admin/proxy/** (dual-mounted on
 * /api/admin/livetv/proxy/* and /api/v1/livetv/admin/proxy/*). Auth is
 * scope-based (`livetv:admin`) and bodies follow the redesigned contract:
 * bare success objects + application/problem+json on error.
 *
 * The legacy "kill" path is retired — `proxy/cancel` is canonical, so the
 * cancel describe block exercises the previous kill behaviour against the
 * cancel def.
 *
 * Properties under test:
 *   - scope auth: principal carrying `livetv:admin` passes; missing → 403 scope_required
 *   - status GET: bare ProxyStatus object on success
 *   - cancel POST: { cancelled: true }; viewerId → leaveChannel, none → killChannel
 *   - reconnect POST: { reconnected: true } via killChannel
 *   - non-standalone mode → 422 validation_failed
 *   - proxy unreachable → 503 dependency_unavailable
 *   - missing channelId → 422 validation_failed (input contract)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ProxyStatus } from '../../../../../shared/livetv-proxy-types.js';

// ── Hoisted mocks (declared BEFORE vi.mock calls) ────────────────────────────

const { mockConfig } = vi.hoisted(() => ({
    mockConfig: {
        LIVETV_SOURCE: 'standalone' as string,
        STREAM_PROXY_URL: 'http://proxy:3000',
        STREAM_PROXY_SECRET: 'secret',
        // Named exports consumed transitively by the task registry that the
        // mount() auth chokepoint pulls in (mirrors how other def tests fully
        // mock $lib/server/config.js).
        FEATURE_PER_TASK_QUEUES: false,
    },
}));

const { mockGetProxyStatus, mockLeaveChannel, mockKillChannel } = vi.hoisted(() => ({
    mockGetProxyStatus: vi.fn<() => Promise<ProxyStatus>>(),
    mockLeaveChannel: vi.fn(),
    mockKillChannel: vi.fn(),
}));

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: {},
    FEATURE_PER_TASK_QUEUES: false,
}));

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

vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => ({
        getProxyStatus: mockGetProxyStatus,
        leaveChannel: mockLeaveChannel,
        killChannel: mockKillChannel,
    }),
}));

// Token services used by the mount() admin-from-bearer fallback. They are never
// exercised here (principal carries the scope directly) but must resolve.
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: () => false,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def as statusDef } from '$lib/server/api/defs/livetv/admin/proxy/status.js';
import { def as cancelDef } from '$lib/server/api/defs/livetv/admin/proxy/cancel.js';
import { def as reconnectDef } from '$lib/server/api/defs/livetv/admin/proxy/reconnect.js';

const CTX_INTERNAL = { surface: 'internal' as const };

const sampleStatus: ProxyStatus = {
    healthy: true,
    uptime: 3600,
    activeChannels: 2,
    totalViewers: 5,
    ffmpegAvailable: true,
    channels: [
        {
            channelId: 'ch1',
            channelName: 'Test Channel',
            viewers: 3,
            sourceId: 'src1',
            ffmpegHealthy: true,
            ffmpegHealth: 'healthy',
            startedAt: new Date().toISOString(),
        },
    ],
    perSourceLimits: [{ sourceId: 'src1', activeStreams: 2, maxStreams: 5 }],
};

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Build a RequestEvent whose `locals.principal` carries the given scopes.
 * mount()'s scope enforcement reads the principal's expanded scope set first,
 * so this is the canonical way to authorise a scope-gated def in a unit test.
 */
function makeEvent(
    opts: {
        method?: string;
        path?: string;
        scopes?: string[] | null;
        body?: unknown;
    } = {},
): RequestEvent {
    const path = opts.path ?? '/api/admin/livetv/proxy/status';
    const method = opts.method ?? 'GET';
    const scopes = opts.scopes;

    const init: RequestInit = { method };
    if (opts.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(opts.body);
    }

    const principal =
        scopes === null
            ? null
            : {
                  kind: 'pat',
                  userId: '00000000-0000-0000-0000-000000000001',
                  username: 'admin',
                  userGroups: ['admins'],
                  scopes: scopes ?? ['livetv:admin'],
                  isAdmin: false,
              };

    return {
        url: new URL(`http://localhost${path}`),
        request: new Request(`http://localhost${path}`, init),
        params: {},
        route: { id: path },
        locals: {
            principal,
            user: null,
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

async function parseJson(res: Response) {
    return res.clone().json() as Promise<Record<string, unknown>>;
}

// ── status (GET) ──────────────────────────────────────────────────────────────

describe('GET /api/admin/livetv/proxy/status (def: livetv/admin/proxy/status)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.LIVETV_SOURCE = 'standalone';
    });

    it('exports GET only', () => {
        const { GET, POST, PUT, DELETE } = mount(statusDef, CTX_INTERNAL);
        expect(typeof GET).toBe('function');
        expect(POST).toBeUndefined();
        expect(PUT).toBeUndefined();
        expect(DELETE).toBeUndefined();
    });

    it('returns 403 scope_required when principal lacks livetv:admin', async () => {
        const { GET } = mount(statusDef, CTX_INTERNAL);
        const res = await GET!(makeEvent({ scopes: ['media:read'] }));
        expect(res.status).toBe(403);
        const body = await parseJson(res);
        expect(body.code).toBe('scope_required');
    });

    it('returns bare proxy status object when standalone mode', async () => {
        mockGetProxyStatus.mockResolvedValue(sampleStatus);

        const { GET } = mount(statusDef, CTX_INTERNAL);
        const res = await GET!(makeEvent());

        expect(res.status).toBe(200);
        const body = await parseJson(res);
        // Bare object — no { success: true } wrapper.
        expect(body.success).toBeUndefined();
        expect(body.healthy).toBe(true);
        expect(body.activeChannels).toBe(2);
        expect(body.totalViewers).toBe(5);
    });

    it('returns 422 validation_failed when not standalone mode', async () => {
        mockConfig.LIVETV_SOURCE = 'disabled';

        const { GET } = mount(statusDef, CTX_INTERNAL);
        const res = await GET!(makeEvent());

        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 503 dependency_unavailable when proxy unreachable', async () => {
        mockGetProxyStatus.mockRejectedValue(new Error('Connection refused'));

        const { GET } = mount(statusDef, CTX_INTERNAL);
        const res = await GET!(makeEvent());

        expect(res.status).toBe(503);
        const body = await parseJson(res);
        expect(body.code).toBe('dependency_unavailable');
    });
});

// ── cancel (POST) — canonical replacement for legacy "kill" ───────────────────

describe('POST /api/admin/livetv/proxy/cancel (def: livetv/admin/proxy/cancel)', () => {
    const PATH = '/api/admin/livetv/proxy/cancel';

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.LIVETV_SOURCE = 'standalone';
    });

    it('exports POST only', () => {
        const { POST, GET, PUT } = mount(cancelDef, CTX_INTERNAL);
        expect(typeof POST).toBe('function');
        expect(GET).toBeUndefined();
        expect(PUT).toBeUndefined();
    });

    it('returns 403 scope_required when principal lacks livetv:admin', async () => {
        const { POST } = mount(cancelDef, CTX_INTERNAL);
        const res = await POST!(
            makeEvent({
                method: 'POST',
                path: PATH,
                scopes: ['media:read'],
                body: { channelId: 'ch1' },
            }),
        );
        expect(res.status).toBe(403);
        const body = await parseJson(res);
        expect(body.code).toBe('scope_required');
    });

    it('kicks a specific viewer when viewerId provided ({ cancelled: true })', async () => {
        mockLeaveChannel.mockResolvedValue(undefined);

        const { POST } = mount(cancelDef, CTX_INTERNAL);
        const res = await POST!(
            makeEvent({ method: 'POST', path: PATH, body: { channelId: 'ch1', viewerId: 'v1' } }),
        );

        expect(res.status).toBe(200);
        const body = await parseJson(res);
        expect(body).toEqual({ cancelled: true });
        expect(mockLeaveChannel).toHaveBeenCalledWith('ch1', 'v1');
        expect(mockKillChannel).not.toHaveBeenCalled();
    });

    it('kills the entire channel when no viewerId provided ({ cancelled: true })', async () => {
        mockKillChannel.mockResolvedValue(undefined);

        const { POST } = mount(cancelDef, CTX_INTERNAL);
        const res = await POST!(
            makeEvent({ method: 'POST', path: PATH, body: { channelId: 'ch1' } }),
        );

        expect(res.status).toBe(200);
        const body = await parseJson(res);
        expect(body).toEqual({ cancelled: true });
        expect(mockKillChannel).toHaveBeenCalledWith('ch1');
        expect(mockLeaveChannel).not.toHaveBeenCalled();
    });

    it('returns 422 validation_failed when not standalone mode', async () => {
        mockConfig.LIVETV_SOURCE = 'disabled';

        const { POST } = mount(cancelDef, CTX_INTERNAL);
        const res = await POST!(
            makeEvent({ method: 'POST', path: PATH, body: { channelId: 'ch1' } }),
        );

        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 422 validation_failed when channelId is missing (input contract)', async () => {
        const { POST } = mount(cancelDef, CTX_INTERNAL);
        const res = await POST!(makeEvent({ method: 'POST', path: PATH, body: {} }));

        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 503 dependency_unavailable when proxy unreachable', async () => {
        mockLeaveChannel.mockRejectedValue(new Error('Connection refused'));

        const { POST } = mount(cancelDef, CTX_INTERNAL);
        const res = await POST!(
            makeEvent({ method: 'POST', path: PATH, body: { channelId: 'ch1', viewerId: 'v1' } }),
        );

        expect(res.status).toBe(503);
        const body = await parseJson(res);
        expect(body.code).toBe('dependency_unavailable');
    });
});

// ── reconnect (POST) ──────────────────────────────────────────────────────────

describe('POST /api/admin/livetv/proxy/reconnect (def: livetv/admin/proxy/reconnect)', () => {
    const PATH = '/api/admin/livetv/proxy/reconnect';

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.LIVETV_SOURCE = 'standalone';
    });

    it('exports POST only', () => {
        const { POST, GET } = mount(reconnectDef, CTX_INTERNAL);
        expect(typeof POST).toBe('function');
        expect(GET).toBeUndefined();
    });

    it('returns 403 scope_required when principal lacks livetv:admin', async () => {
        const { POST } = mount(reconnectDef, CTX_INTERNAL);
        const res = await POST!(
            makeEvent({
                method: 'POST',
                path: PATH,
                scopes: ['media:read'],
                body: { channelId: 'ch1' },
            }),
        );
        expect(res.status).toBe(403);
        const body = await parseJson(res);
        expect(body.code).toBe('scope_required');
    });

    it('reconnects a channel via killChannel ({ reconnected: true })', async () => {
        mockKillChannel.mockResolvedValue(undefined);

        const { POST } = mount(reconnectDef, CTX_INTERNAL);
        const res = await POST!(
            makeEvent({ method: 'POST', path: PATH, body: { channelId: 'ch1' } }),
        );

        expect(res.status).toBe(200);
        const body = await parseJson(res);
        expect(body).toEqual({ reconnected: true });
        expect(mockKillChannel).toHaveBeenCalledWith('ch1');
    });

    it('returns 422 validation_failed when not standalone mode', async () => {
        mockConfig.LIVETV_SOURCE = 'disabled';

        const { POST } = mount(reconnectDef, CTX_INTERNAL);
        const res = await POST!(
            makeEvent({ method: 'POST', path: PATH, body: { channelId: 'ch1' } }),
        );

        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 422 validation_failed when channelId is missing (input contract)', async () => {
        const { POST } = mount(reconnectDef, CTX_INTERNAL);
        const res = await POST!(makeEvent({ method: 'POST', path: PATH, body: {} }));

        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 503 dependency_unavailable when proxy unreachable', async () => {
        mockKillChannel.mockRejectedValue(new Error('Connection refused'));

        const { POST } = mount(reconnectDef, CTX_INTERNAL);
        const res = await POST!(
            makeEvent({ method: 'POST', path: PATH, body: { channelId: 'ch1' } }),
        );

        expect(res.status).toBe(503);
        const body = await parseJson(res);
        expect(body.code).toBe('dependency_unavailable');
    });
});

// ── Zod schemas for proxy dashboard (unchanged contract) ──────────────────────

describe('Zod schemas for proxy dashboard', () => {
    it('validates ProxyStatusResponseSchema', async () => {
        const { ProxyStatusResponseSchema } = await import('$lib/schemas/livetv.js');

        const result = ProxyStatusResponseSchema.safeParse(sampleStatus);
        expect(result.success).toBe(true);
    });

    it('rejects invalid ProxyStatusResponseSchema', async () => {
        const { ProxyStatusResponseSchema } = await import('$lib/schemas/livetv.js');

        const result = ProxyStatusResponseSchema.safeParse({
            healthy: 'not a boolean',
        });
        expect(result.success).toBe(false);
    });

    it('validates ProxyKillRequestSchema', async () => {
        const { ProxyKillRequestSchema } = await import('$lib/schemas/livetv.js');

        expect(ProxyKillRequestSchema.safeParse({ channelId: 'ch1' }).success).toBe(true);
        expect(
            ProxyKillRequestSchema.safeParse({
                channelId: 'ch1',
                viewerId: 'v1',
            }).success,
        ).toBe(true);
        expect(ProxyKillRequestSchema.safeParse({}).success).toBe(false);
    });

    it('validates ProxyReconnectRequestSchema', async () => {
        const { ProxyReconnectRequestSchema } = await import('$lib/schemas/livetv.js');

        expect(ProxyReconnectRequestSchema.safeParse({ channelId: 'ch1' }).success).toBe(true);
        expect(ProxyReconnectRequestSchema.safeParse({}).success).toBe(false);
    });

    it('validates ProxyChannelInfoSchema with optional fields', async () => {
        const { ProxyChannelInfoSchema } = await import('$lib/schemas/livetv.js');

        const minimal = {
            channelId: 'ch1',
            channelName: 'Test',
            viewers: 2,
            sourceId: 'src1',
            ffmpegHealthy: true,
            startedAt: new Date().toISOString(),
        };

        expect(ProxyChannelInfoSchema.safeParse(minimal).success).toBe(true);

        const full = {
            ...minimal,
            ffmpegHealth: 'degraded',
            activeStreamUrl: 'http://stream.url',
            streamUrlIndex: 1,
            failoverExhausted: false,
            failoverCount: 2,
        };

        expect(ProxyChannelInfoSchema.safeParse(full).success).toBe(true);
    });
});
