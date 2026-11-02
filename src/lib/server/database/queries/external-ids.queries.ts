// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External IDs Query Module
 *
 * Centralized queries for resolving external provider IDs (TMDB, Jellyfin, IMDB, etc.).
 * These patterns were previously scattered across 15+ files.
 *
 * Key principle: Always include media_type when querying by TMDB ID to avoid collisions.
 * The same TMDB ID can refer to different content (e.g., TMDB 1429 is both a movie and TV show).
 */

import type postgres from 'postgres';
import { defineQuery, defineScalarQuery, defineExistsQuery } from '../typed-query.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types';
import { normalizeJellyfinId } from '$lib/server/utils/jellyfin-id.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';

// =============================================================================
// Types
// =============================================================================

export type Provider = 'tmdb' | 'imdb' | 'jellyfin' | 'jellyseerr' | 'tvdb' | 'mal' | 'anilist';
export type MediaType = 'movie' | 'tv';

export interface ExternalIdRow {
    media_id: string;
    provider: Provider;
    external_id: string;
    media_type: MediaType | null;
    is_primary: boolean;
}

export interface ResolvedMediaId {
    mediaId: string;
    mediaType: MediaType;
}

export interface AllExternalIds {
    internal_id: string;
    tmdb_id: number | null;
    imdb_id: string | null;
    jellyfin_id: string | null;
    jellyseerr_id: string | null;
    tvdb_id: number | null;
}

// =============================================================================
// Single ID Resolution Queries
// =============================================================================

/**
 * Resolve TMDB ID to internal UUID.
 * IMPORTANT: Always provide mediaType to avoid ID collisions.
 * @deprecated Use resolvePrimaryExternalId (provider-agnostic)
 */
export const resolveFromTmdb = defineScalarQuery<{ tmdbId: number; mediaType: MediaType }, string>(
    'resolveFromTmdb',
    (sql, { tmdbId, mediaType }) => sql`
        SELECT media_id
        FROM external_ids
        WHERE provider = ${getPrimaryExternalIdProvider()}
          AND external_id = ${String(tmdbId)}
          AND media_type = ${mediaType}
        LIMIT 1
    `,
    (row) => row.media_id as string,
);

/**
 * Resolve Jellyfin ID to internal UUID.
 */
export const resolveFromJellyfin = defineScalarQuery<{ jellyfinId: string }, string>(
    'resolveFromJellyfin',
    (sql, { jellyfinId }) => sql`
        SELECT media_id
        FROM external_ids
        WHERE provider = 'jellyfin'
          AND external_id = ${normalizeJellyfinId(jellyfinId)}
        LIMIT 1
    `,
    (row) => row.media_id as string,
);

/**
 * Resolve IMDB ID to internal UUID.
 *
 * WARNING: Omitting mediaType can return incorrect results if the external_ids
 * table contains duplicate IMDB entries (e.g. from sync bugs or provider
 * collisions). Always pass mediaType when it is known from context.
 */
export const resolveFromImdb = defineScalarQuery<{ imdbId: string; mediaType?: string }, string>(
    'resolveFromImdb',
    (sql, { imdbId, mediaType }) => sql`
        SELECT media_id
        FROM external_ids
        WHERE provider = 'imdb'
          AND external_id = ${imdbId}
          ${mediaType ? sql`AND media_type = ${mediaType}` : sql``}
        LIMIT 1
    `,
    (row) => row.media_id as string,
);

/**
 * Get the primary external ID (TMDB ID) for an internal media UUID.
 * The ::integer cast is guarded to providers with numeric IDs; non-numeric
 * primary IDs (IMDB tt-strings, slugs, UUIDs) are excluded from the cast
 * and the query returns null rather than throwing.
 */
export const getTmdbId = defineScalarQuery<{ mediaId: string }, number>(
    'getTmdbId',
    (sql, { mediaId }) => sql`
        SELECT external_id::integer as tmdb_id
        FROM external_ids
        WHERE media_id = ${mediaId}
          AND provider = ${getPrimaryExternalIdProvider()}
          AND external_id ~ '^[0-9]+$'
        LIMIT 1
    `,
    (row) => row.tmdb_id as number,
);

/**
 * Get Jellyfin ID for an internal media UUID.
 */
export const getJellyfinId = defineScalarQuery<{ mediaId: string }, string>(
    'getJellyfinId',
    (sql, { mediaId }) => sql`
        SELECT external_id
        FROM external_ids
        WHERE media_id = ${mediaId}
          AND provider = 'jellyfin'
        LIMIT 1
    `,
    (row) => row.external_id as string,
);

/**
 * Get IMDB ID for an internal media UUID.
 */
export const getImdbId = defineScalarQuery<{ mediaId: string }, string>(
    'getImdbId',
    (sql, { mediaId }) => sql`
        SELECT external_id
        FROM external_ids
        WHERE media_id = ${mediaId}
          AND provider = 'imdb'
        LIMIT 1
    `,
    (row) => row.external_id as string,
);

