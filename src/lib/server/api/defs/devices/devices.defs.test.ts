// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the cast-devices endpoint defs.
 *
 * These tests verify the auth / structural properties of the defs
 * using mount() + enforce() — NOT the full Valkey/DB behaviour (that is
 * covered by device-commands.service.test.ts and device-commands.defs.test.ts).
 *
 * Key properties under test:
 *   - Feature flag gate: `FEATURE_DEVICE_AUTH=false` → 404
 *   - Unauthenticated → 401
 *   - Authenticated user → reaches the handler
 *   - Correct HTTP methods exported from each def
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

// ── Module mocks ─────────────────────────────────────────────────────────────

// config: FEATURE_DEVICE_AUTH on/off variants tested per test
vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_DEVICE_AUTH: true,
        FEATURE_LIVETV: true,
    },
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

vi.mock('$lib/server/tasks/api-auth.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/tasks/api-auth.js')>();
    return { ...actual };
});

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: () => false,
}));

// Mock Valkey / DB dependencies so defs can be imported without real services
vi.mock('$lib/server/cache/valkey.js', () => ({
    connectValkey: vi.fn().mockResolvedValue(true),
    isCoordinationValkeyReady: vi.fn().mockReturnValue(true),
    setEx: vi.fn().mockResolvedValue(true),
    cacheGet: vi.fn().mockResolvedValue(null),
    getCoordinationClient: vi.fn().mockReturnValue(null),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn().mockReturnValue(null),
}));

vi.mock('$lib/server/oauth/jellyfin-token.service.js', () => ({
    getJellyfinTokenService: vi.fn().mockReturnValue({
        getActiveTokensForUser: vi.fn().mockResolvedValue([]),
        revoke: vi.fn().mockResolvedValue(false),
    }),
}));

vi.mock('$lib/server/database/queries/oauth-refresh-tokens.queries.js', () => ({
    getActiveRefreshTokens: vi.fn().mockResolvedValue([]),
    revokeRefreshToken: vi.fn().mockResolvedValue(0),
}));

vi.mock('$lib/server/database/queries/provider-device-tokens.queries.js', () => ({
    getJellyfinTokenBySession: vi.fn().mockResolvedValue(null),
}));

