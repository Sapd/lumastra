// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One physical file reached under two names.
 *
 * Before the scan processes its new files, each one is checked against the
 * files the library already has, by device + inode + size:
 *
 * - **Case-only rename on a case-insensitive share** (SMB, macOS). The listing
 *   shows `Night Film.mkv`; the row says `night film.mkv`, which still stats
 *   as present, so stale cleanup never removed it and the new spelling became
 *   a second row (a second version, or a second movie). When a new path equals
 *   a known path that the walk no longer lists, ignoring case, and both are
 *   the same file, the row is renamed in place: item, watch history and
 *   everything keyed by the file id stay.
 * - **Hard link or symlink** to a file the library already has (stat follows
 *   a symlink), or two new names for one file in the same scan: only the first
 *   name is ingested; the others are skipped.
 *
 * Files that merely have the same content are different files (different
 * inodes) and are untouched. A shared inode number alone is not trusted (see
 * resolveSameFileAliases).
 *
 * The watcher / delta single-file path (`ingestSingleFile`) applies the same
 * rules through {@link resolveSingleFileAlias}, without a walk listing: it
 * looks the candidates up in the database.
 */

import type postgres from 'postgres';
import { safeLstat, safeStat } from '$lib/server/utils/safe-fs.js';
import { fileIdentityKey } from './shared.js';
import { withTx } from '../../../../../../database/with-tx.js';

export interface SameFileAliasResult {
    /** New files to process, in their original order. */
    process: string[];
    /** New paths skipped because they name a file the scan already has. */
    skipped: Array<{ path: string; sameAs: string }>;
    /** Known rows whose path changed only in case: renamed in place. */
    caseRenames: Array<{ from: string; to: string }>;
}

interface PathIdentity {
    id: string | null;
    /** More than one directory entry names this inode (a hard link exists). */
    linked: boolean;
    /** The path itself is a symlink. */
    symlink: boolean;
    /** Size of the file (of a symlink's target). */
    size: number;
}

async function identityOf(p: string): Promise<PathIdentity> {
    try {
        const [st, lst] = await Promise.all([safeStat(p), safeLstat(p)]);
        return {
            id: fileIdentityKey(st),
            linked: st.nlink > 1,
            symlink: lst.isSymbolicLink(),
            size: st.size,
        };
    } catch {
        return { id: null, linked: false, symlink: false, size: 0 };
    }
}

async function isSymlink(p: string): Promise<boolean> {
    try {
        return (await safeLstat(p)).isSymbolicLink();
    } catch {
        return false;
    }
}

/** Case- and Unicode-normalisation-insensitive key, as SMB and macOS compare names. */
function foldedPath(p: string): string {
    return p.normalize('NFC').toLowerCase();
}

/**
 * `filePath` with the case of every letter in its file name swapped, or null
 * when the name has no letter whose case can change. If that name stats to the
 * same file, the directory compares names case-insensitively.
 */
export function swapCaseProbeName(filePath: string): string | null {
    const slash = filePath.lastIndexOf('/');
    const name = filePath.slice(slash + 1);
    let swapped = '';
    for (const ch of name) {
        const upper = ch.toUpperCase();
        const candidate = ch === upper ? ch.toLowerCase() : upper;
        // Expanding folds (ß → SS, İ → i + dot) are different names. Keep
        // those characters and still probe the other letters in the basename.
        swapped += candidate.length === ch.length ? candidate : ch;
    }
    if (swapped === name) return null;
    return filePath.slice(0, slash + 1) + swapped;
}

/** Stats in flight at once: one round trip each on NFS/SMB, so never serial. */
const STAT_WIDTH = 32;

/**
 * Decide which new files are other names for files the scan already has.
 * Read-only: the caller applies `caseRenames` (see {@link renameFileRowInPlace}).
 *
 * Equal identity alone is not trusted: some network and FUSE filesystems hand
 * out synthetic or reused inode numbers. A new path counts as another name for
 * a file only when the inode really has several names (`nlink > 1`), one of
 * the two paths is a symlink, or the names differ only in case.
 *
 * @param knownFileIds identity → path of known files the walk listed (triage)
 * @param knownNotWalked known paths the walk did not list (case-rename sources)
 */
export async function resolveSameFileAliases(params: {
    newFiles: readonly string[];
    knownFileIds: ReadonlyMap<string, string>;
    knownNotWalked: readonly string[];
    isAborted?: () => boolean;
}): Promise<SameFileAliasResult> {
    const result: SameFileAliasResult = { process: [], skipped: [], caseRenames: [] };
    if (params.newFiles.length === 0) return result;

    const identities = new Map<string, PathIdentity>();
    for (let i = 0; i < params.newFiles.length; i += STAT_WIDTH) {
        if (params.isAborted?.()) break;
        const batch = params.newFiles.slice(i, i + STAT_WIDTH);
        const ids = await Promise.all(batch.map(identityOf));
        batch.forEach((p, j) => identities.set(p, ids[j]));
    }

    const byFoldedPath = new Map<string, string[]>();
    for (const p of params.knownNotWalked) {
        const key = foldedPath(p);
        const list = byFoldedPath.get(key);
        if (list) list.push(p);
        else byFoldedPath.set(key, [p]);
    }

    const seen = new Map<string, string>(params.knownFileIds);
    for (const p of params.newFiles) {
        const ident = identities.get(p);
        if (!ident || ident.id === null) {
            result.process.push(p);
            continue;
        }
        let caseVariant: string | null = null;
        for (const old of byFoldedPath.get(foldedPath(p)) ?? []) {
            if (old !== p && (await identityOf(old)).id === ident.id) {
                caseVariant = old;
                break;
            }
        }
        if (caseVariant !== null) {
            result.caseRenames.push({ from: caseVariant, to: p });
            seen.set(ident.id, p);
            continue;
        }
        const sameAs = seen.get(ident.id);
        const sameAsIsLink = sameAs !== undefined && (await isSymlink(sameAs));
        if (sameAs !== undefined && (ident.linked || ident.symlink || sameAsIsLink)) {
            // Keep the real file, not a symlink to it, when both are new.
            const earlier = result.process.indexOf(sameAs);
            if (sameAsIsLink && !ident.symlink && earlier >= 0) {
                result.process[earlier] = p;
                seen.set(ident.id, p);
                result.skipped.push({ path: sameAs, sameAs: p });
                continue;
            }
            result.skipped.push({ path: p, sameAs });
            continue;
        }
        if (sameAs === undefined) seen.set(ident.id, p);
        result.process.push(p);
    }
    return result;
}

