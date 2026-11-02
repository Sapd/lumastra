// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External ID Builder Utility
 *
 * Consolidates external ID construction logic to ensure consistency across the codebase.
 * This utility handles different row shapes from database queries and transforms them
 * into the standard ExternalIds structure.
 *
 * Usage:
 * ```typescript
 * const externalIds = buildExternalIdsFromRow(row);
 * ```
 */

import type { ExternalIds } from '$lib/types/api-common';

/**
 * Row shape with external ID fields.
 * Supports various database query result shapes.
 */
export interface ExternalIdRow {
    media_id?: string;
    tmdb_id?: number | string | null;
    imdb_id?: string | null;
    tvdb_id?: number | string | null;
    trakt_id?: number | string | null;
    mal_id?: number | string | null;
}

/**
 * Build ExternalIds object from database row.
 *
 * Handles:
 * - String() conversion for numeric IDs (tmdb, tvdb, trakt, mal)
 * - Conditional inclusion (only adds fields that exist)
 * - Optional media_id to internal UUID mapping
 *
 * @param row - Database row with external ID fields
 * @returns ExternalIds object with all available IDs
 */
export function buildExternalIdsFromRow(row: ExternalIdRow): ExternalIds {
    const ids: ExternalIds = {};

    if (row.tmdb_id) {
        ids.tmdb = String(row.tmdb_id);
    }
    if (row.imdb_id) {
        ids.imdb = row.imdb_id;
    }
    if (row.tvdb_id) {
        ids.tvdb = String(row.tvdb_id);
    }
    if (row.trakt_id) {
        ids.trakt = String(row.trakt_id);
    }
    if (row.mal_id) {
        ids.mal = String(row.mal_id);
    }
    if (row.media_id) {
        ids.internal = row.media_id;
    }

    return ids;
}
