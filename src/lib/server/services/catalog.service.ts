// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Catalog Service
 *
 * Provides race-safe ID resolution for the media catalog.
 * Uses PostgreSQL advisory locks to prevent duplicate entries during concurrent requests.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import { captureEpisodeExchangeChoice } from '../database/queries/episode-exchange-choice.queries.js';
import {
    recordMediaChange,
    getMediaChange,
    markMediaChangeUndone,
    sameMediaChangeState,
    latestMediaChange,
} from '../database/queries/admin-media-change.queries.js';
import type postgres from 'postgres';
import type { MediaType, ExternalId, ExternalIdWrite } from '../providers/provider-types.js';
import { FieldAuthorityResolver } from '../plugins/runtime/field-authority-resolver.js';
import type { ProviderData } from '../plugins/runtime/field-authority-resolver.js';
import {
    buildFieldAuthorityConfigFromDefinitions,
    loadProviderSettingsCached,
} from '../plugins/runtime/field-authority-loader.js';
import {
    getProvidersByPriority,
    invokeProviderDetail,
    isProviderConfigured,
} from '../tasks/plugin-context.js';
import { encodeDetailId } from '../providers/encode-id.js';
import { normalizeDetail } from '../providers/normalize.js';
import { isSeries } from '$lib/server/utils/media-types.js';
import { Logger } from '../utils/logger.js';
import { normalizeJellyfinId } from '../utils/jellyfin-id.js';

/** Clamp year to valid range for PostgreSQL make_date (1–9999), return null otherwise */
function sanitizeYear(year: number | undefined | null): number | null {
    if (year == null || year < 1 || year > 9999) return null;
    return year;
}
import {
    getMediaItemById,
    findMediaIdByExternalId,
    getExternalIdsForMedia,
    getProviderMetadata as getProviderMetadataQuery,
    isMediaAvailable,
    batchResolveExternalIds,
} from '../database/queries/catalog-operations.queries.js';
import {
    aggregateMetadataForMedia,
    isProviderUsedInAggregation,
} from '../database/queries/metadata-aggregation.queries.js';
import { withTx } from '../database/with-tx.js';
import { refreshSortTitles } from '../database/queries/sort-title.queries.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';
import { insertAdminAuditEvent } from '../database/queries/admin-audit.queries.js';
import { config } from '../config.js';
import { applyNationalAgeRating } from '../database/queries/age-rating-source.queries.js';
import type { AuditActor } from '../utils/audit-log.js';

const logger = Logger.for('CatalogService');

export interface GetOrCreateResult {
    id: string; // UUID
    isNew: boolean;
}

interface FetchedMetadata {
    title: string;
    originalTitle?: string;
    englishTitle?: string;
    year?: number;
    /** National certification merged across providers (Jellyfin OfficialRating). */
    certification?: string;
    fieldSources: Record<string, string>;
}

// Type alias for SQL executor (works for both Sql and TransactionSql)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqlExecutor = postgres.Sql<any>;

/**
 * Catalog Service
 *
 * Manages the media catalog with UUID-based internal IDs and external ID mappings.
 * Provides thread-safe operations using PostgreSQL advisory locks.
 */
/**
 * How recently a rival external_id must have been written for `upsertExternalId`
 * to treat it as a LIVE competitor rather than a stale leftover.
 *
 * Within this window the incoming write is skipped (first writer wins); outside
 * it, the old row is a genuine leftover from a provider rescan and is replaced
 * as before. Chosen well above the ~0.4s flip period observed on prod and well
 * below the age of any real leftover.
 */
/**
 * `(provider, external_id, media_type)` is UNIQUE, so an id already owned by a
 * DIFFERENT media item cannot be taken. Thrown as a distinct type rather than a
 * bare Error because callers must be able to tell it apart: it is a DURABLE
 * conflict (two items genuinely claim one provider id — e.g. two chapters of one
 * film mapped to a single MAL entry), not a transient write failure. Treating it
 * as retryable makes the caller re-select the same item forever; fribb-anime-sync
 * did exactly that and logged 413,590 write errors in a single five-minute run
 * before its circuit breaker opened.
 *
 * Message text is unchanged, so anything already matching on it still works.
 */
export class ExternalIdOwnedByAnotherItemError extends Error {
    readonly provider: string;
    readonly externalId: string;
    readonly mediaType: string;
    readonly ownerMediaId: string;

    constructor(provider: string, externalId: string, mediaType: string, ownerMediaId: string) {
        super(
            `External ID ${provider}:${externalId} (${mediaType}) is already mapped to media item ${ownerMediaId}`,
        );
        this.name = 'ExternalIdOwnedByAnotherItemError';
        this.provider = provider;
        this.externalId = externalId;
        this.mediaType = mediaType;
        this.ownerMediaId = ownerMediaId;
    }
}

export class EpisodeTmdbExchangeError extends Error {
    constructor(
        readonly reason:
            | 'invalid_pair'
            | 'not_found'
            | 'wrong_type'
            | 'inactive'
            | 'other_series'
            | 'missing_id'
            | 'same_id'
            | 'outside_owner'
            | 'changed',
        message: string,
    ) {
        super(message);
        this.name = 'EpisodeTmdbExchangeError';
    }
}

export interface EpisodeTmdbExchangeSubject {
    id: string;
    title: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    tmdbId: string;
}

export interface EpisodeTmdbExchangePreview {
    series: { id: string; title: string };
    first: EpisodeTmdbExchangeSubject;
    second: EpisodeTmdbExchangeSubject;
    /** Hash of the complete reviewed state, including file links, protection and ancestry. */
    snapshot: string;
    undoId?: string;
}

interface ExchangeEpisodeRow {
    id: string;
    title: string;
    media_type: string;
    status: string;
    canonical_id: string | null;
    season_number: number | null;
    episode_number: number | null;
    season_id: string | null;
    season_type: string | null;
    season_status: string | null;
    season_canonical_id: string | null;
    series_id: string | null;
    series_title: string | null;
    series_type: string | null;
    series_status: string | null;
    series_canonical_id: string | null;
    episode_evidence: Record<string, unknown>;
    season_evidence: Record<string, unknown> | null;
    series_evidence: Record<string, unknown> | null;
}

interface ExchangeExternalIdRow {
    id: number;
    media_id: string;
    provider: string;
    external_id: string;
    media_type: string;
    is_primary: boolean | null;
    confidence: number | null;
    evidence: Record<string, unknown>;
}

const IDENTITY_SWAP_MIN_AGE_SECONDS = 300;

export class CatalogService {
    private skipLifecycleHooks: boolean;

    constructor(
        private sql: postgres.Sql,
        options?: { skipLifecycleHooks?: boolean },
    ) {
        this.skipLifecycleHooks = options?.skipLifecycleHooks ?? false;
    }

    /**
     * Generate stable 64-bit hash for advisory lock.
     * Uses SHA256 truncated to 64 bits for bounded, collision-resistant lock key.
     *
     * Note: readBigInt64BE returns signed BigInt, which is correct for
     * pg_advisory_xact_lock(bigint).
     */
    private hashExternalId(externalId: ExternalId): bigint {
        const input = `${externalId.provider}:${externalId.id}:${externalId.mediaType || ''}`;
        const hash = createHash('sha256').update(input).digest();
        return hash.readBigInt64BE(0); // Signed 64-bit, correct for Postgres bigint
    }

