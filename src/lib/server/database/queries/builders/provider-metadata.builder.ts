// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider Metadata Builder
 *
 * Build dynamic SQL for provider metadata queries based on configuration.
 * Supports configurable provider chains for metadata priority.
 *
 * This module provides three approaches to accessing provider metadata:
 *
 * 1. **View-based (recommended)**: Use `buildViewBasedMetadataJoin()` for simple queries.
 *    Leverages the `v_media_metadata` view which handles provider selection automatically.
 *
 * 2. **Override-aware LATERAL**: Use `buildOverrideAwareMetadataLateralJoin()` when you need
 *    more control but still want to respect per-media provider overrides.
 *
 * 3. **Standard LATERAL**: Use `buildMetadataLateralJoin()` for queries that don't need
 *    per-media override support (e.g., batch processing where performance matters).
 *
 * @module builders/provider-metadata
 */

import type postgres from 'postgres';
import { getMetadataProviderChain } from '../../../utils/provider-config.js';
import { Logger } from '../../../utils/logger.js';
import {
    ARTWORK_TYPE_TO_PROVIDER_KEYS,
    type MaterializableArtworkType,
} from '../../../utils/media-extras.js';

const logger = Logger.for('ProviderMetadataBuilder');

/**
 * Regex for safe provider names: lowercase alphanumeric + hyphens/underscores only.
 * Defense-in-depth: provider-config.ts already validates against an allowlist,
 * but this prevents SQL injection if that validation is ever bypassed.
 */
const SAFE_PROVIDER_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * Identifier pattern: dotted column references like 'mi.id', 'ur.media_id'.
 */
const IDENT = '[a-z_][a-z0-9_]*(\\.[a-z_][a-z0-9_]*)*';

/**
 * Regex for safe SQL expressions used as column references or simple function calls.
 * Allows:
 * - Dotted identifiers: 'mi.id', 'ur.media_id'
 * - COALESCE with dotted args: 'COALESCE(mi.edition_of, mi.id)'
 */
const SAFE_SQL_EXPR = new RegExp(`^(${IDENT}|COALESCE\\(${IDENT}(,\\s*${IDENT})*\\))$`, 'i');

/**
 * Regex for safe SQL parameter placeholders ($1, $2) or column references.
 * Used for parameters that accept either positional params or dotted identifiers.
 */
