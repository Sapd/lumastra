// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browse Components & Utilities
 *
 * Re-exports for browse-related utilities and components.
 */

// Search utilities
export {
    performSearch,
    createDebouncedSearch,
    filterChannels,
    normalizeQuery,
    isValidSearchQuery,
    getSearchTypesParam,
    transformSearchItem,
    type BrowseMediaType,
    type BrowseSearchApiItem,
    type BrowseItem as SearchBrowseItem,
    type SearchResult,
} from './browse-search';

// Modal utilities
export {
    fetchMediaDetailsWithKey,
    openSimilarForItem,
    openDetailForGridItem,
    playGridItem,
    handleCardClick,
    handleKeywordItemClick,
    buildJellyfinMediaData,
    buildKeywordMediaData,
    getItemImageUrl,
    getKeywordItemImageUrl,
    type BrowseItem,
    type KeywordBrowseItem,
    type MediaDetailsPayload,
} from './browse-modals';

// Browse section components
export { default as RecentlyAddedFilters } from './RecentlyAddedFilters.svelte';
export { default as RecentlyAddedSection } from './RecentlyAddedSection.svelte';

// Channel view utilities
export {
    saveChannelViewPreference,
    loadChannelViewPreference,
    calculateProgramProgress,
    isProgramLive,
    formatRemainingTime,
    createProgramTickController,
    createProgramRefreshController,
    CHANNEL_VIEW_STORAGE_KEY,
    PROGRAM_TICK_MS,
    PROGRAM_REFRESH_MS,
    type ChannelView,
    type ChannelProgram,
} from './channel-view';
