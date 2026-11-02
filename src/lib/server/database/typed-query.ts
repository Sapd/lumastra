// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typed Query Utilities
 *
 * Provides type-safe wrappers for postgres.js queries without external dependencies.
 * This is a lightweight alternative to pgTyped that works with any SQL complexity
 * including pgvector, LATERAL joins, CTEs, and advisory locks.
 *
 * Usage:
 * ```typescript
 * interface GetUserRatingParams { userId: string; mediaId: string }
 * interface GetUserRatingResult { rating: number; created_at: Date }
 *
 * export const getUserRating = defineQuery<GetUserRatingParams, GetUserRatingResult>(
 *   'getUserRating',
 *   (sql, { userId, mediaId }) => sql`
 *     SELECT rating, created_at FROM user_ratings
 *     WHERE user_id = ${userId} AND media_id = ${mediaId}
 *   `
 * );
 *
 * // Call site is fully typed:
 * const rating = await getUserRating.one(sql, { userId: 'bob', mediaId: 'abc' });
 * ```
 */

import type postgres from 'postgres';

/**
 * A typed query definition that can be executed with parameters.
 */
export interface TypedQuery<TParams, TResult> {
    /** Query name for debugging/logging */
    readonly name: string;

    /**
     * Execute query and return all results.
     * @returns Array of typed results (empty array if no matches)
     */
    all(sql: postgres.Sql, params: TParams): Promise<TResult[]>;

    /**
     * Execute query and return first result or null.
     * @returns First result or null if no matches
     */
    one(sql: postgres.Sql, params: TParams): Promise<TResult | null>;

    /**
     * Execute query and return first result, throwing if not found.
     * @throws Error if no results
     */
    oneOrThrow(sql: postgres.Sql, params: TParams): Promise<TResult>;

    /**
     * Execute query and return count of affected/returned rows.
     * Useful for INSERT/UPDATE/DELETE operations.
     */
    count(sql: postgres.Sql, params: TParams): Promise<number>;
}

/**
 * A typed query for write operations (INSERT/UPDATE/DELETE).
 */
export interface TypedWriteQuery<TParams, TResult> extends TypedQuery<TParams, TResult> {
    /**
     * Execute write operation. Alias for `all()` but semantically clearer for writes.
     */
    execute(sql: postgres.Sql, params: TParams): Promise<TResult[]>;
}

/**
 * Define a typed read query.
 *
 * @param name - Query name for debugging
 * @param queryFn - Function that builds the query using postgres.js template literals
 * @returns Typed query object with execution methods
 *
 * @example
 * ```typescript
 * export const getMediaByTmdb = defineQuery<
 *   { tmdbId: number; mediaType: 'movie' | 'tv' },
 *   { id: string; title: string }
 * >('getMediaByTmdb', (sql, { tmdbId, mediaType }) => sql`
 *   SELECT mi.id, mi.title
 *   FROM media_items mi
 *   JOIN external_ids ei ON ei.media_id = mi.id
 *   WHERE ei.provider = 'tmdb'
 *     AND ei.external_id = ${String(tmdbId)}
 *     AND ei.media_type = ${mediaType}
 * `);
 * ```
 */
export function defineQuery<TParams, TResult>(
    name: string,
    queryFn: (sql: postgres.Sql, params: TParams) => postgres.PendingQuery<postgres.Row[]>,
): TypedQuery<TParams, TResult> {
    return {
        name,

        async all(sql: postgres.Sql, params: TParams): Promise<TResult[]> {
            const results = await queryFn(sql, params);
            return results as unknown as TResult[];
        },

        async one(sql: postgres.Sql, params: TParams): Promise<TResult | null> {
            const results = await queryFn(sql, params);
            return (results[0] as unknown as TResult) ?? null;
        },

        async oneOrThrow(sql: postgres.Sql, params: TParams): Promise<TResult> {
            const results = await queryFn(sql, params);
            if (results.length === 0) {
                throw new Error(`Query "${name}" returned no results`);
            }
            return results[0] as unknown as TResult;
        },

        async count(sql: postgres.Sql, params: TParams): Promise<number> {
            const results = await queryFn(sql, params);
            return results.length;
        },
    };
}

