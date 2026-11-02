// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/channels/index.ts — GET /livetv/channels
 *
 * GET /livetv/channels
 *   Returns the channel list with now/next EPG and logo URLs pointed at the
 *   surface's entity-image route (see ./logo-url.ts).
 *   Response: { items, page } — standard collection envelope.
 *
 * Auth: feature:FEATURE_LIVETV → all:[ user, liveTv permission ]
 *   The permission check (LIVETV_GROUPS membership) is validated inline because
 *   it is not a bearer-scope concept — it is a user-group gate identical to the
 *   existing `locals.user.hasLiveTvPermission` field.
 */

import {
    stationDto,
    stationIdOfFeed,
    readStationSchedules,
} from '$lib/server/services/livetv/station.service.js';
import { getLiveTvAvailability } from '$lib/server/services/livetv/availability.service.js';
import { pickNowNext } from '$lib/shared/livetv-now-next.js';
import { Logger } from '$lib/server/utils/logger.js';
import { json } from '@sveltejs/kit';
import type { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { hideOfflineStations } from '$lib/server/services/livetv/channel-health.service.js';
import type { LiveTvCategory, LiveTvStationSchema } from '$lib/schemas/livetv.js';
import { LiveTvStationsResponseSchema } from '$lib/schemas/api-playback-responses';
import { assignGlobalChannelNumbers } from '$lib/server/services/livetv/channel-numbering.js';
import { channelImageSet } from '../channels/logo-url.js';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type ChannelsPage = {
    items: z.infer<typeof LiveTvStationSchema>[];
    page: {
        limit: number;
        offset: number;
        hasMore: boolean;
    };
};

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

const logger = Logger.for('LiveTvStations');

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'List live TV stations',
            responses: {
                503: 'Live TV dependency unavailable',
                200: {
                    schema: LiveTvStationsResponseSchema,
                    description: 'Channel list',
                },
                401: 'Authentication required',
                404: 'Live TV not available',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'FEATURE_LIVETV',
        then: { kind: 'user' },
    },
    handlers: {
        /**
         * GET /livetv/channels
         *
         * Returns all visible channels with their current EPG programme.
         * Logo URLs are rebuilt onto the surface's entity-image route so internal
         * and v1 clients both receive a path that actually serves (see ./logo-url.ts).
         */
        GET: async (event, ctx) => {
            const { locals } = event;

            // User-group permission gate (LIVETV_GROUPS membership).
            // `hasLiveTvPermission` is computed by buildUserPermissions in forward-auth.ts
            // from config.LIVETV_GROUPS. It is not a bearer scope — it is a user trait.
            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }

            const provider = await getLiveTvProvider();

            let channelsRaw;
            try {
                channelsRaw = await hideOfflineStations(await provider.getChannels(), locals);
            } catch {
                return ApiProblem.dependencyUnavailable('Live TV provider unavailable');
            }

            // Category order enriches the channel list (per-channel category
            // order, fallback lineup number) but is NOT a hard dependency: if the
            // category read hiccups, still return channels rather than 503-ing.
            let categories: LiveTvCategory[] = [];
            try {
                categories = await provider.getCategories();
            } catch {
                // Keep the empty default: numbering degrades to a flat sort.
            }

            const categorySortOrderById = new Map(categories.map((c) => [c.id, c.sortOrder]));
            // The standalone provider sets the stored, stable channel number
            // (channel-numbers.service.ts). A provider without stored numbers
            // falls back to the lineup position.
            const hasStoredNumbers = channelsRaw.some((ch) => ch.channelNumber !== undefined);
            const channelNumberById = hasStoredNumbers
                ? undefined
                : assignGlobalChannelNumbers(channelsRaw, categories);

            // Rewrite logo URLs to the surface-appropriate entity-image path and
            // annotate each channel with its global lineup number + category order.
            const channels = channelsRaw.map((ch) => ({
                ...ch,
                images: channelImageSet(ctx.surface, ch.id, ch.images),
                channelNumber: channelNumberById ? channelNumberById.get(ch.id) : ch.channelNumber,
                categorySortOrder: ch.categoryId
                    ? categorySortOrderById.get(ch.categoryId)
                    : undefined,
            }));

            let schedules: Awaited<ReturnType<typeof readStationSchedules>> = new Map();
            try {
                schedules = await readStationSchedules(channels.map(stationIdOfFeed));
            } catch (err) {
                logger.warn('Station guide read failed', { error: (err as Error).message });
            }
            const now = Date.now();
            return json({
                ...paginate(
                    channels.map((channel) =>
                        stationDto(
                            channel,
                            pickNowNext(schedules.get(stationIdOfFeed(channel)) ?? [], now),
                        ),
                    ),
                    {
                        limit: channels.length,
                        offset: 0,
                        hasMore: false,
                    },
                ),
                availability: await getLiveTvAvailability(channels),
            });
        },
    },
});
