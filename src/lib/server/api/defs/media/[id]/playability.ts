// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/playability.ts — POST /media/{id}/playability
 *
 * The probe before POST /play-sessions: which versions a title has, how each
 * would play with the caller's capabilities, and which tracks the server would
 * preselect. Read-only: no play_sessions row, no playback grant, no stored plan,
 * no watch history. The decision is the one POST /play-sessions makes with the
 * same capabilities (shared `buildPlaybackStartInfo` + `startDecisionInputs`).
 *
 * Auth: `media:read` (a probe changes nothing; it reads what `GET /media/{id}` already
 * shows a `media:read` token: `progress` with the resume position and watched flag, plus
 * the file list). Unlike `POST /play-sessions` (`media:write`) it needs no write scope
 * because it creates nothing. The library group and age gate
 * are the ones POST /play-sessions applies; a title the caller cannot see is a
 * 404, never a 403. Mounted on both /api and /api/v1.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getDb } from '$lib/server/database/index.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { UUID_RE_LOOSE } from '$lib/utils/id-patterns.js';
import {
    PlayabilityRequestSchema,
    PlayabilityResponseSchema,
} from '$lib/schemas/api-playability.js';
import { probePlayability } from '$lib/server/services/playability.service.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:read'] },
    rateLimit: {
        // Read-only browsing, track changes and version pickers share this bucket.
        limit: 240,
        windowSec: 60,
        keyBy: (event) =>
            `playability:${event.locals.principal?.userId ?? event.locals.user?.userId}`,
    },

    request: { body: PlayabilityRequestSchema },

    docs: {
        POST: {
            tags: ['Playback'],
            stability: 'stable',
            summary: 'Probe how a title would play',
            auth: 'bearer',
            description:
                'Probe before you start. Returns every file version of a movie, episode or video with how it would ' +
                'play for the given `capabilities` (`playMethod`, `playable`, `reasons`, `outputHdr`), its duration, ' +
                'size and audio and subtitle tracks, plus the item-level resume position, watched flag, active file ' +
                "and the audio and subtitle tracks the server recommends from the user's language preferences. " +
                'The answer for a file is the one `POST /play-sessions` decides with the same capabilities. ' +
                'Nothing is created: no session, no grant, no watch history, no transcode. A version whose ' +
                'file cannot be read is listed with `playable: false` and `blockedBy: ["probe_failed"]`. ' +
                '`playable` also reflects the account\'s allowed play methods (`blockedBy: ["play_method_not_allowed"]`); ' +
                'concurrent-stream and IP rules are only checked by the start. Send the chosen ' +
                "`fileId`, `audioStreamIndex` (a track's `absoluteIndex`) and `subtitleId` in the " +
                '`POST /play-sessions` body. Pass `fileId` to probe one version only.',
            body: PlayabilityRequestSchema,
            responses: {
                200: {
                    schema: PlayabilityResponseSchema,
                    description: 'The versions of the title and how each would play',
                },
                401: 'Authentication required',
                404: 'Media not found, no such file version, or not visible to this account',
                422: 'This kind of item has no file versions to probe (music, audiobooks, Live TV, series)',
                429: 'Rate limit exceeded',
                503: 'Database unavailable, or no version of the title could be read in time',
            },
        },
    },

    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiResponses.serviceUnavailable('Database unavailable');

            const userId = event.locals.user?.userId;
            const username = event.locals.user?.username;
            if (!userId || !username) return ApiResponses.unauthorized();

            const id = event.params.id ?? '';
            // 404 for a malformed id too: it can name nothing the caller may see.
            if (!UUID_RE_LOOSE.test(id)) return ApiResponses.notFound('Media');
            const mediaId = id.toLowerCase();

            // Full media-access gate: library group + age rating. 404, not 403,
            // so a hidden title is indistinguishable from an absent one.
            if (!(await checkMediaAccess(sql, mediaId, event.locals.user))) {
                return ApiResponses.notFound('Media');
            }

            const body = ctx.input!.body;
            const result = await probePlayability({
                sql,
                userId,
                mediaId,
                // Ids are compared as text in SQL: normalise like mediaId.
                fileId: body.fileId?.toLowerCase(),
                capabilities: body.capabilities,
                surface: ctx.surface,
                username,
            });

            if (!result.ok) {
                if (result.status === 404) return ApiResponses.notFound('Media');
                if (result.status === 422) return ApiResponses.unprocessableEntity(result.message);
                // Anything else is "the files could not be read": the documented 503.
                return ApiResponses.serviceUnavailable(result.message);
            }
            return typedJson(PlayabilityResponseSchema, result.data);
        },
    },
});
