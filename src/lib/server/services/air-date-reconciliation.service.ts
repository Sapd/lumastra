// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Air-Date Reconciliation
 *
 * Daily shows are released by date ("The Show 2021.03.14.mkv"), not SxxExx.
 * The scanner links such a file to the provider episode that aired that day
 * (video-processor.ts, `findCanonicalEpisodesByAirDate`) — but only once the
 * provider's episodes exist. The first files of a new show arrive before the
 * first metadata sync, so the scanner auto-numbers them (season from the
 * folder, next free episode number). After the sync those files sit on the
 * wrong rows:
 *
 *   - an invented episode beside the real, file-less one, or
 *   - a provider episode at the same position the sync adopted ("Season
 *     2021/2021.03.14.mkv" auto-numbered to S2021E01, which the sync then
 *     bound to whatever TMDB lists as S2021E01).
 *
 * This pass runs after each TMDB series sync and moves every such file link
 * onto the episode whose air date the filename names. It decides from the
 * filename and `premiere_date` only, so it needs no provider call. A move is
 * made only when the date points at one provider episode (pickAirDateEpisode,
 * the same rule the scanner uses), and only off a row the scanner or a sync
 * put there by position: never off a locked row, an identity-bound row, or one
 * an admin identified by hand (a `manual` external id). Those may be off by a
 * day against the filename on purpose (a late show listed under the next day).
 * For the same reason a provider episode whose own air date is within a day
 * of the filename keeps its file: when TMDB shifts a run's dates by one day,
 * following the shift would move every file onto its neighbour.
 *
 * The row the file leaves keeps its place when it is a provider episode (it is
 * simply missing a file now), but the watch state recorded against it while
 * the file sat there (watched flag, resume position, watch events, sessions)
 * moves with the file once no file is left on it: what the user watched was
 * the file, not that episode. A scanner-invented row left without files is
 * merged into the target (all user state moves along) and a scanner season
 * left empty is deleted.
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    lockAncestorChain,
    touchLibraryAddedAt,
    propagateHasFiles,
    recomputeHasFiles,
} from '$lib/server/database/queries/media-files.queries.js';
import { MediaDeletionService } from '$lib/server/services/media-deletion.service.js';
import { parseMediaFilename } from '$lib/server/utils/filename-parser.js';
import { pickAirDateEpisode } from '$lib/server/utils/air-date-episode.js';
import { extractSeasonNumberFromPath } from '$lib/server/utils/path-parsing.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { toUserId } from '$lib/shared/user-id.js';

const logger = Logger.for('AirDateReconciliation');

export interface AirDateRelink {
    fileId: string;
    filePath: string;
    airDate: string;
    /** Episode the file is linked to now */
    fromEpisodeId: string;
    /** Provider episode that aired on `airDate` */
    toEpisodeId: string;
}

export interface AirDateApplyResult {
    relinked: number;
    skipped: number;
    rowsMerged: number;
    emptySeasonsDeleted: number;
    /** Users whose watch state moved off a provider episode with the file. */
    watchStateUsersMoved: number;
}

/**
 * Move the watch state of a provider episode the file just left onto the
 * episode it moved to. Only once no file is left on the source (another
 * version still there means the state may belong to that one). A user who
 * already has state on the target keeps it; their source rows stay put.
 * Returns the users whose state moved.
 */
