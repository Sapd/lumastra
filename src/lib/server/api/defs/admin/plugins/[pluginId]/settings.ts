// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/plugins/[pluginId]/settings.ts
 *
 * GET /api/admin/plugins/[pluginId]/settings — read plugin settings for the admin UI
 * PUT /api/admin/plugins/[pluginId]/settings — write plugin settings (non-secret values + secrets)
 *
 * Auth: admin.  Surface: internal.
 * Scope: { kind: 'admin' } — internal admin BFF; no v1 surface.
 *
 * GET response: bare object { pluginId, pluginName, enabled, settingsConfig, currentSettings, uiPages }
 * PUT response: bare object { updated: true }
 * 503 dependency_unavailable on DB down.
 *
 * The functionally-equivalent /api/v1/tasks/[taskId]/settings uses a different
 * (token-scoped) shape and is reserved for external service tokens. This route
 * is forward-auth + admin-cookie-gated, but the shared Bearer producer
 * (`resolve-bearer-principal.ts`) also reaches it now — not cookie-auth-only.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { pluginIdParamsSchema } from '$lib/schemas/admin.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getDb } from '$lib/server/database/connection.js';
import { PluginSecrets } from '$lib/server/tasks/secrets.js';
import { buildAdminContextStub } from '$lib/server/tasks/plugin-context.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    PluginSettingsGetResponseSchema,
    PluginSettingsPutResponseSchema,
} from '$lib/schemas/api-admin-responses.js';
import type postgres from 'postgres';
import { WEBHOOK_SECRET_KEY } from '$lib/server/plugins/runtime/webhook-dispatch.js';
import { updateBucketRate } from '$lib/server/tasks/http-rate-limit.js';

const log = Logger.for('api.admin.plugin-settings');

// ── constants ─────────────────────────────────────────────────────────────────

const SECRET_CONFIGURED_SENTINEL = '__CONFIGURED__';

// Integrations own no `onConfigChange` lifecycle hook, but some hold a shared
// credential that background tasks consume. Saving such an integration's secret
// must still fire those tasks' onConfigChange so the change takes effect
// immediately — e.g. adding the Discogs token re-enrolls gap artists/albums for
// an immediate catch-up run, matching the old per-task settings behaviour.
// Keyed by credential-owning plugin id → dependent task ids.
const DEPENDENT_TASKS_ON_SECRET_CHANGE: Record<string, string[]> = {
    discogs: ['artist-enrichment', 'album-enrichment'],
};

const MAX_KEYS = 200;
const MAX_VALUE_BYTES = 4096;
const MAX_SECRET_BYTES = 64 * 1024;

// ── request schemas ───────────────────────────────────────────────────────────

