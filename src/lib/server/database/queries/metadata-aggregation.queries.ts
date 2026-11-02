// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Metadata Aggregation Query Module
 *
 * Aggregates metadata from multiple providers (tmdb, mdblist, jellyfin) into
 * an 'aggregated' row in provider_metadata, merging the best fields from each.
 *
 * This solves the problem where LATERAL JOIN picks ONE provider based on priority,
 * causing fields only in lower-priority providers (like rt_audience_score from mdblist)
 * to be lost.
 *
 * @module queries/metadata-aggregation
 */

import type postgres from 'postgres';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('MetadataAggregation');

// =============================================================================
// Provider-Neutral Genre Slugs
// =============================================================================

/**
 * Stable, provider-neutral slug for each TMDB genre ID.
 *
 * These slugs are intentionally NOT translated — they must be identical
 * regardless of UI locale so DB containment queries (`@> '["action"]'`) work
 * across all languages. The mapping covers every genre returned by the TMDB
 * movie and TV genre list endpoints (as of 2026-07).
 *
 * Movie-only IDs: 28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402,
 *                 9648, 10749, 878, 53, 10752, 37
 * TV-only IDs:    10759 (Action & Adventure), 10762 (Kids), 10763 (News),
 *                 10764 (Reality), 10765 (Sci-Fi & Fantasy), 10766 (Soap),
 *                 10767 (Talk), 10768 (War & Politics)
 */
export const TMDB_GENRE_SLUG_MAP: Readonly<Record<number, string>> = {
    // Movie genres
    28: 'action',
    12: 'adventure',
    16: 'animation',
    35: 'comedy',
    80: 'crime',
    99: 'documentary',
    18: 'drama',
    10751: 'family',
    14: 'fantasy',
    36: 'history',
    27: 'horror',
    10402: 'music',
    9648: 'mystery',
    10749: 'romance',
    878: 'science-fiction',
    53: 'thriller',
    10752: 'war',
    37: 'western',
    // TV genres
    10759: 'action-adventure',
    10762: 'kids',
    10763: 'news',
    10764: 'reality',
    10765: 'sci-fi-fantasy',
    10766: 'soap',
    10767: 'talk',
    10768: 'war-politics',
} as const;

/**
 * Map an array of TMDB numeric genre IDs to provider-neutral slugs.
 * IDs not present in the map are silently skipped so unknown genres
 * do not produce empty-string slugs that would corrupt containment queries.
 *
 * @param genreIds - Array of TMDB numeric genre IDs (e.g. [28, 878])
 * @returns Array of slugs (e.g. ["action", "science-fiction"])
 */
export function tmdbGenreIdsToSlugs(genreIds: number[]): string[] {
    const result: string[] = [];
    for (const id of genreIds) {
        const slug = TMDB_GENRE_SLUG_MAP[id];
        if (slug) result.push(slug);
    }
    return result;
}

/**
 * Normalize a keyword name to a provider-neutral slug.
 *
 * Rules: lower-case, replace runs of non-alphanumeric chars with a single
 * hyphen, trim leading/trailing hyphens, collapse multiple hyphens.
 * Consistent with common slug conventions; safe for JSONB containment queries.
 *
 * @param name - Raw keyword string (e.g. "Based on Novel", "time-travel")
 * @returns Slug (e.g. "based-on-novel", "time-travel")
 */
export function keywordNameToSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Map an array of raw keyword name strings to provider-neutral slugs.
 * Empty results are filtered out so malformed inputs don't produce
 * empty-string slugs.
 *
 * @param names - Raw keyword names (e.g. ["time travel", "based on novel"])
 * @returns Array of slugs (e.g. ["time-travel", "based-on-novel"])
 */
export function keywordNamesToSlugs(names: string[]): string[] {
    return names.map(keywordNameToSlug).filter((s) => s.length > 0);
}

// =============================================================================
// Field Priority Configuration
// =============================================================================

/**
 * Default field priority rules for metadata aggregation.
 *
 * Each field maps to an ordered array of providers to try.
 * The first provider with a non-null value wins.
 *
 * Fields NOT listed here will NOT be aggregated (provider-specific only).
 */
