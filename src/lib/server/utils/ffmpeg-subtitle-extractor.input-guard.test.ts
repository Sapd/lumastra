// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every subtitle spawn reads a file ffmpeg opens with format auto-detection: a
 * library container, or an external sidecar (`.srt`/`.ass`) the scanner never
 * sniffs. A file whose CONTENT is an HLS/ffconcat/DASH/IMF playlist body would
 * have ffmpeg follow its references into other libraries and serve what it
 * finds as the subtitle track. Refused before each spawn (fix plan 6 follow-up
 * to the final-wave M1 guard, `transcoding/input-guard.ts`).
 *
 * The sniff is the REAL one over real temp files; only the ffmpeg spawn is
 * mocked.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawnFFmpegSafely: vi.fn() }));

vi.mock('$lib/server/config.js', () => ({
    config: { FFMPEG_PATH: '/usr/bin/ffmpeg', FFPROBE_PATH: '/usr/bin/ffprobe' },
}));

vi.mock('./ffmpeg-spawn.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./ffmpeg-spawn.js')>()),
    spawnFFmpegSafely: (...a: unknown[]) => h.spawnFFmpegSafely(...a),
}));

const REAL_MEDIA = `${process.cwd()}/tests/fixtures/test-video.mp4`;
const HLS_BODY = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/other/library/secret.ts\n';
const CONCAT_SIDECAR = "ffconcat version 1.0\nfile '/other/library/secret.srt'\n";
const REAL_SRT =
    '1\n00:00:01,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral Kenobi.\n';

let dir: string;

async function file(name: string, body: string): Promise<string> {
    const p = join(dir, name);
    await writeFile(p, body);
    return p;
}

function spawnArgs(): string[] {
    return (h.spawnFFmpegSafely.mock.calls[0][0] as { args: string[] }).args;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lumastra-subtitle-guard-'));
    h.spawnFFmpegSafely.mockReset().mockResolvedValue({
        exitCode: 0,
        stdout: 'WEBVTT\n',
        stderr: '',
        timedOut: false,
        sizeExceeded: false,
    });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('subtitle extraction — playlist-body source guard', () => {
    describe('extractSubtitleStream', () => {
        it('refuses a container whose content is a playlist body, before ffmpeg', async () => {
            const { extractSubtitleStream } = await import('./ffmpeg-subtitle-extractor.js');
            const input = await file('movie.mkv', HLS_BODY);

            await expect(
                extractSubtitleStream({ filePath: input, streamIndex: 2 }),
            ).rejects.toMatchObject({ name: 'PlaylistSourceRefusedError', magic: 'hls' });
            expect(h.spawnFFmpegSafely).not.toHaveBeenCalled();
        });

        it('refuses an external sidecar whose content is an ffconcat script, before ffmpeg', async () => {
            const { extractSubtitleStream } = await import('./ffmpeg-subtitle-extractor.js');
            const input = await file('movie.en.srt', CONCAT_SIDECAR);

            await expect(
                extractSubtitleStream({ filePath: input, streamIndex: 0, codec: 'subrip' }),
            ).rejects.toMatchObject({ name: 'PlaylistSourceRefusedError', magic: 'concat' });
            expect(h.spawnFFmpegSafely).not.toHaveBeenCalled();
        });

        it('control: real media and a real .srt sidecar both reach ffmpeg', async () => {
            const { extractSubtitleStream } = await import('./ffmpeg-subtitle-extractor.js');
            const srt = await file('movie.en.srt', REAL_SRT);

            await expect(
                extractSubtitleStream({ filePath: REAL_MEDIA, streamIndex: 2 }),
            ).resolves.toBe('WEBVTT\n');
            expect(spawnArgs()).toContain(REAL_MEDIA);

            await extractSubtitleStream({ filePath: srt, streamIndex: 0, codec: 'subrip' });
            expect(h.spawnFFmpegSafely).toHaveBeenCalledTimes(2);
        });
    });

    describe('extractSubtitleStreamsBinary / extractSubtitleStreamBinary', () => {
        it('refuses a playlist body before ffmpeg; the single-stream wrapper maps it to null', async () => {
            const { extractSubtitleStreamsBinary, extractSubtitleStreamBinary } =
                await import('./ffmpeg-subtitle-extractor.js');
            const input = await file('movie.mkv', HLS_BODY);

            await expect(extractSubtitleStreamsBinary(input, [3, 4], 'sup')).rejects.toMatchObject({
                name: 'PlaylistSourceRefusedError',
            });
            await expect(extractSubtitleStreamBinary(input, 3, 'sup')).resolves.toBeNull();
            expect(h.spawnFFmpegSafely).not.toHaveBeenCalled();
        });

        it('control: real media reaches ffmpeg', async () => {
            const { extractSubtitleStreamsBinary } = await import('./ffmpeg-subtitle-extractor.js');

            await extractSubtitleStreamsBinary(REAL_MEDIA, [3], 'sup');

            expect(spawnArgs()).toContain(REAL_MEDIA);
        });
    });

    describe('batchExtractSubtitles', () => {
        it('refuses a playlist body before ffmpeg', async () => {
            const { batchExtractSubtitles } = await import('./ffmpeg-subtitle-extractor.js');
            const input = await file('movie.mkv', HLS_BODY);

            await expect(
                batchExtractSubtitles({
                    filePath: input,
                    streams: [{ streamIndex: 2, outputPath: join(dir, 'out.vtt') }],
                }),
            ).rejects.toMatchObject({ name: 'PlaylistSourceRefusedError' });
            expect(h.spawnFFmpegSafely).not.toHaveBeenCalled();
        });

        it('control: real media reaches ffmpeg', async () => {
            const { batchExtractSubtitles } = await import('./ffmpeg-subtitle-extractor.js');

            await batchExtractSubtitles({
                filePath: REAL_MEDIA,
                streams: [{ streamIndex: 2, outputPath: join(dir, 'out.vtt') }],
            });

            expect(spawnArgs()).toContain(REAL_MEDIA);
        });
    });
});
