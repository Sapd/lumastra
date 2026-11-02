// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Universal Media ID Resolution Service
 *
 * Resolves any media ID format (internal UUID, composite keys, or a legacy
 * Jellyfin item id still mapped in `external_ids`) to the internal UUID.
 *
 * Features:
 * - L1 (in-memory LRU) + L2 (Valkey) caching
 * - Canonical ID chain following (merged media)
 * - TMDB ID collision handling (requires mediaType)
 * - Comprehensive edge case handling
 */

import { LRUCache } from '$lib/server/cache/lru-cache.js';
import { getValkeyClient } from '$lib/server/cache/valkey.js';
import { TimeUnit } from '@valkey/valkey-glide';
import { getDb } from '$lib/server/database/connection.js';
import {
    resolveMediaIdByProvider,
    resolveJellyfinIdToMediaId,
    getMediaExternalIds,
} from '$lib/server/database/queries/media-queries.js';
import { parseMediaId, type ParsedMediaId } from '$lib/server/utils/media-key-parser.js';
import type { ResolvedIds, ResolveOptions, ResolutionStats } from './media-id-resolver.types.js';
import { Logger } from '$lib/server/utils/logger.js';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
import type { Sql } from 'postgres';
import { UUID_RE_LOOSE as UUID_REGEX } from '$lib/utils/id-patterns.js';

import { parseVirtualSeasonHandle, type VirtualSeasonHandle } from './media-handle.js';

export interface VirtualSeasonResolvedIds extends ResolvedIds {
    kind: 'virtualSeason';
    virtualSeason: VirtualSeasonHandle;
}

const logger = Logger.for('MediaIdResolver');

type SqlAny = Sql<Record<string, unknown>>;

/**
 * L1 Cache Configuration (in-memory LRU)
 */
const L1_CACHE_MAX_SIZE = 10_000;
const L1_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * L2 Cache Configuration (Valkey/Redis). Keys are `media_id:v2:<id>`; `v2`
 * since resolved ids stopped carrying a Jellyfin id.
 */
const L2_CACHE_TTL_SECONDS = 300; // 5 minutes base
const L2_CACHE_TTL_JITTER_SECONDS = 60; // +0-60s jitter

/**
 * Negative result cache (L1 only, shorter TTL)
 */
const NEGATIVE_CACHE_TTL_MS = 45_000; // 30-60s range

/**
 * Resolution limits
 */
const MAX_CANONICAL_HOPS = 5;
const RESOLUTION_TIMEOUT_MS = 2000;

/**
 * L1 Cache (in-memory LRU)
 */
const l1Cache = new LRUCache<ResolvedIds | null>({
    maxSize: L1_CACHE_MAX_SIZE,
    defaultTTL: L1_CACHE_TTL_MS,
    namespace: 'media_id_resolver',
});

/**
 * Resolution statistics
 */
const stats: ResolutionStats = {
    totalResolutions: 0,
    cacheHitRateL1: 0,
    cacheHitRateL2: 0,
    avgResolutionTimeMs: 0,
    resolutionsBySource: {
        uuid: 0,
        jellyfin: 0,
        composite: 0,
    },
    errors: {
        invalidFormat: 0,
        notFound: 0,
        timeout: 0,
    },
};

let l1Hits = 0;
let l2Hits = 0;

/**
 * Normalize UUID to dashed canonical form (lowercase with dashes)
 */
function normalizeUuid(uuid: string): string {
    const stripped = uuid.replace(/-/g, '');
    return `${stripped.slice(0, 8)}-${stripped.slice(8, 12)}-${stripped.slice(12, 16)}-${stripped.slice(16, 20)}-${stripped.slice(20)}`.toLowerCase();
}

/**
 * Check if a string is a valid UUID format
 */
function isUuid(value: string): boolean {
    return UUID_REGEX.test(value);
}

/**
 * Normalize ID for cache key (consistent caching across formats).
 *
 * Provider IDs are NOT unique across media types — e.g. a movie and a TV
 * series can share the same IMDB/TMDB ID. Inputs that already encode the type
 * (e.g. `tmdb:550:movie`) are qualified with a `::type` suffix so the two
 * types occupy distinct cache slots.
 *
 * Bare inputs are NOT qualified, and intentionally so: the read path consults
 * the key BEFORE resolution (when the type is still unknown), so any
 * qualification we could only apply post-resolution on the write path would
 * store the value under a slot the next read never consults — a guaranteed
 * miss. A bare UUID is the internal PK and resolves to exactly one item, so it
 * cannot collide cross-type. Type-less composites (e.g. `imdb:tt0137523`)
 * resolve via a type-agnostic `LIMIT 1` lookup, so qualifying their write key
 * would not change which item a subsequent read returns anyway.
 *
 * @param rawId - The raw input ID
 * @param mediaType - Resolved/known media type to scope the key by, if any
 */
