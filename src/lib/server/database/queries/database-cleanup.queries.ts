// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Database Cleanup Query Module
 *
 * Helpers for the database-cleanup sync plugin. Each function is a pure SQL
 * operation — no service calls, no side effects beyond the declared DB
 * mutations. Multi-statement write functions (applyStubMerge, applyReclassify)
 * run their mutations inside a single transaction so partial failures do not
 * corrupt the media hierarchy.
 *
 * Callers chunk work themselves (LIMIT clauses are internal here) and check
 * abort signals between calls.
 */

import type postgres from 'postgres';
import { isVariousArtistsName } from '$lib/shared/various-artists.js';
import { deriveArtistName, resolveAlbumDir } from '$lib/server/utils/music-scanner-utils.js';
import {
    albumFileCredit,
    resolveAlbumArtist,
    type AlbumArtistDecision,
} from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/album-artist-rule.js';
import { getArtistCreditEvidence } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/artist-credit-evidence.js';
import { reconcileTrackArtistCredits } from '$lib/server/services/music/artist-credit-ingestion.js';
import { findAlbumArtistEvidence } from './music-album-folder.queries.js';
import { recomputeHasFilesBatch } from './media-files.queries.js';
import {
    deleteEmptyAlbum,
    reparentTracksToAlbum,
    reparentAlbumToArtist,
    replaceArtistIdInTracks,
    dedupeAdditionalArtistIds,
} from './artist-merge.queries.js';
import { artistNormTitleSql, artistNormTitleValueSql } from './fragments/music-artist.fragments.js';
import {
    formerlyAvailableSql,
    mediaReferenceGuard,
    RETENTION_COVERED_MEDIA_TYPES,
} from './media-retention.queries.js';
import { UNLINKED_FILE_HEALTH_ISSUE_TYPES } from '$lib/types/pipeline.js';

export interface MergeStubCandidate {
    stub_id: string;
    canonical_id: string;
}

export interface MisidentifiedStub {
    stub_id: string;
}

// =============================================================================
// has_files backfill (one-shot during migration to has_files; cheap once done)
// =============================================================================

/**
 * Backfill `has_files = true` on media_items that have at least one linked file
 * or whose children have files. Idempotent — 0 rows updated once everything is
 * backfilled. Called once per cleanup tick; the WHERE has_files = false clause
 * short-circuits as soon as the column is fully populated.
 *
 * Two passes on the parent walk are required because a grandchild→child→parent
 * chain needs two hops: the first pass sets `has_files` on seasons (whose
 * episodes carry files), the second lifts it up to series.
 *
 * Dismissed rows are skipped: a dismissal keeps the file links but clears
 * has_files on purpose (see propagateHasFiles in media-files.queries.ts), and
 * this runs every cleanup tick — it would undo every "Remove from library".
 */
export async function backfillHasFilesMediaItems(sql: postgres.Sql): Promise<void> {
    await sql`
        UPDATE media_items SET has_files = true
        WHERE has_files = false AND NOT is_dismissed
          AND id IN (
              SELECT DISTINCT mfi.media_item_id FROM media_file_items mfi
              JOIN media_files mf ON mf.id = mfi.file_id AND NOT mf.is_missing
          )
    `;
    await sql`
        UPDATE media_items SET has_files = true
        WHERE has_files = false AND NOT is_dismissed AND id IN (
            SELECT DISTINCT parent_id FROM media_items
            WHERE has_files = true AND parent_id IS NOT NULL
        )
    `;
    await sql`
        UPDATE media_items SET has_files = true
        WHERE has_files = false AND NOT is_dismissed AND id IN (
            SELECT DISTINCT parent_id FROM media_items
            WHERE has_files = true AND parent_id IS NOT NULL
        )
    `;
}

/**
 * Media types whose rows carry `has_files = true` with NO `media_file_items` row,
 * BY DESIGN. {@link clearStaleHasFilesMediaItems} must never touch them.
 *
 * - `audiobook` — the bytes live on the AudiobookShelf server; playback resolves
 *   through `external_ids`. `audiobooks.queries.ts:1-25` states it outright:
 *   "`has_files` means 'playable in this install', not 'has a local file'". Measured
 *   on prod 2026-07-30: **1183** audiobook rows are `has_files = true` with zero file
 *   rows. Omitting this exclusion would clear every one of them on the first tick and
 *   delete the whole audiobook library from browse, search, availability and the
 *   music/recommendation gates — all of which use `has_files` as the O(1)
 *   library-membership predicate (`availability.queries.ts`, `browse.queries.ts`,
 *   `search-access-context.ts`).
 * - `product` — the showcase catalog documents `has_files = true` as its
 *   "published" gate (`showcase.queries.ts`). Defensive: no writer lives in this
 *   tree, so it cannot be verified here, and guessing wrong is destructive.
 *
 * KEEP IN SYNC: any future remote-source integration that adopts the same
 * "playable but file-less" convention must be added here in the SAME commit that
 * introduces it.
 */
const FILELESS_BY_DESIGN_MEDIA_TYPES = ['audiobook', 'product'] as const;

/**
 * Clear a STALE `has_files = true` — the missing other half of
 * {@link backfillHasFilesMediaItems}.
 *
 * That function only ever sets `true` (three `WHERE has_files = false` passes), so
 * once a flag is wrong in the `true` direction nothing in the app ever heals it. The
 * per-item recompute that IS bidirectional (`recomputeHasFilesBatch`,
 * `media-files.queries.ts`) only runs on paths that delete a file through the
 * sanctioned helpers — so any bulk removal, manual DB action, or older code path
 * leaves a permanent phantom. Observed on prod 2026-07-30: "Macross Plus" held
 * `has_files = true` on its `tv` and `season` rows with all four episodes at `false`
 * and no file rows anywhere, which kept it inside the `provider-artwork-*` eligibility
 * domain (those stages require `has_files = true`) and dead-lettered its artwork.
 *
 * Deliberately a SEPARATE function rather than a fourth pass inside
 * `backfillHasFilesMediaItems`: that name and its docstring promise "backfill to
 * true", and a function that silently also clears would be a trap for the next reader.
 *
 * Bounded by `limit` because, unlike the `true`-only backfill (whose
 * `WHERE has_files = false` matches nothing on a settled install), the first run
 * against an install with historic drift can match a large number of rows.
 *
 * Returns the number of rows cleared.
 */
export async function clearStaleHasFilesMediaItems(
    sql: postgres.Sql,
    limit: number = 10_000,
): Promise<number> {
    // Set-based anti-join, NOT a correlated `EXISTS (... linked.id = mi.id OR
    // linked.parent_id = mi.id OR ...)`. The correlated OR form is the intuitive
    // translation of the 3-level tree, but it cannot use an index for the OR arms and
    // failed to return AT ALL within 300s against prod's catalog. Building the
    // "is backed by a file" set once and anti-joining is the same predicate and
    // returns in well under a second.
    const result = await sql`
        WITH owns AS (
            SELECT DISTINCT mfi.media_item_id AS id FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id AND NOT mf.is_missing
        ), lvl1 AS (
            SELECT DISTINCT mi.parent_id AS id
              FROM media_items mi JOIN owns o ON o.id = mi.id
             WHERE mi.parent_id IS NOT NULL
        ), lvl2 AS (
            SELECT DISTINCT mi.parent_id AS id
              FROM media_items mi JOIN lvl1 l ON l.id = mi.id
             WHERE mi.parent_id IS NOT NULL
        ), backed AS (
            SELECT id FROM owns
            UNION SELECT id FROM lvl1
            UNION SELECT id FROM lvl2
        ), stale AS (
            SELECT mi.id
              FROM media_items mi
              LEFT JOIN backed b ON b.id = mi.id
             WHERE mi.has_files = true
               -- Soft-deleted / merged rows get has_files = false explicitly at their
               -- own delete sites; touching them here is blast radius for no gain.
               AND mi.status = 'active'
               AND mi.media_type <> ALL(${FILELESS_BY_DESIGN_MEDIA_TYPES}::text[])
               AND b.id IS NULL
             LIMIT ${limit}
        )
        UPDATE media_items
           SET has_files = false, updated_at = now()
         WHERE id IN (SELECT id FROM stale)
    `;
    return result.count ?? 0;
}

// =============================================================================
// 1a. Merge duplicate series stubs
// =============================================================================

/**
 * Find TV stubs (no external_ids, has children) that match exactly one
 * canonical series (has external_ids) by normalized title and, when the stub has
 * a year, that year. Unknown years also require matching episode positions and
 * no other title-matched root with a different known year, in any status.
 *
 * 30-minute grace window on the stub's created_at: the scanner can create a
 * series stub and attach its children/external_ids non-transactionally (same
 * race documented on softDeleteOrphanMusicItems below). Without the grace, a
 * cleanup tick could merge-away a brand-new stub mid-scan, before the
 * provider match / children finish landing.
 */
