// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scanner used to run a second chapter ffprobe (`probeChapters`) for every
 * new file, seconds after `probeMediaFile` had already read the same file.
 * `probeMediaFile({ chapters: true })` now reads the chapters in that same
 * ffprobe run. Without the option its argument list must stay byte-identical,
 * and `probeChapters` reports whether its probe actually succeeded, so a caller
 * can tell "no chapters" from "could not read the file".
 *
 * Uses a separate test file so `vi.mock('child_process')` does not interfere
 * with the real-ffprobe tests in ffprobe.test.ts (same convention as
 * ffprobe-protocol-whitelist.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

vi.mock('child_process', () => {
    const execFileFn = vi.fn() as ReturnType<typeof vi.fn> & {
        [promisify.custom]?: ReturnType<typeof vi.fn>;
    };
    execFileFn[promisify.custom] = vi.fn();
    return { execFile: execFileFn };
});

vi.mock('$lib/server/config.js', () => ({
    config: { FFPROBE_PATH: '/usr/bin/ffprobe' },
}));

// probeChapters adds the library format whitelist; the test does not care what
// it is, only that the probe runs. An empty list keeps the argument check exact.
vi.mock('./library-input-guard.js', () => ({
    ffprobeLibraryInputArgs: vi.fn(async () => []),
}));

import { probeChapters, probeMediaFile } from './ffprobe.js';
import { MEDIA_PROTOCOL_WHITELIST } from './media-protocol-whitelist.js';
import { execFile } from 'child_process';

const mockExecFileAsync = vi.mocked(
    (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisify.custom],
);

const FILE = '/data/movies/A.mkv';

const PAYLOAD = {
    format: { format_name: 'matroska,webm', duration: '100.0', size: '1000', bit_rate: '80000' },
    streams: [
        {
            index: 0,
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            r_frame_rate: '24/1',
            pix_fmt: 'yuv420p',
        },
    ],
    chapters: [
        { id: 0, start_time: '0.000000', end_time: '60.000000', tags: { title: 'Cold Open' } },
        { id: 1, start_time: '60.000000', end_time: '100.000000', tags: {} },
    ],
};

beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileAsync.mockResolvedValue({ stdout: JSON.stringify(PAYLOAD), stderr: '' });
});

describe('probeMediaFile — chapters option', () => {
    it('without the option the argument list is unchanged and no chapters are returned', async () => {
        const result = await probeMediaFile(FILE);

        expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
        const args = mockExecFileAsync.mock.calls[0][1] as string[];
        expect(args).toEqual([
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_streams',
            '-show_format',
            '-protocol_whitelist',
            MEDIA_PROTOCOL_WHITELIST,
            FILE,
        ]);
        expect(result).not.toHaveProperty('chapters');
    });

    it('with chapters: true it adds -show_chapters and maps the chapters', async () => {
        const result = await probeMediaFile(FILE, undefined, { chapters: true });

        expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
        const args = mockExecFileAsync.mock.calls[0][1] as string[];
        expect(args).toEqual([
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_streams',
            '-show_format',
            '-show_chapters',
            '-protocol_whitelist',
            MEDIA_PROTOCOL_WHITELIST,
            FILE,
        ]);
        expect(result.success).toBe(true);
        expect(result.chapters).toEqual([
            { index: 0, title: 'Cold Open', startTimeMs: 0, endTimeMs: 60000 },
            { index: 1, title: null, startTimeMs: 60000, endTimeMs: 100000 },
        ]);
    });

    it('with chapters: true and no chapters in the output it returns an empty list', async () => {
        mockExecFileAsync.mockResolvedValueOnce({
            stdout: JSON.stringify({ format: PAYLOAD.format, streams: PAYLOAD.streams }),
            stderr: '',
        });

        const result = await probeMediaFile(FILE, undefined, { chapters: true });

        expect(result.success).toBe(true);
        expect(result.chapters).toEqual([]);
    });
});

describe('probeChapters — success flag', () => {
    it('reports success and the mapped chapters when ffprobe answers', async () => {
        const result = await probeChapters(FILE);

        expect(result.success).toBe(true);
        expect(result.durationMs).toBe(100000);
        expect(result.chapters).toHaveLength(2);
    });

    it('reports failure, with no chapters, when ffprobe fails', async () => {
        mockExecFileAsync.mockRejectedValueOnce(new Error('ffprobe exited 1'));

        const result = await probeChapters(FILE);

        expect(result.success).toBe(false);
        expect(result.chapters).toEqual([]);
    });
});
