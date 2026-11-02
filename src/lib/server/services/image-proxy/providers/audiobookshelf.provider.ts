// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AudiobookShelf Image Provider
 *
 * Proxies and disk-caches audiobook cover art.
 *
 * ## Why cache rather than pass through
 *
 * AudiobookShelf caches its own resizes, so this is not about sparing it a
 * second render. Three other reasons decide it:
 *
 * 1. **The catalog already survives an outage.** The `/audiobooks` destination
 *    serves the last-synced rows from `media_items` when AudiobookShelf is
 *    unreachable — stale but working. Uncached covers would leave a grid of
 *    titles with broken images, which reads as *more* broken than being
 *    offline. Caching makes the degraded state coherent.
 * 2. **A cover grid is one request per card.** AudiobookShelf resizes on the
 *    fly on a single-process Node server, and it is frequently reached over
 *    Tailscale or a WAN, so both CPU and latency are paid per card per view.
 * 3. **Invalidation is already solved**, which is usually the hard part — see
 *    the cache key below.
 *
 * ## Trust and SSRF
 *
 * The base URL comes from `AUDIOURL`, which is **operator-configured**, exactly
 * like `JELLYFINURL`. It is deliberately NOT routed through `fetchCustomUrl`'s
 * SSRF guard: that guard exists for attacker-influenceable URLs (M3U ingest,
 * `custom_poster_url`) and rejects RFC1918/loopback — which would break every
 * operator running AudiobookShelf on a LAN address or the same host, i.e. most
 * of them. This mirrors how the Jellyfin provider treats `JELLYFINURL`.
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { restrictImageOptions } from '$lib/server/utils/image-params';
import { requireImageProviderBudget } from '../work-budget';
import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { selectImageFormat } from '$lib/server/utils/image-format';
import { SIZE_PRESET_WIDTHS } from '$lib/server/utils/image-proxy';
import { ImageCache } from '../cache';
import { LRUCache } from '$lib/server/cache/lru-cache.js';
import { discardResponseBody } from '$lib/server/utils/bounded-response.js';
import type { ImageOptions, ImageResponse } from '../types';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from '$lib/server/services/image-proxy/image-sharp';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
const logger = Logger.for('AudiobookshelfImageProvider');

const CACHE_DIR = path.join(process.cwd(), '.cache', 'audiobookshelf');
/**
 * Covers are immutable for a given revision — the key carries `updatedAt`, so a
 * changed cover lands on a different key rather than waiting out a TTL. The TTL
 * is therefore only a floor for reclaiming superseded revisions.
 */
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

class CoverNotFoundError extends Error {}

/**
 * Widths a cover may be rendered at. An arbitrary `maxWidth` is snapped to the
 * nearest, so 481/482/512 do not each get their own file on disk.
 */
const ALLOWED_WIDTHS = [96, 160, 240, 320, 480, 640, 960] as const;

/**
 * Resolve the caller's requested width.
 *
 * Named presets are the canonical request form on the catalog image route
 * (`?size=card`), which carries NO explicit width — reading only `maxWidth`
 * would silently serve every grid card the full-resolution original.
 * `size: 'full'` (and an unknown value) deliberately yields no width, i.e. the
 * untouched cover.
 */
