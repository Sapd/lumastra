// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Multi-episode ("combined file") link arbitration.
 *
 * A filename like `S06E01E03.mkv` is read by the parser as the RANGE
 * "episodes 1 through 3", and the scanner links the file to every episode in
 * that range. That is the correct reading of the Plex/Jellyfin convention when
 * one physical file really does hold several episodes back to back.
 *
 * It is the WRONG reading when the trailing number is a part index — the
 * layout you get from splitting an anthology episode into its segments:
 *
 *     S06E01E01 - Immer wenn sie Chips aß.mkv     ← episode 1, part 1
 *     S06E01E02 - Wenn Fahrräder angreifen.mkv    ← episode 1, part 2
 *     S06E01E03 - Die Nacht der lebenden Finsters.mkv ← episode 1, part 3
 *     S06E02 - Mikey und Kurst.mkv                ← episode 2, its own file
 *     S06E03 - Randalls Geheimdienst.mkv          ← episode 3, its own file
 *
 * Read as ranges, the third file also claims episodes 2 and 3 — which already
 * have dedicated files of their own. Episodes 2 and 3 end up with a spurious
 * extra "version" pointing at a completely different show, and anything that
 * resolves "the file for this episode" can land on it: thumbnails extracted
 * from the wrong video, intro/outro offsets measured against the wrong
 * duration.
 *
 * The two readings are only distinguishable by looking at the rest of the
 * season, so arbitration happens here rather than in the parser: a range link
 * loses to a file that is dedicated to exactly that one episode. Both scan
 * orders reach the same end state — the range file yields when a dedicated
 * file already exists, and a dedicated file evicts range links that got there
 * first. Episodes with no dedicated file of their own (episode 1 above) keep
 * every file that claims them, so genuine combined files are untouched.
 */

import type postgres from 'postgres';
import { parseMediaFilename } from '../../../../../../utils/filename-parser.js';
import { getAdminRangeMappings } from '$lib/server/database/queries/range-mapping-proof.queries.js';
import {
    recordCurrentRangeMappingProof,
    observeRangeParticipant,
} from '$lib/server/services/range-mapping-proof.service.js';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import {
    listDirectChildMediaFilePaths,
    recordRangeSupersededFile,
    type KnownFileRow,
} from '../../../../../../database/queries/media-files.queries.js';
import { withTx } from '../../../../../../database/with-tx.js';
import { MANUAL_OFFSET_SOURCE } from '$lib/shared/manual-file-segments.js';

/**
 * The episode span a filename claims, or null when it names no episode.
 * `ranged` records whether the name was written in range form at all, which is
 * what separates `S06E02` from the self-referential `S06E01E01`.
 */
function episodeSpan(filePath: string): { start: number; end: number; ranged: boolean } | null {
    const parsed = parseMediaFilename(filePath);
    const start = parsed.episodeStart ?? parsed.episode;
    if (start === undefined) return null;
    return {
        start,
        end: parsed.episodeEnd ?? start,
        ranged: parsed.episodeEnd !== undefined,
    };
}

/**
 * True when the filename designates exactly this one episode and nothing else
 * (`S06E02.mkv` for episode 2). Two things are deliberately excluded:
 *
 * - A range that merely starts here (`S06E02E04.mkv`) — it claims others too.
 * - A SELF-REFERENTIAL range (`S06E01E01.mkv`, start === end). It names one
 *   episode, but it is written in the same range form as its siblings, so in a
 *   split-anthology set it is just "part 1" — not evidence that episode 1 owns
 *   a standalone file. Counting it would let part 1 evict parts 2 and 3 and
 *   leave the episode holding a third of itself. Only an unambiguous
 *   single-episode name earns the right to displace a range link.
 */
export function isDedicatedEpisodeFile(filePath: string, episodeNumber: number): boolean {
    const span = episodeSpan(filePath);
    if (!span) return false;
    return !span.ranged && span.start === episodeNumber;
}

