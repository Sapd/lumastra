// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Artist Enrichment Source Abstraction
 *
 * Defines the common result shape and chain executor for artist enrichment.
 * Sources are tried in configured order; each source fills gaps left by
 * previous sources.
 */

import { Logger } from '$lib/server/utils/logger.js';
import { searchArtist as searchTheAudioDB } from './theaudiodb-api.js';
import { searchArtistDiscogs } from './discogs-api.js';
import { searchArtistDeezer } from './deezer-api.js';
import { leadArtistName } from './artist-name-match.js';
import {
    ArtistEnrichmentIncompleteError,
    EnrichmentSourceUnavailableError,
} from './artist-enrichment.types.js';
import type { ArtistEnrichmentResult, EnrichmentSourceId } from './artist-enrichment.types.js';
import type { EnrichmentSourceBreaker } from './enrichment-source-breaker.js';

export type { ArtistEnrichmentResult, EnrichmentSourceId } from './artist-enrichment.types.js';
export {
    ArtistEnrichmentIncompleteError,
    EnrichmentSourceUnavailableError,
} from './artist-enrichment.types.js';

const logger = Logger.for('ArtistEnrichmentChain');

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
    /** Established catalogue identity: contradictory source results contribute nothing. */
    knownMusicBrainzId?: string | null;
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
     * unavailable, so the artist is deferred instead of paying another
     * request to a provider that keeps failing.
     */
    breaker?: EnrichmentSourceBreaker<EnrichmentSourceId>;
}

async function fetchFromSource(
    sourceId: EnrichmentSourceId,
    artistName: string,
    config: SourceConfig,
): Promise<ArtistEnrichmentResult | null> {
    switch (sourceId) {
        case 'theaudiodb':
            return searchTheAudioDB(artistName, { signal: config.signal });
        case 'discogs':
            return searchArtistDiscogs(artistName, config.discogsToken ?? '', {
                signal: config.signal,
            });
        case 'deezer':
            return searchArtistDeezer(artistName, { signal: config.signal });
        default:
            logger.warn('Unknown enrichment source', { sourceId });
            return null;
    }
}

// =============================================================================
// Chain Executor
// =============================================================================

/**
 * Run every source in order over ONE name, merging field-by-field.
 *
 * First non-null value wins per field; stops early once the fields that
 * matter most are all present.
 */
