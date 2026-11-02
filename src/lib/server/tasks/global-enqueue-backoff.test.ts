// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the global-identity non-progress backoff.
 *
 * Guards the prod incident (2026-07-08 → 2026-07-15) where `mdblist-sync` ran
 * 1,037×/day against a 12h schedule because 828 coverage rows could never clear,
 * and every 60s sweep tick re-enqueued a run that drained nothing.
 *
 * The two properties that matter, in tension:
 *   1. A non-progressing loop MUST be throttled (that's the incident).
 *   2. Genuine work must NEVER be throttled (that's the regression risk) —
 *      including every failure mode, which must fail OPEN.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const valkeyMock = vi.hoisted(() => ({ getCoordinationClient: vi.fn() }));
vi.mock('$lib/server/cache/valkey.js', () => valkeyMock);

import { shouldSkipGlobalEnqueue, fingerprintCandidates } from './global-enqueue-backoff.js';
import { BACKLOG_COUNT_CEILING } from '$lib/server/database/queries/stage-sweep.queries.js';

/** In-memory stand-in for the Glide coordination client. */
function makeClient(): {
    store: Map<string, string>;
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
} {
    const store = new Map<string, string>();
    return {
        store,
        get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
        set: vi.fn((k: string, v: string) => {
            store.set(k, v);
            return Promise.resolve('OK');
        }),
        del: vi.fn((keys: string[]) => {
            keys.forEach((k) => store.delete(k));
            return Promise.resolve(1);
        }),
    };
}

const STUCK = fingerprintCandidates(['a', 'b', 'c']);
const MOVED = fingerprintCandidates(['d', 'e', 'f']);

function call(over: Partial<Parameters<typeof shouldSkipGlobalEnqueue>[0]> = {}) {
    return shouldSkipGlobalEnqueue({
        taskId: 'mdblist-sync',
        stageId: 'mdblist-sync',
        backlog: 828,
        fingerprint: STUCK,
        scheduleEveryMs: 12 * 3_600_000,
        now: 1_000_000,
        ...over,
    });
}

describe('shouldSkipGlobalEnqueue', () => {
    let client: ReturnType<typeof makeClient>;

    beforeEach(() => {
        client = makeClient();
        valkeyMock.getCoordinationClient.mockReturnValue(client);
    });

    it('permits the first enqueue (no prior observation)', async () => {
        expect(await call()).toMatchObject({ skip: false, level: 0 });
    });

    it('throttles a run that cleared nothing — the incident signature', async () => {
        await call({ now: 1_000_000 });
        // Same head-of-backlog, same total: the run accomplished nothing.
        const second = await call({ now: 1_000_001 });
        expect(second.skip).toBe(false); // permitted, but now armed
        expect(second.level).toBe(1);

        // The next tick 60s later must be refused.
        const third = await call({ now: 1_060_001 });
        expect(third.skip).toBe(true);
    });

    it('escalates the delay and caps it at the declared schedule.every', async () => {
        let now = 1_000_000;
        let level = 0;
        // Drive many consecutive non-progressing rounds, always waiting out the
        // current delay, and confirm it saturates rather than growing forever.
        for (let i = 0; i < 12; i++) {
            const d = await call({ now });
            if (d.skip) {
                now += d.retryInMs ?? 0;
                continue;
            }
            level = d.level;
            now += 1;
        }
        const state = JSON.parse(
            client.store.get('task:coverage-backoff:mdblist-sync:mdblist-sync')!,
        );
        expect(level).toBeGreaterThan(3);
        // Cap is 12h; the delay must never exceed it.
        expect(state.nextAt - now).toBeLessThanOrEqual(12 * 3_600_000);
    });

    it('clears the backoff as soon as the backlog shrinks', async () => {
        await call({ now: 1_000_000 });
        await call({ now: 1_000_001 }); // level 1, armed
        // A later tick where work actually drained.
        const progressed = await call({ now: 9_000_000, backlog: 700 });
        expect(progressed).toMatchObject({ skip: false, level: 0 });
    });

    it('clears the backoff when the head-of-backlog changes even if the count grew', async () => {
        // A task draining 50 items while 60 arrive: count RISES, but the head
        // moved — that is real progress and must not be throttled.
        await call({ now: 1_000_000, backlog: 828, fingerprint: STUCK });
        const d = await call({ now: 1_000_001, backlog: 900, fingerprint: MOVED });
        expect(d).toMatchObject({ skip: false, level: 0 });
    });

    it('never throttles when the backlog is pinned at the count ceiling', async () => {
        // Progress is unmeasurable there (50k→40k both read as the ceiling).
        await call({ now: 1_000_000, backlog: BACKLOG_COUNT_CEILING });
        const d = await call({ now: 1_000_001, backlog: BACKLOG_COUNT_CEILING });
        expect(d).toMatchObject({ skip: false, level: 0 });
        expect(client.set).not.toHaveBeenCalled();
    });

    it('fails open when Valkey is unavailable', async () => {
        valkeyMock.getCoordinationClient.mockReturnValue(null);
        expect(await call()).toMatchObject({ skip: false, level: 0 });
    });

    it('fails open when the read throws', async () => {
        client.get.mockRejectedValue(new Error('connection reset'));
        expect(await call()).toMatchObject({ skip: false });
    });

    it('fails open on corrupt stored state', async () => {
        client.store.set('task:coverage-backoff:mdblist-sync:mdblist-sync', '{not json');
        expect(await call()).toMatchObject({ skip: false, level: 0 });
    });

    it('uses a coordination-routed key so state cannot be evicted', async () => {
        await call();
        const [key] = client.set.mock.calls[0];
        // `task:` is a COORDINATION_KEY_PREFIXES entry (noeviction instance).
        expect(key.startsWith('task:')).toBe(true);
    });

    it('falls back to a 1h cap for tasks declaring no schedule (metadata-update)', async () => {
        await call({ now: 1_000_000, scheduleEveryMs: null });
        await call({ now: 1_000_001, scheduleEveryMs: null });
        const state = JSON.parse(
            client.store.get('task:coverage-backoff:mdblist-sync:mdblist-sync')!,
        );
        expect(state.nextAt - 1_000_001).toBeLessThanOrEqual(3_600_000);
    });
});

describe('fingerprintCandidates', () => {
    it('is order-independent so a reordered page is not mistaken for progress', () => {
        expect(fingerprintCandidates(['b', 'a'])).toBe(fingerprintCandidates(['a', 'b']));
    });

    it('changes when any candidate changes', () => {
        expect(fingerprintCandidates(['a', 'b'])).not.toBe(fingerprintCandidates(['a', 'c']));
    });
});
