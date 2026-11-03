// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { EventEmitter } from 'node:events';
import { QueueEvents } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ Logger: { for: () => log } }));

import {
    OUTAGE_QUIET_MS,
    closeQueueEventsBounded,
    createOutageGate,
    isConnectionLossError,
    logQueueConnectionErrors,
    resetQueueOutageGateForTests,
} from './queue-outage.js';

describe('createOutageGate', () => {
    it('reports only the first error of an outage and carries the suppressed count over', () => {
        const gate = createOutageGate(1000);
        expect(gate.note(0)).toEqual({ first: true, suppressed: 0 });
        expect(gate.note(100).first).toBe(false);
        expect(gate.note(900).first).toBe(false);
        // Errors keep arriving: the outage is not over, however long it lasts.
        expect(gate.note(1800).first).toBe(false);
        // Quiet for longer than the window: the next error is a new outage.
        expect(gate.note(3000)).toEqual({ first: true, suppressed: 3 });
    });

    it('calls onEnd once the outage has been quiet for the window', () => {
        vi.useFakeTimers();
        try {
            const onEnd = vi.fn();
            const gate = createOutageGate(1000, onEnd);
            gate.note();
            vi.advanceTimersByTime(600);
            gate.note();
            vi.advanceTimersByTime(900);
            expect(onEnd).not.toHaveBeenCalled();
            vi.advanceTimersByTime(200);
            expect(onEnd).toHaveBeenCalledTimes(1);
            expect(onEnd).toHaveBeenCalledWith({ durationMs: 600, errors: 2 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the quiet window above BullMQ longest reconnect delay (20 s)', () => {
        expect(OUTAGE_QUIET_MS).toBeGreaterThan(20_000);
    });
});

describe('isConnectionLossError', () => {
    it.each([
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:6379'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('getaddrinfo ENOTFOUND lumastra-valkey'), { code: 'ENOTFOUND' }),
        new Error('Connection is closed.'),
        new Error('LOADING Valkey is loading the dataset in memory'),
        new Error('READONLY You can’t write against a read only replica.'),
    ])('treats %s as connection loss', (err) => {
        expect(isConnectionLossError(err)).toBe(true);
    });

    it.each([
        new Error('NOAUTH Authentication required.'),
        new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
        new Error("OOM command not allowed when used memory > 'maxmemory'."),
        new Error('ERR Error running script'),
    ])('does not treat %s as connection loss', (err) => {
        expect(isConnectionLossError(err)).toBe(false);
    });
});

describe('logQueueConnectionErrors', () => {
    beforeEach(() => {
        resetQueueOutageGateForTests();
        log.warn.mockReset();
    });

    it('logs one warning for a flood of connection errors across many BullMQ objects', () => {
        const objects = Array.from({ length: 100 }, () => new EventEmitter());
        objects.forEach((o, i) => logQueueConnectionErrors(o, `task-queue-${i}`));
        for (let round = 0; round < 5; round++)
            for (const o of objects) o.emit('error', new Error('getaddrinfo ENOTFOUND valkey'));
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn.mock.calls[0][1]).toMatchObject({ err: 'getaddrinfo ENOTFOUND valkey' });
    });

    it('still logs a non-connection error that arrives inside an outage window', () => {
        const queue = new EventEmitter();
        logQueueConnectionErrors(queue, 'q');
        queue.emit('error', new Error('connect ECONNREFUSED 10.0.0.1:6379'));
        queue.emit('error', new Error('connect ECONNREFUSED 10.0.0.1:6379'));
        queue.emit('error', new Error('NOAUTH Authentication required.'));
        queue.emit('error', new Error('WRONGTYPE Operation against a key'));
        const messages = log.warn.mock.calls.map((c) => [c[0], (c[1] as { err: string }).err]);
        expect(messages).toEqual([
            [expect.stringContaining('connection error'), expect.stringContaining('ECONNREFUSED')],
            ['Task Valkey error', 'NOAUTH Authentication required.'],
            ['Task Valkey error', 'WRONGTYPE Operation against a key'],
        ]);
    });

    it('listens for errors, so BullMQ does not dump the raw error with console.error', () => {
        const queue = new EventEmitter();
        logQueueConnectionErrors(queue, 'q');
        expect(queue.listenerCount('error')).toBe(1);
    });

    it('ignores test doubles without an event API', () => {
        expect(() => logQueueConnectionErrors({}, 'q')).not.toThrow();
    });
});

describe('closeQueueEventsBounded', () => {
    it('returns true when close settles by itself', async () => {
        const qe = { close: vi.fn(async () => {}) };
        await expect(closeQueueEventsBounded(qe, 50)).resolves.toBe(true);
    });

    it('propagates a close that fails on its own', async () => {
        const qe = {
            close: vi.fn(async () => {
                throw new Error('boom');
            }),
        };
        await expect(closeQueueEventsBounded(qe, 50)).rejects.toThrow('boom');
    });

    it('stops the clients reached through getBackend() after a forced close', async () => {
        const disconnect = vi.fn();
        const blockingDisconnect = vi.fn();
        const qe = {
            close: vi.fn(() => new Promise<void>(() => {})),
            // BullMQ 6 exposes no `client` on QueueEvents itself, only on its backend.
            getBackend: () => ({
                client: Promise.resolve({ disconnect }),
                blockingClient: Promise.resolve({ disconnect: blockingDisconnect }),
            }),
        };
        await expect(closeQueueEventsBounded(qe, 20)).resolves.toBe(false);
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(blockingDisconnect).toHaveBeenCalledTimes(1);
    });

    describe('against a real QueueEvents whose server is unreachable', () => {
        interface Reconnecting {
            reconnectTimeout: unknown;
            status: string;
            on(event: 'connecting', listener: () => void): unknown;
        }
        let qe: QueueEvents | undefined;

        afterEach(async () => {
            // Make sure nothing keeps the test process alive if an assertion failed.
            const backend = qe?.getBackend() as unknown as {
                connection?: { _client?: { disconnect(): void } };
                blockingConnection?: { _client?: { disconnect(): void } };
            };
            backend?.connection?._client?.disconnect();
            backend?.blockingConnection?._client?.disconnect();
        });

        it('returns within the bound and leaves no client reconnecting', async () => {
            qe = new QueueEvents('outage-test', {
                // Port 1 refuses at once; BullMQ's own retry strategy then keeps retrying.
                connection: {
                    host: '127.0.0.1',
                    port: 1,
                    maxRetriesPerRequest: null,
                    enableReadyCheck: false,
                },
                prefix: 'bull:outage-test',
            });
            qe.on('error', () => {});
            const backend = qe.getBackend() as unknown as {
                connection?: { _client: Reconnecting };
                blockingConnection?: { _client: Reconnecting };
            };
            // QueueEvents may own one connection or a command and a blocking one.
            const clients = [
                backend.connection?._client,
                backend.blockingConnection?._client,
            ].filter((c): c is Reconnecting => c !== undefined);
            expect(clients.length).toBeGreaterThan(0);
            // Wait until ioredis has scheduled its next reconnect on both clients.
            for (let i = 0; i < 100 && clients.some((c) => !c.reconnectTimeout); i++)
                await new Promise((r) => setTimeout(r, 50));
            expect(clients.every((c) => c.reconnectTimeout)).toBe(true);

            const startedAt = Date.now();
            await expect(closeQueueEventsBounded(qe, 200)).resolves.toBe(false);
            expect(Date.now() - startedAt).toBeLessThan(2_000);

            // No retry timer left: nothing will reconnect or hold the event loop.
            expect(clients.map((c) => c.reconnectTimeout)).toEqual(clients.map(() => null));
            let attempts = 0;
            for (const c of clients) c.on('connecting', () => attempts++);
            await new Promise((r) => setTimeout(r, 2_500));
            expect(attempts).toBe(0);
        }, 20_000);
    });
});
