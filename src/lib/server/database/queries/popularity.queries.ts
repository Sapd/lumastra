// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Popularity Query Module
 *
 * Pure SQL queries for reading and writing media_popularity rows.
 * All functions take sql: postgres.Sql as first parameter, no side effects.
 *
 * Popularity is keyed by (media_id, source). A row's score_context
 * distinguishes artist-level stats from per-track rankings.
 *
 * @module queries/popularity
 */

import type postgres from 'postgres';
import type { PopularitySource } from '../../services/popularity/types.js';

// Default batch size for the chunked wipe loop. Callers may override per-run.
export const DEFAULT_WIPE_BATCH_SIZE = 500;

// =============================================================================
// Types
// =============================================================================

export interface StaleArtistRow {
    artistId: string;
    title: string;
    mbid: string | null;
    lastFetchedAt: Date | null;
}

export interface ArtistLibraryTrackRow {
    id: string;
    title: string;
    mbid: string | null;
}

export interface ArtistPopularityReadout {
    listeners: number | null;
    playcount: number | null;
    score: number;
    providerUrl: string | null;
    fetchedAt: Date;
    rawMetadata: Record<string, unknown> | null;
}

export interface TrackPopularityReadout {
    trackId: string;
    rank: number;
    listeners: number | null;
    playcount: number | null;
    score: number;
    providerUrl: string | null;
}

export interface PopularityCoverageStats {
    source: PopularitySource;
    artistsFetched: number;
    artistsTotal: number;
    tracksMatched: number;
    tracksTotal: number;
    oldestFetchedAt: Date | null;
    tableSizeBytes: number;
}

export interface PopularityBacklogCounts {
    /** Artists with a popularity row fresher than the staleness threshold. */
    analyzed: number;
    /** Artists with no row, or a row older than the staleness threshold. */
    remaining: number;
}

// =============================================================================
// Upsert
// =============================================================================

/**
 * Upserts an artist-level popularity row for the given source.
 * Sets score_context='artist_global' and clears rank_in_artist.
 * Always refreshes fetched_at to NOW().
 */
export async function upsertArtistPopularity(
    sql: postgres.Sql,
    input: {
        artistId: string;
        source: PopularitySource;
        rawListeners: number | null;
        rawPlaycount: number | null;
        normalizedScore: number;
        providerUrl: string;
        rawMetadata?: Record<string, unknown>;
    },
): Promise<void> {
    await sql`
        INSERT INTO media_popularity (
            media_id,
            source,
            score_context,
            raw_listeners,
            raw_playcount,
            normalized_score,
            rank_in_artist,
            provider_url,
            raw_metadata,
            fetched_at
        ) VALUES (
            ${input.artistId},
            ${input.source},
            'artist_global',
            ${input.rawListeners},
            ${input.rawPlaycount},
            ${input.normalizedScore},
            NULL,
            ${input.providerUrl},
            ${input.rawMetadata ? sql.json(input.rawMetadata as Record<string, never>) : null},
            NOW()
        )
        ON CONFLICT (media_id, source) DO UPDATE SET
            score_context      = 'artist_global',
            raw_listeners      = EXCLUDED.raw_listeners,
            raw_playcount      = EXCLUDED.raw_playcount,
            normalized_score   = EXCLUDED.normalized_score,
            rank_in_artist     = NULL,
            provider_url       = EXCLUDED.provider_url,
            raw_metadata       = EXCLUDED.raw_metadata,
            fetched_at         = NOW()
    `;
}

/**
 * Upserts a track-level popularity row for the given source.
 * Sets score_context='track_in_artist' and stores the track's rank within
 * the artist's top-tracks list.
 * Always refreshes fetched_at to NOW().
 */
export async function upsertTrackPopularity(
    sql: postgres.Sql,
    input: {
        trackId: string;
        source: PopularitySource;
        rank: number;
        rawListeners: number | null;
        rawPlaycount: number | null;
        normalizedScore: number;
        providerUrl: string;
    },
): Promise<void> {
    await sql`
        INSERT INTO media_popularity (
            media_id,
            source,
            score_context,
            raw_listeners,
            raw_playcount,
            normalized_score,
            rank_in_artist,
            provider_url,
            raw_metadata,
            fetched_at
        ) VALUES (
            ${input.trackId},
            ${input.source},
            'track_in_artist',
            ${input.rawListeners},
            ${input.rawPlaycount},
            ${input.normalizedScore},
            ${input.rank},
            ${input.providerUrl},
            NULL,
            NOW()
        )
        ON CONFLICT (media_id, source) DO UPDATE SET
            score_context      = 'track_in_artist',
            raw_listeners      = EXCLUDED.raw_listeners,
            raw_playcount      = EXCLUDED.raw_playcount,
            normalized_score   = EXCLUDED.normalized_score,
            rank_in_artist     = EXCLUDED.rank_in_artist,
            provider_url       = EXCLUDED.provider_url,
            fetched_at         = NOW()
    `;
}