export const FIELD_PRIORITY_DEFAULT: Record<string, readonly string[]> = {
    // =========================================================================
    // MDBList-exclusive fields (only mdblist has these)
    // =========================================================================
    rt_audience_score: ['mdblist'],
    letterboxd_rating: ['mdblist'],
    letterboxd_votes: ['mdblist'],
    mdblist_score: ['mdblist'],
    mdblist_keywords: ['mdblist'],
    metacritic_score: ['mdblist'],
    trakt_score: ['mdblist'],
    mal_score: ['mdblist'],
    mal_votes: ['mdblist'],
    streaming_services: ['mdblist'],
    anime_genres: ['mdblist'],
    age_rating_numeric: ['mdblist'],

    // =========================================================================
    // TMDB-preferred fields (prefer TMDB, fall back to others)
    // =========================================================================
    imdb_rating: ['tmdb', 'mdblist', 'jellyfin'],
    rt_rating: ['tmdb', 'mdblist'],
    overview: ['tmdb', 'jellyfin', 'mdblist'],
    genres: ['tmdb', 'jellyfin'],
    keywords: ['tmdb', 'mdblist'],
    // Numeric TMDB keyword IDs — DB-backed browse/keywords matches on these.
    // Sourced from the tmdb provider row (discovery path writes it there); for
    // metadata-update-only items the IDs live on the aggregated row and are
    // carried forward by the preserve clause in aggregateMetadataForMedia.
    tmdb_keyword_ids: ['tmdb'],
    // Provider-neutral keyword slugs derived from keyword names at enrichment
    // time. Browse queries match on these instead of TMDB-specific IDs so any
    // provider that emits keyword_slugs participates — not only tmdb.
    keyword_slugs: ['tmdb', 'mdblist', 'jellyfin'],
    // Provider-neutral genre slugs derived from genre names at enrichment time.
    // Genre browse and recommendation queries prefer these over numeric IDs so
    // any provider that emits genre_slugs participates — not only tmdb.
    genre_slugs: ['tmdb', 'mdblist', 'jellyfin'],
    actors: ['tmdb', 'jellyfin'],
    // Structured cast (name + character + person id) for the detail API's
    // actors[].character / proxied actors[].profileUrl. The detail query reads
    // the highest-priority (aggregated) row, so `cast` MUST be aggregated or it
    // is invisible even when the tmdb source row has it. Only tmdb emits this
    // shape today; listed alongside jellyfin for symmetry with `actors`
    // (jellyfin simply never supplies it, so hasValue skips it).
    cast: ['tmdb', 'jellyfin'],
    directors: ['tmdb', 'jellyfin'],
    trailer_url: ['tmdb', 'jellyfin'],
    runtime_minutes: ['tmdb', 'jellyfin'],
    // popularity and vote_count are TMDB-specific scoring metrics; no
    // semantically equivalent field exists in other supported providers.
    popularity: ['tmdb'],
    vote_count: ['tmdb'],
    vote_average: ['tmdb', 'jellyfin'],
    release_date: ['tmdb', 'jellyfin'],
    certification: ['tmdb', 'jellyfin'],
    tagline: ['tmdb', 'jellyfin'],
    // original_language is a TMDB concept (ISO 639-1 original production language).
    // jellyfin does not expose an equivalent field.
    original_language: ['tmdb'],
    // production_countries, spoken_languages, budget, revenue are TMDB-exclusive
    // financial/locale fields not modelled by other supported providers.
    production_countries: ['tmdb'],
    spoken_languages: ['tmdb'],
    budget: ['tmdb'],
    revenue: ['tmdb'],
    status: ['tmdb', 'jellyfin'],
    homepage: ['tmdb', 'jellyfin'],
    imdb_id: ['tmdb', 'mdblist'],
    producers: ['tmdb', 'jellyfin'],
    writers: ['tmdb', 'jellyfin'],

    // =========================================================================
    // Image paths (provider-agnostic image handling)
    // poster_path/backdrop_path ARE populated on the 'tmdb' provider row (the
    // raw TMDB detail envelope carries both top-level, spread verbatim by
    // metadata-sync-single.service.ts). dual-embedding-generator.ts's
    // storeDualEmbedding also writes poster_path the same way, but has NO
    // production callers (embedding-only-generator.ts is the active path per
    // this file's own module comment) — exercised only by
    // embedding.integration.test.ts, so don't rely on it as a real source.
    // logo_path is derived (TMDB has no top-level field — see
    // metadata-sync-single.service.ts's pickTmdbLogoPath) and populated the
    // same way. still_path is populated per-episode by the season-structure,
    // absolute-numbering, and episode reconciliation services. profile_path
    // is person-scoped (cast member headshots), not an item-level field —
    // genuinely not populated here; kept for when a per-person aggregation
    // exists.
    // =========================================================================
    poster_path: ['tmdb', 'tvdb', 'jellyfin'],
    backdrop_path: ['tmdb', 'tvdb', 'jellyfin'],
    logo_path: ['tmdb', 'tvdb'],
    still_path: ['tmdb', 'tvdb'],
    profile_path: ['tmdb'],

    // =========================================================================
    // Series-specific fields
    // =========================================================================
    total_episodes: ['tmdb', 'jellyfin'],
    total_seasons: ['tmdb', 'jellyfin'],
    series_status: ['tmdb', 'jellyfin'],
    last_air_date: ['tmdb', 'jellyfin'],
    // next_episode_to_air is a structured TMDB object; jellyfin surfaces the
    // same information as a flat date string — include as a non-null fallback.
    next_episode_to_air: ['tmdb', 'jellyfin'],
    networks: ['tmdb', 'jellyfin'],
    created_by: ['tmdb', 'jellyfin'],
} as const;

/**
 * Media type-specific priority overrides.
 *
 * For certain media types (like anime), we may want different provider priorities.
 * These override the default priorities for specific fields.
 */
export const FIELD_PRIORITY_OVERRIDES: Record<string, Record<string, readonly string[]>> = {
    // For anime content, prefer MAL scores (via mdblist) over IMDB
    anime: {
        // MAL data comes through mdblist, so prefer mdblist for anime ratings
        imdb_rating: ['mdblist', 'tmdb', 'jellyfin'],
        vote_average: ['mdblist', 'tmdb', 'jellyfin'],
        // Anime-specific genres from mdblist are more accurate
        genres: ['mdblist', 'tmdb', 'jellyfin'],
    },
} as const;

