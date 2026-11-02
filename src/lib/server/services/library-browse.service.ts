// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Folder picker backend for `GET /api/admin/library/browse`.
 *
 * Lists SUBDIRECTORIES of a path, never files, confined to a fixed set of
 * "allowed roots": the setup wizard's well-known mount points
 * ({@link LIBRARY_MOUNT_ROOTS}) plus the parent directory of every existing
 * filesystem-backed library folder (so an operator adding a sibling folder to
 * an already-configured library can browse there even if it isn't under one
 * of the fixed roots).
 *
 * `listBrowseEntries` is the pure, security-relevant core: given a requested
 * path and the resolved set of allowed roots, it does the realpath resolution
 * and root-confinement check and nothing else. It takes `allowedRoots` as a
 * plain argument (rather than reaching for {@link getAllowedBrowseRoots}
 * itself) so integration tests can point it at a tmp directory instead of the
 * real `/data`-style roots.
 */

import { basename, join, resolve as resolvePath } from 'node:path';
import type postgres from 'postgres';
import { safeReaddir, safeRealpath, safeStat } from '$lib/server/utils/safe-fs.js';
import { LIBRARY_MOUNT_ROOTS } from '$lib/server/utils/library-mount-roots.js';
import {
    configuredLibraryRoots,
    isWithinAllowedLibraryRoots,
} from '$lib/server/services/library-root-validation.js';
import {
    getAllLibraryPaths,
    FILESYSTEM_LIBRARY_PROVIDERS,
} from '$lib/server/database/queries/library-paths.queries.js';

/** Per-directory cap on the reported subdirectory count — display only. */
export const BROWSE_CHILD_COUNT_CAP = 1000;

export interface BrowseEntry {
    name: string;
    path: string;
    readable: boolean;
    /** Subdirectory count, capped at {@link BROWSE_CHILD_COUNT_CAP}; null when unreadable. */
    childCount: number | null;
}

export type BrowseResult =
    | { ok: true; path: string | null; entries: BrowseEntry[] }
    | { ok: false; status: 400 | 403; message: string };

/** `child` is `root` itself, or a real descendant of it (never a same-prefix sibling). */
function isPathUnderRoot(child: string, root: string): boolean {
    if (child === root) return true;
    const withSep = root.endsWith('/') ? root : `${root}/`;
    return child.startsWith(withSep);
}

/** Count immediate subdirectories, capped. Returns null on any read failure. */
async function countSubdirs(path: string): Promise<number | null> {
    try {
        const dirents = await safeReaddir(path);
        let count = 0;
        for (const d of dirents) {
            if (!d.isDirectory()) continue;
            count += 1;
            if (count >= BROWSE_CHILD_COUNT_CAP) return BROWSE_CHILD_COUNT_CAP;
        }
        return count;
    } catch {
        return null;
    }
}

/**
 * Resolve every allowed root to its realpath, dropping roots that don't exist
 * or can't be resolved. Confinement checks compare against REALPATHS on both
 * sides so a root that is itself a symlink still confines correctly.
 */
async function resolveRoots(allowedRoots: readonly string[]): Promise<string[]> {
    const resolved = await Promise.all(
        allowedRoots.map(async (root) => {
            try {
                return await safeRealpath(root);
            } catch {
                return null;
            }
        }),
    );
    return resolved.filter((r): r is string => r !== null);
}

/**
 * The fixed setup-wizard roots plus the parent directory of every existing
 * filesystem-backed library folder (remote-provider rows, whose `path` is a
 * synthetic URI, are excluded — `dirname()` on one produces nonsense).
 */
export async function getAllowedBrowseRoots(sql: postgres.Sql): Promise<string[]> {
    const paths = await getAllLibraryPaths(sql);
    const filesystemProviders = new Set<string>(FILESYSTEM_LIBRARY_PROVIDERS);
    const parents = new Set<string>();
    for (const p of paths) {
        if (!filesystemProviders.has(p.provider)) continue;
        // `path` is already an absolute, normalized filesystem path for every
        // filesystem-backed row — `dirname` needs no node:path import beyond
        // what's already here since we only need the last-segment strip.
        const idx = p.path.lastIndexOf('/');
        // A folder directly under `/` (e.g. `/movies`) contributes ITSELF, never
        // `/`: the parent rule would otherwise make the whole filesystem
        // browsable from the admin UI.
        const parent = idx > 0 ? p.path.slice(0, idx) : p.path;
        // A legacy row of `/` itself (created before folder validation) must
        // not open the whole filesystem either.
        if (parent && parent !== '/') parents.add(parent);
    }
    // An operator allow-list replaces the built-in container roots, and the
    // parent rule may not reach outside it.
    const allowList = configuredLibraryRoots();
    if (allowList.length > 0) {
        const inside: string[] = [];
        for (const parent of parents) {
            if (await isWithinAllowedLibraryRoots(parent)) inside.push(parent);
        }
        return [...new Set([...allowList, ...inside])];
    }
    return [...new Set([...LIBRARY_MOUNT_ROOTS, ...parents])];
}

