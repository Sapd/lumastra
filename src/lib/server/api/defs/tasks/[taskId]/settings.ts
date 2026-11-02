// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/tasks/{taskId}/settings
 * PUT /api/v1/tasks/{taskId}/settings
 *
 * GET and PUT both require tasks:admin (security review 2026-09-12, C16 —
 * GET exposed secret key names and non-secret values to any tasks:read
 * caller, i.e. every `read`-scoped user; API.md already documented this
 * surface as tasks:admin, so the code is now aligned with the docs).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getDb } from '$lib/server/database/connection.js';
import { PluginSecrets } from '$lib/server/tasks/secrets.js';
import { buildAdminContextStub } from '$lib/server/tasks/plugin-context.js';
import { Logger } from '$lib/server/utils/logger.js';
import { taskSettingsPutBodySchema } from '$lib/schemas/admin.js';
import type postgres from 'postgres';
import { upsertTaskSettings } from '$lib/server/database/queries/task-settings.queries.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';

const SettingsFieldSchema = z.object({
    key: z.string(),
    label: z.string().optional(),
    type: z
        .string()
        .meta({ description: 'Field type: "string", "number", "boolean", "secret", etc.' }),
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.any().optional(),
    options: z
        .array(
            z.object({ value: z.union([z.string(), z.number(), z.boolean()]), label: z.string() }),
        )
        .optional()
        .meta({ description: 'Select-field choices as {value,label} pairs' }),
    validation: z.any().optional(),
    advanced: z.boolean().optional().meta({
        description:
            'Fine-tuning knob most operators never need; admin UIs fold these under "Advanced"',
    }),
});

const TaskSettingsResponseSchema = z.object({
    fields: z
        .array(SettingsFieldSchema)
        .optional()
        .meta({ description: 'Schema definitions for configurable fields (GET only)' }),
    values: z
        .record(z.string(), z.any())
        .optional()
        .meta({ description: 'Current non-secret values keyed by field name (GET only)' }),
    secrets: z
        .array(z.string())
        .optional()
        .meta({ description: 'Field names whose values are stored as secrets (GET only)' }),
    ok: z
        .literal(true)
        .optional()
        .meta({ description: 'Confirmation flag returned by PUT on success' }),
});

const TaskSettingsPutBodySchema = z.record(z.string(), z.any()).meta({
    description: 'Map of field keys to new values. Omitted fields are unchanged.',
});

const log = Logger.for('api.v1.tasks.settings');

