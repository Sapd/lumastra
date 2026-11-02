// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Fusion SQL Fragments
 *
 * Weighted late-fusion of the two recommendation embeddings (library +
 * discovery) into a single cosine-similarity score.
 *
 * Background: similarity search historically scored a candidate item with a
 * *max / fallback* strategy when it had both a library and a discovery
 * embedding — `GREATEST(lib_sim, disc_sim)`, `COALESCE(lib_emb, disc_emb)`, or a
 * `CASE WHEN lib ... WHEN disc ...` priority fallback. Those pick a single
 * vector and discard the other source's signal entirely. This fragment instead
 * produces a *weighted blend* when both embeddings are present, and the single
 * available similarity (no penalty) when only one is present.
 *
 * The two weights are normalized at build time, so only their ratio matters.
 * Weights come from `config.EMBEDDING_FUSION_LIBRARY_WEIGHT` /
 * `EMBEDDING_FUSION_DISCOVERY_WEIGHT`.
 *
 * Note: this fuses the two scalar *similarities* (late fusion), not the vectors
 * themselves. Late fusion keeps the per-source HNSW candidate selection intact
 * (each source's `<=>` distance stays index-eligible in the candidate phase)
 * and avoids requiring the two embeddings to share a comparable vector space.
 *
 * @module fragments/embedding-fusion
 */

import type postgres from 'postgres';
import { config } from '../../../config.js';

/**
 * Build a weighted-fusion cosine-similarity expression.
 *
 * Given SQL expressions for the library embedding column, the discovery
 * embedding column, and the query vector, returns a `postgres` fragment that
 * evaluates to:
 *
 * - both embeddings present → `wLib·(1 - lib<=>vec) + wDisc·(1 - disc<=>vec)`
 *   where `wLib + wDisc = 1` (normalized weights)
 * - only library present    → `1 - lib<=>vec`
 * - only discovery present  → `1 - disc<=>vec`
 * - neither present         → `0`
 *
 * The caller supplies the column/vector expressions as `sql` fragments so the
 * same helper works whether the query vector is `se.emb`, `sv.vec`, or a bound
 * `${userVector}::vector`, and whatever the embedding column aliases are.
 *
 * @param sql        postgres tag (for building the fragment)
 * @param libEmbExpr SQL fragment for the library embedding column (may be NULL)
 * @param discEmbExpr SQL fragment for the discovery embedding column (may be NULL)
 * @param vecExpr    SQL fragment for the query vector to compare against
 */
export function buildFusedSimilarityExpr(
    sql: postgres.Sql,
    libEmbExpr: postgres.PendingQuery<postgres.Row[]>,
    discEmbExpr: postgres.PendingQuery<postgres.Row[]>,
    vecExpr: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    const rawLibWeight = config.EMBEDDING_FUSION_LIBRARY_WEIGHT;
    const rawDiscWeight = config.EMBEDDING_FUSION_DISCOVERY_WEIGHT;
    const total = rawLibWeight + rawDiscWeight;
    // Guard against a degenerate 0/0 config — fall back to an even split.
    const libWeight = total > 0 ? rawLibWeight / total : 0.5;
    const discWeight = total > 0 ? rawDiscWeight / total : 0.5;

    return sql`
        CASE
            WHEN (${libEmbExpr}) IS NOT NULL AND (${discEmbExpr}) IS NOT NULL
                THEN ${libWeight}::float8 * (1 - ((${libEmbExpr}) <=> (${vecExpr})))
                   + ${discWeight}::float8 * (1 - ((${discEmbExpr}) <=> (${vecExpr})))
            WHEN (${libEmbExpr}) IS NOT NULL
                THEN 1 - ((${libEmbExpr}) <=> (${vecExpr}))
            WHEN (${discEmbExpr}) IS NOT NULL
                THEN 1 - ((${discEmbExpr}) <=> (${vecExpr}))
            ELSE 0
        END
    `;
}
