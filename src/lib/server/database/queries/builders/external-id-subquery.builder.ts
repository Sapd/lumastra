// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External ID Subquery Builder
 *
 * Build scalar subqueries for external ID lookups using postgres.js template fragments.
 * These prevent row multiplication from JOINs and are the preferred pattern for fetching external IDs.
 *
 * All functions now accept `sql: postgres.Sql` and return template fragments that can be
 * composed into larger queries without requiring sql.unsafe().
 *
 * @module builders/external-id-subquery
 */

import type postgres from 'postgres';
import {
    getPrimaryExternalIdProvider,
    type ExternalIdProvider,
} from '../../../utils/provider-config.js';

// =============================================================================
// CORE FRAGMENT BUILDERS
// =============================================================================

/**
 * Build a scalar subquery for external ID with custom media_id expression.
 * Use when the media_id is not simply `mi.id`.
 *
 * @param sql - Postgres SQL client instance
 * @param mediaIdExpr - Expression for media_id lookup as a template fragment
 * @param provider - External ID provider name
 * @param castToInt - Whether to cast result to integer (for TMDB IDs)
 * @returns SQL subquery template fragment
 *
 * @example
 * const subquery = buildExternalIdSubquery(sql, sql`ur.media_id`, 'tmdb');
 * const query = sql`SELECT ${subquery} as tmdb_id FROM user_ratings ur`;
 *
 * @example
 * // With integer cast
 * const subquery = buildExternalIdSubquery(sql, sql`mi.id`, 'tmdb', true);
 */
export function buildExternalIdSubquery(
    sql: postgres.Sql,
    mediaIdExpr: postgres.PendingQuery<postgres.Row[]>,
    provider: ExternalIdProvider,
    castToInt = false,
): postgres.PendingQuery<postgres.Row[]> {
    if (castToInt) {
        return sql`(SELECT external_id::integer FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${provider} LIMIT 1)`;
    }
    return sql`(SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${provider} LIMIT 1)`;
}

/**
 * External ID subquery result type.
 */
export interface ExternalIdSubqueries {
    /** Primary external ID as text (returns empty string if not found) */
    primaryExtId: postgres.PendingQuery<postgres.Row[]>;
    /** Primary external ID as text or NULL */
    primaryExtIdNullable: postgres.PendingQuery<postgres.Row[]>;
    /** IMDB ID as text */
    imdbId: postgres.PendingQuery<postgres.Row[]>;
    /** Jellyfin ID as text */
    jellyfinId: postgres.PendingQuery<postgres.Row[]>;
    /** Jellyseerr ID as text */
    jellyseerrId: postgres.PendingQuery<postgres.Row[]>;
}

/**
 * Build scalar subquery template fragments for external IDs.
 * Uses LIMIT 1 subqueries instead of JOINs to prevent row multiplication
 * when external_ids has multiple rows per (media_id, provider).
 *
 * This is the PREFERRED pattern for fetching external IDs in SELECT clauses.
 * Use these instead of LEFT JOIN external_ids to avoid duplicate rows.
 *
 * @param sql - Postgres SQL client instance
 * @param mediaIdExpr - Expression for media_id lookup (template fragment)
 * @returns Object with template fragments for each provider
 *
 * @example
 * // Replace JOIN-based query:
 * // FROM media_items mi
 * // LEFT JOIN external_ids tmdb_ext ON tmdb_ext.media_id = mi.id AND tmdb_ext.provider = 'tmdb'
 * // SELECT tmdb_ext.external_id as tmdb_id
 *
 * // With scalar subquery:
 * const extIds = buildExternalIdSubqueries(sql, sql`mi.id`);
 * const query = sql`SELECT ${extIds.primaryExtId} as primary_ext_id, ${extIds.imdbId} as imdb_id FROM media_items mi`;
 */
export function buildExternalIdSubqueries(
    sql: postgres.Sql,
    mediaIdExpr: postgres.PendingQuery<postgres.Row[]>,
): ExternalIdSubqueries {
    return {
        primaryExtId: sql`COALESCE((SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '')`,
        primaryExtIdNullable: sql`(SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1)`,
        imdbId: sql`(SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = 'imdb' LIMIT 1)`,
        jellyfinId: sql`(SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = 'jellyfin' LIMIT 1)`,
        jellyseerrId: sql`(SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = 'jellyseerr' LIMIT 1)`,
    };
}

/**
 * Pre-built external ID subqueries factory for common mi.id pattern.
 * Use for queries with standard `FROM media_items mi` join.
 *
 * @param sql - Postgres SQL client instance
 * @returns External ID subqueries for mi.id
 */
export function prebuiltExternalIdSubqueries(sql: postgres.Sql): ExternalIdSubqueries {
    return buildExternalIdSubqueries(sql, sql`mi.id`);
}

