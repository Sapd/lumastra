// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media ID Resolution
 *
 * Functions for resolving between different ID formats (TMDB, Jellyfin, internal UUID).
 * These are the primary utilities for ID translation in the application.
 *
 * @module resolvers/media-id
 */

import type postgres from 'postgres';
import { Logger } from '../../../utils/logger.js';
import { getPrimaryExternalIdProvider } from '../../../utils/provider-config.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types';
import { normalizeJellyfinId } from '$lib/server/utils/jellyfin-id.js';

const logger = Logger.for('MediaIdResolver');

/**
 * Input type for batch media ID resolution
 */
export interface TmdbMediaItem {
    tmdbId: number | string;
    /**
     * Matched verbatim against `external_ids.media_type` (see
     * batchResolveMediaIds), which also holds 'episode' / 'season' rows.
     */
    mediaType: string;
}

/**
 * Resolve a TMDB ID to the internal media_id (UUID).
 * Returns null if not found.
 *
 * @param sql - Postgres SQL client
 * @param tmdbId - TMDB identifier
 * @param mediaType - Media type ('movie' or 'tv')
 * @returns The internal UUID or null if not found
 */
export async function resolveMediaId(
    sql: postgres.Sql,
    tmdbId: number,
    mediaType: 'movie' | 'tv',
): Promise<string | null> {
    try {
        const [row] = await sql`
            SELECT media_id FROM external_ids
            WHERE provider = ${getPrimaryExternalIdProvider()}
                AND external_id = ${String(tmdbId)}
                AND media_type = ${mediaType}
            LIMIT 1
        `;
        return (row?.media_id as string) || null;
    } catch (error) {
        logger.error('Failed to resolve media ID', error as Error, {
            tmdbId,
            mediaType,
        });
        throw error;
    }
}

/**
 * Batch resolve TMDB IDs to internal media_ids (UUIDs).
 * Returns a Map where keys are formatted as `${tmdbId}:${mediaType}` and values are UUIDs.
 *
 * @param sql - Postgres SQL client
 * @param items - Array of TMDB items to resolve
 * @returns Map of composite keys to UUIDs
 *
 * @example
 * const items = [
 *   { tmdbId: 550, mediaType: 'movie' },
 *   { tmdbId: 1399, mediaType: 'tv' }
 * ];
 * const mediaIds = await batchResolveMediaIds(sql, items);
 * const fightClubId = mediaIds.get('550:movie');
 * const gotId = mediaIds.get('1399:tv');
 */
export async function batchResolveMediaIds(
    sql: postgres.Sql,
    items: TmdbMediaItem[],
): Promise<Map<string, string>> {
    if (items.length === 0) {
        return new Map();
    }

    try {
        const tmdbIds = items.map((i) => String(i.tmdbId));
        const mediaTypes = items.map((i) => i.mediaType);

        const rows = await sql`
            SELECT external_id, media_type, media_id FROM external_ids
            WHERE provider = ${getPrimaryExternalIdProvider()} AND (external_id, media_type) IN (
                SELECT * FROM unnest(${tmdbIds}::text[], ${mediaTypes}::text[])
            )
        `;

        const result = new Map<string, string>();
        for (const row of rows) {
            const key = `${row.external_id}:${row.media_type}`;
            result.set(key, row.media_id as string);
        }

        logger.debug('Batch resolved media IDs', {
            requested: items.length,
            found: result.size,
        });

        return result;
    } catch (error) {
        logger.error('Failed to batch resolve media IDs', error as Error, {
            itemCount: items.length,
        });
        throw error;
    }
}

/**
 * Build a composite key for Map/Set operations with TMDB IDs.
 *
 * @param tmdbId - TMDB identifier
 * @param mediaType - Media type ('movie' or 'tv')
 * @returns Composite key in format `${tmdbId}:${mediaType}`
 */
export function buildMediaKey(tmdbId: number | string, mediaType: 'movie' | 'tv'): string {
    return `${tmdbId}:${mediaType}`;
}

/**
 * Parse a composite media key back to its components.
 * The id segment may be a numeric TMDB integer or a non-numeric string
 * (IMDB tt-strings, slugs, UUIDs) — both are returned as-is in `externalId`.
 * The legacy `tmdbId` field is populated only when the id segment is numeric.
 *
 * @param key - Composite key in format `${externalId}:${mediaType}`
 * @returns Object with externalId (string), optional numeric tmdbId, and mediaType; or null if invalid
 */
