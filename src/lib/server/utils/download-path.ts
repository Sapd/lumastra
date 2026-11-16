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

import { constants as fsConstants } from 'node:fs';
import { open, readlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Sql } from 'postgres';
import { getLibraryRootPaths } from './media-path-resolver.js';
import { isWithinRoot } from './contained-fs.js';
import { safeRealpath } from './safe-fs.js';
import type { OpenedFile } from './file-streaming.js';
import { Logger } from './logger.js';

const logger = Logger.for('DownloadPath');

const WARN_EVERY_MS = 60 * 60_000;
const warnedAt = new Map<string, number>();

/** Test hook. */
export function resetDownloadPathWarningsForTests(): void {
    warnedAt.clear();
}

/** One warning per hour for a server-wide condition. */
function warnOnce(key: string, message: string): void {
    const now = Date.now();
    const last = warnedAt.get(key);
    if (last !== undefined && now - last < WARN_EVERY_MS) return;
    warnedAt.set(key, now);
    logger.warn(message);
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

async function canonicalRootsOf(roots: readonly string[]): Promise<string[]> {
    const canonicalRoots: string[] = [];
    for (const root of roots.map((r) => r.trim()).filter(Boolean)) {
        try {
            canonicalRoots.push(await safeRealpath(root));
        } catch {
            // an unmounted root cannot contain anything canonical
            canonicalRoots.push(resolve(root));
        }
    }
    return canonicalRoots;
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
    const canonicalRoots = await canonicalRootsOf(roots);
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

export interface OpenHooks {
    /** Test seam: runs between the path check and the open, where a swap would land. */
    afterCheck?: () => Promise<void> | void;
    /** Test seam: reads `/proc/self/fd/<fd>`. */
    readFdLink?: (fd: number) => Promise<string>;
}

/** Dev server / tests: the racy realpath fallback is tolerated there. NODE_ENV only, so the sandbox bundle stays free of $app. */
const isDevEnvironment = (): boolean => process.env.NODE_ENV !== 'production';

/**
 * Check, then OPEN ONCE, then verify the descriptor: the file is opened O_NOFOLLOW on the
 * canonical path, `fstat`ed, and the descriptor's own real path (`/proc/self/fd/N`; elsewhere
 * the canonical path's realpath with a matching device and inode) must lie inside an allowed
 * root. The caller streams from THAT descriptor, so nothing resolves the path again and a
 * link or directory swapped in after the check cannot redirect the read. Null = refuse.
 */
export async function openDownloadableFileIn(
    filePath: string,
    roots: readonly string[],
    itemKey?: string,
    hooks: OpenHooks = {},
): Promise<OpenedFile | null> {
    const canonical = await resolveDownloadablePathIn(filePath, roots, itemKey);
    if (!canonical) return null;
    await hooks.afterCheck?.();
    let handle;
    try {
        handle = await open(
            canonical,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
    } catch {
        return null;
    }
    try {
        const st = await handle.stat();
        if (!st.isFile()) throw new Error('not a regular file');
        let real: string;
        try {
            real = await (hooks.readFdLink ?? ((fd) => readlink(`/proc/self/fd/${fd}`)))(handle.fd);
        } catch {
            // Without /proc/self/fd, open -> realpath -> stat is racy: fail closed in production.
            if (!isDevEnvironment()) {
                warnOnce(
                    'no-proc',
                    'downloads refused: /proc/self/fd is unavailable, so the opened file cannot be verified race-free (only the dev server tolerates that)',
                );
                throw new Error('no /proc/self/fd');
            }
            real = await safeRealpath(canonical);
            const again = await stat(real);
            if (again.ino !== st.ino || again.dev !== st.dev) throw new Error('inode changed');
        }
        const canonicalRoots = await canonicalRootsOf(roots);
        if (!canonicalRoots.some((r) => isWithinRoot(real, r))) {
            warnOutsideRoots(itemKey ?? filePath, filePath, real);
            throw new Error('descriptor outside the roots');
        }
        return {
            handle,
            size: st.size,
            mtimeMs: Number.isFinite(st.mtimeMs) ? st.mtimeMs : null,
        };
    } catch {
        await handle.close().catch(() => {});
        return null;
    }
}

/** {@link openDownloadableFileIn} against the enabled library roots plus `extraRoots`. */
export async function openDownloadableFile(
    sql: Sql,
    filePath: string,
    extraRoots: readonly string[] = [],
    itemKey?: string,
    hooks?: OpenHooks,
): Promise<OpenedFile | null> {
    const roots = [...(await getLibraryRootPaths(sql)), ...extraRoots];
    if (roots.length === 0) return null;
    return openDownloadableFileIn(filePath, roots, itemKey, hooks);
}
