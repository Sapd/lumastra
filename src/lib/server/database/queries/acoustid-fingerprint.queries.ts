// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Queries for the `acoustid-fingerprint` stage.
 *
 * Storage (tracks):
 *   custom_metadata.acoustid       — what the fingerprint lookup found
 *                                    ({ recording_mbid, score, ... }).
 *   custom_metadata.recording_mbid — the recording MBID the rest of the app
 *                                    reads. Filled from the match ONLY when it
 *                                    is absent or was itself written by an
 *                                    earlier match. A tag-supplied value is
 *                                    never touched.
 *
 * Albums / artists only ever gain an external id they did not have; nothing
 * existing is overwritten and no file is renamed or moved.
 */

import type postgres from 'postgres';

export const ACOUSTID_STAGE_ID = 'acoustid-fingerprint';

/** Skip reasons — each one is a terminal per-item outcome. */
export const ACOUSTID_SKIP = {
    noMatch: 'acoustid-no-match',
    ambiguous: 'acoustid-ambiguous',
    rejected: 'acoustid-rejected',
    fingerprintFailed: 'fingerprint-failed',
    hasTagMbid: 'recording-mbid-from-tags',
    noKey: 'no-acoustid-key',
    noFpcalc: 'fpcalc-unavailable',
} as const;

/**
 * SQL fragment (alias `mi`): the track already carries a recording MBID that
 * did NOT come from a fingerprint match — i.e. from tags. Such tracks never
 * need a lookup.
 */
export function hasTagRecordingMbidSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(
        COALESCE(mi.custom_metadata->>'recording_mbid', '') <> ''
        AND (mi.custom_metadata->'acoustid'->>'recording_mbid')
            IS DISTINCT FROM (mi.custom_metadata->>'recording_mbid')
    )`;
}

/**
 * SQL fragment: an AcoustID key is configured, either in plugin_secrets (what
 * the admin Settings UI writes) or via the env var (passed in as a boolean,
 * since SQL cannot see process.env).
 */
export function acoustIdKeyConfiguredSql(
    sql: postgres.Sql,
    envKeySet: boolean,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`(
        ${envKeySet ? sql`true` : sql`false`}
        OR EXISTS (
            SELECT 1 FROM plugin_secrets
             WHERE plugin_id = 'musicbrainz-metadata-provider'
               AND key = 'ACOUSTID_API_KEY'
        )
    )`;
}

export interface AcoustIdBacklogRow {
    id: string;
    title: string | null;
    album_id: string | null;
    album_title: string | null;
    file_path: string;
    has_tag_mbid: boolean;
}

/**
 * Next tracks to fingerprint, from the coverage table. Only rows that are
 * due (`next_eligible_at`), active, and have a present file. Ordered so a row
 * that failed transiently goes to the back.
 */
export async function findAcoustIdBacklog(
    sql: postgres.Sql,
    limit: number,
): Promise<AcoustIdBacklogRow[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- background task, no user: reads every track/album by design
    return sql<AcoustIdBacklogRow[]>`
        SELECT mi.id,
               mi.title,
               album.id    AS album_id,
               album.title AS album_title,
               f.file_path,
               ${hasTagRecordingMbidSql(sql)} AS has_tag_mbid
          FROM media_item_stage_state miss
          JOIN media_items mi ON mi.id = miss.media_item_id
          LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
          JOIN LATERAL (
                SELECT mf.file_path
                  FROM media_file_items mfi
                  JOIN media_files mf ON mf.id = mfi.file_id
                 WHERE mfi.media_item_id = mi.id AND NOT mf.is_missing
                 ORDER BY mfi.is_default DESC NULLS LAST, mf.file_path
                 LIMIT 1
          ) f ON true
         WHERE miss.stage_id = ${ACOUSTID_STAGE_ID}
           AND miss.status IN ('pending', 'failed_transient', 'obsolete')
           AND (miss.next_eligible_at IS NULL OR miss.next_eligible_at <= now())
           AND mi.media_type = 'track'
           AND mi.status = 'active'
         ORDER BY miss.attempt ASC, miss.updated_at ASC
         LIMIT ${limit}
    `;
}

/** Number of rows still waiting (any retriable state, due or not). */
export async function countAcoustIdRemaining(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM media_item_stage_state
         WHERE stage_id = ${ACOUSTID_STAGE_ID}
           AND status IN ('pending', 'failed_transient', 'obsolete')
    `;
    return row?.n ?? 0;
}

