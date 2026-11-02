// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TopShelfArtifactStore — durable, pinned filesystem store for tvOS Top Shelf
 * preview/cinemagraph MP4 artifacts.
 *
 * Deliberately NOT the LRU preview cache (`preview-cache.store.ts`): that
 * store's refcount-0 eviction can drop an artifact while a 48h signed URL
 * still points at it. This store's durability contract instead pins any
 * artifact whose `lastRequestedAt` is within
 * `TTL + PINNING_SLACK_MS` of now — a live signed URL can only exist for an
 * artifact inside that window (the URL's expiry IS the TTL, and every mint /
 * successful serve touches `lastRequestedAt`).
 *
 * Layout (no shard prefix — item count is small relative to the preview cache):
 * ```
 * {rootDir}/{mediaUuid}/
 *   manifest.json
 *   preview-{contentKey}.mp4
 *   cinemagraph-{contentKey}.mp4
 *   {storeKey}-{contentKey}.mp4     (overlaid variants — storeKey is a
 *                                    hyphenated compound token, e.g.
 *                                    preview-ov-logo-tl-s1-x40-{contentKey}.mp4)
 *   *.tmp.*                         (in-flight renders, rename-on-complete)
 * ```
 */

import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { parseOverlayToken } from './topshelf-overlay.js';
import type { OverlayMode } from './topshelf-overlay.js';

const logger = Logger.for('TopShelfArtifactStore');

const MANIFEST_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';
/**
 * Extra slack added on top of the signed-URL TTL before an artifact becomes
 * GC-eligible — absorbs clock skew and in-flight requests that started just
 * before expiry.
 */
const PINNING_SLACK_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Stale in-flight render tmp files older than this are swept as orphans. */
const STALE_TMP_MS = 60 * 60 * 1000; // 1 hour

/** A plain variant (`preview`/`cinemagraph`) or a compound overlay token. */
export type StoreVariantKey = string;

export interface TopShelfVariantManifestEntry {
    contentKey: string;
    source: 'trailer' | 'snippet';
    /** Overlay mode; absent for plain variants (back-compatible). */
    mode?: OverlayMode;
    bytes: number;
    createdAt: string;
    lastRequestedAt: string;
}

export interface TopShelfManifest {
    version: number;
    variants: Partial<Record<StoreVariantKey, TopShelfVariantManifestEntry>>;
}

export type TopShelfArtifactLookup =
    | { status: 'ready'; path: string; entry: TopShelfVariantManifestEntry }
    | { status: 'missing_file'; entry: TopShelfVariantManifestEntry }
    | { status: 'no_entry' };

function emptyManifest(): TopShelfManifest {
    return { version: MANIFEST_VERSION, variants: {} };
}

function isStoreVariantKey(value: string): boolean {
    return value === 'preview' || value === 'cinemagraph' || parseOverlayToken(value) !== null;
}

/** `computeTopShelfContentKey` always produces a 16-char lowercase hex sha1 prefix. */
const CONTENT_KEY_PATTERN = /^[0-9a-f]{16}$/;

/** Parse and structurally validate a manifest.json body. Corrupt → null (cache-miss). */
function parseManifest(raw: string): TopShelfManifest | null {
    try {
        const data: unknown = JSON.parse(raw);
        if (!data || typeof data !== 'object') return null;
        const obj = data as Record<string, unknown>;
        const rawVariants = obj.variants;
        if (!rawVariants || typeof rawVariants !== 'object') return null;
        const variants: TopShelfManifest['variants'] = {};
        for (const [key, value] of Object.entries(rawVariants as Record<string, unknown>)) {
            if (!isStoreVariantKey(key) || !value || typeof value !== 'object') continue;
            const v = value as Record<string, unknown>;
            if (
                typeof v.contentKey !== 'string' ||
                !CONTENT_KEY_PATTERN.test(v.contentKey) ||
                (v.source !== 'trailer' && v.source !== 'snippet') ||
                typeof v.bytes !== 'number' ||
                typeof v.createdAt !== 'string' ||
                typeof v.lastRequestedAt !== 'string'
            ) {
                continue;
            }
            const mode =
                v.mode === 'logo' || v.mode === 'text' || v.mode === 'none' ? v.mode : undefined;
            variants[key] = {
                contentKey: v.contentKey,
                source: v.source,
                ...(mode ? { mode } : {}),
                bytes: v.bytes,
                createdAt: v.createdAt,
                lastRequestedAt: v.lastRequestedAt,
            };
        }
        return { version: MANIFEST_VERSION, variants };
    } catch {
        return null;
    }
}