export async function findMergeStubCandidates(
    sql: postgres.Sql,
    limit = 500,
): Promise<MergeStubCandidate[]> {
    // "Exactly one canonical match" is a GROUP BY ... HAVING count(*) = 1. The
    // previous correlated COUNT(*) re-scanned every canonical series per series
    // row (prod: 6,865 x 6,857 lower(trim()) evaluations, 21 s per run). The two
    // MATERIALIZED steps make the planner start from the few stubs; without them
    // it kept a nested loop (6 s). Same rows; prod 89 ms.
    return sql<MergeStubCandidate[]>`
        WITH no_ext AS MATERIALIZED (
            SELECT mi.id, mi.title, mi.year
            FROM media_items mi
            WHERE mi.status = 'active'
              AND mi.media_type = 'tv'
              AND mi.parent_id IS NULL
              AND mi.created_at < NOW() - INTERVAL '30 minutes'
              AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
        ),
        stubs AS MATERIALIZED (
            SELECT n.id, n.year, LOWER(TRIM(n.title)) AS title_key
            FROM no_ext n
            WHERE EXISTS (SELECT 1 FROM media_items c WHERE c.parent_id = n.id)
        )
        SELECT s.id AS stub_id, (array_agg(c.id))[1] AS canonical_id
        FROM stubs s
        JOIN media_items c
          ON c.status = 'active'
         AND c.media_type = 'tv'
         AND c.parent_id IS NULL
         AND LOWER(TRIM(c.title)) = s.title_key
         AND (c.year = s.year OR (s.year IS NULL
             -- A title-only stub must not pick one surviving remake after another
             -- series was deleted/merged or has not yet received external ids.
             AND NOT EXISTS (
                 SELECT 1 FROM media_items other
                 WHERE other.media_type = 'tv' AND other.parent_id IS NULL
                   AND LOWER(TRIM(other.title)) = s.title_key
                   AND other.year IS NOT NULL AND other.year IS DISTINCT FROM c.year
             )
             AND EXISTS (
                 SELECT 1 FROM media_items ss
                 JOIN media_items se ON se.parent_id = ss.id AND se.media_type = 'episode' AND se.status = 'active'
                 JOIN media_items cs ON cs.parent_id = c.id AND cs.media_type = 'season'
                     AND cs.status = 'active' AND cs.season_number = ss.season_number
                 JOIN media_items ce ON ce.parent_id = cs.id AND ce.media_type = 'episode'
                     AND ce.status = 'active' AND ce.episode_number = se.episode_number
                     AND COALESCE(ce.season_number, cs.season_number) = COALESCE(se.season_number, ss.season_number)
                 WHERE ss.parent_id = s.id AND ss.media_type = 'season' AND ss.status = 'active'
             )
         ))
         AND EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = c.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
        GROUP BY s.id
        HAVING count(*) = 1
        ORDER BY s.id
        LIMIT ${limit}
    `;
}

/**
 * Apply one stub-merge: re-parent non-conflicting children onto the canonical
 * series, consolidating conflicting seasons before deleting their empty shells.
 * Referenced episode clashes abort the whole transaction; the caller logs the skip.
 */
export async function applyStubMerge(
    sql: postgres.Sql,
    stubId: string,
    canonicalId: string,
): Promise<void> {
    await sql.begin(async (tx) => {
        const txSql = tx as unknown as postgres.Sql;
        // Lock BOTH complete trees in one global UUID order, before any writes.
        // Parent-first locks invert the scanner/recompute ancestor-chain order.
        // NO KEY UPDATE remains compatible with file-link FK KEY SHARE locks.
        const locked = await txSql<{ id: string; root_id: string }[]>`
            WITH RECURSIVE subtree AS (
                SELECT id, id AS root_id FROM media_items WHERE id IN (${stubId}, ${canonicalId})
                UNION ALL
                SELECT mi.id, s.root_id FROM media_items mi JOIN subtree s ON mi.parent_id = s.id
            )
            SELECT mi.id, s.root_id FROM media_items mi JOIN subtree s ON mi.id = s.id
            ORDER BY mi.id FOR NO KEY UPDATE OF mi
        `;
        const lockedIds = locked.map((row) => row.id);
        const lockedSet = new Set(lockedIds);
        const sourceIds = locked.filter((row) => row.root_id === stubId).map((row) => row.id);
        const roots = await txSql`
            SELECT id FROM media_items WHERE id IN (${stubId}, ${canonicalId})
                AND parent_id IS NULL AND media_type = 'tv' AND status = 'active'
                AND NOT EXISTS (
                    -- A row may have left these trees while the ordered lock
                    -- waited. Never let recomputation lock an outside ancestor
                    -- after this transaction already holds the original set.
                    SELECT 1 FROM media_items member
                    WHERE member.id = ANY(${lockedIds}::uuid[]) AND member.parent_id IS NOT NULL
                        AND NOT (member.parent_id = ANY(${lockedIds}::uuid[]))
                )
        `;
        if (roots.length !== 2) throw new Error(`Skipping stub merge ${stubId}: hierarchy changed`);
        const conflicts = await txSql<
            { stub_season: string; canonical_season: string; canonical_status: string }[]
        >`
            SELECT child.id AS stub_season, existing.id AS canonical_season, existing.status AS canonical_status
            FROM media_items child
            JOIN media_items existing ON existing.parent_id = ${canonicalId}
                AND existing.season_number = child.season_number
            WHERE child.parent_id = ${stubId} AND child.media_type = 'season'
                AND existing.media_type = 'season'
        `;
        if (new Set(conflicts.map((c) => c.stub_season)).size !== conflicts.length) {
            throw new Error(`Skipping stub merge ${stubId}: ambiguous canonical seasons`);
        }
        for (const conflict of conflicts) {
            if (!lockedSet.has(conflict.stub_season) || !lockedSet.has(conflict.canonical_season)) {
                throw new Error(`Skipping stub merge ${stubId}: hierarchy changed during locking`);
            }
            if (conflict.canonical_status !== 'active') {
                // Deleted seasons still occupy the unique key. Do not move live
                // episodes beneath them: keep referenced source trees intact,
                // otherwise retire the duplicate tree in place.
                const descendants = await txSql<{ id: string; protected: boolean }[]>`
                    WITH RECURSIVE subtree AS (
                        SELECT id FROM media_items WHERE id = ${conflict.stub_season}
                        UNION ALL
                        SELECT mi.id FROM media_items mi JOIN subtree s ON mi.parent_id = s.id
                    )
                    SELECT child.id, (NOT ${mediaReferenceGuard(txSql, 'child')}
                        OR EXISTS (SELECT 1 FROM media_file_items f WHERE f.media_item_id = child.id)
                        OR EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = child.id)) AS protected
                    FROM media_items child JOIN subtree s ON s.id = child.id
                `;
                if (descendants.some((row) => row.protected || !lockedSet.has(row.id))) {
                    throw new Error(
                        `Skipping stub merge ${stubId}: referenced or changing duplicate season`,
                    );
                }
                await txSql`UPDATE media_items SET status = 'deleted', updated_at = NOW()
                    WHERE id = ANY(${descendants.map((row) => row.id)}::uuid[])`;
                continue;
            }
            const shellReferences = await txSql`
                SELECT child.id FROM media_items child WHERE child.id = ${conflict.stub_season}
                AND (NOT ${mediaReferenceGuard(txSql, 'child')}
                    OR EXISTS (SELECT 1 FROM media_file_items f WHERE f.media_item_id = child.id))
            `;
            if (shellReferences.length)
                throw new Error(`Skipping stub merge ${stubId}: referenced conflicting season`);
            const episodes = await txSql<{ id: string; clashes: boolean }[]>`
                SELECT child.id, EXISTS (
                    SELECT 1 FROM media_items existing
                    WHERE existing.parent_id = ${conflict.canonical_season}
                        AND existing.media_type = child.media_type
                        AND existing.season_number IS NOT DISTINCT FROM child.season_number
                        AND existing.episode_number = child.episode_number
                ) AS clashes
                FROM media_items child WHERE child.parent_id = ${conflict.stub_season}
                ORDER BY child.id
            `;
            for (const episode of episodes) {
                if (!lockedSet.has(episode.id))
                    throw new Error(
                        `Skipping stub merge ${stubId}: hierarchy changed during locking`,
                    );
                if (!episode.clashes) {
                    // Retain the original UUID, and therefore its files and all
                    // user state, while making it browsable under the canonical season.
                    await txSql`UPDATE media_items SET parent_id = ${conflict.canonical_season}, updated_at = NOW() WHERE id = ${episode.id}`;
                    continue;
                }
                const protectedRows = await txSql`
                    SELECT child.id FROM media_items child WHERE child.id = ${episode.id}
                    AND (NOT ${mediaReferenceGuard(txSql, 'child')}
                        OR EXISTS (SELECT 1 FROM media_file_items f WHERE f.media_item_id = child.id)
                        OR EXISTS (SELECT 1 FROM media_items descendant WHERE descendant.parent_id = child.id)
                        OR EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = child.id))
                `;
                if (protectedRows.length) {
                    throw new Error(
                        `Skipping stub merge ${stubId}: clashing episode has user references, file-linked descendants or identity`,
                    );
                }
                await txSql`UPDATE media_items SET status = 'deleted', updated_at = NOW() WHERE id = ${episode.id}`;
            }
            await txSql`UPDATE media_items SET status = 'deleted', updated_at = NOW() WHERE id = ${conflict.stub_season}`;
        }
        await txSql`UPDATE media_items SET parent_id = ${canonicalId}, updated_at = NOW()
            WHERE parent_id = ${stubId} AND status <> 'deleted' AND id = ANY(${lockedIds}::uuid[])`;
        // An insert arriving during the merge must not be hidden by a deleted
        // shell. Abort rather than acquire a new row lock out of UUID order.
        const unexpectedChildren = await txSql`
            SELECT child.id FROM media_items child JOIN media_items parent ON parent.id = child.parent_id
            WHERE child.status = 'active' AND (parent.id = ${stubId}
                OR (parent.status = 'deleted' AND parent.id = ANY(${sourceIds}::uuid[]))) LIMIT 1
        `;
        if (unexpectedChildren.length)
            throw new Error(`Skipping stub merge ${stubId}: active children remain`);
        await txSql`UPDATE media_items SET status = 'deleted', updated_at = NOW() WHERE id = ${stubId}`;
        // All old/new ancestors are already in the globally ordered locked set.
        // The helper reads links in a fresh statement after those locks.
        await recomputeHasFilesBatch(txSql, lockedIds);
    });
}

