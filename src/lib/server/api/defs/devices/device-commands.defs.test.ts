// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The device remote-control defs: who may call what, what the sender looks like,
 * and how service errors come out. The service itself is covered by
 * device-commands.service.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/auth/livetv-user-policy.js', async (original) => ({
    ...(await original<typeof import('$lib/server/auth/livetv-user-policy.js')>()),
    userAllowsLiveTv: vi.fn(async () => true),
}));
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

const ALICE = '00000000-0000-0000-0000-000000000001';
const GRANDMA = '00000000-0000-0000-0000-000000000002';

/** Rows the device-access query answers with (the caller's own device by default). */
const ownDevice = [{ device_name: 'Living Room', owner_id: ALICE, username: 'alice', own: true }];
const owned = { rows: ownDevice as unknown[] };
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => () => Promise.resolve(owned.rows)),
}));

vi.mock('$lib/server/oauth/device-session-liveness.js', () => ({
    isDeviceSessionTombstoned: vi.fn(() => false),
    onDeviceSessionsRevoked: vi.fn(),
}));

vi.mock('$lib/server/services/device-presence.service.js', () => ({
    getHeartbeat: vi.fn().mockResolvedValue({ deviceName: "Alice's iPhone" }),
}));
vi.mock('$lib/server/services/device-command-checks.js', () => ({
    deviceCommandChecks: vi.fn(() => ({})),
}));
import { deviceCommandChecks } from '$lib/server/services/device-command-checks.js';
vi.mock('$lib/server/services/device-state-projection.js', () => ({
    projectNowPlaying: vi.fn().mockResolvedValue(null),
}));

const command = {
    id: 'cmd_00000000-0000-4000-8000-000000000001',
    deviceSessionId: 'tv-1',
    type: 'playback.pause',
    args: {},
    delivery: 'live',
    source: 'app',
    sender: { username: 'alice' },
    status: 'pending',
    createdAt: '2026-10-16T20:00:00.000Z',
    updatedAt: '2026-10-16T20:00:00.000Z',
    expiresAt: '2026-10-16T20:00:15.000Z',
};
vi.mock('$lib/server/services/device-commands.service.js', () => ({
    sendDeviceCommand: vi.fn(),
    listDeviceInbox: vi.fn(),
    getDeviceCommand: vi.fn(),
    cancelDeviceCommand: vi.fn(),
    reportDeviceCommandResult: vi.fn(),
    buildDeviceState: vi.fn(),
    reportDeviceState: vi.fn(),
}));

import { mount } from '$lib/server/api/mount.js';
import { def as commandsDef } from './[id]/commands/index.js';
import { def as commandDef } from './[id]/commands/[commandId]/index.js';
import { def as resultDef } from './[id]/commands/[commandId]/result.js';
import { def as stateDef } from './[id]/state.js';
import * as service from '$lib/server/services/device-commands.service.js';

const CTX = { surface: 'v1' as const };
const CMD_ID = command.id;

function makeEvent(opts: {
    params: Record<string, string>;
    method?: string;
    body?: unknown;
    deviceSessionId?: string;
    authMethod?: string;
    headers?: Record<string, string>;
}): RequestEvent {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    const url = 'http://localhost/api/v1/devices/x';
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
        params: opts.params,
        route: { id: '/api/v1/devices/[id]/commands' as const },
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
            deviceSessionId: opts.deviceSessionId,
            authMethod: opts.authMethod ?? 'bearer',
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
    owned.rows = ownDevice;
    vi.mocked(service.sendDeviceCommand).mockResolvedValue({
        ok: true,
        value: { command: command as never, replayed: false },
    });
    vi.mocked(service.reportDeviceState).mockResolvedValue({ ok: true, value: {} as never });
});

