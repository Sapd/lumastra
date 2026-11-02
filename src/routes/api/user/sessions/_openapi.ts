// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    visibility: 'internal',
    GET: {
        tags: ['User'],
        summary: 'List native web-login sessions',
        description:
            "Lists the caller's live native (built-in username/password) browser login sessions. Flags which one is the current request's session. Never includes the stored token hash. Empty under forward-auth (no native session rows exist).",
        responses: {
            200: 'Web-login sessions',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
    POST: {
        tags: ['User'],
        summary: 'Revoke other native web-login sessions',
        description:
            "Revokes all of the caller's native sessions EXCEPT the one behind the current request's session cookie (logout-everywhere-else).",
        responses: {
            204: 'Other sessions revoked (no content)',
            400: 'No native session cookie on this request',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
