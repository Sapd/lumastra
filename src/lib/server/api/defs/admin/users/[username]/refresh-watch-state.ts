// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/users/[username]/refresh-watch-state — clear per-user pull-log cursors.
 *
 * POST /api/admin/users/:username/refresh-watch-state
 *   Deletes per-provider rows from watch_state_pull_log so the next pull cycle
 *   does a full re-fetch. Does not trigger an immediate pull.
 *
 * Auth: users:admin scope OR admin session (internal surface only).
 *
 * Response contract: bare { providersCleared, message }
 * Errors: problem+json (incl. 503 dependency_unavailable).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    handlers: {
        POST: async (event, _ctx) => {
            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const uid = await getUserIdByUsername(db, username);
            if (!uid) return ApiProblem.notFound('User');

            const cleared = await db<{ provider: string }[]>`
                DELETE FROM watch_state_pull_log
                WHERE user_id = ${uid}::uuid
                RETURNING provider
            `;
            const providersCleared = cleared.map((r) => r.provider);
            const message = providersCleared.length
                ? `Cleared ${providersCleared.length} cursor(s) (${providersCleared.join(', ')}). Next sync within 5 min will re-fetch ${username}'s full watch state.`
                : `No pull-log entries existed for ${username}; nothing to clear.`;

            auditLog('user.refresh_watch_state', username, auditActor(event), {});

            return json({ providersCleared, message });
        },
    },
});
