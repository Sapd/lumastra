// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Availability Query Module
 *
 * Centralized availability logic. An item is "available" iff
 * `media_items.has_files = true`. The former Jellyfin-external-ID branch
 * (`OR EXISTS(SELECT 1 FROM external_ids WHERE provider='jellyfin')`) was
 * removed in the Jellyfin-decoupling refactor — do not re-add it. `has_files`
 * is the canonical signal, populated exclusively by the file-scanner plugin
 * and propagated up the media hierarchy on link/unlink/delete. It replaces
 * direct file-link checks, which miss series with files linked to episodes.
 *
 * ## Usage in queries
 *
 * ```typescript
 * import { isAvailableExpr } from './availability.queries.js';
 *
 * // Default — assumes media_items aliased as `mi`
 * const rows = await sql`SELECT mi.*, ${isAvailableExpr(sql)} AS is_available FROM media_items mi`;
 *
 * // Custom column — for queries using a different alias
 * const rows = await sql`SELECT ${isAvailableExpr(sql, sql`us.media_id`)} AS is_available FROM user_suggestions us`;
 * ```
 *
 * @module queries/availability
 */

import type postgres from 'postgres';
import { UUID_RE } from '$lib/utils/id-patterns.js';

// =========================================================================
// SQL FRAGMENT FUNCTIONS (preferred — type-safe, composable)
// =========================================================================

/**
 * Postgres.js fragment: boolean expression that is true when a media item is available.
 * Uses canonical `has_files` for both paths: a direct column check by default,
 * or a catalog lookup for a custom mediaIdCol (false for missing/null IDs).
 *
 * @param sql - postgres.js instance from the calling query
 * @param mediaIdCol - SQL fragment for the media item ID column (default: `mi.id`)
 */
export function isAvailableExpr(
    sql: postgres.Sql,
    mediaIdCol?: postgres.PendingQuery<postgres.Row[]> | ReturnType<postgres.Sql>,
): postgres.PendingQuery<postgres.Row[]> {
    if (!mediaIdCol) {
        // Default path: use has_files column (O(1) instead of EXISTS subquery)
        return sql`mi.has_files`;
    }
    // Capture the outer reference before introducing lookup aliases, so even
    // callers using the same alias names retain a correlated lookup.
    return sql`(
        SELECT EXISTS(
            SELECT 1 FROM media_items availability_item
            WHERE availability_item.id = availability_target.media_id
              AND availability_item.has_files = true
        )
        FROM (SELECT ${mediaIdCol} AS media_id) availability_target
    )`;
}

/**
 * Postgres.js fragment: negated availability (true when NOT available → can be requested).
 */
export function canRequestExpr(
    sql: postgres.Sql,
    mediaIdCol?: postgres.PendingQuery<postgres.Row[]> | ReturnType<postgres.Sql>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`NOT ${isAvailableExpr(sql, mediaIdCol)}`;
}

// =========================================================================
// STRING CONSTANTS (for sql.unsafe() in dynamic query builders)
// =========================================================================

/**
 * Boolean expression for WHERE clauses.
 * Assumes the outer query aliases media_items as `mi`.
 * Uses has_files column exclusively (O(1) column check).
 */
export const AVAILABILITY_EXISTS = 'mi.has_files';

/**
 * Two SELECT fields for availability data.
 * Requires the outer query to alias `media_items` as `mi`.
 * Returns: is_available (from has_files), can_request
 */
export const AVAILABILITY_SELECT_FIELDS = `mi.has_files AS is_available,
        NOT mi.has_files AS can_request`;

/**
 * Negated availability for sql.unsafe() contexts.
 * True when item is NOT available → can be requested.
 */
export const CAN_REQUEST_EXISTS = 'NOT mi.has_files';

/**
 * WHERE-clause-ready EXISTS expression.
 */
export const AVAILABILITY_FILTER = AVAILABILITY_EXISTS;

// =========================================================================
// INTERFACES
// =========================================================================

export interface AvailabilityResult {
    is_available: boolean;
}

// =========================================================================
// QUERY FUNCTIONS
// =========================================================================

/**
 * Check if a single media item is available (has_files = true).
 */
export async function isAvailable(sql: postgres.Sql, mediaId: string): Promise<boolean> {
    const rows = await sql<[{ available: boolean }]>`
        SELECT mi.has_files AS available
        FROM media_items mi
        WHERE mi.id = ${mediaId}
    `;
    return rows[0]?.available ?? false;
}

/**
 * Batch check availability for multiple media items.
 * Returns a Map from mediaId to boolean; missing IDs default to false.
 */
// RFC 4122 UUID shape — used to filter caller-supplied ids before the uuid[]
// cast. Without this, a single non-UUID slipping through (e.g. a TMDB id) trips
// "invalid input syntax for type uuid" and the whole batch 500s.

export async function batchGetAvailability(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (mediaIds.length === 0) return result;

    // Filter to well-formed UUIDs. Non-matching ids are recorded as `false`
    // (consistent with the post-query loop's default), so callers get a stable
    // map shape regardless of input hygiene.
    const uuids = mediaIds.filter((id) => UUID_RE.test(id));
    if (uuids.length === 0) {
        for (const id of mediaIds) result.set(id, false);
        return result;
    }

    const rows = await sql<Array<{ id: string }>>`
        SELECT id FROM media_items
        WHERE id = ANY(${uuids}::uuid[])
          AND has_files
    `;

    const available = new Set(rows.map((r) => r.id));
    for (const id of mediaIds) {
        result.set(id, available.has(id));
    }
    return result;
}

/**
 * Get availability details for a single media item.
 * Returns is_available (from has_files).
 */
export async function getAvailability(
    sql: postgres.Sql,
    mediaId: string,
): Promise<AvailabilityResult> {
    const rows = await sql<[AvailabilityResult]>`
        SELECT
            mi.has_files AS is_available
        FROM media_items mi
        WHERE mi.id = ${mediaId}
    `;
    return rows[0] ?? { is_available: false };
}
