// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/users/[username]/jellyfin — Jellyfin account mapping.
 *
 * POST /api/admin/users/:username/jellyfin
 *   Body: { jellyfinUsername?: string | null, resolve?: boolean }
 *     - jellyfinUsername (string)  → set login override
 *     - jellyfinUsername null      → clear override (use same-name)
 *     - resolve: true              → resolve + cache the Jellyfin UUID now
 *
 * Auth: users:admin scope OR admin session (internal surface only).
 *
 * Response contract: bare { username, override?, jellyfinUserId? }
 * Errors: problem+json (incl. 503 dependency_unavailable).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { requireAdminCeilingForTarget } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/index.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    setJellyfinOverride,
    resolveJellyfinForUser,
} from '$lib/server/services/admin-identity.service.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';

const JellyfinBody = z.object({
    jellyfinUsername: z.string().max(128).nullable().optional(),
    resolve: z.boolean().optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    request: {
        body: JellyfinBody,
    },
    handlers: {
        POST: async (event, ctx) => {
            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                db,
                username,
                "Only administrators can change an admin's Jellyfin mapping",
            );
            if (ceilingErr) return ceilingErr;

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            const { jellyfinUsername, resolve } = ctx.input!.body;

            let override: string | null | undefined;
            if (jellyfinUsername !== undefined) {
                const setResult = await setJellyfinOverride(db, username, jellyfinUsername);
                if (!setResult.ok) {
                    if (setResult.status === 404) return ApiProblem.notFound(setResult.message);
                    return ApiProblem.internalError(setResult.message);
                }
                override = setResult.data.override;
                auditLog('user.jellyfin-override', username, auditActor(event), {
                    cleared: override === null,
                });
            }

            let jellyfinUserId: string | null | undefined;
            if (resolve) {
                const resolveResult = await resolveJellyfinForUser(username);
                jellyfinUserId = resolveResult.ok ? resolveResult.data.jellyfinUserId : null;
            }

            return json({ username, override, jellyfinUserId });
        },
    },
});
