// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transport-agnostic MusicBrainz result shapes and pure data helpers.
 *
 * MusicBrainz metadata is fetched through two intentionally separate transports:
 * - `enrichment.ts` (this directory) uses the module-level `api-client.ts`
 *   `fetch` client for direct, non-plugin service calls.
 * - `tasks/builtin/native/providers/musicbrainz.ts` re-fetches through the
 *   rate-limited, SSRF-hardened plugin `ctx.http` transport.
 *
 * The HTTP layers can't be shared, but the *result shapes* and the *pure
 * transforms* over already-fetched JSON are identical. This module is the
 * single source of truth for those — keep it free of any transport
 * (`fetch`/`ctx.http`) dependency.
 */

// =============================================================================
// Public result shapes
// =============================================================================

export interface MusicAlbumCandidate {
    mbid: string;
    title: string;
    artistName: string;
    year?: number;
    releaseGroupMbid?: string;
    primaryType?: string;
    confidence: number;
    coverArtUrl?: string;
}

export interface MusicAlbumDetail {
    mbid: string;
    title: string;
    artistName: string;
    artistMbid?: string;
    year?: number;
    label?: string;
    catalogNumber?: string;
    primaryType?: string;
    genres: string[];
    tags: string[];
    tracks: MusicTrackStub[];
    coverArtUrl?: string;
    releaseGroupMbid?: string;
}

export interface MusicTrackStub {
    position: number;
    title: string;
    durationMs?: number;
    recordingMbid?: string;
}

export interface MusicArtistDetail {
    mbid: string;
    name: string;
    sortName: string;
    type?: string;
    country?: string;
    beginDate?: string;
    endDate?: string;
    genres: string[];
    tags: string[];
    releaseGroups: Array<{
        mbid: string;
        title: string;
        primaryType?: string;
        year?: number;
    }>;
}

// =============================================================================
// Pure helpers over already-fetched MusicBrainz JSON
// =============================================================================

/** Minimal structural shape consumed by {@link extractGenres}. */
interface GenreTagSource {
    genres?: Array<{ name: string }>;
    tags?: Array<{ name: string; count: number }>;
}

/** Minimal structural shape of a MusicBrainz artist-credit entry. */
interface ArtistCreditLike {
    name: string;
    artist: { id: string; name: string };
    joinphrase?: string;
}

/** Merge explicit genres with positive-count tag genres, de-duplicated. */
export function extractGenres(obj: GenreTagSource | undefined | null): string[] {
    const genres = (obj?.genres ?? []).map((g) => g.name);
    const tagGenres = (obj?.tags ?? []).filter((t) => t.count > 0).map((t) => t.name);
    return [...new Set([...genres, ...tagGenres])];
}

/** Name of the first credited artist, or a stable fallback. */
export function primaryArtistName(credits: ArtistCreditLike[] | undefined): string {
    return credits?.[0]?.artist?.name ?? 'Unknown Artist';
}

/** All credited artists beyond the primary, as featuring entries. */
export function extractFeaturingArtists(
    credits: ArtistCreditLike[] | undefined,
): Array<{ name: string; mbid: string; joinphrase?: string }> {
    if (!credits || credits.length <= 1) return [];
    return credits.slice(1).map((credit) => ({
        name: credit.name || credit.artist.name,
        mbid: credit.artist.id,
        joinphrase: credit.joinphrase || undefined,
    }));
}

/** Parse a 4-digit leading year out of a MusicBrainz date string. */
export function releaseYear(dateStr?: string): number | undefined {
    if (!dateStr) return undefined;
    const year = parseInt(dateStr.slice(0, 4), 10);
    return isNaN(year) ? undefined : year;
}
