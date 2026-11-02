// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { PlaybackSessionStateSchema } from '$lib/schemas/livetv-playback-sessions.js';
import {
    playbackState,
    playbackLeave,
} from '$lib/server/services/livetv/playback-session-lifecycle.js';

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Get Live TV playback session state',
            responses: {
                200: {
                    schema: PlaybackSessionStateSchema,
                    description: 'Session state and selected outputs',
                },
                401: 'Authentication required',
                404: 'Session not found',
                422: 'Invalid session UUID',
                503: 'Session store unavailable',
            },
        },
        DELETE: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Stop a Live TV playback session',
            responses: {
                204: 'Session ended (idempotent)',
                401: 'Authentication required',
                409: 'Session change in progress',
                422: 'Invalid session UUID',
                503: 'Session store unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    request: { params: z.object({ playbackSessionId: z.string().guid() }) },
    handlers: { GET: playbackState, DELETE: playbackLeave },
});
