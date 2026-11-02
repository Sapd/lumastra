// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PreviewCacheStore — persistent local cache of transcoded preview artifacts.
 *
 * Streaming-aware lifecycle: a preview must return a stream URL *immediately*
 * while FFmpeg is still producing segments, so an artifact is `warming` for
 * the duration of the transcode and only becomes `ready` (sized, budget-
 * counted) once FFmpeg exits cleanly. `acquire()` never waits for transcode
 * completion — it only awaits the (fast) job-start, then returns the
 * still-`warming` entry. Task 4's FFmpeg `onExit` hook calls `markReady()` /
 * `markFailed()` to close the lifecycle.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PreviewCacheStore');
const READY_MARKER = '.ready';

export interface PreviewCacheEntry {
    key: string;
    dir: string;
    sizeBytes: number;
    refcount: number;
    lastAccessedAt: number;
    state: 'warming' | 'ready';
}

export interface PreviewCacheStats {
    entries: number;
    ready: number;
    warming: number;
    totalBytes: number;
    maxBytes: number;
    hits: number;
    misses: number;
    evictions: number;
}

/**
 * Recursively sums the byte size of every file under `dir`. Exported for
 * reuse by Task 4 (e.g. verifying on-disk size before trusting a `markReady`
 * caller-supplied size, or admin/debug tooling).
 */
export async function dirSizeBytes(dir: string): Promise<number> {
    let total = 0;
    const walk = async (d: string): Promise<void> => {
        const items = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
        for (const it of items) {
            const p = join(d, it.name);
            if (it.isDirectory()) await walk(p);
            else {
                const s = await fs.stat(p).catch(() => null);
                if (s) total += s.size;
            }
        }
    };
    await walk(dir);
    return total;
}

export class PreviewCacheStore {
    private readonly rootDir: string;
    private readonly maxBytes: number;
    private readonly entries = new Map<string, PreviewCacheEntry>();
    private readonly inFlight = new Map<string, Promise<PreviewCacheEntry>>();
    // Per-key chain of in-progress dir deletions. Deletes are un-awaited (fire from
    // markFailed/evict/acquire-rejection), so a same-key re-acquire must wait for any
    // pending delete before recreating the dir — otherwise the stale `fs.rm` running on
    // the threadpool can wipe the freshly re-warmed dir (TOCTOU). See scheduleDelete().
    private readonly pendingDeletes = new Map<string, Promise<void>>();
    private hits = 0;
    private misses = 0;
    private evictions = 0;
    private readonly now: () => number;
    // Fired after an entry is dropped by evictToBudget()/markFailed() so a
    // caller can close out the (possibly still-lingering) FFmpeg job for the
    // key. Not imported directly here — ffmpeg-transcode.service.ts already
    // imports this module, so importing it back would create a cycle. See
    // setOnDrop().
    private onDrop?: (key: string) => void;

    constructor(opts: { rootDir: string; maxBytes: number; now?: () => number }) {
        this.rootDir = opts.rootDir;
        this.maxBytes = opts.maxBytes;
        this.now = opts.now ?? ((): number => Date.now());
    }

    /**
     * Registers a callback fired whenever `evictToBudget()`/`markFailed()`
     * drops an entry, so the caller can stop a lingering FFmpeg job for
     * `key`. Not fired from the acquire-rejection path — that failure never
     * fully started a job and already schedules its own dir cleanup.
     */
    setOnDrop(cb: (key: string) => void): void {
        this.onDrop = cb;
    }

    dirFor(key: string): string {
        // A key shorter than the 2-char shard prefix (e.g. '' or a single
        // char) makes `key.slice(0, 2)` collapse to '' — `path.join(root, '',
        // '')` resolves to `root` itself, so any caller that later `rm`s
        // "the artifact dir" (markFailed/evictToBudget/scheduleDelete) would
        // recursively delete the ENTIRE preview cache. Fail loudly instead.
        if (key.length < 2) {
            throw new Error('preview cache key too short');
        }
        return join(this.rootDir, key.slice(0, 2), key);
    }

