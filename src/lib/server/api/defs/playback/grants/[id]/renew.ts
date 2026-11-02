// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import {
    PlaybackGrantStoreUnavailableError,
    renewPlaybackGrant,
} from '$lib/server/services/playback-grant.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import {
    GrantIdParams,
    RenewPlaybackGrantRequestSchema,
    RenewPlaybackGrantResponseSchema,
} from '../schema.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:write'] },
    visibility: 'public',
    rateLimit: {
        limit: 30,
        windowSec: 60,
        keyBy: (event) =>
            `playback-renew:${event.locals.principal?.userId ?? event.locals.user?.userId}`,
    },
    request: { params: GrantIdParams, body: RenewPlaybackGrantRequestSchema },
    docs: {
        POST: {
            tags: ['Playback'],
            stability: 'stable',
            summary: 'Renew a playback grant',
            description:
                'Extends expiry in place using the existing token, preserving scope, session and IP pin; capped at seven days from creation.',
            auth: 'bearer',
            body: RenewPlaybackGrantRequestSchema,
            responses: {
                200: {
                    schema: RenewPlaybackGrantResponseSchema,
                    description: 'Renewed grant and unchanged secret',
                },
                401: 'Authentication required',
                404: 'Active grant not found',
                503: 'Live TV session store unavailable',
            },
        },
    },
    handlers: {
        POST: async (event, ctx) => {
            const owner = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!owner) return ApiProblem.unauthorized();
            let grant;
            try {
                grant = await renewPlaybackGrant(
                    ctx.input!.params!.id,
                    owner,
                    ctx.surface,
                    ctx.input!.body.token,
                );
            } catch (error) {
                if (error instanceof PlaybackGrantStoreUnavailableError) {
                    return problem('dependency_unavailable', {
                        error: 'Live TV session store unavailable',
                    });
                }
                throw error;
            }
            if (!grant) return ApiProblem.notFound('Active grant not found');
            return json({
                id: grant.id,
                token: grant.token,
                mediaId: grant.mediaId,
                playbackSessionId: grant.playbackSessionId,
                kind: grant.kind,
                ipPinned: grant.ipPinned,
                expiresAt: grant.expiresAt.toISOString(),
                renewAfter: grant.renewAfter.toISOString(),
                renewHref: apiUrl(ctx.surface, `/playback/grants/${grant.id}/renew`),
                param: 'grant',
            });
        },
    },
});
