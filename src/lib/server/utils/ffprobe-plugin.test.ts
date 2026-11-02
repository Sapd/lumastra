// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the FFprobe functions probeStreams and probeFormat (their one
 * production caller is `probeAudioSource`, services/music-transcode/source-metadata.ts).
 *
 * Uses a separate test file to avoid vi.mock('child_process') interfering
 * with the existing ffprobe.test.ts tests that call real ffprobe.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

// Mock child_process with custom promisify support
vi.mock('child_process', () => {
    const execFileFn = vi.fn() as ReturnType<typeof vi.fn> & {
        [promisify.custom]?: ReturnType<typeof vi.fn>;
    };
    // Node's promisify has special handling for execFile via
    // Symbol(nodejs.util.promisify.custom). We need to provide it
    // so promisify(execFile) returns {stdout, stderr} correctly.
    execFileFn[promisify.custom] = vi.fn();
    return { execFile: execFileFn };
});

vi.mock('$lib/server/config.js', () => ({
    config: { FFPROBE_PATH: '/usr/bin/ffprobe' },
}));

import { probeStreams, probeFormat } from './ffprobe.js';
import { execFile } from 'child_process';

// Get the custom promisify mock
const mockExecFileAsync = vi.mocked(
    (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisify.custom],
);

function mockExecFileResult(stdout: string): void {
    mockExecFileAsync.mockResolvedValue({ stdout, stderr: '' });
}

function mockExecFileError(err: Error): void {
    mockExecFileAsync.mockRejectedValue(err);
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('probeStreams', () => {
    it('returns all stream types', async () => {
        const ffprobeOutput = JSON.stringify({
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
                {
                    index: 1,
                    codec_type: 'audio',
                    codec_name: 'aac',
                    channels: 2,
                    tags: { language: 'eng' },
                    disposition: { default: 1 },
                },
                {
                    index: 2,
                    codec_type: 'audio',
                    codec_name: 'ac3',
                    channels: 6,
                    tags: { language: 'ger' },
                    disposition: { default: 0 },
                },
                {
                    index: 3,
                    codec_type: 'subtitle',
                    codec_name: 'subrip',
                    tags: { language: 'eng' },
                    disposition: { default: 0, forced: 0 },
                },
            ],
        });
        mockExecFileResult(ffprobeOutput);

        const result = await probeStreams('/test.mkv');

        expect(result.video).toHaveLength(1);
        expect(result.video[0].codec).toBe('h264');
        expect(result.video[0].width).toBe(1920);
        expect(result.video[0].height).toBe(1080);

        expect(result.audio).toHaveLength(2);
        expect(result.audio[0].language).toBe('eng');
        expect(result.audio[0].channels).toBe(2);
        expect(result.audio[1].language).toBe('ger');
        expect(result.audio[1].channels).toBe(6);

        expect(result.subtitle).toHaveLength(1);
        expect(result.subtitle[0].codec).toBe('subrip');
        expect(result.subtitle[0].language).toBe('eng');
    });

    it('parses fps and pixelFormat', async () => {
        const ffprobeOutput = JSON.stringify({
            streams: [
                {
                    index: 0,
                    codec_type: 'video',
                    codec_name: 'hevc',
                    width: 3840,
                    height: 2160,
                    r_frame_rate: '24000/1001',
                    pix_fmt: 'yuv420p10le',
                },
            ],
        });
        mockExecFileResult(ffprobeOutput);

        const result = await probeStreams('/test.mkv');

        expect(result.video).toHaveLength(1);
        const video = result.video[0];
        expect(video.fps).toBeCloseTo(23.976, 2);
        expect(video.pixelFormat).toBe('yuv420p10le');
    });

    it('throws on ffprobe failure', async () => {
        mockExecFileError(new Error('ffprobe not found'));

        await expect(probeStreams('/test.mkv')).rejects.toThrow('ffprobe not found');
    });
});

describe('probeFormat', () => {
    it('returns format info with tags', async () => {
        const ffprobeOutput = JSON.stringify({
            format: {
                format_name: 'matroska,webm',
                size: '1234567890',
                bit_rate: '8000000',
                duration: '7200.5',
                tags: {
                    title: 'Test Movie',
                    encoder: 'libebml',
                },
            },
        });
        mockExecFileResult(ffprobeOutput);

        const result = await probeFormat('/test.mkv');

        expect(result.formatName).toBe('matroska,webm');
        expect(result.fileSize).toBe(1234567890);
        expect(result.bitrate).toBe(8000000);
        expect(result.duration).toBeCloseTo(7200.5, 1);
        expect(result.tags).toEqual({
            title: 'Test Movie',
            encoder: 'libebml',
        });
    });

    it('returns empty tags when none present', async () => {
        const ffprobeOutput = JSON.stringify({
            format: {
                format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
                size: '500000000',
                bit_rate: '4000000',
                duration: '3600.0',
            },
        });
        mockExecFileResult(ffprobeOutput);

        const result = await probeFormat('/test.mp4');

        expect(result.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2');
        expect(result.tags).toEqual({});
    });

    it('throws on ffprobe failure', async () => {
        mockExecFileError(new Error('timeout'));

        await expect(probeFormat('/test.mkv')).rejects.toThrow('timeout');
    });
});