// =============================================================================
// Existence Checks
// =============================================================================

/**
 * Check if a media item exists by TMDB ID.
 */
export const existsByTmdb = defineExistsQuery<{
    tmdbId: number;
    mediaType: MediaType;
}>(
    'existsByTmdb',
    (sql, { tmdbId, mediaType }) => sql`
        SELECT 1
        FROM external_ids
        WHERE provider = ${getPrimaryExternalIdProvider()}
          AND external_id = ${String(tmdbId)}
          AND media_type = ${mediaType}
        LIMIT 1
    `,
);

/**
 * Check if a media item exists by Jellyfin ID.
 */
export const existsByJellyfin = defineExistsQuery<{ jellyfinId: string }>(
    'existsByJellyfin',
    (sql, { jellyfinId }) => sql`
        SELECT 1
        FROM external_ids
        WHERE provider = 'jellyfin'
          AND external_id = ${normalizeJellyfinId(jellyfinId)}
        LIMIT 1
    `,
);

// =============================================================================
// Multi-ID Queries
// =============================================================================

/**
 * Get all external IDs for a media item.
 * Optimized: Uses single table scan with pivot aggregation instead of 5 scalar subqueries.
 */
export const getAllExternalIds = defineQuery<{ mediaId: string }, AllExternalIds>(
    'getAllExternalIds',
    (sql, { mediaId }) => sql`
        SELECT
            ${mediaId} as internal_id,
            MAX(CASE WHEN provider = ${getPrimaryExternalIdProvider()} AND external_id ~ '^[0-9]+$' THEN external_id::integer END) as tmdb_id,
            MAX(CASE WHEN provider = 'imdb' THEN external_id END) as imdb_id,
            MAX(CASE WHEN provider = 'jellyfin' THEN external_id END) as jellyfin_id,
            MAX(CASE WHEN provider = 'jellyseerr' THEN external_id END) as jellyseerr_id,
            MAX(CASE WHEN provider = 'tvdb' AND external_id ~ '^[0-9]+$' THEN external_id::integer END) as tvdb_id
        FROM external_ids
        WHERE media_id = ${mediaId}
    `,
);

/**
 * Get all external ID records for a media item (raw rows).
 */
export const getExternalIdRecords = defineQuery<{ mediaId: string }, ExternalIdRow>(
    'getExternalIdRecords',
    (sql, { mediaId }) => sql`
        SELECT media_id, provider, external_id, media_type, is_primary
        FROM external_ids
        WHERE media_id = ${mediaId}
    `,
);

// =============================================================================
// Batch Resolution Queries
// =============================================================================

interface TmdbBatchItem {
    // Accepts either a numeric TMDB id or the raw text `external_id` — the
    // implementation stringifies via `String(i.tmdbId)` and the column is text,
    // so callers resolving from stored external ids (strings) are valid.
    tmdbId: string | number;
    mediaType: MediaType;
}

interface BatchResolvedItem {
    external_id: string;
    media_type: MediaType;
    media_id: string;
}

/**
 * Batch resolve multiple TMDB IDs to internal UUIDs.
 * Returns a Map keyed by `${tmdbId}:${mediaType}`.
 * @deprecated Use batchResolvePrimaryExternalId (provider-agnostic)
 *
 * @example
 * const items = [
 *   { tmdbId: 550, mediaType: 'movie' },
 *   { tmdbId: 1399, mediaType: 'tv' }
 * ];
 * const resolved = await batchResolveFromTmdb(sql, items);
 * const fightClubId = resolved.get('550:movie');
 */
export async function batchResolveFromTmdb(
    sql: postgres.Sql,
    items: TmdbBatchItem[],
): Promise<Map<string, string>> {
    if (items.length === 0) {
        return new Map();
    }

    const tmdbIds = items.map((i) => String(i.tmdbId));
    const mediaTypes = items.map((i) => i.mediaType);

    const rows = await sql<BatchResolvedItem[]>`
        SELECT external_id, media_type, media_id
        FROM external_ids
        WHERE provider = ${getPrimaryExternalIdProvider()}
          AND (external_id, media_type) IN (
            SELECT * FROM unnest(${tmdbIds}::text[], ${mediaTypes}::text[])
          )
    `;

    const result = new Map<string, string>();
    for (const row of rows) {
        const key = `${row.external_id}:${row.media_type}`;
        result.set(key, row.media_id);
    }
    return result;
}

/**
 * Batch resolve multiple Jellyfin IDs to internal UUIDs.
 * Returns a Map keyed by Jellyfin ID.
 */
