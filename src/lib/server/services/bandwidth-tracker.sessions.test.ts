// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';

const store = new Map<string, string>();
const cacheSet = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return true;
});
const cacheGet = vi.fn(async (key: string) => store.get(key) ?? null);
const getKeysByPattern = vi.fn(async (pattern: string) =>
    [...store.keys()].filter((k) => k.startsWith(pattern.replace(/\*$/, ''))),
);

vi.mock('$lib/server/cache/valkey.js', () => ({ cacheSet, cacheGet, getKeysByPattern }));

const { bandwidthTracker } = await import('./bandwidth-tracker.service.js');

const OWN_KEY = 'bandwidth:sessions:v1:' + hostname();

describe('per-session bandwidth across pods', () => {
    beforeEach(() => {
        store.clear();
        cacheSet.mockClear();
    });

    it('sees a session whose segments another pod served (the admin request and the segments land on different replicas)', async () => {
        // Pod B served 2.5 Mbps to session s-b; this pod served nothing for it.
        store.set('bandwidth:sessions:v1:pod-b', JSON.stringify({ 's-b': 2.5 }));

        const map = await bandwidthTracker.getAggregatedSessionBandwidthMap();

        expect(map.get('s-b')).toBe(2.5);
    });

    it('sums a session split across pods, and reads its own pod live rather than from its stale snapshot', async () => {
        bandwidthTracker.trackSession('s-split', 1_250_000); // 1 Mbps over the 10 s window
        store.set('bandwidth:sessions:v1:pod-b', JSON.stringify({ 's-split': 3 }));
        store.set(OWN_KEY, JSON.stringify({ 's-split': 99 }));

        const map = await bandwidthTracker.getAggregatedSessionBandwidthMap();

        expect(map.get('s-split')).toBeCloseTo(4, 5);
    });

    it('publishes its map, then clears it once when idle, then stops writing', () => {
        bandwidthTracker.trackSession('s-pub', 1_250_000);
        bandwidthTracker.publishSessionBandwidth();
        expect(JSON.parse(store.get(OWN_KEY) ?? '{}')).toHaveProperty('s-pub');

        vi.useFakeTimers();
        try {
            vi.setSystemTime(Date.now() + 60_000); // samples age out of the window
            bandwidthTracker.publishSessionBandwidth();
            expect(store.get(OWN_KEY)).toBe('{}');
            cacheSet.mockClear();
            bandwidthTracker.publishSessionBandwidth();
            expect(cacheSet).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
