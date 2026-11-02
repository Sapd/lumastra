// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Media Files Query Module
 *
 * Queries for the media_files and media_file_items tables (migration 11.22.0).
 *
 * media_files  — one row per physical file on disk
 * media_file_items — M:N junction: file ↔ media_item
 *   • One file can contain many episodes (multi-episode file)
 *   • One episode can span many files (split file / Part1+Part2)
 */

import { currentHealthIssueReviewSql } from './file-health-review.queries.js';
import type postgres from 'postgres';
import type * as MediaDeletionModule from '$lib/server/services/media-deletion.service.js';
import { snapshotTrickplayForReclaim } from './file-rematch.queries.js';
import { VARIOUS_ARTISTS_LABEL, isVariousArtistsName } from '$lib/shared/various-artists.js';
import { MANUAL_OFFSET_SOURCE } from '$lib/shared/manual-file-segments.js';
import {
    acquireMediaSegmentResolutionLocks,
    bumpMediaSegmentAnalysisGeneration,
} from '../media-segment-resolution-lock.js';
import { isInOpenTransaction, withTx } from '../with-tx.js';
import { publishMessage, subscribeToChannel } from '../../cache/valkey.js';
import { Logger } from '../../utils/logger.js';
import type { FileHealthIssueType } from '$lib/types/pipeline.js';
import { UNLINKED_FILE_HEALTH_ISSUE_TYPES } from '$lib/types/pipeline.js';
import { actionableFileHealthSql } from './file-health-classification.queries.js';

const ownerCacheLogger = Logger.for('OwnerForFileCache');
const recomputeLogger = Logger.for('RecomputeHasFiles');
const OWNER_CACHE_INVALIDATE_CHANNEL = 'media:owner-cache:invalidate';

/**
 * One recorded problem with a file on disk.
 *
 * The `type` union is single-sourced as {@link FileHealthIssueType} in
 * `$lib/types/pipeline` so the client-side copies (ingest-map types, the
 * validated admin client's Zod enum) cannot drift from it. What each type
 * MEANS is documented below.
 *
 * - `truncated_video`      — last keyframe PTS is <90% of container duration
 * - `no_keyframes`         — probe succeeded but returned zero keyframes
 * - `duration_mismatch`    — file duration disagrees with provider runtime
 * - `tag_parse_timeout`    — `parseFile` (music-metadata) timed out. Without
 *   this signal the scanner falls back to a filename-derived title and
 *   creates a new garbage track row on every scan — observed on preprod with
 *   417 dups of "secal-désenchantée" from a single NFD-encoded FLAC.
 * - `tag_parse_corrupt`    — same, but the tags are unreadable rather than slow
 * - `filename_not_utf8`    — the on-disk filename is not valid UTF-8 (e.g.
 *   Latin-1), so `fs.readdir` hands us a path containing U+FFFD that can never
 *   re-open the real file. Every probe / track-creation / link ENOENTs, so the
 *   scanner refuses it rather than letting the item silently vanish. Applies to
 *   BOTH music and video. Fix is to rename the file to UTF-8.
 * - `container_unreadable` — ffmpeg could not decode a single frame ANYWHERE
 *   in the file (broken EBML header, truncated download, garbage bytes).
 *   Recorded by trickplay generation, usually the first thing to decode a file
 *   end to end, and by the scanner on a NEW file's stub row when ffprobe
 *   rejects its content (with the retry tiers below). `detail` carries the verbatim demuxer error including the byte
 *   offset, e.g. `0x00 at pos 8193 (0x2001) invalid as first byte of an EBML
 *   number`, so an admin can see what is wrong and where without re-running
 *   ffmpeg by hand.
 * - `video_ends_early`     — the container advertises a duration well beyond
 *   the last frame that decodes. Seen on releases whose subtitle/attachment
 *   stream durations drive `format.duration`; one prod file reported 13600s for
 *   a 1360s episode. `expected_duration` is what the container claims,
 *   `actual_duration` the last timestamp that decoded. Playback is usually
 *   fine; seek bars and duration-derived work are not.
 * - `video_decode_gaps`    — a material run of timestamps INSIDE the file
 *   produced no frame while video resumes afterwards: interior corruption
 *   rather than a short tail. `detail` names the affected time range.
 * - `unsafe_filename`      — the on-disk filename contains a C0 control
 *   character (U+0000-U+001F, including a raw `\n`/`\r`) or DEL (U+007F).
 *   Detected via the shared `hasControlChars()` guard also applied at the
 *   upload `init.ts` zod schema and `writeConcatTmpFile` — a filename this
 *   pathological must never reach the ffmpeg concat list writer, which joins
 *   one line per file under `-safe 0`. Applies to BOTH music and video.
 * - `playlist_container_rejected` — ffprobe's `format_name` identified the
 *   file as a playlist/reference-following container (`hls`, `dash`,
 *   `concat`, `imf`) rather than a real media container. No legitimate
 *   library file probes this way. This function still upserts a `media_files`
 *   STUB row for it (see below) — the chokepoint refusing it keeps such a
 *   file from ever getting a `media_item` link, so no playback query can
 *   select it and no downstream ffmpeg/ffprobe argv builder ever receives it.
 * - `series_identity_conflict` — the episode's series evidence contradicts
 *   itself or the catalog (two series own its ids, or the series already holds
 *   a different id from the match's provider). The scanner refuses to link it
 *   so it cannot land on the wrong series; `detail` names the ids.
 * - `series_folder_contention` — temporary folder/witness lock contention;
 *   retried automatically, independently of real identity conflicts.
 * - `movie_identity_conflict` — a movie's folder/NFO IMDb id and the IMDb id
 *   of the provider item its title matched disagree. Refused like the series
 *   case, so the two films' ids are never paired on one item.
 */
export interface FileHealthIssue {
    type: FileHealthIssueType;
    basis?: 'duration_comparison' | 'premature_eof';
    detected_at: string;
    /**
     * Number of consecutive scans that hit this issue. Used to back off:
     * retry the next scan immediately for attempt 1-2, then 24h, then 7d.
     */
    attempt_count?: number;
    /**
     * ISO timestamp — skip parsing this file until this time. Lets the
     * scanner avoid wasting 30s on a parseFile timeout that will fail
     * again with the same error.
     */
    next_retry_at?: string;
    /** Free-form detail (error message, etc.) for diagnostics. */
    detail?: string;
    /**
     * `range_superseded` only: the single-episode files that cover every
     * episode of this multi-episode file. The scan skips the file while all of
     * them are still there.
     */
    superseded_by?: string[];
    expected_duration?: number;
    actual_duration?: number;
    file_duration?: number;
    tmdb_duration?: number;
}

/**
 * Exponential backoff for repeated scan failures on the same file.
 * Attempt 1-2: retry immediately on next scan (no delay).
 * Attempt 3-4: wait 24 h.
 * Attempt 5+:  wait 7 d.
 *
 * Caller stamps the returned ISO timestamp onto `next_retry_at` so the
 * scanner can short-circuit a known-bad file without spending the 30s
 * parseFile timeout on every pass.
 */
export function nextRetryAtForAttempt(attempt: number): string | undefined {
    if (attempt <= 2) return undefined;
    if (attempt <= 4) return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

export interface MediaFileRow {
    id: string;
    file_path: string;
    edition: string | null;
    part_number: number | null;
    library_group_id: string | null;
    container_format: string | null;
    duration_seconds: number | null;
    total_bitrate: number | null;
    file_size_bytes: number | null;
    file_mtime: Date | null;
    file_hash_head: string | null;
    probed_at: Date | null;
    /** Present on scanner lookups; older narrow projections may omit it. */
    is_missing?: boolean;
    keyframes: number[] | null;
    health_issues: FileHealthIssue[] | null;
    /**
     * Absolute episode number the file name carries. Selected by
     * `findMediaFileByPath` and `loadMediaFilesByPrefix`; undefined when a
     * query did not select it.
     */
    absolute_episode?: number | null;
    created_at: Date;
    updated_at: Date;
    /**
     * Only populated by loadMediaFilesByPrefix().
     * true = at least one media_file_items row exists for this file.
     * undefined = unknown (per-file lookup path).
     */
    is_linked?: boolean;
    /** From media_file_items junction — only populated by queries that join it */
    is_default?: boolean;
    sort_order?: number;
    label?: string | null;
}

/**
 * Narrow row shape returned by loadMediaFilesByPrefix().
 *
 * The bulk prefix-load for the scanner triage path selects only the columns
 * consumed by triageFiles, detectFileChanges, and the per-file short-circuit
 * checks: id, file_path, the change-detection triple (mtime/size/hash), and
 * is_linked. Heavy columns (keyframes, probed_at, container_format,
 * duration_seconds, total_bitrate, edition, part_number, health_issues) are
 * only needed on the content-changed branch, which re-queries the DB
 * individually. Using this type cuts memory from ~280MB to ~125MB at 400k rows
 * and turns 400k correlated EXISTS subqueries into a single hash join.
 *
 * Callers that hold a `Map<string, KnownFileRow>` must not access the omitted
 * fields — the TypeScript compiler enforces this at the call site.
 */
export type KnownFileRow = Pick<
    MediaFileRow,
    | 'id'
    | 'file_path'
    | 'file_mtime'
    | 'file_size_bytes'
    | 'file_hash_head'
    | 'health_issues'
    | 'absolute_episode'
    | 'is_missing'
> & { is_linked: boolean };

export interface UpsertMediaFileParams {
    filePath: string;
    edition?: string;
    partNumber?: number;
    /**
     * Absolute episode number read from the file name. `undefined` leaves the
     * stored value alone on conflict (callers that did not parse an episode);
     * `null` clears it (the name no longer carries one).
     */
    absoluteEpisode?: number | null;
    libraryGroupId?: string;
    /**
     * 64KB head hash (see hashFileHead), populated at ingest time so it lands
     * atomically with the INSERT (fix #5 — rename-race follow-up). Without
     * this, file_hash_head was only ever written by a later, separate
     * updateFileStat() call — a fast rename right after first-ingest could
     * see the row deleted (deleteStaleMediaFile) before that follow-up write
     * landed, snapshotting dismissed_content_hash = NULL and silently
     * breaking reclaim-by-hash. Only applied on a fresh INSERT — the
     * ON CONFLICT branch deliberately leaves file_hash_head untouched, since
     * its lifecycle on an already-known path belongs to
     * updateFileStat()/change-detection, not this upsert.
     */
    fileHashHead?: string | null;
}

/**
 * Insert or update a media_files row by file_path.
 * On conflict (same file_path): updates edition, part_number, absolute_episode (when given) and updated_at.
 * file_hash_head is only set on a fresh INSERT (see UpsertMediaFileParams doc).
 * Returns { id, created } where created=true if this was a new row.
 */
export async function upsertMediaFile(
    sql: postgres.Sql,
    params: UpsertMediaFileParams,
): Promise<{ id: string; created: boolean }> {
    const rows = await sql<[{ id: string; created: boolean }]>`
        INSERT INTO media_files (file_path, edition, part_number, absolute_episode, library_group_id, file_hash_head)
        VALUES (${params.filePath}, ${params.edition ?? null}, ${params.partNumber ?? null}, ${params.absoluteEpisode ?? null}, ${params.libraryGroupId ?? null}, ${params.fileHashHead ?? null})
        ON CONFLICT (file_path) DO UPDATE
            SET edition           = EXCLUDED.edition,
                part_number       = EXCLUDED.part_number,
                absolute_episode  = CASE
                                        WHEN ${params.absoluteEpisode !== undefined}::boolean
                                            THEN EXCLUDED.absolute_episode
                                        ELSE media_files.absolute_episode
                                    END,
                library_group_id  = COALESCE(EXCLUDED.library_group_id, media_files.library_group_id),
                is_missing        = false,
                probed_at         = CASE
                                        WHEN media_files.is_missing = true THEN NULL
                                        ELSE media_files.probed_at
                                    END,
                updated_at        = NOW()
        -- xmax = 0 is true on freshly inserted rows (no pending deletes/updates in MVCC).
        -- Reliable for single-statement upserts outside a transaction.
        RETURNING id, (xmax = 0) AS created
    `;
    return rows[0];
}

/**
 * Store the absolute episode number the file name carries (`null` clears it) on
 * a file the scanner already knows. A scan skips unchanged files before
 * upsertMediaFile, so without this a file scanned before the column existed
 * would never get its number. Writes nothing when the stored value already
 * matches; the scanner also compares in memory first, so an unchanged file costs
 * no round-trip at all.
 */
export async function setAbsoluteEpisodeIfChanged(
    sql: postgres.Sql,
    fileId: string,
    absoluteEpisode: number | null,
): Promise<void> {
    await sql`
        UPDATE media_files
        SET absolute_episode = ${absoluteEpisode}
        WHERE id = ${fileId} AND absolute_episode IS DISTINCT FROM ${absoluteEpisode}
    `;
}

/**
 * Set library_added_at on an item and optionally its ancestors.
 *
 * Item itself: COALESCE — never overwrites an existing first-add date.
 * Ancestors: unconditional NOW() when propagateToAncestors=true (new episode
 * resurfaces the series), or COALESCE when false (series timestamp frozen at
 * first episode ever).
 *
 * Call this after attachFileToItem for new files, and directly with NOW()
 * for content replacements (video-processor content-changed branch).
 */
export async function touchLibraryAddedAt(
    sql: postgres.Sql,
    mediaItemId: string,
    propagateToAncestors: boolean,
): Promise<void> {
    // Item itself: only set if not yet set (preserve original first-add date)
    await sql`
        UPDATE media_items
        SET library_added_at = COALESCE(library_added_at, NOW())
        WHERE id = ${mediaItemId}
    `;

    if (propagateToAncestors) {
        // Ancestors always get NOW() — new episode resurfaces the series
        await sql`
            WITH chain AS MATERIALIZED (
                -- Ordered row lock: see ANCESTOR LOCK ORDER on propagateHasFiles.
                SELECT id FROM media_items
                WHERE id IN (
                    SELECT p.id FROM media_items mi
                        JOIN media_items p ON p.id = mi.parent_id
                    WHERE mi.id = ${mediaItemId}
                    UNION ALL
                    SELECT gp.id FROM media_items mi
                        JOIN media_items p ON p.id = mi.parent_id
                        JOIN media_items gp ON gp.id = p.parent_id
                    WHERE mi.id = ${mediaItemId}
                )
                ORDER BY id
                FOR NO KEY UPDATE
            )
            UPDATE media_items SET library_added_at = NOW()
            FROM chain
            WHERE media_items.id = chain.id
        `;
    } else {
        // Ancestors also COALESCE — series timestamp frozen at first episode
        await sql`
            WITH chain AS MATERIALIZED (
                -- Ordered row lock: see ANCESTOR LOCK ORDER on propagateHasFiles.
                SELECT id FROM media_items
                WHERE id IN (
                    SELECT p.id FROM media_items mi
                        JOIN media_items p ON p.id = mi.parent_id
                    WHERE mi.id = ${mediaItemId}
                    UNION ALL
                    SELECT gp.id FROM media_items mi
                        JOIN media_items p ON p.id = mi.parent_id
                        JOIN media_items gp ON gp.id = p.parent_id
                    WHERE mi.id = ${mediaItemId}
                )
                ORDER BY id
                FOR NO KEY UPDATE
            )
            UPDATE media_items SET library_added_at = COALESCE(library_added_at, NOW())
            FROM chain
            WHERE media_items.id = chain.id
        `;
    }
}

/**
 * Propagate has_files=true up the ancestor chain when a file is linked.
 * Walks up from the linked item to its root, setting has_files on each.
 *
 * ANCESTOR LOCK ORDER: every statement that writes an episode/season/series
 * chain (this, touchLibraryAddedAt, recomputeHasFilesBatch) first locks the
 * WHOLE chain it touches in `id` order, in one LockRows-over-Sort CTE. A bare
 * multi-row UPDATE locks rows in plan order, and with several of these inside
 * one scanner transaction two siblings of a series took season/series in
 * opposite orders: 20 deadlocks on prod in 48 h (2026-09-22..23). The lock is
 * taken even where the `has_files = false` guard then skips the row, so a
 * later statement in the same transaction never has to acquire a new one.
 *
 * RE-DERIVERS (recomputeHasFilesBatch) must lock the chain in a statement of
 * their own, EARLIER than the one that reads the file links. Locking and
 * reading in one statement evaluates the reads against the snapshot taken
 * before the lock wait, so a waiter writes back values a sibling has already
 * invalidated and committed. Monotonic writers (this function,
 * touchLibraryAddedAt) read nothing but the target row, which Postgres
 * re-checks after the wait, so they are safe in one statement. The two-
 * statement form assumes READ COMMITTED: under REPEATABLE READ the second
 * statement would reuse the transaction snapshot.
 *
 * DISMISSED ROWS ARE LEFT ALONE, here and in every other has_files
 * re-deriver below: a dismissal ("Remove from library", the scanner's
 * softDismiss, the Audiobookshelf sweep) clears has_files on purpose, and the
 * library surfaces read only has_files — re-deriving it from the file links,
 * which a dismissal keeps, would put the item back in front of every user.
 * attachFileToItem un-dismisses the linked item itself before propagating.
 */
export async function propagateHasFiles(sql: postgres.Sql, mediaItemId: string): Promise<void> {
    await sql`
        WITH chain AS MATERIALIZED (
            SELECT id FROM media_items
            WHERE id IN (
                SELECT mi.id FROM media_items mi WHERE mi.id = ${mediaItemId}
                UNION ALL
                SELECT p.id FROM media_items mi JOIN media_items p ON p.id = mi.parent_id WHERE mi.id = ${mediaItemId}
                UNION ALL
                SELECT gp.id FROM media_items mi
                    JOIN media_items p ON p.id = mi.parent_id
                    JOIN media_items gp ON gp.id = p.parent_id
                WHERE mi.id = ${mediaItemId}
            )
            ORDER BY id
            FOR NO KEY UPDATE
        )
        UPDATE media_items SET has_files = true
        FROM chain
        WHERE media_items.id = chain.id
          AND media_items.has_files = false
          AND NOT media_items.is_dismissed
    `;
}

/**
 * Recompute has_files for an item and its ancestors after a file is unlinked.
 *
 * Thin wrapper over {@link recomputeHasFilesBatch} — prefer the batch variant
 * when handling multiple detached/affected items so the ancestor recompute
 * collapses into a single set-based UPDATE instead of O(n × depth) sequential
 * statements.
 */
export async function recomputeHasFiles(sql: postgres.Sql, mediaItemId: string): Promise<void> {
    await recomputeHasFilesBatch(sql, [mediaItemId]);
}

/**
 * Lock the ancestor chain (every given item and all its ancestors, up to depth
 * 10) in `id` order and return the locked ids. Must run inside a transaction to
 * mean anything: the lock is held until it ends.
 *
 * Callers that re-derive anything FROM the file links (has_files) must call this
 * as a statement of its own, before the statement that reads. Locking and
 * reading in one statement evaluates the reads against the snapshot taken
 * before the lock wait (READ COMMITTED), so a waiter writes back values a
 * sibling transaction has already invalidated and committed. Callers that
 * touch several chains in one transaction (e.g. relinking a file between two
 * episodes) should lock the UNION of the chains here once, up front, so every
 * transaction takes the rows in the same global id order.
 */
export async function lockAncestorChain(
    tx: postgres.Sql,
    mediaItemIds: string[],
): Promise<string[]> {
    return (await lockChainRows(tx, mediaItemIds)).ids;
}

/** lockAncestorChain plus the isolation level the transaction runs under. */
async function lockChainRows(
    tx: postgres.Sql,
    mediaItemIds: string[],
): Promise<{ ids: string[]; isolation: string | null }> {
    if (mediaItemIds.length === 0) return { ids: [], isolation: null };
    const seedIds = [...new Set(mediaItemIds)];
    const rows = await tx<{ id: string; isolation: string }[]>`
        WITH RECURSIVE chain AS (
            SELECT id, parent_id, 1 AS depth
            FROM media_items
            WHERE id = ANY(${seedIds}::uuid[])
            UNION ALL
            SELECT mi.id, mi.parent_id, c.depth + 1
            FROM media_items mi
            JOIN chain c ON mi.id = c.parent_id
            WHERE c.depth < 10
        )
        SELECT id, current_setting('transaction_isolation') AS isolation
        FROM media_items
        WHERE id IN (SELECT id FROM chain)
        ORDER BY id
        FOR NO KEY UPDATE
    `;
    return { ids: rows.map((r) => r.id), isolation: rows[0]?.isolation ?? null };
}

let warnedNonReadCommitted = false;

/**
 * Recompute has_files for a set of items and all of their ancestors. Locks the
 * whole ancestor chain (ordered, one statement), then re-derives has_files for
 * exactly the locked rows in a second statement.
 *
 * Replaces the previous pattern of looping per affected id and, inside that,
 * looping per ancestor — which produced O(n × depth) sequential UPDATEs.
 *
 * The two statements MUST share a transaction, or the lock is gone before the
 * re-derive. An open transaction (transaction handle, or a reserved connection
 * the caller put in a manual BEGIN) is used as is; a bare pool or a reserved
 * connection in autocommit gets a transaction of its own here.
 *
 * Dismissed rows keep their has_files (see propagateHasFiles).
 */
export async function recomputeHasFilesBatch(
    sql: postgres.Sql,
    mediaItemIds: string[],
): Promise<void> {
    if (mediaItemIds.length === 0) return;

    // Deduplicate to keep the recursion seed minimal.
    const seedIds = [...new Set(mediaItemIds)];

    const run = async (tx: postgres.Sql): Promise<void> => {
        // Lock first (own statement), then re-derive: see lockAncestorChain for
        // why they must be separate statements. A row can be re-parented between
        // the chain walk and the lock being granted (a series merge committing
        // while we wait), which leaves its NEW parent outside the locked set; the
        // statement reports every locked row's parent so that case is caught
        // without an extra round trip, and we lock the new chain and go again.
        // Seeds for the lock walk. A retry adds the parents that fell outside the
        // locked set, so one ordered statement covers old and new chains together
        // (the rows already held are no-ops).
        let lockSeeds = seedIds;
        for (let attempt = 0; attempt < 3; attempt++) {
            const { ids: lockedIds, isolation } = await lockChainRows(tx, lockSeeds);
            if (lockedIds.length === 0) return;
            if (isolation !== 'read committed' && !warnedNonReadCommitted) {
                // The re-derive below only sees the sibling's commit because each
                // statement takes a fresh snapshot (READ COMMITTED). Under
                // REPEATABLE READ / SERIALIZABLE it would reuse the transaction's
                // snapshot and the stale-write race is back.
                warnedNonReadCommitted = true;
                recomputeLogger.warn(
                    'recomputeHasFilesBatch needs READ COMMITTED; the caller runs under a stricter isolation level',
                    { isolation },
                );
            }

            const parents = await tx<{ parent_id: string | null }[]>`
                WITH derived AS (
                    SELECT target.id,
                        (
                            -- Rewritten from a single unfiltered EXISTS that OUTER-JOINed
                            -- OUTWARD from every media_file_items row (linked -> parent ->
                            -- grandparent) and matched target.id against any of the three —
                            -- correct, but it reseqscanned the whole media_items +
                            -- media_file_items tables PER AFFECTED ROW with no index able to
                            -- drive an "OR" across three unrelated columns (prod slow-query
                            -- log, 2026-09-26: 9 calls/4.3h, p50 728ms, 200ms in a prod
                            -- EXPLAIN even for a 3-row chain — the correlated subquery, not
                            -- the recursive ancestor walk, was the cost). Same fact — a file
                            -- directly on target, on a child, or on a grandchild — expressed
                            -- as three targeted EXISTS that walk INWARD from target via
                            -- idx_media_items_parent_id: 4ms in the same prod EXPLAIN
                            -- (~50x), 0 mismatches verified against the old predicate across
                            -- 2,000 sampled items on prod.
                            EXISTS (SELECT 1 FROM media_file_items mfi JOIN media_files mf ON mf.id = mfi.file_id WHERE mfi.media_item_id = target.id AND NOT mf.is_missing)
                            OR EXISTS (
                                SELECT 1 FROM media_items child
                                JOIN media_file_items mfi ON mfi.media_item_id = child.id
                                JOIN media_files mf ON mf.id = mfi.file_id
                                WHERE child.parent_id = target.id AND NOT mf.is_missing
                            )
                            OR EXISTS (
                                SELECT 1 FROM media_items child
                                JOIN media_items grandchild ON grandchild.parent_id = child.id
                                JOIN media_file_items mfi ON mfi.media_item_id = grandchild.id
                                JOIN media_files mf ON mf.id = mfi.file_id
                                WHERE child.parent_id = target.id AND NOT mf.is_missing
                            )
                        ) AS has_files
                    FROM media_items target
                    WHERE target.id = ANY(${lockedIds}::uuid[])
                      AND NOT target.is_dismissed
                ),
                updated AS (
                    -- Only rows whose value changes: an unconditional rewrite of every
                    -- locked row made a dead tuple (and a row-trigger firing) per row
                    -- per call, and the retry loop repeated it.
                    UPDATE media_items target
                    SET has_files = derived.has_files
                    FROM derived
                    WHERE target.id = derived.id
                      AND target.has_files IS DISTINCT FROM derived.has_files
                    RETURNING 1
                )
                -- The data-modifying CTE above runs to completion even though nothing
                -- selects from it. This SELECT sees the statement-start snapshot, taken
                -- after the chain lock was granted; parent_id is not written here.
                -- Parents of ALL locked rows, not just the updated ones: a dismissed
                -- row is skipped but can still have been re-parented.
                SELECT parent_id FROM media_items WHERE id = ANY(${lockedIds}::uuid[])
            `;

            const locked = new Set(lockedIds);
            const outside = parents
                .map((r) => r.parent_id)
                .filter((id): id is string => id !== null && !locked.has(id));
            if (outside.length === 0) return;
            lockSeeds = [...new Set([...seedIds, ...lockedIds, ...outside])];
        }
        // Still re-parented after three rounds (a series merge moving seasons
        // under us the whole time). The rows we derived are correct for the
        // chains we held; only a newly adopted parent can be stale. Say so
        // instead of returning as if the whole chain had been re-derived.
        recomputeLogger.warn(
            'recomputeHasFilesBatch: ancestor chain kept changing; a new parent may be stale',
            { seedCount: seedIds.length },
        );
    };

    // The two statements must share one transaction or the lock is gone before
    // the re-derive. Reuse the caller's transaction when there is one (a
    // TransactionSql, or a ReservedSql the caller put in a manual BEGIN: opening
    // another BEGIN there would COMMIT the caller's transaction early); open our
    // own for a bare pool or a ReservedSql in autocommit. See with-tx.ts.
    if (await isInOpenTransaction(sql)) {
        await run(sql);
    } else {
        await withTx(sql, (tx) => run(tx as unknown as postgres.Sql));
    }
}

/**
 * Batch propagate has_files after a bulk scan. Runs the same 3-pass approach
 * as the cleanup plugin backfill. Call this once at the end of a scan instead
 * of propagating per-file (avoids 10K+ individual UPDATEs).
 */
export async function propagateHasFilesBatch(sql: postgres.Sql): Promise<void> {
    // Pass 1: items with direct files. Dismissed rows are skipped in every
    // pass (see propagateHasFiles).
    await sql`
        UPDATE media_items SET has_files = true
        WHERE has_files = false AND NOT is_dismissed
          AND id IN (SELECT DISTINCT media_item_id FROM media_file_items)
    `;
    // Pass 2: parents of items with files
    await sql`
        UPDATE media_items SET has_files = true
        WHERE has_files = false AND NOT is_dismissed AND id IN (
            SELECT DISTINCT parent_id FROM media_items
            WHERE has_files = true AND parent_id IS NOT NULL
        )
    `;
    // Pass 3: grandparents
    await sql`
        UPDATE media_items SET has_files = true
        WHERE has_files = false AND NOT is_dismissed AND id IN (
            SELECT DISTINCT parent_id FROM media_items
            WHERE has_files = true AND parent_id IS NOT NULL
        )
    `;
}

/**
 * Attach a file to a media_item. Idempotent — safe to call multiple times.
 *
 * Use this for standard file→item linking (scanner, episode linking, extras).
 * is_default is set automatically: the first file becomes default, subsequent
 * files are non-default. This respects the unique partial index without callers
 * needing to check state.
 *
 * Concurrent-safe: uses pg_advisory_xact_lock to serialize attaches to the
 * same media_item_id, preventing partial-unique-index races when two files
 * for the same item are processed simultaneously by the file scanner.
 *
 * Atomic propagation: `has_files` for the item AND its ancestor chain (parent,
 * grandparent — depth 3 max in Lumastra's data model) is updated INSIDE the
 * same transaction as the INSERT. A worker crash/SIGKILL between the INSERT
 * and the propagation cannot leave the cache inconsistent — Postgres aborts
 * the whole transaction on connection drop. This is why the older
 * `skipHasFilesPropagation` opt-out + end-of-scan `propagateHasFilesBatch`
 * fallback was deleted: that pattern relied on the worker process surviving
 * long enough to commit the batch step at end-of-scan, and a deploy or OOM
 * mid-scan would orphan every file attached during the run until the next
 * full scan completed (~30+ minutes of staleness).
 *
 * For explicit version/edition linking with custom label and sort_order,
 * use `linkFileAsVersion()` instead.
 */
/**
 * Whether an admin linked this file to its episodes by hand
 * (manual-file-links.service.ts). Automatic attaches then leave the file alone:
 * a scan that decided to attach before the admin saved must not add the link
 * the name implies after the save.
 *
 * Takes the file row FOR KEY SHARE first, in a statement of its own: the editor
 * holds the row FOR UPDATE while it writes, so an attach racing a save waits for
 * it, and the check below then runs on a fresh snapshot that sees the save
 * (reading in the locking statement would use the snapshot from before the
 * wait). File row first, then the item lock: the same order as the editor.
 * Must run inside the attach's transaction.
 */
async function fileIsLinkedByHand(tx: postgres.Sql, fileId: string): Promise<boolean> {
    await tx`SELECT 1 FROM media_files WHERE id = ${fileId} FOR KEY SHARE`;
    const [row] = await tx<{ manual: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM media_file_items
            WHERE file_id = ${fileId} AND offset_source = ${MANUAL_OFFSET_SOURCE}
        ) AS manual
    `;
    return row?.manual === true;
}

export async function attachFileToItem(
    sql: postgres.Sql,
    fileId: string,
    mediaItemId: string,
): Promise<void> {
    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as typeof sql;
        if (await fileIsLinkedByHand(tx, fileId)) return;
        // Serialize concurrent attaches to the same media item.
        // Without this, two files racing for the same item can both evaluate
        // NOT EXISTS as true, and the second INSERT hits the partial unique
        // index (one-default-per-item) — a constraint ON CONFLICT can't target
        // alongside the (file_id, media_item_id) primary key.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${mediaItemId}))`;

        await tx`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (
                ${fileId},
                ${mediaItemId},
                NOT EXISTS (
                    SELECT 1 FROM media_file_items
                    WHERE media_item_id = ${mediaItemId} AND is_default = true
                )
            )
            ON CONFLICT (file_id, media_item_id) DO NOTHING
        `;

        // Un-dismiss items that regain files (e.g. after rename/move/re-add).
        // Without this, re-identified items stay hidden even though they have files.
        // dismissed_at is cleared alongside so the rename-by-hash reclaim path
        // (file-rematch.queries.ts) doesn't see this row as a candidate again.
        await tx`
            UPDATE media_items
               SET is_dismissed = false,
                   dismissed_at = NULL
             WHERE id = ${mediaItemId} AND is_dismissed = true
        `;

        // Propagate has_files atomically with the INSERT. propagateHasFiles is
        // a single UPDATE that walks the 3-level ancestor chain via UNION;
        // the `has_files = false` guard makes most calls during a re-scan
        // a no-op (sibling N attaches after sibling 1 already flipped the
        // parent), so the per-attach cost amortises across a scan.
        await propagateHasFiles(tx, mediaItemId);
        // The old default is still default after this INSERT. Snapshot only
        // after propagation has locked the whole ancestor chain in id order;
        // writing the item first would invert that order for sibling attaches.
        await snapshotTrickplayForReclaim(tx, { mediaItemId, excludeFileId: fileId });
    });
}

