// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Top-K weighted-random pick for music autoplay's "next track".
 *
 * Why this exists: the embedding-based candidate scoring is deterministic,
 * so given the same input track the same next-track is picked every time —
 * e.g. "Moon and Back" by Manian always produced "Jump" by Manian. That
 * feels robotic even when the pick is technically on-mood.
 *
 * Strategy: keep the top-K candidates (quality gate stays high), then
 * sample weighted by similarity score. K=1 reverts to fully deterministic
 * behaviour (pick the best match every time). K=5 (default) produces
 * enough variation that the same seed track doesn't always yield the
 * same successor while still preferring higher-quality matches.
 *
 * This is a small piece of isolated logic with an injectable RNG, kept in
 * its own module so it can be unit-tested without a database.
 */

export interface RankedCandidate {
    id: string;
    similarity_score: number;
}

/**
 * Pick one candidate from the top K of `scored`, weighted by similarity.
 * `excludedArtists` and `artistOf` implement the "don't pick tracks by the
 * artist of the current track" diversity rule already enforced elsewhere.
 *
 * - `scored` is expected to be sorted high→low by similarity_score.
 * - Returns `null` only if `scored` is empty.
 * - With k <= 1, returns the first eligible candidate (legacy behaviour).
 * - With only one eligible candidate, returns it directly.
 * - `rng` defaults to Math.random; inject a deterministic RNG in tests.
 */
export function pickAutoNext<T extends RankedCandidate>(
    scored: T[],
    excludedArtists: Set<string>,
    artistOf: (row: T) => string,
    k: number,
    rng: () => number = Math.random,
    /**
     * The subset of `excludedArtists` that must STILL hold when the full set
     * excludes every candidate — in practice the now-playing artist.
     *
     * Without this tier, falling back to the deferred pool also drops the
     * current-artist rule, which is worse than never having applied the wider
     * exclusion: measured on prod, capping both artists in a two-artist
     * neighbourhood turned a clean A>B>A>B alternation into runs of five
     * consecutive tracks by A. Defaults to the full set (all-or-nothing) for
     * callers that pass only a hard rule.
     */
    hardExcludedArtists: Set<string> = excludedArtists,
): T | null {
    if (scored.length === 0) return null;

    const kClamped = Math.max(1, k);
    const eligible: T[] = [];
    const deferred: T[] = [];
    for (const row of scored) {
        if (excludedArtists.has(artistOf(row))) {
            if (deferred.length < kClamped) deferred.push(row);
            continue;
        }
        eligible.push(row);
        if (eligible.length >= kClamped) break;
    }

    // If artist-diversity leaves nothing, fall back to the deferred pool —
    // but TIERED: prefer deferred tracks that only the soft exclusion caught,
    // so the hard current-artist rule survives (see hardExcludedArtists).
    const softDeferred = deferred.filter((row) => !hardExcludedArtists.has(artistOf(row)));
    const pool = eligible.length > 0 ? eligible : softDeferred.length > 0 ? softDeferred : deferred;
    if (pool.length === 0) return null;
    if (pool.length === 1 || k <= 1) return pool[0];

    // Floor to avoid a pool where every weight is effectively zero.
    const weights = pool.map((r) => Math.max(0.001, r.similarity_score));
    const total = weights.reduce((a, b) => a + b, 0);
    let pick = rng() * total;
    for (let i = 0; i < pool.length; i++) {
        pick -= weights[i];
        if (pick <= 0) return pool[i];
    }
    return pool[pool.length - 1];
}
