// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File Scanner Runs Query Module
 *
 * Queries for the file_scanner_runs table (migration 11.46.0).
 * Each row records the outcome of a single scanner run: totals, match rate,
 * error counts. match_rate is a GENERATED column computed by PostgreSQL.
 */

import type postgres from 'postgres';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { withTx } from '../with-tx.js';

export interface FileScannerRunRow {
    id: string;
    library_path_id: string | null;
    started_at: Date;
    completed_at: Date | null;
    total_files: number;
    matched: number;
    updated: number;
    unmatched: number;
    errors: number;
    /**
     * PERCENTAGE 0-100, NUMERIC returned as string by postgres.js.
     *
     * Wrong-by-name and no longer displayed anywhere: it is
     * `matched / total_files * 100`, and `matched` is written as
     * `added + updated` (see `file-scanner.ts`), so it measures CHURN, not
     * matching — a fully-matched library that changed nothing scores 0%.
     * Across 10,229 production runs the ≥90% "green" band fired twice.
     * Kept in the row type because the generated column still exists and is
     * harmless at rest; a future base-schema squash may drop it.
     */
    match_rate: string;
    /**
     * Bounded sample of this run's error strings (migration 16.236.0).
     * The authoritative COUNT is `errors`; this array is capped, so
     * `error_samples.length < errors` is normal and means "truncated".
     */
    error_samples: string[];
    created_at: Date;
}

/**
 * One run joined to its library path, for the admin run-history views.
 *
 * `library_path` is projected EXPLICITLY rather than relying on `SELECT *`
 * picking it up: a consumer schema that declares the field `.nullable()`
 * rejects `undefined`, so a query that silently stops emitting the column
 * turns into an unhandled 500 on rows that look fine. Two nulls, two
 * different meanings:
 *  - `library_path_id` null  → a global (scope='all') scan, "All libraries".
 *  - `library_path_id` set but `library_path` null → the path row was
 *    deleted after the run; the run history outlives the path it scanned.
 */
export interface ScannerRunWithPathRow extends FileScannerRunRow {
    library_path: string | null;
}

export interface InsertScannerRunParams {
    libraryPathId?: string;
    startedAt: Date;
}

/**
 * Insert a new scanner run row at the start of a scan.
 * Returns the new row's UUID so it can be updated when the scan completes.
 */
export async function insertScannerRun(
    sql: postgres.Sql,
    params: InsertScannerRunParams,
): Promise<string> {
    return withTx(sql, async (tx) => {
        // Keep path-to-group mapping stable through fence acquisition and registration.
        await tx`LOCK TABLE library_paths IN SHARE MODE`;
        const [path] = params.libraryPathId
            ? await tx<{ group_id: string }[]>`
                SELECT library_group_id::text AS group_id FROM library_paths
                WHERE id = ${params.libraryPathId}::uuid
            `
            : [];
        await lockLibraryScanFence(tx, path?.group_id);
        const rows = await tx<[{ id: string }]>`
            INSERT INTO file_scanner_runs (library_path_id, started_at)
            VALUES (${params.libraryPathId ?? null}, ${params.startedAt})
            RETURNING id
        `;
        return rows[0].id;
    });
}

/**
 * Serialize scan registration with retention's health check and commit.
 * A global scan takes the global fence exclusively; per-group operations
 * share it and take their group fence. Always acquire global before group.
 * Call only inside a transaction. Registration commits before filesystem work;
 * the open file_scanner_runs row then fences retention until completion.
 */