    lookup(key: string): PreviewCacheEntry | undefined {
        const e = this.entries.get(key);
        if (e) e.lastAccessedAt = this.now();
        return e;
    }

    attach(key: string): void {
        const e = this.entries.get(key);
        if (e) {
            e.refcount++;
            e.lastAccessedAt = this.now();
        }
    }

    detach(key: string): void {
        const e = this.entries.get(key);
        if (e && e.refcount > 0) e.refcount--;
    }

    /**
     * Schedules an un-awaited recursive delete of `dir`, chained per key so a
     * same-key re-acquire can await the delete before recreating the dir (see
     * the `pendingDeletes` await at the top of acquire's IIFE). Prevents a
     * stale delete from clobbering a freshly re-warmed dir (TOCTOU).
     */
    private scheduleDelete(key: string, dir: string): void {
        const prev = this.pendingDeletes.get(key);
        const p = (async (): Promise<void> => {
            if (prev) await prev.catch(() => {});
            await fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
                logger.warn('Failed to remove preview artifact dir', {
                    key,
                    dir,
                    error: String(err),
                });
            });
        })().finally(() => {
            if (this.pendingDeletes.get(key) === p) this.pendingDeletes.delete(key);
        });
        this.pendingDeletes.set(key, p);
    }

    /**
     * Single-flight per key. On miss: creates `dirFor(key)`, inserts a
     * `warming` entry, awaits `startWarm(dir)` (which only *starts* the
     * transcode and resolves fast), then returns the still-`warming` entry.
     * Does NOT wait for transcode completion. Records hit/miss.
     *
     * `estimatedBytes` seeds the warming entry's `sizeBytes` (default 0) so
     * the disk budget accounts for in-flight artifacts too — `markReady`
     * replaces it with the real measured size, and `markFailed` drops it
     * along with the entry. Warming entries still aren't eviction
     * candidates; they only contribute to the budget sum.
     */
    async acquire(
        key: string,
        startWarm: (dir: string) => Promise<void>,
        estimatedBytes = 0,
    ): Promise<PreviewCacheEntry> {
        const existing = this.entries.get(key);
        if (existing) {
            this.hits++;
            existing.lastAccessedAt = this.now();
            return existing;
        }
        const flight = this.inFlight.get(key);
        if (flight) {
            this.hits++;
            return flight;
        }

        this.misses++;
        const dir = this.dirFor(key);
        const entry: PreviewCacheEntry = {
            key,
            dir,
            sizeBytes: estimatedBytes,
            refcount: 0,
            lastAccessedAt: this.now(),
            state: 'warming',
        };
        const p = (async (): Promise<PreviewCacheEntry> => {
            // Serialize against any in-flight delete of the same key so a stale
            // fs.rm can't wipe the dir we're about to recreate (TOCTOU).
            const pendingDelete = this.pendingDeletes.get(key);
            if (pendingDelete) await pendingDelete.catch(() => {});
            await fs.mkdir(dir, { recursive: true });
            this.entries.set(key, entry);
            // Only STARTS the transcode (resolves fast). The entry stays `warming`
            // until markReady()/markFailed() is called from the FFmpeg onExit hook.
            await startWarm(dir);
            return entry;
        })()
            .catch((err: unknown) => {
                this.entries.delete(key);
                this.scheduleDelete(key, dir);
                throw err;
            })
            .finally(() => {
                this.inFlight.delete(key);
            });

        this.inFlight.set(key, p);
        return p;
    }

    /** Called when the warming FFmpeg job exits cleanly (Task 4 onExit, code 0). */
    markReady(key: string, sizeBytes: number): void {
        const e = this.entries.get(key);
        if (!e) return;
        e.sizeBytes = sizeBytes;
        e.state = 'ready';
        e.lastAccessedAt = this.now();
        this.evictToBudget();
    }

    /** Called when the warming FFmpeg job errors/exits non-zero. */
    markFailed(key: string): void {
        const e = this.entries.get(key);
        if (!e) return;
        this.entries.delete(key);
        this.scheduleDelete(key, e.dir);
        this.onDrop?.(key);
    }

    /**
     * Evicts idle (`ready` + `refcount === 0`) entries, LRU by
     * `lastAccessedAt`, until under `maxBytes`. Never evicts `warming` or
     * in-use entries — if it can't get under budget it degrades (leaves the
     * remainder), it never corrupts an in-flight or in-use artifact.
     */
    evictToBudget(): number {
        let total = 0;
        for (const e of this.entries.values()) total += e.sizeBytes;
        if (total <= this.maxBytes) return 0;

        const idle = [...this.entries.values()]
            .filter((e) => e.state === 'ready' && e.refcount === 0)
            .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

        let freed = 0;
        for (const e of idle) {
            if (total - freed <= this.maxBytes) break;
            this.entries.delete(e.key);
            this.scheduleDelete(e.key, e.dir);
            this.onDrop?.(e.key);
            freed += e.sizeBytes;
            this.evictions++;
            logger.info('Evicted idle preview artifact', { key: e.key, bytes: e.sizeBytes });
        }
        return freed;
    }

    /**
     * Startup rescan: indexes on-disk artifacts that carry the `.ready`
     * marker as `ready` entries, and deletes partial (interrupted) dirs that
     * lack it — those can never be resumed since the warming FFmpeg process
     * is gone.
     */
    async scanOnStartup(): Promise<void> {
        if (!existsSync(this.rootDir)) {
            await fs.mkdir(this.rootDir, { recursive: true }).catch(() => {});
            return;
        }
        const shards = await fs.readdir(this.rootDir).catch(() => [] as string[]);
        for (const shard of shards) {
            const shardPath = join(this.rootDir, shard);
            const keys = await fs.readdir(shardPath).catch(() => [] as string[]);
            for (const key of keys) {
                const dir = join(shardPath, key);
                if (!existsSync(join(dir, READY_MARKER))) {
                    await fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
                        logger.warn('Failed to remove partial preview artifact dir', {
                            key,
                            dir,
                            error: String(err),
                        });
                    });
                    continue;
                }
                const size = await dirSizeBytes(dir);
                const stat = await fs.stat(dir).catch(() => null);
                this.entries.set(key, {
                    key,
                    dir,
                    sizeBytes: size,
                    refcount: 0,
                    lastAccessedAt: stat?.mtimeMs ?? this.now(),
                    state: 'ready',
                });
            }
        }
        this.evictToBudget();
    }

    stats(): PreviewCacheStats {
        let totalBytes = 0;
        let ready = 0;
        let warming = 0;
        for (const e of this.entries.values()) {
            totalBytes += e.sizeBytes;
            if (e.state === 'ready') ready++;
            else warming++;
        }
        return {
            entries: this.entries.size,
            ready,
            warming,
            totalBytes,
            maxBytes: this.maxBytes,
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
        };
    }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
// The class stays constructor-injected (no config import inside it) so tests
// can construct it directly against a temp dir. The singleton below is the
// only place that reads `config.PREVIEW_CACHE_DIR` / `PREVIEW_CACHE_MAX_BYTES`,
// built lazily so importing this module never eagerly touches config at
// module-load time (matches the pattern in session-manager.service.ts).

let singleton: PreviewCacheStore | null = null;

export function getPreviewCacheStore(): PreviewCacheStore {
    if (!singleton) {
        singleton = new PreviewCacheStore({
            rootDir: config.PREVIEW_CACHE_DIR,
            maxBytes: config.PREVIEW_CACHE_MAX_BYTES,
        });
    }
    return singleton;
}

/** Reset the singleton — exclusively for tests. */
export function __resetPreviewCacheStoreForTests(): void {
    singleton = null;
}
