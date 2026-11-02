// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mapFeedStations } from '$lib/server/services/livetv/station.service.js';
import type { PageServerLoad } from './$types';
import type { LiveTvStation } from '$lib/schemas/livetv.js';
import { getDb } from '$lib/server/database/index.js';
import {
    getFavoriteChannelIds,
    getPersonalizedChannelIds,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { cacheManager } from '$lib/server/cache/index.js';
import { CACHE_NAMESPACES } from '$lib/server/cache/namespaces.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getSimpleMode } from '$lib/server/services/livetv/simple-mode.service.js';
import type { LiveTvSimpleMode } from '$lib/schemas/livetv-simple-mode.js';

const logger = Logger.for('LiveTvPage');

/** Stable key within the per-user liveTvPersonalizedChannels namespace. */
const PERSONALIZED_CHANNELS_CACHE_KEY = 'v1:personalized-channel-ids';

/** Favorites are unbounded; the row caps at favorites + history, max 8 items. */
const FOR_YOU_MAX_ITEMS = 8;

export const load: PageServerLoad = async (event) => {
    const [base, simpleMode] = await Promise.all([loadForYou(event), loadSimpleMode(event.locals)]);
    return { ...base, simpleMode };
};

/** The viewer's simple mode (senior-friendly screen); undefined when off or unreadable. */
async function loadSimpleMode(locals: App.Locals): Promise<LiveTvSimpleMode | undefined> {
    const sql = getDb();
    if (!sql || !locals.user?.hasLiveTvPermission) return undefined;
    try {
        const mode = await getSimpleMode(sql, locals.user.userId);
        return mode.enabled ? mode : undefined;
    } catch (err) {
        logger.error('Failed to load Live TV simple mode', err as Error);
        return undefined;
    }
}

async function loadForYou({ locals, parent }: Parameters<PageServerLoad>[0]): Promise<{
    personalizedChannels: LiveTvStation[];
    favoriteChannelIds: string[];
}> {
    const sql = getDb();
    if (!sql || !locals.user)
        return { personalizedChannels: [] as LiveTvStation[], favoriteChannelIds: [] as string[] };

    const userId = locals.user.userId;
    const personalizedCache = cacheManager.for(CACHE_NAMESPACES.liveTvPersonalizedChannels);

    try {
        const [favoriteIds, historyIds, parentData] = await Promise.all([
            // Favorites are read fresh (single PK-indexed lookup) so a toggle
            // reflects on the next navigation — only the history aggregates
            // below are cache-aside.
            getFavoriteChannelIds(sql, userId),
            // Cache-aside per user: the two watch-history aggregates in
            // getPersonalizedChannelIds otherwise run on every landing render.
            // Keyed by userId (short TTL); a cached empty list is honored too
            // (a user with no history), avoiding a re-run every hit.
            (async (): Promise<string[]> => {
                const cached = await personalizedCache.get<string[]>(
                    PERSONALIZED_CHANNELS_CACHE_KEY,
                    userId,
                );
                if (cached) return cached;
                const ids = await getPersonalizedChannelIds(sql, userId);
                await personalizedCache.set(
                    PERSONALIZED_CHANNELS_CACHE_KEY,
                    ids,
                    undefined,
                    userId,
                );
                return ids;
            })(),
            parent(),
        ]);

        const stations = await mapFeedStations([...favoriteIds, ...historyIds]);
        const favoriteStationIds = [
            ...new Set(favoriteIds.flatMap((id) => stations.get(id) ?? [])),
        ];
        const historyStationIds = historyIds.flatMap((id) => stations.get(id) ?? []);
        // Favorites pinned first (stable order), recently-watched fill the rest.
        const seen = new Set<string>();
        const stationIds: string[] = [];
        for (const id of [...favoriteStationIds, ...historyStationIds]) {
            if (!seen.has(id)) {
                seen.add(id);
                stationIds.push(id);
            }
            if (stationIds.length >= FOR_YOU_MAX_ITEMS) break;
        }

        if (stationIds.length === 0)
            return {
                personalizedChannels: [] as LiveTvStation[],
                favoriteChannelIds: [] as string[],
            };

        const channelMap = new Map(parentData.channels.map((ch) => [ch.id, ch]));
        const personalizedChannels = stationIds
            .map((id) => channelMap.get(id))
            .filter((ch): ch is LiveTvStation => ch !== undefined && ch.isVisible);

        return { personalizedChannels, favoriteChannelIds: favoriteStationIds };
    } catch (err) {
        logger.error('Failed to load personalized channels', err as Error);
        return { personalizedChannels: [] as LiveTvStation[], favoriteChannelIds: [] as string[] };
    }
}
