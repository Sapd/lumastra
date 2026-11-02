// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MusicFieldSource } from '$lib/shared/music-provenance.js';

/** Shared types for album enrichment sources (TheAudioDB, Discogs, etc.) */

/** Unified result shape returned by all album enrichment sources */
export interface AlbumEnrichmentResult {
    provenance?: Partial<
        Record<'posterUrl' | 'backdropUrl' | 'releaseMbid' | 'releaseGroupMbid', MusicFieldSource>
    >;
    posterUrl: string | null;
    backdropUrl: string | null;
    releaseMbid: string | null;
    releaseGroupMbid: string | null;
}

/** Known enrichment source identifiers */
export type EnrichmentSourceId = 'theaudiodb' | 'discogs' | 'deezer';

/**
 * The chain found no poster AND could not ask every source: one failed
 * (`reason: 'source-unavailable'`, the client threw
 * `EnrichmentSourceUnavailableError`) or the run was stopped mid-chain
 * (`reason: 'aborted'`). Such a result is not a "no match": the album must
 * stay retryable, never be tombstoned.
 *
 * `partial` carries what the sources that did answer returned (e.g. a
 * release-group MBID), so the caller can still try Cover Art Archive.
 */
export class AlbumEnrichmentIncompleteError extends Error {
    constructor(
        readonly reason: 'source-unavailable' | 'aborted',
        readonly unavailableSources: EnrichmentSourceId[],
        readonly partial: AlbumEnrichmentResult | null,
    ) {
        super(
            reason === 'aborted'
                ? 'Album enrichment stopped before every source answered'
                : `Enrichment source unavailable: ${unavailableSources.join(', ')}`,
        );
        this.name = 'AlbumEnrichmentIncompleteError';
    }
}