export class TopShelfArtifactStore {
    private readonly rootDir: string;
    private readonly maxBytes: number;
    private readonly retentionMs: number;
    private readonly pinningWindowMs: number;
    private readonly now: () => number;
    // Serializes manifest read-modify-write per item so two concurrent
    // touch()/recordVariant() calls for the same media item never race and
    // clobber each other (last-write-wins on JSON.stringify would otherwise
    // silently drop one writer's update).
    private readonly manifestLocks = new Map<string, Promise<void>>();
    private gcTimer: ReturnType<typeof setInterval> | null = null;

    constructor(opts: {
        rootDir: string;
        maxBytes: number;
        retentionDays: number;
        urlTtlSeconds: number;
        now?: () => number;
    }) {
        this.rootDir = opts.rootDir;
        this.maxBytes = opts.maxBytes;
        this.retentionMs = opts.retentionDays * 24 * 60 * 60 * 1000;
        this.pinningWindowMs = opts.urlTtlSeconds * 1000 + PINNING_SLACK_MS;
        this.now = opts.now ?? ((): number => Date.now());
    }

    itemDir(mediaUuid: string): string {
        return join(this.rootDir, mediaUuid);
    }

    private manifestPath(mediaUuid: string): string {
        return join(this.itemDir(mediaUuid), MANIFEST_FILE);
    }

    artifactPath(mediaUuid: string, variant: StoreVariantKey, contentKey: string): string {
        return join(this.itemDir(mediaUuid), `${variant}-${contentKey}.mp4`);
    }

    /** Serialize an async mutator against the per-item manifest lock. */
    private async withManifestLock<T>(mediaUuid: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.manifestLocks.get(mediaUuid) ?? Promise.resolve();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const chained = prev.then(() => gate);
        this.manifestLocks.set(mediaUuid, chained);
        await prev;
        try {
            return await fn();
        } finally {
            release();
            if (this.manifestLocks.get(mediaUuid) === chained) {
                this.manifestLocks.delete(mediaUuid);
            }
        }
    }

    async readManifest(mediaUuid: string): Promise<TopShelfManifest | null> {
        try {
            const raw = await fs.readFile(this.manifestPath(mediaUuid), 'utf-8');
            return parseManifest(raw);
        } catch {
            return null;
        }
    }

    /** Atomic tmp+rename manifest write. */
    private async writeManifestAtomic(
        mediaUuid: string,
        manifest: TopShelfManifest,
    ): Promise<void> {
        const dir = this.itemDir(mediaUuid);
        await fs.mkdir(dir, { recursive: true });
        const finalPath = this.manifestPath(mediaUuid);
        const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
        await fs.writeFile(tmpPath, JSON.stringify(manifest), 'utf-8');
        await fs.rename(tmpPath, finalPath);
    }

    /**
     * Look up the current artifact for (mediaUuid, variant). Distinguishes
     * "no manifest entry at all" from "manifest entry exists but the file is
     * gone" — the serving route maps these to 404 vs 410 respectively.
     */
    async getVariantArtifact(
        mediaUuid: string,
        variant: StoreVariantKey,
    ): Promise<TopShelfArtifactLookup> {
        const manifest = await this.readManifest(mediaUuid);
        const entry = manifest?.variants[variant];
        if (!entry) return { status: 'no_entry' };

        const path = this.artifactPath(mediaUuid, variant, entry.contentKey);
        try {
            await fs.access(path);
        } catch {
            return { status: 'missing_file', entry };
        }
        return { status: 'ready', path, entry };
    }

    /** Record a freshly-rendered variant (called after a successful render). */
    async recordVariant(
        mediaUuid: string,
        variant: StoreVariantKey,
        entry: TopShelfVariantManifestEntry,
    ): Promise<void> {
        await this.withManifestLock(mediaUuid, async () => {
            const manifest = (await this.readManifest(mediaUuid)) ?? emptyManifest();
            const previous = manifest.variants[variant];
            manifest.variants[variant] = entry;
            // Write the manifest FIRST so the durable pointer always names a
            // file that exists, then unlink the superseded artifact — a
            // rotated-out fileVersion/startBucket/profileRev would otherwise
            // never be cleaned up and would keep counting against the size
            // cap forever (it isn't referenced by any current manifest
            // entry, so sweepOnce's per-entry pass never sees it either).
            await this.writeManifestAtomic(mediaUuid, manifest);
            if (previous && previous.contentKey !== entry.contentKey) {
                const oldPath = this.artifactPath(mediaUuid, variant, previous.contentKey);
                await fs.rm(oldPath, { force: true }).catch(() => {});
            }
        });
    }