// =============================================================================
// EXISTS CHECKS
// =============================================================================

/**
 * External ID EXISTS check result type.
 */
export interface ExternalIdExistsChecks {
    /** Check if TMDB ID exists */
    hasTmdb: postgres.PendingQuery<postgres.Row[]>;
    /** Check if TMDB ID does NOT exist */
    notHasTmdb: postgres.PendingQuery<postgres.Row[]>;
    /** Check if IMDB ID exists */
    hasImdb: postgres.PendingQuery<postgres.Row[]>;
    /** Check if IMDB ID does NOT exist */
    notHasImdb: postgres.PendingQuery<postgres.Row[]>;
    /** Check if Jellyfin ID exists */
    hasJellyfin: postgres.PendingQuery<postgres.Row[]>;
    /** Check if Jellyfin ID does NOT exist */
    notHasJellyfin: postgres.PendingQuery<postgres.Row[]>;
    /** Check if Jellyseerr ID exists */
    hasJellyseerr: postgres.PendingQuery<postgres.Row[]>;
    /** Check if Jellyseerr ID does NOT exist */
    notHasJellyseerr: postgres.PendingQuery<postgres.Row[]>;
    /** Check if primary external ID exists (based on getPrimaryExternalIdProvider()) */
    hasPrimaryExt: postgres.PendingQuery<postgres.Row[]>;
    /** Check if primary external ID does NOT exist (based on getPrimaryExternalIdProvider()) */
    notHasPrimaryExt: postgres.PendingQuery<postgres.Row[]>;
    /** Generic function to build EXISTS check for any provider */
    forProvider: (provider: string, exists: boolean) => postgres.PendingQuery<postgres.Row[]>;
}

/**
 * Build EXISTS/NOT EXISTS check template fragments for external IDs.
 * Uses subqueries instead of LEFT JOIN ... IS NULL pattern to avoid row multiplication.
 *
 * This is the PREFERRED pattern for checking external ID existence in WHERE clauses.
 * Use these instead of LEFT JOIN external_ids + IS NULL checks.
 *
 * @param sql - Postgres SQL client instance
 * @param mediaIdExpr - Expression for media_id lookup (template fragment)
 * @returns Object with template fragments for existence checks
 *
 * @example
 * // Replace JOIN-based pattern:
 * // FROM media_items mi
 * // LEFT JOIN external_ids jf_ext ON jf_ext.media_id = mi.id AND jf_ext.provider = 'jellyfin'
 * // WHERE jf_ext.external_id IS NULL
 *
 * // With NOT EXISTS subquery:
 * const checks = buildExternalIdExistsChecks(sql, sql`mi.id`);
 * const query = sql`SELECT * FROM media_items mi WHERE ${checks.notHasJellyfin}`;
 *
 * @example
 * const checks = buildExternalIdExistsChecks(sql, sql`mi.id`);
 * const query = sql`SELECT * FROM media_items mi WHERE ${checks.hasJellyfin}`;
 */
export function buildExternalIdExistsChecks(
    sql: postgres.Sql,
    mediaIdExpr: postgres.PendingQuery<postgres.Row[]>,
): ExternalIdExistsChecks {
    const buildCheck = (
        provider: string,
        exists: boolean,
    ): postgres.PendingQuery<postgres.Row[]> => {
        if (exists) {
            return sql`EXISTS (SELECT 1 FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${provider})`;
        }
        return sql`NOT EXISTS (SELECT 1 FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${provider})`;
    };

    const primaryProvider = getPrimaryExternalIdProvider();

    return {
        hasTmdb: buildCheck('tmdb', true),
        notHasTmdb: buildCheck('tmdb', false),
        hasImdb: buildCheck('imdb', true),
        notHasImdb: buildCheck('imdb', false),
        hasJellyfin: buildCheck('jellyfin', true),
        notHasJellyfin: buildCheck('jellyfin', false),
        hasJellyseerr: buildCheck('jellyseerr', true),
        notHasJellyseerr: buildCheck('jellyseerr', false),
        hasPrimaryExt: buildCheck(primaryProvider, true),
        notHasPrimaryExt: buildCheck(primaryProvider, false),
        forProvider: buildCheck,
    };
}

/**
 * Pre-built EXISTS checks factory for common mi.id pattern.
 * Use for queries with standard `FROM media_items mi` join.
 *
 * @param sql - Postgres SQL client instance
 * @returns External ID EXISTS checks for mi.id
 */
export function prebuiltExternalIdExistsChecks(sql: postgres.Sql): ExternalIdExistsChecks {
    return buildExternalIdExistsChecks(sql, sql`mi.id`);
}

// =============================================================================
// EXCLUSION FILTERS
// =============================================================================

/**
 * External ID exclusion builder result type.
 */
