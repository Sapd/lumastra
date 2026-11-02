// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Query Builder
 *
 * Functions for building dynamic media queries using postgres.js template literals.
 * These are type-safe and SQL-injection-proof.
 *
 * @module builders/media-query
 */

import type postgres from 'postgres';
import { MediaQueryFragments } from '../fragments/base-media.fragments.js';
import { isAvailableExpr, canRequestExpr } from '../availability.queries.js';
import {
    buildMetadataProviderOrder,
    buildMetadataLateralJoin,
} from './provider-metadata.builder.js';
import {
    getMetadataProviderChain,
    getPrimaryExternalIdProvider,
} from '../../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '../../../utils/embedding-source.js';

/**
 * Options for building a media query.
 */
export interface MediaQueryOptions {
    /** Include metadata fields from provider_metadata */
    includeMetadata?: boolean;
    /** Include extended metadata (MDBList enrichment) */
    includeExtendedMetadata?: boolean;
    /** Include embedding vectors */
    includeEmbeddings?: boolean;
    /** Include availability information */
    includeAvailability?: boolean;
    /** Include IMDB external ID */
    includeImdbId?: boolean;
    /** Custom WHERE clause (without WHERE keyword) */
    whereClause?: string;
    /** ORDER BY clause (without ORDER BY keyword) */
    orderBy?: string;
    /** LIMIT value */
    limit?: number;
    /** OFFSET value */
    offset?: number;
    /** Provider chain for metadata (defaults to config if not specified) */
    providers?: string[];
    /**
     * Restrict to library-backed items (`has_files = true`).
     *
     * Library-scoped reads MUST set this so catalog ghosts (active metadata
     * with no files on disk — e.g. discovery rows) never leak as playable
     * cards. Leave unset only for discovery/aggregation reads that
     * intentionally include file-less items.
     */
    requireFiles?: boolean;
}

/**
 * Build a complete media query with common joins and fields.
 * This is a helper for constructing dynamic queries.
 *
 * @param options - Query options
 * @returns SQL query string (use with sql.unsafe() and proper parameterization)
 *
 * @example
 * const query = buildMediaQuery({
 *   includeMetadata: true,
 *   includeAvailability: true,
 *   whereClause: 'mi.media_type = $1',
 *   orderBy: 'mi.updated_at DESC',
 *   limit: 100
 * });
 * const results = await sql.unsafe(query, ['movie']);
 */
export function buildMediaQuery(options: MediaQueryOptions = {}): string {
    const selectParts: string[] = [MediaQueryFragments.baseMediaSelect];
    const joinParts: string[] = [
        // Use dynamic metadata lateral join with configurable provider chain
        buildMetadataLateralJoin(options.providers),
    ];
    const whereParts: string[] = [MediaQueryFragments.activeFilter];

    if (options.requireFiles) {
        whereParts.push(MediaQueryFragments.hasFilesFilter);
    }

    if (options.includeExtendedMetadata) {
        selectParts.push(MediaQueryFragments.extendedMetadataFields);
    } else if (options.includeMetadata) {
        selectParts.push(MediaQueryFragments.metadataFields);
    }

    if (options.includeEmbeddings) {
        selectParts.push(MediaQueryFragments.embeddings);
        joinParts.push(MediaQueryFragments.embeddingJoins);
    }

    if (options.includeAvailability) {
        selectParts.push(MediaQueryFragments.availabilityFields);
        joinParts.push(MediaQueryFragments.availabilityJoin);
    }

    if (options.includeImdbId) {
        selectParts.push(`imdb_ext.external_id AS imdb_id`);
        joinParts.push(MediaQueryFragments.imdbJoin);
    }

    if (options.whereClause) {
        whereParts.push(options.whereClause);
    }

    let query = `
        SELECT ${selectParts.join(',\n        ')}
        FROM media_items mi
        ${joinParts.join('\n        ')}
        WHERE ${whereParts.join(' AND ')}
    `;

    if (options.orderBy) {
        query += `\n        ORDER BY ${options.orderBy}`;
    }

    if (options.limit !== undefined) {
        query += `\n        LIMIT ${options.limit}`;
    }

    if (options.offset !== undefined) {
        query += `\n        OFFSET ${options.offset}`;
    }

    return query;
}

/**
 * Options for mediaSelectFields and mediaJoins functions.
 */
export interface MediaFieldOptions {
    metadata?: boolean;
    availability?: boolean;
    embeddings?: boolean;
    imdbId?: boolean;
    jellyfinId?: boolean;
}

/**
 * Build a typed SELECT clause for media items using postgres.js template literals.
 * This is the recommended way to build queries as it's type-safe and SQL-injection-proof.
 *
 * @param sql - Postgres SQL client
 * @param options - What fields to include
 * @returns SQL fragment for use in template literal
 *
 * @example
 * const results = await sql`
 *     SELECT ${mediaSelectFields(sql, { metadata: true, availability: true })}
 *     FROM media_items mi
 *     ${mediaJoins(sql, { metadata: true, availability: true })}
 *     WHERE mi.status = 'active'
 * `;
 */
