// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/tasks/{taskId}/backlog
 *
 * Auth scope: tasks:read
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getDb } from '$lib/server/database/connection.js';
import { buildAdminContextStub } from '$lib/server/tasks/plugin-context.js';
import { Logger } from '$lib/server/utils/logger.js';
import { json } from '@sveltejs/kit';
// Share the UI contract: response conformance must preserve stage.id, which
// BacklogCard uses as its keyed-each identity (including 'ineligible').
import { BacklogResponseSchema } from '$lib/schemas/task-definition.schema.js';

const log = Logger.for('api.v1.tasks.backlog');

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Tasks'],
            summary: 'Get task backlog',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the backlog summary (stages and remaining count) for the task. Requires `tasks:read` scope.',
            responses: {
                200: {
                    schema: BacklogResponseSchema,
                    description: 'Backlog summary',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:read'] },
    handlers: {
        GET: async (event) => {
            const taskId = event.params.taskId!;
            const task = registry.getTask(taskId);
            if (!task) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            if (!task.backlog) {
                return ApiProblem.notFound(`Task '${taskId}' has no backlog definition`);
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'Database unavailable — cannot read task backlog',
                );
            }

            const stubCtx = buildAdminContextStub(taskId, { sql });

            try {
                const stages = await task.backlog.stages(stubCtx);
                const remainingHint = stages.reduce((sum, s) => sum + (s.count ?? 0), 0);
                return json({
                    unitLabel: task.backlog.unitLabel,
                    stages,
                    remainingHint,
                });
            } catch (err) {
                log.warn('backlog.stages() failed in admin context', {
                    taskId,
                    err: String(err),
                });
                return json({ stages: [], message: 'backlog query needs runtime context' });
            }
        },
    },
});
