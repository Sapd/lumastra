// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * device-commands.service — send, deliver, report, cancel, inbox and state,
 * against an in-memory Valkey (the helpers the service uses, nothing else).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = new Map<string, { value: string; expiresAt: number | null }>();
const sets = new Map<string, Set<string>>();
const counters = new Map<string, number>();
/** Set to make the next compare-and-set lose (someone else changed the status). */
const cas = { loseNext: false };

/** The compare-and-set Lua script, emulated: SET only while the status matches. */
function evalScript(args: string[]): number {
    const [, , , key, json, , ...from] = args;
    const entry = store.get(key);
    if (!entry || cas.loseNext) {
        cas.loseNext = false;
        return 0;
    }
    const status = (JSON.parse(entry.value) as { status?: string }).status;
    if (!status || !from.includes(status)) return 0;
    store.set(key, { value: json, expiresAt: entry.expiresAt });
    return 1;
}

vi.mock('$lib/server/cache/valkey.js', () => ({
    connectValkey: vi.fn().mockResolvedValue(true),
    isCoordinationValkeyReady: vi.fn().mockReturnValue(true),
    getCoordinationClient: vi.fn(() => ({
        customCommand: async (args: string[]) => evalScript(args),
        incr: async (key: string) => {
            const n = (counters.get(key) ?? 0) + 1;
            counters.set(key, n);
            store.set(key, { value: String(n), expiresAt: null });
            return n;
        },
    })),
    sCard: vi.fn(async (key: string) => sets.get(key)?.size ?? 0),
    setEx: vi.fn(async (key: string, seconds: number, value: string) => {
        store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
        return true;
    }),
    setIfNotExists: vi.fn(async (key: string, value: string, seconds?: number) => {
        if (store.has(key)) return false;
        store.set(key, { value, expiresAt: seconds ? Date.now() + seconds * 1000 : null });
        return true;
    }),
    cacheGetOrThrow: vi.fn(async (key: string) => {
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
            store.delete(key);
            return null;
        }
        return entry.value;
    }),
    cacheDel: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) {
            store.delete(k);
            sets.delete(k);
        }
        return 1;
    }),
    sAdd: vi.fn(async (key: string, ...members: string[]) => {
        const set = sets.get(key) ?? new Set<string>();
        const before = set.size;
        members.forEach((m) => set.add(m));
        sets.set(key, set);
        return set.size - before;
    }),
    sMembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    sRem: vi.fn(async (key: string, ...members: string[]) => {
        members.forEach((m) => sets.get(key)?.delete(m));
        return members.length;
    }),
    expire: vi.fn().mockResolvedValue(true),
}));

const rateLimit = { allowed: true, deniedPrefix: '' };
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async (key: string) => ({
        allowed:
            rateLimit.allowed &&
            !(rateLimit.deniedPrefix && key.startsWith(rateLimit.deniedPrefix)),
        remaining: 0,
        resetAt: Math.floor(Date.now() / 1000) + 5,
        total: 20,
    })),
}));

vi.mock('$lib/server/services/notification-events.service.js', () => ({
    publishUserEvent: vi.fn().mockResolvedValue('not-applicable'),
}));

vi.mock('$lib/server/services/device-presence.service.js', () => ({
    getHeartbeat: vi.fn(),
    isDeviceStreamOpen: vi.fn(),
    DEVICE_ONLINE_KEY: (id: string) => `device:online:${id}`,
    DEVICE_STREAM_KEY: (id: string) => `devcmd:v1:stream:${id}`,
}));

// Hoisted: the service registers its revoke listener while it is imported.
const revokeListeners = vi.hoisted(() => [] as ((ids: readonly string[]) => void)[]);
vi.mock('$lib/server/oauth/device-session-liveness.js', () => ({
    onDeviceSessionsRevoked: (fn: (ids: readonly string[]) => void) => revokeListeners.push(fn),
}));

