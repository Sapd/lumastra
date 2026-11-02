// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "This transcode cannot keep up with playback", with hysteresis.
 *
 * A video encode below 1x real time means the player will run out of
 * segments and spin. The usual causes are outside Lumastra: another app
 * holding the GPU encoder (Sunshine/Apollo game streaming, OBS, Discord
 * streaming, NVIDIA instant replay — measured 2026-10-14: hevc_nvenc fell to
 * ~1 fps next to a Sunshine stream), or a CPU too weak for a software
 * encode. The flag lets the player and the admin say so instead of spinning
 * without explanation.
 *
 * A single low reading means nothing: FFmpeg starts slowly (probe, encoder
 * init, the first keyframe), a seek restarts the process, and the speed
 * itself is a windowed estimate (live-rates.ts). So:
 *   - readings in the first {@link STARTUP_GRACE_MS} of a process, or the
 *     first {@link RESUME_GRACE_MS} after a throttle resume, are ignored;
 *   - the job turns slow only after every reading for {@link SLOW_AFTER_MS}
 *     stayed below {@link SLOW_SPEED};
 *   - it turns back only after {@link RECOVER_AFTER_MS} at or above
 *     {@link RECOVERED_SPEED}. Readings in between hold the current state.
 * A throttle-paused job is never slow: it is paused because it is ahead.
 */

import type { TranscodeJob } from './types.js';

/** Below this speed the encode falls behind playback. */
export const SLOW_SPEED = 1.0;
/** At or above this speed a slow job counts as recovering. */
export const RECOVERED_SPEED = 1.1;
/** Readings this soon after a (re)spawn — start or seek — are ignored. */
export const STARTUP_GRACE_MS = 8_000;
/** Readings this soon after a throttle resume are ignored (the rate window restarts). */
export const RESUME_GRACE_MS = 4_000;
/** How long the speed must stay below {@link SLOW_SPEED} before the job is slow. */
export const SLOW_AFTER_MS = 10_000;
/** How long the speed must stay at or above {@link RECOVERED_SPEED} to clear it. */
export const RECOVER_AFTER_MS = 5_000;

/** Why a job is slow: the GPU encoder is shared and busy, or the CPU cannot keep up. */
export type SlowTranscodeReason = 'gpu_busy' | 'cpu_slow';

export interface SlowTranscodeState {
    /** Readings before this wall-clock time are ignored. */
    ignoreUntil: number;
    /** First reading of the current below-threshold run. */
    belowSince?: number;
    /** First reading of the current recovered run. */
    aboveSince?: number;
    slow: boolean;
}

/** Fresh state for a new process (start, seek, ladder respawn). */
export function startSlowTracking(now: number): SlowTranscodeState {
    return { ignoreUntil: now + STARTUP_GRACE_MS, slow: false };
}

/**
 * The throttle paused or resumed the process. A paused job is ahead of the
 * player, so whatever was measured before no longer describes it.
 */
export function restartSlowTracking(
    state: SlowTranscodeState | undefined,
    now: number,
): SlowTranscodeState {
    return { ignoreUntil: Math.max(state?.ignoreUntil ?? 0, now + RESUME_GRACE_MS), slow: false };
}

/**
 * Feed one speed reading. Returns `'slow'` / `'recovered'` when this reading
 * flipped the state (the caller logs it), undefined otherwise.
 */
export function observeSpeed(
    state: SlowTranscodeState,
    speed: number,
    now: number,
): 'slow' | 'recovered' | undefined {
    if (!Number.isFinite(speed) || now < state.ignoreUntil) return undefined;
    if (speed < SLOW_SPEED) {
        state.aboveSince = undefined;
        state.belowSince ??= now;
        if (!state.slow && now - state.belowSince >= SLOW_AFTER_MS) {
            state.slow = true;
            return 'slow';
        }
    } else if (speed >= RECOVERED_SPEED) {
        state.belowSince = undefined;
        state.aboveSince ??= now;
        if (state.slow && now - state.aboveSince >= RECOVER_AFTER_MS) {
            state.slow = false;
            return 'recovered';
        }
    } else {
        // Between the thresholds: neither run continues.
        state.belowSince = undefined;
        state.aboveSince = undefined;
    }
    return undefined;
}

