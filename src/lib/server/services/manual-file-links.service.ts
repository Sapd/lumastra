// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Manual file → episode links.
 *
 * An admin links one file to an ordered list of episodes (any season, any
 * order) with a window per episode, for files whose name cannot describe what
 * they hold: `S09E20-21` that holds 9x20 then 9x19, `S09E37` that also holds
 * 9x41, `S10E13` that holds 11x16 then 10x19.
 *
 * The links are ordinary `media_file_items` rows marked
 * `offset_source = 'manual'`, with `sort_order` = position in the file and the
 * admin's window in `start_offset_ms`/`end_offset_ms`. What keeps them:
 *
 *   - refreshSegmentsForFile / applyFileSegments / rebuildAllFileSegments skip
 *     a manually linked file (file-segments.queries.ts);
 *   - the scanner's range repair and its unchanged-file range heal skip it, so
 *     `S09E20-21` does not get 9x21 back (video-processor.ts,
 *     multi-episode-links.ts);
 *   - range-link eviction never removes a link with `offset_source` set;
 *   - promoteHighestQualityVersion keeps a manual default.
 *
 * Every manual link is the DEFAULT file of its episode, because that is the
 * file playback opens: the admin's statement is "play this episode from here".
 * Another file the episode had stays linked as a version.
 *
 * The set is also remembered by content (`manual_file_link_sets`, keyed by the
 * 64 KB head hash + size): a rename or move gives the file a new row, and the
 * scanner puts the set back on it (restoreManualLinksForNewFile). New bytes at
 * the same path keep the set only while the windows still fit the new
 * duration (revalidateManualLinksAfterContentChange).
 */

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import type { AuditActor } from '$lib/server/utils/audit-log.js';
import { insertAdminAuditEvent } from '$lib/server/database/queries/admin-audit.queries.js';
import { getFileEpisodeReviewRevision } from '$lib/server/database/queries/manual-file-links.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    lockAncestorChain,
    promoteDefaultWhereMissing,
    propagateHasFiles,
    recomputeHasFilesBatch,
    type FileHealthIssue,
} from '$lib/server/database/queries/media-files.queries.js';
import { refreshSegmentsForFile } from '$lib/server/database/queries/file-segments.queries.js';
import { emitPipelineEvent } from '$lib/server/database/queries/event-outbox.queries.js';
import {
    DURATION_SNAP_MS,
    MANUAL_OFFSET_SOURCE,
    validateManualWindows,
    type ManualWindow,
    type BoundaryOrigin,
} from '$lib/shared/manual-file-segments.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('ManualFileLinks');

import {
    captureFileMappingChoice,
    fileMappingChoiceIds,
    restoreFileMappingChoice,
    canRestoreFileMappingChoice,
} from '$lib/server/database/queries/file-mapping-choice.queries.js';
import {
    recordMediaChange,
    getMediaChange,
    markMediaChangeUndone,
    sameMediaChangeState,
} from '$lib/server/database/queries/admin-media-change.queries.js';

export type ManualLinkFailure =
    | { ok: false; reason: 'file_not_found' }
    | { ok: false; reason: 'conflict' }
    | { ok: false; reason: 'invalid'; message: string };

export type ManualLinkResult =
    { ok: true; mediaItemIds: string[]; undoId?: string } | ManualLinkFailure;

interface EpisodeRow {
    id: string;
    series_id: string | null;
    is_dismissed: boolean;
}

interface LockedMappingFile {
    id: string;
    duration_seconds: number | null;
    file_hash_head: string | null;
    file_size_bytes: string | null;
}
interface CurrentMappingLink {
    media_item_id: string;
    is_default: boolean;
    start_offset_ms: string | null;
    end_offset_ms: string | null;
}

async function readMappingLinks(tx: postgres.Sql, fileId: string): Promise<CurrentMappingLink[]> {
    return tx<CurrentMappingLink[]>`
        SELECT media_item_id, is_default, start_offset_ms::text AS start_offset_ms,
            end_offset_ms::text AS end_offset_ms FROM media_file_items WHERE file_id = ${fileId}
        ORDER BY media_item_id
    `;
}

/** Match attach/delete lock order: item advisory → ancestors → file. The first
 * read only chooses locks; decisions use fresh evidence under all final locks. */