// Indexed access rather than a repeated literal union, so this stays in step
// with ResolvedIds.mediaType. Episodes and seasons must be able to qualify a
// cache key: TMDB ids collide across types, which is the whole reason this
// function appends a type segment.
function normalizeCacheKey(rawId: string, mediaType?: ResolvedIds['mediaType']): string {
    const trimmed = rawId.trim().toLowerCase();

    // Normalize UUIDs to dashed format
    let base: string;
    if (isUuid(trimmed)) {
        base = normalizeUuid(trimmed);
    } else {
        // Composite keys are already normalized
        base = trimmed;
    }

    // Scope by media type when known so cross-type ID collisions can't share a
    // cache slot. We only append when the base doesn't already end in the type
    // segment (e.g. `tmdb:550:movie` already carries it) to avoid double tags.
    if (mediaType && !base.endsWith(`:${mediaType}`)) {
        return `${base}::${mediaType}`;
    }
    return base;
}

/**
 * Get staggered TTL for L2 cache (prevents cache stampede)
 */
function getStaggeredTtl(): number {
    return L2_CACHE_TTL_SECONDS + Math.floor(Math.random() * L2_CACHE_TTL_JITTER_SECONDS);
}

/**
 * Get negative result TTL (L1 only, shorter TTL)
 */
function getNegativeCacheTtl(): number {
    return NEGATIVE_CACHE_TTL_MS + Math.floor(Math.random() * 15_000); // 30-45s
}

/**
 * Cache result in L1 and L2
 */
async function cacheResult(
    key: string,
    result: ResolvedIds | null,
    isNegative = false,
): Promise<void> {
    try {
        if (isNegative) {
            // Negative results: L1 only with shorter TTL
            l1Cache.set(key, result, getNegativeCacheTtl());
        } else {
            // Positive results: L1 + L2
            l1Cache.set(key, result);

            // L2 (Valkey)
            const valkey = getValkeyClient();
            if (valkey && result) {
                const cacheKey = `media_id:v2:${key}`;
                const ttl = getStaggeredTtl();
                await valkey.set(cacheKey, JSON.stringify(result), {
                    expiry: { type: TimeUnit.Seconds, count: ttl },
                });
            }
        }
    } catch (error) {
        logger.warn('Failed to cache result', { key, error });
        // Non-fatal, continue
    }
}

/**
 * Check L2 cache (Valkey)
 */
async function checkL2Cache(key: string): Promise<ResolvedIds | null> {
    try {
        const valkey = getValkeyClient();
        if (!valkey) return null;

        const cacheKey = `media_id:v2:${key}`;
        const cached = await valkey.get(cacheKey);

        if (cached) {
            l2Hits++;
            const jsonString = typeof cached === 'string' ? cached : cached.toString();
            return JSON.parse(jsonString) as ResolvedIds;
        }

        return null;
    } catch (error) {
        logger.warn('Failed to check L2 cache', { key, error });
        return null;
    }
}

/**
 * Follow canonical_id chain to get final media ID
 */
async function followCanonicalChain(
    sql: SqlAny,
    startId: string,
    maxHops: number,
): Promise<{ finalId: string; wasCanonicalized: boolean }> {
    let currentId = startId;
    let hops = 0;
    let wasCanonicalized = false;

    while (hops < maxHops) {
        const rows = await sql<{ canonical_id: string | null }[]>`
            SELECT canonical_id FROM media_items
            WHERE id = ${currentId}
            LIMIT 1
        `;

        if (rows.length === 0 || !rows[0].canonical_id) {
            break;
        }

        // Follow chain
        currentId = rows[0].canonical_id;
        wasCanonicalized = true;
        hops++;
    }

    if (hops >= maxHops) {
        logger.warn('Canonical chain exceeded max hops', {
            startId,
            finalId: currentId,
            maxHops,
        });
    }

    return { finalId: currentId, wasCanonicalized };
}

/**
 * Resolve a UUID-shaped id: the internal UUID, or a legacy Jellyfin item id
 * mapped through `external_ids`.
 */
