// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { probeVideoTiming } from './ffprobe-video-timing.js';
import { haveFfmpeg } from '../../../../tests/helpers/have-ffmpeg';
import malformed from './__fixtures__/nonadvancing-av1-packets.json';

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('video timing with actual subprocesses and generated media', () => {
    let dir: string;
    let cfr: string;
    let vfr: string;
    let av1: string;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'video-timing-real-'));
        cfr = join(dir, 'unchanging-black.mkv');
        vfr = join(dir, 'vfr.mkv');
        av1 = join(dir, 'av1.mkv');
        const encode = (args: string[]): void => {
            execFileSync(
                config.FFMPEG_PATH,
                ['-hide_banner', '-loglevel', 'error', '-y', ...args],
                { stdio: 'pipe', timeout: 60_000 },
            );
        };
        encode([
            '-f',
            'lavfi',
            '-i',
            'color=black:size=96x64:rate=24:duration=24',
            '-threads',
            '2',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            cfr,
        ]);
        encode([
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=96x64:rate=24:duration=3',
            '-vf',
            "select='not(mod(n,3))'",
            '-fps_mode',
            'vfr',
            '-threads',
            '2',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            vfr,
        ]);
        encode([
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=96x64:rate=24:duration=3',
            '-threads',
            '2',
            '-c:v',
            'libsvtav1',
            '-preset',
            '12',
            '-svtav1-params',
            'lp=2',
            '-crf',
            '45',
            av1,
        ]);
    }, 90_000);
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    it('keeps CFR with unchanged picture content, VFR and AV1 inconclusive', async () => {
        for (const [path, duration] of [
            [cfr, 24],
            [vfr, 3],
            [av1, 3],
        ] as const)
            expect(await probeVideoTiming(path, duration)).toBe('inconclusive');
    });
    function fakeProbe(code: string): () => void {
        const path = join(dir, 'fixture-probe');
        writeFileSync(path, '#!/usr/bin/env node\n' + code, { mode: 0o755 });
        const spy = vi.spyOn(config, 'FFPROBE_PATH', 'get').mockReturnValue(path);
        return () => spy.mockRestore();
    }
    it('diagnoses canonical positive evidence through a successful real subprocess only', async () => {
        const restore = fakeProbe(
            `if (!process.argv.includes('14%+#4096')) process.exit(2); process.stdout.write(${JSON.stringify(JSON.stringify(malformed))});`,
        );
        try {
            expect(await probeVideoTiming(cfr, 24)).toBe('nonadvancing');
        } finally {
            restore();
        }
    });
    it('rejects partial malformed timing evidence when the actual process exits nonzero', async () => {
        const restore = fakeProbe(
            `process.stdout.write(${JSON.stringify(JSON.stringify(malformed))}); process.exitCode=1;`,
        );
        try {
            expect(await probeVideoTiming(cfr, 24)).toBe('inconclusive');
        } finally {
            restore();
        }
    });
    it('enforces the actual output cap without diagnosing corruption', async () => {
        const restore = fakeProbe("process.stdout.write('x'.repeat(3 * 1024 * 1024));");
        try {
            expect(await probeVideoTiming(cfr, 24)).toBe('inconclusive');
        } finally {
            restore();
        }
    });
    it('kills an actual hanging probe on caller abort', async () => {
        const restore = fakeProbe('setInterval(() => {}, 1000);');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 100);
        try {
            await expect(probeVideoTiming(cfr, 24, controller.signal)).rejects.toMatchObject({
                name: 'AbortError',
            });
        } finally {
            clearTimeout(timer);
            restore();
        }
    });
    it('bounds an actual hanging probe by wall time and keeps the result inconclusive', async () => {
        const restore = fakeProbe('setInterval(() => {}, 1000);');
        const started = Date.now();
        try {
            expect(await probeVideoTiming(cfr, 24)).toBe('inconclusive');
            expect(Date.now() - started).toBeLessThan(19_000);
        } finally {
            restore();
        }
    }, 20_000);
});