/**
 * Move a media_files row to a new path (a case-only rename). No-op, returning
 * false, when a row for the new path already exists.
 */
export async function renameFileRowInPlace(
    sql: postgres.Sql,
    from: string,
    to: string,
): Promise<boolean> {
    return withTx(sql, async (txRaw): Promise<boolean> => {
        const tx = txRaw as unknown as postgres.Sql;
        const rows = await tx`
            UPDATE media_files SET file_path = ${to}, updated_at = NOW()
             WHERE file_path = ${from}
               AND NOT EXISTS (SELECT 1 FROM media_files WHERE file_path = ${to})
        `;
        if (rows.count === 0) return false;
        await tx`UPDATE media_items SET file_path = ${to} WHERE file_path = ${from}`;
        return true;
    });
}

export type SingleFileAlias =
    | { kind: 'none' }
    /** A known row whose path differs only in case: rename it in place. */
    | { kind: 'caseRename'; from: string }
    /** Another name (hard link, symlink) for a linked file the library has. */
    | { kind: 'alias'; sameAs: string };

/** Same-size rows inspected at most; sizes of media files are close to unique. */
const SIZE_CANDIDATE_LIMIT = 50;

function likePrefix(root: string): string {
    const escaped = root.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    return (escaped.endsWith('/') ? escaped : escaped + '/') + '%';
}

/**
 * {@link resolveSameFileAliases} for one path the watcher or the delta ingest
 * is about to ingest. A path the library already has a row for is `none`.
 *
 * - Case-only rename: only when the directory compares names
 *   case-insensitively (the swapped-case name stats to the same file, see
 *   {@link swapCaseProbeName}), a known row under `libraryRoot` whose path
 *   folds to the same name and still stats to this file is `caseRename`. The
 *   watcher drops the old name's unlink as a phantom (it still stats), so
 *   without this the new name became a second row.
 * - Hard link / symlink: a linked row of the same size (indexed, 16.408.0)
 *   that is the same file is `alias`, under the same rule as the full scan:
 *   the inode has several names, or one of the two paths is a symlink.
 */
export async function resolveSingleFileAlias(
    sql: postgres.Sql,
    absPath: string,
    libraryRoot: string,
): Promise<SingleFileAlias> {
    const [known] = await sql`SELECT 1 FROM media_files WHERE file_path = ${absPath} LIMIT 1`;
    if (known) return { kind: 'none' };
    const ident = await identityOf(absPath);
    if (ident.id === null) return { kind: 'none' };
    const prefix = likePrefix(libraryRoot);

    const probe = swapCaseProbeName(absPath);
    if (probe !== null && (await identityOf(probe)).id === ident.id) {
        // The file's own folder first (an indexed range of a few rows): a
        // renamed file. Only a folder the library knows no file in may itself
        // have been renamed, and only then is the whole library searched.
        const dirPrefix = likePrefix(absPath.slice(0, absPath.lastIndexOf('/')));
        let rows = await sql<{ file_path: string }[]>`
            SELECT file_path FROM media_files
             WHERE file_path LIKE ${dirPrefix} ESCAPE '\\'
        `;
        if (rows.length === 0) {
            rows = await sql<{ file_path: string }[]>`
                SELECT file_path FROM media_files
                 WHERE file_path LIKE ${prefix} ESCAPE '\\'
                   AND lower(normalize(file_path, NFC)) = lower(normalize(${absPath}, NFC))
            `;
        }
        for (const { file_path: other } of rows) {
            if (other === absPath) continue;
            if (foldedPath(other) !== foldedPath(absPath)) continue;
            if ((await identityOf(other)).id === ident.id) {
                return { kind: 'caseRename', from: other };
            }
        }
    }

    const rows = await sql<{ file_path: string }[]>`
        SELECT mf.file_path FROM media_files mf
         WHERE mf.file_size_bytes = ${ident.size}
           AND mf.file_path LIKE ${prefix} ESCAPE '\\'
           AND mf.file_path <> ${absPath}
           AND EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id)
         LIMIT ${SIZE_CANDIDATE_LIMIT}
    `;
    for (const { file_path: other } of rows) {
        const otherIdent = await identityOf(other);
        if (otherIdent.id !== ident.id) continue;
        if (ident.linked || ident.symlink || otherIdent.symlink) {
            return { kind: 'alias', sameAs: other };
        }
    }
    return { kind: 'none' };
}
