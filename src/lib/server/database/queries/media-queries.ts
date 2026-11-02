// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Query Utilities
 *
 * Shared SQL fragments and helper functions for querying the UUID-based media catalog.
 * These utilities help build consistent queries across the application.
 *
 * This file re-exports from the modular query system for backwards compatibility.
 * New code should import directly from the specific modules:
 * - fragments/base-media.fragments.ts - MediaQueryFragments
 * - fragments/watch-history.fragments.ts - WatchHistoryFragments
 * - fragments/jsonb-extractors.ts - JSONB array extraction helpers
 * - builders/media-query.builder.ts - buildMediaQuery, mediaSelectFields, etc.
 * - builders/external-id-subquery.builder.ts - Scalar subquery builders
 * - builders/provider-metadata.builder.ts - Dynamic provider chain builders
 * - resolvers/media-id.resolver.ts - resolveMediaId, batchResolveMediaIds, etc.
 * - filters/watch-history.filters.ts - timeframeToDays, buildTimeWindowFilter, etc.
 *
 * Table Reference:
 * - media_items: Core catalog with internal UUIDs (id, title, original_title, year, media_type, is_local_only)
 * - external_ids: Maps internal IDs to external provider IDs (media_id, provider, external_id, media_type)
 * - provider_metadata: Raw metadata from each provider (media_id, provider, metadata JSONB)
 * - media_embeddings: Vector embeddings per source (media_id, source, embedding)
 * - library_availability: Track availability across libraries (media_id, library, library_item_id, available)
 */

// =============================================================================
// FRAGMENTS - Re-export from modular fragments
// =============================================================================

export { MediaQueryFragments } from './fragments/base-media.fragments.js';
export { buildEmbeddingTextFields } from './fragments/base-media.fragments.js';
export { WatchHistoryFragments } from './fragments/watch-history.fragments.js';
export {
    buildJsonArrayExtract,
    JsonbArrayExtractors,
    TypedJsonbExtractors,
} from './fragments/jsonb-extractors.js';

// =============================================================================
// BUILDERS - Re-export from modular builders
// =============================================================================

export {
    buildMediaQuery,
    mediaSelectFields,
    mediaJoins,
    parseMediaRow,
    type MediaQueryOptions,
    type MediaFieldOptions,
    type ParsedMediaItem,
} from './builders/media-query.builder.js';

export {
    buildExternalIdSubquery,
    buildExternalIdSubqueries,
    prebuiltExternalIdSubqueries,
    prebuiltExternalIdSubqueries as ExternalIdSubqueries,
    buildExternalIdExistsChecks,
    prebuiltExternalIdExistsChecks,
    prebuiltExternalIdExistsChecks as ExternalIdExistsChecks,
    buildExternalIdExclusions,
    prebuiltExternalIdExclusions,
    prebuiltExternalIdExclusions as ExternalIdExclusions,
} from './builders/external-id-subquery.builder.js';

export {
    getProviderArray,
    resetProviderArrayCache,
    buildMetadataProviderOrder,
    buildMetadataLateralJoin,
    buildMetadataLateralJoinFragment,
    getDynamicMediaQueryFragments,
    buildProviderFilterUnsafe,
    buildProviderOrderUnsafe,
    buildProviderMetadataSubquery,
    type DynamicMediaQueryFragments,
} from './builders/provider-metadata.builder.js';

// =============================================================================
// RESOLVERS - Re-export from modular resolvers
// =============================================================================

export {
    resolveMediaId,
    batchResolveMediaIds,
    buildMediaKey,
    parseMediaKey,
    resolveMediaIdByProvider,
    getExternalIds,
    resolveJellyfinIdToMediaId,
    getMediaExternalIds,
    type TmdbMediaItem,
} from './resolvers/media-id.resolver.js';

// =============================================================================
// FILTERS - Re-export from modular filters
// =============================================================================

export {
    timeframeToDays,
    buildTimeWindowFilter,
    buildMinWatchTimeFilter,
    buildTimeframeFilter,
    buildCompletionFilter,
    type Timeframe,
} from './filters/watch-history.filters.js';