export interface StoredAcoustIdMatch {
    recording_mbid: string;
    acoustid_id: string;
    score: number;
    recording_title?: string;
    artist_mbids: string[];
    artist_names: string[];
    release_groups: Array<{ id: string; title?: string }>;
    matched_at: string;
}

/**
 * Store a confident match on the track.
 *
 * `custom_metadata.acoustid` is always replaced with the new match.
 * `custom_metadata.recording_mbid` is set only when it is empty or equal to the
 * previous match's MBID (so a re-run can correct its own earlier answer). A
 * tag-supplied MBID wins. Returns whether `recording_mbid` now holds the match.
 */
export async function applyAcoustIdMatch(
    sql: postgres.Sql,
    trackId: string,
    match: StoredAcoustIdMatch,
): Promise<{ recordingMbidSet: boolean }> {
    const [row] = await sql<{ recording_mbid: string | null }[]>`
        UPDATE media_items mi
           SET custom_metadata =
                   COALESCE(mi.custom_metadata, '{}'::jsonb)
                   || jsonb_build_object('acoustid', ${sql.json(match as unknown as postgres.JSONValue)}::jsonb)
                   || CASE
                          WHEN COALESCE(mi.custom_metadata->>'recording_mbid', '') = ''
                            OR (mi.custom_metadata->>'recording_mbid')
                               = (mi.custom_metadata->'acoustid'->>'recording_mbid')
                          THEN jsonb_build_object('recording_mbid', ${match.recording_mbid}::text)
                          ELSE '{}'::jsonb
                      END
         WHERE mi.id = ${trackId}::uuid
        RETURNING mi.custom_metadata->>'recording_mbid' AS recording_mbid
    `;
    return { recordingMbidSet: row?.recording_mbid === match.recording_mbid };
}

/**
 * Drop an earlier fingerprint answer from tracks that no longer match (their
 * file changed). `recording_mbid` goes too, but only where it is that answer —
 * a tag-supplied MBID stays.
 */
export async function clearOwnAcoustIdMatch(sql: postgres.Sql, trackIds: string[]): Promise<void> {
    if (trackIds.length === 0) return;
    await sql`
        UPDATE media_items mi
           SET custom_metadata = CASE
                   WHEN (mi.custom_metadata->>'recording_mbid') = (mi.custom_metadata->'acoustid'->>'recording_mbid')
                   THEN mi.custom_metadata - 'acoustid' - 'recording_mbid'
                   ELSE mi.custom_metadata - 'acoustid'
               END
         WHERE mi.id = ANY(${trackIds}::uuid[])
           AND mi.custom_metadata ? 'acoustid'
    `;
}

/** Record the matched outcome on the coverage row. */
export async function markAcoustIdMatched(
    sql: postgres.Sql,
    trackId: string,
    processingVersion: number,
): Promise<void> {
    await sql`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status, completed_at
        ) VALUES (${trackId}::uuid, ${ACOUSTID_STAGE_ID}, ${processingVersion}, 'completed', now())
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
           SET status = 'completed',
               skipped_reason = NULL,
               completed_at = now(),
               last_error = NULL,
               next_eligible_at = NULL,
               invalidated_at = NULL,
               declines = 0,
               declines_since = NULL,
               processing_version = GREATEST(EXCLUDED.processing_version, media_item_stage_state.processing_version),
               updated_at = now()
    `;
}

/** Record a terminal "won't match" outcome (no-match, ambiguous, rejected, ...). */
export async function markAcoustIdSkipped(
    sql: postgres.Sql,
    trackIds: string[],
    reason: string,
    processingVersion: number,
): Promise<void> {
    if (trackIds.length === 0) return;
    await sql`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status, skipped_reason, completed_at
        )
        SELECT id, ${ACOUSTID_STAGE_ID}, ${processingVersion}, 'skipped_permanent', ${reason}, now()
          FROM unnest(${trackIds}::uuid[]) AS t(id)
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
           SET status = 'skipped_permanent',
               skipped_reason = EXCLUDED.skipped_reason,
               completed_at = now(),
               last_error = NULL,
               next_eligible_at = NULL,
               declines = 0,
               declines_since = NULL,
               processing_version = GREATEST(EXCLUDED.processing_version, media_item_stage_state.processing_version),
               updated_at = now()
         WHERE media_item_stage_state.status <> 'completed'
    `;
}

