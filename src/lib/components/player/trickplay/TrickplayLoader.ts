// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TrickplayLoader
 * Manages preloading, caching, and serving of trickplay thumbnail sprites
 * Extracted from ProgressBar.svelte to improve maintainability
 */

import { browser } from '$app/environment';
import {
    TrickplayManifestResponseSchema,
    type TrickplayManifestResponse,
} from '$lib/schemas/playback-trickplay';

// Configuration constants
const MAX_CONCURRENT_PRELOADS = 2;
const IDLE_TIMEOUT_MS = 1000;

/**
 * Callback interface for loader events
 */
export interface TrickplayLoaderCallbacks {
    onManifestLoad: (manifest: TrickplayManifestResponse) => void;
    onImageLoad: (index: number, url: string) => void;
    onImageFail: (index: number) => void;
    onLoadingStateChange: (isLoading: boolean) => void;
}

/**
 * TrickplayLoader class
 * Handles fetching, caching, and queueing of trickplay thumbnails
 */
export class TrickplayLoader {
    // Session tracking - incremented on reset to invalidate stale callbacks
    private currentSessionId = 0;

    // Caches
    private preloadedSprites = new Map<number, string>(); // index -> blob URL
    private blobUrlsToRevoke = new Set<string>();
    private failedSpriteSheets = new Map<number, number>(); // index -> failure timestamp
    private loadingSheets = new Set<number>();

    // Retry config: failed sheets become eligible for retry after this interval
    private static readonly FAILURE_RETRY_MS = 10_000;

    // Background loading state
    private backgroundPreloadQueue: number[] = [];
    private isBackgroundPreloading = false;

    // Pending target resolution
    private pendingTargetIndex: number | null = null;
    private trickplayLoading = false;

    // Manifest prefetch state
    private hasPrefetchedManifest = false;

    // Server-issued resources
    private itemId: string | null = null;
    private fileId: string | null = null;
    private manifestHref: string | null = null;
    private manifest: TrickplayManifestResponse | null = null;
    private manifestFailedAt: number | null = null;
    private manifestPromise: Promise<TrickplayManifestResponse | null> | null = null;

    constructor(
        private callbacks: TrickplayLoaderCallbacks,
        private debug = false,
    ) {
        this.log('TrickplayLoader initialized');
    }
    // ============================================
    // Public API
    // ============================================

    /**
     * Update configuration for new playback session
     */
    updateSession(
        itemId: string | null,
        fileId: string | null,
        manifestHref?: string | null,
    ): void {
        const resourceKey = (href: string | null | undefined): string | null => {
            if (!href) return null;
            const url = new URL(href, 'https://playback.invalid');
            url.searchParams.delete('grant');
            return url.pathname + url.search + url.hash;
        };
        const changed =
            itemId !== this.itemId ||
            fileId !== this.fileId ||
            resourceKey(manifestHref) !== resourceKey(this.manifestHref);

        if (changed) {
            this.log('Session changed, resetting loader');
            this.reset();
            this.itemId = itemId;
            this.fileId = fileId;
            this.manifestHref = manifestHref ?? null;
            this.currentSessionId++;
        } else {
            this.manifestHref = manifestHref ?? null;
        }
    }

    /**
     * Get sprite sheet index for a given time in seconds
     */
    getSpriteIndexForTime(timeSeconds: number): number {
        const info = this.manifest;
        if (!info) return 0;
        const intervalSeconds = info.intervalMs / 1000;
        const tileIndex = Math.floor(timeSeconds / intervalSeconds);
        const tilesPerImage = info.tileColumns * info.tileRows;
        return Math.floor(tileIndex / tilesPerImage);
    }

    /**
     * Request a specific sprite sheet to be loaded
     * Returns immediately if cached, starts loading if needed
     */
    requestSheet(index: number): void {
        this.pendingTargetIndex = index;
        this.tryResolveTarget();
    }

    /**
     * Check if a sheet is in cache
     */
    isSheetCached(index: number): boolean {
        return this.preloadedSprites.has(index);
    }

    /**
     * Get cached URL for a sheet
     */
    getCachedUrl(index: number): string | null {
        return this.preloadedSprites.get(index) ?? null;
    }

    /**
     * Prefetch first tile from manifest
     */
    async prefetchFirstTile(): Promise<void> {
        if (!browser || this.hasPrefetchedManifest) {
            return;
        }

        if (!this.manifestHref) return;
        this.hasPrefetchedManifest = true;
        const sessionId = this.currentSessionId;
        const manifest = await this.ensureManifest();
        if (!this.isSessionValid(sessionId)) return;
        if (!manifest) {
            this.hasPrefetchedManifest = false;
            return;
        }
        await this.loadSheet(0, sessionId);
        this.tryResolveTarget();
    }