// =============================================================================
// 1b. Reclassify misidentified episode-as-series stubs
// =============================================================================

/**
 * Find TV stubs that look like scanner mis-detections of episode filenames as
 * series: no external IDs, no year, 0–2 children. These originate when the
 * scanner uses an episode filename as the series title before the provider
 * match lands.
 *
 * CRITICAL SAFETY GUARD (D5):
 * Stubs whose linked media_files currently exist on disk (file_path is not
 * NULL, meaning the file record still references a path — no soft-delete /
 * missing marker) are EXCLUDED from this reclassify path. Hard-deleting their
 * media_file_items would sever the file link permanently, and if the scanner
 * never runs again (manual-import setups, Jellyfin disabled) those episodes
 * become orphaned on disk with no way to re-link.
 *
 * Stubs with no linked files, or with linked files whose file_path has been
 * cleared (scanner detected them as gone), still flow through this path.
 *
 * 30-minute grace window on the stub's created_at (same rationale as
 * findMergeStubCandidates / softDeleteOrphanMusicItems): the scanner inserts
 * the stub before its provider match / children land, so a fresh stub must
 * survive a cleanup tick that races that non-transactional window.
 */
export async function findMisidentifiedEpisodes(
    sql: postgres.Sql,
    limit = 500,
): Promise<MisidentifiedStub[]> {
    return sql<MisidentifiedStub[]>`
        WITH unmatched_stubs AS (
            SELECT mi.id AS stub_id
            FROM media_items mi
            WHERE mi.status = 'active'
              AND mi.media_type = 'tv'
              AND mi.parent_id IS NULL
              AND mi.year IS NULL
              AND mi.created_at < NOW() - INTERVAL '30 minutes'
              AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
              AND (SELECT COUNT(*) FROM media_items c WHERE c.parent_id = mi.id) BETWEEN 0 AND 2
              -- D5 safety guard: do NOT reclassify if any file under this stub
              -- still points at an on-disk path. A pending-match series with
              -- year not yet populated should survive; the scanner will pick
              -- it back up when provider lookup completes.
              AND NOT EXISTS (
                  SELECT 1
                  FROM media_items descendant
                  JOIN media_file_items mfi ON mfi.media_item_id = descendant.id
                  JOIN media_files mf ON mf.id = mfi.file_id
                  WHERE mf.file_path IS NOT NULL
                    AND (
                        descendant.id = mi.id
                        OR descendant.parent_id = mi.id
                        OR descendant.parent_id IN (
                            SELECT id FROM media_items WHERE parent_id = mi.id
                        )
                    )
              )
        )
        SELECT stub_id FROM unmatched_stubs
        LIMIT ${limit}
    `;
}

/**
 * Apply the reclassify operation for a single stub: hard-delete any remaining
 * media_file_items in the hierarchy (file rows live on so the scanner can
 * re-link on next run), then soft-delete grandchildren → children → stub.
 */
export async function applyReclassify(sql: postgres.Sql, stubId: string): Promise<void> {
    await sql.begin(async (tx) => {
        const txSql = tx as unknown as postgres.Sql;
        const hierarchy = await txSql<{ id: string }[]>`
            SELECT id FROM media_items WHERE id = ${stubId}
            UNION ALL
            SELECT id FROM media_items WHERE parent_id = ${stubId}
            UNION ALL
            SELECT gc.id FROM media_items gc
            JOIN media_items c ON c.id = gc.parent_id
            WHERE c.parent_id = ${stubId}
        `;
        const ids = hierarchy.map((r) => r.id);

        // Unlink media_file_items so files can be re-linked on next scan
        await txSql`
            DELETE FROM media_file_items
            WHERE media_item_id = ANY(${ids})
        `;

        // Soft-delete grandchildren → children → stub
        await txSql`
            UPDATE media_items
            SET status = 'deleted', has_files = false, updated_at = NOW()
            WHERE parent_id IN (
                SELECT id FROM media_items WHERE parent_id = ${stubId}
            )
        `;
        await txSql`
            UPDATE media_items
            SET status = 'deleted', has_files = false, updated_at = NOW()
            WHERE parent_id = ${stubId}
        `;
        await txSql`
            UPDATE media_items
            SET status = 'deleted', has_files = false, updated_at = NOW()
            WHERE id = ${stubId}
        `;
    });
}

// =============================================================================
// 1c. Orphan media stubs
// =============================================================================

/**
 * Soft-delete parent-level TV / artist items that have no children, no
 * external IDs, and no linked files. tvchannel items are excluded — they're
 * linked via livetv_channels, not external_ids or media_file_items.
 *
 * 30-minute grace window: mirrors softDeleteOrphanMusicItems below — the
 * scanner inserts a parent stub before its children / external_ids / files
 * are attached (not transactional), so a cleanup tick racing a fresh scan
 * could otherwise soft-delete a series/artist that is still mid-creation.
 *
 * Credit-only artist exclusion (bug: "Pimp! Code" search regression): an
 * artist can be a legitimate, actively-referenced entity while still having
 * zero children — `ensureTrackArtistLinks` (file-scanner) links a track's
 * non-album-owning performer via `custom_metadata.additional_artist_ids`
 * instead of parenting an album under them (e.g. a performer credited on a
 * Various-Artists compilation track). Such an artist owns no album, has no
 * external_ids, and has no media_file_items of its own — so without this
 * check it satisfies every "orphan" predicate above and gets soft-deleted,
 * even though it is still linked from other active tracks and still
 * resolves fine via direct-id lookup (getArtistWithAlbums has no status
 * filter), leaving it permanently unsearchable (searchMusic requires
 * status = 'active') while its credited tracks keep showing up.
 *
 * Returns the number of rows soft-deleted.
 */
export async function softDeleteOrphanMediaStubs(sql: postgres.Sql): Promise<number> {
    const result = await sql`
        UPDATE media_items
        SET status = 'deleted', updated_at = NOW()
        WHERE status = 'active'
          AND media_type IN ('tv', 'artist')
          AND parent_id IS NULL
          AND created_at < NOW() - INTERVAL '30 minutes'
          AND NOT EXISTS (SELECT 1 FROM media_items c WHERE c.parent_id = media_items.id)
          AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = media_items.id)
          AND NOT EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = media_items.id)
          AND NOT EXISTS (
              SELECT 1 FROM media_items t
              WHERE t.media_type = 'track'
                AND t.status = 'active'
                AND t.custom_metadata->'additional_artist_ids' @> jsonb_build_array(media_items.id::text)
          )
    `;
    return result.count;
}

// =============================================================================
// 1c.5. Heal dead additional_artist_ids references
// =============================================================================

/**
 * Self-heal pass for the credit-only-artist soft-delete bug (see
 * softDeleteOrphanMediaStubs docstring): before that exclusion guard existed,
 * a credit-only artist (referenced only via other tracks'
 * `additional_artist_ids`, never a track/album parent of its own) could get
 * soft-deleted as a false "orphan". Restoring those rows outright isn't
 * always possible — `uq_music_artist_norm_title` (migration 16.77.0) means a
 * deleted row's normalized title can now collide with an active row created
 * in the meantime, so un-deleting would violate the partial unique index.
 * Instead, this rewrites the dead UUID inside every active track's
 * `additional_artist_ids` to point at that active same-name row, leaving the
 * soft-deleted row alone (it stays deleted, but nothing references it
 * anymore).
 *
 * Identity rule is shared with `autoMergeDuplicateArtists` via
 * `artistNormTitleSql` (regexp_replace + Various-Artists alias folding) —
 * both read the same fragment so the two functions can never disagree about
 * which active artist is "the same" one (one merging a pair the other
 * wouldn't heal, or vice versa).
 *
 * Canonical pick when multiple active rows share the norm: oldest
 * `created_at` (same tiebreak as `findOrCreateMusicArtist`).
 *
 * `replaceArtistIdInTracks` performs an order-preserving rename but does not
 * dedupe, so a track that already carried the canonical id ends up with it
 * twice (e.g. `[canonicalId, deadId]` → `[canonicalId, canonicalId]`).
 * `dedupeAdditionalArtistIds` collapses that back down to first-occurrence
 * order immediately after each pair's rewrite.
 *
 * Idempotent: once a dead artist's id no longer appears in any active
 * track's `additional_artist_ids`, it no longer satisfies the "referenced"
 * predicate below and is skipped on subsequent runs.
 *
 * Returns the number of (dead → canonical) pairs rewritten.
 */