// Plugin-derived field priorities (set by plugin loader after plugins initialize)
let _effectiveFieldPriorities: Record<string, readonly string[]> | null = null;

// DB-driven field authority override maps
let _fieldAuthorityOverride: Record<string, readonly string[]> | null = null;
let _fieldAuthorityAnimeOverride: Record<string, readonly string[]> | null = null;

/**
 * Map a provider DEFINITION id to the key its rows are stored under in
 * `provider_metadata`: 'tmdb-metadata-provider' → 'tmdb'. Same convention as
 * metadata-sync-single.service.ts, which derives the row key the scan path
 * writes. An id without the suffix (a test, an external plugin that already
 * uses its row key) passes through unchanged.
 */
export function providerIdToMetadataKey(providerId: string): string {
    return providerId.replace(/-metadata-provider$/, '').replace(/-metadata$/, '');
}

/**
 * Override the effective field priorities with plugin-manifest-derived config.
 * Called by the plugin system after metadata provider plugins are loaded.
 *
 * `priorities` names providers by DEFINITION id ('tmdb-metadata-provider'),
 * but the aggregator looks them up by `provider_metadata.provider` ('tmdb').
 * Unmapped, every field a manifest declares (overview, poster_path,
 * backdrop_path, vote_average, runtime_minutes, …) found no source row and
 * was left out of 'aggregated' — which the metadata lateral join reads
 * first. Prod hid it behind its legacy `provider_field_authorities` rows
 * (checked before this table); a fresh install has none, so its hero and
 * recommendation rows showed no description (2026-09-29).
 */
export function setEffectiveFieldPriorities(priorities: Record<string, readonly string[]>): void {
    // Manifests declare only the fields they author. A default field no
    // manifest names must keep its default chain, not vanish: replacing the
    // table outright silently dropped cast, keyword_slugs, genre_slugs,
    // tmdb_keyword_ids, age_rating_numeric, … from every aggregated row on
    // prod (2026-09-24 — name-only actors for 11,494 items).
    const merged: Record<string, readonly string[]> = { ...FIELD_PRIORITY_DEFAULT };
    for (const [field, chain] of Object.entries(priorities)) {
        // The manifest order leads; the default chain stays as fallback so a
        // declared field does not lose jellyfin/mdblist when tmdb lacks it.
        merged[field] = [
            ...new Set([
                ...chain.map(providerIdToMetadataKey),
                ...(FIELD_PRIORITY_DEFAULT[field] ?? []),
            ]),
        ];
    }
    _effectiveFieldPriorities = merged;
    logger.debug('Field priorities updated from plugin manifests', {
        fieldCount: Object.keys(priorities).length,
    });
}

/**
 * Get current effective field priorities.
 * Returns plugin-manifest-derived config if available, or FIELD_PRIORITY_DEFAULT fallback.
 */
export function getEffectiveFieldPriorities(): Record<string, readonly string[]> {
    return _effectiveFieldPriorities ?? FIELD_PRIORITY_DEFAULT;
}

/**
 * Set the field authority override from DB. Called by provider-config-loader.
 * @param defaultMap - field_name → provider[] for default (non-anime) priorities
 * @param animeMap - field_name → provider[] for anime-specific priorities
 */
export function setFieldAuthorityOverride(
    defaultMap: Record<string, readonly string[]>,
    animeMap: Record<string, readonly string[]>,
): void {
    _fieldAuthorityOverride = Object.keys(defaultMap).length > 0 ? defaultMap : null;
    _fieldAuthorityAnimeOverride = Object.keys(animeMap).length > 0 ? animeMap : null;
}

/**
 * Reset field authority caches (for testing or dynamic reconfiguration)
 */
export function resetFieldAuthorityCache(): void {
    _fieldAuthorityOverride = null;
    _fieldAuthorityAnimeOverride = null;
    _effectiveFieldPriorities = null;
}

/**
 * Get the effective field priority for a given field and media type.
 *
 * Checks DB-driven overrides first, then falls back to hard-coded defaults or plugin-derived priorities.
 *
 * @param field - The metadata field name
 * @param mediaType - The media type (optional, for type-specific overrides)
 * @param isAnime - Whether the content is anime (triggers anime-specific priorities)
 * @returns The provider priority array for this field
 */
export function getFieldPriority(
    field: string,
    mediaType?: string,
    isAnime?: boolean,
): readonly string[] | undefined {
    // Check for anime-specific override first (DB then hard-coded)
    if (isAnime) {
        if (_fieldAuthorityAnimeOverride?.[field]) {
            return _fieldAuthorityAnimeOverride[field];
        }
        if (FIELD_PRIORITY_OVERRIDES.anime?.[field]) {
            return FIELD_PRIORITY_OVERRIDES.anime[field];
        }
    }

    // Check for media type-specific override (hard-coded only, DB doesn't have these yet)
    if (mediaType && FIELD_PRIORITY_OVERRIDES[mediaType]?.[field]) {
        return FIELD_PRIORITY_OVERRIDES[mediaType][field];
    }

    // Check DB default override
    if (_fieldAuthorityOverride?.[field]) {
        return _fieldAuthorityOverride[field];
    }

    // Fall back to effective (plugin-derived or hard-coded) default
    return getEffectiveFieldPriorities()[field];
}