interface SettingRow {
    key: string;
    value: unknown;
}
interface SecretKeyRow {
    key: string;
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Tasks'],
            summary: 'Get task settings',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the configurable settings schema and current values for the task. Requires `tasks:admin` scope.',
            responses: {
                200: {
                    schema: TaskSettingsResponseSchema,
                    description: 'Task settings schema and values',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task not found or has no settings',
                500: 'Internal server error',
            },
        },
        PUT: {
            tags: ['Tasks'],
            summary: 'Update task settings',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Updates one or more configurable settings for the task. ' +
                'Omitted fields are unchanged. Requires `tasks:admin` scope.',
            body: TaskSettingsPutBodySchema,
            responses: {
                200: {
                    schema: TaskSettingsResponseSchema,
                    description: 'Settings updated',
                },
                400: 'Validation error',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task not found or has no settings',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        // security review 2026-09-12, C16: GET moved from tasks:read to
        // tasks:admin — it returns secret key names, not just non-secret
        // values, so it belongs behind the same gate as PUT.
        GET: { kind: 'scope', anyOf: ['tasks:admin'] },
        PUT: { kind: 'scope', anyOf: ['tasks:admin'] },
    },
    /**
     * REQUEST CONTRACT — PUT body.
     *
     * Derived from taskSettingsPutBodySchema in schemas/admin.ts.
     * mount() validates this BEFORE the handler runs on PUT; GET has no body
     * so mount() skips body validation for GET automatically.
     * The handler's own safeParse() continues to work unchanged (double-parse).
     * Schema is .strict() — unknown fields are rejected with a 422, not stripped.
     */
    request: {
        body: taskSettingsPutBodySchema,
    },
    handlers: {
        GET: async (event) => {
            const taskId = event.params.taskId!;
            const task = registry.getTask(taskId);
            if (!task) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            if (!task.settings) {
                return ApiProblem.notFound(`Task '${taskId}' has no settings definition`);
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const settingRows = (await sql`
                SELECT key, value
                FROM plugin_settings
                WHERE plugin_id = ${taskId}
            `) as unknown as SettingRow[];
            const values: Record<string, unknown> = {};
            for (const row of settingRows) {
                values[row.key] = row.value;
            }

            const secretRows = (await sql`
                SELECT key
                FROM plugin_secrets
                WHERE plugin_id = ${taskId}
            `) as unknown as SecretKeyRow[];
            const secrets = secretRows.map((r) => r.key);

            const fields = task.settings.fields.map((f) => ({
                key: f.key,
                label: f.label,
                type: f.type,
                description: f.description,
                required: f.required,
                default: f.type === 'secret' ? undefined : f.default,
                options: f.options,
                validation: f.validation,
                advanced: f.advanced,
            }));

            return json({ fields, values, secrets });
        },

        PUT: async (event, ctx) => {
            const taskId = event.params.taskId!;
            if (taskId === 'core.server') {
                return ApiProblem.forbidden('Core server identity is not editable');
            }
            const task = registry.getTask(taskId);
            if (!task) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            if (!task.settings) {
                return ApiProblem.notFound(`Task '${taskId}' has no settings definition`);
            }

            // mount() has already validated + parsed the body via the `request`
            // contract — use ctx.input.body to avoid re-reading the consumed stream.
            // Fall back to manual parse for callers that bypass mount() (e.g. tests
            // using plain mock objects without a real Request).
            let parsed: ReturnType<typeof taskSettingsPutBodySchema.safeParse>;
            if (ctx.input?.body !== undefined) {
                parsed = { success: true as const, data: ctx.input.body };
            } else {
                let rawBody: unknown;
                try {
                    rawBody = await event.request.clone().json();
                } catch {
                    const contentType = event.request.headers.get('content-type') ?? '';
                    const contentLength = event.request.headers.get('content-length');
                    const hasJsonContent = contentType.includes('application/json');
                    const hasBody = contentLength !== null && contentLength !== '0';
                    if (hasJsonContent || hasBody) {
                        return problem('validation_failed', {
                            error: 'Invalid JSON in request body',
                        });
                    }
                    rawBody = {};
                }
                parsed = taskSettingsPutBodySchema.safeParse(rawBody);
            }
            if (!parsed.success) {
                return problem('validation_failed', {
                    error: 'Invalid settings update body',
                    details: parsed.error.issues.map((i) => ({
                        field: i.path.length === 0 ? 'body' : `body.${i.path.join('.')}`,
                        message: i.message,
                    })),
                });
            }

            const { values, secrets: secretsUpdate } = parsed.data;

            const MAX_KEYS = 50;
            const MAX_VALUE_BYTES = 4096;
            const MAX_SECRET_BYTES = 8192;

            if (values && Object.keys(values).length > MAX_KEYS) {
                return problem('validation_failed', {
                    error: `Too many settings values: ${Object.keys(values).length} (max ${MAX_KEYS})`,
                });
            }
            if (secretsUpdate && Object.keys(secretsUpdate).length > MAX_KEYS) {
                return problem('validation_failed', {
                    error: `Too many secrets: ${Object.keys(secretsUpdate).length} (max ${MAX_KEYS})`,
                });
            }
            if (values) {
                for (const [key, value] of Object.entries(values)) {
                    const serialized = JSON.stringify(value ?? null);
                    if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
                        return problem('validation_failed', {
                            error: `Value for '${key}' exceeds ${MAX_VALUE_BYTES} bytes when serialized`,
                        });
                    }
                }
            }
            if (secretsUpdate) {
                for (const [key, value] of Object.entries(secretsUpdate)) {
                    if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
                        return problem('validation_failed', {
                            error: `Secret '${key}' exceeds ${MAX_SECRET_BYTES} bytes`,
                        });
                    }
                }
            }

            const declaredKeys = new Set(
                task.settings.fields.filter((f) => f.type !== 'secret').map((f) => f.key),
            );
            const declaredSecretKeys = new Set(
                task.settings.fields.filter((f) => f.type === 'secret').map((f) => f.key),
            );

            if (values) {
                const fieldByKey = new Map(task.settings.fields.map((f) => [f.key, f]));
                for (const [key, value] of Object.entries(values)) {
                    if (!declaredKeys.has(key)) {
                        return problem('validation_failed', {
                            error: `Unknown settings key '${key}'`,
                            details: [
                                {
                                    field: `values.${key}`,
                                    message: `Declared keys: ${[...declaredKeys].join(', ')}`,
                                },
                            ],
                        });
                    }
                    const field = fieldByKey.get(key);
                    const validation = field?.validation;
                    if (validation) {
                        if (
                            typeof validation.min === 'number' &&
                            typeof value === 'number' &&
                            value < validation.min
                        ) {
                            return problem('validation_failed', {
                                error: `Value for '${key}' (${value}) is below declared min ${validation.min}`,
                                details: [
                                    { field: `values.${key}`, message: `min: ${validation.min}` },
                                ],
                            });
                        }
                        if (
                            typeof validation.max === 'number' &&
                            typeof value === 'number' &&
                            value > validation.max
                        ) {
                            return problem('validation_failed', {
                                error: `Value for '${key}' (${value}) exceeds declared max ${validation.max}`,
                                details: [
                                    { field: `values.${key}`, message: `max: ${validation.max}` },
                                ],
                            });
                        }
                        if (typeof validation.pattern === 'string' && typeof value === 'string') {
                            try {
                                const re = new RegExp(validation.pattern);
                                if (!re.test(value)) {
                                    return problem('validation_failed', {
                                        error: `Value for '${key}' does not match declared pattern /${validation.pattern}/`,
                                        details: [
                                            { field: `values.${key}`, message: 'pattern mismatch' },
                                        ],
                                    });
                                }
                            } catch {
                                // Malformed pattern declared by the plugin — skip check.
                            }
                        }
                    }
                }
            }

            if (secretsUpdate) {
                for (const key of Object.keys(secretsUpdate)) {
                    if (!declaredSecretKeys.has(key)) {
                        return problem('validation_failed', {
                            error: `Unknown secret key '${key}'`,
                            details: [
                                {
                                    field: `secrets.${key}`,
                                    message: `Declared secret keys: ${[...declaredSecretKeys].join(', ')}`,
                                },
                            ],
                        });
                    }
                }
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            await sql.begin(async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;
                if (values && Object.keys(values).length > 0) {
                    await upsertTaskSettings(tx, taskId, values);
                }
                if (secretsUpdate && Object.keys(secretsUpdate).length > 0) {
                    const pluginSecrets = new PluginSecrets(tx);
                    for (const [key, value] of Object.entries(secretsUpdate)) {
                        await pluginSecrets.set(taskId, key, value);
                    }
                }
            });

            // Security fix C24 (2026-09-16): auditActor(event) resolves the
            // USERNAME, not the users.id UUID the hand-built object below
            // used to pass as `username` — see work-profile.ts for the
            // GDPR-erasure rationale.
            auditLog('task.settings.update', taskId, auditActor(event), {
                settingKeys: values ? Object.keys(values) : [],
                secretKeys: secretsUpdate ? Object.keys(secretsUpdate) : [],
            });

            if (task.lifecycle?.onConfigChange) {
                const stubCtx = buildAdminContextStub(taskId, {
                    sql,
                    settings: async () => values ?? {},
                });
                try {
                    await task.lifecycle.onConfigChange(stubCtx, values ?? {});
                } catch (err) {
                    log.warn('onConfigChange hook failed', { taskId, err: String(err) });
                }
            }

            return json({ ok: true });
        },
    },
});
