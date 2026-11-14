// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs REAL ffmpeg through `serveProgressiveTranscode` and probes what came out
 * of the HTTP body. Argument-string tests cannot tell whether a fragmented MP4
 * actually muxes through a pipe, or whether the GPU→software retry really
 * produces a stream — only execution can.
 *
 * The fixture mirrors the Moonfin incident: H.264 + 5.1 E-AC-3 in Matroska.
 * Skips when ffmpeg/ffprobe are absent.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { haveFfmpeg } from '../../../../tests/helpers/have-ffmpeg';

const { mockConfig, mockGetBestEncoder } = vi.hoisted(() => ({
    mockConfig: {
        FFMPEG_PATH: 'ffmpeg',
        JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT: 2,
        LUMASTRA_TRANSCODE_LOAD_SHED_RATIO: 0,
        VAAPI_DEVICE: '' as string,
        QSV_DEVICE: '',
    },
    mockGetBestEncoder: vi.fn(),
}));

vi.mock('$lib/server/config', () => ({ config: mockConfig }));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));
vi.mock('$lib/server/services/transcoding/hardware-detection', () => ({
    hardwareDetection: { getBestEncoder: mockGetBestEncoder },
}));
vi.mock('$lib/server/services/preview-admission.service', () => ({
    checkRealTranscodeLoadShed: () => ({ shed: false, loadRatio: 0, threshold: 0 }),
}));

const { serveProgressiveTranscode, activeProgressiveTranscodes } =
    await import('./progressive-transcode-runner');
const { parseProgressiveRequest, planProgressiveTranscode } =
    await import('./progressive-transcode');

const MOONFIN_720P =
    'Static=false&videoCodec=hevc&audioCodec=aac&videoBitRate=500000&audioBitRate=128000' +
    '&maxWidth=320&container=mp4&audioChannels=2';

interface ProbeStream {
    codec_type: string;
    codec_name: string;
    width?: number;
    channels?: number;
}