const PutBodySchema = z
    .object({
        enabled: z.boolean().optional(),
        // Request-side raw plugin settings: keys + value types are defined by the
        // plugin's own SettingField manifest (genuinely heterogeneous across
        // plugins), so an open value map is unavoidable here. The handler
        // re-validates every key against the resolved task.settings.fields
        // (type/min/max/pattern/byte-size) before persisting — this gate only
        // asserts "settings is a plain object".
        settings: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();

// ── response schemas ──────────────────────────────────────────────────────────

// Single source of truth in $lib/schemas/api-admin-responses (PluginSettingsGet/
// PutResponseSchema, imported at the top). Also referenced by the v1 _openapi.ts
// at routes/api/v1/plugins/internal/[id]/settings. The handlers .parse() with
// these, so the documented shape matches the emitted shape exactly.

// ── row types ─────────────────────────────────────────────────────────────────

interface SettingRow {
    key: string;
    value: unknown;
}
interface SecretKeyRow {
    key: string;
}

/** Comma-separated text or an array → trimmed, non-empty strings. */
export function normalizeArrayValue(value: unknown): string[] {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return items
        .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
        .map((v) => String(v).trim())
        .filter((v) => v !== '');
}

// ── def ───────────────────────────────────────────────────────────────────────

/**
 * The settings fields an operator may actually write, which is not quite the
 * set the plugin declared.
 *
 * An integration declaring `capabilities.webhook` needs a `webhookSecret`
 * before its endpoint answers anything but 404, and nothing requires the author
 * to declare a matching field. Unknown keys are dropped by the handler, so
 * without this injection such a plugin's webhook could NEVER be turned on: the
 * secret had no way in, and the operator had no remedy. Injected by the host
 * because the host is what requires the key — not the plugin.
 *
 * A plugin that DOES declare its own `webhookSecret` field keeps it, label and
 * all; this only fills a hole.
 */
export function effectiveSettingsFields<F extends { key: string; type?: string; label?: string }>(
    declared: readonly F[],
    isWebhookIntegration: boolean,
): Map<string, F> {
    const byKey = new Map(declared.map((f) => [f.key, f]));
    if (isWebhookIntegration && !byKey.has(WEBHOOK_SECRET_KEY)) {
        byKey.set(WEBHOOK_SECRET_KEY, {
            key: WEBHOOK_SECRET_KEY,
            type: 'secret',
            label: 'Webhook secret',
        } as F);
    }
    return byKey;
}

/**
 * A non-secret value checked against the field's declared type. The PUT used
 * to store whatever arrived: a numeric STRING skipped min/max entirely, a
 * select could hold a value it never offered, and plugins read the wrong type.
 * `null` stays allowed (it clears the setting). A numeric string for a number
 * field is coerced, since that is what a hand-written API call sends.
 */
export function checkSettingFieldValue(
    field: { key: string; type?: string; options?: ReadonlyArray<{ value: string }> },
    value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
    if (value === null || value === undefined) return { ok: true, value };
    switch (field.type) {
        case 'number': {
            const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
            if (typeof n !== 'number' || !Number.isFinite(n)) {
                return { ok: false, error: `Value for '${field.key}' must be a number` };
            }
            return { ok: true, value: n };
        }
        case 'boolean':
            return typeof value === 'boolean'
                ? { ok: true, value }
                : { ok: false, error: `Value for '${field.key}' must be true or false` };
        case 'select':
            if (typeof value !== 'string') {
                return { ok: false, error: `Value for '${field.key}' must be a string` };
            }
            if (field.options?.length && !field.options.some((o) => o.value === value)) {
                return { ok: false, error: `Value for '${field.key}' is not one of its options` };
            }
            return { ok: true, value };
        case 'string':
        case 'multiline':
            return typeof value === 'string'
                ? { ok: true, value }
                : { ok: false, error: `Value for '${field.key}' must be a string` };
        default:
            return { ok: true, value };
    }
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: pluginIdParamsSchema,
        body: PutBodySchema,
    },
    handlers: {
        GET: async (event) => {
            const pluginId = event.params.pluginId;
            if (!pluginId) return ApiProblem.validationFailed('Missing pluginId');

            const task = registry.getConfigurable(pluginId);
            if (!task) return ApiProblem.notFound(`Plugin '${pluginId}' not found`);

            // A webhook integration is CONFIGURABLE even with no settings block
            // of its own, because the host injects `webhookSecret` for it. That
            // is the whole point of the injection: `sample-integration` declares
            // `capabilities.webhook` and no settings at all, and without this
            // the operator hits the no-settings state and still cannot reach
            // the secret their webhook needs.
            const isWebhookIntegration =
                registry.getIntegration(pluginId)?.capabilities?.webhook === true;

            if (!task.settings && !isWebhookIntegration) {
                // Plugin exists but declares no settings schema — return a
                // well-formed 200 with null config so the modal renders its
                // "no configurable settings" state instead of a red error.
                return json(
                    PluginSettingsGetResponseSchema.parse({
                        pluginId,
                        pluginName: task.name ?? pluginId,
                        enabled: true,
                        settingsConfig: null,
                        currentSettings: {},
                        uiPages: [],
                    }),
                );
            }

            const declaredFields = task.settings?.fields ?? [];
            if (!Array.isArray(declaredFields)) {
                return ApiProblem.internalError('Plugin settings definition is malformed');
            }
            // The SAME merge the PUT applies. Returning the raw declared list
            // here meant the modal never rendered the injected field, so the
            // operator still had no way to type the secret — the write path
            // accepted a key the read path never offered.
            const effectiveFields = [
                ...effectiveSettingsFields(declaredFields, isWebhookIntegration).values(),
            ];

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const settingRows = await sql<SettingRow[]>`
                SELECT key, value FROM plugin_settings WHERE plugin_id = ${pluginId}
            `;
            const currentSettings: Record<string, unknown> = {};
            for (const row of settingRows) currentSettings[row.key] = row.value;

            // Don't leak secret values — signal "configured" via sentinel so
            // the UI can show the field as filled. PUT strips it before write.
            const secretRows = await sql<SecretKeyRow[]>`
                SELECT key FROM plugin_secrets WHERE plugin_id = ${pluginId}
            `;
            const configuredSecretKeys = new Set(secretRows.map((r) => r.key));
            for (const f of effectiveFields) {
                if (f.type === 'secret' && configuredSecretKeys.has(f.key)) {
                    currentSettings[f.key] = SECRET_CONFIGURED_SENTINEL;
                }
            }

            return json(
                PluginSettingsGetResponseSchema.parse({
                    pluginId,
                    pluginName: task.name ?? pluginId,
                    enabled: true,
                    settingsConfig: { ...(task.settings ?? {}), fields: effectiveFields },
                    currentSettings,
                    uiPages: [],
                }),
            );
        },

        PUT: async (event) => {
            const pluginId = event.params.pluginId;
            if (pluginId === 'core.server') {
                return ApiProblem.forbidden('Core server identity is not editable');
            }
            if (!pluginId) return ApiProblem.validationFailed('Missing pluginId');

            const task = registry.getConfigurable(pluginId);
            if (!task) return ApiProblem.notFound(`Plugin '${pluginId}' not found`);

            const isWebhookIntegration =
                registry.getIntegration(pluginId)?.capabilities?.webhook === true;
            if (!task.settings && !isWebhookIntegration) {
                return ApiProblem.notFound(`Plugin '${pluginId}' has no settings definition`);
            }
            const declaredFields = task.settings?.fields ?? [];
            if (!Array.isArray(declaredFields)) {
                return ApiProblem.internalError('Plugin settings definition is malformed');
            }

            let rawBody: unknown;
            try {
                rawBody = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Invalid JSON body');
            }

            const parsed = PutBodySchema.safeParse(rawBody);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }
            const typedBody = parsed.data;

            if (typedBody.enabled === false) {
                return ApiProblem.validationFailed(
                    'Per-plugin disable is not implemented yet — use the task system controls instead',
                );
            }

            const incoming = typedBody.settings ?? {};
            if (Object.keys(incoming).length > MAX_KEYS) {
                return ApiProblem.validationFailed(
                    `Too many keys: ${Object.keys(incoming).length} (max ${MAX_KEYS})`,
                );
            }

            const fieldByKey = effectiveSettingsFields(declaredFields, isWebhookIntegration);
            const values: Record<string, unknown> = {};
            const secretsUpdate: Record<string, string> = {};
            const secretsToDelete: string[] = [];

            for (const [key, rawValue] of Object.entries(incoming)) {
                let value = rawValue;
                const field = fieldByKey.get(key);
                if (!field) {
                    log.warn('admin settings PUT: dropping unknown key', { pluginId, key });
                    continue;
                }

                if (field.type === 'secret') {
                    if (typeof value !== 'string') {
                        return ApiProblem.validationFailed(`Secret '${key}' must be a string`);
                    }
                    // The sentinel means "keep the stored secret". An explicit
                    // '' (the settings form's Clear) removes it.
                    if (value === SECRET_CONFIGURED_SENTINEL) continue;
                    if (value === '') {
                        secretsToDelete.push(key);
                        continue;
                    }
                    if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
                        return ApiProblem.validationFailed(
                            `Secret '${key}' exceeds ${MAX_SECRET_BYTES} bytes`,
                        );
                    }
                    secretsUpdate[key] = value;
                } else {
                    const checked = checkSettingFieldValue(field, value);
                    if (!checked.ok) return ApiProblem.validationFailed(checked.error);
                    value = checked.value;
                    const v = field.validation;
                    if (v) {
                        if (
                            typeof v.min === 'number' &&
                            typeof value === 'number' &&
                            value < v.min
                        ) {
                            return ApiProblem.validationFailed(
                                `Value for '${key}' (${value}) is below declared min ${v.min}`,
                            );
                        }
                        if (
                            typeof v.max === 'number' &&
                            typeof value === 'number' &&
                            value > v.max
                        ) {
                            return ApiProblem.validationFailed(
                                `Value for '${key}' (${value}) exceeds declared max ${v.max}`,
                            );
                        }
                        if (typeof v.pattern === 'string' && typeof value === 'string') {
                            try {
                                const re = new RegExp(v.pattern);
                                if (!re.test(value)) {
                                    return ApiProblem.validationFailed(
                                        `Value for '${key}' does not match declared pattern /${v.pattern}/`,
                                    );
                                }
                            } catch {
                                // Malformed pattern declared by the plugin — let the value pass
                            }
                        }
                    }

                    // `array` fields arrive from the admin form as the typed
                    // comma-separated text. Stored verbatim, a plugin reading
                    // it as a list got a STRING — and `list.includes(group)`
                    // on a string is a substring test (a read list of
                    // "admins" admitted group "admin"). Store a real array.
                    if (field.type === 'array') {
                        value = normalizeArrayValue(value);
                    }

                    let serialized: string;
                    try {
                        serialized = JSON.stringify(value ?? null);
                    } catch {
                        return ApiProblem.validationFailed(
                            `Value for '${key}' is not JSON-serializable`,
                        );
                    }
                    if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
                        return ApiProblem.validationFailed(
                            `Value for '${key}' exceeds ${MAX_VALUE_BYTES} bytes`,
                        );
                    }
                    values[key] = value;
                }
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            await sql.begin(async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;
                for (const [key, value] of Object.entries(values)) {
                    await tx`
                        INSERT INTO plugin_settings (plugin_id, key, value)
                        VALUES (${pluginId}, ${key}, ${tx.json(value as Record<string, never>)})
                        ON CONFLICT (plugin_id, key) DO UPDATE SET value = EXCLUDED.value
                    `;
                }
                if (Object.keys(secretsUpdate).length > 0 || secretsToDelete.length > 0) {
                    const pluginSecrets = new PluginSecrets(tx);
                    for (const [key, value] of Object.entries(secretsUpdate)) {
                        await pluginSecrets.set(pluginId, key, value);
                    }
                    for (const key of secretsToDelete) {
                        await pluginSecrets.delete(pluginId, key);
                    }
                }
            });

            // Apply the new rate to THIS process's bucket immediately.
            //
            // Scope, stated honestly: `updateBucketRate` mutates a module-level
            // map, so this reaches only the process that served the request —
            // a web replica. Provider HTTP largely runs in the dedicated
            // worker, and prod runs two web replicas; those pick the value up
            // at their next boot, via `applyStoredRateLimits` in hooks.server.
            // Cross-process LIVE propagation would need a Valkey broadcast and
            // is not implemented. Before the boot pass existed the stored value
            // reverted to the manifest rate on every restart, which was the
            // worse half of this.
            if (Object.prototype.hasOwnProperty.call(values, 'rps')) {
                // NUMBER only. The declared-field min/max checks above skip a
                // string (they test `typeof value === 'number'`), so coercing
                // here would let `"0.001"` past the declared floor and create a
                // bucket that waits ~17 minutes per token. A non-number means
                // no override, which is the bucket-removal path.
                const rps = typeof values.rps === 'number' ? values.rps : Number.NaN;
                // A non-finite or non-positive value removes the bucket, which
                // is `updateBucketRate`'s documented "revert to the manifest
                // default" path — the same thing clearing the field means.
                updateBucketRate(pluginId, rps);
                log.info('applied rps change to this process', { pluginId, rps });
            }

            // Fire the onConfigChange lifecycle hook AFTER the tx commits so
            // the plugin sees the new values on its first read.
            if (task.onConfigChange) {
                const stubCtx = buildAdminContextStub(pluginId, {
                    sql,
                    settings: async () => values,
                });
                try {
                    await task.onConfigChange(stubCtx, values);
                } catch (err) {
                    log.warn('onConfigChange hook failed', {
                        pluginId,
                        err: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            // Fan the config-change out to tasks that consume this integration's
            // shared secret (integrations have no onConfigChange of their own).
            // Only when a secret actually changed, so a no-op save doesn't kick
            // catch-up runs.
            if (Object.keys(secretsUpdate).length > 0 || secretsToDelete.length > 0) {
                for (const depId of DEPENDENT_TASKS_ON_SECRET_CHANGE[pluginId] ?? []) {
                    const dep = registry.getConfigurable(depId);
                    if (!dep?.onConfigChange) continue;
                    const depCtx = buildAdminContextStub(depId, {
                        sql,
                        settings: async () => values,
                    });
                    try {
                        await dep.onConfigChange(depCtx, values);
                    } catch (err) {
                        log.warn('dependent onConfigChange hook failed', {
                            pluginId,
                            dependentTask: depId,
                            err: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }

            return json(PluginSettingsPutResponseSchema.parse({ updated: true }));
        },
    },
});
