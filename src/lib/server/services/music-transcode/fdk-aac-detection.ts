// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnFFmpegSafely } from '$lib/server/utils/ffmpeg-spawn.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('MusicTranscode:fdkDetect');

let cached: boolean | null = null;
let detecting: Promise<boolean> | null = null;

export async function hasLibFdkAac(): Promise<boolean> {
    if (cached !== null) return cached;
    if (detecting) return detecting;

    detecting = (async () => {
        try {
            const result = await spawnFFmpegSafely({
                args: ['-hide_banner', '-encoders'],
                timeout: 5000,
                maxStdoutSize: 5 * 1024 * 1024,
            });
            const found = /(\s|^)libfdk_aac(\s|$)/m.test(result.stdout);
            logger.info('libfdk_aac availability', { available: found });
            cached = found;
            return found;
        } catch (err) {
            logger.warn('Failed to probe ffmpeg encoders; assuming no libfdk_aac', {
                err: String(err),
            });
            cached = false;
            return false;
        } finally {
            detecting = null;
        }
    })();
    return detecting;
}

/** Test-only: reset the cached detection. */
export function _resetFdkAacDetectionForTests(): void {
    cached = null;
    detecting = null;
}
