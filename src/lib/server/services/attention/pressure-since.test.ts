// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pressure clocks. A condition keeps its clock (first seen) and its last
 * snapshot while it is absent for up to 3 minutes; a longer gap drops it, so the
 * next sighting starts a new clock. The earliest clock across Valkey and this
 * process wins, and losing both only restarts the clock (the alert comes later,
 * never falsely early).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
const store = vi.hoisted(() => new Map<string, string>());

vi.mock('$lib/server/cache/valkey.js', () => ({
    cacheGet: cache.get,
    cacheSet: cache.set,
}));

import type { PressureCondition } from './adapters.js';

import { resetPressureSinceForTests, trackPressureSince } from './pressure-since.js';

const KEY = 'v3:attention:resource-pressure-since';
/** Absent this long still counts as continuing (PRESSURE_GAP_GRACE_MS). */
const GRACE = 3 * 60_000;

function condition(label: string): PressureCondition {
    return {
        key: 'container:a',
        subject: 'a',
        kind: 'container',
        level: 'warn',
        ratio: 0.9,
        where: label,
    };
}

function active(entries: Record<string, string>): Map<string, PressureCondition> {
    return new Map(Object.entries(entries).map(([key, label]) => [key, condition(label)]));
}

/** A Valkey stand-in: what cacheSet stores, cacheGet returns. */
function workingCache(): void {
    cache.get.mockReset().mockImplementation(async (key: string) => store.get(key) ?? null);
    cache.set.mockReset().mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
        return true;
    });
}

beforeEach(() => {
    store.clear();
    resetPressureSinceForTests();
    workingCache();
});

describe('trackPressureSince', () => {
    it.each([
        { first: 1_000, last: 60_000 },
        { first: 1_000, last: 60_000, value: null },
        { first: 1_000, last: 60_000, value: 'invalid' },
        { first: 1_000, last: 60_000, value: {} },
        { first: 1_000, last: 60_000, value: { ...condition('bad'), kind: 'unknown' } },
        { first: 1_000, last: 60_000, value: { ...condition('bad'), ratio: null } },
    ])('drops malformed stored clock %j inside the grace window', async (broken) => {
        const good = { first: 1_000, last: 60_000, value: condition('good') };
        store.set(KEY, JSON.stringify({ broken, good }));

        const out = await trackPressureSince(new Map(), 120_000);

        expect(out.has('broken')).toBe(false);
        expect(out.get('good')).toEqual(good);
    });

    it('a first sighting starts the clock now and returns the value', async () => {
        const out = await trackPressureSince(active({ a: 'v1' }), 1_000);
        expect(out.get('a')).toEqual({ first: 1_000, last: 1_000, value: condition('v1') });
    });

    it('a later sighting keeps the first time, moves the last time, and takes the newest value', async () => {
        await trackPressureSince(active({ a: 'v1' }), 1_000);
        const out = await trackPressureSince(active({ a: 'v2' }), 5_000);
        expect(out.get('a')).toEqual({ first: 1_000, last: 5_000, value: condition('v2') });
    });

    it('an absent key within the grace keeps its clock and comes back with its last value', async () => {
        await trackPressureSince(active({ a: 'v1' }), 1_000);
        const gap = await trackPressureSince(new Map(), 60_000);
        expect(gap.get('a')).toEqual({ first: 1_000, last: 1_000, value: condition('v1') });

        const back = await trackPressureSince(active({ a: 'v2' }), 120_000);
        expect(back.get('a')).toEqual({ first: 1_000, last: 120_000, value: condition('v2') });
    });

    it('a key absent for exactly 3 minutes is still kept', async () => {
        await trackPressureSince(active({ a: 'v1' }), 1_000);
        const out = await trackPressureSince(new Map(), 1_000 + GRACE);
        expect(out.has('a')).toBe(true);
    });

    it('a key absent for longer than 3 minutes is dropped, and restarts when it returns', async () => {
        await trackPressureSince(active({ a: 'v1' }), 1_000);
        const dropped = await trackPressureSince(new Map(), 1_000 + GRACE + 1);
        expect(dropped.has('a')).toBe(false);

        const back = await trackPressureSince(active({ a: 'v3' }), 1_000 + GRACE + 2);
        expect(back.get('a')).toEqual({
            first: 1_000 + GRACE + 2,
            last: 1_000 + GRACE + 2,
            value: condition('v3'),
        });
    });

    it('with Valkey down (get returns null) the process-local copy keeps the clock', async () => {
        cache.get.mockResolvedValue(null);
        cache.set.mockResolvedValue(false);
        await trackPressureSince(active({ a: 'v1' }), 1_000);
        const out = await trackPressureSince(active({ a: 'v1' }), 2_000);
        expect(out.get('a')?.first).toBe(1_000);
    });

    it('an earlier clock in Valkey wins over a later local one (another worker saw it first)', async () => {
        store.set(KEY, JSON.stringify({ a: { first: 400, last: 1_900, value: condition('v0') } }));
        resetPressureSinceForTests();
        const out = await trackPressureSince(active({ a: 'v1' }), 2_000);
        expect(out.get('a')).toEqual({ first: 400, last: 2_000, value: condition('v1') });
    });

    it('an earlier local clock wins over a later Valkey one', async () => {
        await trackPressureSince(active({ a: 'v1' }), 1_000);
        store.set(KEY, JSON.stringify({ a: { first: 5_000, last: 5_000, value: condition('x') } }));
        const out = await trackPressureSince(active({ a: 'v1' }), 6_000);
        expect(out.get('a')?.first).toBe(1_000);
    });

    it('ignores stored clocks that start in the future', async () => {
        store.set(KEY, JSON.stringify({ a: { first: 9_000, last: 9_000, value: condition('x') } }));
        resetPressureSinceForTests();
        const out = await trackPressureSince(active({ a: 'v1' }), 2_000);
        expect(out.get('a')?.first).toBe(2_000);
    });

    it('a now earlier than the last local write resets the local copy', async () => {
        // Valkey is down, so only the local copy could carry the clock. Without the
        // reset, the copy (first 1 000, last 1 500) would still survive a call at 1 200.
        cache.get.mockResolvedValue(null);
        await trackPressureSince(active({ a: 'v1' }), 1_000);
        await trackPressureSince(active({ a: 'v1' }), 1_500);
        const out = await trackPressureSince(active({ a: 'v1' }), 1_200);
        expect(out.get('a')?.first).toBe(1_200);
    });

    it('writes nothing when nothing is active and nothing is stored', async () => {
        const out = await trackPressureSince(new Map(), 1_000);
        expect(out.size).toBe(0);
        expect(cache.set).not.toHaveBeenCalled();
    });

    it('writes an empty map when the last stored clock lapses', async () => {
        await trackPressureSince(active({ a: 'v1' }), 1_000);
        await trackPressureSince(new Map(), 1_000 + GRACE + 1);
        expect(cache.set).toHaveBeenLastCalledWith(KEY, '{}', 900);
    });

    it('stores the clocks under the v2 key with a 15-minute TTL', async () => {
        await trackPressureSince(active({ a: 'v1' }), 1_000);
        expect(cache.set).toHaveBeenCalledWith(KEY, expect.any(String), 900);
        const stored = JSON.parse(cache.set.mock.calls[0][1] as string) as Record<string, unknown>;
        expect(stored).toEqual({ a: { first: 1_000, last: 1_000, value: condition('v1') } });
    });
});
