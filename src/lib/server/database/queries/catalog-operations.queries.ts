// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Catalog Operations Queries
 *
 * Standalone database queries for catalog operations.
 * NOTE: Transaction-scoped operations (advisory locks, transactional inserts)
 * remain in CatalogService. This module contains read queries and simple operations.
 *
 * Tables:
 * - media_items: Core catalog with internal UUIDs
 * - external_ids: Maps internal IDs to external provider IDs
 * - provider_metadata: Raw metadata from each provider
 * - library_availability: Track availability across libraries
 *
 * @module queries/catalog-operations
 */

import type postgres from 'postgres';
import { buildOverrideAwareMetadataLateralJoin } from './builders/provider-metadata.builder.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { normalizeJellyfinId } from '../../utils/jellyfin-id.js';
import { buildAutoEpisodeOrderingJoinFragment } from './episode-search.queries.js';

// =============================================================================
// Types
// =============================================================================

export type MediaType = 'movie' | 'tv' | 'episode' | 'season';

export interface MediaItemRow {
    id: string;
    title: string;
    original_title: string | null;
    year: number | null;
    media_type: MediaType;
    is_local_only: boolean;
    status: string;
    file_path: string | null;
    runtime_seconds: number | null;
}

export interface MediaDownloadNamingRow {
    id: string;
    title: string;
    year: number | null;
    media_type: MediaType;
    /** Only populated for `media_type = 'episode'` (`parent_id` → season → series). */
    season_number: number | null;
    episode_number: number | null;
    series_title: string | null;
}

export interface ExternalIdRow {
    provider: string;
    external_id: string;
    media_type: string | null;
    confidence: number;
    is_primary: boolean;
}

export interface ProviderMetadataRow {
    provider: string;
    metadata: Record<string, unknown>;
    fetched_at: Date;
    updated_at: Date;
}

// =============================================================================
// Media Item Queries
// =============================================================================

/**
 * Get a media item by UUID.
 */