describe('POST /devices/{id}/commands', () => {
    const post = (extra: Partial<Parameters<typeof makeEvent>[0]> = {}) =>
        mount(commandsDef, CTX).POST!(
            makeEvent({
                params: { id: 'tv-1' },
                method: 'POST',
                body: { type: 'playback.pause' },
                deviceSessionId: 'phone-1',
                ...extra,
            }),
        );

    it('sends for the owner and answers 202 with the command', async () => {
        const res = await post();
        expect(res.status).toBe(202);
        expect(service.sendDeviceCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                deviceSessionId: 'tv-1',
                ownerUserId: '00000000-0000-0000-0000-000000000001',
                request: { type: 'playback.pause' },
                sender: expect.objectContaining({
                    source: 'app',
                    deviceSessionId: 'phone-1',
                    deviceName: "Alice's iPhone",
                }),
            }),
        );
    });

    it('marks a PAT caller as automation', async () => {
        await post({ authMethod: 'pat', deviceSessionId: undefined });
        expect(vi.mocked(service.sendDeviceCommand).mock.calls[0][0].sender.source).toBe(
            'automation',
        );
    });

    it('answers 404 for a device that is not yours', async () => {
        owned.rows = [];
        const res = await post();
        expect(res.status).toBe(404);
        expect(service.sendDeviceCommand).not.toHaveBeenCalled();
    });

    it('rejects an unknown type and strict args with 422', async () => {
        expect((await post({ body: { type: 'tv.explode' } })).status).toBe(422);
        expect(
            (await post({ body: { type: 'playback.seekBy', args: { seconds: 10, extra: 1 } } }))
                .status,
        ).toBe(422);
        expect(service.sendDeviceCommand).not.toHaveBeenCalled();
    });

    it('validates the Idempotency-Key header and passes it on', async () => {
        expect((await post({ headers: { 'Idempotency-Key': 'bad key!' } })).status).toBe(422);
        await post({ headers: { 'Idempotency-Key': 'tap-42' } });
        expect(vi.mocked(service.sendDeviceCommand).mock.calls[0][0].idempotencyKey).toBe('tap-42');
    });

    it('maps service errors to problem details', async () => {
        const cases: [string, number][] = [
            ['device_unsupported', 409],
            ['device_unreachable', 409],
            ['stale_target', 409],
            ['simple_mode_locked', 403],
            ['rate_limited', 429],
        ];
        for (const [kind, status] of cases) {
            vi.mocked(service.sendDeviceCommand).mockResolvedValueOnce({
                ok: false,
                error: { kind: kind as never, message: kind },
            });
            const res = await post();
            expect(res.status).toBe(status);
            if (status !== 429) {
                expect(((await res.json()) as { details?: string }).details).toBe(kind);
            }
        }
    });

    it('an Idempotency-Key repeat answers 200', async () => {
        vi.mocked(service.sendDeviceCommand).mockResolvedValueOnce({
            ok: true,
            value: { command: command as never, replayed: true },
        });
        expect((await post()).status).toBe(200);
    });
});

describe('device-only routes', () => {
    it('only the device itself reads its inbox', async () => {
        vi.mocked(service.listDeviceInbox).mockResolvedValue({ ok: true, value: [] });
        const { GET } = mount(commandsDef, CTX);
        expect(
            (await GET!(makeEvent({ params: { id: 'tv-1' }, deviceSessionId: 'phone-1' }))).status,
        ).toBe(403);
        expect(
            (await GET!(makeEvent({ params: { id: 'tv-1' }, deviceSessionId: 'tv-1' }))).status,
        ).toBe(200);
    });

    it('only the target device reports a result', async () => {
        vi.mocked(service.reportDeviceCommandResult).mockResolvedValue({
            ok: true,
            value: command as never,
        });
        const { POST } = mount(resultDef, CTX);
        const call = (deviceSessionId: string) =>
            POST!(
                makeEvent({
                    params: { id: 'tv-1', commandId: CMD_ID },
                    method: 'POST',
                    body: { status: 'applied' },
                    deviceSessionId,
                }),
            );
        expect((await call('phone-1')).status).toBe(403);
        expect((await call('tv-1')).status).toBe(200);
        expect(service.reportDeviceCommandResult).toHaveBeenCalledWith('tv-1', CMD_ID, {
            status: 'applied',
        });
    });

    it('only the device itself reports its state', async () => {
        const { PUT } = mount(stateDef, CTX);
        const call = (deviceSessionId: string) =>
            PUT!(
                makeEvent({
                    params: { id: 'tv-1' },
                    method: 'PUT',
                    body: { nowPlaying: null },
                    deviceSessionId,
                }),
            );
        expect((await call('phone-1')).status).toBe(403);
        expect((await call('tv-1')).status).toBe(204);
    });
});

describe('owner routes', () => {
    it('reads and cancels a command; foreign devices are 404', async () => {
        vi.mocked(service.getDeviceCommand).mockResolvedValue({
            ok: true,
            value: command as never,
        });
        vi.mocked(service.cancelDeviceCommand).mockResolvedValue({
            ok: true,
            value: { ...command, status: 'cancelled' } as never,
        });
        const { GET, DELETE } = mount(commandDef, CTX);
        const ev = (method = 'GET') =>
            makeEvent({
                params: { id: 'tv-1', commandId: CMD_ID },
                method,
                deviceSessionId: 'phone-1',
            });
        expect((await GET!(ev())).status).toBe(200);
        expect((await DELETE!(ev('DELETE'))).status).toBe(200);
        owned.rows = [];
        expect((await GET!(ev())).status).toBe(404);
    });

    it('reads the device state', async () => {
        vi.mocked(service.buildDeviceState).mockResolvedValue({
            deviceSessionId: 'tv-1',
            deviceName: 'Living Room',
            deviceType: 'tv',
            online: true,
            lastSeen: null,
            reachable: true,
            capabilities: { commands: {} },
            nowPlaying: null,
            textInput: null,
            party: null,
            revision: 1,
        });
        const { GET } = mount(stateDef, CTX);
        const res = await GET!(makeEvent({ params: { id: 'tv-1' }, deviceSessionId: 'phone-1' }));
        expect(res.status).toBe(200);
        expect(((await res.json()) as { deviceName: string }).deviceName).toBe('Living Room');
    });
});