    /**
     * Get or create a media item by external ID.
     *
     * This method is race-safe: concurrent calls with the same external ID will
     * return the same UUID. Uses PostgreSQL advisory locks to prevent duplicates.
     *
     * @param externalId - The external ID to look up or create
     * @param mediaType - The media type (movie, tv, episode, season)
     * @returns The UUID and whether it was newly created
     */
    async getOrCreateByExternalId(
        externalId: ExternalId,
        mediaType: MediaType,
    ): Promise<GetOrCreateResult> {
        const lockKey = this.hashExternalId(externalId);

        // Pre-fetch metadata BEFORE acquiring the advisory lock.
        // Network calls (TMDB/MDBList, ~10s timeout) must not run inside a
        // transaction — they would hold the lock for the entire duration and
        // block every concurrent catalog write for this item.
        let rawProviderData: Record<string, unknown> | null = null;
        let aggregated: FetchedMetadata | null = null;

        try {
            const definitions = getProvidersByPriority();

            // Find the primary provider matching the requested provider short name
            const primaryDefinition = definitions.find(
                (d) =>
                    d.id === `${externalId.provider}-metadata-provider` ||
                    d.id.startsWith(externalId.provider),
            );

            const effectiveMediaType = externalId.mediaType || mediaType;
            const providerResults: ProviderData[] = [];
            const detailType: 'movie' | 'tv' = isSeries(effectiveMediaType) ? 'tv' : 'movie';

            // Fetch from primary provider first
            if (primaryDefinition && (await isProviderConfigured(primaryDefinition.id))) {
                try {
                    const encoded = encodeDetailId(primaryDefinition.id, detailType, externalId.id);
                    const raw = await invokeProviderDetail(primaryDefinition.id, encoded);
                    const detail = normalizeDetail(primaryDefinition.id, raw, detailType);
                    if (detail) {
                        rawProviderData = detail as unknown as Record<string, unknown>;
                        providerResults.push({
                            provider: primaryDefinition.id,
                            data: detail as unknown as Record<string, unknown>,
                        });
                    }
                } catch (err) {
                    logger.debug(`Primary provider ${primaryDefinition.id} detail failed`, { err });
                }
            }

            // Fetch from other configured providers for multi-provider merge
            for (const definition of definitions) {
                if (definition === primaryDefinition) continue;
                if (!(await isProviderConfigured(definition.id))) continue;

                try {
                    const encoded = encodeDetailId(definition.id, detailType, externalId.id);
                    const raw = await invokeProviderDetail(definition.id, encoded);
                    const detail = normalizeDetail(definition.id, raw, detailType);
                    if (detail) {
                        providerResults.push({
                            provider: definition.id,
                            data: detail as unknown as Record<string, unknown>,
                        });
                    }
                } catch {
                    // Skip failing secondary providers
                }
            }

            // Merge results using field authority resolver
            if (providerResults.length > 0) {
                // Layer operator overrides from plugin_settings on top of
                // manifest defaults. Cached at 60s TTL (see
                // loadProviderSettingsCached) so the per-write hot path
                // doesn't hit the DB every time; admin PATCH invalidates the
                // cache for instant-takes-effect semantics.
                // Use the instance's injected handle, not getDb(): when a task
                // constructs CatalogService(ctx.sql) this keeps provider-setting
                // reads on the same (task) pool instead of falling back to the
                // global web pool.
                const providerSettings = await loadProviderSettingsCached(this.sql);
                const faConfig = buildFieldAuthorityConfigFromDefinitions(
                    definitions,
                    providerSettings,
                );
                const resolver = new FieldAuthorityResolver(faConfig);
                const { merged, fieldSources } = resolver.merge(providerResults);

                aggregated = {
                    title: typeof merged.title === 'string' ? merged.title : '',
                    originalTitle:
                        typeof merged.originalTitle === 'string' ? merged.originalTitle : undefined,
                    englishTitle:
                        typeof merged.englishTitle === 'string' ? merged.englishTitle : undefined,
                    year: typeof merged.year === 'number' ? merged.year : undefined,
                    certification:
                        typeof merged.certification === 'string' && merged.certification
                            ? merged.certification
                            : undefined,
                    fieldSources,
                };
            }
        } catch (error) {
            logger.warn(`Failed to fetch metadata for ${externalId.provider}:${externalId.id}`, {
                error,
            });
        }

        const result = await withTx(this.sql, async (tx) => {
            const executor = tx as SqlExecutor;

            // Acquire transaction-scoped advisory lock
            // This is released automatically when the transaction commits/rolls back
            await executor`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;

            // Check if external ID already exists.
            // A concurrent request may have inserted it while we were pre-fetching
            // metadata above — the lock guarantees we see that write here.
            const existing = await this.findByExternalIdTx(
                executor,
                externalId,
                externalId.mediaType || mediaType,
            );
            if (existing) {
                return { id: existing, isNew: false };
            }

            // Use aggregated data or fallback to minimal record
            const title = aggregated?.title || `Unknown ${mediaType}`;
            const originalTitle = aggregated?.originalTitle;
            const englishTitle = aggregated?.englishTitle;
            const safeYear = sanitizeYear(aggregated?.year);

            // Insert media item
            const [item] = await executor`
                INSERT INTO media_items (title, original_title, english_title, year, media_type)
                VALUES (${title}, ${originalTitle || null}, ${englishTitle || null}, ${safeYear}, ${mediaType})
                RETURNING id
            `;
            await refreshSortTitles(executor, [item.id as string]);

            // Insert external ID mapping (normalize Jellyfin IDs to dashless)
            const extIdForInsert =
                externalId.provider === 'jellyfin'
                    ? normalizeJellyfinId(externalId.id)
                    : externalId.id;
            await executor`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                VALUES (
                    ${item.id},
                    ${externalId.provider},
                    ${extIdForInsert},
                    ${externalId.mediaType || mediaType},
                    TRUE,
                    'api'
                )
            `;

            // Store raw provider response (not aggregated) - one row per provider
            if (rawProviderData && Object.keys(rawProviderData).length > 0) {
                // Pre-clean undefined values (JSONB doesn't handle undefined)
                const cleanRawMetadata = Object.fromEntries(
                    Object.entries(rawProviderData).filter(([_, v]) => v !== undefined),
                );

                if (Object.keys(cleanRawMetadata).length > 0) {
                    await executor`
                        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                        VALUES (${item.id}, ${externalId.provider}, ${cleanRawMetadata}, NOW())
                    `;
                }
            }

            // Store aggregated view with field_sources
            if (aggregated) {
                const { fieldSources, ...aggregatedMetadata } = aggregated;
                const cleanAggregated = Object.fromEntries(
                    Object.entries(aggregatedMetadata).filter(([_, v]) => v !== undefined),
                );

                if (Object.keys(cleanAggregated).length > 0) {
                    await executor`
                        INSERT INTO provider_metadata (media_id, provider, metadata, field_sources, fetched_at)
                        VALUES (${item.id}, 'aggregated', ${cleanAggregated}, ${fieldSources || {}}, NOW())
                        ON CONFLICT (media_id, provider) DO UPDATE SET
                            metadata = EXCLUDED.metadata,
                            field_sources = EXCLUDED.field_sources,
                            updated_at = NOW()
                    `;
                }
            }

            // A national certification supplied by the provider (Jellyfin
            // OfficialRating) sets the age rating, winning over MDBList.
            if (aggregated?.certification) {
                await applyNationalAgeRating(
                    executor,
                    item.id as string,
                    aggregated.certification,
                );
            }

            logger.info(`Created media item`, {
                id: item.id as string,
                provider: externalId.provider,
                externalId: externalId.id,
                title,
                mediaType,
            });

            return { id: item.id as string, isNew: true };
        });

        if (result.isNew && !this.skipLifecycleHooks) {
            // No sql arg: this hook is fire-and-forget (un-awaited) and outlives
            // the method, but `this.sql` may be a transaction handle (e.g.
            // createCatalogService(tx) inside the scanner's withTx). A deferred
            // query on a committed tx races/throws — let the hook resolve getDb()
            // (a pool) itself, as it did before the pool-split.
            MediaLifecycleService.afterCreated(result.id, 'getOrCreateByExternalId').catch(
                (err: unknown) => {
                    logger.error(
                        'afterCreated lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        { mediaId: result.id, source: 'getOrCreateByExternalId' },
                    );
                },
            );
        }

        return result;
    }

    /**
     * Get or create a minimal media item by TMDB ID.
     *
     * This is a lightweight version of getOrCreateByExternalId that does NOT
     * fetch metadata from external providers. Use this when you just need to
     * ensure a media_items record exists (e.g., for ratings, suggestions).
     *
     * Race-safe: Uses PostgreSQL advisory locks to prevent duplicates.
     *
     * @param tmdbId - The TMDB ID
     * @param mediaType - The media type ('movie' or 'tv')
     * @param title - Fallback title if creating new record
     * @param originalTitle - Optional original title
     * @param year - Optional release year
     * @returns The UUID and whether it was newly created
     */
    async getOrCreateMinimalByTmdb(
        tmdbId: number,
        mediaType: 'movie' | 'tv',
        title: string,
        originalTitle?: string,
        year?: number,
    ): Promise<GetOrCreateResult> {
        // Validate TMDB ID (must be positive integer)
        if (!tmdbId || tmdbId <= 0) {
            throw new Error(`Invalid TMDB ID: ${tmdbId}. TMDB IDs must be positive integers.`);
        }

        const externalId: ExternalId = {
            provider: 'tmdb',
            id: String(tmdbId),
            mediaType,
        };

        const lockKey = this.hashExternalId(externalId);

        const result = await withTx(this.sql, async (tx) => {
            const executor = tx as SqlExecutor;

            // Acquire transaction-scoped advisory lock
            await executor`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;

            // Check if TMDB ID already exists
            const existing = await this.findByExternalIdTx(executor, externalId, mediaType);
            if (existing) {
                return { id: existing, isNew: false };
            }

            // Create minimal media item (no metadata fetch)
            const [item] = await executor`
                INSERT INTO media_items (title, original_title, year, media_type)
                VALUES (${title}, ${originalTitle || null}, ${sanitizeYear(year)}, ${mediaType})
                RETURNING id
            `;
            await refreshSortTitles(executor, [item.id as string]);

            // Insert TMDB external ID mapping
            await executor`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                VALUES (${item.id}, 'tmdb', ${String(tmdbId)}, ${mediaType}, TRUE, 'api')
            `;

            logger.debug(`Created minimal media item`, {
                id: item.id as string,
                tmdbId,
                title,
                mediaType,
            });

            return { id: item.id as string, isNew: true };
        });

        if (result.isNew && !this.skipLifecycleHooks) {
            MediaLifecycleService.afterCreated(result.id, 'getOrCreateMinimalByTmdb').catch(
                (err: unknown) => {
                    logger.error(
                        'afterCreated lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        { mediaId: result.id, source: 'getOrCreateMinimalByTmdb' },
                    );
                },
            );
        }

        return result;
    }