export async function getMediaItemById(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MediaItemRow | null> {
    const rows = await sql<MediaItemRow[]>`
        SELECT id, title, original_title, year, media_type, is_local_only, status, file_path, runtime_seconds
        FROM media_items
        WHERE id = ${mediaId} AND status = 'active'
        LIMIT 1
    `;
    return rows[0] || null;
}

/**
 * Get the naming context for a normalized download filename: the item's own
 * title/year, plus (for episodes only) season/episode number and the series
 * title, resolved by walking `parent_id` episode → season → series — see
 * docs/dev/media-type-vocabulary.md, `episode.parent_id` is the SEASON, not
 * the series.
 */
export async function getMediaItemForDownloadNaming(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MediaDownloadNamingRow | null> {
    const rows = await sql<MediaDownloadNamingRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.year,
            mi.media_type,
            mi.season_number,
            mi.episode_number,
            series.title AS series_title
        FROM media_items mi
        LEFT JOIN media_items season ON mi.media_type = 'episode' AND season.id = mi.parent_id
        LEFT JOIN media_items series ON mi.media_type = 'episode' AND series.id = season.parent_id
        WHERE mi.id = ${mediaId} AND mi.status = 'active'
        LIMIT 1
    `;
    return rows[0] || null;
}

/**
 * Check if a media item exists (active status).
 */
export async function mediaItemExists(sql: postgres.Sql, mediaId: string): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
            SELECT 1 FROM media_items
            WHERE id = ${mediaId} AND status = 'active'
        ) as exists
    `;
    return rows[0]?.exists ?? false;
}

// =============================================================================
// External ID Queries
// =============================================================================

/**
 * Find media_id by external ID.
 *
 * IMPORTANT: For TMDB lookups, mediaType is required — TMDB IDs are NOT unique
 * across media types (e.g., TMDB ID 1429 maps to both a movie and a TV show).
 * Omitting mediaType for a TMDB provider will throw to prevent silent collisions.
 */
export async function findMediaIdByExternalId(
    sql: postgres.Sql,
    params: {
        provider: string;
        externalId: string;
        mediaType?: string;
    },
): Promise<string | null> {
    const { provider, mediaType } = params;
    // Normalize Jellyfin IDs to dashless for consistent lookup
    const externalId =
        provider === 'jellyfin' ? normalizeJellyfinId(params.externalId) : params.externalId;

    if (provider === 'tmdb' && !mediaType) {
        throw new Error('mediaType is required for TMDB provider lookups');
    }

    if (!mediaType) {
        const rows = await sql<{ media_id: string }[]>`
            SELECT media_id FROM external_ids
            WHERE provider = ${provider}
              AND external_id = ${externalId}
            LIMIT 1
        `;
        return rows[0]?.media_id || null;
    }

    const rows = await sql<{ media_id: string }[]>`
        SELECT media_id FROM external_ids
        WHERE provider = ${provider}
          AND external_id = ${externalId}
          AND media_type = ${mediaType}
        LIMIT 1
    `;

    return rows[0]?.media_id || null;
}

/**
 * Get all external IDs for a media item.
 */
export async function getExternalIdsForMedia(
    sql: postgres.Sql,
    mediaId: string,
): Promise<ExternalIdRow[]> {
    return await sql<ExternalIdRow[]>`
        SELECT provider, external_id, media_type, confidence, is_primary
        FROM external_ids
        WHERE media_id = ${mediaId}
        ORDER BY is_primary DESC, confidence DESC
    `;
}

/**
 * Check if an external ID exists.
 */
export async function externalIdExists(
    sql: postgres.Sql,
    params: {
        provider: string;
        externalId: string;
        mediaType?: string;
    },
): Promise<boolean> {
    const { provider, mediaType } = params;
    const externalId =
        provider === 'jellyfin' ? normalizeJellyfinId(params.externalId) : params.externalId;

    const rows = mediaType
        ? await sql<{ exists: boolean }[]>`
            SELECT EXISTS(
                SELECT 1 FROM external_ids
                WHERE provider = ${provider}
                  AND external_id = ${externalId}
                  AND media_type = ${mediaType}
            ) as exists
        `
        : await sql<{ exists: boolean }[]>`
            SELECT EXISTS(
                SELECT 1 FROM external_ids
                WHERE provider = ${provider}
                  AND external_id = ${externalId}
            ) as exists
        `;

    return rows[0]?.exists ?? false;
}

/**
 * Batch resolve external IDs to media_ids.
 */
export async function batchResolveExternalIds(
    sql: postgres.Sql,
    items: Array<{
        provider: string;
        externalId: string;
        mediaType?: string;
    }>,
): Promise<Map<string, string>> {
    if (items.length === 0) return new Map();

    const providers = items.map((i) => i.provider);
    const externalIds = items.map((i) =>
        i.provider === 'jellyfin' ? normalizeJellyfinId(i.externalId) : i.externalId,
    );
    const mediaTypes = items.map((i) => i.mediaType || '');

    const rows = await sql<
        {
            provider: string;
            external_id: string;
            media_type: string;
            media_id: string;
        }[]
    >`
        SELECT provider, external_id, media_type, media_id
        FROM external_ids
        WHERE (provider, external_id, media_type) IN (
            SELECT * FROM unnest(
                ${providers}::text[],
                ${externalIds}::text[],
                ${mediaTypes}::text[]
            )
        )
    `;

    const result = new Map<string, string>();
    for (const row of rows) {
        const key = `${row.provider}:${row.external_id}:${row.media_type || ''}`;
        result.set(key, row.media_id);
    }

    return result;
}

// =============================================================================
// Provider Metadata Queries
// =============================================================================

/**
 * Get provider metadata for a media item.
 */
export async function getProviderMetadata(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        provider?: string;
    },
): Promise<ProviderMetadataRow[]> {
    const { mediaId, provider } = params;

    if (provider) {
        return await sql<ProviderMetadataRow[]>`
            SELECT provider, metadata, fetched_at, updated_at
            FROM provider_metadata
            WHERE media_id = ${mediaId} AND provider = ${provider}
        `;
    }

    return await sql<ProviderMetadataRow[]>`
        SELECT provider, metadata, fetched_at, updated_at
        FROM provider_metadata
        WHERE media_id = ${mediaId}
        ORDER BY provider
    `;
}

/**
 * Check if provider metadata exists.
 */
export async function hasProviderMetadata(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        provider?: string;
    },
): Promise<boolean> {
    const { mediaId, provider } = params;

    const rows = provider
        ? await sql<{ exists: boolean }[]>`
            SELECT EXISTS(
                SELECT 1 FROM provider_metadata
                WHERE media_id = ${mediaId} AND provider = ${provider}
            ) as exists
        `
        : await sql<{ exists: boolean }[]>`
            SELECT EXISTS(
                SELECT 1 FROM provider_metadata
                WHERE media_id = ${mediaId}
            ) as exists
        `;

    return rows[0]?.exists ?? false;
}

