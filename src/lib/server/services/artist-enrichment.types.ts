// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MusicFieldSource } from '$lib/shared/music-provenance.js';

/** Shared types for artist enrichment sources (TheAudioDB, Discogs, etc.) */

/** Unified result shape returned by all enrichment sources */
export interface ArtistEnrichmentResult {
    provenance?: Partial<
        Record<
            | 'thumbUrl'
            | 'fanartUrl'
            | 'bannerUrl'
            | 'musicBrainzId'
            | 'biography'
            | 'genre'
            | 'countryCode',
            MusicFieldSource
        >
    >;
    thumbUrl: string | null;
    fanartUrl: string | null;
    bannerUrl: string | null;
    musicBrainzId: string | null;
    biography: string | null;
    genre: string | null;
    countryCode: string | null;
}

/** Known enrichment source identifiers */
export type EnrichmentSourceId = 'theaudiodb' | 'discogs' | 'deezer';

/**
 * A source could not answer: network error, timeout, non-2xx, a quota/error
 * payload, or an unparseable body. Distinct from "answered, no such artist"
 * (a `null` result), because only an answer may tombstone the artist.
 *
 * Every artist-search client throws this instead of returning `null` on
 * failure. Before it existed, TheAudioDB 404-ing every request (its free key
 * changed from `2` to `123`) and a day of failed Deezer lookups both read as
 * "no match", and those artists were marked `skipped_permanent` for good.
 */
export class EnrichmentSourceUnavailableError extends Error {
    constructor(
        readonly source: EnrichmentSourceId,
        readonly detail: string,
    ) {
        super(`${source} unavailable: ${detail}`);
        this.name = 'EnrichmentSourceUnavailableError';
    }
}

/**
 * The chain found no image AND could not ask every source: one failed
 * (`reason: 'source-unavailable'`) or the run was stopped mid-chain
 * (`reason: 'aborted'`). Such a result is not a "no match" — the artist must
 * stay retryable, never be tombstoned.
 */
export class ArtistEnrichmentIncompleteError extends Error {
    constructor(
        readonly reason: 'source-unavailable' | 'aborted',
        readonly unavailableSources: EnrichmentSourceId[],
    ) {
        super(
            reason === 'aborted'
                ? 'Artist enrichment stopped before every source answered'
                : `Enrichment source unavailable: ${unavailableSources.join(', ')}`,
        );
        this.name = 'ArtistEnrichmentIncompleteError';
    }
}
