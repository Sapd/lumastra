// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Kavita Plugin
 *
 * Book/Manga/Comic integration via Kavita server
 *
 * This plugin provides:
 * - Search across all Kavita content (series, collections, reading lists)
 * - Cover image proxying
 * - Unified MediaItem transformation for dashboard integration
 *
 * Configuration:
 *   FEATURE_KAVITA=true          # Enable the plugin
 *   KAVITAURL=https://...        # Kavita server URL
 *   KAVITAAPIKEY=xxx             # API key from Kavita user settings
 */

// Types
export * from './types.js';

// Client
export {
    search,
    getSeriesById,
    getSeriesMetadata,
    getSeriesMetadataBatch,
    getLibraries,
    getSeriesCoverUrl,
    getVolumeCoverUrl,
    getChapterCoverUrl,
    getCollectionCoverUrl,
    getReadingListCoverUrl,
    getPersonCoverUrl,
    testConnection,
    clearAuthCache,
} from './client.js';

// Transformer
export {
    transformSearchResults,
    transformSeriesResult,
    transformCollectionResult,
    transformReadingListResult,
    transformPersonResult,
    getSearchResultCount,
    formatLabel,
    inferMediaType,
} from './transformer.js';
