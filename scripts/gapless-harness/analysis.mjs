// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Analysis of one recorded file-boundary run.
 *
 * Pure, and deliberately in its own file so it can be unit-tested against
 * synthesised signals whose answer is known by construction — a measurement
 * instrument that has never been shown to produce the right number on a known
 * input is not evidence of anything. (`analysis.test.ts`. It caught two design
 * errors in this file on its first run.)
 *
 * Everything here works on mono Float32 PCM at a known sample rate.
 *
 * ## The fixture design, and why these frequencies
 *
 * File A is a constant {@link TONE_A_HZ} tone. File B is a linear chirp whose
 * instantaneous frequency starts at {@link CHIRP_BASE_HZ} and rises
 * {@link CHIRP_RATE_HZ_PER_S} per second. Two consequences:
 *
 *  - **Which file is sounding is unambiguous.** A sits far below the chirp's
 *    entire range, so one threshold ({@link CLASSIFY_HZ}) separates them for
 *    the whole run. An earlier draft used 440 Hz against a chirp starting at
 *    500 Hz; 60 Hz apart is inside the estimator's own noise, and the join
 *    detector latched onto the half-silent window at the end of A instead.
 *  - **The frequency at the join says where in B playback entered**, which is
 *    the quantity the gap-only harness could not see:
 *    `contentLostMs = (hzAtJoin − CHIRP_BASE_HZ) / CHIRP_RATE_HZ_PER_S × 1000`.
 */

/** The constant tone in file A. Far below the chirp's whole range. */
export const TONE_A_HZ = 200;

/** File B: instantaneous frequency = CHIRP_BASE_HZ + CHIRP_RATE_HZ_PER_S · t. */
export const CHIRP_BASE_HZ = 800;
export const CHIRP_RATE_HZ_PER_S = 1000;

/** Above this, the window is file B. Midway between A and the chirp's floor. */
const CLASSIFY_HZ = 500;

/**
 * Fine pass — locates the join and the silence around it.
 *
 * 256 samples is ~5.8 ms, so the join instant is resolved to about a third of
 * the smallest lead worth distinguishing. It is also, conveniently, well
 * calibrated: a window straddling the cut is half A and half B, so its crossing
 * count lands near CLASSIFY_HZ and its CENTRE is the boundary.
 */
const FINE_WINDOW = 256;
const FINE_HOP = 64;

/** Fit pass — long enough windows that the chirp estimate is stable. */
const FIT_WINDOW = 1024;
const FIT_HOP = 256;

/**
 * Frequency by zero crossings.
 *
 * Adequate because the fixtures are single sinusoids with no harmonics — an FFT
 * would buy resolution this does not need and would smear the chirp across the
 * window. Hysteresis around zero keeps DC offset and dither from inventing
 * crossings.
 */
function zeroCrossingHz(samples, from, length, sampleRate) {
    let crossings = 0;
    let sign = 0;
    const threshold = 0.02;
    const end = from + length;
    for (let i = from; i < end; i++) {
        const v = samples[i];
        if (v > threshold) {
            if (sign === -1) crossings++;
            sign = 1;
        } else if (v < -threshold) {
            if (sign === 1) crossings++;
            sign = -1;
        }
    }
    return crossings / 2 / (length / sampleRate);
}

function rms(samples, from, length) {
    let sum = 0;
    const end = from + length;
    for (let i = from; i < end; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / length);
}

function frameize(samples, sampleRate, window, hop) {
    const frames = [];
    for (let start = 0; start + window <= samples.length; start += hop) {
        frames.push({
            startMs: (start / sampleRate) * 1000,
            centreMs: ((start + window / 2) / sampleRate) * 1000,
            rms: rms(samples, start, window),
            hz: zeroCrossingHz(samples, start, window, sampleRate),
        });
    }
    return frames;
}

/** Least-squares line through (x, y), plus r². */
function fitLine(xs, ys) {
    const n = xs.length;
    if (n < 3) return { slope: 0, intercept: 0, r2: 0 };
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
        sx += xs[i];
        sy += ys[i];
    }
    const mx = sx / n;
    const my = sy / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx;
        const dy = ys[i] - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    if (sxx === 0 || syy === 0) return { slope: 0, intercept: my, r2: 0 };
    const slope = sxy / sxx;
    return { slope, intercept: my - slope * mx, r2: (sxy * sxy) / (sxx * syy) };
}

/**
 * No usable reading.
 *
 * `gapMs` is null, not 0. An earlier version returned 0 here, and `run.mjs`
 * printed it as "gap 0.0" — indistinguishable from a genuinely gapless join. A
 * failed capture that renders as the best possible result is worse than no
 * harness: it is the exact shape of mistake this rebuild exists to stop.
 */
