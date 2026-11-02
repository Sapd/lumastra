// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Upsert Utilities
 *
 * Provides functions for upserting media items into the UUID-based tables.
 * Used by sync services to properly insert/update media metadata.
 */

import type postgres from 'postgres';
import { Logger } from '../../utils/logger.js';
import { CatalogService } from '../../services/catalog.service.js';
import type { ExternalIdWrite } from '../../providers/provider-types.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { normalizeJellyfinId } from '../../utils/jellyfin-id.js';
import { MediaLifecycleService } from '../../services/media-lifecycle.service.js';
import { deriveSortTitle } from '../../utils/sort-title.js';
import { applyNationalAgeRating, invalidateAgeCache } from './age-rating-source.queries.js';
import { refreshSortTitles } from './sort-title.queries.js';
import { upsertMediaTitles, type MediaTitleInput } from './media-titles.queries.js';
import { withTx } from '../with-tx.js';

const logger = Logger.for('MediaUpsert');

/**
 * Media metadata for upserting
 */
export interface MediaUpsertData {
    // Core identification
    primaryExternalId?: string | null;
    mediaType: 'movie' | 'tv';
    title: string;
    originalTitle?: string | null;
    /** ISO 639-1 language of `originalTitle` (e.g. 'ja'), when known. */
    originalLanguage?: string | null;
    englishTitle?: string | null;

    // Optional external IDs
    imdbId?: string | null;
    jellyfinId?: string | null;

    // Core metadata
    overview?: string | null;
    releaseDate?: string | null;
    year?: number | null;
    runtimeMinutes?: number | null;

    // Ratings
    imdbRating?: number | null;
    externalRating?: number | null;

    // Content info
    certification?: string | null;
    genres?: number[] | null;
    keywords?: string[] | null;

    // People
    actors?: string[] | null;
    directors?: string[] | null;
    producers?: string[] | null;
    writers?: string[] | null;

    // Availability
    isAvailable?: boolean;
    isLocalOnly?: boolean;
    canRequest?: boolean;

    // Library info (for Jellyfin)
    jellyfinLibraryId?: string | null;
    jellyfinLibraryName?: string | null;

    // Provider-specific metadata (stored as JSONB)
    providerMetadata?: Record<string, unknown>;
}

/**
 * Result of an upsert operation
 */
export interface MediaUpsertResult {
    mediaId: string;
    inserted: boolean;
}

/**
 * Merge `metadata` into a media item's `provider_metadata` row for `provider`,
 * skipping the write when the item is `metadata_locked` (an admin hand-edit
 * that background/scheduled syncs must not clobber) unless `force` is set.
 *
 * The lock check is atomic with the write — a single `INSERT ... SELECT ...
 * FROM media_items WHERE id = … AND (force OR NOT metadata_locked)`, mirrored
 * on the `ON CONFLICT DO UPDATE` branch — so there is no separate
 * SELECT/write race (same shape as `applyLocalNfoDisplayMetadata` in
 * media-items.queries.ts and the `WHERE force OR NOT metadata_locked` upserts
 * in metadata-sync-single.service.ts). A `mediaId` that doesn't match any
 * `media_items` row (already deleted, or never existed) also yields 0 rows —
 * the `SELECT ... FROM media_items` source simply produces nothing to insert,
 * not a foreign-key error.
 *
 * The chokepoint for the `provider_metadata` JSONB-merge SHAPE specifically
 * (`metadata || EXCLUDED.metadata` with the `jsonb_typeof` corruption
 * fallback) — it replaced four previously hand-kept copies of that exact SQL
 * (media-upsert.ts's own former inline block; ai-sync.queries.ts's
 * `upsertProviderMetadata` and `upsertAggregatedMetadata`;
 * embedding-operations.queries.ts's `upsertProviderMetadata`). Every caller
 * of that shape (TMDB sync, cast backfill, embedding generation, Jellyfin
 * season/episode image_tag sync, mdblist-sync's `sync-missing-metadata.ts`
 * enrichment pass, the four episode-thumbnail `still_path` reconciliation
 * writers) now goes through this one function.
 *
 * It is NOT the only `provider_metadata` writer in the codebase — three
 * writers with a genuinely different merge/replace shape keep their own
 * lock-guarded SQL rather than being force-fit into this one:
 *   - `aggregateMetadataForMedia` / `upsertAggregatedRowsBatch`
 *     (metadata-aggregation.queries.ts) — full-replace with a selective
 *     enrichment-key preserve clause, not a blanket `||` merge.
 *   - `upsertMdblistMetadata` (ai-sync.queries.ts) — full-replace, resolved
 *     via `external_ids` rather than a known `mediaId`.
 *   - `CatalogService.storeProviderMetadata` (catalog.service.ts) —
 *     merges metadata plus field_sources/expiry bookkeeping; carries its own
 *     `WHERE force OR NOT metadata_locked` guard.
 *
 * Returns the number of rows the write touched: 0 when the item is locked
 * and `force` is false (or `mediaId` doesn't exist), 1 when it landed.
 * **A 0 is not a failure** — callers must not treat it as an error or a
 * signal to retry/re-enroll the item (see `updateOriginalTitleByTmdbId` in
 * ai-sync.queries.ts for the same contract elsewhere in this codebase; a past
 * regression there conflated "wrote nothing because locked" with "failed").
 */