async function resolveUuid(
    sql: SqlAny,
    uuid: string,
    options: ResolveOptions,
): Promise<ResolvedIds | null> {
    const normalizedUuid = normalizeUuid(uuid);

    // Check if it's an internal UUID (media_items)
    const mediaInfo = await getMediaExternalIds(sql, normalizedUuid);

    if (mediaInfo) {
        // Internal UUID found
        let finalId = mediaInfo.internalId;
        let wasCanonicalized = false;

        // Follow canonical_id chain if set
        if (mediaInfo.canonicalId) {
            const result = await followCanonicalChain(
                sql,
                mediaInfo.internalId,
                options.maxCanonicalHops || MAX_CANONICAL_HOPS,
            );
            finalId = result.finalId;
            wasCanonicalized = result.wasCanonicalized;

            // Re-fetch external IDs for canonical ID
            if (wasCanonicalized) {
                const canonicalInfo = await getMediaExternalIds(sql, finalId);
                if (canonicalInfo) {
                    return {
                        internalId: canonicalInfo.internalId,
                        externalIds: canonicalInfo.externalIds,
                        source: 'uuid',
                        mediaType: canonicalInfo.mediaType,
                        wasCanonicalized: true,
                        inputId: uuid,
                    };
                }
            }
        }

        return {
            internalId: finalId,
            externalIds: mediaInfo.externalIds,
            source: 'uuid',
            mediaType: mediaInfo.mediaType,
            wasCanonicalized,
            inputId: uuid,
        };
    }

    // Not in media_items. An older client may still hold a Jellyfin item id
    // that an earlier server version handed out; map it through the
    // `external_ids` rows Jellyfin sync keeps (a database lookup only, nothing
    // calls Jellyfin). On a standalone install there are no such rows and the
    // id is simply not found. An unknown id is NOT guessed to be a Jellyfin
    // item any more: it is "not found".
    //
    // The middleware entry point (`withIdResolution`) resolves a bare `[id]`
    // param with no media-type context. On the rare case where a Jellyfin ID
    // spans multiple media types, `resolveJellyfinIdToMediaId` fails closed
    // (returns null + warns) rather than guessing an arbitrary item.
    const internalId = await resolveJellyfinIdToMediaId(sql, normalizedUuid);

    if (internalId) {
        let resolvedInfo = await getMediaExternalIds(sql, internalId);
        let wasCanonicalized = false;

        // A merged item forwards to its canonical item, exactly like the
        // internal-UUID path above.
        if (resolvedInfo?.canonicalId) {
            const result = await followCanonicalChain(
                sql,
                resolvedInfo.internalId,
                options.maxCanonicalHops || MAX_CANONICAL_HOPS,
            );
            if (result.wasCanonicalized) {
                wasCanonicalized = true;
                resolvedInfo = await getMediaExternalIds(sql, result.finalId);
            }
        }

        // Only an active item answers a legacy id: a deleted (or dangling
        // merged) row is "not found", never a stale hit.
        if (resolvedInfo && resolvedInfo.status === 'active') {
            return {
                internalId: resolvedInfo.internalId,
                externalIds: resolvedInfo.externalIds,
                source: 'jellyfin',
                mediaType: resolvedInfo.mediaType,
                wasCanonicalized,
                inputId: uuid,
            };
        }
    }

    logger.debug('UUID not found in database', { inputId: uuid });
    return null;
}

/**
 * Resolve composite key (provider:id:mediaType)
 */
async function resolveComposite(sql: SqlAny, parsed: ParsedMediaId): Promise<ResolvedIds | null> {
    const { provider, externalId, mediaType } = parsed;

    if (!provider || !externalId) {
        throw new Error('Invalid composite key: missing provider or externalId');
    }

    // TMDB MUST have mediaType
    if (provider === 'tmdb' && !mediaType) {
        throw new Error('TMDB requires format tmdb:id:movie or tmdb:id:tv (mediaType required)');
    }

    // Only pass mediaType for TMDB (other providers don't use it). No cast: the
    // token may legitimately be 'episode' or 'season', and it is matched
    // verbatim against external_ids.media_type, which holds those rows.
    const lookupMediaType = provider === 'tmdb' ? mediaType : undefined;

    // Resolve external ID to internal UUID
    const internalId = await resolveMediaIdByProvider(sql, provider, externalId, lookupMediaType);

    if (!internalId) {
        // Not in local DB - for TMDB, allow partial resolution (routes can fetch from API)
        if (provider === 'tmdb' && mediaType) {
            return {
                internalId: null,
                externalIds: {
                    [provider]: externalId,
                },
                source: 'composite',
                // No cast: ResolvedIds.mediaType admits all four tokens, so the
                // real one flows through. Casting here would narrow it back to a
                // lie and hand callers 'episode' disguised as 'movie' | 'tv'.
                mediaType,
                inputId: `${provider}:${externalId}:${mediaType}`,
            };
        }
        // Other providers require local mapping
        return null;
    }

    // Fetch all external IDs
    const mediaInfo = await getMediaExternalIds(sql, internalId);

    if (!mediaInfo) {
        return null;
    }

    return {
        internalId: mediaInfo.internalId,
        externalIds: mediaInfo.externalIds,
        source: 'composite',
        mediaType: mediaInfo.mediaType,
        inputId: `${provider}:${externalId}${mediaType ? `:${mediaType}` : ''}`,
    };
}

