// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External ID Composite Key Utilities (formerly TMDB Composite Key)
 *
 * CRITICAL: External IDs are NOT unique across media types!
 * The same provider ID can refer to BOTH a movie AND a TV show.
 *
 * Examples of collisions:
 * - TMDB ID 1429 = "25th Hour" (movie) AND "Attack on Titan" (TV show)
 * - TMDB ID 119051 = "Wednesday" (movie) AND "Wednesday" (TV show)
 *
 * This module provides type-safe utilities to prevent external ID collision bugs:
 * - ExternalIdKey: Branded type that can only be created via createExternalIdKey()
 * - ExternalIdMap<T>: Type-safe Map that enforces composite keys
 * - ExternalIdSet: Type-safe Set that enforces composite keys
 *
 * Usage:
 * ```typescript
 * import { createExternalIdKey, ExternalIdMap, ExternalIdSet } from '$lib/server/utils/tmdb-composite-key';
 *
 * // Instead of: const map = new Map<number, string>();
 * const map = new ExternalIdMap<string>();
 * map.set(providerId, mediaType, jellyfinId);
 * const id = map.get(providerId, mediaType);
 *
 * // Instead of: const set = new Set<number>();
 * const set = new ExternalIdSet();
 * set.add(providerId, mediaType);
 * if (set.has(providerId, mediaType)) { ... }
 * ```
 */

// Branded type for compile-time safety
declare const ExternalIdKeyBrand: unique symbol;

/**
 * A branded string type that represents an external ID composite key.
 * Can only be created via the createExternalIdKey() function.
 */
export type ExternalIdKey = string & {
    readonly [ExternalIdKeyBrand]: true;
};

/**
 * Media type for external ID items
 */
export type ExternalIdMediaType = 'movie' | 'tv';

/**
 * @deprecated Use ExternalIdMediaType
 */
export type TmdbMediaType = ExternalIdMediaType;

import { isMovie, isSeries } from './media-types.js';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';

/**
 * Parsed components of an external ID composite key
 */
export interface ExternalIdKeyComponents {
    provider_id: number;
    media_type: ExternalIdMediaType;
}

/**
 * Create a composite key from external provider ID and media type.
 * This is the ONLY way to create an ExternalIdKey.
 *
 * @example
 * const key = createExternalIdKey(1429, 'movie'); // "1429:movie"
 * const key = createExternalIdKey(1429, 'tv');    // "1429:tv"
 */
export function createExternalIdKey(
    providerId: number,
    mediaType: ExternalIdMediaType,
): ExternalIdKey {
    return `${providerId}:${mediaType}` as ExternalIdKey;
}

/**
 * @deprecated Use createExternalIdKey
 */
export function tmdbKey(tmdbId: number, mediaType: ExternalIdMediaType): ExternalIdKey {
    return createExternalIdKey(tmdbId, mediaType);
}

/**
 * Parse a composite key string back to its components.
 * Returns null if the key is invalid.
 */
export function parseExternalIdKey(key: string): ExternalIdKeyComponents | null {
    const colonIndex = key.lastIndexOf(':');
    if (colonIndex === -1) return null;

    const providerIdStr = key.substring(0, colonIndex);
    const mediaType = key.substring(colonIndex + 1);

    const provider_id = Number.parseInt(providerIdStr, 10);
    if (isNaN(provider_id)) return null;

    // Normalize to canonical ExternalIdMediaType ('movie' | 'tv')
    if (isMovie(mediaType)) return { provider_id, media_type: 'movie' };
    if (isSeries(mediaType)) return { provider_id, media_type: 'tv' };
    return null;
}

/**
 * @deprecated Use parseExternalIdKey
 */
export function parseTmdbKey(
    key: string,
): { tmdb_id: number; media_type: ExternalIdMediaType } | null {
    const parsed = parseExternalIdKey(key);
    if (!parsed) return null;
    return {
        tmdb_id: parsed.provider_id,
        media_type: parsed.media_type,
    };
}

/**
 * Type-safe Map for external ID lookups that enforces composite keys.
 *
 * Prevents the common bug of using only providerId as key, which causes
 * collisions when the same ID exists for both movie and TV.
 *
 * @example
 * const jellyfinMap = new ExternalIdMap<string>();
 *
 * // Adding items
 * jellyfinMap.set(providerId, mediaType, jellyfinId);
 *
 * // Looking up
 * const id = jellyfinMap.get(providerId, mediaType);
 * if (jellyfinMap.has(providerId, mediaType)) { ... }
 */
export class ExternalIdMap<T> {
    private readonly map = new Map<ExternalIdKey, T>();

    /**
     * Set a value for the given provider ID and media type
     */
    set(providerId: number, mediaType: ExternalIdMediaType, value: T): this {
        this.map.set(createExternalIdKey(providerId, mediaType), value);
        return this;
    }

    /**
     * Set a value using a pre-computed composite key
     */
    setByKey(key: ExternalIdKey, value: T): this {
        this.map.set(key, value);
        return this;
    }

    /**
     * Get a value for the given provider ID and media type
     */
    get(providerId: number, mediaType: ExternalIdMediaType): T | undefined {
        return this.map.get(createExternalIdKey(providerId, mediaType));
    }

    /**
     * Get a value using a pre-computed composite key
     */
    getByKey(key: ExternalIdKey): T | undefined {
        return this.map.get(key);
    }

    /**
     * Check if a value exists for the given provider ID and media type
     */
    has(providerId: number, mediaType: ExternalIdMediaType): boolean {
        return this.map.has(createExternalIdKey(providerId, mediaType));
    }

    /**
     * Check if a value exists using a pre-computed composite key
     */
    hasByKey(key: ExternalIdKey): boolean {
        return this.map.has(key);
    }

