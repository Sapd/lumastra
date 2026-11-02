// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Album Enrichment Source Abstraction
 *
 * Defines the common result shape and chain executor for album enrichment.
 * Sources are tried in configured order; each source fills gaps left by
 * previous sources.
 */

import { Logger } from '$lib/server/utils/logger.js';
import { searchAlbum } from './theaudiodb-api.js';
import { searchReleaseDiscogs } from './discogs-api.js';
import { searchAlbumDeezer } from './deezer-api.js';
import { AlbumEnrichmentIncompleteError } from './album-enrichment.types.js';
import { EnrichmentSourceUnavailableError } from './artist-enrichment.types.js';
import type { EnrichmentSourceBreaker } from './enrichment-source-breaker.js';
import type { AlbumEnrichmentResult, EnrichmentSourceId } from './album-enrichment.types.js';

export type { AlbumEnrichmentResult, EnrichmentSourceId } from './album-enrichment.types.js';
export { AlbumEnrichmentIncompleteError } from './album-enrichment.types.js';

const logger = Logger.for('AlbumEnrichmentChain');

export const ALL_SOURCES: Array<{
    value: EnrichmentSourceId;
    label: string;
}> = [
    { value: 'theaudiodb', label: 'TheAudioDB (free, no key)' },
    { value: 'discogs', label: 'Discogs (requires token)' },
    { value: 'deezer', label: 'Deezer (free, no key)' },
];

export const DEFAULT_PRIMARY: EnrichmentSourceId = 'theaudiodb';
export const DEFAULT_FALLBACK: EnrichmentSourceId = 'discogs';

// =============================================================================
// Source Dispatch
// =============================================================================

interface SourceConfig {
    onArtwork?: (
        role: 'poster' | 'backdrop' | 'banner',
        url: string,
        provider: EnrichmentSourceId,
    ) => Promise<void>;
    barcode?: string;
    catalogueNumber?: string;
    year?: number;
    discogsToken?: string;
    /**
     * Optional abort signal. When composed in by the sync drain's
     * soft-budget loop, an in-flight HTTP fetch to TheAudioDB/Discogs
     * aborts immediately instead of waiting for the request's own
     * 10-second timeout — keeps admin-triggered stops responsive.
     */
    signal?: AbortSignal;
    /**
     * Per-run circuit breaker. An open source is skipped and counted as
     * unavailable, so the album is deferred instead of paying another
     * request to a provider that keeps failing.
     */
    breaker?: EnrichmentSourceBreaker<EnrichmentSourceId>;
}

async function fetchFromSource(
    sourceId: EnrichmentSourceId,
    artistName: string,
    albumTitle: string,
    config: SourceConfig,
): Promise<AlbumEnrichmentResult | null> {
    switch (sourceId) {
        case 'theaudiodb': {
            const result = await searchAlbum(artistName, albumTitle, {
                signal: config.signal,
            });
            if (!result) return null;
            return {
                posterUrl: result.posterUrl,
                backdropUrl: result.backdropUrl,
                releaseGroupMbid: result.releaseGroupMbid,
                releaseMbid: null,
            };
        }
        case 'discogs': {
            const result = await searchReleaseDiscogs(
                artistName,
                albumTitle,
                config.discogsToken ?? '',
                {
                    signal: config.signal,
                    barcode: config.barcode,
                    catalogueNumber: config.catalogueNumber,
                    year: config.year,
                },
            );
            if (!result) return null;
            return {
                provenance: result.provenance,
                posterUrl: result.posterUrl,
                backdropUrl: result.backdropUrl,
                releaseMbid: null,
                releaseGroupMbid: null,
            };
        }
        case 'deezer':
            return searchAlbumDeezer(artistName, albumTitle, { signal: config.signal });
        default:
            logger.warn('Unknown album enrichment source', { sourceId });
            return null;
    }
}

// =============================================================================
// Chain Executor
// =============================================================================