// =============================================================================
// Library Availability Queries
// =============================================================================

/**
 * Check if a media item is available in any library.
 */
export async function isMediaAvailable(sql: postgres.Sql, mediaId: string): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
            SELECT 1 FROM library_availability
            WHERE media_id = ${mediaId} AND available = TRUE
        ) as exists
    `;
    return rows[0]?.exists ?? false;
}

/**
 * Get library availability status for a media item.
 */
export async function getLibraryAvailability(
    sql: postgres.Sql,
    mediaId: string,
): Promise<
    Array<{
        library: string;
        libraryItemId: string;
        available: boolean;
        quality: string | null;
    }>
> {
    const rows = await sql<
        {
            library: string;
            library_item_id: string;
            available: boolean;
            quality: string | null;
        }[]
    >`
        SELECT library, library_item_id, available, quality
        FROM library_availability
        WHERE media_id = ${mediaId}
    `;

    return rows.map((row) => ({
        library: row.library,
        libraryItemId: row.library_item_id,
        available: row.available,
        quality: row.quality,
    }));
}

// =============================================================================
// Image Metadata Queries
// =============================================================================

export interface ImageMetadataRow {
    poster_path: string | null;
    backdrop_path: string | null;
    logo_path: string | null;
    still_path: string | null;
    media_type: string | null;
    metadata_media_type: string | null;
    metadata_source_id: string | null;
    primary_ext_id: string | null;
    primary_provider: string | null;
    tmdb_id: string | null;
    jellyfin_id: string | null;
    custom_poster_url: string | null;
    custom_thumb_url: string | null;
    custom_backdrop_url?: string | null;
    custom_logo_url?: string | null;
    /**
     * AudiobookShelf `libraryItemId`, when this item is an ABS book.
     *
     * Audiobooks carry no provider metadata and no `media_files` row, so none of
     * the local/tmdb/jellyfin providers can resolve their art — the cover has to
     * be fetched from AudiobookShelf by this id. Carried on the same cached row
     * as everything else rather than through a second lookup, because the
     * catalog image path resolves metadata once per (uuid, role).
     */
    audiobookshelf_id: string | null;
    /**
     * `custom_metadata.audiobookshelf.updatedAt` — the cover cache's revision
     * key. AudiobookShelf bumps it when the cover changes, so folding it into
     * the key makes a replaced cover a MISS instead of a TTL wait.
     */
    audiobookshelf_revision: string | null;
}

/**
 * Get image metadata for a media item by UUID.
 * Returns poster/backdrop paths from provider metadata and external IDs for fallback.
 * Walks the parent_id chain up to depth 3 so episodes and tracks
 * inherit image metadata from their grandparent series/album when needed.
 */
export async function getImageMetadata(
    sql: postgres.Sql,
    mediaId: string,
    imageType: 'poster' | 'backdrop' | 'logo' | 'still' | 'primary' | 'banner' | 'thumb' = 'poster',
    inherit: 'none' | undefined = undefined,
): Promise<ImageMetadataRow | null> {
    const primaryProvider = getPrimaryExternalIdProvider();
    // Build the override-aware LATERAL join string referencing CTE alias `a`.
    const metadataLateral = sql.unsafe(
        buildOverrideAwareMetadataLateralJoin(undefined, 'a.id', 'a.preferred_provider'),
    );
    const requestedPathPresent =
        imageType === 'backdrop'
            ? sql`(COALESCE(pm.metadata->>'backdrop_path', pm.metadata->'artwork'->>'backdrop') IS NOT NULL OR a.custom_backdrop_url IS NOT NULL)`
            : imageType === 'logo'
              ? sql`(COALESCE(pm.metadata->>'logo_path', pm.metadata->'artwork'->>'logo') IS NOT NULL OR a.custom_logo_url IS NOT NULL)`
              : imageType === 'thumb' || imageType === 'still'
                ? sql`(COALESCE(pm.metadata->>'still_path', pm.metadata->'artwork'->>'still') IS NOT NULL OR a.custom_thumb_url IS NOT NULL)`
                : sql`(COALESCE(pm.metadata->>'poster_path', pm.metadata->'artwork'->>'poster') IS NOT NULL OR a.custom_poster_url IS NOT NULL)`;
    // Rank the requested slot's presence FIRST, then nearest ancestor (depth).
    // Without the presence term, a depth-0 episode with no still/thumb would win
    // over a season/series ancestor that actually carries one — defeating
    // inheritance. The presence term lets the nearest ancestor WITH the image win.
    const requestedTypeRank = sql`${requestedPathPresent} DESC, a.depth ASC`;
    const rows = await sql<ImageMetadataRow[]>`
        WITH RECURSIVE ancestors(
            id,
            depth,
            media_type,
            preferred_provider,
            custom_poster_url,
            custom_backdrop_url,
            custom_logo_url,
            custom_thumb_url
        ) AS (
            SELECT
                mi.id,
                0,
                mi.media_type,
                mi.preferred_provider,
                mi.custom_poster_url,
                mi.custom_backdrop_url,
                mi.custom_logo_url,
                mi.custom_thumb_url
            FROM media_items mi
            WHERE mi.id = ${mediaId}
            UNION ALL
            SELECT
                   mi.parent_id,
                   a.depth + 1,
                   parent.media_type,
                   parent.preferred_provider,
                   parent.custom_poster_url,
                   parent.custom_backdrop_url,
                   parent.custom_logo_url,
                   parent.custom_thumb_url
            FROM ancestors a
            JOIN media_items mi ON mi.id = a.id
            JOIN media_items parent ON parent.id = mi.parent_id
            WHERE a.depth < ${inherit === 'none' ? 0 : 3}
              AND mi.parent_id IS NOT NULL
        )
        SELECT
            COALESCE(pm.metadata->>'poster_path',   pm.metadata->'artwork'->>'poster')   AS poster_path,
            COALESCE(pm.metadata->>'backdrop_path', pm.metadata->'artwork'->>'backdrop') AS backdrop_path,
            COALESCE(pm.metadata->>'logo_path',     pm.metadata->'artwork'->>'logo')     AS logo_path,
            COALESCE(pm.metadata->>'still_path',    pm.metadata->'artwork'->>'still')    AS still_path,
            origin.media_type,
            a.media_type                  AS metadata_media_type,
            a.id                          AS metadata_source_id,
            a.custom_poster_url,
            a.custom_thumb_url,
            a.custom_backdrop_url,
            a.custom_logo_url,
            primary_ext.external_id       AS primary_ext_id,
            primary_ext.provider          AS primary_provider,
            tmdb.external_id              AS tmdb_id,
            jf.external_id                AS jellyfin_id,
            abs.external_id               AS audiobookshelf_id,
            origin.custom_metadata #>> '{audiobookshelf,updatedAt}' AS audiobookshelf_revision
        FROM ancestors a
        ${metadataLateral}
        JOIN media_items origin ON origin.id = ${mediaId}
        LEFT JOIN external_ids primary_ext
            ON primary_ext.media_id = a.id
           AND primary_ext.provider = ${primaryProvider}
        LEFT JOIN external_ids abs
            ON abs.media_id = a.id
           AND abs.provider = 'audiobookshelf'
        LEFT JOIN external_ids tmdb
            ON tmdb.media_id = a.id
           AND tmdb.provider = 'tmdb'
        LEFT JOIN external_ids jf
            ON jf.media_id = a.id
           AND jf.provider = 'jellyfin'
        ORDER BY
            ${requestedTypeRank}
        LIMIT 1
    `;

    return rows.length > 0 ? rows[0] : null;
}

/**
 * Per-role presence flags for a media item, computed with parent-chain
 * inheritance so the listing matches what the byte route actually serves.
 *
 * Each flag is true when the role is resolvable for this item via the same
 * inheritance the byte route uses: the item's OWN provider metadata /
 * custom_* column, OR — walking up the parent_id chain (episode → season →
 * series, track → album → artist) — an ancestor's. This mirrors the recursive
 * CTEs in {@link getImageMetadata} and `getLocalArtwork`.
 *
 * `still`/`thumb` share the same underlying sources (provider `still_path` and
 * `custom_thumb_url`) — TMDB exposes episode stills as `still_path`, and the
 * UI serves them via the generic `thumb` slot.
 */
export interface InheritedImagePresence {
    poster: boolean;
    backdrop: boolean;
    logo: boolean;
    /** still/thumb share sources (provider still_path + custom_thumb_url). */
    thumb: boolean;
}

/**
 * Compute per-role image presence for a media item WITH parent-chain
 * inheritance, in a single recursive walk (depth < 3, matching
 * {@link getImageMetadata}). Returns null only when the item does not exist.
 *
 * A role is "present" when ANY ancestor (the item itself at depth 0, then its
 * parents) carries either provider metadata for that role OR the paired
 * `custom_*` column. This is the presence contract the byte route honors via
 * the local/tmdb/jellyfin/custom provider chain, so the listing no longer
 * under-reports inherited artwork (e.g. an episode that inherits its series
 * poster).
 */
export async function getInheritedImagePresence(
    sql: postgres.Sql,
    mediaId: string,
): Promise<InheritedImagePresence | null> {
    // Per-ancestor metadata pick respects per-media provider overrides, same as
    // getImageMetadata. Alias `a` is the recursive ancestor row.
    const metadataLateral = sql.unsafe(
        buildOverrideAwareMetadataLateralJoin(undefined, 'a.id', 'a.preferred_provider'),
    );
    const rows = await sql<
        {
            poster: boolean;
            backdrop: boolean;
            logo: boolean;
            thumb: boolean;
            exists: boolean;
        }[]
    >`
        WITH RECURSIVE ancestors(
            id,
            depth,
            preferred_provider,
            custom_poster_url,
            custom_backdrop_url,
            custom_logo_url,
            custom_thumb_url
        ) AS (
            SELECT
                mi.id,
                0,
                mi.preferred_provider,
                mi.custom_poster_url,
                mi.custom_backdrop_url,
                mi.custom_logo_url,
                mi.custom_thumb_url
            FROM media_items mi
            WHERE mi.id = ${mediaId}
            UNION ALL
            SELECT
                mi.parent_id,
                a.depth + 1,
                parent.preferred_provider,
                parent.custom_poster_url,
                parent.custom_backdrop_url,
                parent.custom_logo_url,
                parent.custom_thumb_url
            FROM ancestors a
            JOIN media_items mi ON mi.id = a.id
            JOIN media_items parent ON parent.id = mi.parent_id
            WHERE a.depth < 3
              AND mi.parent_id IS NOT NULL
        )
        SELECT
            bool_or(pm.metadata->>'poster_path' IS NOT NULL OR a.custom_poster_url IS NOT NULL)     AS poster,
            bool_or(pm.metadata->>'backdrop_path' IS NOT NULL OR a.custom_backdrop_url IS NOT NULL) AS backdrop,
            bool_or(pm.metadata->>'logo_path' IS NOT NULL OR a.custom_logo_url IS NOT NULL)         AS logo,
            bool_or(pm.metadata->>'still_path' IS NOT NULL OR a.custom_thumb_url IS NOT NULL)       AS thumb,
            count(*) > 0                                                                            AS exists
        FROM ancestors a
        ${metadataLateral}
    `;

    const row = rows[0];
    // This aggregate query always returns exactly one row. When the item does
    // not exist the recursive base is empty, so count(*) = 0 → exists false and
    // the bool_or columns are NULL. Coalesce presence flags to false.
    if (!row || !row.exists) return null;
    return {
        poster: row.poster ?? false,
        backdrop: row.backdrop ?? false,
        logo: row.logo ?? false,
        thumb: row.thumb ?? false,
    };
}

/**
 * Update the file_path for a media item (caches the resolved local file path).
 */
export async function updateMediaItemFilePath(
    sql: postgres.Sql,
    mediaId: string,
    filePath: string,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET file_path = ${filePath}
        WHERE id = ${mediaId}
    `;
}

