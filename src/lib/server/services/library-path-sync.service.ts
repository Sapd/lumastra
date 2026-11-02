// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Coordinates side-effects of library path changes.
 * Routes import this service instead of reaching into plugin internals.
 */
import type { Sql } from 'postgres';
import { Logger } from '$lib/server/utils/logger';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { broadcastPermissionsInvalidation } from '$lib/server/cache/library-group-permissions-cache.js';

const logger = Logger.for('LibraryPathSync');

/**
 * Notify the file-scanner watcher that library paths have changed.
 * Dynamically imports the file-scanner to avoid circular dependencies.
 * Errors are logged but never thrown — callers should not block on watcher sync.
 */
export async function syncWatcherPaths(sql: Sql): Promise<void> {
    try {
        const { updateWatcherPaths } =
            await import('../tasks/builtin/native/media-sources/file-scanner.js');
        await updateWatcherPaths(sql);
    } catch (err) {
        logger.warn('Failed to sync watcher paths after library path change', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Centralized lifecycle hook for library group mutations (create/update/delete).
 * Clears browse caches so group changes are reflected immediately.
 */
export async function afterLibraryGroupChanged(): Promise<void> {
    // Audiobook age ratings include the group's floor. Drop both local and
    // sibling-replica item verdicts when an administrator changes that floor.
    const { invalidateMediaAgeCache } = await import('$lib/server/middleware/media-access.js');
    invalidateMediaAgeCache('*');
    // A deleted group drops its permission row (ON DELETE CASCADE); the cached
    // restriction map and per-item verdicts must not outlive it.
    broadcastPermissionsInvalidation();
    await Promise.all([
        cacheManager.for(CACHE_NAMESPACES.browseLibraries).clear(),
        cacheManager.for(CACHE_NAMESPACES.browseAZ).clear(),
        cacheManager.for(CACHE_NAMESPACES.searchResultsPage).clear(),
    ]);
}

/**
 * Centralized lifecycle hook for all library path mutations (create/update/delete).
 * Clears path mapping cache, syncs watcher, and clears browse caches.
 */
export async function afterLibraryPathChanged(sql: Sql): Promise<void> {
    const { invalidateMediaAgeCache } = await import('$lib/server/middleware/media-access.js');
    invalidateMediaAgeCache('*');
    // Clear path-mapping + library-root caches (synchronous — must be fresh immediately).
    // The libraryRoots cache gates file-read boundary checks (defense-in-depth); a stale
    // copy blocks artwork/media serving for a newly-added library — this is exactly why a
    // freshly-added music library's covers under /data/music returned the fallback image
    // until the cache was cleared.
    await Promise.all([
        cacheManager.for(CACHE_NAMESPACES.libraryPathMappings).delete('all'),
        cacheManager.for(CACHE_NAMESPACES.libraryRoots).delete('all'),
    ]);

    // A folder moved between libraries re-stamps its files' library group;
    // the per-item access verdicts cached (up to an hour) are keyed on the
    // user's denied groups only, so they must be dropped on every replica.
    broadcastPermissionsInvalidation();

    // Clear browse caches so library changes are reflected in browse views
    await Promise.all([
        cacheManager.for(CACHE_NAMESPACES.browseRecentlyAdded).clear(),
        cacheManager.for(CACHE_NAMESPACES.browseLibraries).clear(),
        cacheManager.for(CACHE_NAMESPACES.searchResultsPage).clear(),
    ]);

    // Sync file-scanner watcher (fire-and-forget)
    void syncWatcherPaths(sql);
}