/**
 * List subdirectories of `requestedPath`, or — when it is omitted — the
 * allowed roots that currently exist.
 *
 * Security model: `requestedPath` is realpath-resolved and MUST land under one
 * of `allowedRoots` (also realpath-resolved), or the call is rejected with 403
 * and no further detail (no existence leak beyond "not allowed"). A relative
 * path, or one that fails to resolve at all (`..` escapes are collapsed by
 * `realpath` itself, so they either resolve to somewhere real — checked below
 * — or fail to resolve), is rejected with 400.
 */
export async function listBrowseEntries(
    requestedPath: string | undefined,
    allowedRoots: readonly string[],
): Promise<BrowseResult> {
    if (requestedPath === undefined || requestedPath === '') {
        const entries: BrowseEntry[] = [];
        for (const root of allowedRoots) {
            let stat;
            try {
                stat = await safeStat(root);
            } catch {
                continue; // root doesn't exist / unreadable — omit, not an error
            }
            if (!stat.isDirectory()) continue;
            entries.push({
                name: basename(root) || root,
                path: root,
                readable: true,
                childCount: await countSubdirs(root),
            });
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        return { ok: true, path: null, entries };
    }

    if (!requestedPath.startsWith('/')) {
        return { ok: false, status: 400, message: 'path must be an absolute path' };
    }

    // Lexical confinement FIRST, before touching the filesystem: otherwise a
    // missing path outside the roots (400 "does not exist") and an existing one
    // (403) answer differently, and the endpoint becomes an existence probe for
    // arbitrary paths. The realpath check below still catches symlink escapes.
    const lexical = resolvePath(requestedPath);
    if (!allowedRoots.some((root) => isPathUnderRoot(lexical, resolvePath(root)))) {
        return {
            ok: false,
            status: 403,
            message: 'path is outside the allowed library mount roots',
        };
    }

    let resolved: string;
    try {
        resolved = await safeRealpath(requestedPath);
    } catch {
        return { ok: false, status: 400, message: 'path does not exist or is not readable' };
    }

    const resolvedRoots = await resolveRoots(allowedRoots);
    if (!resolvedRoots.some((root) => isPathUnderRoot(resolved, root))) {
        return {
            ok: false,
            status: 403,
            message: 'path is outside the allowed library mount roots',
        };
    }

    let stat;
    try {
        stat = await safeStat(resolved);
    } catch {
        return { ok: false, status: 400, message: 'path does not exist or is not readable' };
    }
    if (!stat.isDirectory()) {
        return { ok: false, status: 400, message: 'path is not a directory' };
    }

    let dirents;
    try {
        dirents = await safeReaddir(resolved);
    } catch {
        return { ok: false, status: 400, message: 'could not list this directory' };
    }

    const entries: BrowseEntry[] = [];
    for (const dirent of dirents) {
        const childPath = join(resolved, dirent.name);

        if (dirent.isDirectory()) {
            entries.push({
                name: dirent.name,
                path: childPath,
                readable: true,
                childCount: await countSubdirs(childPath),
            });
            continue;
        }

        if (!dirent.isSymbolicLink()) continue; // never list files

        // Symlinked dirs: include only if their realpath is ALSO under an
        // allowed root — otherwise a symlink is a ready-made root escape.
        let real: string;
        try {
            real = await safeRealpath(childPath);
        } catch {
            continue; // broken symlink
        }
        let targetStat;
        try {
            targetStat = await safeStat(childPath); // follows the symlink
        } catch {
            continue;
        }
        if (!targetStat.isDirectory()) continue;
        if (!resolvedRoots.some((root) => isPathUnderRoot(real, root))) continue;

        entries.push({
            name: dirent.name,
            path: childPath,
            readable: true,
            childCount: await countSubdirs(childPath),
        });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, path: resolved, entries };
}
