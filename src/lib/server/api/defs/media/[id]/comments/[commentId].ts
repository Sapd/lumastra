// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/comments/[commentId].ts — DELETE /media/{id}/comments/{commentId}
 *
 * The media access gate runs before the per-comment author/admin check so that
 * callers who cannot access a media item receive 404 — matching the behaviour
 * of GET /media/{id} and the media comments collection endpoint.
 *
 * Mounted at:
 *   src/routes/api/v1/media/[id]/comments/[commentId]/+server.ts
 */

import { makeCommentByIdDef } from '$lib/server/api/defs/interactions/handlers.js';
import { mediaAccessGate } from '$lib/server/api/defs/media/[id]/access-gate.js';
import type { RouteMetadata } from '$lib/server/openapi';

const docs: RouteMetadata = {
    DELETE: {
        tags: ['Media'],
        summary: 'Delete a media comment',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Deletes a comment on a media item. The caller must be the comment author or an admin.',
        responses: {
            204: 'Comment deleted',
            401: 'Authentication required',
            403: 'Not the comment author',
            404: 'Comment or media not found',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};

export const def = makeCommentByIdDef('media', mediaAccessGate, docs);
