// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock spawnFFmpegSafely before imports
vi.mock('./ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: vi.fn(),
}));

// Mock fs/promises, but spread the real module: the playlist-body source
// guard opens the input with the real `open` (playlist-sniff.ts), and a
// nonexistent test path is left to ffmpeg (ENOENT) rather than to a guard
// refusal.
vi.mock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs/promises')>()),
    readFile: vi.fn(),
    unlink: vi.fn(),
}));

import {
    chromaprintFingerprint,
    detectBlackFrames,
    extractFrame,
    detectSilence,
} from './ffmpeg-analysis.js';
import { config } from '$lib/server/config.js';
import { configSchema } from '$lib/config/schema.js';
import { spawnFFmpegSafely } from './ffmpeg-spawn.js';
import { readFile, unlink, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSpawn = vi.mocked(spawnFFmpegSafely);
const mockReadFile = vi.mocked(readFile);
const mockUnlink = vi.mocked(unlink);

beforeEach(() => {
    vi.clearAllMocks();
    mockUnlink.mockResolvedValue(undefined);
});

describe('chromaprintFingerprint', () => {
    it('returns empty array for zero-length range', async () => {
        const result = await chromaprintFingerprint('/test.mkv', 5, 5, '/tmp');
        expect(result).toEqual(new Uint32Array(0));
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('calls FFmpeg with correct chromaprint args', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });
        // Create a buffer with 2 uint32 values: [42, 99]
        const buf = Buffer.alloc(8);
        buf.writeUInt32LE(42, 0);
        buf.writeUInt32LE(99, 4);
        mockReadFile.mockResolvedValue(buf);

        const result = await chromaprintFingerprint('/test.mkv', 0, 600, '/tmp');

        expect(mockSpawn).toHaveBeenCalledOnce();
        const call = mockSpawn.mock.calls[0][0];
        expect(call.args).toContain('-f');
        expect(call.args).toContain('chromaprint');
        expect(call.args).toContain('-fp_format');
        expect(call.args).toContain('raw');
        expect(call.args).toContain('-t');
        expect(call.args).toContain('600');

        expect(result).toBeInstanceOf(Uint32Array);
        expect(result.length).toBe(2);
        expect(result[0]).toBe(42);
        expect(result[1]).toBe(99);
    });

    it('cleans up temp file on success', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });
        mockReadFile.mockResolvedValue(Buffer.alloc(4));

        await chromaprintFingerprint('/test.mkv', 0, 10, '/tmp');

        expect(mockUnlink).toHaveBeenCalledOnce();
    });

    it('cleans up temp file on FFmpeg failure', async () => {
        mockSpawn.mockRejectedValue(new Error('FFmpeg failed'));

        await expect(chromaprintFingerprint('/test.mkv', 0, 10, '/tmp')).rejects.toThrow(
            'FFmpeg failed',
        );

        expect(mockUnlink).toHaveBeenCalledOnce();
    });
});

describe('detectBlackFrames', () => {
    it('returns empty array for zero-length range', async () => {
        const result = await detectBlackFrames('/test.mkv', 10, 10);
        expect(result).toEqual([]);
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('parses blackframe filter output with pblack format', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: [
                '[blackframe @ 0x1234] frame:1 pblack:98 pts:0 t:0.000000 type:I last_keyframe:0',
                '[blackframe @ 0x1234] frame:42 pblack:95 pts:175000 t:1.750000 type:P last_keyframe:0',
            ].join('\n'),
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });

        const result = await detectBlackFrames('/test.mkv', 100, 110);

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ time: 100, blackPercentage: 98 });
        expect(result[1]).toEqual({ time: 101.75, blackPercentage: 95 });
    });

    it('passes correct FFmpeg args', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });

        await detectBlackFrames('/test.mkv', 50, 70, {
            minimumBlackPct: 80,
            threshold: 16,
        });

        const call = mockSpawn.mock.calls[0][0];
        expect(call.args).toContain('-ss');
        expect(call.args).toContain('50');
        expect(call.args).toContain('-t');
        expect(call.args).toContain('20');
        // The blackframe filter is composed into the -vf argument with
        // scale + fps, not passed as its own arg. Assert the substring
        // appears in any single arg.
        expect(
            (call.args as string[]).some((a) => a.includes('blackframe=amount=80:threshold=16')),
        ).toBe(true);
    });

    it('returns sorted results', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: [
                '[blackframe @ 0x1] frame:2 pblack:90 pts:0 t:3.000000 type:I last_keyframe:0',
                '[blackframe @ 0x1] frame:1 pblack:95 pts:0 t:1.000000 type:I last_keyframe:0',
            ].join('\n'),
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });

        const result = await detectBlackFrames('/test.mkv', 0, 10);
        expect(result[0].time).toBeLessThan(result[1].time);
    });

    it('parses blackframe filter output with pct format', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: '[blackframe @ 0x1234] frame:5 pct:92 pts:0 t:2.500000 type:I last_keyframe:0',
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });

        const result = await detectBlackFrames('/test.mkv', 0, 10);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ time: 2.5, blackPercentage: 92 });
    });

    it('throws and logs on FFmpeg failure', async () => {
        mockSpawn.mockRejectedValue(new Error('ffmpeg crashed'));

        await expect(detectBlackFrames('/test.mkv', 0, 10)).rejects.toThrow('ffmpeg crashed');
    });
});