const SAFE_PARAM_OR_EXPR = /^(\$\d+|[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*)$/;

/**
 * Validate a provider name is safe for SQL interpolation.
 * Throws if the name contains anything that could be used for injection.
 */
function assertSafeProviderName(name: string): void {
    if (!SAFE_PROVIDER_NAME.test(name)) {
        throw new Error(
            `Unsafe provider name: "${name}". Only lowercase alphanumeric, hyphens, and underscores are allowed.`,
        );
    }
}

/**
 * Validate that a SQL expression is a safe column reference (e.g., 'mi.id').
 * Throws if it contains anything suspicious.
 */
function assertSafeSqlExpr(expr: string, label: string): void {
    if (!SAFE_SQL_EXPR.test(expr)) {
        throw new Error(
            `Unsafe SQL expression for ${label}: "${expr}". Only dotted identifiers are allowed.`,
        );
    }
}

/**
 * Validate every provider name in the chain and return it as a quoted, comma-joined
 * SQL list (`'a', 'b'`) — the single place the "validate before interpolating into
 * raw SQL" invariant lives for the `provider IN (…)` / `ARRAY[…]` clauses.
 */
function quoteProviderList(chain: string[]): string {
    chain.forEach(assertSafeProviderName);
    return chain.map((p) => `'${p}'`).join(', ');
}

/**
 * Cached provider array for template literal usage.
 * Use sparingly - prefer buildMetadataLateralJoin() for most queries.
 */
let _cachedProviderArray: string[] | null = null;

/**
 * Get the provider array for use in SQL queries.
 * Cached for performance.
 *
 * @returns Array of provider names in priority order (always includes 'aggregated' first)
 */
export function getProviderArray(): string[] {
    // getMetadataProviderChain() is itself cached per METADATA_PROVIDERS value;
    // re-read it so a saved chain change applies here without a restart.
    const chain = getMetadataProviderChain();
    if (!_cachedProviderArray || _cachedProviderArray.join(',') !== chain.join(',')) {
        _cachedProviderArray = chain;
    }
    return _cachedProviderArray;
}

/**
 * Reset the provider array cache.
 * Call this if provider configuration changes at runtime.
 */
export function resetProviderArrayCache(): void {
    _cachedProviderArray = null;
}

/**
 * Build a CASE expression for ordering provider metadata by priority.
 * Uses the configured provider chain from METADATA_PROVIDERS env var.
 *
 * @param providers - Array of provider names in priority order (optional, uses config if not provided)
 * @param alias - Table alias prefix for provider column (optional)
 * @returns SQL CASE expression string
 *
 * @example
 * // With config: METADATA_PROVIDERS=tmdb,mdblist
 * buildMetadataProviderOrder()
 * // Returns: "CASE WHEN provider = 'aggregated' THEN 0 WHEN provider = 'tmdb' THEN 1 WHEN provider = 'mdblist' THEN 2 ELSE 999 END"
 */
export function buildMetadataProviderOrder(providers?: string[], alias: string = ''): string {
    const chain = providers || getMetadataProviderChain();
    if (alias) assertSafeSqlExpr(alias, 'alias');
    return buildProviderPriorityCase(chain, alias ? `${alias}.provider` : 'provider');
}

/**
 * Canonical provider-priority `CASE` builder: ranks a source/provider column by the
 * given chain (index 0 = highest priority), everything else 999. The single source
 * of truth for the priority ordering used by every provider-resilient pick —
 * `buildMetadataProviderOrder` (provider_metadata.provider), the media_scalars
 * lateral (media_scalars.source), and the browse media_genres pick (mg.source).
 *
 * @param chain  - provider names in priority order (must already be resolved)
 * @param column - the SQL column expression to switch on (caller-controlled literal)
 * @returns `CASE WHEN <column> = '<p0>' THEN 0 … ELSE 999 END`, or `'0'` for an empty chain
 */
export function buildProviderPriorityCase(chain: string[], column: string): string {
    if (chain.length === 0) return '0';
    assertSafeSqlExpr(column, 'column');
    chain.forEach((p) => assertSafeProviderName(p));
    const cases = chain.map((p, i) => `WHEN ${column} = '${p}' THEN ${i}`);
    return `CASE ${cases.join(' ')} ELSE 999 END`;
}

/**
 * Build a LATERAL join for provider_metadata with dynamic provider chain.
 * This ensures queries use the configured provider priority.
 *
 * NOTE: This returns a plain string. For use in postgres.js template literals,
 * use buildMetadataLateralJoinFragment() instead which returns a proper SQL fragment.
 *
 * @param providers - Array of provider names to include (optional, uses config if not provided)
 * @param mediaIdExpr - Expression for media_id lookup (default: 'mi.id')
 * @returns SQL LATERAL JOIN string
 *
 * @example
 * // For sql.unsafe() contexts or raw SQL string building:
 * const lateralJoin = buildMetadataLateralJoin();
 * const query = sql.unsafe(`SELECT ... FROM media_items mi ${lateralJoin} WHERE ...`);
 *
 * @example
 * // For user_ratings table
 * const lateralJoin = buildMetadataLateralJoin(undefined, 'ur.media_id');
 */
export function buildMetadataLateralJoin(
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    excludeMediaType?: string,
): string {
    assertSafeSqlExpr(mediaIdExpr, 'mediaIdExpr');
    const chain = providers || getMetadataProviderChain();
    if (chain.length === 0) {
        logger.warn('Empty provider chain in buildMetadataLateralJoin');
        return '';
    }
    const providerList = quoteProviderList(chain);
    const orderExpr = buildMetadataProviderOrder(chain);
    let mediaTypeGuard = '';
    if (excludeMediaType !== undefined) {
        assertSafeProviderName(excludeMediaType);
        const tableAlias = mediaIdExpr.split('.')[0];
        mediaTypeGuard = ` AND ${tableAlias}.media_type != '${excludeMediaType}'`;
    }

    return `
        LEFT JOIN LATERAL (
            SELECT media_id, provider, metadata, fetched_at, updated_at
            FROM provider_metadata
            WHERE media_id = ${mediaIdExpr} AND provider IN (${providerList})${mediaTypeGuard}
            ORDER BY ${orderExpr}
            LIMIT 1
        ) pm ON true
    `;
}

/**
 * Build a LATERAL join for provider_metadata as a postgres.js SQL fragment.
 * Use this when interpolating into postgres.js template literals (sql`...`).
 *
 * This wraps buildMetadataLateralJoin() in sql.unsafe() to ensure the SQL
 * is treated as raw SQL rather than a parameterized string value.
 *
 * @param sql - Postgres SQL client instance
 * @param providers - Array of provider names to include (optional, uses config if not provided)
 * @param mediaIdExpr - Expression for media_id lookup (default: 'mi.id')
 * @returns postgres.js SQL fragment for use in template literals
 *
 * @example
 * // In postgres.js template literals:
 * const results = await sql`
 *     SELECT mi.id, mi.title
 *     FROM media_items mi
 *     ${buildMetadataLateralJoinFragment(sql)}
 *     WHERE mi.status = 'active'
 * `;
 *
 * @example
 * // With custom mediaIdExpr for user_ratings table:
 * const results = await sql`
 *     SELECT ur.rating, pm.metadata->>'title' as title
 *     FROM user_ratings ur
 *     ${buildMetadataLateralJoinFragment(sql, undefined, 'ur.media_id')}
 *     WHERE ur.user_id = ${userId}
 * `;
 */
export function buildMetadataLateralJoinFragment(
    sql: postgres.Sql,
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    excludeMediaType?: string,
): postgres.PendingQuery<postgres.Row[]> {
    return sql.unsafe(buildMetadataLateralJoin(providers, mediaIdExpr, excludeMediaType));
}

/**
 * The media_scalars columns exposed by the scalars lateral. `source` is included so
 * a caller can run genre/keyword subqueries (media_genres / media_keywords) against
 * the SAME winning provider the scalars were read from (`… AND source = ms.source`),
 * matching the old single-provider metadata pick exactly.
 */
const MEDIA_SCALARS_COLS =
    'source, mdblist_score, imdb_rating, vote_average, mal_score, popularity, runtime_minutes, ' +
    'release_year, release_date, first_air_date, rt_rating, rt_audience_score, overview, ' +
    'trailer_url, poster_path, backdrop_path, has_anime_genres';

/**
 * Build a LATERAL join that yields the highest-priority provider's row from the
 * normalized `media_scalars` projection (migration 16.124.0) — the typed-column
 * equivalent of `buildMetadataLateralJoin`, picking the same provider by the same
 * chain order but reading indexed native columns instead of detoasting metadata.
 * Exposes the media_scalars columns under `${alias}` (default `ms`).
 */
export function buildMediaScalarsLateralJoin(
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    alias: string = 'ms',
): string {
    assertSafeSqlExpr(mediaIdExpr, 'mediaIdExpr');
    if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`Unsafe alias: ${alias}`);
    const chain = providers || getMetadataProviderChain();
    if (chain.length === 0) {
        // Expose the columns as typed NULLs so callers referencing ${alias}.<col> compile.
        return `LEFT JOIN LATERAL (SELECT
            NULL::text source,
            NULL::int mdblist_score, NULL::numeric imdb_rating, NULL::numeric vote_average,
            NULL::numeric mal_score, NULL::numeric popularity, NULL::int runtime_minutes,
            NULL::int release_year, NULL::date release_date, NULL::date first_air_date,
            NULL::int rt_rating, NULL::int rt_audience_score, NULL::text overview,
            NULL::text trailer_url, NULL::text poster_path, NULL::text backdrop_path,
            false has_anime_genres) ${alias} ON true`;
    }
    const providerList = quoteProviderList(chain);
    return `
        LEFT JOIN LATERAL (
            SELECT ${MEDIA_SCALARS_COLS}
            FROM media_scalars
            WHERE media_id = ${mediaIdExpr} AND source IN (${providerList})
            ORDER BY ${buildProviderPriorityCase(chain, 'source')}
            LIMIT 1
        ) ${alias} ON true
    `;
}