/**
 * Record a transient failure (outage, throttle, unreadable mount). The row
 * leaves the due backlog for `backoffMs`; after `maxAttempts` it becomes
 * `failed_permanent` so a track that always errors cannot loop forever.
 */
export async function markAcoustIdTransientFailure(
    sql: postgres.Sql,
    trackIds: string[],
    error: { message: string; code: string },
    backoffMs: number,
    maxAttempts: number,
    opts: { countAttempt?: boolean } = {},
): Promise<void> {
    if (trackIds.length === 0) return;
    // countAttempt=false: back off without moving toward failed_permanent (used
    // for upstream outages, which say nothing about the track itself).
    const inc = opts.countAttempt === false ? 0 : 1;
    await sql`
        UPDATE media_item_stage_state
           SET status = CASE WHEN attempt + ${inc} >= ${maxAttempts} THEN 'failed_permanent' ELSE 'failed_transient' END,
               attempt = attempt + ${inc},
               last_error = ${sql.json({ message: error.message.slice(0, 500), code: error.code, retryable: true })},
               next_eligible_at = CASE
                   WHEN attempt + ${inc} >= ${maxAttempts} THEN NULL
                   ELSE now() + make_interval(secs => ${backoffMs} / 1000.0)
               END,
               updated_at = now()
         WHERE stage_id = ${ACOUSTID_STAGE_ID}
           AND media_item_id = ANY(${trackIds}::uuid[])
           AND status IN ('pending', 'failed_transient', 'obsolete', 'running')
    `;
}

// =============================================================================
// Album / artist propagation
// =============================================================================

export interface AlbumMatchEvidence {
    album_id: string;
    album_title: string;
    artist_id: string | null;
    artist_title: string | null;
    track_count: number;
    album_has_rg: boolean;
    artist_has_mbid: boolean;
    album_has_poster: boolean;
    matches: Array<{
        score: number;
        artist_mbids: string[];
        artist_names: string[];
        release_groups: Array<{ id: string; title?: string }>;
    }>;
}

/** Everything needed to decide album/artist MBIDs for the given albums. */
export async function loadAlbumMatchEvidence(
    sql: postgres.Sql,
    albumIds: string[],
): Promise<AlbumMatchEvidence[]> {
    if (albumIds.length === 0) return [];
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- background task, no user: reads every track/album by design
    return sql<AlbumMatchEvidence[]>`
        SELECT album.id    AS album_id,
               album.title AS album_title,
               artist.id    AS artist_id,
               artist.title AS artist_title,
               (SELECT count(*)::int FROM media_items t
                 WHERE t.parent_id = album.id AND t.media_type = 'track') AS track_count,
               EXISTS (SELECT 1 FROM external_ids e
                        WHERE e.media_id = album.id AND e.provider = 'musicbrainz_releasegroup') AS album_has_rg,
               COALESCE(EXISTS (SELECT 1 FROM external_ids e
                        WHERE e.media_id = artist.id AND e.provider = 'musicbrainz'), false) AS artist_has_mbid,
               EXISTS (SELECT 1 FROM image_candidates ma
                        WHERE ma.media_item_id = album.id AND ma.artwork_type = 'poster') AS album_has_poster,
               COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                              'score', (t.custom_metadata->'acoustid'->>'score')::float,
                              'artist_mbids', COALESCE(t.custom_metadata->'acoustid'->'artist_mbids', '[]'::jsonb),
                              'artist_names', COALESCE(t.custom_metadata->'acoustid'->'artist_names', '[]'::jsonb),
                              'release_groups', COALESCE(t.custom_metadata->'acoustid'->'release_groups', '[]'::jsonb)))
                     FROM media_items t
                    WHERE t.parent_id = album.id
                      AND t.media_type = 'track'
                      AND t.custom_metadata ? 'acoustid'
               ), '[]'::jsonb) AS matches
          FROM media_items album
          LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
         WHERE album.id = ANY(${albumIds}::uuid[])
           AND album.media_type = 'album'
    `;
}

