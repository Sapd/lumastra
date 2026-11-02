// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { ApiProblem } from '$lib/server/api/problem.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import {
    PlaybackSessionStartSchema,
    PlaybackSessionStartResponseSchema,
} from '$lib/schemas/livetv-playback-sessions.js';
import {
    LiveTvFailureProblemSchema,
    LiveTvStartUnavailableProblemSchema,
} from '$lib/schemas/livetv-failures.js';
import { startPlayback } from '$lib/server/services/livetv/start-playback.js';

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Start a Live TV playback session',
            responses: {
                201: {
                    schema: PlaybackSessionStartResponseSchema,
                    description:
                        'Session accepted; play delivery.url and send keepalive to reporting.href every reporting.intervalMs',
                },
                401: 'Authentication required',
                404: 'Unknown station or feed',
                409: 'Another session change is in progress',
                410: 'Viewer eviction guard still active. Problem body: `error: playback_session_ended`, `reason` = evicted | superseded | expired | left, optional `details`.',
                422: 'Invalid station, feed or quality',
                500: {
                    schema: LiveTvFailureProblemSchema,
                    contentType: 'application/problem+json',
                    description:
                        'The server could not encode the channel: `code` = encoder_failed, `failure.retryable` true, `retryAfter` 5',
                },
                502: {
                    schema: LiveTvFailureProblemSchema,
                    contentType: 'application/problem+json',
                    description:
                        'The channel will not play. `code` = channel_offline | provider_auth_failed | geo_blocked | no_video | all_feeds_failed | upstream_stalled. ' +
                        '`failure.retryable` false means do not retry automatically; offer another channel. `failure.feedsTried` is present for administrators only.',
                },
                503: {
                    schema: LiveTvStartUnavailableProblemSchema,
                    contentType: 'application/problem+json',
                    description:
                        '`code` = provider_connection_limit (provider refuses, `retryAfter` 30) | stream_limit (our slots are full, 30) | dependency_unavailable (stream proxy down, 5) | cap_unavailable. `Retry-After` carries the same seconds.',
                },
                504: {
                    schema: LiveTvFailureProblemSchema,
                    contentType: 'application/problem+json',
                    description:
                        'The provider could not be reached: `code` = provider_unreachable, `failure.retryable` true, `retryAfter` 10',
                },
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    request: { body: PlaybackSessionStartSchema },
    handlers: {
        POST: (event, ctx) => {
            if (!event.locals.user?.hasLiveTvPermission) return ApiProblem.notFound();
            return startPlayback(event, ctx.surface, ctx.input!.body);
        },
    },
});
