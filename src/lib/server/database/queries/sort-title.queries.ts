// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Sort-title maintenance for `media_items`.
 *
 * `media_items.sort_title` has no database trigger: the application is its only
 * writer, through `deriveSortTitle`. List endpoints order by
 * `COALESCE(NULLIF(sort_title, ''), LOWER(title))`, so a row written without a
 * key sorts by its raw title ("The Doll" under T) next to audiobooks whose key
 * strips the article. Every path that creates a row or changes its title calls
 * `refreshSortTitles` for the ids it touched.
 *
 * The language is the library's declared language (`library_paths.language`),
 * found through `library_group_id` on the row or on its parent or grandparent
 * (episodes and tracks carry no group of their own). A group whose paths
 * declare different languages, and a row with no group, use the default.
 */

import type postgres from 'postgres';
import { deriveSortTitle } from '../../utils/sort-title.js';
import { withTx } from '../with-tx.js';

/** One row's inputs to `deriveSortTitle`. */
export interface SortTitleSource {
    id: string;
    title: string;
    english_title: string | null;
    original_title: string | null;
    sort_title: string | null;
    language: string | null;
}

/**
 * Load the sort-title inputs for `ids`, with the library language resolved
 * through the row, its parent or its grandparent.
 */
export async function loadSortTitleSources(
    sql: postgres.Sql,
    ids: readonly string[],
): Promise<SortTitleSource[]> {
    if (ids.length === 0) return [];
    // System-internal key maintenance: no user is involved, so there is no access decision to gate.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql<SortTitleSource[]>`
        SELECT mi.id::text AS id, mi.title, mi.english_title, mi.original_title, mi.sort_title,
               gl.language
          FROM media_items mi
          LEFT JOIN media_items p ON p.id = mi.parent_id
          LEFT JOIN media_items gp ON gp.id = p.parent_id
          LEFT JOIN LATERAL (
              SELECT CASE WHEN COUNT(DISTINCT lp.language) = 1 THEN MIN(lp.language) END AS language
                FROM library_paths lp
               WHERE lp.library_group_id = COALESCE(mi.library_group_id, p.library_group_id, gp.library_group_id)
          ) gl ON true
         WHERE mi.id = ANY(${ids as string[]}::uuid[])
    `;
}

/** The key `deriveSortTitle` gives a row, exactly as the write paths store it. */
export function sortTitleFor(source: SortTitleSource): string {
    return deriveSortTitle(
        source.title,
        source.english_title,
        source.original_title,
        source.language,
    );
}

/**
 * Run `fn` with sync capture off, then put the setting back. `SET LOCAL` alone
 * would outlive this call when `sql` is a caller's open transaction and silence
 * the caller's later writes, so the previous value is restored explicitly.
 *
 * Only for writes that change columns sync clients never receive.
 */
async function withSyncCaptureOff<T>(
    sql: postgres.Sql,
    fn: (tx: postgres.Sql) => Promise<T>,
): Promise<T> {
    return withTx(sql, async (tx) => {
        const [{ prev }] = await tx<{ prev: string | null }[]>`
            SELECT current_setting('lumastra.sync_capture', true) AS prev
        `;
        await tx`SELECT set_config('lumastra.sync_capture', 'off', true)`;
        const result = await fn(tx);
        await tx`SELECT set_config('lumastra.sync_capture', ${prev ?? ''}, true)`;
        return result;
    });
}

/**
 * Recompute `sort_title` for `ids` from their stored title, English title,
 * original title and library language. Writes only rows whose key differs, so
 * a call after a no-op update costs no write. Returns the number of rows
 * written.
 *
 * `sort_title` is the only column this changes. Sync clients do not receive it
 * (sorting is server-side), but it is in `SYNC_INHERITED_COLUMNS`, so a captured
 * write would log the row again and, for a series, season or album, fan out over
 * its whole subtree. The title write before this call is captured on its own;
 * this follow-up runs with capture off.
 */
export async function refreshSortTitles(
    sql: postgres.Sql,
    ids: readonly string[],
): Promise<number> {
    const sources = await loadSortTitleSources(sql, ids);
    const changedIds: string[] = [];
    const keys: string[] = [];
    for (const source of sources) {
        const key = sortTitleFor(source);
        if (key === source.sort_title) continue;
        changedIds.push(source.id);
        keys.push(key);
    }
    if (changedIds.length === 0) return 0;
    return withSyncCaptureOff(sql, async (tx) => {
        const updated = await tx`
            UPDATE media_items mi
               SET sort_title = v.key
              FROM unnest(${changedIds}::uuid[], ${keys}::text[]) AS v(id, key)
             WHERE mi.id = v.id
               AND mi.sort_title IS DISTINCT FROM v.key
            RETURNING mi.id
        `;
        return updated.length;
    });
}

/** Rows read, derived and written per batch (one short transaction each). */
export const SORT_TITLE_BACKFILL_BATCH_SIZE = 5000;

/** Per-run limits for {@link backfillSortTitles}; an unset limit means unbounded. */
export interface SortTitleBackfillBudget {
    /** Stop once at least this many rows were written (checked between batches). */
    maxRows?: number;
    /** Stop starting new batches once this many milliseconds have passed. */
    maxMs?: number;
    /** Stop starting new batches once aborted. */
    signal?: AbortSignal;
    /** Rows per batch; defaults to {@link SORT_TITLE_BACKFILL_BATCH_SIZE}. */
    batchSize?: number;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Give `media_items` rows without a `sort_title` the key `deriveSortTitle`
 * would have written, so list endpoints that order by
 * `COALESCE(NULLIF(sort_title, ''), LOWER(title))` sort movies, series, episodes,
 * albums, artists and tracks the way audiobooks already sort ("The Doll" under D).
 * The write paths set the key through {@link refreshSortTitles}; this repairs
 * rows written before that.
 *
 * The key is derived in TypeScript with the library's declared language, as the
 * write paths do. Only rows with a NULL or empty key are visited, in `id` order
 * by keyset. Each batch is its own short transaction with sync capture off:
 * `sort_title` is in `SYNC_INHERITED_COLUMNS`, so captured writes logged hundreds
 * of thousands of `sync_changes` rows for a column no sync client receives.
 *
 * Resumable and idempotent: a run that stops at its budget leaves the remaining
 * rows for the next call; a call with nothing left costs one bounded SELECT.
 * Rows whose derived key is empty stay unfilled and are skipped within a run.
 *
 * Returns the number of rows written.
 */
export async function backfillSortTitles(
    sql: postgres.Sql,
    budget: SortTitleBackfillBudget = {},
): Promise<number> {
    const batchSize = budget.batchSize ?? SORT_TITLE_BACKFILL_BATCH_SIZE;
    const startedAt = Date.now();
    let lastId = NIL_UUID;
    let written = 0;
    for (;;) {
        if (budget.signal?.aborted) return written;
        if (budget.maxRows !== undefined && written >= budget.maxRows) return written;
        if (budget.maxMs !== undefined && Date.now() - startedAt >= budget.maxMs) return written;

        // System-internal key maintenance: no user is involved, so there is no access decision to gate.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        const batch = await sql<{ id: string }[]>`
            SELECT id::text AS id
              FROM media_items
             WHERE id > ${lastId}::uuid
               AND (sort_title IS NULL OR sort_title = '')
             ORDER BY id
             LIMIT ${batchSize}
        `;
        if (batch.length === 0) return written;
        lastId = batch[batch.length - 1].id;

        const sources = await loadSortTitleSources(
            sql,
            batch.map((r) => r.id),
        );
        const ids: string[] = [];
        const keys: string[] = [];
        for (const source of sources) {
            const key = sortTitleFor(source);
            if (key === '') continue;
            ids.push(source.id);
            keys.push(key);
        }
        if (ids.length === 0) continue;
        written += await withTx(sql, async (tx) => {
            await tx`SET LOCAL lumastra.sync_capture = 'off'`;
            const updated = await tx`
                UPDATE media_items mi
                   SET sort_title = v.key
                  FROM unnest(${ids}::uuid[], ${keys}::text[]) AS v(id, key)
                 WHERE mi.id = v.id
                   AND (mi.sort_title IS NULL OR mi.sort_title = '')
                RETURNING mi.id
            `;
            return updated.length;
        });
    }
}
