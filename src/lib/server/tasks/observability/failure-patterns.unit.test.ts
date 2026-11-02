// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the pure failure-grouping fold (Slice 3 §4.1, §9).
 *
 * No DB / Valkey — exercises `groupFailures` directly: templated-but-varying
 * messages collapse; counts/first-last seen; affectedTasks cap + overflow;
 * run/item source split; kinds only on run source; freshest sample.
 */

import { describe, it, expect } from 'vitest';
import { groupFailures } from './failure-patterns.service.js';

function row(message: string, taskId: string, at: string, source: 'run' | 'item', kind?: string) {
    return { taskId, message, at: new Date(at), source, kind };
}

describe('groupFailures', () => {
    it('groups FFmpeg context pointers while preserving codec causes and the original sample', () => {
        const first = '[matroska,webm @ 0x55aa1234abcd] Invalid data found when processing input';
        const second = '[matroska,webm @ 0x7fefabcd1234] Invalid data found when processing input';
        const patterns = groupFailures([
            row(first, 'probe', '2026-10-20T10:00:00Z', 'run'),
            row(second, 'probe', '2026-10-20T10:01:00Z', 'run'),
            row(
                '[h264 @ 0x55aa1234abcd] Invalid data found when processing input',
                'probe',
                '2026-10-20T10:02:00Z',
                'run',
            ),
            row('Invalid codec tag 0x31637661', 'probe', '2026-10-20T10:03:00Z', 'run'),
            row('Invalid codec tag 0x31637662', 'probe', '2026-10-20T10:04:00Z', 'run'),
        ]);
        expect(patterns).toHaveLength(4);
        expect(patterns[0].count).toBe(2);
        expect(patterns[0].sampleMessage).toBe(second);
        expect(patterns[0].normalizedMessage).toContain('[matroska,webm @ <address>]');
    });
    it('groups templated-but-varying messages into one pattern', () => {
        const rows = [
            row(
                'Timeout to https://api.tmdb.org/3/movie/1',
                'tmdb-sync',
                '2026-06-02T10:00:00Z',
                'run',
            ),
            row(
                'Timeout to https://api.tmdb.org/3/tv/9999',
                'tmdb-sync',
                '2026-06-02T11:00:00Z',
                'run',
            ),
        ];
        const patterns = groupFailures(rows);
        expect(patterns).toHaveLength(1);
        expect(patterns[0].count).toBe(2);
    });

    it('keeps distinct errors separate and sorts by count desc', () => {
        const rows = [
            row('Timeout to https://x/1', 't1', '2026-06-02T10:00:00Z', 'run'),
            row('Timeout to https://x/2', 't1', '2026-06-02T10:01:00Z', 'run'),
            row('Unauthorized key', 't1', '2026-06-02T10:02:00Z', 'run'),
        ];
        const patterns = groupFailures(rows);
        expect(patterns).toHaveLength(2);
        expect(patterns[0].count).toBe(2); // timeout group first (higher count)
        expect(patterns[1].count).toBe(1);
    });

    it('tracks first/last seen and uses the freshest sample', () => {
        const rows = [
            row('boom 100', 't', '2026-06-02T10:00:00Z', 'run'),
            row('boom 200', 't', '2026-06-02T12:00:00Z', 'run'),
        ];
        const [p] = groupFailures(rows);
        expect(p.firstSeen).toBe('2026-06-02T10:00:00.000Z');
        expect(p.lastSeen).toBe('2026-06-02T12:00:00.000Z');
        expect(p.sampleMessage).toBe('boom 200'); // freshest verbatim
    });

    it('caps affectedTasks at 10 and counts the overflow', () => {
        const rows = Array.from({ length: 15 }, (_, i) =>
            row('same error', `task-${i}`, '2026-06-02T10:00:00Z', 'run'),
        );
        const [p] = groupFailures(rows);
        expect(p.affectedTasks).toHaveLength(10);
        expect(p.affectedTasksOverflow).toBe(5);
    });

    it('splits run vs item sources even with identical text', () => {
        const rows = [
            row('same text', 't', '2026-06-02T10:00:00Z', 'run'),
            row('same text', 't', '2026-06-02T10:01:00Z', 'item'),
        ];
        const patterns = groupFailures(rows);
        expect(patterns).toHaveLength(2);
        expect(new Set(patterns.map((p) => p.source))).toEqual(new Set(['run', 'item']));
    });

    it('surfaces kinds only for run-source patterns', () => {
        const runRows = [
            row('boom', 't', '2026-06-02T10:00:00Z', 'run', 'transient'),
            row('boom', 't', '2026-06-02T10:01:00Z', 'run', 'permanent'),
        ];
        const [runP] = groupFailures(runRows);
        expect(new Set(runP.kinds)).toEqual(new Set(['transient', 'permanent']));

        const itemRows = [row('boom', 't', '2026-06-02T10:00:00Z', 'item')];
        const [itemP] = groupFailures(itemRows);
        expect(itemP.kinds).toBeUndefined();
    });

    it('returns an empty array for no rows', () => {
        expect(groupFailures([])).toEqual([]);
    });
});