/**
 * True when the filename claims a multi-episode range that merely covers this
 * episode — the link a dedicated file is entitled to displace.
 */
export function isRangeFileCovering(filePath: string, episodeNumber: number): boolean {
    const span = episodeSpan(filePath);
    if (!span) return false;
    return span.end > span.start && episodeNumber >= span.start && episodeNumber <= span.end;
}

/** A file dedicated to one episode, with the ids of its file row and episode row. */
export interface DedicatedEpisodeFile {
    filePath: string;
    fileId: string;
    episodeId: string;
}

/**
 * Find a file already linked to `episodeNumber` in this season that is
 * dedicated to exactly that episode, ignoring `excludeFilePath` (the file
 * currently being scanned) and any path in `ignorePaths`.
 *
 * Returns the winning file, or null when the episode has no dedicated file —
 * in which case a range file linking to it is legitimate. DB only: nothing is
 * stat'ed, so the answer can be read inside an episode link lock.
 */
export async function findDedicatedEpisodeFile(
    sql: postgres.Sql,
    seasonId: string,
    episodeNumber: number,
    excludeFilePath: string,
    ignorePaths: ReadonlySet<string> = new Set(),
): Promise<DedicatedEpisodeFile | null> {
    const rows = await sql<{ file_path: string; file_id: string; episode_id: string }[]>`
        SELECT mf.file_path, mf.id AS file_id, ep.id AS episode_id
        FROM media_items ep
        JOIN media_file_items mfi ON mfi.media_item_id = ep.id
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE ep.parent_id = ${seasonId}
          AND ep.media_type = 'episode'
          AND ep.episode_number = ${episodeNumber}
          AND mf.file_path IS NOT NULL
          AND mf.file_path <> ${excludeFilePath}
          AND NOT mf.is_missing
        ORDER BY mf.id
    `;
    const row = rows.find(
        (r) => !ignorePaths.has(r.file_path) && isDedicatedEpisodeFile(r.file_path, episodeNumber),
    );
    if (!row) return null;
    return { filePath: row.file_path, fileId: row.file_id, episodeId: row.episode_id };
}

/**
 * {@link findDedicatedEpisodeFile} reduced to the winning path.
 */
export async function findDedicatedFileForEpisodeNumber(
    sql: postgres.Sql,
    seasonId: string,
    episodeNumber: number,
    excludeFilePath: string,
): Promise<string | null> {
    return (
        (await findDedicatedEpisodeFile(sql, seasonId, episodeNumber, excludeFilePath))?.filePath ??
        null
    );
}

/**
 * Run `fn` holding the link decision for one episode of one season, on a
 * transaction handle. Two files that both claim the episode — a range file
 * (`S03E03E04`) and its own single-episode file (`S03E04`) — each check for a
 * dedicated file before they attach. Without this lock both checks can pass
 * before either attaches, and the range file keeps a link next to the
 * dedicated one. Holding the lock across check, attach and eviction makes the
 * second file see the first one's committed result.
 *
 * Only ever one episode's lock is held at a time, so two of these can never
 * deadlock against each other. `attachFileToItem` takes its per-item lock
 * inside `fn`, so the order is always episode lock, then item lock.
 */
