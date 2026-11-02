// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Admin', 'Playback'],
        summary: 'Inspect a playback plan',
        description:
            "Returns the PlaybackPlan stored in Valkey at session-start time. The response carries `plan: null` and `expired: true` when the plan's Valkey TTL has elapsed; the admin UI renders an explanatory state in that case rather than treating it as a 404.",
        responses: {
            200: 'Plan retrieved (may be null if expired)',
            400: 'Plan ID required',
            401: 'Authentication required',
            403: 'Admin privileges required',
            500: 'Internal server error',
        },
    },
};
