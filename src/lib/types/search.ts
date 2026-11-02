// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search Types
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/api-search-responses'.
 * These types are used on the client-side to provide type safety for search operations.
 *
 * Schema definitions include:
 * - SearchMediaType: Valid media types for search results
 * - SearchResultItem: Raw search result before transformation
 * - GroupedSearchResults: Results grouped by media type
 * - SeriesSearchItem: Series data for episode picker
 * - AvailableCategories: Available search categories by service
 * - CategoryConfig: Category filter chip configuration
 */

export type {
    SearchMediaType,
    SearchResultItem,
    GroupedSearchResults,
    SeriesSearchItem,
    AvailableCategories,
    CategoryConfig,
} from '$lib/schemas/api-search-responses';

// SearchCategory is defined in constants/ (not schemas/) because it contains
// component references (svelte-hero-icons) that cannot be placed in a Zod schema.
export type { SearchCategory } from '$lib/constants/search-categories';