export async function lockLibraryScanFence(sql: postgres.Sql, groupId?: string): Promise<void> {
    if (groupId) {
        await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('file-library-scan:global', 0))`;
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`file-library-scan:group:${groupId}`}, 0))`;
    } else {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('file-library-scan:global', 0))`;
    }
}

export interface UpdateScannerRunParams {
    id: string;
    completedAt: Date;
    totalFiles: number;
    matched: number;
    updated: number;
    unmatched: number;
    errors: number;
    /** Bounded sample of the error strings — pass `boundScannerRunErrorSamples(...)`. */
    errorSamples: string[];
}

/** Max error strings kept on a run row. */
export const SCANNER_RUN_ERROR_SAMPLE_LIMIT = 20;

/** Max characters kept per stored error string. */
export const SCANNER_RUN_ERROR_SAMPLE_MAX_CHARS = 300;

/**
 * Clamp a scan's error strings to something safe to store on the row.
 *
 * A scan of a mount that has gone away produces ONE error per file, so this
 * input is unbounded in both directions: the array can be
 * hundreds-of-thousands long, and a single entry embeds a full file path plus
 * a driver message. Storing it raw would write megabytes per run to a table
 * that already holds five figures of rows.
 *
 * The count is NOT derived from this array — `errors` carries the real total
 * — so truncating here loses nothing the UI needs to stay honest: it renders
 * "showing 20 of 137" from the two numbers together.
 */
export function boundScannerRunErrorSamples(errors: readonly string[]): string[] {
    return errors.slice(0, SCANNER_RUN_ERROR_SAMPLE_LIMIT).map((e) => {
        const s = String(e);
        return s.length > SCANNER_RUN_ERROR_SAMPLE_MAX_CHARS
            ? `${s.slice(0, SCANNER_RUN_ERROR_SAMPLE_MAX_CHARS)}…`
            : s;
    });
}

/**
 * Update a scanner run row when the scan completes.
 */
export async function updateScannerRun(
    sql: postgres.Sql,
    params: UpdateScannerRunParams,
): Promise<void> {
    await sql`
        UPDATE file_scanner_runs
        SET completed_at = ${params.completedAt},
            total_files  = ${params.totalFiles},
            matched      = ${params.matched},
            updated      = ${params.updated},
            unmatched    = ${params.unmatched},
            errors       = ${params.errors},
            error_samples = ${params.errorSamples}::text[]
        WHERE id = ${params.id}
    `;
}

/**
 * Sentinel value for errors column indicating a run was abandoned due to crash.
 * Distinguishes crash-abandoned runs from normal completed runs in the admin UI.
 */
export const ABANDONED_RUN_ERRORS_SENTINEL = -1;

/**
 * Hours an in-flight run (`completed_at IS NULL`) is allowed to sit open
 * before it's treated as abandoned. Bulk scans on large libraries can
 * legitimately exceed 10 minutes across replicas, so this stays generous.
 *
 * Named and exported (rather than inlined as `INTERVAL '2 hours'`) so
 * `getStaleInFlightScannerRuns` can detect a stale run using the SAME
 * threshold `markAbandonedScannerRuns` uses to actually mark one — those two
 * had drifted apart into two different literals before, which would have
 * made a run read as "still fine" to one and "abandoned" to the other.
 */
export const ABANDONED_RUN_STALE_HOURS = 2;

/** What a run row means to an operator, once staleness is taken into account. */
export type ScannerRunStatus = 'running' | 'abandoned' | 'completed';

/**
 * Collapse (`completed_at`, `started_at`, `errors`) into the ONE thing the
 * admin table renders: did it work.
 *
 * Derived HERE, server-side, and shipped as a field — deliberately not left
 * to the client. The 2h rule is not presentation: it is the same threshold
 * `markAbandonedScannerRuns` uses to actually stamp a row, and a second
 * implementation of it in a `.svelte` file is a copy that drifts silently
 * (tsgo does not typecheck `.svelte`, so nothing would catch it).
 *
 * The sentinel is checked FIRST. An abandoned row has both `completed_at`
 * stamped and `errors = -1`, so ordering only matters for intent — but
 * `errors = -1` must never reach a numeric renderer, because "-1 errors" is
 * the exact wrong sentence for a run that never finished.
 *
 * An in-flight run younger than the window is `running`, NOT abandoned: bulk
 * scans on large libraries legitimately run for a long time, and reporting a
 * healthy scan as a failure is the louder mistake.
 */
export function deriveScannerRunStatus(
    run: Pick<FileScannerRunRow, 'started_at' | 'completed_at' | 'errors'>,
    now: Date = new Date(),
): ScannerRunStatus {
    if (run.errors === ABANDONED_RUN_ERRORS_SENTINEL) return 'abandoned';
    if (run.completed_at === null) {
        const openMs = now.getTime() - new Date(run.started_at).getTime();
        return openMs > ABANDONED_RUN_STALE_HOURS * 3_600_000 ? 'abandoned' : 'running';
    }
    return 'completed';
}

/**
 * Mark abandoned scanner runs (started but never completed) as failed.
 * Called before each scan to reconcile runs left open by a previous crash.
 * Uses errors = -1 sentinel to distinguish abandoned runs from normal completions.
 * Returns the number of runs marked as abandoned.
 *
 * When `libraryPathId` is provided, only rows for that specific path are
 * considered — prevents replica B from marking a legitimate long-running
 * scan on replica A as abandoned. Pass `null` for global scans (scope='all'),
 * which only targets rows where library_path_id IS NULL.
 */
export async function markAbandonedScannerRuns(
    sql: postgres.Sql,
    libraryPathId: string | null,
): Promise<number> {
    if (libraryPathId !== null) {
        const result = await sql`
            UPDATE file_scanner_runs
            SET completed_at = NOW(),
                errors = ${ABANDONED_RUN_ERRORS_SENTINEL}
            WHERE completed_at IS NULL
              AND library_path_id = ${libraryPathId}
              AND started_at < NOW() - make_interval(hours => ${ABANDONED_RUN_STALE_HOURS})
        `;
        return result.count;
    }
    const result = await sql`
        UPDATE file_scanner_runs
        SET completed_at = NOW(),
            errors = ${ABANDONED_RUN_ERRORS_SENTINEL}
        WHERE completed_at IS NULL
          AND library_path_id IS NULL
          AND started_at < NOW() - make_interval(hours => ${ABANDONED_RUN_STALE_HOURS})
    `;
    return result.count;
}

/**
 * Return the most recent scanner runs, newest first, joined to their library
 * path. Backs the per-library history sub-table in the admin UI.
 *
 * `libraryPathId` is TRI-state, and the third state is the one that is easy
 * to miss:
 *  - `undefined` — every library's runs interleaved (the unscoped view).
 *  - a uuid — that library's runs.
 *  - `null` — runs of GLOBAL (scope='all') scans, i.e. `library_path_id IS
 *    NULL`. Without this case, expanding the "All libraries" row would fall
 *    through to the unscoped branch and show every library's runs under a
 *    heading claiming to be one library's history. `= NULL` never matches, so
 *    it has to be a separate `IS NULL` branch rather than a parameter value.
 */
export async function getRecentScannerRuns(
    sql: postgres.Sql,
    limit = 20,
    libraryPathId?: string | null,
    /**
     * Narrow to runs whose library_path belongs to this library group — the
     * per-library page's scan-history section. `undefined` (the default)
     * leaves every group's runs interleaved. A run whose `library_path_id` is
     * null (a global scope='all' scan) never belongs to any group and is
     * therefore excluded once a group filter is set, regardless of
     * `libraryPathId`.
     */
    libraryGroupId?: string,
): Promise<ScannerRunWithPathRow[]> {
    const groupFilter = libraryGroupId ? sql`AND lp.library_group_id = ${libraryGroupId}` : sql``;
    if (libraryPathId === null) {
        return sql<ScannerRunWithPathRow[]>`
            SELECT r.*, lp.path AS library_path
            FROM file_scanner_runs r
            LEFT JOIN library_paths lp ON lp.id = r.library_path_id
            WHERE r.library_path_id IS NULL ${groupFilter}
            ORDER BY r.started_at DESC
            LIMIT ${limit}
        `;
    }
    if (libraryPathId) {
        return sql<ScannerRunWithPathRow[]>`
            SELECT r.*, lp.path AS library_path
            FROM file_scanner_runs r
            LEFT JOIN library_paths lp ON lp.id = r.library_path_id
            WHERE r.library_path_id = ${libraryPathId} ${groupFilter}
            ORDER BY r.started_at DESC
            LIMIT ${limit}
        `;
    }
    return sql<ScannerRunWithPathRow[]>`
        SELECT r.*, lp.path AS library_path
        FROM file_scanner_runs r
        LEFT JOIN library_paths lp ON lp.id = r.library_path_id
        WHERE TRUE ${groupFilter}
        ORDER BY r.started_at DESC
        LIMIT ${limit}
    `;
}

/**
 * Return the newest run per `library_path_id` REGARDLESS of completion state,
 * joined to the library path. Backs the default admin table: one stable row
 * per library instead of six near-identical anonymous rows per scan cycle.
 *
 * Note the difference from `getLatestCompletedScannerRunPerLibrary` below,
 * which cannot be reused here. That one filters to `completed_at IS NOT NULL`
 * because the attention adapter needs "abandoned" to be detectable, and a
 * combined query would let a library's newer in-flight row hide an older
 * crashed one. That trap only bites a query that DISCARDS in-flight rows and
 * then has to reconstruct them: this query keeps every row and hands the
 * newest one to `deriveScannerRunStatus`, which reads in-flight-past-the-grace
 * -window as abandoned directly. Taking the newest unconditionally is what
 * makes a single query sufficient — a crashed run IS this library's current
 * state and should be what the row shows.
 *
 * `DISTINCT ON (library_path_id)` groups NULL `library_path_id` rows (global,
 * scope='all' scans) together as their own single group — NULLs are equal for
 * grouping, unlike `NULL = NULL`, verified against a live Postgres instance.
 */
export async function getLatestScannerRunPerLibrary(
    sql: postgres.Sql,
    /** Narrow to one library group's folders — see {@link getRecentScannerRuns}. */
    libraryGroupId?: string,
): Promise<ScannerRunWithPathRow[]> {
    const groupFilter = libraryGroupId ? sql`WHERE lp.library_group_id = ${libraryGroupId}` : sql``;
    return sql<ScannerRunWithPathRow[]>`
        SELECT DISTINCT ON (r.library_path_id) r.*, lp.path AS library_path
        FROM file_scanner_runs r
        LEFT JOIN library_paths lp ON lp.id = r.library_path_id
        ${groupFilter}
        ORDER BY r.library_path_id, r.started_at DESC
    `;
}

/** A scanner run row as consumed by the attention adapter (`adaptScanRun`). */
export type ScannerRunSummary = FileScannerRunRow;

/**
 * Return the latest COMPLETED run per `library_path_id`, one row per group.
 *
 * `getRecentScannerRuns` (above) cannot serve this: it returns the newest N
 * rows GLOBALLY, so a library that scans less often than its neighbours can
 * fall out of that window entirely even though it has a perfectly good latest
 * completed run of its own. `DISTINCT ON` groups per `library_path_id`
 * instead, which is the only way to guarantee every library gets represented.
 *
 * Deliberately excludes `completed_at IS NULL` rows — NOT because an
 * in-flight run has nothing to report (see `getStaleInFlightScannerRuns`
 * below for that), but because a single `DISTINCT ON` picking "whichever row
 * is newest regardless of status" has no way to represent "abandoned": a
 * crashed run is only stamped `completed_at`/`errors = -1` at the START of
 * that library's NEXT scan (`markAbandonedScannerRuns` runs immediately
 * before `insertScannerRun` in `file-scanner.ts`'s `performScan`), so between
 * the crash and that next scan the row sits at `completed_at IS NULL` with a
 * `started_at` from hours ago — and a combined query's own newer, in-flight
 * row for the SAME library would always win `ORDER BY started_at DESC`,
 * silently discarding the stale one. Splitting completed vs. stale-in-flight
 * into two queries is what makes the abandoned case detectable at all.
 *
 * `DISTINCT ON (library_path_id)` groups NULL `library_path_id` rows (global,
 * scope='all' scans) together as their own single group, the same way plain
 * `DISTINCT`/`GROUP BY` treat NULLs as equal for grouping — verified against a
 * live Postgres instance, since this is easy to get backwards by assuming SQL
 * NULL-equality semantics (`NULL = NULL` is UNKNOWN) apply here.
 */
export async function getLatestCompletedScannerRunPerLibrary(
    sql: postgres.Sql,
): Promise<ScannerRunSummary[]> {
    return sql<ScannerRunSummary[]>`
        SELECT DISTINCT ON (library_path_id) *
        FROM file_scanner_runs
        WHERE completed_at IS NOT NULL
        ORDER BY library_path_id, started_at DESC
    `;
}

/**
 * Return one row per `library_path_id` that has been open (`completed_at IS
 * NULL`) for longer than `ABANDONED_RUN_STALE_HOURS` — the same window
 * `markAbandonedScannerRuns` uses to actually mark a run abandoned, read here
 * BEFORE that marking happens (or if it never happens at all, e.g. no scan on
 * that library is ever triggered again). A scan legitimately runs for a long
 * time, so "in-flight" alone must never be read as "abandoned"; only a run
 * stuck open past this same threshold counts.
 */
export async function getStaleInFlightScannerRuns(sql: postgres.Sql): Promise<ScannerRunSummary[]> {
    return sql<ScannerRunSummary[]>`
        SELECT DISTINCT ON (library_path_id) *
        FROM file_scanner_runs
        WHERE completed_at IS NULL
          AND started_at < NOW() - make_interval(hours => ${ABANDONED_RUN_STALE_HOURS})
        ORDER BY library_path_id, started_at DESC
    `;
}

/**
 * Which active scan scopes have no prior successful scan? Checks only the
 * indexed library_path_id history for the active paths and the legacy global
 * scope; never counts or scans media_items. Abandoned runs do not establish
 * initial completion. History retention makes this a rough onboarding hint.
 */
export async function getInitialScanKeys(sql: postgres.Sql, scanKeys: string[]): Promise<string[]> {
    // Filter before SQL: a predicate around a cast is not a reliable guard
    // against PostgreSQL evaluating that cast first. Match the whole key.
    const validKeys = scanKeys.filter((key) => key === 'all' || UUID_RE.exec(key)?.[0] === key);
    if (validKeys.length === 0) return [];
    const rows = await sql<{ scan_key: string }[]>`
        SELECT scope.scan_key
        FROM unnest(${validKeys}::text[]) AS scope(scan_key)
        WHERE EXISTS (
            SELECT 1 FROM library_paths lp
            WHERE (scope.scan_key = 'all' OR lp.id = NULLIF(scope.scan_key, 'all')::uuid)
              AND NOT EXISTS (
                  SELECT 1 FROM file_scanner_runs r
                  WHERE r.library_path_id IS NULL AND r.completed_at >= lp.created_at
                    AND r.errors >= 0
              )
              AND NOT EXISTS (
                  SELECT 1 FROM file_scanner_runs r
                  WHERE r.library_path_id = lp.id AND r.completed_at IS NOT NULL
                    AND r.errors >= 0
              )
        )
    `;
    return rows.map((row) => row.scan_key);
}