async function lockManualMapping(
    tx: postgres.Sql,
    fileId: string,
    wanted: string[],
    seriesId?: string,
): Promise<
    | ManualLinkFailure
    | { ok: true; file: LockedMappingFile; current: CurrentMappingLink[]; touched: string[] }
> {
    const snapshot = await readMappingLinks(tx, fileId);
    const touched = [...new Set([...wanted, ...snapshot.map((link) => link.media_item_id)])].sort();
    for (const id of touched) await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
    await lockAncestorChain(tx, [...touched, ...(seriesId ? [seriesId] : [])]);
    const [file] = await tx<LockedMappingFile[]>`
        SELECT id, duration_seconds, file_hash_head, file_size_bytes::text AS file_size_bytes
        FROM media_files WHERE id = ${fileId} FOR UPDATE
    `;
    if (!file) return { ok: false, reason: 'file_not_found' };
    const current = await readMappingLinks(tx, fileId);
    if (current.some((link) => !touched.includes(link.media_item_id))) {
        return { ok: false, reason: 'conflict' };
    }
    return { ok: true, file, current, touched };
}

function durationMsOf(durationSeconds: number | null): number | null {
    if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return null;
    }
    return Math.round(durationSeconds * 1000);
}

/**
 * Replace the file's episode links with `episodeIds` in file order, each with
 * its window (`windows[i]` belongs to `episodeIds[i]`; null only for a single
 * episode, which then plays the whole file).
 *
 * Links of this file to episodes not in the list are removed; an episode left
 * without any file loses `has_files` like after any unlink. Nothing else about
 * those episodes changes (watch state stays where it is). With `seriesId`, the
 * episodes must belong to that series.
 */
export async function setManualFileEpisodes(
    sql: postgres.Sql,
    fileId: string,
    episodeIds: string[],
    windows: ManualWindow[] | null,
    options: ApplyOptions = {},
): Promise<ManualLinkResult> {
    const result = await withTx(sql, (txRaw) =>
        applyManualLinksInTx(
            txRaw as unknown as postgres.Sql,
            fileId,
            episodeIds,
            windows,
            options,
        ),
    );
    if (result.ok) afterLinksChanged(result.mediaItemIds);
    return result;
}

interface ApplyOptions {
    seriesId?: string;
    /** Required by the admin endpoint; trusted scanner restores omit it. */
    revision?: string;
    /** Deliberately restore only these selected dismissed episodes on reviewed admin writes. */
    restoreDismissedEpisodeIds?: string[];
    actor?: AuditActor;
    /** Duration to validate against when the row has none yet (a new file). */
    durationMs?: number;
}