/** postgres.js fragment wrapper for {@link buildMediaScalarsLateralJoin}. */
export function buildMediaScalarsLateralJoinFragment(
    sql: postgres.Sql,
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    alias: string = 'ms',
): postgres.PendingQuery<postgres.Row[]> {
    return sql.unsafe(buildMediaScalarsLateralJoin(providers, mediaIdExpr, alias));
}

/**
 * The "inverted scan" access path for media_scalars. The LATERAL form
 * ({@link buildMediaScalarsLateralJoin}) scans every candidate media_items row and
 * looks scalars up per-row, so the planner can't use the media_scalars column indexes —
 * a scalar range predicate (runtime_minutes < 90, release_date >= …) is applied only
 * AFTER the lateral. To let those predicates drive the scan, a rail instead reads
 * `FROM media_scalars ms JOIN media_items mi ON mi.id = ms.media_id …` (bitmap index
 * scans on the filtered columns) and ANDs in this predicate to keep only the rows that
 * ARE the winning provider for their media_id — exactly the row the LATERAL would have
 * picked. Equivalent to the LATERAL pick (verified EXCEPT both-ways on prod), ~12×
 * faster on scalar-range-filtered rails (short-movies: 216ms → 18ms on prod).
 *
 * Pass `preferredProviderExpr` (e.g. `'mi.preferred_provider'`) when replacing an
 * OVERRIDE-AWARE pick ({@link buildOverrideAwareMetadataLateralJoin}): the per-item
 * preferred provider then wins first, exactly as that LATERAL orders it
 * ({@link buildProviderChainOrderExpr}). Omitted, only the chain priority applies.
 *
 * @returns `<alias>.source = (SELECT … winning source … LIMIT 1)` — AND into the WHERE.
 */
