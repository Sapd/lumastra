// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native Lumastra devices as Jellyfin sessions: lookup and ownership, the
 * session list entry, and the commands that go through `sendDeviceCommand`
 * (sender, admin rules, error answers).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserContext } from '$lib/server/types';
import type { DeviceCommandError } from '$lib/server/services/device-commands.service';

const h = vi.hoisted(() => ({
    rows: [] as unknown[],
    sqlThrows: false,
    heartbeats: new Map<string, unknown>(),
    hidden: new Set<string>(),
    mediaTypes: new Map<string, string>(),
}));

vi.mock('$lib/server/services/device-commands.service.js', () => ({
    sendDeviceCommand: vi.fn(),
    buildDeviceState: vi.fn(),
}));
vi.mock('$lib/server/services/device-command-checks.js', () => ({
    deviceCommandChecks: vi.fn(() => ({ check: vi.fn() })),
}));
vi.mock('$lib/server/services/device-presence.service.js', () => ({
    getHeartbeat: vi.fn(async (id: string) => h.heartbeats.get(id) ?? null),
    getHeartbeats: vi.fn(async (ids: string[]) => {
        const out = new Map<string, unknown>();
        for (const id of ids) if (h.heartbeats.has(id)) out.set(id, h.heartbeats.get(id));
        return out;
    }),
}));
vi.mock('$lib/server/database/queries/media-type-cache.queries.js', () => ({
    getMediaType: vi.fn(async (_sql: unknown, id: string) => h.mediaTypes.get(id) ?? null),
}));
vi.mock('./commands', () => ({
    canSeeItem: vi.fn(async (_sql: unknown, id: string, user: { userId: string }) => {
        return !h.hidden.has(`${user.userId}:${id}`) && !h.hidden.has(`*:${id}`);
    }),
}));

const service = await import('$lib/server/services/device-commands.service.js');
const checks = await import('$lib/server/services/device-command-checks.js');
const {
    listNativeDevices,
    nativeGeneralCommand,
    nativePlay,
    nativePlaystate,
    nativeErrorResponse,
    resolveNativeTarget,
    serializeNativeSession,
} = await import('./native-devices');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const TV = '99999999-9999-4999-8999-999999999999';
const TV_HEX = TV.replace(/-/g, '');
const ITEM = 'aaaaaaaabbbb4ccc8dddeeeeeeeeeeee';
const ITEM_DASHED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const sql = vi.fn(async () => {
    if (h.sqlThrows) throw new Error('db down');
    return h.rows;
}) as unknown as import('postgres').Sql;

const tokenRow = (userId: string, username: string, session = TV) => ({
    device_session_id: session,
    user_id: userId,
    username,
    display_name: null,
    device_id: 'tv-device',
    device_name: 'Living Room',
});

const user = (userId: string, username: string, ownerIsAdmin = false) =>
    ({
        userId,
        username,
        ownerIsAdmin,
        hasLiveTvPermission: true,
    }) as unknown as UserContext;

const alice = user(ALICE, 'alice');
const bob = user(BOB, 'bob');
const admin = user(ADMIN, 'root', true);

const caps = (...commands: string[]) => ({
    commands: Object.fromEntries(commands.map((c) => [c, {}])),
});
const heartbeat = (...commands: string[]) => ({
    deviceName: 'Living Room',
    deviceType: 'tv',
    capabilities: caps(...commands),
    lastSeen: Date.now(),
});

const locals = { jfDevice: { deviceName: 'Findroid on Pixel' } } as never;
const ctxFor = (target: ReturnType<typeof tokenRow>, caller: UserContext) => ({
    sql,
    target: {
        deviceSessionId: target.device_session_id,
        ownerUserId: target.user_id,
        ownerUsername: target.username,
        ownerDisplayName: null,
        deviceId: target.device_id,
        deviceName: target.device_name,
    },
    caller,
    locals,
});

beforeEach(() => {
    vi.clearAllMocks();
    h.rows = [];
    h.sqlThrows = false;
    h.heartbeats.clear();
    h.hidden.clear();
    h.mediaTypes.clear();
    vi.mocked(service.sendDeviceCommand).mockResolvedValue({
        ok: true,
        value: { command: {} as never, replayed: false },
    });
});

const sent = () => vi.mocked(service.sendDeviceCommand).mock.calls.map((c) => c[0]);