/**
 * Whether the job is slow at `now`. Also true when the readings stayed low
 * and then stopped altogether — an encoder that stalls completely prints no
 * more progress lines, and that must not read as "fine".
 */
export function isSlow(state: SlowTranscodeState | undefined, now: number): boolean {
    if (!state) return false;
    if (state.slow) return true;
    return (
        state.belowSince !== undefined &&
        now >= state.ignoreUntil &&
        now - state.belowSince >= SLOW_AFTER_MS
    );
}

type SlowJob = Pick<
    TranscodeJob,
    'slowTranscode' | 'throttledAt' | 'transcodeDecisionResult' | 'process' | 'status'
>;

/**
 * The slow reason the player and the admin show, or undefined. Only a live
 * video encode is judged: a copy job's speed says something about the disk,
 * not the encoder; a throttle-paused job is ahead of the player; and a
 * process that has exited (end of file, stop, crash) prints no more readings,
 * so whatever it last measured no longer describes anything. After a
 * software-encode fallback the CPU does the encoding, so a slow run names the
 * CPU; the fallback itself is reported separately (softwareEncodeFallback).
 */
export function slowTranscodeReason(job: SlowJob, now: number): SlowTranscodeReason | undefined {
    const decision = job.transcodeDecisionResult;
    if (decision?.videoAction !== 'transcode') return undefined;
    if (job.throttledAt !== undefined) return undefined;
    // 'ready' = master playlist written; the process may still be encoding.
    if (job.status === 'stopping' || job.status === 'stopped' || job.status === 'error') {
        return undefined;
    }
    const proc = job.process;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return undefined;
    if (!isSlow(job.slowTranscode, now)) return undefined;
    return decision.useGpu && decision.gpuEncoder ? 'gpu_busy' : 'cpu_slow';
}

const GPU_ENCODER_RE = /_(?:nvenc|qsv|vaapi|amf|videotoolbox|v4l2m2m|mf)$/i;

/** The software encoder for the same codec as `encoder` (a GPU or software encoder name). */
export function softwareEncoderFor(encoder: string): string {
    const e = encoder.toLowerCase();
    if (e.includes('av1')) return 'libsvtav1';
    if (e.includes('hevc') || e.includes('265')) return 'libx265';
    return 'libx264';
}

/**
 * The same decision, encoded in software: no GPU encoder or decoder, and a
 * GPU encoder name in `targetCodec.video` replaced by the software encoder
 * for the same codec. The strategy reads `targetCodec.video` when
 * `gpuEncoder` is unset (full-transcode-strategy.ts), so clearing
 * `gpuEncoder` alone still built `-c:v hevc_nvenc` — seen live on the
 * Windows tower 2026-10-14, the fallback respawn failed on the same NVENC.
 */
export function toSoftwareDecision<T extends NonNullable<TranscodeJob['transcodeDecisionResult']>>(
    decision: T,
): T {
    const video = decision.targetCodec?.video;
    return {
        ...decision,
        useGpu: false,
        gpuEncoder: undefined,
        gpuDecoder: undefined,
        ...(decision.targetCodec
            ? {
                  targetCodec: {
                      ...decision.targetCodec,
                      video:
                          video && GPU_ENCODER_RE.test(video) ? softwareEncoderFor(video) : video,
                  },
              }
            : {}),
    };
}

/** x264/x265 presets, fastest first. */
const PRESET_SPEED_ORDER = [
    'ultrafast',
    'superfast',
    'veryfast',
    'faster',
    'fast',
    'medium',
    'slow',
    'slower',
    'veryslow',
    'placebo',
];

/**
 * The software preset for a job that fell back from a GPU encoder: the
 * configured one is chosen for software jobs the operator expected, and even
 * `veryfast` cannot keep a 4K source near real time on a typical CPU
 * (config.ts, SOFTWARE_ENCODE_MAX_WIDTH). `superfast`, or `ultrafast` above
 * 1080p — never slower than what is configured.
 */
export function softwareFallbackPreset(
    configured: string,
    sourceHeight: number | undefined,
): string {
    const wanted = (sourceHeight ?? 0) > 1080 ? 'ultrafast' : 'superfast';
    const have = PRESET_SPEED_ORDER.indexOf(configured);
    return have !== -1 && have < PRESET_SPEED_ORDER.indexOf(wanted) ? configured : wanted;
}