export function buildWinningSourceScalarFilter(
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    alias: string = 'ms',
    preferredProviderExpr?: string,
): string {
    assertSafeSqlExpr(mediaIdExpr, 'mediaIdExpr');
    if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`Unsafe alias: ${alias}`);
    const chain = providers || getMetadataProviderChain();
    if (chain.length === 0) return 'true';
    const providerList = quoteProviderList(chain);
    const orderBy =
        preferredProviderExpr === undefined
            ? buildProviderPriorityCase(chain, 'w.source')
            : buildProviderChainOrderExpr(chain, 'w.source', preferredProviderExpr);
    return `${alias}.source = (
        SELECT w.source FROM media_scalars w
        WHERE w.media_id = ${mediaIdExpr} AND w.source IN (${providerList})
        ORDER BY ${orderBy}
        LIMIT 1
    )`;
}

/** postgres.js fragment wrapper for {@link buildWinningSourceScalarFilter}. */
export function buildWinningSourceScalarFilterFragment(
    sql: postgres.Sql,
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    alias: string = 'ms',
    preferredProviderExpr?: string,
): postgres.PendingQuery<postgres.Row[]> {
    return sql.unsafe(
        buildWinningSourceScalarFilter(providers, mediaIdExpr, alias, preferredProviderExpr),
    );
}

/**
 * `COALESCE(<alias>.metadata->>'<pathKey>', <alias>.metadata->'artwork'->>'<artworkKey>')`
 * — the single expression that reads an artwork path out of a provider_metadata
 * row. The key pair comes from the frozen ARTWORK_TYPE_TO_PROVIDER_KEYS map
 * (`thumb` -> `still_path`, NOT `thumb_path`), never from a `${type}_path`
 * template. Mirrors `catalog-operations.queries.ts:388-394`.
 */
export function buildProviderArtworkPathExpr(
    artworkType: MaterializableArtworkType,
    alias: string = 'pm',
): string {
    assertSafeSqlExpr(alias, 'alias');
    const keys = ARTWORK_TYPE_TO_PROVIDER_KEYS[artworkType];
    if (!keys) throw new Error(`Unsupported materializable artwork type: ${artworkType}`);
    return `COALESCE(${alias}.metadata->>'${keys.pathKey}', ${alias}.metadata->'artwork'->>'${keys.artworkKey}')`;
}

/** postgres.js fragment wrapper for {@link buildProviderArtworkPathExpr}. */
export function buildProviderArtworkPathExprFragment(
    sql: postgres.Sql,
    artworkType: MaterializableArtworkType,
    alias: string = 'pm',
): postgres.PendingQuery<postgres.Row[]> {
    return sql.unsafe(buildProviderArtworkPathExpr(artworkType, alias));
}

/**
 * The ORDER BY body that `buildOverrideAwareMetadataLateralJoin` (:571-583)
 * uses to pick its single winning provider_metadata row: the per-item
 * `preferred_provider` first, then the configured chain priority. Factored out
 * so an EXISTS-style predicate and a scalar read query can be provably
 * identical to the LATERAL.
 */
export function buildProviderChainOrderExpr(
    providers?: string[],
    providerColumn: string = 'pm.provider',
    preferredProviderExpr: string = 'mi.preferred_provider',
): string {
    assertSafeSqlExpr(providerColumn, 'providerColumn');
    assertSafeSqlExpr(preferredProviderExpr, 'preferredProviderExpr');
    const chain = providers || getMetadataProviderChain();
    return `CASE WHEN ${preferredProviderExpr} IS NOT NULL AND ${providerColumn} = ${preferredProviderExpr} THEN 0 ELSE 1 END, ${buildProviderPriorityCase(chain, providerColumn)}`;
}

/**
 * postgres.js fragment wrapper for {@link buildProviderChainOrderExpr}.
 *
 * Exists so the query module can write `ORDER BY ${fragment}` without a bare
 * `sql.unsafe()` call of its own — this file is the single place raw SQL text
 * is turned into a fragment (same reason every sibling builder has a
 * `*Fragment` twin).
 */