describe('resolveNativeTarget', () => {
    it('resolves the owner, accepts hex and dashed ids, and an admin', async () => {
        h.rows = [tokenRow(ALICE, 'alice')];
        expect(await resolveNativeTarget(sql, TV_HEX, alice)).toMatchObject({
            deviceSessionId: TV,
            ownerUserId: ALICE,
        });
        expect(await resolveNativeTarget(sql, TV.toUpperCase(), alice)).not.toBeNull();
        expect(await resolveNativeTarget(sql, TV_HEX, admin)).not.toBeNull();
    });

    it('someone else’s device, an unknown or revoked one, a bad id and a DB error are all null', async () => {
        h.rows = [tokenRow(ALICE, 'alice')];
        expect(await resolveNativeTarget(sql, TV_HEX, bob)).toBeNull();
        h.rows = [];
        expect(await resolveNativeTarget(sql, TV_HEX, alice)).toBeNull();
        expect(await resolveNativeTarget(sql, 'not-an-id', alice)).toBeNull();
        h.rows = [tokenRow(ALICE, 'alice')];
        h.sqlThrows = true;
        expect(await resolveNativeTarget(sql, TV_HEX, alice)).toBeNull();
    });
});

describe('listNativeDevices / serializeNativeSession', () => {
    it('lists an online device with its commands and state, as a controllable session', async () => {
        h.rows = [tokenRow(ALICE, 'alice')];
        h.heartbeats.set(TV, heartbeat('playback.pause', 'ui.message', 'media.play'));
        vi.mocked(service.buildDeviceState).mockResolvedValue({
            deviceSessionId: TV,
            deviceName: 'Living Room',
            deviceType: 'tv',
            online: true,
            lastSeen: '2026-10-16T20:00:00.000Z',
            reachable: true,
            capabilities: caps('playback.pause'),
            nowPlaying: {
                kind: 'video',
                sessionId: 's',
                title: 'The Film',
                positionSeconds: 10,
                paused: true,
                rate: 1,
                availableCommands: [],
                video: {
                    itemId: ITEM_DASHED,
                    mediaType: 'movie',
                    audioTracks: [],
                    subtitleTracks: [],
                    segments: [],
                },
            },
            textInput: null,
            party: null,
            revision: 1,
        } as never);
        const views = await listNativeDevices(sql, { userId: alice.userId, ownerIsAdmin: false });
        expect(views).toHaveLength(1);
        const session = serializeNativeSession(views[0]);
        expect(session).toMatchObject({
            Id: TV_HEX,
            UserId: ALICE.replace(/-/g, ''),
            DeviceName: 'Living Room',
            DeviceId: 'tv-device',
            SupportsRemoteControl: true,
            SupportsMediaControl: true,
            PlayableMediaTypes: ['Video', 'Audio'],
            SupportedCommands: ['DisplayMessage', 'Play', 'PlayMediaSource', 'DisplayContent'],
            NowPlayingItem: { Name: 'The Film', Type: 'Movie' },
            PlayState: { IsPaused: true },
        });
    });

    it('skips a device with no heartbeat, or one that announces nothing', async () => {
        h.rows = [
            tokenRow(ALICE, 'alice'),
            tokenRow(ALICE, 'alice', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
        ];
        h.heartbeats.set('dddddddd-dddd-4ddd-8ddd-dddddddddddd', heartbeat());
        expect(await listNativeDevices(sql, { userId: alice.userId, ownerIsAdmin: false })).toEqual(
            [],
        );
    });

    it('an idle device lists without NowPlayingItem', async () => {
        h.rows = [tokenRow(ALICE, 'alice')];
        h.heartbeats.set(TV, heartbeat('playback.pause'));
        vi.mocked(service.buildDeviceState).mockResolvedValue({
            deviceSessionId: TV,
            deviceName: null,
            deviceType: 'tv',
            online: true,
            lastSeen: '2026-10-16T20:00:00.000Z',
            reachable: false,
            capabilities: caps('playback.pause'),
            nowPlaying: null,
            textInput: null,
            party: null,
            revision: 0,
        } as never);
        const [view] = await listNativeDevices(sql, { userId: alice.userId, ownerIsAdmin: false });
        const session = serializeNativeSession(view);
        expect(session).not.toHaveProperty('NowPlayingItem');
        expect(session.SupportsRemoteControl).toBe(true);
        expect(session.SupportedCommands).toEqual([]);
    });

    it('an administrator sees another user’s device with the admin commands only, their own in full', async () => {
        h.rows = [
            tokenRow(ALICE, 'alice'),
            tokenRow(ADMIN, 'root', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
        ];
        h.heartbeats.set(
            TV,
            heartbeat('playback.pause', 'playback.stop', 'ui.message', 'media.play'),
        );
        h.heartbeats.set(
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            heartbeat('playback.pause', 'ui.message'),
        );
        vi.mocked(service.buildDeviceState).mockImplementation(
            async (id: string) =>
                ({ deviceSessionId: id, lastSeen: null, nowPlaying: null }) as never,
        );
        const views = await listNativeDevices(sql, { userId: admin.userId, ownerIsAdmin: true });
        const foreign = views.find((v) => v.target.ownerUserId === ALICE)!;
        const own = views.find((v) => v.target.ownerUserId === ADMIN)!;
        expect(foreign.commands).toEqual(['playback.stop', 'ui.message']);
        expect(own.commands).toEqual(['playback.pause', 'ui.message']);
    });

    it('a database error leaves the session list intact (empty native part)', async () => {
        h.sqlThrows = true;
        expect(await listNativeDevices(sql, { userId: alice.userId, ownerIsAdmin: false })).toEqual(
            [],
        );
    });
});

describe('commands: sender, ownership and admin rules', () => {
    const own = ctxFor(tokenRow(ALICE, 'alice'), alice);

    it('a Playstate command is sent as an app sender of the Jellyfin caller, 204', async () => {
        const res = await nativePlaystate(own, 'Pause', undefined);
        expect(res.status).toBe(204);
        expect(sent()).toEqual([
            expect.objectContaining({
                deviceSessionId: TV,
                ownerUserId: ALICE,
                request: { type: 'playback.pause' },
                sender: {
                    userId: ALICE,
                    username: 'alice',
                    source: 'app',
                    deviceName: 'Findroid on Pixel',
                },
            }),
        ]);
        expect(checks.deviceCommandChecks).toHaveBeenCalledTimes(1);
    });

    it('an administrator sending ui.message / playback.stop to someone else is an admin sender', async () => {
        const foreign = ctxFor(tokenRow(ALICE, 'alice'), admin);
        expect((await nativePlaystate(foreign, 'Stop', undefined)).status).toBe(204);
        expect(
            (
                await nativeGeneralCommand(foreign, {
                    Name: 'DisplayMessage',
                    ControllingUserId: 'x',
                    Arguments: { Text: 'Restarting soon' },
                })
            ).status,
        ).toBe(204);
        expect(sent().map((s) => [s.request.type, s.sender.admin])).toEqual([
            ['playback.stop', true],
            ['ui.message', true],
        ]);
        expect(sent()[0].ownerUserId).toBe(ALICE);
        expect(checks.deviceCommandChecks).not.toHaveBeenCalled();
    });

    it('an administrator may not send anything else to someone else’s device: 403, nothing looked up', async () => {
        const foreign = ctxFor(tokenRow(ALICE, 'alice'), admin);
        for (const res of [
            await nativePlaystate(foreign, 'Pause', undefined),
            await nativePlaystate(foreign, 'Seek', 100),
            await nativeGeneralCommand(foreign, {
                Name: 'SetAudioStreamIndex',
                ControllingUserId: 'x',
                Arguments: { Index: '1' },
            }),
            await nativePlay(foreign, { playCommand: 'PlayNow', itemIds: [ITEM] }),
            await nativeGeneralCommand(foreign, {
                Name: 'DisplayContent',
                ControllingUserId: 'x',
                Arguments: { ItemId: ITEM },
            }),
        ]) {
            expect(res.status).toBe(403);
        }
        expect(service.sendDeviceCommand).not.toHaveBeenCalled();
    });

    it('an administrator controlling their own device is an ordinary owner', async () => {
        const mine = ctxFor(tokenRow(ADMIN, 'root'), admin);
        expect((await nativePlaystate(mine, 'Pause', undefined)).status).toBe(204);
        expect(sent()[0].sender.admin).toBeUndefined();
    });

    it('invalid and unsupported commands answer 400 without sending', async () => {
        const seek = await nativePlaystate(own, 'Seek', undefined);
        expect(seek.status).toBe(400);
        const volume = await nativeGeneralCommand(own, {
            Name: 'VolumeUp',
            ControllingUserId: 'x',
            Arguments: {},
        });
        expect(volume.status).toBe(400);
        expect(await volume.json()).toMatchObject({ details: 'device_unsupported' });
        expect(service.sendDeviceCommand).not.toHaveBeenCalled();
    });
});

describe('commands: items', () => {
    const own = ctxFor(tokenRow(ALICE, 'alice'), alice);

    it('Play resolves the kind and sends media.play', async () => {
        h.mediaTypes.set(ITEM_DASHED, 'tv');
        const res = await nativePlay(own, {
            playCommand: 'PlayNow',
            itemIds: [ITEM],
            startPositionTicks: 600_000_000,
        });
        expect(res.status).toBe(204);
        expect(sent()[0].request).toEqual({
            type: 'media.play',
            args: {
                kind: 'series',
                itemId: ITEM_DASHED,
                mode: 'play',
                resume: false,
                startSeconds: 60,
            },
        });
    });

    it('StartIndex picks which of several items plays', async () => {
        const other = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        h.mediaTypes.set(ITEM_DASHED, 'episode');
        h.mediaTypes.set(other, 'episode');
        await nativePlay(own, {
            playCommand: 'PlayNow',
            itemIds: [ITEM, other.replace(/-/g, '')],
            startIndex: 1,
        });
        expect(sent()[0].request.args).toMatchObject({ itemId: other, kind: 'episode' });
    });

    it('PlayNow of several tracks plays the first and queues the rest, when the device queues', async () => {
        const t2 = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const t3 = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        for (const id of [ITEM_DASHED, t2, t3]) h.mediaTypes.set(id, 'audio');
        h.heartbeats.set(TV, heartbeat('media.play', 'queue.add'));
        const res = await nativePlay(own, {
            playCommand: 'PlayNow',
            itemIds: [ITEM, t2, t3],
            startPositionTicks: 100_000_000,
        });
        expect(res.status).toBe(204);
        expect(sent().map((s) => s.request)).toEqual([
            {
                type: 'media.play',
                args: {
                    kind: 'track',
                    itemId: ITEM_DASHED,
                    mode: 'play',
                    resume: false,
                    startSeconds: 10,
                },
            },
            { type: 'queue.add', args: { itemIds: [t2, t3], position: 'end' } },
        ]);
    });

    it('a list whose device cannot queue is refused before anything is sent', async () => {
        const t2 = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        h.mediaTypes.set(ITEM_DASHED, 'audio');
        h.mediaTypes.set(t2, 'audio');
        h.heartbeats.set(TV, heartbeat('media.play'));
        const res = await nativePlay(own, { playCommand: 'PlayNow', itemIds: [ITEM, t2] });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ details: 'device_unsupported' });
        expect(service.sendDeviceCommand).not.toHaveBeenCalled();
    });

    it('PlayShuffle of several items is 400 device_unsupported, not one silent item', async () => {
        const t2 = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        h.mediaTypes.set(ITEM_DASHED, 'audio');
        h.mediaTypes.set(t2, 'audio');
        const res = await nativePlay(own, { playCommand: 'PlayShuffle', itemIds: [ITEM, t2] });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ details: 'device_unsupported' });
        expect(service.sendDeviceCommand).not.toHaveBeenCalled();
    });

    it('a playlist id becomes kind playlist with its serial id', async () => {
        const playlist = '00000000000040008000' + '00000000002a';
        await nativePlay(own, { playCommand: 'PlayNow', itemIds: [playlist] });
        expect(sent()[0].request.args).toMatchObject({ kind: 'playlist', itemId: '42' });
    });

    it('an item the caller cannot see, or that does not exist, is 404', async () => {
        h.mediaTypes.set(ITEM_DASHED, 'movie');
        h.hidden.add(`${ALICE}:${ITEM}`);
        expect((await nativePlay(own, { playCommand: 'PlayNow', itemIds: [ITEM] })).status).toBe(
            404,
        );
        h.hidden.clear();
        h.mediaTypes.clear();
        expect((await nativePlay(own, { playCommand: 'PlayNow', itemIds: [ITEM] })).status).toBe(
            404,
        );
        expect(service.sendDeviceCommand).not.toHaveBeenCalled();
    });

    it('a kind a device cannot play (a season) is 400 device_unsupported', async () => {
        h.mediaTypes.set(ITEM_DASHED, 'season');
        const res = await nativePlay(own, { playCommand: 'PlayNow', itemIds: [ITEM] });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ details: 'device_unsupported' });
    });

    it('a StartIndex outside the list is 400', async () => {
        expect(
            (await nativePlay(own, { playCommand: 'PlayNow', itemIds: [ITEM], startIndex: 4 }))
                .status,
        ).toBe(400);
    });

    it('PlayNext / PlayLast queue every item; DisplayContent opens the detail', async () => {
        h.mediaTypes.set(ITEM_DASHED, 'track');
        await nativePlay(own, { playCommand: 'PlayLast', itemIds: [ITEM] });
        await nativeGeneralCommand(own, {
            Name: 'DisplayContent',
            ControllingUserId: 'x',
            Arguments: { ItemId: ITEM },
        });
        expect(sent().map((s) => s.request)).toEqual([
            { type: 'queue.add', args: { itemIds: [ITEM_DASHED], position: 'end' } },
            {
                type: 'media.play',
                args: { kind: 'track', itemId: ITEM_DASHED, mode: 'openDetail' },
            },
        ]);
    });

    it('malformed ItemIds in a command are 400', async () => {
        const res = await nativeGeneralCommand(own, {
            Name: 'Play',
            ControllingUserId: 'x',
            Arguments: { ItemIds: 'nope' },
        });
        expect(res.status).toBe(400);
    });
});

