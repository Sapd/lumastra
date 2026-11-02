// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File Rematch Query Module — Bug #3 (rename reconnect-by-hash)
 *
 * When a file is renamed on disk, the native watcher emits `unlink(oldPath)` then
 * `add(newPath)` as a pair. The unlink path deletes the media_files row and
 * — if the linked media_item ends up with zero files — soft-dismisses the
 * item via `cleanupOrphanedMediaItems` → `MediaDeletionService.softDismiss`.
 *
 * Without rematch, the `add` path treats the new file as a fresh ingest:
 * a brand-new media_items row is created and the user's watch state,
 * ratings, playlist memberships, and pipeline coverage rows are stranded
 * on the dismissed item's UUID.
 *
 * `findReclaimableByHash` looks for a recently-dismissed item whose last
 * default file shared the same 64KB head hash (`media_files.file_hash_head`).
 * A match within the 24h window means the user almost certainly renamed
 * rather than re-encoded the file — the dismissed item is the same content,
 * so reattach the new file to the original media_item and un-dismiss.
 *
 * The 64KB head hash is the same hash maintained by
 * `change-detection.ts` for content-changed detection — re-encodes change
 * the container header so this hash is stable across pure renames but
 * differs across re-encodes.
 *
 * Returning the candidate is read-only; the caller (video-processor or
 * audio-processor) is responsible for performing the reattach in its own
 * transaction. The candidate includes its kind, episode numbers and movie/series
 * provider IDs so callers can reject a move or rename that changes its identity.
 */

import type postgres from 'postgres';

export interface ReclaimCandidate {
    media_item_id: string;
    media_type: string;
    season_number: number | null;
    episode_number: number | null;
    series_id: string | null;
    external_ids: { provider: string; external_id: string }[];
    dismissed_at: Date | null;
    dismissed_content_hash: string | null;
}

/**
 * Find a soft-dismissed media_item whose previously-linked file shared the
 * given 64KB-head content hash and was dismissed within the past
 * `withinHours` hours, or an eligible reclaim pinned by scan deferral.
 *
 * Returns the most recently dismissed candidate, or null when no eligible
 * item exists.
 *
 * Constraints applied:
 *   - `media_items.is_dismissed = true` — only consider dormant items.
 *   - `media_items.dismissed_at IS NOT NULL AND > now() - interval` —
 *     legacy dismissals (pre-16.3.0) have NULL dismissed_at and are
 *     deliberately excluded. An already eligible candidate pinned to the
 *     same hash by a deferred scan remains eligible for up to three deferrals.
 *   - `media_items.dismissed_content_hash = :contentHash` — the content
 *     fingerprint snapshot taken at soft-dismiss time.
 *
 * Why the hash is snapshotted on `media_items` rather than read live from
 * `media_files`: by the time the native watcher `add` event fires for the
 * renamed file, `deleteStaleMediaFile` has already CASCADE-dropped the old
 * media_files row (and its media_file_items junction). The item-side
 * snapshot, written by `MediaDeletionService.softDismiss`, is the only
 * surviving copy of the original fingerprint at reclaim time.
 */
export async function findReclaimableByHash(
    sql: postgres.Sql,
    contentHash: string,
    withinHours: number = 24,
): Promise<ReclaimCandidate | null> {
    const rows = await sql<ReclaimCandidate[]>`
        SELECT mi.id::text                  AS media_item_id,
               mi.dismissed_at              AS dismissed_at,
               mi.dismissed_content_hash    AS dismissed_content_hash,
               mi.media_type,
               COALESCE(mi.season_number,
                   CASE WHEN parent.media_type = 'season' THEN parent.season_number END
               ) AS season_number,
               mi.episode_number,
               CASE WHEN mi.media_type = 'episode' THEN
                   CASE WHEN parent.media_type = 'season' THEN parent.parent_id
                        ELSE mi.parent_id END
               END::text AS series_id,
               COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                       'provider', ei.provider, 'external_id', ei.external_id
                   ))
                     FROM external_ids ei
                    WHERE ei.media_id = CASE
                        WHEN mi.media_type = 'episode' THEN
                            CASE WHEN parent.media_type = 'season' THEN parent.parent_id
                                 ELSE mi.parent_id END
                        ELSE mi.id
                    END
                      AND ei.provider IN ('tmdb', 'imdb')
               ), '[]'::jsonb) AS external_ids
          FROM media_items mi
          LEFT JOIN media_items parent ON mi.media_type = 'episode' AND parent.id = mi.parent_id
         WHERE mi.dismissed_at IS NOT NULL
           AND (mi.dismissed_at > now() - make_interval(secs => ${withinHours * 3600})
                OR mi.processing_state->>'hash-reclaim-deferred' = mi.dismissed_content_hash
                OR mi.processing_state #>> '{hash-reclaim-deferred,hash}' = mi.dismissed_content_hash)
           AND mi.dismissed_content_hash = ${contentHash}
           AND mi.processing_state->>'hash-reclaim-refused' IS DISTINCT FROM mi.dismissed_content_hash
           AND (mi.is_dismissed = true OR mi.status = 'deleted')
         ORDER BY mi.dismissed_at DESC
         LIMIT 1
    `;
    return rows[0] ?? null;
}

