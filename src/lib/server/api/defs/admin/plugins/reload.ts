// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/plugins/reload.ts
 *
 * POST /api/admin/plugins/reload — hot-load external plugins (bounded: new-only).
 *
 * Auth: admin.  Surface: internal.
 * Scope: { kind: 'admin' } — internal admin BFF; no v1 surface.
 *
 * POST response: bare object { newlyLoaded, skippedKnown, errors, sdkImportErrors, discovered }
 * 503  dependency_unavailable on DB down.
 *
 * Multi-replica caveat: this only affects the replica that handles the request.
 * Each replica owns its own filesystem and plugin registry.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { reloadExternalPlugins } from '$lib/server/plugins/runtime/loader.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const logger = Logger.for('AdminPluginsReload');

// ── response schema ───────────────────────────────────────────────────────────

const PluginReloadResponseSchema = z.object({
    newlyLoaded: z.array(z.string()),
    skippedKnown: z.number().int().nonnegative(),
    errors: z.array(z.unknown()),
    sdkImportErrors: z.array(z.unknown()),
    discovered: z.number().int().nonnegative(),
    validationError: z.string().nullable().optional(),
});

// ── def ───────────────────────────────────────────────────────────────────────

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const result = await reloadExternalPlugins(sql);

            logger.info('External plugins reload triggered', {
                triggeredBy: event.locals.principal?.username ?? event.locals.user?.username,
                newlyLoaded: result.newlyLoaded.length,
                skippedKnown: result.skippedKnown,
                errors: result.errors,
                sdkImportErrors: result.sdkImportErrors,
                validationError: result.validationError,
            });

            auditLog('plugin.reload', '*', auditActor(event), {
                newlyLoaded: result.newlyLoaded,
                skipped: result.skippedKnown,
                errors: result.errors,
                validationError: result.validationError,
            });

            return json(
                PluginReloadResponseSchema.parse({
                    newlyLoaded: result.newlyLoaded,
                    skippedKnown: result.skippedKnown,
                    errors: result.errors,
                    sdkImportErrors: result.sdkImportErrors,
                    discovered: result.discovered,
                    validationError: result.validationError,
                }),
            );
        },
    },
});