/**
 * Record that we attempted to fetch popularity for an artist but the provider
 * returned no data (artist name/MBID was unknown to the provider).
 *
 * Why this matters: without a probe marker, unmatchable artists stay
 * `fetched_at IS NULL` forever. The staleness scan (`getStaleArtists`) keeps
 * returning them slice after slice, causing the drain loop to stall at the
 * 'no-progress' guard instead of draining to empty. After marking, the row's
 * `fetched_at` falls inside the fresh window until the next refresh cycle,
 * then gets retried naturally.
 *
 * Conflict behavior: if a row already exists (real data from a previous
 * successful fetch OR a previous probe), only `fetched_at` is refreshed —
 * existing listeners/playcount/score are preserved. That keeps valid data
 * intact when a provider is transiently missing an entry, while still
 * shifting the artist out of the stale window so the drain can make
 * progress. Distinguishing "probed then real" from "real then probed" is
 * not worth the extra discriminator — the refresh cadence reconciles both.
 */
export async function markArtistProbed(
    sql: postgres.Sql,
    artistId: string,
    source: PopularitySource,
    reason: string,
): Promise<boolean> {
    try {
        await sql`
            INSERT INTO media_popularity (
                media_id,
                source,
                score_context,
                raw_listeners,
                raw_playcount,
                normalized_score,
                rank_in_artist,
                provider_url,
                raw_metadata,
                fetched_at
            ) VALUES (
                ${artistId},
                ${source},
                'artist_global',
                NULL,
                NULL,
                0,
                NULL,
                NULL,
                ${sql.json({ probed: true, reason })},
                NOW()
            )
            ON CONFLICT (media_id, source) DO UPDATE SET
                fetched_at = NOW()
        `;
        return true;
    } catch {
        return false;
    }
}

// =============================================================================
// Deletion
// =============================================================================

/**
 * Deletes all track-level popularity rows for every track that belongs to the
 * given artist (via the two-hop track → album → artist parent_id chain) for
 * the specified source.
 *
 * Only removes rows where score_context='track_in_artist'. Used before
 * re-upserting after a fresh provider fetch so tracks that fell out of the
 * provider's top list don't keep stale scores.
 *
 * Returns the number of rows deleted.
 */
export async function deleteTrackPopularityForArtist(
    sql: postgres.Sql,
    artistId: string,
    source: PopularitySource,
): Promise<number> {
    const result = await sql<[{ count: string }]>`
        DELETE FROM media_popularity mp
        USING media_items track, media_items album
        WHERE mp.media_id    = track.id
          AND track.parent_id = album.id
          AND album.parent_id = ${artistId}
          AND track.media_type = 'track'
          AND mp.source        = ${source}
          AND mp.score_context = 'track_in_artist'
        RETURNING 1
    `;
    return result.length;
}

/**
 * Delete every media_popularity row for a given source, in batches sized to
 * keep per-statement lock windows short. Returns total rows deleted.
 *
 * Called by the sync plugin's force-mode wipe and by the destructive
 * "Re-analyze everything" admin action. Batched because a single-shot DELETE
 * on a large `media_popularity` table (artist rows × track rows per source)
 * can hold row locks long enough to stall concurrent writers (the enrichment
 * plugin or orchestrator).
 */
/**
 * Rebuild the precomputed popular-hits ordering for one source.
 *
 * `music_popularity_rank` is a pure projection of `media_popularity` (see
 * migration 16.238.0): it stores `artist_global * track_in_artist` per track so
 * the quick-picks popular-hits bucket can read an already-ordered list instead
 * of sorting ~13k joined rows per request.
 *
 * Called once at the END of a popularity sync rather than from a row trigger:
 * the sync writes `media_popularity` in bulk, and a per-row trigger would
 * rebuild the whole projection thousands of times per run.
 *
 * Returns the number of projected rows.
 */