describe('registry errors as Jellyfin answers', () => {
    const own = ctxFor(tokenRow(ALICE, 'alice'), alice);
    const cases: [DeviceCommandError['kind'], number][] = [
        ['device_unsupported', 400],
        ['device_unreachable', 400],
        ['invalid', 400],
        ['stale_target', 409],
        ['conflict', 409],
        ['simple_mode_locked', 403],
        ['forbidden', 403],
        ['not_found', 404],
        ['rate_limited', 429],
        ['unavailable', 503],
    ];

    it.each(cases)('%s -> %i', async (kind, status) => {
        vi.mocked(service.sendDeviceCommand).mockResolvedValueOnce({
            ok: false,
            error: { kind, message: kind, ...(kind === 'rate_limited' ? { retryAfter: 7 } : {}) },
        });
        const res = await nativePlaystate(own, 'Pause', undefined);
        expect(res.status).toBe(status);
        if (kind === 'rate_limited') expect(res.headers.get('Retry-After')).toBe('7');
        if (kind === 'device_unreachable') {
            expect(await res.json()).toMatchObject({ details: 'device_unreachable' });
        }
    });

    it('nativeErrorResponse covers every error kind', () => {
        for (const [kind] of cases) {
            expect(nativeErrorResponse({ kind, message: 'm' }).status).toBeGreaterThanOrEqual(400);
        }
    });
});

