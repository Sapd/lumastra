// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Stable per-artist diversity key for music tracks.
 *
 * Compilation tracks tagged "Various Artists" share a single synthetic
 * artist_id, so a naive `artist_id`-based per-artist cap suppresses
 * consecutive compilation tracks even though their underlying real artists
 * differ. This helper returns `va:${trackId}` for VA tracks so each VA
 * track is its own artist for cap purposes, mirroring the `va:${id}`
 * partition used in the SQL "Because You Listened" rank.
 *
 * Used by both Quick Picks (bucket interleave + global artist cap +
 * adjacency guard) and the autoplay smart-queue diversity filter. Both
 * surfaces feed inputs that may or may not carry a stable artist_id, so
 * the key is intentionally name-based — mixing UUID and name keys for the
 * same artist breaks the cap silently when one path has the hierarchy
 * populated and another does not.
 */

import { isVariousArtistsName } from './music-scanner-utils.js';

export const UNKNOWN_ARTIST_KEY = '__unknown_artist__';

export interface ArtistKeyInput {
    /** Track ID — used as the unique key for VA tracks */
    id: string;
    /** Display artist name. Triggers VA detection; primary diversity key. */
    artistName?: string | null;
    /**
     * Optional fallback ID (typically album/parent_id) for shapes that don't
     * carry an artist name at all. Keeps tracks from the same album grouped
     * under one cap entry when their artist info is missing.
     */
    fallbackId?: string | null;
}

/**
 * Resolution order:
 *   1. VA detection on `artistName` → `va:${trackId}` (each VA track unique)
 *   2. Lowercased trimmed `artistName`
 *   3. `fallbackId` (e.g. album)
 *   4. UNKNOWN_ARTIST_KEY (synthetic bucket so unknowns share a cap)
 *
 * Note: an explicit artist_id is intentionally NOT used. Caller paths
 * disagree on whether they carry a stable artist_id (autoplay's candidate
 * shape doesn't, Quick Picks' bucket queries sometimes do, and
 * trackDisplayArtistSql can surface per-track metadata that disagrees with
 * the album→artist hierarchy). Falling back to lowercased name keeps the
 * key space unified across all those paths so the cap actually counts
 * "the same artist" the same way.
 */
export function effectiveArtistKey(input: ArtistKeyInput): string {
    const { id, artistName, fallbackId } = input;
    if (artistName && isVariousArtistsName(artistName)) return `va:${id}`;
    const trimmed = artistName?.trim().toLowerCase();
    if (trimmed) return trimmed;
    if (fallbackId && fallbackId.trim().length > 0) return fallbackId.trim();
    return UNKNOWN_ARTIST_KEY;
}

/**
 * The primary CREDIT artist for a track, from the structured per-artist list
 * (`trackArtistsSql` → `additional_artist_ids`), or undefined when absent.
 *
 * Why this exists: `resolved_artist` is a DISPLAY string and stays combined by
 * design — artist-linkify preserves the raw ARTIST tag byte-for-byte and
 * splits it into links at render time, so a scan never rewrites it. Keying a
 * diversity cap off that string makes every credit line its own artist:
 * measured on prod, autoplay served "Eloren Ft 50 Sparks & Dr. Vale" immediately
 * followed by "Eloren", because the hard don't-repeat-the-current-artist rule
 * compared two different key strings. 1,949 of 24,240 tracks (8.0%) carry a
 * multi-credit display name (feat/ft/&/x/vs/comma), and ALL of them have the
 * structured list populated — so this resolves cleanly for every affected row.
 *
 * NOT a canonical artist identity, and deliberately not sold as one:
 *   - Element 0 is TAG order, not billing order. "Nicco x Manian" yields
 *     "Nicco". It identifies the credit line's lead, not the "main" act.
 *   - It collapses genuinely distinct acts: a solo track and a duo track
 *     sharing a lead land in one bucket. For a DIVERSITY CAP that is the
 *     desired behaviour — consistency matters more than picking the right
 *     name — but it would be wrong for display or for linking.
 *
 * Callers must fall back to the existing display-name chain when this returns
 * undefined, so the key space stays unified across rows that have no
 * structured list. Every site that keys the same cap MUST use this helper —
 * mixing a credit-derived key with a display-derived one silently no-ops the
 * cap, which is the failure this whole helper exists to prevent.
 */
export function primaryCreditArtistName(
    trackArtists: Array<{ id: string | null; title: string }> | null | undefined,
): string | undefined {
    const first = trackArtists?.[0]?.title?.trim();
    return first && first.length > 0 ? first : undefined;
}
