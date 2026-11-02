// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Server-side rules for a filesystem library folder, shared by every path that
 * creates or re-points one (admin + v1 library-paths, the library wizard, the
 * first-run setup). Before this, `path` was any non-empty string.
 *
 * Why it matters beyond a bad scan: the file-read sandbox
 * (`isPathWithinLibraryRoots`) is built FROM the library folders, so a folder
 * of `/` switched the sandbox off for playback, downloads and images, and the
 * folder browser lists the parent of every folder.
 *
 * Rules, in order:
 *  1. absolute, no control characters, no `.`/`..` segments;
 *  2. not the filesystem root;
 *  3. it exists and resolves (realpath) — a folder that does not exist cannot
 *     be scanned, and this is what `validate-path` already told the UI;
 *  4. under `LIBRARY_ALLOWED_ROOTS` when the operator set it (realpaths on both
 *     sides); unset = no allow-list, for bare-metal installs;
 *  5. not the same folder as, inside, or around another filesystem library
 *     folder (compared lexically AND by realpath): overlapping folders put the
 *     same files in two libraries and two access groups.
 *
 * Existing rows are not re-validated; only creates and path changes are.
 */

import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    getAllLibraryPaths,
    normalizeLibraryPath,
} from '$lib/server/database/queries/library-paths.queries.js';
import { hasControlChars } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/filename-safety.js';

export type LibraryRootRejection =
    | 'not-absolute'
    | 'invalid'
    | 'filesystem-root'
    | 'not-found'
    | 'not-accessible'
    | 'outside-allowed-roots'
    | 'duplicate'
    | 'overlaps';

export class LibraryRootRejectedError extends Error {
    constructor(
        readonly reason: LibraryRootRejection,
        message: string,
    ) {
        super(message);
        this.name = 'LibraryRootRejectedError';
    }
}

function isWithin(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);
}

async function tryRealpath(p: string): Promise<string | null> {
    try {
        return await realpath(p);
    } catch {
        return null;
    }
}

/** Operator allow-list (deployment env, comma-separated absolute paths). */
function allowedRoots(): string[] {
    return config.LIBRARY_ALLOWED_ROOTS.split(',')
        .map((r) => r.trim())
        .filter((r) => r.startsWith('/'))
        .map((r) => normalizeLibraryPath(r));
}

/**
 * Validates `rawPath` as a filesystem library folder and returns the
 * normalized path to store. Throws {@link LibraryRootRejectedError}.
 *
 * @param excludeId the row being edited, so it does not collide with itself.
 */
export async function assertLibraryRootAllowed(
    sql: postgres.Sql,
    rawPath: string,
    opts: { excludeId?: string } = {},
): Promise<string> {
    const trimmed = rawPath.trim();
    if (!trimmed.startsWith('/')) {
        throw new LibraryRootRejectedError(
            'not-absolute',
            `"${trimmed}" is not an absolute path. Use the full path as the server sees it, e.g. /data/movies.`,
        );
    }
    if (hasControlChars(trimmed) || trimmed.split('/').some((s) => s === '.' || s === '..')) {
        throw new LibraryRootRejectedError('invalid', `"${trimmed}" is not a valid folder path.`);
    }
    const normalized = normalizeLibraryPath(trimmed);
    if (normalized === '' || normalized === '/' || posix.normalize(normalized) === '/') {
        throw new LibraryRootRejectedError(
            'filesystem-root',
            'The filesystem root cannot be a library folder. Pick the folder that holds your media.',
        );
    }

    let real: string;
    try {
        real = await realpath(normalized);
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw new LibraryRootRejectedError(
                'not-found',
                `Folder "${normalized}" was not found. Check the path and that it is mounted into the container.`,
            );
        }
        throw new LibraryRootRejectedError(
            'not-accessible',
            `Folder "${normalized}" cannot be accessed by the server (${code ?? 'error'}).`,
        );
    }
    if (real === '/') {
        throw new LibraryRootRejectedError(
            'filesystem-root',
            `"${normalized}" points at the filesystem root and cannot be a library folder.`,
        );
    }

    const roots = allowedRoots();
    if (roots.length > 0) {
        const realRoots = (await Promise.all(roots.map(tryRealpath))).filter(
            (r): r is string => r !== null,
        );
        if (!realRoots.some((root) => isWithin(real, root))) {
            throw new LibraryRootRejectedError(
                'outside-allowed-roots',
                `"${normalized}" is outside the folders this server allows for libraries (LIBRARY_ALLOWED_ROOTS).`,
            );
        }
    }

    const existing = (await getAllLibraryPaths(sql)).filter(
        (row) => row.id !== opts.excludeId && row.path.startsWith('/'),
    );
    for (const row of existing) {
        const other = normalizeLibraryPath(row.path);
        const otherReal = (await tryRealpath(other)) ?? other;
        if (other === normalized || otherReal === real) {
            throw new LibraryRootRejectedError(
                'duplicate',
                `"${normalized}" is already a library folder${row.path !== normalized ? ` (as "${row.path}")` : ''}.`,
            );
        }
        const nested =
            isWithin(normalized, other) ||
            isWithin(other, normalized) ||
            isWithin(real, otherReal) ||
            isWithin(otherReal, real);
        if (nested) {
            throw new LibraryRootRejectedError(
                'overlaps',
                `"${normalized}" overlaps the library folder "${row.path}". Library folders cannot contain one another.`,
            );
        }
    }

    return normalized;
}

/**
 * Runs {@link assertLibraryRootAllowed} and maps a rejection to the API
 * problem (409 for a duplicate/overlap, 422 otherwise). Any other error is
 * rethrown.
 */
export async function checkLibraryRootForApi(
    sql: postgres.Sql,
    rawPath: string,
    opts: { excludeId?: string } = {},
): Promise<{ path: string } | { problem: Response }> {
    try {
        return { path: await assertLibraryRootAllowed(sql, rawPath, opts) };
    } catch (err) {
        if (!(err instanceof LibraryRootRejectedError)) throw err;
        return {
            problem:
                err.reason === 'duplicate' || err.reason === 'overlaps'
                    ? ApiProblem.conflict(err.message)
                    : ApiProblem.validationFailed(err.message),
        };
    }
}

/**
 * True when no allow-list is configured, or `absPath` resolves (or, when it
 * does not exist, lexically sits) under one of `LIBRARY_ALLOWED_ROOTS`. Used
 * by the folder browser and the folder check so they cannot probe or list
 * outside the folders libraries may live in.
 */
export async function isWithinAllowedLibraryRoots(absPath: string): Promise<boolean> {
    const roots = allowedRoots();
    if (roots.length === 0) return true;
    const target = (await tryRealpath(absPath)) ?? normalizeLibraryPath(absPath);
    for (const root of roots) {
        const realRoot = (await tryRealpath(root)) ?? root;
        if (isWithin(target, realRoot)) return true;
    }
    return false;
}

/** The configured allow-list, normalized (empty when unset). */
export function configuredLibraryRoots(): string[] {
    return allowedRoots();
}