/**
 * Get all files for a media_item, ordered by part_number (NULLs first).
 * Used by the player to discover what files to play for a given media item.
 */
export async function getFilesForMediaItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<MediaFileRow[]> {
    return sql<MediaFileRow[]>`
        SELECT mf.*,
               mfi.is_default,
               mfi.sort_order,
               mfi.label
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${mediaItemId}
        ORDER BY mfi.sort_order, mf.part_number NULLS FIRST, mf.id
    `;
}

/**
 * Scanner-probed duration (ms) of the file a media item plays by default — the
 * default link, else the first by sort order, as `buildLumastraInfo` picks it.
 * One column on purpose: `getFilesForMediaItem` drags `keyframes` jsonb along,
 * and the /watch loader that reads this sits on the time-to-first-frame path.
 * NULL until the file has been probed.
 */
export async function getDefaultFileDurationMs(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<number | null> {
    const rows = await sql<{ duration_seconds: number | null }[]>`
        SELECT mf.duration_seconds
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${mediaItemId}
        ORDER BY mfi.is_default DESC, mfi.sort_order, mf.part_number NULLS FIRST, mf.id
        LIMIT 1
    `;
    const seconds = rows[0]?.duration_seconds;
    return seconds != null && Number(seconds) > 0 ? Math.round(Number(seconds) * 1000) : null;
}

/** File count and total on-disk size for a single media item. */
export interface MediaFileSummary {
    count: number;
    totalBytes: number | null;
}

/**
 * Aggregate file count and total size for a single media item — the header's
 * state line needs "how many files and how big", not the per-file rows
 * `getFilesForMediaItem` returns. Always resolves, even when the item has no
 * files (`{ count: 0, totalBytes: null }`), so callers can treat the result
 * as unconditional rather than checking for a missing summary.
 *
 * Known limitation, left as-is on purpose: `media_file_items` carries
 * `start_offset_ms`/`end_offset_ms`/`offset_source`, so one physical file can
 * be split across several media items (e.g. two episodes sharing a single
 * recording). This aggregate sums `file_size_bytes` per linked item, so each
 * split item is attributed the file's FULL size — two split episodes will
 * each report "1 file" at the whole shared file's byte count, not a fraction
 * of it. Deciding what the number should mean for a split item (the whole
 * file? an estimated share?) is a design decision, not something to guess at
 * here — this is just documenting the behaviour so it reads as a known
 * limitation rather than a surprise.
 */
export async function getMediaFileSummary(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<MediaFileSummary> {
    const [row] = await sql<{ file_count: number; total_bytes: string | null }[]>`
        SELECT
            COUNT(*)::int AS file_count,
            SUM(mf.file_size_bytes)::text AS total_bytes
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${mediaItemId}
    `;
    return {
        count: row?.file_count ?? 0,
        totalBytes: row?.total_bytes != null ? Number(row.total_bytes) : null,
    };
}

/** One direct child of a container, summarised by where its files live on disk. */
export interface DescendantDirAnchor {
    /**
     * How far below the container the files sit: 1 when this child owns them
     * itself (album→track, season→episode), 2 when a grandchild does
     * (artist→album→track, tv→season→episode).
     */
    depth: number;
    /** Lexicographic bounds of the directories holding this child's files. */
    minDir: string;
    maxDir: string;
}

/**
 * Summarise where a container item's descendant files live, grouped per direct
 * child.
 *
 * Container rows (artist, album, tv, season) never own a file themselves —
 * `has_files` on them is aggregated up from their children — so callers that
 * need an on-disk anchor for one (e.g. deciding where to write artwork
 * "alongside" the media) have to reach through to the descendants that do.
 *
 * Grouping per child is what makes multi-disc layouts work. An album split
 * over `Album/CD 01` and `Album/CD 02` collapses to `Album` via that child's
 * own min/max bounds, so a caller walking up to the artist starts from the
 * album folder rather than from a disc folder. min/max are enough to recover
 * the shared prefix: for any set of strings, the common prefix of the whole
 * set equals the common prefix of its lexicographic extremes.
 *
 * Children whose files the child owns directly are folded into one row
 * (`depth = 1`), since none of them contributes a directory level of its own —
 * that keeps a 500-episode season from returning 500 rows.
 *
 * Returns an empty array when the item has no file-bearing descendants at all
 * (discovery-only items, LiveTV channels, radio stations).
 */
export async function findDescendantDirAnchors(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<DescendantDirAnchor[]> {
    const rows = await sql<{ depth: number; min_dir: string; max_dir: string }[]>`
        WITH RECURSIVE tree AS (
            SELECT id AS child_id, id AS node_id, 1 AS depth
            FROM media_items
            WHERE parent_id = ${mediaItemId}
            UNION ALL
            SELECT t.child_id, c.id, t.depth + 1
            FROM media_items c
            JOIN tree t ON c.parent_id = t.node_id
            -- Bounded walk. The guard tests the row being extended, so
            -- depth < 2 yields depths 1 and 2 — exactly the documented
            -- hierarchies (album to track, artist to album to track) and no
            -- deeper. Stopping here also keeps a cyclic parent_id from
            -- spinning forever, and keeps nested extras from dragging their
            -- own subfolder into a container's directory span.
            WHERE t.depth < 2
        ),
        located AS (
            SELECT
                t.child_id,
                t.depth,
                -- dirname(): strip the trailing path segment.
                regexp_replace(mf.file_path, '/[^/]+$', '') AS dir
            FROM tree t
            JOIN media_file_items mfi ON mfi.media_item_id = t.node_id
            JOIN media_files mf ON mf.id = mfi.file_id
        )
        SELECT
            min(depth) AS depth,
            min(dir) AS min_dir,
            max(dir) AS max_dir
        FROM located
        -- Direct file owners share one row (no folder level of their own);
        -- deeper children stay separate so each keeps its own folder bounds.
        GROUP BY CASE WHEN depth = 1 THEN NULL ELSE child_id END
    `;
    return rows.map((row) => ({
        depth: row.depth,
        minDir: row.min_dir,
        maxDir: row.max_dir,
    }));
}

/**
 * Returns true if a media_items row has at least one linked file.
 * Used by the scanner to detect when a second file matches the same item.
 */
export async function mediaItemHasFile(sql: postgres.Sql, mediaItemId: string): Promise<boolean> {
    const rows = await sql<[{ exists: boolean }]>`
        SELECT EXISTS(
            SELECT 1 FROM media_file_items WHERE media_item_id = ${mediaItemId}
        ) AS exists
    `;
    return rows[0]?.exists ?? false;
}

/**
 * Returns all media_item_ids linked to the same file(s) as the given media_item.
 * Used when completing playback of a multi-episode file: all linked episodes get marked watched.
 */
export async function getLinkedMediaItemIds(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<string[]> {
    const rows = await sql<{ media_item_id: string }[]>`
        SELECT DISTINCT mfi2.media_item_id
        FROM media_file_items mfi1
        JOIN media_file_items mfi2 ON mfi2.file_id = mfi1.file_id
        WHERE mfi1.media_item_id = ${mediaItemId}
    `;
    return rows.map((r) => r.media_item_id);
}

/**
 * Returns distinct edition values for a media item (excludes null/default edition).
 * When result is non-empty, the watch page should offer an edition picker.
 */
export async function getEditionsForMediaItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<string[]> {
    const rows = await sql<{ edition: string }[]>`
        SELECT DISTINCT mf.edition
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${mediaItemId}
          AND mf.edition IS NOT NULL
    `;
    return rows.map((r) => r.edition);
}

/**
 * Find a media_files row by file_path. Returns null if not found.
 */
export async function findMediaFileByPath(
    sql: postgres.Sql,
    filePath: string,
): Promise<MediaFileRow | null> {
    const rows = await sql<MediaFileRow[]>`
        SELECT * FROM media_files WHERE file_path = ${filePath} LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Lookup variant for the SDK `ctx.mediaFiles.findByPath` surface — returns
 * just the file UUID and the first linked media item id (or null when the
 * file is unlinked). Single query with LEFT JOIN keeps it round-trip-cheap
 * for plugins that process file-system events. Returns null when no
 * media_files row exists for the path.
 */
export async function findMediaFileWithLinkByPath(
    sql: postgres.Sql,
    filePath: string,
): Promise<{ mediaFileId: string; mediaItemId: string | null } | null> {
    const rows = await sql<{ media_file_id: string; media_item_id: string | null }[]>`
        SELECT mf.id AS media_file_id, MIN(mfi.media_item_id) AS media_item_id
        FROM media_files mf
        LEFT JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mf.file_path = ${filePath}
        GROUP BY mf.id
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        mediaFileId: row.media_file_id,
        mediaItemId: row.media_item_id,
    };
}

/**
 * Bulk-load the triage-relevant columns for all media_files rows whose
 * file_path starts with the given prefix.
 *
 * Returns a Map<filePath, KnownFileRow> for O(1) per-file lookups during
 * scanning. Selecting only the columns consumed by triageFiles and the
 * per-file short-circuit checks (id, path, mtime, size, hash, health_issues,
 * is_linked) reduces the heap footprint from ~280MB to ~125MB at 400k rows.
 *
 * is_linked is computed via a LEFT JOIN on a pre-aggregated set rather than
 * a per-row correlated EXISTS, turning 400k subqueries into a single hash
 * join. Benefits from the text_pattern_ops index added in migration 16.56.0.
 */
export async function loadMediaFilesByPrefix(
    sql: postgres.Sql,
    pathPrefix: string,
): Promise<Map<string, KnownFileRow>> {
    const escaped = pathPrefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped.endsWith('/') ? escaped : escaped + '/';
    const rows = await sql<KnownFileRow[]>`
        SELECT
            mf.id,
            mf.file_path,
            mf.file_mtime,
            mf.file_size_bytes,
            mf.file_hash_head,
            mf.health_issues,
            mf.absolute_episode,
            mf.is_missing,
            (linked.file_id IS NOT NULL) AS is_linked
        FROM media_files mf
        LEFT JOIN (
            SELECT DISTINCT file_id FROM media_file_items
        ) linked ON linked.file_id = mf.id
        WHERE mf.file_path LIKE ${prefix + '%'} ESCAPE '\\'
    `;
    const map = new Map<string, KnownFileRow>();
    for (const row of rows) {
        map.set(row.file_path, row);
    }
    return map;
}

/**
 * Returns the set of episode_numbers that are already linked to the given
 * file, scoped to a specific season_number.
 *
 * Used by the scanner's existing-file short-circuit to decide whether a
 * multi-episode file (e.g. S01E01E02.mkv) is FULLY linked — i.e. every
 * episode in the parsed range has a media_file_items row pointing to this
 * file. If any episode number in [episodeStart..episodeEnd] is absent from
 * the returned set, the short-circuit must fall through so the missing
 * link(s) get created.
 *
 * Single-episode callers should use {@link isFileLinkedToMediaItem} instead
 * (one fewer JOIN and no Set allocation).
 */
export async function getLinkedEpisodeNumbersForFile(
    sql: postgres.Sql,
    fileId: string,
    seasonNumber: number,
): Promise<Set<number>> {
    const rows = await sql<{ episode_number: number }[]>`
        SELECT mi.episode_number
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mfi.file_id = ${fileId}
          AND mi.episode_number IS NOT NULL
          AND mi.season_number = ${seasonNumber}
    `;
    return new Set(rows.map((r) => r.episode_number));
}

/**
 * Returns true if the given file_path is linked to at least one media_item.
 * Boolean-only check — use {@link findAllLinkedMediaItemsByFilePath} when you
 * need the actual item IDs.
 */
export async function isFileLinkedToMediaItem(
    sql: postgres.Sql,
    filePath: string,
): Promise<boolean> {
    const rows = await sql<[{ exists: boolean }]>`
        SELECT EXISTS(
            SELECT 1
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            WHERE mf.file_path = ${filePath}
        ) AS exists
    `;
    return rows[0]?.exists ?? false;
}

/**
 * Returns ALL media_item_ids linked to the given file_path.
 * Handles the M:N relationship correctly — a single file can map to multiple
 * media items (e.g. multi-episode video files like S01E01E02.mkv).
 */
export async function findAllLinkedMediaItemsByFilePath(
    sql: postgres.Sql,
    filePath: string,
): Promise<string[]> {
    const rows = await sql<{ media_item_id: string }[]>`
        SELECT mfi.media_item_id
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mf.file_path = ${filePath}
    `;
    return rows.map((r) => r.media_item_id);
}

/**
 * Byte range holding every path under `folder/`, for the text_pattern_ops index
 * on media_files.file_path. A LIKE whose pattern is a bind parameter cannot use
 * that index once Postgres switches the prepared statement to a generic plan;
 * the walk over the whole file_path index cost ~30 ms per call and was ~40% of
 * all database time on prod. The range is exact for the prefix ('0' is the byte
 * after '/'), and the LIKE still decides escaping, so results do not change.
 */
function folderPathRange(folder: string): { lo: string; hi: string } {
    return { lo: folder + '/', hi: folder + '0' };
}

/**
 * Given a movie folder path, find the media_item_id of the main video file
 * directly inside that folder (not in any subfolder).
 *
 * Used by the extras scanner to link extras to their parent movie.
 *
 * Example:
 *   folderPath = '/movies/Milo Farrow (2001)'
 *   Matches files like '/movies/Milo Farrow (2001)/Milo Farrow.mkv'
 *   but NOT '/movies/Milo Farrow (2001)/trailers/Trailer.mp4'
 *
 * Returns null if no linked file is found in that folder.
 */
export async function findParentMediaItemByFolder(
    sql: postgres.Sql,
    folderPath: string,
): Promise<string | null> {
    const p = directChildFolderParams(folderPath);

    const rows = await sql<{ media_item_id: string }[]>`
        SELECT mfi.media_item_id
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mf.file_path ~>=~ ${p.lo}
          AND mf.file_path ~<~ ${p.hi}
          AND mf.file_path LIKE ${p.like} ESCAPE '\\'
          AND mf.file_path NOT LIKE ${p.notLike} ESCAPE '\\'
          AND mi.media_type != 'extra'
        -- Deterministic pick when a folder holds several primaries (e.g. loose
        -- episodes in a season folder): stable across scans instead of arbitrary.
        ORDER BY mf.file_path
        LIMIT 1
    `;
    return rows[0]?.media_item_id ?? null;
}

/**
 * The four bind values {@link findParentMediaItemByFolder} and
 * {@link findParentMediaItemsByFolders} filter on — one function so the single
 * and the batched lookup can never disagree about a folder.
 */
function directChildFolderParams(folderPath: string): {
    lo: string;
    hi: string;
    like: string;
    notLike: string;
} {
    // Ensure no trailing slash on folderPath
    const folder = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
    // Escape LIKE wildcards in the folder path so that directory names
    // containing '%' or '_' (legal on Linux/macOS) do not match unexpectedly.
    const escaped = folder.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const range = folderPathRange(folder);
    return {
        lo: range.lo,
        hi: range.hi,
        like: escaped + '/%',
        // NOT LIKE 'folder/%/%' excludes anything with an extra path segment
        notLike: escaped + '/%/%',
    };
}

/**
 * {@link findParentMediaItemByFolder} for many folders in ONE statement: the
 * same WHERE, ORDER BY and LIMIT per folder, as a correlated subquery over the
 * input list, so every folder gets exactly the row the single lookup returns
 * (null included). The map is keyed by the input strings.
 *
 * Why: the scanner's artwork pass resolves every artwork folder of a library on
 * every scan — ~7,100 folders across prod's six libraries, hourly — one round
 * trip each. As one statement per chunk the same answers cost ~0.06 ms a folder.
 * Chunked so a huge library neither builds one giant statement nor crosses the
 * JIT cost threshold.
 */
export async function findParentMediaItemsByFolders(
    sql: postgres.Sql,
    folderPaths: readonly string[],
): Promise<Map<string, string | null>> {
    const CHUNK = 1000;
    const result = new Map<string, string | null>();
    const unique = [...new Set(folderPaths)];
    for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        const params = chunk.map(directChildFolderParams);
        const rows = await sql<{ ord: string; media_item_id: string | null }[]>`
            SELECT f.ord, (
                SELECT mfi.media_item_id
                FROM media_files mf
                JOIN media_file_items mfi ON mfi.file_id = mf.id
                JOIN media_items mi ON mi.id = mfi.media_item_id
                WHERE mf.file_path ~>=~ f.lo
                  AND mf.file_path ~<~ f.hi
                  AND mf.file_path LIKE f.pat ESCAPE '\\'
                  AND mf.file_path NOT LIKE f.sub ESCAPE '\\'
                  AND mi.media_type != 'extra'
                ORDER BY mf.file_path
                LIMIT 1
            ) AS media_item_id
            FROM unnest(
                ${sql.array(params.map((p) => p.lo))}::text[],
                ${sql.array(params.map((p) => p.hi))}::text[],
                ${sql.array(params.map((p) => p.like))}::text[],
                ${sql.array(params.map((p) => p.notLike))}::text[]
            ) WITH ORDINALITY AS f(lo, hi, pat, sub, ord)
        `;
        if (rows.length !== chunk.length) {
            throw new Error(
                `findParentMediaItemsByFolders: ${rows.length} rows for ${chunk.length} folders`,
            );
        }
        for (const row of rows) {
            result.set(chunk[Number(row.ord) - 1], row.media_item_id);
        }
    }
    return result;
}

/**
 * Fallback for `findParentMediaItemByFolder` when a folder has no primary
 * file DIRECTLY inside it — the shape a series/artist folder always has: a
 * series has no files of its own, only its episodes do, one or more season
 * subfolders down (`Series X/Season 1/ep.mkv`). An extra dropped at the
 * series root (`Series X/trailers/trailer.mp4`) therefore had no parent to
 * attach to at all — `processExtra` would call `findParentMediaItemByFolder`
 * (direct-children only) and get null, silently dropping series-level extras.
 *
 * Two-step resolution:
 *   1. Find ANY non-extra file linked anywhere RECURSIVELY under
 *      `folderPath` (not just directly inside it) — for a series folder this
 *      matches an episode file in a season subfolder. Deterministic when
 *      several match: shallowest path first (fewest path segments below
 *      `folderPath`), then lexical path — stable across reruns.
 *   2. Walk that file's media_item UP via `parent_id` (episode → season →
 *      series, or album → artist) to the TOP ancestor (`parent_id IS NULL`),
 *      depth-bounded at 6 to match `findLibraryGroupForItemTree`'s bound.
 *      That top ancestor is the item a folder-level extra should attach to.
 *
 * Returns null when the folder has no linked files at all (recursively).
 * For a folder whose primary sits directly inside it (a movie), the CALLER
 * should try `findParentMediaItemByFolder` FIRST — this function still
 * resolves the same result for that shape (a movie has no ancestors, so the
 * "top" is the movie itself), but the caller's direct-match path is cheaper
 * and remains the primary route for that common case.
 */
export async function findRootMediaItemByFolderRecursive(
    sql: postgres.Sql,
    folderPath: string,
): Promise<string | null> {
    // Ensure no trailing slash, matching findParentMediaItemByFolder.
    const folder = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
    // Escape LIKE wildcards, matching findParentMediaItemByFolder.
    const escaped = folder.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped + '/';
    const range = folderPathRange(folder);

    const rows = await sql<{ id: string }[]>`
        WITH RECURSIVE candidate AS (
            SELECT mfi.media_item_id AS id
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mf.file_path ~>=~ ${range.lo}
              AND mf.file_path ~<~ ${range.hi}
              AND mf.file_path LIKE ${prefix + '%'} ESCAPE '\\'
              AND mi.media_type != 'extra'
            -- Deterministic shallowest-first pick: fewer path separators
            -- below folderPath first, then lexical path.
            ORDER BY
                length(mf.file_path) - length(replace(mf.file_path, '/', '')) ASC,
                mf.file_path ASC
            LIMIT 1
        ),
        ancestors AS (
            SELECT mi.id, mi.parent_id, 0 AS depth
            FROM media_items mi
            JOIN candidate c ON c.id = mi.id
            UNION ALL
            SELECT p.id, p.parent_id, a.depth + 1
            FROM media_items p
            JOIN ancestors a ON p.id = a.parent_id
            WHERE a.depth < 6
        )
        SELECT id
        FROM ancestors
        WHERE parent_id IS NULL
        ORDER BY depth DESC
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * Resolve a TV series from its root folder when episodes are stored in a
 * `Season …` directory directly below it (for example
 * `Show/Season 01/S01E01.mkv`).
 *
 * This deliberately does not use the broader recursive-root lookup above:
 * arbitrary nested folders such as a music album's `Disc 1` must not have
 * their artwork attributed to a top-level ancestor. The explicit season
 * directory requirement also prevents library-root artwork from resolving to
 * a folderless show further down the tree.
 */
export async function findTvSeriesByFolderWithSeasonDirectory(
    sql: postgres.Sql,
    folderPath: string,
): Promise<string | null> {
    const folder = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
    const escaped = folder.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped + '/';
    const seasonChild = escaped + '/Season %/%';
    const deeperThanSeason = escaped + '/%/%/%';

    const rows = await sql<{ id: string }[]>`
        WITH RECURSIVE candidate AS (
            SELECT mfi.media_item_id AS id
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mf.file_path LIKE ${prefix + '%'} ESCAPE '\\'
              AND mf.file_path LIKE ${seasonChild} ESCAPE '\\'
              AND mf.file_path NOT LIKE ${deeperThanSeason} ESCAPE '\\'
              AND mi.media_type = 'episode'
            ORDER BY mf.file_path
            LIMIT 1
        ),
        ancestors AS (
            SELECT mi.id, mi.parent_id, mi.media_type, 0 AS depth
            FROM media_items mi
            JOIN candidate c ON c.id = mi.id
            UNION ALL
            SELECT p.id, p.parent_id, p.media_type, a.depth + 1
            FROM media_items p
            JOIN ancestors a ON p.id = a.parent_id
            WHERE a.depth < 6
        )
        SELECT id
        FROM ancestors
        WHERE parent_id IS NULL
          AND media_type = 'tv'
        ORDER BY depth DESC
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * Find the primary (non-extra) media_item linked to an EXACT file path. Used to
 * attach a filename-suffix extra to the specific sibling primary the scanner
 * matched by name (`B-trailer.mkv` → `B.mkv`), rather than an arbitrary item in
 * the folder. Returns null when the file is unknown or only linked to an extra.
 */
export async function findMediaItemByFilePath(
    sql: postgres.Sql,
    filePath: string,
): Promise<string | null> {
    const rows = await sql<{ media_item_id: string }[]>`
        SELECT mfi.media_item_id
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mf.file_path = ${filePath}
          AND mi.media_type != 'extra'
        ORDER BY mi.id
        LIMIT 1
    `;
    return rows[0]?.media_item_id ?? null;
}

/** Artist-name form for comparing a folder name with an artist title. */
function folderArtistKey(name: string): string {
    const key = name
        .normalize('NFKC')
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/[^\p{L}\p{N} ]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    return isVariousArtistsName(key) ? VARIOUS_ARTISTS_LABEL.toLowerCase() : key;
}

export interface FolderArtistCandidate {
    id: string;
    title: string;
    nfoSourcePath: string | null;
}

/**
 * Which of the artists with tracks under `folder` the folder belongs to, if
 * any: the one whose `artist.nfo` lives in it, else the one it is named after.
 *
 * Having tracks under the folder is not enough. An album's artist is often
 * not the folder's: every album in `juno/` is a compilation, so "Various
 * Artists" took juno's photo, backdrop and logo; tracks under `Various
 * Artists/` credited to Ziggy X gave Ziggy X the Various Artists picture; and
 * `W&W/` went to an "W" fragment. Art in a folder that names no artist we
 * have is left alone.
 */
export function pickFolderArtist(
    folder: string,
    candidates: readonly FolderArtistCandidate[],
): string | null {
    const dir = folder.endsWith('/') ? folder.slice(0, -1) : folder;
    const byNfo = candidates.find(
        (c) => c.nfoSourcePath !== null && c.nfoSourcePath === `${dir}/artist.nfo`,
    );
    if (byNfo) return byNfo.id;
    const folderKey = folderArtistKey(dir.slice(dir.lastIndexOf('/') + 1));
    if (!folderKey) return null;
    return candidates.find((c) => folderArtistKey(c.title) === folderKey)?.id ?? null;
}

/**
 * Find the artist media_item a folder of albums belongs to. Used for
 * artist-level artwork (folder.jpg, logo.png, backdrop.jpg) where
 * findParentMediaItemByFolder returns null because artists have no direct
 * file links. See {@link pickFolderArtist} for which artist that is.
 */
export async function findArtistByChildFolder(
    sql: postgres.Sql,
    folderPath: string,
): Promise<string | null> {
    const folder = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
    const escaped = folder.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped + '/';

    const rows = await sql<{ id: string; title: string; nfo_source_path: string | null }[]>`
        SELECT DISTINCT mi_artist.id, mi_artist.title,
               mi_artist.custom_metadata->>'nfo_source_path' AS nfo_source_path
        FROM media_items mi_artist
        JOIN media_items mi_album ON mi_album.parent_id = mi_artist.id
        JOIN media_items mi_track ON mi_track.parent_id = mi_album.id
        JOIN media_file_items mfi ON mfi.media_item_id = mi_track.id
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE mi_artist.media_type = 'artist'
          AND mf.file_path LIKE ${prefix + '%'} ESCAPE E'\\\\'
    `;
    return pickFolderArtist(
        folder,
        rows.map((r) => ({ id: r.id, title: r.title, nfoSourcePath: r.nfo_source_path })),
    );
}

/**
 * Given a media_item_id, if that item is an episode, return its season parent's ID.
 * Used by artwork processing to attach season-folder artwork to the season item
 * rather than to an arbitrary episode in the folder.
 */
export async function findSeasonParentIfEpisode(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<string | null> {
    const rows = await sql<{ parent_id: string }[]>`
        SELECT mi.parent_id
        FROM media_items mi
        WHERE mi.id = ${mediaItemId}
          AND mi.media_type = 'episode'
          AND mi.parent_id IS NOT NULL
        LIMIT 1
    `;
    return rows[0]?.parent_id ?? null;
}

/**
 * Update label, is_default, and/or sort_order on a media_file_items junction row.
 * Only non-null fields are applied (COALESCE keeps existing values for nulls).
 * Called by the file scanner when registering secondary versions of a media item.
 */
export async function updateMediaFileItemMetadata(
    sql: postgres.Sql,
    fileId: string,
    mediaItemId: string,
    metadata: { label?: string; isDefault?: boolean; sortOrder?: number },
): Promise<void> {
    await sql`
        UPDATE media_file_items
        SET label      = COALESCE(${metadata.label ?? null}, label),
            is_default = COALESCE(${metadata.isDefault ?? null}, is_default),
            sort_order = COALESCE(${metadata.sortOrder ?? null}, sort_order)
        WHERE file_id = ${fileId} AND media_item_id = ${mediaItemId}
    `;
}

/**
 * Atomically link a file as a version of a media item.
 *
 * 1. Demotes the current default (if any) to is_default=false.
 * 2. Assigns sequential sort_order to all existing files.
 * 3. Inserts the new junction row with the correct is_default and sort_order.
 *
 * All steps run against the same `sql` handle so they share any enclosing
 * transaction — no intermediate state is visible to the unique partial index.
 */
export async function linkFileAsVersion(
    sql: postgres.Sql,
    fileId: string,
    mediaItemId: string,
    options: {
        label: string;
        isDefault: boolean;
        sortOrder: number;
    },
): Promise<void> {
    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        if (await fileIsLinkedByHand(tx, fileId)) return;
        // Serialize concurrent version links for the same media item to prevent
        // partial-unique-index races (demote succeeds but upsert fails).
        await tx`SELECT pg_advisory_xact_lock(hashtext(${mediaItemId}))`;

        // Step 1: demote the current default so the unique index is free
        if (options.isDefault) {
            await tx`
                UPDATE media_file_items
                SET is_default = false
                WHERE media_item_id = ${mediaItemId} AND is_default = true
            `;
        }

        // Step 2: upsert the junction row with final metadata in one statement
        await tx`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order, label)
            VALUES (${fileId}, ${mediaItemId}, ${options.isDefault}, ${options.sortOrder}, ${options.label})
            ON CONFLICT (file_id, media_item_id)
            DO UPDATE SET is_default = ${options.isDefault},
                          sort_order = ${options.sortOrder},
                          label      = ${options.label}
        `;
    });
}

/**
 * Count distinct media items linked via media_file_items.
 * Used by the file scanner to report how many items are currently on disk.
 */
export async function countLinkedMediaItems(sql: postgres.Sql): Promise<number> {
    const rows = await sql<[{ count: string }]>`
        SELECT COUNT(DISTINCT mfi.media_item_id)::text AS count
        FROM media_file_items mfi
    `;
    return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Delete a stale media_files row (and its media_file_items via CASCADE) by file path.
 * Called when a file that was previously scanned no longer exists on disk.
 *
 * After removing the file, checks whether any linked media_items have become
 * orphaned (no remaining files). Sibling promotion: when the deleted file was the
 * is_default=true version for a media_item and surviving siblings exist, one sibling
 * is promoted to is_default=true (lowest sort_order wins; oldest created_at breaks ties).
 * This runs inside the same transaction as the DELETE so downstream queries that filter
 * WHERE is_default=true (audio-language badges, episode-detail panel, play-sessions)
 * never see a gap.
 *
 * Orphaned items (zero remaining files) are soft-dismissed via cleanupOrphanedMediaItems,
 * which preserves user data (ratings, watch-state) while hiding the item from UI.
 *
 * All steps — SELECT, DELETE, promotion, recomputeHasFiles, cleanup — run inside a single
 * transaction so the partial unique index constraint is always satisfied atomically.
 */
export async function deleteStaleMediaFile(
    sql: postgres.Sql,
    filePath: string,
    notNewerThan?: Date,
): Promise<{ deleted: boolean; affectedItemIds: string[]; removedSizeBytes?: number }> {
    let deleted = false;
    let affectedItemIds: string[] = [];
    // Size of the row that was deleted, when it had one: a removed file's other
    // names (a hard link renamed over it) are looked up by it.
    let removedSizeBytes: number | undefined;
    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        // 1. Find which media_items were linked to this file before deletion,
        //    AND capture the file's 64KB head hash. The hash is snapshotted
        //    onto media_items.dismissed_content_hash (step 1b) so the
        //    rename-by-hash reclaim path (bug #3) can find these items even
        //    after the DELETE cascades media_files away.
        const linkedItems = await tx<
            {
                media_item_id: string;
                file_hash_head: string | null;
            }[]
        >`
            SELECT mfi.media_item_id, mf.file_hash_head
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mf.file_path = ${filePath}
        `;
        const affectedIds = linkedItems.map((r) => r.media_item_id);
        const fileHashHead = linkedItems[0]?.file_hash_head ?? null;

        // Per-item advisory lock first: the one attachFileToItem and
        // linkFileAsVersion hold while they choose a default. Without it an
        // attach to an item whose default file is being deleted here sees the
        // old default, inserts its file as non-default, and fails the deferred
        // one-default trigger once this delete commits. Every holder takes it
        // before any row lock, in id order.
        for (const id of [...new Set(affectedIds)].toSorted()) {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
        }

        // Then the affected items' ancestor chain, before the hash snapshot
        // below and before the junction rows go. applyAirDateRelinks takes the
        // same order (chain, then junction rows) when it moves a file between
        // episodes; with the chain locked second here, an unlink and a relink of
        // the same file waited on each other's junction row and chain lock.
        await lockAncestorChain(tx, affectedIds);

        // 1b. Snapshot the head hash onto each linked media_item. We write
        //     before DELETE so a worker crash between steps cannot leave
        //     the hash unrecorded — softDismiss (downstream) reads this
        //     value implicitly via dismissed_content_hash. Items that
        //     survive cleanupOrphanedMediaItems (still have other files)
        //     will simply carry an unused hash; the column is only read
        //     when is_dismissed=true.
        if (fileHashHead && affectedIds.length > 0) {
            await tx`
                UPDATE media_items
                   SET dismissed_content_hash = ${fileHashHead}
                 WHERE id = ANY(${affectedIds}::uuid[])
            `;
        }

        await snapshotTrickplayForReclaim(tx, { filePath, notNewerThan });

        // 2. Delete the file (cascades to media_file_items).
        //    When notNewerThan is provided, guard against concurrent writers:
        //    skip the delete if updated_at was stamped after the walk started.
        let deletedIds: { id: string; file_size_bytes: number | string | null }[];
        if (notNewerThan !== undefined) {
            deletedIds = await tx<{ id: string; file_size_bytes: number | string | null }[]>`
                DELETE FROM media_files
                WHERE file_path = ${filePath}
                  AND updated_at <= ${notNewerThan}
                RETURNING id, file_size_bytes
            `;
        } else {
            deletedIds = await tx<{ id: string; file_size_bytes: number | string | null }[]>`
                DELETE FROM media_files
                WHERE file_path = ${filePath}
                RETURNING id, file_size_bytes
            `;
        }

        // If 0 rows deleted, a concurrent writer resurrected the row after the
        // walk snapshot — nothing to clean up; skip orphan/sibling steps.
        if (deletedIds.length === 0) {
            return;
        }
        deleted = true;
        affectedItemIds = affectedIds;
        const size = deletedIds[0]?.file_size_bytes;
        if (size !== null && size !== undefined) removedSizeBytes = Number(size);

        // 3. Promote a sibling to is_default=true for each affected media_item that
        //    now has surviving files but no default. The NOT EXISTS guard makes this
        //    idempotent — it fires only when no current default exists, so it is safe
        //    to call unconditionally for every affected item.
        //
        //    media_file_items has no surrogate `id` column — the PK is
        //    (file_id, media_item_id). We select the winner file_id in a subquery
        //    and update by that composite key.
        await promoteDefaultWhereMissing(tx, affectedIds);

        // 4. Recompute has_files for affected items and their ancestors
        await recomputeHasFilesBatch(tx, affectedIds);

        // 5. Clean up orphaned media_items (no remaining files)
        if (affectedIds.length > 0) {
            await cleanupOrphanedMediaItems(tx, affectedIds);
        }
    });
    // removedSizeBytes is left out when nothing was deleted, so the result of a
    // no-op removal stays exactly { deleted, affectedItemIds }.
    return removedSizeBytes === undefined
        ? { deleted, affectedItemIds }
        : { deleted, affectedItemIds, removedSizeBytes };
}

/**
 * Give each item that still has files but lost its default link a new default:
 * lowest sort_order, then oldest file (the quality pass re-ranks after probing).
 * A no-op for items that have a default or no files. Call it inside the
 * transaction that removed the default, before commit, or the deferred
 * `check_media_file_items_one_default` trigger rejects it; hold the items'
 * advisory lock (see attachFileToItem) if a concurrent attach must not race it.
 *
 * media_file_items has no surrogate `id` column (PK is (file_id, media_item_id)),
 * so the winner is picked in a subquery and updated by that composite key.
 */
export async function promoteDefaultWhereMissing(
    tx: postgres.Sql,
    mediaItemIds: string[],
): Promise<void> {
    for (const id of mediaItemIds) {
        await tx`
            UPDATE media_file_items mfi_outer
            SET is_default = TRUE
            FROM (
                SELECT mfi.file_id
                FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = ${id}
                  AND NOT EXISTS (
                      SELECT 1 FROM media_file_items
                      WHERE media_item_id = ${id} AND is_default = TRUE
                  )
                ORDER BY mfi.sort_order, mf.created_at, mfi.file_id
                LIMIT 1
            ) winner
            WHERE mfi_outer.media_item_id = ${id}
              AND mfi_outer.file_id = winner.file_id
        `;
    }
}

// Concurrent stale-file deletions must share the same lazy module load.
// Overlapping dynamic imports can expose an incomplete circular module graph.
let mediaDeletionServiceModule: Promise<typeof MediaDeletionModule> | undefined;

/**
 * Soft-dismiss all media items that have no remaining files.
 * Called after file deletion to clean up orphaned items.
 * Every zero-file orphan is soft-dismissed via MediaDeletionService.softDismiss,
 * which preserves user data (ratings, watch-state) while hiding the item from UI.
 * Sibling promotion (if applicable) is handled separately in deleteStaleMediaFile.
 */
export async function cleanupOrphanedMediaItems(
    sql: postgres.Sql,
    mediaItemIds: string[],
): Promise<void> {
    if (mediaItemIds.length === 0) return;

    const { MediaDeletionService } = await (mediaDeletionServiceModule ??=
        import('$lib/server/services/media-deletion.service.js'));

    // Find items that now have zero files
    const orphans = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_items mi
        WHERE mi.id = ANY(${mediaItemIds})
          AND NOT EXISTS (
              SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id
          )
    `;

    // Soft-dismiss orphaned items (preserves user data)
    for (const orphan of orphans) {
        await MediaDeletionService.softDismiss(sql, orphan.id);
    }
}

/**
 * After FFprobe enriches a file's stream metadata, evaluate all versions of a
 * media_item by quality and promote the best one to is_default=true.
 *
 * Ranking: max video-stream height (DESC) → file duration_seconds (DESC) →
 * created_at (ASC) for determinism. When only one file exists there is nothing
 * to decide — the function returns early as a no-op.
 *
 * Atomicity: the promotion runs in a single transaction. Because the partial
 * unique index prevents two is_default=true rows for the same media_item_id,
 * we clear all defaults first and then set the winner — order matters.
 *
 * Concurrency safety: uses pg_advisory_xact_lock to serialize concurrent
 * promotions on the same media_item_id, preventing partial-unique-index races.
 * Serializes with linkFileAsVersion's lock on the same media_item_id.
 *
 * @returns `promoted: true` when the default changed, `promoted: false` when
 *   the current default was already the highest-quality file (or only one file).
 *   `chosenFileId` is always the file that ends up as the default after the call.
 *   `oldFileId` is the file that was demoted (only set when `promoted: true`).
 */
export async function promoteHighestQualityVersion(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<{
    promoted: boolean;
    chosenFileId: string | null;
    oldFileId: string | null;
}> {
    // Acquire the advisory lock first, then rank under the locked snapshot.
    // Ranking outside the lock is a TOCTOU bug: a concurrent attachFileToItem
    // or replaceStreamsForFile can change the population between the SELECT
    // and the UPDATE, causing the promotion to act on stale ranking.
    let result: {
        promoted: boolean;
        chosenFileId: string | null;
        oldFileId: string | null;
    } = {
        promoted: false,
        chosenFileId: null,
        oldFileId: null,
    };

    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // Serialize concurrent promotions (and concurrent attaches via
        // attachFileToItem which takes the same lock key).
        await tx`SELECT pg_advisory_xact_lock(hashtext(${mediaItemId}))`;

        // Rank all files for this item by quality under the lock. Falls back
        // to duration when stream metadata is absent (e.g. file not yet probed).
        const ranked = await tx<
            {
                file_id: string;
                is_default: boolean;
                offset_source: string | null;
            }[]
        >`
            SELECT
                mfi.file_id,
                mfi.is_default,
                mfi.offset_source
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            LEFT JOIN LATERAL (
                SELECT MAX(ms.height) AS max_height
                FROM media_streams ms
                WHERE ms.file_id = mfi.file_id
                  AND ms.stream_type = 'video'
            ) vs ON TRUE
            WHERE mfi.media_item_id = ${mediaItemId}
            ORDER BY
                COALESCE(vs.max_height, 0) DESC,
                COALESCE(mf.duration_seconds, 0) DESC,
                mf.created_at ASC,
                mfi.file_id ASC
        `;

        // Nothing to do when there are 0 or 1 files.
        if (ranked.length <= 1) {
            result = {
                promoted: false,
                chosenFileId: ranked[0]?.file_id ?? null,
                oldFileId: null,
            };
            return;
        }

        const currentDefault = ranked.find((r) => r.is_default);

        // An admin linked this file to the item by hand (file-episodes editor):
        // a better-looking version must not take playback away from it.
        if (currentDefault?.offset_source === MANUAL_OFFSET_SOURCE) {
            result = { promoted: false, chosenFileId: currentDefault.file_id, oldFileId: null };
            return;
        }

        const chosenFileId = ranked[0].file_id;

        // Already optimal — skip the write.
        if (currentDefault?.file_id === chosenFileId) {
            result = { promoted: false, chosenFileId, oldFileId: null };
            return;
        }

        // Swap: clear all defaults first (required by partial unique index),
        // then set the winner. Both statements are in the same transaction.
        await tx`
            UPDATE media_file_items
            SET is_default = FALSE
            WHERE media_item_id = ${mediaItemId} AND is_default = TRUE
        `;
        await tx`
            UPDATE media_file_items
            SET is_default = TRUE
            WHERE media_item_id = ${mediaItemId}
              AND file_id = ${chosenFileId}
        `;
        result = {
            promoted: true,
            chosenFileId,
            oldFileId: currentDefault?.file_id ?? null,
        };
    });

    return result;
}

/**
 * `file_path -> media_files.id` for every file under a library path. Lets the
 * scanner's sidecar pass pair subtitles with their video without a
 * `findMediaFileByPath` round trip per sidecar.
 */
export async function loadMediaFileIdsByPrefix(
    sql: postgres.Sql,
    pathPrefix: string,
): Promise<Map<string, string>> {
    const escaped = pathPrefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped.endsWith('/') ? escaped : escaped + '/';
    const rows = await sql<{ id: string; file_path: string }[]>`
        SELECT id, file_path FROM media_files
        WHERE file_path LIKE ${prefix + '%'} ESCAPE '\\'
    `;
    return new Map(rows.map((r) => [r.file_path, r.id]));
}

/**
 * Return all file_path values for media_files rows that belong to a given library path prefix.
 * Used by the stale-file sweep in performScan() to detect files removed from disk.
 */
export async function getMediaFilePathsByLibraryPrefix(
    sql: postgres.Sql,
    pathPrefix: string,
): Promise<string[]> {
    // Escape LIKE wildcards in the path prefix (consistent with findParentMediaItemByFolder)
    const escaped = pathPrefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    // Ensure the prefix ends with / to avoid matching sibling directories
    const prefix = escaped.endsWith('/') ? escaped : escaped + '/';
    const rows = await sql<{ file_path: string }[]>`
        SELECT file_path FROM media_files
        WHERE file_path LIKE ${prefix + '%'} ESCAPE '\\'
    `;
    return rows.map((r) => r.file_path);
}

// ============================================================================
// Probe data queries (Phase 2 — FFprobe enrichment)
// ============================================================================

export interface UpdateProbeDataParams {
    fileId: string;
    containerFormat: string | null;
    durationSeconds: number | null;
    totalBitrate: number | null;
    fileSizeBytes: number | null;
}

/**
 * Store probe metadata on a media_files row and set probed_at timestamp.
 */
export async function updateProbeData(
    sql: postgres.Sql,
    params: UpdateProbeDataParams,
): Promise<void> {
    await sql`
        UPDATE media_files
        SET container_format = ${params.containerFormat},
            duration_seconds = ${params.durationSeconds},
            total_bitrate    = ${params.totalBitrate},
            file_size_bytes  = ${params.fileSizeBytes},
            probed_at        = NOW(),
            updated_at       = NOW()
        WHERE id = ${params.fileId}
    `;
}

/**
 * Store keyframe positions for a media file.
 */
export async function updateKeyframes(
    sql: postgres.Sql,
    fileId: string,
    keyframes: number[],
): Promise<void> {
    await sql`
        UPDATE media_files
        SET keyframes  = ${sql.json(keyframes)},
            updated_at = NOW()
        WHERE id = ${fileId}
    `;
}

/**
 * Get keyframes and file path for a specific file.
 * Used by HLS playback to generate accurate VOD playlists for copy-mode video.
 */
export async function getKeyframesForFile(
    sql: postgres.Sql,
    fileId: string,
): Promise<
    | {
          keyframes: number[] | null;
          file_path: string;
          duration_seconds: number | null;
      }
    | undefined
> {
    const rows = await sql<
        {
            keyframes: number[] | null;
            file_path: string;
            duration_seconds: number | null;
        }[]
    >`
        SELECT keyframes, file_path, duration_seconds
        FROM media_files
        WHERE id = ${fileId}
    `;
    return rows[0];
}

export interface ProbeDataRow {
    file_id: string;
    file_path: string;
    container_format: string | null;
    duration_seconds: number | null;
    total_bitrate: number | null;
    file_size_bytes: number | null;
    keyframes: number[] | null;
}

/**
 * Get probe data for all files linked to a media item.
 * Reserved for the preview player DB-first path (Step 7 — not yet implemented).
 */
export async function getProbeDataForMediaItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<ProbeDataRow[]> {
    return sql<ProbeDataRow[]>`
        SELECT mf.id AS file_id, mf.file_path, mf.container_format,
               mf.duration_seconds, mf.total_bitrate, mf.file_size_bytes,
               mf.keyframes
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${mediaItemId}
          AND mf.probed_at IS NOT NULL
        ORDER BY mf.part_number NULLS FIRST
    `;
}

/**
 * Mark an absent file and recompute every linked item's ancestor chain.
 * Production callers confirm absence again under the locks. The row's MVCC
 * version fences observations made before a newer scan or probe wrote it.
 * Probe queues supply observedVersion from before their first filesystem check;
 * the local snapshot also detects writes committed while waiting for locks.
 */
export async function markFileMissing(
    sql: postgres.Sql,
    fileId: string,
    confirmMissing?: () => Promise<boolean>,
    observedVersion?: string,
): Promise<boolean> {
    return withTx(sql, async (tx) => {
        const [observed] = await tx<{ version: string }[]>`
            SELECT xmin::text AS version FROM media_files WHERE id = ${fileId}::uuid
        `;
        if (!observed || (observedVersion !== undefined && observed.version !== observedVersion))
            return false;
        // File before item locks, matching attachment and manual link editing.
        // Derive links only after the file lock prevents new attachments.
        const [current] = await tx<{ version: string }[]>`
            SELECT xmin::text AS version FROM media_files WHERE id = ${fileId}::uuid FOR UPDATE
        `;
        if (!current || current.version !== observed.version) return false;
        const linked = await tx<{ media_item_id: string }[]>`
            SELECT media_item_id FROM media_file_items WHERE file_id = ${fileId}::uuid
            ORDER BY media_item_id
        `;
        const ids = linked.map((r) => r.media_item_id);
        for (const id of ids) await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
        await lockAncestorChain(tx, ids);
        if (confirmMissing && !(await confirmMissing())) return false;
        await tx`
            UPDATE media_files
            SET is_missing = true, probed_at = NOW(), updated_at = NOW()
            WHERE id = ${fileId}::uuid
        `;
        await recomputeHasFilesBatch(tx, ids);
        return true;
    });
}

/** Restore a scanned file without replacing its metadata or existing links. */
export async function restoreMissingFile(
    sql: postgres.Sql,
    fileId: string,
    confirmPresent: () => Promise<boolean>,
): Promise<boolean> {
    return withTx(sql, async (tx) => {
        const [file] = await tx<{ is_missing: boolean }[]>`
            SELECT is_missing FROM media_files WHERE id = ${fileId}::uuid FOR UPDATE
        `;
        if (!file?.is_missing) return false;
        const linked = await tx<{ media_item_id: string }[]>`
            SELECT media_item_id FROM media_file_items WHERE file_id = ${fileId}::uuid
            ORDER BY media_item_id
        `;
        const ids = linked.map((r) => r.media_item_id);
        for (const id of ids) await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
        await lockAncestorChain(tx, ids);
        if (!(await confirmPresent())) return false;
        await tx`UPDATE media_files SET is_missing = false, probed_at = NULL, updated_at = NOW()
                 WHERE id = ${fileId}::uuid`;
        await recomputeHasFilesBatch(tx, ids);
        return true;
    });
}

/**
 * Clear the missing sentinel so the file re-enters the probe queue.
 *
 * Scanner recovery uses restoreMissingFile(), including unchanged-file triage,
 * to revalidate presence and recompute availability under the same locks. This
 * low-level helper exists for tests and one-off tooling only.
 */
export async function clearFileMissing(sql: postgres.Sql, fileId: string): Promise<void> {
    await sql`
        UPDATE media_files
        SET is_missing = false,
            updated_at = NOW()
        WHERE id = ${fileId}::uuid
    `;
}

/**
 * Count files eligible for Phase A (probed_at IS NULL and linked).
 * Used by the heartbeat to compute a per-phase denominator so progress
 * cannot exceed 100% when a file passes through both phases.
 */
export async function countUnprobedFiles(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<Array<{ c: number }>>`
        SELECT COUNT(*)::int AS c
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mf.probed_at IS NULL
          AND NOT mf.is_missing
    `;
    return row?.c ?? 0;
}

/**
 * Count files eligible for Phase B (probed, has video stream, no keyframes yet,
 * and linked). Used by the heartbeat to compute a per-phase denominator.
 */
export async function countFilesWithoutKeyframes(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<Array<{ c: number }>>`
        SELECT COUNT(*)::int AS c
        FROM media_files mf
        WHERE mf.probed_at IS NOT NULL
          AND mf.keyframes IS NULL
          AND NOT mf.is_missing
          AND EXISTS (
              SELECT 1 FROM media_streams ms
              WHERE ms.file_id = mf.id AND ms.stream_type = 'video'
          )
          AND EXISTS (
              SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id
          )
    `;
    return row?.c ?? 0;
}

/** A row of {@link getUnprobedFiles}. */
export interface UnprobedFileRow {
    id: string;
    /** MVCC generation observed before the probe/absence check. */
    file_version?: string;
    file_path: string;
    /** The stat the scanner committed; media-probe matches it to a scan-time probe. */
    file_mtime: Date | null;
    file_size_bytes: number | null;
    media_item_ids: string[];
}

/**
 * Find files that have never been probed (probed_at IS NULL).
 *
 * Returns one row per physical file with all linked media_item_ids aggregated,
 * so multi-episode files (one file → N episodes) are probed only once.
 *
 * Intentionally does NOT re-fetch probed-but-streamless files: on degenerate
 * inputs (corrupt containers, images accidentally registered as media) a
 * success-with-zero-streams probe would otherwise loop forever. The
 * `media_streams`-reset recovery path that condition historically covered is
 * handled by wipeProcessedData()/invalidateFileProbeData(), both of which
 * null `probed_at` alongside the stream delete.
 *
 * Excludes is_missing rows: files confirmed absent on disk are sentineled so
 * they don't re-enter the FIFO queue every drain cycle.
 */
export async function getUnprobedFiles(
    sql: postgres.Sql,
    limit: number,
): Promise<UnprobedFileRow[]> {
    return sql<UnprobedFileRow[]>`
        SELECT mf.id, mf.file_path, mf.file_mtime, mf.file_size_bytes, mf.xmin::text AS file_version,
               array_agg(mfi.media_item_id) AS media_item_ids
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mf.probed_at IS NULL
          AND NOT mf.is_missing
        GROUP BY mf.id, mf.file_path, mf.file_mtime, mf.file_size_bytes, mf.xmin
        ORDER BY mf.created_at ASC, mf.id ASC
        LIMIT ${limit}
    `;
}

/**
 * Of the given media_item ids, return the subset that have MORE THAN ONE
 * media_file linked. Used by the probe Phase-A hot path to skip
 * `promoteHighestQualityVersion` for single-file items: that function is a
 * no-op when an item has one file, but only after it has opened a transaction,
 * taken a `pg_advisory_xact_lock`, and run a 3-table ranking SELECT. On a fresh
 * import nearly every item has exactly one file, so checking membership here
 * (one cheap batched query per slice) avoids N advisory-lock transactions.
 */
export async function loadMultiFileItemIds(
    sql: postgres.Sql,
    mediaItemIds: string[],
): Promise<Set<string>> {
    if (mediaItemIds.length === 0) return new Set<string>();
    const rows = await sql<{ media_item_id: string }[]>`
        SELECT media_item_id
        FROM media_file_items
        WHERE media_item_id = ANY(${mediaItemIds}::uuid[])
        GROUP BY media_item_id
        HAVING COUNT(*) > 1
    `;
    return new Set(rows.map((r) => r.media_item_id));
}

/**
 * Find files that have been probed but don't have keyframes yet.
 * Returns duration_seconds so Phase B can detect truncated files.
 *
 * Ordering: `probed_at ASC` is the primary sort (oldest probes first, so the
 * catchup drain works through the tail of the backlog first). `mf.id ASC` is
 * appended as a tiebreaker so rows sharing a `probed_at` timestamp — common
 * after a bulk probe — appear in a stable order across fetches. Without the
 * tiebreaker drain-backlog's `no-progress` signature would silently shuffle
 * and the detector would misfire (it uses a count + first-id + last-id
 * comparison that assumes deterministic row order).
 *
 * Excludes is_missing rows for the same reason as getUnprobedFiles.
 */
export async function getFilesWithoutKeyframes(
    sql: postgres.Sql,
    limit: number,
): Promise<
    {
        id: string;
        file_version?: string;
        file_path: string;
        duration_seconds: number | null;
        file_size_bytes: number | null;
        media_item_ids: string[];
    }[]
> {
    // media_item_ids[] mirrors getUnprobedFiles' shape so the caller can mark
    // every linked media_item's `media-probe-b` stage_state row as
    // `completed` after a successful keyframe probe. Without this, the
    // per-file work succeeds but the per-item gate stays `pending`, the
    // stage-sweep tick keeps finding the same rows eligible, and the
    // handler runs forever to keyframe files that already have keyframes
    // (because getFilesWithoutKeyframes filters by `keyframes IS NULL` —
    // the file is done, but the stage_state row is the source of truth
    // that stage-sweep consults).
    return sql<
        {
            id: string;
            file_version?: string;
            file_path: string;
            duration_seconds: number | null;
            file_size_bytes: number | null;
            media_item_ids: string[];
        }[]
    >`
        SELECT mf.id, mf.file_path, mf.duration_seconds, mf.file_size_bytes, mf.xmin::text AS file_version,
               array_agg(mfi.media_item_id) AS media_item_ids
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mf.probed_at IS NOT NULL
          AND mf.keyframes IS NULL
          AND NOT mf.is_missing
          AND EXISTS (
              SELECT 1 FROM media_streams ms
              WHERE ms.file_id = mf.id AND ms.stream_type = 'video'
          )
        GROUP BY mf.id, mf.file_path, mf.duration_seconds, mf.file_size_bytes, mf.probed_at, mf.xmin
        ORDER BY mf.probed_at ASC, mf.id ASC
        LIMIT ${limit}
    `;
}

// ============================================================================
// Change detection queries (Phase 3 — file change invalidation)
// ============================================================================

/**
 * Update stored mtime and size after a stat check.
 * Called on every scan for known files to keep the baseline current.
 */
export async function updateFileStat(
    sql: postgres.Sql,
    fileId: string,
    mtime: Date,
    sizeBytes: number,
    hashHead?: string | null,
): Promise<void> {
    if (hashHead !== undefined) {
        await sql`
            UPDATE media_files
            SET file_mtime       = ${mtime},
                file_size_bytes  = ${sizeBytes},
                file_hash_head   = ${hashHead},
                updated_at       = NOW()
            WHERE id = ${fileId}
        `;
    } else {
        await sql`
            UPDATE media_files
            SET file_mtime       = ${mtime},
                file_size_bytes  = ${sizeBytes},
                updated_at       = NOW()
            WHERE id = ${fileId}
        `;
    }
}

/**
 * Store `snapshot` (the file's stat from before the scanner read it) as the
 * row's change-detection mtime/size when the file changed while it was being
 * processed — a copy still in progress. The probe/tags describe the snapshot,
 * so the next scan must see a change and read the file again; committing the
 * final stat (what initFileChangeDetection does after the probe) made the row
 * read `unchanged` forever. The head hash is cleared too, so a change that kept
 * the size (only the mtime moved) is not judged by a hash of the new bytes.
 */
export async function keepProbedFileStat(
    sql: postgres.Sql,
    filePath: string,
    snapshot: { mtime: Date; size: number },
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        UPDATE media_files
        SET file_mtime      = ${snapshot.mtime},
            file_size_bytes = ${snapshot.size},
            file_hash_head  = NULL,
            updated_at      = NOW()
        WHERE file_path = ${filePath}
          AND (file_size_bytes IS DISTINCT FROM ${snapshot.size}
               OR file_mtime IS NULL
               OR abs(extract(epoch FROM (file_mtime - ${snapshot.mtime}::timestamptz))) > 1)
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Invalidate probe data for a file whose contents changed on disk.
 *
 * In a single transaction:
 * 1. Deletes all media_streams for linked media_items
 * 2. Deletes episode_chapters for this file (stale after content change)
 * 3. Deletes trickplay_params and the changed file's terminal attempt marker
 *    for linked items (forces re-generation)
 * 4. Clears probe fields (probed_at, keyframes, etc.)
 *
 * Setting probed_at = NULL makes the file appear in getUnprobedFiles() so the
 * media-probe plugin automatically re-probes it on the next cycle.
 */
/**
 * Resolve a file's path by file ID, verifying it belongs to the given media item.
 * Returns the file_path or null if the file doesn't exist or isn't linked.
 */
export async function getFilePathForMediaItem(
    sql: postgres.Sql,
    fileId: string,
    mediaItemId: string,
): Promise<string | null> {
    const rows = await sql<{ file_path: string }[]>`
        SELECT mf.file_path
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mf.id = ${fileId}
          AND mfi.media_item_id = ${mediaItemId}
        LIMIT 1
    `;
    return rows[0]?.file_path ?? null;
}

/**
 * Return the file_path of the first file linked to a track (media_item).
 * Used by the lyrics API to locate the audio file on disk for sidecar writing.
 */
export async function findMediaFilePathForTrack(
    sql: postgres.Sql,
    trackId: string,
): Promise<string | null> {
    const rows = await sql<{ file_path: string }[]>`
        SELECT mf.file_path
        FROM media_file_items mfi
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE mfi.media_item_id = ${trackId}
        LIMIT 1
    `;
    return rows[0]?.file_path ?? null;
}

export async function invalidateFileProbeData(
    sql: postgres.Sql,
    fileId: string,
): Promise<{ invalidatedMediaItemIds: string[] }> {
    const result = await withTx(sql, async (txRaw) => {
        // postgres.js types TransactionSql and Sql as distinct generics despite
        // being structurally compatible at runtime; cast via unknown to satisfy them.
        const tx = txRaw as unknown as postgres.Sql;

        // 1. Acquire a row lock on media_files FIRST, before any dependent
        //    deletes. The media-probe plugin's wipe path takes locks in the
        //    order (media_files FOR UPDATE → DELETE media_streams), so any
        //    caller that touches both tables must follow the same order or
        //    they deadlock when a wipe and an invalidate hit the same file
        //    concurrently (scanner detects file change mid-wipe). Without
        //    the explicit lock here we would implicitly order the other way:
        //    media_streams first, then media_files via the final UPDATE.
        await tx`SELECT 1 FROM media_files WHERE id = ${fileId} FOR UPDATE`;

        // 2. Collect linked media item IDs before deleting dependent data
        const linked = await tx<{ media_item_id: string }[]>`
            SELECT media_item_id FROM media_file_items WHERE file_id = ${fileId}
        `;
        const mediaItemIds = [
            ...new Set(linked.map((r: { media_item_id: string }) => r.media_item_id)),
        ];

        // 3. Delete streams for this file
        await tx`DELETE FROM media_streams WHERE file_id = ${fileId}`;

        // 4. Delete chapters for this file (content changed = chapters are stale)
        await tx`DELETE FROM episode_chapters WHERE file_id = ${fileId}`;

        // 5. Delete intro/outro segments for linked items (timestamps are stale
        //    when the underlying file content changes) — and the detector
        //    evidence behind them, or the next resolution pass silently
        //    re-materializes the timings of an encode that no longer exists.
        //
        //    The operator's own `manual` candidate is NOT deleted: it is
        //    DEMOTED to `stale-manual`, a method the resolver never
        //    materializes. A re-encode shifts timings, so a stale human answer
        //    is as wrong as a bad detector — but it is also the only record
        //    that a human ever looked at this item, and re-confirming it in
        //    admin is one click against re-deriving it from scratch.
        //
        //    Order is load-bearing: the delete below clears any PREVIOUS
        //    `stale-manual` row first, so the demotion cannot collide with it
        //    on `UNIQUE (media_id, type, method)` and abort this whole
        //    transaction the second time a file changes.
        if (mediaItemIds.length > 0) {
            await acquireMediaSegmentResolutionLocks(tx, mediaItemIds);
            await bumpMediaSegmentAnalysisGeneration(tx, mediaItemIds);
            await tx`
                DELETE FROM media_segment_candidates
                WHERE media_id = ANY(${mediaItemIds})
                  AND method <> 'manual'
            `;
            await tx`
                UPDATE media_segment_candidates
                SET method = 'stale-manual',
                    updated_at = NOW()
                WHERE media_id = ANY(${mediaItemIds})
                  AND method = 'manual'
            `;
            await tx`DELETE FROM media_segments WHERE media_id = ANY(${mediaItemIds})`;
        }

        // 6. Delete this file's trickplay params for ALL linked items so the sync
        //    plugin regenerates them. A shared file affects every linked episode,
        //    while unrelated alternate files retain their own derived params.
        //    Without this, trickplay_params rows persist forever because the sync
        //    plugin only processes items with no row.
        if (mediaItemIds.length > 0) {
            await tx`
                DELETE FROM trickplay_params
                 WHERE media_item_id = ANY(${mediaItemIds})
                   AND file_id = ${fileId}
            `;
            // `no-provider` / `error` markers are per file, not per source
            // generation. The replacement keeps the same file ID, so an old
            // current-version marker would otherwise suppress the missing
            // params row and let coverage certify the changed bytes as done.
            // Clear it in the same transaction as the derived params. Other
            // files' markers remain valid, and anomalous scalar JSON is left
            // alone rather than passed to jsonb object operators.
            const markerKey = `trickplay-params:${fileId}`;
            await tx`
                UPDATE media_items
                   SET processing_state = processing_state - ${markerKey}
                 WHERE id = ANY(${mediaItemIds})
                   AND jsonb_typeof(processing_state) = 'object'
                   AND processing_state ? ${markerKey}
            `;
        }

        // 7. Delete locally-extracted artwork (video frame thumbnails) so the
        //    image-sync plugin re-extracts from the new file content.
        //
        //    Clearing the paired `media_items.custom_{type}_url` is NOT optional
        //    bookkeeping: a local artwork row and its serve URL are one fact
        //    written in two places, and `upsertLocalArtwork` only ever claims a
        //    column that is NULL. Leave the pointer standing and the re-extracted
        //    artwork can never re-publish itself — the column is already taken by
        //    a URL whose row (and whose JPG, unlinked by the caller) is gone, so
        //    `/api/image/custom/<id>/<type>` serves a permanent miss. This is the
        //    same guarded UPDATE as `deleteLocalArtworkForItem`: the LIKE pattern
        //    matches only our own proxy endpoint for THIS item, so a TMDB/Jellyfin
        //    URL or an admin upload pointing elsewhere is never clobbered.
        if (mediaItemIds.length > 0) {
            await tx`
                DELETE FROM image_candidates
                WHERE media_item_id = ANY(${mediaItemIds})
                  AND source = 'local' AND NOT locked
            `;
            await tx`
                UPDATE media_items
                SET custom_poster_url   = CASE WHEN custom_poster_url   LIKE '/api/image/custom/' || id || '/%' AND NOT EXISTS (SELECT 1 FROM image_candidates a WHERE a.media_item_id = media_items.id AND a.artwork_type = 'poster' AND a.locked) THEN NULL ELSE custom_poster_url   END,
                    custom_backdrop_url = CASE WHEN custom_backdrop_url LIKE '/api/image/custom/' || id || '/%' AND NOT EXISTS (SELECT 1 FROM image_candidates a WHERE a.media_item_id = media_items.id AND a.artwork_type = 'backdrop' AND a.locked) THEN NULL ELSE custom_backdrop_url END,
                    custom_logo_url     = CASE WHEN custom_logo_url     LIKE '/api/image/custom/' || id || '/%' AND NOT EXISTS (SELECT 1 FROM image_candidates a WHERE a.media_item_id = media_items.id AND a.artwork_type = 'logo' AND a.locked) THEN NULL ELSE custom_logo_url     END,
                    custom_thumb_url    = CASE WHEN custom_thumb_url    LIKE '/api/image/custom/' || id || '/%' AND NOT EXISTS (SELECT 1 FROM image_candidates a WHERE a.media_item_id = media_items.id AND a.artwork_type = 'thumb' AND a.locked) THEN NULL ELSE custom_thumb_url    END
                WHERE id = ANY(${mediaItemIds})
            `;
        }

        // 8. Clear music analysis processing_state so tracks are re-analyzed
        //    with the new file content (BPM, key, beat grid, etc.). All
        //    Essentia-owned fields live under custom_metadata.essentia, so
        //    dropping that single key discards the entire prior analysis.
        if (mediaItemIds.length > 0) {
            await tx`
                UPDATE media_items
                SET processing_state = processing_state - 'music-analysis',
                    custom_metadata = custom_metadata - 'essentia'
                WHERE id = ANY(${mediaItemIds})
                  AND jsonb_typeof(processing_state) = 'object'
                  AND processing_state ? 'music-analysis'
            `;
        }

        // 9. Clear probe data so the file is re-probed.
        //    file_size_bytes and file_hash_head are NOT cleared here — they are
        //    filesystem metadata maintained by updateFileStat(), not probe data.
        await tx`
            UPDATE media_files
            SET probed_at        = NULL,
                keyframes        = NULL,
                container_format = NULL,
                duration_seconds = NULL,
                total_bitrate    = NULL,
                health_issues    = NULL,
                health_tail_assessment = NULL,
                updated_at       = NOW()
            WHERE id = ${fileId}
        `;

        return mediaItemIds;
    });

    return { invalidatedMediaItemIds: result };
}

// ============================================================================
// Health issue queries
// ============================================================================

/**
 * Update health issues for a media file.
 * Pass null or empty array to clear issues.
 *
 * @param auditRunJobId - BullMQ job id of the run that detected the issues.
 *   Pass the job id when issues is non-empty so listFailedItems can JOIN
 *   task_history to surface the integer run id. Pass null (or omit) on a
 *   clean re-probe to clear the field alongside health_issues.
 */
export async function updateHealthIssues(
    sql: postgres.Sql,
    fileId: string,
    issues: FileHealthIssue[] | null,
    auditRunJobId?: string | null,
): Promise<void> {
    const value =
        issues && issues.length > 0 ? sql.json(issues as unknown as postgres.JSONValue) : null;
    await sql`
        UPDATE media_files
        SET health_issues        = ${value},
            audit_run_job_id     = ${auditRunJobId ?? null},
            updated_at           = NOW()
        WHERE id = ${fileId}
    `;
}

export interface FileHealthRow {
    file_id: string;
    file_path: string;
    duration_seconds: number | null;
    health_issues: FileHealthIssue[];
    media_item_id: string | null;
    title: string | null;
    media_type: string | null;
    year: number | null;
}

/**
 * Record (or refresh) a scan failure on a file by path. Creates a stub
 * `media_files` row when none exists yet — this covers the case where
 * tag parsing fails before the row would normally be inserted, so the
 * scanner has somewhere to remember the failure across runs.
 *
 * On repeat failures the `attempt_count` increments and `next_retry_at`
 * gets pushed out via {@link nextRetryAtForAttempt} so the scanner can
 * skip files that persistently fail without wasting the 30s parseFile
 * timeout on every pass.
 *
 * Returns the resulting health-issue record so callers can log
 * attempt_count and next_retry_at at warn level.
 */
export async function recordFileScanIssue(
    sql: postgres.Sql,
    args: {
        filePath: string;
        libraryGroupId?: string | null;
        // Every value this function writes means "recorded INSTEAD OF a
        // media_item link" — the same subset the Ingest Map and orphan
        // cleanup key off (see UNLINKED_FILE_HEALTH_ISSUE_TYPES).
        type: (typeof UNLINKED_FILE_HEALTH_ISSUE_TYPES)[number];
        detail?: string;
    },
): Promise<FileHealthIssue> {
    // Wrap in a transaction with a per-file-path advisory lock so concurrent
    // failure scans of the same file serialize. Without this the SELECT-then-
    // INSERT/UPDATE shape was a TOCTOU: two workers both saw `attempt_count=N`,
    // both wrote `N+1`, and the second clobbered the first — attempt_count
    // would plateau and the exponential backoff never kicked in. The lock is
    // released at COMMIT.
    return await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${args.filePath}, 0))`;

        const [existing] = await tx<{ id: string; health_issues: FileHealthIssue[] | null }[]>`
            SELECT id, health_issues FROM media_files
             WHERE file_path = ${args.filePath} LIMIT 1
        `;
        const priorIssues = existing?.health_issues ?? [];
        const priorMatch = priorIssues.find((i) => i.type === args.type);
        const attemptCount = (priorMatch?.attempt_count ?? 0) + 1;
        const issue: FileHealthIssue = {
            type: args.type,
            detected_at: new Date().toISOString(),
            attempt_count: attemptCount,
            ...(args.detail !== undefined ? { detail: args.detail } : {}),
        };
        const retryAt = nextRetryAtForAttempt(attemptCount);
        if (retryAt) issue.next_retry_at = retryAt;
        // Preserve unrelated issue types so an existing duration_mismatch on
        // the same file doesn't get dropped by a tag-parse failure update.
        const otherIssues = priorIssues.filter((i) => i.type !== args.type);
        const merged = [...otherIssues, issue];
        const issuesJson = tx.json(merged as unknown as postgres.JSONValue);
        if (existing) {
            // Refresh `library_group_id` on UPDATE so a stub originally
            // written from a library with a null group id picks up the
            // correct one when the file is later (re-)seen under a known
            // library. COALESCE keeps existing non-null values stable.
            await tx`
                UPDATE media_files
                   SET health_issues    = ${issuesJson},
                       library_group_id = COALESCE(${args.libraryGroupId ?? null}, library_group_id),
                       updated_at       = NOW()
                 WHERE id = ${existing.id}
            `;
        } else {
            await tx`
                INSERT INTO media_files (file_path, library_group_id, health_issues)
                VALUES (${args.filePath}, ${args.libraryGroupId ?? null}, ${issuesJson})
                ON CONFLICT (file_path) DO UPDATE
                SET health_issues    = ${issuesJson},
                    library_group_id = COALESCE(EXCLUDED.library_group_id, media_files.library_group_id),
                    updated_at       = NOW()
            `;
        }
        return issue;
    });
}

