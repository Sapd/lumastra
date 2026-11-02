// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * P1 + R2 residual (fix plan 6, Task 7 / S-P1c): `probeMediaFile` — the
 * scanner's and every other caller's library probe — must pass
 * `-protocol_whitelist file` so the ffprobe process has no app-side default
 * protocol set for the file it opens. Every caller of `probeMediaFile`
 * passes a resolved local disk path (media-path-resolver.ts is
 * local-disk-only), so `file` alone is sufficient — this is the app's own
 * contribution to R2, independent of the pinned jellyfin-ffmpeg binary's own
 * HLS/concat demuxer gates.
 *
 * Uses a separate test file to avoid `vi.mock('child_process')` interfering
 * with the existing ffprobe.test.ts tests that call real ffprobe (same
 * convention as ffprobe-plugin.test.ts / ffprobe-error-detail.test.ts).
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

import { probeMediaFile, probeFormat, probeStreams } from './ffprobe.js';
import { execFile } from 'child_process';

const mockExecFileAsync = vi.mocked(
    (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisify.custom],
);

beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileAsync.mockResolvedValue({
        stdout: JSON.stringify({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }),
        stderr: '',
    });
});

describe('probeMediaFile — protocol whitelist (P1+R2 residual)', () => {
    it('passes -protocol_whitelist file immediately before the probed path', async () => {
        await probeMediaFile('/data/movies/Movie.mkv');

        expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
        const args = mockExecFileAsync.mock.calls[0]![1] as string[];

        const pathIndex = args.indexOf('/data/movies/Movie.mkv');
        expect(pathIndex).toBeGreaterThan(-1);
        expect(args[pathIndex - 2]).toBe('-protocol_whitelist');
        expect(args[pathIndex - 1]).toBe('file');
    });

    // Control: the rest of the argv (unrelated to the whitelist) is unchanged.
    it('still requests JSON streams+format output', async () => {
        await probeMediaFile('/data/movies/Movie.mkv');

        const args = mockExecFileAsync.mock.calls[0]![1] as string[];
        expect(args).toContain('-show_streams');
        expect(args).toContain('-show_format');
        expect(args).toContain('json');
    });
});

// F1c (fix plan 6, Task 7 fix round 1): probeAudioSource (music transcode's
// source-metadata.ts) is the only caller of these two "plugin-facing" probe
// functions today, and it always passes a resolved local disk path — same
// local-disk-only guarantee as probeMediaFile.
describe('probeFormat — protocol whitelist (F1c)', () => {
    it('passes -protocol_whitelist file immediately before the probed path', async () => {
        await probeFormat('/data/music/Track.flac');

        const args = mockExecFileAsync.mock.calls[0]![1] as string[];
        const pathIndex = args.indexOf('/data/music/Track.flac');
        expect(pathIndex).toBeGreaterThan(-1);
        expect(args[pathIndex - 2]).toBe('-protocol_whitelist');
        expect(args[pathIndex - 1]).toBe('file');
    });
});

describe('probeStreams — protocol whitelist (F1c)', () => {
    it('passes -protocol_whitelist file immediately before the probed path', async () => {
        await probeStreams('/data/music/Track.flac');

        const args = mockExecFileAsync.mock.calls[0]![1] as string[];
        const pathIndex = args.indexOf('/data/music/Track.flac');
        expect(pathIndex).toBeGreaterThan(-1);
        expect(args[pathIndex - 2]).toBe('-protocol_whitelist');
        expect(args[pathIndex - 1]).toBe('file');
    });
});
