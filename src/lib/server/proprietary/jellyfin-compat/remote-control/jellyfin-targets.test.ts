// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The Lumastra remote controlling a Jellyfin client: the provider the core
 * device API calls for `jf:<id>` — list, state, and delivery through the
 * client's socket (applied / unreachable / unsupported / ownership).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDeviceRecord } from './device-registry';

const h = vi.hoisted(() => ({
    devices: new Map<string, unknown>(),
    online: new Set<string>(),
    hidden: new Set<string>(),
    allowed: true,
    playSessions: [] as unknown[],
    enabled: true,
}));

vi.mock('$lib/server/config', () => ({
    config: {
        get FEATURE_JELLYFIN_COMPAT() {
            return h.enabled;
        },
    },
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/play-sessions.queries', () => ({
    getActiveSessionsForUser: vi.fn(async () => h.playSessions),
}));
const checkRateLimit = vi.fn(async (_key: string, _limit: number, _window: number) => ({
    allowed: h.allowed,
    resetAt: Math.floor(Date.now() / 1000) + 5,
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...(a as [string, number, number])),
}));
vi.mock('./device-registry', () => ({
    getDevice: vi.fn(async (id: string) => h.devices.get(id) ?? null),
    listDevicesForUser: vi.fn(async (userId: string) =>
        [...h.devices.values()].filter((d) => (d as { userId: string }).userId === userId),
    ),
    getOnlineSessionIds: vi.fn(async () => h.online),
}));
vi.mock('./sessions-list', () => ({ IDLE_DEVICE_WINDOW_MS: 10 * 60 * 1000 }));
const sendToSession = vi.fn(async (..._a: unknown[]) => ({ local: 1, published: true }));
vi.mock('./fanout', () => ({
    deliverToSession: (...a: unknown[]) => sendToSession(...a),
}));
vi.mock('./commands', () => ({
    userContextFor: vi.fn(async (userId: string) => ({ userId })),
    canSeeItem: vi.fn(async (_sql: unknown, id: string) => !h.hidden.has(id)),
}));

const { jellyfinRemoteTargets: provider } = await import('./jellyfin-targets');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const alice = { userId: ALICE, username: 'alice' };
const sender = { userId: ALICE, username: 'alice', source: 'app' as const, deviceName: 'iPhone' };

function record(over: Partial<RemoteDeviceRecord> = {}): RemoteDeviceRecord {
    return {
        id: 'a'.repeat(32),
        userId: ALICE,
        username: 'alice',
        displayName: null,
        deviceId: 'tv-dev',
        deviceName: 'Bedroom TV',
        client: 'Jellyfin Android TV',
        clientVersion: '0.19',
        playableMediaTypes: ['Video'],
        supportedCommands: ['DisplayMessage', 'SetSubtitleStreamIndex', 'DisplayContent'],
        supportsMediaControl: true,
        lastActivityAt: Date.now(),
        ...over,
    };
}
const TARGET = `jf:${'a'.repeat(32)}`;

beforeEach(() => {
    vi.clearAllMocks();
    h.devices.clear();
    h.online.clear();
    h.hidden.clear();
    h.allowed = true;
    h.enabled = true;
    h.playSessions = [];
    h.devices.set(record().id, record());
    h.online.add(record().id);
});

describe('ownership of ids', () => {
    it('owns only the jf: prefix, which no device session id can have', () => {
        expect(provider.owns(TARGET)).toBe(true);
        expect(provider.owns('11111111-1111-4111-8111-111111111111')).toBe(false);
    });
});

describe('list', () => {
    it('lists the user’s controllable clients with capabilities, online first by recency', async () => {
        const idle = record({
            id: 'b'.repeat(32),
            deviceName: 'Old phone',
            lastActivityAt: Date.now() - 60_000,
        });
        h.devices.set(idle.id, idle);
        const list = await provider.list(alice);
        expect(list.map((d) => d.deviceSessionId)).toEqual([TARGET, `jf:${'b'.repeat(32)}`]);
        expect(list.every((d) => d.external === true)).toBe(true);
        // Negative, stable, and distinct per client.
        expect(list[0].id).toBeLessThan(0);
        expect(list[0].id).not.toBe(list[1].id);
        expect((await provider.list(alice))[0].id).toBe(list[0].id);
        expect(list[0]).toMatchObject({
            deviceName: 'Bedroom TV',
            clientId: 'Jellyfin Android TV',
            deviceType: 'tv',
            isOnline: true,
            deviceId: 'tv-dev',
        });
        expect(Object.keys(list[0].capabilities!.commands)).toContain('playback.pause');
        expect(Object.keys(list[0].capabilities!.commands)).toContain('ui.message');
        expect(list[1].isOnline).toBe(false);
    });

    it('never lists another user’s client, an uncontrollable one, or one idle for long', async () => {
        h.devices.set('c'.repeat(32), record({ id: 'c'.repeat(32), userId: BOB }));
        h.devices.set(
            'd'.repeat(32),
            record({ id: 'd'.repeat(32), supportsMediaControl: false, supportedCommands: [] }),
        );
        const old = record({ id: 'e'.repeat(32), lastActivityAt: Date.now() - 3_600_000 });
        h.devices.set(old.id, old);
        expect((await provider.list(alice)).map((d) => d.deviceSessionId)).toEqual([TARGET]);
    });
});

