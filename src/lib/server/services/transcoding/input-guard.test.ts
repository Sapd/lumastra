// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `assertTranscodeInputIsMedia` under a saturated fs guard (fix plan 6, final
 * wave F1). The sniff reads through `withFsGuard`, whose permits are shared by
 * every guarded fs op in the process: a dead NFS mount can hold all of them,
 * and a sniff of a file on a HEALTHY mount then times out with
 * `FsTimeoutError`. That verdict says nothing about the file, so it must not
 * fail the spawn — before the guard existed, video playback touched no guarded
 * fs at all. The sniff, the guard and the files are all real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL_MEDIA = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const HLS_BODY = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/other/library/secret.ts\n';

describe('assertTranscodeInputIsMedia with a saturated fs guard (F1)', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'lumastra-input-guard-f1-'));
        // Fresh module graph per test so every test gets its own semaphore;
        // a tiny cap and timeout keep the saturation cheap and fast.
        vi.resetModules();
        vi.stubEnv('LUMASTRA_FS_MAX_CONCURRENCY', '2');
        vi.stubEnv('LUMASTRA_FS_TIMEOUT_MS', '100');
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(dir, { recursive: true, force: true });
    });

    /** Hold every permit with ops that never settle (a dead hard mount). */
    async function saturateGuard(): Promise<void> {
        const { withFsGuard } = await import('$lib/server/utils/safe-fs.js');
        for (let i = 0; i < 2; i++) {
            withFsGuard(() => new Promise<never>(() => {}), 'stat', `/dead-mount/${i}`).catch(
                () => undefined,
            );
        }
    }

    it('a real file on a healthy mount still passes while the guard is saturated', async () => {
        await saturateGuard();
        const { assertTranscodeInputIsMedia } = await import('./input-guard.js');

        await expect(
            assertTranscodeInputIsMedia({ localFilePath: REAL_MEDIA }),
        ).resolves.toBeUndefined();
    });

    it('control: a playlist body is still refused when the guard is free', async () => {
        const body = join(dir, 'movie.mkv');
        await writeFile(body, HLS_BODY);
        const { assertTranscodeInputIsMedia } = await import('./input-guard.js');

        await expect(assertTranscodeInputIsMedia({ localFilePath: body })).rejects.toMatchObject({
            name: 'PlaylistSourceRefusedError',
            magic: 'hls',
        });
    });
});