export function parseMediaKey(
    key: string,
): { externalId: string; tmdbId: number | null; mediaType: 'movie' | 'tv' } | null {
    const parts = key.split(':');
    if (parts.length !== 2) return null;

    const idSegment = parts[0];
    const mediaTypePart = parts[1];

    if (!isMovie(mediaTypePart) && !isSeries(mediaTypePart)) {
        return null;
    }

    // Normalise rather than assert. isSeries() accepts BOTH conventions, so a
    // key of `550:series` passes the guard above — asserting the raw segment to
    // 'movie' | 'tv' would return the string 'series' wearing the 'tv' type.
    const mediaType: 'movie' | 'tv' = isMovie(mediaTypePart) ? 'movie' : 'tv';

    const numericId = /^[0-9]+$/.test(idSegment) ? parseInt(idSegment, 10) : null;

    return { externalId: idSegment, tmdbId: numericId, mediaType };
}

/**
 * Resolve any external ID to internal media_id (UUID).
 * Supports any provider in the external_ids table.
 *
 * @param sql - Postgres SQL client
 * @param provider - External ID provider (e.g., 'tmdb', 'imdb', 'tvdb')
 * @param externalId - External ID value
 * @param mediaType - Media type (optional for unique providers like imdb)
 * @returns The internal UUID or null if not found
 */
export async function resolveMediaIdByProvider(
    sql: postgres.Sql,
    provider: string,
    externalId: string,
    /**
     * Composite-key discriminator, matched verbatim against
     * `external_ids.media_type`. Widened beyond `'movie' | 'tv'` because that
     * column also holds `'episode'` and `'season'` rows, and callers resolving
     * a `tmdb:123:episode` style key need to filter on them.
     */
    mediaType?: string,
): Promise<string | null> {
    try {
        // Normalize Jellyfin IDs to dashless for consistent lookup
        const normalizedId = provider === 'jellyfin' ? normalizeJellyfinId(externalId) : externalId;

        let rows;
        if (mediaType) {
            rows = await sql`
                SELECT media_id FROM external_ids
                WHERE provider = ${provider}
                    AND external_id = ${normalizedId}
                    AND media_type = ${mediaType}
                LIMIT 1
            `;
        } else {
            // For providers with unique IDs (like IMDB), mediaType not required
            rows = await sql`
                SELECT media_id FROM external_ids
                WHERE provider = ${provider}
                    AND external_id = ${normalizedId}
                LIMIT 1
            `;
        }
        return (rows[0]?.media_id as string) || null;
    } catch (error) {
        logger.error('Failed to resolve media ID by provider', error as Error, {
            provider,
            externalId,
            mediaType,
        });
        throw error;
    }
}

/**
 * Get all external IDs for a media item.
 *
 * @param sql - Postgres SQL client
 * @param mediaId - Internal UUID
 * @returns Map of provider -> external_id
 */
export async function getExternalIds(
    sql: postgres.Sql,
    mediaId: string,
): Promise<Record<string, string>> {
    try {
        const rows = await sql`
            SELECT provider, external_id
            FROM external_ids
            WHERE media_id = ${mediaId}
        `;

        const result: Record<string, string> = {};
        for (const row of rows) {
            result[row.provider as string] = row.external_id as string;
        }
        return result;
    } catch (error) {
        logger.error('Failed to get external IDs', error as Error, { mediaId });
        throw error;
    }
}

/**
 * Reverse lookup: Jellyfin UUID -> Internal UUID.
 * Handles both dashed and dashless UUID formats by normalizing to the canonical
 * dashless storage form.
 *
 * Composite-key safety: a Jellyfin `external_id` is not guaranteed unique across
 * media types in our DB (e.g. the same ID stored for a series and one of its
 * seasons). When `mediaType` is supplied the lookup is scoped to that type. When
 * it is omitted and the ID maps to more than one media item, this fails CLOSED
 * (returns `null` + warns) rather than returning an arbitrary UUID — picking the
 * wrong item would silently contaminate every downstream Jellyfin lookup.
 *
 * @param sql - Postgres SQL client
 * @param jellyfinId - Jellyfin UUID (with or without dashes)
 * @param mediaType - Optional media type to disambiguate (composite key)
 * Rows of deleted media items are ignored (a merged item is still returned; the
 * caller follows its canonical chain).
 *
 * @returns The internal UUID, or null if not found / ambiguous
 */