export interface ItemFileHealthIssue {
    file_id: string;
    file_path: string;
    /** The owning item — differs from the queried id for a series/season. */
    media_item_id: string;
    media_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    issues: Array<FileHealthIssue & { reviewed?: boolean }>;
}

/**
 * File-health issues across an item AND its descendants, for the media detail
 * page's Overview summary.
 *
 * Walks two levels down (series → season → episode) so a series overview says
 * something instead of nothing — the issues always live on the episode's file,
 * never on the series row, and an admin landing on the series is exactly the
 * person who needs to know a download is broken. Same tree the Files tab uses
 * with `?children=true`.
 */
export async function getFileHealthIssuesForItemTree(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<ItemFileHealthIssue[]> {
    return sql<ItemFileHealthIssue[]>`
        SELECT mf.id       AS file_id,
               mf.file_path,
               mfi.media_item_id,
               mi.title    AS media_title,
               mi.season_number,
               mi.episode_number,
               CASE WHEN jsonb_typeof(mf.health_issues) = 'array'
                    THEN COALESCE(bounded_issues.value, '[]'::jsonb)
                    ELSE jsonb_build_array(jsonb_build_object(
                         'type', 'unknown_recorded_evidence', 'detected_at', mf.updated_at::text)) END AS issues
          FROM media_files mf
          JOIN media_file_items mfi ON mfi.file_id = mf.id
          JOIN media_items mi ON mi.id = mfi.media_item_id
          LEFT JOIN LATERAL (
              SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                  'type', CASE WHEN jsonb_typeof(issue->'type') = 'string' AND length(issue->>'type') BETWEEN 1 AND 80
                    THEN issue->>'type' ELSE 'unknown_recorded_evidence' END,
                  'detected_at', COALESCE(left(issue->>'detected_at', 80), mf.updated_at::text),
                  'detail', left(issue->>'detail', 2048),
                  'reviewed', ${currentHealthIssueReviewSql(sql, sql`mf.id`, sql`issue`)},
                  'expected_duration', CASE WHEN jsonb_typeof(issue->'expected_duration') = 'number' THEN issue->'expected_duration' END,
                  'actual_duration', CASE WHEN jsonb_typeof(issue->'actual_duration') = 'number' THEN issue->'actual_duration' END
              ))) AS value
              FROM (SELECT issue FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(mf.health_issues) = 'array'
                       THEN mf.health_issues ELSE '[]'::jsonb END
              ) AS entry(issue) LIMIT 20) first_issues
          ) bounded_issues ON true
         WHERE mfi.media_item_id IN (
                   SELECT id FROM media_items WHERE id = ${mediaItemId}::uuid
                   UNION ALL
                   SELECT id FROM media_items WHERE parent_id = ${mediaItemId}::uuid
                   UNION ALL
                   SELECT ep.id FROM media_items ep
                     JOIN media_items s ON s.id = ep.parent_id
                    WHERE s.parent_id = ${mediaItemId}::uuid
               )
           AND ${actionableFileHealthSql(sql, sql`mf.id`)}
         ORDER BY mi.season_number NULLS FIRST, mi.episode_number NULLS FIRST, mf.file_path
    `;
}

/** Issue types recorded by decode-time analysis rather than the scanner. */
export type DecodeHealthIssueType =
    'container_unreadable' | 'video_ends_early' | 'video_decode_gaps';

/**
 * Record a decode-time health issue against a file by its `media_files.id`.
 *
 * Split from {@link recordFileScanIssue} on purpose: that one is keyed by
 * `file_path` and may INSERT a stub row for a file the scanner refused, which
 * is exactly wrong here — trickplay only ever runs on a file that is already
 * linked to a media item, and creating a second row for the same media under a
 * slightly different path would fork its identity.
 *
 * Merges by type (preserving unrelated issues, same as the scanner path) and
 * keeps `attempt_count` climbing so repeat offenders are visible.
 */
export async function recordDecodeHealthIssue(
    sql: postgres.Sql,
    args: {
        fileId: string;
        type: DecodeHealthIssueType;
        /** Verbatim reason — the exact ffmpeg error, including where. */
        detail: string;
        expectedDuration?: number;
        actualDuration?: number;
    },
): Promise<void> {
    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // Same TOCTOU guard as recordFileScanIssue: two concurrent trickplay
        // runs on different sources of one item can land here at once.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${args.fileId}, 0))`;

        const [existing] = await tx<{ health_issues: FileHealthIssue[] | null }[]>`
            SELECT health_issues FROM media_files WHERE id = ${args.fileId}::uuid LIMIT 1
        `;
        // No row → the file was unlinked mid-run; nothing to annotate.
        if (!existing) return;

        const priorIssues = existing.health_issues ?? [];
        const priorMatch = priorIssues.find((i) => i.type === args.type);
        const issue: FileHealthIssue = {
            type: args.type,
            detected_at: new Date().toISOString(),
            attempt_count: (priorMatch?.attempt_count ?? 0) + 1,
            detail: args.detail,
            ...(args.expectedDuration !== undefined
                ? { expected_duration: args.expectedDuration }
                : {}),
            ...(args.actualDuration !== undefined ? { actual_duration: args.actualDuration } : {}),
        };
        const merged = [...priorIssues.filter((i) => i.type !== args.type), issue];
        await tx`
            UPDATE media_files
               SET health_issues = ${tx.json(merged as unknown as postgres.JSONValue)},
                   updated_at    = NOW()
             WHERE id = ${args.fileId}::uuid
        `;
    });
}

