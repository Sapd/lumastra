// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playback/previews/[id].ts — DELETE /playback/previews/{id}
 *
 * DELETE — cleanup preview session (idempotent, 204).
 *
 * Auth: {kind:'user'} — ownership check inside each handler.
 *
 * No request body.  `request.params` declares the id param.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { deletePreview } from '$lib/server/services/preview-session.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaybackPreviewsByIdDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const PreviewIdParams = z.object({
    id: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        DELETE: {
            tags: ['Playback'],
            summary: 'Stop a hover-preview session',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                204: 'Preview session cleaned up',
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },

    request: {
        /**
         * Route params — id must be a non-empty string.
         * DELETE carries no body.
         */
        params: PreviewIdParams,
    },

    handlers: {
        DELETE: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const playSessionId = ctx.input!.params!.id;

            try {
                await deletePreview({ playSessionId, username: userId });

                // Idempotent: 204 whether session existed or was already cleaned up.
                return new Response(null, { status: 204 });
            } catch (error) {
                logger.error('Failed to cleanup preview session', error as Error, {
                    playSessionId,
                });
                return problem('internal_error');
            }
        },
    },
});
