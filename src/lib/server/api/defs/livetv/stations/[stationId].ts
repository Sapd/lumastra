// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/stations/[stationId].ts — GET /livetv/stations/{stationId}
 *
 * GET /livetv/stations/{stationId}
 *   Returns the station record for the given UUID with its current and next
 *   EPG programmes. Logo URL points at the surface's entity-image route
 *   (see ../channels/logo-url.ts). The Apple players call this to refresh the playing
 *   station's guide when a programme ends, instead of the whole lineup.
 *
 * Auth: feature:FEATURE_LIVETV → user (+ inline hasLiveTvPermission check)
 */

import {
    resolveStation,
    stationDto,
    readStationNowNext,
} from '$lib/server/services/livetv/station.service.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { Logger } from '$lib/server/utils/logger.js';
import { channelImageSet } from '../channels/logo-url.js';
import { LiveTvStationDetailSchema } from '$lib/schemas/livetv.js';

// The handler returns the provider's LiveTvChannel FLAT (`{ ...stationDto(channel), images }`),
// not wrapped in `{ channel }`, with nowNext from the station schedule.

const logger = Logger.for('LiveTvChannel');

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

/**
 * Path params schema for GET /livetv/stations/{stationId}.
 *
 * The handler validates UUID format inline; this provides the declarative
 * contract that mount() validates before the handler runs.
 * Lenient: unknown fields are stripped.
 */
const ChannelParamsSchema = z.object({
    stationId: z.string().guid(),
});

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Get a Live TV station',
            auth: 'bearer',
            description:
                'Returns details for a specific Live TV station including the current and next program. ' +
                'Requires `hasLiveTvPermission`.',
            responses: {
                200: {
                    schema: LiveTvStationDetailSchema,
                    description: 'Channel details',
                },
                401: 'Authentication required',
                403: 'Live TV access not permitted',
                404: 'Channel not found',
                503: 'Live TV database or provider unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'FEATURE_LIVETV',
        then: { kind: 'user' },
    },
    request: {
        params: ChannelParamsSchema,
    },
    handlers: {
        /**
         * GET /livetv/stations/{stationId}
         *
         * Returns a single channel's detail, including its current EPG programme
         * and logo URL rewritten to the correct surface image base.
         *
         * Uses provider.getChannel() (single-channel DB lookup) rather than
         * provider.getChannels() (full list scan + 30 s cache warm) to avoid
         * loading every channel just to discard all but one.  Also returns
         * invisible channels to admins (getChannels() filters them out).
         */
        GET: async (event, ctx) => {
            const { locals, params } = event;

            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }

            const stationId = params.stationId;
            const channelId = stationId;
            if (!channelId)
                return ApiProblem.validationFailed([{ field: 'id', message: 'Required' }]);
            if (!isUuid(channelId)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a valid UUID' },
                ]);
            }

            let station;

            try {
                station = await resolveStation(stationId!);
            } catch {
                return ApiProblem.dependencyUnavailable('Live TV database unavailable');
            }
            if (!station) return ApiProblem.notFound('Station not found');
            // The lineup gate the stream endpoints use: a viewer gets 404 for a
            // channel they may not open (a hidden feed, a hidden category).
            if (!(await canStreamLiveTvChannel(locals, station.shownFeedId))) {
                return ApiProblem.notFound(`Channel ${channelId} not found`);
            }

            let provider;
            let channel;
            try {
                provider = await getLiveTvProvider();
                channel = await provider.getChannel(station.shownFeedId);
            } catch {
                return ApiProblem.dependencyUnavailable('Live TV provider unavailable');
            }

            if (!channel) {
                return ApiProblem.notFound(`Channel ${channelId} not found`);
            }

            // The guide is optional: a failed read leaves both nowNext members null.
            const nowNext = await readStationNowNext(station.stationId).catch((err: unknown) => {
                logger.warn('Station guide read failed', {
                    stationId,
                    error: (err as Error).message,
                });
                return { current: null, next: null };
            });

            const result = {
                ...stationDto(channel, nowNext),
                images: channelImageSet(ctx.surface, station.shownFeedId, channel.images),
            };

            return json(result);
        },
    },
});
