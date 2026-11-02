// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/channels/[id]/feeds.ts — GET /livetv/stations/{stationId}/feeds
 *
 * The feeds of the station a channel belongs to (its backup group), for the
 * viewer feed picker: a station's shown feed can be broken at the provider
 * (it plays a placeholder clip), and the viewer picks another one.
 *
 * Offered: every feed of the group outside a hidden category and still in the
 * playlist — feeds the admin HID included, since hidden is a lineup choice,
 * not a verdict that the feed is broken. A picked feed plays through the normal
 * stream endpoints, whose gate (canStreamLiveTvChannel) admits exactly these.
 *
 * Auth: feature:FEATURE_LIVETV → user (+ inline hasLiveTvPermission check).
 * 403 while LIVETV_VIEWER_FEED_CHOICE is off; 404 for a channel the caller may
 * not stream (same answer as an unknown id).
 */

import { resolveStation } from '$lib/server/services/livetv/station.service.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getStationFeeds } from '$lib/server/database/queries/livetv-channels.queries.js';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access.js';
import { isDegradedFeed } from '$lib/server/services/livetv/auto-processor.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { LiveTvStationFeedsSchema, type LiveTvFeed } from '$lib/schemas/livetv.js';

const FeedsParamsSchema = z.object({
    stationId: z.string().guid(),
});

const QUALITY_TIERS = new Set(['uhd', 'fhd', 'hd', 'sd']);

function toQualityTier(tier: string | null): LiveTvFeed['qualityTier'] {
    return tier && QUALITY_TIERS.has(tier) ? (tier as LiveTvFeed['qualityTier']) : undefined;
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            stability: 'beta',
            summary: "List a Live TV station's feeds",
            auth: 'bearer',
            description:
                'Returns the feeds of the station (backup group) the channel belongs to, so a ' +
                'viewer can watch another feed when the shown one does not play. Play a feed ' +
                'by its `id` like any channel. Feeds in hidden categories are left out; feeds the ' +
                'administrator hid are included (`isVisible: false`). A channel without a backup ' +
                'group returns just itself. Requires `hasLiveTvPermission` and the ' +
                'administrator\'s "Let viewers choose a channel\'s feed" setting.',
            responses: {
                200: { schema: LiveTvStationFeedsSchema, description: 'Feeds of the station' },
                401: 'Authentication required',
                403: 'Live TV access not permitted, or feed choice is turned off',
                404: 'Channel not found',
                422: 'Invalid channel ID',
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
        params: FeedsParamsSchema,
    },
    handlers: {
        GET: async (event) => {
            const { locals, params } = event;

            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }
            // Backup groups exist only in the standalone provider's own lineup.
            if (!config.LIVETV_VIEWER_FEED_CHOICE || config.LIVETV_SOURCE !== 'standalone') {
                return ApiProblem.forbidden('Feed choice is turned off');
            }

            const stationId = params.stationId;
            const channelId = stationId;
            if (!channelId || !isUuid(channelId)) {
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
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            if (!(await canStreamLiveTvChannel(locals, station.shownFeedId))) {
                return ApiProblem.notFound(`Channel ${channelId} not found`);
            }

            const rows = await getStationFeeds(sql, station.shownFeedId);
            if (rows.length === 0) return ApiProblem.notFound(`Channel ${channelId} not found`);

            const backupGroupId = rows[0].backup_group_id ?? undefined;
            const feeds: LiveTvFeed[] = rows.map((row) => ({
                id: row.id,
                name: row.name,
                qualityTier: toQualityTier(row.quality_tier),
                isDegraded: isDegradedFeed(row.raw_name),
                isPrimary: row.is_primary,
                isVisible: row.is_visible,
                // A lone channel is its own default.
                isDefault: backupGroupId === undefined ? true : row.is_shown,
            }));
            // The default feed first; the rest keep the viewer query's rank.
            feeds.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

            return json({ stationId: station.stationId, feeds });
        },
    },
});
