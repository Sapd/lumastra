// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Session genre-streak detection for the music smart queue.
 *
 * This module builds a recency-weighted genre profile of the current
 * listening session and exposes a soft per-candidate score adjustment that
 * boosts or penalizes a candidate by how well it matches the streak's
 * dominant genre.
 *
 * Genre tags in this dataset are noisy multi-label arrays (a single track
 * can carry a dozen+ overlapping tags), so this deliberately avoids a hard
 * "must share a genre" gate — everything here is continuous and degrades
 * to a no-op when genre data is sparse or the session is genre-mixed.
 */

export interface GenreStreakProfile {
    /** Normalized recency-weighted tag → mass; sums to 1 across seen tags. */
    weights: Map<string, number>;
    /** Dominance of the strongest tag in `weights`. 0 when no streak detected. */
    cohesion: number;
}

const EMPTY_PROFILE: GenreStreakProfile = { weights: new Map(), cohesion: 0 };

/**
 * Builds the session genre profile from a current-first list of lowercased
 * genre-tag arrays (index 0 = currently playing track, index 1 = most
 * recent prior play, etc.). Each entry may be null/empty when that track
 * has no genre metadata.
 *
 * Requires at least 3 tagged tracks to produce a non-empty profile. This
 * isn't just a cold-start guard: with recency-decayed weights (halving per
 * hop back), the current track's own weight (1.0) is mathematically
 * guaranteed to be >= the sum of every other weight combined (a geometric
 * series capped below 1). So with only 2 tagged tracks, the current track's
 * own genre would ALWAYS reach >=50% cohesion regardless of whether the
 * prior track agrees — making "streak" detection fire on a single track,
 * not an actual pattern. Three tagged tracks (current + 2 prior) is the
 * minimum where a genuinely disagreeing history can outweigh a lone current
 * tag, so cohesion reflects real multi-track agreement — matching "some
 * rock tracks" (plural) from the reported behaviour.
 */
export function computeGenreStreakProfile(
    genreWindow: ReadonlyArray<readonly string[] | null | undefined>,
): GenreStreakProfile {
    const MIN_TAGGED_TRACKS = 3;
    const tagWeight = new Map<string, number>();
    let taggedWeightSum = 0;
    let taggedTrackCount = 0;

    genreWindow.forEach((tags, i) => {
        if (!tags || tags.length === 0) return;
        const weight = Math.pow(0.5, i);
        taggedWeightSum += weight;
        taggedTrackCount++;
        for (const tag of new Set(tags)) {
            tagWeight.set(tag, (tagWeight.get(tag) ?? 0) + weight);
        }
    });

    if (taggedTrackCount < MIN_TAGGED_TRACKS || taggedWeightSum <= 0) return EMPTY_PROFILE;

    const weights = new Map<string, number>();
    let cohesion = 0;
    for (const [tag, weight] of tagWeight) {
        const normalized = weight / taggedWeightSum;
        weights.set(tag, normalized);
        if (normalized > cohesion) cohesion = normalized;
    }

    return { weights, cohesion };
}

/**
 * A candidate's affinity to the session genre profile: the strongest match
 * among its own tags, in [0, 1]. Returns null when either side has no
 * genre data — callers must treat null as "no signal" (neutral), not as
 * zero overlap, so untagged tracks are never penalized.
 */
export function genreAffinity(
    candidateGenres: readonly string[] | null | undefined,
    profile: GenreStreakProfile,
): number | null {
    if (!candidateGenres || candidateGenres.length === 0) return null;
    if (profile.weights.size === 0) return null;

    let best = 0;
    for (const tag of candidateGenres) {
        const weight = profile.weights.get(tag.toLowerCase()) ?? 0;
        if (weight > best) best = weight;
    }
    return best;
}

/** Whether the recent session history is dominated enough by one genre to act on. */
export function isGenreStreakActive(profile: GenreStreakProfile, threshold: number): boolean {
    return profile.cohesion >= threshold;
}

/**
 * Soft additive score adjustment for a same-genre streak. Symmetric around
 * affinity = 0.5: candidates matching the dominant session genre are
 * boosted, candidates with confirmed zero overlap are penalized,
 * unknown-genre candidates (affinity = null) are left untouched. Scaled by
 * `weight` and by how dominant the streak actually is (`profile.cohesion`),
 * so a genre-mixed recent history produces little to no adjustment.
 */
export function genreStreakScoreAdjustment(
    candidateGenres: readonly string[] | null | undefined,
    profile: GenreStreakProfile,
    weight: number,
): number {
    const affinity = genreAffinity(candidateGenres, profile);
    if (affinity === null) return 0;
    return weight * profile.cohesion * (2 * affinity - 1);
}

/**
 * Extracts lowercased genre tags from a track's custom_metadata.genre field
 * (string, array of strings, or absent). Mirrors the ad-hoc genre
 * extraction that used to live inline in the smart-queue route.
 */
export function getGenreTags(meta: Record<string, unknown> | null | undefined): string[] | null {
    if (!meta) return null;
    const raw = meta['genre'];
    if (Array.isArray(raw)) {
        const tags = raw
            .filter((g): g is string => typeof g === 'string' && g.length > 0)
            .map((g) => g.toLowerCase());
        return tags.length > 0 ? tags : null;
    }
    if (typeof raw === 'string' && raw.length > 0) return [raw.toLowerCase()];
    return null;
}
