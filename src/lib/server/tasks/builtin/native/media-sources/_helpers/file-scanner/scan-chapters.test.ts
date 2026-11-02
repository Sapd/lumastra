// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scanner reads a new file's chapters from the probe it already made to
 * link the file (`probeFileForScan` with `chapters: true`), and only runs a
 * second ffprobe when that probe is not available for the file's current stat.
 * Real files for the stat; `probeChapters` is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as FfprobeModule from '$lib/server/utils/ffprobe.js';
import type { MediaProbeResult } from '$lib/server/utils/ffprobe.js';

const { mockProbeChapters, mockUpsert, mockMarkProbed } = vi.hoisted(() => ({
    mockProbeChapters: vi.fn(),
    mockUpsert: vi.fn(),
    mockMarkProbed: vi.fn(),
}));

vi.mock('$lib/server/utils/ffprobe.js', async (importOriginal) => {
    const actual = await importOriginal<typeof FfprobeModule>();
    return { ...actual, probeChapters: mockProbeChapters };
});

vi.mock('$lib/server/database/queries/episode-chapters.queries.js', () => ({
    upsertChaptersForFile: mockUpsert,
    markChaptersProbed: mockMarkProbed,
}));

vi.mock('$lib/server/services/file-chapters.service.js', () => ({
    replaceProbedFileChapters: vi.fn(),
}));

import { readScanChapters } from './scan-chapters.js';
import {
    clearScanProbeCache,
    rememberScanProbe,
    takeScanProbe,
} from '$lib/server/utils/scan-probe-cache.js';

const CHAPTERS = [
    { index: 0, title: 'Cold Open', startTimeMs: 0, endTimeMs: 60000 },
    { index: 1, title: 'Act Two', startTimeMs: 60000, endTimeMs: 100000 },
];

function scanProbe(chapters: MediaProbeResult['chapters']): MediaProbeResult {
    return {
        success: true,
        video: null,
        audioStreams: [],
        subtitleStreams: [],
        duration: 100,
        container: 'matroska,webm',
        fileSize: 0,
        formatBitrate: null,
        chapters,
    };
}

let dir: string;
let filePath: string;

beforeEach(async () => {
    vi.clearAllMocks();
    clearScanProbeCache();
    dir = await mkdtemp(join(tmpdir(), 'scan-chapters-'));
    filePath = join(dir, 'episode.mkv');
    await writeFile(filePath, 'original-bytes');
    mockProbeChapters.mockResolvedValue({ chapters: [], durationMs: 0, success: true });
    mockUpsert.mockResolvedValue(undefined);
    mockMarkProbed.mockResolvedValue(true);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function rememberFromDisk(probe: MediaProbeResult): Promise<void> {
    const st = await stat(filePath);
    rememberScanProbe(filePath, { mtime: st.mtime, size: st.size }, probe);
}

describe('readScanChapters', () => {
    it('uses the scan probe chapters when the file stat still matches (no ffprobe)', async () => {
        await rememberFromDisk(scanProbe(CHAPTERS));
        const st = await stat(filePath);

        const result = await readScanChapters(filePath, filePath);

        expect(mockProbeChapters).not.toHaveBeenCalled();
        expect(result).toEqual({
            chapters: CHAPTERS,
            success: true,
            physicalPath: filePath,
            stat: { mtime: st.mtime, size: st.size },
        });
    });

    it('a scan-probe hit carries the probed stat, which is what the marker records', async () => {
        await rememberFromDisk(scanProbe(CHAPTERS));
        const st = await stat(filePath);

        const result = await readScanChapters(filePath, filePath);

        expect(result.stat).toEqual({ mtime: st.mtime, size: st.size });
    });

    it('leaves the scan probe in place for media-probe Phase A', async () => {
        await rememberFromDisk(scanProbe(CHAPTERS));

        await readScanChapters(filePath, filePath);

        const st = await stat(filePath);
        expect(takeScanProbe(filePath, { mtime: st.mtime, size: st.size })).not.toBeNull();
    });

    it('probes again when the file changed after the scan', async () => {
        await rememberFromDisk(scanProbe(CHAPTERS));
        await writeFile(filePath, 'different-and-longer-bytes');
        mockProbeChapters.mockResolvedValueOnce({
            chapters: [CHAPTERS[0]],
            durationMs: 60000,
            success: true,
        });

        const result = await readScanChapters(filePath, filePath);
        const st = await stat(filePath);

        expect(mockProbeChapters).toHaveBeenCalledWith(filePath, undefined, { signal: undefined });
        expect(result).toEqual({
            chapters: [CHAPTERS[0]],
            success: true,
            physicalPath: filePath,
            stat: { mtime: st.mtime, size: st.size },
        });
    });

    it('a fallback probe reports the stat it ran against when the file is unchanged', async () => {
        const st = await stat(filePath);
        mockProbeChapters.mockResolvedValueOnce({
            chapters: CHAPTERS,
            durationMs: 0,
            success: true,
        });

        const result = await readScanChapters(filePath, filePath);

        expect(result.stat).toEqual({ mtime: st.mtime, size: st.size });
    });

    it('a fallback probe whose file changed mid-probe reports a null stat', async () => {
        mockProbeChapters.mockImplementationOnce(async () => {
            await writeFile(filePath, 'rewritten-while-probing-bytes');
            return { chapters: CHAPTERS, durationMs: 0, success: true };
        });

        const result = await readScanChapters(filePath, filePath);

        expect(result).toEqual({
            chapters: CHAPTERS,
            success: true,
            stat: null,
            physicalPath: filePath,
        });
    });

    it('probes when the scan probe carries no chapters', async () => {
        await rememberFromDisk(scanProbe(undefined));

        await readScanChapters(filePath, filePath);

        expect(mockProbeChapters).toHaveBeenCalledTimes(1);
    });

    it('probes the container path when it differs from the scanned path', async () => {
        await rememberFromDisk(scanProbe(CHAPTERS));
        const containerPath = join(dir, 'mapped', 'episode.mkv');

        await readScanChapters(filePath, containerPath);

        expect(mockProbeChapters).toHaveBeenCalledWith(containerPath, undefined, {
            signal: undefined,
        });
    });

    it('reports a failed chapter probe as unsuccessful, not as "no chapters"', async () => {
        mockProbeChapters.mockResolvedValueOnce({ chapters: [], durationMs: 0, success: false });

        const result = await readScanChapters(filePath, filePath);

        expect(result).toMatchObject({ chapters: [], success: false });
    });
});
