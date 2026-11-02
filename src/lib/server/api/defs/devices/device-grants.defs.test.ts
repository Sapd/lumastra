// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The household-grant defs: GET/POST /devices/grants, DELETE
 * /devices/grants/{username}, GET /devices/controllable. The SQL itself is
 * covered by device-control-grants.queries.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/config.js', () => ({ config: { FEATURE_DEVICE_AUTH: true } }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
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
vi.mock('$lib/server/auth.js', () => ({ isUserAdmin: () => false }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    auditActor: vi.fn(() => ({ username: 'alice' })),
}));
vi.mock('$lib/server/database/queries/device-control-grants.queries.js', () => ({
    MAX_GRANTS_PER_OWNER: 20,
    listGrantsByOwner: { all: vi.fn() },
    listControllableDevices: { all: vi.fn() },
    addGrantCapped: vi.fn(),
    removeGrant: { execute: vi.fn() },
    findUserByUsernameFolded: vi.fn(),
}));
vi.mock('$lib/server/services/device-presence.service.js', () => ({
    getHeartbeat: vi.fn(),
    getHeartbeats: vi.fn(),
}));
vi.mock('$lib/server/services/device-commands.service.js', () => ({
    invalidateHelpersCache: vi.fn(),
    cancelCommandsFromSender: vi.fn(async () => 0),
}));
const rateLimit = vi.hoisted(() => ({ allowed: true }));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({
        allowed: rateLimit.allowed,
        resetAt: Math.floor(Date.now() / 1000) + 30,
    })),
}));

import { mount } from '$lib/server/api/mount.js';
import { def as grantsDef } from './grants/index.js';
import { def as grantDef } from './grants/[username].js';
import { def as controllableDef } from './controllable.js';
import * as q from '$lib/server/database/queries/device-control-grants.queries.js';
import { getHeartbeats } from '$lib/server/services/device-presence.service.js';
import {
    cancelCommandsFromSender,
    invalidateHelpersCache,
} from '$lib/server/services/device-commands.service.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { auditLog } from '$lib/server/utils/audit-log.js';

const CTX = { surface: 'v1' as const };
const ME = '00000000-0000-0000-0000-000000000001';
const BOB = '00000000-0000-0000-0000-000000000002';

function makeEvent(opts: {
    params?: Record<string, string>;
    method?: string;
    body?: unknown;
    authMethod?: string;
}): RequestEvent {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    const url = 'http://localhost/api/v1/devices/grants';
    return {
        url: new URL(url),
        request: new Request(url, {
            method: opts.method ?? 'GET',
            body: bodyStr,
            headers: bodyStr ? { 'content-type': 'application/json' } : {},
        }),
        params: opts.params ?? {},
        route: { id: '/api/v1/devices/grants' as const },
        locals: {
            user: {
                userId: toUserId(ME),
                username: 'alice',
                groups: '',
                userGroups: [] as string[],
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: false,
                isAdmin: false,
                isModerator: false,
                maxAgeRating: null,
                isAgeRestricted: false,
                liveTvPriority: 'low' as const,
            },
            authMethod: opts.authMethod ?? 'session',
            principal: {
                kind: opts.authMethod ?? 'session',
                userId: toUserId(ME),
                username: 'alice',
                scopes: [],
            },
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

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(q.findUserByUsernameFolded).mockResolvedValue({ id: BOB, username: 'Bob' });
    rateLimit.allowed = true;
    vi.mocked(q.addGrantCapped).mockResolvedValue({
        status: 'added',
        createdAt: new Date('2026-10-16T12:00:00Z'),
    });
    vi.mocked(q.removeGrant.execute).mockResolvedValue([{ owner_user_id: ME }]);
});

describe('GET /devices/grants', () => {
    it('lists the people allowed to control my devices', async () => {
        vi.mocked(q.listGrantsByOwner.all).mockResolvedValue([
            { user_id: BOB, username: 'Bob', created_at: new Date('2026-10-16T10:00:00Z') },
        ]);
        const res = await mount(grantsDef, CTX).GET!(makeEvent({}));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            items: [{ username: 'Bob', createdAt: '2026-10-16T10:00:00.000Z' }],
        });
        expect(q.listGrantsByOwner.all).toHaveBeenCalledWith(expect.anything(), {
            ownerUserId: ME,
        });
    });
});