    /**
     * Preload sheets distributed across the manifest
     */
    async startStrategicPreload(): Promise<void> {
        const sessionId = this.currentSessionId;
        const manifest = await this.ensureManifest();
        if (!manifest || !this.isSessionValid(sessionId)) return;
        const count = manifest.sheets.length;
        const sheets =
            count <= 6
                ? manifest.sheets.map((sheet) => sheet.index)
                : [
                      ...new Set([
                          0,
                          Math.floor(count * 0.25),
                          Math.floor(count * 0.5),
                          Math.floor(count * 0.75),
                          count - 1,
                      ]),
                  ].map((position) => manifest.sheets[position].index);

        // Add to background queue (skip sheets already queued/loaded)
        const newSheets = sheets.filter(
            (index) =>
                !this.backgroundPreloadQueue.includes(index) &&
                !this.isSheetCached(index) &&
                !this.failedSpriteSheets.has(index), // background preload skips recently-failed sheets
        );

        if (newSheets.length > 0) {
            this.backgroundPreloadQueue.push(...newSheets);
            void this.processBackgroundQueue();
        }
    }

    /**
     * Clean up all resources
     */
    destroy(): void {
        this.currentSessionId++;
        this.reset();
    }

    // ============================================
    // Private Helpers - Session & State
    // ============================================

    private isSessionValid(sessionId: number): boolean {
        return sessionId === this.currentSessionId;
    }

    private sheetNeedsLoading(index: number): boolean {
        if (this.isSheetCached(index) || this.loadingSheets.has(index)) {
            return false;
        }

        const failedAt = this.failedSpriteSheets.get(index);
        if (failedAt !== undefined) {
            // Allow retry after the cooldown period
            if (Date.now() - failedAt < TrickplayLoader.FAILURE_RETRY_MS) {
                return false;
            }
            // Cooldown expired — allow retry
            this.failedSpriteSheets.delete(index);
        }

        return true;
    }

    private trackBlobUrl(url: string): void {
        if (url.startsWith('blob:')) {
            this.blobUrlsToRevoke.add(url);
        }
    }

    private revokeAllBlobUrls(): void {
        for (const blobUrl of this.blobUrlsToRevoke) {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch {
                /* expected: blob URL may have already been revoked */
            }
        }
        this.blobUrlsToRevoke.clear();
    }

    private reset(): void {
        this.revokeAllBlobUrls();
        this.preloadedSprites.clear();
        this.failedSpriteSheets.clear();
        this.loadingSheets.clear();
        this.backgroundPreloadQueue = [];
        this.pendingTargetIndex = null;
        this.trickplayLoading = false;
        this.hasPrefetchedManifest = false;
        this.manifest = null;
        this.manifestFailedAt = null;
        this.manifestPromise = null;
        this.isBackgroundPreloading = false;
    }

    private log(message: string, ...args: unknown[]): void {
        if (this.debug) {
            console.log(`[TrickplayLoader] ${message}`, ...args);
        }
    }

    // ============================================
    // Private Helpers - Manifest Resources
    // ============================================

    private async ensureManifest(): Promise<TrickplayManifestResponse | null> {
        if (this.manifest) return this.manifest;
        if (this.manifestPromise) return this.manifestPromise;
        if (this.manifestFailedAt !== null && Date.now() - this.manifestFailedAt < 30_000)
            return null;
        if (!this.itemId || !this.manifestHref) return null;
        const sessionId = this.currentSessionId;
        const href = this.manifestHref;
        const request = (async () => {
            try {
                const response = await fetch(href, { priority: 'high' as RequestPriority });
                if (!response.ok) {
                    if (this.isSessionValid(sessionId)) this.manifestFailedAt = Date.now();
                    return null;
                }
                const manifest = TrickplayManifestResponseSchema.parse(await response.json());
                if (!this.isSessionValid(sessionId)) return null;
                this.manifest = manifest;
                this.manifestFailedAt = null;
                this.callbacks.onManifestLoad(manifest);
                return manifest;
            } catch (error) {
                if (this.isSessionValid(sessionId)) this.manifestFailedAt = Date.now();
                this.log('Manifest fetch failed', error);
                return null;
            } finally {
                if (this.isSessionValid(sessionId)) this.manifestPromise = null;
            }
        })();
        this.manifestPromise = request;
        return request;
    }

    private async getSheetHref(index: number): Promise<string | null> {
        const manifest = await this.ensureManifest();
        const href = manifest?.sheets.find((sheet) => sheet.index === index)?.href;
        if (!href) return null;
        // Resolve credentials at use time, including sheets returned by an
        // in-flight manifest request that began before renewal.
        const token = this.manifestHref
            ? new URL(this.manifestHref, 'https://playback.invalid').searchParams.get('grant')
            : null;
        const url = new URL(href, 'https://playback.invalid');
        if (token && url.searchParams.has('grant')) {
            url.searchParams.set('grant', token);
            return url.pathname + url.search + url.hash;
        }
        return href;
    }

    // ============================================
    // Private Helpers - Loading Logic
    // ============================================

    private async waitForIdle(): Promise<void> {
        return new Promise<void>((resolve) => {
            if (!browser) {
                resolve();
                return;
            }
            if ('requestIdleCallback' in window) {
                requestIdleCallback(() => resolve(), {
                    timeout: IDLE_TIMEOUT_MS,
                });
            } else {
                setTimeout(resolve, 50);
            }
        });
    }