async function runChainForName(
    artistName: string,
    sources: EnrichmentSourceId[],
    config: SourceConfig,
): Promise<{
    merged: ArtistEnrichmentResult;
    hasAnyData: boolean;
    /** Sources that failed instead of answering. */
    unavailable: EnrichmentSourceId[];
}> {
    const merged: ArtistEnrichmentResult = {
        thumbUrl: null,
        fanartUrl: null,
        bannerUrl: null,
        musicBrainzId: null,
        biography: null,
        genre: null,
        countryCode: null,
    };

    let hasAnyData = false;
    const unavailable: EnrichmentSourceId[] = [];

    for (const sourceId of sources) {
        // Check abort between sources so a cancelled run doesn't run
        // the second source for every artist in the slice.
        if (config.signal?.aborted) return { merged, hasAnyData, unavailable };
        if (config.breaker?.shouldSkip(sourceId)) {
            unavailable.push(sourceId);
            continue;
        }
        let result: ArtistEnrichmentResult | null;
        try {
            result = await fetchFromSource(sourceId, artistName, config);
            config.breaker?.recordAnswer(sourceId);
        } catch (err) {
            // An abort surfaces from the fetch as a plain error; the caller
            // reads `config.signal.aborted`, so just stop here.
            if (config.signal?.aborted) return { merged, hasAnyData, unavailable };
            if (!(err instanceof EnrichmentSourceUnavailableError)) {
                logger.warn('Enrichment source threw unexpectedly', {
                    sourceId,
                    artistName,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            // Keep going: a later source may still have the image, and if
            // none does the caller retries instead of recording a no-match.
            config.breaker?.recordFailure(sourceId);
            unavailable.push(sourceId);
            continue;
        }
        if (!result) continue;
        if (
            config.knownMusicBrainzId &&
            result.musicBrainzId &&
            result.musicBrainzId.toLowerCase() !== config.knownMusicBrainzId.toLowerCase()
        ) {
            logger.debug('Ignoring enrichment result for a different MusicBrainz artist', {
                sourceId,
                artistName,
            });
            continue;
        }

        if (result.thumbUrl) await config.onArtwork?.('poster', result.thumbUrl, sourceId);
        if (result.fanartUrl) await config.onArtwork?.('backdrop', result.fanartUrl, sourceId);
        if (result.bannerUrl) await config.onArtwork?.('banner', result.bannerUrl, sourceId);
        merged.provenance ??= {};
        // Merge: first non-null value wins for each field
        if (!merged.thumbUrl && result.thumbUrl) {
            merged.thumbUrl = result.thumbUrl;
            merged.provenance.thumbUrl = result.provenance?.thumbUrl ?? { provider: sourceId };
            hasAnyData = true;
        }
        if (!merged.fanartUrl && result.fanartUrl) {
            merged.fanartUrl = result.fanartUrl;
            merged.provenance.fanartUrl = result.provenance?.fanartUrl ?? { provider: sourceId };
            hasAnyData = true;
        }
        if (!merged.bannerUrl && result.bannerUrl) {
            merged.bannerUrl = result.bannerUrl;
            merged.provenance.bannerUrl = result.provenance?.bannerUrl ?? { provider: sourceId };
            hasAnyData = true;
        }
        if (!merged.musicBrainzId && result.musicBrainzId) {
            merged.musicBrainzId = result.musicBrainzId;
            merged.provenance.musicBrainzId = result.provenance?.musicBrainzId ?? {
                provider: sourceId,
            };
            hasAnyData = true;
        }
        if (!merged.biography && result.biography) {
            merged.biography = result.biography;
            merged.provenance.biography = result.provenance?.biography ?? { provider: sourceId };
            hasAnyData = true;
        }
        if (!merged.genre && result.genre) {
            merged.genre = result.genre;
            merged.provenance.genre = result.provenance?.genre ?? { provider: sourceId };
            hasAnyData = true;
        }
        if (!merged.countryCode && result.countryCode) {
            merged.countryCode = result.countryCode;
            merged.provenance.countryCode = result.provenance?.countryCode ?? {
                provider: sourceId,
            };
            hasAnyData = true;
        }

        // Stop early if we have the most important fields
        if (merged.thumbUrl && merged.biography && merged.musicBrainzId) {
            break;
        }
    }

    return { merged, hasAnyData, unavailable };
}

/**
 * Run enrichment sources in order, merging results.
 *
 * The first source's non-null fields win. If the first source misses fields
 * (e.g. no image but has biography), subsequent sources fill the gaps.
 * Stops early if all key fields are filled after a source.
 *
 * COMPOUND-CREDIT FALLBACK. When the full name yields no image and the name
 * is a compound credit ("Ferry Corsten presents Gouryella", "Housegeist meets
 * Fec-T"), the chain runs once more against the LEAD artist alone. No provider
 * carries the compound string, but all of them carry the lead act, and the
 * lead act is the same performer — so its photo is the right photo.
 *
 * Only the IMAGE fields are adopted from that second pass. Identity-bearing
 * fields are deliberately dropped: writing Ferry Corsten's MusicBrainz ID onto
 * the Gouryella row would merge two distinct catalogue entities behind the
 * user's back, and his biography would simply be describing someone else.
 *
 * Returns `null` only when every source answered and none has an image.
 * Throws `ArtistEnrichmentIncompleteError` when there is no image but a
 * source failed or the run was stopped before every source was asked.
 */
export async function enrichArtistFromChain(
    artistName: string,
    sources: EnrichmentSourceId[],
    config: SourceConfig,
): Promise<ArtistEnrichmentResult | null> {
    const { merged, hasAnyData, unavailable } = await runChainForName(artistName, sources, config);
    let found = hasAnyData;
    const unavailableSources = new Set(unavailable);

    if (!merged.thumbUrl && !config.signal?.aborted) {
        const lead = leadArtistName(artistName);
        if (lead) {
            logger.debug('No image for compound credit — retrying on lead artist', {
                artistName,
                lead,
            });
            const fallback = await runChainForName(lead, sources, config);
            for (const sourceId of fallback.unavailable) unavailableSources.add(sourceId);
            // Images only — see the doc comment above.
            if (fallback.merged.thumbUrl) {
                merged.provenance ??= {};
                for (const field of ['thumbUrl', 'fanartUrl', 'bannerUrl'] as const) {
                    if (!merged[field] && fallback.merged[field]) {
                        merged[field] = fallback.merged[field];
                        merged.provenance[field] = fallback.merged.provenance?.[field];
                    }
                }
                found = true;
            }
        }
    }

    if (!merged.thumbUrl) {
        if (config.signal?.aborted) {
            throw new ArtistEnrichmentIncompleteError('aborted', [...unavailableSources]);
        }
        if (unavailableSources.size > 0) {
            throw new ArtistEnrichmentIncompleteError('source-unavailable', [
                ...unavailableSources,
            ]);
        }
    }

    return found ? merged : null;
}
