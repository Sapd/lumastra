// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reusable OpenAPI component schemas.
 *
 * Schemas with .meta({ id: 'Name' }) become $ref entries in components/schemas.
 * These model the common response shapes used across multiple endpoints.
 *
 * IMPORTANT: All API response schemas are defined in src/lib/schemas/api-responses.ts
 * This file re-exports them with OpenAPI-compatible names for backward compatibility.
 */

// Re-export schemas from the single source of truth
export {
    ExternalIdsResponseSchema as ExternalIdsResponse,
    UniversalMediaItemSchema as UniversalMediaItemResponse,
    PageSectionSchema as PageSectionResponse,
    SectionMetaSchema as SectionMetaResponse,
    BadgeSchema as BadgeResponse,
    TitlePartSchema as TitlePartResponse,
    SectionFilterSchema as SectionFilterResponse,
    SectionFilterGroupSchema as SectionFilterGroupResponse,
    SectionTypeSchema,
    CardVariantSchema,
    BadgeColorSchema,
    FeaturedPickCriteriaSchema,
} from '../../src/lib/schemas/api-responses';