/** Acquire the health-writer lock before taking any file row lock. Requires a transaction. */
export async function lockFileHealthIssues(
    sql: postgres.Sql,
    fileId: string,
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    await sql`SET LOCAL lock_timeout = '5s'`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${fileId}, 0))`;
    signal?.throwIfAborted();
}

/**
 * Remove only the issue snapshots actually disproved by a probe. The shared
 * decode-writer lock and current-row read preserve concurrent evidence, even
 * a newer issue of the same type. Callers may wrap this in withTx to resolve
 * failure events while the same lock is still held.
 */
export async function removeReviewedHealthIssues(
    sql: postgres.Sql,
    fileId: string,
    reviewed: FileHealthIssue[],
    signal?: AbortSignal,
): Promise<{ removed: number; remaining: FileHealthIssue[] } | null> {
    signal?.throwIfAborted();
    return withTx(sql, async (tx) => {
        signal?.throwIfAborted();
        await lockFileHealthIssues(tx, fileId);
        const [existing] = await tx<{ health_issues: FileHealthIssue[] | null }[]>`
            SELECT health_issues FROM media_files WHERE id = ${fileId}::uuid FOR UPDATE
        `;
        if (!existing) return null;
        signal?.throwIfAborted();
        // Compare JSONB values in PostgreSQL: object key order is immaterial.
        // The predicate runs on the locked current list, never the probe snapshot.
        const [updated] = await tx<{ health_issues: FileHealthIssue[] | null }[]>`
            UPDATE media_files
            SET health_issues = (
                    SELECT NULLIF(jsonb_agg(issue ORDER BY ordinal), '[]'::jsonb)
                    FROM jsonb_array_elements(COALESCE(health_issues, '[]'::jsonb))
                         WITH ORDINALITY AS issues(issue, ordinal)
                    WHERE NOT (issue = ANY(ARRAY(
                        SELECT value FROM jsonb_array_elements(
                            ${tx.json(reviewed as unknown as postgres.JSONValue)}::jsonb
                        )
                    )))
                ),
                updated_at = NOW()
            WHERE id = ${fileId}::uuid
            RETURNING health_issues
        `;
        signal?.throwIfAborted();
        const remaining = updated.health_issues ?? [];
        const removed = (existing.health_issues?.length ?? 0) - remaining.length;
        if (removed > 0 && remaining.length === 0) {
            await tx`UPDATE media_files SET audit_run_job_id = NULL WHERE id = ${fileId}::uuid`;
        }
        signal?.throwIfAborted();
        return { removed, remaining };
    });
}

/** Refresh unchanged reviewed observations; retain newer concurrent and unrelated evidence. */
export async function addRecheckedHealthIssues(
    sql: postgres.Sql,
    fileId: string,
    issues: FileHealthIssue[],
    signal?: AbortSignal,
    reviewed: FileHealthIssue[] = [],
    auditJobId?: string,
): Promise<void> {
    if (issues.length === 0) return;
    await withTx(sql, async (tx) => {
        signal?.throwIfAborted();
        await lockFileHealthIssues(tx, fileId);
        const [row] = await tx<{ health_issues: FileHealthIssue[] | null; unchanged: boolean[] }[]>`
            SELECT health_issues, ARRAY(
                SELECT issue = ANY(ARRAY(SELECT value FROM jsonb_array_elements(${tx.json(reviewed as unknown as postgres.JSONValue)}::jsonb)))
                FROM jsonb_array_elements(COALESCE(health_issues, '[]'::jsonb)) AS issue
            ) AS unchanged
            FROM media_files WHERE id = ${fileId}::uuid FOR UPDATE
        `;
        if (!row) throw new Error('File not found');
        const current = row.health_issues ?? [];
        const merged = [
            ...current.map((issue, index) =>
                row.unchanged[index]
                    ? (issues.find((fresh) => fresh.type === issue.type) ?? issue)
                    : issue,
            ),
            ...issues.filter((i) => !current.some((c) => c.type === i.type)),
        ];
        signal?.throwIfAborted();
        await tx`UPDATE media_files
            SET health_issues = ${tx.json(merged as unknown as postgres.JSONValue)},
                audit_run_job_id = COALESCE(audit_run_job_id, ${auditJobId ?? null}), updated_at = NOW()
            WHERE id = ${fileId}::uuid`;
        signal?.throwIfAborted();
    });
}

/** Read one physical file without depending on library links or failure history. */
export async function getFileHealthSnapshot(
    sql: postgres.Sql,
    fileId: string,
): Promise<{ health_issues: FileHealthIssue[] | null } | undefined> {
    const [row] = await sql<{ health_issues: FileHealthIssue[] | null }[]>`
        SELECT health_issues FROM media_files WHERE id = ${fileId}::uuid LIMIT 1
    `;
    return row;
}

/**
 * Drop decode-time issues from a file once it decodes cleanly again (a
 * replaced download, a remux). Unrelated scanner-recorded issues are left
 * alone, mirroring {@link clearFileScanIssue}.
 */
export async function clearDecodeHealthIssues(
    sql: postgres.Sql,
    fileId: string,
    types: DecodeHealthIssueType[],
): Promise<void> {
    // Same advisory lock its sibling recordDecodeHealthIssue takes, and for the
    // same reason. This read the issue list and wrote a filtered copy back as
    // two separate statements, so a concurrent record on the same file landing
    // between them was computed away — the clear wrote a `remaining` derived
    // from a list that no longer existed, silently dropping the issue just
    // recorded. Both halves must run under one lock or neither is protected.
    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fileId}, 0))`;

        const [existing] = await tx<{ health_issues: FileHealthIssue[] | null }[]>`
            SELECT health_issues FROM media_files WHERE id = ${fileId}::uuid LIMIT 1
        `;
        if (!existing?.health_issues) return;
        const remaining = existing.health_issues.filter(
            (i) => !types.includes(i.type as DecodeHealthIssueType),
        );
        if (remaining.length === existing.health_issues.length) return;
        await tx`
            UPDATE media_files
               SET health_issues = ${
                   remaining.length > 0 ? tx.json(remaining as unknown as postgres.JSONValue) : null
               },
                   updated_at    = NOW()
             WHERE id = ${fileId}::uuid
        `;
    });
}

