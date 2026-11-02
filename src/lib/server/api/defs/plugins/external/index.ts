// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/external/index.ts — GET /api/v1/plugins/external
 *
 * External plugin support is not yet implemented. Returns an empty list.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/plugins/external/`
 * `+server.ts` (`authenticate()` + `requireScope(auth,'tasks:admin')`).
 * Behaviour preserved exactly — mount()'s `{kind:'scope', anyOf:['tasks:admin']}`
 * runs the SAME primitives before the handler.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { listExternalPluginsWithState } from '$lib/server/services/external-plugin-manager.service.js';

// External (third-party drop-in) plugin item: the registry row joined against
// live loader state. `loaded` reflects whether the plugin is currently
// registered on the task registry; `restartRequired` is true whenever the
// desired enabled state diverges from what is actually loaded (unload is
// restart-only, so a just-disabled plugin stays loaded until restart).
const ExternalPluginSchema = z
    .object({
        id: z.string().meta({
            description: 'Plugin identifier (package name / directory)',
        }),
        name: z.string().optional().meta({ description: 'Display name' }),
        version: z.string().optional().meta({ description: 'Plugin version' }),
        kind: z.string().optional().meta({
            description:
                "SDK contract the plugin implements (e.g. 'task', 'provider', 'feature', 'integration')",
        }),
        enabled: z.boolean().meta({
            description: 'Whether the plugin is enabled in the registry',
        }),
        status: z.enum(['installed', 'uninstalled']).meta({
            description: 'Installation lifecycle status',
        }),
        loaded: z.boolean().meta({
            description: 'Whether the plugin is currently registered on the runtime',
        }),
        error: z.string().optional().meta({
            description: 'Load error message, when the plugin failed to load',
        }),
        restartRequired: z.boolean().meta({
            description:
                'True when the enabled state diverges from what is actually loaded (needs a restart to reconcile)',
        }),
        signingKeyId: z.string().optional().meta({
            description: 'Trusted keyId that verified this plugin’s install signature',
        }),
        signingKeySource: z.enum(['official', 'operator', 'unknown']).optional().meta({
            description:
                'Live classification of signingKeyId against the current effective trusted set: official (baked anchor), operator (env), or unknown (legacy/removed key/registry-less)',
        }),
        capabilities: z.object({}).passthrough().optional().meta({
            description: 'Declared capability metadata (cooperative, not a sandbox)',
        }),
        isBundle: z.boolean().optional().meta({
            description: 'True when the plugin was installed as a multi-file signed bundle',
        }),
    })
    .meta({ description: 'Installed external plugin' });

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Plugins'],
            summary: 'List external plugins',
            stability: 'beta',
            description:
                'Lists installed external (third-party) plugins joined against live runtime state. Each item reports the registry `enabled`/`status` alongside whether it is currently `loaded` and whether a `restartRequired` reconciliation is pending. Requires `admin` scope.',
            responses: {
                200: {
                    schema: z.object({
                        plugins: z.array(ExternalPluginSchema).meta({
                            description: 'Installed external plugins',
                        }),
                    }),
                    description: 'External plugins list',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const { items } = await listExternalPluginsWithState(sql);
            // Project to the v1 wire subset (adds capabilities/kind/isBundle to the
            // existing v1 item; bundleInvalid/installedAt/updatedAt stay
            // page-load-only, spec §5).
            const plugins = items.map((i) => ({
                id: i.id,
                name: i.name,
                version: i.version,
                kind: i.kind,
                enabled: i.enabled,
                status: i.status,
                loaded: i.loaded,
                error: i.error,
                restartRequired: i.restartRequired,
                signingKeyId: i.signingKeyId,
                signingKeySource: i.signingKeySource,
                capabilities: i.capabilities,
                isBundle: i.isBundle,
            }));
            return Response.json({ plugins });
        },
    },
});
