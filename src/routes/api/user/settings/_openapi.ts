// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { UserSettingsResponseSchema } from '$lib/schemas/api-user-responses';

export const route: RouteMetadata = {
    visibility: 'internal',
    GET: {
        tags: ['User'],
        summary: 'Get user settings',
        description:
            'Composite endpoint returning all user preferences in a single response: searchPreference, widgetOrder, playbackPreferences, streamPrivacy, profile.',
        responses: {
            200: { schema: UserSettingsResponseSchema, description: 'User settings response' },
            401: 'Authentication required',
            503: 'Database not available',
        },
    },
};
