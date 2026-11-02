// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core provider types shared across the codebase.
 *
 * `audiobook` is a member because `external_ids.media_type` is part of the
 * composite key `(provider, external_id, media_type)` and Audiobookshelf items
 * are written through `CatalogService.upsertExternalId()`, whose
 * {@link ExternalIdWrite} requires it. It is deliberately NOT added to the
 * embedding-generator unions (`ai/dual-embedding-generator.ts`,
 * `ai/embedding-utils.ts`) — audiobooks never enter the recommender.
 *
 * The members are DEFINED in `$lib/shared/media-type-domain` as
 * {@link MediaTypeProvider}, alongside the exhaustive
 * `Record<MediaTypeInternal, MediaTypeProvider | null>` that maps DB rows onto
 * it (`toProviderMediaType()`). This alias keeps the historic import path; it is
 * not a second definition.
 */
import type { MediaTypeProvider } from '$lib/shared/media-type-domain';

export type MediaType = MediaTypeProvider;

export interface ExternalId {
    provider: string;
    id: string;
    /** Required for TMDB (IDs not unique across types), optional for others */
    mediaType?: MediaType;
    /** Confidence score 0-1, defaults to 1.0 */
    confidence?: number;
}

/**
 * External ID for WRITE operations - mediaType is REQUIRED.
 * Use this type when inserting/updating external_ids to ensure media_type is always provided.
 * This prevents bugs where empty media_type causes duplicate search results.
 */
export interface ExternalIdWrite {
    provider: string;
    id: string;
    /** REQUIRED for write operations - prevents duplicate search results */
    mediaType: MediaType;
    /** Confidence score 0-1, defaults to 1.0 */
    confidence?: number;
    /** Source of this external ID (e.g., 'api', 'sync', 'metadata-sync') */
    source?: string;
}
