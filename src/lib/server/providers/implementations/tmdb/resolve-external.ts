// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB external-id resolver.
 *
 * Wraps TMDB's `/find/{external_id}` endpoint and normalises the response
 * into a `MetadataCandidate`. Used by the file scanner when an NFO sidecar
 * or filename token (`tt1234567` / `{tmdb-1234}`) supplies an authoritative
 * external id, so we can resolve straight to the TMDB row without a fuzzy
 * title search.
 *
 * Only TMDB exposes this bridge (other providers either don't index foreign
 * ids or don't have a comparable endpoint), so consumers must gate the call
 * with `providerId === 'tmdb-metadata-provider'`. Returns null on any
 * miss / API error so callers can fall through to title search.
 *
 * Confidence is forced to 1.0 — the `/find` endpoint is authoritative, not
 * heuristic, so it shouldn't share the popularity-derived scoring that the
 * normal search candidates use.
 *
 * Supported sources (all pass-through to TMDB API):
 * - 'imdb' → imdb_id
 * - 'tvdb' → tvdb_id
 * - 'facebook' → facebook_id
 * - 'instagram' → instagram_id
 * - 'twitter' → twitter_id
 */

import type { MetadataCandidate } from '$lib/server/providers/types.js';
import { tmdbApi } from './client.js';
import { searchResultToCandidate } from './normalize.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isMovie } from '$lib/server/utils/media-types.js';

const log = Logger.for('TmdbResolveExternal');

export async function tmdbResolveExternalId(
    externalId: string,
    source: 'imdb' | 'tvdb' | 'facebook' | 'instagram' | 'twitter',
    mediaType: 'movie' | 'tv',
): Promise<MetadataCandidate | null> {
    try {
        // Wrap the availability gate too — `isAvailable()` is documented as
        // synchronous + non-throwing but the contract isn't formally enforced,
        // and the function's promise of "null on any miss / API error"
        // should hold even if it ever changes.
        if (!tmdbApi.isAvailable()) return null;

        const tmdbSource = `${source}_id` as const;
        const result = await tmdbApi.findByExternalId(externalId, tmdbSource);
        const matches = isMovie(mediaType) ? result.movie_results : result.tv_results;
        if (matches.length === 0) return null;
        const first = matches[0];
        if (first.id == null) {
            log.warn('TMDB /find returned a result without id — skipping', {
                externalId,
                source,
                mediaType,
            });
            return null;
        }
        const candidate = searchResultToCandidate({ ...first, media_type: mediaType }, mediaType);
        if (!candidate) return null;
        return { ...candidate, confidence: 1.0 };
    } catch (err) {
        log.warn('resolveExternalId failed', {
            externalId,
            source,
            mediaType,
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
