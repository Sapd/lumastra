// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Sync Missing Metadata from Jellyfin and any primary metadata provider
// Updates existing database entries with missing IMDB IDs, cast, crew, and other metadata

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import type postgres from 'postgres';
import { Database } from '../database/connection.js';
import { normalizeMediaItem, extractCastInfo } from './embedding-utils.js';
import { Logger } from '../utils/logger';
import { isCliEntry } from '../utils/cli-entry.js';
import { fetchWithTimeout } from '../utils/fetch-utils.js';
import { buildMetadataLateralJoinFragment } from '../database/queries/builders/provider-metadata.builder.js';
import { upsertProviderMetadataUnlessLocked } from '../database/queries/media-upsert.js';
import { buildStructuredCast } from './tmdb-metadata-sync.js';
import dotenv from 'dotenv';
import { config, features } from '../config.js';
import {
    canCallJellyfin,
    JELLYFIN_DIRECT_FETCH_TIMEOUT_MS,
    recordJellyfinTransportFailure,
    recordJellyfinTransportSuccess,
} from '../jellyfin/runtime-gate.js';
import { isRecord } from '$lib/utils/data-extraction';
import { getPrimaryExternalIdProvider } from '../utils/provider-config';
import {
    keywordNamesToSlugs,
    batchAggregateMetadata,
} from '../database/queries/metadata-aggregation.queries.js';
import { invokeProviderDetail } from '../tasks/plugin-context.js';
import { encodeDetailId } from '../providers/encode-id.js';
import { isProviderNotFoundError } from '../providers/not-found.js';
import type { ProviderDetailResult } from '@sapd/lumastra-plugin-sdk';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
dotenv.config({ quiet: true });

const logger = Logger.for('SyncMissingMetadata');
const toString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

/**
 * Map an ExternalIdProvider key (e.g. 'tmdb') to the registered plugin/provider
 * ID used by invokeProviderDetail (e.g. 'tmdb-metadata-provider').
 * Falls back to the input value so unknown providers are passed through as-is.
 */
const EXTERNAL_ID_TO_PLUGIN_ID: Record<string, string> = {
    tmdb: 'tmdb-metadata-provider',
};

function externalIdToPluginId(externalId: string): string {
    return EXTERNAL_ID_TO_PLUGIN_ID[externalId] ?? externalId;
}

interface SyncItem {
    /**
     * Internal UUID from media_items.id. Populated by the candidate SQL so
     * we don't have to re-resolve the row via `external_ids` per-item later.
     */
    media_id: string;
    /**
     * External ID from the primary provider (e.g. TMDB numeric string, or a
     * provider-specific string like 'fk_1001' for a non-TMDB primary provider).
     */
    external_id: string;
    imdb_id?: string | null;
    title: string;
    media_type: 'movie' | 'tv';
    jellyfin_id?: string | null;
    source: 'jellyfin' | 'provider';
}

export interface SyncOptions {
    /** Limit the number of items to process per run */
    batchSize?: number;
    /** Only sync items missing specific fields */
    missingFields?: (
        'imdb_id' | 'actors' | 'directors' | 'producers' | 'writers' | 'keywords' | 'networks'
    )[];
    /** Update embeddings to include new metadata */
    updateEmbeddings?: boolean;
    /**
     * Number of items processed in parallel. Each item makes at most one
     * provider detail call (with a 100ms throttle inside the inner request)
     * or one Jellyfin call. Defaults to 4.
     */
    concurrency?: number;
    /**
     * AbortSignal honoured between batches. When the signal aborts, the
     * loop exits at the next batch boundary; in-flight items finish their
     * current HTTP call before returning.
     */
    signal?: AbortSignal;
    /** Progress callback: called after each item is processed */
    onProgress?: (processed: number, total: number, currentItem: string) => void;
    /**
     * Called after each item is successfully written. Receives the internal
     * UUID for the item so the caller can write a coverage-table row.
     */
    onItemSuccess?: (mediaId: string) => Promise<void>;
    /**
     * Called when the provider definitively reports the item's id as not found
     * (404/410). The caller tombstones the item so it is not re-selected and
     * re-asked on every run. Without it a not-found stays a plain error.
     */
    onItemNotFound?: (mediaId: string) => Promise<void>;
    /** Optional task-pool SQL handle. When provided, queries run on the task pool instead of the web pool. */
    sql?: postgres.Sql | null;
}

export interface SyncResult {
    success: boolean;
    total_processed: number;
    updated_count: number;
    skipped_count: number;
    errors: string[];
    message: string;
}

/**
 * Sync missing metadata for items that already exist in the database
 */