/**
 * MediaIdResolver Service
 */
export class MediaIdResolver {
    /**
     * Resolve any ID format to all available ID types
     */
    async resolveAnyMediaId(
        rawId: string,
        options: ResolveOptions = {},
    ): Promise<ResolvedIds | VirtualSeasonResolvedIds> {
        const startTime = Date.now();
        stats.totalResolutions++;

        try {
            // Validate input
            const trimmedId = rawId.trim();
            if (!trimmedId) {
                stats.errors.invalidFormat++;
                throw new Error('Media ID is required');
            }

            if (trimmedId.startsWith('vseason:')) {
                const virtualSeason = parseVirtualSeasonHandle(trimmedId);
                if (!virtualSeason || virtualSeason.ordering === 'standard') {
                    throw new Error(`Invalid media ID format: ${rawId}`);
                }
                const series = await this.resolveAnyMediaId(virtualSeason.seriesUuid, options);
                if (!series.internalId || !['tv', 'series'].includes(series.mediaType ?? '')) {
                    throw new Error(`Media not found: ${rawId}`);
                }
                return {
                    kind: 'virtualSeason',
                    virtualSeason,
                    internalId: null,
                    mediaType: 'season',
                    source: 'composite',
                    inputId: trimmedId,
                };
            }

            // Parse ID format up front so we can derive a type-scoped cache
            // key. The media type is only known ahead of resolution when the
            // input itself carries it (e.g. `tmdb:550:movie`); for bare UUIDs
            // and type-less composites it stays undefined here and the entry is
            // cached under the unqualified key (read and write must agree).
            const parsed = parseMediaId(trimmedId);
            // Collapse to the movie/tv axis the cache keys are scoped by
            // (episode/season are tv for identity purposes). parsed.mediaType is a
            // ParsedMediaTypeToken ('movie' | 'series' | 'episode' | 'season' |
            // 'tv') — every member maps onto a TMDB namespace, so toTmdbMediaType
            // never actually returns null here; `?? undefined` only reconciles its
            // generically nullable signature with this variable's `| undefined`
            // (not `| null`) type.
            const inputMediaType: 'movie' | 'tv' | undefined =
                parsed.type === 'composite' && parsed.mediaType
                    ? (toTmdbType(parsed.mediaType) ?? undefined)
                    : undefined;

            // Normalize for caching, scoped by any media type the input encodes.
            const cacheKey = normalizeCacheKey(trimmedId, inputMediaType);

            // Check L1 cache
            const l1Result = l1Cache.get(cacheKey);
            if (l1Result !== undefined) {
                l1Hits++;
                stats.cacheHitRateL1 = l1Hits / stats.totalResolutions;

                // Null means negative result (cached unresolvable ID)
                // Don't throw - let the resolver try again (cache entry will expire)
                if (l1Result === null) {
                    logger.debug('Cached negative result, will re-resolve', {
                        rawId,
                    });
                    // Fall through to re-resolve
                } else {
                    return l1Result;
                }
            }

            // Check L2 cache (Valkey)
            const l2Result = await checkL2Cache(cacheKey);
            if (l2Result) {
                // Backfill L1
                l1Cache.set(cacheKey, l2Result);
                stats.cacheHitRateL2 = l2Hits / stats.totalResolutions;
                return l2Result;
            }

            // Get database connection
            const sql = getDb();
            if (!sql) {
                throw new Error('Database connection not available');
            }

            // Resolve based on type
            let result: ResolvedIds | null = null;

            if (parsed.type === 'uuid' && parsed.uuid) {
                stats.resolutionsBySource.uuid++;
                result = await resolveUuid(sql, parsed.uuid, options);
            } else if (parsed.type === 'composite') {
                stats.resolutionsBySource.composite++;
                result = await resolveComposite(sql, parsed);
            } else {
                stats.errors.invalidFormat++;
                throw new Error(
                    `Invalid media ID format: ${rawId} (expected UUID or provider:id:mediaType)`,
                );
            }

            // Cache result
            if (result) {
                // Write under the SAME key the read path consulted. The read
                // key (`cacheKey`) is computed from whatever type the input
                // itself carried: type-bearing inputs (e.g. `tmdb:550:movie`)
                // are already `::type`-qualified at read time, while bare UUIDs
                // and type-less composites use the unqualified key. Qualifying
                // the write key by the *resolved* type would store the value
                // under a slot the next read never consults — guaranteeing a
                // miss on the hottest (UUID-first) path. Bare UUIDs are the
                // internal PK and resolve to exactly one item, so they cannot
                // collide cross-type and never needed qualification.
                await cacheResult(cacheKey, result, false);

                if (result.wasCanonicalized && result.internalId) {
                    const canonicalKey = normalizeCacheKey(result.internalId, result.mediaType);
                    if (canonicalKey !== cacheKey) {
                        await cacheResult(canonicalKey, result, false);
                    }
                }

                // Update stats
                const duration = Date.now() - startTime;
                stats.avgResolutionTimeMs =
                    (stats.avgResolutionTimeMs * (stats.totalResolutions - 1) + duration) /
                    stats.totalResolutions;

                return result;
            } else {
                // Not found - cache negative result (L1 only)
                stats.errors.notFound++;
                if (options.cacheNegative !== false) {
                    await cacheResult(cacheKey, null, true);
                }
                throw new Error(`Media not found: ${rawId}`);
            }
        } catch (error) {
            const duration = Date.now() - startTime;

            // Check for timeout
            if (duration > RESOLUTION_TIMEOUT_MS) {
                stats.errors.timeout++;
                logger.warn('Resolution timeout', { rawId, duration });
            }

            throw error;
        }
    }