/**
 * Insert an external id ONLY if the item has none for that provider. Never
 * overwrites. A collision (the MBID already belongs to another item, e.g. a
 * duplicate album folder) is a silent no-op. Returns whether a row was added.
 */
export async function insertExternalIdIfAbsent(
    sql: postgres.Sql,
    input: {
        mediaId: string;
        provider: 'musicbrainz_releasegroup' | 'musicbrainz';
        externalId: string;
        mediaType: 'album' | 'artist';
        confidence: number;
    },
): Promise<boolean> {
    const rows = await sql<{ id: number }[]>`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, confidence, source)
        SELECT ${input.mediaId}::uuid, ${input.provider}, ${input.externalId}, ${input.mediaType},
               ${Math.max(0, Math.min(1, input.confidence))}, ${ACOUSTID_STAGE_ID}
         WHERE NOT EXISTS (
               SELECT 1 FROM external_ids
                WHERE media_id = ${input.mediaId}::uuid AND provider = ${input.provider})
        ON CONFLICT DO NOTHING
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * An album gained a release-group MBID but still has no poster: re-open its
 * album-enrichment row (both the coverage row and the legacy marker — the
 * admin backlog card reads the marker) so Cover Art Archive gets a try.
 * `skipped_permanent` / `completed` rows are never re-opened by a version
 * bump, so this is the only route.
 */
export async function reopenAlbumEnrichmentForPoster(
    sql: postgres.Sql,
    albumId: string,
): Promise<void> {
    await sql`
        UPDATE media_item_stage_state miss
           SET status = 'pending',
               attempt = 0,
               declines = 0,
               declines_since = NULL,
               last_error = NULL,
               skipped_reason = NULL,
               next_eligible_at = now(),
               started_at = NULL,
               completed_at = NULL,
               updated_at = now()
         WHERE miss.media_item_id = ${albumId}::uuid
           AND miss.stage_id = 'album-enrichment'
           AND miss.status IN ('completed', 'skipped_permanent', 'failed_permanent')
           AND NOT EXISTS (
               SELECT 1 FROM image_candidates ma
                WHERE ma.media_item_id = miss.media_item_id AND ma.artwork_type = 'poster')
    `;
    await sql`
        UPDATE media_items
           SET processing_state = processing_state - 'album-enrichment'
         WHERE id = ${albumId}::uuid
           AND processing_state ? 'album-enrichment'
           AND NOT EXISTS (
               SELECT 1 FROM image_candidates ma
                WHERE ma.media_item_id = ${albumId}::uuid AND ma.artwork_type = 'poster')
    `;
}

/** The album's stored MusicBrainz ids (from any source). */
export async function getStoredAlbumMbids(
    sql: postgres.Sql,
    albumId: string,
): Promise<{ releaseMbid: string | null; releaseGroupMbid: string | null }> {
    const rows = await sql<{ provider: string; external_id: string }[]>`
        SELECT provider, external_id
          FROM external_ids
         WHERE media_id = ${albumId}::uuid
           AND provider IN ('musicbrainz_release', 'musicbrainz_releasegroup')
    `;
    return {
        releaseMbid: rows.find((r) => r.provider === 'musicbrainz_release')?.external_id ?? null,
        releaseGroupMbid:
            rows.find((r) => r.provider === 'musicbrainz_releasegroup')?.external_id ?? null,
    };
}

/** Outcome counts for the admin result + verification. */
export async function getAcoustIdStageCounts(
    sql: postgres.Sql,
): Promise<Array<{ status: string; reason: string | null; n: number }>> {
    return sql<Array<{ status: string; reason: string | null; n: number }>>`
        SELECT status, skipped_reason AS reason, count(*)::int AS n
          FROM media_item_stage_state
         WHERE stage_id = ${ACOUSTID_STAGE_ID}
         GROUP BY 1, 2
         ORDER BY 1, 2
    `;
}
