// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The device defs with an external remote-target provider registered (the
 * Jellyfin clients, `jf:<id>`): they list next to the real devices, and a
 * command or state read for such an id goes to the provider, never to the
 * Lumastra device path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/config.js', () => ({
    config: { FEATURE_DEVICE_AUTH: true, FEATURE_LIVETV: true },
}));
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
vi.mock('$lib/server/cache/valkey.js', () => ({
    connectValkey: vi.fn().mockResolvedValue(true),
    isCoordinationValkeyReady: vi.fn().mockReturnValue(true),
}));
// A callable sql whose queries find no device: the Lumastra access check answers "unknown".
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => () => Promise.resolve([])),
}));
vi.mock('$lib/server/oauth/device-session-liveness.js', () => ({
    isDeviceSessionTombstoned: vi.fn(() => false),
    onDeviceSessionsRevoked: vi.fn(),
}));
vi.mock('$lib/server/services/device-presence.service.js', () => ({
    getHeartbeat: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/services/device-command-checks.js', () => ({
    deviceCommandChecks: vi.fn(() => ({})),
}));
vi.mock('$lib/server/services/device-state-projection.js', () => ({
    projectNowPlaying: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/services/device-commands.service.js', () => ({
    sendDeviceCommand: vi.fn(),
    buildDeviceState: vi.fn(),
    listDeviceInbox: vi.fn(),
    getDeviceCommand: vi.fn(),
    cancelDeviceCommand: vi.fn(),
    reportDeviceCommandResult: vi.fn(),
    reportDeviceState: vi.fn(),
    beginIdempotentSend: vi.fn(),
}));
vi.mock('$lib/server/services/user-devices.service.js', () => ({
    getUserDevices: vi.fn(),
}));

import { mount } from '$lib/server/api/mount.js';
import { def as devicesDef } from './index.js';
import { def as commandsDef } from './[id]/commands/index.js';
import { def as commandDef } from './[id]/commands/[commandId]/index.js';
import { def as stateDef } from './[id]/state.js';
import * as service from '$lib/server/services/device-commands.service.js';
import { deviceCommandChecks } from '$lib/server/services/device-command-checks.js';
import { getUserDevices } from '$lib/server/services/user-devices.service.js';
import {
    __resetExternalRemoteTargetProviderForTests,
    registerExternalRemoteTargetProvider,
} from '$lib/server/services/external-remote-targets.js';

const CTX = { surface: 'v1' as const };
const JF = 'jf:' + 'a'.repeat(32);

const provider = {
    owns: (id: string) => id.startsWith('jf:'),
    list: vi.fn(),
    state: vi.fn(),
    send: vi.fn(),
};