describe('POST /devices/grants', () => {
    const post = (username: unknown) =>
        mount(grantsDef, CTX).POST!(makeEvent({ method: 'POST', body: { username } }));

    it('adds a helper by username (case-insensitive lookup) and audits it', async () => {
        const res = await post('BOB');
        expect(res.status).toBe(201);
        expect(((await res.json()) as { username: string }).username).toBe('Bob');
        expect(q.findUserByUsernameFolded).toHaveBeenCalledWith(expect.anything(), 'BOB');
        expect(q.addGrantCapped).toHaveBeenCalledWith(expect.anything(), {
            ownerUserId: ME,
            granteeUserId: BOB,
        });
        expect(invalidateHelpersCache).toHaveBeenCalledWith(ME);
        expect(auditLog).toHaveBeenCalledWith(
            'device.grant.add',
            'Bob',
            expect.anything(),
            expect.objectContaining({ owner: 'alice', grantee: 'Bob' }),
        );
    });

    it('answers 200 with the STORED createdAt and does not audit a repeat', async () => {
        vi.mocked(q.addGrantCapped).mockResolvedValue({
            status: 'exists',
            createdAt: new Date('2026-09-01T08:30:00Z'),
        });
        const res = await post('bob');
        expect(res.status).toBe(200);
        expect(((await res.json()) as { createdAt: string }).createdAt).toBe(
            '2026-09-01T08:30:00.000Z',
        );
        expect(auditLog).not.toHaveBeenCalled();
        expect(invalidateHelpersCache).not.toHaveBeenCalled();
    });

    it('refuses the 21st helper with 422', async () => {
        vi.mocked(q.addGrantCapped).mockResolvedValue({ status: 'limit', createdAt: null });
        const res = await post('bob');
        expect(res.status).toBe(422);
        expect(JSON.stringify(await res.json())).toContain('at most 20');
        expect(auditLog).not.toHaveBeenCalled();
    });

    it.each(['pat', 'service_token', 'stream_token', 'bearer'])(
        'refuses a %s credential with 403 before touching anything',
        async (authMethod) => {
            const res = await mount(grantsDef, CTX).POST!(
                makeEvent({ method: 'POST', body: { username: 'bob' }, authMethod }),
            );
            expect(res.status).toBe(403);
            expect(JSON.stringify(await res.json())).toContain('session_required');
            expect(q.findUserByUsernameFolded).not.toHaveBeenCalled();
            expect(q.addGrantCapped).not.toHaveBeenCalled();
        },
    );

    it.each(['session', 'forward_auth'])('allows a %s sign-in', async (authMethod) => {
        const res = await mount(grantsDef, CTX).POST!(
            makeEvent({ method: 'POST', body: { username: 'bob' }, authMethod }),
        );
        expect(res.status).toBe(201);
    });

    it('is rate limited per user with Retry-After', async () => {
        rateLimit.allowed = false;
        const res = await post('bob');
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBeTruthy();
        expect(checkRateLimit).toHaveBeenCalledWith(`devgrant:${ME}`, 10, 60);
        expect(q.addGrantCapped).not.toHaveBeenCalled();
    });

    it('refuses yourself with 422', async () => {
        vi.mocked(q.findUserByUsernameFolded).mockResolvedValue({ id: ME, username: 'alice' });
        expect((await post('alice')).status).toBe(422);
        expect(q.addGrantCapped).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown user and 422 for a missing name', async () => {
        vi.mocked(q.findUserByUsernameFolded).mockResolvedValue(null);
        expect((await post('nobody')).status).toBe(404);
        expect((await post('')).status).toBe(422);
        expect(q.addGrantCapped).not.toHaveBeenCalled();
    });
});