vi.mock('$lib/server/services/device-presence.service.js', () => ({
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    getHeartbeat: vi.fn().mockResolvedValue(null),
    DEVICE_ONLINE_KEY: (id: string) => `device:online:${id}`,
    HEARTBEAT_TTL_SECONDS: 600,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def as devicesDef } from './index.js';
import { def as heartbeatDef } from './[id]/heartbeat.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeEvent(
    opts: {
        username?: string;
        isAdmin?: boolean;
        liveTv?: boolean;
        deviceSessionId?: string;
        params?: Record<string, string>;
        method?: string;
        body?: unknown;
    } = {},
): RequestEvent {
    const user = opts.username
        ? {
              userId: toUserId('00000000-0000-0000-0000-000000000001'),
              username: opts.username,
              groups: '',
              userGroups: [] as string[],
              hasWatchPermission: false,
              hasLiveTvPermission: opts.liveTv ?? false,
              hasRequestPermission: false,
              isAdmin: opts.isAdmin ?? false,
              isModerator: false,
              maxAgeRating: null as null | number,
              isAgeRestricted: false,
              liveTvPriority: 'low' as const,
          }
        : null;

    const bodyStr = opts.body ? JSON.stringify(opts.body) : null;

    return {
        url: new URL('http://localhost/api/v1/devices'),
        request: new Request('http://localhost/api/v1/devices', {
            method: opts.method ?? 'GET',
            body: bodyStr,
            headers: bodyStr ? { 'content-type': 'application/json' } : undefined,
        }),
        params: opts.params ?? {},
        route: { id: '/api/v1/devices' as const },
        locals: {
            user,
            deviceSessionId: opts.deviceSessionId,
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

const CTX = { surface: 'v1' as const };

async function bodyCode(res: Response): Promise<string> {
    const body = (await res.clone().json()) as { code?: string };
    return body.code ?? '';
}

// ── devices/ (GET/DELETE listing) ─────────────────────────────────────────────

describe('defs/devices/index (GET devices?scope=mine)', () => {
    it('exports only GET on the collection', () => {
        const { GET, DELETE, POST, PUT, PATCH } = mount(devicesDef, CTX);
        expect(typeof GET).toBe('function');
        expect(DELETE).toBeUndefined();
        expect(POST).toBeUndefined();
        expect(PUT).toBeUndefined();
        expect(PATCH).toBeUndefined();
    });

    it('returns 404 when FEATURE_DEVICE_AUTH is false', async () => {
        const { config } = await import('$lib/server/config.js');
        const originalValue = (config as unknown as Record<string, unknown>).FEATURE_DEVICE_AUTH;
        (config as unknown as Record<string, unknown>).FEATURE_DEVICE_AUTH = false;

        const { GET } = mount(devicesDef, CTX);
        const res = await GET!(makeEvent({ username: 'alice' }));
        expect(res.status).toBe(404);
        expect(await bodyCode(res)).toBe('not_found');

        // Restore
        (config as unknown as Record<string, unknown>).FEATURE_DEVICE_AUTH = originalValue;
    });

    it('returns 401 when unauthenticated', async () => {
        const { GET } = mount(devicesDef, CTX);
        const res = await GET!(makeEvent({ username: '' }));
        expect(res.status).toBe(401);
    });

    it('reaches handler for authenticated user (returns 503 when DB null)', async () => {
        const { GET } = mount(devicesDef, CTX);
        const res = await GET!(makeEvent({ username: 'alice' }));
        // DB is mocked as null → 503 dependency_unavailable
        expect(res.status).toBe(503);
        expect(await bodyCode(res)).toBe('dependency_unavailable');
    });
});

// ── devices/[id]/heartbeat ────────────────────────────────────────────────────

describe('defs/devices/[id]/heartbeat (POST)', () => {
    it('exports only POST', () => {
        const { GET, POST, DELETE } = mount(heartbeatDef, CTX);
        expect(typeof POST).toBe('function');
        expect(GET).toBeUndefined();
        expect(DELETE).toBeUndefined();
    });

    it('returns 401 when unauthenticated', async () => {
        const { POST } = mount(heartbeatDef, CTX);
        const res = await POST!(makeEvent({ username: '' }));
        expect(res.status).toBe(401);
    });

    it('returns 403 when no deviceSessionId in JWT', async () => {
        const { POST } = mount(heartbeatDef, CTX);
        const res = await POST!(makeEvent({ username: 'alice', params: { id: 'some-device' } }));
        expect(res.status).toBe(403);
        expect(await bodyCode(res)).toBe('forbidden');
    });

    it('returns 403 when path id does not match JWT deviceSessionId', async () => {
        const { POST } = mount(heartbeatDef, CTX);
        const res = await POST!(
            makeEvent({
                username: 'alice',
                deviceSessionId: 'my-device-jwt',
                params: { id: 'other-device' },
            }),
        );
        expect(res.status).toBe(403);
    });

    it('returns 200 when id matches deviceSessionId (Valkey write)', async () => {
        const { POST } = mount(heartbeatDef, CTX);
        const res = await POST!(
            makeEvent({
                username: 'alice',
                deviceSessionId: 'my-device-jwt',
                params: { id: 'my-device-jwt' },
                method: 'POST',
            }),
        );
        // Valkey setEx is mocked → should return 200
        expect(res.status).toBe(200);
        const body = (await res.json()) as { expiresIn: number };
        expect(typeof body.expiresIn).toBe('number');
    });
});

describe('defs/devices/[id]/heartbeat capabilities', () => {
    it('stores the announced remote-control capabilities', async () => {
        const presence = await import('$lib/server/services/device-presence.service.js');
        vi.mocked(presence.recordHeartbeat).mockClear();
        const { POST } = mount(heartbeatDef, CTX);
        const res = await POST!(
            makeEvent({
                username: 'alice',
                deviceSessionId: 'tv-1',
                params: { id: 'tv-1' },
                method: 'POST',
                body: {
                    deviceName: 'Living Room',
                    deviceType: 'tv',
                    capabilities: {
                        commands: { 'playback.pause': {}, 'ui.message': { actions: 3 } },
                    },
                },
            }),
        );
        expect(res.status).toBe(200);
        expect(presence.recordHeartbeat).toHaveBeenCalledWith(
            'tv-1',
            expect.objectContaining({
                capabilities: { commands: { 'playback.pause': {}, 'ui.message': { actions: 3 } } },
            }),
        );
    });

    it('drops malformed capabilities instead of refusing the heartbeat', async () => {
        const presence = await import('$lib/server/services/device-presence.service.js');
        vi.mocked(presence.recordHeartbeat).mockClear();
        const { POST } = mount(heartbeatDef, CTX);
        const res = await POST!(
            makeEvent({
                username: 'alice',
                deviceSessionId: 'tv-1',
                params: { id: 'tv-1' },
                method: 'POST',
                body: { deviceType: 'tv', capabilities: { commands: 'everything' } },
            }),
        );
        expect(res.status).toBe(200);
        const status = vi.mocked(presence.recordHeartbeat).mock.calls[0][1];
        expect(status.capabilities).toBeUndefined();
    });
});
