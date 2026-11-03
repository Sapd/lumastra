// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subtitle extraction runs at most MAX_CONCURRENT_SUBTITLE_EXTRACTIONS FFmpeg
 * processes per server process. Windows e2e 2026-09-27 (S11): one episode with
 * 54 embedded SRT tracks forked 8+ concurrent full-file `-c:s webvtt` reads.
 * Only the ffmpeg spawn is mocked; the input guard reads a real temp file.
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

const REAL_SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello there.\n';

let dir: string;
let releases: Array<() => void>;

/** Let queued promise continuations (guard sniff, semaphore hand-off) run. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lumastra-subtitle-cap-'));
    releases = [];
    h.spawnFFmpegSafely.mockReset().mockImplementation(
        () =>
            new Promise((resolve) => {
                releases.push(() =>
                    resolve({
                        exitCode: 0,
                        stdout: 'WEBVTT\n',
                        stderr: '',
                        timedOut: false,
                        sizeExceeded: false,
                    }),
                );
            }),
    );
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('subtitle extraction — process-wide concurrency cap', () => {
    it('never runs more than the cap at once, and drains the queue in order', async () => {
        const { extractSubtitleStream, MAX_CONCURRENT_SUBTITLE_EXTRACTIONS } =
            await import('./ffmpeg-subtitle-extractor.js');
        const input = join(dir, 'episode.en.srt');
        await writeFile(input, REAL_SRT);

        const requests = Array.from({ length: MAX_CONCURRENT_SUBTITLE_EXTRACTIONS + 5 }, (_, i) =>
            extractSubtitleStream({ filePath: input, streamIndex: i + 2 }),
        );
        // The input guard reads a real file, so the first spawn can take longer than
        // a fixed number of timer turns on a loaded machine: wait for it, THEN let
        // the queue settle and assert the exact count (an overshoot still fails).
        await vi.waitFor(() => expect(h.spawnFFmpegSafely.mock.calls.length).toBeGreaterThan(0));
        await settle();
        expect(h.spawnFFmpegSafely).toHaveBeenCalledTimes(MAX_CONCURRENT_SUBTITLE_EXTRACTIONS);

        // Finishing one extraction admits exactly one queued request.
        releases.shift()?.();
        await vi.waitFor(() =>
            expect(h.spawnFFmpegSafely.mock.calls.length).toBeGreaterThan(
                MAX_CONCURRENT_SUBTITLE_EXTRACTIONS,
            ),
        );
        await settle();
        expect(h.spawnFFmpegSafely).toHaveBeenCalledTimes(MAX_CONCURRENT_SUBTITLE_EXTRACTIONS + 1);

        // Drain everything: every request is served, none is dropped.
        while (releases.length > 0) {
            releases.shift()?.();
            await settle();
        }
        await expect(Promise.all(requests)).resolves.toHaveLength(requests.length);
        expect(h.spawnFFmpegSafely).toHaveBeenCalledTimes(requests.length);
    });

    it('frees the slot when an extraction fails', async () => {
        const { extractSubtitleStream, MAX_CONCURRENT_SUBTITLE_EXTRACTIONS } =
            await import('./ffmpeg-subtitle-extractor.js');
        const input = join(dir, 'episode.de.srt');
        await writeFile(input, REAL_SRT);
        h.spawnFFmpegSafely.mockReset().mockRejectedValue(new Error('ffmpeg exploded'));

        const results = await Promise.allSettled(
            Array.from({ length: MAX_CONCURRENT_SUBTITLE_EXTRACTIONS * 2 }, (_, i) =>
                extractSubtitleStream({ filePath: input, streamIndex: i + 2 }),
            ),
        );
        expect(results.every((r) => r.status === 'rejected')).toBe(true);
        expect(h.spawnFFmpegSafely).toHaveBeenCalledTimes(MAX_CONCURRENT_SUBTITLE_EXTRACTIONS * 2);
    });
});