export async function healDeadArtistReferences(sql: postgres.Sql): Promise<number> {
    const pairs = await sql<{ dead_id: string; canonical_id: string }[]>`
        WITH dead AS (
            SELECT mi.id,
                -- Shared with autoMergeDuplicateArtists's per_artist CTE via
                -- artistNormTitleSql, so both functions agree on artist identity.
                ${artistNormTitleSql(sql, 'mi')} AS norm
            FROM media_items mi
            WHERE mi.media_type = 'artist'
              AND mi.parent_id IS NULL
              AND mi.status = 'deleted'
              AND EXISTS (
                  SELECT 1 FROM media_items t
                  WHERE t.media_type = 'track'
                    AND t.status = 'active'
                    AND jsonb_typeof(t.custom_metadata->'additional_artist_ids') = 'array'
                    AND t.custom_metadata->'additional_artist_ids' @> jsonb_build_array(mi.id::text)
              )
        ),
        canonical AS (
            SELECT mi.id, mi.created_at,
                ${artistNormTitleSql(sql, 'mi')} AS norm
            FROM media_items mi
            WHERE mi.media_type = 'artist'
              AND mi.parent_id IS NULL
              AND mi.status = 'active'
        )
        SELECT DISTINCT ON (dead.id)
            dead.id AS dead_id,
            canonical.id AS canonical_id
        FROM dead
        JOIN canonical ON canonical.norm = dead.norm
        ORDER BY dead.id, canonical.created_at ASC
    `;

    let healed = 0;
    for (const { dead_id, canonical_id } of pairs) {
        // Transaction-wrap the pair (mirrors autoMergeDuplicateArtists's
        // per-group sql.begin): without it, an exception between the rename
        // and the dedupe would leave a permanent `[canonical, canonical]`
        // duplicate that this pass can never revisit — once the rename
        // succeeds, the dead id is unreferenced and drops out of the `dead`
        // CTE's EXISTS check on every subsequent run.
        await sql.begin(async (tx) => {
            const txSql = tx as unknown as postgres.Sql;
            await replaceArtistIdInTracks(txSql, dead_id, canonical_id);
            await dedupeAdditionalArtistIds(txSql, canonical_id);
        });
        healed++;
    }
    return healed;
}

// =============================================================================
// 1c.6. Drop additional_artist_ids that point at no row at all
// =============================================================================

/** Tracks healed per cleanup tick; the rest carries over to the next tick. */
const DANGLING_ARTIST_ID_BATCH = 250;

export interface DanglingArtistIdHealResult {
    /** Tracks whose array was cleaned and credits re-derived. */
    tracks: number;
    /** Individual dead ids removed from those arrays. */
    idsDropped: number;
    /** Tracks whose credit re-derivation failed; their dead ids are still dropped. */
    failed: number;
    /** Message of the first failure, for the task log. */
    firstError?: string;
}

/**
 * Self-heal pass for `custom_metadata.additional_artist_ids` entries that
 * resolve to NO `media_items` row (the artist was hard-deleted while tracks
 * still referenced it; `healDeadArtistReferences` covers the soft-deleted
 * case). Replaces the former one-off repair script.
 *
 * Per affected track, in ONE transaction:
 *   1. drop every id that matches no `media_items` row, keeping the order of
 *      the valid ids (a compare-and-set on the array we read, so a concurrent
 *      scan write is never overwritten);
 *   2. `reconcileTrackArtistCredits`, the same call `ensureTrackArtistLinks`
 *      makes, which re-splits the intact scalar `custom_metadata.artist`
 *      credit ("A und B") into real artists and links them.
 *
 * `metadata_locked` tracks are excluded in SQL (operator-owned, and
 * reconcile refuses them anyway, so selecting them would re-pick them every
 * tick). Only `active` tracks are looked at: reconcile ignores the others and
 * a soft-deleted track is gone from every listing.
 *
 * Query design: a set-based anti-join. Each array is expanded once with
 * `jsonb_array_elements_text ... WITH ORDINALITY` (order is kept) and
 * LEFT JOINed to `media_items` on its primary key `id` (uuid compared to uuid,
 * so the PK index is used; the earlier `a.id::text = e.aid` form cannot use
 * it and re-scanned the table per element, > 2 min on prod). Entries that are
 * not UUID text are mapped to NULL before the cast (no cast error) and count
 * as dangling. Tracks without the key, or with `[]`, produce no rows from the
 * lateral expansion, so the work is proportional to the number of ids stored,
 * plus one sequential pass over media_items to find the tracks. HAVING
 * `bool_or(a.id IS NULL)` keeps only tracks with at least one dead id; when
 * nothing is dangling the result is empty and the pass is a read-only no-op.
 *
 * Idempotent: a healed track has no dead id and is not selected again.
 * Bounded: at most `limit` tracks per call. A track whose reconcile throws is
 * counted as failed, but its dead ids are still dropped in a separate small
 * update, so it leaves the selection instead of starving later tracks.
 */
export async function healDanglingArtistIds(
    sql: postgres.Sql,
    options: { limit?: number; signal?: AbortSignal } = {},
): Promise<DanglingArtistIdHealResult> {
    const limit = options.limit ?? DANGLING_ARTIST_ID_BATCH;
    // Written without backslash escapes: postgres.js interpolates the cooked
    // template string (see UUID_TEXT_PATTERN in music-artist.fragments.ts).
    const uuidText =
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    const rows = await sql<{ id: string; original: unknown[]; valid_ids: string[] }[]>`
        SELECT
            t.id,
            t.custom_metadata->'additional_artist_ids' AS original,
            COALESCE(
                array_agg(e.aid ORDER BY e.ord) FILTER (WHERE a.id IS NOT NULL),
                ARRAY[]::text[]
            ) AS valid_ids
        FROM media_items t
        CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(t.custom_metadata->'additional_artist_ids') = 'array'
                 THEN t.custom_metadata->'additional_artist_ids'
                 ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS e(aid, ord)
        LEFT JOIN media_items a
               ON a.id = CASE WHEN e.aid ~ ${uuidText} THEN e.aid::uuid END
        WHERE t.media_type = 'track'
          AND t.status = 'active'
          AND t.metadata_locked IS NOT TRUE
        GROUP BY t.id
        HAVING bool_or(a.id IS NULL)
        ORDER BY t.id
        LIMIT ${limit}
    `;
    const result: DanglingArtistIdHealResult = { tracks: 0, idsDropped: 0, failed: 0 };
    if (rows.length === 0) return result;

    const evidence = await getArtistCreditEvidence(sql);
    // Compare-and-set on the array we read: a rescan's write is never overwritten.
    const dropDeadIds = async (db: postgres.Sql, row: (typeof rows)[number]): Promise<boolean> => {
        const [updated] = await db<{ id: string }[]>`
            UPDATE media_items
            SET custom_metadata = custom_metadata
                || ${db.json({ additional_artist_ids: row.valid_ids })}
            WHERE id = ${row.id}
              AND media_type = 'track'
              AND metadata_locked IS NOT TRUE
              AND custom_metadata->'additional_artist_ids' = ${db.json(row.original as never)}
            RETURNING id
        `;
        return Boolean(updated);
    };

    for (const row of rows) {
        if (options.signal?.aborted) break;
        const droppedCount = row.original.length - row.valid_ids.length;
        try {
            const done = await sql.begin(async (tx) => {
                const txSql = tx as unknown as postgres.Sql;
                // Changed under us (rescan) or locked meanwhile: leave it, the
                // next tick re-evaluates the new state.
                if (!(await dropDeadIds(txSql, row))) return false;
                await reconcileTrackArtistCredits(txSql, row.id, { evidence });
                return true;
            });
            if (done) {
                result.tracks++;
                result.idsDropped += droppedCount;
            }
        } catch (err) {
            result.failed++;
            result.firstError ??= err instanceof Error ? err.message : String(err);
            // The transaction rolled back, so the track would be selected again
            // every tick and, ordered by id, could starve later tracks. Commit
            // the dead-id drop on its own; the next scan reconciles the credits.
            try {
                if (await dropDeadIds(sql, row)) result.idsDropped += droppedCount;
            } catch {
                // Still failing: stays selected, counted as failed above.
            }
        }
    }
    return result;
}