export async function syncMissingMetadata(options: SyncOptions = {}): Promise<SyncResult> {
    const {
        batchSize = 1000,
        // `keywords` is in the default so coverage runs also populate keyword
        // names + numeric tmdb_keyword_ids (the TMDB detail response already
        // append_to_response=keywords, so this adds NO extra HTTP call — just
        // extraction). browse/keywords matches on tmdb_keyword_ids.
        missingFields = ['imdb_id', 'actors', 'directors', 'keywords'],
        updateEmbeddings: _updateEmbeddings = false,
        concurrency = 4,
        signal,
        onProgress,
        onItemSuccess,
        onItemNotFound,
    } = options;
    const effectiveConcurrency = Math.max(1, Math.min(concurrency, 16));

    logger.info('Starting metadata sync', {
        missingFields,
        updateEmbeddings: _updateEmbeddings,
    });

    const db = new Database(options.sql);
    const result: SyncResult = {
        success: true,
        total_processed: 0,
        updated_count: 0,
        skipped_count: 0,
        errors: [],
        message: '',
    };

    try {
        const sql = db.getSql();

        // Build SQL condition fragments for provider_metadata JSONB fields.
        // Each fragment is a typed sql template literal — no sql.unsafe() needed
        // because all field names are static constants (no user input).
        const conditionFragments = missingFields.flatMap((field) => {
            switch (field) {
                case 'imdb_id':
                    return [sql`pm.metadata->>'imdb_id' IS NULL`];
                case 'actors':
                    return [
                        sql`(pm.metadata->'actors' IS NULL OR jsonb_array_length(COALESCE(pm.metadata->'actors', '[]'::jsonb)) = 0)`,
                    ];
                case 'directors':
                    return [
                        sql`(pm.metadata->'directors' IS NULL OR jsonb_array_length(COALESCE(pm.metadata->'directors', '[]'::jsonb)) = 0)`,
                    ];
                case 'producers':
                    return [
                        sql`(pm.metadata->'producers' IS NULL OR jsonb_array_length(COALESCE(pm.metadata->'producers', '[]'::jsonb)) = 0)`,
                    ];
                case 'writers':
                    return [
                        sql`(pm.metadata->'writers' IS NULL OR jsonb_array_length(COALESCE(pm.metadata->'writers', '[]'::jsonb)) = 0)`,
                    ];
                case 'keywords':
                    // Re-sync when keyword NAMES are missing, when the numeric
                    // TMDB keyword IDs are missing (backfill for items enriched
                    // before tmdb_keyword_ids existed — browse/keywords matches on
                    // the IDs), OR when keyword_slugs are missing (backfill for
                    // items enriched before keyword_slugs existed — re-enrolled
                    // items that already have tmdb_keyword_ids but no slugs must
                    // still run so the slugs get populated). Any gap makes the
                    // item a candidate; the re-fetch captures all three.
                    //
                    // `keywords_synced_at` gates all of it: once a lookup has RUN for
                    // this item the gaps below are the provider's answer, not our
                    // ignorance, and re-asking every night just burns quota. Titles
                    // with genuinely no keywords at TMDB are the common case, and
                    // without this gate they can never leave the candidate set (they
                    // held ~12,170 TMDB calls/day on prod, flat, forever). Items
                    // enriched before the marker existed have no marker, so the
                    // backfills above still get exactly one pass each.
                    return [
                        sql`(
                            pm.metadata->'keywords_synced_at' IS NULL
                            AND (
                                pm.metadata->'keywords' IS NULL
                                OR jsonb_array_length(COALESCE(pm.metadata->'keywords', '[]'::jsonb)) = 0
                                OR pm.metadata->'tmdb_keyword_ids' IS NULL
                                OR jsonb_array_length(COALESCE(pm.metadata->'tmdb_keyword_ids', '[]'::jsonb)) = 0
                                OR pm.metadata->'keyword_slugs' IS NULL
                                OR jsonb_array_length(COALESCE(pm.metadata->'keyword_slugs', '[]'::jsonb)) = 0
                            )
                        )`,
                    ];
                case 'networks':
                    return [
                        sql`(pm.metadata->'networks' IS NULL OR jsonb_array_length(COALESCE(pm.metadata->'networks', '[]'::jsonb)) = 0)`,
                    ];
                default:
                    return [];
            }
        });

        if (conditionFragments.length === 0) {
            result.message = 'No valid fields specified for sync';
            return result;
        }

        // Stage-state gate: when the caller provides `onItemSuccess` we are
        // in authoritative-stage mode. The candidate query then sources from
        // `media_item_stage_state` directly so every pending row gets a
        // decision in one pass — items where the provider has nothing new still
        // get tombstoned via the always-fire onItemSuccess at the end of the
        // loop, instead of cycling through the missing-fields predicate
        // forever. When `onItemSuccess` is undefined we keep the legacy
        // unfiltered scan so dev/test callers that haven't opted in still work.
        const stageGated = onItemSuccess !== undefined;

        const stageGateFragment = stageGated
            ? sql`AND EXISTS (
                  SELECT 1 FROM media_item_stage_state s
                   WHERE s.media_item_id = mi.id
                     AND s.stage_id = 'metadata-update'
                     AND s.status IN ('pending', 'failed_transient', 'skipped_transient')
              )`
            : sql``;

        // Get items with Jellyfin IDs first (preferred source) using UUID-based tables
        const itemsWithJellyfin = await sql<SyncItem[]>`
      SELECT mi.id as media_id,
             primary_ext.external_id as external_id,
             pm.metadata->>'imdb_id' as imdb_id,
             mi.title,
             mi.media_type,
             jf_ext.external_id as jellyfin_id,
             'jellyfin' as source
      FROM media_items mi
      JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
      JOIN external_ids jf_ext ON jf_ext.media_id = mi.id AND jf_ext.provider = 'jellyfin'
      ${buildMetadataLateralJoinFragment(sql)}
      WHERE mi.media_type IN ('movie', 'tv')
        -- Must mirror the writer's predicate (upsertProviderMetadataUnlessLocked
        -- skips metadata_locked rows). Without this, a locked item missing a
        -- field is selected every run, the write no-ops, and it is re-selected
        -- forever — burning a TMDB fetch per item per run for a write that
        -- cannot land (same trap as tmdb-metadata-sync.ts's itemsNeedingUpdate).
        AND mi.metadata_locked = false
        AND (${conditionFragments.reduce((acc, frag) => sql`${acc} OR ${frag}`)})
        ${stageGateFragment}
      LIMIT ${batchSize / 2}
    `;

        // Also get items without Jellyfin IDs for provider-only recovery
        // Uses NOT EXISTS instead of LEFT JOIN for checking missing jellyfin IDs
        const itemsWithoutJellyfin = await sql<SyncItem[]>`
      SELECT mi.id as media_id,
             primary_ext.external_id as external_id,
             pm.metadata->>'imdb_id' as imdb_id,
             mi.title,
             mi.media_type,
             NULL as jellyfin_id,
             'provider' as source
      FROM media_items mi
      JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
      ${buildMetadataLateralJoinFragment(sql)}
      WHERE mi.media_type IN ('movie', 'tv')
        AND NOT EXISTS (SELECT 1 FROM external_ids WHERE media_id = mi.id AND provider = 'jellyfin')
        AND mi.metadata_locked = false
        ${stageGateFragment}
        AND (${conditionFragments.reduce((acc, frag) => sql`${acc} OR ${frag}`)})
      LIMIT ${batchSize / 2}
    `;

        const itemsToSync = [...itemsWithJellyfin, ...itemsWithoutJellyfin];

        logger.info('Items needing metadata updates', {
            count: itemsToSync.length,
        });
        result.total_processed = itemsToSync.length;

        onProgress?.(0, itemsToSync.length, 'Starting metadata sync...');

        if (itemsToSync.length === 0) {
            result.message = 'All items already have complete metadata';
            return result;
        }

        const JELLYFIN_URL = config.JELLYFINURL;
        const JELLYFIN_API_KEY = config.JELLYFINAPIKEY;

        // The Jellyfin leg runs only while Jellyfin sync is on AND Jellyfin is
        // reachable (connection status + circuit breaker). URL + key alone used to
        // be enough, so a stopped or removed Jellyfin failed the whole nightly
        // task on the /Users call below. Without the leg, Jellyfin-linked items go
        // through the primary provider like every other item.
        const jellyfinAvailable = canCallJellyfin();

        // Resolve Jellyfin user ID only when the Jellyfin leg may run
        let userId: string | undefined;
        if (jellyfinAvailable) {
            try {
                // Routed through the same-origin-only redirect guard (C22
                // fix-plan finding) — this was a third, un-migrated transport to
                // Jellyfin alongside the axios instance (`6552a76f0`) and the
                // AudiobookshelfClient-style clients.
                const usersResponse = await fetchWithTimeout(
                    joinUpstreamUrl(JELLYFIN_URL, `/Users`),
                    {
                        headers: {
                            ...buildJellyfinAuthHeaders({ token: JELLYFIN_API_KEY }),
                            'Content-Type': 'application/json',
                        },
                    },
                    JELLYFIN_DIRECT_FETCH_TIMEOUT_MS,
                );
                recordJellyfinTransportSuccess();

                if (!usersResponse.ok) {
                    logger.warn('Failed to fetch Jellyfin users', {
                        status: usersResponse.statusText,
                    });
                } else {
                    const usersData: unknown = await usersResponse.json();
                    const users = Array.isArray(usersData) ? usersData : [];
                    const firstUser = isRecord(users[0]) ? users[0] : undefined;
                    userId = toString(firstUser?.Id);
                    if (userId) {
                        logger.info('Using Jellyfin user', {
                            userName: toString(firstUser?.Name) || 'Unknown',
                            userId,
                        });
                    }
                }
            } catch (usersError) {
                recordJellyfinTransportFailure(usersError);
                logger.warn('Jellyfin unreachable — skipping the Jellyfin leg', {
                    error: usersError instanceof Error ? usersError.message : String(usersError),
                });
            }
        } else {
            logger.debug('Jellyfin leg skipped', {
                reason: features.jellyfinSync ? 'jellyfin unavailable' : 'jellyfin sync off',
            });
        }
        const jellyfinLegReady = jellyfinAvailable && !!userId;

        // Per-item worker. Hot-path perf note (2026-05-30): the previous
        // version processed items strictly serially with a hard-coded
        // 200 ms inter-item sleep (no rate-limiter rationale — predates
        // the per-call 100 ms pad). On preprod a 1 000-item batch
        // took ~5 min against a 100 k+ row backlog. Removing the 200 ms
        // sleep alone is ~30 % faster; running `effectiveConcurrency`
        // items in parallel against the same provider rate budget cuts
        // another ~4×. Net ~5–10× drain rate on metadata-update.
        let completedSoFar = 0;
        const primaryProvider = getPrimaryExternalIdProvider();
        // Collect UUIDs of items whose provider_metadata was written so we can
        // re-aggregate the merged `aggregated` row after the run.
        const syncedMediaIds: string[] = [];
        // De-dupe helper: the structured-cast write below and the existing
        // updated-fields write both push into syncedMediaIds for the same
        // item when both fire, so guard against pushing the same UUID twice.
        const markSynced = (mediaId: string): void => {
            if (!syncedMediaIds.includes(mediaId)) {
                syncedMediaIds.push(mediaId);
            }
        };

        const processItem = async (dbItem: (typeof itemsToSync)[number]): Promise<void> => {
            // Did the provider actually ANSWER for this item? The completion contract
            // is "we processed this item", and a call that THREW processed nothing —
            // it must stay pending and be retried. The inner provider catch used to
            // log, push an error and fall through to onItemSuccess, so a TMDB outage
            // stamped every candidate in the batch `completed`, with no revival short
            // of an identity.* event most of them never get.
            let providerAnswered = true;

            // Single completion path, so the two exits below cannot drift apart. The
            // "no detail" exit used to `return` straight past this, leaving the item
            // pending to be re-selected and re-asked forever — the very runaway the
            // keywords marker was added to kill.
            const completeItem = async (): Promise<void> => {
                if (!providerAnswered || !onItemSuccess) return;
                try {
                    await onItemSuccess(dbItem.media_id);
                } catch (successCallbackErr) {
                    logger.warn('onItemSuccess callback failed', {
                        mediaId: dbItem.media_id,
                        error:
                            successCallbackErr instanceof Error
                                ? successCallbackErr.message
                                : String(successCallbackErr),
                    });
                }
            };

            try {
                logger.info('Processing item', {
                    title: dbItem.title,
                    externalId: dbItem.external_id,
                    source: dbItem.source,
                });

                let updated = false;
                const updates: Partial<{
                    imdb_id: string;
                    actors: string[];
                    directors: string[];
                    producers: string[];
                    writers: string[];
                    keywords: string[];
                    // TMDB numeric keyword IDs, captured alongside `keywords` (names)
                    // so browse/keywords can match by the language-independent ID
                    // (metadata->'tmdb_keyword_ids' @> [id]) instead of calling TMDB
                    // live. Persisted into provider_metadata.metadata via the JSONB merge.
                    // Only populated when the primary provider returns rawKeywordIds.
                    tmdb_keyword_ids: number[];
                    // ISO timestamp stamped whenever the keyword lookup RAN, even when
                    // the provider returned nothing. Without it "this title has no
                    // keywords" reads identically to "we never looked", and the
                    // candidate query re-selects the item forever. See the keywords
                    // branch below and its `conditionFragments` case.
                    keywords_synced_at: string;
                    // Provider-neutral keyword slugs derived from keyword names.
                    // Browse queries can match on these instead of TMDB-specific IDs.
                    keyword_slugs: string[];
                    networks: string[];
                }> = {};

                // Invoke the primary metadata provider via the SDK abstraction.
                // This replaces the former hardcoded api.themoviedb.org calls and
                // works with any registered primary provider (TMDB, faketvdb, etc.).
                // canCallJellyfin() again per item: an outage mid-run (breaker opened by
                // the items before) moves the rest to the provider instead of each
                // paying a timeout.
                if (dbItem.source === 'provider' || !jellyfinLegReady || !canCallJellyfin()) {
                    logger.info('Using primary provider for metadata recovery', {
                        title: dbItem.title,
                        provider: primaryProvider,
                    });
                    try {
                        const pluginId = externalIdToPluginId(primaryProvider);
                        const encodedId = encodeDetailId(
                            pluginId,
                            dbItem.media_type,
                            dbItem.external_id,
                        );
                        const detail = await invokeProviderDetail<ProviderDetailResult>(
                            pluginId,
                            encodedId,
                            { signal },
                        );

                        if (!detail) {
                            // DEFINITIVE ("this id has nothing"), not a failure —
                            // typically an upstream-deleted TMDB id. Complete the item
                            // so it leaves the candidate set instead of being re-asked
                            // every run.
                            logger.info('Provider returned no detail for item', {
                                title: dbItem.title,
                                provider: primaryProvider,
                            });
                            await completeItem();
                            return;
                        }

                        // IMDB ID from the neutral externalIds map or imdbId field
                        if (missingFields.includes('imdb_id') && !dbItem.imdb_id) {
                            const imdbId = detail.imdbId;
                            if (imdbId) {
                                updates.imdb_id = imdbId;
                                updated = true;
                                logger.info('Found IMDB ID', { imdbId });
                            }
                        }

                        // Cast from the neutral cast array
                        if (
                            missingFields.includes('actors') &&
                            detail.cast &&
                            detail.cast.length > 0
                        ) {
                            updates.actors = detail.cast
                                .slice(0, 8)
                                .map((c) => c.name)
                                .filter(Boolean);
                            updated = true;
                            logger.info('Found actors', { count: updates.actors.length });
                        }

                        // Structured cast (name + character + TMDB person id) for the
                        // detail API's actors[].character / proxied profileUrl. This
                        // must be written to the PRIMARY PROVIDER's provider_metadata
                        // row, not the 'aggregated' row: batchAggregateMetadata rebuilds
                        // 'aggregated' from the provider rows below, and would drop a
                        // write made directly to 'aggregated' on the next aggregation
                        // pass. Runs independently of the `missingFields.includes('actors')`
                        // gate above — the candidate predicate for 'actors' only checks
                        // the flat name list, so an item can reach here with actors
                        // already complete but structured cast still missing.
                        const structuredCast = buildStructuredCast(detail.cast);
                        if (structuredCast.length > 0) {
                            await upsertProviderMetadataUnlessLocked(
                                sql,
                                dbItem.media_id,
                                primaryProvider,
                                {
                                    cast: structuredCast,
                                    cast_synced_at: new Date().toISOString(),
                                },
                            );
                            markSynced(dbItem.media_id);
                            logger.info('Found structured cast', {
                                count: structuredCast.length,
                            });
                        }

                        // Directors from the neutral directors array
                        if (
                            missingFields.includes('directors') &&
                            detail.directors &&
                            detail.directors.length > 0
                        ) {
                            updates.directors = detail.directors;
                            updated = true;
                            logger.info('Found directors', {
                                directors: updates.directors.join(', '),
                            });
                        }

                        // Producers from the neutral producers array
                        if (
                            missingFields.includes('producers') &&
                            detail.producers &&
                            detail.producers.length > 0
                        ) {
                            updates.producers = detail.producers.slice(0, 5);
                            updated = true;
                            logger.info('Found producers', { count: updates.producers.length });
                        }

                        // Writers from the neutral writers array
                        if (
                            missingFields.includes('writers') &&
                            detail.writers &&
                            detail.writers.length > 0
                        ) {
                            updates.writers = detail.writers.slice(0, 5);
                            updated = true;
                            logger.info('Found writers', { count: updates.writers.length });
                        }

                        // Keywords: provider-neutral keyword names + slugs
                        if (missingFields.includes('keywords')) {
                            const keywordNames = detail.keywordNames ?? [];
                            // Record that the lookup RAN, whatever it found. Plenty of
                            // titles genuinely have no keywords at TMDB, and without this
                            // marker "has no keywords" is indistinguishable from "never
                            // asked": the candidate query below re-selects them every
                            // night, re-fetches them, still writes nothing, and selects
                            // them again tomorrow. On prod that was 6,401 items pinned in
                            // the candidate set — the daily run sat at a flat ~12,170 TMDB
                            // calls and never converged.
                            updates.keywords_synced_at = new Date().toISOString();
                            updated = true;
                            if (keywordNames.length > 0) {
                                updates.keywords = keywordNames.slice(0, 10);
                                // Provider-neutral slugs (preferred browse path).
                                // Fall back to deriving from names when the provider
                                // returns a defined-but-empty slug list.
                                updates.keyword_slugs =
                                    detail.keywordSlugs && detail.keywordSlugs.length > 0
                                        ? detail.keywordSlugs
                                        : keywordNamesToSlugs(keywordNames);
                                // TMDB-specific numeric IDs (backward-compat GIN path).
                                // Only present when the primary provider supplies them
                                // (rawKeywordIds is a TMDB-specific escape hatch).
                                if (detail.rawKeywordIds && detail.rawKeywordIds.length > 0) {
                                    updates.tmdb_keyword_ids = detail.rawKeywordIds;
                                }
                                updated = true;
                                logger.info('Found keywords', {
                                    count: updates.keywords.length,
                                });
                            }
                        }

                        // Networks from the neutral networks array (TV only)
                        if (
                            missingFields.includes('networks') &&
                            detail.networks &&
                            detail.networks.length > 0
                        ) {
                            updates.networks = detail.networks;
                            updated = true;
                            logger.info('Found networks', {
                                networks: updates.networks.join(', '),
                            });
                        }

                        // Rate limiting between provider calls
                        await new Promise((resolve) => setTimeout(resolve, 100));
                    } catch (providerError) {
                        providerAnswered = false;
                        if (onItemNotFound && isProviderNotFoundError(providerError)) {
                            logger.warn('Provider id not found — tombstoning item', {
                                title: dbItem.title,
                                provider: primaryProvider,
                                externalId: dbItem.external_id,
                            });
                            try {
                                await onItemNotFound(dbItem.media_id);
                                return;
                            } catch (notFoundCallbackErr) {
                                logger.warn('onItemNotFound callback failed', {
                                    mediaId: dbItem.media_id,
                                    error:
                                        notFoundCallbackErr instanceof Error
                                            ? notFoundCallbackErr.message
                                            : String(notFoundCallbackErr),
                                });
                            }
                        }
                        logger.warn('Provider metadata recovery failed', {
                            title: dbItem.title,
                            provider: primaryProvider,
                            error:
                                providerError instanceof Error
                                    ? providerError.message
                                    : String(providerError),
                        });
                        result.errors.push(
                            `Provider recovery failed for ${dbItem.title}: ${providerError}`,
                        );
                    }
                } else if (dbItem.jellyfin_id && userId) {
                    // Jellyfin processing logic (only when Jellyfin is configured)
                    try {
                        // Routed through the same-origin-only redirect guard
                        // (C22 fix-plan finding) — see the /Users call above.
                        const jellyfinResponse = await fetchWithTimeout(
                            joinUpstreamUrl(
                                JELLYFIN_URL,
                                `/Users/${encodePathSegment(userId)}/Items/${encodePathSegment(dbItem.jellyfin_id)}?` +
                                    new URLSearchParams({
                                        Fields: 'ProviderIds,People,Keywords,Studios,Taglines,Budget,Revenue',
                                    }),
                            ),
                            {
                                headers: {
                                    ...buildJellyfinAuthHeaders({ token: JELLYFIN_API_KEY }),
                                    'Content-Type': 'application/json',
                                },
                            },
                            JELLYFIN_DIRECT_FETCH_TIMEOUT_MS,
                        );

                        if (jellyfinResponse.ok) {
                            const jellyfinDataRaw: unknown = await jellyfinResponse.json();
                            if (!isRecord(jellyfinDataRaw)) {
                                return;
                            }
                            const normalizedItem = normalizeMediaItem(jellyfinDataRaw, 'library');

                            // Extract missing IMDB ID
                            if (
                                missingFields.includes('imdb_id') &&
                                !dbItem.imdb_id &&
                                normalizedItem.imdb_id
                            ) {
                                updates.imdb_id = normalizedItem.imdb_id;
                                updated = true;
                                logger.info('Found IMDB ID from Jellyfin', {
                                    imdbId: normalizedItem.imdb_id,
                                });
                            }

                            // Extract cast and crew information
                            const { directors, actors, producers, writers } =
                                extractCastInfo(normalizedItem);

                            if (missingFields.includes('directors') && directors.length > 0) {
                                updates.directors = directors;
                                updated = true;
                                logger.info('Found directors from Jellyfin', {
                                    directors: directors.join(', '),
                                });
                            }

                            if (missingFields.includes('actors') && actors.length > 0) {
                                updates.actors = actors;
                                updated = true;
                                logger.info('Found actors from Jellyfin', {
                                    sample: actors.slice(0, 3).join(', '),
                                });
                            }

                            if (missingFields.includes('producers') && producers.length > 0) {
                                updates.producers = producers;
                                updated = true;
                                logger.info('Found producers from Jellyfin', {
                                    producers: producers.join(', '),
                                });
                            }

                            if (missingFields.includes('writers') && writers.length > 0) {
                                updates.writers = writers;
                                updated = true;
                                logger.info('Found writers from Jellyfin', {
                                    writers: writers.join(', '),
                                });
                            }

                            // After Jellyfin gives us cast/imdb, also invoke the primary
                            // provider for keywords and networks (fields Jellyfin does not
                            // supply) when those fields are requested and still missing.
                            if (
                                missingFields.includes('keywords') ||
                                missingFields.includes('networks')
                            ) {
                                try {
                                    const pluginId = externalIdToPluginId(primaryProvider);
                                    const encodedId = encodeDetailId(
                                        pluginId,
                                        dbItem.media_type,
                                        dbItem.external_id,
                                    );
                                    const detail = await invokeProviderDetail<ProviderDetailResult>(
                                        pluginId,
                                        encodedId,
                                        { signal },
                                    );

                                    if (!detail) {
                                        logger.info(
                                            'Provider returned no supplemental detail for item',
                                            {
                                                title: dbItem.title,
                                                provider: primaryProvider,
                                            },
                                        );
                                    } else {
                                        // Structured cast, as in the provider-only branch
                                        // above — persisted to the primary provider's
                                        // provider_metadata row so the next aggregation
                                        // pass doesn't drop it. Jellyfin's own People data
                                        // only yields flat actor names (handled above via
                                        // extractCastInfo); this supplemental provider call
                                        // is the only source of character + person id for
                                        // jellyfin-sourced items.
                                        const structuredCast = buildStructuredCast(detail.cast);
                                        if (structuredCast.length > 0) {
                                            await upsertProviderMetadataUnlessLocked(
                                                sql,
                                                dbItem.media_id,
                                                primaryProvider,
                                                {
                                                    cast: structuredCast,
                                                    cast_synced_at: new Date().toISOString(),
                                                },
                                            );
                                            markSynced(dbItem.media_id);
                                            logger.info('Found structured cast from provider', {
                                                count: structuredCast.length,
                                            });
                                        }

                                        if (missingFields.includes('keywords')) {
                                            const keywordNames = detail.keywordNames ?? [];
                                            // Stamp the marker here too. The provider
                                            // branch has done this since the marker was
                                            // introduced; this jellyfin-sourced path did
                                            // not, so a jellyfin item whose supplemental
                                            // lookup legitimately finds no keywords stayed
                                            // a candidate forever — the same nightly
                                            // re-fetch loop, surviving for the entire
                                            // jellyfin-sourced population.
                                            updates.keywords_synced_at = new Date().toISOString();
                                            updated = true;
                                            if (keywordNames.length > 0) {
                                                updates.keywords = keywordNames.slice(0, 10);
                                                // Fall back to deriving slugs when the provider
                                                // returns a defined-but-empty slug list.
                                                updates.keyword_slugs =
                                                    detail.keywordSlugs &&
                                                    detail.keywordSlugs.length > 0
                                                        ? detail.keywordSlugs
                                                        : keywordNamesToSlugs(keywordNames);
                                                if (
                                                    detail.rawKeywordIds &&
                                                    detail.rawKeywordIds.length > 0
                                                ) {
                                                    updates.tmdb_keyword_ids = detail.rawKeywordIds;
                                                }
                                                updated = true;
                                                logger.info('Found keywords from provider', {
                                                    sample: keywordNames.slice(0, 5).join(', '),
                                                });
                                            }
                                        }

                                        if (
                                            missingFields.includes('networks') &&
                                            detail.networks &&
                                            detail.networks.length > 0
                                        ) {
                                            updates.networks = detail.networks;
                                            updated = true;
                                            logger.info('Found networks from provider', {
                                                networks: updates.networks.join(', '),
                                            });
                                        }

                                        // Backfill IMDB ID from provider if Jellyfin didn't have it
                                        if (missingFields.includes('imdb_id') && !updates.imdb_id) {
                                            const imdbId = detail.imdbId;
                                            if (imdbId) {
                                                updates.imdb_id = imdbId;
                                                updated = true;
                                                logger.info('Found IMDB ID from provider', {
                                                    imdbId,
                                                });
                                            }
                                        }
                                    }

                                    await new Promise((resolve) => setTimeout(resolve, 100));
                                } catch (providerError) {
                                    logger.warn('Failed to fetch supplemental data from provider', {
                                        title: dbItem.title,
                                        provider: primaryProvider,
                                        error:
                                            providerError instanceof Error
                                                ? providerError.message
                                                : String(providerError),
                                    });
                                    result.errors.push(
                                        `Provider fetch failed for ${dbItem.title}: ${providerError}`,
                                    );
                                }
                            }
                        }
                    } catch (jellyfinError) {
                        recordJellyfinTransportFailure(jellyfinError);
                        logger.warn('Failed to fetch Jellyfin data', {
                            title: dbItem.title,
                            error:
                                jellyfinError instanceof Error
                                    ? jellyfinError.message
                                    : String(jellyfinError),
                        });
                        result.errors.push(
                            `Jellyfin fetch failed for ${dbItem.title}: ${jellyfinError}`,
                        );
                    }
                }

                // Update the database if we found new data. media_id is
                // pulled from the candidate SQL — no per-item external_ids
                // re-lookup needed.
                if (updated && Object.keys(updates).length > 0) {
                    // Count only an actual write as `updated` — the candidate
                    // query already excludes metadata_locked items, but a
                    // concurrent admin lock between the SELECT and this write
                    // (or a future caller that reuses this code path without
                    // the same pre-filter) would otherwise report success for
                    // a 0-row write (C3, 2026-09-24 security review — same
                    // "0 rows ≠ failure, but also ≠ success" contract as
                    // batchAggregateMetadata's stats fix).
                    const rowsWritten = await upsertProviderMetadataUnlessLocked(
                        sql,
                        dbItem.media_id,
                        'aggregated',
                        updates,
                    );
                    if (rowsWritten > 0) {
                        result.updated_count++;
                        markSynced(dbItem.media_id);
                        logger.info('Updated item with new metadata', {
                            title: dbItem.title,
                            fields: Object.keys(updates).join(', '),
                        });
                    } else {
                        result.skipped_count++;
                        logger.info('Write skipped — item is locked', {
                            title: dbItem.title,
                        });
                    }
                } else {
                    result.skipped_count++;
                    logger.info('No new data found for item', {
                        title: dbItem.title,
                    });
                }

                // ALWAYS mark the coverage row complete after we've checked an
                // item, even when the provider had no new data for it. Previously
                // `onItemSuccess` fired only when at least one field was
                // applied, so items where the provider doesn't-have-the-field
                // stayed `pending` forever — the candidate SQL kept returning
                // them every run, throughput looked huge but the displayed
                // backlog never moved. The stage-state contract is "we processed
                // this item"; whether the network call returned new data is a
                // separate signal recorded in `provider_metadata`.
                await completeItem();
            } catch (itemError) {
                logger.error('Error processing item', itemError as Error, {
                    title: dbItem.title,
                });
                result.errors.push(`Error processing ${dbItem.title}: ${itemError}`);
            }

            // Progress reporting after each item completes. With workers
            // running concurrently the order of completion is not the
            // order of dispatch, so `completedSoFar` is the right counter
            // here (not result.updated_count + result.skipped_count, which
            // could double-count a single item briefly mid-update).
            completedSoFar++;
            onProgress?.(completedSoFar, itemsToSync.length, dbItem.title);
        };

        // Drive the worker pool: process items in slices of
        // effectiveConcurrency. Promise.allSettled ensures that one
        // slow/throwing item never blocks the rest of the slice — the
        // per-item try/catch above also captures errors into
        // result.errors so allSettled rejections shouldn't happen in
        // practice, but the defensive pattern keeps the loop alive
        // against any future code path that escapes the inner try.
        for (let i = 0; i < itemsToSync.length; i += effectiveConcurrency) {
            if (signal?.aborted) {
                logger.warn('Metadata sync aborted by signal', {
                    completed: completedSoFar,
                    remaining: itemsToSync.length - completedSoFar,
                });
                break;
            }
            const slice = itemsToSync.slice(i, i + effectiveConcurrency);
            await Promise.allSettled(slice.map(processItem));
        }

        // Re-aggregate all provider rows into the merged `aggregated` row for
        // items written this run. The upsertProviderMetadataUnlessLocked(…,
        // 'aggregated', …) call above merges only the fields explicitly written
        // (actors, keywords, …) but leaves genre/plot data from the `tmdb`
        // provider row out of the aggregated view. batchAggregateMetadata
        // does the full cross-provider merge. Non-fatal: aggregation failure must
        // not fail the sync.
        if (syncedMediaIds.length > 0) {
            try {
                const aggStats = await batchAggregateMetadata(sql, syncedMediaIds);
                logger.info('Post-sync aggregation complete', {
                    aggregated: aggStats.updated,
                    skipped: aggStats.skipped,
                    errors: aggStats.errors,
                });
            } catch (aggError) {
                logger.warn(
                    'Post-sync aggregation failed — provider rows written, aggregated row may be stale',
                    {
                        error: aggError instanceof Error ? aggError.message : String(aggError),
                        count: syncedMediaIds.length,
                    },
                );
            }
        }

        result.message = `Sync completed: ${result.updated_count} updated, ${result.skipped_count} skipped, ${result.errors.length} errors`;
        logger.info('Sync completed', {
            updated: result.updated_count,
            skipped: result.skipped_count,
            errors: result.errors.length,
        });

        if (_updateEmbeddings && result.updated_count > 0) {
            logger.info('Enqueuing embedding update for synced items', {
                updatedCount: result.updated_count,
            });
            try {
                const { orchestrator } = await import('../tasks/orchestrator.js');
                // Route LIBRARY re-embeds through the dedicated `library-embeddings`
                // task (on the `embedding` class) rather than `discovery-embeddings`
                // (now on its own `discovery` class) — otherwise post-sync library
                // re-embeds would queue behind the catalog-discovery flood.
                await orchestrator.startRun(
                    'library-embeddings',
                    {
                        missingOnly: false,
                        // syncMissingMetadata's batchSize defaults to 1000, but
                        // library-embeddings' inputSchema caps batchSize at 500
                        // — passing it unclamped throws a ZodError inside
                        // startRun and the post-sync re-embed silently never runs.
                        batchSize: Math.min(batchSize, 500),
                    },
                    { trigger: { kind: 'in-process' } },
                );
                logger.info('Enqueued embedding regeneration after metadata sync');
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // Fail-loud: re-throw in dev (catches registry inconsistency
                // immediately in tests), log at error in prod with the
                // TASK_REGISTRY_INCONSISTENCY tag, and still append to
                // result.errors so the calling task surfaces the failure to
                // its admin UI run row.
                result.errors.push(`Failed to enqueue embedding update: ${msg}`);
                const { handleTriggerFailure } = await import('../tasks/handle-trigger-failure.js');
                handleTriggerFailure(err, {
                    logger,
                    action: 'enqueue embedding update after metadata sync',
                    taskId: 'library-embeddings',
                });
            }
        }

        return result;
    } catch (error) {
        logger.error('Fatal error in sync', error as Error);
        result.success = false;
        result.errors.push((error as Error).message);
        result.message = `Sync failed: ${(error as Error).message}`;
        return result;
    }
}

