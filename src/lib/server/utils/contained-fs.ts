// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Symlink-safe file access for library-derived paths.
 *
 * WHY THIS EXISTS
 * ---------------
 * Anyone who can create entries beside the media (NAS user, an archive
 * extracted by a post-processor) can plant a symlink named like a sidecar
 * (`Track.txt`, `0.jpg`, `poster.jpg`) that points at `/config/master.key` or
 * `/proc/self/environ`. Reads that follow it serve the target's bytes; writes
 * that follow it clobber the target.
 *
 *   - READ side: {@link resolveContainedFile} / {@link readContainedFile}. A
 *     regular file is used as is. A symlinked final component is followed only
 *     when its real target is a regular file inside an allowed root (a
 *     configured library root, the metadata store, or roots the caller passes).
 *   - WRITE side: {@link writeFileNoFollow}. Writes to a fresh temp name in the
 *     same directory and renames over the destination; rename replaces a
 *     symlink instead of following it.
 *
 * Every reader/writer of library-derived paths must go through these (enforced
 * by the source scan in contained-fs.test.ts).
 */

import { constants as fsConstants, type ReadStream } from 'node:fs';
import {
    lstat as fsLstat,
    open as fsOpen,
    realpath as fsRealpath,
    rename as fsRename,
    link as fsLink,
    unlink as fsUnlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { Logger } from './logger.js';
import { safeLstat, safeRealpath, safeStat, withFsGuard } from './safe-fs.js';

const logger = Logger.for('containedFs');

/** Default cap for sidecar reads (lyrics, manifests, ignore files, sprite sheets). */
export const DEFAULT_CONTAINED_READ_MAX_BYTES = 32 * 1024 * 1024;

export class ContainmentError extends Error {
    readonly code = 'ECONTAINMENT';
    constructor(
        readonly path: string,
        reason: string,
        readonly kind: 'refused' | 'too_large' = 'refused',
    ) {
        super(`refusing to read ${path}: ${reason}`);
        this.name = 'ContainmentError';
    }
}

export function isWithinRoot(candidate: string, root: string): boolean {
    const c = resolve(candidate);
    const r = resolve(root);
    return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

// ---------------------------------------------------------------------------
// Allowed roots
// ---------------------------------------------------------------------------

const ROOTS_TTL_MS = 60_000;
let rootsCache: { at: number; roots: string[] } | null = null;

/** Test hook: drop the cached root list. */
export function resetContainmentRootsCache(): void {
    rootsCache = null;
    realpathCache.clear();
    sensitiveCache = null;
}

/**
 * Roots a symlinked sidecar/media file may legitimately point into: enabled
 * library paths (container and provider side) plus the metadata store. Empty
 * (fail closed) when the database is unavailable.
 */
export async function getContainmentRoots(): Promise<string[]> {
    if (rootsCache && Date.now() - rootsCache.at < ROOTS_TTL_MS) return rootsCache.roots;
    const roots: string[] = [];
    try {
        const [{ getDb }, { getEnabledLibraryPaths }, meta] = await Promise.all([
            import('../database/connection.js'),
            import('../database/queries/library-paths.queries.js'),
            import('../services/metadata-storage.service.js'),
        ]);
        for (const base of meta.metadataCentralBaseDirCandidates()) {
            roots.push(join(base, '.metadata'));
        }
        const sql = getDb();
        if (sql) {
            for (const row of await getEnabledLibraryPaths(sql)) {
                roots.push(row.path);
                if (row.provider_path) roots.push(row.provider_path);
            }
        }
    } catch (err) {
        logger.debug('containment roots unavailable', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    rootsCache = { at: Date.now(), roots };
    return roots;
}

const realpathCache = new Map<string, { at: number; real: string | null }>();

/** Realpath of a root, cached: a debrid walk asks for the same few roots once per file. */
async function realOf(root: string): Promise<string | null> {
    const hit = realpathCache.get(root);
    if (hit && Date.now() - hit.at < ROOTS_TTL_MS) return hit.real;
    let real: string | null = null;
    try {
        real = await safeRealpath(root);
    } catch {
        // root not mounted right now: the lexical form still applies
    }
    realpathCache.set(root, { at: Date.now(), real });
    return real;
}

async function realRoots(roots: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const r of roots) {
        out.push(resolve(r));
        const real = await realOf(r);
        if (real) out.push(real);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

async function insideAllowedRoots(real: string, extraRoots: readonly string[]): Promise<boolean> {
    if ((await realRoots(extraRoots)).some((r) => isWithinRoot(real, r))) return true;
    return (await realRoots(await getContainmentRoots())).some((r) => isWithinRoot(real, r));
}

/**
 * Decide whether `filePath` may be read. Returns the path to read (the real
 * target for an allowed symlink) or null when it is missing, not a regular
 * file, or a symlink whose target leaves every allowed root.
 *
 * `extraRoots` are trusted in addition to {@link getContainmentRoots}; they are
 * consulted first and the DB lookup only happens when a symlink is hit.
 *
 * Use this for sidecars and other non-media files (strict containment). Media
 * files that debrid/rclone setups symlink to a mount outside the library use
 * {@link resolveContainedMediaFile}.
 */
export async function resolveContainedFile(
    filePath: string,
    extraRoots: readonly string[] = [],
    opts: ContainOptions = {},
): Promise<string | null> {
    return resolveLink(filePath, extraRoots, false, opts);
}

/**
 * Like {@link resolveContainedFile} for MEDIA files: a symlink may resolve
 * outside the library roots (debrid/rclone mounts) as long as the target is a
 * regular file that is not under a sensitive prefix ({@link isSensitivePath}).
 */
export async function resolveContainedMediaFile(
    filePath: string,
    extraRoots: readonly string[] = [],
    opts: ContainOptions = {},
): Promise<string | null> {
    return resolveLink(filePath, extraRoots, true, opts);
}

export interface ContainOptions {
    /**
     * Also check the directories above the file. Set it for a path read from the
     * database: the scan checked it, but by the time it is served a directory on
     * the way may have been swapped for a link. The resolved real path is
     * returned, so the caller's O_NOFOLLOW open cannot be redirected by a later
     * swap of the last component. A directory link may lead outside the roots
     * (a library folder on another mount is common) but never into a sensitive
     * dir. Scan-time callers leave it off: they walk real directories and it
     * would cost a realpath per file.
     */
    parents?: boolean;
}

async function resolveLink(
    filePath: string,
    extraRoots: readonly string[],
    allowOutsideRoots: boolean,
    opts: ContainOptions,
): Promise<string | null> {
    let lst;
    try {
        lst = await safeLstat(filePath);
    } catch {
        return null;
    }
    if (!lst.isSymbolicLink()) {
        if (!lst.isFile()) return null;
        return opts.parents ? resolveParents(filePath, extraRoots) : filePath;
    }

    let real: string;
    try {
        real = await safeRealpath(filePath);
    } catch {
        return null;
    }
    if (!(await insideAllowedRoots(real, extraRoots))) {
        if (!allowOutsideRoots || (await isSensitivePathResolved(real))) {
            // debug: a debrid library can hit this per file; the walker logs a per-walk total.
            logger.debug('symlink target outside allowed roots - refusing', {
                link: filePath,
                target: real,
            });
            return null;
        }
    }
    try {
        return (await safeStat(real)).isFile() ? real : null;
    } catch {
        return null;
    }
}

/** {@link ContainOptions.parents}: the real path of a regular file, or null. */
async function resolveParents(
    filePath: string,
    extraRoots: readonly string[],
): Promise<string | null> {
    let real: string;
    try {
        real = await safeRealpath(filePath);
    } catch {
        return null;
    }
    if (real === resolve(filePath) || (await insideAllowedRoots(real, extraRoots))) return real;
    if (await isSensitivePathResolved(real)) {
        logger.warn('directory link leads into a sensitive dir - refusing', {
            path: filePath,
            target: real,
        });
        return null;
    }
    return real;
}

// ---------------------------------------------------------------------------
// Sensitive prefixes (media symlinks may leave the library, never into these)
// ---------------------------------------------------------------------------

const STATIC_SENSITIVE_PREFIXES = [
    '/proc',
    '/sys',
    '/dev',
    '/etc',
    '/root',
    '/run/secrets',
    '/var/run/secrets',
    '/config',
];

/** Test hook: extra prefixes (e.g. a temp dir standing in for the config dir). */
let injectedSensitivePrefixes: string[] = [];
export function setSensitivePrefixesForTests(prefixes: string[]): void {
    injectedSensitivePrefixes = prefixes;
    sensitiveCache = null;
}

/** True when `realPath` is, or lies under, one of `prefixes` (path-boundary aware). */
export function isSensitivePath(realPath: string, prefixes: readonly string[]): boolean {
    return prefixes.some((p) => p && isWithinRoot(realPath, p));
}

/**
 * Static list plus the directories this install actually uses: the config dir
 * (where master.key lives), the app dir, and the transcode/cache dirs. Both the
 * lexical and the realpath form of each is included.
 */
let sensitiveCache: { at: number; prefixes: string[] } | null = null;

export async function getSensitivePrefixes(): Promise<string[]> {
    if (sensitiveCache && Date.now() - sensitiveCache.at < ROOTS_TTL_MS) {
        return sensitiveCache.prefixes;
    }
    const prefixes = [...STATIC_SENSITIVE_PREFIXES, process.cwd(), ...injectedSensitivePrefixes];
    try {
        const [{ getMasterKeyFilePath }, { config }] = await Promise.all([
            import('../crypto/master-key.js'),
            import('../config.js'),
        ]);
        prefixes.push(dirname(getMasterKeyFilePath()));
        for (const dir of [
            config.FFMPEG_TRANSCODE_DIR,
            config.DOWNLOAD_RENDITION_CACHE_DIR,
            config.PREVIEW_CACHE_DIR,
            config.MUSIC_TRANSCODE_CACHE_DIR,
        ]) {
            if (dir) prefixes.push(dir);
        }
    } catch (err) {
        logger.debug('sensitive prefixes: config unavailable', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    const out = new Set<string>();
    for (const p of prefixes) {
        out.add(resolve(p));
        try {
            out.add(await safeRealpath(p));
        } catch {
            // not present on this host
        }
    }
    const result = [...out];
    sensitiveCache = { at: Date.now(), prefixes: result };
    return result;
}

async function isSensitivePathResolved(real: string): Promise<boolean> {
    return isSensitivePath(real, await getSensitivePrefixes());
}

/**
 * Read a library-derived file with containment, a size cap and a regular-file
 * check on the opened descriptor (a FIFO/device swapped in after the lstat
 * cannot block a thread or stream /dev/zero). Throws {@link ContainmentError}
 * when refused; fs errors (ENOENT, ...) propagate.
 */
export async function readContainedFile(
    filePath: string,
    opts: {
        extraRoots?: readonly string[];
        maxBytes?: number;
        /**
         * Optional strict check of the file actually opened, before reading bytes.
         * Uses Linux procfs's descriptor link, so parent-directory swaps cannot
         * redirect the read unnoticed. Fails closed without Linux/procfs; existing
         * callers that omit this option retain their portable behavior.
         */
        validateOpenedFile?: (actualPath: string) => boolean;
    } & ContainOptions = {},
): Promise<Buffer> {
    const maxBytes = opts.maxBytes ?? DEFAULT_CONTAINED_READ_MAX_BYTES;
    const target = await resolveContainedFile(filePath, opts.extraRoots, opts);
    if (!target) {
        // Distinguish "gone" from "refused" so callers' ENOENT handling still works.
        await safeLstat(filePath);
        throw new ContainmentError(filePath, 'not a regular file or target outside library roots');
    }
    return withFsGuard(
        async () => {
            // O_NOFOLLOW protects the leaf; strict callers also validate the
            // descriptor below because parent directories can still be swapped.
            const fh = await fsOpen(
                target,
                fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
            );
            try {
                if (opts.validateOpenedFile) {
                    let actualPath: string;
                    try {
                        if (process.platform !== 'linux') throw new Error('Linux procfs required');
                        // Raw fs inside this guard: another guarded operation
                        // would acquire the same semaphore recursively.
                        actualPath = await fsRealpath(`/proc/self/fd/${fh.fd}`);
                    } catch {
                        throw new ContainmentError(
                            filePath,
                            'opened descriptor location unavailable',
                        );
                    }
                    if (!opts.validateOpenedFile(actualPath)) {
                        throw new ContainmentError(
                            filePath,
                            'opened descriptor outside allowed roots',
                        );
                    }
                }
                const st = await fh.stat();
                if (!st.isFile()) throw new ContainmentError(filePath, 'not a regular file');
                if (st.size > maxBytes)
                    throw new ContainmentError(filePath, 'file too large', 'too_large');
                const buf = Buffer.alloc(st.size);
                let off = 0;
                while (off < buf.length) {
                    const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
                    if (bytesRead === 0) break;
                    off += bytesRead;
                }
                return off === buf.length ? buf : buf.subarray(0, off);
            } finally {
                // This finally belongs to the underlying guarded operation:
                // even if its caller times out, the descriptor stays alive
                // until outstanding reads finish and is then always closed.
                await fh.close();
            }
        },
        'readContained',
        filePath,
    );
}

/**
 * Stream a path that {@link resolveContainedMediaFile} (or
 * {@link resolveContainedFile}) returned: opened O_NOFOLLOW, so a link swapped
 * in for the last component since the check is refused, and checked to be a
 * regular file on the opened descriptor. The stream closes the handle.
 */
export async function createNoFollowReadStream(
    realPath: string,
    range?: { start: number; end: number },
): Promise<ReadStream> {
    const fh = await withFsGuard(
        () =>
            fsOpen(
                realPath,
                fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
            ),
        'openNoFollow',
        realPath,
    );
    try {
        if (!(await fh.stat()).isFile()) {
            throw new ContainmentError(realPath, 'not a regular file');
        }
    } catch (err) {
        await fh.close();
        throw err;
    }
    return fh.createReadStream(range ? { start: range.start, end: range.end } : {});
}

// ---------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------

/**
 * Write `data` to `destPath` without following a symlink planted at that name:
 * write a uniquely named temp file (exclusive create) in the same directory,
 * then rename it over the destination. `rename` replaces a symlink rather than
 * writing through it, and atomically swaps in the new bytes.
 */
export async function writeFileNoFollow(
    destPath: string,
    data: string | Uint8Array,
): Promise<void> {
    // Short fixed-length name: the destination basename can be long or non-ASCII.
    const tmp = join(dirname(destPath), `.lumastra-${randomUUID().slice(0, 8)}.tmp`);
    try {
        await withFsGuard(
            async () => {
                const fh = await fsOpen(tmp, 'wx', 0o644);
                try {
                    await fh.writeFile(data);
                    // Keep the mode of the file being replaced (best effort).
                    try {
                        const existing = await fsLstat(destPath); // raw: already inside the fs guard
                        if (existing.isFile()) await fh.chmod(existing.mode & 0o7777);
                    } catch {
                        // new file, or mode not copyable
                    }
                } finally {
                    await fh.close();
                }
            },
            'writeFileNoFollow',
            destPath,
        );
        await withFsGuard(() => fsRename(tmp, destPath), 'rename', destPath);
    } catch (err) {
        await withFsGuard(() => fsUnlink(tmp), 'unlink', tmp).catch(() => {});
        throw err;
    }
}

/** Publish complete synced bytes exclusively, refusing any existing file or symlink. */
export async function writeFileExclusiveNoFollow(
    destPath: string,
    data: string | Uint8Array,
): Promise<void> {
    const temporary = join(dirname(destPath), `.lumastra-${randomUUID()}.tmp`);
    let created = false;
    try {
        await withFsGuard(
            async () => {
                const handle = await fsOpen(temporary, 'wx', 0o644);
                created = true;
                try {
                    await handle.writeFile(data);
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            },
            'writeFileExclusiveNoFollow',
            destPath,
        );
        // link() atomically creates the final name and never follows or replaces
        // an existing symlink, including one planted during the temp write.
        await withFsGuard(() => fsLink(temporary, destPath), 'link', destPath);
    } finally {
        if (created)
            await withFsGuard(() => fsUnlink(temporary), 'unlink', temporary).catch(
                (error: unknown) => {
                    if ((error as { code?: string } | null)?.code !== 'ENOENT') throw error;
                },
            );
    }
}
