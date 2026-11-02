// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File Segment Queries
 *
 * Persistence for the per-episode playback windows on combined files (one
 * physical file backing several episode rows, e.g. S02E24E25). Derivation
 * itself is pure and lives in $lib/server/utils/file-segments.
 *
 * Offsets are a projection: they are always recomputable from chapters +
 * runtimes + duration, so a rebuild is safe to re-run at any time.
 *
 * The one exception is a MANUAL link set (`offset_source = 'manual'`, written by
 * the admin file-episodes editor through manual-file-links.service.ts). Its
 * order and windows are the admin's decision and nothing here can recompute
 * them, so every writer below leaves a manually linked file alone.
 */

import type postgres from 'postgres';
import {
    deriveFileSegments,
    type FileSegment,
    type SegmentChapterInput,
    type SegmentEpisodeInput,
} from '../../utils/file-segments.js';
import { parseMediaFilename } from '../../utils/filename-parser.js';
import { MANUAL_OFFSET_SOURCE } from '../../../shared/manual-file-segments.js';

/**
 * Whether an admin linked this file to its episodes by hand. One manual row is
 * enough: the editor writes the whole set at once.
 */
export async function isManuallyLinkedFile(sql: postgres.Sql, fileId: string): Promise<boolean> {
    const [row] = await sql<{ manual: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM media_file_items
            WHERE file_id = ${fileId} AND offset_source = ${MANUAL_OFFSET_SOURCE}
        ) AS manual
    `;
    return row?.manual === true;
}

export interface MultiEpisodeFileGroup {
    fileId: string;
    durationMs: number | null;
    episodes: SegmentEpisodeInput[];
    chapters: SegmentChapterInput[];
    declaredEpisodeCount: number | null;
}

/**
 * How many episodes the release name declares (`S02E24E25` → 2, `S01E01-02-03`
 * → 3), or null when it declares no range. This is the same parse the scanner
 * used to create the episode rows, so it is the honest record of what the file
 * holds — unlike provider runtimes, which for these releases often describe the
 * combined block rather than the individual parts.
 */
function declaredEpisodeCountFor(filePath: string): number | null {
    const parsed = parseMediaFilename(filePath);
    const start = parsed.episodeStart ?? parsed.episode;
    if (start === undefined) return null;
    const end = parsed.episodeEnd ?? start;
    if (end < start) return null;
    return end - start + 1;
}

/**
 * Load every file that backs more than one episode row, with the evidence
 * needed to derive segments. Single-episode files are excluded: they never need
 * offsets (the whole file is the episode). Manually linked files are excluded
 * too: their windows are not derived.
 */
export async function getMultiEpisodeFileGroups(
    sql: postgres.Sql,
    fileId?: string,
): Promise<MultiEpisodeFileGroup[]> {
    // System projection maintenance over combined files; no per-user access
    // scoping applies. Coverage is implicitly restricted to items that actually
    // have a file via the media_file_items join, so catalog ghosts cannot appear.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<
        {
            file_id: string;
            file_path: string;
            duration_ms: string | null;
            episodes: SegmentEpisodeInput[];
            chapters: SegmentChapterInput[];
        }[]
    >`
        SELECT
            mf.id AS file_id,
            mf.file_path,
            (mf.duration_seconds * 1000)::bigint AS duration_ms,
            (
                SELECT json_agg(
                    json_build_object(
                        'mediaItemId', mi.id,
                        'episodeNumber', mi.episode_number,
                        'runtimeMs', (mi.runtime_seconds * 1000)::bigint
                    ) ORDER BY mi.episode_number ASC NULLS LAST, mi.id ASC
                )
                FROM media_file_items x
                JOIN media_items mi
                    ON mi.id = x.media_item_id AND mi.media_type = 'episode'
                WHERE x.file_id = mf.id AND x.is_default = true
            ) AS episodes,
            COALESCE(
                (
                    SELECT json_agg(
                        json_build_object('name', c.chapter_name, 'startMs', (c.start_ticks / 10000)::bigint)
                        ORDER BY c.chapter_index ASC
                    )
                    FROM episode_chapters c
                    WHERE c.file_id = mf.id
                ),
                '[]'::json
            ) AS chapters
        FROM media_files mf
        WHERE ${fileId ? sql`mf.id = ${fileId}` : sql`true`}
          AND NOT EXISTS (
              SELECT 1 FROM media_file_items manual
              WHERE manual.file_id = mf.id AND manual.offset_source = ${MANUAL_OFFSET_SOURCE}
          )
          AND mf.id IN (
              SELECT mfi.file_id
              FROM media_file_items mfi
              JOIN media_items mi2
                  ON mi2.id = mfi.media_item_id AND mi2.media_type = 'episode'
              WHERE mfi.is_default = true
              GROUP BY mfi.file_id
              HAVING count(*) > 1
          )
    `;

    return rows.map((r) => ({
        fileId: r.file_id,
        declaredEpisodeCount: declaredEpisodeCountFor(r.file_path),
        // bigint arrives as a string from postgres.js; NUMERIC/bigint are never
        // implicitly numbers here (see typedjson-prod-skip-numeric-strings).
        durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
        episodes: (r.episodes ?? []).map((e) => ({
            mediaItemId: e.mediaItemId,
            episodeNumber: e.episodeNumber === null ? null : Number(e.episodeNumber),
            runtimeMs: e.runtimeMs === null ? null : Number(e.runtimeMs),
        })),
        chapters: (r.chapters ?? []).map((c) => ({
            name: c.name,
            startMs: Number(c.startMs),
        })),
    }));
}

/**
 * Write the derived windows for one file, clearing any previous offsets on it
 * first so a file that stops qualifying (e.g. its chapters changed, or an
 * episode row was detached) reverts to whole-file playback rather than keeping
 * stale bounds.
 *
 * Manual rows are never touched: neither cleared nor overwritten.
 */
export async function applyFileSegments(
    sql: postgres.Sql,
    fileId: string,
    segments: FileSegment[] | null,
): Promise<void> {
    await sql`
        UPDATE media_file_items
        SET start_offset_ms = NULL, end_offset_ms = NULL, offset_source = NULL
        WHERE file_id = ${fileId}
          AND offset_source IS DISTINCT FROM ${MANUAL_OFFSET_SOURCE}
    `;

    if (!segments || segments.length === 0) return;

    for (const segment of segments) {
        await sql`
            UPDATE media_file_items
            SET start_offset_ms = ${segment.startMs},
                end_offset_ms = ${segment.endMs},
                offset_source = ${segment.source}
            WHERE file_id = ${fileId} AND media_item_id = ${segment.mediaItemId}
              AND offset_source IS DISTINCT FROM ${MANUAL_OFFSET_SOURCE}
        `;
    }
}

/**
 * Recompute the segments for a single file. Call after anything that changes the
 * evidence: episode rows attached/detached, the file re-probed (duration), or
 * chapters synced. A manually linked file keeps its windows.
 */
export async function refreshSegmentsForFile(sql: postgres.Sql, fileId: string): Promise<void> {
    if (await isManuallyLinkedFile(sql, fileId)) return;

    const [group] = await getMultiEpisodeFileGroups(sql, fileId);

    // Not a combined file (any more) — make sure no stale offsets survive.
    if (!group) {
        await applyFileSegments(sql, fileId, null);
        return;
    }

    await applyFileSegments(sql, fileId, deriveFileSegments(group));
}

export interface EpisodeWindow {
    mediaItemId: string;
    /** Offset of this episode's first frame within the file. */
    startMs: number;
    /** Offset of the next episode's first frame (or EOF for the last). */
    endMs: number;
}

/**
 * Every episode window on the file backing `mediaItemId`, including its own —
 * empty for an ordinary single-episode file (where the file IS the episode).
 *
 * Needed wherever a file-absolute playback position has to be judged against
 * individual episodes. A combined file plays as ONE video, so watching it
 * through passes through several episodes in a single session, and the player
 * only ever reports progress for the one that was opened. Completion has to be
 * derived for the others from the same position: "90% watched" for the second
 * episode means 90% of ITS window, not 90% of the file, and not a raw position
 * compared against its runtime (which would mark it watched the instant
 * playback entered the window).
 */
export async function getEpisodeWindowsForFile(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<EpisodeWindow[]> {
    const rows = await sql<
        { media_item_id: string; start_offset_ms: string; end_offset_ms: string }[]
    >`
        SELECT sibling.media_item_id, sibling.start_offset_ms, sibling.end_offset_ms
        FROM media_file_items anchor
        JOIN media_file_items sibling
            ON sibling.file_id = anchor.file_id
            AND sibling.is_default = true
        WHERE anchor.media_item_id = ${mediaItemId}
          AND anchor.is_default = true
          AND sibling.start_offset_ms IS NOT NULL
          AND sibling.end_offset_ms IS NOT NULL
        ORDER BY sibling.start_offset_ms ASC
    `;

    return rows.map((r) => ({
        mediaItemId: r.media_item_id,
        startMs: Number(r.start_offset_ms),
        endMs: Number(r.end_offset_ms),
    }));
}

export interface RebuildSegmentsResult {
    filesConsidered: number;
    filesSegmented: number;
    bySource: Record<string, number>;
}

/**
 * Recompute segments across every combined file. Used by the backfill migration
 * and available as a repair action.
 */
export async function rebuildAllFileSegments(sql: postgres.Sql): Promise<RebuildSegmentsResult> {
    const groups = await getMultiEpisodeFileGroups(sql);
    const result: RebuildSegmentsResult = {
        filesConsidered: groups.length,
        filesSegmented: 0,
        bySource: {},
    };

    for (const group of groups) {
        const segments = deriveFileSegments(group);
        await applyFileSegments(sql, group.fileId, segments);

        if (segments) {
            result.filesSegmented++;
            const source = segments[0].source;
            result.bySource[source] = (result.bySource[source] ?? 0) + 1;
        }
    }

    return result;
}
