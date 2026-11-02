// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holiday Plugin
 *
 * A configurable plugin for displaying seasonal themed recommendations.
 *
 * Features:
 * - Runtime-configurable holidays via JSON file
 * - Multiple content sources: TMDB, MDBList, Custom
 * - Hot-reload support for configuration changes
 * - AI personalization (optional)
 * - Jellyfin availability integration
 *
 * Configuration:
 * - Set HOLIDAY_CONFIG_PATH environment variable to use a custom config file
 * - Default config locations: config/holidays.json, static/config/holidays.json
 * - Or use built-in defaults
 *
 * Usage:
 * ```typescript
 * import { holidayPlugin } from '$lib/server/plugins/holidays';
 *
 * // Initialize (call once at startup)
 * holidayPlugin.init();
 *
 * // Get current holiday
 * const holiday = holidayPlugin.getCurrentHoliday();
 *
 * // Get recommendations
 * const result = await holidayPlugin.getRecommendations(username, { limit: 20, access });
 * ```
 */

// Export main plugin functionality
export {
    initHolidayPlugin,
    getCurrentHoliday,
    getAllHolidays,
    getHolidayRecommendations,
    getHolidayConfig,
    getHolidays,
    getHolidayById,
    getHolidaySettings,
    reloadHolidayConfig,
} from './plugin';

// Export types
export type {
    HolidayConfig,
    HolidayRecommendation,
    HolidayApiResponse,
    HolidayPluginSettings,
    HolidayPluginConfig,
    ContentSource,
    ContentSourceType,
    TmdbContentSource,
    MdblistContentSource,
    CustomContentSource,
    DiscoveredItem,
    PreHolidayConfig,
    HolidayValidation,
} from './types';

// Export source adapters
export { getSourceAdapter, isSourceAvailable, getAllSourceAdapters } from './sources';

// Convenience namespace for cleaner imports
import {
    initHolidayPlugin,
    getCurrentHoliday,
    getAllHolidays,
    getHolidayRecommendations,
    reloadHolidayConfig,
    getHolidaySettings,
} from './plugin';

export const holidayPlugin = {
    init: initHolidayPlugin,
    getCurrentHoliday,
    getAllHolidays,
    getRecommendations: getHolidayRecommendations,
    reload: reloadHolidayConfig,
    getSettings: getHolidaySettings,
};
