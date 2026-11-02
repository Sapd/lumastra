// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineEndpoint } from '$lib/server/api/define.js';
import { problem } from '$lib/server/api/problem.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import { listRunsGrouped } from '$lib/server/database/queries/runs-grouped.queries.js';
import type { RunState } from '@sapd/lumastra-plugin-sdk';
import { V1RunsQuerySchema } from '$lib/schemas/api-query-params.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { RunGroupedResponseSchema } from '$lib/schemas/run.schema.js';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';

const GroupsQuerySchema = V1RunsQuerySchema.pick({
    state: true,
    libraryGroupId: true,
    since: true,
});
const VALID_RUN_STATES: ReadonlySet<RunState> = new Set([
    'pending',
    'active',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
]);

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Runs'],
            summary: 'List runs grouped by task',
            stability: 'beta',
            query: GroupsQuerySchema,
            responses: {
                200: {
                    schema: RunGroupedResponseSchema,
                    description: 'Run groups across the full history',
                },
                400: 'Invalid query',
                401: 'Authentication required',
                403: 'Insufficient scope',
                500: 'Internal server error',
            },
        },
    },
    auth: { kind: 'scope', anyOf: ['runs:read'] },
    handlers: {
        GET: async (event) => {
            const parsed = GroupsQuerySchema.safeParse(Object.fromEntries(event.url.searchParams));
            if (!parsed.success) {
                // Field naming mirrors validate.ts formatZodError() for the
                // 'query' source verbatim: `query.<path>` (body is the only
                // source that special-cases an empty path).
                const errors = parsed.error.issues.map((issue) => ({
                    field: `query.${issue.path.join('.')}`,
                    message: issue.message,
                }));
                return ApiResponses.validationError(errors, event.url.pathname);
            }

            const { state: stateParam, libraryGroupId, since: sinceParam } = parsed.data;

            const since = sinceParam ? new Date(sinceParam) : undefined;

            let state: RunState[] | undefined;
            if (stateParam) {
                const requested = stateParam
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                const unknown = requested.filter((s) => !VALID_RUN_STATES.has(s as RunState));
                if (unknown.length > 0) {
                    return problem('validation_failed', {
                        error: `Unknown state(s): ${unknown.join(', ')}. Valid: ${[...VALID_RUN_STATES].join(', ')}`,
                    });
                }
                state = requested as RunState[];
            }

            const sql = getTaskDb();
            if (!sql) {
                return problem('dependency_unavailable', { error: 'Database unavailable' });
            }

            const rows = await listRunsGrouped(sql, {
                state,
                libraryGroupId,
                since,
            });

            // Resolve display names from the task registry. Tasks that were
            // unregistered (old plugins) fall back to their task_id string.
            const groups = rows.map((row) => {
                const taskDef = registry.getTask(row.taskId);
                return {
                    taskId: row.taskId,
                    name: taskDisplayName(row.taskId, taskDef?.name),
                    count: row.count,
                    stateCounts: row.stateCounts,
                    latestRun: row.latestRun,
                    oldestActiveAt: row.oldestActiveAt,
                };
            });

            return typedJson(RunGroupedResponseSchema, {
                items: groups,
                page: { limit: groups.length, offset: 0, hasMore: false },
            });
        },
    },
});
