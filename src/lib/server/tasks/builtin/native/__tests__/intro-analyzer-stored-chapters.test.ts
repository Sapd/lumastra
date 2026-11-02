// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The intro analyzer's chapter detectors need the file's chapter list. When the
 * file's chapters are already stored and trusted (chapter-sync / scanner marker,
 * see chapter-sync.service.ts), the analyzer reuses that list and does not run
 * ffprobe. Without a stored list it probes as before, and a failed probe still
 * throws so the task retries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockProbeChapters } = vi.hoisted(() => ({ mockProbeChapters: vi.fn() }));

vi.mock('$lib/server/utils/ffprobe.js', () => ({ probeChapters: mockProbeChapters }));

import { detectFromChapters } from '../lumastra-intro-analyzer.js';
import { DEFAULT_CHAPTER_CONFIG } from '../intro-analyzer/chapter.js';

const KNOWN = [
    { index: 0, title: 'Opening', startTimeMs: 0, endTimeMs: 90000 },
    { index: 1, title: 'Episode', startTimeMs: 90000, endTimeMs: 1380000 },
];

beforeEach(() => {
    vi.clearAllMocks();
    mockProbeChapters.mockResolvedValue({ chapters: [], durationMs: 0, success: true });
});

describe('detectFromChapters — stored chapter list', () => {
    it('uses the stored chapter list and runs no ffprobe', async () => {
        const result = await detectFromChapters('/data/ep.mkv', DEFAULT_CHAPTER_CONFIG, undefined, {
            chapters: KNOWN,
            durationMs: 1380000,
        });

        expect(mockProbeChapters).not.toHaveBeenCalled();
        expect(result.chapters).toEqual(KNOWN);
    });

    it('a stored "no chapters" list yields no chapters and no ffprobe', async () => {
        const result = await detectFromChapters('/data/ep.mkv', DEFAULT_CHAPTER_CONFIG, undefined, {
            chapters: [],
            durationMs: 1380000,
        });

        expect(mockProbeChapters).not.toHaveBeenCalled();
        expect(result).toEqual({ segments: [], chapters: [] });
    });

    it('probes when no stored list is given', async () => {
        mockProbeChapters.mockResolvedValueOnce({
            chapters: KNOWN,
            durationMs: 1380000,
            success: true,
        });

        const result = await detectFromChapters('/data/ep.mkv', DEFAULT_CHAPTER_CONFIG);

        expect(mockProbeChapters).toHaveBeenCalledTimes(1);
        expect(result.chapters).toEqual(KNOWN);
    });
});
