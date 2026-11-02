// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `probeMediaFile` must not report a container duration the video/audio
 * can't fill. GPU transcode tests 2026-10-02: a 300 s MKV whose dvd_subtitle
 * ended at 2^32 ms was stored as 4 295 262 s and the muxed /hls endpoint
 * 500'd building a ~700k-segment playlist.
 *
 * Separate file: `vi.mock('child_process')` would break ffprobe.test.ts,
 * which runs the real binary (same convention as ffprobe-protocol-whitelist).
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

import { probeMediaFile } from './ffprobe.js';
import { execFile } from 'child_process';

const mockExecFileAsync = vi.mocked(
    (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisify.custom],
);

function ffprobeOutput(formatDuration: string | undefined, streams: unknown[]) {
    return {
        stdout: JSON.stringify({
            streams,
            format: {
                format_name: 'matroska,webm',
                ...(formatDuration ? { duration: formatDuration } : {}),
            },
        }),
        stderr: '',
    };
}

const mkvStreams = [
    { index: 0, codec_type: 'video', codec_name: 'h264', tags: { DURATION: '00:05:00.000000000' } },
    { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { DURATION: '00:05:00.021000000' } },
    {
        index: 2,
        codec_type: 'subtitle',
        codec_name: 'dvd_subtitle',
        tags: { DURATION: '1193:07:42.295000000' },
    },
];

beforeEach(() => {
    vi.clearAllMocks();
});

describe('probeMediaFile — container duration', () => {
    it('uses the video/audio end when a subtitle inflated the container to 2^32 ms', async () => {
        mockExecFileAsync.mockResolvedValue(ffprobeOutput('4295262.295000', mkvStreams));
        const result = await probeMediaFile('/data/movies/Broken.mkv');
        expect(result.success).toBe(true);
        expect(result.duration).toBeCloseTo(300.021, 3);
    });

    it('keeps a container duration the streams agree with', async () => {
        mockExecFileAsync.mockResolvedValue(ffprobeOutput('300.500000', mkvStreams.slice(0, 2)));
        expect((await probeMediaFile('/data/movies/Fine.mkv')).duration).toBe(300.5);
    });

    it('keeps the container duration when no stream states its own', async () => {
        mockExecFileAsync.mockResolvedValue(
            ffprobeOutput('7200.000000', [{ index: 0, codec_type: 'video', codec_name: 'hevc' }]),
        );
        expect((await probeMediaFile('/data/movies/Plain.mkv')).duration).toBe(7200);
    });
});