/**
 * Drop a specific scan-failure issue type from a file after a successful
 * scan/parse pass. Leaves unrelated issues in place (e.g. an unresolved
 * `truncated_video` keeps showing in the admin UI even when tag parsing
 * subsequently succeeds).
 *
 * If clearing produces an empty array AND the file is orphaned (no
 * media_file_items link), the next `cleanupOrphanedMediaFiles` run will
 * GC the stub row — no separate cleanup needed here.
 */
export async function clearFileScanIssue(
    sql: postgres.Sql,
    filePath: string,
    types: FileHealthIssue['type'] | FileHealthIssue['type'][],
): Promise<void> {
    // Accepts an array so a caller can drop multiple issue types in one
    // round-trip — the audio scanner clears both `tag_parse_timeout` and
    // `tag_parse_corrupt` on every successful parse, and doing that as
    // two separate (SELECT + UPDATE) pairs was 4 round-trips per audio
    // file (~200k extra DB reads on a 50k-track library full re-scan).
    const typeList = Array.isArray(types) ? types : [types];
    const [existing] = await sql<{ id: string; health_issues: FileHealthIssue[] | null }[]>`
        SELECT id, health_issues FROM media_files WHERE file_path = ${filePath} LIMIT 1
    `;
    if (!existing?.health_issues) return;
    const remaining = existing.health_issues.filter((i) => !typeList.includes(i.type));
    if (remaining.length === existing.health_issues.length) return;
    await sql`
        UPDATE media_files
           SET health_issues = ${
               remaining.length > 0 ? sql.json(remaining as unknown as postgres.JSONValue) : null
           },
               updated_at    = NOW()
         WHERE id = ${existing.id}
    `;
}