/**
 * Get the Jellyfin external ID for a media item (best-effort).
 */
export async function getJellyfinExternalId(
    sql: postgres.Sql,
    internalId: string,
): Promise<string | null> {
    const rows = await sql<Array<{ external_id: string }>>`
        SELECT external_id
        FROM external_ids
        WHERE media_id = ${internalId}
          AND provider = 'jellyfin'
        LIMIT 1
    `;
    return rows[0]?.external_id ?? null;
}

/**
 * Get media item data needed for the lumastra watch page SSR branch.
 * Includes series title for episodes (via hierarchy walk).
 *
 * `original_language` is the title's TMDB production language, used by the
 * player's "prefer original language" audio preference. Only the movie/series
 * row carries it — episodes and seasons never do — so it is resolved up the
 * same episode -> season -> series chain as the title, preferring the merged
 * `aggregated` row and falling back to `tmdb` (the only authoritative provider
 * for this field; see METADATA_FIELD_PROVIDERS). NULL when nothing upstream
 * knows it, which the player treats as "no opinion" and falls through to the
 * explicit default language.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getMediaItemForWatch(
    sql: postgres.Sql,
    internalId: string,
): Promise<{
    id: string;
    title: string;
    media_type: string;
    runtime_seconds: number | null;
    season_number: number | null;
    episode_number: number | null;
    series_title: string | null;
    series_id: string | null;
    original_language: string | null;
    overview: string | null;
    parent_id: string | null;
    has_files: boolean;
} | null> {
    // Defense in depth: `internalId` is a uuid column value, and Postgres
    // throws rather than returning no rows for a malformed one. Callers are
    // expected to resolve/validate the id first, but guard here too so this
    // query can never 500 a non-UUID caller.
    if (!UUID_RE.test(internalId)) return null;

    const rows = await sql<
        Array<{
            id: string;
            title: string;
            media_type: string;
            runtime_seconds: number | null;
            season_number: number | null;
            episode_number: number | null;
            series_title: string | null;
            series_id: string | null;
            original_language: string | null;
            overview: string | null;
            parent_id: string | null;
            has_files: boolean;
        }>
    >`
        SELECT
            m.id,
            m.title,
            m.media_type,
            m.has_files,
            m.runtime_seconds,
            COALESCE(eo.order_season_number, m.season_number) AS season_number,
            COALESCE(eo.order_episode_number, m.episode_number) AS episode_number,
            m.parent_id,
            m.overview,
            -- For episodes: walk up two levels (episode -> season -> series)
            -- For seasons: walk up one level (season -> series)
            -- For movies/series: series_title/series_id is null
            CASE
                WHEN m.media_type = 'episode' THEN
                    COALESCE(grandparent.title, parent.title)
                WHEN m.media_type = 'season' THEN
                    parent.title
                ELSE NULL
            END AS series_title,
            CASE
                WHEN m.media_type = 'episode' THEN
                    COALESCE(grandparent.id, parent.id)
                WHEN m.media_type = 'season' THEN
                    parent.id
                ELSE NULL
            END AS series_id,
            orig.original_language
        FROM media_items m
        LEFT JOIN media_items parent      ON parent.id = m.parent_id
        LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
        -- Original production language, resolved series-first then own row.
        -- The (pm.media_id = m.id) sort key puts FALSE (the series row) ahead of
        -- TRUE, so an episode inherits the series language and a movie still
        -- finds its own.
        LEFT JOIN LATERAL (
            SELECT pm.metadata->>'original_language' AS original_language
            FROM provider_metadata pm
            WHERE pm.media_id IN (COALESCE(grandparent.id, parent.id, m.id), m.id)
              AND pm.metadata->>'original_language' IS NOT NULL
            ORDER BY
                (pm.media_id = m.id),
                CASE pm.provider WHEN 'aggregated' THEN 0 WHEN 'tmdb' THEN 1 ELSE 2 END
            LIMIT 1
        ) orig ON TRUE
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'm', 'parent.parent_id')}
        WHERE m.id = ${internalId}
        LIMIT 1
    `;
    return rows[0] ?? null;
}