function requestedWidth(options: ImageOptions): number | undefined {
    if (options.maxWidth) {
        const parsed = Number.parseInt(String(options.maxWidth), 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    const size = options.size;
    if (size && size !== 'full' && size in SIZE_PRESET_WIDTHS) {
        return SIZE_PRESET_WIDTHS[size];
    }
    return undefined;
}

function snapWidth(requested: number | undefined): number | null {
    if (!requested || !Number.isFinite(requested) || requested <= 0) return null;
    let best: number = ALLOWED_WIDTHS[0];
    for (const w of ALLOWED_WIDTHS) {
        if (Math.abs(w - requested) < Math.abs(best - requested)) best = w;
    }
    return best;
}

export interface AudiobookCoverRequest {
    /** AudiobookShelf `libraryItemId`. */
    itemId: string;
    /**
     * The item's ABS `updatedAt` (epoch ms) from
     * `custom_metadata.audiobookshelf.updatedAt`.
     *
     * This is the whole invalidation story: AudiobookShelf bumps the item row's
     * `updatedAt` on nested media edits, cover changes included, and the sweep
     * already stores it. Folding it into the cache key means a replaced cover
     * is a cache MISS on the next render rather than a stale image served until
     * a TTL expires. Pass `null` only when genuinely unknown — the key then
     * degrades to TTL-only behaviour.
     */
    revision: number | null;
    /** Complete elected content identity, independent of the requested URL v/tag. */
    contentRevision?: string;
    options?: ImageOptions;
}

export class AudiobookshelfImageProvider {
    private cache: ImageCache;
    // A missing cover is independent of the requested size/format. Keep this
    // short and bounded so restored covers are retried and stale URLs stay cheap.
    private missingCovers = new LRUCache<true>({
        maxSize: 1000,
        defaultTTL: 30_000,
        namespace: 'v1:abs-cover-miss',
    });

    constructor() {
        this.cache = new ImageCache({ directory: CACHE_DIR, ttl: CACHE_TTL });
    }

    isConfigured(): boolean {
        return Boolean(config.AUDIOURL);
    }

    /**
     * `GET /api/items/:id/cover`.
     *
     * `raw=1` asks AudiobookShelf for the untouched file and skips its own
     * resize/convert step: we re-encode locally anyway, so making it render a
     * variant we then discard would waste CPU on its box for nothing.
     */
    private buildUrl(itemId: string): string {
        const base = config.AUDIOURL.replace(/\/+$/, '');
        return joinUpstreamUrl(base, `/api/items/${encodePathSegment(itemId)}/cover?raw=1`);
    }

    private buildCacheKey(
        req: AudiobookCoverRequest,
        width: number | null,
        format: string,
    ): string {
        const revision = req.revision ?? 'norev';
        const content = req.contentRevision
            ? `-content-${createHash('sha256').update(req.contentRevision).digest('hex')}`
            : '';
        return `abs-${req.itemId}-${revision}${content}-${width ?? 'orig'}.${format}`;
    }

    async getCover(req: AudiobookCoverRequest): Promise<ImageResponse | null> {
        if (!this.isConfigured()) return null;

        const missKey = JSON.stringify([
            config.AUDIOURL,
            req.itemId,
            req.revision,
            req.contentRevision ?? null,
        ]);
        if (this.missingCovers.get(missKey)) return null;

        const options = restrictImageOptions(req.options ?? {});
        // Covers are posters — never logos, so transparency is not a concern and
        // the selector's AVIF/WebP preference applies.
        const selection = selectImageFormat('poster', options.format);
        const format = selection.format;
        const width = snapWidth(requestedWidth(options));
        const cacheKey = this.buildCacheKey(req, width, format);

        try {
            const { buffer, wasHit } = await this.cache.getCachedOrFetch(
                cacheKey,
                async () => {
                    const url = this.buildUrl(req.itemId);
                    // The cover endpoint is auth-exempt for GET, but the key is sent
                    // anyway so a hardened deployment (reverse proxy requiring auth)
                    // still works.
                    const headers: Record<string, string> = {};
                    if (config.AUDIOAPIKEY) headers.Authorization = `Bearer ${config.AUDIOAPIKEY}`;

                    // Routed through the same-origin-only redirect guard (C22
                    // fix-plan finding) — AUDIOURL is admin-configured.
                    await requireImageProviderBudget();
                    const response = await fetchWithTimeout(url, { headers });
                    if (!response.ok) {
                        discardResponseBody(response);
                        if (response.status === 404) {
                            this.missingCovers.set(missKey, true);
                            throw new CoverNotFoundError();
                        }
                        throw new Error(
                            `Audiobookshelf cover ${response.status} for ${req.itemId}`,
                        );
                    }
                    const raw = Buffer.from(await response.arrayBuffer());

                    let pipeline = sharp(raw);
                    if (width) pipeline = pipeline.resize({ width, withoutEnlargement: true });
                    if (format === 'avif') return await pipeline.avif().toBuffer();
                    if (format === 'webp') return await pipeline.webp().toBuffer();
                    return await pipeline.jpeg().toBuffer();
                },
                { provider: true, encode: true },
            );

            // No `as ImageResponse` cast here on purpose: the cast previously
            // hid a wrong field name (`wasHit` instead of `cacheStatus`) that
            // typechecked fine and silently reported every read as a miss.
            return {
                buffer,
                contentType: selection.contentType,
                cacheControl: 'public, max-age=86400',
                cacheStatus: wasHit ? 'HIT' : 'MISS',
            };
        } catch (error) {
            if (error instanceof CoverNotFoundError) {
                logger.debug('Audiobookshelf cover not found', { itemId: req.itemId });
                return null;
            }
            logger.error('Audiobookshelf cover fetch failed', error as Error, {
                itemId: req.itemId,
            });
            return null;
        }
    }
}
