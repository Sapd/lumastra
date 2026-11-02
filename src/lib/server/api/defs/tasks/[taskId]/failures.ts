// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/tasks/{taskId}/failures
 *
 * Auth scope: tasks:admin (WAS tasks:read — moved 2026-09-18 fix-plan-4 Task 2,
 * C2 / Shape C ruling; see the `auth:` stanza below). Collection envelope:
 * `{ items, page: { limit, hasMore, nextCursor?, total } }`
 * — matches `FailuresResponseSchema` in `$lib/schemas/task-definition.schema.js`,
 * the single source of truth admin-UI consumers (`TaskFailuresList.svelte`)
 * validate against.
 *
 * `buildTaskFailuresList` is exported for direct integration testing (same
 * pattern as `buildRateQueue` in defs/rate/queue.ts); the GET handler is a
 * thin wrapper.
 */

import { z } from 'zod';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    FailuresResponseSchema,
    type FailuresResponse,
} from '$lib/schemas/task-definition.schema.js';
import {
    getFailureAggregates,
    getFailureItemTitles,
    liveFailureSubjectPredicate,
    type FailureAggregateRow,
} from '$lib/server/database/queries/plugin-failure-events.queries.js';
import { resolveScopeGatedAccessBoundary } from '$lib/server/utils/scope-gated-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { json } from '@sveltejs/kit';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { stripSecrets, redactPaths } from '$lib/shared/transcode-failure-report.js';

const TaskFailuresQuerySchemaFromDocs = z.object({
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .meta({ description: 'Max failure records to return (1-200, default 50)' }),
    cursor: z.string().optional().meta({ description: 'Opaque base64 keyset cursor' }),
});

/**
 * Query schema for GET /tasks/{taskId}/failures.
 *
 * Derived from what the handler actually reads:
 *   - limit:  coerced integer, 1–200, default 50
 *   - cursor: opaque base64 keyset cursor
 *
 * Unknown query params are stripped (no .strict()).
 * Use z.coerce.number() because URLSearchParams values are always strings.
 */
const TaskFailuresQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
});

interface FailureRow {
    id: string;
    item_id: string;
    run_id: string | null;
    reason: string | null;
    meta: unknown;
    occurred_at: Date;
}

/**
 * Fetch one page of failure rows for a task and shape them into the
 * `FailuresResponseSchema` envelope. `id` is cast to `::text` in SQL —
 * `plugin_failure_events.id` is BIGINT, and this app's global type parser
 * (connection.ts) returns bigint columns as JS `number` by default. Left
 * uncast, `FailuresResponseSchema.parse()` below rejects every row (`id`
 * is typed `string`) and the endpoint 500s the moment the table has any
 * real data — which no test caught, because every prior test mocked the
 * row shape instead of reading one back from Postgres. The cast also fixes
 * `nextCursor` encoding: `Buffer.from(<number>)` allocates a zero-filled
 * buffer of that many bytes, not a buffer containing the number's digits.
 *
 * `plugin_failure_events` is an append-only log — nothing marks an earlier
 * event for the same item resolved when a later one is recorded, so an item
 * that fails on every periodic run accumulates one unresolved row per
 * attempt. A plain per-row SELECT therefore lists the same item multiple
 * times (this is real data, not a join bug: there is no JOIN in this query
 * at all). The query below groups to the LATEST event per `item_id` so the
 * list — and the "Showing N of M" count above it — is one row per distinct
 * failing item; `getFailureAggregates` folds the dropped earlier events back
 * in as `failureCount` rather than losing them.
 */
