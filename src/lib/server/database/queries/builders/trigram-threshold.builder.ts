// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { config } from '../../../config.js';

/** Clamp the configured pg_trgm threshold into (0,1); fall back to the 0.25 default. */
export function clampTrigramThreshold(raw: unknown): number {
    const t = Number(raw);
    return Number.isFinite(t) && t > 0 && t < 1 ? t : 0.25;
}

/**
 * Run `fn` with pg_trgm.similarity_threshold SET LOCAL inside a transaction when the query
 * is trigram-capable; otherwise run on the bare connection (the unchanged fast path).
 * list + count call this identically so they always apply the same threshold.
 *
 * Defensive: if `sql` is already a transaction handle (no `.begin`), skip the nested
 * transaction and run directly — calling `.begin()` on a TransactionSql throws at runtime.
 * Today's only callers pass the pool, so this just future-proofs reuse.
 */
export async function runWithTrigramThreshold<T>(
    sql: postgres.Sql,
    needsThreshold: boolean,
    fn: (db: postgres.Sql) => Promise<T>,
): Promise<T> {
    if (!needsThreshold || typeof sql.begin !== 'function') return fn(sql);
    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const threshold = clampTrigramThreshold(config.SEARCH_TRIGRAM_THRESHOLD);
        await tx`SELECT set_config('pg_trgm.similarity_threshold', ${String(threshold)}, true)`;
        return fn(tx);
    }) as Promise<T>;
}
