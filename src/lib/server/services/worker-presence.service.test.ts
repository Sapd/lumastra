// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';

const logs = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
    Logger: { for: () => ({ error: logs.error, info: logs.info, debug: logs.debug }) },
}));

import {
    createWorkerPresenceMonitor,
    MISSES_BEFORE_MISSING,
    WORKER_PRESENCE_GRACE_MS,
} from './worker-presence.service.js';

async function checkTimes(m: { check: () => Promise<void> }, n: number): Promise<void> {
    for (let i = 0; i < n; i++) await m.check();
}

function monitor(counts: Array<number | null>) {
    let now = 1_000_000;
    const countWorkers = vi.fn(async () => (counts.length > 1 ? counts.shift()! : counts[0]));
    const m = createWorkerPresenceMonitor({ countWorkers, now: () => now });
    return {
        m,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

describe('worker presence', () => {
    it('stays "starting" inside the grace period even with no worker', async () => {
        const { m } = monitor([0]);
        await m.check();
        expect(m.get().status).toBe('starting');
        expect(logs.error).not.toHaveBeenCalled();
    });

    it('needs consecutive empty checks after the grace period, then logs ONE error per outage', async () => {
        logs.error.mockClear();
        const { m, advance } = monitor([0, 0, 0, 0, 1, 0, 0, 0]);
        advance(WORKER_PRESENCE_GRACE_MS + 1);
        await checkTimes(m, MISSES_BEFORE_MISSING - 1);
        expect(m.get().status).toBe('starting');
        await m.check();
        expect(m.get().status).toBe('missing');
        await m.check();
        expect(logs.error).toHaveBeenCalledTimes(1);
        await m.check();
        expect(m.get()).toMatchObject({ status: 'present', workers: 1 });
        // A worker restart (a short gap) keeps "present" and raises nothing.
        await checkTimes(m, MISSES_BEFORE_MISSING - 1);
        expect(m.get().status).toBe('present');
        await m.check();
        expect(m.get().status).toBe('missing');
        expect(logs.error).toHaveBeenCalledTimes(2);
    });

    it('a task Valkey outage is "unknown", never "missing"', async () => {
        logs.error.mockClear();
        const { m, advance } = monitor([null]);
        advance(WORKER_PRESENCE_GRACE_MS + 1);
        await checkTimes(m, MISSES_BEFORE_MISSING + 1);
        expect(m.get().status).toBe('unknown');
        expect(logs.error).not.toHaveBeenCalled();
    });

    it('a Valkey blip during an outage neither clears nor re-logs it', async () => {
        logs.error.mockClear();
        const { m, advance } = monitor([0, 0, 0, null, 0]);
        advance(WORKER_PRESENCE_GRACE_MS + 1);
        await checkTimes(m, MISSES_BEFORE_MISSING);
        expect(m.get().status).toBe('missing');
        await m.check();
        expect(m.get().status).toBe('missing');
        await m.check();
        expect(m.get().status).toBe('missing');
        expect(logs.error).toHaveBeenCalledTimes(1);
    });
});
