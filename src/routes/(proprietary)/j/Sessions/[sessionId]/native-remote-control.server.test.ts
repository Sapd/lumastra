// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route tests for /j/Sessions/{sessionId}/… addressed to a NATIVE Lumastra
 * device: each Jellyfin route translates to a registry command through
 * sendDeviceCommand, with the right sender, and unknown / foreign sessions
 * stay 404.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: unknown) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/connection.js', async (orig) => ({
    ...(await orig<typeof import('$lib/server/database/connection.js')>()),
    getDb: () => ({}),
}));
// Exercise the real Live TV policy with the target owner's stored permission.
vi.mock('$lib/server/database/queries/users.queries.js', async (orig) => ({
    ...(await orig<typeof import('$lib/server/database/queries/users.queries.js')>()),
    getUserLiveTvAllowed: vi.fn(async (_sql: unknown, username: string) =>
        Object.values(users).some((user) => user.username === username && user.allow_live_tv),
    ),
}));
vi.mock('$lib/server/config.js', async (orig) => {
    const actual = await orig<typeof import('$lib/server/config.js')>();
    return { ...actual, config: { ...actual.config, FEATURE_LIVETV: true } };
});
vi.mock('$lib/server/proprietary/jellyfin-compat/remote-control/device-registry', async (orig) => {
    const actual =
        await orig<
            typeof import('$lib/server/proprietary/jellyfin-compat/remote-control/device-registry')
        >();
    return { ...actual, getDevice: vi.fn(async () => null) };
});
vi.mock('$lib/server/database/queries/play-sessions.queries', () => ({
    getSessionById: vi.fn(async () => null),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/remote-control/fanout', () => ({
    sendToSession: vi.fn(async () => 1),
    ensureFanoutSubscription: vi.fn(async () => true),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/remote-control/commands', async (orig) => {
    const actual =
        await orig<
            typeof import('$lib/server/proprietary/jellyfin-compat/remote-control/commands')
        >();
    return { ...actual, canSeeItem: vi.fn(async () => true) };
});
vi.mock('$lib/server/database/queries/media-type-cache.queries.js', () => ({
    getMediaType: vi.fn(async () => 'movie'),
}));
vi.mock('$lib/server/services/device-commands.service.js', () => ({
    sendDeviceCommand: vi.fn(async () => ({ ok: true, value: { command: {}, replayed: false } })),
    buildDeviceState: vi.fn(),
}));
vi.mock('$lib/server/services/device-command-checks.js', () => ({
    deviceCommandChecks: vi.fn(() => ({})),
}));

const natives = new Map<string, { owner: string; username: string }>();
vi.mock('$lib/server/proprietary/jellyfin-compat/remote-control/native-devices', async (orig) => {
    const actual =
        await orig<
            typeof import('$lib/server/proprietary/jellyfin-compat/remote-control/native-devices')
        >();
    return {
        ...actual,
        resolveNativeTarget: vi.fn(
            async (
                _sql: unknown,
                id: string,
                caller: { userId: string; ownerIsAdmin: boolean },
            ) => {
                const n = natives.get(id);
                if (!n) return null;
                if (!caller.ownerIsAdmin && n.owner !== caller.userId) return null;
                return {
                    deviceSessionId: '99999999-9999-4999-8999-999999999999',
                    ownerUserId: n.owner,
                    ownerUsername: n.username,
                    ownerDisplayName: null,
                    deviceId: 'atv',
                    deviceName: 'TV',
                };
            },
        ),
    };
});

const service = await import('$lib/server/services/device-commands.service.js');
const { POST: playPost } = await import('./Playing/+server.js');
const { POST: playstatePost } = await import('./Playing/[command]/+server.js');
const { POST: commandPost } = await import('./Command/+server.js');
const { POST: namedCommandPost } = await import('./Command/[command]/+server.js');
const { POST: messagePost } = await import('./Message/+server.js');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const SESSION = '99999999999949998999999999999999';
const ITEM = 'aaaaaaaabbbb4ccc8dddeeeeeeeeeeee';

const users = {
    alice: { userId: ALICE, username: 'alice', ownerIsAdmin: false, allow_live_tv: true },
    bob: { userId: BOB, username: 'bob', ownerIsAdmin: false, allow_live_tv: false },
    admin: { userId: ADMIN, username: 'root', ownerIsAdmin: true, allow_live_tv: true },
    quickConnectAdmin: { userId: ADMIN, username: 'root', ownerIsAdmin: true, allow_live_tv: true },
};

function ev(
    as: keyof typeof users,
    path: string,
    params: Record<string, string>,
    body?: unknown,
): never {
    const url = new URL(`https://app.example/j/Sessions/${SESSION}${path}`);
    return {
        request: new Request(url, {
            method: 'POST',
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
        url,
        params: { sessionId: SESSION, ...params },
        locals: {
            user: users[as],
            principal: { isAdmin: as === 'admin' },
            jfDevice: { deviceName: 'Findroid' },
        },
    } as never;
}

const sent = () => vi.mocked(service.sendDeviceCommand).mock.calls.map((c) => c[0]);

beforeEach(() => {
    vi.clearAllMocks();
    natives.clear();
    natives.set(SESSION, { owner: ALICE, username: 'alice' });
});

describe('/Sessions/{id}/Playing/{command} on a native device', () => {
    it('Pause becomes playback.pause from the Jellyfin caller', async () => {
        const res = await playstatePost(ev('alice', '/Playing/Pause', { command: 'Pause' }));
        expect(res.status).toBe(204);
        expect(sent()[0]).toMatchObject({
            request: { type: 'playback.pause' },
            ownerUserId: ALICE,
            sender: { userId: ALICE, source: 'app' },
        });
    });

    it('Seek needs seekPositionTicks; 404 for a foreign or unknown session', async () => {
        const bad = ev('alice', '/Playing/Seek', { command: 'Seek' });
        expect((await playstatePost(bad)).status).toBe(400);
        expect(
            (await playstatePost(ev('bob', '/Playing/Pause', { command: 'Pause' }))).status,
        ).toBe(404);
        natives.clear();
        expect(
            (await playstatePost(ev('alice', '/Playing/Pause', { command: 'Pause' }))).status,
        ).toBe(404);
        expect(service.sendDeviceCommand).not.toHaveBeenCalled();
    });

    it('an admin may stop another user’s device but not pause it', async () => {
        expect(
            (await playstatePost(ev('admin', '/Playing/Stop', { command: 'Stop' }))).status,
        ).toBe(204);
        expect(sent()[0].sender.admin).toBe(true);
        expect(
            (await playstatePost(ev('admin', '/Playing/Pause', { command: 'Pause' }))).status,
        ).toBe(403);
        expect(sent()).toHaveLength(1);
    });
});

describe('/Sessions/{id}/Playing (Play) on a native device', () => {
    it('plays the item with the start position', async () => {
        const e = ev('alice', '/Playing', {});
        (e as { url: URL }).url.search =
            `?playCommand=PlayNow&itemIds=${ITEM}&startPositionTicks=300000000`;
        const res = await playPost(e);
        expect(res.status).toBe(204);
        expect(sent()[0].request).toMatchObject({
            type: 'media.play',
            args: { kind: 'movie', mode: 'play', startSeconds: 30 },
        });
    });

    it('still validates playCommand and itemIds with 400', async () => {
        const e = ev('alice', '/Playing', {});
        (e as { url: URL }).url.search = `?playCommand=Nope&itemIds=${ITEM}`;
        expect((await playPost(e)).status).toBe(400);
    });
});

describe('/Sessions/{id}/Command, /Command/{name} and /Message on a native device', () => {
    it('SetSubtitleStreamIndex -1 switches subtitles off', async () => {
        const res = await commandPost(
            ev(
                'alice',
                '/Command',
                {},
                { Name: 'SetSubtitleStreamIndex', Arguments: { Index: '-1' } },
            ),
        );
        expect(res.status).toBe(204);
        expect(sent()[0].request).toEqual({
            type: 'playback.setSubtitleTrack',
            args: { index: -1 },
        });
    });

    it('/Command/{name}: ChannelUp works, VolumeUp is 400 device_unsupported', async () => {
        expect(
            (await namedCommandPost(ev('alice', '/Command/ChannelUp', { command: 'ChannelUp' })))
                .status,
        ).toBe(204);
        expect(sent()[0].request.type).toBe('livetv.channelUp');
        const vol = await namedCommandPost(
            ev('alice', '/Command/VolumeUp', { command: 'VolumeUp' }),
        );
        expect(vol.status).toBe(400);
        expect(await vol.json()).toMatchObject({ details: 'device_unsupported' });
    });

    it.each(['ChannelUp', 'ChannelDown'])(
        '%s returns 404 for an owner denied Live TV on both command routes',
        async (command) => {
            natives.set(SESSION, { owner: BOB, username: 'bob' });
            // Positive ownership control: the denial must come from Live TV policy.
            expect(
                (await playstatePost(ev('bob', '/Playing/Pause', { command: 'Pause' }))).status,
            ).toBe(204);
            vi.mocked(service.sendDeviceCommand).mockClear();
            expect(
                (await namedCommandPost(ev('bob', `/Command/${command}`, { command }))).status,
            ).toBe(404);
            expect((await commandPost(ev('bob', '/Command', {}, { Name: command }))).status).toBe(
                404,
            );
            expect(service.sendDeviceCommand).not.toHaveBeenCalled();
        },
    );

    it('/Message becomes ui.message; an admin may send it to someone else’s device', async () => {
        const body = { Header: 'Hi', Text: 'Dinner' };
        expect((await messagePost(ev('alice', '/Message', {}, body))).status).toBe(204);
        expect((await messagePost(ev('admin', '/Message', {}, body))).status).toBe(204);
        expect(sent().map((s) => [s.request.type, s.sender.admin])).toEqual([
            ['ui.message', undefined],
            ['ui.message', true],
        ]);
        expect(sent()[0].request.args).toEqual({ text: 'Hi\nDinner' });
    });

    it('a device that does not announce the command is 400 device_unsupported', async () => {
        vi.mocked(service.sendDeviceCommand).mockResolvedValueOnce({
            ok: false,
            error: { kind: 'device_unsupported', message: 'no' },
        });
        const res = await messagePost(ev('alice', '/Message', {}, { Text: 'x' }));
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ details: 'device_unsupported' });
    });
});

it('a Quick Connect admin cannot control another owner native device', async () => {
    expect(
        (await messagePost(ev('quickConnectAdmin', '/Message', {}, { Text: 'foreign' }))).status,
    ).toBe(404);
    expect(sent()).toEqual([]);
    natives.set(SESSION, { owner: ADMIN, username: 'root' });
    expect(
        (await messagePost(ev('quickConnectAdmin', '/Message', {}, { Text: 'own' }))).status,
    ).toBe(204);
});