export async function rebuildPopularityRank(sql: postgres.Sql, source: string): Promise<number> {
    const [row] = await sql<{ n: string | number }[]>`
        SELECT music_popularity_rank_rebuild(${source}) AS n
    `;
    return Number(row?.n ?? 0);
}

export async function wipePopularityForSource(
    sql: postgres.Sql,
    source: PopularitySource,
    batchSize: number = DEFAULT_WIPE_BATCH_SIZE,
    abortSignal?: AbortSignal,
): Promise<number> {
    // Reject non-positive/non-finite batch sizes: LIMIT 0 deletes nothing
    // every iteration, and `wiped < batchSize` (0 < 0 = false) would never
    // trigger the break — turning the loop into a DoS against the query
    // pool.
    if (!Number.isFinite(batchSize) || batchSize < 1) {
        throw new Error(
            `wipePopularityForSource: batchSize must be a positive integer, got ${batchSize}`,
        );
    }
    let total = 0;
    while (true) {
        // Check abort at the top of each batch so a cancelled force-mode run
        // can exit mid-wipe without draining the remaining cohort — matching
        // the abort contract the other sync plugins' wipes honor.
        if (abortSignal?.aborted) return total;
        const result = await sql`
            WITH victims AS (
                SELECT ctid
                FROM media_popularity
                WHERE source = ${source}
                LIMIT ${batchSize}
            )
            DELETE FROM media_popularity mp
            USING victims v
            WHERE mp.ctid = v.ctid
        `;
        const wiped = result.count ?? 0;
        total += wiped;
        if (wiped < batchSize) break;
    }
    return total;
}

// =============================================================================
// Coverage-table backlog (feature-flag path)
// =============================================================================

/**
 * Return up to `limit` artist IDs from `media_item_stage_state` where the row
 * is in a retriable state for `stageId`. Used when
 * `PIPELINE_COVERAGE_AUTHORITATIVE_STAGES` includes `'music-popularity'` and
 * the coverage table is the authoritative eligibility source instead of the
 * legacy staleness-window predicate.
 *
 * Retriable statuses:
 *   pending          — not yet processed
 *   failed_transient — transient failure, backoff window expired
 *   obsolete         — content changed, needs re-fetch
 *   skipped_transient — transient skip, retry allowed
 *
 * Returns the same `StaleArtistRow` shape as `getStaleArtists` so the
 * processSlice logic is unaffected. `mbid` and `lastFetchedAt` are
 * populated from the JOIN when available.
 */
export async function findPopularityCoverageTableBacklog(
    sql: postgres.Sql,
    stageId: string,
    limit: number,
): Promise<StaleArtistRow[]> {
    const rows = await sql<
        Array<{
            artist_id: string;
            title: string;
            mbid: string | null;
            last_fetched_at: Date | null;
        }>
    >`
        SELECT
            mi.id          AS artist_id,
            mi.title,
            ei.external_id AS mbid,
            mp.fetched_at  AS last_fetched_at
        FROM media_item_stage_state miss
        JOIN media_items mi ON mi.id = miss.media_item_id
        LEFT JOIN media_popularity mp
            ON mp.media_id = mi.id
        LEFT JOIN external_ids ei
            ON ei.media_id   = mi.id
            AND ei.provider  = 'musicbrainz'
            AND ei.media_type = 'artist'
        WHERE miss.stage_id = ${stageId}
          AND miss.status IN ('pending', 'failed_transient', 'obsolete', 'skipped_transient')
          AND (miss.next_eligible_at IS NULL OR miss.next_eligible_at <= now())
          AND mi.media_type = 'artist'
        ORDER BY miss.next_eligible_at ASC NULLS FIRST, miss.updated_at ASC
        LIMIT ${limit}
    `;

    return rows.map((r) => ({
        artistId: r.artist_id,
        title: r.title,
        mbid: r.mbid,
        lastFetchedAt: r.last_fetched_at,
    }));
}

// =============================================================================
// Selection for plugin
// =============================================================================

