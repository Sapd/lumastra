// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** The sole VOD preview creator on both surfaces: admission, cached artifacts and trailers. */

import { createHash } from 'node:crypto';

import { getClientIpStrictFromRequest } from '$lib/server/utils/client-ip.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { get as getConfig } from '$lib/server/config/config.service.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getPreviewSession,
    getUserPreviewSessions,
    getUserLiveTvSessionId,
    cleanupPreviewSession,
    getLiveTvSessionCount,
    getLiveTvWatcherCount,
    createPreview,
    findReusablePreview,
} from '$lib/server/services/preview-session.service.js';
import { pickEvictionVictim } from '$lib/server/services/preview-eviction.js';
import { checkPreviewAdmission } from '$lib/server/services/preview-admission.service.js';
import {
    findLocalTrailerForItem,
    getMediaTypeAndParent,
} from '$lib/server/database/queries/media-extras.queries.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { getDb } from '$lib/server/database/index.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    CreatedPreviewResponseSchema,
    PreviewSessionNoTrailerSchema,
} from '$lib/schemas/api-playback-responses';

const logger = Logger.for('PlaybackPreviewsDef');

import { resolvePreviewStartPosition } from '$lib/server/utils/preview-start-position.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { PREVIEW_KEEPALIVE_INTERVAL_MS } from '$lib/shared/preview-heartbeat.js';

/** The subset of a create/reuse outcome this endpoint projects. */
interface PreviewResultShape {
    playSessionId: string;
    sessionItemId: string;
    streamUrl: string;
    playMethod: string;
    transcodeMode: string;
    hlsStartPosition: number;
    mode?: 'preview' | 'trailer';
}

/**
 * One body shape for both the created and the reused answer.
 *
 * Written once on purpose: a reused preview that reported a different shape
 * than a created one would be a contract fork visible only to whichever clients
 * happened to hit the coalescing path.
 */
