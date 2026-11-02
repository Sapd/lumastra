// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path';
import type postgres from 'postgres';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';
import {
    listSeriesFolderWitnesses,
    findSeriesFolderOwnerId,
    listSeriesFolderOwnerIds,
    tryLockSeriesFolderWitnesses,
    type SeriesFolderWitness,
} from '$lib/server/database/queries/series-folder-ownership.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { assessFilePresence } from '$lib/server/utils/file-presence.js';
import { seasonNumberFromFolderName } from '$lib/server/utils/path-parsing.js';

export interface FolderSeriesEvidence {
    imdbId?: string;
    tmdbId?: string;
    year?: number;
}

class SeriesFolderOwnershipChangedError extends Error {}

type RecordRangeLinkEvictions = (episodeId: string, filePaths: readonly string[]) => void;

type OwnershipUncertainty = {
    kind: 'uncertain';
    reason: string;
    retryable: boolean;
    /** Lock/snapshot contention, distinct from contradictory identity evidence. */
    contention?: true;
};

type OwnershipResult<T> = { kind: 'none' } | OwnershipUncertainty | { kind: 'reused'; value: T };

/** Resolve directory identity, never a basename or title. Only an immediate
 * series/episode or series/recognised-season/episode layout establishes scope;
 * flat roots and arbitrary nested show collections cannot establish an owner. */
function seriesDirectory(filePath: string, libraryRoot: string): string | null {
    if (!path.isAbsolute(filePath) || !path.isAbsolute(libraryRoot)) return null;
    if (path.normalize(filePath) !== filePath) return null;
    const root = path.resolve(libraryRoot);
    let folder = path.dirname(filePath);
    if (seasonNumberFromFolderName(path.basename(folder)) !== null) folder = path.dirname(folder);
    if (folder === root || !folder.startsWith(root + '/')) return null;
    return folder;
}

const seriesFolderLocks = new Map<string, Promise<unknown>>();

/** Serialize unmatched attachments in a series directory, including the first
 * episode that establishes its owner. Without this, sibling scanner workers
 * contend on the witness fence or invalidate each other's final observation.
 * Keep the lock and all hierarchy writes on one connection/transaction. */
