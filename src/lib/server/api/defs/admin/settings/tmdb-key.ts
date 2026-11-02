// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/settings/tmdb-key.ts
 *
 * POST /api/admin/tmdb-key — save the TMDB API key via the config service.
 *
 * Used by first-run onboarding and the Settings page. v4 read tokens are JWTs,
 * so MAX_KEY_LENGTH is generous.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * POST → { saved: true, warning?: string } (temporary probe failures warn)
 * 409  → conflict when TMDB_API_KEY is set by an environment variable
 * 422  → validation_failed when key is missing, too long, or rejected by TMDB
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { saveConfig, isEnvOverridden } from '$lib/server/config/config.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { probeTmdbKey } from '$lib/server/services/tmdb-key-probe.js';
import * as m from '$lib/paraglide/messages';

const MAX_KEY_LENGTH = 2048;

const TmdbKeyBodySchema = z.object({
    key: z.string().trim().min(1).max(MAX_KEY_LENGTH),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: TmdbKeyBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            // saveConfig never writes an ENV-owned key: answering "saved" would
            // leave the operator believing a key is in use that is not.
            if (isEnvOverridden('TMDB_API_KEY')) {
                return ApiProblem.conflict(
                    'TMDB_API_KEY is set by an environment variable; remove it to set the key here',
                );
            }
            // key is already trimmed, min-length-1, max-MAX_KEY_LENGTH by the schema
            const key = ctx.input!.body.key;
            const result = await probeTmdbKey(key);
            if (!result.ok && !result.retryable) {
                return ApiProblem.validationFailed(result.error);
            }
            await saveConfig({ TMDB_API_KEY: key });
            auditLog('settings.save', 'config', auditActor(event), {
                changedKeys: ['TMDB_API_KEY'],
            });
            return json({
                saved: true,
                ...(!result.ok
                    ? { warning: m.setup_tmdb_verification_warning({ reason: result.error }) }
                    : {}),
            });
        },
    },
});
