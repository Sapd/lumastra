// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET    /api/v1/tasks/{taskId}/triggers  — the triggers in effect
 * PUT    /api/v1/tasks/{taskId}/triggers  — replace them all
 * DELETE /api/v1/tasks/{taskId}/triggers  — back to the task's declared schedule
 *
 * Jellyfin-style task triggers (spec 2026-09-27 Part 2): every N, daily at
 * HH:MM, weekly on a day at HH:MM, on server startup — several per task.
 * Times are the server's local time (the container's TZ), which GET reports
 * as `timeZone` so an editor can say which zone it is using.
 *
 * Interval triggers have a floor (15 minutes, or the task's own interval
 * when that is shorter): an arbitrary interval is how a library scan ends up
 * running every 5 minutes on a spinning-disk NAS — the reason the older
 * Triggers are the sole cadence API; pause remains a separate state control.
 *
 * Pausing is not a trigger: `PUT …/state { schedule: 'paused' }` keeps
 * working and leaves the triggers in place. All methods require
 * `tasks:admin` (security review C16).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    TaskTriggersResponseSchema,
    TaskTriggersUpdateSchema,
} from '$lib/schemas/task-definition.schema.js';
import {
    readTaskTriggers,
    resetTaskTriggers,
    saveTaskTriggers,
    taskSchedulability,
} from '$lib/server/tasks/trigger-service.js';
import { minIntervalMs, validateTriggers } from '$lib/server/tasks/triggers.js';
import { json } from '@sveltejs/kit';

const COMMON_ERRORS = {
    401: 'Authentication required',
    403: 'Insufficient scope',
    404: 'Task not found',
    500: 'Internal server error',
} as const;

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Tasks'],
            summary: 'Get a task’s triggers',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the triggers that start the task — the declared schedule as one interval ' +
                'trigger when no operator triggers are set (`isDefault`) — plus the server time ' +
                'zone daily/weekly triggers use, the next start and the interval floor. Requires ' +
                '`tasks:admin` scope.',
            responses: {
                200: { schema: TaskTriggersResponseSchema, description: 'Triggers in effect' },
                ...COMMON_ERRORS,
            },
        },
        PUT: {
            tags: ['Tasks'],
            summary: 'Replace a task’s triggers',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Replaces all triggers of the task (1–8): `interval` (`every`, e.g. `6h`), `daily` ' +
                '(`at` HH:MM), `weekly` (`weekday` 0–6 from Sunday, `at`) or `startup`. The next ' +
                'start is recomputed immediately. 422 when the task has no schedule of its own or ' +
                'an interval is below the floor. Requires `tasks:admin` scope.',
            body: TaskTriggersUpdateSchema,
            responses: {
                200: { schema: TaskTriggersResponseSchema, description: 'Updated triggers' },
                400: 'Validation error',
                422: 'Task has no schedule, or a trigger is not allowed',
                ...COMMON_ERRORS,
            },
        },
        DELETE: {
            tags: ['Tasks'],
            summary: 'Reset a task’s triggers',
            stability: 'beta',
            auth: 'bearer',
            description:
                "Removes the operator's triggers so the task's declared schedule (or its env " +
                'override) applies again. Requires `tasks:admin` scope.',
            responses: {
                200: { schema: TaskTriggersResponseSchema, description: 'Default triggers' },
                422: 'Task has no schedule',
                ...COMMON_ERRORS,
            },
        },
    },

    auth: {
        GET: { kind: 'scope', anyOf: ['tasks:admin'] },
        PUT: { kind: 'scope', anyOf: ['tasks:admin'] },
        DELETE: { kind: 'scope', anyOf: ['tasks:admin'] },
    },
    // `.partial()`: mount() validates a declared body for DELETE too, and the
    // reset DELETE carries none (an empty body parses as `{}`). PUT re-parses
    // strictly with the full schema below; the docs above keep the full PUT
    // body. Declaring a schema at all keeps mount()'s body-size cap in force.
    request: {
        body: TaskTriggersUpdateSchema.partial(),
        bodyMethods: ['PUT'],
    },
    handlers: {
        GET: async (event) => {
            const taskId = event.params.taskId!;
            const task = registry.getTask(taskId);
            if (!task) return ApiProblem.notFound(`Task '${taskId}' not found`);
            const sql = getTaskDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            return json(await readTaskTriggers(sql, task));
        },

        PUT: async (event, ctx) => {
            const taskId = event.params.taskId!;
            const task = registry.getTask(taskId);
            if (!task) return ApiProblem.notFound(`Task '${taskId}' not found`);

            const { schedulable, reason } = taskSchedulability(task);
            if (!schedulable) {
                return problem('validation_failed', {
                    error: `This task's schedule can't be changed: ${reason}`,
                });
            }

            const parsed = TaskTriggersUpdateSchema.safeParse(
                ctx.input?.body ?? (await event.request.json().catch(() => ({}))),
            );
            if (!parsed.success) {
                return problem('validation_failed', {
                    error: 'Invalid triggers',
                    details: parsed.error.issues.map((i) => ({
                        field: i.path.join('.') || 'body',
                        message: i.message,
                    })),
                });
            }

            const invalid = validateTriggers(
                parsed.data.triggers,
                minIntervalMs(task.schedule?.every),
            );
            if (invalid) return problem('validation_failed', { error: invalid });

            const sql = getTaskDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const actor = auditActor(event);
            await saveTaskTriggers(sql, task, parsed.data.triggers, actor.username ?? 'unknown');
            auditLog('task.triggers.set', taskId, actor, { triggers: parsed.data.triggers });
            return json(await readTaskTriggers(sql, task));
        },

        DELETE: async (event) => {
            const taskId = event.params.taskId!;
            const task = registry.getTask(taskId);
            if (!task) return ApiProblem.notFound(`Task '${taskId}' not found`);
            if (!taskSchedulability(task).schedulable) {
                return problem('validation_failed', { error: 'This task has no schedule.' });
            }
            const sql = getTaskDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            await resetTaskTriggers(sql, task);
            auditLog('task.triggers.reset', taskId, auditActor(event), {});
            return json(await readTaskTriggers(sql, task));
        },
    },
});