export function buildProviderChainOrderExprFragment(
    sql: postgres.Sql,
    providers?: string[],
    providerColumn: string = 'pm.provider',
    preferredProviderExpr: string = 'mi.preferred_provider',
): postgres.PendingQuery<postgres.Row[]> {
    return sql.unsafe(
        buildProviderChainOrderExpr(providers, providerColumn, preferredProviderExpr),
    );
}

/**
 * Eligibility predicate for the provider-artwork backfill: "does the WINNING
 * provider_metadata row for this item carry a path for <artworkType>?"
 *
 * Modelled on {@link buildWinningSourceScalarFilter} (:318) — pick the winning
 * row first (ORDER BY + LIMIT 1), then test it. A plain
 * `EXISTS (... provider IN (chain) AND path IS NOT NULL)` would admit an item
 * whose only path lives on a LOSING chain provider; the chain-ordered fetch
 * then finds nothing and the stage row can never complete, churning every
 * 60s sweep tick.
 *
 * The chain ALWAYS contains 'aggregated' ranked first
 * (`provider-config.ts:145-149`) and must — the LATERAL prefers it too, so
 * excluding it would make eligibility disagree with the fetch.
 *
 * @returns a WHERE-clause fragment over alias `mi` (or `mediaIdExpr`'s owner).
 */
export function buildWinningProviderArtworkPathFilter(
    artworkType: MaterializableArtworkType,
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    preferredProviderExpr: string = 'mi.preferred_provider',
): string {
    assertSafeSqlExpr(mediaIdExpr, 'mediaIdExpr');
    assertSafeSqlExpr(preferredProviderExpr, 'preferredProviderExpr');
    const chain = providers || getMetadataProviderChain();
    if (chain.length === 0) return 'false';
    const providerList = quoteProviderList(chain);
    const order = buildProviderChainOrderExpr(chain, 'pm.provider', preferredProviderExpr);
    const pathExpr = buildProviderArtworkPathExpr(artworkType, 'win');
    return `EXISTS (
        SELECT 1 FROM (
            SELECT pm.metadata
              FROM provider_metadata pm
             WHERE pm.media_id = ${mediaIdExpr}
               AND pm.provider IN (${providerList})
             ORDER BY ${order}
             LIMIT 1
        ) win
        WHERE ${pathExpr} IS NOT NULL
    )`;
}

/** postgres.js fragment wrapper for {@link buildWinningProviderArtworkPathFilter}. */
export function buildWinningProviderArtworkPathFilterFragment(
    sql: postgres.Sql,
    artworkType: MaterializableArtworkType,
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    preferredProviderExpr: string = 'mi.preferred_provider',
): postgres.PendingQuery<postgres.Row[]> {
    return sql.unsafe(
        buildWinningProviderArtworkPathFilter(
            artworkType,
            providers,
            mediaIdExpr,
            preferredProviderExpr,
        ),
    );
}

/**
 * Dynamic media query fragments interface.
 */
export interface DynamicMediaQueryFragments {
    /** LATERAL join for provider_metadata with dynamic priority (includes TMDB external_ids join) */
    metadataLateralJoin: string;
    /** ORDER BY expression for provider priority */
    providerOrder: string;
    /** List of enabled providers */
    providers: string[];
}

/**
 * Build provider JOIN clauses dynamically based on configuration.
 * Returns object with SQL fragments ready for use.
 *
 * @returns Object containing SQL fragments configured for current providers
 */
export function getDynamicMediaQueryFragments(): DynamicMediaQueryFragments {
    const providers = getMetadataProviderChain();

    return {
        metadataLateralJoin: buildMetadataLateralJoin(providers),
        providerOrder: buildMetadataProviderOrder(providers),
        providers,
    };
}

/**
 * Build provider filter clause for sql.unsafe() queries.
 * Uses ANY() for better index usage with multiple providers.
 *
 * @param providers - Array of provider names (optional, uses config if not provided)
 * @returns SQL filter clause like "provider = ANY(ARRAY['aggregated', 'tmdb']::text[])"
 *
 * @example
 * const filter = buildProviderFilterUnsafe();
 * const query = sql.unsafe(`
 *     SELECT * FROM provider_metadata
 *     WHERE media_id = $1 AND ${filter}
 * `, [mediaId]);
 */
export function buildProviderFilterUnsafe(providers?: string[]): string {
    const chain = providers || getProviderArray();
    if (chain.length === 0) {
        // Safety: never allow empty chain, fallback to defaults
        logger.warn('Empty provider chain, falling back to aggregated,tmdb');
        return `provider = ANY(ARRAY['aggregated', 'tmdb']::text[])`;
    }
    const providerList = quoteProviderList(chain);
    return `provider = ANY(ARRAY[${providerList}]::text[])`;
}