describe('extractFrame', () => {
    it('returns JPEG buffer by default', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });
        const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
        mockReadFile.mockResolvedValue(fakeJpeg);

        const result = await extractFrame('/test.mkv', 30, '/tmp');

        expect(result.buffer).toBe(fakeJpeg);
        expect(result.format).toBe('jpeg');
    });

    it('passes correct args for PNG with dimensions', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });
        mockReadFile.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        await extractFrame('/test.mkv', 10, '/tmp', {
            format: 'png',
            width: 320,
            height: 240,
        });

        const call = mockSpawn.mock.calls[0][0];
        expect(call.args).toContain('png');
        expect(call.args.join(',')).toContain('scale=320:240');
    });

    it('cleans up temp file on success', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });
        mockReadFile.mockResolvedValue(Buffer.from([0xff, 0xd8]));

        await extractFrame('/test.mkv', 5, '/tmp');

        expect(mockUnlink).toHaveBeenCalledOnce();
    });

    it('cleans up temp file on failure', async () => {
        mockSpawn.mockRejectedValue(new Error('FFmpeg failed'));

        await expect(extractFrame('/test.mkv', 5, '/tmp')).rejects.toThrow('FFmpeg failed');

        expect(mockUnlink).toHaveBeenCalledOnce();
    });
});

describe('detectSilence', () => {
    it('returns empty array for zero-length range', async () => {
        const result = await detectSilence('/test.mkv', 50, 50);
        expect(result).toEqual([]);
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('parses silencedetect output', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: [
                '[silencedetect @ 0x1234] silence_start: 1.5',
                '[silencedetect @ 0x1234] silence_end: 3.2 | silence_duration: 1.7',
                '[silencedetect @ 0x1234] silence_start: 8.0',
                '[silencedetect @ 0x1234] silence_end: 9.5 | silence_duration: 1.5',
            ].join('\n'),
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });

        const result = await detectSilence('/test.mkv', 100, 200);

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ start: 101.5, end: 103.2, duration: 1.7 });
        expect(result[1]).toEqual({ start: 108.0, end: 109.5, duration: 1.5 });
    });

    it('passes correct args with custom options', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });

        await detectSilence('/test.mkv', 0, 60, {
            noiseDb: -40,
            minDuration: 2.0,
        });

        const call = mockSpawn.mock.calls[0][0];
        expect(call.args.join(' ')).toContain('silencedetect=noise=-40dB:d=2');
    });

    it('handles trailing silence (no silence_end)', async () => {
        mockSpawn.mockResolvedValue({
            stdout: '',
            stderr: '[silencedetect @ 0x1234] silence_start: 5.0',
            exitCode: 0,
            timedOut: false,
            sizeExceeded: false,
        });

        const result = await detectSilence('/test.mkv', 0, 60);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ start: 5.0, end: 60, duration: 55 });
    });

    it('throws on FFmpeg failure', async () => {
        mockSpawn.mockRejectedValue(new Error('ffmpeg error'));

        await expect(detectSilence('/test.mkv', 0, 60)).rejects.toThrow('ffmpeg error');
    });
});