export interface ExternalIdExclusions {
    /**
     * Build primary external ID exclusion expression (provider-agnostic, string IDs).
     * Returns expression like: COALESCE((subquery), '') != ALL(arrayParam)
     * @param ids - Array of external IDs to exclude
     */
    primaryExtNotIn: (ids: string[]) => postgres.PendingQuery<postgres.Row[]>;
    /**
     * Build primary external ID inclusion expression (provider-agnostic, string IDs).
     * Returns expression like: (subquery) = ANY(arrayParam)
     * @param ids - Array of external IDs to include
     */
    primaryExtIn: (ids: string[]) => postgres.PendingQuery<postgres.Row[]>;
    /**
     * Build TMDB ID exclusion expression.
     * Returns expression like: COALESCE((subquery), '') != ALL(arrayParam)
     * @param ids - Array of TMDB IDs to exclude
     * @deprecated Use primaryExtNotIn with string IDs
     */
    tmdbNotIn: (ids: number[]) => postgres.PendingQuery<postgres.Row[]>;
    /**
     * Build generic provider exclusion expression for text IDs.
     * @param provider - Provider name (e.g., 'imdb', 'jellyfin')
     * @param ids - Array of external IDs to exclude
     */
    providerNotIn: (provider: string, ids: string[]) => postgres.PendingQuery<postgres.Row[]>;
    /**
     * Build TMDB ID inclusion expression (for IN-style filters).
     * Returns expression like: (subquery) = ANY(arrayParam)
     * @param ids - Array of TMDB IDs to include
     * @deprecated Use primaryExtIn with string IDs
     */
    tmdbIn: (ids: number[]) => postgres.PendingQuery<postgres.Row[]>;
    /**
     * Build generic provider inclusion expression.
     * @param provider - Provider name
     * @param ids - Array of external IDs to include
     */
    providerIn: (provider: string, ids: string[]) => postgres.PendingQuery<postgres.Row[]>;
}

/**
 * Build exclusion template fragments for external IDs.
 * Useful for excluding items that match a list of external IDs.
 *
 * These patterns handle NULL correctly - items without the external ID
 * are NOT excluded (COALESCE to 0 ensures != ALL works correctly).
 *
 * @param sql - Postgres SQL client instance
 * @param mediaIdExpr - Expression for media_id lookup (template fragment)
 * @returns Object with template fragment builders for exclusion patterns
 *
 * @example
 * // Exclude items whose TMDB ID is in an exclusion list:
 * const exclusions = buildExternalIdExclusions(sql, sql`mi.id`);
 * const excludedTmdbIds = [550, 1399, 680];
 * const query = sql`
 *     SELECT * FROM media_items mi
 *     WHERE ${exclusions.tmdbNotIn(excludedTmdbIds)}
 * `;
 *
 * @example
 * // Include only items with specific Jellyfin IDs:
 * const exclusions = buildExternalIdExclusions(sql, sql`mi.id`);
 * const jellyfinIds = ['abc123', 'def456'];
 * const query = sql`
 *     SELECT * FROM media_items mi
 *     WHERE ${exclusions.providerIn('jellyfin', jellyfinIds)}
 * `;
 */
export function buildExternalIdExclusions(
    sql: postgres.Sql,
    mediaIdExpr: postgres.PendingQuery<postgres.Row[]>,
): ExternalIdExclusions {
    return {
        primaryExtNotIn: (ids: string[]) =>
            sql`COALESCE((SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') != ALL(${ids})`,
        primaryExtIn: (ids: string[]) =>
            sql`(SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) = ANY(${ids})`,
        /** @deprecated Use primaryExtNotIn with string IDs */
        tmdbNotIn: (ids: number[]) =>
            sql`COALESCE((SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') != ALL(${ids.map(String)})`,
        providerNotIn: (provider: string, ids: string[]) =>
            sql`COALESCE((SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${provider} LIMIT 1), '') != ALL(${ids})`,
        /** @deprecated Use primaryExtIn with string IDs */
        tmdbIn: (ids: number[]) =>
            sql`(SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) = ANY(${ids.map(String)})`,
        providerIn: (provider: string, ids: string[]) =>
            sql`(SELECT external_id FROM external_ids WHERE media_id = ${mediaIdExpr} AND provider = ${provider} LIMIT 1) = ANY(${ids})`,
    };
}

/**
 * Pre-built exclusion helpers factory for common mi.id pattern.
 * Use for queries with standard `FROM media_items mi` join.
 *
 * @param sql - Postgres SQL client instance
 * @returns External ID exclusion helpers for mi.id
 */
export function prebuiltExternalIdExclusions(sql: postgres.Sql): ExternalIdExclusions {
    return buildExternalIdExclusions(sql, sql`mi.id`);
}