/**
 * Legacy export for backward compatibility
 */
export const FIELD_PRIORITY = FIELD_PRIORITY_DEFAULT;

/**
 * Get all unique providers referenced in effective field priorities.
 * Uses plugin-derived priorities if available, falls back to hard-coded defaults.
 */
export function getAllAggregatedProviders(): readonly string[] {
    return [...new Set(Object.values(getEffectiveFieldPriorities()).flat())];
}

/**
 * Check if a provider is used in any field priority rule.
 * Use this to avoid unnecessary aggregation triggers.
 */
export function isProviderUsedInAggregation(provider: string): boolean {
    return getAllAggregatedProviders().includes(provider);
}

/**
 * Stale data threshold in days - provider data older than this is considered stale
 */
const STALE_THRESHOLD_DAYS = 30;

// =============================================================================
// Types
// =============================================================================

interface ProviderMetadataRow {
    provider: string;
    metadata: Record<string, unknown>;
}

interface AggregationStats {
    updated: number;
    skipped: number;
    errors: number;
}

/**
 * Check if media content is anime based on genres.
 * Handles both string arrays and object arrays (e.g., {id, name} from TMDB).
 *
 * Note: Only checks for explicit "anime" genre, NOT "animation".
 * TMDB uses "Animation" for all animated content (Pixar, Disney, etc.),
 * which would cause false positives. The "anime" genre comes from MDBList
 * via the anime_genres field.
 */
function isAnimeContent(genres: unknown[] | null): boolean {
    if (!genres || !Array.isArray(genres)) return false;
    // Only check for explicit "anime", not "animation" (which includes Western cartoons)
    const animeIndicators = ['anime'];

    return genres.some((g) => {
        // Handle string genres
        if (typeof g === 'string') {
            return animeIndicators.includes(g.toLowerCase());
        }
        // Handle object genres (e.g., { id: 123, name: "Animation" })
        if (g && typeof g === 'object' && 'name' in g) {
            const name = g.name;
            if (typeof name === 'string') {
                return animeIndicators.includes(name.toLowerCase());
            }
        }
        return false;
    });
}

/**
 * Detect if content is anime from provider metadata.
 * Checks anime_genres from mdblist first (most reliable), then falls back to genre checking.
 */
function detectAnimeFromProviders(providerData: Map<string, Record<string, unknown>>): boolean {
    const mdblistData = providerData.get('mdblist');

    // Check anime_genres from mdblist first (most reliable)
    const animeGenres = mdblistData?.anime_genres as unknown[] | undefined;
    if (animeGenres && Array.isArray(animeGenres) && animeGenres.length > 0) {
        return true;
    }

    // Fall back to checking genres for explicit "anime"
    const genres = (providerData.get('tmdb')?.genres ?? mdblistData?.genres) as
        unknown[] | undefined;
    return isAnimeContent(genres ?? null);
}

/**
 * Wildcard fields: if no listed provider in the priority chain supplies the
 * field, fall back to the first provider in the Map that has it. This lets
 * any plugin provider that emits keyword_slugs or genre_slugs participate in
 * aggregation even when it isn't listed in FIELD_PRIORITY_DEFAULT.
 */
const WILDCARD_FALLBACK_FIELDS = new Set(['keyword_slugs', 'genre_slugs']);

/**
 * Aggregate fields using media-type-aware priorities.
 */
function aggregateFieldsWithPriority(
    providerData: Map<string, Record<string, unknown>>,
    mediaType?: string,
    isAnime?: boolean,
): {
    aggregated: Record<string, unknown>;
    fieldSources: Record<string, string>;
} {
    const aggregated: Record<string, unknown> = {};
    const fieldSources: Record<string, string> = {};

    for (const field of Object.keys(getEffectiveFieldPriorities())) {
        const providers = getFieldPriority(field, mediaType, isAnime);
        if (!providers) continue;

        for (const provider of providers) {
            const metadata = providerData.get(provider);
            if (metadata && hasValue(metadata[field])) {
                aggregated[field] = metadata[field];
                fieldSources[field] = provider;
                break; // First provider with non-empty value wins
            }
        }

        // Wildcard fallback: for slug fields, if no listed provider supplied a
        // value, accept the value from any provider in the Map. This makes
        // non-TMDB providers that emit genre_slugs/keyword_slugs participate.
        if (!aggregated[field] && WILDCARD_FALLBACK_FIELDS.has(field)) {
            for (const [provider, metadata] of providerData) {
                if (hasValue(metadata[field])) {
                    aggregated[field] = metadata[field];
                    fieldSources[field] = provider;
                    break;
                }
            }
        }
    }

    return { aggregated, fieldSources };
}

/**
 * Check if a value is non-empty (not null, undefined, or empty array).
 * Empty strings are considered valid values.
 */
function hasValue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
}

/**
 * Aggregate fields using group-level priority overrides.
 * Group overrides take precedence for specified fields; non-overridden fields
 * use the global priority chain (which respects DB overrides, anime detection, etc.)
 */