/** {@link setManualFileEpisodes} on an open transaction, without the after-commit hooks. */
async function applyManualLinksInTx(
    tx: postgres.Sql,
    fileId: string,
    episodeIds: string[],
    windows: ManualWindow[] | null,
    options: ApplyOptions,
): Promise<ManualLinkResult> {
    if (new Set(episodeIds).size !== episodeIds.length) {
        return { ok: false, reason: 'invalid', message: 'An episode is listed twice.' };
    }
    {
        const locked = await lockManualMapping(tx, fileId, episodeIds, options.seriesId);
        if (!locked.ok) return locked;
        const { file, current, touched } = locked;

        if (
            options.revision !== undefined &&
            options.seriesId !== undefined &&
            options.revision !== (await getFileEpisodeReviewRevision(tx, fileId, options.seriesId))
        ) {
            return { ok: false, reason: 'conflict' };
        }

        const durationMs = durationMsOf(file.duration_seconds) ?? options.durationMs ?? null;
        const problem = validateManualWindows(durationMs, episodeIds.length, windows);
        if (problem) return { ok: false, reason: 'invalid', message: problem };

        // Episodes only, all of one series. Admin-scoped: no library filter.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin write keyed by explicit episode ids
        const episodes = await tx<EpisodeRow[]>`
            SELECT ep.id, season.parent_id AS series_id, ep.is_dismissed
            FROM media_items ep
            LEFT JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            WHERE ep.id = ANY(${episodeIds}::uuid[]) AND ep.media_type = 'episode'
        `;
        if (episodes.length !== episodeIds.length) {
            return { ok: false, reason: 'invalid', message: 'Every entry must be an episode.' };
        }
        const seriesIds = new Set(episodes.map((e) => e.series_id));
        if (
            seriesIds.size !== 1 ||
            seriesIds.has(null) ||
            (options.seriesId !== undefined && !seriesIds.has(options.seriesId))
        ) {
            return {
                ok: false,
                reason: 'invalid',
                message: 'All episodes must belong to the same series.',
            };
        }

        const before = new Map(current.map((r) => [r.media_item_id, r]));
        const wanted = new Set(episodeIds);
        const removed = current.filter((r) => !wanted.has(r.media_item_id));

        // Re-read hierarchy AFTER waiting for locks: a reparent/status change
        // that raced the review must not authorize a write into its old series.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- explicit admin targets under mutation locks
        const valid = await tx<{ id: string }[]>`
            SELECT ep.id FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season' AND season.status = 'active'
            JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv' AND series.status = 'active'
            WHERE ep.id = ANY(${episodeIds}::uuid[]) AND ep.media_type = 'episode' AND ep.status = 'active'
              AND series.id = ${[...seriesIds][0]}::uuid
        `;
        if (valid.length !== episodeIds.length) return { ok: false, reason: 'conflict' };
        const reviewSeriesId = options.seriesId ?? [...seriesIds][0]!;
        const beforeRevision = await getFileEpisodeReviewRevision(tx, fileId, reviewSeriesId);
        if (options.revision !== undefined && options.revision !== beforeRevision) {
            return { ok: false, reason: 'conflict' };
        }

        // All decisions use fresh episode state under the graph and file locks.
        // Scanner/content restores deliberately retain their trusted behaviour.
        const restoredDismissedEpisodeIds = episodes
            .filter((ep) => ep.is_dismissed)
            .map((ep) => ep.id);
        if (options.revision !== undefined) {
            const acknowledged = new Set(options.restoreDismissedEpisodeIds ?? []);
            if (
                restoredDismissedEpisodeIds.some((id) => !acknowledged.has(id)) ||
                [...acknowledged].some((id) => !wanted.has(id))
            ) {
                return {
                    ok: false,
                    reason: 'invalid',
                    message:
                        'Explicitly acknowledge restoration of each selected dismissed episode.',
                };
            }
        }

        const beforeChoice = options.actor
            ? await captureFileMappingChoice(tx, fileId, touched)
            : undefined;
        if (removed.length > 0) {
            const removedIds = removed.map((r) => r.media_item_id);
            await tx`
                DELETE FROM media_file_items
                WHERE file_id = ${fileId} AND media_item_id = ANY(${removedIds}::uuid[])
            `;
            await promoteDefaultWhereMissing(
                tx,
                removed.filter((r) => r.is_default).map((r) => r.media_item_id),
            );
        }

        for (let i = 0; i < episodeIds.length; i++) {
            const itemId = episodeIds[i];
            const w = windows?.[i] ?? null;
            // The last window ends at the stored duration exactly (the editor
            // may send a value up to DURATION_SNAP_MS off, see validateManualWindows).
            const endMs =
                w === null
                    ? null
                    : i === episodeIds.length - 1 && durationMs !== null
                      ? durationMs
                      : w.endMs;
            // Two statements: idx_media_file_items_one_default is not
            // deferrable, so demote the other default before claiming it.
            await tx`
                UPDATE media_file_items SET is_default = false
                WHERE media_item_id = ${itemId} AND is_default = true AND file_id <> ${fileId}
            `;
            await tx`
                INSERT INTO media_file_items
                    (file_id, media_item_id, is_default, sort_order,
                     start_offset_ms, end_offset_ms, offset_source, boundary_origin)
                VALUES
                    (${fileId}, ${itemId}, true, ${i},
                     ${w?.startMs ?? null}, ${endMs}, ${MANUAL_OFFSET_SOURCE}, ${w?.boundaryOrigin ?? null})
                ON CONFLICT (file_id, media_item_id) DO UPDATE
                SET is_default = true,
                    sort_order = EXCLUDED.sort_order,
                    start_offset_ms = EXCLUDED.start_offset_ms,
                    end_offset_ms = EXCLUDED.end_offset_ms,
                    offset_source = EXCLUDED.offset_source, boundary_origin = EXCLUDED.boundary_origin
            `;
            await tx`
                UPDATE media_items SET is_dismissed = false, dismissed_at = NULL
                WHERE id = ${itemId} AND is_dismissed = true
            `;
            await propagateHasFiles(tx, itemId);

            // A link that already existed changed only its window: no row
            // trigger fires for that (they cover insert, delete and a new
            // default), so say it explicitly, in this transaction.
            const prior = before.get(itemId);
            if (
                prior &&
                (numOrNull(prior.start_offset_ms) !== (w?.startMs ?? null) ||
                    numOrNull(prior.end_offset_ms) !== endMs)
            ) {
                await emitWindowChanged(tx, itemId, fileId);
            }
        }

        if (removed.length > 0) {
            await recomputeHasFilesBatch(
                tx,
                removed.map((r) => r.media_item_id),
            );
        }

        await writeLinkSet(tx, {
            fileId,
            hash: file.file_hash_head,
            sizeBytes: file.file_size_bytes,
            durationMs,
            entries: episodeIds.map((mediaItemId, i) => ({
                mediaItemId,
                startMs: windows?.[i]?.startMs ?? null,
                boundaryOrigin: windows?.[i]?.boundaryOrigin ?? null,
                endMs:
                    windows === null
                        ? null
                        : i === episodeIds.length - 1 && durationMs !== null
                          ? durationMs
                          : windows[i].endMs,
            })),
        });

        // These two warnings are disproved by a reviewed explicit mapping.
        // Decoder, provider identity, and other unrelated evidence stays intact.
        const [issues] = await tx<{ health_issues: FileHealthIssue[] | null }[]>`
            SELECT health_issues FROM media_files WHERE id = ${fileId}
        `;
        const cleared = (issues?.health_issues ?? []).filter(
            (issue) =>
                issue.type === 'episode_number_unparsed' || issue.type === 'range_superseded',
        );
        if (options.revision !== undefined && cleared.length > 0) {
            await tx`
                UPDATE media_files mf SET health_issues = (
                    SELECT jsonb_agg(issue) FROM jsonb_array_elements(mf.health_issues) issue
                    WHERE issue->>'type' NOT IN ('episode_number_unparsed', 'range_superseded')
                ) WHERE id = ${fileId}
            `;
        }
        if (options.actor) {
            const afterRevision = await getFileEpisodeReviewRevision(tx, fileId, reviewSeriesId);
            if (beforeRevision !== afterRevision || cleared.length > 0) {
                await recordMappingAudit(tx, fileId, 'set', options.actor, {
                    beforeRevision,
                    afterRevision,
                    mediaItemIds: episodeIds,
                    restoredDismissedEpisodeIds,
                    removed: removed.map((r) => r.media_item_id),
                    clearedIssues: cleared,
                });
            }
        }

        const undoId = options.actor
            ? await recordMediaChange(
                  tx,
                  reviewSeriesId,
                  `file-mapping:${fileId}`,
                  beforeChoice,
                  await captureFileMappingChoice(tx, fileId, touched),
                  options.actor.username ?? 'admin',
              )
            : undefined;
        return { ok: true, mediaItemIds: touched, undoId };
    }
}