/**
 * Returns all artist media_items that either have no popularity row for the
 * given source or have a row with fetched_at older than staleBeforeIso.
 *
 * Results are ordered so artists with a MusicBrainz ID come first (preferred
 * for provider matching), then by fetched_at ASC NULLS FIRST so the stalest
 * artists are processed earliest. `mi.id ASC` is the final tiebreaker so
 * artists sharing a fetched_at timestamp (very common on fresh installs
 * where every row is fetched_at IS NULL) come back in a stable order —
 * drainBacklog's no-progress detector signs slices by
 * `count + idOf(first) + idOf(last)` and relies on deterministic ordering.
 *
 * Callers pass staleBeforeIso as an ISO-8601 timestamp string, e.g.:
 *   new Date(Date.now() - 7 * 86400 * 1000).toISOString()
 */
export async function getStaleArtists(
    sql: postgres.Sql,
    source: PopularitySource,
    staleBeforeIso: string,
    limit: number,
): Promise<StaleArtistRow[]> {
    const rows = await sql<
        Array<{
            artist_id: string;
            title: string;
            mbid: string | null;
            last_fetched_at: Date | null;
        }>
    >`
        SELECT
            mi.id          AS artist_id,
            mi.title,
            ei.external_id AS mbid,
            mp.fetched_at  AS last_fetched_at
        FROM media_items mi
        LEFT JOIN media_popularity mp
            ON  mp.media_id = mi.id
            AND mp.source   = ${source}
        LEFT JOIN external_ids ei
            ON  ei.media_id   = mi.id
            AND ei.provider   = 'musicbrainz'
            AND ei.media_type = 'artist'
        WHERE mi.media_type = 'artist'
          AND (mp.fetched_at IS NULL OR mp.fetched_at < ${staleBeforeIso}::timestamptz)
        ORDER BY
            (ei.external_id IS NOT NULL) DESC,
            mp.fetched_at ASC NULLS FIRST,
            mi.id ASC
        LIMIT ${limit}
    `;

    return rows.map((r) => ({
        artistId: r.artist_id,
        title: r.title,
        mbid: r.mbid,
        lastFetchedAt: r.last_fetched_at,
    }));
}

/**
 * Returns {analyzed, remaining} where `analyzed` is the count of artists
 * whose popularity row for the given source is fresher than
 * `staleBeforeIso`, and `remaining` is the count of artists either missing
 * a row or with one older than the threshold.
 *
 * The predicate matches `getStaleArtists` 1:1 so the admin progress card
 * and the drain loop agree on what "remaining" means. Pass the same
 * `staleBeforeIso` to both for consistency.
 *
 * Note: totals are over `media_items WHERE media_type = 'artist'` — a
 * probed-null row (see `markArtistProbed`) counts as `analyzed` because
 * the artist was looked at within the refresh window, even though the
 * provider had no data.
 */
export async function countPopularityBacklog(
    sql: postgres.Sql,
    source: PopularitySource,
    staleBeforeIso: string,
): Promise<PopularityBacklogCounts> {
    const [row] = await sql<Array<{ analyzed: number; remaining: number }>>`
        SELECT
            COUNT(*) FILTER (
                WHERE mp.fetched_at IS NOT NULL
                  AND mp.fetched_at >= ${staleBeforeIso}::timestamptz
            )::int AS analyzed,
            COUNT(*) FILTER (
                WHERE mp.fetched_at IS NULL
                  OR mp.fetched_at < ${staleBeforeIso}::timestamptz
            )::int AS remaining
        FROM media_items mi
        LEFT JOIN media_popularity mp
            ON  mp.media_id = mi.id
            AND mp.source   = ${source}
        WHERE mi.media_type = 'artist'
    `;
    return {
        analyzed: row?.analyzed ?? 0,
        remaining: row?.remaining ?? 0,
    };
}

/**
 * Returns the total number of artist-type media_items. Used by the backlog
 * card when no popularity provider is configured — surfaces the library-
 * wide sizing signal so the admin UI can show "X artists awaiting a
 * configured provider" instead of a misleading "0 of 0".
 */
export async function countTotalArtists(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<Array<{ total: number }>>`
        SELECT COUNT(*)::int AS total
        FROM media_items
        WHERE media_type = 'artist'
    `;
    return row?.total ?? 0;
}

// =============================================================================
// Loading library tracks for an artist
// =============================================================================

/**
 * Returns all tracks in the library that belong to the given artist, resolved
 * via the two-hop track → album → artist parent_id chain.
 *
 * Each row includes the track's MusicBrainz recording ID when available,
 * preferring custom_metadata.recording_mbid over external_ids, so the
 * popularity orchestrator can match provider top-tracks against our library.
 */