export function aggregateFieldsWithGroupOverrides(
    providerData: Map<string, Record<string, unknown>>,
    groupOverrides: Record<string, string[]> | null,
    mediaType?: string,
    isAnime?: boolean,
): {
    aggregated: Record<string, unknown>;
    fieldSources: Record<string, string>;
} {
    const aggregated: Record<string, unknown> = {};
    const fieldSources: Record<string, string> = {};
    const hasGroupOverrides = groupOverrides && Object.keys(groupOverrides).length > 0;

    for (const field of Object.keys(getEffectiveFieldPriorities())) {
        // Group overrides take highest precedence for specified fields
        let providers: readonly string[] | undefined;
        if (hasGroupOverrides && groupOverrides[field]) {
            providers = groupOverrides[field];
        } else {
            providers = getFieldPriority(field, mediaType, isAnime);
        }
        if (!providers) continue;

        for (const provider of providers) {
            const metadata = providerData.get(provider);
            if (metadata && hasValue(metadata[field])) {
                aggregated[field] = metadata[field];
                fieldSources[field] = provider;
                break;
            }
        }

        // Wildcard fallback: for slug fields, if no listed provider supplied a
        // value, accept the value from any provider in the Map. This makes
        // non-TMDB providers that emit genre_slugs/keyword_slugs participate.
        if (!aggregated[field] && WILDCARD_FALLBACK_FIELDS.has(field)) {
            for (const [provider, metadata] of providerData) {
                if (hasValue(metadata[field])) {
                    aggregated[field] = metadata[field];
                    fieldSources[field] = provider;
                    break;
                }
            }
        }
    }

    return { aggregated, fieldSources };
}

// =============================================================================
// Core Aggregation Functions
// =============================================================================

/**
 * Aggregate metadata for a single media item.
 *
 * Reads all provider_metadata rows for the item, merges them according to
 * field priority rules (with media-type-aware overrides), and upserts an 'aggregated' row.
 *
 * @param sql - Postgres SQL client
 * @param mediaId - UUID of the media item
 * @param options - Optional overrides for media type detection
 */