/** Pin an already eligible hash candidate for at most three scan attempts.
 * Scan cadence is configurable, so count attempts rather than elapsed days.
 * The fourth attempt clears the pin and must fall through to normal matching.
 * Legacy string pins start with a fresh bounded budget. The hash
 * comparison prevents an old deferral from extending a different dismissal;
 * undismiss clears it on success. Keep the original dismissal time intact. */
export async function deferHashReclaim(
    sql: postgres.Sql,
    mediaItemId: string,
    contentHash: string,
): Promise<boolean> {
    const [row] = await sql<{ deferred: boolean }[]>`
        UPDATE media_items
           SET processing_state = CASE
               WHEN processing_state #>> '{hash-reclaim-deferred,hash}' = ${contentHash}
                    AND (processing_state #>> '{hash-reclaim-deferred,attempts}')::int >= 3
               THEN (processing_state - 'hash-reclaim-deferred')
                   || jsonb_build_object('hash-reclaim-refused', ${contentHash}::text)
               ELSE COALESCE(processing_state, '{}'::jsonb) || jsonb_build_object(
                   'hash-reclaim-deferred', jsonb_build_object(
                       'hash', ${contentHash}::text,
                       'attempts', CASE
                           WHEN processing_state #>> '{hash-reclaim-deferred,hash}' = ${contentHash}
                           THEN (processing_state #>> '{hash-reclaim-deferred,attempts}')::int + 1
                           ELSE 1 END)) END
         WHERE id = ${mediaItemId}::uuid
           AND dismissed_content_hash = ${contentHash}
           AND processing_state->>'hash-reclaim-refused' IS DISTINCT FROM dismissed_content_hash
           AND (is_dismissed OR status = 'deleted')
        RETURNING processing_state ? 'hash-reclaim-deferred' AS deferred
    `;
    return row?.deferred ?? false;
}

/** Clear the pin and remember refusal for this dismissal. If normal matching
 * also skips the file, the next scan must not start a new deferral budget. */
export async function clearHashReclaimDeferral(
    sql: postgres.Sql,
    mediaItemId: string,
    contentHash: string,
): Promise<void> {
    await sql`
        UPDATE media_items SET processing_state =
            (COALESCE(processing_state, '{}'::jsonb) - 'hash-reclaim-deferred')
            || jsonb_build_object('hash-reclaim-refused', ${contentHash}::text)
        WHERE id = ${mediaItemId}::uuid AND dismissed_content_hash = ${contentHash}
          AND (is_dismissed OR status = 'deleted')
    `;
}

export interface LiveHashMatch {
    media_item_id: string;
}

/**
 * Order-independent rename reclaim for NON-PROVIDER media (rename-race fix #4).
 *
 * `findReclaimableByHash` only works in the unlink-before-add ordering: it
 * matches the `dismissed_content_hash` snapshot that `softDismiss` stamps.
 * When the native watcher (or the full scan) processes the `add(newPath)` BEFORE the
 * `unlink(oldPath)` commits, the old item is still `status='active'` /
 * `is_dismissed=false` and carries no snapshot — so for media without an
 * external-id safety net (music tracks, personal/non-entertainment video) a
 * brand-new UUID would be minted and the user's ratings/history stranded.
 *
 * This lookup closes that window by matching the still-LIVE `media_files`
 * row's 64KB head hash (populated at ingest since fix #5). Scoping rules:
 *
 *   - `status='active'` only — dismissed/deleted rows are the other
 *     (`findReclaimableByHash`) path's job.
 *   - `NOT EXISTS external_ids` — provider-matched movies/TV are NEVER
 *     hash-merged; their external-id net already dedupes renames.
 *   - exactly ONE linked file — the rename shape. A byte-head-identical
 *     COPY of a multi-file item stays a distinct new item; without this
 *     guard a copy would silently attach as a second file. (A copy of a
 *     single-file item does attach as a 2nd file — accepted trade-off,
 *     bounded to exactly that shape.)
 */
