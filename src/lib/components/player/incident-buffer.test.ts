// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { IncidentRingBuffer, PLAYBACK_INCIDENT_BUFFER_MAX_ENTRIES } from './incident-buffer.js';

describe('IncidentRingBuffer', () => {
    it('evicts the oldest entry once length exceeds the cap', () => {
        const buf = new IncidentRingBuffer({ maxEntries: 3, maxAgeMs: 1_000_000, now: () => 0 });
        buf.push({ t: 0, kind: 'seek' });
        buf.push({ t: 1, kind: 'seek' });
        buf.push({ t: 2, kind: 'seek' });
        buf.push({ t: 3, kind: 'seek' });
        expect(buf.snapshot().map((e) => e.t)).toEqual([1, 2, 3]);
    });

    it('evicts entries older than maxAgeMs relative to now', () => {
        let currentTime = 0;
        const buf = new IncidentRingBuffer({
            maxEntries: 100,
            maxAgeMs: 90_000,
            now: () => currentTime,
        });
        buf.push({ t: 0, kind: 'seek' });
        currentTime = 50_000;
        buf.push({ t: 50_000, kind: 'seek' });
        currentTime = 100_000; // 100s later — the t:0 entry is now 100s old, past the 90s window
        buf.push({ t: 100_000, kind: 'seek' });

        const kept = buf.snapshot().map((e) => e.t);
        expect(kept).not.toContain(0);
        expect(kept).toContain(50_000);
        expect(kept).toContain(100_000);
    });

    it('clear() empties the buffer', () => {
        const buf = new IncidentRingBuffer({ maxEntries: 10, maxAgeMs: 90_000, now: () => 0 });
        buf.push({ t: 0, kind: 'seek' });
        buf.clear();
        expect(buf.snapshot()).toEqual([]);
    });

    it('falls back to the default cap instead of growing unbounded when maxEntries is NaN', () => {
        const buf = new IncidentRingBuffer({
            maxEntries: Number.NaN,
            maxAgeMs: 1_000_000,
            now: () => 0,
        });
        for (let i = 0; i < PLAYBACK_INCIDENT_BUFFER_MAX_ENTRIES + 10; i++) {
            buf.push({ t: i, kind: 'seek' });
        }
        expect(buf.snapshot().length).toBe(PLAYBACK_INCIDENT_BUFFER_MAX_ENTRIES);
    });

    it('falls back to the default cap when maxEntries is non-positive', () => {
        const buf = new IncidentRingBuffer({ maxEntries: 0, maxAgeMs: 1_000_000, now: () => 0 });
        for (let i = 0; i < PLAYBACK_INCIDENT_BUFFER_MAX_ENTRIES + 10; i++) {
            buf.push({ t: i, kind: 'seek' });
        }
        expect(buf.snapshot().length).toBe(PLAYBACK_INCIDENT_BUFFER_MAX_ENTRIES);
    });
});