export async function aggregateMetadataForMedia(
    sql: postgres.Sql,
    mediaId: string,
    options?: {
        mediaType?: string;
        isAnime?: boolean;
        groupOverrides?: Record<string, string[]> | null;
        /**
         * Bypass `metadata_locked` (C3, 2026-09-24 security review). Default
         * false — every background caller (mdblist-sync) must NOT rebuild a
         * locked item's 'aggregated' row. Only the admin single-item sync
         * paths (metadata-sync-single.service.ts, catalog.service.ts's
         * `storeProviderMetadata`) pass `force`, mirroring the `canWrite`
         * they already computed before deciding to write the source
         * provider row in the first place — otherwise the source row gets
         * force-written but 'aggregated' silently stays stale.
         */
        force?: boolean;
    },
): Promise<void> {
    const force = options?.force ?? false;
    // Fetch all provider metadata rows for this media item
    const rows = await sql<ProviderMetadataRow[]>`
        SELECT provider, metadata
        FROM provider_metadata
        WHERE media_id = ${mediaId}::uuid
          AND provider != 'aggregated'
    `;

    if (rows.length === 0) {
        // No provider data to aggregate
        return;
    }

    // Build provider lookup map
    const providerData = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
        providerData.set(row.provider, row.metadata);
    }

    // Determine media type and anime status if not provided
    let mediaType = options?.mediaType;
    let isAnime = options?.isAnime;

    if (mediaType === undefined) {
        // Get media_type from media_items table
        const mediaInfo = await sql<{ media_type: string }[]>`
            SELECT media_type FROM media_items WHERE id = ${mediaId}::uuid
        `;
        mediaType = mediaInfo[0]?.media_type;
    }

    if (isAnime === undefined) {
        isAnime = detectAnimeFromProviders(providerData);
    }

    // Aggregate fields — use group overrides if provided, otherwise media-type-aware priorities
    const { aggregated, fieldSources } = options?.groupOverrides
        ? aggregateFieldsWithGroupOverrides(
              providerData,
              options.groupOverrides,
              mediaType,
              isAnime,
          )
        : aggregateFieldsWithPriority(providerData, mediaType, isAnime);

    // Skip if nothing to aggregate
    if (Object.keys(aggregated).length === 0) {
        return;
    }

    // Upsert aggregated row. Skips `metadata_locked` items unless `force`
    // (C3, 2026-09-24 security review) — atomic with the write via the same
    // SELECT-from-media_items + ON CONFLICT WHERE shape used elsewhere in
    // this module and in media-upsert.ts's upsertProviderMetadataUnlessLocked.
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, field_sources, fetched_at, updated_at)
        SELECT mi.id, 'aggregated',
            ${sql.json(aggregated as Record<string, never>)},
            ${sql.json(fieldSources)},
            NOW(), NOW()
        FROM media_items mi
        WHERE mi.id = ${mediaId}::uuid AND (${force} OR NOT mi.metadata_locked)
        ON CONFLICT (media_id, provider) DO UPDATE SET
            -- Full-replace from source rows, BUT carry forward enrichment-only
            -- keys that syncMissingMetadata merges straight onto the aggregated
            -- row (it does not write a source provider row). Without this, a
            -- later aggregation run (e.g. triggered by mdblist-sync) would wipe
            -- tmdb_keyword_ids / keyword_slugs / genre_slugs and silently empty
            -- DB-backed browse queries.
            metadata = EXCLUDED.metadata
                || CASE
                    WHEN jsonb_typeof(provider_metadata.metadata) = 'object'
                    THEN COALESCE(
                        (
                            SELECT jsonb_object_agg(key, value)
                            FROM jsonb_each(provider_metadata.metadata)
                            WHERE key IN ('tmdb_keyword_ids', 'keyword_slugs', 'genre_slugs')
                              AND NOT (EXCLUDED.metadata ? key)
                        ),
                        '{}'::jsonb
                    )
                    ELSE '{}'::jsonb
                END,
            field_sources = EXCLUDED.field_sources,
            updated_at = NOW()
        WHERE ${force} OR NOT EXISTS (
            SELECT 1 FROM media_items locked_check
            WHERE locked_check.id = provider_metadata.media_id
                AND locked_check.metadata_locked
        )
    `;
}

/**
 * Batch aggregate metadata for multiple media items.
 *
 * Processes items in batches to avoid overwhelming the database.
 * Uses media-type-aware priority rules (e.g., anime gets MAL scores via mdblist).
 *
 * @param sql - Postgres SQL client
 * @param mediaIds - Array of media UUIDs to aggregate
 * @param batchSize - Number of items per batch (default: 100)
 * @returns Statistics on the aggregation run
 */
/**
 * Set-based upsert of aggregated `provider_metadata` rows (H14). One statement
 * for the whole batch instead of one INSERT per media — cuts network round-trips
 * and per-statement planning/overhead (~30-40% on the write path). The per-row
 * AFTER triggers (`trg_provider_metadata_quality` / `_people`) still fire once
 * per affected row, so quality/people-sync semantics are UNCHANGED. Uses the
 * exact same enrichment-only preserve clause as the per-item path so a batch run
 * can't wipe keyword/genre slugs written straight onto the aggregated row.
 *
 * Skips `metadata_locked` ids (C3, 2026-09-24 security review): every caller
 * of `batchAggregateMetadata` is a background/bulk task (tmdb sweep, cast
 * backfill, missing-metadata sync, aggregation backfill) — none pass an
 * admin-force override — so a locked item's 'aggregated' row must not be
 * rebuilt here. The guard lives in the SQL (both the INSERT…SELECT source and
 * the ON CONFLICT DO UPDATE predicate) rather than in the caller, so it can't
 * be bypassed by a future caller that forgets to pre-filter its id list.
 */
async function upsertAggregatedRowsBatch(
    sql: postgres.Sql,
    rows: {
        mediaId: string;
        aggregated: Record<string, unknown>;
        fieldSources: Record<string, unknown>;
    }[],
): Promise<void> {
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.mediaId);
    const metas = rows.map((r) => JSON.stringify(r.aggregated));
    const fsrcs = rows.map((r) => JSON.stringify(r.fieldSources));
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, field_sources, fetched_at, updated_at)
        SELECT t.media_id::uuid, 'aggregated', t.metadata::jsonb, t.field_sources::jsonb, NOW(), NOW()
        FROM unnest(${ids}::text[], ${metas}::text[], ${fsrcs}::text[])
            AS t(media_id, metadata, field_sources)
        JOIN media_items mi ON mi.id = t.media_id::uuid AND mi.metadata_locked = false
        ON CONFLICT (media_id, provider) DO UPDATE SET
            metadata = EXCLUDED.metadata
                || CASE
                    WHEN jsonb_typeof(provider_metadata.metadata) = 'object'
                    THEN COALESCE(
                        (
                            SELECT jsonb_object_agg(key, value)
                            FROM jsonb_each(provider_metadata.metadata)
                            WHERE key IN ('tmdb_keyword_ids', 'keyword_slugs', 'genre_slugs')
                              AND NOT (EXCLUDED.metadata ? key)
                        ),
                        '{}'::jsonb
                    )
                    ELSE '{}'::jsonb
                END,
            field_sources = EXCLUDED.field_sources,
            updated_at = NOW()
        WHERE NOT EXISTS (
            SELECT 1 FROM media_items locked_check
            WHERE locked_check.id = provider_metadata.media_id
                AND locked_check.metadata_locked
        )
    `;
}

