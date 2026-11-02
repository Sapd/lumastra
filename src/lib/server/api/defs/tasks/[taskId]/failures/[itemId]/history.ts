// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/tasks/{taskId}/failures/{itemId}/history
 *
 * Named params identify the task/plugin and the failing item.
 *
 * Surfaces `getFailureTimeline()` (plugin-failure-events.queries.ts), which
 * had zero callers outside its own test file until this endpoint — a per-item
 * failure history was recorded on every retry but never shown: each retry
 * only ever surfaced the latest reason, prior attempts were invisible even
 * though they were sitting in `plugin_failure_events`.
 *
 * `buildFailureHistory` is exported for direct integration testing; the GET
 * handler is a thin wrapper. Auth: `tasks:admin` scope (WAS `tasks:read` —
 * moved 2026-09-18 fix-plan-4 Task 2, Shape C ruling's five-endpoint sweep;
 * matches the parent failures list endpoint, `tasks/[taskId]/failures.ts`, which
 * moved for the same reason).
 */

import type postgres from 'postgres';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getFailureTimeline } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { stripSecrets, redactPaths } from '$lib/shared/transcode-failure-report.js';
import { FailureTimelineResponseSchema } from '$lib/schemas/task-definition.schema.js';

/** One more than what's ever returned — lets us detect truncation without a
 *  separate COUNT query. */
const HISTORY_FETCH_LIMIT = 200;

const logger = Logger.for('TaskFailureHistoryDef');

/**
 * Fetch a single item's failure timeline and shape it for the response
 * schema — oldest event first, which is the natural reading order for
 * "here's what happened, attempt by attempt" (the underlying query returns
 * newest-first for its own DESC-ordered admin list use case, so this
 * reverses it).
 *
 * `reason` is redacted server-side (secrets + absolute media paths) before
 * it ever leaves the process — the configured library roots are NOT part of
 * the response. They're the host's filesystem layout. This endpoint is now
 * `tasks:admin`-gated (moved 2026-09-18 fix-plan-4 Task 2 — see the file
 * header), not `library:admin`-gated like every other surface that touches
 * `library_paths`, so the redaction stays as defence-in-depth rather than
 * being removed now that the gate itself is stricter.
 */
export async function buildFailureHistory(
    sql: postgres.Sql,
    pluginId: string,
    itemId: string,
): Promise<{
    pluginId: string;
    itemId: string;
    events: {
        id: string;
        reason?: string;
        occurredAt: Date;
        runId?: string;
        fileId?: string;
        inputIdentity?: string;
        processingVersion?: number;
        inputScope?: 'current' | 'earlier' | 'unverified';
    }[];
    truncated: boolean;
}> {
    const rowsPromise = getFailureTimeline(sql, pluginId, itemId, HISTORY_FETCH_LIMIT + 1);
    const libraryRootsPromise = getEnabledLibraryPaths(sql)
        .then((paths) => paths.map((p) => p.path))
        .catch((err: unknown) => {
            // Best-effort: a failure here must not take down the (otherwise
            // successful) failure-timeline response, but it does mean any
            // absolute path in `reason` won't get redacted this time.
            logger.warn('buildFailureHistory: failed to load library roots for redaction', {
                error: err,
            });
            return [] as string[];
        });

    const [rows, libraryRoots] = await Promise.all([rowsPromise, libraryRootsPromise]);

    const truncated = rows.length > HISTORY_FETCH_LIMIT;
    const capped = truncated ? rows.slice(0, HISTORY_FETCH_LIMIT) : rows;

    const sanitize = (text: string): string =>
        redactPaths(stripSecrets(text), { libraryRoots, unquoted: true });

    const events = capped
        .slice()
        .reverse()
        .map((r) => ({
            id: r.id,
            reason: r.reason ? sanitize(r.reason) : undefined,
            occurredAt: r.occurred_at,
            runId: r.run_id ?? undefined,
            ...(pluginId === 'lumastra-intro-analyzer'
                ? {
                      fileId: r.file_id ?? undefined,
                      inputIdentity: r.input_identity ?? undefined,
                      processingVersion: r.processing_version ?? undefined,
                      inputScope: r.input_scope ?? 'unverified',
                  }
                : {}),
        }));

    return {
        pluginId,
        itemId,
        events,
        truncated,
    };
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Tasks'],
            summary: 'Get the full failure history for a single item',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns up to the 200 most recent failure events for one (task, item) ' +
                'pair, oldest first, with `reason` already redacted (secrets + absolute ' +
                'media paths) server-side. `truncated: true` means older events beyond ' +
                'the 200 returned were dropped. Requires `tasks:admin` scope. Path ' +
                'params: `{taskId}` is the task slug, `{itemId}` is the item id.',
            responses: {
                200: {
                    schema: FailureTimelineResponseSchema,
                    description: 'Failure history',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task not found',
                500: 'Internal server error',
            },
        },
    },

    // WAS `tasks:read` — moved to `tasks:admin` (2026-09-18 fix-plan-4 Task 2,
    // Shape C ruling's five-endpoint sweep; see defs/library/paths.ts for the
    // full rationale, identical here).
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    handlers: {
        GET: async (event) => {
            const taskId = event.params.taskId!;
            const itemId = event.params.itemId!;

            const task = registry.getTask(taskId);
            if (!task) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'Database unavailable — cannot read failure history',
                );
            }

            const result = await buildFailureHistory(sql, taskId, itemId);

            return json(FailureTimelineResponseSchema.parse(result));
        },
    },
});
