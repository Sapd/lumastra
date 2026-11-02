// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/reconciliation-proposals/apply.ts
 *
 * POST /api/admin/reconciliation-proposals/{quarantineId}/apply
 *
 * Applies one absolute-numbering proposal: the file-backed episode adopts the
 * proposed TMDB identity and moves onto the position of the TMDB episode, the
 * file-less ghost merges into it (user state migrates) and an undo record is
 * written (`POST /api/admin/reconciliation-moves/{id}/undo` reverses it). The
 * pair is re-validated under the per-series advisory lock first; the proposal is
 * resolved as `reattached` in the same transaction.
 *
 * Auth:    library:admin (the resolver recorded is the caller's identity: the username, or the token's own name for a token caller)
 * Surface: internal
 *
 * Response: { quarantineId, moveId, episodeId, seasonNumber, episodeNumber }
 * 404 not_found           no such absolute-numbering proposal
 * 409 conflict            already resolved; no longer a valid match (the reason is in the
 *                         detail and the proposal stays open)
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    ProposalActionError,
    applyAbsoluteNumberingProposal,
} from '$lib/server/services/absolute-numbering-reconciliation.service.js';
import { auditActor } from '$lib/server/utils/audit-log.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ quarantineId: z.string().regex(UUID_RE, 'Invalid UUID') }),
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { quarantineId } = ctx.input!.params;
            const resolvedBy = auditActor(event).username ?? 'admin';

            try {
                const result = await applyAbsoluteNumberingProposal(sql, quarantineId, resolvedBy);
                return json(result);
            } catch (err) {
                if (err instanceof ProposalActionError) {
                    return err.code === 'not-found'
                        ? ApiProblem.notFound(err.message)
                        : ApiProblem.conflict(err.message);
                }
                throw err;
            }
        },
    },
});