describe('Jellyfin compat switched off', () => {
    it('owns nothing, lists nothing and refuses everything', async () => {
        h.enabled = false;
        expect(provider.owns(TARGET)).toBe(false);
        expect(await provider.list(alice)).toEqual([]);
        expect(await provider.state(TARGET, alice)).toBeNull();
        expect(
            await provider.send({
                id: TARGET,
                user: alice,
                request: { type: 'playback.pause' },
                sender,
            }),
        ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
        expect(sendToSession).not.toHaveBeenCalled();
    });
});

describe('state', () => {
    it('describes the client, with what it plays from its play session', async () => {
        h.playSessions = [
            {
                id: 'ps1',
                device_id: 'tv-dev',
                media_id: ITEM,
                status: 'ACTIVE',
                position_ms: 61_000,
                runtime_ms: 3_600_000,
                last_heartbeat_at: new Date(),
            },
            {
                id: 'ps2',
                device_id: 'other',
                media_id: ITEM,
                status: 'ACTIVE',
                position_ms: 1,
                last_heartbeat_at: new Date(),
            },
        ];
        const s = await provider.state(TARGET, alice);
        expect(s).toMatchObject({
            deviceSessionId: TARGET,
            online: true,
            reachable: true,
            deviceType: 'tv',
            nowPlaying: {
                sessionId: 'ps1',
                positionSeconds: 61,
                durationSeconds: 3600,
                paused: false,
                reported: false,
            },
        });
    });

    it('keeps the sample time as observedAt and answers an ever-higher revision', async () => {
        const sampled = new Date(Date.now() - 7_000);
        h.playSessions = [
            {
                id: 'ps1',
                device_id: 'tv-dev',
                media_id: ITEM,
                media_type: 'movie',
                status: 'ACTIVE',
                position_ms: 61_000,
                last_heartbeat_at: sampled,
            },
        ];
        const a = await provider.state(TARGET, alice);
        const b = await provider.state(TARGET, alice);
        expect(a?.nowPlaying?.observedAt).toBe(sampled.toISOString());
        expect(b!.revision).toBeGreaterThan(a!.revision);
    });

    it('describes audio as music, not video', async () => {
        h.playSessions = [
            {
                id: 'ps1',
                device_id: 'tv-dev',
                media_id: ITEM,
                media_type: 'audio',
                status: 'ACTIVE',
                position_ms: 1_000,
                last_heartbeat_at: new Date(),
            },
        ];
        const s = await provider.state(TARGET, alice);
        expect(s?.nowPlaying).toMatchObject({ kind: 'music', music: { trackId: ITEM } });
        expect(s?.nowPlaying?.video).toBeUndefined();
    });

    it('is null for another user’s client and for an unknown id', async () => {
        expect(await provider.state(TARGET, { userId: BOB, username: 'bob' })).toBeNull();
        expect(await provider.state(`jf:${'f'.repeat(32)}`, alice)).toBeNull();
    });
});

describe('send', () => {
    it('delivers a Playstate to the open socket and answers applied', async () => {
        const r = await provider.send({
            id: TARGET,
            user: alice,
            request: { type: 'playback.pause' },
            sender,
        });
        expect(r).toMatchObject({
            ok: true,
            value: {
                status: 'applied',
                type: 'playback.pause',
                deviceSessionId: TARGET,
                source: 'app',
            },
        });
        expect(sendToSession).toHaveBeenCalledWith(
            'a'.repeat(32),
            expect.objectContaining({
                MessageType: 'Playstate',
                Data: expect.objectContaining({ Command: 'Pause' }),
            }),
        );
    });

    it('without an open socket it is device_unreachable and nothing is sent', async () => {
        h.online.clear();
        const r = await provider.send({
            id: TARGET,
            user: alice,
            request: { type: 'playback.pause' },
            sender,
        });
        expect(r).toMatchObject({ ok: false, error: { kind: 'device_unreachable' } });
        expect(sendToSession).not.toHaveBeenCalled();
    });

    it('a command the client did not announce is device_unsupported', async () => {
        h.devices.set(record().id, record({ supportedCommands: [], playableMediaTypes: [] }));
        expect(
            await provider.send({
                id: TARGET,
                user: alice,
                request: { type: 'livetv.channelUp' },
                sender,
            }),
        ).toMatchObject({ ok: false, error: { kind: 'device_unsupported' } });
        expect(
            await provider.send({
                id: TARGET,
                user: alice,
                request: {
                    type: 'media.play',
                    args: { kind: 'movie', itemId: ITEM, mode: 'play' },
                },
                sender,
            }),
        ).toMatchObject({ ok: false, error: { kind: 'device_unsupported' } });
        expect(sendToSession).not.toHaveBeenCalled();
    });

    it('registry commands without a Jellyfin counterpart are device_unsupported', async () => {
        for (const type of ['playback.setRate', 'party.join', 'playback.setSleepTimer'] as const) {
            const request =
                type === 'playback.setRate'
                    ? { type, args: { rate: 1.5 } }
                    : type === 'party.join'
                      ? { type, args: { code: 'x' } }
                      : { type, args: { mode: 'off' } };
            expect(await provider.send({ id: TARGET, user: alice, request, sender })).toMatchObject(
                {
                    ok: false,
                    error: { kind: 'device_unsupported' },
                },
            );
        }
    });

    it('someone else’s client and an unknown one are not_found', async () => {
        expect(
            await provider.send({
                id: TARGET,
                user: { userId: BOB, username: 'bob' },
                request: { type: 'playback.pause' },
                sender,
            }),
        ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
        expect(
            await provider.send({
                id: `jf:${'f'.repeat(32)}`,
                user: alice,
                request: { type: 'playback.pause' },
                sender,
            }),
        ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
        expect(sendToSession).not.toHaveBeenCalled();
    });

    it('a message carries the sender in its header and is delivered as DisplayMessage', async () => {
        const r = await provider.send({
            id: TARGET,
            user: alice,
            request: { type: 'ui.message', args: { text: 'Dinner' } },
            sender,
        });
        expect(r.ok).toBe(true);
        expect(sendToSession).toHaveBeenCalledWith(
            'a'.repeat(32),
            expect.objectContaining({
                MessageType: 'GeneralCommand',
                Data: expect.objectContaining({
                    Name: 'DisplayMessage',
                    Arguments: { Header: 'Message from iPhone', Text: 'Dinner' },
                }),
            }),
        );
    });

    it('media.play delivers Play for an item the owner may see, and refuses a hidden one', async () => {
        const request = {
            type: 'media.play' as const,
            args: { kind: 'movie' as const, itemId: ITEM, mode: 'play' as const },
        };
        expect((await provider.send({ id: TARGET, user: alice, request, sender })).ok).toBe(true);
        expect(sendToSession).toHaveBeenCalledWith(
            'a'.repeat(32),
            expect.objectContaining({
                MessageType: 'Play',
                Data: expect.objectContaining({
                    PlayCommand: 'PlayNow',
                    ItemIds: [ITEM.replace(/-/g, '')],
                }),
            }),
        );
        h.hidden.add(ITEM.replace(/-/g, ''));
        sendToSession.mockClear();
        expect(await provider.send({ id: TARGET, user: alice, request, sender })).toMatchObject({
            ok: false,
            error: { kind: 'not_found' },
        });
        expect(sendToSession).not.toHaveBeenCalled();
    });

    const seekTicks = (): number => {
        const message = sendToSession.mock.calls.at(-1)?.[1] as {
            Data: { SeekPositionTicks: number };
        };
        return message.Data.SeekPositionTicks;
    };

    it('seekBy without a play session is a conflict', async () => {
        const request = { type: 'playback.seekBy' as const, args: { seconds: 10 } };
        expect(await provider.send({ id: TARGET, user: alice, request, sender })).toMatchObject({
            ok: false,
            error: { kind: 'conflict' },
        });
    });

    it('seekBy moves on from where playback is NOW, not from the old sample', async () => {
        h.playSessions = [
            {
                id: 'ps1',
                device_id: 'tv-dev',
                media_id: ITEM,
                status: 'ACTIVE',
                position_ms: 100_000,
                last_heartbeat_at: new Date(Date.now() - 8_000),
            },
        ];
        const request = { type: 'playback.seekBy' as const, args: { seconds: 10 } };
        expect((await provider.send({ id: TARGET, user: alice, request, sender })).ok).toBe(true);
        // 100 s sampled + 8 s elapsed + 10 s requested = 118 s.
        expect(seekTicks() / 10_000_000).toBeCloseTo(118, 0);
    });

    it('seekBy is stale_target when the sample is too old while playing, but fine while paused', async () => {
        const row = {
            id: 'ps1',
            device_id: 'tv-dev',
            media_id: ITEM,
            position_ms: 100_000,
            last_heartbeat_at: new Date(Date.now() - 40_000),
        };
        const request = { type: 'playback.seekBy' as const, args: { seconds: 10 } };
        h.playSessions = [{ ...row, status: 'ACTIVE' }];
        expect(await provider.send({ id: TARGET, user: alice, request, sender })).toMatchObject({
            ok: false,
            error: { kind: 'stale_target' },
        });
        expect(sendToSession).not.toHaveBeenCalled();
        h.playSessions = [{ ...row, status: 'PAUSED' }];
        expect((await provider.send({ id: TARGET, user: alice, request, sender })).ok).toBe(true);
        expect(seekTicks()).toBe(1_100_000_000);
    });

    it('expect.sessionId must match the playing session, else stale_target', async () => {
        h.playSessions = [
            {
                id: 'ps1',
                device_id: 'tv-dev',
                media_id: ITEM,
                status: 'ACTIVE',
                position_ms: 1,
                last_heartbeat_at: new Date(),
            },
        ];
        const base = { type: 'playback.pause' as const };
        expect(
            await provider.send({
                id: TARGET,
                user: alice,
                request: { ...base, expect: { sessionId: 'other' } },
                sender,
            }),
        ).toMatchObject({ ok: false, error: { kind: 'stale_target' } });
        expect(
            (
                await provider.send({
                    id: TARGET,
                    user: alice,
                    request: { ...base, expect: { sessionId: 'ps1' } },
                    sender,
                })
            ).ok,
        ).toBe(true);
        expect(
            await provider.send({
                id: TARGET,
                user: alice,
                request: { ...base, expect: { queueRevision: 1 } },
                sender,
            }),
        ).toMatchObject({ ok: false, error: { kind: 'device_unsupported' } });
    });

    it('is rate limited', async () => {
        h.allowed = false;
        expect(
            await provider.send({
                id: TARGET,
                user: alice,
                request: { type: 'playback.pause' },
                sender,
            }),
        ).toMatchObject({
            ok: false,
            error: { kind: 'rate_limited', retryAfter: expect.any(Number) },
        });
        expect(sendToSession).not.toHaveBeenCalled();
        // A budget of its own, not the native device one.
        expect(checkRateLimit.mock.calls[0][0]).toBe(`devcmd:jf:${ALICE}:${TARGET}`);
    });

    it('runs the type checks (Live TV permission, simple-mode lock) before delivering', async () => {
        const check = vi.fn(async () => ({
            kind: 'simple_mode_locked' as const,
            message: 'locked',
        }));
        expect(
            await provider.send({
                id: TARGET,
                user: alice,
                request: { type: 'playback.pause' },
                sender,
                checks: { check },
            }),
        ).toMatchObject({ ok: false, error: { kind: 'simple_mode_locked' } });
        expect(check).toHaveBeenCalled();
        expect(sendToSession).not.toHaveBeenCalled();
    });

    it('does not run the checks for a client the caller does not own', async () => {
        const check = vi.fn(async () => null);
        await provider.send({
            id: TARGET,
            user: { userId: BOB, username: 'bob' },
            request: { type: 'playback.pause' },
            sender,
            checks: { check },
        });
        expect(check).not.toHaveBeenCalled();
    });

    it('a message that reached no socket and could not be published is device_unreachable', async () => {
        sendToSession.mockResolvedValueOnce({ local: 0, published: false });
        expect(
            await provider.send({
                id: TARGET,
                user: alice,
                request: { type: 'playback.pause' },
                sender,
            }),
        ).toMatchObject({ ok: false, error: { kind: 'device_unreachable' } });
        // Published for another replica's socket: delivered as far as we can tell.
        sendToSession.mockResolvedValueOnce({ local: 0, published: true });
        expect(
            (
                await provider.send({
                    id: TARGET,
                    user: alice,
                    request: { type: 'playback.pause' },
                    sender,
                })
            ).ok,
        ).toBe(true);
    });
});
