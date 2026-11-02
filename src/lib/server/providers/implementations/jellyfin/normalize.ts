// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin normalization helpers.
 *
 * Converts raw JellyfinItem shapes returned by the native provider's
 * search() and detail() methods into MetadataCandidate / MediaMetadata.
 *
 * Logic mirrors the legacy jellyfin metadata-provider plugin's
 * toMovieCandidate / toSeriesCandidate / getMovieDetail / getSeriesDetail
 * implementations exactly.
 *
 * Note: The legacy getSeriesDetail delegates to jellyfinSeriesService which
 * returns a shaped object (name, overview, year, genres, status), not a raw
 * JellyfinItem. The native provider returns the raw JellyfinItem from
 * /Items/{id}. Both shapes are handled here — missing fields degrade
 * gracefully to undefined.
 */

import type { MetadataCandidate, MediaMetadata } from '$lib/server/providers/types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
    if (typeof v === 'number' && isFinite(v)) return v;
    return undefined;
}

/** 1 RunTimeTick = 100 nanoseconds → minutes */
function ticksToMinutes(ticks: unknown): number | undefined {
    const t = num(ticks);
    if (t == null) return undefined;
    return Math.round(t / 600_000_000);
}

// ---------------------------------------------------------------------------
// searchResultToCandidate
// ---------------------------------------------------------------------------

/**
 * Map a raw Jellyfin item (from /Items search) to MetadataCandidate.
 *
 * The `type` param determines mediaType in the output — the legacy plugin
 * filters by item.Type before mapping, so only matching types reach here.
 *
 * Returns null if Id is missing.
 */
export function searchResultToCandidate(
    raw: unknown,
    type: 'movie' | 'tv',
): MetadataCandidate | null {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;

    const id = item['Id'];
    if (!id) return null;

    const title = str(item['Name']) || str(id);

    const providerIds = item['ProviderIds'];
    let externalIds: Record<string, string> | undefined;
    if (providerIds && typeof providerIds === 'object' && !Array.isArray(providerIds)) {
        const raw = providerIds as Record<string, unknown>;
        const mapped: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw)) {
            if (typeof value === 'string' && value) {
                mapped[key.toLowerCase()] = value;
            }
        }
        if (Object.keys(mapped).length > 0) {
            externalIds = mapped;
        }
    }

    return {
        externalId: str(id),
        provider: 'jellyfin',
        title,
        year: num(item['ProductionYear']),
        mediaType: type === 'movie' ? 'movie' : 'tv',
        confidence: 0.7,
        ...(externalIds !== undefined && { externalIds }),
        ...(str(item['OfficialRating']) && { certification: str(item['OfficialRating']) }),
    };
}

// ---------------------------------------------------------------------------
// detailToMetadata
// ---------------------------------------------------------------------------

/**
 * Map a raw Jellyfin item detail response (/Items/{id}) to MediaMetadata.
 *
 * Mirrors legacy getMovieDetail for both movie and series detail — the legacy
 * getSeriesDetail used a different service shape (name/year/genres/status)
 * but the native provider returns the raw /Items/{id} response for all types.
 *
 * Returns null if the raw object is missing.
 */
export function detailToMetadata(raw: unknown, _type: 'movie' | 'tv'): MediaMetadata | null {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;

    const name = str(item['Name']) || undefined;
    if (!name) return null;

    const premiereDate = str(item['PremiereDate']);

    return {
        title: name,
        originalTitle: str(item['OriginalTitle']) || undefined,
        overview: str(item['Overview']) || undefined,
        year: num(item['ProductionYear']),
        genres: Array.isArray(item['Genres'])
            ? (item['Genres'] as unknown[]).map((g) => str(g))
            : undefined,
        runtime: ticksToMinutes(item['RunTimeTicks']),
        releaseDate: premiereDate ? premiereDate.substring(0, 10) : undefined,
        externalIds:
            item['ProviderIds'] && typeof item['ProviderIds'] === 'object'
                ? (item['ProviderIds'] as Record<string, string>)
                : undefined,
        status: str(item['Status']) || undefined,
        certification: str(item['OfficialRating']) || undefined,
    };
}