    /**
     * Touch `lastRequestedAt` for a variant — called on every mint that finds
     * an existing artifact, and on every successful serve. This is the input
     * the pinning rule reads: any artifact a live signed URL can point at has
     * been touched within the URL's TTL, so it is never GC-eligible.
     * No-ops silently when the variant has no manifest entry.
     */
    async touch(mediaUuid: string, variant: StoreVariantKey): Promise<void> {
        await this.withManifestLock(mediaUuid, async () => {
            const manifest = await this.readManifest(mediaUuid);
            const entry = manifest?.variants[variant];
            if (!manifest || !entry) return;
            entry.lastRequestedAt = new Date(this.now()).toISOString();
            await this.writeManifestAtomic(mediaUuid, manifest);
        });
    }

    /** True while `lastRequestedAt` is inside the durability (pinning) window. */
    private isPinned(entry: TopShelfVariantManifestEntry): boolean {
        const lastRequested = Date.parse(entry.lastRequestedAt);
        if (Number.isNaN(lastRequested)) return false;
        return this.now() - lastRequested < this.pinningWindowMs;
    }

    /** True when `lastRequestedAt` is older than the retention TTL. */
    private isExpiredByRetention(entry: TopShelfVariantManifestEntry): boolean {
        const lastRequested = Date.parse(entry.lastRequestedAt);
        if (Number.isNaN(lastRequested)) return true;
        return this.now() - lastRequested >= this.retentionMs;
    }

    /**
     * One GC sweep: deletes retention-expired variants (never a pinned one),
     * unlinks superseded artifact files no manifest entry points at any more,
     * then — if still over the size cap — evicts oldest-`lastRequestedAt`
     * variants first, again never crossing the pinning rule. Also removes
     * empty item directories and stale `*.tmp.*` files.
     *
     * Every manifest read-modify-write below runs inside `withManifestLock` —
     * the SAME per-item lock `touch()`/`recordVariant()` use — and re-reads
     * the manifest after acquiring it rather than trusting a pre-lock
     * snapshot. Without that, a concurrent `touch()` re-pinning an entry (or
     * `recordVariant()` rotating it to a new contentKey) mid-sweep could
     * have this sweep delete an artifact a signed URL was just minted or
     * refreshed against.
     */
    async sweepOnce(): Promise<{ deleted: number; evicted: number; bytesFreed: number }> {
        let deleted = 0;
        let evicted = 0;
        let bytesFreed = 0;

        if (!existsSync(this.rootDir)) {
            await fs.mkdir(this.rootDir, { recursive: true }).catch(() => {});
            return { deleted, evicted, bytesFreed };
        }

        const itemDirs = await fs.readdir(this.rootDir).catch(() => [] as string[]);

        interface Candidate {
            mediaUuid: string;
            variant: StoreVariantKey;
            entry: TopShelfVariantManifestEntry;
        }
        const survivors: Candidate[] = [];

        for (const mediaUuid of itemDirs) {
            const dir = this.itemDir(mediaUuid);
            const stat = await fs.stat(dir).catch(() => null);
            if (!stat?.isDirectory()) continue;

            // Clean up stale in-flight tmp files regardless of manifest state.
            const files = await fs.readdir(dir).catch(() => [] as string[]);
            for (const file of files) {
                if (!file.includes('.tmp.')) continue;
                const filePath = join(dir, file);
                const fstat = await fs.stat(filePath).catch(() => null);
                if (fstat && this.now() - fstat.mtimeMs > STALE_TMP_MS) {
                    await fs.rm(filePath, { force: true }).catch(() => {});
                }
            }

            await this.withManifestLock(mediaUuid, async () => {
                const manifest = await this.readManifest(mediaUuid);
                if (!manifest) return;

                let manifestChanged = false;
                for (const variant of Object.keys(manifest.variants)) {
                    const entry = manifest.variants[variant];
                    if (!entry) continue;

                    if (!this.isPinned(entry) && this.isExpiredByRetention(entry)) {
                        const artifactPath = this.artifactPath(
                            mediaUuid,
                            variant,
                            entry.contentKey,
                        );
                        await fs.rm(artifactPath, { force: true }).catch(() => {});
                        delete manifest.variants[variant];
                        manifestChanged = true;
                        deleted++;
                        bytesFreed += entry.bytes;
                        continue;
                    }

                    survivors.push({ mediaUuid, variant, entry });
                }

                if (manifestChanged) {
                    if (Object.keys(manifest.variants).length === 0) {
                        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
                    } else {
                        await this.writeManifestAtomic(mediaUuid, manifest).catch(() => {});
                    }
                }

                // Superseded-artifact cleanup: a `{storeKey}-{key}.mp4` file
                // that no current manifest entry points at is either a
                // rotated-out fileVersion/startBucket/profileRev that
                // predates recordVariant()'s own unlink, or a crash between
                // the render's rename and its recordVariant() call. Re-list
                // the directory since the retention pass above may have just
                // removed the file that used to match.
                const currentFiles = await fs.readdir(dir).catch(() => [] as string[]);
                for (const file of currentFiles) {
                    // <storeKey>-<16hex>.mp4 — storeKey may itself contain
                    // hyphens (compound tokens), so match the 16-hex content
                    // key as the final segment and treat the rest as the key.
                    const match = /^(.+)-([0-9a-f]{16})\.mp4$/.exec(file);
                    if (!match) continue;
                    const [, fileVariant, fileKey] = match;
                    if (manifest.variants[fileVariant]?.contentKey === fileKey) continue;
                    await fs.rm(join(dir, file), { force: true }).catch(() => {});
                }
            });
        }

        // Size-cap eviction: oldest lastRequestedAt first, never a pinned entry.
        const totalBytes = survivors.reduce((sum, c) => sum + c.entry.bytes, 0);
        if (totalBytes > this.maxBytes) {
            const evictable = survivors
                .filter((c) => !this.isPinned(c.entry))
                .sort(
                    (a, b) =>
                        Date.parse(a.entry.lastRequestedAt) - Date.parse(b.entry.lastRequestedAt),
                );

            let freed = 0;
            for (const candidate of evictable) {
                if (totalBytes - freed <= this.maxBytes) break;

                await this.withManifestLock(candidate.mediaUuid, async () => {
                    // Re-read and re-check eligibility under the lock — the
                    // pre-lock `survivors` snapshot may be stale by now (a
                    // concurrent touch() could have re-pinned this entry, or
                    // recordVariant() may have rotated it to a different
                    // contentKey entirely).
                    const manifest = await this.readManifest(candidate.mediaUuid);
                    const entry = manifest?.variants[candidate.variant];
                    if (!manifest || !entry) return;
                    if (entry.contentKey !== candidate.entry.contentKey) return;
                    if (this.isPinned(entry)) return;

                    const artifactPath = this.artifactPath(
                        candidate.mediaUuid,
                        candidate.variant,
                        entry.contentKey,
                    );
                    await fs.rm(artifactPath, { force: true }).catch(() => {});
                    delete manifest.variants[candidate.variant];
                    freed += entry.bytes;
                    evicted++;
                    bytesFreed += entry.bytes;

                    if (Object.keys(manifest.variants).length === 0) {
                        await fs
                            .rm(this.itemDir(candidate.mediaUuid), { recursive: true, force: true })
                            .catch(() => {});
                    } else {
                        await this.writeManifestAtomic(candidate.mediaUuid, manifest).catch(
                            () => {},
                        );
                    }
                    logger.info('Evicted Top Shelf artifact over size cap', {
                        mediaUuid: candidate.mediaUuid,
                        variant: candidate.variant,
                        bytes: entry.bytes,
                    });
                });
            }

            if (totalBytes - freed > this.maxBytes && evictable.length === 0) {
                logger.warn('Top Shelf store over size cap but every artifact is pinned', {
                    totalBytes,
                    maxBytes: this.maxBytes,
                });
            }
        }

        return { deleted, evicted, bytesFreed };
    }