const helperRows = vi.hoisted(() => ({
    rows: [] as { user_id: string }[],
    /** When set, the grant lookup does not answer until this resolves. */
    gate: null as Promise<void> | null,
    sessions: [] as { device_session_id: string }[],
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/device-control-grants.queries.js', () => ({
    listGrantsByOwner: {
        all: vi.fn(async () => {
            if (helperRows.gate) await helperRows.gate;
            return helperRows.rows;
        }),
    },
    listDeviceSessionIdsOfUser: { all: vi.fn(async () => helperRows.sessions) },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import {
    beginIdempotentSend,
    buildDeviceState,
    cancelCommandsFromSender,
    cancelDeviceCommand,
    invalidateHelpersCache,
    forgetDevice,
    getDeviceCommand,
    INBOX_LIMIT,
    listDeviceInbox,
    reportDeviceCommandResult,
    reportDeviceState,
    rememberCapabilities,
    sendDeviceCommand,
    type CommandSender,
} from './device-commands.service.js';
import { publishUserEvent } from './notification-events.service.js';
import { getHeartbeat, isDeviceStreamOpen } from './device-presence.service.js';
import type { DeviceCommandRequest, DeviceCommandType } from '$lib/schemas/device-commands.js';

const TV = 'tv-session-1';
const OWNER = 'user-1';
const sender: CommandSender = {
    userId: OWNER,
    username: 'alice',
    source: 'app',
    deviceSessionId: 'phone-1',
    deviceName: "Alice's iPhone",
};

function announce(types: DeviceCommandType[], online = true, reachable = true): void {
    vi.mocked(getHeartbeat).mockResolvedValue(
        online
            ? ({
                  userId: OWNER,
                  username: 'alice',
                  deviceSessionId: TV,
                  deviceName: 'Living Room',
                  deviceType: 'tv',
                  supportsWatchTogether: true,
                  capabilities: { commands: Object.fromEntries(types.map((t) => [t, {}])) },
                  lastSeen: Date.now(),
              } as never)
            : null,
    );
    vi.mocked(isDeviceStreamOpen).mockResolvedValue(reachable);
}

function send(
    request: DeviceCommandRequest,
    extra: Partial<Parameters<typeof sendDeviceCommand>[0]> = {},
) {
    return sendDeviceCommand({
        deviceSessionId: TV,
        ownerUserId: OWNER,
        request,
        sender,
        ...extra,
    });
}

function publishedKinds(): string[] {
    return vi.mocked(publishUserEvent).mock.calls.map((c) => c[0].kind);
}

beforeEach(() => {
    store.clear();
    sets.clear();
    counters.clear();
    cas.loseNext = false;
    rateLimit.allowed = true;
    rateLimit.deniedPrefix = '';
    vi.mocked(publishUserEvent).mockClear();
    announce([
        'playback.pause',
        'playback.seekBy',
        'livetv.tune',
        'media.play',
        'ui.message',
        'playback.stop',
    ]);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('sendDeviceCommand', () => {
    it('queues a live command, delivers it only to the target device and returns it', async () => {
        const res = await send({ type: 'playback.pause' });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        const cmd = res.value.command;
        expect(cmd).toMatchObject({
            type: 'playback.pause',
            delivery: 'live',
            status: 'pending',
            source: 'app',
            sender: { username: 'alice', deviceSessionId: 'phone-1', deviceName: "Alice's iPhone" },
            deviceSessionId: TV,
        });
        expect(cmd).not.toHaveProperty('ownerUserId');
        const call = vi
            .mocked(publishUserEvent)
            .mock.calls.find((c) => c[0].kind === 'device.command');
        expect(call?.[0]).toMatchObject({
            userId: OWNER,
            targetDeviceSessionId: TV,
            persist: false,
        });
        const inbox = await listDeviceInbox(TV);
        expect(inbox.ok && inbox.value.map((c) => c.id)).toEqual([cmd.id]);
    });

    it('refuses a type the device does not announce', async () => {
        const res = await send({ type: 'playback.setRate', args: { rate: 1.5 } });
        expect(res).toMatchObject({ ok: false, error: { kind: 'device_unsupported' } });
    });

    it('refuses a live command for a device without an open stream, but queues an intent', async () => {
        announce(['playback.pause', 'media.play'], true, false);
        expect(await send({ type: 'playback.pause' })).toMatchObject({
            ok: false,
            error: { kind: 'device_unreachable' },
        });
        const intent = await send({
            type: 'media.play',
            args: { kind: 'movie', itemId: 'm1' },
        });
        expect(intent.ok && intent.value.command.delivery).toBe('queued');
    });

    it('queues an intent for an offline device (no heartbeat, nothing to check against)', async () => {
        announce([], false, false);
        const res = await send({
            type: 'livetv.tune',
            args: { stationId: '00000000-0000-4000-8000-000000000001' },
        });
        expect(res.ok).toBe(true);
    });

    it('applies the type defaults to args', async () => {
        const res = await send({ type: 'media.play', args: { kind: 'episode', itemId: 'e1' } });
        expect(res.ok && res.value.command.args).toEqual({
            kind: 'episode',
            itemId: 'e1',
            mode: 'play',
            resume: true,
        });
    });

    it('a new tune supersedes the pending one and tells the device to drop it', async () => {
        // Supersede only reaches OLDER commands: two sends in one millisecond would tie.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now());
        const first = await send({
            type: 'livetv.tune',
            args: { stationId: '00000000-0000-4000-8000-000000000001' },
        });
        vi.setSystemTime(Date.now() + 5);
        const second = await send({
            type: 'livetv.tune',
            args: { stationId: '00000000-0000-4000-8000-000000000002' },
        });
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        const old = await getDeviceCommand(TV, first.value.command.id);
        expect(old.ok && old.value.status).toBe('superseded');
        expect(publishedKinds()).toContain('device.command_cancelled');
        const inbox = await listDeviceInbox(TV);
        expect(inbox.ok && inbox.value.map((c) => c.id)).toEqual([second.value.command.id]);
    });

    it('an Idempotency-Key repeat returns the first command and sends nothing new', async () => {
        const a = await send({ type: 'playback.pause' }, { idempotencyKey: 'tap-1' });
        vi.mocked(publishUserEvent).mockClear();
        const b = await send({ type: 'playback.pause' }, { idempotencyKey: 'tap-1' });
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        expect(b.value.replayed).toBe(true);
        expect(b.value.command.id).toBe(a.value.command.id);
        expect(publishUserEvent).not.toHaveBeenCalled();
    });

    it('checks expect.sessionId against the reported state', async () => {
        await reportDeviceState(OWNER, TV, {
            nowPlaying: {
                kind: 'video',
                sessionId: 'play-1',
                title: 'A Film',
                paused: false,
                rate: 1,
                availableCommands: ['playback.seekBy'],
            },
        });
        expect(
            await send({
                type: 'playback.seekBy',
                args: { seconds: 10 },
                expect: { sessionId: 'play-2' },
            }),
        ).toMatchObject({ ok: false, error: { kind: 'stale_target' } });
        expect(
            (
                await send({
                    type: 'playback.seekBy',
                    args: { seconds: 10 },
                    expect: { sessionId: 'play-1' },
                })
            ).ok,
        ).toBe(true);
    });

    it('queue edits need a queue revision', async () => {
        announce(['queue.remove']);
        expect(await send({ type: 'queue.remove', args: { index: 2 } })).toMatchObject({
            ok: false,
            error: { kind: 'invalid' },
        });
    });

    it('rate limits per sender and device', async () => {
        rateLimit.allowed = false;
        expect(await send({ type: 'playback.pause' })).toMatchObject({
            ok: false,
            error: { kind: 'rate_limited' },
        });
    });

    it('an administrator may only send messages and stop', async () => {
        const admin = {
            ...sender,
            userId: 'admin-1',
            admin: true,
            source: 'admin' as const,
            deviceSessionId: undefined,
        };
        expect(
            await sendDeviceCommand({
                deviceSessionId: TV,
                ownerUserId: OWNER,
                request: { type: 'playback.pause' },
                sender: admin,
            }),
        ).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
        const msg = await sendDeviceCommand({
            deviceSessionId: TV,
            ownerUserId: OWNER,
            request: { type: 'ui.message', args: { text: 'Restarting soon' } },
            sender: admin,
        });
        expect(msg.ok).toBe(true);
        if (!msg.ok) return;
        // Admin messages live 30 s, not 120 s.
        const lifetime =
            Date.parse(msg.value.command.expiresAt) - Date.parse(msg.value.command.createdAt);
        expect(lifetime).toBe(30_000);
        expect(msg.value.command.sender.admin).toBe(true);
        // The administrator hears the status too, not only the device owner.
        vi.mocked(publishUserEvent).mockClear();
        await reportDeviceCommandResult(TV, msg.value.command.id, { status: 'applied' });
        const recipients = vi
            .mocked(publishUserEvent)
            .mock.calls.filter((c) => c[0].kind === 'device.command_status')
            .map((c) => c[0].userId);
        expect(recipients.sort()).toEqual([OWNER, 'admin-1'].sort());
    });

    it('a device cannot command itself', async () => {
        const res = await sendDeviceCommand({
            deviceSessionId: TV,
            ownerUserId: OWNER,
            request: { type: 'playback.pause' },
            sender: { ...sender, deviceSessionId: TV },
        });
        expect(res).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    });

    it('runs the type checks the def supplies', async () => {
        const res = await send(
            { type: 'livetv.tune', args: { stationId: '00000000-0000-4000-8000-000000000001' } },
            { checks: { check: async () => ({ kind: 'not_found', message: 'Unknown channel' }) } },
        );
        expect(res).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    });

    it('a scheduled stop waits (queued) and starts its lifetime at notBefore', async () => {
        announce(['playback.stop'], true, false);
        const at = new Date(Date.now() + 30 * 60_000).toISOString();
        const res = await send({ type: 'playback.stop', notBefore: at });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.value.command.delivery).toBe('queued');
        // 15 s lifetime + 120 s grace for a device that wakes up late.
        expect(Date.parse(res.value.command.expiresAt)).toBe(Date.parse(at) + 135_000);
    });
});

describe('results, cancel and expiry', () => {
    async function sentPause() {
        const res = await send({ type: 'playback.pause' });
        if (!res.ok) throw new Error('send failed');
        return res.value.command;
    }

    it('walks delivered → applied and tells the account each time', async () => {
        const cmd = await sentPause();
        vi.mocked(publishUserEvent).mockClear();
        expect((await reportDeviceCommandResult(TV, cmd.id, { status: 'delivered' })).ok).toBe(
            true,
        );
        const applied = await reportDeviceCommandResult(TV, cmd.id, { status: 'applied' });
        expect(applied.ok && applied.value.status).toBe('applied');
        expect(publishedKinds()).toEqual(['device.command_status', 'device.command_status']);
        const inbox = await listDeviceInbox(TV);
        expect(inbox.ok && inbox.value).toEqual([]);
    });

    it('records a rejection with its reason', async () => {
        const cmd = await sentPause();
        const res = await reportDeviceCommandResult(TV, cmd.id, {
            status: 'rejected',
            reason: 'nothing_playing',
        });
        expect(res.ok && res.value).toMatchObject({
            status: 'rejected',
            reason: 'nothing_playing',
        });
    });

    it('a message can be acknowledged with the pressed button', async () => {
        const res = await send({
            type: 'ui.message',
            args: { text: 'Dinner is ready', actions: [{ id: 'ok', label: 'OK' }] },
        });
        if (!res.ok) throw new Error('send failed');
        await reportDeviceCommandResult(TV, res.value.command.id, { status: 'applied' });
        const ack = await reportDeviceCommandResult(TV, res.value.command.id, {
            status: 'acknowledged',
            actionId: 'ok',
        });
        expect(ack.ok && ack.value).toMatchObject({ status: 'acknowledged', actionId: 'ok' });
    });

    it('refuses impossible transitions and other devices', async () => {
        const cmd = await sentPause();
        expect(
            await reportDeviceCommandResult(TV, cmd.id, { status: 'acknowledged' }),
        ).toMatchObject({
            ok: false,
        });
        expect(
            await reportDeviceCommandResult('tv-other', cmd.id, { status: 'applied' }),
        ).toMatchObject({
            ok: false,
            error: { kind: 'not_found' },
        });
        await reportDeviceCommandResult(TV, cmd.id, { status: 'applied' });
        expect(await reportDeviceCommandResult(TV, cmd.id, { status: 'rejected' })).toMatchObject({
            ok: false,
            error: { kind: 'conflict' },
        });
    });

    it('cancels a pending command and tells the device', async () => {
        const cmd = await sentPause();
        vi.mocked(publishUserEvent).mockClear();
        const res = await cancelDeviceCommand(TV, cmd.id);
        expect(res.ok && res.value.status).toBe('cancelled');
        expect(publishedKinds()).toEqual(['device.command_status', 'device.command_cancelled']);
        expect(await cancelDeviceCommand(TV, cmd.id)).toMatchObject({
            ok: false,
            error: { kind: 'conflict' },
        });
    });

    it('a command past its lifetime reads as expired and leaves the inbox', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const cmd = await sentPause();
        vi.setSystemTime(Date.now() + 16_000);
        const res = await getDeviceCommand(TV, cmd.id);
        expect(res.ok && res.value.status).toBe('expired');
        const inbox = await listDeviceInbox(TV);
        expect(inbox.ok && inbox.value).toEqual([]);
        // A late "applied" is recorded as expired, not applied.
        const late = await reportDeviceCommandResult(TV, cmd.id, { status: 'applied' });
        expect(late.ok).toBe(false);
    });
});

describe('state', () => {
    const stateRecipients = (): string[] =>
        vi
            .mocked(publishUserEvent)
            .mock.calls.filter((c) => c[0].kind === 'device.state')
            .map((c) => c[0].userId);

    it('household helpers of the owner follow the state live too', async () => {
        invalidateHelpersCache('owner-with-helper');
        helperRows.rows = [{ user_id: 'helper-1' }];
        try {
            await reportDeviceState('owner-with-helper', TV, { nowPlaying: null });
            await vi.waitFor(() =>
                expect(stateRecipients()).toEqual(['owner-with-helper', 'helper-1']),
            );
        } finally {
            helperRows.rows = [];
        }
    });

    it('does not wait for the helper lookup: the report is stored and answered first', async () => {
        invalidateHelpersCache('slow-owner');
        let release: () => void = () => {};
        helperRows.gate = new Promise<void>((resolve) => (release = resolve));
        helperRows.rows = [{ user_id: 'helper-1' }];
        try {
            const result = await reportDeviceState('slow-owner', TV, { nowPlaying: null });
            expect(result.ok).toBe(true);
            // The owner has it; the helper lookup is still pending.
            expect(stateRecipients()).toEqual(['slow-owner']);
            release();
            await vi.waitFor(() => expect(stateRecipients()).toEqual(['slow-owner', 'helper-1']));
        } finally {
            helperRows.gate = null;
            helperRows.rows = [];
        }
    });

    it('a removed grant stops the fan-out as soon as the cache is invalidated', async () => {
        invalidateHelpersCache('owner-2');
        helperRows.rows = [{ user_id: 'helper-1' }];
        try {
            await reportDeviceState('owner-2', TV, { nowPlaying: null });
            await vi.waitFor(() => expect(stateRecipients()).toContain('helper-1'));

            // Grant removed: still cached for up to the TTL ...
            helperRows.rows = [];
            vi.mocked(publishUserEvent).mockClear();
            await reportDeviceState('owner-2', TV, { nowPlaying: null });
            await vi.waitFor(() => expect(stateRecipients()).toContain('helper-1'));

            // ... until the removal invalidates it.
            invalidateHelpersCache('owner-2');
            vi.mocked(publishUserEvent).mockClear();
            await reportDeviceState('owner-2', TV, { nowPlaying: null });
            await new Promise((r) => setTimeout(r, 20));
            expect(stateRecipients()).toEqual(['owner-2']);
        } finally {
            helperRows.rows = [];
        }
    });

    it('a lookup that began before an invalidation is not cached', async () => {
        invalidateHelpersCache('owner-3');
        let release: () => void = () => {};
        helperRows.gate = new Promise<void>((resolve) => (release = resolve));
        helperRows.rows = [{ user_id: 'helper-1' }];
        try {
            await reportDeviceState('owner-3', TV, { nowPlaying: null });
            // The grant is removed while that lookup is in flight.
            helperRows.rows = [];
            invalidateHelpersCache('owner-3');
            release();
            await new Promise((r) => setTimeout(r, 20));
            helperRows.gate = null;
            vi.mocked(publishUserEvent).mockClear();
            await reportDeviceState('owner-3', TV, { nowPlaying: null });
            await new Promise((r) => setTimeout(r, 20));
            expect(stateRecipients()).toEqual(['owner-3']);
        } finally {
            helperRows.gate = null;
            helperRows.rows = [];
        }
    });

    it('stores the report, stamps it and pushes device.state to the account', async () => {
        await reportDeviceState(OWNER, TV, {
            nowPlaying: {
                kind: 'livetv',
                sessionId: 'livetv:ch-7',
                title: 'Nordwelle',
                paused: false,
                rate: 1,
                availableCommands: ['livetv.channelUp'],
                livetv: { stationId: 'ch-7', feedId: 'feed-7', name: 'Nordwelle', number: 7 },
            },
            liveTvMode: 'simple',
        });
        const call = vi
            .mocked(publishUserEvent)
            .mock.calls.find((c) => c[0].kind === 'device.state');
        expect(call?.[0].userId).toBe(OWNER);
        expect(call?.[0].targetDeviceSessionId).toBeUndefined();
        const state = await buildDeviceState(TV);
        expect(state).toMatchObject({
            online: true,
            reachable: true,
            liveTvMode: 'simple',
            nowPlaying: { kind: 'livetv', reported: true, livetv: { number: 7 } },
        });
        expect(state.revision).toBeGreaterThan(0);
        expect(state.nowPlaying?.observedAt).toBeTypeOf('string');
    });

    it('falls back to the server projection when the device reports nothing', async () => {
        const state = await buildDeviceState(TV, {
            fallback: {
                project: async () => ({
                    kind: 'video',
                    sessionId: 'play-9',
                    title: '',
                    paused: true,
                    rate: 1,
                    reported: false,
                    availableCommands: [],
                }),
            },
        });
        expect(state.nowPlaying).toMatchObject({ sessionId: 'play-9', reported: false });
        expect(state.revision).toBe(0);
    });

    it('revisions only go up', async () => {
        const report = { nowPlaying: null };
        const a = await reportDeviceState(OWNER, TV, report);
        const b = await reportDeviceState(OWNER, TV, report);
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        expect(b.value.revision).toBeGreaterThan(a.value.revision);
        // Still not behind once the report itself expired.
        store.delete('devcmd:v1:state:' + TV);
        expect((await buildDeviceState(TV)).revision).toBe(b.value.revision);
    });
});

describe('review fixes', () => {
    it('a lost compare-and-set does not overwrite the winner (cancel vs applied)', async () => {
        const res = await send({ type: 'playback.pause' });
        if (!res.ok) throw new Error('send failed');
        const id = res.value.command.id;
        // The device's "applied" lands between the cancel's read and its write.
        cas.loseNext = true;
        expect(await cancelDeviceCommand(TV, id)).toMatchObject({
            ok: false,
            error: { kind: 'conflict' },
        });
        await reportDeviceCommandResult(TV, id, { status: 'applied' });
        const now = await getDeviceCommand(TV, id);
        expect(now.ok && now.value.status).toBe('applied');
    });

    it('two concurrent tunes: the older is superseded, never both', async () => {
        const tune = (n: number) =>
            send({
                type: 'livetv.tune',
                args: { stationId: `00000000-0000-4000-8000-00000000000${n}` },
            });
        const [a, b] = await Promise.all([tune(1), tune(2)]);
        if (!a.ok || !b.ok) throw new Error('send failed');
        const statuses = await Promise.all(
            [a, b].map(async (r) => {
                const c = await getDeviceCommand(TV, r.value.command.id);
                return c.ok ? c.value.status : 'missing';
            }),
        );
        expect(statuses.filter((st) => st === 'pending')).toHaveLength(1);
        expect(statuses.filter((st) => st === 'superseded')).toHaveLength(1);
    });

    it('a failed store releases the Idempotency-Key so the retry sends', async () => {
        const valkey = await import('$lib/server/cache/valkey.js');
        vi.mocked(valkey.setEx).mockResolvedValueOnce(false);
        expect(await send({ type: 'playback.pause' }, { idempotencyKey: 'k1' })).toMatchObject({
            ok: false,
            error: { kind: 'unavailable' },
        });
        const retry = await send({ type: 'playback.pause' }, { idempotencyKey: 'k1' });
        expect(retry.ok && retry.value.replayed).toBe(false);
    });

    it('a key reused for a different request is a conflict; an expired record still replays', async () => {
        const first = await send({ type: 'playback.pause' }, { idempotencyKey: 'k2' });
        if (!first.ok) throw new Error('send failed');
        expect(await send({ type: 'playback.resume' }, { idempotencyKey: 'k2' })).toMatchObject({
            ok: false,
            error: { kind: 'conflict' },
        });
        store.delete('devcmd:v1:cmd:' + first.value.command.id);
        const again = await send({ type: 'playback.pause' }, { idempotencyKey: 'k2' });
        expect(again.ok && again.value).toMatchObject({
            replayed: true,
            command: { id: first.value.command.id },
        });
    });

    it('limits messages separately from other commands', async () => {
        rateLimit.deniedPrefix = 'devcmd:msg:';
        expect(await send({ type: 'ui.message', args: { text: 'Hi' } })).toMatchObject({
            ok: false,
            error: { kind: 'rate_limited' },
        });
        expect((await send({ type: 'playback.pause' })).ok).toBe(true);
    });

    it('checks expect.queueRevision against the reported queue', async () => {
        announce(['queue.remove']);
        await reportDeviceState(OWNER, TV, {
            nowPlaying: {
                kind: 'music',
                sessionId: 'm1',
                title: 'Song',
                paused: false,
                rate: 1,
                availableCommands: ['queue.remove'],
                music: { trackId: 't1', queue: { items: [], index: 0, revision: 3 } },
            },
        });
        expect(
            await send({ type: 'queue.remove', args: { index: 1 }, expect: { queueRevision: 2 } }),
        ).toMatchObject({ ok: false, error: { kind: 'stale_target' } });
        expect(
            (await send({ type: 'queue.remove', args: { index: 1 }, expect: { queueRevision: 3 } }))
                .ok,
        ).toBe(true);
    });

    it('caps the commands waiting for one device', async () => {
        announce(['media.play'], true, false);
        for (let i = 0; i < INBOX_LIMIT; i++) {
            sets.set(
                'devcmd:v1:inbox:' + TV,
                new Set([...(sets.get('devcmd:v1:inbox:' + TV) ?? []), `x${i}`]),
            );
        }
        expect(
            await send({ type: 'media.play', args: { kind: 'movie', itemId: 'm' } }),
        ).toMatchObject({
            ok: false,
            error: { kind: 'rate_limited' },
        });
    });

    it('does not hand a received live command out again after a reconnect', async () => {
        const res = await send({ type: 'playback.seekBy', args: { seconds: 10 } });
        if (!res.ok) throw new Error('send failed');
        await reportDeviceCommandResult(TV, res.value.command.id, { status: 'delivered' });
        const inbox = await listDeviceInbox(TV);
        expect(inbox.ok && inbox.value).toEqual([]);
    });

    it('only accepts a button that was offered', async () => {
        const res = await send({
            type: 'ui.message',
            args: { text: 'OK?', actions: [{ id: 'yes', label: 'Yes' }] },
        });
        if (!res.ok) throw new Error('send failed');
        await reportDeviceCommandResult(TV, res.value.command.id, { status: 'applied' });
        expect(
            await reportDeviceCommandResult(TV, res.value.command.id, {
                status: 'acknowledged',
                actionId: 'stop',
            }),
        ).toMatchObject({ ok: false, error: { kind: 'invalid' } });
        expect(
            await reportDeviceCommandResult(TV, res.value.command.id, { status: 'acknowledged' }),
        ).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    });

    it('checks an offline device against the capabilities it announced last', async () => {
        announce([], false, false);
        await rememberCapabilities(TV, { commands: { 'livetv.tune': {} } });
        expect(
            await send({ type: 'media.play', args: { kind: 'movie', itemId: 'm' } }),
        ).toMatchObject({
            ok: false,
            error: { kind: 'device_unsupported' },
        });
        expect(
            (
                await send({
                    type: 'livetv.tune',
                    args: { stationId: '00000000-0000-4000-8000-000000000001' },
                })
            ).ok,
        ).toBe(true);
    });

    it('rate limits state reports', async () => {
        rateLimit.deniedPrefix = 'devstate:';
        expect(await reportDeviceState(OWNER, TV, { nowPlaying: null })).toMatchObject({
            ok: false,
            error: { kind: 'rate_limited' },
        });
    });

    it('a revoked device loses its commands, state and presence', async () => {
        const res = await send({ type: 'media.play', args: { kind: 'movie', itemId: 'm' } });
        if (!res.ok) throw new Error('send failed');
        await reportDeviceState(OWNER, TV, { nowPlaying: null });
        for (const listener of revokeListeners) listener([TV]);
        await new Promise((r) => setTimeout(r, 0));
        const cmd = await getDeviceCommand(TV, res.value.command.id);
        expect(cmd.ok && cmd.value.status).toBe('expired');
        expect(store.has('devcmd:v1:state:' + TV)).toBe(false);
        expect(sets.has('devcmd:v1:inbox:' + TV)).toBe(false);
        await forgetDevice(TV); // idempotent
    });

    it('state and status frames skip the replay buffer', async () => {
        await reportDeviceState(OWNER, TV, { nowPlaying: null });
        const res = await send({ type: 'playback.pause' });
        if (!res.ok) throw new Error('send failed');
        await reportDeviceCommandResult(TV, res.value.command.id, { status: 'applied' });
        for (const [opts] of vi.mocked(publishUserEvent).mock.calls) {
            if (opts.kind === 'device.state' || opts.kind === 'device.command_status') {
                expect(opts.replay).toBe(false);
            }
        }
    });
});

describe('household helper: who may see and cancel a command', () => {
    const HELPER = 'helper-1';
    const helperSender: CommandSender = { userId: HELPER, username: 'grandson', source: 'app' };

    it('a helper reads and cancels only the commands they sent; the owner sees all', async () => {
        const mine = await send({ type: 'playback.pause' }, { sender: helperSender });
        const owners = await send({ type: 'playback.stop' });
        if (!mine.ok || !owners.ok) throw new Error('send failed');
        const viewer = { onlySenderUserId: HELPER };

        expect((await getDeviceCommand(TV, mine.value.command.id, viewer)).ok).toBe(true);
        expect(await getDeviceCommand(TV, owners.value.command.id, viewer)).toMatchObject({
            ok: false,
            error: { kind: 'not_found' },
        });
        expect(await cancelDeviceCommand(TV, owners.value.command.id, viewer)).toMatchObject({
            ok: false,
            error: { kind: 'not_found' },
        });
        // Not cancelled by the refused attempt.
        const still = await getDeviceCommand(TV, owners.value.command.id);
        expect(still.ok && still.value.status).toBe('pending');

        expect((await cancelDeviceCommand(TV, mine.value.command.id, viewer)).ok).toBe(true);
        // The owner sees the helper's command too.
        expect((await getDeviceCommand(TV, mine.value.command.id)).ok).toBe(true);
    });
});

describe('cancelCommandsFromSender', () => {
    const HELPER = 'helper-1';
    const helperSender: CommandSender = { userId: HELPER, username: 'grandson', source: 'app' };

    afterEach(() => {
        helperRows.sessions = [];
    });

    it('cancels what a removed helper still has waiting on the owner’s devices, and only that', async () => {
        helperRows.sessions = [{ device_session_id: TV }];
        const later = new Date(Date.now() + 3_600_000).toISOString();
        const scheduled = await send(
            { type: 'playback.stop', notBefore: later },
            { sender: helperSender },
        );
        const live = await send({ type: 'playback.pause' }, { sender: helperSender });
        const ownersOwn = await send({ type: 'ui.message', args: { text: 'Dinner' } });
        if (!scheduled.ok || !live.ok || !ownersOwn.ok) throw new Error('send failed');
        vi.mocked(publishUserEvent).mockClear();

        expect(await cancelCommandsFromSender(OWNER, HELPER)).toBe(2);

        for (const c of [scheduled, live]) {
            const got = await getDeviceCommand(TV, c.value.command.id);
            expect(got.ok && got.value.status).toBe('cancelled');
        }
        const kept = await getDeviceCommand(TV, ownersOwn.value.command.id);
        expect(kept.ok && kept.value.status).toBe('pending');
        // The device is told to drop them.
        expect(publishedKinds().filter((k) => k === 'device.command_cancelled')).toHaveLength(2);
        const inbox = await listDeviceInbox(TV);
        expect(inbox.ok && inbox.value.map((c) => c.id)).toEqual([ownersOwn.value.command.id]);
    });

    it('does nothing (and does not throw) when the owner has no device or the lookup fails', async () => {
        helperRows.sessions = [];
        expect(await cancelCommandsFromSender(OWNER, HELPER)).toBe(0);
    });
});

describe('beginIdempotentSend (external providers)', () => {
    const request: DeviceCommandRequest = { type: 'playback.pause' };
    const input = { userId: OWNER, key: 'tap-9', deviceSessionId: 'jf:abc', request };
    const finalCommand = {
        id: 'cmd_00000000-0000-4000-8000-000000000009',
        deviceSessionId: 'jf:abc',
        type: 'playback.pause',
        args: {},
        delivery: 'live',
        source: 'app',
        sender: { username: 'alice' },
        status: 'applied',
        createdAt: '2026-10-16T20:00:00.000Z',
        updatedAt: '2026-10-16T20:00:00.000Z',
        expiresAt: '2026-10-16T20:05:00.000Z',
    } as never;

    it('claims a free key; a commit makes a repeat return the first command', async () => {
        const first = await beginIdempotentSend(input);
        if (!first.ok || !('claim' in first.value)) throw new Error('expected a claim');
        await first.value.claim.commit(finalCommand);
        const repeat = await beginIdempotentSend(input);
        expect(repeat).toEqual({
            ok: true,
            value: { replay: { command: finalCommand, replayed: true } },
        });
    });

    it('a different request or device under the same key is a conflict', async () => {
        const first = await beginIdempotentSend(input);
        if (!first.ok || !('claim' in first.value)) throw new Error('expected a claim');
        await first.value.claim.commit(finalCommand);
        expect(
            await beginIdempotentSend({ ...input, request: { type: 'playback.resume' } }),
        ).toMatchObject({ ok: false, error: { kind: 'conflict' } });
        expect(await beginIdempotentSend({ ...input, deviceSessionId: 'jf:other' })).toMatchObject({
            ok: false,
            error: { kind: 'conflict' },
        });
    });

    it('a repeat while the first is still running is a conflict, not a second send', async () => {
        const first = await beginIdempotentSend(input);
        expect(first.ok).toBe(true);
        expect(await beginIdempotentSend(input)).toMatchObject({
            ok: false,
            error: { kind: 'conflict' },
        });
    });

    it('releasing the claim frees the key for a retry', async () => {
        const first = await beginIdempotentSend(input);
        if (!first.ok || !('claim' in first.value)) throw new Error('expected a claim');
        await first.value.claim.release();
        const retry = await beginIdempotentSend(input);
        expect(retry.ok && 'claim' in retry.value).toBe(true);
    });

    it('keys are per user', async () => {
        await beginIdempotentSend(input);
        const other = await beginIdempotentSend({ ...input, userId: 'user-2' });
        expect(other.ok && 'claim' in other.value).toBe(true);
    });
});
