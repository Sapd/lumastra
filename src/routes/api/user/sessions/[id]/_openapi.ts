// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    visibility: 'internal',
    DELETE: {
        tags: ['User'],
        summary: 'Revoke one native web-login session',
        description:
            "Revokes one of the caller's own native web-login sessions by row id. Owner-scoped: an id that does not exist or is not owned by the caller returns 404 (not 403), avoiding an existence leak.",
        responses: {
            204: 'Session revoked (no content)',
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