export async function batchAggregateMetadata(
    sql: postgres.Sql,
    mediaIds: string[],
    batchSize: number = 100,
    groupOverrides?: Record<string, string[]> | null,
): Promise<AggregationStats> {
    const stats: AggregationStats = {
        updated: 0,
        skipped: 0,
        errors: 0,
    };

    if (mediaIds.length === 0) {
        return stats;
    }

    logger.info('Starting batch metadata aggregation', {
        totalItems: mediaIds.length,
        batchSize,
    });

    // Process in batches
    for (let i = 0; i < mediaIds.length; i += batchSize) {
        const batchIds = mediaIds.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(mediaIds.length / batchSize);

        logger.debug(`Processing batch ${batchNumber}/${totalBatches}`, {
            batchSize: batchIds.length,
        });

        // Fetch all provider metadata for this batch in one query
        const rows = await sql<(ProviderMetadataRow & { media_id: string })[]>`
            SELECT media_id::text, provider, metadata
            FROM provider_metadata
            WHERE media_id = ANY(${batchIds}::uuid[])
              AND provider != 'aggregated'
        `;

        // Fetch media type + lock info for the batch. metadata_locked is read
        // here (not just guarded in upsertAggregatedRowsBatch's SQL) so a
        // locked id is counted as `skipped` rather than `updated` — every
        // caller of this function is a background/bulk task with no
        // admin-force override, so a locked id must both (a) never have its
        // 'aggregated' row rebuilt and (b) never be reported as a successful
        // write (C3, 2026-09-24 security review).
        const mediaTypeRows = await sql<
            { id: string; media_type: string; metadata_locked: boolean }[]
        >`
            SELECT id::text, media_type, metadata_locked
            FROM media_items
            WHERE id = ANY(${batchIds}::uuid[])
        `;

        // Build media type + lock lookups
        const mediaTypeById = new Map<string, string>();
        const lockedById = new Set<string>();
        for (const row of mediaTypeRows) {
            mediaTypeById.set(row.id, row.media_type);
            if (row.metadata_locked) lockedById.add(row.id);
        }

        // Group provider rows by media_id
        const byMediaId = new Map<string, ProviderMetadataRow[]>();
        for (const row of rows) {
            const existing = byMediaId.get(row.media_id) || [];
            existing.push({ provider: row.provider, metadata: row.metadata });
            byMediaId.set(row.media_id, existing);
        }

        // Aggregate each media item in-memory, collect for one set-based upsert
        // per batch (H14 — fewer round-trips; per-row AFTER triggers still fire).
        const pending: {
            mediaId: string;
            aggregated: Record<string, unknown>;
            fieldSources: Record<string, unknown>;
        }[] = [];
        for (const mediaId of batchIds) {
            if (lockedById.has(mediaId)) {
                stats.skipped++;
                continue;
            }

            const providerRows = byMediaId.get(mediaId);
            if (!providerRows || providerRows.length === 0) {
                stats.skipped++;
                continue;
            }

            try {
                // Build provider lookup map
                const providerData = new Map<string, Record<string, unknown>>();
                for (const row of providerRows) {
                    providerData.set(row.provider, row.metadata);
                }

                // Get media type and detect anime from provider metadata
                const mediaType = mediaTypeById.get(mediaId);
                const isAnime = detectAnimeFromProviders(providerData);

                // Aggregate fields — use group overrides if provided, otherwise media-type-aware priorities
                const { aggregated, fieldSources } = groupOverrides
                    ? aggregateFieldsWithGroupOverrides(
                          providerData,
                          groupOverrides,
                          mediaType,
                          isAnime,
                      )
                    : aggregateFieldsWithPriority(providerData, mediaType, isAnime);

                if (Object.keys(aggregated).length === 0) {
                    stats.skipped++;
                    continue;
                }

                pending.push({ mediaId, aggregated, fieldSources });
            } catch (error) {
                logger.error('Failed to aggregate metadata', error as Error, {
                    mediaId,
                });
                stats.errors++;
            }
        }

        // One set-based upsert for the whole batch. On failure, fall back to
        // per-row upserts so a single bad row doesn't fail the batch and error
        // attribution stays accurate.
        try {
            await upsertAggregatedRowsBatch(sql, pending);
            stats.updated += pending.length;
        } catch (batchError) {
            logger.warn('Batch aggregated upsert failed; falling back to per-row', {
                batchNumber,
                count: pending.length,
                error: batchError instanceof Error ? batchError.message : String(batchError),
            });
            for (const row of pending) {
                try {
                    await upsertAggregatedRowsBatch(sql, [row]);
                    stats.updated++;
                } catch (error) {
                    logger.error('Failed to aggregate metadata', error as Error, {
                        mediaId: row.mediaId,
                    });
                    stats.errors++;
                }
            }
        }

        logger.debug(`Batch ${batchNumber}/${totalBatches} completed`, {
            updated: stats.updated,
            skipped: stats.skipped,
            errors: stats.errors,
        });
    }

    logger.info('Batch metadata aggregation completed', stats);
    return stats;
}

/**
 * Get media items that need aggregation (missing or stale aggregated row).
 *
 * An item needs aggregation if:
 * 1. It has provider_metadata rows but no 'aggregated' row
 * 2. Its 'aggregated' row is older than any source provider row
 *
 * @param sql - Postgres SQL client
 * @param limit - Maximum items to return (default: 10000)
 * @returns Array of media UUIDs needing aggregation
 */
