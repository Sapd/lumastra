// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { playbackLeave } from '$lib/server/services/livetv/playback-session-lifecycle.js';

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Leave a Live TV playback session (sendBeacon)',
            responses: {
                204: 'Session ended (idempotent)',
                401: 'Authentication required',
                404: 'Live TV not available',
                409: 'Session change in progress',
                422: 'Invalid session UUID',
                503: 'Session store unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    request: { params: z.object({ playbackSessionId: z.string().guid() }) },
    handlers: { POST: playbackLeave },
});
