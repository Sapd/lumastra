// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Server-Driven UI Type Definitions
 *
 * This file re-exports types from Zod schemas and provides helper functions
 * for the unified, component-driven UI architecture.
 *
 * IMPORTANT: All API response types are defined in src/lib/schemas/api-responses.ts
 * This file re-exports them for backward compatibility with existing imports.
 */

import { getExternalIdFor, getPreferredExternalId } from '$lib/utils/external-ids';

// ============================================================================
// Re-export types from Zod schemas (SINGLE SOURCE OF TRUTH)
// ============================================================================

export type {
    // Badge types
    BadgeColor,
    Badge,

    // Title parts (for non-HTML clients like tvOS)
    TitleHighlightColor,
    TitlePart,

    // Universal Media Item
    UniversalMediaType as MediaType,
    AspectRatio,
    MatchSource,
    UniversalMediaItem,

    // Section types
    SectionType,
    FeaturedPickCriteria,
    SectionFilter,
    SectionFilterGroup,
    SectionMeta,
    PageSection,

    // Card variant
    CardVariant,
} from '$lib/schemas/api-responses';

// Re-import types for use in this file's functions
import type {
    BadgeColor,
    Badge,
    UniversalMediaType,
    UniversalMediaItem,
} from '$lib/schemas/api-responses';

// ============================================================================
// Page Response (not in Zod schemas yet - page-level type)
// ============================================================================

import type { PageSection as PageSectionType } from '$lib/schemas/api-responses';

export interface ServerDrivenPage {
    /** Page identifier */
    pageId: string;
    /** Page title for document head */
    title?: string;
    /** Ordered list of sections to render */
    sections: PageSectionType[];
    /** Page-level metadata */
    meta?: {
        /** Last updated timestamp */
        updatedAt?: string;
        /** Cache TTL in seconds */
        cacheTtl?: number;
        /** User context */
        user?: string;
    };
}

// ============================================================================
// Helper Types for Component Props
// ============================================================================

export interface CardEvents {
    click: UniversalMediaItem;
    play: UniversalMediaItem;
    request: UniversalMediaItem;
    more: UniversalMediaItem;
    remove: UniversalMediaItem;
}

// ============================================================================
// Transformer Helpers
// ============================================================================

/**
 * Creates a unique ID for a media item.
 * Prefers UUID if available, falls back to composite key format.
 */
export function createMediaId(
    idOrExternalId: string | number,
    mediaType?: UniversalMediaType,
): string {
    // If it looks like a UUID, return as-is
    if (
        typeof idOrExternalId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrExternalId)
    ) {
        return idOrExternalId;
    }

    // Otherwise create composite key
    const type = mediaType || 'movie';
    return `${type}-${idOrExternalId}`;
}

/**
 * Gets the best available external ID for a media item.
 * Returns the preferred provider's ID if specified and available,
 * otherwise falls back to the default priority chain.
 *
 * Uses the centralized external-ids helpers for provider-agnostic lookup.
 *
 * @see getExternalIdFor from '$lib/utils/external-ids' for direct provider access
 * @see getPreferredExternalId from '$lib/utils/external-ids' for full priority chain
 */
export function getExternalIdFromItem(
    item: Pick<UniversalMediaItem, 'externalIds'>,
    preferredProvider?: 'tmdb' | 'imdb' | 'tvdb' | 'trakt',
): string | undefined {
    if (!item.externalIds) {
        return undefined;
    }

    // Check preferred provider first using centralized helper
    if (preferredProvider) {
        const id = getExternalIdFor(item.externalIds, preferredProvider);
        if (id) return id;
    }

    // Use centralized helper for default priority chain (excludes UUIDs)
    const preferred = getPreferredExternalId(item.externalIds, {
        includeUuids: false,
    });
    return preferred?.id;
}

/**
 * Creates a badge object with proper typing
 */
export function createBadge(text: string, color: BadgeColor, icon?: string, title?: string): Badge {
    return { text, color, icon, title };
}

/**
 * Maps badge color to Skeleton UI variant class
 */
export function getBadgeVariant(color: BadgeColor): string {
    const variants: Record<BadgeColor, string> = {
        primary: 'variant-filled-primary',
        secondary: 'variant-filled-secondary',
        success: 'variant-filled-success',
        warning: 'variant-filled-warning',
        error: 'variant-filled-error',
        surface: 'variant-filled-surface',
        tertiary: 'variant-filled-tertiary',
    };
    return variants[color] || 'variant-filled-surface';
}
