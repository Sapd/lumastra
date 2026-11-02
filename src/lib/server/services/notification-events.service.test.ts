// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the cross-pod fan-out half of notification-events.service.
 *
 * The property under test is delivery COUNT, not just delivery: the pub/sub
 * subscriber runs on the publishing pod too, so the interesting failures are
 * "twice when Valkey is up" and "never when Valkey is down" — both invisible to
 * a test that only asserts "the consumer got something".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Consumer } from '$lib/server/utils/sse-replay-hub.js';

// ---------------------------------------------------------------------------
// Valkey mock — pub/sub callbacks + a coordination client for INCR/LPUSH
// ---------------------------------------------------------------------------

interface MockValkeyState {
    channels: Map<string, Set<(msg: string) => void>>;
    /** false → `publishMessage` resolves false, as it does with no client. */
    publishEnabled: boolean;
    /** true → `publishMessage` rejects, simulating a mid-call connection drop. */
    publishThrows: boolean;
    /** null → hub has no client: no INCR, no replay push (local fallback id). */
    coordinationClientAvailable: boolean;
    publishLog: Array<{ channel: string; message: string }>;
    commands: string[][];
    seq: number;
}

const mockState: MockValkeyState = {
    channels: new Map(),
    publishEnabled: true,
    publishThrows: false,
    coordinationClientAvailable: true,
    publishLog: [],
    commands: [],
    seq: 0,
};

vi.mock('$lib/server/cache/valkey.js', () => ({
    setIfNotExists: vi.fn(async () => true),
    publishMessage: vi.fn(async (channel: string, message: string) => {
        if (mockState.publishThrows) throw new Error('connection reset');
        mockState.publishLog.push({ channel, message });
        if (!mockState.publishEnabled) return false;
        const subs = mockState.channels.get(channel);
        if (subs) {
            // Dispatch out-of-band, like a real pub/sub round trip.
            for (const cb of subs) queueMicrotask(() => cb(message));
        }
        return true;
    }),
    subscribeToChannel: vi.fn(async (channel: string, callback: (msg: string) => void) => {
        let set = mockState.channels.get(channel);
        if (!set) {
            set = new Set();
            mockState.channels.set(channel, set);
        }
        set.add(callback);
        return async () => {
            set?.delete(callback);
        };
    }),
    getCoordinationClient: vi.fn(() => {
        if (!mockState.coordinationClientAvailable) return null;
        return {
            customCommand: async (cmd: string[]): Promise<unknown> => {
                mockState.commands.push(cmd);
                if (cmd[0] === 'INCR') return ++mockState.seq;
                return 'OK';
            },
        };
    }),
}));

// ---------------------------------------------------------------------------
// DB mock — models the coalescing unique index, not a stub
// ---------------------------------------------------------------------------

interface MockDbState {
    /** null → getDb() returns null (DB down / not configured). */
    available: boolean;
    /** Keys already present, as the unique index would hold them. */
    rows: Set<string>;
    /** Every insert ATTEMPT, conflicting or not. */
    attempts: string[];
    /** true → the insert throws instead of conflicting (DB failure, not conflict). */
    insertThrows: boolean;
    /** Monotonic source of the row ids the mock hands back on `inserted`. */
    nextRowId: number;
}

const mockDb: MockDbState = {
    available: true,
    rows: new Set(),
    attempts: [],
    insertThrows: false,
    nextRowId: 0,
};

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => (mockDb.available ? ({} as unknown) : null)),
}));

vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    insertNotification: vi.fn(
        async (_sql: unknown, opts: { userId: string; kind: string; payload?: unknown }) => {
            const coalesceKey = (opts.payload as { coalesceKey?: string } | undefined)?.coalesceKey;
            const key = `${opts.userId}|${opts.kind}|${coalesceKey ?? ''}`;
            mockDb.attempts.push(key);
            // Yield, so two concurrent publishes actually interleave here rather
            // than running to completion one after the other.
            await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
            if (mockDb.insertThrows) throw new Error('connection terminated');
            // A real INSERT ... RETURNING hands back the row's server-generated
            // id, and `publishUserEvent` puts it on the frame — so the mock has
            // to produce one or the `notificationId` contract is untestable.
            const row = { id: `notif-${++mockDb.nextRowId}` };
            // No coalesceKey → the partial index does not apply; always inserts.
            if (coalesceKey === undefined) return { inserted: true, row };
            if (mockDb.rows.has(key)) return { inserted: false, row: null };
            mockDb.rows.add(key);
            return { inserted: true, row };
        },
    ),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
        }),
    },
}));

// This file tests the "Valkey is up" world: every count below assumes the
// cross-pod subscriber is registered, because the point is that the subscriber
// runs on the PUBLISHING pod too. The service only subscribes when a cache URL
// is configured (a cacheless install has no cross-pod anything to subscribe
// for), so say so explicitly rather than inheriting whatever the runner's
// environment happens to hold. The valkey module is fully mocked above — no
// connection is attempted at this URL.
process.env.CACHE_URL = 'redis://localhost:6379';

// Import after the mocks so the module-level subscribeToChannel call lands on
// the mock and registers into mockState.channels.
const { publishUserEvent, userEventsHub } = await import('./notification-events.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

interface CapturedConsumer {
    frames: string[];
    consumer: Consumer;
}

/** Register a live (post-replay) consumer scoped to one user. */
function addConsumer(targetUserId: string): CapturedConsumer {
    const frames: string[] = [];
    const consumer: Consumer = {
        controller: {
            enqueue: (chunk: Uint8Array): void => {
                frames.push(decoder.decode(chunk));
            },
        } as unknown as ReadableStreamDefaultController<Uint8Array>,
        localBuffer: [],
        replayDone: true,
        targetUserId,
    };
    userEventsHub.consumers.add(consumer);
    return { frames, consumer };
}

/** Let queueMicrotask-dispatched pub/sub callbacks run. */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    userEventsHub.consumers.clear();
    mockState.publishEnabled = true;
    mockState.publishThrows = false;
    mockState.coordinationClientAvailable = true;
    mockState.publishLog = [];
    mockState.commands = [];
    mockState.seq = 0;
    mockDb.available = true;
    mockDb.rows.clear();
    mockDb.attempts = [];
    mockDb.insertThrows = false;
    mockDb.nextRowId = 0;
});

