// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Content Source Adapters Index
 *
 * Exports all content source adapters and a factory function
 * for creating adapters by type.
 */

import type { ContentSourceAdapter, ContentSourceType } from '../types';
import { tmdbSource } from './tmdb.source';
import { mdblistSource } from './mdblist.source';
import { customSource } from './custom.source';

// Export individual adapters
export { tmdbSource, TmdbContentSourceAdapter } from './tmdb.source';
export { mdblistSource, MdblistContentSourceAdapter } from './mdblist.source';
export { customSource, CustomContentSourceAdapter } from './custom.source';

// Registry of all source adapters
const sourceAdapters = new Map<ContentSourceType, ContentSourceAdapter>();
sourceAdapters.set('tmdb', tmdbSource);
sourceAdapters.set('mdblist', mdblistSource);
sourceAdapters.set('custom', customSource);

/**
 * Get a content source adapter by type
 */
export function getSourceAdapter(type: ContentSourceType): ContentSourceAdapter | null {
    return sourceAdapters.get(type) || null;
}

/**
 * Get all available source adapters
 */
export function getAllSourceAdapters(): ContentSourceAdapter[] {
    return Array.from(sourceAdapters.values());
}

/**
 * Check if a source type is available
 */
export function isSourceAvailable(type: ContentSourceType): boolean {
    const adapter = sourceAdapters.get(type);
    return adapter?.isAvailable() ?? false;
}
