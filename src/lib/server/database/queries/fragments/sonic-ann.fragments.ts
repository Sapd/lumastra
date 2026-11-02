// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic ANN SQL Fragment
 *
 * Shared inner-ANN stage for every kNN query over `media_audio_embeddings`.
 * Lives here rather than beside one of its callers because both the
 * quick-picks sonic buckets and the sonic-taste picks need the identical
 * shape, and a hand-copied second version of a correctness-critical query
 * pattern is exactly how one copy silently drifts.
 *
 * @module fragments/sonic-ann
 */

import type postgres from 'postgres';

/**
 * Inner ANN stage for the sonic (`media_audio_embeddings`, MSCLAP 1024-dim)
 * kNN buckets — the sibling of `musicAnnCandidates` in
 * music-quick-picks.queries.ts, and subject to the same rules for the same
 * reasons.
 *
 * These queries never carried the jsonb genre predicate that first exposed the
 * defect, which is why they were not part of the original split. They were
 * broken anyway, through the other half of the problem: the planner declining
 * the index on price. Measured on prod in the shipped single-stage shape:
 *
 *   Sort Method: top-N heapsort
 *   Index Scan using media_audio_embeddings_pkey ... loops=27250
 *   Execution Time: 667 ms      <- idx_media_audio_embeddings_hnsw NOT used
 *
 * It walked 27,250 rows by primary key and sorted them. Two-stage plus the
 * enable_seqscan pin: HNSW index used, 15 of 15 rows identical to the exact
 * scan, ~3ms warm. (A first touch of a cold index measures ~300ms; that is
 * cache warmup, not the index's floor — do not read a single cold sample as
 * an index-quality problem.)
 *
 * `model_id` is filtered HERE rather than outside so the candidate pool is
 * always single-model. Today the column has exactly one value across all
 * 30,008 rows, so it changes nothing; if a second model is ever embedded, an
 * outer-only filter would let the pool fill with the wrong model's neighbours
 * and then discard them, silently starving recall. It is a cheap equality, not
 * the kind of predicate that costs a plan — and the pin holds the index
 * regardless.
 */
export function sonicAnnCandidates(
    sql: postgres.Sql,
    centroidLiteral: string,
    modelId: string,
    annLimit: number,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
            SELECT
                mae.media_id AS media_id,
                mae.embedding AS embedding,
                (mae.embedding <=> ${centroidLiteral}::vector) AS ann_distance
            FROM media_audio_embeddings mae
            WHERE mae.model_id = ${modelId}
            ORDER BY mae.embedding <=> ${centroidLiteral}::vector ASC
            LIMIT ${annLimit}`;
}
