// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import {
    AdminUiPrefsResponseSchema,
    AdminUiPrefsPatchBodySchema,
} from '$lib/schemas/api-admin-responses';

export const route: RouteMetadata = {
    visibility: 'internal',
    GET: {
        tags: ['Admin'],
        summary: 'Get the current admin user UI preferences',
        description:
            'Returns per-admin-user UI preferences (admin navigation style). ' +
            'Defaults to "sidebar" when the user has never set one. Requires admin.',
        responses: {
            200: {
                schema: AdminUiPrefsResponseSchema,
                description: 'Current UI preferences',
            },
            401: 'Authentication required',
            503: 'Database unavailable',
        },
    },
    PATCH: {
        tags: ['Admin'],
        summary: 'Update the current admin user UI preferences',
        description: 'Persists the chosen admin navigation style for the current admin user.',
        body: AdminUiPrefsPatchBodySchema,
        responses: {
            200: {
                schema: AdminUiPrefsResponseSchema,
                description: 'Updated UI preferences',
            },
            400: 'Validation failed',
            401: 'Authentication required',
            503: 'Database unavailable',
        },
    },
};