export async function withSeriesFolderLock<T>(
    sql: postgres.Sql,
    filePath: string,
    library: LibraryPathRow,
    work: (tx: postgres.Sql) => Promise<T>,
): Promise<T | OwnershipUncertainty> {
    const folder = seriesDirectory(filePath, library.path);
    const run = async (): Promise<T> =>
        withTx(sql, async (tx) => {
            let previousTimeout: string | undefined;
            if (folder) {
                const [timeout] = await tx<{ previous: string; timeout_ms: number }[]>`
                    SELECT current_setting('lock_timeout') AS previous, setting::int AS timeout_ms
                    FROM pg_settings WHERE name = 'lock_timeout'
                `;
                previousTimeout = timeout.previous;
                const limit =
                    timeout.timeout_ms > 0 ? Math.min(timeout.timeout_ms, 30_000) : 30_000;
                await tx`SELECT set_config('lock_timeout', ${String(limit)}, true)`;
                await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`series-folder:${folder}`}, 0))`;
            }
            const value = await work(tx);
            if (previousTimeout !== undefined)
                await tx`SELECT set_config('lock_timeout', ${previousTimeout}, true)`;
            return value;
        });
    // Queue siblings before BEGIN reserves a pool connection. Only the head
    // waits on PostgreSQL; the advisory lock still fences other replicas.
    const previous = folder
        ? (seriesFolderLocks.get(folder) ?? Promise.resolve())
        : Promise.resolve();
    const current = previous.then(run, run);
    const tail = current.catch(() => undefined);
    if (folder) seriesFolderLocks.set(folder, tail);
    try {
        return await current;
    } catch (error) {
        // Classify after rollback: hierarchy creation, rename adoption and
        // episode-link locks can time out inside work(), too.
        if ((error as { code?: string }).code === '55P03')
            return {
                kind: 'uncertain',
                retryable: true,
                reason: 'series folder lock is contended',
                contention: true,
            };
        throw error;
    } finally {
        if (folder && seriesFolderLocks.get(folder) === tail) seriesFolderLocks.delete(folder);
    }
}

/** Cheap, unlocked equality check only. Different/unknown owners still need
 * withVerifiedSeriesFolderOwner before deciding a cross-series attachment. */
export async function currentSeriesFolderOwnerId(
    sql: postgres.Sql,
    filePath: string,
    library: LibraryPathRow,
    year?: number,
): Promise<string | null> {
    const folder = seriesDirectory(filePath, library.path);
    if (!folder) return null;
    return findSeriesFolderOwnerId(sql, folder, filePath, library.library_group_id, year);
}

function uniqueOwner(
    rows: SeriesFolderWitness[],
    library: LibraryPathRow,
    folder: string,
    year?: number,
): string | null {
    if (rows.length === 0 || rows.length > 1000) return null;
    const owners = new Set(rows.map((r) => r.series_id));
    if (owners.size !== 1 || owners.has(null)) return null;
    for (const row of rows) {
        if (
            !row.valid_hierarchy ||
            row.is_missing ||
            row.file_library !== library.library_group_id ||
            row.series_library !== library.library_group_id
        )
            return null;
        if (year !== undefined && row.series_year !== year) return null;
        // A different show nested below this folder must not become a sibling.
        if (seriesDirectory(row.file_path, library.path) !== folder) return null;
    }
    return rows[0].series_id;
}

/** Execute the attachment on the SAME transaction as ownership validation.
 * Re-read after locks (fresh READ COMMITTED statement), including every link
 * of every witness file. Manual relinking/status changes cannot invalidate a
 * checked witness until the attachment commits. No provider IDs are written. */
export async function withVerifiedSeriesFolderOwner<T>(
    sql: postgres.Sql,
    filePath: string,
    library: LibraryPathRow,
    evidence: FolderSeriesEvidence,
    attach: (
        tx: postgres.Sql,
        seriesId: string,
        recordRangeLinkEvictions: RecordRangeLinkEvictions,
    ) => Promise<T>,
): Promise<OwnershipResult<T>> {
    const folder = seriesDirectory(filePath, library.path);
    if (!folder) return { kind: 'none' };
    try {
        return await withTx(sql, async (tx): Promise<OwnershipResult<T>> => {
            const before = await listSeriesFolderWitnesses(tx, folder, filePath);
            if (before.length === 0) return { kind: 'none' };
            const owner = uniqueOwner(before, library, folder, evidence.year);
            if (!owner)
                return {
                    kind: 'uncertain',
                    reason: 'folder witnesses have no unique valid series owner',
                    // Multiple otherwise valid owners can occur during a bulk
                    // move. Invalid/missing/cross-library witnesses cannot be
                    // repaired by waiting for a lock holder to commit.
                    retryable:
                        before.length <= 1000 &&
                        before.every(
                            (row) =>
                                row.series_id !== null &&
                                row.valid_hierarchy &&
                                !row.is_missing &&
                                row.file_library === library.library_group_id &&
                                row.series_library === library.library_group_id &&
                                (evidence.year === undefined ||
                                    row.series_year === evidence.year) &&
                                seriesDirectory(row.file_path, library.path) === folder,
                        ),
                };
            if (!(await tryLockSeriesFolderWitnesses(tx, before)))
                return {
                    kind: 'uncertain',
                    reason: 'folder witness lock is contended',
                    contention: true,
                    retryable: true,
                };
            const current = await listSeriesFolderWitnesses(tx, folder, filePath);
            // A file gained/lost links while we chose locks: do not use a new,
            // unlocked witness, even if it currently names the same series.
            if (
                JSON.stringify(current) !== JSON.stringify(before) ||
                uniqueOwner(current, library, folder, evidence.year) !== owner
            )
                return {
                    kind: 'uncertain',
                    reason: 'folder witnesses changed while acquiring locks',
                    contention: true,
                    retryable: true,
                };
            const ids = await listSeriesFolderOwnerIds(tx, owner);
            for (const [provider, id] of [
                ['imdb', evidence.imdbId],
                ['tmdb', evidence.tmdbId],
            ]) {
                // A personal series established by an earlier sibling has no
                // provider identity yet. An unresolved folder tag cannot
                // contradict that absence, nor may it become a stored ID.
                // An identified owner still requires positive agreement.
                if (
                    id &&
                    ids.length > 0 &&
                    !ids.some((entry) => entry.provider === provider && entry.external_id === id)
                )
                    return {
                        kind: 'uncertain',
                        reason: 'folder owner conflicts with explicit provider identity',
                        retryable: false,
                    };
            }
            for (const file of new Set(current.map((r) => r.file_path))) {
                const presence = await assessFilePresence(file, { mountRoot: library.path });
                if (presence !== 'present')
                    return {
                        kind: 'uncertain',
                        reason: 'folder witness file is not present',
                        retryable: presence === 'transient',
                    };
            }
            // The callback can discover a fileless canonical episode not in
            // the witness set. An editor may hold its item lock while waiting
            // for our ancestor locks, so bound ALL remaining lock waits too.
            // Preserve a caller's shorter limit and restore it on success;
            // rollback/savepoint rollback restores it on every failure.
            const [timeout] = await tx<{ previous: string; timeout_ms: number }[]>`
                SELECT current_setting('lock_timeout') AS previous, setting::int AS timeout_ms
                FROM pg_settings WHERE name = 'lock_timeout'
            `;
            const limit = timeout.timeout_ms > 0 ? Math.min(timeout.timeout_ms, 250) : 250;
            await tx`SELECT set_config('lock_timeout', ${String(limit)}, true)`;
            const permittedRemovals = new Set<string>();
            const witnessKey = (row: SeriesFolderWitness): string =>
                JSON.stringify([row.file_id, row.episode_id]);
            // Only the hierarchy's guarded range arbitration reports actual
            // evictions. Restrict its report to the exact locked, automatic,
            // unsegmented witness pairs; no newly discovered row is permitted.
            const recordRangeLinkEvictions: RecordRangeLinkEvictions = (episodeId, paths) => {
                const evictedPaths = new Set(paths);
                for (const row of current) {
                    if (
                        row.episode_id === episodeId &&
                        evictedPaths.has(row.file_path) &&
                        row.offset_source === null &&
                        row.start_offset_ms === null &&
                        row.end_offset_ms === null
                    ) {
                        permittedRemovals.add(witnessKey(row));
                    }
                }
            };
            const value = await attach(tx, owner, recordRangeLinkEvictions);
            // Include our own new link, and detect a rival NEW file/owner that
            // committed while the callback attached. Throw to roll back every
            // hierarchy/file/link write of this attempt, not just its verdict.
            const finalRows = await listSeriesFolderWitnesses(tx, folder);
            if (
                uniqueOwner(finalRows, library, folder, evidence.year) !== owner ||
                JSON.stringify(finalRows.filter((row) => row.file_path !== filePath)) !==
                    JSON.stringify(current.filter((row) => !permittedRemovals.has(witnessKey(row))))
            )
                throw new SeriesFolderOwnershipChangedError();
            if (
                finalRows.some((row) => row.file_path === filePath) &&
                (await assessFilePresence(filePath, { mountRoot: library.path })) !== 'present'
            ) {
                throw new SeriesFolderOwnershipChangedError();
            }
            // This final observation is the decision point. Existing witnesses
            // stay locked until commit; unrelated later insertions are not
            // globally serialized by a folder-wide writer protocol.
            await tx`SELECT set_config('lock_timeout', ${timeout.previous}, true)`;
            return { kind: 'reused', value };
        });
    } catch (error) {
        if (
            error instanceof SeriesFolderOwnershipChangedError ||
            (error as { code?: string }).code === '55P03'
        )
            return {
                kind: 'uncertain',
                retryable: true,
                contention: true,
                reason:
                    error instanceof SeriesFolderOwnershipChangedError
                        ? 'folder ownership changed during attachment'
                        : 'folder ownership validation or attachment lock is contended',
            };
        throw error;
    }
}
