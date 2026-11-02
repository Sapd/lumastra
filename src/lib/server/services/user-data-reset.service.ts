// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getDb } from '$lib/server/database/connection.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { cacheManager, CACHE_NAMESPACES, type RegisteredCacheConfig } from '$lib/server/cache';
import type { RESET_ACTIONS } from '$lib/schemas/api-user-data-reset.js';
import { clearAllMusicState } from '$lib/server/database/queries/music-tracking.queries.js';
import { clearAllTrackRatings } from '$lib/server/database/queries/music-interactions.queries.js';
import {
    clearAllWatchHistory,
    clearAllTasteDampers,
} from '$lib/server/database/queries/user-data-reset.queries.js';
import { watchManager } from '$lib/server/services/watch-manager.service.js';
import { watchStateEvents } from '$lib/server/services/watch-state-events.service.js';
import { invalidateContinueWatchingCache } from '$lib/server/services/watched-cache.service.js';

const logger = Logger.for('UserDataReset');

type ResetAction = (typeof RESET_ACTIONS)[number];

// Namespaces where deleteUserCache(userId) is effective (L2 key is
// `namespace:userId:*`). The short-TTL rec namespaces whose key shape does NOT
// carry userId in that prefix (musicSonicFingerprint, similarContent,
// watchingSources) self-heal on their own TTL after the underlying data change,
// so we deliberately do not attempt fragile pattern deletes for them.
const MUSIC_REC_NS: RegisteredCacheConfig[] = [
    CACHE_NAMESPACES.musicTasteClusters,
    CACHE_NAMESPACES.musicSonicTasteClusters,
    CACHE_NAMESPACES.musicTasteStationSnapshots,
    CACHE_NAMESPACES.musicGenrePlan,
    CACHE_NAMESPACES.musicNewDiscovery,
    CACHE_NAMESPACES.musicSonicDiscovery,
];
const VOD_REC_NS: RegisteredCacheConfig[] = [
    CACHE_NAMESPACES.moodRecommendations,
    CACHE_NAMESPACES.vectorMoodRecommendations,
    CACHE_NAMESPACES.forYouKeywords,
    CACHE_NAMESPACES.continueWatchingRows,
];
const VOD_STEER_NS: RegisteredCacheConfig[] = [
    CACHE_NAMESPACES.tasteDampers,
    CACHE_NAMESPACES.dismissState,
];

class UserDataResetManager {
    private sqlOrThrow(): postgres.Sql {
        const sql = getDb();
        if (!sql) throw new Error('Database not initialised');
        return sql;
    }

    private async flush(userId: UserId, namespaces: RegisteredCacheConfig[]): Promise<void> {
        for (const ns of namespaces) {
            try {
                await cacheManager.for(ns).deleteUserCache(userId);
            } catch (error) {
                logger.warn('data-reset cache flush failed', { userId, ns: ns.name, error });
            }
        }
    }

    async run(userId: UserId, action: ResetAction): Promise<Record<string, number>> {
        switch (action) {
            case 'music-history': {
                const counts = await clearAllMusicState(this.sqlOrThrow(), userId);
                await this.flush(userId, MUSIC_REC_NS);
                return counts;
            }
            case 'music-feedback': {
                const trackRatings = await clearAllTrackRatings(this.sqlOrThrow(), userId);
                await this.flush(userId, MUSIC_REC_NS);
                return { trackRatings };
            }
            case 'music-recs': {
                await this.flush(userId, MUSIC_REC_NS);
                return {};
            }
            case 'vod-resume': {
                await watchManager.clearWatchProgress({ userId });
                return {};
            }
            case 'vod-history': {
                const sql = this.sqlOrThrow();
                const counts = await withTx(sql, (tx) => clearAllWatchHistory(tx, userId));
                await invalidateContinueWatchingCache(userId).catch((e) =>
                    logger.warn('data-reset CW invalidation failed', e as Error),
                );
                watchStateEvents.emit(userId, {
                    type: 'watch_state_set_changed',
                    mediaId: '*',
                    reason: 'clear_progress',
                });
                await this.flush(userId, VOD_REC_NS);
                return counts;
            }
            case 'vod-recs': {
                const dampers = await clearAllTasteDampers(this.sqlOrThrow(), userId);
                await this.flush(userId, [...VOD_STEER_NS, ...VOD_REC_NS]);
                return { dampers };
            }
        }
    }
}

export const userDataResetManager = new UserDataResetManager();