describe('device-only routes need the device itself', () => {
    it('refuses a stream token or a revoked session that carries the same device session id', async () => {
        vi.mocked(service.listDeviceInbox).mockResolvedValue({ ok: true, value: [] });
        const { GET } = mount(commandsDef, CTX);
        const { PUT } = mount(stateDef, CTX);
        expect(
            (
                await GET!(
                    makeEvent({
                        params: { id: 'tv-1' },
                        deviceSessionId: 'tv-1',
                        authMethod: 'stream_token',
                    }),
                )
            ).status,
        ).not.toBe(200);
        expect(
            (
                await PUT!(
                    makeEvent({
                        params: { id: 'tv-1' },
                        method: 'PUT',
                        body: { nowPlaying: null },
                        deviceSessionId: 'tv-1',
                        authMethod: 'stream_token',
                    }),
                )
            ).status,
        ).not.toBe(204);
        const liveness = await import('$lib/server/oauth/device-session-liveness.js');
        vi.mocked(liveness.isDeviceSessionTombstoned).mockReturnValueOnce(true);
        expect(
            (await GET!(makeEvent({ params: { id: 'tv-1' }, deviceSessionId: 'tv-1' }))).status,
        ).toBe(403);
    });

    it('answers 429 when the device reports state too often', async () => {
        vi.mocked(service.reportDeviceState).mockResolvedValueOnce({
            ok: false,
            error: { kind: 'rate_limited', message: 'Too many', retryAfter: 3 },
        });
        const { PUT } = mount(stateDef, CTX);
        const res = await PUT!(
            makeEvent({
                params: { id: 'tv-1' },
                method: 'PUT',
                body: { nowPlaying: null },
                deviceSessionId: 'tv-1',
            }),
        );
        expect(res.status).toBe(429);
    });
});

