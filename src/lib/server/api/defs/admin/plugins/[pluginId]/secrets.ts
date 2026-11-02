// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/plugins/[pluginId]/secrets — GET (which keys are set) / DELETE (revoke one).
 *
 * Plugin secrets could be WRITTEN (through a plugin's declared settings fields)
 * and re-encrypted under a new master key, but never REVOKED: `PluginSecrets`
 * has had `delete()` since it shipped with no caller anywhere. An operator who
 * set a webhook secret, or pasted an API key they later rotated at the
 * provider, had no way to take it back short of touching the database.
 *
 * Values are NEVER returned. This lists key names and whether each is set,
 * which is what an operator needs to answer "is this configured?" without the
 * page becoming a place secrets can leak from.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { PluginSecrets } from '$lib/server/tasks/secrets.js';
import { listPluginSecretKeys } from '$lib/server/database/queries/plugin-secrets.queries.js';
import { ID_PATTERN, registry } from '$lib/server/tasks/registry.js';
import { buildAdminContextStub } from '$lib/server/tasks/plugin-context.js';

const DeleteBodySchema = z.object({ key: z.string().min(1).max(128) });

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event: RequestEvent) => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const pluginId = event.params.pluginId ?? '';
            if (!ID_PATTERN.test(pluginId)) return ApiResponses.notFound('unknown plugin');

            const all = await listPluginSecretKeys(sql);
            return json({
                // Names only. A secrets screen that can echo a value back is a
                // secrets screen that leaks one.
                keys: all.filter((k) => k.pluginId === pluginId).map((k) => k.key),
            });
        },

        DELETE: async (event: RequestEvent) => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const pluginId = event.params.pluginId ?? '';
            if (!ID_PATTERN.test(pluginId)) return ApiResponses.notFound('unknown plugin');

            const raw: unknown = await event.request.json().catch(() => ({}));
            const parsed = DeleteBodySchema.safeParse(raw);
            if (!parsed.success) return ApiResponses.badRequest('a secret key is required');

            await new PluginSecrets(sql).delete(pluginId, parsed.data.key);

            // Tell the plugin, the same way the settings PUT does. A plugin
            // that read its credential once at config time would otherwise keep
            // using the revoked one until the process restarted — which is the
            // opposite of what pressing Revoke means, and the failure mode
            // would be invisible.
            const configurable = registry.getConfigurable(pluginId);
            if (configurable?.onConfigChange) {
                try {
                    await configurable.onConfigChange(buildAdminContextStub(pluginId, { sql }), {});
                } catch {
                    // A plugin's own hook must not turn a successful revocation
                    // into a failed request — the secret IS gone either way.
                }
            }
            // The KEY is audited, never the value. Revoking a credential is
            // exactly the kind of change someone needs to be able to trace.
            auditLog('plugin.secret.delete', pluginId, auditActor(event), { key: parsed.data.key });

            // Deleting an absent key is a no-op, and reporting 204 either way
            // keeps "which keys exist" out of the response — the same reason
            // the webhook endpoint answers 404 for a wrong secret.
            return new Response(null, { status: 204 });
        },
    },
});
