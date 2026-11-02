// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * In-process cache for a media item's identity + parsed embedding, used by
 * the modal's /api/media/{id}/similar endpoint.
 *
 * The similar computation used to refetch (and re-JSON.parse a 1024-float
 * vector) on every response-cache miss even though an item's embedding only
 * changes on re-embed. Lives in its own module — NOT inside the API def — so
 * the cache-invalidation service can purge it on media change without a
 * cache-layer → api-def import: a stale entry here would otherwise feed the
 * NEXT similar recompute the pre-invalidation embedding/title, silently
 * undoing the eviction of the response cache.
 *
 * TTLs: positive entries 5 min (matches the response cache's L1 tier — the
 * documented per-replica staleness bound, since in-process caches cannot be
 * pattern-invalidated across replicas). Entries WITHOUT an embedding (or for
 * missing items) cache for only 60 s so freshly embedded items start serving
 * similar content promptly.
 */

import type postgres from 'postgres';
import { LRUCache } from '$lib/server/cache';
import { parseEmbedding } from '$lib/server/utils/embedding-utils.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source.js';

export interface SimilarSourceMedia {
    primary_ext_id: string;
    title: string;
    media_type: string;
    embedding: number[] | null;
}

const SOURCE_MEDIA_NULL = Symbol('source-media-null');
const SOURCE_SHORT_TTL = 60 * 1000;
const SOURCE_POSITIVE_TTL = 5 * 60 * 1000;

const sourceMediaCache = new LRUCache<SimilarSourceMedia | typeof SOURCE_MEDIA_NULL>({
    maxSize: 500,
    defaultTTL: SOURCE_POSITIVE_TTL,
    namespace: 'similar-source-media',
});

export async function getSimilarSourceMedia(
    sql: postgres.Sql,
    internalId: string,
): Promise<SimilarSourceMedia | null> {
    const cached = sourceMediaCache.get(internalId);
    if (cached !== null) {
        return cached === SOURCE_MEDIA_NULL ? null : cached;
    }

    const [row] = await sql<
        {
            primary_ext_id: string;
            title: string;
            media_type: string;
            library_embedding: unknown;
            discovery_embedding: unknown;
        }[]
    >`
        SELECT
            COALESCE((SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') as primary_ext_id,
            mi.title,
            mi.media_type,
            lib_emb.embedding as library_embedding,
            disc_emb.embedding as discovery_embedding
        FROM media_items mi
        LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id AND lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
        LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id AND disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
        WHERE mi.id = ${internalId}
    `;

    if (!row) {
        sourceMediaCache.set(internalId, SOURCE_MEDIA_NULL, SOURCE_SHORT_TTL);
        return null;
    }

    let embedding: number[] | null = null;
    if (row.library_embedding) {
        embedding = parseEmbedding(row.library_embedding as number[] | string | null);
    } else if (row.discovery_embedding) {
        embedding = parseEmbedding(row.discovery_embedding as number[] | string | null);
    }

    const entry: SimilarSourceMedia = {
        primary_ext_id: row.primary_ext_id,
        title: row.title,
        media_type: row.media_type,
        embedding: embedding && embedding.length > 0 ? embedding : null,
    };
    sourceMediaCache.set(internalId, entry, entry.embedding ? undefined : SOURCE_SHORT_TTL);
    return entry;
}

/**
 * Drop the cached identity/embedding for one item. Called by the cache
 * invalidation service on media change (in-process only — other replicas
 * converge via the 5-minute TTL, same bound as every other L1 tier).
 */
export function invalidateSimilarSourceMedia(internalId: string): void {
    sourceMediaCache.delete(internalId);
}
