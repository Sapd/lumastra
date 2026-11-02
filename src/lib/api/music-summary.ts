// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music hover-card summaries.
 *
 * Fetches the tiny artist/album summary endpoints and caches each entity for the
 * lifetime of the page. A hover card can be opened and closed dozens of times
 * while a track plays; without the cache that would be one request per hover.
 *
 * @module api/music-summary
 */

import { apiGet } from './client';
import {
    MusicAlbumSummarySchema,
    MusicArtistSummarySchema,
    type MusicAlbumSummary,
    type MusicArtistSummary,
} from '$lib/schemas/api-music-responses';

/** Which kind of entity a hover card is describing. */
export type MusicEntityKind = 'artist' | 'album';

/** The union a hover card renders. Which arm applies follows the requested kind. */
export type MusicEntitySummary = MusicArtistSummary | MusicAlbumSummary;

/**
 * Resolved and in-flight lookups, keyed by `${kind}:${id}`.
 *
 * Promises (not values) are cached so two cards hovering the same entity before
 * the first response lands share one request rather than racing.
 */
const cache = new Map<string, Promise<MusicEntitySummary | null>>();

function cacheKey(kind: MusicEntityKind, id: string): string {
    return `${kind}:${id}`;
}

async function fetchSummary(kind: MusicEntityKind, id: string): Promise<MusicEntitySummary | null> {
    const result =
        kind === 'artist'
            ? await apiGet(`/api/music/artists/${id}/summary`, MusicArtistSummarySchema)
            : await apiGet(`/api/music/albums/${id}/summary`, MusicAlbumSummarySchema);

    return result.data ?? null;
}

/**
 * Fetch an artist or album summary, reusing any cached or in-flight request.
 *
 * Resolves to null when the entity is missing or inaccessible (the endpoints
 * 404 on both, deliberately, so they cannot be used to probe scope) — callers
 * render nothing rather than surfacing an error to a hover.
 *
 * A rejected fetch is evicted, so a transient failure (offline, a 500) does not
 * poison the entry for the rest of the session; the next hover retries. A
 * successful `null` IS cached: a 404 will still be a 404 next hover, and
 * re-requesting it on every pass would be pure waste.
 */
export function getMusicEntitySummary(
    kind: MusicEntityKind,
    id: string,
): Promise<MusicEntitySummary | null> {
    const key = cacheKey(kind, id);

    const cached = cache.get(key);
    if (cached) return cached;

    const request = fetchSummary(kind, id).catch((error: unknown) => {
        cache.delete(key);
        throw error;
    });

    cache.set(key, request);
    return request;
}

/** Drop every cached summary. Exported for tests. */
export function clearMusicEntitySummaryCache(): void {
    cache.clear();
}