export async function buildTaskFailuresList(
    sql: postgres.Sql,
    taskId: string,
    opts: { limit: number; cursorId: string | null },
    access: MediaAccessBoundary,
): Promise<{
    failures: {
        id: string;
        itemId: string;
        runId?: string;
        reason?: string;
        meta?: unknown;
        occurredAt: Date;
        title?: string;
        failureCount?: number;
    }[];
    total: number;
    nextCursor?: string;
}> {
    const { limit, cursorId } = opts;

    // Same live-subject predicate as the attention-board count
    // (countUnresolvedFailuresByPlugin) so the tile and this list agree: a
    // deleted, fileless or already-completed subject is not "unresolved" here
    // either (see liveFailureSubjectPredicate for the prod numbers).
    const [{ total }] = await sql<{ total: number }[]>`
        SELECT COUNT(DISTINCT f.item_id)::int AS total
        FROM plugin_failure_events f
        WHERE f.plugin_id = ${taskId}
          AND f.resolved_at IS NULL
          ${liveFailureSubjectPredicate(sql, 'f')}
    `;

    const rows = (cursorId
        ? await sql`
            WITH latest AS (
                SELECT f.item_id, MAX(f.id) AS latest_id
                FROM plugin_failure_events f
                WHERE f.plugin_id = ${taskId}
                  AND f.resolved_at IS NULL
                  ${liveFailureSubjectPredicate(sql, 'f')}
                GROUP BY f.item_id
            )
            SELECT pfe.id::text AS id, pfe.item_id, pfe.run_id, pfe.reason, pfe.meta, pfe.occurred_at
            FROM plugin_failure_events pfe
            JOIN latest l ON l.item_id = pfe.item_id AND l.latest_id = pfe.id
            WHERE l.latest_id > ${cursorId}
            ORDER BY l.latest_id
            LIMIT ${limit + 1}
          `
        : await sql`
            WITH latest AS (
                SELECT f.item_id, MAX(f.id) AS latest_id
                FROM plugin_failure_events f
                WHERE f.plugin_id = ${taskId}
                  AND f.resolved_at IS NULL
                  ${liveFailureSubjectPredicate(sql, 'f')}
                GROUP BY f.item_id
            )
            SELECT pfe.id::text AS id, pfe.item_id, pfe.run_id, pfe.reason, pfe.meta, pfe.occurred_at
            FROM plugin_failure_events pfe
            JOIN latest l ON l.item_id = pfe.item_id AND l.latest_id = pfe.id
            ORDER BY l.latest_id
            LIMIT ${limit + 1}
          `) as unknown as FailureRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
        ? Buffer.from(page[page.length - 1].id).toString('base64')
        : undefined;

    const itemIds = page.map((r) => r.item_id);
    // Enrichment only — a failure here must not cost the endpoint the page
    // it already has (same trade-off `listFailedItems` makes for the same
    // helper elsewhere).
    const [aggregates, titles, libraryRoots] = await Promise.all([
        getFailureAggregates(sql, taskId, itemIds).catch(
            () => new Map<string, FailureAggregateRow>(),
        ),
        getFailureItemTitles(sql, itemIds, access).catch(() => new Map<string, string>()),
        getEnabledLibraryPaths(sql)
            .then((paths) => paths.map((p) => p.path))
            .catch(() => [] as string[]),
    ]);
    // Same redaction as the per-item history endpoint, so one failure's text
    // is not shown redacted in one view and raw in the other.
    const sanitize = (text: string): string =>
        redactPaths(stripSecrets(text), { libraryRoots, unquoted: true });

    const failures = page.map((r: FailureRow) => ({
        id: r.id,
        itemId: r.item_id,
        runId: r.run_id ?? undefined,
        reason: r.reason ? sanitize(r.reason) : undefined,
        meta: r.meta ?? undefined,
        occurredAt: r.occurred_at,
        title: titles.get(r.item_id),
        failureCount: aggregates.get(r.item_id)?.failure_count,
    }));

    return { failures, total, nextCursor };
}

/** Map the database builder's result to the HTTP collection contract. */
export function taskFailuresResponse(
    result: Awaited<ReturnType<typeof buildTaskFailuresList>>,
    limit: number,
): FailuresResponse {
    return FailuresResponseSchema.parse({
        items: result.failures,
        page: {
            limit,
            hasMore: !!result.nextCursor,
            nextCursor: result.nextCursor,
            total: result.total,
        },
    });
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Tasks'],
            summary: 'Get task failure records',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the failure log for the task (dead-letter queue). Requires `tasks:admin` scope.',
            query: TaskFailuresQuerySchemaFromDocs,
            responses: {
                200: {
                    schema: FailuresResponseSchema,
                    description: 'Failure records',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task not found',
                500: 'Internal server error',
            },
        },
    },

    // WAS `tasks:read` — moved to `tasks:admin` (C2, 2026-09-18 fix-plan-4
    // Task 2). `tasks:read` used to be auto-granted to every non-admin
    // session (principal.ts `expandScopes`); that auto-grant is removed in
    // the same task (see ledger.md "Shape C" ruling), which is the
    // load-bearing fix — this endpoint move is belt-and-braces on top of it,
    // matching the five-endpoint sweep the ruling calls for.
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    /**
     * REQUEST CONTRACT — GET query params.
     *
     * Derived from TaskFailuresQuerySchema: limit (int 1–200) and cursor
     * (opaque base64 string).  mount() validates types before the handler
     * runs; the handler's own parseInt() / cursor logic is unchanged (safe
     * double-processing).  Unknown params are stripped (no .strict()).
     */
    request: {
        query: TaskFailuresQuerySchema,
    },
    handlers: {
        GET: async (event) => {
            const taskId = event.params.taskId!;
            const task = registry.getTask(taskId);
            if (!task) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            const url = event.url;
            const limitParam = url.searchParams.get('limit');
            const cursor = url.searchParams.get('cursor') ?? undefined;

            const limit = limitParam
                ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200)
                : 50;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'Database unavailable — cannot read task failures',
                );
            }

            // Decode cursor: base64(id) used as keyset offset.
            let cursorId: string | null = null;
            if (cursor) {
                try {
                    cursorId = Buffer.from(cursor, 'base64').toString('utf8');
                    // Buffer.from never throws on bad base64, so check the decoded
                    // id: anything but a bigint would 500 in the keyset comparison.
                    if (!/^\d{1,18}$/.test(cursorId)) throw new Error('not a row id');
                } catch {
                    return problem('validation_failed', { error: 'Invalid cursor format' });
                }
            }

            // KNOWN ASYMMETRY (not fixed by this task — recorded per review round 1):
            // buildSearchAccessContext (search-access-context.ts:82-87) applies the
            // age filter from user.maxAgeRating regardless of isAdmin, unlike the
            // library-group axis, which short-circuits for admins
            // (library-group-permissions-cache.ts:121). An admin whose maxAgeRating
            // happens to be non-null will silently lose titles here for
            // over-rated items. Pre-existing semantics on a widely-used shared
            // helper; out of this task's scope/risk budget to change.
            const access: MediaAccessBoundary = await resolveScopeGatedAccessBoundary(
                sql,
                event.locals.user,
            );
            const result = await buildTaskFailuresList(sql, taskId, { limit, cursorId }, access);

            return json(taskFailuresResponse(result, limit));
        },
    },
});