/**
 * Build provider ordering clause using array_position() for sql.unsafe() queries.
 * Alternative to CASE-based ordering - produces the same result, more compact.
 *
 * @param providers - Array of provider names (optional, uses config if not provided)
 * @param alias - Table alias prefix for provider column (optional, e.g., 'pm')
 * @returns SQL ORDER BY expression like "array_position(ARRAY['aggregated', 'tmdb']::text[], provider)"
 *
 * @example
 * const order = buildProviderOrderUnsafe(undefined, 'pm');
 * const query = sql.unsafe(`
 *     SELECT * FROM provider_metadata pm
 *     WHERE media_id = $1
 *     ORDER BY ${order}
 *     LIMIT 1
 * `, [mediaId]);
 */
export function buildProviderOrderUnsafe(providers?: string[], alias: string = ''): string {
    const chain = providers || getProviderArray();
    if (chain.length === 0) {
        // Safety: return constant if no providers (should never happen)
        return `0`;
    }
    if (alias) assertSafeSqlExpr(alias, 'alias');
    const providerList = quoteProviderList(chain);
    const prefix = alias ? `${alias}.` : '';
    return `array_position(ARRAY[${providerList}]::text[], ${prefix}provider)`;
}

/**
 * Build a complete provider metadata subquery for sql.unsafe() contexts.
 * Use when buildMetadataLateralJoin() can't be used (e.g., non-LATERAL queries).
 *
 * @param mediaIdParam - Parameter placeholder for media_id (e.g., '$1', '${mediaId}')
 * @param providers - Array of provider names (optional, uses config if not provided)
 * @returns SQL subquery string
 *
 * @example
 * const subquery = buildProviderMetadataSubquery('$1');
 * const query = sql.unsafe(`
 *     SELECT * FROM (${subquery}) pm
 *     WHERE pm.media_id = $1
 * `, [mediaId]);
 */
export function buildProviderMetadataSubquery(mediaIdParam: string, providers?: string[]): string {
    if (!SAFE_PARAM_OR_EXPR.test(mediaIdParam)) {
        throw new Error(
            `Unsafe SQL parameter for mediaIdParam: "${mediaIdParam}". Only positional params ($1) or dotted identifiers are allowed.`,
        );
    }
    const filter = buildProviderFilterUnsafe(providers);
    const order = buildProviderOrderUnsafe(providers);

    return `
        SELECT media_id, provider, metadata, fetched_at, updated_at
        FROM provider_metadata
        WHERE media_id = ${mediaIdParam} AND ${filter}
        ORDER BY ${order}
        LIMIT 1
    `;
}

// =============================================================================
// View-Based Provider Selection (v_media_metadata)
// =============================================================================

/**
 * Build a LEFT JOIN using the v_media_metadata view.
 * This is the preferred method for most queries as it:
 * - Automatically handles per-media provider overrides
 * - Respects global provider priority from provider_capabilities
 * - Is simpler and easier to read than LATERAL joins
 *
 * The view returns the following columns:
 * - media_id, title, year, media_type, preferred_provider
 * - effective_provider: The provider actually used
 * - metadata: JSONB metadata from that provider
 * - field_sources, fetched_at, metadata_updated_at
 *
 * @param mediaIdExpr - Expression for media_id lookup (default: 'mi.id')
 * @returns SQL JOIN string
 *
 * @example
 * // Basic usage
 * const join = buildViewBasedMetadataJoin();
 * // Returns: "LEFT JOIN v_media_metadata vm ON vm.media_id = mi.id"
 *
 * @example
 * // Usage in a query
 * const query = sql.unsafe(`
 *     SELECT mi.id, vm.metadata->>'title', vm.effective_provider
 *     FROM media_items mi
 *     ${buildViewBasedMetadataJoin()}
 *     WHERE mi.status = 'active'
 * `);
 */
export function buildViewBasedMetadataJoin(mediaIdExpr: string = 'mi.id'): string {
    assertSafeSqlExpr(mediaIdExpr, 'mediaIdExpr');
    return `LEFT JOIN v_media_metadata vm ON vm.media_id = ${mediaIdExpr}`;
}

