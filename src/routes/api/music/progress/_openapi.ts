// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { MusicProgressRequestSchema } from '$lib/schemas/music';
import { z } from 'zod';

export { MusicProgressRequestSchema };

const ProgressResponseSchema = z
    .object({
        success: z.boolean(),
        data: z.object({ success: z.literal(true) }),
        timestamp: z.string(),
    })
    .meta({ id: 'MusicProgressResponse' });

export const route: RouteMetadata = {
    POST: {
        tags: ['Music'],
        summary: 'Kick-cooldown check / heartbeat',
        description:
            'Validates that the requesting user has not had their session terminated by ' +
            'an admin. Performs no database writes — playback progress is recorded via ' +
            'POST /api/music/progress/start (play start) and ' +
            'POST /api/music/progress/end (play end). ' +
            'Returns 403 when the user is in a kick-cooldown window.',
        body: MusicProgressRequestSchema,
        responses: {
            200: {
                schema: ProgressResponseSchema,
                description: 'Request allowed — no kick cooldown active',
            },
            400: 'Invalid request',
            403: 'Session terminated by admin — retry after the indicated cooldown',
        },
    },
};
