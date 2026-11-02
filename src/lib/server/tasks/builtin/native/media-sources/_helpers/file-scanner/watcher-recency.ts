// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Recently-added recency refresh for the file watcher's single-file ingest.
 *
 * The browse "Recently Added" row orders by media_items.first_file_at, which
 * only refreshRecentlyAddedRecency writes. The hourly scan refreshes it only
 * when it adds/updates/removes something, and the watcher has usually ingested
 * the file by then, so without this a watcher-ingested title keeps a NULL
 * first_file_at (sorted last, so hidden) until the next scan that adds.
 */

import { refreshRecentlyAddedRecencyForItems } from '$lib/server/database/queries/browse.queries.js';
import { isMusic } from '$lib/server/utils/media-types.js';
import type postgres from 'postgres';

export interface WatcherIngestOutcome {
    status: 'ingested' | 'filtered' | 'skipped' | 'error';
    mediaItemId: string | null;
}

interface RecencyLogger {
    warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Coalescing window. A season pack or a deleted folder fires one watcher event
 * per file; refreshing per event meant N identical scoped UPDATEs on the same
 * title row, each queueing behind the series' chain lock. Item ids are collected
 * for this long (a fixed window from the first one, so a long burst is never
 * starved) and refreshed in one call.
 */
const COALESCE_WINDOW_MS = 2000;

let pendingIds = new Set<string>();
let pendingSql: postgres.Sql | null = null;
let pendingLogger: RecencyLogger | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Refresh the recency of the titles owning `itemIds` soon, batched with
 * whatever else is queued. Never throws. A refresh lost to a process exit is
 * healed by the next scan that adds, updates or removes something.
 */
export function queueRecencyRefresh(
    sql: postgres.Sql,
    itemIds: string[],
    logger: RecencyLogger,
): void {
    if (itemIds.length === 0) return;
    for (const id of itemIds) pendingIds.add(id);
    pendingSql = sql;
    pendingLogger = logger;
    if (timer === null) {
        timer = setTimeout(() => void flushRecencyRefreshes(), COALESCE_WINDOW_MS);
        // Never hold the process open for a best-effort refresh.
        timer.unref?.();
    }
}

/** Run the queued refresh now (the timer calls this; tests and shutdown may too). */
export async function flushRecencyRefreshes(): Promise<void> {
    if (timer !== null) {
        clearTimeout(timer);
        timer = null;
    }
    const ids = [...pendingIds];
    const sql = pendingSql;
    const logger = pendingLogger;
    pendingIds = new Set();
    if (ids.length === 0 || sql === null) return;

    try {
        await refreshRecentlyAddedRecencyForItems(sql, ids);
    } catch (err) {
        logger?.warn('File watcher: refreshRecentlyAddedRecency failed (non-fatal)', {
            itemCount: ids.length,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Queue the owning title's recency refresh after the watcher ingested
 * `filePath`. No-op for anything but a fresh ingest and for music libraries (the
 * refresh only covers movies/series). Never throws: the file is already ingested.
 */
export function refreshRecencyAfterWatcherIngest(
    sql: postgres.Sql,
    libraryMediaType: string | null | undefined,
    result: WatcherIngestOutcome,
    _filePath: string,
    logger: RecencyLogger,
): void {
    if (result.status !== 'ingested' || !result.mediaItemId) return;
    try {
        if (libraryMediaType && isMusic(libraryMediaType)) return;
    } catch (err) {
        logger.warn('File watcher: recency media-type check failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
        });
        return;
    }
    queueRecencyRefresh(sql, [result.mediaItemId], logger);
}
