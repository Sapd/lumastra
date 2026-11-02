// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** GET /livetv/stations/{stationId}/current-program — now/next from the station schedule. */

import {
    resolveStation,
    readStationSchedules,
} from '$lib/server/services/livetv/station.service.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { pickNowNext } from '$lib/shared/livetv-now-next.js';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access.js';
import { CurrentProgramResponseSchema } from '$lib/schemas/livetv';

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

const CurrentProgramParamsSchema = z.object({
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
            summary: 'Get the programme airing now on a station',
            auth: 'bearer',
            description: 'Returns nowNext and the server observation time asOf.',
            responses: {
                200: {
                    schema: CurrentProgramResponseSchema,
                    description: 'Current program (if any)',
                },
                401: 'Authentication required',
                404: 'Channel not found',
                503: 'Live TV provider unavailable',
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
        params: CurrentProgramParamsSchema,
    },
    handlers: {
        /**
         * GET /livetv/stations/{stationId}/current-program
         *
         * Returns { nowNext, asOf } using the same schedule as the station list.
         */
        GET: async (event) => {
            const { locals, params } = event;

            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }

            const stationId = params.stationId;
            const channelId = stationId;
            if (!channelId) {
                return ApiProblem.validationFailed([{ field: 'channelId', message: 'Required' }]);
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

            try {
                const schedules = await readStationSchedules([station.stationId]);
                const now = Date.now();
                return json({
                    nowNext: pickNowNext(schedules.get(station.stationId) ?? [], now),
                    asOf: new Date(now).toISOString(),
                });
            } catch {
                return ApiProblem.dependencyUnavailable('Live TV schedule unavailable');
            }
        },
    },
});