export async function withEpisodeLinkLock<T>(
    sql: postgres.Sql,
    seasonId: string,
    episodeNumber: number,
    fn: (tx: postgres.Sql) => Promise<T>,
): Promise<T> {
    return withTx(sql, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`episode-link:${seasonId}:${episodeNumber}`}, 0))`;
        return fn(tx);
    });
}

/**
 * Resolve the season a file's existing episode links belong to, so a
 * dedicated-file lookup can be scoped without re-running hierarchy creation.
 *
 * Returns null when the file has no episode link in that season yet.
 */
export async function findSeasonIdForLinkedFile(
    sql: postgres.Sql,
    fileId: string,
    seasonNumber: number,
): Promise<string | null> {
    const rows = await sql<{ parent_id: string }[]>`
        SELECT ep.parent_id
        FROM media_file_items mfi
        JOIN media_items ep ON ep.id = mfi.media_item_id
        WHERE mfi.file_id = ${fileId}
          AND ep.media_type = 'episode'
          AND ep.season_number = ${seasonNumber}
          AND ep.parent_id IS NOT NULL
        LIMIT 1
    `;
    return rows[0]?.parent_id ?? null;
}

/**
 * Drop range-file links to `episodeId` now that a file dedicated to exactly
 * that episode is attached, and make the dedicated file the default.
 *
 * Handles the scan order where the range file was seen FIRST — it will already
 * hold the link (and, since `attachFileToItem` makes the first attach the
 * default, the `is_default` flag too). Returns the evicted paths for logging.
 *
 * A link carrying a segment window (`offset_source` set — e.g. the
 * `runtime-split` offsets that give each episode its slice of a genuine
 * combined file) is NEVER evicted. Those offsets are positive evidence that
 * the file really does hold this episode and that the system successfully
 * derived where: SpongeBob `S01E20-21` is segmented that way while a separate
 * standalone `S01E20` rip also exists, and dropping the segmented link would
 * discard working playback data to chase a duplicate. The mis-links this
 * function exists to clean up have no offsets at all.
 *
 * `is_default` is rewritten in two statements inside the transaction rather
 * than one: `idx_media_file_items_one_default` is a plain (non-deferrable)
 * unique index, so a single UPDATE flipping one row true while another is
 * still true can trip it mid-statement. The one-default invariant trigger is
 * DEFERRABLE INITIALLY DEFERRED and so only checks at commit, by which point
 * exactly one default row remains.
 */
export async function evictRangeLinksSupersededByDedicatedFile(
    sql: postgres.Sql,
    episodeId: string,
    episodeNumber: number,
    dedicatedFileId: string,
    dedicatedFilePath: string,
): Promise<string[]> {
    // The caller's "is this a single-episode file" test is `episodeCount === 1`,
    // which is NOT the same question: a self-referential range (S06E01E01)
    // spans one episode and passes it. Re-ask the real predicate here so the
    // destructive path can never run on a file that only looks dedicated —
    // otherwise part 1 of a split anthology evicts parts 2 and 3.
    if (!isDedicatedEpisodeFile(dedicatedFilePath, episodeNumber)) return [];

    const linked = await sql<
        {
            file_id: string;
            file_path: string;
            is_default: boolean;
            offset_source: string | null;
        }[]
    >`
        SELECT mfi.file_id, mf.file_path, mfi.is_default, mfi.offset_source
        FROM media_file_items mfi
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE mfi.media_item_id = ${episodeId}
          AND mf.file_path IS NOT NULL
    `;

    const superseded = linked.filter(
        (row) =>
            row.file_id !== dedicatedFileId &&
            row.offset_source === null &&
            isRangeFileCovering(row.file_path, episodeNumber),
    );
    if (superseded.length === 0) return [];

    const supersededIds = superseded.map((row) => row.file_id);

    // Only reassign the default when the row we are deleting held it —
    // otherwise a surviving link (e.g. a segmented one we just declined to
    // evict) would be silently demoted.
    const evictingDefault = superseded.some((row) => row.is_default);

    // withTx, not sql.begin: called inside withEpisodeLinkLock's transaction it
    // nests as a savepoint instead of failing on a TransactionSql.
    await withTx(sql, async (tx) => {
        await tx`
            DELETE FROM media_file_items
            WHERE media_item_id = ${episodeId}
              AND file_id = ANY(${tx.array(supersededIds)}::uuid[])
        `;
        if (evictingDefault) {
            await tx`
                UPDATE media_file_items SET is_default = false
                WHERE media_item_id = ${episodeId} AND is_default = true
            `;
            const promoted = await tx`
                UPDATE media_file_items SET is_default = true
                WHERE media_item_id = ${episodeId} AND file_id = ${dedicatedFileId}
            `;
            // The dedicated row can be gone — a concurrent scan's ON CONFLICT
            // DO NOTHING, or a delete between the SELECT above and this
            // transaction. Promoting nothing after clearing every default
            // leaves the item file-bearing with no default, which the deferred
            // one-default trigger rejects at COMMIT and fails the whole scan.
            // Fall back to any surviving link so the invariant still holds.
            if (promoted.count === 0) {
                await tx`
                    UPDATE media_file_items SET is_default = true
                    WHERE file_id = (
                        SELECT file_id FROM media_file_items
                        WHERE media_item_id = ${episodeId}
                        ORDER BY sort_order, file_id
                        LIMIT 1
                    )
                      AND media_item_id = ${episodeId}
                `;
            }
        }
    });

    return superseded.map((row) => row.file_path);
}

/** Cheap name test before the parser runs: an episode number followed by another one. */
const RANGE_NAME_HINT = /[ex]\d+\s*(?:-\s*e?|e)\s*\d+/i;

/**
 * Unchanged files named as an episode RANGE (`S01E01E02`) that are linked to
 * fewer episodes than the range holds. The full scan skips unchanged files
 * before `processVideoFile`, whose range check recreates a missing link, so a
 * combined file left half-linked (the second episode created later, a failed
 * write, an old bug) stayed that way forever. The scan promotes these out of
 * the unchanged set.
 *
 * A range link that is missing on purpose (the episode has a dedicated file,
 * see the module doc) is promoted too; `processVideoFile` recognises it and
 * returns without writing. Only range-named files are parsed, and the link
 * counts come from one query.
 *
 * A range file that holds every link of its span can still hold a link that a
 * dedicated file supersedes: a scan race left both files attached to the
 * episode, or an older scan did. It is promoted as well, so the hierarchy path
 * evicts that link (see the existing-file range check in processVideoFile).
 * Segment-window links (`offset_source` set) are never promoted for this, and
 * neither is a file an admin linked by hand (`offset_source = 'manual'`).
 */
export async function findRangeFilesMissingLinks(
    sql: postgres.Sql,
    unchangedPaths: readonly string[],
): Promise<Set<string>> {
    const wanted = new Map<string, number>();
    for (const p of unchangedPaths) {
        const slash = p.lastIndexOf('/');
        if (!RANGE_NAME_HINT.test(p.slice(slash + 1))) continue;
        const span = episodeSpan(p);
        // A span wider than any real combined file is a misread name.
        if (span && span.ranged && span.end > span.start && span.end - span.start < 50) {
            wanted.set(p, span.end - span.start + 1);
        }
    }
    if (wanted.size === 0) return new Set();
    const rows = await sql<{ file_path: string; links: number; manual: boolean }[]>`
        SELECT mf.file_path, count(mfi.media_item_id)::int AS links,
               COALESCE(bool_or(mfi.offset_source = ${MANUAL_OFFSET_SOURCE}), false) AS manual
          FROM media_files mf
          LEFT JOIN media_file_items mfi ON mfi.file_id = mf.id
         WHERE mf.file_path = ANY(${[...wanted.keys()]}::text[])
         GROUP BY mf.file_path
    `;
    const out = new Set<string>();
    const complete: string[] = [];
    for (const row of rows) {
        // Linked by hand: the name's range is not what the file holds.
        if (row.manual) continue;
        if (row.links < (wanted.get(row.file_path) ?? 0)) out.add(row.file_path);
        else complete.push(row.file_path);
    }
    if (complete.length === 0) return out;

    // For each unsegmented range link of a complete range file: the other
    // linked files of that episode, decided in JS below.
    const overlaps = await sql<{ file_path: string; episode_number: number; other_path: string }[]>`
        SELECT rf.file_path, ep.episode_number, df.file_path AS other_path
          FROM media_files rf
          JOIN media_file_items rfi ON rfi.file_id = rf.id
                                   AND rfi.offset_source IS NULL
          JOIN media_items ep ON ep.id = rfi.media_item_id
          JOIN media_file_items dfi ON dfi.media_item_id = ep.id
                                   AND dfi.file_id <> rf.id
          JOIN media_files df ON df.id = dfi.file_id
         WHERE rf.file_path = ANY(${complete}::text[])
           AND ep.media_type = 'episode'
           AND ep.episode_number IS NOT NULL
           AND df.file_path IS NOT NULL
           AND NOT df.is_missing
    `;
    for (const row of overlaps) {
        if (
            isRangeFileCovering(row.file_path, row.episode_number) &&
            isDedicatedEpisodeFile(row.other_path, row.episode_number)
        ) {
            out.add(row.file_path);
        }
    }
    return out;
}

/**
 * Episode numbers the file is linked to WITHOUT a segment window
 * (`offset_source` IS NULL) — the only links
 * {@link evictRangeLinksSupersededByDedicatedFile} may remove.
 */
export async function findUnsegmentedLinkEpisodesForFile(
    sql: postgres.Sql,
    fileId: string,
): Promise<Set<number>> {
    const rows = await sql<{ episode_number: number }[]>`
        SELECT ep.episode_number
          FROM media_file_items mfi
          JOIN media_items ep ON ep.id = mfi.media_item_id
         WHERE mfi.file_id = ${fileId}
           AND mfi.offset_source IS NULL
           AND ep.media_type = 'episode'
           AND ep.episode_number IS NOT NULL
    `;
    return new Set(rows.map((r) => r.episode_number));
}

/**
 * Record the `range_superseded` stub of a range file that its single-episode
 * files have just taken over completely.
 *
 * Eviction drops a range file's links one episode at a time. When the last
 * covered episode goes, the file has a row and no link, and nothing records
 * why: the next full scan treats it as new (one ffprobe), then records the
 * stub. This records it at once, so the next scan skips the file.
 *
 * Call it AFTER the transaction that evicted the link has committed: it stats
 * the file. Returns false, writing nothing, while the file still has a link, when
 * some episode of its span has no dedicated file, or when the file cannot be
 * stat'ed. recordRangeSupersededFile writes only while the row is unlinked.
 */
export async function recordStubIfRangeFullySuperseded(
    sql: postgres.Sql,
    rangePath: string,
    seasonId: string,
    libraryGroupId: string | null,
    signal?: AbortSignal,
): Promise<boolean> {
    const span = episodeSpan(rangePath);
    if (
        !span ||
        !span.ranged ||
        !Number.isInteger(span.start) ||
        span.start < 0 ||
        span.start > 100000 ||
        span.end <= span.start ||
        span.end - span.start >= 50
    )
        return false;

    const [linked] = await sql<{ linked: boolean }[]>`
        SELECT EXISTS (
            SELECT 1
              FROM media_file_items mfi
              JOIN media_files mf ON mf.id = mfi.file_id
             WHERE mf.file_path = ${rangePath}
        ) AS linked
    `;
    if (linked?.linked) return false;

    const supersededBy: string[] = [];
    const dedicatedIds: string[] = [];
    for (let ep = span.start; ep <= span.end; ep++) {
        const dedicated = await findDedicatedEpisodeFile(sql, seasonId, ep, rangePath);
        if (!dedicated) return false;
        supersededBy.push(dedicated.filePath);
        dedicatedIds.push(dedicated.fileId);
    }

    const [source] = await sql<
        { file_version: string }[]
    >`SELECT xmin::text AS file_version FROM media_files WHERE file_path = ${rangePath}`;
    const st = await safeStat(rangePath).catch(() => null);
    if (!st || signal?.aborted) return false;
    await recordRangeSupersededFile(sql, {
        filePath: rangePath,
        libraryGroupId,
        supersededBy,
        mtime: st.mtime,
        size: st.size,
        expectedVersion: source?.file_version,
    });
    const [range] = await sql<
        { id: string }[]
    >`SELECT id FROM media_files WHERE file_path = ${rangePath}`;
    if (range && !signal?.aborted)
        await recordCurrentRangeMappingProof(sql, {
            fileId: range.id,
            seasonId,
            first: span.start,
            last: span.end,
            dedicatedIds,
            signal,
        });
    return true;
}

/**
 * Multi-episode files that a removed single-episode file may have covered,
 * found by NAME: every range file in the removed file's folder that claims its
 * episode with the same season (`S01E01E02` for a removed `S01E02`).
 *
 * The superseded-verdict lookup (findRangeFilesSupersededBy) only finds range
 * files that still carry the verdict. A range file that was linked again after
 * its first covering file went away has lost the verdict, yet still lacks the
 * second episode when the second covering file goes too.
 *
 * Returns nothing unless the removed name is an unambiguous single-episode
 * name (not a range, not self-referential).
 */
export async function findRangeFilesCoveringRemovedFile(
    sql: postgres.Sql,
    removedPath: string,
): Promise<string[]> {
    const span = episodeSpan(removedPath);
    if (!span || span.ranged) return [];
    const episode = span.start;
    if (!isDedicatedEpisodeFile(removedPath, episode)) return [];
    const season = parseMediaFilename(removedPath).season;
    const dir = removedPath.slice(0, removedPath.lastIndexOf('/'));
    const siblings = await listDirectChildMediaFilePaths(sql, dir);
    return siblings
        .filter(
            (p) =>
                p !== removedPath &&
                isRangeFileCovering(p, episode) &&
                parseMediaFilename(p).season === season,
        )
        .sort();
}

/**
 * Adopt only positively validated current observations. Legacy linked/path
 * flags still help invalidation lookups, but cannot establish mapping coverage.
 * Reobserve every participant before skipping; graph checks happen in SQL.
 */
export async function partitionSupersededRangeFiles(
    newFiles: readonly string[],
    knownFiles: ReadonlyMap<string, KnownFileRow>,
    walked: ReadonlySet<string>,
    sql?: postgres.Sql,
    signal?: AbortSignal,
): Promise<{ process: string[]; superseded: string[] }> {
    if (!sql || signal?.aborted) return { process: [...newFiles], superseded: [] };
    const candidates = newFiles.filter((p) => {
        const row = knownFiles.get(p);
        return (
            row && !row.is_linked && row.health_issues?.some((i) => i.type === 'range_superseded')
        );
    });
    const mappings = await getAdminRangeMappings(
        sql,
        candidates.map((p) => knownFiles.get(p)!.id),
    );
    const skip = new Set<string>();
    for (const path of candidates) {
        const proof = mappings.get(knownFiles.get(path)!.id)?.proof;
        if (!proof) continue;
        let current = true;
        for (const participant of proof.participants) {
            if (!walked.has(participant.path)) {
                current = false;
                break;
            }
            const observed = await observeRangeParticipant(
                {
                    id: participant.fileId,
                    path: participant.path,
                    size: participant.size,
                    mtimeMs: participant.mtimeMs,
                    generation: participant.generation,
                },
                participant.root,
                signal,
            );
            if (JSON.stringify(observed) !== JSON.stringify(participant)) {
                current = false;
                break;
            }
        }
        if (current) skip.add(path);
    }
    // A graph/source change during the physical probes also forces processing.
    const final = await getAdminRangeMappings(
        sql,
        [...skip].map((p) => knownFiles.get(p)!.id),
    );
    for (const path of skip)
        if (final.get(knownFiles.get(path)!.id)?.state !== 'current') skip.delete(path);
    return {
        process: newFiles.filter((p) => !skip.has(p)),
        superseded: newFiles.filter((p) => skip.has(p)),
    };
}
