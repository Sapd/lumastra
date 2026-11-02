// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Popularity orchestrator.
 *
 * Takes a provider + one artist and produces writes to the media_popularity
 * table. The provider stays provider-native; matching, normalization, and
 * persistence live here.
 *
 * Flow per artist:
 *   1. Load our library's tracks for the artist (with MBIDs where available)
 *   2. Call provider.fetchArtistPopularity(artist)
 *   3. Match provider's top-tracks list to our library tracks
 *   4. Normalize scores (artist: log-scaled global; tracks: per-artist linear)
 *   5. Delete stale track rows for this artist/source, then upsert fresh ones
 *   6. Upsert artist row; record unmatched provider-track titles in raw_metadata
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import {
    deleteTrackPopularityForArtist,
    getLibraryTracksForArtist,
    markArtistProbed,
    upsertArtistPopularity,
    upsertTrackPopularity,
} from '../../database/queries/popularity.queries.js';
import { withTx } from '../../database/with-tx.js';
import { matchTracks, type LibraryTrack } from './matcher.js';
import { normalizeArtistScore, normalizeTitle, normalizeTrackScores } from './normalize.js';
import type { PopularityProvider } from './types.js';

const logger = Logger.for('PopularityOrchestrator');

/**
 * Ceiling used for global artist score normalization. Chosen to be near the
 * highest Last.fm listener count observed (~5M for Beatles-tier artists) so
 * the log curve covers the realistic range without saturating top artists
 * at 1.0. Tunable later if we observe saturation.
 */
const ARTIST_LISTENER_CEILING = 5_000_000;

export interface EnrichArtistInput {
    artistId: string;
    title: string;
    mbid?: string;
}

export interface EnrichArtistResult {
    fetched: boolean;
    matchedTracks: number;
    unmatchedProviderTracks: number;
    artistScore: number | null;
    /**
     * True iff this call moved the artist out of the stale window — either
     * by writing real popularity data (`fetched: true`) OR by landing a
     * probe sentinel (`fetched: false` with a successful markArtistProbed).
     * When the provider threw (left the row stale for retry) or the
     * probe-write itself failed, `advanced` is `false` so drainBacklog's
     * no-progress detector stays armed against pathological writers.
     */
    advanced: boolean;
}

/**
 * Fetch popularity for one artist via the given provider and persist the
 * results. Returns a summary for the plugin's progress log.
 *
 * Does not throw on provider failure — returns `fetched: false` so the
 * plugin can continue with the next artist.
 *
 * `advanced` in the return signals whether the row left the stale window
 * this call. That's used by the drain's no-progress detector: a DB failure
 * that swallows every probe-write would otherwise be indistinguishable
 * from genuine progress.
 */