/** The `data:` line of an SSE frame, parsed back into the payload object. */
function framePayload(raw: string): Record<string, unknown> {
    const line = raw.split('\n').find((l) => l.startsWith('data: '));
    if (!line) throw new Error(`frame carried no data line: ${raw}`);
    return JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('publishUserEvent cross-pod fan-out', () => {
    it('stores a Jellyfin token notice without a request-derived URL', async () => {
        const { notifyJellyfinPatDenied } = await import('./jellyfin-token-notice.service.js');
        // Model a forged request origin, including the old service input for regression coverage.
        const notice = { userId: 'user-a', tokenId: 42, origin: 'https://phishing.example' };
        await notifyJellyfinPatDenied(notice);
        const { insertNotification } =
            await import('$lib/server/database/queries/user-notifications.queries.js');
        expect(mockDb.attempts).toHaveLength(1);
        const stored = vi.mocked(insertNotification).mock.calls.at(-1)?.[1];
        expect(stored).toMatchObject({
            userId: 'user-a',
            kind: 'jellyfin.readonly_token',
            payload: {},
        });
        expect(JSON.stringify(stored)).not.toContain('phishing.example');
        expect(stored?.payload).not.toHaveProperty('linkUrl');
    });

    it('delivers locally when Valkey is unavailable (subscriber never fires)', async () => {
        mockState.coordinationClientAvailable = false;
        mockState.publishEnabled = false;
        const a = addConsumer('user-a');

        await publishUserEvent({
            userId: 'user-a',
            kind: 'device.state',
            data: { deviceId: 'dev-1' },
        });
        await flush();

        expect(a.frames).toHaveLength(1);
        expect(a.frames[0]).toContain('event: device.state');
        expect(a.frames[0]).toContain('"deviceId":"dev-1"');
    });

    it('delivers exactly once when Valkey is available (no double-delivery)', async () => {
        const a = addConsumer('user-a');

        await publishUserEvent({
            userId: 'user-a',
            kind: 'device.state',
            data: { deviceId: 'dev-1' },
        });
        await flush();

        // One publish, one delivery: the broadcast lives in the subscriber, so
        // publishUserEvent must NOT also broadcast on the emitting pod.
        expect(mockState.publishLog).toHaveLength(1);
        expect(mockState.publishLog[0].channel).toBe('user:events:frames');
        expect(a.frames).toHaveLength(1);
        // Frame id comes from the Valkey INCR, not the local fallback counter.
        expect(mockState.commands.some((cmd) => cmd[0] === 'INCR')).toBe(true);
        expect(a.frames[0]).toContain('id: 1\n');
    });

    it('reaches only the consumer whose targetUserId matches', async () => {
        const a = addConsumer('user-a');
        const b = addConsumer('user-b');

        await publishUserEvent({
            userId: 'user-a',
            kind: 'device.state',
            data: { deviceId: 'dev-1' },
        });
        await flush();

        expect(a.frames).toHaveLength(1);
        expect(a.frames[0]).toContain('"targetUserId":"user-a"');
        expect(b.frames).toHaveLength(0);
    });

    it('falls back to local delivery when the publish call itself rejects', async () => {
        mockState.publishThrows = true;
        const a = addConsumer('user-a');

        // Resolves rather than rejecting — that is the point of the assertion.
        // The value it resolves TO is `'not-applicable'`: a signal kind has no
        // durable row, so there is no persist outcome to report and a Valkey
        // publish failure is not one either.
        await expect(
            publishUserEvent({
                userId: 'user-a',
                kind: 'device.state',
                data: { deviceId: 'dev-1' },
            }),
        ).resolves.toBe('not-applicable');
        await flush();

        expect(a.frames).toHaveLength(1);
    });

    it('pushes to the replay LIST before delivering', async () => {
        addConsumer('user-a');

        await publishUserEvent({
            userId: 'user-a',
            kind: 'device.state',
            data: {},
        });
        await flush();

        // Ordering matters on reconnect: a consumer that reads Last-Event-ID
        // right after a live frame must find that frame already in the LIST.
        const pushIndex = mockState.commands.findIndex((cmd) => cmd[0] === 'LPUSH');
        expect(pushIndex).toBeGreaterThanOrEqual(0);
        expect(mockState.publishLog).toHaveLength(1);
    });
});

describe('publishUserEvent device-addressed frames (remote control)', () => {
    it('never pushes them to the replay LIST and delivers them only to that device', async () => {
        const tv = addConsumer('user-a');
        tv.consumer.targetDeviceSessionId = 'tv-1';
        const ipad = addConsumer('user-a');
        ipad.consumer.targetDeviceSessionId = 'ipad-1';

        await publishUserEvent({
            userId: 'user-a',
            targetDeviceSessionId: 'tv-1',
            kind: 'device.command',
            data: { id: 'cmd_1' },
            persist: false,
        });
        await flush();

        expect(mockState.commands.some((cmd) => cmd[0] === 'LPUSH')).toBe(false);
        expect(tv.frames).toHaveLength(1);
        expect(ipad.frames).toHaveLength(0);
    });
});

describe('publishUserEvent durable-insert arbitration', () => {
    const newEpisode = (userId: string, coalesceKey: string) => ({
        userId,
        kind: 'library.new_episode',
        persist: true,
        data: { seriesId: 's1', coalesceKey },
    });

    it('two CONCURRENT emits for one coalesce key produce one row and ONE broadcast', async () => {
        const a = addConsumer('user-a');

        // Genuinely concurrent — this is the shape the outbox dispatcher
        // actually produces: it shards by hashtext(media_item_id) and drains
        // shards in parallel, so two episodes of one season are handled at the
        // same time on an 8+ core host. Sequential emits pass even with the
        // broadcast-before-persist ordering, which is exactly why this went
        // unnoticed.
        await Promise.all([
            publishUserEvent(newEpisode('user-a', 'series:s1:s2')),
            publishUserEvent(newEpisode('user-a', 'series:s1:s2')),
        ]);
        await flush();

        expect(mockDb.attempts).toHaveLength(2); // both tried
        expect(mockDb.rows.size).toBe(1); // the index kept one
        expect(a.frames).toHaveLength(1); // …and so did the user
    });

    it('does not burn a replay slot or a publish on the losing emit', async () => {
        addConsumer('user-a');

        await Promise.all([
            publishUserEvent(newEpisode('user-a', 'series:s1:s2')),
            publishUserEvent(newEpisode('user-a', 'series:s1:s2')),
        ]);
        await flush();

        // The replay LIST is bounded (500) and SHARED across all users, so an
        // undelivered frame must not evict another user's.
        expect(mockState.commands.filter((cmd) => cmd[0] === 'LPUSH')).toHaveLength(1);
        expect(mockState.publishLog).toHaveLength(1);
    });

    it('still delivers distinct coalesce keys', async () => {
        const a = addConsumer('user-a');

        await Promise.all([
            publishUserEvent(newEpisode('user-a', 'series:s1:s2')),
            publishUserEvent(newEpisode('user-a', 'series:s1:s3')),
        ]);
        await flush();

        expect(a.frames).toHaveLength(2);
    });

    it('delivers to each user separately for the same coalesce key', async () => {
        const a = addConsumer('user-a');
        const b = addConsumer('user-b');

        await Promise.all([
            publishUserEvent(newEpisode('user-a', 'series:s1:s2')),
            publishUserEvent(newEpisode('user-b', 'series:s1:s2')),
        ]);
        await flush();

        expect(a.frames).toHaveLength(1);
        expect(b.frames).toHaveLength(1);
    });

    it('broadcasts anyway when the insert FAILS (failure is not a conflict)', async () => {
        mockDb.insertThrows = true;
        const a = addConsumer('user-a');

        await publishUserEvent(newEpisode('user-a', 'series:s1:s2'));
        await flush();

        // A conflict means "already delivered"; a failure means "we don't know".
        // Suppressing here would turn a Postgres outage into total silence.
        expect(a.frames).toHaveLength(1);
    });

    it('broadcasts anyway when the DB is unavailable', async () => {
        mockDb.available = false;
        const a = addConsumer('user-a');

        await publishUserEvent(newEpisode('user-a', 'series:s1:s2'));
        await flush();

        expect(mockDb.attempts).toHaveLength(0);
        expect(a.frames).toHaveLength(1);
    });

    it('keeps watch signals as direct payloads and isolates cross-pod delivery to their user', async () => {
        const a = addConsumer('user-a');
        const b = addConsumer('user-b');
        await publishUserEvent({
            userId: 'user-a',
            kind: 'watch_state_set_changed',
            persist: false,
            replay: false,
            data: {
                type: 'watch_state_set_changed',
                mediaId: 'ep-1',
                reason: 'sync_import',
                at: 123,
            },
        });
        await flush();
        expect(a.frames).toHaveLength(1);
        expect(b.frames).toHaveLength(0);
        expect(a.frames[0]).toContain('"mediaId":"ep-1"');
        expect(a.frames[0]).not.toContain('"data":');
        expect(mockDb.attempts).toHaveLength(0);
        expect(mockState.commands.some((cmd) => cmd[0] === 'LPUSH')).toBe(false);
    });

    it('leaves signal kinds on the broadcast-only path (no DB dependency)', async () => {
        mockDb.available = false;
        const a = addConsumer('user-a');

        await publishUserEvent({
            userId: 'user-a',
            kind: 'device.state',
            data: { deviceId: 'dev-1' },
        });
        await flush();

        expect(mockDb.attempts).toHaveLength(0);
        expect(a.frames).toHaveLength(1);
    });
});

describe('publishUserEvent notificationId on the live frame', () => {
    const newEpisode = (userId: string, coalesceKey: string) => ({
        userId,
        kind: 'library.new_episode',
        persist: true,
        data: { seriesId: 's1', coalesceKey },
    });

    it('carries the durable row id when the insert succeeded', async () => {
        const a = addConsumer('user-a');

        await publishUserEvent(newEpisode('user-a', 'series:s1:s2'));
        await flush();

        // The whole point: a client holding this frame can hydrate the fully
        // rendered row from GET /notifications/{id} rather than re-deriving a
        // view out of `data`.
        expect(framePayload(a.frames[0]).notificationId).toBe('notif-1');
    });

    it('omits it when the insert FAILED — there is no row to name', async () => {
        mockDb.insertThrows = true;
        const a = addConsumer('user-a');

        await publishUserEvent(newEpisode('user-a', 'series:s1:s2'));
        await flush();

        // The frame still goes out (a failure is not a conflict), but naming a
        // row that was never written would hand the client a 404 on hydrate.
        expect(a.frames).toHaveLength(1);
        expect(framePayload(a.frames[0])).not.toHaveProperty('notificationId');
    });

    it('omits it when the DB is unavailable', async () => {
        mockDb.available = false;
        const a = addConsumer('user-a');

        await publishUserEvent(newEpisode('user-a', 'series:s1:s2'));
        await flush();

        expect(framePayload(a.frames[0])).not.toHaveProperty('notificationId');
    });

    it('omits it for a signal kind, which never has a durable row', async () => {
        const a = addConsumer('user-a');

        await publishUserEvent({
            userId: 'user-a',
            kind: 'device.state',
            data: { deviceId: 'dev-1' },
        });
        await flush();

        // "present iff durable row" is the contract — a signal-class frame must
        // never let a client ask the inbox about something that was never in it.
        expect(framePayload(a.frames[0])).not.toHaveProperty('notificationId');
    });

    it('does not leak the winner’s id onto a coalesced duplicate', async () => {
        const a = addConsumer('user-a');

        await Promise.all([
            publishUserEvent(newEpisode('user-a', 'series:s1:s2')),
            publishUserEvent(newEpisode('user-a', 'series:s1:s2')),
        ]);
        await flush();

        // The conflicting emit returns before delivery, so exactly one frame
        // exists and it names the row that was actually written.
        expect(a.frames).toHaveLength(1);
        expect(framePayload(a.frames[0]).notificationId).toBe('notif-1');
    });
});

describe('user-events pub/sub subscriber', () => {
    /** The subscriber registered at module init, for direct malformed-input tests. */
    function subscriberCallback(): (msg: string) => void {
        const subs = mockState.channels.get('user:events:frames');
        expect(subs).toBeDefined();
        const [cb] = Array.from(subs ?? []);
        expect(cb).toBeDefined();
        return cb;
    }

    it('drops a frame with no targetUserId rather than fanning it to everyone', async () => {
        const a = addConsumer('user-a');
        const b = addConsumer('user-b');

        // The hub treats a targetUserId-less frame as global, so accepting one
        // off the wire would leak one user's notification to all of them.
        subscriberCallback()(
            JSON.stringify({ id: 7, type: 'library.new_episode', data: { seriesId: 's1' } }),
        );
        await flush();

        expect(a.frames).toHaveLength(0);
        expect(b.frames).toHaveLength(0);
    });

    it('ignores malformed messages without throwing', async () => {
        const a = addConsumer('user-a');
        const cb = subscriberCallback();

        expect(() => cb('not json')).not.toThrow();
        expect(() => cb(JSON.stringify({ id: 'nope', type: 'x', data: {} }))).not.toThrow();
        expect(() => cb(JSON.stringify({ id: 1, data: { targetUserId: 'user-a' } }))).not.toThrow();
        await flush();

        expect(a.frames).toHaveLength(0);
    });
});