describe('DELETE /devices/grants/{username}', () => {
    const del = (username: string) =>
        mount(grantDef, CTX).DELETE!(makeEvent({ method: 'DELETE', params: { username } }));

    it('removes the grant, stops the fan-out, cancels the helper’s commands and audits it', async () => {
        expect((await del('bob')).status).toBe(204);
        expect(invalidateHelpersCache).toHaveBeenCalledWith(ME);
        expect(cancelCommandsFromSender).toHaveBeenCalledWith(ME, BOB);
        expect(q.removeGrant.execute).toHaveBeenCalledWith(expect.anything(), {
            ownerUserId: ME,
            granteeUserId: BOB,
        });
        expect(auditLog).toHaveBeenCalledWith(
            'device.grant.remove',
            'Bob',
            expect.anything(),
            expect.objectContaining({ owner: 'alice', grantee: 'Bob' }),
        );
    });

    it.each(['pat', 'service_token', 'bearer'])(
        'refuses a %s credential with 403',
        async (authMethod) => {
            const res = await mount(grantDef, CTX).DELETE!(
                makeEvent({ method: 'DELETE', params: { username: 'bob' }, authMethod }),
            );
            expect(res.status).toBe(403);
            expect(q.removeGrant.execute).not.toHaveBeenCalled();
            expect(cancelCommandsFromSender).not.toHaveBeenCalled();
        },
    );

    it('is rate limited per user', async () => {
        rateLimit.allowed = false;
        expect((await del('bob')).status).toBe(429);
        expect(q.removeGrant.execute).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown user or a grant that does not exist', async () => {
        vi.mocked(q.removeGrant.execute).mockResolvedValue([]);
        expect((await del('bob')).status).toBe(404);
        expect(cancelCommandsFromSender).not.toHaveBeenCalled();
        vi.mocked(q.findUserByUsernameFolded).mockResolvedValue(null);
        expect((await del('nobody')).status).toBe(404);
        expect(auditLog).not.toHaveBeenCalled();
    });
});

describe('GET /devices/controllable', () => {
    const rowOf = (id: string, name: string | null, owner = 'grandma') => ({
        device_session_id: id,
        device_name: name,
        owner_username: owner,
    });
    const hb = (over: object = {}) => ({
        deviceType: 'tv',
        capabilities: { commands: { 'playback.pause': {} } },
        lastSeen: Date.parse('2026-10-16T10:00:00Z'),
        // Fields a helper must not get:
        userId: BOB,
        username: 'grandma',
        deviceName: 'secret',
        ...over,
    });

    it('lists the granting owners’ devices in ONE query, online first then by name, with only what a helper needs', async () => {
        vi.mocked(q.listControllableDevices.all).mockResolvedValue([
            rowOf('tv-b', 'B Room'),
            rowOf('tv-a', 'A Room'),
            rowOf('tv-off', 'Attic', 'aunt'),
        ] as never);
        vi.mocked(getHeartbeats).mockResolvedValue(
            new Map([
                ['tv-a', hb()],
                ['tv-b', hb()],
            ]) as never,
        );
        const res = await mount(controllableDef, CTX).GET!(makeEvent({}));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Record<string, unknown>[] };
        expect(body.items.map((i) => i.deviceSessionId)).toEqual(['tv-a', 'tv-b', 'tv-off']);
        expect(body.items[0]).toEqual({
            deviceSessionId: 'tv-a',
            deviceName: 'A Room',
            deviceType: 'tv',
            isOnline: true,
            lastHeartbeat: '2026-10-16T10:00:00.000Z',
            capabilities: { commands: { 'playback.pause': {} } },
            ownerUsername: 'grandma',
        });
        expect(body.items[2]).toEqual({
            deviceSessionId: 'tv-off',
            deviceName: 'Attic',
            isOnline: false,
            ownerUsername: 'aunt',
        });
        // No identifying extras.
        for (const item of body.items) {
            expect(item).not.toHaveProperty('deviceId');
            expect(item).not.toHaveProperty('clientId');
            expect(item).not.toHaveProperty('userId');
        }
        expect(q.listControllableDevices.all).toHaveBeenCalledTimes(1);
        expect(q.listControllableDevices.all).toHaveBeenCalledWith(expect.anything(), {
            granteeUserId: ME,
        });
    });

    it('is empty when nobody granted me anything', async () => {
        vi.mocked(q.listControllableDevices.all).mockResolvedValue([]);
        vi.mocked(getHeartbeats).mockResolvedValue(new Map());
        const res = await mount(controllableDef, CTX).GET!(makeEvent({}));
        expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
    });
});