function event(opts: {
    url?: string;
    params?: Record<string, string>;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
}): RequestEvent {
    const url = opts.url ?? 'http://localhost/api/v1/devices/x';
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    return {
        url: new URL(url),
        request: new Request(url, {
            method: opts.method ?? 'GET',
            body: bodyStr,
            headers: {
                ...(bodyStr ? { 'content-type': 'application/json' } : {}),
                ...opts.headers,
            },
        }),
        params: opts.params ?? {},
        route: { id: '/api/v1/devices' as const },
        locals: {
            user: {
                userId: toUserId('00000000-0000-0000-0000-000000000001'),
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
            authMethod: 'bearer',
            deviceSessionId: 'phone-1',
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

const realDevice = {
    id: 1,
    deviceSessionId: 'tv-1',
    deviceId: 'd1',
    deviceName: 'Apple TV',
    isCustomName: false,
    createdAt: '2026-10-16T10:00:00.000Z',
    lastUsedAt: '2026-10-16T10:00:00.000Z',
    isOnline: false,
    supportsWatchTogether: false,
};
const jfDevice = {
    id: -7,
    external: true,
    deviceSessionId: JF,
    deviceId: 'findroid',
    deviceName: 'Pixel',
    isCustomName: false,
    createdAt: '2026-10-16T12:00:00.000Z',
    lastUsedAt: '2026-10-16T12:00:00.000Z',
    isOnline: true,
    supportsWatchTogether: false,
    lastHeartbeat: '2026-10-16T12:00:00.000Z',
    capabilities: { commands: { 'playback.pause': {} } },
};

beforeEach(() => {
    vi.clearAllMocks();
    __resetExternalRemoteTargetProviderForTests();
    registerExternalRemoteTargetProvider(provider as never);
    vi.mocked(getUserDevices).mockResolvedValue([realDevice] as never);
    provider.list.mockResolvedValue([jfDevice]);
});

describe('GET /devices', () => {
    it('lists external targets next to the real devices, online first', async () => {
        const res = await mount(devicesDef, CTX).GET!(
            event({ url: 'http://localhost/api/v1/devices' }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { deviceSessionId: string }[] };
        expect(body.items.map((d) => d.deviceSessionId)).toEqual([JF, 'tv-1']);
        expect(body.items[0]).toMatchObject({ external: true, deviceSessionId: JF });
        expect(body.items[0]).not.toHaveProperty('id');
        expect(body.items[1]).not.toHaveProperty('external');
        expect(provider.list).toHaveBeenCalledWith({
            userId: '00000000-0000-0000-0000-000000000001',
            username: 'alice',
        });
    });

    it('onlineOnly filters them like any device; without a provider nothing changes', async () => {
        const res = await mount(devicesDef, CTX).GET!(
            event({ url: 'http://localhost/api/v1/devices?onlineOnly=true' }),
        );
        expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
        __resetExternalRemoteTargetProviderForTests();
        const plain = await mount(devicesDef, CTX).GET!(
            event({ url: 'http://localhost/api/v1/devices' }),
        );
        expect(((await plain.json()) as { items: unknown[] }).items).toHaveLength(1);
    });
});

describe('POST /devices/{id}/commands for a jf: id', () => {
    const post = (body: unknown = { type: 'playback.pause' }, headers?: Record<string, string>) =>
        mount(commandsDef, CTX).POST!(
            event({ params: { id: JF }, method: 'POST', body, ...(headers ? { headers } : {}) }),
        );
    const command = {
        id: 'cmd_00000000-0000-4000-8000-000000000001',
        deviceSessionId: JF,
        type: 'playback.pause',
        args: {},
        delivery: 'live',
        source: 'app',
        sender: { username: 'alice' },
        status: 'applied',
        createdAt: '2026-10-16T20:00:00.000Z',
        updatedAt: '2026-10-16T20:00:00.000Z',
        expiresAt: '2026-10-16T20:05:00.000Z',
    };

    it('goes to the provider, answers 202 with its command, never touches the Lumastra service', async () => {
        provider.send.mockResolvedValue({ ok: true, value: command });
        const res = await post();
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ command, replayed: false });
        expect(provider.send).toHaveBeenCalledWith(
            expect.objectContaining({
                id: JF,
                request: { type: 'playback.pause' },
                user: { userId: '00000000-0000-0000-0000-000000000001', username: 'alice' },
                sender: expect.objectContaining({ source: 'app' }),
            }),
        );
        expect(service.sendDeviceCommand).not.toHaveBeenCalled();
    });

    it('maps provider errors like device errors: unreachable 409, unsupported 409, unknown 404', async () => {
        for (const [kind, status] of [
            ['device_unreachable', 409],
            ['device_unsupported', 409],
            ['not_found', 404],
        ] as const) {
            provider.send.mockResolvedValueOnce({ ok: false, error: { kind, message: kind } });
            const res = await post();
            expect(res.status).toBe(status);
            if (status === 409) {
                expect(((await res.json()) as { details?: string }).details).toBe(kind);
            }
        }
    });

    it('runs the type checks of the caller (Live TV, simple mode) through the provider', async () => {
        provider.send.mockResolvedValue({ ok: true, value: command });
        await post();
        expect(deviceCommandChecks).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: '00000000-0000-0000-0000-000000000001',
                hasLiveTvPermission: true,
            }),
        );
        expect(provider.send.mock.calls[0][0]).toHaveProperty('checks');
    });

    it('turns a provider that throws into 503 instead of a crash', async () => {
        provider.send.mockRejectedValueOnce(new Error('valkey exploded'));
        expect((await post()).status).toBe(503);
    });

    describe('Idempotency-Key', () => {
        const commit = vi.fn(async () => {});
        const release = vi.fn(async () => {});
        const begin = vi.mocked(service.beginIdempotentSend);

        it('claims the key, sends once and keeps the answer for a repeat', async () => {
            commit.mockClear();
            release.mockClear();
            begin.mockResolvedValueOnce({ ok: true, value: { claim: { commit, release } } });
            provider.send.mockResolvedValue({ ok: true, value: command });
            const res = await post(undefined, { 'Idempotency-Key': 'tap-1' });
            expect(res.status).toBe(202);
            expect(begin).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: '00000000-0000-0000-0000-000000000001',
                    key: 'tap-1',
                    deviceSessionId: JF,
                    request: { type: 'playback.pause' },
                }),
            );
            expect(commit).toHaveBeenCalledWith(command);
            expect(release).not.toHaveBeenCalled();
        });

        it('a repeat answers 200 with the first command and sends nothing', async () => {
            begin.mockResolvedValueOnce({
                ok: true,
                value: { replay: { command: command as never, replayed: true } },
            });
            const res = await post(undefined, { 'Idempotency-Key': 'tap-1' });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ command, replayed: true });
            expect(provider.send).not.toHaveBeenCalled();
        });

        it('the same key for a different request is a conflict', async () => {
            begin.mockResolvedValueOnce({
                ok: false,
                error: { kind: 'conflict', message: 'different command' },
            });
            expect((await post(undefined, { 'Idempotency-Key': 'tap-1' })).status).toBe(409);
            expect(provider.send).not.toHaveBeenCalled();
        });

        it('a failed send frees the key; a throwing provider too', async () => {
            release.mockClear();
            commit.mockClear();
            begin.mockResolvedValue({ ok: true, value: { claim: { commit, release } } });
            provider.send.mockResolvedValueOnce({
                ok: false,
                error: { kind: 'device_unreachable', message: 'x' },
            });
            expect((await post(undefined, { 'Idempotency-Key': 'tap-2' })).status).toBe(409);
            provider.send.mockRejectedValueOnce(new Error('boom'));
            expect((await post(undefined, { 'Idempotency-Key': 'tap-3' })).status).toBe(503);
            expect(release).toHaveBeenCalledTimes(2);
            expect(commit).not.toHaveBeenCalled();
            begin.mockReset();
        });

        it('rejects a malformed key before anything else; without a key nothing is claimed', async () => {
            expect((await post(undefined, { 'Idempotency-Key': 'bad key!' })).status).toBe(422);
            expect(begin).not.toHaveBeenCalled();
            provider.send.mockResolvedValue({ ok: true, value: command });
            await post();
            expect(begin).not.toHaveBeenCalled();
        });
    });

    it('a jf: command is final on POST: it cannot be read or cancelled afterwards (404)', async () => {
        const { GET, DELETE } = mount(commandDef, CTX);
        const ev = (method: string) =>
            event({
                params: { id: JF, commandId: 'cmd_00000000-0000-4000-8000-000000000001' },
                method,
            });
        expect((await GET!(ev('GET'))).status).toBe(404);
        expect((await DELETE!(ev('DELETE'))).status).toBe(404);
        expect(service.getDeviceCommand).not.toHaveBeenCalled();
        expect(service.cancelDeviceCommand).not.toHaveBeenCalled();
    });

    it('still validates the body before the provider sees it', async () => {
        expect((await post({ type: 'tv.explode' })).status).toBe(422);
        expect(provider.send).not.toHaveBeenCalled();
    });
});

describe('GET /devices/{id}/state for a jf: id', () => {
    it('answers the provider’s state, 404 when it has none', async () => {
        provider.state.mockResolvedValueOnce({
            deviceSessionId: JF,
            deviceName: 'Pixel',
            deviceType: 'mobile',
            online: true,
            lastSeen: '2026-10-16T12:00:00.000Z',
            reachable: true,
            capabilities: { commands: { 'playback.pause': {} } },
            nowPlaying: null,
            textInput: null,
            party: null,
            revision: 5,
        });
        const ok = await mount(stateDef, CTX).GET!(event({ params: { id: JF } }));
        expect(ok.status).toBe(200);
        expect(await ok.json()).toMatchObject({ deviceSessionId: JF });
        provider.state.mockResolvedValueOnce(null);
        expect((await mount(stateDef, CTX).GET!(event({ params: { id: JF } }))).status).toBe(404);
        expect(service.buildDeviceState).not.toHaveBeenCalled();
    });
});