/**
 * Build a LEFT JOIN using v_media_metadata as a postgres.js SQL fragment.
 * Use this when interpolating into postgres.js template literals (sql`...`).
 *
 * @param sql - Postgres SQL client instance
 * @param mediaIdExpr - Expression for media_id lookup (default: 'mi.id')
 * @returns postgres.js SQL fragment for use in template literals
 *
 * @example
 * const results = await sql`
 *     SELECT mi.id, vm.metadata->>'title' as title
 *     FROM media_items mi
 *     ${buildViewBasedMetadataJoinFragment(sql)}
 *     WHERE mi.status = 'active'
 * `;
 */
export function buildViewBasedMetadataJoinFragment(
    sql: postgres.Sql,
    mediaIdExpr: string = 'mi.id',
): postgres.PendingQuery<postgres.Row[]> {
    return sql.unsafe(buildViewBasedMetadataJoin(mediaIdExpr));
}

// =============================================================================
// Override-Aware LATERAL Joins
// =============================================================================

/**
 * Build a LATERAL join that respects per-media provider overrides.
 * Use this when the v_media_metadata view doesn't fit your needs
 * (e.g., complex subqueries, custom filtering).
 *
 * Priority order:
 * 1. Per-media override (mi.preferred_provider) - highest priority
 * 2. 'aggregated' provider - second priority
 * 3. Global provider chain order
 *
 * @param providers - Array of provider names (optional, uses config if not provided)
 * @param mediaIdExpr - Expression for media_id lookup (default: 'mi.id')
 * @param preferredProviderExpr - Expression for preferred_provider (default: 'mi.preferred_provider')
 * @returns SQL LATERAL JOIN string
 *
 * @example
 * // Basic usage
 * const join = buildOverrideAwareMetadataLateralJoin();
 * // Returns LATERAL join that checks mi.preferred_provider first
 *
 * @example
 * // Custom table alias
 * const join = buildOverrideAwareMetadataLateralJoin(
 *     undefined,
 *     'ur.media_id',
 *     'm.preferred_provider'
 * );
 */
export function buildOverrideAwareMetadataLateralJoin(
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    preferredProviderExpr: string = 'mi.preferred_provider',
): string {
    assertSafeSqlExpr(mediaIdExpr, 'mediaIdExpr');
    assertSafeSqlExpr(preferredProviderExpr, 'preferredProviderExpr');
    const chain = providers || getMetadataProviderChain();
    if (chain.length === 0) {
        logger.warn('Empty provider chain in buildOverrideAwareMetadataLateralJoin');
        return '';
    }
    const providerList = quoteProviderList(chain);
    const orderExpr = buildMetadataProviderOrder(chain);

    return `
        LEFT JOIN LATERAL (
            SELECT media_id, provider, metadata, field_sources, fetched_at, updated_at
            FROM provider_metadata
            WHERE media_id = ${mediaIdExpr}
              AND provider IN (${providerList})
            ORDER BY
                -- Per-media override gets highest priority
                CASE WHEN ${preferredProviderExpr} IS NOT NULL
                     AND provider = ${preferredProviderExpr} THEN 0 ELSE 1 END,
                -- Standard provider chain order
                ${orderExpr}
            LIMIT 1
        ) pm ON true
    `;
}

/**
 * Build an override-aware LATERAL join as a postgres.js SQL fragment.
 * Use this when interpolating into postgres.js template literals (sql`...`).
 *
 * @param sql - Postgres SQL client instance
 * @param providers - Array of provider names (optional, uses config if not provided)
 * @param mediaIdExpr - Expression for media_id lookup (default: 'mi.id')
 * @param preferredProviderExpr - Expression for preferred_provider (default: 'mi.preferred_provider')
 * @returns postgres.js SQL fragment for use in template literals
 *
 * @example
 * const results = await sql`
 *     SELECT mi.id, pm.metadata->>'title' as title
 *     FROM media_items mi
 *     ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
 *     WHERE mi.status = 'active'
 * `;
 */
export function buildOverrideAwareMetadataLateralJoinFragment(
    sql: postgres.Sql,
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    preferredProviderExpr: string = 'mi.preferred_provider',
): postgres.PendingQuery<postgres.Row[]> {
    return sql.unsafe(
        buildOverrideAwareMetadataLateralJoin(providers, mediaIdExpr, preferredProviderExpr),
    );
}

