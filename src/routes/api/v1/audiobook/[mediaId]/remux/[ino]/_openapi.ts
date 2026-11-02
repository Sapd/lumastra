// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

/** Retired by the P9 audiobook byte cutover. Documented as deprecated; the replacement is named in each operation. */
export const route: RouteMetadata = {
    // The generator documents GET only; HEAD answers the same 410 with no body.
    GET: {
        tags: ['Audiobooks'],
        summary: 'Retired singular audiobook remux route (GET)',
        stability: 'deprecated',
        deprecation: {
            since: '2026-10-22',
            replacement: '/audiobooks/{mediaId}/remux/{trackIndex}',
        },
        auth: 'none',
        description:
            'Retired by the P9 audiobook byte cutover; this path is not an alias. Every call answers 410 route_retired and reveals nothing about the book. Start a new play session and follow the issued /audiobooks/{mediaId}/remux/{trackIndex} URL.',
        responses: {
            410: {
                description:
                    'Retired route: start a new play session and follow the issued /audiobooks/{mediaId}/remux/{trackIndex} URL',
                code: 'route_retired',
            },
        },
    },
};
