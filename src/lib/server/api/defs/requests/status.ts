// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/requests/status.ts — POST /requests/status
 *
 * Batch status-check for media requests.  Accepts up to 20 items and returns
 * per-item request/availability status including download progress.
 *
 * Auth: user.
 * Rate-limit: STANDARD (100 / 60 s) — matched to the old legacy handler.
 *
 * Response: bare JSON array of RequestStatusResult objects (not {items,page}
 * because this is a one-shot batch RPC, not a pageable collection).
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { getClientIp } from '$lib/server/utils/client-ip.js';
import { providerResolutionService } from '$lib/server/services/provider-resolution.service.js';
import {
    jellyseerrClient,
    type MediaStatus,
    type JellyseerrRequest,
    type SeasonRequestStatus,
} from '$lib/server/jellyseerr.js';
import { radarrClient, sonarrClient } from '$lib/server/sonarr.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { getDb } from '$lib/server/database/index.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { getExternalIdFor, withoutLegacyJellyfinId } from '$lib/utils/external-ids.js';
import { RequestStatusResponseSchema } from '$lib/schemas/api-content-responses.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import {
    type RequestStatusQuery,
    type RequestStatusResult,
    type ArrStatus,
    checkLocalAvailability,
    checkIfWatched,
    validateRequestQuery,
    determineSeasonStatus,
    determineMovieStatus,
    determineTvAggregateStatus,
} from '$lib/server/services/request-status/index.js';

const logger = Logger.for('RequestStatusDef');

// ---------------------------------------------------------------------------
// Rate-limit constants (STANDARD: 100 / 60 s)
// ---------------------------------------------------------------------------

const STATUS_RATE_LIMIT = 100;
const STATUS_RATE_WINDOW = 60;

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

/**
 * Single status query item.
 *
 * `mediaType` accepts both `series` (canonical) and the legacy `tv` token —
 * the underlying service layer uses `isSeries()` which recognises both.
 */
const StatusQueryItemSchema = z.object({
    externalIds: z
        .record(z.string(), z.string())
        .refine((ids) => Object.values(ids).some((v) => typeof v === 'string' && v.length > 0), {
            message: 'At least one external ID is required',
        }),
    /** Canonical: `movie` or `series`. Legacy `tv` is accepted. */
    mediaType: z.enum(['movie', 'series']).meta({
        description: 'Media type: movie or series.',
    }),
    seasons: z
        .array(z.number().int().min(0))
        .max(50)
        .optional()
        .meta({ description: 'Season numbers — one result row is returned per season' }),
});

const StatusBodySchema = z.object({
    requests: z.array(StatusQueryItemSchema).min(1).max(20),
});

// ---------------------------------------------------------------------------
// Internal type
// ---------------------------------------------------------------------------

