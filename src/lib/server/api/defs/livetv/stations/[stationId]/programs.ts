// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '$lib/server/utils/logger.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { pickNowNext } from '$lib/shared/livetv-now-next.js';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access.js';
import { resolveStation, readStationAirings } from '$lib/server/services/livetv/station.service.js';
import { StationProgramsResponseSchema } from '$lib/schemas/livetv.js';

import { ProgramsWindowSchema, validateReadWindow } from '../../read-window.js';
export { ProgramsWindowSchema } from '../../read-window.js';

const logger = Logger.for('LiveTvStationPrograms');

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Get programs for a station in an explicit time window',
            query: ProgramsWindowSchema,
            responses: {
                200: {
                    schema: StationProgramsResponseSchema,
                    description: 'Station programs',
                },
                401: 'Authentication required',
                404: 'Station not found',
                422: 'Invalid window (maximum 24 hours)',
                503: 'Live TV provider unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    request: {
        params: z.object({ stationId: z.string().guid() }),
        query: ProgramsWindowSchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            if (!event.locals.user?.hasLiveTvPermission) return ApiProblem.notFound();
            const error = validateReadWindow(ctx.input!.query);
            if (error) return error;
            let station;

            try {
                station = await resolveStation(ctx.input!.params.stationId);
            } catch (err) {
                logger.error('Station programs read failed', err as Error);
                return ApiProblem.dependencyUnavailable('Live TV database unavailable');
            }
            if (!station || !(await canStreamLiveTvChannel(event.locals, station.shownFeedId))) {
                return ApiProblem.notFound('Station not found');
            }
            try {
                const { from, to } = ctx.input!.query;
                const schedules = await readStationAirings(
                    [station.stationId],
                    new Date(from),
                    new Date(to),
                );
                const airings = schedules.get(station.stationId) ?? [];
                const now = Date.now();
                return json({
                    stationId: station.stationId,
                    window: {
                        from: new Date(from).toISOString(),
                        to: new Date(to).toISOString(),
                        asOf: new Date(now).toISOString(),
                    },
                    airings,
                    nowNext: pickNowNext(airings, now),
                });
            } catch (err) {
                logger.error('Station programs read failed', err as Error);
                return ApiProblem.dependencyUnavailable('Live TV provider unavailable');
            }
        },
    },
});