/**
 * Remember a multi-episode file whose every episode has a file of its own
 * (`range_superseded`), on a stub row with no media-item link. The row carries
 * the file's mtime and size and the covering files, so the full scan can skip
 * the file while it is unchanged and every covering file is still there
 * (`partitionSupersededRangeFiles`). Without the row the file was new to every
 * scan: probed, parsed and walked through the series hierarchy each time.
 *
 * Replaces an earlier `range_superseded` entry and keeps every other issue.
 * No attempt count or retry time: this is a verdict about the file's
 * neighbours, re-checked whenever one of them goes away, not a failure to back
 * off from.
 */
export async function recordRangeSupersededFile(
    sql: postgres.Sql,
    args: {
        filePath: string;
        libraryGroupId: string | null;
        supersededBy: readonly string[];
        mtime: Date;
        size: number;
        /** Source row observed before the caller stat; absent callers never rewrite existing stats. */
        expectedVersion?: string;
    },
): Promise<void> {
    if (args.supersededBy.length === 0) {
        throw new Error('Range coverage requires at least one covering file.');
    }
    const issue: FileHealthIssue = {
        type: 'range_superseded',
        detected_at: new Date().toISOString(),
        detail: 'Every episode of this multi-episode file has a file of its own, so it is not linked. It is linked again when one of those files is removed.',
        superseded_by: [...args.supersededBy],
    };
    await withTx(sql, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${args.filePath}, 0))`;
        const [existing] = await tx<
            { health_issues: FileHealthIssue[] | null; file_version: string }[]
        >`
            SELECT health_issues, xmin::text AS file_version FROM media_files WHERE file_path = ${args.filePath} LIMIT 1 FOR UPDATE
        `;
        if (args.expectedVersion && existing && existing.file_version !== args.expectedVersion)
            return;
        const issuesJson = tx.json([issue] as unknown as postgres.JSONValue);
        await tx`
            INSERT INTO media_files (file_path, library_group_id, health_issues, file_mtime, file_size_bytes)
            VALUES (${args.filePath}, ${args.libraryGroupId}, ${issuesJson}, ${args.mtime}, ${args.size})
            ON CONFLICT (file_path) DO UPDATE
            SET health_issues = COALESCE((
                    SELECT jsonb_agg(prior) FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(media_files.health_issues) = 'array'
                            THEN media_files.health_issues ELSE '[]'::jsonb END
                    ) prior WHERE prior->>'type' IS DISTINCT FROM 'range_superseded'
                ), '[]'::jsonb) || EXCLUDED.health_issues,
                file_mtime = CASE WHEN ${args.expectedVersion ?? null}::text IS NOT NULL THEN EXCLUDED.file_mtime ELSE media_files.file_mtime END,
                file_size_bytes = CASE WHEN ${args.expectedVersion ?? null}::text IS NOT NULL THEN EXCLUDED.file_size_bytes ELSE media_files.file_size_bytes END,
                updated_at       = NOW()
            -- Linked meanwhile (another worker, the watcher): not superseded.
            WHERE NOT EXISTS (
                SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = media_files.id
            )
        `;
        await tx`DELETE FROM file_range_mapping_proofs WHERE file_id IN (SELECT id FROM media_files WHERE file_path = ${args.filePath})`;
    });
}

/**
 * Drop a `range_superseded` verdict from a file that is linked again (a
 * covering file went away), whichever path linked it: the series hierarchy, a
 * rename reclaim, a version link. One statement that matches nothing for
 * every other file.
 */
export async function clearRangeSupersededIfLinked(
    sql: postgres.Sql,
    filePath: string,
    invalidRange = false,
): Promise<void> {
    await sql`
        UPDATE media_files mf
           SET health_issues = (
                   SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_agg(i) END
                     FROM jsonb_array_elements(mf.health_issues) i
                    WHERE i->>'type' <> 'range_superseded'
               ),
               updated_at = NOW()
         WHERE mf.file_path = ${filePath}
           AND mf.health_issues @> '[{"type":"range_superseded"}]'::jsonb
           AND (${invalidRange} OR EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id))
    `;
}

/**
 * Multi-episode files recorded as superseded by `removedPath`
 * ({@link recordRangeSupersededFile}), under `pathPrefix`. When a covering
 * file is removed they must be ingested again: the episode it covered now has
 * no file. Prefix-bounded so the containment test runs over one library's rows.
 */
export async function findRangeFilesSupersededBy(
    sql: postgres.Sql,
    removedPath: string,
    pathPrefix: string,
): Promise<string[]> {
    const escaped = pathPrefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped.endsWith('/') ? escaped : escaped + '/';
    const needle = sql.json([{ type: 'range_superseded', superseded_by: [removedPath] }]);
    const rows = await sql<{ file_path: string }[]>`
        SELECT file_path FROM media_files
         WHERE file_path LIKE ${prefix + '%'} ESCAPE '\\'
           -- Literal predicate of idx_media_files_range_superseded (16.408.0).
           AND health_issues @> '[{"type":"range_superseded"}]'::jsonb
           AND health_issues @> ${needle}
         ORDER BY file_path
    `;
    return rows.map((r) => r.file_path);
}

/**
 * Paths of the media_files rows that sit directly in `dir` (not in a
 * subfolder). Indexed by the prefix; the folder depth is checked in JS.
 */
export async function listDirectChildMediaFilePaths(
    sql: postgres.Sql,
    dir: string,
): Promise<string[]> {
    const escaped = dir.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = (escaped.endsWith('/') ? escaped : escaped + '/') + '%';
    const rows = await sql<{ file_path: string }[]>`
        SELECT file_path FROM media_files
         WHERE file_path LIKE ${prefix} ESCAPE '\\'
         ORDER BY file_path
    `;
    const base = dir.endsWith('/') ? dir : dir + '/';
    return rows
        .map((r) => r.file_path)
        .filter((p) => p.startsWith(base) && !p.slice(base.length).includes('/'));
}

/**
 * Drop one issue type from a file's row, only while the row has no media-item
 * link, in one statement. For a verdict the scanner recorded on a NEW file's
 * stub row and later refuted itself: the same type on a linked row may come
 * from another writer (trickplay's decode verdict for `container_unreadable`)
 * that the scanner's probe does not refute. A no-op when the row does not
 * carry the type.
 */
export async function clearUnlinkedFileScanIssue(
    sql: postgres.Sql,
    filePath: string,
    type: FileHealthIssueType,
): Promise<void> {
    await sql`
        UPDATE media_files mf
           SET health_issues = (
                   SELECT jsonb_agg(i)
                     FROM jsonb_array_elements(mf.health_issues) i
                    WHERE i->>'type' <> ${type}
               ),
               updated_at = NOW()
         WHERE mf.file_path = ${filePath}
           AND mf.health_issues @> ${sql.json([{ type }])}
           AND NOT EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id)
    `;
}

/**
 * Return the active scan-failure cooldown for a file, or null when none.
 *
 * The scanner calls this BEFORE parseFile so a file in the cooldown window
 * doesn't burn a 30s timeout every pass. The caller compares `mtime` against
 * `latestDetectedAt` to bust the cooldown when the file has been modified on
 * disk since the failure was recorded — a re-tagged or replaced file should
 * be retried immediately rather than waiting out the 7-day tier.
 */
export interface ScanCooldown {
    /** Most-deferred next_retry_at across all unresolved issue types. */
    retryAt: Date;
    /** Earliest detected_at across unresolved issues — used as "since" for mtime bust. */
    latestDetectedAt: Date;
}

export async function getFileScanRetryAt(
    sql: postgres.Sql,
    filePath: string,
    /** Only these issue types count; all of them when omitted. */
    onlyTypes?: readonly FileHealthIssueType[],
): Promise<ScanCooldown | null> {
    const [row] = await sql<{ health_issues: FileHealthIssue[] | null }[]>`
        SELECT health_issues FROM media_files WHERE file_path = ${filePath} LIMIT 1
    `;
    if (!row?.health_issues) return null;
    let latestRetry: number | null = null;
    let latestDetected: number | null = null;
    for (const i of row.health_issues) {
        if (onlyTypes && !onlyTypes.includes(i.type)) continue;
        if (i.next_retry_at) {
            const t = Date.parse(i.next_retry_at);
            if (Number.isFinite(t) && (latestRetry === null || t > latestRetry)) {
                latestRetry = t;
            }
        }
        const d = Date.parse(i.detected_at);
        if (Number.isFinite(d) && (latestDetected === null || d > latestDetected)) {
            latestDetected = d;
        }
    }
    if (latestRetry === null) return null;
    return {
        retryAt: new Date(latestRetry),
        latestDetectedAt: latestDetected !== null ? new Date(latestDetected) : new Date(0),
    };
}

export interface ScanIssueRow {
    file_path: string;
    library_group_id: string | null;
    issues: FileHealthIssue[];
    created_at: Date;
    updated_at: Date;
}

/**
 * List unresolved scan failures for the admin Ingest Map page.
 *
 * Filters to media_files rows that carry at least one `tag_parse_*` issue
 * AND have no linked media item — these are the "garbage skipped" files
 * the user needs to know about. Files with the same path but an active
 * track are reported separately (they're not blocking ingest).
 */
export async function listScanIssues(sql: postgres.Sql, limit = 200): Promise<ScanIssueRow[]> {
    return sql<ScanIssueRow[]>`
        SELECT mf.file_path,
               mf.library_group_id,
               mf.health_issues AS issues,
               mf.created_at,
               mf.updated_at
          FROM media_files mf
         WHERE mf.health_issues IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(mf.health_issues) = 'array' THEN mf.health_issues ELSE '[]'::jsonb END
               ) i
                WHERE i->>'type' = ANY(${UNLINKED_FILE_HEALTH_ISSUE_TYPES}::text[])
           )
           AND NOT EXISTS (
               SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id
           )
         ORDER BY mf.updated_at DESC
         LIMIT ${limit}
    `;
}

/** Actionable physical-file count used by Health attention. */
export async function countFilesWithHealthIssues(sql: postgres.Sql): Promise<number> {
    const rows = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM media_files mf
        WHERE mf.health_issues IS NOT NULL AND mf.health_issues <> '[]'::jsonb
          AND ${actionableFileHealthSql(sql, sql`mf.id`)}
    `;
    return Number(rows[0]?.count ?? 0);
}