    /** Lazily start the background GC sweep loop (idempotent). */
    startGcLoopIfNeeded(intervalMs: number): void {
        if (this.gcTimer) return;
        this.gcTimer = setInterval(() => {
            void this.sweepOnce().catch((err: unknown) => {
                logger.warn('Top Shelf GC sweep failed', { error: String(err) });
            });
        }, intervalMs);
        // Never hold the event loop open just for this background sweep.
        this.gcTimer.unref?.();
    }

    /** Stop the background GC loop — exclusively for tests. */
    stopGcLoop(): void {
        if (this.gcTimer) {
            clearInterval(this.gcTimer);
            this.gcTimer = null;
        }
    }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let singleton: TopShelfArtifactStore | null = null;

export function getTopShelfArtifactStore(): TopShelfArtifactStore {
    if (!singleton) {
        singleton = new TopShelfArtifactStore({
            rootDir: config.TOPSHELF_PREVIEW_CACHE_DIR,
            maxBytes: config.TOPSHELF_PREVIEW_CACHE_MAX_BYTES,
            retentionDays: config.TOPSHELF_PREVIEW_RETENTION_DAYS,
            urlTtlSeconds: config.TOPSHELF_PREVIEW_URL_TTL_SECONDS,
        });
        singleton.startGcLoopIfNeeded(config.TOPSHELF_GC_INTERVAL_MS);
    }
    return singleton;
}

/** Reset the singleton — exclusively for tests. */
export function __resetTopShelfArtifactStoreForTests(): void {
    singleton?.stopGcLoop();
    singleton = null;
}
