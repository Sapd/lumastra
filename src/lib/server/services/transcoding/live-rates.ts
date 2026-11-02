// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Current FFmpeg speed and fps, measured over a short window.
 *
 * FFmpeg's own `speed=` and `fps=` are averages since the process started —
 * wall time included. Once the transcode throttle has stopped a process
 * (SIGSTOP), every second it sat paused counts against it: measured on
 * FFmpeg 9, a 40x encode read 14.6x right after a 6 s pause and took many
 * seconds to climb back. That drove the player's "slower than realtime"
 * warning and the segment planner's wait-vs-restart estimate. Here the rates
 * come from `time=` / `frame=` deltas over the last few seconds, and the
 * window restarts on resume, so paused time never enters them.
 */

import type { TranscodeJob } from './types.js';

/** Minimum wall time a measurement spans; FFmpeg reports every 0.5 s. */
const WINDOW_MS = 3000;

export interface ProgressReading {
    /** Output media time from `time=`, seconds. */
    mediaSeconds: number;
    /** Output frame count from `frame=`, when the line carries one. */
    frames?: number;
}

/**
 * Feed one progress reading. Until the first full window, FFmpeg's own
 * readings stand (`fallback`); after it, only windowed rates are used.
 */
export function updateLiveRates(
    job: Pick<TranscodeJob, 'rateSample' | 'transcodeSpeed' | 'transcodeFps'>,
    reading: ProgressReading,
    now: number,
    fallback: { speed?: number; fps?: number },
): void {
    const sample = job.rateSample;
    const measured = sample?.measured === true;
    if (!measured) {
        if (fallback.speed !== undefined) job.transcodeSpeed = fallback.speed;
        if (fallback.fps !== undefined) job.transcodeFps = fallback.fps;
    }
    if (!sample?.anchor || reading.mediaSeconds < sample.anchor.mediaSeconds) {
        // First reading of this process, first since a resume, or time went
        // backwards: start a new window.
        job.rateSample = { measured, anchor: { at: now, ...reading } };
        return;
    }
    const { anchor } = sample;
    const elapsedMs = now - anchor.at;
    if (elapsedMs < WINDOW_MS) return;
    const elapsedSeconds = elapsedMs / 1000;
    job.transcodeSpeed = (reading.mediaSeconds - anchor.mediaSeconds) / elapsedSeconds;
    if (reading.frames !== undefined && anchor.frames !== undefined) {
        job.transcodeFps = Math.max(0, reading.frames - anchor.frames) / elapsedSeconds;
    }
    job.rateSample = { measured: true, anchor: { at: now, ...reading } };
}

/**
 * Drop the window anchor but keep using windowed rates — called when the
 * throttle resumes the process, so the pause is never measured.
 */
export function restartRateWindow(job: Pick<TranscodeJob, 'rateSample'>): void {
    if (job.rateSample) job.rateSample = { measured: job.rateSample.measured };
}