describe('device lookup queries', () => {
    const sqlText = (): string =>
        vi
            .mocked(sql as unknown as (s: TemplateStringsArray) => unknown)
            .mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'))
            .join('\n');

    it('listNativeDevices reads the most recently used sessions first and skips offline ones', async () => {
        const OFFLINE = '88888888-8888-4888-8888-888888888888';
        h.rows = [tokenRow(ALICE, 'alice'), tokenRow(ALICE, 'alice', OFFLINE)];
        h.heartbeats.set(TV, heartbeat('playback.pause'));
        vi.mocked(service.buildDeviceState).mockResolvedValue({ nowPlaying: null } as never);
        const views = await listNativeDevices(sql, { userId: alice.userId, ownerIsAdmin: false });
        expect(views.map((v) => v.target.deviceSessionId)).toEqual([TV]);
        // Only the live one gets a state built.
        expect(service.buildDeviceState).toHaveBeenCalledTimes(1);
        expect(service.buildDeviceState).toHaveBeenCalledWith(TV, expect.anything());
        const text = sqlText();
        expect(text.indexOf('ORDER BY latest.used_at DESC')).toBeGreaterThan(-1);
        expect(text.indexOf('ORDER BY latest.used_at DESC')).toBeLessThan(text.indexOf('LIMIT'));
    });

    it('resolveNativeTarget compares the session id case-insensitively and takes the newest token', async () => {
        h.rows = [tokenRow(ALICE, 'alice')];
        await resolveNativeTarget(sql, TV_HEX, { userId: alice.userId, ownerIsAdmin: false });
        const text = sqlText();
        expect(text).toContain('lower(t.device_session_id) = lower(');
        expect(text).toContain('ORDER BY t.created_at DESC');
    });
});
