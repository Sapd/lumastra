// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/external/install.ts — POST /api/v1/plugins/external/install
 *
 * Installs (or upgrades) an offline-signed external plugin from a remote
 * manifest URL + detached Ed25519 signature. Delegates to the installer
 * service, which fetches + verifies the manifest against ENV-configured
 * trusted keys, persists the `external_plugins` registry row, and either
 * hot-loads the fresh bundle or stages an upgrade for the next restart.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/plugins/external/install/`
 * `+server.ts` (`authenticate()` + `requireScope(auth,'tasks:admin')`).
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin.
 *
 * SENSITIVE: the install payload IS schema-validated (manifest URL + detached
 * signature) before reaching the installer, and the installer re-verifies the
 * signature over the raw manifest bytes against the ENV-only trusted keys.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { auditActor } from '$lib/server/utils/audit-log.js';
import {
    installExternalPlugin,
    type InstallInput,
} from '$lib/server/plugins/external-install/installer.js';

// SENSITIVE: install payloads MUST be schema-validated before reaching the
// installer. `manifestUrl` is a URL; `signature` is the detached Ed25519
// signature (base64) over the raw manifest bytes; `force` opts past the
// anti-rollback (same/older version) guard.
const InstallBodySchema = z.object({
    manifestUrl: z.string().url().meta({ description: 'URL of the plugin manifest to install' }),
    signature: z.string().meta({
        description: 'Detached Ed25519 signature (base64) over the raw manifest bytes',
    }),
    checksum: z.string().optional().meta({
        description: 'Optional expected sha256 of the plugin bundle (defence-in-depth hint)',
    }),
    force: z.boolean().optional().meta({
        description: 'Bypass the anti-rollback guard to (re)install a same/older version',
    }),
});

const InstalledDescriptorSchema = z.object({
    id: z.string().optional().meta({ description: 'Installed plugin id (directory / def id)' }),
    name: z.string().optional().meta({ description: 'Plugin name' }),
    version: z.string().optional().meta({ description: 'Installed plugin version' }),
    kind: z.string().optional().meta({ description: 'SDK contract the plugin implements' }),
    enabled: z.boolean().optional().meta({
        description: 'Whether the plugin is enabled after install',
    }),
    status: z.enum(['installed', 'uninstalled']).optional().meta({
        description: 'Installation lifecycle status',
    }),
    loaded: z.boolean().optional().meta({
        description: 'Whether the plugin is currently loaded into the running process',
    }),
    error: z.string().optional().meta({ description: 'Failure reason, when present' }),
    restartRequired: z.boolean().optional().meta({
        description:
            'True when the install staged a change that only takes effect on the next restart (upgrades)',
    }),
    signingKeyId: z.string().optional().meta({
        description: 'Trusted keyId that verified the install signature',
    }),
    signingKeySource: z.enum(['official', 'operator', 'unknown']).optional().meta({
        description: 'Source of the verifying key: official (baked anchor) or operator (env)',
    }),
});

const ErrorSchema = z.object({ error: z.string() });

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Plugins'],
            summary: 'Install an external plugin',
            stability: 'beta',
            description:
                'Installs (or upgrades) an external (third-party) plugin from a remotely-fetched, offline-signed manifest. The host fetches the manifest and bundle (SSRF-guarded), verifies the detached Ed25519 signature against ENV-configured trusted keys, checks the bundle sha256, and either hot-loads a fresh plugin (201) or stages an upgrade for the next restart (200, `restartRequired: true`). Requires `admin` scope.',
            body: InstallBodySchema,
            responses: {
                201: {
                    schema: InstalledDescriptorSchema,
                    description: 'Fresh plugin installed and hot-loaded',
                },
                200: {
                    schema: InstalledDescriptorSchema,
                    description: 'Upgrade staged; a restart is required to take effect',
                },
                400: {
                    schema: ErrorSchema,
                    description:
                        'Invalid request, disabled install gate, fetch/SSRF failure, untrusted signature, bad manifest, checksum mismatch, or identity mismatch',
                },
                409: {
                    schema: ErrorSchema,
                    description: 'Version is not newer than the installed one (anti-rollback)',
                },
                422: {
                    schema: ErrorSchema,
                    description: 'Bundle fetched and verified but failed to load/execute',
                },
                500: {
                    schema: ErrorSchema,
                    description: 'Read-only plugins dir or unexpected server error',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
            },
        },
    },
    handlers: {
        POST: async (event: RequestEvent) => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');

            const raw: unknown = await event.request.json().catch(() => ({}));
            const parsed = InstallBodySchema.safeParse(raw);
            if (!parsed.success) return ApiResponses.badRequest('invalid install request');

            const actor = auditActor(event);
            const input: InstallInput = parsed.data;
            const result = await installExternalPlugin(sql, input, actor);

            return new Response(JSON.stringify(result.body), {
                status: result.status,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    },
});
