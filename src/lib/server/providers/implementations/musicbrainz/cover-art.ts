// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cover Art Archive Integration
 *
 * Fetches album artwork from the Cover Art Archive (coverartarchive.org).
 * No API key required. Free, unlimited access.
 *
 * Implements a byte-bounded in-memory cache with TTL to avoid redundant requests.
 */

import { safeFetch as upstreamSafeFetch } from '$lib/server/tasks/url-safety.js';
import { withProviderCallScope } from '$lib/server/utils/provider-calls.js';

import { Logger } from '$lib/server/utils/logger.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
import {
    readBoundedResponseBytes,
    readBoundedResponseJson,
} from '$lib/server/utils/bounded-response.js';
const safeFetch: typeof upstreamSafeFetch = (...args) =>
    withProviderCallScope('coverartarchive', () => upstreamSafeFetch(...args));

const logger = Logger.for('CoverArtArchive');

const CAA_BASE_URL = 'https://coverartarchive.org';
const REQUEST_TIMEOUT_MS = 15000;
/** Cover Art Archive images come from archive.org mirrors a release uploader chose. */
const MAX_COVER_BYTES = 20 * 1024 * 1024;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
/**
 * Redirect hops followed before giving up. A 6th redirect is rejected.
 *
 * Security review 2026-09-12, P1: both CAA calls used to go out through a bare
 * `fetch`, which follows redirects itself with no further checks — so the
 * one-time SSRF check on the image URL only ever covered the FIRST hop, and a
 * 302 could walk the request onto a link-local or RFC1918 address. `safeFetch`
 * re-validates every hop (and pins each to its pre-resolved address) instead.
 */
const MAX_REDIRECT_HOPS = 5;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Cache
// =============================================================================

/**
 * This cache holds decoded image BYTES, so it is bounded by bytes rather than
 * by entry count. The distinction matters: a front cover is routinely 0.5–2 MB,
 * so an entry-capped cache (the shared `LRUCache` helper, default 500) would
 * still be free to hold well over a gigabyte on a 2 GiB pod.
 *
 * Expiry alone does not bound it either. Entries were only ever dropped when
 * something looked the same key up again, and both callers walk a library —
 * `album-enrichment` and the file scanner's audio processor key by MusicBrainz
 * release ID, so a bulk pass visits each key once and never returns. Every
 * image fetched stayed resident for the lifetime of the process.
 *
 * The cache still earns its place: the audio processor runs per TRACK, so all
 * tracks of one album hit the same `release:` key and would otherwise re-download
 * the same artwork once per track.
 */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Secondary bound: negative results weigh 0 bytes, so bytes alone can't cap them. */
const CACHE_MAX_ENTRIES = 512;

interface CacheEntry {
    value: CoverArtResult | null;
    expiresAt: number;
    /** `value.buffer.length`, or 0 for a negative result. */
    bytes: number;
}

/** Insertion-ordered, so the first key is always the least recently used. */
const cache = new Map<string, CacheEntry>();
let cachedBytes = 0;

function dropEntry(key: string, entry: CacheEntry): void {
    cache.delete(key);
    cachedBytes -= entry.bytes;
}

function getCached(key: string): CoverArtResult | null | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        dropEntry(key, entry);
        return undefined;
    }
    // Re-insert to mark most-recently-used, so the album currently being
    // scanned survives eviction pressure from the albums around it.
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
}

function setCached(key: string, value: CoverArtResult | null): void {
    const bytes = value?.buffer.length ?? 0;

    // A single image larger than the whole budget can never be held without
    // evicting everything else and still overflowing, so decline it outright
    // rather than letting the eviction loop below empty the cache for it.
    if (bytes > CACHE_MAX_BYTES) {
        const existing = cache.get(key);
        if (existing) dropEntry(key, existing);
        return;
    }

    const existing = cache.get(key);
    if (existing) dropEntry(key, existing);

    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS, bytes });
    cachedBytes += bytes;

    // Expired entries first — they are dead weight regardless of recency.
    const now = Date.now();
    for (const [k, entry] of cache) {
        if (now > entry.expiresAt) dropEntry(k, entry);
    }

    // Then evict least-recently-used until back under both bounds. The entry
    // just inserted is the most recent, so it is the last candidate; the guard
    // above guarantees the loop clears the bounds before reaching it.
    while (cachedBytes > CACHE_MAX_BYTES || cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.entries().next();
        if (oldest.done) break;
        dropEntry(oldest.value[0], oldest.value[1]);
    }
}

/** Test seam: lets the suite assert eviction without exporting the Map itself. */
export function __cacheStatsForTest(): { entries: number; bytes: number } {
    return { entries: cache.size, bytes: cachedBytes };
}

/** Test seam: the cache is module state and would otherwise leak across cases. */
export function __clearCacheForTest(): void {
    cache.clear();
    cachedBytes = 0;
}

