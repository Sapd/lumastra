// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/**
 * Lightweight media_type resolver with in-memory FIFO cache.
 * Used by watchManager to reject music tracks.
 * Cache is small (1000 entries) and expires on process restart.
 * Eviction is insertion-order (FIFO via Map), not true LRU — fine for this use case.
 */

const cache = new Map<string, string>();
const MAX_CACHE_SIZE = 1000;

export async function getMediaType(sql: postgres.Sql, mediaId: string): Promise<string | null> {
    const cached = cache.get(mediaId);
    if (cached !== undefined) return cached;

    const rows = await sql<{ media_type: string }[]>`
        SELECT media_type FROM media_items WHERE id = ${mediaId} LIMIT 1
    `;
    const mediaType = rows[0]?.media_type ?? null;
    if (mediaType) {
        if (cache.size >= MAX_CACHE_SIZE) {
            // Evict oldest entry (first inserted)
            const firstKey = cache.keys().next().value;
            if (firstKey !== undefined) cache.delete(firstKey);
        }
        cache.set(mediaId, mediaType);
    }
    return mediaType;
}

export function isMusicMediaType(mediaType: string | null): boolean {
    return mediaType === 'track' || mediaType === 'audio' || mediaType === 'music';
}

/** Clear cache (for tests). */
export function clearMediaTypeCache(): void {
    cache.clear();
}