async function moveWatchStateWithFile(
    tx: postgres.Sql,
    fromId: string,
    toId: string,
): Promise<string[]> {
    const [left] = await tx<{ has_link: boolean; is_provider: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM media_file_items WHERE media_item_id = ${fromId}) AS has_link,
               EXISTS (SELECT 1 FROM external_ids WHERE media_id = ${fromId} AND source IS DISTINCT FROM 'watch-sync-file') AS is_provider
    `;
    // A scanner row is merged whole afterwards (mergeInto moves everything).
    if (!left || left.has_link || !left.is_provider) return [];

    const moved = await tx<{ user_id: string }[]>`
        UPDATE user_media_state SET media_id = ${toId}
        WHERE media_id = ${fromId}
          AND NOT EXISTS (
              SELECT 1 FROM user_media_state t
              WHERE t.media_id = ${toId} AND t.user_id = user_media_state.user_id
          )
        RETURNING user_id
    `;
    const users = moved.map((r) => r.user_id);
    if (users.length === 0) return [];
    // Events, sessions and history of exactly those users follow; the
    // partial unique index on events only covers a non-null source_event_id.
    await tx`
        UPDATE user_media_events SET media_id = ${toId}
        WHERE media_id = ${fromId}
          AND user_id = ANY(${users}::uuid[])
          AND NOT EXISTS (
              SELECT 1 FROM user_media_events t
              WHERE t.media_id = ${toId}
                AND t.user_id = user_media_events.user_id
                AND t.source = user_media_events.source
                AND t.source_event_id IS NOT DISTINCT FROM user_media_events.source_event_id
          )
    `;
    await tx`
        UPDATE play_sessions SET media_id = ${toId}
        WHERE media_id = ${fromId} AND user_id = ANY(${users}::uuid[])
    `;
    await tx`
        UPDATE watch_history SET media_id = ${toId}
        WHERE media_id = ${fromId} AND user_id = ANY(${users}::uuid[])
    `;
    return users;
}

interface LinkRow {
    file_id: string;
    file_path: string;
    episode_id: string;
    premiere_date: string | null;
    has_provider_id: boolean;
    link_count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between two `YYYY-MM-DD` dates. */
function daysApart(a: string, b: string): number {
    return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
}

interface CanonicalRow {
    id: string;
    season_number: number;
    premiere_date: string;
}

/**
 * SQL guard: the episode `mi` may give up its file. Not locked, not bound by
 * identity, no provider id an admin set by hand.
 */
// `mfi` is the link being judged: a link an admin set by hand
// (manual-file-links.service.ts) is never moved by an air date.
const movableSource = (q: postgres.Sql): postgres.PendingQuery<postgres.Row[]> => q`
    mfi.offset_source IS DISTINCT FROM 'manual'
    AND NOT mi.metadata_locked
    AND mi.title_binding IS DISTINCT FROM 'identity'
    AND NOT EXISTS (
        SELECT 1 FROM external_ids m WHERE m.media_id = mi.id AND m.source = 'manual'
    )`;

/**
 * Every file of the series whose name is an air date that is not the air date
 * of the episode it is linked to, paired with the one provider episode that
 * did air that day.
 */
export async function detectAirDateRelinks(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<AirDateRelink[]> {
    // premiere_date as text: a `date` column would come back as a JS Date at
    // local midnight, and comparing that with the filename's string is a
    // time-zone bug waiting to happen.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal reconciliation lookup keyed by a specific series UUID; not user-facing
    const links = await sql<LinkRow[]>`
        SELECT mfi.file_id,
               mf.file_path,
               mi.id AS episode_id,
               to_char(mi.premiere_date, 'YYYY-MM-DD') AS premiere_date,
               EXISTS (SELECT 1 FROM external_ids p WHERE p.media_id = mi.id AND source IS DISTINCT FROM 'watch-sync-file') AS has_provider_id,
               (SELECT count(*)::int FROM media_file_items x WHERE x.file_id = mfi.file_id) AS link_count
        FROM media_items mi
        JOIN media_items s ON s.id = mi.parent_id AND s.media_type = 'season'
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE s.parent_id = ${seriesMediaId}
          AND mi.media_type = 'episode'
          -- Cheap prefilter: only paths with something date-shaped in them
          -- reach the filename parser, which has the final say.
          AND mf.file_path ~ '(19|20)[0-9]{2}[-._ ](0[1-9]|1[0-2])[-._ ][0-3][0-9]'
          AND ${movableSource(sql)}
    `;

    const stranded: Array<LinkRow & { airDate: string; folderSeason: number | undefined }> = [];
    for (const link of links) {
        // A file spread over several episodes was linked on purpose
        // (S01E01E02, segments); a date name never produces that.
        if (link.link_count !== 1) continue;
        // Full path, as the scanner parses it: the season-folder rule decides
        // whether a leading number is an episode number.
        const { airDate } = parseMediaFilename(link.file_path, { airDates: true });
        if (!airDate || airDate === link.premiere_date) continue;
        // A provider episode a day off the filename is the right episode with
        // a time-zone or listing difference, not a stranded file.
        if (
            link.has_provider_id &&
            link.premiere_date &&
            daysApart(airDate, link.premiere_date) <= 1
        )
            continue;
        // Any season folder above the file, as the scanner reads it.
        const folderSeason = extractSeasonNumberFromPath(link.file_path, '');
        stranded.push({ ...link, airDate, folderSeason });
    }
    if (stranded.length === 0) return [];

    const dates = [...new Set(stranded.map((l) => l.airDate))];
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal reconciliation lookup keyed by a specific series UUID; not user-facing
    const canonical = await sql<CanonicalRow[]>`
        SELECT mi.id, mi.season_number, to_char(mi.premiere_date, 'YYYY-MM-DD') AS premiere_date
        FROM media_items mi
        JOIN media_items s ON s.id = mi.parent_id AND s.media_type = 'season'
        WHERE s.parent_id = ${seriesMediaId}
          AND mi.media_type = 'episode'
          AND mi.premiere_date = ANY(${dates}::date[])
          AND EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND source IS DISTINCT FROM 'watch-sync-file')
    `;
    const byDate = new Map<string, CanonicalRow[]>();
    for (const row of canonical) {
        byDate.set(row.premiere_date, [...(byDate.get(row.premiere_date) ?? []), row]);
    }

    const relinks: AirDateRelink[] = [];
    for (const link of stranded) {
        const target = pickAirDateEpisode(byDate.get(link.airDate) ?? [], link.folderSeason);
        if (!target || target.id === link.episode_id) continue;
        relinks.push({
            fileId: link.file_id,
            filePath: link.file_path,
            airDate: link.airDate,
            fromEpisodeId: link.episode_id,
            toEpisodeId: target.id,
        });
    }
    return relinks;
}

/** Move each file link, then clear away the scanner rows it leaves empty. */
export async function applyAirDateRelinks(
    sql: postgres.Sql,
    seriesMediaId: string,
    relinks: AirDateRelink[],
    signal?: AbortSignal,
): Promise<AirDateApplyResult> {
    const result: AirDateApplyResult = {
        relinked: 0,
        skipped: 0,
        rowsMerged: 0,
        emptySeasonsDeleted: 0,
        watchStateUsersMoved: 0,
    };
    const applied: AirDateRelink[] = [];
    const usersToRefresh = new Set<string>();

    for (const relink of relinks) {
        if (signal?.aborted) break;
        try {
            const moved = await withTx(sql, async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;
                // Serialize with the other per-series reconciliation applies.
                await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesMediaId})::bigint)`;
                // Same per-item lock attachFileToItem takes, for both rows.
                const [first, second] = [relink.fromEpisodeId, relink.toEpisodeId].sort();
                await tx`SELECT pg_advisory_xact_lock(hashtext(${first}))`;
                await tx`SELECT pg_advisory_xact_lock(hashtext(${second}))`;
                // Lock the ancestor chains of BOTH episodes in ONE ordered statement
                // before any write. Same order as deleteStaleMediaFile (chain first,
                // then the file's junction rows), so a concurrent unlink of the source
                // file cannot hold a junction row while waiting for a chain row this
                // transaction holds, or the reverse. One statement for both chains
                // also keeps the two episodes' chains in a single global id order
                // (propagateHasFiles and recomputeHasFiles lock one chain each).
                await lockAncestorChain(tx, [relink.fromEpisodeId, relink.toEpisodeId]);

                // Re-check under the lock: the file must still be linked only
                // to the row detection saw, that row must still be free to give
                // it up, and the target must still be the provider episode of
                // that day (a concurrent sync may have moved its date).
                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal TOCTOU re-check keyed by a specific episode UUID; not user-facing
                const [still] = await tx<{ is_default: boolean }[]>`
                    SELECT mfi.is_default
                    FROM media_file_items mfi
                    JOIN media_items mi ON mi.id = mfi.media_item_id
                    WHERE mfi.file_id = ${relink.fileId}
                      AND mfi.media_item_id = ${relink.fromEpisodeId}
                      AND ${movableSource(tx)}
                      AND (
                          NOT EXISTS (SELECT 1 FROM external_ids p WHERE p.media_id = mi.id AND source IS DISTINCT FROM 'watch-sync-file')
                          OR mi.premiere_date IS NULL
                          OR abs(mi.premiere_date - ${relink.airDate}::date) > 1
                      )
                      AND (SELECT count(*) FROM media_file_items x WHERE x.file_id = ${relink.fileId}) = 1
                      AND EXISTS (
                          SELECT 1 FROM media_items t
                          WHERE t.id = ${relink.toEpisodeId}
                            AND t.premiere_date = ${relink.airDate}::date
                            AND EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = t.id AND source IS DISTINCT FROM 'watch-sync-file')
                      )
                `;
                if (!still) return false;

                await tx`
                    DELETE FROM media_file_items
                    WHERE file_id = ${relink.fileId} AND media_item_id = ${relink.fromEpisodeId}
                `;
                // The row keeps another version: hand it the default the
                // moved file held, or the deferred one-default trigger fails
                // the commit.
                if (still.is_default) {
                    await tx`
                        UPDATE media_file_items SET is_default = true
                        WHERE media_item_id = ${relink.fromEpisodeId}
                          AND file_id = (
                              SELECT file_id FROM media_file_items
                              WHERE media_item_id = ${relink.fromEpisodeId}
                              ORDER BY sort_order, file_id
                              LIMIT 1
                          )
                    `;
                }

                await tx`
                    INSERT INTO media_file_items (file_id, media_item_id, is_default)
                    VALUES (
                        ${relink.fileId},
                        ${relink.toEpisodeId},
                        NOT EXISTS (
                            SELECT 1 FROM media_file_items
                            WHERE media_item_id = ${relink.toEpisodeId} AND is_default = true
                        )
                    )
                    ON CONFLICT (file_id, media_item_id) DO NOTHING
                `;
                await tx`
                    UPDATE media_items
                       SET is_dismissed = false,
                           dismissed_at = NULL
                     WHERE id = ${relink.toEpisodeId} AND is_dismissed = true
                `;
                await propagateHasFiles(tx, relink.toEpisodeId);
                await recomputeHasFiles(tx, relink.fromEpisodeId);
                // As the scanner's attach does: the episode now has a file.
                await touchLibraryAddedAt(
                    tx,
                    relink.toEpisodeId,
                    config.RECENTLY_ADDED_PROPAGATE_TO_SERIES,
                );
                for (const userId of await moveWatchStateWithFile(
                    tx,
                    relink.fromEpisodeId,
                    relink.toEpisodeId,
                )) {
                    usersToRefresh.add(userId);
                    result.watchStateUsersMoved++;
                }
                return true;
            });
            if (moved) {
                result.relinked++;
                applied.push(relink);
            } else {
                result.skipped++;
            }
        } catch (err) {
            result.skipped++;
            logger.warn('Failed to move daily-show file to its air-date episode', {
                seriesMediaId,
                filePath: relink.filePath,
                airDate: relink.airDate,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // A scanner-invented row the file left behind is an empty shell now. Merge
    // it into the episode the file moved to, so watch state recorded against
    // it follows the file. Provider rows stay: they are real episodes. The
    // cleanup below ignores the abort signal on purpose: each step is short,
    // and a shell skipped now is never found again (detection follows files).
    const targetsByShell = new Map<string, Set<string>>();
    for (const r of applied) {
        targetsByShell.set(
            r.fromEpisodeId,
            (targetsByShell.get(r.fromEpisodeId) ?? new Set()).add(r.toEpisodeId),
        );
    }
    const shellSeasons = new Set<string>();
    for (const [fromId, targets] of targetsByShell) {
        // Files that left for different days: no one target owns the shell's
        // watch state, so leave the row as it is.
        if (targets.size !== 1) continue;
        const [toId] = targets;
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal cleanup keyed by a specific episode UUID; not user-facing
        const [shell] = await sql<{ id: string; parent_id: string | null }[]>`
            SELECT mi.id, mi.parent_id FROM media_items mi
            WHERE mi.id = ${fromId}
              AND NOT mi.metadata_locked
              AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND source IS DISTINCT FROM 'watch-sync-file')
              AND NOT EXISTS (SELECT 1 FROM media_file_items x WHERE x.media_item_id = mi.id)
        `;
        if (!shell) continue;
        try {
            await MediaDeletionService.mergeInto(sql, toId, fromId);
            result.rowsMerged++;
            if (shell.parent_id) shellSeasons.add(shell.parent_id);
        } catch (err) {
            logger.warn('Failed to merge emptied scanner episode', {
                fromId,
                toId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // A scanner season that only held those rows ("Season 2021" when the
    // provider numbers the show by run) is empty now. Only the seasons this
    // pass emptied, never one an admin locked, and the emptiness check runs
    // inside the delete's transaction after its row lock: a scan that just
    // added an episode there keeps its season (parent_id is ON DELETE SET
    // NULL, so deleting would orphan that episode).
    for (const seasonId of shellSeasons) {
        const stillEmpty = async (tx: postgres.Sql): Promise<boolean> => {
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal cleanup keyed by a specific season UUID; not user-facing
            const [row] = await tx<{ ok: boolean }[]>`
                SELECT (
                    NOT s.metadata_locked
                    AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = s.id AND source IS DISTINCT FROM 'watch-sync-file')
                    AND NOT EXISTS (SELECT 1 FROM media_items e WHERE e.parent_id = s.id)
                ) AS ok
                FROM media_items s
                WHERE s.id = ${seasonId} AND s.media_type = 'season'
            `;
            return row?.ok === true;
        };
        try {
            if (!(await stillEmpty(sql))) continue;
            const deleted = await MediaDeletionService.hardDelete(sql, seasonId, {
                eligibility: stillEmpty,
            });
            if (deleted.deleted) result.emptySeasonsDeleted++;
        } catch (err) {
            logger.warn('Failed to delete empty scanner season', {
                seasonId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (result.relinked > 0) {
        try {
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
            await cacheManager.for(CACHE_NAMESPACES.nextEpisode).clear();
            await cacheManager.for(CACHE_NAMESPACES.heroNextUp).clear();
            await cacheManager.for(CACHE_NAMESPACES.newEpisodes).clear();
        } catch (err) {
            logger.warn('Post-relink cache clear failed (non-fatal)', {
                seriesMediaId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    for (const userId of usersToRefresh) {
        try {
            const { invalidateAllWatchedCaches } = await import('./watched-cache.service.js');
            await invalidateAllWatchedCaches(toUserId(userId));
        } catch (err) {
            logger.warn('Watched-cache invalidation failed (non-fatal)', {
                userId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    logger.info('Moved daily-show files to their air-date episodes', {
        seriesMediaId,
        ...result,
    });
    return result;
}

/** Metadata-sync hook: one query for a show without date-named files, no provider call. */
export async function maybeRelinkByAirDate(
    sql: postgres.Sql,
    seriesMediaId: string,
    signal?: AbortSignal,
): Promise<AirDateApplyResult | null> {
    const relinks = await detectAirDateRelinks(sql, seriesMediaId);
    if (relinks.length === 0 || signal?.aborted) return null;
    return applyAirDateRelinks(sql, seriesMediaId, relinks, signal);
}
