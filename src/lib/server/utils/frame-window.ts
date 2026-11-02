// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Where in an episode is it safe to grab a thumbnail?
 *
 * Pure functions: seconds in, seconds out. No DB, no ffmpeg, no filesystem —
 * so every constant here is pinned by unit test rather than discovered in
 * production.
 *
 * The defect this replaces: `video-frame-extractor.service.ts` seeks to a flat
 * percentage of runtime (`IMAGE_SYNC_VIDEO_TIMESTAMP`, default 10). For a
 * 46-minute Star Harbor: NG episode that lands at 4:36, inside the superimposed
 * act-one production credits. Sampling six real TNG S3 episodes on prod at that
 * offset produced one credit card, two near-black starfields, and three usable
 * frames — a 50% miss rate.
 *
 * Two ideas carry the fix:
 *
 * 1. Anchor in ABSOLUTE SECONDS where the underlying thing is measured in
 *    seconds. A title sequence is ~90 seconds long; it is not 3.5% of runtime.
 *    Fractional guards only take over for short-form content.
 * 2. Spread candidates PER EPISODE. The old fallback ladder was the same
 *    `[25, 40, 55, 70]` for every episode in a season, so when it fired the
 *    siblings still collided.
 */

/** Clamp `v` into [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

export interface FrameWindow {
    /** Earliest safe offset, seconds, relative to the episode's own start. */
    floor: number;
    /** Latest safe offset, seconds, relative to the episode's own start. */
    ceiling: number;
    /** True when the inversion guard rewrote the window (short-form content). */
    collapsed: boolean;
}

/**
 * Padding applied AFTER hard intro evidence.
 *
 * Evidence is used padded rather than raw because an intro ending is not the
 * same as the credits ending: TNG's title sequence ends around 2:00 but its
 * superimposed production credits run over act one until roughly 5:00. An
 * unpadded evidence floor lands straight back on the reported frame.
 */
export function introPad(durationSeconds: number): number {
    return clamp(0.05 * durationSeconds, 45, 150);
}

/** Floor used when no chapter/segment evidence exists — the common case. */
export function noEvidenceFloor(durationSeconds: number): number {
    return clamp(0.15 * durationSeconds, 120, 600);
}

/** Tail excluded at the end: end credits, "next time on", and the final act. */
export function tailGuard(durationSeconds: number): number {
    return clamp(0.18 * durationSeconds, 120, 900);
}

/**
 * Compute the safe sampling window for one episode.
 *
 * @param durationSeconds effective duration of THIS episode (already adjusted
 *        for combined multi-episode files by the caller).
 * @param evidenceSeconds intro end from `media_segments` or an intro-named
 *        chapter, or 0/undefined when unknown. Clamped to 25% of duration —
 *        evidence past a quarter of the episode is not intro evidence.
 */
export function computeFrameWindow(durationSeconds: number, evidenceSeconds?: number): FrameWindow {
    const d = durationSeconds;
    const evidence = Math.min(Math.max(evidenceSeconds ?? 0, 0), 0.25 * d);

    let floor = evidence > 0 ? Math.min(evidence + introPad(d), 0.4 * d) : noEvidenceFloor(d);
    let ceiling = d - tailGuard(d);

    // Inversion guard. This is a correctness bug in the flat-percentage
    // approach, not a preference: a 180s short yields floor 120 / ceiling 60,
    // an inverted window that cannot be sampled at all. Collapse to a plain
    // central band instead.
    let collapsed = false;
    if (ceiling - floor < Math.max(30, 0.15 * d)) {
        floor = 0.2 * d;
        ceiling = 0.8 * d;
        collapsed = true;
    }

    return { floor, ceiling, collapsed };
}

/** Golden ratio conjugate — the low-discrepancy step for candidate spreading. */
const PHI = 0.6180339887498949;

/**
 * Deterministic per-episode seed in [0, 1).
 *
 * Derived from the episode UUID, NOT the episode number: episode numbers repeat
 * across seasons, which manufactures exactly the sibling collisions the spread
 * exists to prevent.
 */
export function seedFromEpisodeId(episodeId: string): number {
    const hex = episodeId.replace(/-/g, '').slice(0, 8);
    if (hex.length < 8) return 0;
    const n = Number.parseInt(hex, 16);
    return Number.isFinite(n) ? n / 2 ** 32 : 0;
}

/**
 * `count` candidate offsets inside the window, in seconds.
 *
 * Stratified AND rotated: stratification guarantees one candidate per 1/N slice
 * of the body (coverage), rotation by a per-episode seed decorrelates siblings.
 * Pure golden-ratio without stratification can cluster; pure stratification
 * without rotation aligns every episode on the same beats — which is the
 * original bug.
 */
export function candidateOffsets(window: FrameWindow, episodeId: string, count: number): number[] {
    const span = window.ceiling - window.floor;
    if (span <= 0 || count <= 0) return [];

    const seed = seedFromEpisodeId(episodeId);
    const out: number[] = [];
    for (let k = 0; k < count; k++) {
        const f = (k + ((seed + k * PHI) % 1)) / count;
        out.push(window.floor + f * span);
    }
    return out;
}

/**
 * Snap an offset back to the nearest keyframe at or before it, but NEVER below
 * the window floor.
 *
 * An unbounded downward snap with a long GOP walks the first candidate straight
 * back into the act-one credit window the floor exists to exclude.
 *
 * @param offset seconds, relative to `base`
 * @param base absolute start of this episode within its file (0 for a normal file)
 * @param keyframes ABSOLUTE keyframe positions in seconds, ascending
 */
export function snapToKeyframe(
    offset: number,
    base: number,
    floor: number,
    keyframes?: readonly number[],
): number {
    if (!keyframes || keyframes.length === 0) return offset;

    const target = base + offset;
    let lo = 0;
    let hi = keyframes.length - 1;
    let best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (keyframes[mid] <= target) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best < 0) return offset;

    const snapped = keyframes[best] - base;
    return snapped >= floor ? snapped : offset;
}
