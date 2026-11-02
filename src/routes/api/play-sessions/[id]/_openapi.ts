// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { PlaybackReportSchema } from '$lib/schemas/session-update';
import { SessionHeartbeatResponseSchema } from '$lib/schemas/api-playback-responses';

export const route: RouteMetadata = {
    PUT: {
        tags: ['Play Sessions'],
        summary: 'Update play session',
        description:
            'Report progress, pause, resume, or complete a play session. Verifies session ownership. ' +
            'On heartbeats (status=ACTIVE|PAUSED) the response always includes resumeAnchorAt and ' +
            'progressSaved so the client can advance its localStorage resume cache and detect ' +
            'engagement-gate openings. Optional action/reason fields surface kill or superseded ' +
            'states; an optional transcode field is layered in when a transcode job is active. ' +
            'COMPLETED requests return 204 (or 200 with action=kill if the session vanished).',
        body: PlaybackReportSchema,
        responses: {
            200: {
                schema: SessionHeartbeatResponseSchema,
                description:
                    'Heartbeat acknowledgement: resumeAnchorAt + progressSaved, plus optional ' +
                    'kill/superseded/transcode fields. Also covers the rare action=kill response on COMPLETED.',
            },
            204: 'COMPLETED accepted (no content)',
            404: 'Not found',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};

export { PlaybackReportSchema };
