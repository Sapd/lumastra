// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import {
    CollaborationRequestSchema,
    CollaborationResponseSchema,
} from '$lib/schemas/collaboration-review.js';
import {
    CollaborationReviewError,
    applyCollaboration,
    previewCollaboration,
    returnCollaborationToQueue,
} from '$lib/server/services/music/collaboration-review.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: { body: CollaborationRequestSchema },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const artistId = adminMediaId(event);
            if (!artistId || !UUID_RE.test(artistId))
                return ApiProblem.notFound('Artist not found');
            const request = ctx.input!.body;
            const actor = event.locals.principal?.username ?? event.locals.user?.username;
            if (!actor) return ApiProblem.unauthorized();
            try {
                if (request.action === 'preview') {
                    const preview = await previewCollaboration(sql, artistId, request.members);
                    return json(CollaborationResponseSchema.parse({ action: 'preview', preview }));
                }
                if (request.action === 'return') {
                    const returned = await returnCollaborationToQueue(sql, artistId, actor);
                    if (!returned) return ApiProblem.notFound('Artist not found');
                    return json(CollaborationResponseSchema.parse({ action: 'return', returned }));
                }
                const result = await applyCollaboration(sql, artistId, actor, request);
                return json(CollaborationResponseSchema.parse({ action: 'apply', result }));
            } catch (error) {
                if (!(error instanceof CollaborationReviewError)) throw error;
                if (error.kind === 'missing') return ApiProblem.notFound(error.message);
                if (error.kind === 'conflict') return ApiProblem.conflict(error.message);
                return ApiProblem.validationFailed(error.message);
            }
        },
    },
});