export async function getLibraryTracksForArtist(
    sql: postgres.Sql,
    artistId: string,
): Promise<ArtistLibraryTrackRow[]> {
    const rows = await sql<
        Array<{
            id: string;
            title: string;
            mbid: string | null;
        }>
    >`
        SELECT
            track.id,
            track.title,
            COALESCE(
                (track.custom_metadata->>'recording_mbid'),
                ei.external_id
            ) AS mbid
        FROM media_items track
        JOIN media_items album ON album.id = track.parent_id
        LEFT JOIN external_ids ei
            ON  ei.media_id   = track.id
            AND ei.provider   = 'musicbrainz'
            AND ei.media_type = 'track'
        WHERE album.parent_id  = ${artistId}
          AND track.media_type = 'track'
        ORDER BY track.title
    `;

    return rows.map((r) => ({
        id: r.id,
        title: r.title,
        mbid: r.mbid,
    }));
}

// =============================================================================
// Reading popularity for a single artist
// =============================================================================

/**
 * Returns the artist-level popularity row for the given source, or null if the
 * artist has never been fetched for this source.
 */
export async function getArtistPopularity(
    sql: postgres.Sql,
    artistId: string,
    source: PopularitySource,
): Promise<ArtistPopularityReadout | null> {
    const rows = await sql<
        Array<{
            raw_listeners: string | null;
            raw_playcount: string | null;
            normalized_score: number;
            provider_url: string | null;
            fetched_at: Date;
            raw_metadata: Record<string, unknown> | null;
        }>
    >`
        SELECT
            raw_listeners,
            raw_playcount,
            normalized_score,
            provider_url,
            fetched_at,
            raw_metadata
        FROM media_popularity
        WHERE media_id     = ${artistId}
          AND source       = ${source}
          AND score_context = 'artist_global'
        LIMIT 1
    `;

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
        listeners: row.raw_listeners !== null ? Number(row.raw_listeners) : null,
        playcount: row.raw_playcount !== null ? Number(row.raw_playcount) : null,
        score: row.normalized_score,
        providerUrl: row.provider_url,
        fetchedAt: row.fetched_at,
        rawMetadata: row.raw_metadata,
    };
}

/**
 * Batch-fetch Last.fm lane data (crowd tags + similar-artist names) for a set
 * of artist media_ids, keyed by artist id. Artists with no Last.fm row, or
 * whose row carries neither tags nor similar_artists, are omitted — callers
 * treat absence as "unknown lane" (neutral), never as a mismatch.
 *
 * Feeds the sonic smart queue's lane-affinity re-rank term
 * (music-lane-affinity.ts).
 */
export async function getArtistLaneData(
    sql: postgres.Sql,
    artistIds: string[],
): Promise<Map<string, { tags: string[]; similar: string[] }>> {
    const result = new Map<string, { tags: string[]; similar: string[] }>();
    if (artistIds.length === 0) return result;

    const rows = await sql<
        Array<{
            media_id: string;
            tags: unknown;
            similar: unknown;
        }>
    >`
        SELECT
            media_id::text,
            raw_metadata->'tags'            AS tags,
            raw_metadata->'similar_artists' AS similar
        FROM media_popularity
        WHERE source        = 'lastfm'
          AND score_context = 'artist_global'
          AND media_id      = ANY(${artistIds}::uuid[])
    `;

    const toStringArray = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

    for (const row of rows) {
        const tags = toStringArray(row.tags);
        const similar = toStringArray(row.similar);
        if (tags.length === 0 && similar.length === 0) continue;
        result.set(row.media_id, { tags, similar });
    }
    return result;
}

// =============================================================================
// Reading track popularity for an album
// =============================================================================

/**
 * Returns popularity rows for all tracks in the given album that have a
 * popularity entry for the specified source. Tracks without a row are absent
 * from the result; callers can detect gaps by comparing against the full
 * track list.
 *
 * Results are ordered by rank_in_artist ASC so the most popular track comes
 * first, matching typical UI rendering order.
 */