export async function upsertProviderMetadataUnlessLocked(
    sql: postgres.Sql,
    mediaId: string,
    provider: string,
    metadata: Record<string, unknown>,
    options: { force?: boolean } = {},
): Promise<number> {
    const force = options.force ?? false;
    const result = await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
        SELECT mi.id, ${provider}, ${sql.json(metadata as Record<string, never>)}, NOW()
        FROM media_items mi
        WHERE mi.id = ${mediaId} AND (${force} OR NOT mi.metadata_locked)
        FOR UPDATE OF mi
        ON CONFLICT (media_id, provider) DO UPDATE SET
            metadata = CASE
                WHEN jsonb_typeof(provider_metadata.metadata) = 'object'
                THEN provider_metadata.metadata || EXCLUDED.metadata
                ELSE EXCLUDED.metadata
            END,
            updated_at = NOW()
        WHERE ${force} OR NOT EXISTS (
            SELECT 1 FROM media_items locked_check
            WHERE locked_check.id = provider_metadata.media_id
                AND locked_check.metadata_locked
        )
    `;
    return result.count;
}

/**
 * Cascading multi-ID lookup to find an existing media_items row.
 *
 * Tries identifiers in confidence order:
 *   1. Primary provider ID + mediaType (e.g. TMDB)
 *   2. Jellyfin ID + mediaType
 *   3. IMDB ID + mediaType
 *   4. Title + mediaType + year (normalized, top-level items only)
 *
 * Returns the media_items UUID of the best match, or null if no match.
 */
interface FindExistingMediaParams {
    primaryProvider: string;
    primaryExternalId: string | null;
    jellyfinId: string | null;
    imdbId: string | null;
    mediaType: string;
    title: string;
    year: number | null;
}

async function findExistingMedia(
    sql: postgres.Sql,
    params: FindExistingMediaParams,
): Promise<string | null> {
    const { primaryProvider, primaryExternalId, jellyfinId, imdbId, mediaType, title, year } =
        params;

    // Build WHERE conditions and LEFT JOINs dynamically based on available IDs.
    // We use a single query with a CASE-based match_rank to pick the best hit.
    const hasPrimary = primaryExternalId != null && primaryExternalId.length > 0;
    const hasJellyfin = jellyfinId != null && jellyfinId.length > 0;
    const hasImdb = imdbId != null && imdbId.length > 0;

    // If no IDs at all, go straight to title match
    if (!hasPrimary && !hasJellyfin && !hasImdb) {
        const [titleMatch] = await sql<Array<{ id: string }>>`
            SELECT mi.id
            FROM media_items mi
            WHERE mi.media_type = ${mediaType}
              AND mi.parent_id IS NULL
              AND lower(mi.title) = lower(${title})
              AND (
                  (mi.year = ${year} OR (mi.year IS NULL AND ${year}::int IS NULL))
              )
            ORDER BY mi.created_at ASC
            LIMIT 1
        `;
        return titleMatch?.id ?? null;
    }

    // Build a single query with optional LEFT JOINs
    const rows = await sql<Array<{ id: string; match_rank: number }>>`
        SELECT DISTINCT mi.id,
            CASE
                ${hasPrimary ? sql`WHEN ei_primary.id IS NOT NULL THEN 1` : sql`WHEN false THEN 1`}
                ${hasJellyfin ? sql`WHEN ei_jf.id IS NOT NULL THEN 2` : sql`WHEN false THEN 2`}
                ${hasImdb ? sql`WHEN ei_imdb.id IS NOT NULL THEN 3` : sql`WHEN false THEN 3`}
                ELSE 4
            END AS match_rank
        FROM media_items mi
        ${
            hasPrimary
                ? sql`LEFT JOIN external_ids ei_primary ON ei_primary.media_id = mi.id
            AND ei_primary.provider = ${primaryProvider}
            AND ei_primary.external_id = ${primaryExternalId}
            AND ei_primary.media_type = ${mediaType}`
                : sql``
        }
        ${
            hasJellyfin
                ? sql`LEFT JOIN external_ids ei_jf ON ei_jf.media_id = mi.id
            AND ei_jf.provider = 'jellyfin'
            AND ei_jf.external_id = ${normalizeJellyfinId(jellyfinId)}`
                : sql``
        }
        ${
            hasImdb
                ? sql`LEFT JOIN external_ids ei_imdb ON ei_imdb.media_id = mi.id
            AND ei_imdb.provider = 'imdb'
            AND ei_imdb.external_id = ${imdbId}
            AND ei_imdb.media_type = ${mediaType}`
                : sql``
        }
        WHERE (
            ${hasPrimary ? sql`ei_primary.id IS NOT NULL` : sql`false`}
            ${hasJellyfin ? sql`OR ei_jf.id IS NOT NULL` : sql``}
            ${hasImdb ? sql`OR ei_imdb.id IS NOT NULL` : sql``}
            OR (
                mi.media_type = ${mediaType}
                AND mi.parent_id IS NULL
                AND lower(mi.title) = lower(${title})
                AND (mi.year = ${year} OR (mi.year IS NULL AND ${year}::int IS NULL))
            )
        )
        ORDER BY match_rank ASC
        LIMIT 1
    `;

    return rows.length > 0 ? rows[0].id : null;
}

/**
 * Upsert media metadata into UUID-based tables.
 *
 * This function:
 * 1. Gets or creates the media_items record
 * 2. Upserts external IDs (TMDB, IMDB, Jellyfin)
 * 3. Upserts library availability
 * 4. Upserts provider metadata
 *
 * @param sql - Postgres.js sql instance
 * @param data - Media metadata to upsert
 * @returns The media ID and whether it was inserted (vs updated)
 */
export async function upsertMediaMetadata(
    sql: postgres.Sql,
    data: MediaUpsertData,
): Promise<MediaUpsertResult> {
    const hasValidPrimaryId = data.primaryExternalId != null && data.primaryExternalId.length > 0;

    // Step 1: Get or create media_items record
    let mediaId: string;
    let inserted = false;

    const primaryProvider = getPrimaryExternalIdProvider();

    const lookupParams: FindExistingMediaParams = {
        primaryProvider,
        primaryExternalId: hasValidPrimaryId ? data.primaryExternalId! : null,
        jellyfinId: data.jellyfinId ?? null,
        imdbId: data.imdbId ?? null,
        mediaType: data.mediaType,
        title: data.title,
        year: data.year ?? null,
    };

    // Cascading multi-ID lookup: try TMDB → Jellyfin → IMDB → title+year
    // This prevents orphan duplicates when an item is synced with different ID sets.
    const existing = await findExistingMedia(sql, lookupParams);

    // A miss is re-checked and the row created under a per-identity advisory
    // lock, together with its primary external id, in ONE transaction. Before,
    // two concurrent upserts of the same title both missed, both inserted, and
    // the loser's external-id write threw after its media_items row was already
    // committed: a twin with no external id that nothing can ever refresh or
    // match again (711 such movies on prod, 2026-06/07).
    const created = existing
        ? null
        : await withTx(sql, async (tx) => {
              const txSql = tx as unknown as postgres.Sql;
              // findExistingMedia falls back to a title+year match for EVERY
              // caller, so the title identity is always locked: a TMDB-id upsert
              // and a title-only upsert of the same title would otherwise hold
              // different locks and both insert. The title key is normalised in
              // SQL with the same lower() the title match uses. Both keys are
              // taken in sorted hash order so two callers can never deadlock.
              const primaryKey = `${primaryProvider}:${data.primaryExternalId}:${data.mediaType}`;
              const lockHashes = await txSql<Array<{ h: number }>>`
                  SELECT DISTINCT h FROM (
                      SELECT hashtext('title:' || ${data.mediaType}::text || ':' || ${String(data.year ?? '')}::text || ':' || lower(${data.title}::text)) AS h
                      ${hasValidPrimaryId ? txSql`UNION ALL SELECT hashtext(${primaryKey}::text)` : txSql``}
                  ) keys
                  ORDER BY h
              `;
              for (const { h } of lockHashes) {
                  await txSql`SELECT pg_advisory_xact_lock(hashtext('media-upsert'), ${h}::int)`;
              }
              const raced = await findExistingMedia(txSql, lookupParams);
              if (raced) return { id: raced, inserted: false };
              const sortTitle = deriveSortTitle(data.title, data.englishTitle, data.originalTitle);
              const [item] = await txSql`
                  INSERT INTO media_items (title, original_title, english_title, sort_title, year, media_type, is_local_only, overview)
                  VALUES (
                      ${data.title},
                      ${data.originalTitle || null},
                      ${data.englishTitle || null},
                      ${sortTitle},
                      ${data.year || null},
                      ${data.mediaType},
                      ${data.isLocalOnly ?? !hasValidPrimaryId},
                      ${data.overview || null}
                  )
                  RETURNING id
              `;
              const id = item.id as string;
              // Add primary provider external ID (only when valid) - use CatalogService
              if (hasValidPrimaryId) {
                  await new CatalogService(txSql).upsertExternalId(
                      id,
                      {
                          provider: primaryProvider,
                          id: data.primaryExternalId!,
                          mediaType: data.mediaType,
                          source: 'sync',
                      },
                      true,
                  );
              }
              return { id, inserted: true };
          });

    if (created?.inserted) {
        mediaId = created.id;
        inserted = true;
    } else {
        mediaId = existing ?? created!.id;

        // Update media_items. RETURNING id lets us detect whether the row
        // was actually modified — an empty result means metadata_locked
        // filtered it out, so we must NOT fire the lifecycle hook (which
        // would trigger spurious embedding regeneration and cache churn).
        // Recompute the normalized sort key from the provided values so A-Z
        // ordering stays correct when the title/english_title change. Derived by
        // the same helper as the migration backfill (the app is the sole writer
        // of sort_title — no DB trigger).
        const sortTitle = deriveSortTitle(data.title, data.englishTitle, data.originalTitle);

        const updatedRows = await sql<{ id: string }[]>`
            UPDATE media_items SET
                title = COALESCE(${data.title}, title),
                original_title = COALESCE(${data.originalTitle || null}, original_title),
                english_title = COALESCE(${data.englishTitle || null}, english_title),
                sort_title = ${sortTitle},
                year = COALESCE(${data.year || null}, year),
                overview = COALESCE(${data.overview || null}, overview),
                is_local_only = COALESCE(${data.isLocalOnly ?? !hasValidPrimaryId}, is_local_only),
                updated_at = NOW()
            WHERE id = ${mediaId} AND metadata_locked = false
            RETURNING id
        `;

        // The statement above derives the key without a language; re-derive it
        // with the library's declared language so a German library keeps
        // "Der Z" under Z.
        if (updatedRows.length > 0) await refreshSortTitles(sql, [mediaId]);

        // Fire lifecycle hook only when the row actually changed.
        if (updatedRows.length > 0) {
            const changedFields: string[] = [];
            if (data.title) changedFields.push('title');
            if (data.overview) changedFields.push('overview');
            if (data.year) changedFields.push('year');
            if (changedFields.length > 0) {
                // Fire-and-forget but surface failures — the inner method's
                // handleTriggerFailure escalates unknown-task at error+TAG in
                // prod and re-throws in dev. We log here so non-task errors
                // (cache invalidation, etc.) are also visible instead of
                // being swallowed by a bare `.catch(() => {})`.
                MediaLifecycleService.afterMetadataChanged(mediaId, changedFields, sql).catch(
                    (err: unknown) => {
                        logger.error(
                            'afterMetadataChanged lifecycle hook failed',
                            err instanceof Error ? err : new Error(String(err)),
                            { mediaId, changedFields },
                        );
                    },
                );
            }
        }
    }

    // Step 2: Upsert other external IDs via CatalogService
    const catalogService = new CatalogService(sql);
    const externalIdsToUpsert: Array<{
        mediaId: string;
        externalId: ExternalIdWrite;
    }> = [];

    if (data.imdbId) {
        externalIdsToUpsert.push({
            mediaId,
            externalId: {
                provider: 'imdb',
                id: data.imdbId,
                mediaType: data.mediaType,
                source: 'sync',
            },
        });
    }

    if (data.jellyfinId) {
        externalIdsToUpsert.push({
            mediaId,
            externalId: {
                provider: 'jellyfin',
                id: data.jellyfinId,
                mediaType: data.mediaType,
                source: 'sync',
            },
        });
    }

    // Batch upsert external IDs
    if (externalIdsToUpsert.length > 0) {
        await catalogService.batchUpsertExternalIds(externalIdsToUpsert);
    }

    // Step 3: Upsert library availability
    if (data.jellyfinId) {
        await catalogService.updateLibraryAvailability(
            mediaId,
            'jellyfin',
            data.jellyfinId,
            data.isAvailable ?? true,
        );
    }

    // Step 4: Persist searchable title aliases. Full TMDB localized titles are
    // added by the per-item sync path, but every metadata upsert should at least
    // keep primary/original/English names in the side table that search reads.
    const titleAliases: MediaTitleInput[] = [
        { title: data.title, language: null, kind: 'primary' },
    ];
    if (data.originalTitle) {
        titleAliases.push({
            title: data.originalTitle,
            language: data.originalLanguage ?? null,
            kind: 'original',
        });
    }
    if (data.englishTitle) {
        titleAliases.push({ title: data.englishTitle, language: 'en', kind: 'localized' });
    }
    await upsertMediaTitles(sql, mediaId, titleAliases, primaryProvider);

    // Step 5: Build and upsert provider metadata
    const metadata: Record<string, unknown> = {};

    // Core metadata
    if (data.overview) metadata.overview = data.overview;
    if (data.releaseDate) metadata.release_date = data.releaseDate;
    if (data.runtimeMinutes) metadata.runtime_minutes = data.runtimeMinutes;
    if (data.certification) metadata.certification = data.certification;

    // Ratings
    if (data.imdbRating !== undefined && data.imdbRating !== null) {
        metadata.imdb_rating = data.imdbRating;
    }
    if (data.externalRating !== undefined && data.externalRating !== null) {
        metadata.vote_average = data.externalRating;
    }

    // Arrays
    if (data.genres?.length) metadata.genres = data.genres;
    if (data.keywords?.length) metadata.keywords = data.keywords;
    if (data.actors?.length) metadata.actors = data.actors;
    if (data.directors?.length) metadata.directors = data.directors;
    if (data.producers?.length) metadata.producers = data.producers;
    if (data.writers?.length) metadata.writers = data.writers;

    // Availability flags
    if (data.isAvailable !== undefined) metadata.is_available = data.isAvailable;
    if (data.canRequest !== undefined) metadata.can_request = data.canRequest;

    // Library info
    if (data.jellyfinLibraryId) {
        metadata.jellyfin_library_id = data.jellyfinLibraryId;
    }
    if (data.jellyfinLibraryName) {
        metadata.jellyfin_library_name = data.jellyfinLibraryName;
    }

    // Merge any provider-specific metadata
    if (data.providerMetadata) {
        Object.assign(metadata, data.providerMetadata);
    }

    // Only upsert if we have metadata
    if (Object.keys(metadata).length > 0) {
        // Determine provider based on source
        const provider = data.jellyfinId ? 'jellyfin' : primaryProvider;

        // Background/sweep path — never force. The only intended override is
        // the single-item admin sync (metadata-sync-single.service.ts), which
        // does not call upsertMediaMetadata.
        await upsertProviderMetadataUnlessLocked(sql, mediaId, provider, metadata);
    }

    // A national certification (TMDB release dates in the configured country,
    // Jellyfin OfficialRating) sets the age rating and beats MDBList. Not gated
    // on the metadata lock: age_rating is an access-control input, see
    // updateMediaAgeRating.
    if (data.certification) {
        await applyNationalAgeRating(sql, mediaId, data.certification);
    }

    // Fire-and-forget lifecycle hook for new media items
    if (inserted) {
        MediaLifecycleService.afterCreated(mediaId, 'upsertMediaMetadata', sql).catch(
            (err: unknown) => {
                logger.error(
                    'afterCreated lifecycle hook failed',
                    err instanceof Error ? err : new Error(String(err)),
                    { mediaId, source: 'upsertMediaMetadata' },
                );
            },
        );
    }

    return { mediaId, inserted };
}

/**
 * Update the cached age_rating on media_items from MDBList.
 * This is a direct column (not JSONB) for efficient filtering.
 * Only updates if the value actually changed.
 *
 * MDBList only FILLS: a rating that came from a national certification
 * (`age_rating_source = 'national'`, see `applyNationalAgeRating`) is never
 * overwritten, because the national system (FSK, MPAA, BBFC, ...) is the one the
 * household's age limits are written against. The guard lives in the UPDATE itself,
 * so concurrent writers cannot race it.
 *
 * Deliberately NOT gated on `metadata_locked`. The lock freezes what an admin
 * edited; `age_rating` has no admin edit path (certifications and MDBList are its
 * only writers), so there is no admin decision to protect. It is an access-control
 * input: a lock could only keep a stale or NULL rating, and a NULL rating is
 * visible to an age-restricted user whose scope allows unrated items. A stricter
 * rating must always be able to land.
 */
export async function updateMediaAgeRating(
    sql: postgres.Sql,
    mediaId: string,
    ageRating: number | null,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET age_rating = ${ageRating},
            age_rating_source = CASE WHEN ${ageRating}::int IS NULL THEN NULL ELSE 'mdblist' END
        WHERE id = ${mediaId}
          AND age_rating_source IS DISTINCT FROM 'national'
          AND (age_rating IS DISTINCT FROM ${ageRating})
    `;
    await invalidateAgeCache(mediaId);
}

/**
 * Batch upsert multiple media items.
 *
 * @param sql - Postgres.js sql instance
 * @param items - Array of media items to upsert
 * @returns Summary of results
 */
export async function batchUpsertMediaMetadata(
    sql: postgres.Sql,
    items: MediaUpsertData[],
): Promise<{ created: number; updated: number; errors: number }> {
    let created = 0;
    let updated = 0;
    let errors = 0;

    for (const item of items) {
        try {
            const result = await upsertMediaMetadata(sql, item);
            if (result.inserted) {
                created++;
            } else {
                updated++;
            }
        } catch (error) {
            errors++;
            logger.warn(
                'Failed to upsert media item',
                {
                    primaryExternalId: item.primaryExternalId,
                    title: item.title,
                },
                error as Error,
            );
        }
    }

    return { created, updated, errors };
}