    /**
     * Provider-agnostic lightweight version of getOrCreateByExternalId.
     * Does NOT fetch metadata from external providers.
     *
     * Race-safe: Uses PostgreSQL advisory locks to prevent duplicates.
     *
     * @param extId - The external ID string (e.g., "12345" for TMDB, "tt0137523" for IMDB)
     * @param provider - The external ID provider
     * @param mediaType - The media type ('movie', 'tv', or 'audiobook')
     * @param title - Fallback title for stub creation
     * @returns The UUID and whether it was newly created
     */
    async getOrCreateMinimal(
        extId: string,
        provider: string,
        mediaType: 'movie' | 'tv' | 'audiobook',
        title?: string,
    ): Promise<GetOrCreateResult> {
        const externalId: ExternalId = { provider, id: extId, mediaType };
        const lockKey = this.hashExternalId(externalId);

        const result = await withTx(this.sql, async (tx) => {
            const executor = tx as SqlExecutor;

            await executor`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;

            const existing = await this.findByExternalIdTx(executor, externalId, mediaType);
            if (existing) return { id: existing, isNew: false };

            const [item] = await executor`
                INSERT INTO media_items (title, media_type, status, created_at, updated_at)
                VALUES (${title ?? `Stub (${provider}:${extId})`}, ${mediaType}, 'active', NOW(), NOW())
                RETURNING id
            `;
            await refreshSortTitles(executor, [item.id as string]);

            await executor`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                VALUES (${item.id}, ${provider}, ${extId}, ${mediaType}, TRUE, 'api')
            `;

            return { id: item.id as string, isNew: true };
        });

        if (result.isNew && !this.skipLifecycleHooks) {
            MediaLifecycleService.afterCreated(result.id, 'getOrCreateMinimal').catch(
                (err: unknown) => {
                    logger.error(
                        'afterCreated lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        { mediaId: result.id, source: 'getOrCreateMinimal' },
                    );
                },
            );
        }

        return result;
    }

    /**
     * Find media ID by external ID (within a transaction).
     *
     * IMPORTANT: External IDs are NOT unique across media types (e.g., TMDB ID
     * 1429 maps to both a movie and a TV show; IMDB/Jellyfin IDs can also be
     * shared between an item and its parent). The lookup is ALWAYS scoped by the
     * composite key `(provider, external_id, media_type)`, so callers must supply
     * the effective media type. There is intentionally no type-less fallback —
     * resolving by `external_id` alone could return an arbitrary item of the
     * wrong type.
     */
    private async findByExternalIdTx(
        tx: SqlExecutor,
        externalId: ExternalId,
        mediaType: MediaType,
    ): Promise<string | null> {
        // Normalize Jellyfin IDs to dashless format for consistent lookup
        const extIdValue =
            externalId.provider === 'jellyfin' ? normalizeJellyfinId(externalId.id) : externalId.id;

        const rows = await tx`
            SELECT media_id FROM external_ids
            WHERE provider = ${externalId.provider}
              AND external_id = ${extIdValue}
              AND media_type = ${mediaType}
            LIMIT 1
        `;
        return (rows[0]?.media_id as string) || null;
    }

    /**
     * Find media ID by external ID (standalone query)
     */
    async findByExternalId(externalId: ExternalId): Promise<string | null> {
        return findMediaIdByExternalId(this.sql, {
            provider: externalId.provider,
            externalId: externalId.id,
            mediaType: externalId.mediaType,
        });
    }

    /**
     * Create a local-only media item (Jellyfin content with no external metadata match)
     */
    async createLocalOnlyItem(
        jellyfinId: string,
        title: string,
        mediaType: MediaType,
        year?: number,
    ): Promise<string> {
        // Normalize Jellyfin ID to dashless format for consistent storage
        const normalizedJfId = normalizeJellyfinId(jellyfinId);

        const createdId: string = await withTx(this.sql, async (tx) => {
            const executor = tx as SqlExecutor;

            const [item] = await executor`
                INSERT INTO media_items (title, year, media_type, is_local_only)
                VALUES (${title}, ${sanitizeYear(year)}, ${mediaType}, TRUE)
                RETURNING id
            `;
            await refreshSortTitles(executor, [item.id as string]);

            await executor`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                VALUES (${item.id}, 'jellyfin', ${normalizedJfId}, ${mediaType}, TRUE, 'jellyfin')
            `;

            await executor`
                INSERT INTO library_availability (media_id, library, library_item_id, available)
                VALUES (${item.id}, 'jellyfin', ${normalizedJfId}, TRUE)
            `;

            logger.info(`Created local-only media item`, {
                id: item.id as string,
                jellyfinId,
                title,
                mediaType,
            });

            return item.id as string;
        });

        // Fire lifecycle hook after transaction commits (fire-and-forget,
        // but log on failure — silent swallow has hidden regressions in
        // the past on this hot path).
        if (!this.skipLifecycleHooks) {
            MediaLifecycleService.afterCreated(createdId, 'createLocalOnlyItem').catch(
                (err: unknown) => {
                    logger.error(
                        'afterCreated lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        { mediaId: createdId, source: 'createLocalOnlyItem' },
                    );
                },
            );
        }

        return createdId;
    }

    /**
     * Get media item by UUID
     */
    async getById(mediaId: string): Promise<{
        id: string;
        title: string;
        originalTitle?: string;
        year?: number;
        mediaType: MediaType;
        isLocalOnly: boolean;
    } | null> {
        const row = await getMediaItemById(this.sql, mediaId);

        if (!row) return null;

        return {
            id: row.id,
            title: row.title,
            originalTitle: row.original_title || undefined,
            year: row.year || undefined,
            mediaType: row.media_type,
            isLocalOnly: row.is_local_only,
        };
    }

    /**
     * Get all external IDs for a media item
     */
    async getExternalIds(mediaId: string): Promise<ExternalId[]> {
        const rows = await getExternalIdsForMedia(this.sql, mediaId);

        return rows.map((row) => ({
            provider: row.provider,
            id: row.external_id,
            mediaType: (row.media_type || undefined) as MediaType | undefined,
            confidence: row.confidence || undefined,
        }));
    }

    /**
     * Upsert a single external ID with required mediaType.
     * This is the preferred method for all external_ids writes.
     *
     * @param mediaId - The internal UUID of the media item
     * @param externalId - The external ID with required mediaType
     * @param isPrimary - Whether this is the primary ID for this provider
     */
    /**
     * @returns `true` when the row was written, `false` when the convergence guard
     * skipped it because another writer had just claimed the same
     * (media_id, provider, media_type). Callers that count enrichment or report an
     * outcome to a user MUST check this: the two cases were previously
     * indistinguishable, so a skipped write was counted as a successful one.
     */
    async upsertExternalId(
        mediaId: string,
        externalId: ExternalIdWrite,
        isPrimary = false,
    ): Promise<boolean> {
        return (await this.upsertExternalIdDetailed(mediaId, externalId, isPrimary)).written;
    }

    /** Read the exact two-episode assignment an administrator will review. No writes. */
    async previewEpisodeTmdbExchange(
        firstId: string,
        secondId: string,
    ): Promise<EpisodeTmdbExchangePreview> {
        const preview = await this.readEpisodeTmdbExchange(this.sql, firstId, secondId);
        const undoId = await latestMediaChange(this.sql, firstId, 'episode-exchange');
        if (undoId) {
            const receipt = await getMediaChange(this.sql, firstId, 'episode-exchange', undoId);
            const after = z
                .object({ firstId: z.string(), secondId: z.string(), guard: z.unknown() })
                .safeParse(receipt?.after_state);
            if (
                after.success &&
                after.data.firstId === firstId &&
                after.data.secondId === secondId &&
                (await sameMediaChangeState(
                    this.sql,
                    await captureEpisodeExchangeChoice(this.sql, firstId, secondId),
                    after.data.guard,
                ))
            )
                return { ...preview, undoId };
        }
        return preview;
    }

    /**
     * Exchange only the two TMDB episode mappings. Immediate unique constraints
     * rule out a two-row UPDATE, so both old rows are removed and restored with
     * exchanged IDs in one transaction. No reader or outbox consumer can see the
     * uncommitted gap. The transaction also owns the audit record; lifecycle
     * hooks run only after it commits.
     */
    async exchangeEpisodeTmdbIds(
        firstId: string,
        secondId: string,
        reviewedSnapshot: string,
        actor: AuditActor,
        undoReceiptId?: string,
    ): Promise<EpisodeTmdbExchangePreview> {
        if (!actor.username) {
            throw new EpisodeTmdbExchangeError(
                'invalid_pair',
                'An authenticated actor is required.',
            );
        }
        const result = await withTx(this.sql, async (tx) => {
            // Discover the ancestry first, then lock every owner in UUID order.
            // A concurrent reparent can change the discovery result while we
            // wait, so read and validate the complete evidence again afterward.
            const discovered = await tx<
                Array<{ id: string; season_id: string | null; series_id: string | null }>
            >`
                SELECT ep.id, season.id AS season_id, series.id AS series_id
                FROM media_items ep
                LEFT JOIN media_items season ON season.id = ep.parent_id
                LEFT JOIN media_items series ON series.id = season.parent_id
                WHERE ep.id IN (${firstId}, ${secondId})
            `;
            const owners = [
                ...new Set(
                    discovered.flatMap((row) =>
                        [row.id, row.season_id, row.series_id].filter(
                            (id): id is string => id !== null,
                        ),
                    ),
                ),
            ].sort();
            if (owners.length > 0) {
                await tx`SELECT id FROM media_items WHERE id = ANY(${owners}::uuid[]) ORDER BY id FOR UPDATE`;
            }
            const current = await this.readEpisodeTmdbExchange(tx, firstId, secondId, true);
            if (undoReceiptId) {
                const receipt = await getMediaChange(
                    tx,
                    firstId,
                    'episode-exchange',
                    undoReceiptId,
                );
                const stateSchema = z.object({
                    firstId: z.uuid(),
                    secondId: z.uuid(),
                    snapshot: z.string(),
                    guard: z.unknown(),
                    rows: z.array(z.record(z.string(), z.unknown())),
                });
                if (!receipt)
                    throw new EpisodeTmdbExchangeError(
                        'changed',
                        'Recovery is no longer available.',
                    );
                const before = stateSchema.parse(receipt.before_state);
                const after = stateSchema.parse(receipt.after_state);
                if (before.firstId !== firstId || before.secondId !== secondId)
                    throw new EpisodeTmdbExchangeError(
                        'changed',
                        'Recovery belongs to a different episode pair.',
                    );
                if (receipt.undone_at) return current;
                if (
                    !(await sameMediaChangeState(
                        tx,
                        await captureEpisodeExchangeChoice(tx, firstId, secondId),
                        after.guard,
                    ))
                )
                    throw new EpisodeTmdbExchangeError(
                        'changed',
                        'The episode pair changed after the swap. Reload before undoing.',
                    );
                await tx`DELETE FROM external_ids WHERE media_id IN (${firstId},${secondId}) AND provider='tmdb' AND media_type='episode'`;
                await tx`INSERT INTO external_ids SELECT * FROM jsonb_populate_recordset(NULL::external_ids,${tx.json(before.rows as postgres.JSONValue)}::jsonb)`;
                await markMediaChangeUndone(tx, undoReceiptId);
                await insertAdminAuditEvent(tx, {
                    instanceId: config.INSTANCE_ID,
                    actor: actor.username!,
                    action: 'media.episode-tmdb.undo',
                    target: current.series.id,
                    outcome: 'ok',
                    detail: { firstId, secondId, receiptId: undoReceiptId },
                });
                return this.readEpisodeTmdbExchange(tx, firstId, secondId, true);
            }
            if (current.snapshot !== reviewedSnapshot) {
                throw new EpisodeTmdbExchangeError(
                    'changed',
                    'The reviewed episode, identity, ancestry, protection or file association changed. Refresh the preview.',
                );
            }

            const beforeGuard = await captureEpisodeExchangeChoice(tx, firstId, secondId);
            const removed = await tx<Array<ExchangeExternalIdRow>>`
                DELETE FROM external_ids
                WHERE media_id IN (${firstId}, ${secondId})
                  AND provider = 'tmdb' AND media_type = 'episode'
                RETURNING *,to_jsonb(external_ids) AS evidence
            `;
            if (removed.length !== 2) {
                throw new EpisodeTmdbExchangeError(
                    'changed',
                    'The TMDB assignments changed. Refresh the preview.',
                );
            }
            const firstOld = removed.find((row) => row.media_id === firstId);
            const secondOld = removed.find((row) => row.media_id === secondId);
            if (
                !firstOld ||
                !secondOld ||
                firstOld.external_id !== current.first.tmdbId ||
                secondOld.external_id !== current.second.tmdbId
            ) {
                throw new EpisodeTmdbExchangeError(
                    'changed',
                    'The TMDB assignments changed. Refresh the preview.',
                );
            }
            // Reuse each row's key and attributes. The external_ids primary key
            // has no inbound FK in the published schema, and preserving it also
            // avoids needless row-key churn for any external observer.
            for (const row of [firstOld, secondOld].sort((a, b) => a.id - b.id)) {
                const replacement =
                    row.media_id === firstId ? secondOld.external_id : firstOld.external_id;
                await tx`
                    INSERT INTO external_ids
                        (id, media_id, provider, external_id, media_type, is_primary, source, confidence)
                    VALUES
                        (${row.id}, ${row.media_id}, 'tmdb', ${replacement}, 'episode',
                         ${row.is_primary}, 'manual', ${row.confidence})
                `;
            }
            await insertAdminAuditEvent(tx, {
                instanceId: config.INSTANCE_ID,
                actor: actor.username ?? 'system',
                principalKind: actor.kind,
                credentialId: actor.credentialId,
                action: 'media.episode-tmdb.exchange',
                target: current.series.id,
                outcome: 'ok',
                detail: {
                    first: {
                        mediaId: firstId,
                        from: firstOld.external_id,
                        to: secondOld.external_id,
                    },
                    second: {
                        mediaId: secondId,
                        from: secondOld.external_id,
                        to: firstOld.external_id,
                    },
                    reviewedSnapshot,
                    ...(actor.delegated ? { delegated: true } : {}),
                },
            });
            const after = await this.readEpisodeTmdbExchange(tx, firstId, secondId, true);
            const rows = await tx<
                { evidence: Record<string, unknown> }[]
            >`SELECT to_jsonb(ei) AS evidence FROM external_ids ei
                WHERE media_id IN (${firstId},${secondId}) AND provider='tmdb' AND media_type='episode' ORDER BY id`;
            const undoId = await recordMediaChange(
                tx,
                firstId,
                'episode-exchange',
                {
                    firstId,
                    secondId,
                    snapshot: current.snapshot,
                    guard: beforeGuard,
                    rows: removed.map((row) => row.evidence),
                },
                {
                    firstId,
                    secondId,
                    snapshot: after.snapshot,
                    guard: await captureEpisodeExchangeChoice(tx, firstId, secondId),
                    rows: rows.map((row) => row.evidence),
                },
                actor.username!,
            );
            return { ...after, undoId };
        });
        if (!this.skipLifecycleHooks) {
            for (const mediaId of [firstId, secondId]) {
                MediaLifecycleService.afterExternalIdChanged(mediaId).catch((err: unknown) => {
                    logger.error(
                        'afterExternalIdChanged lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        { mediaId, source: 'exchangeEpisodeTmdbIds' },
                    );
                });
            }
        }
        return result;
    }

    private async readEpisodeTmdbExchange(
        sql: SqlExecutor,
        firstId: string,
        secondId: string,
        lockIds = false,
    ): Promise<EpisodeTmdbExchangePreview> {
        if (firstId === secondId) {
            throw new EpisodeTmdbExchangeError('invalid_pair', 'Select two different episodes.');
        }
        const rows = await sql<Array<ExchangeEpisodeRow>>`
            SELECT ep.id, ep.title, ep.media_type, ep.status, ep.canonical_id,
                   ep.season_number, ep.episode_number,
                   season.id AS season_id, season.media_type AS season_type,
                   season.status AS season_status, season.canonical_id AS season_canonical_id,
                   series.id AS series_id, series.title AS series_title,
                   series.media_type AS series_type, series.status AS series_status,
                   series.canonical_id AS series_canonical_id,
                   to_jsonb(ep) AS episode_evidence,
                   to_jsonb(season) AS season_evidence,
                   to_jsonb(series) AS series_evidence
            FROM media_items ep
            LEFT JOIN media_items season ON season.id = ep.parent_id
            LEFT JOIN media_items series ON series.id = season.parent_id
            WHERE ep.id IN (${firstId}, ${secondId})
            ORDER BY ep.id
        `;
        if (rows.length !== 2)
            throw new EpisodeTmdbExchangeError('not_found', 'Both episodes must exist.');
        if (
            rows.some(
                (row) =>
                    row.media_type !== 'episode' ||
                    row.season_type !== 'season' ||
                    row.series_type !== 'tv',
            )
        ) {
            throw new EpisodeTmdbExchangeError(
                'wrong_type',
                'Both items must be episodes beneath a series.',
            );
        }
        if (
            rows.some(
                (row) =>
                    row.status !== 'active' ||
                    row.canonical_id !== null ||
                    row.season_status !== 'active' ||
                    row.season_canonical_id !== null ||
                    row.series_status !== 'active' ||
                    row.series_canonical_id !== null,
            )
        ) {
            throw new EpisodeTmdbExchangeError(
                'inactive',
                'Both episodes and their ancestors must be active canonical items.',
            );
        }
        if (!rows[0].series_id || rows[0].series_id !== rows[1].series_id) {
            throw new EpisodeTmdbExchangeError(
                'other_series',
                'Both episodes must belong to the same series.',
            );
        }
        const ids = lockIds
            ? await sql<Array<ExchangeExternalIdRow>>`
                SELECT ei.*, to_jsonb(ei) AS evidence FROM external_ids ei
                WHERE ei.media_id IN (${firstId}, ${secondId})
                ORDER BY ei.id FOR UPDATE
            `
            : await sql<Array<ExchangeExternalIdRow>>`
                SELECT ei.*, to_jsonb(ei) AS evidence FROM external_ids ei
                WHERE ei.media_id IN (${firstId}, ${secondId})
                ORDER BY ei.id
            `;
        const firstTmdb = ids.filter(
            (row) =>
                row.media_id === firstId && row.provider === 'tmdb' && row.media_type === 'episode',
        );
        const secondTmdb = ids.filter(
            (row) =>
                row.media_id === secondId &&
                row.provider === 'tmdb' &&
                row.media_type === 'episode',
        );
        if (firstTmdb.length !== 1 || secondTmdb.length !== 1) {
            throw new EpisodeTmdbExchangeError(
                'missing_id',
                'Each episode must already have one TMDB episode ID.',
            );
        }
        if (firstTmdb[0].external_id === secondTmdb[0].external_id) {
            throw new EpisodeTmdbExchangeError(
                'same_id',
                'The two TMDB episode IDs must be different.',
            );
        }
        const owners = await sql<Array<{ media_id: string }>>`
            SELECT media_id FROM external_ids
            WHERE provider = 'tmdb' AND media_type = 'episode'
              AND external_id IN (${firstTmdb[0].external_id}, ${secondTmdb[0].external_id})
            ORDER BY media_id
        `;
        if (
            owners.length !== 2 ||
            owners.some((owner) => owner.media_id !== firstId && owner.media_id !== secondId)
        ) {
            throw new EpisodeTmdbExchangeError(
                'outside_owner',
                'Another episode owns one of these TMDB IDs.',
            );
        }
        const files = lockIds
            ? await sql<Array<{ evidence: Record<string, unknown> }>>`
                SELECT to_jsonb(mfi) AS evidence FROM media_file_items mfi
                WHERE mfi.media_item_id IN (${firstId}, ${secondId})
                ORDER BY mfi.media_item_id, mfi.file_id FOR UPDATE
            `
            : await sql<Array<{ evidence: Record<string, unknown> }>>`
                SELECT to_jsonb(mfi) AS evidence FROM media_file_items mfi
                WHERE mfi.media_item_id IN (${firstId}, ${secondId})
                ORDER BY mfi.media_item_id, mfi.file_id
            `;
        const metadata = lockIds
            ? await sql<Array<{ evidence: Record<string, unknown> }>>`
                SELECT to_jsonb(pm) AS evidence FROM provider_metadata pm
                WHERE pm.media_id IN (${firstId}, ${secondId})
                ORDER BY pm.media_id, pm.id FOR UPDATE
            `
            : await sql<Array<{ evidence: Record<string, unknown> }>>`
                SELECT to_jsonb(pm) AS evidence FROM provider_metadata pm
                WHERE pm.media_id IN (${firstId}, ${secondId})
                ORDER BY pm.media_id, pm.id
            `;
        const first = rows.find((row) => row.id === firstId)!;
        const second = rows.find((row) => row.id === secondId)!;
        const evidence = {
            episodes: rows.map((row) => [
                row.episode_evidence,
                row.season_evidence,
                row.series_evidence,
            ]),
            externalIds: ids.map((row) => row.evidence),
            fileLinks: files.map((row) => row.evidence),
            providerMetadata: metadata.map((row) => row.evidence),
        };
        const snapshot = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
        return {
            series: { id: first.series_id!, title: first.series_title! },
            first: {
                id: first.id,
                title: first.title,
                seasonNumber: first.season_number,
                episodeNumber: first.episode_number,
                tmdbId: firstTmdb[0].external_id,
            },
            second: {
                id: second.id,
                title: second.title,
                seasonNumber: second.season_number,
                episodeNumber: second.episode_number,
                tmdbId: secondTmdb[0].external_id,
            },
            snapshot,
        };
    }

    /**
     * {@link upsertExternalId}, also reporting whether the item's mapping CHANGED
     * (a new row, or an old id for this provider replaced). `written` is true for a
     * re-confirmation of the existing mapping too; `changed` is not. Callers that
     * react to a new identity (the scanner's "series matched" side effects) must
     * key on `changed`: the full scan re-confirms every series' ids each hour.
     * `preserveExisting` atomically refuses any different mapping already held by
     * this item, including historical mappings outside the convergence window.
     */
    async upsertExternalIdDetailed(
        mediaId: string,
        externalId: ExternalIdWrite,
        isPrimary = false,
        options: { preserveExisting?: boolean } = {},
    ): Promise<{ written: boolean; changed: boolean }> {
        const { provider, mediaType } = externalId;
        // Normalize Jellyfin IDs to dashless format for consistent storage
        const externalIdValue =
            provider === 'jellyfin' ? normalizeJellyfinId(externalId.id) : externalId.id;
        // Set only on the path that actually reaches the INSERT. The guard's early
        // `return` below leaves the transaction callback, not this method, so without
        // an explicit flag a skipped write is indistinguishable from a real one.
        let didWrite = false;
        // Whether the item's mapping actually CHANGED (new row, or an old id for
        // this provider replaced). Re-confirming an existing mapping still counts
        // as a write for the return value, but must not fire the lifecycle hook:
        // the scanner re-confirms a series' ids on every ingest of every episode,
        // so an unconditional hook re-invalidated that series' caches each time.
        let mappingChanged = false;
        // Wrap in transaction to avoid race between SELECT/DELETE/INSERT
        await withTx(this.sql, async (tx) => {
            const executor = tx as SqlExecutor;
            // Keep a classification durable across scanner/catalog writers. Lock
            // the item and its ancestors in a stable order, then read the marker
            // in a fresh statement so a concurrent Keep writer is observed.
            const ancestors = await executor<{ id: string }[]>`
                WITH RECURSIVE item_chain AS (
                    SELECT id, parent_id FROM media_items WHERE id = ${mediaId}
                    UNION
                    SELECT parent.id, parent.parent_id
                    FROM media_items parent
                    JOIN item_chain child ON child.parent_id = parent.id
                )
                SELECT mi.id
                FROM media_items mi
                JOIN item_chain c ON c.id = mi.id
                ORDER BY mi.id
                FOR UPDATE OF mi
            `;
            const ancestorIds = ancestors.map((row) => row.id);
            if (ancestorIds.length > 0) {
                const kept = await executor<{ media_id: string }[]>`
                    SELECT media_id FROM personal_media_dispositions
                    WHERE media_id = ANY(${ancestorIds}) AND disposition = 'kept'
                    LIMIT 1
                `;
                // Jellyfin ids are sync links, not metadata identification. Keep
                // personal media eligible for watch sync without leaving Keep.
                if (
                    kept.length > 0 &&
                    externalId.source !== 'manual' &&
                    !(provider === 'jellyfin' && externalId.source === 'watch-sync-file')
                )
                    return;
                if (externalId.source === 'manual') {
                    // An explicit operator match leaves the Keep state; otherwise
                    // a matched row could remain hidden in the Kept filter.
                    await executor`
                        DELETE FROM personal_media_dispositions WHERE media_id = ${mediaId}
                    `;
                }
            }
            const existing = await executor<Array<{ media_id: string }>>`
                SELECT media_id FROM external_ids
                WHERE provider = ${provider}
                AND external_id = ${externalIdValue}
                AND media_type = ${mediaType}
            `;
            if (existing.length > 0 && existing[0].media_id !== mediaId) {
                throw new ExternalIdOwnedByAnotherItemError(
                    provider,
                    externalIdValue,
                    mediaType,
                    existing[0].media_id,
                );
            }
            if (options.preserveExisting) {
                // Scanner evidence can only add or confirm a mapping. Resolve the
                // item's unique-key conflict in the INSERT itself, so a concurrent
                // writer cannot introduce a rival between a pre-check and a DELETE.
                // The separate provider/id/type uniqueness constraint also rejects
                // an ID concurrently claimed by another item without moving it.
                const confirmed = await executor<Array<{ inserted: boolean }>>`
                    INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source, confidence)
                    VALUES (
                        ${mediaId}, ${provider}, ${externalIdValue}, ${mediaType},
                        ${isPrimary}, ${externalId.source || 'api'}, ${externalId.confidence ?? 1.0}
                    )
                    ON CONFLICT (media_id, provider, media_type) DO UPDATE SET
                        confidence = GREATEST(external_ids.confidence, EXCLUDED.confidence),
                        source = CASE WHEN external_ids.source = 'manual' THEN external_ids.source
                            ELSE COALESCE(EXCLUDED.source, external_ids.source) END
                    WHERE external_ids.external_id = EXCLUDED.external_id
                    RETURNING (xmax = 0) AS inserted
                `;
                didWrite = confirmed.length > 0;
                mappingChanged = confirmed[0]?.inserted ?? false;
                return;
            }
            // A media item may hold only ONE id per (provider, media_type) —
            // idx_external_ids_one_per_provider is UNIQUE on exactly that. So a
            // different incoming id must REPLACE the current one, and two writers
            // that disagree will swap it back and forth forever.
            //
            // That is not hypothetical: on prod (2026-08-27) two Jellyfin items —
            // the same film in two libraries — resolved to one media item and
            // swapped 1,370 times each. Every swap is a DELETE plus an INSERT, and
            // both fire the external_ids trigger (identity.cleared, then
            // identity.assigned; its IS DISTINCT FROM guard only covers UPDATE, so
            // delete-then-insert sails past it). Those events invalidate every stage
            // declaring `identity.*`, re-running tmdb-metadata-sync, image-sync and
            // metadata-translations-sync several times per SECOND, indefinitely —
            // ~76k of ~112k weekly TMDB calls.
            //
            // Since we cannot hold both, make the writers CONVERGE: while the
            // current row is fresh, the first writer wins and later disagreeing
            // writes are skipped, so the second call is a no-op rather than a swap.
            // A genuine rescan is unaffected — there the old row is hours or days
            // old, falls outside the window, and is replaced exactly as before.
            // Operator-initiated writes are NEVER skipped. The guard exists to stop
            // two automated writers alternating; a human correcting a bad id is the
            // one caller whose intent is unambiguous, and the moment they do it is
            // usually right after the scan that wrote the wrong value — i.e. inside
            // the window. Dropping that write silently (the skip only logs, and
            // upsertExternalId now returns a boolean saying whether it wrote, so
            // the admin endpoint can stop reporting `{updated: true}` regardless)
            // would make the fix worse than the bug.
            if (externalId.source === 'manual') {
                logger.debug('Manual external-id write — bypassing the convergence guard', {
                    mediaId,
                    provider,
                });
            }
            const liveRival =
                externalId.source === 'manual'
                    ? []
                    : await executor<Array<{ external_id: string }>>`
                SELECT external_id FROM external_ids
                WHERE media_id = ${mediaId}
                  AND provider = ${provider}
                  AND media_type = ${mediaType}
                  AND external_id != ${externalIdValue}
                  AND created_at >= now() - ${`${IDENTITY_SWAP_MIN_AGE_SECONDS} seconds`}::interval
            `;
            if (liveRival.length > 0) {
                logger.warn(
                    'Skipping external-id write: this item already has a freshly-written id ' +
                        'for the same provider. Usually the same title present twice at the provider.',
                    {
                        mediaId,
                        provider,
                        mediaType,
                        keeping: liveRival[0].external_id,
                        skipped: externalIdValue,
                    },
                );
                return;
            }

            // Remove stale mappings: if this media_id already has a different external_id
            // for the same provider+mediaType (e.g. Jellyfin rescanned and assigned a new ID),
            // delete the old one to prevent duplicates. Preserve is_primary from old row.
            const stale = await executor<Array<{ is_primary: boolean }>>`
                DELETE FROM external_ids
                WHERE media_id = ${mediaId}
                  AND provider = ${provider}
                  AND media_type = ${mediaType}
                  AND external_id != ${externalIdValue}
                RETURNING is_primary
            `;
            const inheritPrimary = isPrimary || stale.some((r) => r.is_primary);
            mappingChanged = existing.length === 0 || stale.length > 0;
            await executor`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source, confidence)
                VALUES (
                    ${mediaId},
                    ${provider},
                    ${externalIdValue},
                    ${mediaType},
                    ${inheritPrimary},
                    ${externalId.source || 'api'},
                    ${externalId.confidence ?? 1.0}
                )
                ON CONFLICT (provider, external_id, media_type) DO UPDATE SET
                    media_id = EXCLUDED.media_id,
                    confidence = GREATEST(external_ids.confidence, EXCLUDED.confidence),
                    source = COALESCE(EXCLUDED.source, external_ids.source)
            `;
            didWrite = true;
        });

        // Fire-and-forget lifecycle hook for cache invalidation
        // Skipped when caller manages lifecycle hooks (e.g. transaction-scoped usage),
        // and when the convergence guard skipped the write — nothing changed, so
        // invalidating caches is pure waste. Prod logged a "Skipping external-id write"
        // immediately followed by "External ID changed, invalidating caches" for the
        // same media id, which is the guard paying the cost it exists to avoid.
        if (!this.skipLifecycleHooks && didWrite && mappingChanged) {
            MediaLifecycleService.afterExternalIdChanged(mediaId).catch((err: unknown) => {
                logger.error(
                    'afterExternalIdChanged lifecycle hook failed',
                    err instanceof Error ? err : new Error(String(err)),
                    { mediaId, source: 'upsertExternalId' },
                );
            });
        }

        return { written: didWrite, changed: didWrite && mappingChanged };
    }

    /**
     * Batch upsert multiple external IDs in a single transaction.
     * All IDs must have mediaType specified.
     *
     * @param items - Array of {mediaId, externalId} pairs to upsert
     */
    async batchUpsertExternalIds(
        items: Array<{
            mediaId: string;
            externalId: ExternalIdWrite;
            isPrimary?: boolean;
        }>,
    ): Promise<void> {
        if (items.length === 0) return;

        // Normalize each item up-front. Jellyfin IDs are dashless so the
        // stale-cleanup and the insert agree on the stored value.
        type NormalizedItem = {
            mediaId: string;
            provider: string;
            mediaType: string;
            extIdValue: string;
            isPrimary: boolean;
            source: string;
            confidence: number;
        };
        const allNormalized: NormalizedItem[] = items.map(({ mediaId, externalId, isPrimary }) => ({
            mediaId,
            provider: externalId.provider,
            mediaType: externalId.mediaType,
            extIdValue:
                externalId.provider === 'jellyfin'
                    ? normalizeJellyfinId(externalId.id)
                    : externalId.id,
            isPrimary: isPrimary || false,
            source: externalId.source || 'api',
            confidence: externalId.confidence ?? 1.0,
        }));

        // Collapse duplicates on the ON CONFLICT key (provider, external_id,
        // media_type): a single INSERT ... ON CONFLICT statement cannot touch
        // the same target row twice, and the original sequential loop was
        // last-write-wins, so keep the last occurrence per key.
        const conflictKey = (n: NormalizedItem): string =>
            `${n.provider}\0${n.extIdValue}\0${n.mediaType}`;
        const dedup = new Map<string, NormalizedItem>();
        for (const n of allNormalized) dedup.set(conflictKey(n), n);

        // Second dedup, on the OTHER unique key. `conflictKey` covers
        // (provider, external_id, media_type); idx_external_ids_one_per_provider is
        // UNIQUE on (media_id, provider, media_type). Two DIFFERENT ids for one item
        // in a single batch therefore both survive the first dedup, both reach the
        // INSERT, and the second raises 23505 — aborting the whole transaction and
        // failing the entire scan batch, not just the offending pair. That is the
        // "same film in two libraries" shape arriving in one batch instead of two.
        // Last-write-wins here, matching the intra-batch rule above.
        const perItemKey = (n: NormalizedItem): string =>
            `${n.mediaId}\u0000${n.provider}\u0000${n.mediaType}`;
        const perItem = new Map<string, NormalizedItem>();
        for (const n of dedup.values()) perItem.set(perItemKey(n), n);
        if (perItem.size !== dedup.size) {
            logger.warn(
                'Batch carried multiple external ids for one (item, provider, type) — keeping the last',
                { dropped: dedup.size - perItem.size },
            );
        }
        const deduped: NormalizedItem[] = [...perItem.values()];
        const writtenMediaIds = new Set<string>();

        await withTx(this.sql, async (tx) => {
            const executor = tx as SqlExecutor;

            // Batch writes use the same durable Keep boundary as single-row
            // scanner writes. Lock each requested item and its ancestors in a
            // stable order, then read dispositions in a fresh statement so a
            // concurrent Keep writer is visible before any identity mutation.
            const targetIds = [...new Set(deduped.map((n) => n.mediaId))];
            const lockedItems =
                targetIds.length === 0
                    ? []
                    : await executor<{ id: string }[]>`
                    WITH RECURSIVE item_chain AS (
                        SELECT id AS target_id, id, parent_id
                        FROM media_items WHERE id = ANY(${targetIds}::uuid[])
                        UNION
                        SELECT child.target_id, parent.id, parent.parent_id
                        FROM media_items parent
                        JOIN item_chain child ON child.parent_id = parent.id
                    )
                    SELECT mi.id
                    FROM media_items mi
                    JOIN item_chain c ON c.id = mi.id
                    ORDER BY mi.id
                    FOR UPDATE OF mi
                `;
            const lockedIds = lockedItems.map((row) => row.id);
            const keptTargetIds =
                lockedIds.length === 0
                    ? new Set<string>()
                    : new Set(
                          (
                              await executor<{ target_id: string }[]>`
                    WITH RECURSIVE item_chain AS (
                        SELECT id AS target_id, id, parent_id
                        FROM media_items WHERE id = ANY(${targetIds}::uuid[])
                        UNION
                        SELECT child.target_id, parent.id, parent.parent_id
                        FROM media_items parent
                        JOIN item_chain child ON child.parent_id = parent.id
                    )
                    SELECT DISTINCT c.target_id
                    FROM item_chain c
                    JOIN personal_media_dispositions d ON d.media_id = c.id
                    WHERE d.disposition = 'kept'
                `
                          ).map((row) => row.target_id),
                      );
            const keptAutomatic = deduped.filter(
                (n) => n.source !== 'manual' && keptTargetIds.has(n.mediaId),
            );
            if (keptAutomatic.length > 0) {
                logger.info('Batch external-id writes skipped for kept personal media', {
                    skipped: keptAutomatic.length,
                });
            }
            const dispositionSafe = deduped.filter(
                (n) => n.source === 'manual' || !keptTargetIds.has(n.mediaId),
            );
            if (dispositionSafe.length === 0) return;

            // Drop writes that would displace a LIVE rival, the same way the
            // single-row upsertExternalId does — see the long comment there for the
            // prod loop this prevents. It cannot be a condition on the DELETE below:
            // idx_external_ids_one_per_provider is UNIQUE on
            // (media_id, provider, media_type), so leaving the rival in place while
            // still inserting would trade a swap for a unique violation. The item
            // has to leave the batch entirely.
            // Operator-initiated writes bypass the convergence guard here exactly as
            // they do in the single-row path. No caller routes a manual write through
            // the batch today, but the asymmetry is a landmine: the next person who
            // bulk-applies admin fixes reintroduces the silently-dropped-correction
            // bug verbatim.
            const guardable = dispositionSafe.filter((n) => n.source !== 'manual');
            const contested =
                guardable.length === 0
                    ? []
                    : await executor<
                          Array<{ media_id: string; provider: string; media_type: string }>
                      >`
                SELECT ei.media_id::text AS media_id, ei.provider, ei.media_type
                  FROM external_ids ei
                  JOIN unnest(
                      ${executor.array(guardable.map((n) => n.mediaId))}::uuid[],
                      ${executor.array(guardable.map((n) => n.provider))}::text[],
                      ${executor.array(guardable.map((n) => n.mediaType))}::text[],
                      ${executor.array(guardable.map((n) => n.extIdValue))}::text[]
                  ) AS w(media_id, provider, media_type, external_id)
                    ON w.media_id = ei.media_id
                   AND w.provider = ei.provider
                   AND w.media_type = ei.media_type
                 WHERE ei.external_id <> w.external_id
                   AND ei.created_at >= now() - ${`${IDENTITY_SWAP_MIN_AGE_SECONDS} seconds`}::interval
            `;
            // Ids already owned by a DIFFERENT media item. The single-row path throws
            // here (ExternalIdOwnedByAnotherItemError); the batch's
            // `ON CONFLICT ... DO UPDATE SET media_id = EXCLUDED.media_id` instead
            // silently REASSIGNS the row — an UPDATE with a changed media_id, so the
            // trigger fires identity events. Two items claiming one id across
            // alternating scan batches therefore ping-pong the row, which is the same
            // loop shape the single-row guard was written to stop, entering through a
            // different door. A batch must not fail wholesale for one bad pair, so
            // drop the offending items and log instead of throwing.
            const stealing = await executor<
                Array<{ provider: string; external_id: string; media_type: string }>
            >`
                SELECT ei.provider, ei.external_id, ei.media_type
                  FROM external_ids ei
                  JOIN unnest(
                    ${executor.array(dispositionSafe.map((n) => n.mediaId))}::uuid[],
                    ${executor.array(dispositionSafe.map((n) => n.provider))}::text[],
                    ${executor.array(dispositionSafe.map((n) => n.mediaType))}::text[],
                    ${executor.array(dispositionSafe.map((n) => n.extIdValue))}::text[]
                  ) AS w(media_id, provider, media_type, external_id)
                    ON w.provider = ei.provider
                   AND w.media_type = ei.media_type
                   AND w.external_id = ei.external_id
                 WHERE ei.media_id <> w.media_id
            `;
            const stolenKeys = new Set(
                stealing.map((r) => `${r.provider}\u0000${r.external_id}\u0000${r.media_type}`),
            );
            if (stolenKeys.size > 0) {
                logger.warn(
                    'Batch external-id writes skipped: id already belongs to another media item',
                    { skipped: stolenKeys.size },
                );
            }

            const contestedKeys = new Set(
                contested.map((r) => `${r.media_id}\u0000${r.provider}\u0000${r.media_type}`),
            );
            const normalized: NormalizedItem[] = dispositionSafe.filter(
                (n) =>
                    !contestedKeys.has(`${n.mediaId}\u0000${n.provider}\u0000${n.mediaType}`) &&
                    !stolenKeys.has(`${n.provider}\u0000${n.extIdValue}\u0000${n.mediaType}`),
            );
            if (normalized.length !== dispositionSafe.length) {
                logger.warn(
                    'Skipping external-id writes that would displace a freshly-written id for ' +
                        'the same provider. Usually the same title present twice at the provider.',
                    { skipped: dispositionSafe.length - normalized.length },
                );
            }
            if (normalized.length === 0) return;

            // Flattened keep-tuples — one row per (media_id, provider, media_type,
            // external_id) we are about to write.
            const keepMediaIds = normalized.map((n) => n.mediaId);
            const keepProviders = normalized.map((n) => n.provider);
            const keepMediaTypes = normalized.map((n) => n.mediaType);
            const keepExtIds = normalized.map((n) => n.extIdValue);

            // Batched stale cleanup: delete every row whose (media_id, provider,
            // media_type) group is touched by this batch but whose external_id
            // is NOT one of the kept IDs (e.g. a Jellyfin ID that changed after
            // a rescan). Returns surviving is_primary flags so a moved ID can
            // inherit primary status on re-insert.
            const stale = await executor<
                Array<{
                    media_id: string;
                    provider: string;
                    media_type: string;
                    is_primary: boolean;
                }>
            >`
                WITH keep AS (
                    SELECT media_id, provider, media_type, external_id
                    FROM unnest(
                        ${executor.array(keepMediaIds)}::uuid[],
                        ${executor.array(keepProviders)}::text[],
                        ${executor.array(keepMediaTypes)}::text[],
                        ${executor.array(keepExtIds)}::text[]
                    ) AS k(media_id, provider, media_type, external_id)
                )
                DELETE FROM external_ids ei
                WHERE EXISTS (
                    SELECT 1 FROM keep g
                    WHERE g.media_id = ei.media_id
                      AND g.provider = ei.provider
                      AND g.media_type = ei.media_type
                )
                AND NOT EXISTS (
                    SELECT 1 FROM keep k
                    WHERE k.media_id = ei.media_id
                      AND k.provider = ei.provider
                      AND k.media_type = ei.media_type
                      AND k.external_id = ei.external_id
                )
                RETURNING ei.media_id, ei.provider, ei.media_type, ei.is_primary
            `;

            // A group inherits primary status if ANY deleted row in it was primary.
            const groupHadPrimary = new Set<string>();
            for (const row of stale) {
                if (row.is_primary) {
                    groupHadPrimary.add(`${row.media_id}\0${row.provider}\0${row.media_type}`);
                }
            }

            // Batched insert via UNNEST. is_primary is the item's own flag OR
            // the inherited group primary status.
            const insMediaIds = normalized.map((n) => n.mediaId);
            const insProviders = normalized.map((n) => n.provider);
            const insExtIds = normalized.map((n) => n.extIdValue);
            const insMediaTypes = normalized.map((n) => n.mediaType);
            const insIsPrimary = normalized.map(
                (n) =>
                    n.isPrimary ||
                    groupHadPrimary.has(`${n.mediaId}\0${n.provider}\0${n.mediaType}`),
            );
            const insSources = normalized.map((n) => n.source);
            const insConfidences = normalized.map((n) => n.confidence);

            await executor`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source, confidence)
                SELECT * FROM unnest(
                    ${executor.array(insMediaIds)}::uuid[],
                    ${executor.array(insProviders)}::text[],
                    ${executor.array(insExtIds)}::text[],
                    ${executor.array(insMediaTypes)}::text[],
                    ${executor.array(insIsPrimary)}::boolean[],
                    ${executor.array(insSources)}::text[],
                    ${executor.array(insConfidences)}::double precision[]
                )
                ON CONFLICT (provider, external_id, media_type) DO UPDATE SET
                    media_id = EXCLUDED.media_id,
                    confidence = GREATEST(external_ids.confidence, EXCLUDED.confidence),
                    source = COALESCE(EXCLUDED.source, external_ids.source)
            `;
            for (const n of normalized) writtenMediaIds.add(n.mediaId);
            // Manual identity supersedes a direct Keep only if it actually
            // reached the insert. A rejected conflict leaves the disposition
            // intact for the operator to retry or review.
            const successfullyWrittenManualIds = [
                ...new Set(normalized.filter((n) => n.source === 'manual').map((n) => n.mediaId)),
            ];
            if (successfullyWrittenManualIds.length > 0) {
                await executor`DELETE FROM personal_media_dispositions
                               WHERE media_id = ANY(${successfullyWrittenManualIds}::uuid[])`;
            }
        });

        // Fire-and-forget lifecycle hooks — once per unique mediaId
        // Skipped when caller manages lifecycle hooks (e.g. transaction-scoped usage)
        if (!this.skipLifecycleHooks) {
            const uniqueMediaIds = writtenMediaIds;
            for (const id of uniqueMediaIds) {
                MediaLifecycleService.afterExternalIdChanged(id).catch((err: unknown) => {
                    logger.error(
                        'afterExternalIdChanged lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        { mediaId: id, source: 'batchUpsertExternalIds' },
                    );
                });
            }
        }
    }

    /**
     * Update the media_type of an existing external_id.
     * Used for TMDB type corrections when the actual type differs from what was stored.
     *
     * @param provider - The provider (e.g., 'tmdb')
     * @param externalId - The external ID value
     * @param oldMediaType - The current (incorrect) media type
     * @param newMediaType - The correct media type
     */
    async updateExternalIdMediaType(
        provider: string,
        externalId: string,
        oldMediaType: MediaType,
        newMediaType: MediaType,
    ): Promise<void> {
        await this.sql`
            UPDATE external_ids
            SET media_type = ${newMediaType}
            WHERE provider = ${provider}
                AND external_id = ${externalId}
                AND media_type = ${oldMediaType}
        `;

        logger.info(
            `Updated media_type for ${provider}:${externalId}: ${oldMediaType} → ${newMediaType}`,
        );
    }

    /**
     * Delete ALL external_id rows for a media item.
     *
     * Canonical removal path for `external_ids` — callers must route through
     * this method instead of issuing raw `DELETE FROM external_ids` (composite
     * key integrity + lifecycle invalidation are owned here). Used by merge /
     * hard-delete flows that retire a duplicate or removed media item.
     *
     * @param mediaId - Internal media UUID whose external IDs are removed
     * @returns Number of external_id rows deleted
     */
    async deleteExternalIdsForMediaId(mediaId: string): Promise<number> {
        const deleted = await this.sql<Array<{ media_id: string }>>`
            DELETE FROM external_ids
            WHERE media_id = ${mediaId}
            RETURNING media_id
        `;

        // Fire-and-forget lifecycle hook for cache invalidation.
        // Skipped when caller manages lifecycle hooks (e.g. transaction-scoped usage).
        if (!this.skipLifecycleHooks && deleted.length > 0) {
            MediaLifecycleService.afterExternalIdChanged(mediaId).catch((err: unknown) => {
                logger.error(
                    'afterExternalIdChanged lifecycle hook failed',
                    err instanceof Error ? err : new Error(String(err)),
                    { mediaId, source: 'deleteExternalIdsForMediaId' },
                );
            });
        }

        return deleted.length;
    }

    /**
     * Delete ALL external_id rows for a set of media items in a single
     * statement.
     *
     * Batch sibling of {@link deleteExternalIdsForMediaId} for cascade flows
     * (e.g. hard-deleting an item plus its seasons/episodes) — issues one
     * `DELETE ... WHERE media_id = ANY(...)` instead of N round-trips while
     * still owning composite-key integrity and lifecycle invalidation. The
     * lifecycle hook fires once per affected media id (only those that actually
     * had rows removed).
     *
     * @param mediaIds - Internal media UUIDs whose external IDs are removed
     * @returns Number of external_id rows deleted
     */
    async deleteExternalIdsForMediaIds(mediaIds: string[]): Promise<number> {
        if (mediaIds.length === 0) {
            return 0;
        }

        const deleted = await this.sql<Array<{ media_id: string }>>`
            DELETE FROM external_ids
            WHERE media_id = ANY(${mediaIds})
            RETURNING media_id
        `;

        // Fire-and-forget lifecycle hooks, one per distinct affected media id.
        // Skipped when caller manages lifecycle hooks (e.g. transaction-scoped).
        if (!this.skipLifecycleHooks && deleted.length > 0) {
            const affected = new Set(deleted.map((row) => row.media_id));
            for (const mediaId of affected) {
                MediaLifecycleService.afterExternalIdChanged(mediaId).catch((err: unknown) => {
                    logger.error(
                        'afterExternalIdChanged lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        {
                            mediaId,
                            source: 'deleteExternalIdsForMediaIds',
                        },
                    );
                });
            }
        }

        return deleted.length;
    }

    /**
     * Delete the external_id rows for a single (media_id, provider) pair.
     *
     * Composite-key safe: when `mediaType` is supplied the delete is scoped to
     * that exact `(media_id, provider, media_type)` triple so a provider id that
     * is reused across media types (TMDB `1429` = a movie AND a series) is never
     * removed from the wrong item. Omit `mediaType` only for callers that
     * genuinely want every media_type for the pair gone.
     *
     * Canonical single-provider removal path for `external_ids` — callers must
     * route through this method instead of issuing raw `DELETE FROM external_ids`
     * (lifecycle invalidation is owned here). Used by the admin external-id
     * editor.
     *
     * @param mediaId - Internal media UUID whose external IDs are removed
     * @param provider - Provider name (e.g. 'tmdb', 'jellyfin')
     * @param mediaType - Optional media type to scope the delete (composite key)
     * @returns Number of external_id rows deleted
     */
    async deleteExternalId(
        mediaId: string,
        provider: string,
        mediaType?: MediaType,
    ): Promise<number> {
        const deleted = mediaType
            ? await this.sql<Array<{ media_id: string }>>`
                DELETE FROM external_ids
                WHERE media_id = ${mediaId}
                  AND provider = ${provider}
                  AND media_type = ${mediaType}
                RETURNING media_id
            `
            : await this.sql<Array<{ media_id: string }>>`
                DELETE FROM external_ids
                WHERE media_id = ${mediaId}
                  AND provider = ${provider}
                RETURNING media_id
            `;

        // Fire-and-forget lifecycle hook for cache invalidation.
        // Skipped when caller manages lifecycle hooks (e.g. transaction-scoped usage).
        if (!this.skipLifecycleHooks && deleted.length > 0) {
            MediaLifecycleService.afterExternalIdChanged(mediaId).catch((err: unknown) => {
                logger.error(
                    'afterExternalIdChanged lifecycle hook failed',
                    err instanceof Error ? err : new Error(String(err)),
                    { mediaId, source: 'deleteExternalId' },
                );
            });
        }

        return deleted.length;
    }

    /**
     * Delete every external_id contributed by a given provider set and source.
     *
     * Canonical bulk-removal path for `external_ids` that are owned by a single
     * enrichment source and need to be re-fetched on the next drain (e.g. a
     * force-mode anime sync wiping its `('mal', 'anilist')` ids tagged
     * `source = 'fribb-anime-lists'`). Spans all media items, so there is no
     * single mediaId to invalidate — callers performing this wipe are expected
     * to construct the service with `skipLifecycleHooks: true` and drive their
     * own re-enrollment.
     *
     * @param providers - Provider names whose rows are removed (composite source key)
     * @param source - The `source` tag that scopes the wipe to one contributor
     * @returns Number of external_id rows deleted
     */
    async deleteExternalIdsByProviderSource(providers: string[], source: string): Promise<number> {
        if (providers.length === 0) return 0;
        const deleted = await this.sql<Array<{ id: string }>>`
            DELETE FROM external_ids
            WHERE provider = ANY(${providers})
              AND source = ${source}
            RETURNING id
        `;
        return deleted.length;
    }

    /**
     * Update library availability for a media item
     */
    async updateLibraryAvailability(
        mediaId: string,
        library: string,
        libraryItemId: string,
        available: boolean,
        quality?: string,
    ): Promise<void> {
        // Normalize Jellyfin library item IDs to dashless format
        const normalizedItemId =
            library === 'jellyfin' ? normalizeJellyfinId(libraryItemId) : libraryItemId;
        await this.sql`
            INSERT INTO library_availability (media_id, library, library_item_id, available, quality, last_verified_at)
            VALUES (${mediaId}, ${library}, ${normalizedItemId}, ${available}, ${quality || null}, NOW())
            ON CONFLICT (media_id, library) DO UPDATE SET
                library_item_id = EXCLUDED.library_item_id,
                available = EXCLUDED.available,
                quality = COALESCE(EXCLUDED.quality, library_availability.quality),
                last_verified_at = NOW()
        `;
    }

    /**
     * Check if a media item is available in any library
     */
    async isAvailable(mediaId: string): Promise<boolean> {
        return isMediaAvailable(this.sql, mediaId);
    }

    /**
     * Get provider metadata for a media item
     */
    async getProviderMetadata(
        mediaId: string,
        provider?: string,
    ): Promise<
        Array<{
            provider: string;
            metadata: Record<string, unknown>;
            fetchedAt: Date;
        }>
    > {
        const rows = await getProviderMetadataQuery(this.sql, {
            mediaId,
            provider,
        });

        return rows.map((row) => ({
            provider: row.provider,
            metadata: row.metadata,
            fetchedAt: row.fetched_at,
        }));
    }

    /**
     * Replace provider metadata on refresh, retaining only the newest discovery
     * detail-sync stamp. Omitted provider fields must disappear.
     *
     * When storing metadata for a non-aggregated provider (tmdb, mdblist, jellyfin),
     * this method automatically triggers re-aggregation to merge fields from all
     * providers into the 'aggregated' row.
     *
     * The INSERT/UPDATE below is itself lock-guarded (C3 fix-round-2,
     * 2026-09-25 security review) — `options.force` bypasses `metadata_locked`
     * here too, not just on the re-aggregation call. Previously this method's
     * write was unconditional, relying entirely on its sole caller
     * (metadata-sync-single.service.ts's per-item admin sync) gating the CALL
     * on `canWrite = options.force || !current.metadata_locked` computed
     * earlier in that caller — a lock landing between that `canWrite` read
     * and this write (or any future caller that forgets to gate the call
     * site) would have been silently overwritten.
     */
    async storeProviderMetadata(
        mediaId: string,
        provider: string,
        metadata: Record<string, unknown>,
        fieldSources?: Record<string, string>,
        expiresAt?: Date,
        options?: { force?: boolean },
    ): Promise<void> {
        // Pre-clean undefined values
        const cleanMetadata = Object.fromEntries(
            Object.entries(metadata).filter(([_, v]) => v !== undefined),
        );
        const force = options?.force ?? false;

        // Lock check is atomic with the write (single statement, no
        // SELECT-then-write race) — same idiom as
        // `upsertProviderMetadataUnlessLocked` (media-upsert.ts): the INSERT
        // source is `FROM media_items WHERE id=$1 AND (force OR NOT
        // metadata_locked)`, and the ON CONFLICT arm re-checks the lock via a
        // matching `WHERE force OR NOT EXISTS (...)`.
        await this.sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, field_sources, fetched_at, expires_at)
            SELECT mi.id, ${provider}, ${this.sql.json(cleanMetadata as Record<string, never>)},
                   ${fieldSources ? this.sql.json(fieldSources) : null}, NOW(), ${expiresAt || null}
            FROM media_items mi
            WHERE mi.id = ${mediaId} AND (${force} OR NOT mi.metadata_locked)
            ON CONFLICT (media_id, provider) DO UPDATE SET
                -- Replace provider fields, carrying forward only the newest GC keep stamp.
                -- CASE guards timestamp casts even for malformed legacy metadata.
                metadata = EXCLUDED.metadata || CASE
                    WHEN pg_input_is_valid(provider_metadata.metadata->>'discovery_detail_synced_at', 'timestamp with time zone')
                    THEN CASE
                        WHEN pg_input_is_valid(EXCLUDED.metadata->>'discovery_detail_synced_at', 'timestamp with time zone')
                        THEN CASE
                            WHEN (provider_metadata.metadata->>'discovery_detail_synced_at')::timestamptz > (EXCLUDED.metadata->>'discovery_detail_synced_at')::timestamptz
                            THEN jsonb_build_object('discovery_detail_synced_at', provider_metadata.metadata->'discovery_detail_synced_at')
                            ELSE '{}'::jsonb
                        END
                        ELSE jsonb_build_object('discovery_detail_synced_at', provider_metadata.metadata->'discovery_detail_synced_at')
                    END
                    ELSE '{}'::jsonb
                END
                -- Carry forward the last-full-season-fetch stamp (series-sync
                -- season refresh plan); a sync's own blob never contains it.
                || CASE
                    WHEN provider_metadata.metadata->'seasons_full_fetch_at' IS NOT NULL
                         AND EXCLUDED.metadata->'seasons_full_fetch_at' IS NULL
                    THEN jsonb_build_object('seasons_full_fetch_at', provider_metadata.metadata->'seasons_full_fetch_at')
                    ELSE '{}'::jsonb
                END,
                field_sources = COALESCE(EXCLUDED.field_sources, provider_metadata.field_sources),
                updated_at = NOW(),
                expires_at = EXCLUDED.expires_at
            WHERE ${force} OR NOT EXISTS (
                SELECT 1 FROM media_items lc
                WHERE lc.id = provider_metadata.media_id AND lc.metadata_locked
            )
        `;

        // Trigger re-aggregation only if this provider is used in field priorities
        // This avoids unnecessary work when storing metadata from unused providers
        if (provider !== 'aggregated' && isProviderUsedInAggregation(provider)) {
            await aggregateMetadataForMedia(this.sql, mediaId, { force: options?.force });
        }
    }

    /**
     * Batch resolve external IDs to UUIDs
     */
    async batchResolve(
        items: Array<{
            provider: string;
            externalId: string;
            mediaType?: string;
        }>,
    ): Promise<Map<string, string>> {
        return batchResolveExternalIds(this.sql, items);
    }
}

// Factory function
export function createCatalogService(
    sql: postgres.Sql,
    options?: { skipLifecycleHooks?: boolean },
): CatalogService {
    return new CatalogService(sql, options);
}