function previewResponse(r: PreviewResultShape, surface: ApiSurface): Record<string, unknown> {
    return {
        id: r.playSessionId,
        mediaId: r.sessionItemId,
        streamUrl: r.streamUrl,
        playMethod: r.playMethod,
        transcodeMode: r.transcodeMode,
        hlsStartPosition: r.hlsStartPosition,
        mode: r.mode ?? 'preview',
        reporting: {
            kind: 'keepalive',
            method: 'POST',
            playbackSessionId: r.playSessionId,
            intervalMs: PREVIEW_KEEPALIVE_INTERVAL_MS,
            href: apiUrl(surface, `/playback/previews/${r.playSessionId}/keepalive`),
        },
    };
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const CreatePreviewBody = z
    .object({
        trailerPreferred: z.boolean().optional(),
        trailerRequired: z.boolean().optional(),
        /**
         * Internal media UUID (required).
         * No more itemId in path — body-first design mirrors stream-tokens.
         */
        mediaId: z.string().min(1),
        /** Optional file UUID to override the default file selection. */
        fileId: z.string().optional(),
        /**
         * Start position in seconds.
         *
         * OMIT IT for a normal preview: the server then picks a runtime-proportional
         * position that skips studio logos and opening credits (identical heuristic
         * to the web player — see $lib/shared/preview-position). Send an explicit
         * value only for a genuine resume position, or 0 for trailers/Live TV.
         */
        startPositionSeconds: z
            .number()
            .min(0)
            .optional()
            .describe(
                'Start position in seconds. OMIT for a normal preview — the server then picks a ' +
                    'runtime-proportional position that skips studio logos and opening credits. ' +
                    'Send an explicit value only for a genuine resume position, or 0 for ' +
                    'trailers and Live TV.',
            ),
        /** Set to true when previewing a live TV channel. */
        isLiveTv: z.boolean().optional(),
        /**
         * Force h264/AAC codec for shared previews (e.g. homepage hero).
         * When true the planner never emits hevc/av1.
         */
        heroSafeCodec: z.boolean().optional(),
    })
    .strict();

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Playback'],
            summary: 'Create a hover-preview transcode session',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: PreviewSessionNoTrailerSchema,
                    description: 'No local trailer exists (mode: none); no session allocated',
                },
                201: {
                    schema: CreatedPreviewResponseSchema,
                    description: 'Preview session created',
                },
                401: 'Authentication required',
                404: 'Media not found or not accessible',
                503: 'Previews disabled, database unavailable, or preview capacity unavailable',
                429: 'Rate limit exceeded',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },

    request: {
        /**
         * POST body — CreatePreviewBody.
         *
         * Derived from the inline CreatePreviewBodySchema in the original handler.
         * Required: mediaId.  All other fields optional.
         * Unknown fields are rejected.
         */
        body: CreatePreviewBody,
    },

    handlers: {
        POST: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const trailerPreferred = ctx.input!.body.trailerPreferred === true;
            const trailerRequired = ctx.input!.body.trailerRequired === true;
            const trailerProbe = trailerPreferred || trailerRequired;
            const previewEnabled = getConfig('FEATURE_MEDIA_HOVER_VIDEO_PREVIEW');
            if (!previewEnabled && !trailerProbe) {
                return problem('not_found', {
                    error: 'Video preview feature is not enabled',
                });
            }

            const { mediaId, fileId, startPositionSeconds, isLiveTv, heroSafeCodec } =
                ctx.input!.body;

            // Media access check — BOTH axes. isMediaAccessible alone is the
            // library-group axis only and returns true whenever no library
            // restrictions are configured, which let an age-restricted user open a
            // preview of an 18-rated item.
            //
            // One `getDb()` for the whole handler: the access check used to
            // take its own handle and skip itself when the DB was down, which
            // read as fail-open but never was — the very next statement returned
            // 503 on the same null.
            const sql = getDb();
            if (!sql) {
                return problem('dependency_unavailable', { error: 'Database unavailable' });
            }
            const typeRow = await getMediaTypeAndParent(sql, mediaId);
            if (typeRow?.media_type === 'extra' && !typeRow.parent_id)
                return problem('not_found', { error: 'Media not found' });
            const accessId = typeRow?.media_type === 'extra' ? typeRow.parent_id! : mediaId;
            if (!(await checkMediaAccess(sql, accessId, event.locals.user))) {
                return problem('not_found', { error: 'Media not found' });
            }

            const localTrailer = trailerProbe ? await findLocalTrailerForItem(sql, mediaId) : null;
            if (trailerRequired && !localTrailer) {
                return json({ mode: 'none' });
            }

            // The one trailer fact reuse lookup and creation both key on: a trailer
            // was asked for AND exists. (Reuse compares it with a session's isTrailer.)
            const useTrailer = !!localTrailer;

            // Clients that don't compute a start position (tvOS) previously fell
            // through to 0 and opened every preview on the studio logo reel.
            // Resolve BEFORE the reuse lookup, not just before createPreview:
            // the lookup is keyed on the seek position, so defaulting later
            // would make every request look like a different preview and defeat
            // coalescing entirely.
            const resolvedStartPosition =
                isLiveTv || localTrailer
                    ? 0
                    : await resolvePreviewStartPosition(sql, mediaId, startPositionSeconds);

            // Reuse an already-running artifact for the same item+seek
            // BEFORE evicting or creating anything.
            //
            const reusable = await findReusablePreview({
                userId,
                requestedItemId: mediaId,
                trailerPreferred: useTrailer,
                startPositionSeconds: resolvedStartPosition,
                isLiveTv,
                authMethod: event.locals.authMethod,
                clientIp: getClientIpStrictFromRequest(event.request, event.getClientAddress),
                deviceSessionId: event.locals.deviceSessionId,
                parentTokenHash:
                    event.locals.authMethod === 'pat' && event.locals.accessToken
                        ? createHash('sha256').update(event.locals.accessToken).digest('hex')
                        : undefined,
                mintedByAdmin: event.locals.principal?.isAdmin === true,
            });
            if (reusable) {
                // 201, not 200, even though nothing was created. The declared
                // contract for this endpoint has exactly one success code and
                // shipped native clients enforce it strictly — the iOS client
                // accepts `.created` and silently returns nil on anything else,
                // so a "more correct" 200 here would make every reused preview
                // look like a failure to the very clients this path exists for.
                return json(previewResponse(reusable, ctx.surface), {
                    status: 201,
                    headers: {
                        Location: apiUrl(
                            ctx.surface,
                            `/playback/previews/${reusable.playSessionId}`,
                        ),
                    },
                });
            }

            // Reserve global capacity for new work only; reuse adds no encoding load.
            const admission = await checkPreviewAdmission();
            if (!admission.admit) {
                logger.warn('Preview request refused by admission control', {
                    reason: admission.reason,
                    mediaId,
                    userId,
                });
                return problem('rate_limited', {
                    error: admission.message ?? 'Video previews are temporarily unavailable.',
                });
            }

            // From here on a reservation slot is held; release it on EVERY exit
            // path (success, live-TV limit, error, throw) or the global budget
            // leaks a slot and permanently shrinks.
            try {
                // Enforce max concurrent previews per user. A `while` (not `if`)
                // because a single create only removes ONE session — if the cap
                // was just lowered (or several previews piled up before this
                // request), one eviction is not enough to get under the cap, and
                // an `if` would leave the user permanently over it. The length
                // check after each eviction guards against spinning forever if
                // cleanup ever fails to shrink the list (pickEvictionVictim always
                // returns a member of its input, so this should not happen).
                let userPreviews = await getUserPreviewSessions(userId);
                while (userPreviews.length >= config.PREVIEW_MAX_PER_USER) {
                    const victim = pickEvictionVictim(userPreviews);
                    await cleanupPreviewSession(victim.playSessionId, victim, userId);
                    const remaining = userPreviews.filter(
                        (s) => s.playSessionId !== victim.playSessionId,
                    );
                    if (remaining.length >= userPreviews.length) {
                        logger.error(
                            'Eviction did not shrink the per-user preview list; aborting to avoid spinning',
                            undefined,
                            { userId, count: remaining.length },
                        );
                        break;
                    }
                    userPreviews = remaining;
                }

                // Live TV rate limiting.
                if (isLiveTv) {
                    const liveTvEnabled = getConfig('FEATURE_MEDIA_HOVER_VIDEO_PREVIEW_LIVETV');
                    if (!liveTvEnabled) {
                        return problem('not_found', {
                            error: 'Live TV previews are not enabled',
                        });
                    }

                    const maxPerServer = getConfig<number>('PREVIEW_MAX_LIVETV_PER_SERVER');
                    const current = await getLiveTvSessionCount();
                    if (current >= maxPerServer) {
                        return problem('rate_limited', {
                            error: 'Server live TV preview limit reached',
                        });
                    }

                    const maxWatchers = getConfig<number>('PREVIEW_MAX_LIVETV_WATCHERS');
                    if (maxWatchers > 0) {
                        const watchers = await getLiveTvWatcherCount();
                        if (watchers >= maxWatchers) {
                            return problem('rate_limited', {
                                error: 'Too many live TV watchers',
                            });
                        }
                    }

                    const existingId = await getUserLiveTvSessionId(userId);
                    if (existingId) {
                        const existing = await getPreviewSession(existingId);
                        if (existing) {
                            await cleanupPreviewSession(existingId, existing, userId);
                        }
                    }
                }

                const result = await createPreview({
                    sql,
                    itemId: mediaId,
                    username: event.locals.user?.username ?? String(userId),
                    userId,
                    internalId: mediaId,
                    fileId,
                    startPositionSeconds: resolvedStartPosition,
                    isLiveTv,
                    heroSafeCodec,
                    trailerPreferred: useTrailer,
                    trailerRequired,
                    // Selects the HLS surface for the returned streamUrl: token
                    // clients (tvOS AVPlayer, api_key auth) need /api/v1/*.
                    authMethod: event.locals.authMethod,
                    clientIp: getClientIpStrictFromRequest(event.request, event.getClientAddress),
                    deviceSessionId: event.locals.deviceSessionId,
                    parentTokenHash:
                        event.locals.authMethod === 'pat' && event.locals.accessToken
                            ? createHash('sha256').update(event.locals.accessToken).digest('hex')
                            : undefined,
                    mintedByAdmin: event.locals.principal?.isAdmin === true,
                });

                if ('mode' in result && result.mode === 'none') return json({ mode: 'none' });

                if ('error' in result) {
                    if (result.status === 400) {
                        return problem('validation_failed', { error: result.error });
                    }
                    if (result.status === 404) {
                        return problem('not_found', { error: result.error });
                    }
                    return problem('internal_error', { error: result.error });
                }

                const r = result as PreviewResultShape;

                return json(previewResponse(r, ctx.surface), {
                    status: 201,
                    headers: {
                        Location: apiUrl(ctx.surface, `/playback/previews/${r.playSessionId}`),
                    },
                });
            } catch (error) {
                logger.error('Failed to create preview session', error as Error, { mediaId });
                return problem('internal_error');
            } finally {
                admission.release?.();
            }
        },
    },
});
