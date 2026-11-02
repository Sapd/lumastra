// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getPlaybackGrant, revokePlaybackGrant } from '$lib/server/services/playback-grant.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { GrantIdParams, PlaybackGrantResponseSchema } from './schema.js';

/** Public IDs are not credentials. Every operation requires the owner's account credential. */
export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:write'] },
    visibility: 'public',
    request: { params: GrantIdParams },
    docs: {
        GET: {
            tags: ['Playback'],
            stability: 'stable',
            summary: 'Get a playback grant',
            auth: 'bearer',
            responses: {
                200: {
                    schema: PlaybackGrantResponseSchema,
                    description: 'Grant metadata (no secret)',
                },
                401: 'Authentication required',
                404: 'Grant not found',
            },
        },
        DELETE: {
            tags: ['Playback'],
            stability: 'stable',
            summary: 'Revoke a playback grant',
            auth: 'bearer',
            responses: {
                204: 'Grant revoked',
                401: 'Authentication required',
                404: 'Grant not found',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const owner = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!owner) return ApiProblem.unauthorized();
            const grant = await getPlaybackGrant(ctx.input!.params!.id, owner, ctx.surface);
            if (!grant) return ApiProblem.notFound('Grant not found');
            return json({
                id: grant.id,
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
        DELETE: async (event, ctx) => {
            const owner = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!owner) return ApiProblem.unauthorized();
            const revoked = await revokePlaybackGrant(ctx.input!.params!.id, owner);
            if (!revoked) return ApiProblem.notFound('Grant not found');
            return new Response(null, { status: 204 });
        },
    },
});
