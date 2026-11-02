// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/users/[id]/refresh-watch-state.ts — POST /api/v1/users/{id}/refresh-watch-state
 *
 * Clears the per-user pull cursor in `watch_state_pull_log` for every provider
 * so the next watch-sync cycle re-fetches that user's full Jellyfin watch state
 * instead of running incrementally from the last cursor.
 *
 * Use when a user's `user_media_state` has drifted from the source of truth
 * (e.g. Jellyfin marks were unmarked after the cursor advanced past them, or
 * the migration backfill missed rows).  Does NOT trigger an immediate pull —
 * the regular 5-min cycle picks the reset up.
 *
 * Auth: users:admin scope.
 * {id} is a stable users.id UUID; the handler resolves it to a username before
 * delegating to the existing admin implementation, exactly as the hand-written
 * route did.
 *
 * Phase 3 port of the hand-written
 * `src/routes/api/v1/users/[id]/refresh-watch-state/` `+server.ts` — see
 * defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { getDb } from '$lib/server/database/index.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { POST as adminPOST } from '../../../../../../routes/api/admin/users/[username]/refresh-watch-state/+server.js';

const RefreshWatchStateResponseSchema = z.object({
    providersCleared: z.array(z.string()).meta({
        description: 'List of provider names whose pull cursor was cleared.',
    }),
    message: z.string().meta({ description: 'Human-readable summary of the operation.' }),
});

async function resolveUsername(event: RequestEvent): Promise<string | Response> {
    const db = getDb();
    if (!db) return ApiProblem.dependencyUnavailable('Database not available');
    const user = await getUserById(db, event.params.id ?? '');
    if (!user) return ApiProblem.notFound('User not found');
    (event.params as Record<string, string>).username = user.username;
    return user.username;
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Users'],
            summary: "Reset a user's watch-state pull cursor",
            stability: 'stable',
            auth: 'bearer',
            description:
                'Clears the per-user pull cursor in `watch_state_pull_log` for every provider ' +
                "so the next watch-sync cycle re-fetches the user's full Jellyfin watch state " +
                'instead of running incrementally from the last cursor. ' +
                'Does **not** trigger an immediate pull — the regular 5-minute cycle picks the ' +
                "change up. Use when a user's watch state has drifted from the source of truth. " +
                'Requires `users:admin` scope.',
            responses: {
                200: {
                    schema: RefreshWatchStateResponseSchema,
                    description: 'Cursors cleared — next sync will re-fetch the full watch state.',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (users:admin required)',
                404: 'User not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        POST: async (event) => {
            const result = await resolveUsername(event);
            if (result instanceof Response) return result;
            return delegateToAdmin(event, adminPOST!);
        },
    },
});