export async function getTrackPopularityForAlbum(
    sql: postgres.Sql,
    albumId: string,
    source: PopularitySource,
): Promise<TrackPopularityReadout[]> {
    const rows = await sql<
        Array<{
            track_id: string;
            rank: number | null;
            listeners: string | null;
            playcount: string | null;
            score: number;
            provider_url: string | null;
        }>
    >`
        SELECT
            mp.media_id        AS track_id,
            mp.rank_in_artist  AS rank,
            mp.raw_listeners   AS listeners,
            mp.raw_playcount   AS playcount,
            mp.normalized_score AS score,
            mp.provider_url
        FROM media_popularity mp
        JOIN media_items track ON track.id = mp.media_id
        WHERE track.parent_id   = ${albumId}
          AND mp.source         = ${source}
          AND mp.score_context  = 'track_in_artist'
        ORDER BY mp.rank_in_artist ASC NULLS LAST
    `;

    return rows.map((r) => ({
        trackId: r.track_id,
        rank: r.rank ?? 0,
        listeners: r.listeners !== null ? Number(r.listeners) : null,
        playcount: r.playcount !== null ? Number(r.playcount) : null,
        score: r.score,
        providerUrl: r.provider_url,
    }));
}

/**
 * Like getTrackPopularityForAlbum, but two-hop: returns popularity for every
 * track across every album of the given artist. Used by the artist detail
 * endpoint to decorate the full tracklist with ranks/stars.
 */
export async function getTrackPopularityForArtist(
    sql: postgres.Sql,
    artistId: string,
    source: PopularitySource,
): Promise<TrackPopularityReadout[]> {
    const rows = await sql<
        Array<{
            track_id: string;
            rank: number | null;
            listeners: string | null;
            playcount: string | null;
            score: number;
            provider_url: string | null;
        }>
    >`
        SELECT
            mp.media_id        AS track_id,
            mp.rank_in_artist  AS rank,
            mp.raw_listeners   AS listeners,
            mp.raw_playcount   AS playcount,
            mp.normalized_score AS score,
            mp.provider_url
        FROM media_popularity mp
        JOIN media_items track ON track.id = mp.media_id
        JOIN media_items album ON album.id = track.parent_id
        WHERE album.parent_id   = ${artistId}
          AND mp.source         = ${source}
          AND mp.score_context  = 'track_in_artist'
        ORDER BY mp.rank_in_artist ASC NULLS LAST
    `;

    return rows.map((r) => ({
        trackId: r.track_id,
        rank: r.rank ?? 0,
        listeners: r.listeners !== null ? Number(r.listeners) : null,
        playcount: r.playcount !== null ? Number(r.playcount) : null,
        score: r.score,
        providerUrl: r.provider_url,
    }));
}

// =============================================================================
// Coverage stats (admin diagnostics)
// =============================================================================

/**
 * Returns coverage statistics for the given source — how many artists and
 * tracks have been matched, when the oldest row was fetched, and the total
 * on-disk size of the media_popularity table.
 *
 * Intended for admin dashboards and diagnostic endpoints; not called on the
 * hot path.
 */
export async function getPopularityCoverageStats(
    sql: postgres.Sql,
    source: PopularitySource,
): Promise<PopularityCoverageStats> {
    const rows = await sql<
        Array<{
            artists_fetched: string;
            artists_total: string;
            tracks_matched: string;
            tracks_total: string;
            oldest_fetched_at: Date | null;
            table_size_bytes: string;
        }>
    >`
        SELECT
            COUNT(*) FILTER (
                WHERE mp.source = ${source}
                  AND mp.score_context = 'artist_global'
            )::text AS artists_fetched,
            (
                SELECT COUNT(*)::text
                FROM media_items
                WHERE media_type = 'artist'
            ) AS artists_total,
            COUNT(*) FILTER (
                WHERE mp.source = ${source}
                  AND mp.score_context = 'track_in_artist'
            )::text AS tracks_matched,
            (
                SELECT COUNT(*)::text
                FROM media_items
                WHERE media_type = 'track'
            ) AS tracks_total,
            MIN(mp.fetched_at) FILTER (
                WHERE mp.source = ${source}
            ) AS oldest_fetched_at,
            pg_total_relation_size('media_popularity')::text AS table_size_bytes
        FROM media_popularity mp
    `;

    const row = rows[0];
    return {
        source,
        artistsFetched: Number(row.artists_fetched),
        artistsTotal: Number(row.artists_total),
        tracksMatched: Number(row.tracks_matched),
        tracksTotal: Number(row.tracks_total),
        oldestFetchedAt: row.oldest_fetched_at,
        tableSizeBytes: Number(row.table_size_bytes),
    };
}
