// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { PlaybackReportSchema } from '$lib/schemas/session-update';

export const route: RouteMetadata = {
    POST: {
        tags: ['Play Sessions'],
        summary: 'Beacon session update',
        description:
            'POST-only mirror of PUT for navigator.sendBeacon() compatibility. Always returns 204.',
        body: PlaybackReportSchema,
        responses: {
            204: 'Update accepted (no content)',
            404: 'Not found',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};

export { PlaybackReportSchema };