export async function findActiveItemByLiveHeadHash(
    sql: postgres.Sql,
    contentHash: string,
    mediaTypes: string[],
): Promise<LiveHashMatch | null> {
    // Fetch up to TWO distinct candidates so we can detect ambiguity. If two
    // different active single-file items share the same 64KB head hash (short
    // files, templated intros, duplicate rips), there is no reliable signal for
    // which one the renamed file belongs to — `is_default` can't disambiguate
    // (every single-file candidate is default). Guessing risks merging the
    // file's future plays/ratings onto the WRONG item and orphaning the correct
    // one. So we refuse (return null) on ambiguity and let the caller mint a
    // fresh item — the conservative posture, matching the multi-file case.
    const rows = await sql<LiveHashMatch[]>`
        SELECT mi.id::text AS media_item_id
          FROM media_items mi
          JOIN media_file_items mfi ON mfi.media_item_id = mi.id
          JOIN media_files      mf  ON mf.id = mfi.file_id
         WHERE mi.status     = 'active'
           AND mi.media_type = ANY(${mediaTypes})
           AND mf.file_hash_head = ${contentHash}
           AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
           AND (SELECT count(*) FROM media_file_items x WHERE x.media_item_id = mi.id) = 1
         GROUP BY mi.id
         LIMIT 2
    `;
    if (rows.length !== 1) return null; // 0 = no match; >1 = ambiguous → refuse
    return rows[0];
}

/**
 * Un-dismiss a media_items row that has just had a new file reattached.
 * Idempotent — calling this on an already-undismissed row is a no-op (the
 * WHERE clause filters it out).
 *
 * Clears `dismissed_at` so subsequent reclaim lookups for unrelated content
 * hashes do not see this row as a candidate.
 */
export async function undismissMediaItem(sql: postgres.Sql, mediaItemId: string): Promise<void> {
    await sql`
        UPDATE media_items
           SET is_dismissed = false,
               dismissed_at = NULL,
               dismissed_content_hash = NULL,
               processing_state = processing_state - 'hash-reclaim-deferred' - 'hash-reclaim-refused',
               status = 'active',
               updated_at = NOW()
         WHERE id = ${mediaItemId}
           AND (is_dismissed = true OR status = 'deleted'
                OR processing_state ?| array['hash-reclaim-deferred', 'hash-reclaim-refused'])
    `;
}

export interface PersonalSeriesOfEpisode {
    id: string;
    title: string;
    metadata_locked: boolean;
}

/**
 * The provider-less series an episode belongs to (through its season, or
 * directly), while that series is active. Null for a matched series (any
 * external_ids row): a provider id already finds it after a rename.
 */
export async function findPersonalSeriesOfEpisode(
    sql: postgres.Sql,
    episodeId: string,
    seriesMediaType: string,
): Promise<PersonalSeriesOfEpisode | null> {
    const [row] = await sql<PersonalSeriesOfEpisode[]>`
        SELECT s.id::text AS id, s.title, s.metadata_locked
          FROM media_items e
          JOIN media_items p ON p.id = e.parent_id
          JOIN media_items s ON s.id = CASE WHEN p.media_type = 'season' THEN p.parent_id ELSE p.id END
         WHERE e.id = ${episodeId}
           AND e.media_type = 'episode'
           AND s.media_type = ${seriesMediaType}
           AND s.parent_id IS NULL
           AND s.status = 'active'
           AND NOT s.is_dismissed
           AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = s.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
    `;
    return row ?? null;
}

/** Files linked to series episodes (directly or through a season). An optional
 * range bounds presence checks to the episodes whose links are being decided. */
export async function listSeriesFilePaths(
    sql: postgres.Sql,
    seriesId: string,
    episodeRange?: { season: number; start: number; end: number },
): Promise<string[]> {
    const rows = await sql<{ file_path: string }[]>`
        SELECT DISTINCT mf.file_path
          FROM media_items e
          JOIN media_file_items mfi ON mfi.media_item_id = e.id
          JOIN media_files mf ON mf.id = mfi.file_id
         WHERE e.media_type = 'episode'
           AND (
               e.parent_id = ${seriesId}
               OR e.parent_id IN (
                   SELECT id FROM media_items WHERE parent_id = ${seriesId} AND media_type = 'season'
               )
           )
           ${
               episodeRange
                   ? sql`
               AND e.parent_id IN (
                   SELECT id FROM media_items
                   WHERE parent_id = ${seriesId} AND media_type = 'season'
                     AND season_number = ${episodeRange.season}
               )
               AND e.episode_number BETWEEN ${episodeRange.start} AND ${episodeRange.end}
           `
                   : sql``
           }
         ORDER BY mf.file_path
    `;
    return rows.map((r) => r.file_path);
}

