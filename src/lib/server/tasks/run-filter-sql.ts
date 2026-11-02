// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The subject predicate is built as a CONDITIONAL fragment, unlike every other
 * `listRuns` filter which uses `AND ($n IS NULL OR col = $n)`.
 *
 * That difference is load-bearing, not stylistic. `idx_task_history_subject` is
 * a partial index with `WHERE (scope->>'subjectId') IS NOT NULL`. Postgres can
 * only use a partial index when it can PROVE the predicate from the query's
 * quals. A bare `scope->>'subjectId' = $1` proves it (a strict operator implies
 * NOT NULL); wrapping it in `$1 IS NULL OR ...` makes it unprovable under a
 * generic plan, and the query silently degrades to a sequential scan.
 */

export interface SqlFragment {
    sql: string;
    value: string;
}

export function buildSubjectPredicate(subjectId: string | undefined): SqlFragment | null {
    if (!subjectId) return null;
    return { sql: "AND scope->>'subjectId' = ", value: subjectId };
}
