// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ Logger: { for: () => log } }));

import {
    OUTAGE_QUIET_MS,
    closeQueueEventsBounded,
    createOutageGate,
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
});

describe('logQueueConnectionErrors', () => {
    beforeEach(() => {
        resetQueueOutageGateForTests();
        log.warn.mockReset();
    });

    it('logs one warning for a flood of errors across many BullMQ objects', () => {
        const objects = Array.from({ length: 100 }, () => new EventEmitter());
        objects.forEach((o, i) => logQueueConnectionErrors(o, `task-queue-${i}`));
        for (let round = 0; round < 5; round++)
            for (const o of objects) o.emit('error', new Error('getaddrinfo ENOTFOUND valkey'));
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn.mock.calls[0][1]).toMatchObject({ err: 'getaddrinfo ENOTFOUND valkey' });
    });

    it('listens for errors, so BullMQ does not dump the raw error with console.error', () => {
        const queue = new EventEmitter();
        logQueueConnectionErrors(queue, 'q');
        expect(queue.listenerCount('error')).toBe(1);
    });

    it('ignores test doubles without an event API', () => {
        expect(() => logQueueConnectionErrors({}, 'q')).not.toThrow();
        expect(OUTAGE_QUIET_MS).toBeGreaterThan(0);
    });
});

describe('closeQueueEventsBounded', () => {
    it('returns true when close settles by itself', async () => {
        const qe = { close: vi.fn(async () => {}) };
        await expect(closeQueueEventsBounded(qe, 50)).resolves.toBe(true);
    });

    it('gives up on a close that never settles and stops the client reconnecting', async () => {
        const disconnect = vi.fn();
        const qe = {
            // BullMQ behaviour while Valkey is down: close() waits for an 'end' that never comes.
            close: vi.fn(() => new Promise<void>(() => {})),
            client: Promise.resolve({ disconnect }),
        };
        await expect(closeQueueEventsBounded(qe, 20)).resolves.toBe(false);
        expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('propagates a close that fails on its own', async () => {
        const qe = {
            close: vi.fn(async () => {
                throw new Error('boom');
            }),
        };
        await expect(closeQueueEventsBounded(qe, 50)).rejects.toThrow('boom');
    });
});
