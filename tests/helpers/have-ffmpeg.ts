// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a real `ffmpeg` and `ffprobe` are on PATH. Tests that spawn them
 * gate on this with `describe.skipIf(!haveFfmpeg())`: the CI unit-test job
 * installs no ffmpeg (only the integration shards provision the pinned
 * jellyfin-ffmpeg build), so an ungated spawn fails there with
 * `spawn ffmpeg ENOENT`.
 */

import { execFileSync } from 'node:child_process';

export function haveFfmpeg(): boolean {
    try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
        execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