export async function getItemsNeedingAggregation(
    sql: postgres.Sql,
    limit: number = 10000,
): Promise<string[]> {
    const rows = await sql<{ media_id: string }[]>`
        WITH source_providers AS (
            -- Get latest update time for source providers per media_id
            SELECT
                media_id,
                MAX(updated_at) as latest_source_update
            FROM provider_metadata
            WHERE provider IN ${sql(getAllAggregatedProviders())}
            GROUP BY media_id
        ),
        aggregated_status AS (
            -- Get aggregated row status
            SELECT
                media_id,
                updated_at as aggregated_update
            FROM provider_metadata
            WHERE provider = 'aggregated'
        )
        SELECT sp.media_id::text
        FROM source_providers sp
        LEFT JOIN aggregated_status ag ON ag.media_id = sp.media_id
        WHERE
            -- No aggregated row exists
            ag.media_id IS NULL
            -- OR aggregated row is stale (older than source data)
            OR ag.aggregated_update < sp.latest_source_update
        ORDER BY sp.latest_source_update DESC
        LIMIT ${limit}
    `;

    return rows.map((r) => r.media_id);
}

/**
 * Aggregate metadata for items updated by a specific provider.
 *
 * This is useful after a batch sync (e.g., MDBList sync) to update
 * aggregated rows for all affected items.
 *
 * @param sql - Postgres SQL client
 * @param provider - Provider name (e.g., 'mdblist', 'tmdb')
 * @param sinceMinutesAgo - Only process items updated within this time window
 * @param batchSize - Number of items per batch
 * @returns Statistics on the aggregation run
 */
export async function aggregateRecentlyUpdatedProvider(
    sql: postgres.Sql,
    provider: string,
    sinceMinutesAgo: number = 60,
    batchSize: number = 100,
): Promise<AggregationStats> {
    const cutoff = new Date(Date.now() - sinceMinutesAgo * 60 * 1000);

    const rows = await sql<{ media_id: string }[]>`
        SELECT DISTINCT media_id::text
        FROM provider_metadata
        WHERE provider = ${provider}
          AND updated_at >= ${cutoff}
    `;

    const mediaIds = rows.map((r) => r.media_id);

    logger.info(`Found ${mediaIds.length} items with recent ${provider} updates to re-aggregate`);

    return batchAggregateMetadata(sql, mediaIds, batchSize);
}

/**
 * Get aggregation statistics for monitoring.
 *
 * @param sql - Postgres SQL client
 * @returns Object with counts of aggregated vs non-aggregated items
 */
export async function getAggregationStats(sql: postgres.Sql): Promise<{
    total_with_metadata: number;
    with_aggregated: number;
    without_aggregated: number;
    stale_aggregated: number;
}> {
    const result = await sql<
        {
            total_with_metadata: number;
            with_aggregated: number;
            without_aggregated: number;
            stale_aggregated: number;
        }[]
    >`
        WITH source_providers AS (
            SELECT
                media_id,
                MAX(updated_at) as latest_source_update
            FROM provider_metadata
            WHERE provider IN ${sql(getAllAggregatedProviders())}
            GROUP BY media_id
        ),
        aggregated_status AS (
            SELECT
                media_id,
                updated_at as aggregated_update
            FROM provider_metadata
            WHERE provider = 'aggregated'
        ),
        stats AS (
            SELECT
                COUNT(DISTINCT sp.media_id) as total_with_metadata,
                COUNT(ag.media_id) as with_aggregated,
                COUNT(DISTINCT sp.media_id) - COUNT(ag.media_id) as without_aggregated,
                COUNT(CASE WHEN ag.aggregated_update < sp.latest_source_update THEN 1 END) as stale_aggregated
            FROM source_providers sp
            LEFT JOIN aggregated_status ag ON ag.media_id = sp.media_id
        )
        SELECT * FROM stats
    `;

    return (
        result[0] || {
            total_with_metadata: 0,
            with_aggregated: 0,
            without_aggregated: 0,
            stale_aggregated: 0,
        }
    );
}

/**
 * Get detailed aggregation statistics including per-provider staleness.
 *
 * Provider data is considered stale if it hasn't been updated in STALE_THRESHOLD_DAYS.
 *
 * @param sql - Postgres SQL client
 * @returns Detailed statistics including per-provider stale counts
 */
export async function getDetailedAggregationStats(sql: postgres.Sql): Promise<{
    total_with_metadata: number;
    with_aggregated: number;
    without_aggregated: number;
    stale_aggregated: number;
    stale_by_provider: Record<string, number>;
    provider_counts: Record<string, number>;
}> {
    const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

    // Get basic aggregation stats
    const basicStats = await getAggregationStats(sql);

    // Get per-provider stale counts
    const staleRows = await sql<{ provider: string; stale_count: number }[]>`
        SELECT
            provider,
            COUNT(*) as stale_count
        FROM provider_metadata
        WHERE provider IN ${sql(getAllAggregatedProviders())}
          AND updated_at < ${staleCutoff}
        GROUP BY provider
    `;

    // Get total counts per provider
    const countRows = await sql<{ provider: string; total_count: number }[]>`
        SELECT
            provider,
            COUNT(*) as total_count
        FROM provider_metadata
        WHERE provider IN ${sql(getAllAggregatedProviders())}
        GROUP BY provider
    `;

    const stale_by_provider: Record<string, number> = {};
    for (const row of staleRows) {
        stale_by_provider[row.provider] = Number(row.stale_count);
    }

    const provider_counts: Record<string, number> = {};
    for (const row of countRows) {
        provider_counts[row.provider] = Number(row.total_count);
    }

    return {
        ...basicStats,
        stale_by_provider,
        provider_counts,
    };
}