/**
 * Define a typed write query (INSERT/UPDATE/DELETE).
 *
 * @param name - Query name for debugging
 * @param queryFn - Function that builds the query using postgres.js template literals
 * @returns Typed write query object with execution methods
 *
 * @example
 * ```typescript
 * export const upsertUserRating = defineWriteQuery<
 *   { userId: string; mediaId: string; rating: number },
 *   { id: number; created_at: Date }
 * >('upsertUserRating', (sql, { userId, mediaId, rating }) => sql`
 *   INSERT INTO user_ratings (user_id, media_id, rating)
 *   VALUES (${userId}, ${mediaId}, ${rating})
 *   ON CONFLICT (user_id, media_id) DO UPDATE SET rating = EXCLUDED.rating
 *   RETURNING id, created_at
 * `);
 * ```
 */
export function defineWriteQuery<TParams, TResult>(
    name: string,
    queryFn: (sql: postgres.Sql, params: TParams) => postgres.PendingQuery<postgres.Row[]>,
): TypedWriteQuery<TParams, TResult> {
    const base = defineQuery<TParams, TResult>(name, queryFn);
    return {
        ...base,
        async execute(sql: postgres.Sql, params: TParams): Promise<TResult[]> {
            return base.all(sql, params);
        },
    };
}

/**
 * Define a query that returns a single scalar value.
 *
 * @param name - Query name for debugging
 * @param queryFn - Function that builds the query
 * @param extractor - Function to extract the scalar from the result row
 * @returns Function that returns the scalar value or null
 *
 * @example
 * ```typescript
 * export const getUserRatingCount = defineScalarQuery<
 *   { userId: string },
 *   number
 * >(
 *   'getUserRatingCount',
 *   (sql, { userId }) => sql`SELECT COUNT(*)::int as count FROM user_ratings WHERE user_id = ${userId}`,
 *   (row) => row.count
 * );
 * ```
 */
export function defineScalarQuery<TParams, TScalar>(
    name: string,
    queryFn: (sql: postgres.Sql, params: TParams) => postgres.PendingQuery<postgres.Row[]>,
    extractor: (row: Record<string, unknown>) => TScalar,
): {
    name: string;
    get(sql: postgres.Sql, params: TParams): Promise<TScalar | null>;
    getOrThrow(sql: postgres.Sql, params: TParams): Promise<TScalar>;
    getOrDefault(sql: postgres.Sql, params: TParams, defaultValue: TScalar): Promise<TScalar>;
} {
    return {
        name,

        async get(sql: postgres.Sql, params: TParams): Promise<TScalar | null> {
            const results = await queryFn(sql, params);
            if (results.length === 0) return null;
            return extractor(results[0]);
        },

        async getOrThrow(sql: postgres.Sql, params: TParams): Promise<TScalar> {
            const results = await queryFn(sql, params);
            if (results.length === 0) {
                throw new Error(`Scalar query "${name}" returned no results`);
            }
            return extractor(results[0]);
        },

        async getOrDefault(
            sql: postgres.Sql,
            params: TParams,
            defaultValue: TScalar,
        ): Promise<TScalar> {
            const results = await queryFn(sql, params);
            if (results.length === 0) return defaultValue;
            return extractor(results[0]);
        },
    };
}

/**
 * Define a query that checks for existence (returns boolean).
 *
 * @example
 * ```typescript
 * export const hasUserRated = defineExistsQuery<{ userId: string; mediaId: string }>(
 *   'hasUserRated',
 *   (sql, { userId, mediaId }) => sql`
 *     SELECT 1 FROM user_ratings
 *     WHERE user_id = ${userId} AND media_id = ${mediaId}
 *     LIMIT 1
 *   `
 * );
 *
 * const rated = await hasUserRated.check(sql, { userId: 'bob', mediaId: 'abc' });
 * // rated: boolean
 * ```
 */
export function defineExistsQuery<TParams>(
    name: string,
    queryFn: (sql: postgres.Sql, params: TParams) => postgres.PendingQuery<postgres.Row[]>,
): {
    name: string;
    check(sql: postgres.Sql, params: TParams): Promise<boolean>;
} {
    return {
        name,
        async check(sql: postgres.Sql, params: TParams): Promise<boolean> {
            const results = await queryFn(sql, params);
            return results.length > 0;
        },
    };
}

/**
 * Helper type for query result rows with common patterns.
 */
export interface BaseMediaRow {
    id: string; // Internal UUID
    title: string;
    media_type: 'movie' | 'tv';
}

export interface MediaRowWithTmdb extends BaseMediaRow {
    tmdb_id: number | null;
}

export interface MediaRowWithAvailability extends BaseMediaRow {
    is_available: boolean;
    can_request: boolean;
    jellyfin_id: string | null;
}

export interface MediaRowWithEmbedding extends BaseMediaRow {
    embedding: number[] | string | null;
    similarity?: number;
}
