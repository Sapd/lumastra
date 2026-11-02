// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for summarizeFfmpegStderr.
 *
 * The parser extracts a single short, user-safe error line out of raw FFmpeg
 * stderr tails so the player overlay can surface "why did this fail?" without
 * leaking the whole stderr buffer. Fixtures are derived from real failures we
 * have seen in production.
 */

import { describe, it, expect } from 'vitest';
import { summarizeFfmpegStderr } from './ffmpeg-error-summary.js';

describe('summarizeFfmpegStderr', () => {
    it('extracts the tonemap "Undefined constant" line from the real DV P8 failure', () => {
        const stderr = [
            'Press [q] to stop, [?] for help',
            "[Parsed_tonemap_0 @ 0x7f8a2c003040] Undefined constant or missing '(' in 'bt2390'",
            "[Parsed_tonemap_0 @ 0x7f8a2c003040] Error when evaluating the expression 'bt2390'.",
            "[AVFilterGraph @ 0x7f8a2c001800] Error initializing filter 'tonemap' with args 'bt2390'",
            'Error reinitializing filters!',
            'Failed to inject frame into filter network: Invalid argument',
            'Error while processing the decoded data for stream #0:0',
        ].join('\n');

        const summary = summarizeFfmpegStderr(stderr, 234);
        expect(summary).toContain('Undefined constant');
        expect(summary).toContain('bt2390');
        // Filter graph noise prefix must be stripped.
        expect(summary).not.toMatch(/\[Parsed_tonemap_0 @ 0x[0-9a-f]+\]/);
        expect(summary).not.toContain('Press [q]');
        expect(summary.length).toBeLessThanOrEqual(200);
    });

    it('extracts a missing-codec failure', () => {
        const stderr = [
            'ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers',
            "Input #0, matroska,webm, from '/media/movie.mkv':",
            '  Stream #0:0: Video: hevc, yuv420p10le, 3840x2160',
            "Unknown encoder 'hevc_nvenc'",
            '',
        ].join('\n');

        const summary = summarizeFfmpegStderr(stderr, 1);
        expect(summary).toContain("Unknown encoder 'hevc_nvenc'");
        expect(summary).not.toContain('ffmpeg version');
        expect(summary.length).toBeLessThanOrEqual(200);
    });

    it('extracts a GPU encoder init failure', () => {
        const stderr = [
            '[hevc_vaapi @ 0x55c6e8a00000] Failed to initialise VAAPI connection: -1 (unknown libva error).',
            '[hevc_vaapi @ 0x55c6e8a00000] Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height',
            'Error initializing output stream 0:0 --',
        ].join('\n');

        const summary = summarizeFfmpegStderr(stderr, 1);
        // Prefer a line that names the concrete cause; "Failed to initialise VAAPI"
        // is more informative than the generic "Error initializing output stream".
        expect(summary).toContain('Failed to initialise VAAPI');
        expect(summary).not.toMatch(/\[hevc_vaapi @ 0x[0-9a-f]+\]/);
        expect(summary.length).toBeLessThanOrEqual(200);
    });

    it('falls back to the exit code when nothing in stderr matches', () => {
        const stderr = [
            'ffmpeg version 7.1',
            '  libavutil      59. 22.100 / 59. 22.100',
            "Input #0, mov,mp4: 'movie.mp4'",
            '  Stream #0:0: Video: h264',
        ].join('\n');

        expect(summarizeFfmpegStderr(stderr, 137)).toBe('FFmpeg exited with code 137');
    });

    it('falls back when stderr is empty', () => {
        expect(summarizeFfmpegStderr('', 1)).toBe('FFmpeg exited with code 1');
    });

    it('reports a null exit code in the fallback', () => {
        expect(summarizeFfmpegStderr('', null)).toBe('FFmpeg exited with code unknown');
    });

    it('uses a spawn-specific fallback message when provided', () => {
        expect(summarizeFfmpegStderr('', null, 'spawn ffmpeg ENOENT')).toBe('spawn ffmpeg ENOENT');
    });

    it('caps very long summary lines at 200 chars', () => {
        const longLine = 'Error: ' + 'x'.repeat(500) + ' failed to do the thing';
        const summary = summarizeFfmpegStderr(longLine, 1);
        expect(summary.length).toBeLessThanOrEqual(200);
        expect(summary.startsWith('Error:')).toBe(true);
    });

    it('prefers a more-specific high-priority pattern over a less-specific earlier one', () => {
        // A generic "Failed to open output file" often precedes the actual
        // root cause during FFmpeg startup. We want the concrete "Unknown
        // encoder" to surface even though it appears later in the tail.
        const stderr = [
            'Failed to open output file: /tmp/hls/index.m3u8',
            "Unknown encoder 'hevc_nvenc'",
        ].join('\n');
        const summary = summarizeFfmpegStderr(stderr, 1);
        expect(summary).toContain("Unknown encoder 'hevc_nvenc'");
        expect(summary).not.toContain('Failed to open output file');
    });

    it('prefers the last matching line when multiple candidates exist', () => {
        const stderr = [
            'Error opening input file /foo.mkv: No such file',
            // Later lines are more relevant — they reflect the terminal failure.
            'Invalid data found when processing input',
        ].join('\n');
        const summary = summarizeFfmpegStderr(stderr, 1);
        expect(summary).toContain('Invalid data found');
    });
});