// =============================================================================
// 1d. Orphan music tracks/albums (no media_file_items link)
// =============================================================================

/**
 * Soft-delete `track` and `album` rows that have no `media_file_items` link
 * and no children of their own. These accumulate when bulk re-scans drop
 * file-item rows without removing the parent media row, leaving 404-on-stream
 * ghosts that still surface in Quick Picks / Stations / autoplay until they
 * age out via the existing 30-day retention into hardDelete cascade.
 *
 * 30-minute grace window: the file scanner inserts a track row before
 * attaching its media_file (`audio-processor.ts` lines 1681 → 1702 are not
 * transactional). Without the grace, a cleanup tick that races a fresh scan
 * could soft-delete a brand-new track between insert and attach.
 *
 * Returns the number of rows soft-deleted.
 */
/**
 * Auto-merge legacy duplicate artist rows. Groups artists by normalized
 * title (same regex as findOrCreateMusicArtist) and consolidates each
 * group into a single canonical row.
 *
 * Safety contract: a group is only merged when AT MOST ONE row in the
 * group has any external_ids. Two artists sharing a name but holding
 * different external_ids are likely genuinely-different artists (e.g.
 * two musicians named "John Smith") — merging those would corrupt the
 * MusicBrainz identity, so we skip the group entirely.
 *
 * Winner selection: oldest `created_at`. The bug-class that produces
 * these duplicates is "later scan supplies a library_group_id and the
 * lookup misses the older NULL-lgid row", so the older row is always
 * the originally-correct one with children + (sometimes) external_ids
 * already attached.
 *
 * For each loser, this:
 *   1. Reparents every child album under the loser to the winner. If
 *      the winner already has an album with the same title, the loser's
 *      tracks fold into the winner's album and the loser's album is
 *      deleted — or, when it is still referenced, kept soft-deleted under
 *      the winner so its references survive.
 *   2. Rewrites every track's `custom_metadata.additional_artist_ids`
 *      pointing at the loser to point at the winner.
 *   3. Migrates external_ids (only legal because at most one row holds
 *      any — and that's the winner by construction; nothing to do unless
 *      the loser is the older row, which can't happen given winner=
 *      oldest).
 *   4. Migrates user-tier rows that key on `media_id` (user_media_state,
 *      user_ratings, watch_history, playlist_items, user_media_flags (series_excluded),
 *      library_availability).
 *   5. Deletes the now-empty loser via `deleteEmptyArtist`.
 *
 * Returns counts so the operator can verify the cleanup converged.
 */