/**
 * Build an override-aware LATERAL join whose `metadata` column is a per-KEY
 * priority MERGE across providers, instead of a single provider's whole blob.
 *
 * The standard {@link buildOverrideAwareMetadataLateralJoin} picks ONE row
 * (LIMIT 1) — so a provider that wins the priority race while lacking a given
 * field blanks that field for the caller. This is a recurring footgun: the
 * `aggregated` provider is meant to be a complete merge of the source providers,
 * but when it goes stale/partial (e.g. it was computed while the `tmdb` row was
 * still sparse, then `tmdb` was later enriched with `overview`/`poster_path`)
 * it shadows the richer `tmdb` row and the detail modal renders no description,
 * no poster, no genres. (The normalized media_genres projection is the narrower,
 * genres-only answer to the same class of "aggregated shadows a richer provider" bug.)
 *
 * This variant instead exposes, for EACH key, the value from the highest-priority
 * provider that actually carries that key — so a sparse `aggregated` row only
 * contributes the keys it has and everything else falls through to `tmdb`/etc.
 * Provider/timestamp columns come from the top-priority row so the shape stays a
 * drop-in for the single-row join. Per-key `jsonb_each` makes this heavier than
 * the LIMIT 1 join — use it for single-item detail reads, NOT hot list queries.
 *
 * Exposes the same columns as {@link buildOverrideAwareMetadataLateralJoin}
 * (alias `pm`): media_id, provider, metadata, field_sources, fetched_at, updated_at.
 */
export function buildMergedMetadataLateralJoin(
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    preferredProviderExpr: string = 'mi.preferred_provider',
): string {
    assertSafeSqlExpr(mediaIdExpr, 'mediaIdExpr');
    assertSafeSqlExpr(preferredProviderExpr, 'preferredProviderExpr');
    const chain = providers || getMetadataProviderChain();
    if (chain.length === 0) {
        logger.warn('Empty provider chain in buildMergedMetadataLateralJoin');
        return '';
    }
    const providerList = quoteProviderList(chain);
    const overrideTop = `CASE WHEN ${preferredProviderExpr} IS NOT NULL AND provider = ${preferredProviderExpr} THEN 0 ELSE 1 END`;
    const overrideInner = `CASE WHEN ${preferredProviderExpr} IS NOT NULL AND pmx.provider = ${preferredProviderExpr} THEN 0 ELSE 1 END`;
    const chainOrderTop = buildMetadataProviderOrder(chain);
    const chainOrderInner = buildMetadataProviderOrder(chain, 'pmx');

    return `
        LEFT JOIN LATERAL (
            SELECT top.media_id, top.provider, top.field_sources, top.fetched_at,
                   top.updated_at, merged.metadata
            FROM (
                SELECT media_id, provider, field_sources, fetched_at, updated_at
                FROM provider_metadata
                WHERE media_id = ${mediaIdExpr} AND provider IN (${providerList})
                ORDER BY ${overrideTop}, ${chainOrderTop}
                LIMIT 1
            ) top
            CROSS JOIN LATERAL (
                SELECT jsonb_object_agg(kv.key, kv.value) AS metadata
                FROM (
                    SELECT DISTINCT ON (e.key) e.key, e.value
                    FROM provider_metadata pmx
                    CROSS JOIN LATERAL jsonb_each(pmx.metadata) e
                    WHERE pmx.media_id = ${mediaIdExpr} AND pmx.provider IN (${providerList})
                      -- jsonb_each() errors on a non-object; the single-row join
                      -- it replaces tolerated scalar/NULL metadata (->> returns
                      -- NULL), so guard to keep that graceful behavior.
                      AND jsonb_typeof(pmx.metadata) = 'object'
                      -- Skip empty values so a higher-priority provider that
                      -- carries the key but with no real content (null, '', [],
                      -- {}) doesn't shadow a lower-priority provider's real value
                      -- — matches the aggregation's hasValue() semantics.
                      AND e.value NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb)
                    ORDER BY e.key, ${overrideInner}, ${chainOrderInner}
                ) kv
            ) merged
        ) pm ON true
    `;
}

/**
 * Build a merged-metadata override-aware LATERAL join as a postgres.js SQL
 * fragment. See {@link buildMergedMetadataLateralJoin}.
 */
export function buildMergedMetadataLateralJoinFragment(
    sql: postgres.Sql,
    providers?: string[],
    mediaIdExpr: string = 'mi.id',
    preferredProviderExpr: string = 'mi.preferred_provider',
): postgres.PendingQuery<postgres.Row[]> {
    return sql.unsafe(
        buildMergedMetadataLateralJoin(providers, mediaIdExpr, preferredProviderExpr),
    );
}

/**
 * Result type for v_media_metadata view queries.
 * Use this when working with the view directly.
 */
export interface ViewMediaMetadataRow {
    media_id: string;
    title: string;
    year: number | null;
    media_type: string;
    preferred_provider: string | null;
    effective_provider: string | null;
    metadata: Record<string, unknown> | null;
    field_sources: Record<string, string> | null;
    fetched_at: Date | null;
    metadata_updated_at: Date | null;
}
