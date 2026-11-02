// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/settings/privacy-settings.ts
 *
 * GET  /api/admin/privacy-settings — return all user privacy settings
 * POST /api/admin/privacy-settings — update a user's hideFromOthers setting
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET  → PrivacySettingsItem[]   (bare array — single resource)
 * POST → { username, hideFromOthers }; 404 when no such user
 * 503  → dependency_unavailable when AI-DB is down
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getHiddenUsers,
    setUserPrivacySetting,
} from '$lib/server/database/queries/oauth-admin.queries.js';
import { privacySettingsBodySchema } from '$lib/schemas/admin.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { foldUsername } from '$lib/shared/username-fold.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: privacySettingsBodySchema,
    },
    handlers: {
        GET: async () => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('AI database unavailable');

            const privacySettings = await getHiddenUsers(sql);
            return json(privacySettings);
        },

        POST: async (event, ctx) => {
            const { username, hideFromOthers } = ctx.input!.body;

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('AI database unavailable');

            const actor = auditActor(event);
            const found = await setUserPrivacySetting(sql, username, hideFromOthers);
            if (!found) return ApiProblem.notFound('User not found');
            auditLog('user.privacy_hide_streams', foldUsername(username), actor, {
                hideFromOthers,
            });
            return json({ username, hideFromOthers });
        },
    },
});
