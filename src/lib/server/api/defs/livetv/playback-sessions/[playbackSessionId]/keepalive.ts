// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { playbackKeepalive } from '$lib/server/services/livetv/playback-session-lifecycle.js';

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Keep a Live TV playback session alive',
            responses: {
                204: 'Keepalive accepted',
                401: 'Authentication required',
                404: 'session_not_found or session_expired',
                410: 'Session ended. Problem body: `error: playback_session_ended`, `reason` = evicted | superseded | expired | left | failed, optional `details`. With `reason: failed` the body is a taxonomy failure: `code` (channel_offline, upstream_stalled, ...), `failure.retryable`, `retryAfter` (seconds), and for administrators `failure.feedsTried`; the other reasons keep `code: gone`.',
                422: 'Invalid session UUID',
                503: 'Session store or stream proxy unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    request: { params: z.object({ playbackSessionId: z.string().guid() }) },
    handlers: { POST: playbackKeepalive },
});
