// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getLiveTvAvailability } from '$lib/server/services/livetv/availability.service.js';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { pickNowNext } from '$lib/shared/livetv-now-next.js';
import { stationDto, stationIdOfFeed, readStationSchedules } from '$lib/server/services/livetv/station.service.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import type { LiveTvStation, LiveTvCategory } from '$lib/schemas/livetv.js';
import { config, features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { appPath } from '$lib/shared/api-urls.js';

const logger = Logger.for('LiveTvLayout');

export const load: LayoutServerLoad = async ({ locals, depends }) => {
    depends('livetv:channels');
    if (!features.liveTV) {
        return {
            liveTvDisabled: true as const,
            liveTvFeedChoice: false,
            channels: [] as LiveTvStation[],
            categories: [] as LiveTvCategory[],
        };
    }

    if (!locals.user?.hasLiveTvPermission) {
        throw redirect(302, appPath('/'));
    }

    try {
        const provider = await getLiveTvProvider();
        const [channels, categories] = await Promise.all([
            provider.getChannels(),
            provider.getCategories().catch(() => [] as LiveTvCategory[]),
        ]);

        const schedules = await readStationSchedules(channels.map(stationIdOfFeed)).catch((err: unknown) => {
            logger.warn('Station guide read failed', { error: (err as Error).message });
            return new Map();
        });
        const now = Date.now();
        return {
            liveTvDisabled: false as const,
            availability: await getLiveTvAvailability(channels),
            loadError: false,
            // Right-click / long-press feed menu on multi-feed stations.
            liveTvFeedChoice:
                config.LIVETV_VIEWER_FEED_CHOICE && config.LIVETV_SOURCE === 'standalone',
            channels: channels.filter((ch) => ch.isVisible).map((ch) => stationDto(ch,
                pickNowNext(schedules.get(stationIdOfFeed(ch)) ?? [], now))),
            categories: categories.filter((cat) => cat.isVisible),
        };
    } catch (err) {
        logger.error('Failed to load Live TV layout data', err as Error);
        return {
            liveTvDisabled: false as const,
            loadError: true,
            liveTvFeedChoice: false,
            channels: [] as LiveTvStation[],
            categories: [] as LiveTvCategory[],
        };
    }
};
