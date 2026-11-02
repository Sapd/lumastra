// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { promises as fs, existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MusicCodec } from './types.js';
import { cachePathFor, partialPathFor } from './cache-key.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('MusicTranscode:Cache');

export interface CacheConfig {
    cacheDir: string;
}

export interface CacheWriter {
    /** True for the first concurrent caller — owns the partial file. */
    isPrimary: boolean;
    /** Absolute path to write encoded bytes to (only meaningful when isPrimary). */
    partialPath: string;
    /** Absolute path the file will live at after promote(). */
    finalPath: string;
    /** Followers call this to wait for the primary to finish. */
    waitForPrimary: () => Promise<void>;
    /** Primary calls this on ffmpeg exit code 0. Atomic rename → final path. */
    promote: () => Promise<void>;
    /** Primary calls this on any error. Removes the partial file. */
    abort: () => Promise<void>;
}

export interface MusicTranscodeCache {
    getCachedFinalPath(key: string, codec: MusicCodec): Promise<string | null>;
    beginWrite(key: string, codec: MusicCodec): Promise<CacheWriter>;
    reapToCap(maxBytes: number, signal?: AbortSignal): Promise<void>;
    /**
     * Non-mutating probe: returns true if a primary writer is currently
     * encoding this (key, codec). Service-layer dedupe uses this to attach
     * follower streams to an in-flight encode rather than spawning a second
     * ffmpeg + slot for the same target file.
     */
    peekInFlight(key: string, codec: MusicCodec): boolean;
    /**
     * Wait for the primary writer for (key, codec) to settle. Resolves when
     * the cache file has been promoted; rejects when the primary aborted.
     * Returns immediately (resolved) if no primary is in flight — callers
     * should call peekInFlight() first to gate this.
     */
    waitForKey(key: string, codec: MusicCodec): Promise<void>;
}

/**
 * In-flight key is keyed by (cacheKey + ':' + codec). cacheKey already
 * includes codec/bitrate fingerprint, but the codec arrives separately
 * everywhere else in the service, so compose it explicitly to mirror the
 * cache file's on-disk path.
 */
function inFlightKey(cacheKey: string, codec: MusicCodec): string {
    return `${cacheKey}:${codec}`;
}

export function createMusicTranscodeCache(cfg: CacheConfig): MusicTranscodeCache {
    const inFlight = new Map<string, { primary: Promise<void>; finalPath: string }>();

    async function getCachedFinalPath(key: string, codec: MusicCodec): Promise<string | null> {
        const finalPath = cachePathFor(cfg.cacheDir, key, codec);
        if (existsSync(finalPath)) {
            // Touch atime so the reaper preserves popular items.
            const now = new Date();
            await fs.utimes(finalPath, now, now).catch(() => {});
            return finalPath;
        }
        return null;
    }

    async function beginWrite(key: string, codec: MusicCodec): Promise<CacheWriter> {
        const finalPath = cachePathFor(cfg.cacheDir, key, codec);
        const partialPath = partialPathFor(finalPath);
        const fk = inFlightKey(key, codec);

        const existing = inFlight.get(fk);
        if (existing) {
            return {
                isPrimary: false,
                partialPath,
                finalPath,
                waitForPrimary: () => existing.primary,
                promote: async () => {
                    /* no-op for followers */
                },
                abort: async () => {
                    /* no-op for followers */
                },
            };
        }

        // Register the in-flight entry SYNCHRONOUSLY before any await so that
        // concurrent callers that arrive before the mkdir completes see this entry
        // and become followers rather than spawning a second primary.
        let resolvePrimary!: () => void;
        let rejectPrimary!: (e: unknown) => void;
        const primaryPromise = new Promise<void>((resolve, reject) => {
            resolvePrimary = resolve;
            rejectPrimary = reject;
        });
        // Suppress unhandled-rejection if no follower ever calls waitForPrimary().
        primaryPromise.catch(() => {});
        inFlight.set(fk, { primary: primaryPromise, finalPath });

        try {
            await fs.mkdir(dirname(finalPath), { recursive: true });
        } catch (err) {
            rejectPrimary(err);
            inFlight.delete(fk);
            throw err;
        }

        return {
            isPrimary: true,
            partialPath,
            finalPath,
            waitForPrimary: () => primaryPromise,
            promote: async () => {
                try {
                    await fs.rename(partialPath, finalPath);
                    resolvePrimary();
                } catch (err) {
                    rejectPrimary(err);
                    throw err;
                } finally {
                    inFlight.delete(fk);
                }
            },
            abort: async () => {
                await fs.unlink(partialPath).catch(() => {});
                rejectPrimary(new Error('write aborted'));
                inFlight.delete(fk);
            },
        };
    }

    function peekInFlight(key: string, codec: MusicCodec): boolean {
        return inFlight.has(inFlightKey(key, codec));
    }

    async function waitForKey(key: string, codec: MusicCodec): Promise<void> {
        const entry = inFlight.get(inFlightKey(key, codec));
        if (!entry) return; // No primary in flight — caller should re-check the cache.
        await entry.primary;
    }

    function isInFlightPartial(path: string): boolean {
        return [...inFlight.values()].some((entry) => partialPathFor(entry.finalPath) === path);
    }

    async function sweepStalePartials(sweepDir: string): Promise<void> {
        let items: Dirent[];
        try {
            items = await fs.readdir(sweepDir, { withFileTypes: true });
        } catch {
            return;
        }
        // The streaming timeout is unrelated to abandoned files. Allow one hour
        // for a peer encoder, and never reap a writer this process still owns.
        const stalePartialMs = 60 * 60 * 1000;
        const cutoff = Date.now() - stalePartialMs;
        for (const item of items) {
            const full = join(sweepDir, item.name);
            if (item.isDirectory()) {
                await sweepStalePartials(full);
            } else if (item.isFile() && full.endsWith('.partial')) {
                if (isInFlightPartial(full)) continue;
                const st = await fs.stat(full).catch(() => null);
                if (st && st.mtimeMs < cutoff && !isInFlightPartial(full)) {
                    await fs.unlink(full).catch(() => {});
                    logger.debug('reaped stale partial', { path: full });
                }
            }
        }
    }

    async function reapToCap(maxBytes: number, signal?: AbortSignal): Promise<void> {
        await sweepStalePartials(cfg.cacheDir);

        const entries: { path: string; size: number; atimeMs: number }[] = [];
        async function walk(walkDir: string): Promise<void> {
            let items: Dirent[];
            try {
                items = await fs.readdir(walkDir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const item of items) {
                if (signal?.aborted) return;
                const full = join(walkDir, item.name);
                if (item.isDirectory()) {
                    await walk(full);
                } else if (item.isFile() && !full.endsWith('.partial')) {
                    const st = await fs.stat(full).catch(() => null);
                    if (st)
                        entries.push({
                            path: full,
                            size: st.size,
                            atimeMs: st.atimeMs,
                        });
                }
            }
        }
        await walk(cfg.cacheDir);

        let total = entries.reduce((s, e) => s + e.size, 0);
        if (total <= maxBytes) return;

        entries.sort((a, b) => a.atimeMs - b.atimeMs); // oldest first
        for (const e of entries) {
            if (signal?.aborted) break;
            if (total <= maxBytes) break;
            await fs.unlink(e.path).catch(() => {});
            total -= e.size;
            logger.debug('cache reap evicted', {
                path: e.path,
                sizeKb: Math.round(e.size / 1024),
            });
        }
    }

    return {
        getCachedFinalPath,
        beginWrite,
        reapToCap,
        peekInFlight,
        waitForKey,
    };
}