async function recordMappingAudit(
    tx: postgres.Sql,
    fileId: string,
    operation: 'set' | 'reset',
    actor: AuditActor,
    detail: Record<string, unknown>,
): Promise<void> {
    await insertAdminAuditEvent(tx, {
        instanceId: config.INSTANCE_ID,
        actor: actor.username ?? 'system',
        principalKind: actor.kind,
        credentialId: actor.credentialId,
        action: `media.file-episodes.${operation}`,
        target: fileId,
        outcome: 'ok',
        detail: { ...detail, ...(actor.delegated ? { delegated: true } : {}) },
    });
}

function numOrNull(v: string | null): number | null {
    return v === null ? null : Number(v);
}

/** No-op while the outbox is off (emit_pipeline_event checks the flag). */
async function emitWindowChanged(
    tx: postgres.Sql,
    mediaItemId: string,
    fileId: string,
): Promise<void> {
    await emitPipelineEvent(tx, 'file.windowChanged', mediaItemId, {
        event: 'file.windowChanged',
        mediaId: mediaItemId,
        fileId,
    });
}

interface LinkSetEntry {
    boundaryOrigin?: BoundaryOrigin | null;
    mediaItemId: string;
    startMs: number | null;
    endMs: number | null;
}

/**
 * Remember the file's set by content. Without a head hash and size (a file the
 * scanner never stat'ed) there is no key: the links still work, they just do
 * not follow a rename.
 */
