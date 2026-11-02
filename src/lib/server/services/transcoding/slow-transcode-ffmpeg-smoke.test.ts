// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End to end through REAL FFmpeg: its `-stats` progress lines go through the
 * process runner's parser and live-rates window into the slow-transcode
 * tracker, and the job ends up flagged — or not.
 *
 * The slow encode stands in for a GPU encoder shared with a game stream
 * (2026-10-14: hevc_nvenc at ~1 fps next to Sunshine): the `realtime`
 * filter holds FFmpeg at 0.5x, deterministically, on any machine. The
 * control encode is held at 2x the same way (a tiny 320x180 encode reaches
 * that on any runner), so it keeps up and must never be flagged.
 *
 * Takes ~22 s. Skips when no ffmpeg is available.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TranscodeJob } from './types.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

vi.mock('../../config.js', () => ({
    config: { FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg', FFMPEG_SEGMENT_DURATION: 6 },
}));
vi.mock('../../utils/logger.js', () => ({
    Logger: { for: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
}));

function haveFfmpeg(): boolean {
    try {
        execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function makeJob(id: string): TranscodeJob {
    return {
        id,
        config: {
            playSessionId: id,
            itemId: 'item',
            username: 'u',
            deviceId: 'd',
            audioTracks: [],
            inputUrl: 'lavfi',
            videoInfo: { codec: 'h264', width: 320, height: 180 },
        },
        outputDir: mkdtempSync(join(tmpdir(), `slow-smoke-${id}-`)),
        status: 'starting',
        segmentsReady: 0,
        segmentOffset: 0,
        process: null,
        startedAt: new Date(),
        lastAccessedAt: new Date(),
        lastProgressAt: new Date(),
        masterPlaylistReady: true,
        segmentDurationSeconds: 6,
        transcodeDecisionResult: {
            mode: 'full',
            reasons: 0,
            videoAction: 'transcode',
            audioAction: 'copy',
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
        },
    } as unknown as TranscodeJob;
}

/** A 320x180 libx264 encode to the null muxer, optionally slowed to `speed`. */
function encodeArgs(opts: { realtimeSpeed: number }): string[] {
    return [
        ...['-hide_banner', '-nostdin', '-stats', '-loglevel', 'error'],
        ...['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=60'],
        ...['-vf', `realtime=speed=${opts.realtimeSpeed}`],
        ...['-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'null', '-'],
    ];
}

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('slow-transcode detection with real FFmpeg', () => {
    it('flags a 0.5x encode as cpu_slow and leaves a 2x one alone', async () => {
        const { FFmpegProcessRunnerEvents } = await import('./process-runner.js');
        const { startSlowTracking, slowTranscodeReason, STARTUP_GRACE_MS, SLOW_AFTER_MS } =
            await import('./slow-transcode.js');
        const runner = new FFmpegProcessRunnerEvents();
        const callbacks = { onExit: () => {}, onError: () => {}, onMasterPlaylistCheck: () => {} };

        const slow = makeJob('slow');
        const realtime = makeJob('realtime');
        slow.slowTranscode = startSlowTracking(Date.now());
        realtime.slowTranscode = startSlowTracking(Date.now());
        await Promise.all([
            runner.spawnFFmpeg(slow, encodeArgs({ realtimeSpeed: 0.5 }), callbacks),
            runner.spawnFFmpeg(realtime, encodeArgs({ realtimeSpeed: 2 }), callbacks),
        ]);

        try {
            const deadline = Date.now() + STARTUP_GRACE_MS + SLOW_AFTER_MS + 4000;
            while (Date.now() < deadline && !slowTranscodeReason(slow, Date.now())) {
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
            // Throttled to 0.5x; wide bounds so a loaded runner does not flake.
            expect(slow.transcodeSpeed).toBeGreaterThan(0.2);
            expect(slow.transcodeSpeed).toBeLessThan(0.8);
            expect(slowTranscodeReason(slow, Date.now())).toBe('cpu_slow');

            expect(realtime.transcodeSpeed).toBeGreaterThan(1.3);
            expect(slowTranscodeReason(realtime, Date.now())).toBeUndefined();
        } finally {
            await Promise.all([runner.killFFmpeg(slow, 2000), runner.killFFmpeg(realtime, 2000)]);
        }
    }, 40_000);
});