const EMPTY = {
    joinMs: null,
    gapMs: null,
    contentLostMs: null,
    chirpSlopeHzPerS: 0,
    fitR2: 0,
    silent: true,
    /** True only when every field below is a real measurement. */
    usable: false,
};

/**
 * @param {Float32Array|number[]} samples mono PCM of one boundary run
 * @param {number} sampleRate
 */
export function analyseBoundary(samples, sampleRate) {
    const fine = frameize(samples, sampleRate, FINE_WINDOW, FINE_HOP);
    if (fine.length === 0) return { ...EMPTY };

    const peak = fine.reduce((max, f) => Math.max(max, f.rms), 0);
    if (peak < 0.005) return { ...EMPTY };

    // 0.35 of peak: a window straddling a hard cut is half signal (rms ≈ 0.7 of
    // peak) and must still count as audible, while true silence must not.
    const audible = (f) => f.rms > peak * 0.35;

    // No window ever classified as file B: the capture never reached the second
    // file. Not silence, and NOT a measurement either — `usable: false` is what
    // keeps it out of the results table.
    const joinIndex = fine.findIndex((f) => audible(f) && f.hz > CLASSIFY_HZ);
    if (joinIndex < 0) {
        return { ...EMPTY, silent: false };
    }
    const joinMs = fine[joinIndex].centreMs;

    // Walk back over the windows that OVERLAP the onset of B and are therefore
    // neither cleanly A nor cleanly B, then count the silence behind them.
    //
    // Both simpler versions of this were wrong, and each was caught by a
    // control rather than by reading the code:
    //
    //  - "count silent windows immediately before the join" stopped on the
    //    first overlapping window (audible, but its crossing count still below
    //    CLASSIFY_HZ) and never reached the silence: 0 ms for a forced 200 ms
    //    gap.
    //  - "find the last window whose rms is near the recording's peak" matched
    //    five windows out of two thousand on AAC, where the encoder's priming
    //    transient at t=0 sets the peak and the steady tone sits well below it:
    //    a three-second gap on every m4a row.
    //
    // The number of overlapping windows is not a fudge factor — it is exactly
    // how many windows can contain the onset given the window and hop.
    const overlapWindows = Math.ceil(FINE_WINDOW / FINE_HOP);
    let cursor = joinIndex - 1;
    for (let skipped = 0; skipped < overlapWindows && cursor >= 0 && audible(fine[cursor]);) {
        cursor--;
        skipped++;
    }
    let silentWindows = 0;
    while (cursor >= 0 && !audible(fine[cursor])) {
        cursor--;
        silentWindows++;
    }
    // A window overlapping either edge of the silence is not itself silent, so
    // one window's duration is added back.
    const gapMs =
        silentWindows === 0 ? 0 : ((silentWindows * FINE_HOP + FINE_WINDOW) / sampleRate) * 1000;

    // The chirp, fitted over long windows well clear of the boundary. 50 ms of
    // slack because a window containing any of A at all has a meaningless
    // crossing count.
    const fit = frameize(samples, sampleRate, FIT_WINDOW, FIT_HOP);
    const xs = [];
    const ys = [];
    for (const f of fit) {
        if (f.startMs < joinMs + 50) continue;
        if (f.rms <= peak * 0.35) continue;
        // Past the end of B the signal decays; its estimate is unusable.
        if (f.hz < CLASSIFY_HZ) continue;
        xs.push(f.centreMs / 1000);
        ys.push(f.hz);
    }
    const { slope, intercept, r2 } = fitLine(xs, ys);

    // Where in B did playback enter? Extrapolate the fitted chirp back to the
    // join instant and invert f(τ) = BASE + RATE·τ.
    const hzAtJoin = slope * (joinMs / 1000) + intercept;
    const contentLostMs = ((hzAtJoin - CHIRP_BASE_HZ) / CHIRP_RATE_HZ_PER_S) * 1000;

    return {
        joinMs,
        // Gap and loss are INDEPENDENT and neither is derived from the other.
        // A gap means B started late in wall time while sitting at its own
        // start; a loss means B was already past its start when it became
        // audible. `control_gap_200` must show 200/0 and `control_clip_200`
        // 0/200 — if either leaks into the other column the analysis is wrong,
        // which is exactly what running both controls every time detects.
        gapMs,
        contentLostMs,
        /** Fitted chirp slope, Hz/s. Should be CHIRP_RATE_HZ_PER_S at rate 1. */
        chirpSlopeHzPerS: slope,
        fitR2: r2,
        silent: false,
        // A fit over fewer than a handful of windows, or one that barely
        // correlates, cannot support a content-loss figure — the number would be
        // extrapolated from noise back to the join instant.
        usable: xs.length >= 8 && r2 > 0.8,
    };
}