async function writeLinkSet(
    tx: postgres.Sql,
    set: {
        fileId: string;
        hash: string | null;
        sizeBytes: string | null;
        durationMs: number | null;
        entries: LinkSetEntry[];
    },
): Promise<void> {
    await tx`DELETE FROM manual_file_link_sets WHERE file_id = ${set.fileId}`;
    if (!set.hash || set.sizeBytes === null) return;
    await tx`
        INSERT INTO manual_file_link_sets
            (file_hash_head, file_size_bytes, duration_ms, entries, file_id, updated_at)
        VALUES
            (${set.hash}, ${set.sizeBytes}::bigint, ${set.durationMs},
             ${tx.json(set.entries as unknown as postgres.JSONValue)}, ${set.fileId}, now())
        ON CONFLICT (file_hash_head, file_size_bytes) DO UPDATE
        SET duration_ms = EXCLUDED.duration_ms,
            entries = EXCLUDED.entries,
            file_id = EXCLUDED.file_id,
            updated_at = now()
    `;
}

/**
 * Hand the file back to automatic segments: the links stay, the manual marks
 * and windows go, and the windows are derived again from the name, chapters and
 * runtimes as for any other file. The next scan may then re-create the links
 * the name's range implies. Returns false when the file does not exist.
 */
export async function clearManualFileEpisodes(sql: postgres.Sql, fileId: string): Promise<boolean> {
    return (await clearReviewedManualFileEpisodes(sql, fileId)).ok;
}

/** Admin reset uses reviewed evidence; scanner revalidation keeps its trusted path. */
export async function clearReviewedManualFileEpisodes(
    sql: postgres.Sql,
    fileId: string,
    options: ApplyOptions = {},
): Promise<ManualLinkResult> {
    const touched = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const locked = await lockManualMapping(tx, fileId, [], options.seriesId);
        if (!locked.ok) return locked;
        const beforeRevision = options.seriesId
            ? await getFileEpisodeReviewRevision(tx, fileId, options.seriesId)
            : null;
        if (options.revision !== undefined && beforeRevision !== options.revision) {
            return { ok: false, reason: 'conflict' } as const;
        }
        const beforeChoice = options.actor
            ? await captureFileMappingChoice(tx, fileId, locked.touched)
            : undefined;
        const rows = await tx<{ media_item_id: string }[]>`
            UPDATE media_file_items
            SET start_offset_ms = NULL, end_offset_ms = NULL, offset_source = NULL, boundary_origin = NULL, sort_order = 0
            WHERE file_id = ${fileId} AND offset_source = ${MANUAL_OFFSET_SOURCE}
            RETURNING media_item_id
        `;
        await tx`DELETE FROM manual_file_link_sets WHERE file_id = ${fileId}`;
        await refreshSegmentsForFile(tx, fileId);
        // The hand-made windows are gone (whole file, or derived ones now).
        for (const r of rows) await emitWindowChanged(tx, r.media_item_id, fileId);
        if (options.actor && rows.length > 0) {
            await recordMappingAudit(tx, fileId, 'reset', options.actor, {
                beforeRevision,
                mediaItemIds: rows.map((r) => r.media_item_id),
                afterRevision: options.seriesId
                    ? await getFileEpisodeReviewRevision(tx, fileId, options.seriesId)
                    : null,
            });
        }
        const undoId =
            options.actor && options.seriesId
                ? await recordMediaChange(
                      tx,
                      options.seriesId,
                      `file-mapping:${fileId}`,
                      beforeChoice,
                      await captureFileMappingChoice(tx, fileId, locked.touched),
                      options.actor.username ?? 'admin',
                  )
                : undefined;
        return { ok: true, mediaItemIds: rows.map((r) => r.media_item_id), undoId } as const;
    });
    if (touched.ok) afterLinksChanged(touched.mediaItemIds);
    return touched;
}

/**
 * Per-episode work tied to the old window is stale now. With the outbox on, the
 * row triggers and `file.windowChanged` (emitted in the transaction) already
 * reach the stages, and this is a no-op; it covers the outbox-off fallback.
 * Best effort, after commit: the links are already right.
 */
function afterLinksChanged(mediaItemIds: string[]): void {
    for (const id of mediaItemIds) {
        MediaLifecycleService.afterContentChanged(id).catch((err: unknown) => {
            logger.warn('afterContentChanged failed after a manual link change', {
                mediaItemId: id,
                error: err instanceof Error ? err.message : String(err),
            });
        });
    }
}

/**
 * Tolerance between the duration a set was made for and a file's probed
 * duration: the scanner rounds to whole seconds, the stored value is a `real`.
 */
