// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// playback-health.ts — playback binary (ffmpeg/ffprobe) availability probe.
//
// Single source of truth for "can this deployment actually transcode/probe
// media". Lifted from /api/admin/status so the same X_OK binary probe feeds BOTH
// the status route AND the admin attention spine (a PLAYBACK-HEALTH signal), so
// the unified system verdict reflects "playback is broken" without spawning
// ffmpeg every derive cycle.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '$lib/server/config';

/**
 * Returns only the basename of a binary path so that admin status responses
 * do not expose absolute filesystem paths (e.g. /usr/local/bin/ffmpeg → ffmpeg).
 */
export function redactBinPath(binPath: string): string {
    return path.basename(binPath);
}

export function checkBinary(binPath: string): {
    ok: boolean;
    message: string;
    detail: string;
} {
    try {
        fs.accessSync(binPath, fs.constants.X_OK);
        return {
            ok: true,
            message: 'Available',
            detail: redactBinPath(binPath),
        };
    } catch {
        // best-effort: X_OK probe — failure means the binary isn't available/executable.
        if (!binPath.includes('/')) {
            return {
                ok: false,
                message: 'Not verified (no absolute path set)',
                detail: redactBinPath(binPath),
            };
        }
        return {
            ok: false,
            message: 'Not found or not executable',
            detail: redactBinPath(binPath),
        };
    }
}

/** Shape returned by {@link checkPlaybackHealth}. */
export interface PlaybackHealth {
    ffmpegOk: boolean;
    ffprobeOk: boolean;
    ffmpegDetail?: string;
    ffprobeDetail?: string;
    /**
     * Hardware-transcode capability. Only probed when GPU_ACCELERATION is a
     * Linux HW accelerator (qsv/vaapi/nvenc); `undefined` means "not applicable"
     * (GPU_ACCELERATION=none, or an accel that can't run in this container).
     * `false` means the configured accelerator could not initialise — software
     * transcode still works, but HW is broken (e.g. missing VA driver, no device
     * permission). `hwAccelDetail` carries the first diagnostic line.
     */
    hwAccelOk?: boolean;
    hwAccelType?: string;
    hwAccelDetail?: string;
}

function firstLine(s: string): string {
    return (
        (s || '')
            .split('\n')
            .find((l) => l.trim().length > 0)
            ?.trim() ?? ''
    );
}

/**
 * Probe whether the configured hardware accelerator can actually initialise.
 * Returns null when GPU_ACCELERATION is not a probe-able Linux HW accel.
 * VA-API/QSV are probed with `vainfo` (loads the VA driver against the render
 * node — the same path ffmpeg uses); NVENC with `nvidia-smi`. Best-effort: any
 * spawn error (e.g. tool not installed) is reported as a failure with detail,
 * which is itself the useful signal ("HW transcode tooling/driver missing").
 */
function probeHwAccel(): { ok: boolean; detail?: string } | null {
    const accel = config.GPU_ACCELERATION;
    if (accel === 'none' || accel === 'amf' || accel === 'videotoolbox') return null;
    try {
        if (accel === 'nvenc') {
            const r = spawnSync('nvidia-smi', ['-L'], { timeout: 8000, encoding: 'utf8' });
            if (r.error) return { ok: false, detail: `nvidia-smi unavailable: ${r.error.message}` };
            if (r.status === 0 && /GPU\s+\d/.test(r.stdout || '')) return { ok: true };
            return { ok: false, detail: firstLine(r.stderr || r.stdout || 'nvidia-smi failed') };
        }
        // qsv / vaapi → VA-API capability probe
        const device = config.VAAPI_DEVICE || '/dev/dri/renderD128';
        const r = spawnSync('vainfo', ['--display', 'drm', '--device', device], {
            timeout: 8000,
            encoding: 'utf8',
        });
        if (r.error) return { ok: false, detail: `vainfo unavailable: ${r.error.message}` };
        if (r.status === 0 && /VAEntrypoint/.test(r.stdout || '')) return { ok: true };
        return { ok: false, detail: firstLine(r.stderr || r.stdout || 'VA-API init failed') };
    } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * In-module TTL cache. ffmpeg/ffprobe availability is effectively static per
 * deployment, but this is called on every attention derive cycle (~every 60s);
 * caching for ~5 minutes avoids spawning the probe each cycle. The cache
 * naturally refreshes once `expiresAt` passes (no manual invalidation needed).
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { value: PlaybackHealth; expiresAt: number } | null = null;

/**
 * Probe ffmpeg + ffprobe at their configured paths. Result is cached in-module
 * for ~5 minutes. `*Detail` carries the redacted reason (basename / "not found")
 * only when the corresponding binary is unavailable.
 */
export async function checkPlaybackHealth(): Promise<PlaybackHealth> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.value;

    const ffmpeg = checkBinary(config.FFMPEG_PATH);
    const ffprobe = checkBinary(config.FFPROBE_PATH);
    const hw = probeHwAccel();
    const value: PlaybackHealth = {
        ffmpegOk: ffmpeg.ok,
        ffprobeOk: ffprobe.ok,
        ffmpegDetail: ffmpeg.ok ? undefined : ffmpeg.message,
        ffprobeDetail: ffprobe.ok ? undefined : ffprobe.message,
        hwAccelOk: hw ? hw.ok : undefined,
        hwAccelType: hw ? config.GPU_ACCELERATION : undefined,
        hwAccelDetail: hw && !hw.ok ? hw.detail : undefined,
    };
    cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
}