// ---------------------------------------------------------------------------
// Playlist-body source guard (fix plan 6 follow-up to the final-wave M1
// guard, transcoding/input-guard.ts)
// ---------------------------------------------------------------------------
//
// Every spawn in this file first refuses an input whose CONTENT is a
// playlist/manifest body: episode.filePath is a library file, and a body
// rewritten into an HLS/ffconcat/DASH/IMF playlist would have ffmpeg follow
// its references into other libraries. The sniff is the REAL one over real
// temp files (only spawnFFmpegSafely and the tmp-file readFile/unlink are
// mocked, per the module mocks above).
describe('playlist-body source guard', () => {
    const REAL_MEDIA = join(process.cwd(), 'tests/fixtures/test-video.mp4');
    const HLS_BODY = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/other/library/secret.ts\n';

    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'lumastra-ffmpeg-analysis-guard-'));
        mockUnlink.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    describe('chromaprintFingerprint', () => {
        it('refuses a playlist body: no ffmpeg spawn', async () => {
            const input = join(dir, 'episode.mkv');
            await writeFile(input, HLS_BODY);

            await expect(chromaprintFingerprint(input, 0, 10, dir)).rejects.toMatchObject({
                name: 'PlaylistSourceRefusedError',
            });
            expect(mockSpawn).not.toHaveBeenCalled();
        });

        it('control: real media reaches the ffmpeg spawn', async () => {
            mockSpawn.mockResolvedValue({
                stdout: '',
                stderr: '',
                exitCode: 0,
                timedOut: false,
                sizeExceeded: false,
            });
            mockReadFile.mockResolvedValue(Buffer.alloc(4));

            await chromaprintFingerprint(REAL_MEDIA, 0, 10, dir);

            expect(mockSpawn).toHaveBeenCalledOnce();
            expect(mockSpawn.mock.calls[0][0].args).toContain(REAL_MEDIA);
        });
    });

    describe('detectBlackFrames', () => {
        it('refuses a playlist body: no ffmpeg spawn', async () => {
            const input = join(dir, 'episode.mkv');
            await writeFile(input, HLS_BODY);

            await expect(detectBlackFrames(input, 0, 10)).rejects.toMatchObject({
                name: 'PlaylistSourceRefusedError',
            });
            expect(mockSpawn).not.toHaveBeenCalled();
        });

        it('control: real media reaches the ffmpeg spawn', async () => {
            mockSpawn.mockResolvedValue({
                stdout: '',
                stderr: '',
                exitCode: 0,
                timedOut: false,
                sizeExceeded: false,
            });

            await detectBlackFrames(REAL_MEDIA, 0, 10);

            expect(mockSpawn).toHaveBeenCalledOnce();
            expect(mockSpawn.mock.calls[0][0].args).toContain(REAL_MEDIA);
        });
    });

    describe('extractFrame', () => {
        it('refuses a playlist body: no ffmpeg spawn', async () => {
            const input = join(dir, 'episode.mkv');
            await writeFile(input, HLS_BODY);

            await expect(extractFrame(input, 5, dir)).rejects.toMatchObject({
                name: 'PlaylistSourceRefusedError',
            });
            expect(mockSpawn).not.toHaveBeenCalled();
        });

        it('control: real media reaches the ffmpeg spawn', async () => {
            mockSpawn.mockResolvedValue({
                stdout: '',
                stderr: '',
                exitCode: 0,
                timedOut: false,
                sizeExceeded: false,
            });
            mockReadFile.mockResolvedValue(Buffer.from([0xff, 0xd8]));

            await extractFrame(REAL_MEDIA, 5, dir);

            expect(mockSpawn).toHaveBeenCalledOnce();
            expect(mockSpawn.mock.calls[0][0].args).toContain(REAL_MEDIA);
        });
    });

    describe('detectSilence', () => {
        it('refuses a playlist body: no ffmpeg spawn', async () => {
            const input = join(dir, 'episode.mkv');
            await writeFile(input, HLS_BODY);

            await expect(detectSilence(input, 0, 10)).rejects.toMatchObject({
                name: 'PlaylistSourceRefusedError',
            });
            expect(mockSpawn).not.toHaveBeenCalled();
        });

        it('control: real media reaches the ffmpeg spawn', async () => {
            mockSpawn.mockResolvedValue({
                stdout: '',
                stderr: '',
                exitCode: 0,
                timedOut: false,
                sizeExceeded: false,
            });

            await detectSilence(REAL_MEDIA, 0, 10);

            expect(mockSpawn).toHaveBeenCalledOnce();
            expect(mockSpawn.mock.calls[0][0].args).toContain(REAL_MEDIA);
        });
    });
});