// =============================================================================
// Interfaces
// =============================================================================

export interface CoverArtResult {
    buffer: Buffer;
    contentType: string;
}

interface CoverArtArchiveImage {
    types: string[];
    front: boolean;
    back: boolean;
    image: string;
    thumbnails: {
        small?: string;
        large?: string;
        '250'?: string;
        '500'?: string;
        '1200'?: string;
    };
}

interface CoverArtArchiveResponse {
    images: CoverArtArchiveImage[];
    release: string;
}

// =============================================================================
// Internal Helpers
// =============================================================================

async function fetchImageBuffer(url: string): Promise<CoverArtResult | null> {
    try {
        const response = await safeFetch(
            url,
            { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
            { maxRedirects: MAX_REDIRECT_HOPS },
        );
        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') ?? 'image/jpeg';
        const buffer = await readBoundedResponseBytes(response, MAX_COVER_BYTES);
        return {
            buffer,
            contentType,
        };
    } catch (error) {
        logger.warn('Cover art image fetch failed', { url }, error as Error);
        return null;
    }
}

async function fetchCoverArtForResource(
    resourceType: 'release' | 'release-group',
    mbid: string,
): Promise<CoverArtResult | null> {
    const indexUrl = `${CAA_BASE_URL}/${resourceType}/${encodePathSegment(mbid)}`;

    try {
        const response = await safeFetch(
            indexUrl,
            { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
            { maxRedirects: MAX_REDIRECT_HOPS },
        );

        if (response.status === 404) return null;

        if (!response.ok) {
            logger.warn('Cover Art Archive index fetch failed', {
                mbid,
                resourceType,
                status: response.status,
            });
            return null;
        }

        const data = (await readBoundedResponseJson(
            response,
            MAX_INDEX_BYTES,
        )) as CoverArtArchiveResponse;
        const frontImage = data.images.find((img) => img.front) ?? data.images[0];
        if (!frontImage) return null;

        const imageUrl =
            frontImage.thumbnails['500'] ?? frontImage.thumbnails.large ?? frontImage.image;

        // Chained-SSRF guard: the URL is returned by the trusted CAA API but
        // we still validate it. A compromised CDN entry could otherwise point
        // us at link-local / RFC1918 addresses.
        try {
            const { assertNotPrivateUrl } = await import('$lib/server/utils/ssrf-guard.js');
            await assertNotPrivateUrl(new URL(imageUrl));
        } catch (err) {
            logger.warn(
                'Cover Art Archive image URL rejected by SSRF guard',
                { mbid, resourceType, imageUrl },
                err as Error,
            );
            return null;
        }

        return fetchImageBuffer(imageUrl);
    } catch (error) {
        logger.warn('Cover Art Archive request failed', { mbid, resourceType }, error as Error);
        return null;
    }
}

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Fetch album art buffer for a MusicBrainz release ID.
 * Falls back to the release group if the release has no art.
 * Results are cached for 5 minutes.
 *
 * Either id may be absent. A blank release id skips the release lookup and is
 * NEVER used as a cache key: album-enrichment calls this with only a release
 * group (one stored by the acoustid-fingerprint stage) and used to pass `''`,
 * so every such album shared the key `release:` and got the cover of the first
 * one looked up for the next five minutes. On prod (2026-10-01) that put one
 * album's cover on ~30 others per streak, ~1,000 albums in all (Nelly
 * Furtado's "Promiscuous" showed Michael Jackson's "In the Closet").
 */
export async function getAlbumArt(
    releaseMbid: string | null | undefined,
    releaseGroupMbid?: string | null,
): Promise<CoverArtResult | null> {
    const release = releaseMbid?.trim() || null;
    const releaseGroup = releaseGroupMbid?.trim() || null;
    const cacheKey = release ? `release:${release}` : null;

    if (cacheKey) {
        const cached = getCached(cacheKey);
        if (cached !== undefined) return cached;
    }

    let result = release ? await fetchCoverArtForResource('release', release) : null;

    if (!result && releaseGroup) {
        const rgKey = `release-group:${releaseGroup}`;
        const rgCached = getCached(rgKey);
        if (rgCached !== undefined) {
            // Aliases one buffer under two keys, so its bytes are counted twice
            // against the budget. That errs toward evicting early, which is the
            // safe direction for a bound that exists to cap resident memory.
            if (cacheKey) setCached(cacheKey, rgCached);
            return rgCached;
        }
        result = await fetchCoverArtForResource('release-group', releaseGroup);
        setCached(rgKey, result);
    }

    if (cacheKey) setCached(cacheKey, result);
    return result;
}

/**
 * Returns the direct Cover Art Archive URL for a release.
 * Useful for frontend img src attributes (no server-side proxying needed).
 */
export function getAlbumArtUrl(releaseMbid: string): string {
    return `${CAA_BASE_URL}/release/${encodePathSegment(releaseMbid)}/front`;
}
