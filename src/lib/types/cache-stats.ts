// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared types for cache statistics and monitoring
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/admin-types'.
 */

export type {
    NamespaceMetrics,
    FilesystemCache,
    FilesystemCacheBudget,
    FilesystemCacheLastCleanup,
    FilesystemCacheImageFormats,
    FilesystemCacheFormatBreakdown,
    StandaloneCache,
    TranscodingCacheStats,
    SubtitleCacheStats,
    CacheAggregate,
    CacheHealth,
    CacheStatsResponse,
} from '$lib/schemas/admin-types';