function probe(path: string): { format: string; streams: ProbeStream[] } {
    const out = execFileSync(
        'ffprobe',
        [
            '-v',
            'error',
            '-show_entries',
            'format=format_name:stream=codec_type,codec_name,width,channels',
            '-of',
            'json',
            path,
        ],
        { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out) as { format: { format_name: string }; streams: ProbeStream[] };
    return { format: parsed.format.format_name, streams: parsed.streams };
}

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('progressive transcode (real ffmpeg)', () => {
    let dir: string;
    let source: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'progressive-smoke-'));
        source = join(dir, 'source.mkv');
        execFileSync(
            'ffmpeg',
            [
                ...['-hide_banner', '-loglevel', 'error', '-y'],
                ...['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=6'],
                ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6'],
                ...['-map', '0:v', '-map', '1:a'],
                ...['-c:v', 'libx264', '-preset', 'ultrafast'],
                ...['-c:a', 'eac3', '-ac', '6'],
                source,
            ],
            { stdio: 'pipe', timeout: 120_000 },
        );
    });

    beforeEach(() => {
        mockGetBestEncoder.mockReset();
        mockConfig.VAAPI_DEVICE = '';
    });

    async function run(query: string, name: string) {
        const request = new Request(`http://localhost/j/Videos/x/stream?${query}`);
        const parsed = parseProgressiveRequest(new URL(request.url).searchParams);
        if (!parsed) throw new Error('not a progressive request');
        const plan = planProgressiveTranscode(parsed, {
            container: 'mkv',
            video: { codec: 'h264', width: 640, height: 360, bitrate: 2_000_000, isHdr: false },
            audio: [{ index: 1, codec: 'eac3', channels: 6, isDefault: true }],
        });
        if (plan.kind !== 'transcode') throw new Error('expected a transcode plan');
        const res = await serveProgressiveTranscode({
            plan,
            inputPath: source,
            request,
            itemId: 'item',
            username: 'leon',
        });
        const out = join(dir, name);
        writeFileSync(out, Buffer.from(await res.arrayBuffer()));
        return { res, out };
    }

    it('turns H.264 + E-AC-3 MKV into a fragmented MP4 with stereo AAC (Moonfin 720p)', async () => {
        // No GPU in CI: the software HEVC encoder.
        mockGetBestEncoder.mockResolvedValue('libx265');

        const { res, out } = await run(MOONFIN_720P, 'moonfin.mp4');

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('video/mp4');
        const probed = probe(out);
        expect(probed.format).toContain('mp4');
        const video = probed.streams.find((s) => s.codec_type === 'video');
        const audio = probed.streams.find((s) => s.codec_type === 'audio');
        expect(video).toMatchObject({ codec_name: 'hevc', width: 320 });
        expect(audio).toMatchObject({ codec_name: 'aac', channels: 2 });
        expect(activeProgressiveTranscodes()).toBe(0);
    }, 120_000);

    it('serves a copy-only remux over HTTP and retains multichannel E-AC-3', async () => {
        const { res, out } = await run(
            'static=false&container=mp4&videoCodec=h264&audioCodec=eac3&AudioStreamIndex=1',
            'remux.mp4',
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('video/mp4');
        const probed = probe(out);
        expect(probed.format).toContain('mp4');
        expect(probed.streams.find((s) => s.codec_type === 'video')).toMatchObject({
            codec_name: 'h264',
            width: 640,
        });
        expect(probed.streams.find((s) => s.codec_type === 'audio')).toMatchObject({
            codec_name: 'eac3',
            channels: 6,
        });
        expect(mockGetBestEncoder).not.toHaveBeenCalled();
        expect(activeProgressiveTranscodes()).toBe(0);
    }, 120_000);

    it('retries in software when the GPU encoder dies before any output', async () => {
        mockGetBestEncoder.mockResolvedValue('h264_vaapi');
        mockConfig.VAAPI_DEVICE = '/dev/dri/does-not-exist';

        const { res, out } = await run(
            'container=mp4&videoCodec=h264&audioCodec=aac&maxWidth=320&audioChannels=2',
            'fallback.mp4',
        );

        expect(res.status).toBe(200);
        const video = probe(out).streams.find((s) => s.codec_type === 'video');
        expect(video).toMatchObject({ codec_name: 'h264', width: 320 });
        expect(activeProgressiveTranscodes()).toBe(0);
    }, 120_000);

    it('kills ffmpeg and frees the slot when the client hangs up mid-stream', async () => {
        mockGetBestEncoder.mockResolvedValue('libx264');
        const request = new Request(
            'http://localhost/j/Videos/x/stream?container=mp4&videoCodec=h264&audioCodec=aac',
        );
        const parsed = parseProgressiveRequest(new URL(request.url).searchParams);
        if (!parsed) throw new Error('not a progressive request');
        const plan = planProgressiveTranscode(parsed, {
            container: 'mkv',
            // An mpeg4 source the client did not list forces a re-encode that outlives one read.
            video: { codec: 'mpeg4', width: 640, height: 360, bitrate: 2_000_000, isHdr: false },
            audio: [{ index: 1, codec: 'eac3', channels: 6, isDefault: true }],
        });
        if (plan.kind !== 'transcode') throw new Error('expected a transcode plan');
        const res = await serveProgressiveTranscode({
            plan,
            inputPath: source,
            request,
            itemId: 'item',
            username: 'leon',
        });
        const reader = res.body!.getReader();
        await reader.read();
        expect(activeProgressiveTranscodes()).toBe(1);
        await reader.cancel();
        await vi.waitFor(() => expect(activeProgressiveTranscodes()).toBe(0), { timeout: 10_000 });
    }, 120_000);

    it('copies the video and converts only the audio when the video fits', async () => {
        const { out } = await run(
            'container=mp4&videoCodec=h264,hevc&audioCodec=aac&audioChannels=2',
            'remux.mp4',
        );
        const streams = probe(out).streams;
        expect(streams.find((s) => s.codec_type === 'video')).toMatchObject({
            codec_name: 'h264',
            width: 640,
        });
        expect(streams.find((s) => s.codec_type === 'audio')).toMatchObject({
            codec_name: 'aac',
            channels: 2,
        });
        expect(mockGetBestEncoder).not.toHaveBeenCalled();
    }, 120_000);
});