interface InternalRequestStatusQuery extends RequestStatusQuery {
    tmdbId: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveToTmdbId(
    externalIds: ExternalIds,
    mediaType: string,
): Promise<number | null> {
    // Normalise `series` → `tv` for the resolver (internal convention)
    const internalType = isSeries(mediaType) ? 'tv' : 'movie';
    // No cast needed — the ternary above already produces exactly 'tv' | 'movie'.
    const resolution = await providerResolutionService.resolveToTmdb(externalIds, internalType);
    if (!resolution.success) {
        logger.debug('Failed to resolve externalIds to TMDB', {
            externalIds,
            mediaType,
            reason: resolution.reason,
        });
        return null;
    }
    return resolution.tmdbId;
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Request'],
            summary: 'Check request status for items',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Checks the current request/availability status for 1–20 media items in one call. ' +
                'This is the only endpoint that carries live progress — ' +
                '`download.percentage` (plus `timeLeft`, `size`, `sizeLeft`) and ' +
                '`statusMessage`. `GET /requests` and `GET /requests/{id}` return only the ' +
                'coarse status label.\n\n' +
                'Answers "has this been requested, and what is its status?" directly from ' +
                '`externalIds` + `mediaType`, without needing a Jellyseerr request ID.\n\n' +
                'Pass `seasons` to get one result row per season (each carrying `seasonNumber`); ' +
                'otherwise a series returns a single aggregate row. ' +
                'Rate-limited: 100 requests per 60 seconds per user.\n\n' +
                'Returns a bare JSON array (not `{items,page}`) — this is a batch RPC, not a ' +
                'pageable collection.',
            body: StatusBodySchema,
            responses: {
                200: {
                    schema: RequestStatusResponseSchema,
                    description: 'Request statuses for the submitted items, in submission order',
                },
                401: 'Authentication required',
                422: 'Validation error or unresolvable external ID',
                429: 'Rate limit exceeded',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        body: StatusBodySchema,
    },
    handlers: {
        /**
         * POST /requests/status
         *
         * Checks the current request/availability status for 1–20 media items.
         * Returns a bare JSON array (not {items,page} — this is a batch RPC).
         *
         * Each result echoes the input externalIds + mediaType and adds:
         *   status, statusMessage?, download?, watched?, seasonNumber?
         *
         * `mediaType` in the response always uses the public discriminator value
         * (`movie` | `series`) — never the internal `tv`.
         */
        POST: async (event, ctx) => {
            // Rate limit: 100 / 60 s
            const ip = getClientIp(event);
            const username = event.locals.user?.username || 'anonymous';
            const rl = await checkRateLimit(
                `${ip}:${username}:requests-status`,
                STATUS_RATE_LIMIT,
                STATUS_RATE_WINDOW,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(
                    Math.max(1, Math.ceil(rl.resetAt - Date.now() / 1000)),
                );
            }

            // Body was validated by mount() and is in ctx.input.body.
            // Fall back to manual parse when called outside mount() (tests).
            let parsedBody: z.infer<typeof StatusBodySchema>;
            if (ctx.input?.body) {
                parsedBody = ctx.input.body;
            } else {
                let raw: unknown;
                try {
                    raw = await event.request.json();
                } catch {
                    return ApiProblem.validationFailed('Request body must be valid JSON');
                }
                const result = StatusBodySchema.safeParse(raw);
                if (!result.success) {
                    return ApiProblem.validationFailed(
                        result.error.issues.map((e) => ({
                            field: e.path.join('.'),
                            message: e.message,
                        })),
                    );
                }
                parsedBody = result.data;
            }

            const { locals, request } = event;
            const effectiveUsername = getEffectiveUser(
                request,
                locals.user?.username || config.DEFAULT_USER,
            );

            // Access boundary for local-availability checks
            const sqlForAccess = getDb();
            const accessCtx = sqlForAccess
                ? await buildSearchAccessContext(sqlForAccess, locals.user)
                : {
                      username: locals.user?.username ?? null,
                      deniedGroupIds: null,
                      ageRating: null,
                      liveTvAllowed: false,
                  };
            const accessForCheck = {
                deniedGroupIds: accessCtx.deniedGroupIds,
                ageRating: accessCtx.ageRating,
            };

            // `effectiveUsername` is a login name — right for Jellyseerr, wrong for
            // `checkIfWatched`, which filters `user_media_state.user_id` (a uuid).
            // Passing the name through made every watch-history check throw
            // `invalid input syntax for type uuid` and get swallowed into `false`,
            // so nothing ever read as watched. `locals.user` carries no id, so the
            // name has to be resolved here. Null (unknown user, or no DB) means
            // "cannot tell" — callers skip the check rather than claim unwatched.
            const watchedUserId = sqlForAccess
                ? await getUserIdByUsername(sqlForAccess, effectiveUsername)
                : null;

            const rawRequests = parsedBody.requests;

            // Resolve externalIds → TMDB and validate
            const requests: InternalRequestStatusQuery[] = [];
            for (let i = 0; i < rawRequests.length; i++) {
                // A legacy Jellyfin item id from an older client is never
                // echoed back (responses carry no Jellyfin ids).
                const rawReq = {
                    ...rawRequests[i],
                    externalIds: withoutLegacyJellyfinId(rawRequests[i].externalIds),
                };
                const tmdbId = await resolveToTmdbId(
                    rawReq.externalIds as ExternalIds,
                    rawReq.mediaType,
                );
                if (tmdbId === null) {
                    return ApiProblem.validationFailed(
                        `Request at index ${i}: must have valid externalIds with at least one provider ID`,
                    );
                }
                // Normalise for the internal service layer (always 'movie'|'tv')
                const internalMediaType: 'movie' | 'tv' = isSeries(rawReq.mediaType)
                    ? 'tv'
                    : 'movie';
                const reqWithTmdbId = { ...rawReq, mediaType: internalMediaType, tmdbId };
                const validation = validateRequestQuery(reqWithTmdbId, i);
                if (!validation.valid) {
                    return ApiProblem.validationFailed(validation.error ?? 'Invalid request');
                }
                requests.push({ ...validation.data, tmdbId });
            }

            logger.debug('Processing status check', {
                count: requests.length,
                ids: requests.map((r) => r.tmdbId),
            });

            // Shared data — fetched in parallel
            const [sonarrQueue, radarrQueue, user] = await Promise.all([
                sonarrClient.getAllQueueRecords({ includeSeries: true, includeEpisode: true }),
                radarrClient.getAllQueueRecords({ includeMovie: true }),
                jellyseerrClient.getUserByUsername(effectiveUsername),
            ]);

            let userRequests: JellyseerrRequest[] = [];
            if (user) {
                userRequests = await jellyseerrClient.getRequests({
                    requestedBy: user.id,
                    take: 50,
                });
            }

            // Pre-fetch Jellyseerr media info in parallel
            const mediaInfoMap = new Map<
                string,
                Awaited<ReturnType<typeof jellyseerrClient.getMediaByTmdbId>>
            >();
            const mediaInfoResults = await Promise.all(
                requests.map(async (req) => {
                    const key = `${req.tmdbId}-${req.mediaType}`;
                    try {
                        const info = await jellyseerrClient.getMediaByTmdbId(
                            req.tmdbId,
                            req.mediaType,
                        );
                        return { key, info };
                    } catch {
                        return { key, info: null };
                    }
                }),
            );
            for (const { key, info } of mediaInfoResults) {
                mediaInfoMap.set(key, info);
            }

            // Pre-fetch season statuses for TV requests with seasons
            const seasonStatusMap = new Map<string, SeasonRequestStatus[] | null>();
            const tvRequestsWithSeasons = requests.filter(
                (r) => isSeries(r.mediaType) && r.seasons && r.seasons.length > 0,
            );
            if (tvRequestsWithSeasons.length > 0) {
                const seasonStatusResults = await Promise.all(
                    tvRequestsWithSeasons.map(async (req) => {
                        const compositeKey = `${getExternalIdFor(req.externalIds, 'tmdb') || 'unknown'}:tv`;
                        try {
                            const statuses = await jellyseerrClient.getSeasonRequestStatus(
                                req.tmdbId,
                            );
                            return { compositeKey, statuses };
                        } catch {
                            return { compositeKey, statuses: null };
                        }
                    }),
                );
                for (const { compositeKey, statuses } of seasonStatusResults) {
                    seasonStatusMap.set(compositeKey, statuses);
                }
            }

            // Process each request
            const results: RequestStatusResult[] = [];

            for (const req of requests) {
                logger.debug('Processing request', {
                    tmdbId: req.tmdbId,
                    mediaType: req.mediaType,
                    seasonCount: req.seasons?.length,
                });

                try {
                    const mediaInfoKey = `${req.tmdbId}-${req.mediaType}`;
                    const mediaInfo = mediaInfoMap.get(mediaInfoKey);

                    // Season-specific TV queries
                    if (isSeries(req.mediaType) && req.seasons && req.seasons.length > 0) {
                        const tvdbId = mediaInfo?.tvdbId;
                        const seasonCompositeKey = `${getExternalIdFor(req.externalIds, 'tmdb') || 'unknown'}:tv`;
                        const jellyseerrSeasonStatuses =
                            seasonStatusMap.get(seasonCompositeKey) || null;
                        const userRequest = userRequests.find(
                            (r) => r.media?.tmdbId === req.tmdbId && r.type === req.mediaType,
                        );
                        const requestAge = userRequest
                            ? Date.now() - new Date(userRequest.createdAt).getTime()
                            : 0;

                        for (const seasonNum of req.seasons) {
                            const seasonResult = await determineSeasonStatus(
                                req.externalIds,
                                seasonNum,
                                tvdbId,
                                sonarrQueue,
                                jellyseerrSeasonStatuses,
                                requestAge,
                                accessForCheck,
                                watchedUserId ?? undefined,
                            );
                            results.push(seasonResult);
                        }
                        continue;
                    }

                    // Local availability check
                    const localAvailability = await checkLocalAvailability(
                        req.externalIds,
                        req.mediaType,
                        accessForCheck,
                    );
                    if (localAvailability?.isAvailable) {
                        const watched = watchedUserId
                            ? await checkIfWatched(watchedUserId, req.externalIds, req.mediaType)
                            : false;
                        results.push({
                            // Merge the resolved internal UUID into the echoed
                            // ids. `status: 'available'` is exactly the moment a
                            // fulfilled request becomes a catalog row, so this is
                            // when a UUID-first client can finally resolve it —
                            // and the caller cannot have sent `internal` itself,
                            // because before fulfilment the row did not exist.
                            // The UUID was already being fetched here and thrown
                            // away; only the boolean survived.
                            externalIds: {
                                ...req.externalIds,
                                internal: localAvailability.internalId,
                            },
                            mediaType: req.mediaType,
                            status: 'available',
                            watched,
                        });
                        continue;
                    }

                    const userRequest = userRequests.find(
                        (r) => r.media?.tmdbId === req.tmdbId && r.type === req.mediaType,
                    );
                    const requestAge = userRequest
                        ? Date.now() - new Date(userRequest.createdAt).getTime()
                        : 0;

                    // Movie handling
                    if (isMovie(req.mediaType)) {
                        const movieResult = await determineMovieStatus(
                            req.externalIds,
                            radarrQueue,
                            requestAge,
                            mediaInfo?.status as MediaStatus | undefined,
                            accessForCheck,
                        );
                        if (movieResult.status === 'available') {
                            movieResult.watched = watchedUserId
                                ? await checkIfWatched(
                                      watchedUserId,
                                      req.externalIds,
                                      req.mediaType,
                                  )
                                : false;
                        }
                        results.push({ ...movieResult, externalIds: req.externalIds });
                        continue;
                    }

                    // TV aggregate logic
                    let arrStatus: ArrStatus | undefined;
                    const tvdbId = userRequest?.media?.tvdbId || mediaInfo?.tvdbId;
                    if (tvdbId) {
                        const sonarrSeries = await sonarrClient.getSeriesByTvdbId(tvdbId);
                        if (sonarrSeries) {
                            arrStatus = {
                                isMonitored: sonarrSeries.monitored,
                                hasFile: (sonarrSeries.statistics?.episodeFileCount || 0) > 0,
                                releaseStatus: sonarrSeries.status,
                                nextRelease: sonarrSeries.nextAiring || sonarrSeries.firstAired,
                            };
                        }
                    }

                    const { status, download, statusMessage } = determineTvAggregateStatus(
                        mediaInfo?.status as MediaStatus | undefined,
                        sonarrQueue,
                        tvdbId,
                        requestAge,
                        arrStatus,
                    );

                    results.push({
                        externalIds: req.externalIds,
                        mediaType: req.mediaType,
                        status,
                        statusMessage,
                        download,
                    });
                } catch (error) {
                    logger.error('Failed to check status for request', error as Error, {
                        tmdbId: req.tmdbId,
                        mediaType: req.mediaType,
                    });
                    results.push({
                        externalIds: req.externalIds,
                        mediaType: req.mediaType,
                        status: 'pending',
                    });
                }
            }

            // Project to the public contract before serializing:
            //   1. strip the server-internal `download.state`
            //   2. canonicalise `mediaType` 'tv' → 'series'
            //
            // (2) was missing: every builder in the request-status service layer
            // emits the internal `tv` (see resolvers.ts / utils.ts), so this
            // endpoint leaked `tv` despite its own doc comment and
            // RequestStatusResultSchema both declaring `movie | series`.
            //
            // Inline conversion is correct here rather than toPublicMediaType():
            // `RequestStatusResult.mediaType` is the closed union 'movie' | 'tv'
            // (narrowed at the top of this handler), so the pass-through arm
            // cannot carry a token the public vocabulary has no member for.
            // See docs/dev/media-type-vocabulary.md, "When a hand-written
            // conversion IS correct".
            const publicResults = results.map((r) => {
                const mediaType = r.mediaType === 'tv' ? 'series' : r.mediaType;
                if (!r.download) return { ...r, mediaType };
                const { state: _state, ...publicDownload } = r.download;
                return { ...r, mediaType, download: publicDownload };
            });

            return json(publicResults);
        },
    },
});
