// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Favorites → Watchlist Import
 *
 * One-time, user-triggered copy of the caller's Jellyfin Favorites (Movies +
 * Series only) into their Lumastra watchlist. Idempotent — safe to re-run;
 * relies on watchlistManager.addItem()'s upsert for dedup.
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { AsyncSemaphore } from '$lib/server/utils/async-semaphore.js';
import { toInternalMediaType } from '$lib/shared/media-type-domain.js';
import type { UserContext } from '$lib/server/types.js';
import { resolveJellyfinUserIdByUserId } from './jellyfin-user-id-resolver.js';
import { jellyfinMediaService } from '$lib/server/jellyfin/media.service.js';
import { watchlistManager } from './watchlist-manager.service.js';

const logger = Logger.for('JellyfinWatchlistImport');

const IMPORT_CONCURRENCY = 5;

export type JellyfinWatchlistImportResult =
    | { ok: true; imported: number; skipped: number; total: number }
    | { ok: false; reason: 'unavailable' };

export async function importJellyfinFavoritesToWatchlist(
    sql: postgres.Sql,
    user: UserContext,
): Promise<JellyfinWatchlistImportResult> {
    const jellyfinUserId = await resolveJellyfinUserIdByUserId(user.userId);
    if (!jellyfinUserId) {
        return { ok: false, reason: 'unavailable' };
    }

    let items;
    try {
        items = await jellyfinMediaService.getFavoriteItems(jellyfinUserId, ['Movie', 'Series']);
    } catch (error) {
        logger.warn('Failed to fetch Jellyfin favorites for import', {
            userId: user.userId,
            error: String(error),
        });
        return { ok: false, reason: 'unavailable' };
    }

    const semaphore = new AsyncSemaphore(IMPORT_CONCURRENCY);
    let imported = 0;
    let skipped = 0;

    await Promise.all(
        items.map((item) =>
            semaphore.withPermit(async () => {
                const mediaType = toInternalMediaType(item.Type);
                if (mediaType !== 'movie' && mediaType !== 'tv') {
                    skipped++;
                    return;
                }

                const tmdbId = item.ProviderIds?.Tmdb ?? item.ProviderIds?.tmdb;
                if (!tmdbId) {
                    skipped++;
                    return;
                }

                try {
                    const result = await watchlistManager.addItem({
                        sql,
                        userId: user.userId,
                        externalIds: { tmdb: tmdbId },
                        mediaType,
                        title: item.Name,
                        user,
                        skipActivityFeed: true,
                    });
                    if (result.saved) {
                        imported++;
                    } else {
                        skipped++;
                    }
                } catch (error) {
                    logger.debug('Skipped a Jellyfin favorite during import', {
                        userId: user.userId,
                        title: item.Name,
                        error: String(error),
                    });
                    skipped++;
                }
            }),
        ),
    );

    return { ok: true, imported, skipped, total: items.length };
}
