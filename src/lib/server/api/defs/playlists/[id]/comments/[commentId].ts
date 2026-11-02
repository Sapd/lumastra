// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/comments/[commentId].ts
 * DELETE /playlists/{id}/comments/{commentId}
 *
 * The resource-level access gate (playlist membership / public visibility)
 * runs before the per-comment author/admin check so that non-members on a
 * private playlist receive 404 (not 403) — matching legacy route behaviour.
 *
 * Mounted at:
 *   src/routes/api/v1/playlists/[id]/comments/[commentId]/+server.ts
 */

import { makeCommentByIdDef } from '$lib/server/api/defs/interactions/handlers.js';
import { playlistAccessGate } from '$lib/server/api/defs/playlists/[id]/access-gate.js';
import type { RouteMetadata } from '$lib/server/openapi';

const docs: RouteMetadata = {
    DELETE: {
        tags: ['Playlists'],
        summary: 'Delete a playlist comment',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Deletes a comment on a playlist. The caller must be the comment author or an admin.',
        responses: {
            204: 'Comment deleted',
            401: 'Authentication required',
            403: 'Not the comment author',
            404: 'Comment or playlist not found',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};

export const def = makeCommentByIdDef('playlist', playlistAccessGate, docs);