export async function resolveJellyfinIdToMediaId(
    sql: postgres.Sql,
    jellyfinId: string,
    mediaType?: string,
): Promise<string | null> {
    try {
        // Normalize to dashless (canonical storage format)
        const normalized = normalizeJellyfinId(jellyfinId);

        if (mediaType) {
            const rows = await sql`
                SELECT ei.media_id FROM external_ids ei
                JOIN media_items mi ON mi.id = ei.media_id
                WHERE ei.provider = 'jellyfin'
                    AND ei.external_id = ${normalized}
                    AND ei.media_type = ${mediaType}
                    AND mi.status <> 'deleted'
                LIMIT 1
            `;
            return (rows[0]?.media_id as string) || null;
        }

        // No type hint: fetch up to two distinct matches so we can detect — and
        // refuse to guess at — a Jellyfin ID that spans multiple media types.
        const rows = await sql`
            SELECT DISTINCT ei.media_id FROM external_ids ei
            JOIN media_items mi ON mi.id = ei.media_id
            WHERE ei.provider = 'jellyfin'
                AND ei.external_id = ${normalized}
                AND mi.status <> 'deleted'
            LIMIT 2
        `;

        if (rows.length === 0) {
            return null;
        }

        if (rows.length > 1) {
            logger.warn(
                'Ambiguous Jellyfin ID maps to multiple media items; refusing to resolve without a media type',
                {
                    jellyfinId,
                    normalized,
                },
            );
            return null;
        }

        return (rows[0]?.media_id as string) || null;
    } catch (error) {
        logger.error('Failed to resolve Jellyfin ID to media ID', error as Error, {
            jellyfinId,
        });
        throw error;
    }
}

/**
 * Get all external IDs for a media item, including media type and status.
 * Used by the ID resolver for complete resolution context.
 *
 * @param sql - Postgres SQL client
 * @param mediaId - Internal UUID
 * @returns Media info with all external IDs
 */
export async function getMediaExternalIds(
    sql: postgres.Sql,
    mediaId: string,
): Promise<{
    internalId: string;
    status: string;
    mediaType: 'movie' | 'tv';
    canonicalId: string | null;
    externalIds: Record<string, string>;
} | null> {
    try {
        const rows = await sql<
            {
                internal_id: string;
                status: string;
                media_type: 'movie' | 'tv';
                canonical_id: string | null;
                external_ids: Record<
                    string,
                    {
                        external_id: string;
                        media_type: string;
                        is_primary: boolean;
                        confidence: number;
                    }
                >;
            }[]
        >`
            SELECT
                mi.id as internal_id,
                mi.status,
                mi.media_type,
                mi.canonical_id,
                jsonb_object_agg(
                    ei.provider,
                    jsonb_build_object(
                        'external_id', ei.external_id,
                        'media_type', ei.media_type,
                        'is_primary', ei.is_primary,
                        'confidence', ei.confidence
                    )
                ) FILTER (WHERE ei.provider IS NOT NULL) as external_ids
            FROM media_items mi
            -- Jellyfin item ids are sync-only and never part of resolved ids.
            LEFT JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider <> 'jellyfin'
            WHERE mi.id = ${mediaId}
            GROUP BY mi.id
        `;

        if (rows.length === 0) {
            return null;
        }

        const row = rows[0];

        // Flatten external_ids to just provider -> external_id string
        const externalIds: Record<string, string> = {};
        if (row.external_ids) {
            for (const [provider, data] of Object.entries(row.external_ids)) {
                externalIds[provider] = data.external_id;
            }
        }

        return {
            internalId: row.internal_id,
            status: row.status,
            mediaType: row.media_type,
            canonicalId: row.canonical_id,
            externalIds,
        };
    } catch (error) {
        logger.error('Failed to get media external IDs', error as Error, {
            mediaId,
        });
        throw error;
    }
}