/**
 * Run album enrichment sources in order, merging results.
 *
 * The first source's non-null fields win. If the first source misses fields
 * (e.g. no image but has an MBID), subsequent sources fill the gaps.
 * Stops early if poster and at least one MBID are filled after a source.
 *
 * Returns `null` only when every source answered and none had anything.
 * Throws `AlbumEnrichmentIncompleteError` when there is no poster but a source
 * failed or the run was stopped before every source was asked; the error
 * carries whatever the other sources returned.
 */
export async function enrichAlbumFromChain(
    artistName: string,
    albumTitle: string,
    sources: EnrichmentSourceId[],
    config: SourceConfig,
): Promise<AlbumEnrichmentResult | null> {
    const merged: AlbumEnrichmentResult = {
        posterUrl: null,
        backdropUrl: null,
        releaseMbid: null,
        releaseGroupMbid: null,
    };

    let hasAnyData = false;
    const unavailable: EnrichmentSourceId[] = [];
    let stopped = false;

    for (const sourceId of sources) {
        // Check abort between sources so a cancelled run doesn't run
        // the second source for every album in the slice.
        if (config.signal?.aborted) {
            stopped = true;
            break;
        }
        if (config.breaker?.shouldSkip(sourceId)) {
            unavailable.push(sourceId);
            continue;
        }
        let result: AlbumEnrichmentResult | null;
        try {
            result = await fetchFromSource(sourceId, artistName, albumTitle, config);
            config.breaker?.recordAnswer(sourceId);
        } catch (err) {
            // An abort surfaces from the fetch as a plain error.
            if (config.signal?.aborted) {
                stopped = true;
                break;
            }
            if (!(err instanceof EnrichmentSourceUnavailableError)) {
                logger.warn('Album enrichment source threw unexpectedly', {
                    sourceId,
                    artistName,
                    albumTitle,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            // Keep going: a later source may still have the poster, and if
            // none does the caller retries instead of recording a no-match.
            config.breaker?.recordFailure(sourceId);
            unavailable.push(sourceId);
            continue;
        }
        if (!result) continue;

        if (result.posterUrl) await config.onArtwork?.('poster', result.posterUrl, sourceId);
        if (result.backdropUrl) await config.onArtwork?.('backdrop', result.backdropUrl, sourceId);
        merged.provenance ??= {};
        // Merge: first non-null value wins for each field
        if (!merged.posterUrl && result.posterUrl) {
            merged.posterUrl = result.posterUrl;
            merged.provenance.posterUrl = result.provenance?.posterUrl ?? { provider: sourceId };
            hasAnyData = true;
        }
        if (!merged.backdropUrl && result.backdropUrl) {
            merged.backdropUrl = result.backdropUrl;
            merged.provenance.backdropUrl = result.provenance?.backdropUrl ?? {
                provider: sourceId,
            };
            hasAnyData = true;
        }
        if (!merged.releaseMbid && result.releaseMbid) {
            merged.releaseMbid = result.releaseMbid;
            merged.provenance.releaseMbid = result.provenance?.releaseMbid ?? {
                provider: sourceId,
            };
            hasAnyData = true;
        }
        if (!merged.releaseGroupMbid && result.releaseGroupMbid) {
            merged.releaseGroupMbid = result.releaseGroupMbid;
            merged.provenance.releaseGroupMbid = result.provenance?.releaseGroupMbid ?? {
                provider: sourceId,
            };
            hasAnyData = true;
        }

        // Stop early when poster and at least one MBID are filled
        if (merged.posterUrl && (merged.releaseMbid || merged.releaseGroupMbid)) {
            break;
        }
    }

    if (!merged.posterUrl) {
        const partial = hasAnyData ? merged : null;
        // `searchReleaseDiscogs` returns null (not a throw) when the abort lands
        // between its two requests, so check the signal too, not just `stopped`.
        if (stopped || config.signal?.aborted) {
            throw new AlbumEnrichmentIncompleteError('aborted', unavailable, partial);
        }
        if (unavailable.length > 0) {
            throw new AlbumEnrichmentIncompleteError('source-unavailable', unavailable, partial);
        }
    }

    return hasAnyData ? merged : null;
}
