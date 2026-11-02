// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Availability Filter Utility
 *
 * Filters API responses to only include available items.
 * This is applied AFTER caching to avoid cache fragmentation.
 *
 * Design rationale:
 * - Cache stores full results (available + unavailable)
 * - Filter is applied at response time based on query param
 * - This preserves cache efficiency while supporting tvOS "available only" mode
 * - May return fewer items than requested limit (acceptable for tvOS use case)
 */

import type { PageSection } from '$lib/types/server-driven-ui';

/**
 * Filter a PageSection to only include available items
 */
export function filterSectionByAvailability(section: PageSection | null): PageSection | null {
    if (!section) return null;
    return {
        ...section,
        items: section.items.filter((item) => item.isAvailable),
    };
}

/**
 * Filter an array of UniversalMediaItem to only include available items
 */
export function filterItemsByAvailability<T extends { isAvailable?: boolean }>(items: T[]): T[] {
    return items.filter((item) => item.isAvailable === true);
}

/**
 * Parse the availability filter from URL search params
 * Supports: ?available=true, ?availableOnly=true, ?available=1
 */
export function parseAvailabilityFilter(url: URL): boolean {
    const available = url.searchParams.get('available');
    const availableOnly = url.searchParams.get('availableOnly');

    return (
        available === 'true' ||
        available === '1' ||
        availableOnly === 'true' ||
        availableOnly === '1'
    );
}

/**
 * Higher-order function to wrap an endpoint handler with availability filtering
 * Usage:
 *   return withAvailabilityFilter(url, section);
 */
export function withAvailabilityFilter(url: URL, section: PageSection | null): PageSection | null {
    if (!section) return null;
    const availableOnly = parseAvailabilityFilter(url);
    return availableOnly ? filterSectionByAvailability(section) : section;
}
