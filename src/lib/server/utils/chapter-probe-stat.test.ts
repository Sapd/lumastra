// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * probeChaptersWithStat hands back the stat the chapters describe only when the
 * file kept that stat across the probe. The chapter marker is written with it,
 * so a file that changed mid-probe must never end up marked as probed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockProbeChapters, mockSafeStat } = vi.hoisted(() => ({
    mockProbeChapters: vi.fn(),
    mockSafeStat: vi.fn(),
}));

vi.mock('$lib/server/utils/ffprobe.js', () => ({ probeChapters: mockProbeChapters }));
vi.mock('$lib/server/utils/safe-fs.js', () => ({ safeStat: mockSafeStat }));

import { probeChaptersWithStat, toFileChapterRows } from './chapter-probe-stat.js';

const FILE = '/media/show/episode.mkv';
const MTIME = new Date('2026-10-01T10:00:00.000Z');
const LATER = new Date('2026-10-02T10:00:00.000Z');
const PROBE = {
    chapters: [{ index: 0, title: 'Opening', startTimeMs: 0, endTimeMs: 90000 }],
    durationMs: 1320000,
    success: true,
};

beforeEach(() => {
    vi.clearAllMocks();
    mockProbeChapters.mockResolvedValue(PROBE);
    mockSafeStat.mockResolvedValue({ mtime: MTIME, size: 4096 });
});

describe('probeChaptersWithStat', () => {
    it('returns the probe result and the stat when the file is unchanged across the probe', async () => {
        const result = await probeChaptersWithStat(FILE, { signal: undefined });

        expect(result).toEqual({ ...PROBE, stat: { mtime: MTIME, size: 4096 } });
    });

    it('stats the file before and after the probe, and probes in between', async () => {
        await probeChaptersWithStat(FILE, {});

        expect(mockSafeStat).toHaveBeenCalledTimes(2);
        const firstStat = mockSafeStat.mock.invocationCallOrder[0];
        const secondStat = mockSafeStat.mock.invocationCallOrder[1];
        const probe = mockProbeChapters.mock.invocationCallOrder[0];
        expect(firstStat).toBeLessThan(probe);
        expect(probe).toBeLessThan(secondStat);
    });

    it('passes the signal through to the probe with the default timeout', async () => {
        const controller = new AbortController();

        await probeChaptersWithStat(FILE, { signal: controller.signal });

        expect(mockProbeChapters).toHaveBeenCalledWith(FILE, undefined, {
            signal: controller.signal,
        });
    });

    it('reports a null stat when the mtime changed during the probe', async () => {
        mockSafeStat
            .mockResolvedValueOnce({ mtime: MTIME, size: 4096 })
            .mockResolvedValueOnce({ mtime: LATER, size: 4096 });

        const result = await probeChaptersWithStat(FILE, {});

        expect(result.stat).toBeNull();
        expect(result.chapters).toEqual(PROBE.chapters);
        expect(result.success).toBe(true);
    });

    it('reports a null stat when the size changed during the probe', async () => {
        mockSafeStat
            .mockResolvedValueOnce({ mtime: MTIME, size: 4096 })
            .mockResolvedValueOnce({ mtime: MTIME, size: 8192 });

        const result = await probeChaptersWithStat(FILE, {});

        expect(result.stat).toBeNull();
    });

    it('reports a null stat when the file cannot be stat-ed before the probe', async () => {
        mockSafeStat.mockRejectedValueOnce(new Error('ENOENT'));

        const result = await probeChaptersWithStat(FILE, {});

        expect(result.stat).toBeNull();
        expect(result.success).toBe(true);
    });

    it('reports a null stat when the file cannot be stat-ed after the probe', async () => {
        mockSafeStat
            .mockResolvedValueOnce({ mtime: MTIME, size: 4096 })
            .mockRejectedValueOnce(new Error('EIO'));

        const result = await probeChaptersWithStat(FILE, {});

        expect(result.stat).toBeNull();
    });

    it('keeps a failed probe failed, with its stat still reported when the file is stable', async () => {
        mockProbeChapters.mockResolvedValue({ chapters: [], durationMs: 0, success: false });

        const result = await probeChaptersWithStat(FILE, {});

        expect(result.success).toBe(false);
        expect(result.chapters).toEqual([]);
    });
});

describe('toFileChapterRows', () => {
    it('maps probe chapters to the rows chapter-sync stores, in ticks of 100 ns', () => {
        const rows = toFileChapterRows([
            { index: 0, title: 'Opening', startTimeMs: 0, endTimeMs: 90000 },
            { index: 1, title: null, startTimeMs: 90000, endTimeMs: 1320000 },
        ]);

        expect(rows).toEqual([
            {
                chapterIndex: 0,
                chapterName: 'Opening',
                startTicks: '0',
                endTicks: '900000000',
                source: 'file',
            },
            {
                chapterIndex: 1,
                chapterName: null,
                startTicks: '900000000',
                endTicks: '13200000000',
                source: 'file',
            },
        ]);
    });
});