export interface TrackWithFiles {
    id: string;
    file_paths: string[];
}

/**
 * Active tracks of an album with this title, track number and disc number that
 * still have files, with those files' paths. The replace counterpart of
 * `findAdoptableOrphanTrack` (audio-processor), which only sees tracks with no
 * file at all: a full scan meets the new file (song.flac) while the old one
 * (song.mp3) is still linked, because it retires vanished files last. Same
 * text comparison of the disc number, for the reason given there.
 */
export async function findTracksWithFilesByIdentity(
    sql: postgres.Sql,
    params: {
        albumId: string;
        title: string;
        trackNumber: number | null;
        discNumber: number | null;
    },
): Promise<TrackWithFiles[]> {
    return sql<TrackWithFiles[]>`
        SELECT mi.id::text AS id, array_agg(mf.file_path ORDER BY mf.file_path) AS file_paths
          FROM media_items mi
          JOIN media_file_items mfi ON mfi.media_item_id = mi.id
          JOIN media_files mf ON mf.id = mfi.file_id
         WHERE mi.media_type = 'track'
           AND mi.parent_id = ${params.albumId}
           AND mi.title = ${params.title}
           AND mi.sort_order IS NOT DISTINCT FROM ${params.trackNumber}
           AND mi.custom_metadata ->> 'disc_number' IS NOT DISTINCT FROM ${
               params.discNumber === null ? null : String(params.discNumber)
           }
           AND mi.status = 'active'
           AND NOT mi.is_dismissed
         GROUP BY mi.id
         ORDER BY mi.id
         LIMIT 10
    `;
}

/** Preserve a completed source locator before a detach or an add-before-unlink
 * reconnect. The manifest remains the authority for sampled content/settings proof.
 * Kept on the item because file/params rows cascade on unlink. Caller holds the
 * per-item attach/delete lock; no filesystem effects belong in this query. */
export async function snapshotTrickplayForReclaim(
    sql: postgres.Sql,
    scope: { mediaItemId?: string; excludeFileId?: string; filePath?: string; notNewerThan?: Date },
): Promise<void> {
    await sql`
        UPDATE media_items mi
           SET processing_state = COALESCE(mi.processing_state, '{}'::jsonb) ||
               jsonb_build_object('trickplay-reclaim', jsonb_build_object(
                   'fileId', mf.id, 'filePath', mf.file_path,
                   'headHash', mf.file_hash_head, 'mediaType', mi.media_type,
                   'processingVersion', ss.processing_version,
                   'capturedAtMs', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
               ))
          FROM media_file_items mfi
          JOIN media_files mf ON mf.id = mfi.file_id
          JOIN media_item_stage_state ss ON ss.media_item_id = mfi.media_item_id
               AND ss.stage_id = 'trickplay-generation' AND ss.status = 'completed'
         WHERE mi.id = mfi.media_item_id AND mfi.is_default
           AND mf.file_hash_head IS NOT NULL
           ${scope.mediaItemId ? sql`AND mi.id = ${scope.mediaItemId}::uuid` : sql``}
           ${scope.excludeFileId ? sql`AND mf.id <> ${scope.excludeFileId}::uuid` : sql``}
           ${scope.filePath ? sql`AND mf.file_path = ${scope.filePath}` : sql``}
           ${scope.notNewerThan ? sql`AND mf.updated_at <= ${scope.notNewerThan}` : sql``}
    `;
}

export interface TrickplayReclaimSource {
    file_id: string;
    file_path: string;
    file_hash_head: string | null;
    media_type: string;
    stage_updated_at: string;
    snapshot: {
        fileId: string;
        filePath: string;
        headHash: string;
        mediaType: string;
        processingVersion: number;
        capturedAtMs?: number;
    } | null;
}

