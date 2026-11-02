// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Last.fm "lane affinity" re-rank term for the sonic smart queue.
 *
 * MSCLAP audio similarity hears production — tempo, four-on-floor kick,
 * supersaw leads, club mastering — but not scene: a bigroom Cloudrunner remix
 * sits right next to Martin Fenwick in audio space while belonging to a
 * different musical culture (hands-up/rave vs French electro-house), and the
 * file-tag genre boost can't discriminate either when everything shares one
 * coarse tag ("House"). This module scores that missing dimension from the
 * per-artist Last.fm crowd data the popularity provider already stores
 * (media_popularity.raw_metadata: `tags`, `similar_artists`).
 *
 * Two signals, strongest first:
 *   1. Similar-artist link — the candidate's artist appears in the current
 *      artist's Last.fm similar list (or vice versa). Crowd co-listening is
 *      a direct "same scene" statement → affinity 1.0. Matching is exact
 *      case-insensitive name equality against a curated list — deliberately
 *      NOT substring or semantic text matching, so name resemblance alone
 *      ("Moonlight X" vs "Moon Y") can never create a link.
 *   2. Tag-set Jaccard — overlap of the two artists' crowd tag folksonomies
 *      ({house, french, club} vs {hands up, german, trance}), compared as
 *      opaque case-insensitive labels.
 *
 * Missing data on either side yields null and callers MUST treat null as
 * neutral (0 adjustment) — most compilation tracks have no resolvable artist
 * and must not be penalized for it.
 *
 * The adjustment is centered (±weight), unlike the boost-only genre term: a
 * disjoint lane actively demotes. Weight must stay comparable to the genre
 * boost (0.12) and well below typical retrieval similarity spreads so audio
 * similarity remains the decider — this reorders near-equals, it never
 * overrides a clearly closer-sounding candidate.
 */

/** Per-artist Last.fm crowd data (from media_popularity.raw_metadata). */
export interface ArtistLaneData {
    /** Crowd tags, as stored (any case, e.g. "House", "hands up"). */
    tags: string[];
    /** Similar artist names, as returned by Last.fm artist.getinfo. */
    similar: string[];
}

/** One side of a lane comparison: display name + fetched lane data. */
export interface LaneComparand {
    name: string | null;
    lane: ArtistLaneData | null;
}

function norm(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Various-Artists alias set, matching the canonical list in
 * music-artist.fragments.ts (normalizedArtistTitleSql). A VA "artist" must
 * never participate in lane comparison: its Last.fm entry (if one exists)
 * carries meaningless aggregate tags that would be attributed to whatever
 * per-track artist name the compilation track displays.
 */
const VARIOUS_ARTIST_ALIASES = new Set(['va', 'various', 'various artists']);

/** True when an artist display name is a Various-Artists alias (any case/punctuation). */
export function isVariousArtistsName(name: string | null): boolean {
    if (!name) return false;
    const normalized = norm(name).replace(/[^a-z0-9 ]/g, '');
    return VARIOUS_ARTIST_ALIASES.has(normalized);
}

function hasSimilarLink(a: LaneComparand, b: LaneComparand): boolean {
    const aName = a.name ? norm(a.name) : null;
    const bName = b.name ? norm(b.name) : null;
    if (bName && a.lane?.similar.some((s) => norm(s) === bName)) return true;
    if (aName && b.lane?.similar.some((s) => norm(s) === aName)) return true;
    return false;
}

/**
 * Lane affinity between the current artist and a candidate artist, in [0, 1].
 *
 * 1.0 on a similar-artist link in either direction; otherwise the Jaccard
 * index of the lowercased tag sets. Returns null when there is insufficient
 * evidence — no similar link AND either side is missing lane data or has an
 * empty tag set. Null means "unknown", not "different lane".
 */
export function computeLaneAffinity(
    current: LaneComparand,
    candidate: LaneComparand,
): number | null {
    if (hasSimilarLink(current, candidate)) return 1.0;

    const curTags = current.lane?.tags ?? [];
    const candTags = candidate.lane?.tags ?? [];
    if (curTags.length === 0 || candTags.length === 0) return null;

    const curSet = new Set(curTags.map(norm));
    const candSet = new Set(candTags.map(norm));
    let intersection = 0;
    for (const t of candSet) {
        if (curSet.has(t)) intersection++;
    }
    const union = curSet.size + candSet.size - intersection;
    if (union === 0) return null;
    return intersection / union;
}

/**
 * Centered additive score adjustment for a lane affinity: [0, 1] maps onto
 * [-weight, +weight] via `2x − 1`; null (unknown) is neutral 0.
 */
export function laneAffinityAdjustment(affinity: number | null, weight: number): number {
    if (affinity === null) return 0;
    return weight * (2 * affinity - 1);
}