export async function autoMergeDuplicateArtists(
    sql: postgres.Sql,
    logger: {
        info(msg: string, meta?: object): void;
        warn(msg: string, meta?: object): void;
        debug(msg: string, meta?: object): void;
    },
    options: {
        limit?: number;
        /** Caller can hydrate release credits before the shared decision. */
        albumArtistDecision?: (
            tx: postgres.Sql,
            albumId: string,
        ) => Promise<AlbumArtistDecision | undefined>;
    } = {},
): Promise<{ merged: number; skipped: number }> {
    const limit = options.limit ?? 100;
    let merged = 0;
    let skipped = 0;

    // Find dup groups whose losers carry no external_ids. The aggregate
    // `MAX(ext_count) <= 1` is the safety filter: at most one row in the
    // group has any external_ids (i.e. zero collision potential).
    const groups = await sql<
        {
            norm: string;
            rows: { id: string; created_at: Date; ext_count: number }[];
        }[]
    >`
        WITH per_artist AS (
            SELECT
                mi.id,
                mi.title,
                mi.created_at,
                -- Strip punctuation, then fold VA aliases ("VA", "V.A.", "V/A",
                -- "Various", "Various Artists") into a single canonical norm so
                -- they land in one duplicate group and get merged rather than
                -- remaining as perpetual duplicate-artist-groups health invariant
                -- hits. Mirrors the VA_NAME_PATTERN from $lib/shared/various-artists.
                -- Shared with healDeadArtistReferences via artistNormTitleSql —
                -- see that function's docstring for why this must not be
                -- hand-copied.
                ${artistNormTitleSql(sql, 'mi')} AS norm,
                (SELECT COUNT(*) FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')::int AS ext_count
              FROM media_items mi
             WHERE mi.media_type = 'artist'
               AND mi.parent_id IS NULL
               AND mi.status = 'active'
        ),
        dup_groups AS (
            SELECT norm
              FROM per_artist
             GROUP BY norm
            HAVING COUNT(*) > 1
               AND SUM(CASE WHEN ext_count > 0 THEN 1 ELSE 0 END) <= 1
        )
        SELECT
            dg.norm,
            jsonb_agg(
                jsonb_build_object('id', pa.id, 'created_at', pa.created_at, 'ext_count', pa.ext_count)
                -- ext_count DESC FIRST so the row that HOLDS the external_ids
                -- (the MusicBrainz identity) becomes the winner (rows[0]). The
                -- dup_groups HAVING guarantees at most ONE row has external_ids,
                -- so every loser then has ext_count=0 and the hard delete can't
                -- drop a provider id (review fix). created_at ASC is the
                -- tiebreak when no row has external_ids.
                ORDER BY pa.ext_count DESC, pa.created_at ASC
            ) AS rows
          FROM dup_groups dg
          JOIN per_artist pa USING (norm)
         GROUP BY dg.norm
         LIMIT ${limit}
    `;

    for (const group of groups) {
        const rows = group.rows as unknown as {
            id: string;
            created_at: string;
            ext_count: number;
        }[];
        if (rows.length < 2) continue;
        const winnerId = rows[0].id;
        const loserIds = rows.slice(1).map((r) => r.id);

        try {
            const outcome = await sql.begin(async (tx) => {
                let didMerge = false;
                let didSkip = false;
                const txSql = tx as unknown as postgres.Sql;
                const [winner] = await txSql<
                    { title: string }[]
                >`SELECT title FROM media_items WHERE id=${winnerId}`;
                if (!winner) return { merged: false, skipped: true };
                for (const loserId of loserIds) {
                    // 1. Reparent albums. Handle title-collisions with the winner
                    //    by folding tracks into the winner's existing album.
                    const loserAlbums = await txSql<
                        { id: string; title: string; has_tracks: boolean }[]
                    >`
                        SELECT id, title, EXISTS (SELECT 1 FROM media_items t WHERE t.parent_id=media_items.id AND t.media_type='track' AND t.status='active') AS has_tracks FROM media_items
                         WHERE parent_id = ${loserId}::uuid
                           AND media_type = 'album'
                    `;
                    // Validate EVERY album before remapping the artist's own
                    // references. A retained album must retain its artist too.
                    let blocked = false;
                    const decisions = new Map<string, AlbumArtistDecision>();
                    for (const album of loserAlbums) {
                        const row = options.albumArtistDecision
                            ? undefined
                            : await findAlbumArtistEvidence(txSql, album.id);
                        const decision = options.albumArtistDecision
                            ? await options.albumArtistDecision(txSql, album.id)
                            : row &&
                              resolveAlbumArtist(row.track_metadata.map(albumFileCredit), {
                                  locked: row.metadata_locked,
                                  currentArtist: row.artist_title ?? undefined,
                                  fallbackArtist: row.file_path
                                      ? deriveArtistName({
                                            filePath: row.file_path,
                                            albumDir: resolveAlbumDir(row.file_path).albumDir,
                                            libraryRoot: row.library_root ?? undefined,
                                        })
                                      : 'Unknown Artist',
                              });
                        if (decision) decisions.set(album.id, decision);
                        // Empty albums carry no contrary tag evidence. Locks still win.
                        const [match] =
                            decision && album.has_tracks
                                ? await txSql<{ same: boolean }[]>`
                            SELECT ${artistNormTitleValueSql(txSql, txSql`${decision.artist}::text`)} = ${artistNormTitleValueSql(txSql, txSql`${winner.title}::text`)} AS same
                        `
                                : [{ same: true }];
                        if (
                            !decision ||
                            decision.locked ||
                            (album.has_tracks &&
                                (decision.various
                                    ? !isVariousArtistsName(winner.title)
                                    : !match.same))
                        ) {
                            blocked = true;
                            break;
                        }
                    }
                    if (blocked) {
                        didSkip = true;
                        logger.info(
                            'Retained duplicate artist — album placement rule or lock requires it',
                            { loserId, winnerId },
                        );
                        continue;
                    }
                    for (const album of loserAlbums) {
                        const winnerAlbumId = await txSql<{ id: string }[]>`
                            SELECT id FROM media_items
                             WHERE media_type = 'album'
                               AND parent_id = ${winnerId}::uuid
                               AND status = 'active' AND metadata_locked IS NOT TRUE
                               AND regexp_replace(LOWER(TRIM(title)), '[^a-z0-9 ]', '', 'g')
                                 = regexp_replace(LOWER(TRIM(${album.title})), '[^a-z0-9 ]', '', 'g')
                             ORDER BY created_at, id
                             LIMIT 1
                        `;
                        if (winnerAlbumId[0]) {
                            // Title collision — fold tracks, then let
                            // deleteEmptyAlbum hand the emptied album's user
                            // references to the winner album and drop it, or
                            // keep it soft-deleted under the winner.
                            await reparentTracksToAlbum(txSql, album.id, winnerAlbumId[0].id);
                            await deleteEmptyAlbum(
                                txSql,
                                album.id,
                                winnerAlbumId[0].id,
                                decisions.get(album.id)?.source,
                            );
                        } else {
                            await reparentAlbumToArtist(txSql, album.id, winnerId, {
                                respectMetadataLock: true,
                                ruleSource: decisions.get(album.id)?.source,
                            });
                        }
                    }

                    // 2. Replace artist id in tracks' additional_artist_ids.
                    await txSql`
                        UPDATE media_items
                           SET custom_metadata = jsonb_set(
                                   custom_metadata,
                                   '{additional_artist_ids}',
                                   (
                                       SELECT jsonb_agg(
                                           CASE WHEN v = to_jsonb(${loserId}::text)
                                                THEN to_jsonb(${winnerId}::text)
                                                ELSE v
                                           END
                                       )
                                         FROM jsonb_array_elements(custom_metadata->'additional_artist_ids') v
                                   )
                               )
                         WHERE media_type = 'track'
                           AND custom_metadata->'additional_artist_ids'
                               @> jsonb_build_array(${loserId}::text)
                    `;

                    // 3. Migrate user-tier rows. Each table independently —
                    //    NOT EXISTS guards against composite-key collisions
                    //    (e.g. user already rated both rows): keep the
                    //    winner's row, drop the loser's.
                    await txSql`
                        UPDATE user_media_state
                           SET media_id = ${winnerId}::uuid
                         WHERE media_id = ${loserId}::uuid
                           AND NOT EXISTS (
                               SELECT 1 FROM user_media_state w
                                WHERE w.media_id = ${winnerId}::uuid
                                  AND w.user_id = user_media_state.user_id
                           )
                    `;
                    await txSql`
                        DELETE FROM user_media_state WHERE media_id = ${loserId}::uuid
                    `;

                    await txSql`
                        UPDATE user_ratings
                           SET media_id = ${winnerId}::uuid
                         WHERE media_id = ${loserId}::uuid
                           AND NOT EXISTS (
                               SELECT 1 FROM user_ratings w
                                WHERE w.media_id = ${winnerId}::uuid
                                  AND w.user_id = user_ratings.user_id
                           )
                    `;
                    await txSql`DELETE FROM user_ratings WHERE media_id = ${loserId}::uuid`;

                    await txSql`
                        UPDATE watch_history SET media_id = ${winnerId}::uuid WHERE media_id = ${loserId}::uuid
                    `;
                    await txSql`
                        UPDATE playlists SET revision = revision + 1, updated_at = NOW()
                        WHERE id IN (SELECT playlist_id FROM playlist_items WHERE media_id = ${loserId}::uuid)
                    `;
                    await txSql`
                        UPDATE playlist_items SET media_id = ${winnerId}::uuid WHERE media_id = ${loserId}::uuid
                    `;
                    // After migration 16.108.0, UUID-keyed excluded-series rows live in
                    // user_media_flags with flag_type='series_excluded', target_type='series',
                    // target_id = media_id::text. Re-point the loser UUID to the winner UUID.
                    await txSql`
                        UPDATE user_media_flags
                           SET target_id = ${winnerId}
                         WHERE flag_type = 'series_excluded'
                           AND target_type = 'series'
                           AND target_id = ${loserId}
                    `;
                    await txSql`
                        UPDATE library_availability
                           SET media_id = ${winnerId}::uuid
                         WHERE media_id = ${loserId}::uuid
                           AND NOT EXISTS (
                               SELECT 1 FROM library_availability w
                                WHERE w.media_id = ${winnerId}::uuid
                                  AND w.library = library_availability.library
                                  AND w.library_item_id IS NOT DISTINCT FROM library_availability.library_item_id
                           )
                    `;
                    await txSql`DELETE FROM library_availability WHERE media_id = ${loserId}::uuid`;

                    // 4. Delete the now-childless loser. NOT EXISTS guards
                    //    against a concurrent scan that snuck a new child
                    //    in between the reparent UPDATE and this DELETE.
                    const dropped = await txSql`
                        DELETE FROM media_items
                         WHERE id = ${loserId}::uuid
                           AND NOT EXISTS (
                               SELECT 1 FROM media_items
                                WHERE parent_id = ${loserId}::uuid
                                  AND media_type = 'album'
                           )
                    `;
                    if (dropped.count === 0) {
                        // Race: don't fail the whole batch, just record and skip.
                        logger.warn(
                            'autoMergeDuplicateArtists: loser still has children after reparent',
                            {
                                loserId,
                                winnerId,
                            },
                        );
                        throw new Error('loser still has children');
                    }
                    didMerge = true;
                }
                return { merged: didMerge, skipped: didSkip };
            });
            if (outcome.merged) merged++;
            if (outcome.skipped) skipped++;
        } catch (err) {
            skipped++;
            logger.warn('autoMergeDuplicateArtists: group skipped', {
                norm: group.norm,
                winnerId,
                loserIds,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (merged > 0) {
        logger.info('autoMergeDuplicateArtists: merged duplicate artists', {
            merged,
            skipped,
        });
    }
    return { merged, skipped };
}

/**
 * Rename-race guard (fix #1, `rename-race-conditions.md`): a rename's soft
 * *dismiss* leaves a track/album `is_dismissed=true, status='active'` while
 * the reclaim window is open. Without the `is_dismissed = false` guard here,
 * this UPDATE would promote that row straight to `status='deleted'` (the
 * 30-day hard-delete track) with no dismiss-awareness — and the 30-minute
 * grace is on `created_at`, which does not protect a long-lived renamed
 * track. Guarding at the source (this query) stops the bad state from ever
 * forming during the reclaim window; the `dismissed_at` grace is
 * belt-and-suspenders for a hypothetical dismissed-but-flag-cleared row.
 */
export async function softDeleteOrphanMusicItems(sql: postgres.Sql): Promise<number> {
    const result = await sql`
        UPDATE media_items
        SET status = 'deleted', has_files = false, updated_at = NOW()
        WHERE status = 'active'
          AND media_type IN ('track', 'album')
          AND is_dismissed = false
          AND created_at < NOW() - INTERVAL '30 minutes'
          AND (dismissed_at IS NULL OR dismissed_at < NOW() - INTERVAL '30 minutes')
          AND NOT EXISTS (
              SELECT 1 FROM media_file_items mfi
              WHERE mfi.media_item_id = media_items.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM media_items child
              WHERE child.parent_id = media_items.id
                AND child.status = 'active'
          )
    `;
    return result.count;
}

// =============================================================================
// 2. Hard-delete soft-deleted media past retention
// =============================================================================

/**
 * The legacy 30-day purge predicate over `mi`: soft-deleted before the cutoff,
 * childless, file-less, not an alias target and unreferenced. Formerly
 * available rows of the media types the 365-day unavailable-media retention
 * covers are left to that policy; an artist still credited on any track is
 * kept.
 */
function hardDeletablePredicate(sql: postgres.Sql, cutoff: Date): ReturnType<postgres.Sql> {
    return sql`
        mi.status = 'deleted'
        AND mi.updated_at < ${cutoff}
        AND NOT (
            mi.media_type = ANY(${[...RETENTION_COVERED_MEDIA_TYPES]}::text[])
            AND ${formerlyAvailableSql(sql, 'mi')}
        )
        AND NOT EXISTS (SELECT 1 FROM media_items c WHERE c.parent_id = mi.id)
        AND NOT EXISTS (SELECT 1 FROM media_items alias WHERE alias.canonical_id = mi.id)
        AND NOT EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id)
        AND (
            mi.media_type <> 'artist'
            -- Credits compare normalized (case, dashes) so legacy spellings count;
            -- a non-array value holds no credits.
            OR NOT EXISTS (
                SELECT 1
                FROM media_items t
                CROSS JOIN LATERAL jsonb_array_elements_text(
                    CASE jsonb_typeof(t.custom_metadata->'additional_artist_ids')
                        WHEN 'array' THEN t.custom_metadata->'additional_artist_ids'
                        ELSE '[]'::jsonb
                    END
                ) AS credit(artist_id)
                WHERE t.media_type = 'track'
                  AND lower(replace(credit.artist_id, '-', '')) = replace(mi.id::text, '-', '')
            )
        )
        AND ${mediaReferenceGuard(sql, 'mi')}
    `;
}

/**
 * Find media_items that have been soft-deleted for longer than the retention
 * cutoff and pass {@link hardDeletablePredicate}. Returns a bounded list of
 * IDs; caller invokes MediaDeletionService.hardDelete() per ID (rechecking
 * {@link isHardDeletableMediaId} in its transaction) to get proper cleanup
 * (cache, embeddings).
 */
export async function findHardDeletableMediaIds(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 2000,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_items mi
        WHERE ${hardDeletablePredicate(sql, cutoff)}
        LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
}

/** In-transaction recheck of {@link findHardDeletableMediaIds} for one row. */
export async function isHardDeletableMediaId(
    sql: postgres.Sql,
    mediaId: string,
    cutoff: Date,
): Promise<boolean> {
    const rows = await sql<{ eligible: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM media_items mi
            WHERE mi.id = ${mediaId}::uuid AND ${hardDeletablePredicate(sql, cutoff)}
        ) AS eligible
    `;
    return rows[0]?.eligible === true;
}

/**
 * Purge media_item_stage_state rows for soft-deleted items. Soft-delete sites
 * (softDeleteOrphanMediaStubs / softDeleteOrphanMusicItems / applyReclassify
 * / mergeStubInto) flip media_items.status to 'deleted' but leave stage_state
 * rows behind. Coverage candidate queries that don't filter status (e.g.
 * findCoverageTableBacklog for trickplay) keep returning these orphans, the
 * admin backlog count stays inflated, and stage-sweep keeps enqueueing the
 * task with no real work. Hard-delete (MediaDeletionService) eventually
 * cascades via FK, but the retention window (days) means orphans accumulate.
 *
 * LIMIT-batched (unlike the rest of this file, this previously had no cap):
 * a large deleted-item backlog could otherwise touch millions of rows in one
 * unbounded DELETE, holding a long write lock for the task's whole timeout.
 * The caller loops this via `pruneUntilDrained` to drain the backlog across
 * bounded passes instead.
 *
 * Returns the number of stage_state rows purged in this pass.
 */
export async function purgeStageStateForDeletedItems(
    sql: postgres.Sql,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM media_item_stage_state
        WHERE (media_item_id, stage_id) IN (
            SELECT s.media_item_id, s.stage_id
              FROM media_item_stage_state s
              JOIN media_items mi ON mi.id = s.media_item_id
             WHERE mi.status != 'active'
             LIMIT ${limit}
        )
    `;
    return result.count;
}

// =============================================================================
// 3. Orphan media_files
// =============================================================================

/**
 * Remove media_files rows with no media_file_items link (bounded batch).
 * Returns the number of files deleted. Caller re-invokes in a loop if it
 * wants to drain the full backlog.
 */
export async function cleanupOrphanedMediaFiles(sql: postgres.Sql, limit = 10000): Promise<number> {
    // Skip rows whose `health_issues` carries an unresolved scan failure.
    // Those rows are written by the file-scanner specifically to remember
    // "this file failed to parse — needs admin attention or backoff retry"
    // (see recordFileScanIssue in media-files.queries.ts). Deleting them
    // here would erase the diagnostic state and re-arm the dup-creation
    // loop on the next scan.
    const result = await sql`
        DELETE FROM media_files
        WHERE id IN (
            SELECT mf.id FROM media_files mf
            WHERE NOT EXISTS (
                SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id
            )
              AND (
                  mf.health_issues IS NULL
                  OR NOT EXISTS (
                      SELECT 1 FROM jsonb_array_elements(mf.health_issues) i
                       WHERE i->>'type' = ANY(${UNLINKED_FILE_HEALTH_ISSUE_TYPES}::text[])
                  )
              )
            LIMIT ${limit}
        )
    `;
    return result.count;
}

// =============================================================================
// 3b. Orphaned interactions / interaction_reactions
// =============================================================================

/**
 * Delete `interactions` and `interaction_reactions` rows whose target no longer
 * exists. Because `target_type`/`target_id` are plain text with no FK, deleting
 * the parent entity (a media item, playlist, or person) leaves these rows behind
 * forever unless explicitly reconciled.
 *
 * Closed set of target_type values (enforced at app layer, migration 16.106.0):
 *   'media'    — media_items.id (UUID)
 *   'playlist' — playlists.id  (integer stored as text)
 *   'person'   — media_people.id (UUID)
 *
 * UUID cast guard: rows whose target_id is not a valid UUID format are skipped
 * by the `target_id ~ '^[0-9a-f]{8}-...'` filter so a malformed value can never
 * cause a bad `::uuid` cast and abort the whole statement. Integer guard uses
 * `~ '^\d+$'` for playlist rows.
 *
 * Split into six independently LIMIT-batched functions (one per table x
 * target_type) instead of a single unbounded six-statement transaction: a
 * large orphan backlog previously ran all six DELETEs unbounded inside one
 * transaction, holding a long-lived write lock for the whole task timeout.
 * Orphan deletion is idempotent (the predicate is re-evaluated every pass),
 * so batching each target-type independently — outside a shared transaction
 * — is safe: a failure or abort partway through leaves some target-types
 * cleaned and others not, which is fine, since the next run's predicate is
 * unaffected by that partial progress. The caller loops each of these via
 * `pruneUntilDrained` to drain the backlog across bounded passes.
 */
export const INTERACTIONS_UUID_PATTERN =
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const INTERACTIONS_INT_PATTERN = '^[0-9]+$';

/** Orphaned `interactions` rows targeting a deleted media item. */
export async function pruneOrphanedInteractionsMedia(
    sql: postgres.Sql,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM interactions
        WHERE id IN (
            SELECT i.id FROM interactions i
            WHERE i.target_type = 'media'
              AND i.target_id ~ ${INTERACTIONS_UUID_PATTERN}
              AND NOT EXISTS (
                  SELECT 1 FROM media_items WHERE id = i.target_id::uuid
              )
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/** Orphaned `interactions` rows targeting a deleted playlist. */
export async function pruneOrphanedInteractionsPlaylist(
    sql: postgres.Sql,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM interactions
        WHERE id IN (
            SELECT i.id FROM interactions i
            WHERE i.target_type = 'playlist'
              AND i.target_id ~ ${INTERACTIONS_INT_PATTERN}
              AND NOT EXISTS (
                  SELECT 1 FROM playlists WHERE id::text = i.target_id
              )
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/** Orphaned `interactions` rows targeting a deleted person. */
export async function pruneOrphanedInteractionsPerson(
    sql: postgres.Sql,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM interactions
        WHERE id IN (
            SELECT i.id FROM interactions i
            WHERE i.target_type = 'person'
              -- media_people.id is BIGINT, not uuid. This used the uuid pattern and
              -- an ::uuid cast (copy-pasted from the media/playlist variants, whose
              -- keys really are uuids), so the predicate was "bigint = uuid" and
              -- Postgres rejected it at PLAN time on every run since it shipped.
              -- It stayed invisible because database-cleanup only reports failure when
              -- the total cleaned count is zero: on a busy install some other stage
              -- always cleans something, so the run said "completed" while carrying
              -- this error in result.errors forever. Surfaced on preprod (quiet enough
              -- that the total WAS zero) 2026-07-30; prod had been hiding the identical
              -- pair of errors on every "completed" run.
              -- Compares id::text instead of casting target_id to bigint, matching the
              -- playlist variant above: a numeric string wider than bigint would
              -- overflow the cast (22003), whereas text comparison just fails to match.
              AND i.target_id ~ ${INTERACTIONS_INT_PATTERN}
              AND NOT EXISTS (
                  SELECT 1 FROM media_people WHERE id::text = i.target_id
              )
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/** Orphaned `interaction_reactions` rows targeting a deleted media item. */
export async function pruneOrphanedInteractionReactionsMedia(
    sql: postgres.Sql,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM interaction_reactions
        WHERE id IN (
            SELECT r.id FROM interaction_reactions r
            WHERE r.target_type = 'media'
              AND r.target_id ~ ${INTERACTIONS_UUID_PATTERN}
              AND NOT EXISTS (
                  SELECT 1 FROM media_items WHERE id = r.target_id::uuid
              )
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/** Orphaned `interaction_reactions` rows targeting a deleted playlist. */
export async function pruneOrphanedInteractionReactionsPlaylist(
    sql: postgres.Sql,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM interaction_reactions
        WHERE id IN (
            SELECT r.id FROM interaction_reactions r
            WHERE r.target_type = 'playlist'
              AND r.target_id ~ ${INTERACTIONS_INT_PATTERN}
              AND NOT EXISTS (
                  SELECT 1 FROM playlists WHERE id::text = r.target_id
              )
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/** Orphaned `interaction_reactions` rows targeting a deleted person. */
export async function pruneOrphanedInteractionReactionsPerson(
    sql: postgres.Sql,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM interaction_reactions
        WHERE id IN (
            SELECT r.id FROM interaction_reactions r
            WHERE r.target_type = 'person'
              -- Same "bigint = uuid" defect as pruneOrphanedInteractionsPerson above --
              -- see the full explanation there. Keep the two in step.
              AND r.target_id ~ ${INTERACTIONS_INT_PATTERN}
              AND NOT EXISTS (
                  SELECT 1 FROM media_people WHERE id::text = r.target_id
              )
            LIMIT ${limit}
        )
    `;
    return result.count;
}

// =============================================================================
// 4. Old finished play_sessions
// =============================================================================

/**
 * Delete play_sessions in terminal states (COMPLETED / CRASHED / KILLED) older than
 * the retention cutoff. Bounded batch. Returns the number of rows deleted.
 */
export async function pruneOldPlaySessions(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50000,
): Promise<number> {
    const result = await sql`
        DELETE FROM play_sessions
        WHERE id IN (
            SELECT id FROM play_sessions
            WHERE status IN ('COMPLETED', 'CRASHED', 'KILLED')
              AND stopped_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

// =============================================================================
// 7. TTL-expired rows (expires_at / date-based)
// =============================================================================

/**
 * Delete user_suggestions rows where expires_at has passed.
 * expires_at is set per-row when suggestions are cached; NULL rows are
 * permanent and skipped.
 */
export async function purgeExpiredUserSuggestions(
    sql: postgres.Sql,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM user_suggestions
        WHERE id IN (
            SELECT id FROM user_suggestions
            WHERE expires_at IS NOT NULL AND expires_at < NOW()
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/**
 * Delete user_media_flags rows where expires_at has passed.
 * NULL expires_at = permanent flag (dismissed_cw, request_dismissed);
 * skip those.
 */
export async function purgeExpiredUserMediaFlags(
    sql: postgres.Sql,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM user_media_flags
        WHERE id IN (
            SELECT id FROM user_media_flags
            WHERE expires_at IS NOT NULL AND expires_at < NOW()
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/**
 * Delete assistant_rate_limits rows older than the cutoff date.
 * These are per-day counters; rows are keyed by (user_id, date).
 * Old day rows are permanently stale and carry no query value.
 */
export async function purgeOldAssistantRateLimits(
    sql: postgres.Sql,
    cutoffDate: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM assistant_rate_limits
        WHERE id IN (
            SELECT id FROM assistant_rate_limits
            WHERE date < ${cutoffDate}::date
            LIMIT ${limit}
        )
    `;
    return result.count;
}

// =============================================================================
// 8. Audit / operational event logs
// =============================================================================

/**
 * Delete cluster_node_events older than cutoff.
 * Stores node online/offline transitions; historical events have no
 * operational value beyond a few months.
 */
export async function pruneClusterNodeEvents(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM cluster_node_events
        WHERE id IN (
            SELECT id FROM cluster_node_events
            WHERE created_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/**
 * Delete file_scanner_runs older than cutoff.
 * Scan execution audit trail; old runs have no ongoing diagnostic value.
 */
export async function pruneFileScannerRuns(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM file_scanner_runs
        WHERE id IN (
            SELECT id FROM file_scanner_runs
            WHERE started_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/**
 * Delete plugin_failure_events older than cutoff.
 * Append-only failure log; old resolved failures waste space.
 * Retention period is configured via LUMASTRA_FAILURE_EVENT_RETENTION_DAYS.
 */
export async function prunePluginFailureEvents(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM plugin_failure_events
        WHERE id IN (
            SELECT id FROM plugin_failure_events
            WHERE occurred_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/**
 * Delete plugin_secret_access_log rows older than cutoff.
 * Secret access audit trail; old entries have no ongoing compliance value
 * beyond the configured retention window.
 */
export async function prunePluginSecretAccessLog(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM plugin_secret_access_log
        WHERE id IN (
            SELECT id FROM plugin_secret_access_log
            WHERE accessed_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

// =============================================================================
// 9. Chat / AI messages
// =============================================================================

/**
 * Delete assistant_messages older than cutoff.
 * RAG context windows degrade over time anyway; old history is not useful
 * for context retrieval and grows linearly with user interactions.
 */
export async function pruneAssistantMessages(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM assistant_messages
        WHERE id IN (
            SELECT id FROM assistant_messages
            WHERE created_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/**
 * Delete collaborative_chat_messages older than cutoff.
 * Watch-party / playlist chat history; old messages have no ongoing value.
 */
export async function pruneCollaborativeChatMessages(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM collaborative_chat_messages
        WHERE id IN (
            SELECT id FROM collaborative_chat_messages
            WHERE created_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

// =============================================================================
// 10. Task system tables
// =============================================================================

/**
 * Delete task_quota_usage rows older than cutoff date.
 * day column is DATE type; old day rows accumulate indefinitely otherwise.
 */
export async function pruneTaskQuotaUsage(
    sql: postgres.Sql,
    cutoffDate: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM task_quota_usage
        WHERE (task_id, tenant_id, day) IN (
            SELECT task_id, tenant_id, day FROM task_quota_usage
            WHERE day < ${cutoffDate}::date
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/**
 * Delete task_webhook_outbox rows that are delivered or dead and older than cutoff.
 * Pending/retrying rows (delivered_at IS NULL AND dead = false) are never touched.
 */
export async function pruneDeliveredWebhookOutbox(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM task_webhook_outbox
        WHERE id IN (
            SELECT id FROM task_webhook_outbox
            WHERE (delivered_at IS NOT NULL OR dead = true)
              AND created_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/**
 * Delete pipeline event_outbox rows that have been successfully consumed
 * (consumed_at IS NOT NULL) and are older than cutoff. Dead-letter rows
 * are preserved for admin triage — only auto-pruned when explicitly
 * targeted by separate operator action.
 *
 * The dispatcher's normal drain leaves consumed rows untouched, so the
 * table grows ~one row per pipeline event until cleanup runs. On preprod
 * 2026-05-29 the table reached 557 MB / 1.14 M consumed rows before
 * this prune was added.
 */
export async function pruneConsumedEventOutbox(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM event_outbox
        WHERE id IN (
            SELECT id FROM event_outbox
            WHERE consumed_at IS NOT NULL
              AND NOT dead_letter
              AND consumed_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/**
 * Delete task_history_archive rows older than cutoff, respecting retention policy.
 * Rows with retention_policy = 'forever' are never deleted.
 * Rows with retain_until > NOW() are skipped even if started_at is old.
 */
export async function pruneTaskHistoryArchive(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM task_history_archive
        WHERE id IN (
            SELECT id FROM task_history_archive
            WHERE retention_policy IS DISTINCT FROM 'forever'
              AND (retain_until IS NULL OR retain_until < NOW())
              AND started_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

// =============================================================================
// 11. LiveTV channel watch history
// =============================================================================

/**
 * Delete livetv_channel_watch_history rows older than cutoff.
 * Tracks per-user channel views for personalisation; old rows degrade
 * personalisation quality anyway and grow unboundedly.
 */
export async function pruneLivetvChannelWatchHistory(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 500_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM livetv_channel_watch_history
        WHERE id IN (
            SELECT id FROM livetv_channel_watch_history
            WHERE watched_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

// =============================================================================
// 12. user_media_events two-tier archival
// =============================================================================

/**
 * Move user_media_events into user_media_events_archive when recorded_at is
 * older than archiveCutoff. recorded_at (not occurred_at) is the eligibility
 * boundary because provider sync can write backdated events whose occurred_at
 * is years old but recorded_at is now — using occurred_at would archive a
 * just-ingested sync event before rebuild, push, or dedupe paths see it.
 *
 * Uses a single CTE so DELETE only fires for successfully inserted rows.
 * Safe to re-run (ON CONFLICT DO NOTHING on archive PK).
 * Returns the number of events moved.
 */
export async function archiveOldUserMediaEvents(
    sql: postgres.Sql,
    archiveCutoff: Date,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        WITH to_archive AS (
            SELECT id FROM user_media_events
            WHERE recorded_at < ${archiveCutoff}
            ORDER BY recorded_at ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
        ),
        archived AS (
            INSERT INTO user_media_events_archive
                (id, user_id, media_id, event_type, source, position_ms, runtime_ms,
                 source_event_id, session_id, event_seq, repudiated_at, snapshot_state,
                 pushed_to_providers, occurred_at, recorded_at, session_elapsed_ms)
            SELECT
                ume.id, ume.user_id, ume.media_id, ume.event_type, ume.source,
                ume.position_ms, ume.runtime_ms, ume.source_event_id, ume.session_id,
                ume.event_seq, ume.repudiated_at, ume.snapshot_state,
                ume.pushed_to_providers, ume.occurred_at, ume.recorded_at,
                ume.session_elapsed_ms
            FROM user_media_events ume
            INNER JOIN to_archive ta ON ta.id = ume.id
            ON CONFLICT (id) DO NOTHING
            RETURNING id
        )
        DELETE FROM user_media_events
        WHERE id IN (SELECT id FROM archived)
        RETURNING id
    `;
    return result.count;
}

/**
 * Hard-delete user_media_events_archive rows older than purgeCutoff.
 * This is the final deletion tier: events live in the source table until
 * archive_days, in the archive table until purge_days, then disappear.
 */
export async function purgeOldArchivedMediaEvents(
    sql: postgres.Sql,
    purgeCutoff: Date,
    limit = 10_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM user_media_events_archive
        WHERE id IN (
            SELECT id FROM user_media_events_archive
            WHERE recorded_at < ${purgeCutoff}
            ORDER BY recorded_at ASC
            LIMIT ${limit}
        )
    `;
    return result.count;
}

export { pruneSyncChanges } from './sync-changes.queries.js';