    /**
     * Batch resolution for multiple IDs (performance optimization)
     */
    async resolveBatch(rawIds: string[]): Promise<Map<string, ResolvedIds>> {
        const results = new Map<string, ResolvedIds>();

        // Resolve in parallel
        const promises = rawIds.map(async (id) => {
            try {
                const resolved = await this.resolveAnyMediaId(id);
                results.set(id, resolved);
            } catch (error) {
                // Skip failed resolutions
                logger.debug('Failed to resolve in batch', { id, error });
            }
        });

        await Promise.all(promises);

        return results;
    }

    /**
     * Invalidate cache for specific ID
     */
    async invalidate(rawId: string): Promise<void> {
        try {
            // An entry may live under the bare key (UUID / type-less input) or
            // a `::type`-qualified key (type-bearing composite). Clear the bare
            // key plus both type variants to fully evict it regardless.
            const cacheKeys = [
                normalizeCacheKey(rawId),
                normalizeCacheKey(rawId, 'movie'),
                normalizeCacheKey(rawId, 'tv'),
            ];

            // Clear L1
            for (const key of cacheKeys) {
                l1Cache.delete(key);
            }

            // Clear L2 (Valkey)
            const valkey = getValkeyClient();
            if (valkey) {
                await valkey.del(cacheKeys.map((key) => `media_id:v2:${key}`));
            }

            logger.debug('Invalidated cache', { rawId, cacheKeys });
        } catch (error) {
            logger.warn('Failed to invalidate cache', { rawId, error });
        }
    }

    /**
     * Get resolution stats (cache hit rate, timing)
     */
    getStats(): ResolutionStats {
        return { ...stats };
    }

    /**
     * Reset stats (for testing)
     */
    resetStats(): void {
        stats.totalResolutions = 0;
        stats.cacheHitRateL1 = 0;
        stats.cacheHitRateL2 = 0;
        stats.avgResolutionTimeMs = 0;
        stats.resolutionsBySource = { uuid: 0, jellyfin: 0, composite: 0 };
        stats.errors = { invalidFormat: 0, notFound: 0, timeout: 0 };
        l1Hits = 0;
        l2Hits = 0;
    }
}

/**
 * Singleton instance
 */
export const mediaIdResolver = new MediaIdResolver();

// Lookup-only, access-scoped SQL batching for catalog hydration (no per-ID resolver calls).
export { resolveCatalogMediaBatch } from './media-id-resolver-batch.js';