export interface SessionSourceInfo {
    container: string | null;
    bitrate_kbps: number | null;
    video_codec: string | null;
    width: number | null;
    height: number | null;
    audio_codec: string | null;
}

/**
 * Fetch authoritative source media technicals for populating a play_sessions row:
 * container + total bitrate from `media_files`, video codec / resolution from the
 * video stream, and audio codec from the chosen audio stream (by index when
 * provided, otherwise the default audio stream, otherwise the lowest-index one).
 */
export async function getSessionSourceInfo(
    sql: postgres.Sql,
    fileId: string,
    audioStreamIndex?: number,
): Promise<SessionSourceInfo | null> {
    const rows = await sql<
        {
            container_format: string | null;
            total_bitrate: number | null;
            video_codec: string | null;
            width: number | null;
            height: number | null;
            audio_codec: string | null;
        }[]
    >`
        SELECT
            mf.container_format,
            mf.total_bitrate,
            v.codec AS video_codec,
            v.width,
            v.height,
            a.codec AS audio_codec
        FROM media_files mf
        LEFT JOIN LATERAL (
            SELECT codec, width, height
            FROM media_streams
            WHERE file_id = mf.id AND stream_type = 'video'
            ORDER BY is_default DESC, stream_index ASC
            LIMIT 1
        ) v ON TRUE
        LEFT JOIN LATERAL (
            SELECT codec
            FROM media_streams
            WHERE file_id = mf.id
              AND stream_type = 'audio'
            -- Prefer the client-requested stream_index, then default, then lowest.
            -- NULLS LAST absorbs the case where audioStreamIndex is NULL (the
            -- equality becomes NULL) so the is_default/stream_index fallback wins.
            ORDER BY
                (stream_index = ${audioStreamIndex ?? null}::int) DESC NULLS LAST,
                is_default DESC,
                stream_index ASC
            LIMIT 1
        ) a ON TRUE
        WHERE mf.id = ${fileId}::uuid
    `;
    const row = rows[0];
    if (!row) return null;
    // Guard against zero/negative totals from incomplete probes — callers treat
    // null as "unknown" and fall through to the plan/client-supplied value.
    const validBitrate =
        row.total_bitrate !== null && row.total_bitrate > 0
            ? Math.round(row.total_bitrate / 1000)
            : null;
    return {
        container: row.container_format,
        bitrate_kbps: validBitrate,
        video_codec: row.video_codec,
        width: row.width,
        height: row.height,
        audio_codec: row.audio_codec,
    };
}

/**
 * Self-heal the catalog gap where probed files never wrote `runtime_seconds`
 * back to the parent `media_items`. For multi-variant movies (theatrical +
 * extended) the longest probed duration is chosen (`DISTINCT ON` / `ORDER BY
 * duration DESC`) — consistent with `play-sessions.service.ts` and
 * conservative for "watched" thresholds. Episodes are excluded: their
 * runtime comes from authoritative metadata providers and a single file
 * rarely maps 1:1.
 *
 * Returns the number of movies whose `runtime_seconds` was populated by
 * this call so the caller can log it.
 *
 * Only touches rows where the current runtime is `NULL` or `0` — existing
 * runtimes (TMDB, Jellyfin, manual) are left alone.
 */
export async function backfillMovieRuntimesFromProbedFiles(sql: postgres.Sql): Promise<number> {
    const result = await sql`
        UPDATE media_items mi
        SET runtime_seconds = ROUND(sub.duration_seconds)::int
        FROM (
            SELECT DISTINCT ON (mfi.media_item_id)
                mfi.media_item_id,
                mf.duration_seconds
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi2 ON mi2.id = mfi.media_item_id
            WHERE mf.duration_seconds IS NOT NULL
              AND mf.duration_seconds > 0
              AND mi2.media_type = 'movie'
              AND COALESCE(mi2.runtime_seconds, 0) = 0
            ORDER BY mfi.media_item_id, mf.duration_seconds DESC NULLS LAST
        ) sub
        WHERE mi.id = sub.media_item_id
          AND mi.media_type = 'movie'
          AND COALESCE(mi.runtime_seconds, 0) = 0
    `;
    return result.count ?? 0;
}

/**
 * Chunked variant of `backfillMovieRuntimesFromProbedFiles`. Updates up to
 * `limit` eligible movies per call, returning the number actually touched.
 * Callers loop until this function returns 0 — letting a huge first-run
 * backfill be sliced across many short queries interleaved with
 * `onProgress`/abort checks, so a 100k-file library doesn't hold one
 * statement open for 30-60s and trip BullMQ's stall detector.
 *
 * Same semantics as the single-shot version: picks the longest probed
 * duration per movie (`DISTINCT ON` / `ORDER BY duration DESC`), only
 * touches rows where the current runtime is `NULL` or `0`.
 */
export async function backfillMovieRuntimesChunk(
    sql: postgres.Sql,
    limit: number,
): Promise<number> {
    const result = await sql`
        UPDATE media_items mi
        SET runtime_seconds = ROUND(sub.duration_seconds)::int
        FROM (
            SELECT DISTINCT ON (mfi.media_item_id)
                mfi.media_item_id,
                mf.duration_seconds
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi2 ON mi2.id = mfi.media_item_id
            WHERE mf.duration_seconds IS NOT NULL
              AND mf.duration_seconds > 0
              AND mi2.media_type = 'movie'
              AND COALESCE(mi2.runtime_seconds, 0) = 0
            ORDER BY mfi.media_item_id, mf.duration_seconds DESC NULLS LAST
            -- Subquery LIMIT caps the UPDATE's write set per round-trip.
            -- Pairing with the outer "runtime IS NULL/0" filter means the
            -- loop converges: each pass takes the next N stale movies
            -- off the list.
            LIMIT ${limit}
        ) sub
        WHERE mi.id = sub.media_item_id
          AND mi.media_type = 'movie'
          AND COALESCE(mi.runtime_seconds, 0) = 0
    `;
    return result.count ?? 0;
}

/**
 * Returns true if the given file is linked to at least one media_item that
 * has the awaiting_provider_match flag set in its custom_metadata.
 *
 * Used by the file scanner's change-detection path to detect items that were
 * created without a confident provider match. The unchanged-file fast path
 * normally returns 'skipped' before any matching runs — this check lets the
 * scanner override that and re-run matching, so newly-configured fallback
 * providers get a chance to match the file on the next scan.
 */
export async function isFileLinkedToAwaitingMatchItem(
    sql: postgres.Sql,
    fileId: string,
): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
            SELECT 1
            FROM media_file_items mfi
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mfi.file_id = ${fileId}
              AND (mi.custom_metadata->>'awaiting_provider_match')::boolean IS TRUE
        ) AS exists
    `;
    return rows[0]?.exists ?? false;
}

/**
 * Clear the awaiting_provider_match flag (and its companion timestamp) from
 * any media_items linked to the given file. Called immediately before a
 * re-match attempt so the items don't keep the stale flag if the new match
 * pipeline doesn't restore it.
 */
export async function clearAwaitingMatchFlagForFile(
    sql: postgres.Sql,
    fileId: string,
): Promise<void> {
    await sql`
        UPDATE media_items mi
        SET custom_metadata = custom_metadata - 'awaiting_provider_match'
                                              - 'awaiting_provider_match_since'
        FROM media_file_items mfi
        WHERE mfi.file_id = ${fileId}
          AND mfi.media_item_id = mi.id
          AND (mi.custom_metadata->>'awaiting_provider_match')::boolean IS TRUE
    `;
}

/**
 * Given a list of file paths, returns the subset whose linked media_items
 * have custom_metadata.awaiting_provider_match = true.
 *
 * Used by the bulk file scanner to pull awaiting-match files out of the
 * triage.unchanged skip bucket and into the active processing queue.
 */
export async function findFilesWithAwaitingMatch(
    sql: postgres.Sql,
    filePaths: string[],
): Promise<string[]> {
    if (filePaths.length === 0) return [];
    const rows = await sql<{ file_path: string }[]>`
        SELECT DISTINCT mf.file_path
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mf.file_path = ANY(${sql.array(filePaths)})
          AND (mi.custom_metadata->>'awaiting_provider_match')::boolean IS TRUE
    `;
    return rows.map((r) => r.file_path);
}

/**
 * Return all file paths under a library prefix that are linked to a
 * media_item with awaiting_provider_match=true.
 *
 * Replaces the chunked findFilesWithAwaitingMatch loop in file-scanner.ts:
 * instead of 80 round-trips (5 000-path chunks over 400k unchanged files),
 * a single prefix-filtered query returns the usually-empty set directly.
 * Benefits from the text_pattern_ops index added in migration 16.56.0.
 *
 * Returns file paths only (no MediaFileRow) — callers only need the path
 * to promote the file to the "needs reprocessing" set.
 */
export async function findFilesAwaitingMatchByPrefix(
    sql: postgres.Sql,
    pathPrefix: string,
): Promise<string[]> {
    const escaped = pathPrefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped.endsWith('/') ? escaped : escaped + '/';
    const rows = await sql<{ file_path: string }[]>`
        SELECT DISTINCT mf.file_path
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mf.file_path LIKE ${prefix + '%'} ESCAPE '\\'
          AND (mi.custom_metadata->>'awaiting_provider_match')::boolean IS TRUE
    `;
    return rows.map((r) => r.file_path);
}

/**
 * Unverified filename-title tracks need one evidence-based tag check even when
 * their files are unchanged. Scope by the same escaped directory prefix used
 * by the other scanner catch-up queries; the caller intersects with walked,
 * unchanged files so unavailable files are never promoted.
 * Segment titles cannot be established from the file TITLE tag.
 * Keep locked rows eligible: the processor preserves their title/source and
 * records completed verification so subsequent scans can skip them cheaply.
 */
export async function findTrackFilesWithUnverifiedTitleSourceByPrefix(
    sql: postgres.Sql,
    pathPrefix: string,
): Promise<string[]> {
    const escaped = pathPrefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped.endsWith('/') ? escaped : escaped + '/';
    const rows = await sql<{ file_path: string }[]>`
        SELECT DISTINCT mf.file_path
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mf.file_path LIKE ${prefix + '%'} ESCAPE '\\'
          AND mi.media_type = 'track'
          AND mi.status = 'active'
          AND NOT mi.is_dismissed
          AND mfi.start_offset_ms IS NULL AND mfi.end_offset_ms IS NULL
          AND mi.title_source = 'filename'
          AND (mi.custom_metadata->'title_source_verified') IS DISTINCT FROM 'true'::jsonb
    `;
    return rows.map((row) => row.file_path);
}

export interface TrackFileMissingDiscNumber {
    file_path: string;
    album: string | null;
}

/**
 * Disc catch-up candidates, restricted to a single whole-file track link: the
 * processor updates only its first linked item, so multi-link files cannot
 * reliably converge. The single-link guard makes DISTINCT unnecessary.
 *
 * Filter markers here rather than returning every disc-less track in a library.
 * The album regex is a prefilter for splitDiscSuffix's CD/Disc/Disk ordinals
 * (1..20), with a separate title and a number boundary. It deliberately permits
 * trailing scene tokens: the caller's shared cleaner/parser validates the exact
 * suffix without duplicating scene-title normalization in SQL. Folder markers
 * match resolveAlbumDir's immediate-parent DISC_FOLDER_PATTERN.
 */
export async function findTrackFilesMissingDiscNumberByPrefix(
    sql: postgres.Sql,
    pathPrefix: string,
): Promise<TrackFileMissingDiscNumber[]> {
    const folder = pathPrefix.endsWith('/') ? pathPrefix.slice(0, -1) : pathPrefix;
    const { lo, hi } = folderPathRange(folder);
    const albumMarker = String.raw`\S(?:.*\S)?(?:\s+[-–—]\s+|\s*[:,]\s*|\s+)(?:\(?|\[)(?:cd|disc|disk)\s*0*(?:[1-9]|1[0-9]|20)(?:\s|[)\]]|$)`;
    const folderMarker = String.raw`/(?:cd|disc|disk|vol(?:ume)?\.?|part)\s*\d+/[^/]+$`;
    return sql<TrackFileMissingDiscNumber[]>`
        SELECT mf.file_path, mi.custom_metadata->>'album' AS album
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mf.file_path ~>=~ ${lo}
          AND mf.file_path ~<~ ${hi}
          AND mi.media_type = 'track'
          AND mi.status = 'active'
          AND NOT mi.is_dismissed
          AND mi.metadata_locked = false
          AND mfi.start_offset_ms IS NULL AND mfi.end_offset_ms IS NULL
          AND jsonb_typeof(mi.custom_metadata->'disc_number') IS DISTINCT FROM 'number'
          AND (
              replace(mi.custom_metadata->>'album', '_', ' ') ~* ${albumMarker}
              OR mf.file_path ~* ${folderMarker}
          )
          AND NOT EXISTS (
              SELECT 1 FROM media_file_items other
              WHERE other.file_id = mf.id
                AND other.media_item_id <> mfi.media_item_id
          )
    `;
}

/** Whole-file TITLE evidence must not rename linked chapter/segment items. */
export async function findTrackIdsWithUnverifiedTitleSourceByFilePath(
    sql: postgres.Sql,
    filePath: string,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mf.file_path = ${filePath}
          AND mi.media_type = 'track'
          AND mi.status = 'active'
          AND NOT mi.is_dismissed
          AND mfi.start_offset_ms IS NULL AND mfi.end_offset_ms IS NULL
          AND mi.title_source = 'filename'
          AND (mi.custom_metadata->'title_source_verified') IS DISTINCT FROM 'true'::jsonb
    `;
    return rows.map((row) => row.id);
}