describe('bounded analysis decode', () => {
    const result = { stdout: '', stderr: '', exitCode: 0, timedOut: false, sizeExceeded: false };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('defaults runtime and admin settings to two threads, retaining explicit auto', () => {
        expect(config.ANALYSIS_FFMPEG_THREADS).toBe(2);
        const setting = configSchema.find((s) => s.key === 'ANALYSIS_FFMPEG_THREADS');
        expect(setting?.defaultValue).toBe(2);
        expect(setting?.validation?.min).toBe(0);
    });

    it.each(['blackframe', 'fingerprint', 'silence', 'frame'])(
        '%s caps the input decoder and filters',
        async (operation) => {
            vi.spyOn(config, 'ANALYSIS_FFMPEG_THREADS', 'get').mockReturnValue(2);
            mockSpawn.mockResolvedValue(result);
            mockReadFile.mockResolvedValue(Buffer.alloc(4));
            if (operation === 'blackframe') await detectBlackFrames('/test.mkv', 0, 10);
            if (operation === 'fingerprint')
                await chromaprintFingerprint('/test.mkv', 0, 10, '/tmp');
            if (operation === 'silence') await detectSilence('/test.mkv', 0, 10);
            if (operation === 'frame') await extractFrame('/test.mkv', 0, '/tmp');
            const args = mockSpawn.mock.calls[0]![0].args;
            expect(args.indexOf('-threads')).toBeLessThan(args.indexOf('-i'));
            expect(args.slice(args.indexOf('-threads'), args.indexOf('-threads') + 2)).toEqual([
                '-threads',
                '2',
            ]);
            expect(
                args.slice(args.indexOf('-filter_threads'), args.indexOf('-filter_threads') + 2),
            ).toEqual(['-filter_threads', '2']);
        },
    );

    it('keeps every decoded frame, scales before sampling, and uses fast software decode', async () => {
        mockSpawn.mockResolvedValue(result);
        await detectBlackFrames('/test.mkv', 0, 10);
        const args = mockSpawn.mock.calls[0]![0].args;
        expect(args.slice(args.indexOf('-flags2'), args.indexOf('-flags2') + 2)).toEqual([
            '-flags2',
            '+fast',
        ]);
        expect(args.indexOf('-flags2')).toBeLessThan(args.indexOf('-i'));
        expect(args).not.toContain('-skip_frame');
        expect(args[args.indexOf('-vf') + 1]).toBe(
            'scale=320:-2:flags=fast_bilinear,fps=5,blackframe=amount=50:threshold=32',
        );
        expect(args).toEqual(expect.arrayContaining(['-an', '-sn', '-dn']));
    });

    it('passes explicit zero through to ffmpeg (also prevents the global cap replacing it)', async () => {
        mockSpawn.mockResolvedValue(result);
        await detectBlackFrames('/test.mkv', 0, 10, { threads: 0 });
        const args = mockSpawn.mock.calls[0]![0].args;
        expect(args.slice(args.indexOf('-threads'), args.indexOf('-threads') + 2)).toEqual([
            '-threads',
            '0',
        ]);
        expect(
            args.slice(args.indexOf('-filter_threads'), args.indexOf('-filter_threads') + 2),
        ).toEqual(['-filter_threads', '0']);
    });

    it('serializes visual analysis, including frame extraction, and releases after failure', async () => {
        let active = 0;
        let peak = 0;
        mockReadFile.mockResolvedValue(Buffer.alloc(4));
        mockSpawn.mockImplementation(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 30));
            active--;
            if (mockSpawn.mock.calls.length === 1) throw new Error('decode failed');
            return result;
        });
        const settled = await Promise.allSettled([
            detectBlackFrames('/one.mkv', 0, 10),
            extractFrame('/two.mkv', 0, '/tmp'),
            detectBlackFrames('/three.mkv', 0, 10),
        ]);
        expect(peak).toBe(1);
        expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    });
});

it('cancels blackframe analysis while it waits for the visual permit, without spawning', async () => {
    let release!: () => void;
    const result = { stdout: '', stderr: '', exitCode: 0, timedOut: false, sizeExceeded: false };
    mockSpawn.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
            release = resolve;
        });
        return result;
    });
    mockSpawn.mockResolvedValue(result);
    const active = detectBlackFrames('/active.mkv', 0, 600, { timeout: 1_200_000, threads: 2 });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const waiting = detectBlackFrames('/waiting.mkv', 0, 900, {
        timeout: 1_800_000,
        threads: 2,
        abortSignal: controller.signal,
    });
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    try {
        await rejected;
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
        release();
        await active;
    }
    await detectBlackFrames('/next.mkv', 0, 40, { threads: 2 });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
});

it.each([NaN, Infinity, -Infinity])(
    'refuses non-finite blackframe window %s without spawning',
    async (end) => {
        expect(await detectBlackFrames('/video.mkv', 0, end)).toEqual([]);
        expect(mockSpawn).not.toHaveBeenCalled();
    },
);