// Command line execution
// Gated on LUMASTRA_CLI (set by the npm script), never on
// `import.meta.url === file://${argv[1]}` — see utils/cli-entry.ts.
if (isCliEntry('sync-metadata')) {
    const args = process.argv.slice(2);
    const batchSize = args.includes('--batch-size')
        ? parseInt(args[args.indexOf('--batch-size') + 1])
        : 100;
    const updateEmbeddings = args.includes('--update-embeddings');

    const missingFields: SyncOptions['missingFields'] = [];
    if (args.includes('--imdb-id')) missingFields.push('imdb_id');
    if (args.includes('--cast')) missingFields.push('actors', 'directors', 'producers', 'writers');
    if (args.includes('--keywords')) missingFields.push('keywords');
    if (args.includes('--networks')) missingFields.push('networks');

    // Default to IMDB ID and cast if no specific fields requested
    if (missingFields.length === 0) {
        missingFields.push('imdb_id', 'actors', 'directors');
    }

    syncMissingMetadata({
        batchSize,
        missingFields,
        updateEmbeddings,
    })
        .then((result) => {
            logger.info('Final result', {
                totalProcessed: result.total_processed,
                updated: result.updated_count,
                skipped: result.skipped_count,
                errors: result.errors.length,
                sampleErrors: result.errors.slice(0, 5),
                status: result.message,
            });
            process.exit(result.success ? 0 : 1);
        })
        .catch((error) => {
            logger.error('Script failed', error instanceof Error ? error : undefined);
            process.exit(1);
        });
}
