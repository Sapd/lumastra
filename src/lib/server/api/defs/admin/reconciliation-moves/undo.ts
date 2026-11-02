// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/reconciliation-moves/undo.ts
 *
 * POST /api/admin/reconciliation-moves/{id}/undo
 *
 * Reverses one applied reconciliation move in a single transaction: removes the
 * TMDB id it bound, moves the episode back to where it sat, restores its title
 * fields, and blocks the same pair from being applied again. The next metadata
 * sync recreates the ghost episode the apply merged away.
 *
 * Auth:    library:admin (undoneBy is the caller's identity: the username, or the
 *          token's own name, e.g. `service:<name>`, for a token caller)
 * Surface: internal
 *
 * Response: { moveId, episodeId, seasonNumber, episodeNumber }
 * 404 not_found           the move does not exist
 * 409 conflict            already undone; the original slot is taken; the episode no
 *                         longer carries the id the move bound; the episode was deleted
 *                         ('episode-gone': the audit row survives, there is nothing to move
 *                         back); the season is gone; the episode is metadata-locked or has a
 *                         manual title ('locked'); the series lock could not be taken within
 *                         10 s ('busy': retry)
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    ReconciliationUndoError,
    undoReconciliationMove,
} from '$lib/server/services/episode-reconciliation-undo.service.js';
import { auditActor } from '$lib/server/utils/audit-log.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ id: z.string().regex(UUID_RE, 'Invalid UUID') }),
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { id } = ctx.input!.params;
            const undoneBy = auditActor(event).username ?? 'admin';

            try {
                const result = await undoReconciliationMove(sql, id, undoneBy);
                return json(result);
            } catch (err) {
                if (err instanceof ReconciliationUndoError) {
                    return err.code === 'not-found'
                        ? ApiProblem.notFound(err.message)
                        : ApiProblem.conflict(err.message);
                }
                throw err;
            }
        },
    },
});