const SAME_DURATION_MS = DURATION_SNAP_MS * 2;

export interface NewFileIdentity {
    filePath: string;
    contentHash: string;
    sizeBytes: number;
    /** Probed duration of the new file; required to restore a set with windows. */
    durationMs: number | null;
}

export type RestoreOutcome =
    | { restored: true; fileId: string; mediaItemIds: string[] }
    | { restored: false; reason: string };

/** Cheap gate for the scanner: hash a new file only when some set exists at all. */
export async function hasManualLinkSets(sql: postgres.Sql): Promise<boolean> {
    const [row] = await sql<{ any: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM manual_file_link_sets) AS any
    `;
    return row?.any === true;
}

/**
 * Put a remembered set back on a file that just appeared at a new path with the
 * same content (head hash + size): a rename or move. Works in both orders the
 * scanner sees a rename in: the old row already deleted (watcher: unlink, then
 * add), or still there with its path gone (full scan: new paths before stale
 * cleanup), in which case its manual links move to the new file.
 *
 * Not restored, and the file is linked from its name as usual, when:
 *   - the file that holds the set is still on disk (a copy, not a move);
 *   - the duration differs (the head matched, the rest of the file did not);
 *   - an episode of the set no longer exists.
 *
 * `upsertFile` creates the new media_files row inside the transaction and
 * returns its id.
 */
export async function restoreManualLinksForNewFile(
    sql: postgres.Sql,
    file: NewFileIdentity,
    upsertFile: (tx: postgres.Sql) => Promise<string>,
): Promise<RestoreOutcome> {
    const [set] = await sql<
        {
            duration_ms: string | null;
            entries: LinkSetEntry[];
            file_id: string | null;
            holder_path: string | null;
        }[]
    >`
        SELECT s.duration_ms::text AS duration_ms, s.entries, s.file_id, mf.file_path AS holder_path
        FROM manual_file_link_sets s
        LEFT JOIN media_files mf ON mf.id = s.file_id
        WHERE s.file_hash_head = ${file.contentHash} AND s.file_size_bytes = ${file.sizeBytes}
    `;
    if (!set) return { restored: false, reason: 'no remembered set' };
    if (set.holder_path === file.filePath) return { restored: false, reason: 'same path' };
    if (set.holder_path !== null && (await safeStat(set.holder_path).catch(() => null))) {
        return { restored: false, reason: 'the file holding the set is still on disk' };
    }

    const entries = set.entries ?? [];
    const windowed = entries.length > 1;
    const setDurationMs = set.duration_ms === null ? null : Number(set.duration_ms);
    if (windowed) {
        if (
            file.durationMs === null ||
            setDurationMs === null ||
            Math.abs(file.durationMs - setDurationMs) > SAME_DURATION_MS
        ) {
            return { restored: false, reason: 'duration differs from the remembered set' };
        }
    }

    const result = await withTx(sql, async (txRaw): Promise<RestoreOutcome> => {
        const tx = txRaw as unknown as postgres.Sql;
        const fileId = await upsertFile(tx);
        await tx`
            UPDATE media_files
               SET file_hash_head = ${file.contentHash},
                   file_size_bytes = ${file.sizeBytes},
                   duration_seconds = COALESCE(
                       duration_seconds,
                       ${file.durationMs === null ? null : file.durationMs / 1000}
                   ),
                   updated_at = NOW()
             WHERE id = ${fileId}
        `;
        // The old row of a full-scan rename: its path is gone (checked above),
        // so its manual links move instead of staying as stale defaults.
        if (set.file_id !== null && set.file_id !== fileId) {
            await tx`
                DELETE FROM media_file_items
                WHERE file_id = ${set.file_id} AND offset_source = ${MANUAL_OFFSET_SOURCE}
            `;
        }
        const applied = await applyManualLinksInTx(
            tx,
            fileId,
            entries.map((e) => e.mediaItemId),
            windowed
                ? entries.map((e) => ({
                      startMs: e.startMs ?? 0,
                      endMs: e.endMs ?? 0,
                      boundaryOrigin: e.boundaryOrigin ?? undefined,
                  }))
                : null,
            { durationMs: setDurationMs ?? undefined },
        );
        if (!applied.ok) {
            // Roll the whole restore back; the caller links the file normally.
            throw new RestoreRejected(
                applied.reason === 'invalid' ? applied.message : 'file not found',
            );
        }
        return { restored: true, fileId, mediaItemIds: applied.mediaItemIds };
    }).catch((err: unknown) => {
        if (err instanceof RestoreRejected) {
            return { restored: false as const, reason: err.message };
        }
        throw err;
    });

    if (result.restored) afterLinksChanged(result.mediaItemIds);
    return result;
}

class RestoreRejected extends Error {}

/**
 * After the bytes of a manually linked file changed in place: keep the set only
 * when its windows still fit the new duration, and re-key the remembered set to
 * the new content. Otherwise hand the file back to automatic segments — the
 * windows were set for other bytes. Returns what happened, for the log.
 */
export async function revalidateManualLinksAfterContentChange(
    sql: postgres.Sql,
    fileId: string,
    newDurationMs: number | null,
): Promise<'not-manual' | 'kept' | 'cleared'> {
    const rows = await sql<
        {
            media_item_id: string;
            start_offset_ms: string | null;
            end_offset_ms: string | null;
            boundary_origin: BoundaryOrigin | null;
        }[]
    >`
        SELECT media_item_id, start_offset_ms::text AS start_offset_ms,
               end_offset_ms::text AS end_offset_ms, boundary_origin
        FROM media_file_items
        WHERE file_id = ${fileId} AND offset_source = ${MANUAL_OFFSET_SOURCE}
        ORDER BY sort_order
    `;
    if (rows.length === 0) return 'not-manual';

    const windowed = rows.length > 1;
    const lastEnd = rows[rows.length - 1].end_offset_ms;
    const fits =
        !windowed ||
        (newDurationMs !== null &&
            lastEnd !== null &&
            Math.abs(Number(lastEnd) - newDurationMs) <= SAME_DURATION_MS);

    if (!fits) {
        await clearManualFileEpisodes(sql, fileId);
        logger.warn('Manual episode windows no longer fit the file after its content changed', {
            fileId,
            newDurationMs,
            lastWindowEndMs: lastEnd === null ? null : Number(lastEnd),
        });
        return 'cleared';
    }

    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const [file] = await tx<
            { file_hash_head: string | null; file_size_bytes: string | null }[]
        >`
            SELECT file_hash_head, file_size_bytes::text AS file_size_bytes
            FROM media_files WHERE id = ${fileId}
        `;
        await writeLinkSet(tx, {
            fileId,
            hash: file?.file_hash_head ?? null,
            sizeBytes: file?.file_size_bytes ?? null,
            durationMs: windowed && lastEnd !== null ? Number(lastEnd) : newDurationMs,
            entries: rows.map((r) => ({
                mediaItemId: r.media_item_id,
                boundaryOrigin: r.boundary_origin,
                startMs: r.start_offset_ms === null ? null : Number(r.start_offset_ms),
                endMs: r.end_offset_ms === null ? null : Number(r.end_offset_ms),
            })),
        });
    });
    return 'kept';
}

/** Restore the complete previous mapping/default/hidden state only while its exact after-state remains. */
export async function undoManualFileEpisodes(
    sql: postgres.Sql,
    fileId: string,
    seriesId: string,
    receiptId: string,
): Promise<ManualLinkResult> {
    const result = await withTx(sql, async (tx) => {
        const receipt = await getMediaChange(tx, seriesId, `file-mapping:${fileId}`, receiptId);
        if (!receipt) return { ok: false, reason: 'conflict' } as const;
        const ids = await fileMappingChoiceIds(tx, receipt.after_state);
        const locked = await lockManualMapping(tx, fileId, ids, seriesId);
        if (!locked.ok) return locked;
        if (receipt.undone_at) return { ok: true, mediaItemIds: ids } as const;
        if (
            !(await sameMediaChangeState(
                tx,
                await captureFileMappingChoice(tx, fileId, ids),
                receipt.after_state,
            ))
        )
            return { ok: false, reason: 'conflict' } as const;
        if (!(await canRestoreFileMappingChoice(tx, receipt.before_state)))
            return { ok: false, reason: 'conflict' } as const;
        await restoreFileMappingChoice(tx, fileId, ids, receipt.before_state);
        await recomputeHasFilesBatch(tx, ids);
        for (const id of ids) await emitWindowChanged(tx, id, fileId);
        await markMediaChangeUndone(tx, receiptId);
        return { ok: true, mediaItemIds: ids } as const;
    });
    if (result.ok) afterLinksChanged(result.mediaItemIds);
    return result;
}
