// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Strict path containment for DOWNLOADS of library files.
 *
 * Playback keeps the permissive {@link resolveContainedMediaFile}: a cataloged symlink may
 * lead outside the library (debrid / rclone mounts) as long as it avoids a sensitive prefix.
 * A download hands the bytes to the caller as a file, so a symlink planted in a library
 * folder must not turn it into "read any file the server can read": the CANONICAL target
 * has to lie inside a canonical library root (or an explicitly trusted extra root).
 *
 * Mounts outside the library (debrid / rclone) are listed in the setting
 * DOWNLOAD_ALLOWED_MOUNT_ROOTS; callers pass it as `extraRoots`.
 *
 * The returned path is the canonical one: open THAT (O_NOFOLLOW, as
 * `createNoFollowReadStream` does), never the original, so a link swapped in between this
 * check and the open cannot redirect the read.
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Sql } from 'postgres';
import { getLibraryRootPaths } from './media-path-resolver.js';
import { isWithinRoot } from './contained-fs.js';
import { safeRealpath } from './safe-fs.js';
import { Logger } from './logger.js';

const logger = Logger.for('DownloadPath');

const WARN_EVERY_MS = 60 * 60_000;
const warnedAt = new Map<string, number>();

/** Test hook. */
export function resetDownloadPathWarningsForTests(): void {
    warnedAt.clear();
}

/** Warn once per (item, hour); the hint names the setting. The HTTP response never carries the path. */
function warnOutsideRoots(itemKey: string, filePath: string, target: string): void {
    const now = Date.now();
    if (warnedAt.size > 1_000) {
        for (const [k, at] of warnedAt) if (now - at >= WARN_EVERY_MS) warnedAt.delete(k);
    }
    const last = warnedAt.get(itemKey);
    if (last !== undefined && now - last < WARN_EVERY_MS) return;
    warnedAt.set(itemKey, now);
    logger.warn(
        'download refused: the file resolves outside the library folders. If it lives on a ' +
            'debrid/rclone mount, add that mount folder to the setting "Extra download folders" ' +
            '(DOWNLOAD_ALLOWED_MOUNT_ROOTS).',
        { item: itemKey, path: filePath, target },
    );
}

/** Pure core: the canonical path of `filePath` when it is a regular file inside one of `roots`, else null. */
export async function resolveDownloadablePathIn(
    filePath: string,
    roots: readonly string[],
    itemKey = filePath,
): Promise<string | null> {
    let real: string;
    try {
        real = await safeRealpath(filePath);
    } catch {
        return null;
    }
    const canonicalRoots: string[] = [];
    for (const root of roots.map((r) => r.trim()).filter(Boolean)) {
        try {
            canonicalRoots.push(await safeRealpath(root));
        } catch {
            // an unmounted root cannot contain anything canonical
            canonicalRoots.push(resolve(root));
        }
    }
    if (!canonicalRoots.some((r) => isWithinRoot(real, r))) {
        warnOutsideRoots(itemKey, filePath, real);
        return null;
    }
    try {
        return (await stat(real)).isFile() ? real : null;
    } catch {
        return null;
    }
}

/**
 * {@link resolveDownloadablePathIn} against the enabled library roots (container and
 * provider side). No roots configured: refused (fail closed).
 */
export async function resolveDownloadablePath(
    sql: Sql,
    filePath: string,
    extraRoots: readonly string[] = [],
    itemKey?: string,
): Promise<string | null> {
    const roots = [...(await getLibraryRootPaths(sql)), ...extraRoots];
    if (roots.length === 0) return null;
    return resolveDownloadablePathIn(filePath, roots, itemKey);
}
