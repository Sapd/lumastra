// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Proxy Service Singleton
 *
 * Provides a singleton instance of the ImageProxyService for use across the application.
 */

import type postgres from 'postgres';
import { getDb } from '$lib/server/database';
import { ImageProxyService } from './service';

/**
 * One ImageProxyService instance per Postgres pool handle.
 *
 * Task-side callers (e.g. provider-artwork-materialization) must pass their
 * task-pool `ctx.sql` so DB traffic stays off the web pool. Each distinct
 * handle gets exactly one cached instance, so we never duplicate the
 * in-memory dedupe maps / LRU caches that a stray `new ImageProxyService(sql)`
 * would create.
 */
const instances = new WeakMap<postgres.Sql, ImageProxyService>();

/**
 * Get the shared ImageProxyService instance for the given pool.
 *
 * @param sql - Optional pool handle. Web routes omit it and get the web-pool
 *   singleton; task code passes `ctx.sql` to stay on the task pool.
 */
export function getImageProxyService(sql?: postgres.Sql): ImageProxyService {
    const handle = sql ?? getDb();
    if (!handle) {
        throw new Error('Database not available');
    }
    let instance = instances.get(handle);
    if (!instance) {
        instance = new ImageProxyService(handle);
        instances.set(handle, instance);
    }
    return instance;
}

// Re-export types for convenience
export type {
    ImageType,
    ImageSize,
    ImageFormat,
    MediaType,
    ImageOptions,
    ImageResponse,
    ImageRequest,
    ProviderImageRequest,
    ImageMetadata,
} from './types';

export {
    ImageProxyService,
    PersonRateLimitError,
    lookupLegacyJellyfinImageMediaId,
} from './service';
export { imageResponse, imageCacheControl } from './response';
export type { ImageCacheOptions } from './response';

export { LibraryImageQuery, libraryImageResponse } from './library-response';
