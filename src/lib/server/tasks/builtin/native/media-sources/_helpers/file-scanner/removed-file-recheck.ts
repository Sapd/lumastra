// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a removed file leaves behind for its other names.
 *
 * A rename done as `link(O, N); unlink(O)` (Sonarr, Radarr, some tools) is seen
 * by the watcher or the delta ingest as "add N" first. O still exists and is
 * linked, so N is skipped as another name of O ({@link ingestSingleFile}). Once
 * O is removed, N is no longer an alias and must be ingested. Two things find
 * N again:
 *
 * - the removed file's folder: a regular media file there with no row, of the
 *   removed file's size;
 * - the names skipped for it in this process (a rename into another folder).
 *
 * Kept apart from same-file-aliases.ts so the watcher can import it without
 * pulling in the shared scanner module (and through it the task registry).
 */

import type postgres from 'postgres';
import { dirname, extname, join } from 'node:path';
import { safeReaddir, safeStat } from '$lib/server/utils/safe-fs.js';
import { isAudioFile, MEDIA_EXTENSIONS } from '$lib/server/utils/media-file-kinds.js';

/** Skipped-alias entries kept in this process (per file they named). */
const SKIPPED_ALIAS_LIMIT = 1000;
/** Skipped names remembered per file. */
const SKIPPED_ALIASES_PER_FILE = 50;
/**
 * Files {@link resolveSingleFileAlias} skipped as another name, keyed by the
 * file they name. A rename into another folder is a hard link there too; when
 * the original goes, its folder holds no other name to find, so the skipped
 * ones are remembered here. Oldest keys are dropped first.
 */
const skippedAliases = new Map<string, Set<string>>();

/** Remember that `aliasPath` was skipped as another name for `sameAs`. */
export function rememberSkippedAlias(sameAs: string, aliasPath: string): void {
    const names = skippedAliases.get(sameAs) ?? new Set<string>();
    skippedAliases.delete(sameAs);
    if (names.size < SKIPPED_ALIASES_PER_FILE) names.add(aliasPath);
    skippedAliases.set(sameAs, names);
    while (skippedAliases.size > SKIPPED_ALIAS_LIMIT) {
        const oldest = skippedAliases.keys().next().value;
        if (oldest === undefined) break;
        skippedAliases.delete(oldest);
    }
}

/** The names skipped for `sameAs` so far; forgotten once taken. */
export function takeSkippedAliases(sameAs: string): string[] {
    const names = skippedAliases.get(sameAs);
    if (!names) return [];
    skippedAliases.delete(sameAs);
    return [...names];
}

/**
 * Other names a removed file may have left unlinked: the media files of its
 * folder, plus the names skipped for it, that have no row and stat to the
 * removed file's size. Once the removed row is gone, one of them is no longer
 * an alias and must be ingested. Read-only; the caller ingests the result.
 *
 * Dedupe is the caller's concern: the result is unique by construction.
 */
export async function findUnlinkedSameSizeNames(
    sql: postgres.Sql,
    removedPath: string,
    removedSizeBytes: number,
    skippedNames: readonly string[],
): Promise<string[]> {
    const folder = dirname(removedPath);
    let entries: string[] = [];
    try {
        entries = (await safeReaddir(folder)).map((d) => d.name);
    } catch {
        // A folder that cannot be listed is handled by the next full scan.
    }
    const candidates = new Set<string>(skippedNames);
    for (const name of entries) {
        const ext = extname(name).toLowerCase();
        if (!MEDIA_EXTENSIONS.has(ext) && !isAudioFile(ext)) continue;
        candidates.add(join(folder, name));
    }
    candidates.delete(removedPath);
    if (candidates.size === 0) return [];

    const list = [...candidates];
    const known = await sql<{ file_path: string }[]>`
        SELECT file_path FROM media_files WHERE file_path = ANY(${list}::text[])
    `;
    const knownPaths = new Set(known.map((r) => r.file_path));
    const out: string[] = [];
    for (const p of list) {
        if (knownPaths.has(p)) continue;
        const st = await safeStat(p).catch(() => null);
        if (st?.isFile() && st.size === removedSizeBytes) out.push(p);
    }
    return out;
}