    /**
     * Delete a value for the given provider ID and media type
     */
    delete(providerId: number, mediaType: ExternalIdMediaType): boolean {
        return this.map.delete(createExternalIdKey(providerId, mediaType));
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.map.clear();
    }

    /**
     * Get the number of entries
     */
    get size(): number {
        return this.map.size;
    }

    /**
     * Iterate over all entries
     */
    *entries(): IterableIterator<[ExternalIdKeyComponents, T]> {
        for (const [key, value] of this.map) {
            const components = parseExternalIdKey(key);
            if (components) {
                yield [components, value];
            }
        }
    }

    /**
     * Iterate over all values
     */
    values(): IterableIterator<T> {
        return this.map.values();
    }

    /**
     * Iterate over all keys as components
     */
    *keys(): IterableIterator<ExternalIdKeyComponents> {
        for (const key of this.map.keys()) {
            const components = parseExternalIdKey(key);
            if (components) {
                yield components;
            }
        }
    }

    /**
     * Execute a callback for each entry
     */
    forEach(callback: (value: T, key: ExternalIdKeyComponents) => void): void {
        for (const [key, value] of this.entries()) {
            callback(value, key);
        }
    }

    /**
     * Get the underlying Map (for advanced use cases)
     */
    getRawMap(): ReadonlyMap<ExternalIdKey, T> {
        return this.map;
    }
}

/**
 * Type-safe Set for tracking external IDs that enforces composite keys.
 *
 * Prevents the common bug of using only providerId, which causes
 * false positives/negatives when the same ID exists for both movie and TV.
 *
 * @example
 * const watchedSet = new ExternalIdSet();
 *
 * // Adding items
 * watchedSet.add(providerId, mediaType);
 *
 * // Checking
 * if (watchedSet.has(providerId, mediaType)) {
 *   // This item was watched
 * }
 */
export class ExternalIdSet {
    private readonly set = new Set<ExternalIdKey>();

    /**
     * Add an external ID item to the set
     */
    add(providerId: number, mediaType: ExternalIdMediaType): this {
        this.set.add(createExternalIdKey(providerId, mediaType));
        return this;
    }

    /**
     * Add using a pre-computed composite key
     */
    addByKey(key: ExternalIdKey): this {
        this.set.add(key);
        return this;
    }

    /**
     * Check if an external ID item is in the set
     */
    has(providerId: number, mediaType: ExternalIdMediaType): boolean {
        return this.set.has(createExternalIdKey(providerId, mediaType));
    }

    /**
     * Check using a pre-computed composite key
     */
    hasByKey(key: ExternalIdKey): boolean {
        return this.set.has(key);
    }

    /**
     * Remove an external ID item from the set
     */
    delete(providerId: number, mediaType: ExternalIdMediaType): boolean {
        return this.set.delete(createExternalIdKey(providerId, mediaType));
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.set.clear();
    }

    /**
     * Get the number of entries
     */
    get size(): number {
        return this.set.size;
    }

    /**
     * Iterate over all entries as components
     */
    *values(): IterableIterator<ExternalIdKeyComponents> {
        for (const key of this.set) {
            const components = parseExternalIdKey(key);
            if (components) {
                yield components;
            }
        }
    }

    /**
     * Execute a callback for each entry
     */
    forEach(callback: (key: ExternalIdKeyComponents) => void): void {
        for (const key of this.values()) {
            callback(key);
        }
    }

    /**
     * Convert to array of composite keys
     */
    toArray(): ExternalIdKey[] {
        return Array.from(this.set);
    }

    /**
     * Create from an array of items with provider_id and media_type
     */
    static fromItems<T extends { provider_id: number; media_type: ExternalIdMediaType }>(
        items: T[],
    ): ExternalIdSet {
        const set = new ExternalIdSet();
        for (const item of items) {
            set.add(item.provider_id, item.media_type);
        }
        return set;
    }

    /**
     * Get the underlying Set (for advanced use cases)
     */
    getRawSet(): ReadonlySet<ExternalIdKey> {
        return this.set;
    }
}

/**
 * Helper to build an ExternalIdMap from provider items.
 *
 * @example
 * const jellyfinMap = buildExternalIdMap(allItems);
 * const jellyfinId = jellyfinMap.get(providerId, mediaType);
 */
export function buildExternalIdMap<
    T extends {
        Id: string;
        Type?: string;
        ProviderIds?: Record<string, string | undefined>;
    },
>(items: T[]): ExternalIdMap<string> {
    const map = new ExternalIdMap<string>();

    for (const item of items) {
        const tmdbIdStr = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb;
        if (tmdbIdStr) {
            const providerId = Number.parseInt(tmdbIdStr, 10);
            if (!isNaN(providerId)) {
                // item.Type is a generic Jellyfin-shaped string — this helper has no
                // caller restricting it to movie/series items, so a non-TMDB item
                // (e.g. a music/audio row carrying a stray Tmdb provider id) can
                // genuinely reach here. Skip it rather than mislabel it as a movie.
                const mediaType = toTmdbType(item.Type);
                if (mediaType) {
                    map.set(providerId, mediaType, item.Id);
                }
            }
        }
    }

    return map;
}

/**
 * Helper to build an ExternalIdSet from database results.
 *
 * @example
 * const ratedSet = buildExternalIdSet(userRatings);
 * if (ratedSet.has(providerId, mediaType)) { ... }
 */
export function buildExternalIdSet<T extends { provider_id: number; media_type: string }>(
    items: T[],
): ExternalIdSet {
    const set = new ExternalIdSet();
    for (const item of items) {
        const mediaType = item.media_type as ExternalIdMediaType;
        if (isMovie(mediaType) || isSeries(mediaType)) {
            set.add(item.provider_id, mediaType);
        }
    }
    return set;
}
