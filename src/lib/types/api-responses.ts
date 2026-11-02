// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API Response Type Re-exports
 *
 * This file re-exports types inferred from Zod schemas for convenient imports.
 * The Zod schemas in src/lib/schemas/api-responses.ts are the SINGLE SOURCE OF TRUTH.
 *
 * Usage:
 *   import type { UniversalMediaItem, PageSection } from '$lib/types/api-responses';
 *
 * DO NOT define interfaces/types here manually - import from the Zod schemas.
 * To add new fields, update the Zod schema first.
 */

// Re-export all types from Zod schemas
export type {
    // External IDs
    ExternalIdsResponse,

    // Badge types
    BadgeColor,
    Badge,

    // Title parts (structured titles for non-HTML clients)
    TitleHighlightColor,
    TitlePart,

    // Media item types
    UniversalMediaType,
    AspectRatio,
    MatchSource,
    FeaturedPickCriteria,
    UniversalMediaItem,

    // Section types
    SectionFilter,
    SectionFilterGroup,
    SectionMeta,
    SectionType,
    PageSection,

    // Card types
    CardVariant,
} from '$lib/schemas/api-responses';