export async function batchResolveFromJellyfin(
    sql: postgres.Sql,
    jellyfinIds: string[],
): Promise<Map<string, string>> {
    if (jellyfinIds.length === 0) {
        return new Map();
    }

    // Normalize all IDs to dashless and build a reverse map to return
    // results keyed by the original input IDs
    const normalizedIds = jellyfinIds.map(normalizeJellyfinId);
    const normalizedToOriginal = new Map<string, string>();
    for (let i = 0; i < jellyfinIds.length; i++) {
        normalizedToOriginal.set(normalizedIds[i], jellyfinIds[i]);
    }

    const rows = await sql<{ external_id: string; media_id: string }[]>`
        SELECT external_id, media_id
        FROM external_ids
        WHERE provider = 'jellyfin'
          AND external_id = ANY(${normalizedIds})
    `;

    const result = new Map<string, string>();
    for (const row of rows) {
        // Key by original input ID for caller compatibility
        const originalId = normalizedToOriginal.get(row.external_id) || row.external_id;
        result.set(originalId, row.media_id);
        // Also key by stored (dashless) form
        if (originalId !== row.external_id) {
            result.set(row.external_id, row.media_id);
        }
    }
    return result;
}

/**
 * Batch get TMDB IDs for multiple internal UUIDs.
 * Returns a Map keyed by internal UUID.
 */
export async function batchGetTmdbIds(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<Map<string, number>> {
    if (mediaIds.length === 0) {
        return new Map();
    }

    const rows = await sql<{ media_id: string; tmdb_id: number }[]>`
        SELECT media_id, external_id::integer as tmdb_id
        FROM external_ids
        WHERE provider = ${getPrimaryExternalIdProvider()}
          AND media_id = ANY(${mediaIds}::uuid[])
          AND external_id ~ '^[0-9]+$'
    `;

    const result = new Map<string, number>();
    for (const row of rows) {
        result.set(row.media_id, row.tmdb_id);
    }
    return result;
}

// =============================================================================
// Composite Key Helper
// =============================================================================

/**
 * Resolve `(provider, external_id, media_type)` to an internal media UUID.
 *
 * Provider-agnostic and composite-key safe — works for any provider
 * (`'tmdb'`, `'jellyfin'`, `'imdb'`, `'mal'`, future plugins …) without the
 * deprecated per-provider helpers. Used by the SDK `ctx.catalog.findByExternalId`
 * surface; `mediaType` is mandatory because the same provider id can map to
 * different lumastra items across media types (TMDB id `1429` resolves to a
 * movie AND a series — composite key matters).
 *
 * Jellyfin external_ids are stored in dashless form (see
 * `normalizeJellyfinId`); pass the raw input — the query handles
 * normalization at the boundary.
 */
export async function findMediaIdByProviderExternalId(
    sql: postgres.Sql,
    params: { provider: string; externalId: string; mediaType: string },
): Promise<string | null> {
    const externalIdValue =
        params.provider === 'jellyfin' ? normalizeJellyfinId(params.externalId) : params.externalId;
    const rows = await sql<{ media_id: string }[]>`
        SELECT media_id FROM external_ids
        WHERE provider = ${params.provider}
          AND external_id = ${externalIdValue}
          AND media_type = ${params.mediaType}
        LIMIT 1
    `;
    return rows[0]?.media_id ?? null;
}

/**
 * Build a composite key for Map/Set operations with TMDB IDs.
 * @deprecated Use buildExternalIdKey (provider-agnostic)
 */
export function buildTmdbKey(tmdbId: number, mediaType: MediaType): string {
    return `${tmdbId}:${mediaType}`;
}

/**
 * Parse a composite TMDB key back to components.
 */
export function parseTmdbKey(key: string): { tmdbId: number; mediaType: MediaType } | null {
    const parts = key.split(':');
    if (parts.length !== 2) return null;

    const tmdbId = parseInt(parts[0], 10);
    if (isNaN(tmdbId)) return null;

    const mediaType = parts[1];
    // Normalize to canonical MediaType ('movie' | 'tv')
    if (isMovie(mediaType)) return { tmdbId, mediaType: 'movie' };
    if (isSeries(mediaType)) return { tmdbId, mediaType: 'tv' };
    return null;
}

// =============================================================================
// Provider-Agnostic Names (preferred for new code)
// =============================================================================

/**
 * Resolve primary external ID to internal UUID.
 * Uses getPrimaryExternalIdProvider() internally - provider-agnostic.
 */
export const resolvePrimaryExternalId = resolveFromTmdb;

/**
 * Get primary external ID for an internal media UUID.
 * Uses getPrimaryExternalIdProvider() internally - provider-agnostic.
 */
export const getPrimaryExternalId = getTmdbId;

/**
 * Batch resolve multiple primary external IDs to internal UUIDs.
 * Uses getPrimaryExternalIdProvider() internally - provider-agnostic.
 */
export const batchResolvePrimaryExternalId = batchResolveFromTmdb;

/**
 * Build a composite key for Map/Set operations.
 * Provider-agnostic version of buildTmdbKey.
 */
export function buildExternalIdKey(providerId: number, mediaType: MediaType): string {
    return buildTmdbKey(providerId, mediaType);
}
