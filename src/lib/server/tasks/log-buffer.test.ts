// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for LogBuffer.
 * Mocks Valkey entirely — no live infrastructure required.
 *
 * Run with: npx vitest run src/lib/server/tasks/log-buffer.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogBuffer, type LogEntry } from './log-buffer.js';

vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: vi.fn(() => null),
    getCoordinationClient: vi.fn(() => null),
    subscribeToChannel: vi.fn(async () => null),
    publishMessage: vi.fn(async () => true),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// ── Fake Valkey client ────────────────────────────────────────────────────────

interface FakeStorage {
    lists: Map<string, string[]>;
    strings: Map<string, string>;
    pubsub: Array<{ channel: string; message: string }>;
}

function makeFakeClient(storage: FakeStorage): {
    customCommand: (cmd: string[]) => Promise<unknown>;
} {
    return {
        customCommand: async (cmd: string[]) => {
            const [op, ...args] = cmd;
            switch (op) {
                case 'LPUSH': {
                    const [key, value] = args;
                    const list = storage.lists.get(key) ?? [];
                    list.unshift(value);
                    storage.lists.set(key, list);
                    return list.length;
                }
                case 'LTRIM': {
                    const [key, start, end] = args;
                    const list = storage.lists.get(key) ?? [];
                    storage.lists.set(key, list.slice(Number(start), Number(end) + 1));
                    return 'OK';
                }
                case 'EXPIRE': {
                    return 1;
                }
                case 'LRANGE': {
                    const [key, start, end] = args;
                    const list = storage.lists.get(key) ?? [];
                    return list.slice(Number(start), Number(end) + 1);
                }
                case 'GET': {
                    return storage.strings.get(args[0]) ?? null;
                }
                case 'SET': {
                    // Support `SET key value [NX] [EX ttl]` semantics that the
                    // log-buffer marker write relies on.
                    const [key, value, ...rest] = args;
                    const upper = rest.map((r) => r.toUpperCase());
                    const isNx = upper.includes('NX');
                    if (isNx && storage.strings.has(key)) return null;
                    storage.strings.set(key, value);
                    return 'OK';
                }
                case 'INCRBY': {
                    const [key, amount] = args;
                    const current = Number(storage.strings.get(key) ?? '0');
                    const next = current + Number(amount);
                    storage.strings.set(key, String(next));
                    return next;
                }
                case 'INCR': {
                    const [key] = args;
                    const current = Number(storage.strings.get(key) ?? '0');
                    const next = current + 1;
                    storage.strings.set(key, String(next));
                    return next;
                }
                case 'PUBLISH': {
                    storage.pubsub.push({ channel: args[0], message: args[1] });
                    return 1;
                }
                default:
                    return null;
            }
        },
    };
}

// ── append + readRecent ───────────────────────────────────────────────────────

