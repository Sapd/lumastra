// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/people/[id]/comments/[commentId].ts
 * DELETE /people/{id}/comments/{commentId}
 *
 * Mounted at:
 *   src/routes/api/v1/people/[id]/comments/[commentId]/+server.ts
 */

import { makeCommentByIdDef } from '$lib/server/api/defs/interactions/handlers.js';
import type { RouteMetadata } from '$lib/server/openapi';

const docs: RouteMetadata = {
    DELETE: {
        tags: ['People'],
        summary: 'Delete a comment on a person',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Deletes a comment on a person profile. The caller must be the comment author or an admin.',
        responses: {
            204: 'Comment deleted',
            422: 'Invalid person handle; use tmdb:123 or a positive numeric alias. Aliases share one canonical interaction target.',
            401: 'Authentication required',
            403: 'Not the comment author',
            404: 'Comment or person not found',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};

export const def = makeCommentByIdDef('person', undefined, docs);