describe('household grant: a granted helper', () => {
    // The access query only returns a foreign device when a grant exists, so
    // "granted" = the row comes back with own: false, "revoked" = no row.
    const grandmasTv = [
        { device_name: "Grandma's TV", owner_id: GRANDMA, username: 'grandma', own: false },
    ];

    it('sends to the owner device with the owner as owner and the helper as sender', async () => {
        owned.rows = grandmasTv;
        const res = await mount(commandsDef, CTX).POST!(
            makeEvent({
                params: { id: 'tv-1' },
                method: 'POST',
                body: { type: 'livetv.channelUp' },
                deviceSessionId: 'phone-1',
            }),
        );
        expect(res.status).toBe(202);
        expect(service.sendDeviceCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                deviceSessionId: 'tv-1',
                ownerUserId: GRANDMA,
                sender: expect.objectContaining({ userId: ALICE, username: 'alice' }),
            }),
        );
        // The simple-mode lock is read from the owner, not the helper.
        expect(deviceCommandChecks).toHaveBeenCalledWith(
            expect.objectContaining({ userId: ALICE, ownerUserId: GRANDMA }),
        );
    });

    it('reads a command, cancels it and reads the state, projecting the owner', async () => {
        owned.rows = grandmasTv;
        vi.mocked(service.getDeviceCommand).mockResolvedValue({
            ok: true,
            value: command as never,
        });
        vi.mocked(service.cancelDeviceCommand).mockResolvedValue({
            ok: true,
            value: { ...command, status: 'cancelled' } as never,
        });
        vi.mocked(service.buildDeviceState).mockResolvedValue({
            deviceSessionId: 'tv-1',
            deviceName: "Grandma's TV",
            deviceType: 'tv',
            online: true,
            lastSeen: null,
            reachable: true,
            capabilities: { commands: {} },
            nowPlaying: null,
            textInput: null,
            party: null,
            revision: 1,
        });
        const ev = (method = 'GET') =>
            makeEvent({
                params: { id: 'tv-1', commandId: CMD_ID },
                method,
                deviceSessionId: 'phone-1',
            });
        const { GET, DELETE } = mount(commandDef, CTX);
        expect((await GET!(ev())).status).toBe(200);
        expect((await DELETE!(ev('DELETE'))).status).toBe(200);
        const state = await mount(stateDef, CTX).GET!(
            makeEvent({ params: { id: 'tv-1' }, deviceSessionId: 'phone-1' }),
        );
        expect(state.status).toBe(200);
        expect(service.buildDeviceState).toHaveBeenCalledWith(
            'tv-1',
            expect.objectContaining({ deviceName: "Grandma's TV" }),
        );
    });

    it('reads and cancels only the commands the helper sent; the owner and the device see all', async () => {
        vi.mocked(service.getDeviceCommand).mockResolvedValue({
            ok: true,
            value: command as never,
        });
        vi.mocked(service.cancelDeviceCommand).mockResolvedValue({
            ok: true,
            value: { ...command, status: 'cancelled' } as never,
        });
        const ev = (method: string, deviceSessionId: string) =>
            makeEvent({ params: { id: 'tv-1', commandId: CMD_ID }, method, deviceSessionId });
        const { GET, DELETE } = mount(commandDef, CTX);

        owned.rows = grandmasTv; // alice is the helper
        await GET!(ev('GET', 'phone-1'));
        await DELETE!(ev('DELETE', 'phone-1'));
        expect(service.getDeviceCommand).toHaveBeenLastCalledWith('tv-1', CMD_ID, {
            onlySenderUserId: ALICE,
        });
        expect(service.cancelDeviceCommand).toHaveBeenLastCalledWith('tv-1', CMD_ID, {
            onlySenderUserId: ALICE,
        });

        owned.rows = ownDevice; // alice owns the device: everything
        await GET!(ev('GET', 'phone-1'));
        expect(service.getDeviceCommand).toHaveBeenLastCalledWith('tv-1', CMD_ID, {});

        // The device itself reads its own commands without the sender filter.
        await GET!(ev('GET', 'tv-1'));
        expect(service.getDeviceCommand).toHaveBeenLastCalledWith('tv-1', CMD_ID, {});
    });

    it('a command somebody else sent answers 404 like an unknown one', async () => {
        owned.rows = grandmasTv;
        vi.mocked(service.getDeviceCommand).mockResolvedValue({
            ok: false,
            error: { kind: 'not_found', message: 'Unknown command' },
        });
        const res = await mount(commandDef, CTX).GET!(
            makeEvent({
                params: { id: 'tv-1', commandId: CMD_ID },
                deviceSessionId: 'phone-1',
            }),
        );
        expect(res.status).toBe(404);
    });

    it('is refused with 404 once the grant is gone, and for an ungranted device', async () => {
        const post = () =>
            mount(commandsDef, CTX).POST!(
                makeEvent({
                    params: { id: 'tv-1' },
                    method: 'POST',
                    body: { type: 'playback.pause' },
                    deviceSessionId: 'phone-1',
                }),
            );
        owned.rows = grandmasTv;
        expect((await post()).status).toBe(202);
        owned.rows = []; // revoked: the next request already sees it
        expect((await post()).status).toBe(404);
        expect(service.sendDeviceCommand).toHaveBeenCalledTimes(1);
        expect(
            (
                await mount(stateDef, CTX).GET!(
                    makeEvent({ params: { id: 'tv-1' }, deviceSessionId: 'phone-1' }),
                )
            ).status,
        ).toBe(404);
    });

    it('does not reach the device-only routes', async () => {
        owned.rows = grandmasTv;
        expect(
            (
                await mount(commandsDef, CTX).GET!(
                    makeEvent({ params: { id: 'tv-1' }, deviceSessionId: 'phone-1' }),
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await mount(stateDef, CTX).PUT!(
                    makeEvent({
                        params: { id: 'tv-1' },
                        method: 'PUT',
                        body: { nowPlaying: null },
                        deviceSessionId: 'phone-1',
                    }),
                )
            ).status,
        ).toBe(403);
    });
});

it('does not return a cached own-device Live TV title or logo after the switch is off', async () => {
    const { userAllowsLiveTv } = await import('$lib/server/auth/livetv-user-policy.js');
    vi.mocked(userAllowsLiveTv).mockResolvedValueOnce(false);
    vi.mocked(service.buildDeviceState).mockResolvedValue({
        deviceSessionId: 'tv-1',
        deviceName: 'TV',
        deviceType: 'tv',
        online: true,
        lastSeen: null,
        reachable: true,
        capabilities: { commands: {} },
        textInput: null,
        party: null,
        revision: 1,
        nowPlaying: {
            kind: 'livetv',
            sessionId: 'live',
            title: 'Secret channel',
            paused: false,
            rate: 1,
            reported: true,
            availableCommands: [],
            livetv: { stationId: 'station', feedId: 'feed', name: 'Secret channel', images: {} },
        },
    });
    const response = await mount(stateDef, CTX).GET!(
        makeEvent({ params: { id: 'tv-1' }, deviceSessionId: 'phone-1' }),
    );
    const body = await response.json();
    expect(body.nowPlaying).toBeNull();
    expect(JSON.stringify(body)).not.toContain('Secret channel');
});
