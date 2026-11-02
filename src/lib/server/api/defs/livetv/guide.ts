// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { hideOfflineStations } from '$lib/server/services/livetv/channel-health.service.js';
import {
    readStationAirings,
    stationIdOfFeed,
} from '$lib/server/services/livetv/station.service.js';
import { pickNowNext } from '$lib/shared/livetv-now-next.js';
import { GuideResponseSchema } from '$lib/schemas/livetv.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('LiveTvGuide');
import {
    ProgramsWindowSchema,
    validateReadWindow,
    encodeGuideCursor,
    decodeGuideCursor,
} from './read-window.js';

const GuideQuerySchema = ProgramsWindowSchema.extend({
    stationIds: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
}).superRefine((input, ctx) => {
    if (
        input.stationIds !== undefined &&
        (input.cursor !== undefined || input.limit !== undefined)
    ) {
        ctx.addIssue({
            code: 'custom',
            path: ['stationIds'],
            message: 'Use stationIds or limit/cursor',
        });
    }
    if (
        input.stationIds !== undefined &&
        input.stationIds.split(',').filter((id) => id.trim()).length > 200
    ) {
        ctx.addIssue({ code: 'custom', path: ['stationIds'], message: 'At most 200 station ids' });
    }
    if (input.cursor !== undefined && decodeGuideCursor(input.cursor) === null) {
        ctx.addIssue({ code: 'custom', path: ['cursor'], message: 'Invalid guide cursor' });
    }
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Get a window of station airings',
            query: GuideQuerySchema,
            responses: {
                200: { schema: GuideResponseSchema, description: 'Ordered station schedules' },
                401: 'Authentication required',
                404: 'Live TV not available',
                422: 'Invalid window or paging (maximum 24 hours)',
                503: 'Live TV dependency unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    request: { query: GuideQuerySchema },
    handlers: {
        GET: async (event, ctx) => {
            if (!event.locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }
            const input = ctx.input!.query;
            const error = validateReadWindow(input);
            if (error) return error;
            const from = new Date(input.from);
            const to = new Date(input.to);
            const requested =
                input.stationIds === undefined
                    ? undefined
                    : [
                          ...new Set(
                              input.stationIds
                                  .split(',')
                                  .map((id) => id.trim().toLowerCase())
                                  .filter(Boolean),
                          ),
                      ];
            const limit = input.limit ?? 50;
            const requestedSet = requested === undefined ? undefined : new Set(requested);
            const afterId =
                input.cursor === undefined ? undefined : decodeGuideCursor(input.cursor)!;
            try {
                const provider = await getLiveTvProvider();
                const channels = await provider.getChannels();
                const lineup = [
                    ...new Set(
                        (await hideOfflineStations(channels, event.locals))
                            .filter((feed) => feed.isVisible)
                            .map(stationIdOfFeed),
                    ),
                ];
                let offset = 0;
                if (afterId !== undefined) {
                    const cursorIndex = lineup.indexOf(afterId);
                    if (cursorIndex !== -1) {
                        offset = cursorIndex + 1;
                    } else {
                        // The station may have been hidden (offline) between two pages: place the
                        // cursor in the unfiltered order and continue after it.
                        const fullLineup = [
                            ...new Set(
                                channels.filter((feed) => feed.isVisible).map(stationIdOfFeed),
                            ),
                        ];
                        const fullIndex = fullLineup.indexOf(afterId);
                        if (fullIndex === -1) {
                            return ApiProblem.validationFailed([
                                {
                                    field: 'cursor',
                                    message: 'cursor no longer valid, restart paging',
                                },
                            ]);
                        }
                        const rank = new Map(fullLineup.map((id, index) => [id, index]));
                        offset = lineup.filter(
                            (id) => (rank.get(id) ?? Infinity) < fullIndex,
                        ).length;
                    }
                }
                const known = new Set(lineup);
                const selected =
                    requested === undefined
                        ? lineup.slice(offset, offset + limit)
                        : lineup.filter((id) => requestedSet!.has(id));
                const schedules = await readStationAirings(selected, from, to);
                const now = Date.now();
                const hasMore = requested === undefined && offset + selected.length < lineup.length;
                return json({
                    window: {
                        from: from.toISOString(),
                        to: to.toISOString(),
                        asOf: new Date(now).toISOString(),
                    },
                    stations: selected.map((stationId) => {
                        const airings = schedules.get(stationId) ?? [];
                        return { stationId, airings, nowNext: pickNowNext(airings, now) };
                    }),
                    ...(requested === undefined
                        ? {}
                        : {
                              unknownStationIds: requested.filter((id) => !known.has(id)),
                          }),
                    page: {
                        limit: requested === undefined ? limit : Math.max(1, selected.length),
                        nextCursor: hasMore
                            ? encodeGuideCursor(selected[selected.length - 1])
                            : null,
                        hasMore,
                    },
                });
            } catch (err) {
                logger.error('Failed to read Live TV guide', err as Error);
                return ApiProblem.dependencyUnavailable('Live TV schedule unavailable');
            }
        },
    },
});