/**
 * Return file paths under `pathPrefix` whose linked MOVIE item has NO description
 * on the display path — i.e. no non-blank overview in its 'aggregated'
 * provider_metadata row (which is what the detail modal reads) — and carries NO
 * discovery provider id (tmdb/imdb). That is a provider-less local movie whose
 * only description source is its NFO sidecar. The scanner promotes these out of
 * the unchanged-skip set so processVideoFile's re-scan heal (write NFO content to
 * provider_metadata) runs on them. Gapping on the aggregated overview — not
 * media_items.overview — is deliberate: media_items.overview does not render in
 * the modal, so a row that got a partial (media_items-only) heal must still be
 * promoted until its display row exists. Restricting to no-tmdb/imdb keeps the
 * promotion off matched movies (whose overview comes from metadata-sync) so the
 * NFO never competes. Bounded set (matched movies carry an overview). Mirrors
 * findFilesAwaitingMatchByPrefix.
 */
export async function findMovieFilesWithContentGapByPrefix(
    sql: postgres.Sql,
    pathPrefix: string,
): Promise<string[]> {
    const escaped = pathPrefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped.endsWith('/') ? escaped : escaped + '/';
    const rows = await sql<{ file_path: string }[]>`
        SELECT DISTINCT mf.file_path
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mf.file_path LIKE ${prefix + '%'} ESCAPE '\\'
          AND mi.media_type = 'movie'
          AND mi.status = 'active'
          AND NOT mi.is_dismissed
          AND NOT mi.metadata_locked
          AND NOT EXISTS (
              SELECT 1 FROM external_ids ei
              WHERE ei.media_id = mi.id AND ei.provider IN ('tmdb', 'imdb')
          )
          AND NOT EXISTS (
              SELECT 1 FROM provider_metadata pm
              WHERE pm.media_id = mi.id AND pm.provider = 'aggregated'
                AND BTRIM(COALESCE(pm.metadata->>'overview', '')) <> ''
          )
    `;
    return rows.map((r) => r.file_path);
}

/**
 * Atomically detach a file from any media_items awaiting a provider match
 * and clear those items' awaiting flags.
 *
 * Returns the number of junction rows removed (0 = file was not linked to
 * any awaiting-match item and no action was taken).
 *
 * Why atomic: the flag must be cleared at the same time as the detach so
 * the orphaned items don't remain retryable, and so the matching pipeline
 * gets a clean slate to create a new junction row for the matched item.
 */
/**
 * Given a media_files UUID, return the owning media_items UUID, or null if
 * the file is not linked to any media item.
 *
 * Cached for 5 minutes. The file_id → owner mapping is effectively immutable
 * for the file's lifetime — `media_file_items` rows are written once at
 * ingest and only removed on file deletion or rebind. The 5min TTL means a
 * stale-cache window of at most 5 minutes after a rebind / delete, which is
 * acceptable for an access-check gate since the downstream queries return
 * 404 when the file is gone. Callers that mutate `media_file_items` for an
 * already-served file should call `invalidateOwnerForFileCache(fileId)`.
 *
 * The cache is most valuable on hot playback paths (trickplay tiles, HLS
 * sub-segments) where the same fileId is hit dozens of times per session,
 * AND on the inline owner-resolve we now do in jellyfin-compat routes for
 * Android-TV-style MediaSource.Id passthrough.
 */
const OWNER_CACHE_TTL_MS = 5 * 60 * 1000;
const OWNER_CACHE_MAX_SIZE = 4096;
const ownerForFileCache = new Map<string, { ownerId: string | null; expiresAt: number }>();

/** Drop the local L1 entry only — no cross-replica fan-out. */
function invalidateOwnerForFileCacheLocal(fileId: string): void {
    ownerForFileCache.delete(fileId);
}

/**
 * Invalidate the cached file→owner mapping across ALL replicas.
 *
 * Call after any mutation that changes which media_item a file belongs to
 * (detach / rebind / re-identify). The scanner runs on the worker replica, but
 * the cache is read on web replicas (Jellyfin-compat MediaSource.Id resolution,
 * trickplay), so a local-only drop would leave web replicas serving the old
 * owner for up to the 5-minute TTL. The Valkey broadcast closes that window.
 */
export function invalidateOwnerForFileCache(fileId: string): void {
    invalidateOwnerForFileCacheLocal(fileId);

    // publishMessage resolves false (not rejects) when Valkey is down, so check
    // the boolean — a bare .catch would never fire and the failure would be silent.
    publishMessage(OWNER_CACHE_INVALIDATE_CHANNEL, fileId)
        .then((delivered) => {
            if (!delivered) {
                ownerCacheLogger.warn(
                    'Failed to broadcast owner-cache invalidation — other replicas may serve a stale file owner',
                    { fileId },
                );
            }
        })
        .catch(() => {
            /* publishMessage swallows its own errors; defensive only */
        });
}

// Receive invalidations from sibling replicas. Local-only drop so we never
// re-broadcast (which would loop). Registered once at module init; degrades to
// TTL expiry if Valkey is unavailable.
void subscribeToChannel(OWNER_CACHE_INVALIDATE_CHANNEL, (fileId: string) => {
    invalidateOwnerForFileCacheLocal(fileId);
}).catch((err: unknown) => {
    ownerCacheLogger.warn(
        'Failed to subscribe to owner-cache invalidation channel — cross-replica invalidation unavailable',
        {},
        err as Error,
    );
});

export async function getOwnerItemForFile(
    sql: postgres.Sql,
    fileId: string,
): Promise<string | null> {
    const cached = ownerForFileCache.get(fileId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
        // Refresh LRU order
        ownerForFileCache.delete(fileId);
        ownerForFileCache.set(fileId, cached);
        return cached.ownerId;
    }
    if (cached) ownerForFileCache.delete(fileId);

    // ORDER BY for determinism: media_file_items is M:N, so a file can have >1 owner.
    // Without a stable order, LIMIT 1 could return different owners across call sites
    // (e.g. the /j session-report path vs the master.m3u8 stream-policy path), which
    // would make the stream-limit ghost-exclusion miss. Pick the lowest id, always.
    const rows = await sql<{ media_item_id: string }[]>`
        SELECT media_item_id FROM media_file_items
        WHERE file_id = ${fileId}::uuid
        ORDER BY media_item_id
        LIMIT 1
    `;
    const ownerId = rows[0]?.media_item_id ?? null;

    if (ownerForFileCache.size >= OWNER_CACHE_MAX_SIZE) {
        const oldest = ownerForFileCache.keys().next().value;
        if (oldest !== undefined) ownerForFileCache.delete(oldest);
    }
    ownerForFileCache.set(fileId, {
        ownerId,
        expiresAt: now + OWNER_CACHE_TTL_MS,
    });
    return ownerId;
}

/**
 * Read-only: the items this file is linked to that are still flagged
 * `awaiting_provider_match`. The scanner checks this before deciding whether a
 * rematch is worth running at all — detaching first (detachAndClear… below)
 * would strand the item whenever the rematch can't produce a better home.
 */
export async function findAwaitingMatchItemIdsForFile(
    sql: postgres.Sql,
    fileId: string,
): Promise<string[]> {
    const rows = await sql<{ media_item_id: string }[]>`
        SELECT mfi.media_item_id
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mfi.file_id = ${fileId}
          AND (mi.custom_metadata->>'awaiting_provider_match')::boolean IS TRUE
        ORDER BY mfi.media_item_id
    `;
    return rows.map((r) => r.media_item_id);
}

/**
 * Clear the `awaiting_provider_match` flag on items whose rematch ran against
 * a working provider and found nothing: they stay the file's home as plain
 * personal items, and later scans take the cheap unchanged path.
 */
export async function clearAwaitingMatchFlag(
    sql: postgres.Sql,
    mediaItemIds: string[],
): Promise<void> {
    if (mediaItemIds.length === 0) return;
    await sql`
        UPDATE media_items
        SET custom_metadata = custom_metadata
                              - 'awaiting_provider_match'
                              - 'awaiting_provider_match_since'
        WHERE id = ANY(${mediaItemIds}::uuid[])
          AND custom_metadata ? 'awaiting_provider_match'
    `;
}

/**
 * Flag freshly created episodes of a provider-less series as
 * `awaiting_provider_match`, the way createPersonalMediaItem flags a movie, so
 * the scanner re-matches their files once a provider can answer. Only while the
 * series itself has no external id: episodes of an identified series are
 * series-sync's job.
 */
export async function markEpisodesAwaitingProviderMatch(
    sql: postgres.Sql,
    seriesId: string,
    episodeIds: string[],
): Promise<void> {
    if (episodeIds.length === 0) return;
    await sql`
        UPDATE media_items mi
        SET custom_metadata = COALESCE(mi.custom_metadata, '{}'::jsonb)
                              || jsonb_build_object(
                                  'awaiting_provider_match', true,
                                  'awaiting_provider_match_since', now()
                              )
        WHERE mi.id = ANY(${episodeIds}::uuid[])
          AND mi.media_type = 'episode'
          AND NOT (COALESCE(mi.custom_metadata, '{}'::jsonb) ? 'awaiting_provider_match')
          AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND source IS DISTINCT FROM 'watch-sync-file')
          AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = ${seriesId}::uuid AND source IS DISTINCT FROM 'watch-sync-file')
    `;
}

/**
 * The series a rematched episode file may be identified IN PLACE: the one
 * series above the awaiting episodes, still live, and holding either no
 * external id at all (provider-less, never synced from Jellyfin) or already the
 * matched id itself (an earlier episode of this scan adopted it). Null when the
 * match belongs somewhere else; the scanner then links the file there.
 */
export async function findSeriesForInPlaceRematch(
    sql: postgres.Sql,
    episodeIds: string[],
    match: { provider: string; externalId: string },
): Promise<{ seriesId: string; identified: boolean } | null> {
    if (episodeIds.length === 0) return null;
    const rows = await sql<{ id: string; has_ids: boolean; owns_match: boolean }[]>`
        SELECT DISTINCT s.id,
               EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = s.id AND source IS DISTINCT FROM 'watch-sync-file') AS has_ids,
               EXISTS (
                   SELECT 1 FROM external_ids ei
                   WHERE ei.media_id = s.id
                     AND ei.provider = ${match.provider}
                     AND ei.external_id = ${match.externalId}
               ) AS owns_match
        FROM media_items e
        JOIN media_items p ON p.id = e.parent_id
        JOIN media_items s ON s.id = CASE WHEN p.media_type = 'season' THEN p.parent_id ELSE p.id END
        WHERE e.id = ANY(${episodeIds}::uuid[])
          AND e.media_type = 'episode'
          AND s.media_type = 'tv'
          AND NOT s.is_dismissed
          -- Another item holding the matched id is the show's real home: the
          -- scanner then links the file there instead.
          AND NOT EXISTS (
              SELECT 1 FROM external_ids ei
              WHERE ei.provider = ${match.provider}
                AND ei.external_id = ${match.externalId}
                AND ei.media_id <> s.id
          )
    `;
    if (rows.length !== 1) return null;
    const [row] = rows;
    if (row.owns_match) return { seriesId: row.id, identified: true };
    if (row.has_ids) return null;
    return { seriesId: row.id, identified: false };
}

/** Whether `seriesId` holds the given provider id (an in-place rematch landed). */
export async function seriesHoldsExternalId(
    sql: postgres.Sql,
    seriesId: string,
    match: { provider: string; externalId: string },
): Promise<boolean> {
    const rows = await sql`
        SELECT 1 FROM external_ids
        WHERE media_id = ${seriesId}::uuid
          AND provider = ${match.provider}
          AND external_id = ${match.externalId}
        LIMIT 1
    `;
    return rows.length > 0;
}

/**
 * Library paths holding files whose item still awaits a provider match. Used
 * to re-scan exactly those libraries once a metadata provider key is saved.
 */
export async function findLibraryPathIdsWithAwaitingMatch(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT lp.id
        FROM library_paths lp
        WHERE lp.enabled
          AND EXISTS (
              SELECT 1
              FROM media_items mi
              JOIN media_file_items mfi ON mfi.media_item_id = mi.id
              JOIN media_files mf ON mf.id = mfi.file_id
              WHERE (mi.custom_metadata->>'awaiting_provider_match')::boolean IS TRUE
                AND NOT mi.is_dismissed
                AND starts_with(mf.file_path, rtrim(lp.path, '/') || '/')
          )
        ORDER BY lp.id
    `;
    return rows.map((r) => r.id);
}

/**
 * Release a re-identified file from the `awaiting_provider_match` items it was
 * linked to (the scanner calls this once the file has landed on a new item).
 * In one transaction:
 *   - drop the file's links to those items;
 *   - promote a surviving file to default on an item that lost its default (an
 *     item can hold copies of one title from several libraries);
 *   - clear the awaiting flag only on items left with no files. An item that
 *     still holds other files stays awaiting so those files re-match too;
 *     clearing it sent them down the unchanged fast path and kept the old item
 *     alive as a duplicate of the matched one.
 * After commit, items left with no files are soft-dismissed (user data kept).
 * Returns the number of items the file was detached from.
 */
export async function detachAndClearAwaitingMatchForFile(
    sql: postgres.Sql,
    fileId: string,
): Promise<number> {
    const detachedIds = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const awaiting = await tx<{ media_item_id: string }[]>`
            SELECT mfi.media_item_id
            FROM media_file_items mfi
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mfi.file_id = ${fileId}
              AND (mi.custom_metadata->>'awaiting_provider_match')::boolean IS TRUE
            ORDER BY mfi.media_item_id
        `;
        const ids = awaiting.map((r) => r.media_item_id);
        if (ids.length === 0) return [];

        // The per-item advisory lock attachFileToItem and linkFileAsVersion take
        // before they choose a default, so neither can pick one while we promote
        // one. Taken before the row locks, in id order, as they do.
        for (const id of ids) {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
        }
        await lockAncestorChain(tx, ids);

        // Re-check the flag under the locks: a racing scan may have cleared it.
        const rows = await tx<{ media_item_id: string }[]>`
            DELETE FROM media_file_items mfi
            USING media_items mi
            WHERE mfi.file_id = ${fileId}
              AND mfi.media_item_id = ANY(${ids}::uuid[])
              AND mi.id = mfi.media_item_id
              AND (mi.custom_metadata->>'awaiting_provider_match')::boolean IS TRUE
            RETURNING mfi.media_item_id
        `;
        const detached = rows.map((r) => r.media_item_id);

        // An item can hold this file AND other copies of the same title (two
        // libraries, grouped as versions by title+year before a provider was
        // configured). If this file was its default, promote a surviving copy
        // so the deferred one-default trigger accepts the commit.
        await promoteDefaultWhereMissing(tx, detached);

        // Clear the flag only where the item lost its last file. An item that
        // still holds other files stays awaiting, so those files re-match on
        // their own scan and follow this one; with the flag gone they would
        // take the unchanged fast path and keep the old item alive as a
        // duplicate of the matched one.
        await tx`
            UPDATE media_items mi
            SET custom_metadata = mi.custom_metadata
                                  - 'awaiting_provider_match'
                                  - 'awaiting_provider_match_since'
            WHERE mi.id = ANY(${detached}::uuid[])
              AND NOT EXISTS (
                  SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id
              )
        `;

        // The detached items just lost this file. Recompute has_files —
        // otherwise re-identification (e.g. once a provider key is added and the
        // file re-matches to a new canonical item) strands the old personal item
        // as a `has_files = true` ghost with zero linked files, which then leaks
        // as an unplayable card.
        await recomputeHasFilesBatch(tx, detached);
        return detached;
    });

    if (detachedIds.length > 0) {
        // After commit: softDismiss runs lifecycle hooks (caches, events) that
        // must not fire for a detach that could still roll back.
        await cleanupOrphanedMediaItems(sql, detachedIds);
        // The file→owner mapping just changed. Invalidate (and fan out to
        // sibling replicas) so reads don't keep resolving the detached owner.
        invalidateOwnerForFileCache(fileId);
    }
    return detachedIds.length;
}

/** The (default) media_item a file is linked to, or null. */
export async function getMediaItemIdByFilePath(
    sql: postgres.Sql,
    filePath: string,
): Promise<string | null> {
    const rows = await sql<{ media_item_id: string }[]>`
        SELECT mfi.media_item_id
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mf.file_path = ${filePath}
        ORDER BY mfi.is_default DESC
        LIMIT 1`;
    return rows[0]?.media_item_id ?? null;
}

/** Find the ACTUAL stored file_path matching `candidate` under Unicode NFC-insensitive
 *  comparison (handles NFC request vs NFD on-disk, common on macOS). Returns the stored
 *  path verbatim (so callers delete/match the real bytes), or null. */
export async function findMediaFilePathNfc(
    sql: postgres.Sql,
    candidate: string,
): Promise<string | null> {
    const rows = await sql<{ file_path: string }[]>`
        SELECT file_path FROM media_files
        WHERE normalize(file_path, NFC) = normalize(${candidate}, NFC)
        LIMIT 1`;
    return rows[0]?.file_path ?? null;
}

/**
 * What the media-probe stage stored for a file that trickplay needs: the
 * container duration, and the first video stream's size, codec and pixel
 * format. `null` when the file row does not exist.
 */
export interface StoredVideoProbeRow {
    probed_at: Date | null;
    duration_seconds: number | null;
    width: number | null;
    height: number | null;
    codec: string | null;
    pixel_format: string | null;
}

export async function loadStoredVideoProbe(
    sql: postgres.Sql,
    fileId: string,
): Promise<StoredVideoProbeRow | null> {
    const [row] = await sql<StoredVideoProbeRow[]>`
        SELECT mf.probed_at,
               mf.duration_seconds,
               v.width,
               v.height,
               v.codec,
               v.pixel_format
        FROM media_files mf
        LEFT JOIN LATERAL (
            SELECT ms.width, ms.height, ms.codec, ms.pixel_format
            FROM media_streams ms
            WHERE ms.file_id = mf.id AND ms.stream_type = 'video'
            ORDER BY ms.stream_index
            LIMIT 1
        ) v ON true
        WHERE mf.id = ${fileId}::uuid
    `;
    return row ?? null;
}

/** Physical metadata from a successful scanner probe, independently of any
 * identity assignment. Only trust the exact stat verified by that probe. */
export async function updateScannedPhysicalMetadata(
    sql: postgres.Sql,
    fileId: string,
    metadata: {
        durationSeconds: number | null;
        container: string | null;
        bitrate: number | null;
        mtime: Date;
        size: number;
    },
): Promise<void> {
    await sql`UPDATE media_files SET duration_seconds=${metadata.durationSeconds},
        container_format=${metadata.container}, total_bitrate=${metadata.bitrate}
        WHERE id=${fileId} AND file_mtime=${metadata.mtime}::timestamptz AND file_size_bytes=${metadata.size}`;
}
