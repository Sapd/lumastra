// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Soft mix-compatibility tiebreak for the music smart queue.
 *
 * The smart queue used to HARD-REJECT candidates outside a BPM/key/energy
 * tolerance window before ranking — a DJ-crossfade "will these two tracks
 * mix cleanly" check borrowed from beat-math.ts's areKeysCompatible. In
 * production that crushed a 60-candidate CLAP similarity pool down to a
 * single cross-genre survivor (a sea-shanty session got handed a rap track,
 * because it was the only candidate the gate didn't reject). Similarity
 * should decide WHAT plays; mix compatibility only matters for HOW the
 * transition sounds, and the client already adapts its crossfade behaviour
 * per track pair (determineCrossfadeStyle in beat-math.ts) — a key clash
 * there degrades to a filtered/echoed transition, it doesn't need an upstream
 * veto.
 *
 * This module replaces the hard gate with a small additive tiebreak, split
 * into two independent terms:
 *   - `computeBlendCompatibility` (BPM + key): only meaningful when the
 *     client can actually crossfade — a hard-cut client (e.g. iOS) never
 *     blends two tracks together, so tempo/key relationship is irrelevant
 *     to it and callers should zero out `blendWeight` for that case.
 *   - `computeEnergyContinuity`: applies regardless of crossfade capability
 *     — an energy cliff (calm ballad → wall-of-sound) is audible on a hard
 *     cut too, it's not a mixing artifact.
 *
 * CRITICAL INVARIANT: `blendWeight` and `energyWeight` must stay well below
 * the typical within-pool similarity spread (~0.1) between competing
 * candidates. This is a tiebreaker among near-equal candidates, never a
 * decider — that distinction is exactly what the old hard gate violated.
 * Callers combine `mixabilityAdjustment`'s output additively with the raw
 * similarity score; it must never be able to flip the ranking of two
 * candidates whose similarity differs by more than a rounding error.
 */

import { areKeysCompatible } from '$lib/utils/beat-math.js';

/** Tiebreak weights — see the module-level invariant above. */
export interface MixabilityWeights {
    /** Weight for the BPM+key blend term. Set to 0 for hard-cut (non-crossfading) clients. */
    blendWeight: number;
    /** Weight for the energy-continuity term. Applies regardless of client crossfade capability. */
    energyWeight: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * BPM+key "would this blend cleanly" compatibility, in [0, 1].
 *
 * M_bpm: half/double-time aware — a candidate at roughly 2x or 0.5x the
 * current BPM is just as mixable as one at the same BPM (a DJ pitches/loops
 * around it), so the gap is the minimum ratio-gap across {1x, 2x, 0.5x}.
 * M_key: `areKeysCompatible` from beat-math.ts (circle-of-fifths neighbors).
 *
 * Each component is only computed when both sides carry the relevant data;
 * the result is the mean of whatever components are available. Returns
 * null when NEITHER component is computable, so callers can treat "no
 * Essentia data at all" as neutral rather than as a mismatch.
 */
export function computeBlendCompatibility(
    current: { bpm?: number; key?: string },
    candidate: { bpm?: number; key?: string },
): number | null {
    const components: number[] = [];

    // `> 0` on BOTH sides: Essentia stores 0 as a "BPM extraction failed"
    // sentinel, which must count as missing data (skip the component), not
    // as a real tempo maximally far from the current track.
    if (
        current.bpm !== undefined &&
        candidate.bpm !== undefined &&
        current.bpm > 0 &&
        candidate.bpm > 0
    ) {
        const curBpm = current.bpm;
        const candBpm = candidate.bpm;
        const gap =
            Math.min(
                Math.abs(candBpm * 1 - curBpm),
                Math.abs(candBpm * 2 - curBpm),
                Math.abs(candBpm * 0.5 - curBpm),
            ) / curBpm;
        components.push(clamp(1 - gap / 0.5, 0, 1));
    }

    if (current.key !== undefined && candidate.key !== undefined) {
        components.push(areKeysCompatible(current.key, candidate.key) ? 1 : 0);
    }

    if (components.length === 0) return null;
    return components.reduce((sum, c) => sum + c, 0) / components.length;
}

/**
 * Energy-flow continuity between the current track and a candidate, in
 * [0, 1] — 1 = identical energy, 0 = maximal energy delta (>=1.0 apart on
 * the 0-1 Essentia energy scale). Null when either side is missing energy
 * data (callers must treat null as neutral, not as a mismatch).
 */
export function computeEnergyContinuity(
    currentEnergy: number | undefined,
    candidateEnergy: number | undefined,
): number | null {
    if (currentEnergy === undefined || candidateEnergy === undefined) return null;
    return 1 - clamp(Math.abs(currentEnergy - candidateEnergy), 0, 1);
}

/**
 * Combines the blend and energy-continuity terms into a single additive
 * score adjustment, centered so missing data is neutral (0) rather than
 * penalized: each present component maps its [0, 1] value onto [-weight,
 * +weight] via `2x - 1` before scaling by its weight. Range is
 * ±(blendWeight + energyWeight).
 */
export function mixabilityAdjustment(
    blendCompat: number | null,
    energyContinuity: number | null,
    weights: MixabilityWeights,
): number {
    const blendTerm = blendCompat === null ? 0 : weights.blendWeight * (2 * blendCompat - 1);
    const energyTerm =
        energyContinuity === null ? 0 : weights.energyWeight * (2 * energyContinuity - 1);
    return blendTerm + energyTerm;
}
