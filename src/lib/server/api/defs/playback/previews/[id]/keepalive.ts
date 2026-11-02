// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** POST /playback/previews/{id}/keepalive — owner-only lease renewal, 204. */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import {
    getPreviewSession,
    updateSessionHeartbeat,
} from '$lib/server/services/preview-session.service.js';
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
        POST: {
            tags: ['Playback'],
            summary: 'Heartbeat for a preview session',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                204: 'Heartbeat accepted',
                401: 'Authentication required',
                404: 'Preview session not found',
                500: 'Internal server error',
            },
        },
    },
    auth: { kind: 'user' },
    request: { params: PreviewIdParams },
    handlers: {
        POST: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const playSessionId = ctx.input!.params!.id;

            const session = await getPreviewSession(playSessionId);
            if (!session) return problem('not_found', { error: 'Preview session not found' });
            if (session.userId !== userId)
                return problem('not_found', { error: 'Preview session not found' });

            try {
                if (!(await updateSessionHeartbeat(playSessionId)))
                    return problem('not_found', { error: 'Preview session not found' });
                return new Response(null, { status: 204 });
            } catch (error) {
                logger.error('Failed to update preview heartbeat', error as Error, {
                    playSessionId,
                });
                return problem('internal_error');
            }
        },
    },
});