export async function enrichArtist(
    sql: postgres.Sql,
    provider: PopularityProvider,
    input: EnrichArtistInput,
    options: { signal?: AbortSignal } = {},
): Promise<EnrichArtistResult> {
    // 1. Load library tracks for matching
    const libraryRows = await getLibraryTracksForArtist(sql, input.artistId);
    const libraryTracks: LibraryTrack[] = libraryRows.map((row) => ({
        id: row.id,
        title: row.title,
        normalizedTitle: normalizeTitle(row.title),
        mbid: row.mbid,
    }));

    // 2. Ask the provider
    let providerResult;
    try {
        providerResult = await provider.fetchArtistPopularity(
            {
                title: input.title,
                mbid: input.mbid,
            },
            options,
        );
    } catch (err) {
        logger.warn('Provider fetch threw', {
            provider: provider.id,
            artistId: input.artistId,
            title: input.title,
            error: err instanceof Error ? err.message : String(err),
        });
        return {
            fetched: false,
            matchedTracks: 0,
            unmatchedProviderTracks: 0,
            artistScore: null,
            advanced: false,
        };
    }

    if (!providerResult) {
        logger.debug('Provider returned no data', {
            provider: provider.id,
            artistId: input.artistId,
            title: input.title,
        });
        // Mark the artist probed so the staleness scan doesn't keep serving
        // this row slice after slice — without this, unmatchable artists
        // stall `drainBacklog` at its no-progress guard. Only called on the
        // null-return path; thrown errors (network/transient) fall through
        // to the caller's catch and stay stale for the next run's retry.
        //
        // `markArtistProbed` returns a boolean — when the DB write itself
        // failed we report `advanced: false` so the drain can see the
        // outage instead of silently burning the soft budget.
        const probeLanded = await markArtistProbed(
            sql,
            input.artistId,
            provider.id,
            'provider-returned-null',
        );
        if (!probeLanded) {
            logger.warn('Failed to mark artist probed; will retry next run', {
                provider: provider.id,
                artistId: input.artistId,
            });
        }
        return {
            fetched: false,
            matchedTracks: 0,
            unmatchedProviderTracks: 0,
            artistScore: null,
            advanced: probeLanded,
        };
    }

    // 3. Match provider tracks to library tracks
    const { matched, unmatchedProviderTracks } = matchTracks(
        libraryTracks,
        providerResult.topTracks,
    );

    // 4. Normalize track scores using provider-reported listener counts
    const providerScoreInputs = providerResult.topTracks.map((t) => ({
        listeners: t.rawListeners ?? 0,
        playcount: t.rawPlaycount ?? 0,
    }));
    const normalizedTrackScores = normalizeTrackScores(providerScoreInputs);

    // Build a lookup: providerTrack (identity) → its normalized score.
    // We rely on array-index alignment since normalizeTrackScores preserves order.
    const providerTrackToScore = new Map<number, number>();
    providerResult.topTracks.forEach((_track, idx) => {
        providerTrackToScore.set(idx, normalizedTrackScores[idx] ?? 0);
    });

    // 5+6. Persist track + artist rows atomically (TASK-H25).
    //
    // The delete + per-track upserts + artist upsert must commit as one unit.
    // Without a transaction, a crash (or an upsert constraint error) after the
    // delete but before the re-inserts complete leaves this artist with the
    // old track rows wiped, a partial set of new track rows, and the artist
    // row's `fetched_at` unrefreshed — i.e. the row stays stale (re-fetched
    // next run, re-deleting whatever partial set landed) while the track
    // popularity data is corrupt in the meantime. Wrapping in withTx makes the
    // whole replace indivisible: either the artist's full popularity snapshot
    // is replaced, or nothing changes and the row is retried intact.
    const artistListeners = providerResult.artist.rawListeners ?? 0;
    const artistScore = normalizeArtistScore(artistListeners, ARTIST_LISTENER_CEILING);

    let persistedMatches = 0;
    await withTx(sql, async (tx: postgres.Sql) => {
        await deleteTrackPopularityForArtist(tx, input.artistId, provider.id);

        persistedMatches = 0;
        for (const [libraryTrackId, providerTrack] of matched) {
            const providerIdx = providerResult.topTracks.indexOf(providerTrack);
            const normalizedScore = providerTrackToScore.get(providerIdx) ?? 0;

            await upsertTrackPopularity(tx, {
                trackId: libraryTrackId,
                source: provider.id,
                rank: providerTrack.rank,
                rawListeners: providerTrack.rawListeners ?? null,
                rawPlaycount: providerTrack.rawPlaycount ?? null,
                normalizedScore,
                providerUrl: providerTrack.providerUrl,
            });
            persistedMatches++;
        }

        const artistRawMeta: Record<string, unknown> = {
            ...(providerResult.artist.rawMetadata ?? {}),
            unmatched_provider_tracks: unmatchedProviderTracks,
            provider_track_count: providerResult.topTracks.length,
            library_track_count: libraryTracks.length,
            matched_count: persistedMatches,
        };

        await upsertArtistPopularity(tx, {
            artistId: input.artistId,
            source: provider.id,
            rawListeners: providerResult.artist.rawListeners ?? null,
            rawPlaycount: providerResult.artist.rawPlaycount ?? null,
            normalizedScore: artistScore,
            providerUrl: providerResult.artist.providerUrl,
            rawMetadata: artistRawMeta,
        });
    });

    // A successful upsert path always advances — `upsertArtistPopularity`
    // runs a NOT-NULL-shaped row through ON CONFLICT DO UPDATE, which
    // refreshes `fetched_at` and takes the artist out of the stale window.
    // If any of the writes above throw, the exception propagates out of
    // this function — callers treat that as a non-advancing error.
    return {
        fetched: true,
        matchedTracks: persistedMatches,
        unmatchedProviderTracks: unmatchedProviderTracks.length,
        artistScore,
        advanced: true,
    };
}