export function mediaSelectFields(sql: postgres.Sql, options: MediaFieldOptions = {}) {
    const fields = [
        sql`mi.id AS media_id`,
        sql`primary_ext.external_id AS primary_ext_id`,
        sql`primary_ext.media_type`,
        sql`mi.title`,
        sql`mi.original_title`,
        sql`mi.year`,
        sql`mi.is_local_only`,
    ];

    if (options.metadata) {
        fields.push(
            sql`pm.metadata->>'poster_path' AS poster_path`,
            sql`pm.metadata->>'backdrop_path' AS backdrop_path`,
            sql`pm.metadata->>'overview' AS overview`,
            sql`CAST(pm.metadata->>'imdb_rating' AS FLOAT8) AS imdb_rating`,
            sql`CAST(pm.metadata->>'popularity' AS FLOAT8) AS popularity`,
            sql`CAST(pm.metadata->>'vote_count' AS INTEGER) AS vote_count`,
        );
    }

    if (options.availability) {
        fields.push(
            sql`${isAvailableExpr(sql)} AS is_available`,
            sql`(SELECT ei.external_id FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = 'jellyfin' LIMIT 1) AS jellyfin_id`,
            sql`${canRequestExpr(sql)} AS can_request`,
        );
    }

    if (options.embeddings) {
        fields.push(
            sql`jf_emb.embedding AS jellyfin_embedding`,
            sql`js_emb.embedding AS jellyseerr_embedding`,
        );
    }

    if (options.imdbId) {
        fields.push(sql`imdb_ext.external_id AS imdb_id`);
    }

    if (options.jellyfinId && !options.availability) {
        fields.push(sql`jf_ext.external_id AS jellyfin_id`);
    }

    // Join all fields - postgres.js handles this correctly
    return sql`${sql(fields.map((f) => sql`${f}`).join(', '))}`;
}

/**
 * Build JOIN clauses for media queries using postgres.js template literals.
 *
 * @param sql - Postgres SQL client
 * @param options - What tables to join
 * @returns SQL fragment for use in template literal
 */
export function mediaJoins(sql: postgres.Sql, options: MediaFieldOptions = {}) {
    // Primary external ID join (always included)
    let joins = sql`
        LEFT JOIN external_ids primary_ext ON mi.id = primary_ext.media_id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            AND primary_ext.is_primary = TRUE
    `;

    if (options.metadata) {
        // Use dynamic provider chain from configuration
        const providerChain = getMetadataProviderChain();
        const providerList = providerChain.map((p) => `'${p}'`).join(', ');
        const orderExpr = buildMetadataProviderOrder(providerChain);

        joins = sql`${joins}
        ${sql.unsafe(`LEFT JOIN LATERAL (
            SELECT metadata FROM provider_metadata
            WHERE media_id = mi.id AND provider IN (${providerList})
            ORDER BY ${orderExpr}
            LIMIT 1
        ) pm ON true`)}`;
    }

    // availability fields use correlated subqueries — no join needed

    if (options.embeddings) {
        joins = sql`${joins}
        LEFT JOIN media_embeddings jf_emb ON mi.id = jf_emb.media_id
            AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
        LEFT JOIN media_embeddings js_emb ON mi.id = js_emb.media_id
            AND js_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}`;
    }

    if (options.imdbId) {
        joins = sql`${joins}
        LEFT JOIN external_ids imdb_ext ON mi.id = imdb_ext.media_id
            AND imdb_ext.provider = 'imdb'`;
    }

    if (options.jellyfinId && !options.availability) {
        joins = sql`${joins}
        LEFT JOIN external_ids jf_ext ON mi.id = jf_ext.media_id
            AND jf_ext.provider = 'jellyfin'`;
    }

    return joins;
}

/**
 * Parsed media item with camelCase field names.
 */
export interface ParsedMediaItem {
    mediaId: string;
    primaryExtId: string;
    /**
     * Widened from 'movie' | 'tv': parseMediaRow maps an arbitrary
     * media_items row, and callers pass rows from queries that do not all
     * filter by type. Narrowing here mislabelled episodes as movies.
     */
    mediaType: 'movie' | 'tv' | 'episode' | 'season';
    title: string;
    originalTitle?: string;
    year?: number;
    isLocalOnly: boolean;
    posterPath?: string;
    backdropPath?: string;
    overview?: string;
    imdbRating?: number;
    popularity?: number;
    voteCount?: number;
    isAvailable?: boolean;
    jellyfinId?: string;
    canRequest?: boolean;
    genres?: number[];
    actors?: string[];
    directors?: string[];
}

/**
 * Parse a database row into a standardized media item object.
 * Use this to ensure consistent field naming and type handling across queries.
 *
 * @param row - Raw database row
 * @returns Parsed media item with camelCase field names
 */
export function parseMediaRow(row: Record<string, unknown>): ParsedMediaItem {
    return {
        mediaId: row.media_id as string,
        primaryExtId: row.primary_ext_id as string,
        mediaType: (row.media_type as ParsedMediaItem['mediaType']) || 'movie',
        title: row.title as string,
        originalTitle: row.original_title as string | undefined,
        year: row.year ? Number(row.year) : undefined,
        isLocalOnly: Boolean(row.is_local_only),
        posterPath: row.poster_path as string | undefined,
        backdropPath: row.backdrop_path as string | undefined,
        overview: row.overview as string | undefined,
        imdbRating: row.imdb_rating ? Number(row.imdb_rating) : undefined,
        popularity: row.popularity ? Number(row.popularity) : undefined,
        voteCount: row.vote_count ? Number(row.vote_count) : undefined,
        isAvailable: row.is_available !== undefined ? Boolean(row.is_available) : undefined,
        jellyfinId: row.jellyfin_id as string | undefined,
        canRequest: row.can_request !== undefined ? Boolean(row.can_request) : undefined,
        genres: row.genres as number[] | undefined,
        actors: row.actors as string[] | undefined,
        directors: row.directors as string[] | undefined,
    };
}