    // ============================================
    // Private Helpers - Target Resolution
    // ============================================

    private tryResolveTarget(): void {
        if (this.pendingTargetIndex === null) return;

        const target = this.pendingTargetIndex;

        // Check if already displayed (would be tracked by component)
        // For now, just try to load it
        const cached = this.getCachedUrl(target);
        if (cached) {
            this.callbacks.onImageLoad(target, cached);
            return;
        }

        const failedAt = this.failedSpriteSheets.get(target);
        if (failedAt !== undefined && Date.now() - failedAt < TrickplayLoader.FAILURE_RETRY_MS) {
            this.callbacks.onImageFail(target);
            return;
        }

        if (this.sheetNeedsLoading(target)) {
            void this.loadPendingTarget();
        }
    }

    private async loadPendingTarget(): Promise<void> {
        if (this.trickplayLoading || this.pendingTargetIndex === null) return;

        const target = this.pendingTargetIndex;
        if (!this.sheetNeedsLoading(target)) return;

        this.trickplayLoading = true;
        this.callbacks.onLoadingStateChange(true);

        const sessionId = this.currentSessionId;
        const url = await this.getSheetHref(target);
        if (!this.isSessionValid(sessionId)) return;

        if (!url) {
            this.failedSpriteSheets.set(target, Date.now());
            this.callbacks.onImageFail(target);
            this.trickplayLoading = false;
            this.callbacks.onLoadingStateChange(false);
            return;
        }

        if (!this.sheetNeedsLoading(target)) {
            this.trickplayLoading = false;
            this.callbacks.onLoadingStateChange(false);
            const cached = this.getCachedUrl(target);
            if (cached) this.callbacks.onImageLoad(target, cached);
            return;
        }
        this.loadingSheets.add(target);

        try {
            const response = await fetch(url, {
                priority: 'high' as RequestPriority,
            });

            if (!response.ok || !this.isSessionValid(sessionId)) {
                throw new Error('Load failed');
            }

            const blob = await response.blob();
            if (!this.isSessionValid(sessionId)) return;
            const blobUrl = URL.createObjectURL(blob);
            this.trackBlobUrl(blobUrl);

            this.preloadedSprites.set(target, blobUrl);
            this.loadingSheets.delete(target);

            this.callbacks.onImageLoad(target, blobUrl);
        } catch (e) {
            console.warn('[TrickplayLoader] Failed to load sprite sheet', e);
            if (this.isSessionValid(sessionId)) {
                this.loadingSheets.delete(target);
                this.failedSpriteSheets.set(target, Date.now());
                this.callbacks.onImageFail(target);
            }
        } finally {
            if (this.isSessionValid(sessionId)) {
                this.trickplayLoading = false;
                this.callbacks.onLoadingStateChange(false);

                // Re-check: pendingTargetIndex may have changed during the
                // async fetch.  Without this, the new target sits unrequested
                // until the next mouse event.
                if (this.pendingTargetIndex !== null && this.pendingTargetIndex !== target) {
                    this.tryResolveTarget();
                }
            }
        }
    }

    // ============================================
    // Private Helpers - Background Queue
    // ============================================

    private async processBackgroundQueue(): Promise<void> {
        if (this.isBackgroundPreloading || this.backgroundPreloadQueue.length === 0) {
            return;
        }

        this.isBackgroundPreloading = true;
        const sessionId = this.currentSessionId;

        try {
            await this.waitForIdle();

            while (this.backgroundPreloadQueue.length > 0 && this.isSessionValid(sessionId)) {
                const batch = this.backgroundPreloadQueue.splice(0, MAX_CONCURRENT_PRELOADS);
                await Promise.all(batch.map((index) => this.loadSheet(index, sessionId)));
            }
        } finally {
            if (this.isSessionValid(sessionId)) this.isBackgroundPreloading = false;
        }
    }

    private async loadSheet(index: number, sessionId: number): Promise<void> {
        if (!this.sheetNeedsLoading(index) || !this.isSessionValid(sessionId)) {
            return;
        }

        const url = await this.getSheetHref(index);
        if (!this.isSessionValid(sessionId)) return;
        if (!url || !this.sheetNeedsLoading(index)) return;

        this.loadingSheets.add(index);

        try {
            const response = await fetch(url);
            if (!response.ok || !this.isSessionValid(sessionId)) {
                throw new Error('Load failed');
            }

            const blob = await response.blob();
            if (!this.isSessionValid(sessionId)) return;
            const blobUrl = URL.createObjectURL(blob);

            this.trackBlobUrl(blobUrl);
            this.preloadedSprites.set(index, blobUrl);
            this.loadingSheets.delete(index);

            if (this.pendingTargetIndex === index) {
                this.callbacks.onImageLoad(index, blobUrl);
            }
            this.log(`Sheet ${index} preloaded in background`);
        } catch (e) {
            console.warn('[TrickplayLoader] Failed to preload sprite sheet', e);
            if (this.isSessionValid(sessionId)) {
                this.loadingSheets.delete(index);
                this.failedSpriteSheets.set(index, Date.now());
            }
        }
    }
}