/** Source candidates after the reclaim transaction commits. */
export async function getTrickplayReclaimSources(
    sql: postgres.Sql,
    mediaItemId: string,
    processingVersion: number,
): Promise<TrickplayReclaimSource[]> {
    return sql<TrickplayReclaimSource[]>`
        SELECT mf.id::text AS file_id, mf.file_path, mf.file_hash_head, mi.media_type,
               mi.processing_state->'trickplay-reclaim' AS snapshot,
               (SELECT ss.updated_at::text FROM media_item_stage_state ss
                 WHERE ss.media_item_id = mi.id AND ss.stage_id = 'trickplay-generation') AS stage_updated_at
          FROM media_items mi
          JOIN media_file_items mfi ON mfi.media_item_id = mi.id
          JOIN media_files mf ON mf.id = mfi.file_id
         WHERE mi.id = ${mediaItemId}::uuid AND NOT mf.is_missing
           AND mi.has_files = true
           AND mi.status = 'active' AND NOT mi.is_dismissed
           AND mi.media_type IN ('movie', 'episode')
           AND mi.processing_state->'trickplay-reclaim' IS NOT NULL
           AND EXISTS (SELECT 1 FROM media_item_stage_state ss
               WHERE ss.media_item_id = mi.id AND ss.stage_id = 'trickplay-generation'
                 AND ss.processing_version = ${processingVersion}
                 AND ss.status IN ('pending', 'running') AND ss.skipped_reason IS NULL
                 AND (ss.status = 'pending' OR ss.completed_at IS NULL
                      OR ss.invalidated_at > ss.completed_at
                      -- Pending invalidation preserves completed_at and clears
                      -- invalidated_at. The worker then claims it as running.
                      -- Current-file params distinguish a covered replay from a
                      -- new file UUID that still needs its old output adopted.
                      OR NOT EXISTS (SELECT 1 FROM trickplay_params tp
                          WHERE tp.media_item_id = mi.id AND tp.file_id = mf.id)))
           AND NOT EXISTS (
               SELECT 1 FROM media_file_items x JOIN media_files f ON f.id = x.file_id
                WHERE x.media_item_id = mi.id AND NOT f.is_missing
                  AND NOT EXISTS (SELECT 1 FROM media_streams ms WHERE ms.file_id = f.id AND ms.stream_type = 'video')
           )
           -- During add-before-unlink the snapshotted old link still exists.
           -- Its output already qualified at snapshot time; judge the new link.
           AND (mf.id::text IS DISTINCT FROM mi.processing_state->'trickplay-reclaim'->>'fileId'
                OR (SELECT count(*) FROM media_file_items x WHERE x.media_item_id = mi.id) = 1)
         ORDER BY mf.id
    `;
}

/** Short DB-only publication lock, acquired after worker filesystem work. */
export async function lockTrickplayReclaimItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<void> {
    // Attach/delete take this advisory lock before touching FK children or the
    // ancestor chain. Publication changes only this item, so no ancestor locks
    // are needed. NO KEY UPDATE remains compatible with child-insert KEY SHARE.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${mediaItemId}))`;
    await sql`SELECT id FROM media_items WHERE id = ${mediaItemId}::uuid FOR NO KEY UPDATE`;
    await sql`SELECT stage_id FROM media_item_stage_state
               WHERE media_item_id = ${mediaItemId}::uuid AND stage_id = 'trickplay-generation' FOR UPDATE`;
}

/** Compare-and-clear cannot erase a newer reclaim snapshot. */
export async function clearTrickplayReclaimSnapshot(
    sql: postgres.Sql,
    mediaItemId: string,
    snapshot?: NonNullable<TrickplayReclaimSource['snapshot']>,
): Promise<void> {
    await sql`
        UPDATE media_items SET processing_state = processing_state - 'trickplay-reclaim'
         WHERE id = ${mediaItemId}::uuid AND processing_state ? 'trickplay-reclaim'
           ${snapshot ? sql`AND processing_state->'trickplay-reclaim' = ${sql.json(snapshot)}` : sql``}
    `;
}

/** Lazily expire old/undated locators and stages that can no longer consume one. */
export async function expireTrickplayReclaimSnapshot(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<void> {
    await sql`
        UPDATE media_items mi SET processing_state = processing_state - 'trickplay-reclaim'
         WHERE mi.id = ${mediaItemId}::uuid AND processing_state ? 'trickplay-reclaim'
           AND (
               CASE WHEN jsonb_typeof(processing_state->'trickplay-reclaim'->'capturedAtMs') = 'number'
                    THEN (processing_state->'trickplay-reclaim'->>'capturedAtMs')::numeric
                         < extract(epoch FROM clock_timestamp() - interval '7 days') * 1000
                    ELSE true END
               OR NOT EXISTS (SELECT 1 FROM media_item_stage_state ss
                   WHERE ss.media_item_id = mi.id AND ss.stage_id = 'trickplay-generation'
                     AND ss.status IN ('pending', 'running') AND ss.skipped_reason IS NULL)
           )
    `;
}
