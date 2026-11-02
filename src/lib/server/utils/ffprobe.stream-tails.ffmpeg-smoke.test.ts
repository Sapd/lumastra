// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs REAL ffprobe against a generated Matroska clip and a copy cut in half.
 * The premature-EOF signal (`File ended prematurely` on stderr) only exists in
 * the real demuxer's output, so a string-level test cannot prove it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { probeStreamTails } from './ffprobe';
import { haveFfmpeg } from '../../../../tests/helpers/have-ffmpeg';

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('probeStreamTails (real ffprobe)', () => {
    let dir: string;
    let complete: string;
    let cut: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'stream-tails-'));
        complete = join(dir, 'complete.mkv');
        execFileSync(
            'ffmpeg',
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-y',
                '-f',
                'lavfi',
                '-i',
                'testsrc=size=320x180:rate=25:duration=20',
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=440:duration=20',
                '-map',
                '0:v',
                '-map',
                '1:a',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-pix_fmt',
                'yuv420p',
                '-c:a',
                'aac',
                '-shortest',
                complete,
            ],
            { stdio: 'pipe', timeout: 120_000 },
        );
        cut = join(dir, 'cut.mkv');
        const bytes = readFileSync(complete);
        writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('reports both streams ending at the real runtime for a complete clip', async () => {
        const tails = await probeStreamTails(complete);

        expect(tails.success).toBe(true);
        expect(tails.hasAudio).toBe(true);
        expect(tails.endedPrematurely).toBe(false);
        expect(tails.videoEnd).not.toBeNull();
        expect(tails.audioEnd).not.toBeNull();
        expect(tails.videoEnd!).toBeGreaterThan(18);
        expect(tails.videoEnd!).toBeLessThanOrEqual(20.5);
        expect(tails.audioEnd!).toBeGreaterThan(18);
    });

    it('reports a half-written Matroska file as ended prematurely', async () => {
        const tails = await probeStreamTails(cut);

        expect(tails.endedPrematurely).toBe(true);
    });

    it('rejects healthy-looking partial packets from an actual nonzero subprocess', async () => {
        const partialProbe = join(dir, 'partial-ffprobe');
        writeFileSync(
            partialProbe,
            `#!/bin/sh
case "$*" in
    *stream=codec_type:packet=pts_time*) printf '1360.0\\naudio\\n' ;;
    *) printf '1355.0\\n' ;;
esac
exit 1
`,
            { mode: 0o755 },
        );
        const path = vi.spyOn(config, 'FFPROBE_PATH', 'get').mockReturnValue(partialProbe);
        try {
            expect(await probeStreamTails(complete)).toEqual({
                success: false,
                videoEnd: 1355,
                audioEnd: 1360,
                hasAudio: true,
                endedPrematurely: false,
            });
        } finally {
            path.mockRestore();
        }
    });

    it('returns nulls and never throws for a file that does not exist', async () => {
        const tails = await probeStreamTails(join(dir, 'missing.mkv'));

        expect(tails).toEqual({
            success: false,
            videoEnd: null,
            audioEnd: null,
            hasAudio: false,
            endedPrematurely: false,
        });
    });
});
