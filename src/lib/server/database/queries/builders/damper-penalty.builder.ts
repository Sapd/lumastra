// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared SQL builder for the "show less like this" ranking penalty, so every
 * embedding-ranked query (For-You anime/short-movies, Featured Pick, Mood, …)
 * applies the SAME (validated) per-candidate MAX-pool and the SQL can't drift.
 * The JS equivalent is `computeDamperPenalty` in taste-damper.service.ts.
 */

import type postgres from 'postgres';
import { DAMPER_LAMBDA, type DamperContext } from '$lib/server/services/taste-damper.service.js';

export { DAMPER_LAMBDA };

/**
 * SQL fragment evaluating the damper penalty for a candidate's embedding column
 * `embExpr`: `max_i [ weight_i · max(0, cos_centered(item, damper_i)) ] ∈ [0,1]`
 * over the user's active mean-centered dampers, or `0::numeric` when there are
 * none (so non-damper users pay zero cost). pgvector `<=>` normalizes both
 * operands internally, so this is a true cosine of the mean-centered vectors.
 *
 * Apply multiplicatively to a (positive) score, e.g.
 *   `score - GREATEST(score,0) * ${DAMPER_LAMBDA}::numeric * ${penalty}`.
 */
export function buildDamperPenalty(
    sql: postgres.Sql,
    embExpr: postgres.PendingQuery<postgres.Row[]>,
    damper: DamperContext | null,
): postgres.PendingQuery<postgres.Row[]> {
    if (!damper || damper.dampers.length === 0) return sql`0::numeric`;
    const weights = damper.dampers.map((d) => d.weight);
    const vecTexts = damper.dampers.map((d) => `[${d.vec.join(',')}]`);
    const centered = damper.mean
        ? sql`(${embExpr} - ${`[${damper.mean.join(',')}]`}::vector)`
        : embExpr;
    return sql`COALESCE((
        SELECT MAX(dp.w * GREATEST(0, 1 - (${centered} <=> dp.v::vector)))
        FROM unnest(${weights}::float8[], ${vecTexts}::text[]) AS dp(w, v)
    ), 0)`;
}
