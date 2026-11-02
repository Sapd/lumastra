// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The runs a user started by hand — the source for the app-wide "my manual
 * actions" tracker (progress on every page, a success/failure notice at the
 * end, even across a reload).
 */

import type postgres from 'postgres';

export interface ManualRunRow {
    id: string;
    task_id: string;
    parent_run_id: string | null;
    label: string | null;
    state: string;
    scope: { libraryGroupId?: string; subjectId?: string } | null;
    input: unknown;
    started_at: Date;
    completed_at: Date | null;
    error: unknown;
    stages: unknown;
}

/**
 * `identities` are matched case-insensitively against `trigger.by`, which is a
 * USERNAME on most manual routes but the user's UUID on a few (library scan /
 * ingest, "run task now", MAL/Trakt sync) — pass both.
 *
 * Returns the user's manual runs that are live or finished after `since`, plus
 * the same-task CHILDREN of any of the user's manual runs from the last 24h
 * that are live or finished after `since`. A manual "scan all" is a parent that
 * dispatches one run per library and completes at once; its children are
 * found through the parent for as long as they run, not only while the
 * parent itself is inside `since` (they would otherwise drop out one poll
 * after the parent ends, and their completions would never be announced).
 * Children of a DIFFERENT task (a pipeline's members and its internal
 * `__gate__` rows) are not the user's action and are left out.
 *
 * `since` is meant to OVERLAP the previous answer: a run's `completed_at` can
 * precede the moment its row became visible (transaction-start NOW(), batched
 * terminal writes, replay after an outage), so the caller dedups by run id.
 *
 * Live rows sort first, so the limit can only ever cut finished ones.
 */
export async function listMyManualRuns(
    sql: postgres.Sql,
    identities: readonly string[],
    since: Date,
    limit = 100,
): Promise<ManualRunRow[]> {
    const ids = [...new Set(identities.filter(Boolean).map((i) => i.toLowerCase()))];
    if (ids.length === 0) return [];
    return sql<ManualRunRow[]>`
        WITH mine AS (
            SELECT id, task_id, state, completed_at FROM task_history
            WHERE state IN ('pending', 'active', 'cancelling')
              AND trigger->>'kind' = 'manual'
              AND lower(trigger->>'by') = ANY(${ids}::text[])
            UNION
            SELECT id, task_id, state, completed_at FROM task_history
            WHERE state IN ('completed', 'failed', 'cancelled')
              AND completed_at > now() - interval '24 hours'
              AND trigger->>'kind' = 'manual'
              AND lower(trigger->>'by') = ANY(${ids}::text[])
        ),
        wanted AS (
            SELECT id FROM mine
            WHERE state IN ('pending', 'active', 'cancelling') OR completed_at > ${since}
            UNION
            SELECT c.id FROM task_history c
            JOIN mine p ON c.parent_run_id = p.id AND c.task_id = p.task_id
            WHERE c.state IN ('pending', 'active', 'cancelling') OR c.completed_at > ${since}
        )
        SELECT th.id, th.task_id, th.parent_run_id, th.label, th.state, th.scope, th.input,
               th.started_at, th.completed_at, th.error, th.stages
        FROM task_history th
        WHERE th.id IN (SELECT id FROM wanted)
        ORDER BY (th.state IN ('pending', 'active', 'cancelling')) DESC, th.started_at DESC
        LIMIT ${limit}
    `;
}

/** Display names for the library groups / paths a set of runs acted on. */
export async function loadRunLibraryNames(
    sql: postgres.Sql,
    groupIds: readonly string[],
    pathIds: readonly string[],
): Promise<{ groups: Map<string, string>; paths: Map<string, string> }> {
    const [groups, paths] = await Promise.all([
        groupIds.length
            ? sql<{ id: string; name: string }[]>`
                  SELECT id::text, name FROM library_groups WHERE id = ANY(${[...groupIds]}::uuid[])`
            : Promise.resolve([]),
        pathIds.length
            ? sql<{ id: string; path: string; group_name: string | null }[]>`
                  SELECT lp.id::text, lp.path, lg.name AS group_name
                  FROM library_paths lp
                  LEFT JOIN library_groups lg ON lg.id = lp.library_group_id
                  WHERE lp.id = ANY(${[...pathIds]}::uuid[])`
            : Promise.resolve([]),
    ]);
    return {
        groups: new Map(groups.map((g) => [g.id, g.name])),
        paths: new Map(paths.map((p) => [p.id, p.group_name ?? p.path])),
    };
}