describe('LogBuffer.append + readRecent', () => {
    let storage: FakeStorage;
    let buf: LogBuffer;

    beforeEach(() => {
        storage = { lists: new Map(), strings: new Map(), pubsub: [] };
        const client = makeFakeClient(storage);
        // Pub/sub now goes through the injected publish seam (cache client in
        // prod) rather than the keyed client — record it so the live-tail
        // assertion still observes the channel/message.
        buf = new LogBuffer(
            () => client,
            async (channel, message) => {
                storage.pubsub.push({ channel, message: String(message) });
                return true;
            },
        );
    });

    it('round-trips a log entry', async () => {
        const entry: LogEntry = { ts: 1000, level: 'info', message: 'hello' };
        await buf.append('run_1', entry);

        const result = await buf.readRecent('run_1');
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            ts: 1000,
            level: 'info',
            message: 'hello',
        });
    });

    it('returns entries in chronological order (oldest first)', async () => {
        await buf.append('run_2', { ts: 100, level: 'info', message: 'a' });
        await buf.append('run_2', { ts: 200, level: 'info', message: 'b' });
        await buf.append('run_2', { ts: 300, level: 'info', message: 'c' });

        const result = await buf.readRecent('run_2');
        expect(result.map((e) => e.message)).toEqual(['a', 'b', 'c']);
    });

    it('respects count limit on readRecent', async () => {
        for (let i = 0; i < 10; i++) {
            await buf.append('run_3', {
                ts: i,
                level: 'info',
                message: `msg${i}`,
            });
        }
        const result = await buf.readRecent('run_3', 3);
        expect(result).toHaveLength(3);
    });

    it('publishes to the log-stream channel on append', async () => {
        await buf.append('run_4', {
            ts: 1,
            level: 'warn',
            message: 'watch out',
        });
        expect(storage.pubsub).toHaveLength(1);
        expect(storage.pubsub[0].channel).toBe('task:log-stream:run_4');
    });

    it('assigns a monotonic per-run seq so same-ms entries do not collide', async () => {
        // All three entries share ts=42 — previously their SSE ids
        // collided. With INCR seq each gets a unique id.
        await buf.append('run_seq', { ts: 42, level: 'info', message: 'a' });
        await buf.append('run_seq', { ts: 42, level: 'info', message: 'b' });
        await buf.append('run_seq', { ts: 42, level: 'info', message: 'c' });

        const result = await buf.readRecent('run_seq');
        expect(result.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it('sets EXPIRE on the list key', async () => {
        const spy = vi.spyOn(makeFakeClient(storage), 'customCommand');
        // Re-create with a spy.
        const spyClient = {
            customCommand: vi.fn(async (cmd: string[]) => {
                return makeFakeClient(storage).customCommand(cmd);
            }),
        };
        const spyBuf = new LogBuffer(() => spyClient);
        await spyBuf.append('run_ttl', { ts: 1, level: 'debug', message: 'x' });

        const expireCalls = spyClient.customCommand.mock.calls.filter(
            ([cmd]) => cmd[0] === 'EXPIRE',
        );
        expect(expireCalls.length).toBeGreaterThan(0);
        // TTL should be 24h in seconds.
        const listExpire = expireCalls.find(([cmd]) => cmd[1] === 'task:log:run_ttl');
        expect(listExpire).toBeDefined();
        expect(Number(listExpire?.[0][2])).toBe(24 * 3600);
        void spy; // silence unused warning
    });
});

// ── Per-line cap ──────────────────────────────────────────────────────────────

describe('LogBuffer per-line 4KB cap', () => {
    it('truncates message > 4KB with a marker', async () => {
        const storage: FakeStorage = {
            lists: new Map(),
            strings: new Map(),
            pubsub: [],
        };
        const buf = new LogBuffer(() => makeFakeClient(storage));

        const bigMsg = 'x'.repeat(5000);
        await buf.append('run_big', { ts: 1, level: 'info', message: bigMsg });

        const result = await buf.readRecent('run_big');
        expect(result).toHaveLength(1);
        expect(result[0].message).toContain('[truncated:');
        expect(result[0].message.length).toBeLessThan(bigMsg.length);
    });

    it('does not truncate messages under 4KB', async () => {
        const storage: FakeStorage = {
            lists: new Map(),
            strings: new Map(),
            pubsub: [],
        };
        const buf = new LogBuffer(() => makeFakeClient(storage));

        const msg = 'y'.repeat(100);
        await buf.append('run_small', { ts: 1, level: 'info', message: msg });

        const result = await buf.readRecent('run_small');
        expect(result[0].message).toBe(msg);
    });
});

// ── Per-run cap ───────────────────────────────────────────────────────────────

describe('LogBuffer per-run 4MB cap', () => {
    it('emits a single cap-exceeded marker and drops subsequent entries', async () => {
        const storage: FakeStorage = {
            lists: new Map(),
            strings: new Map(),
            pubsub: [],
        };
        const buf = new LogBuffer(() => makeFakeClient(storage));
        const PER_RUN_BYTES = 4 * 1024 * 1024;

        // Seed byte counter just under the cap so the first append pushes
        // total over the threshold and triggers the marker write.
        storage.strings.set('task:log-bytes:run_cap', String(PER_RUN_BYTES));

        // First append over cap → wins SETNX, writes marker.
        await buf.append('run_cap', {
            ts: 1,
            level: 'info',
            message: 'after-cap',
        });
        // Second append → SETNX loses, silently drops.
        await buf.append('run_cap', {
            ts: 2,
            level: 'info',
            message: 'dropped',
        });

        const list = storage.lists.get('task:log:run_cap') ?? [];
        // Only the cap-exceeded marker should be present, not 'after-cap' or 'dropped'.
        expect(list).toHaveLength(1);
        const marker = JSON.parse(list[0]) as LogEntry;
        expect(marker.message).toBe('[per-run-log-cap-exceeded]');
    });

    it('drops entries after cap is exceeded — marker is one-shot (SETNX)', async () => {
        const storage: FakeStorage = {
            lists: new Map(),
            strings: new Map(),
            pubsub: [],
        };
        const buf = new LogBuffer(() => makeFakeClient(storage));
        const PER_RUN_BYTES = 4 * 1024 * 1024;

        // Seed counter well over the cap with marker key already set —
        // simulates a prior appender that already won the SETNX race.
        storage.strings.set('task:log-bytes:run_over', String(PER_RUN_BYTES + 100));
        storage.strings.set('task:log-cap-marker:run_over', '1');

        await buf.append('run_over', {
            ts: 1,
            level: 'info',
            message: 'ignored',
        });

        const list = storage.lists.get('task:log:run_over') ?? [];
        // No marker, no entry — SETNX returned null, the appender bailed silently.
        expect(list).toHaveLength(0);
    });

    it('only one of N concurrent appenders writes the cap marker', async () => {
        const storage: FakeStorage = {
            lists: new Map(),
            strings: new Map(),
            pubsub: [],
        };
        const buf = new LogBuffer(() => makeFakeClient(storage));
        const PER_RUN_BYTES = 4 * 1024 * 1024;

        // Seed counter exactly at cap so every appender will push total over.
        storage.strings.set('task:log-bytes:run_race', String(PER_RUN_BYTES));

        // Fire 5 appends "concurrently" (the fake client is sync so this
        // simulates the TOCTOU window that the previous GET/SET dance had).
        await Promise.all([
            buf.append('run_race', { ts: 1, level: 'info', message: 'r1' }),
            buf.append('run_race', { ts: 2, level: 'info', message: 'r2' }),
            buf.append('run_race', { ts: 3, level: 'info', message: 'r3' }),
            buf.append('run_race', { ts: 4, level: 'info', message: 'r4' }),
            buf.append('run_race', { ts: 5, level: 'info', message: 'r5' }),
        ]);

        const list = storage.lists.get('task:log:run_race') ?? [];
        // Exactly one marker written across all racers.
        expect(list).toHaveLength(1);
        const marker = JSON.parse(list[0]) as LogEntry;
        expect(marker.message).toBe('[per-run-log-cap-exceeded]');
    });
});

// ── subscribe / unsubscribe ───────────────────────────────────────────────────

describe('LogBuffer.subscribe', () => {
    it('returns a no-op unsub when subscribeToChannel returns null', async () => {
        const { subscribeToChannel } = await import('$lib/server/cache/valkey.js');
        vi.mocked(subscribeToChannel).mockResolvedValueOnce(null);

        const storage: FakeStorage = {
            lists: new Map(),
            strings: new Map(),
            pubsub: [],
        };
        const buf = new LogBuffer(() => makeFakeClient(storage));

        const unsub = await buf.subscribe('run_nosub', () => {});
        await expect(unsub()).resolves.toBeUndefined();
    });

    it('delivers entries from subscribeToChannel callback', async () => {
        const callbacks: Array<(msg: string) => void> = [];
        const { subscribeToChannel } = await import('$lib/server/cache/valkey.js');
        vi.mocked(subscribeToChannel).mockImplementationOnce(async (_ch, cb) => {
            callbacks.push(cb);
            return async () => {};
        });

        const storage: FakeStorage = {
            lists: new Map(),
            strings: new Map(),
            pubsub: [],
        };
        const buf = new LogBuffer(() => makeFakeClient(storage));

        const received: LogEntry[] = [];
        await buf.subscribe('run_live', (e) => received.push(e));

        const entry: LogEntry = { ts: 999, level: 'error', message: 'boom' };
        for (const cb of callbacks) cb(JSON.stringify(entry));

        expect(received).toHaveLength(1);
        expect(received[0].message).toBe('boom');
    });
});
