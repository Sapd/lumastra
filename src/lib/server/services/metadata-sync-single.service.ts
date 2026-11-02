// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Metadata Sync — Single Item & Series Children
 *
 * Single-item sync re-fetches metadata from TMDB and updates the database.
 * Series children sync (seasons/episodes) is provider-agnostic — it resolves
 * the metadata provider from external_ids and uses the shared plugin interface.
 */

import type postgres from 'postgres';
import { registerImageCandidate } from '$lib/server/database/queries/image-candidates.queries.js';
import { deriveImageProvider } from '$lib/shared/image-provenance.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isMovie, isSeries, isSeason } from '$lib/server/utils/media-types.js';
import type { TmdbCatalogEpisode } from './episode-reconciliation.service.js';
import {
    beginReconciliationCatalog,
    type ReconciliationCatalogResult,
} from './episode-reconciliation-catalog.service.js';
import { CatalogService } from '$lib/server/services/catalog.service.js';
import type { ExternalIdWrite } from '$lib/server/providers/provider-types.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { createTMDBApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { getSeriesChildren as tmdbGetSeriesChildren } from '$lib/server/providers/implementations/tmdb/series-children.js';
import {
    FULL_REFRESH_METADATA_KEY,
    isFullRefreshDue,
    selectSeasonsToRefresh,
    type StoredSeasonState,
} from '$lib/server/services/series-season-refresh-plan.js';
import { getSeriesChildren as jellyfinGetSeriesChildren } from '$lib/server/providers/implementations/jellyfin/series-children.js';
import { getSeriesChildren as anidbGetSeriesChildren } from '$lib/server/providers/implementations/anidb/series-children.js';
import type { SeriesChildrenResult } from '$lib/server/providers/types.js';
import { getProvidersByPriority } from '$lib/server/tasks/plugin-context.js';
import {
    findEpisodeByPosition,
    findSeasonByNumber,
} from '$lib/server/database/queries/media-items.queries.js';
import {
    quarantineWrite,
    resolveByExternalKey,
} from '$lib/server/database/queries/sync-quarantine.queries.js';
import {
    upsertMediaTitles,
    type MediaTitleInput,
} from '$lib/server/database/queries/media-titles.queries.js';
import { upsertMediaTranslations } from '$lib/server/database/queries/media-translations.queries.js';
import { upsertCompletedRow } from '$lib/server/database/queries/stage-state.queries.js';
import { collectTmdbTranslations } from '$lib/server/services/tmdb-translations-collect.js';
import { enqueueSeasonArtworkMaterialization } from '$lib/server/services/season-artwork-enqueue.js';
import { buildProviderDetailResult } from '$lib/server/providers/implementations/tmdb/detail-coerce.js';
import { buildCanonicalDetailFields } from '$lib/server/ai/tmdb-metadata-sync.js';
import { config } from '$lib/server/config.js';
import { effectiveAgeRatingCountry } from '$lib/server/utils/age-rating-country.js';
import {
    CERTIFICATION_CHECKED_COUNTRY_KEY,
    pickTmdbCertification,
} from '$lib/server/utils/tmdb-certification.js';
import { applyNationalAgeRating } from '$lib/server/database/queries/age-rating-source.queries.js';
import { refreshSortTitles } from '$lib/server/database/queries/sort-title.queries.js';

/**
 * TMDB nests artwork logos under `images.logos[]` and exposes NO top-level
 * `logo_path` the way it does `poster_path`/`backdrop_path`. Derive one so the
 * logo is PERSISTED alongside the other artwork paths (and the metadata
 * aggregation — which already lists `logo_path` — propagates it into the
 * 'aggregated' row the catalog reads). Selection matches the live image
 * provider: an English-language logo first, else the first (TMDB returns them
 * vote-ordered), so stored and live resolution agree.
 */
/**
 * Collect every known title for a TMDB item — primary (movie title / tv name),
 * original-language title, and each translation's localized title — so search
 * can match a title the user actually knows (e.g. German "Disneys Große Pause"
 * for the English-primary "Hafentage"). De-dup + blank-skip happens in
 * upsertMediaTitles. `translations` is already fetched via append_to_response.
 */
function collectTmdbTitles(details: unknown): MediaTitleInput[] {
    const d = details as {
        title?: string;
        name?: string;
        original_title?: string;
        original_name?: string;
        original_language?: string;
        translations?: {
            translations?: Array<{ iso_639_1?: string; data?: { title?: string; name?: string } }>;
        };
    };
    const out: MediaTitleInput[] = [];
    const primary = d.title ?? d.name;
    if (primary) out.push({ title: primary, language: null, kind: 'primary' });
    const original = d.original_title ?? d.original_name;
    if (original)
        out.push({ title: original, language: d.original_language ?? null, kind: 'original' });
    for (const t of d.translations?.translations ?? []) {
        const localized = t.data?.title ?? t.data?.name;
        if (localized)
            out.push({ title: localized, language: t.iso_639_1 ?? null, kind: 'localized' });
    }
    return out;
}

function pickTmdbLogoPath(details: unknown): string | null {
    const logos = (
        details as {
            images?: { logos?: Array<{ iso_639_1?: string | null; file_path?: string | null }> };
        }
    )?.images?.logos;
    if (!Array.isArray(logos) || logos.length === 0) return null;
    const english = logos.find((l) => l?.iso_639_1 === 'en');
    return english?.file_path ?? logos[0]?.file_path ?? null;
}

/** Progress event emitted by the sync service (without wire-format `type` field) */
export interface SyncProgress {
    phase: 'series' | 'season' | 'done';
    message: string;
    seasonsSynced: number;
    episodesSynced: number;
    totalSeasons: number;
}

const logger = Logger.for('MetadataSyncSingle');

export interface PositionEpisode {
    seasonNumber: number;
    episodeNumber: number;
    title: string;
    overview: string | null;
}

export interface LocalEpisodeBinding {
    externalTmdbId: string | null;
    titleBinding: string; // 'position' | 'identity'
}

/**
 * Identity-aware title binding. Only when the local row is EXPLICITLY identity-bound
 * (title_binding = 'identity') AND carries a tmdb external_id present in the catalog
 * do we bind title/overview from that episode. Rows at the default 'position' binding
 * keep standard position-derived values — so legacy/stale episode external_ids never
 * silently override titles.
 */
export function resolveEpisodeTitleBindings(
    positionEp: PositionEpisode,
    localByPosition: Map<string, LocalEpisodeBinding>,
    catalogById: Map<string, { name: string; overview: string | null }>,
): { title: string; overview: string | null } {
    const key = `${positionEp.seasonNumber}:${positionEp.episodeNumber}`;
    const local = localByPosition.get(key);
    if (local?.titleBinding === 'identity' && local.externalTmdbId) {
        const ident = catalogById.get(local.externalTmdbId);
        if (ident) return { title: ident.name, overview: ident.overview };
    }
    return { title: positionEp.title, overview: positionEp.overview };
}

interface ExternalIdRow {
    provider: string;
    external_id: string;
}

export interface MediaItemCurrentRow {
    media_type: string;
    title: string;
    year: number | null;
    overview: string | null;
    metadata_locked: boolean;
}

/** Internal result that also carries the resolved TMDB ID for callers */
interface SingleItemSyncResult {
    updated: boolean;
    fieldsChanged: string[];
    tmdbId: number | null;
    /**
     * The per-library language resolved via `resolveItemLanguage()` (or null
     * when the item's library has none configured — caller falls back to
     * `config.TMDB_LANGUAGE`). Exposed so `syncSeriesWithChildrenInner` can
     * reuse the SAME resolution for the children (season/episode) fetch
     * instead of re-querying, keeping series-level and children-level text
     * sync in the same language.
     */
    libraryLanguage: string | null;
}

/**
 * Required options controlling lock behavior.
 *
 * `force` applies to the target row (the movie, or the series row for
 * syncSeriesWithChildren). When `false`, the lock is honored. When `true`,
 * fresh provider data is fetched; the lock is bypassed only when respectLocks
 * is false. The lock is never cleared — unlocking is a
 * separate, explicit user action (see unlockMediaItem).
 *
 * `forceChildren` controls whether force cascades to seasons/episodes in
 * series sync. It defaults to `false` because per-row lock independence
 * matches the admin UI's mental model: locking an episode's title should
 * survive a parent-series sync. Pass `true` explicitly (e.g. after an
 * admin confirms in a dialog) to override per-child locks as well.
 */
export interface SyncOptions {
    force: boolean;
    /** Fetch fresh data and expand explicitly requested series without bypassing saved locks. */
    respectLocks?: boolean;
    forceChildren?: boolean;
    /**
     * Create missing seasons/episodes even for a series that is not owned
     * (see `isOwnedSeries`). Set ONLY by the explicit admin "Re-sync series
     * children" action; bulk-media-sync and scheduled paths leave it unset so
     * discovery series never grow phantom children.
     */
    forceCreateChildren?: boolean;
}

/**
 * Shared lookup: resolve TMDB ID and media type for a media item.
 * Returns null if item not found or has no valid TMDB external ID.
 *
 * Exported (2026-07-07, Task 6 of the multilingual-metadata feature) so
 * `metadata-translations-sync.ts` can reuse the exact same TMDB-id
 * resolution the primary sync path uses instead of re-implementing the
 * external_ids lookup. No behavior change for existing callers.
 */
export async function resolveMediaTmdb(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<{
    tmdbId: number;
    current: MediaItemCurrentRow;
} | null> {
    const [currentRows, externalIdRows] = await Promise.all([
        sql<MediaItemCurrentRow[]>`
            SELECT media_type, title, year, overview, metadata_locked
            FROM media_items
            WHERE id = ${mediaItemId}
        `,
        sql<ExternalIdRow[]>`
            SELECT provider, external_id
            FROM external_ids
            WHERE media_id = ${mediaItemId}
        `,
    ]);

    if (currentRows.length === 0) {
        logger.warn('Media item not found for sync', { mediaItemId });
        return null;
    }

    const tmdbRow = externalIdRows.find((r) => r.provider === 'tmdb');
    if (!tmdbRow) {
        logger.info('No TMDB external ID for item — skipping sync', {
            mediaItemId,
        });
        return null;
    }

    const tmdbId = parseInt(tmdbRow.external_id, 10);
    if (isNaN(tmdbId)) {
        logger.warn('Invalid TMDB ID — cannot sync', {
            mediaItemId,
            rawId: tmdbRow.external_id,
        });
        return null;
    }

    return { tmdbId, current: currentRows[0] };
}

/**
 * Resolve the TMDB metadata language for an item from its library's
 * per-library `language` setting (via the library group its files belong to).
 * Returns null when the item has no library group or no path language is set,
 * letting the caller fall back to the global default (`config.TMDB_LANGUAGE`).
 */
async function resolveItemLanguage(sql: postgres.Sql, mediaItemId: string): Promise<string | null> {
    try {
        const rows = await sql<{ language: string | null }[]>`
            SELECT lp.language
            FROM media_items mi
            JOIN library_paths lp ON lp.library_group_id = mi.library_group_id
            WHERE mi.id = ${mediaItemId} AND lp.language IS NOT NULL AND lp.language <> ''
            LIMIT 1
        `;
        const lang = rows[0]?.language?.trim();
        return lang && lang.length > 0 ? lang : null;
    } catch {
        return null;
    }
}

/**
 * Sync metadata for a single media item from its provider (TMDB).
 *
 * Looks up external IDs, determines provider, fetches fresh data, writes
 * the changed fields. Respects `metadata_locked` unless `options.force`
 * is true. Never clears the lock — unlocking is always an explicit user
 * action.
 */
export async function syncSingleItem(
    sql: postgres.Sql,
    mediaItemId: string,
    options: SyncOptions,
): Promise<{ updated: boolean; fieldsChanged: string[] }> {
    const result = await syncSingleItemInternal(sql, mediaItemId, options);
    return { updated: result.updated, fieldsChanged: result.fieldsChanged };
}

/**
 * Internal version that also returns the resolved TMDB ID
 * so callers like syncSeriesWithChildren avoid a duplicate lookup.
 */
async function syncSingleItemInternal(
    sql: postgres.Sql,
    mediaItemId: string,
    options: SyncOptions,
): Promise<SingleItemSyncResult> {
    const resolved = await resolveMediaTmdb(sql, mediaItemId);
    if (!resolved) {
        return { updated: false, fieldsChanged: [], tmdbId: null, libraryLanguage: null };
    }

    const { tmdbId, current } = resolved;
    // Defensive: `resolveMediaTmdb` only returns non-null when it loaded a row,
    // so `current` is normally present — but an interrupted/aborted query on the
    // task-tier connection produced an undefined `current`, and the unguarded
    // `current.media_type` threw "Cannot read properties of undefined (reading
    // 'media_type')", turning a transient into a PERMANENT per-item failure.
    // Treat it as a no-op (the next run re-resolves) rather than crashing.
    if (!current) {
        logger.warn('Resolved media item missing current row — skipping sync', { mediaItemId });
        return { updated: false, fieldsChanged: [], tmdbId, libraryLanguage: null };
    }
    const mediaType = current.media_type;
    const overrideLock = options.force && !options.respectLocks;
    const canWrite = overrideLock || !current.metadata_locked;

    // Localize to the item's per-library language; fall back to the global
    // default (config.TMDB_LANGUAGE) when the library has none configured.
    // Always construct via createTMDBApi() — never fall back to the `tmdbApi`
    // singleton here. The singleton's language is frozen at process boot
    // (its constructor default param is evaluated once, at module load), so
    // a config change made after boot would silently never reach it. Reading
    // config.TMDB_LANGUAGE fresh on every call keeps this path honoring the
    // CURRENT config value.
    const libraryLanguage = await resolveItemLanguage(sql, mediaItemId);
    const api = createTMDBApi(libraryLanguage ?? config.TMDB_LANGUAGE);

    let fetchedTitle: string | null;
    let fetchedYear: number | null;
    let fetchedOverview: string | null;
    let tmdbDetails: Record<string, unknown> | null;

    if (isMovie(mediaType)) {
        // A forced (admin) refresh must see TMDB's answer now, not one the
        // task chain cached minutes ago.
        const details = await api.getMovieDetails(tmdbId, { fresh: options.force === true });
        tmdbDetails = details as unknown as Record<string, unknown>;
        fetchedTitle = details.title ?? null;
        fetchedYear = details.release_date ? parseInt(details.release_date.slice(0, 4), 10) : null;
        fetchedOverview = details.overview ?? null;
    } else if (isSeries(mediaType)) {
        const details = await api.getTVShowDetails(tmdbId, { fresh: options.force === true });
        tmdbDetails = details as unknown as Record<string, unknown>;
        fetchedTitle = details.name ?? null;
        fetchedYear = details.first_air_date
            ? parseInt(details.first_air_date.slice(0, 4), 10)
            : null;
        fetchedOverview = details.overview ?? null;
    } else {
        logger.info('Unsupported media type for TMDB sync — skipping', {
            mediaItemId,
            mediaType,
        });
        return { updated: false, fieldsChanged: [], tmdbId, libraryLanguage };
    }

    const fieldsChanged: string[] = [];

    if (fetchedTitle !== null && fetchedTitle !== current.title) {
        fieldsChanged.push('title');
    }
    if (fetchedYear !== null && fetchedYear !== current.year) {
        fieldsChanged.push('year');
    }
    if (fetchedOverview !== null && fetchedOverview !== current.overview) {
        fieldsChanged.push('overview');
    }

    // `canWrite` was computed from the same SELECT that loaded current
    // title/year/overview. Treat media_items and provider_metadata as one
    // decision: embeddings read overview/genres/cast from pm but title
    // from mi — refreshing pm while mi stays locked would produce hybrid
    // embeddings that drift silently from what the user sees.

    // Write only when something actually changed and we're permitted.
    // The lock itself is never modified here — unlock is an explicit
    // user action (unlockMediaItem endpoint).
    let wroteUpdate = false;
    if (canWrite && fieldsChanged.length > 0) {
        const updated = await sql<{ id: string }[]>`
            UPDATE media_items
            SET
                title    = ${fetchedTitle ?? sql`title`},
                year     = ${fetchedYear !== null ? fetchedYear : sql`year`},
                overview = ${fetchedOverview !== null ? fetchedOverview : sql`overview`}
            WHERE id = ${mediaItemId}
                AND (${overrideLock} OR NOT metadata_locked)
            RETURNING id
        `;
        wroteUpdate = updated.length > 0;
        if (wroteUpdate) await refreshSortTitles(sql, [mediaItemId]);

        if (wroteUpdate) {
            // Fire-and-forget lifecycle hook for cache invalidation. Log
            // failures at error level so a missing-task / Valkey-down
            // condition surfaces — silent swallow has hidden regressions
            // here before (fires on every TMDB sync, very hot path).
            // No sql arg: fire-and-forget hook. On the series path `sql` is the
            // reserved connection from withSeriesSyncLock, so a deferred query on
            // it would race the lock's in-flight work — let the hook resolve a
            // pool via getDb() itself (its pre-pool-split behaviour).
            MediaLifecycleService.afterMetadataChanged(mediaItemId, fieldsChanged).catch(
                (err: unknown) => {
                    logger.error(
                        'afterMetadataChanged lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        {
                            mediaItemId,
                            fieldsChanged,
                            source: 'metadata-sync-single',
                        },
                    );
                },
            );
        } else {
            // The row vanished or was locked while the provider request was in flight.
            logger.info('Item became unavailable for metadata updates during sync', {
                mediaItemId,
                tmdbId,
            });
        }
    } else if (fieldsChanged.length > 0) {
        logger.info('Skipped metadata update — item is locked', {
            mediaItemId,
            tmdbId,
            fieldsThatWouldHaveChanged: fieldsChanged,
        });
    }

    // National certification (FSK, MPAA, ...) for the configured country, from the
    // release_dates / content_ratings blocks already in this response (no extra
    // request). It wins over MDBList and is written even for a locked item:
    // age_rating is an access-control input, see updateMediaAgeRating.
    const ageRatingCountry = effectiveAgeRatingCountry();
    const nationalCertification = tmdbDetails
        ? pickTmdbCertification(tmdbDetails, isMovie(mediaType) ? 'movie' : 'tv', ageRatingCountry)
        : null;
    if (nationalCertification) {
        try {
            await applyNationalAgeRating(sql, mediaItemId, nationalCertification.certification);
        } catch (err) {
            logger.warn('Failed to apply national age rating', { mediaItemId, tmdbId }, err as Error);
        }
    }

    // Store full TMDB response as provider metadata for embedding generation.
    // Gated on the same lock as media_items — a locked row means the user
    // wants a frozen snapshot, so embeddings must stay aligned with what
    // the user sees. Refreshing pm alone would produce hybrid embeddings.
    if (tmdbDetails && canWrite) {
        try {
            const { createCatalogService } =
                await import('$lib/server/services/catalog.service.js');
            const catalogService = createCatalogService(sql);
            // Persist a top-level logo_path derived from TMDB's nested images.logos
            // so the clearLogo is stored (and aggregated) like poster/backdrop.
            const logoPath = pickTmdbLogoPath(tmdbDetails);
            // The raw TMDB response uses `runtime` and `credits.cast`, but the
            // aggregator + detail read only understand the canonical keys
            // `runtime_minutes`, `cast` (with person_id), `actors`, `directors`.
            // Storing the raw blob alone silently dropped cast + runtime from
            // fresh items. Normalize through the provider-neutral seam and OVERLAY
            // the canonical fields so the per-item refresh produces the same
            // stored shape as the discovery path (which the established catalog
            // already relies on).
            const canonicalOverlay = buildCanonicalDetailFields(
                buildProviderDetailResult(tmdbDetails, isMovie(mediaType) ? 'movie' : 'tv'),
            );
            const metadataToStore: Record<string, unknown> = {
                ...tmdbDetails,
                ...(logoPath && !(tmdbDetails as { logo_path?: unknown }).logo_path
                    ? { logo_path: logoPath }
                    : {}),
                ...canonicalOverlay,
            };
            // A title with NO keywords leaves the overlay without `keywords`, so
            // the raw TMDB envelope object would survive the spread and be
            // aggregated as-is — 1,219 rows on prod made every
            // jsonb_array_length(metadata->'keywords') predicate throw (2026-09-24).
            if (!Array.isArray(metadataToStore['keywords'])) delete metadataToStore['keywords'];
            // The per-country certification blocks are large (one entry per country)
            // and already reduced to `certification` above; do not persist them.
            delete metadataToStore['release_dates'];
            delete metadataToStore['content_ratings'];
            if (nationalCertification) {
                metadataToStore['certification'] = nationalCertification.certification;
                metadataToStore['certification_country'] = nationalCertification.country;
            }
            // Which country this fetch looked up, so the age-rating backfill (and a
            // later change of the country setting) can tell which titles still need a lookup.
            metadataToStore[CERTIFICATION_CHECKED_COUNTRY_KEY] = ageRatingCountry;
            // Both re-aggregation calls below must carry `force` forward:
            // `canWrite` (which gated this whole block) is `options.force ||
            // !current.metadata_locked` — if we got here because of `force`
            // on a locked item, the 'aggregated' rebuild must also bypass
            // the lock, or the tmdb row gets force-written but 'aggregated'
            // silently stays stale (C3, 2026-09-24 security review).
            await catalogService.storeProviderMetadata(
                mediaItemId,
                'tmdb',
                metadataToStore,
                undefined,
                undefined,
                { force: overrideLock },
            );
            // Recompute the merged 'aggregated' provider_metadata row now that the
            // tmdb row changed. Without this, a tmdb re-enrich (e.g. a sparse Jan
            // row later expanded with overview/genres/poster) leaves the
            // 'aggregated' row stale — and because the metadata lateral join picks
            // 'aggregated' first (LIMIT 1, no per-field coalesce), the modal would
            // read NULL overview/poster off a stale aggregated blob while the rich
            // values sit unused in the tmdb row. mdblist-sync already re-aggregates
            // after its writes; tmdb-sync must too. (Also re-fires the
            // metadata.changed event so embeddings re-derive from fresh text.)
            const { aggregateMetadataForMedia } =
                await import('$lib/server/database/queries/metadata-aggregation.queries.js');
            await aggregateMetadataForMedia(sql, mediaItemId, { force: overrideLock });
        } catch (err) {
            logger.warn(
                'Failed to store provider metadata during sync',
                { mediaItemId, tmdbId },
                err as Error,
            );
        }
    }

    // Persist localized/original/alias titles so search matches a title the user
    // knows (e.g. German "Große Pause") even when the primary media_items.title is
    // English ("Hafentage"). NOT gated on canWrite: media_titles are search aliases,
    // not the user-visible canonical title — a metadata lock freezes the displayed
    // title, not the item's findability by its other-language names.
    if (tmdbDetails) {
        try {
            await upsertMediaTitles(sql, mediaItemId, collectTmdbTitles(tmdbDetails), 'tmdb');
        } catch (err) {
            logger.warn(
                'Failed to upsert media_titles during sync',
                { mediaItemId, tmdbId },
                err as Error,
            );
        }
    }

    // Persist per-language display translations (title/overview/tagline) for
    // the admin's configured extra languages — zero extra API calls, the
    // `translations` append_to_response data is already in tmdbDetails. Same
    // NOT-gated-on-canWrite rationale as media_titles above: the lock is
    // enforced at READ time by getTranslationMapForItems.
    if (tmdbDetails) {
        const extraLanguages = config.METADATA_ADDITIONAL_LANGUAGES;
        if (extraLanguages.length > 0) {
            try {
                await upsertMediaTranslations(
                    sql,
                    mediaItemId,
                    collectTmdbTranslations(tmdbDetails, extraLanguages),
                );
                // Stage bookkeeping (movies only): mark the translations
                // stage completed so Task 6's backlog skips it on the next
                // sweep. Series stay pending — episode-level fetches are
                // still needed. `metadata-translations-sync` isn't
                // registered yet (Task 6 adds it); upsertCompletedRow is a
                // plain upsert with no registry validation, so writing the
                // row early is safe.
                if (isMovie(mediaType)) {
                    try {
                        await upsertCompletedRow(sql, {
                            mediaItemId,
                            stageId: 'metadata-translations-sync',
                            processingVersion: 1,
                        });
                    } catch (err) {
                        logger.warn(
                            'Failed to mark metadata-translations-sync stage completed',
                            { mediaItemId, tmdbId },
                            err as Error,
                        );
                    }
                }
            } catch (err) {
                logger.warn(
                    'Failed to upsert media_item_translations during sync',
                    { mediaItemId, tmdbId },
                    err as Error,
                );
            }
        }
    }

    logger.info('Synced media item from TMDB', {
        mediaItemId,
        tmdbId,
        fieldsChanged,
        wroteUpdate,
    });

    return {
        updated: wroteUpdate,
        fieldsChanged: wroteUpdate ? fieldsChanged : [],
        tmdbId,
        libraryLanguage,
    };
}

/** Result of syncing a series with all its children */
export interface SeriesSyncResult {
    /** No provider could resolve this series; no children fetch was attempted. */
    prerequisiteMissing?: 'provider-identity';
    updated: boolean;
    fieldsChanged: string[];
    seasonsSynced: number;
    episodesSynced: number;
    /** Number of episode external_id attaches that failed (Jellyfin path only). */
    episodesAttachFailed: number;
    /**
     * True when the children-expansion phase was deliberately declined by the
     * phantom-series gate (the series has no descendant with a file). This is a
     * TERMINAL "nothing to do" outcome — distinct from a zero-episode result
     * caused by an aborted/timed-out run — so the task layer can claim coverage
     * and stop the stage-sweep from re-enqueuing the series every cycle. Without
     * this discriminator a fileless discovery series loops forever (observed on
     * prod: one series re-synced ~18k×/day).
     */
    phantomSkipped?: boolean;
    /**
     * Why missing seasons/episodes were not created: `'not-owned'` = the
     * series has no file and was never added to a library, so only existing
     * children were refreshed (or none at all, see `phantomSkipped`). Unset
     * when children were created normally. Lets the admin UI explain a
     * zero-child re-sync.
     */
    childrenSkipped?: 'not-owned';
    /**
     * TMDB episode catalog built from the children fetched during this sync
     * (primary names only, empty altNames). Available on the TMDB provider path;
     * undefined on the Jellyfin path (which has no authoritative TMDB catalog).
     * Threaded out so the task layer can pass it to applyReconciliation without
     * a duplicate TMDB API fetch.
     */
    tmdbCatalog?: TmdbCatalogEpisode[];
    /**
     * Set when only some seasons were fetched (routine re-sync): the season
     * numbers `tmdbCatalog` covers. Reconciliation must be limited to episodes
     * of these seasons, or it could fuzzy-match an unfetched season's episode
     * against a lookalike title in the fetched ones.
     */
    fetchedSeasonNumbers?: number[];
    /** Seasons TMDB failed to deliver: not written; the run must not claim coverage. */
    incompleteSeasons?: number[];
    reconciliationSkipped?: Extract<ReconciliationCatalogResult, { status: 'skipped' }>;
}

/**
 * Resolve which metadata provider plugin owns a series by looking up its
 * external_ids and matching the provider name against enabled plugins.
 */
async function fetchSeriesChildren(
    providerId: string,
    externalId: string,
    signal?: AbortSignal,
    language?: string | null,
    routineSeriesId?: { sql: postgres.Sql; mediaItemId: string },
): Promise<SeriesChildrenResult> {
    if (providerId === 'tmdb-metadata-provider') {
        // Routine re-sync (no force flag): only the seasons that can have
        // changed. See series-season-refresh-plan.ts. Forced syncs fetch all.
        if (!routineSeriesId) return tmdbGetSeriesChildren(externalId, signal, language);
        const { sql, mediaItemId } = routineSeriesId;
        const local = await loadStoredSeasonState(sql, mediaItemId);
        return tmdbGetSeriesChildren(externalId, signal, language, {
            selectSeasons: (listing) => {
                const picked = selectSeasonsToRefresh(
                    listing,
                    local.seasons,
                    local.hasUnidentifiedFileBackedEpisode,
                    isFullRefreshDue(mediaItemId, local.lastFullFetchAtMs, Date.now()),
                );
                logger.debug('Routine series sync: season refresh plan', {
                    mediaItemId,
                    fetching: picked.size,
                    skipping: listing.length - picked.size,
                });
                return picked;
            },
        });
    }
    if (providerId === 'jellyfin-metadata-provider') {
        // jellyfin + anidb helpers don't accept signal yet — adding it
        // is a separate per-provider refactor. The TMDB path is the
        // common case + the one hitting the 24min hang.
        return jellyfinGetSeriesChildren(externalId);
    }
    if (providerId === 'anidb-metadata-provider') {
        return anidbGetSeriesChildren(externalId);
    }
    // mdblist and musicbrainz don't implement series-children — the legacy
    // plugins both returned empty as well (no getEpisodeList implementations).
    // Log so a future provider author notices the gap if their plugin lands
    // here without a helper.
    logger.warn('No series-children helper for provider — returning empty', {
        providerId,
        externalId,
    });
    return { seasons: [] };
}

/**
 * What we already store for a series, for {@link selectSeasonsToRefresh}:
 * per-season episode count + premiere date, and whether any file-backed
 * episode still lacks a TMDB identity (reconcilers then need the full catalog).
 */
async function loadStoredSeasonState(
    sql: postgres.Sql,
    seriesId: string,
): Promise<{
    seasons: Map<number, StoredSeasonState>;
    hasUnidentifiedFileBackedEpisode: boolean;
    lastFullFetchAtMs: number | null;
}> {
    // One statement (not two): a series with no season row cannot have a
    // file-backed episode, so the flag riding on the season rows loses nothing.
    const rows = await sql<
        Array<{
            season_number: number;
            premiere_date: string | null;
            episode_count: number;
            unidentified_file_backed: boolean;
            last_full_fetch_at: string | null;
        }>
    >`
        SELECT s.season_number, s.premiere_date::text AS premiere_date,
               (SELECT count(*)::int FROM media_items e
                 WHERE e.parent_id = s.id AND e.media_type = 'episode') AS episode_count,
               EXISTS (
                   SELECT 1 FROM media_items e
                   WHERE e.parent_id = s.id AND e.media_type = 'episode'
                     AND (e.has_files OR EXISTS (
                           SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = e.id))
                     AND NOT EXISTS (
                           SELECT 1 FROM external_ids ei
                           WHERE ei.media_id = e.id AND ei.provider = 'tmdb'
                             AND ei.media_type = 'episode')
               ) AS unidentified_file_backed,
               (SELECT pm.metadata->>${FULL_REFRESH_METADATA_KEY}::text FROM provider_metadata pm
                 WHERE pm.media_id = ${seriesId} AND pm.provider = 'tmdb') AS last_full_fetch_at
        FROM media_items s
        WHERE s.parent_id = ${seriesId} AND s.media_type = 'season'
          AND s.season_number IS NOT NULL
    `;
    return {
        seasons: new Map(
            rows.map((r) => [
                r.season_number,
                { episodeCount: r.episode_count, premiereDate: r.premiere_date },
            ]),
        ),
        hasUnidentifiedFileBackedEpisode: rows.some((r) => r.unidentified_file_backed),
        lastFullFetchAtMs: rows[0]?.last_full_fetch_at
            ? Date.parse(rows[0].last_full_fetch_at)
            : null,
    };
}

async function resolveProviderForSeries(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<{
    providerId: string | null;
    externalId: string | null;
    missingIdentity: boolean;
}> {
    const nullResult = { providerId: null, externalId: null, missingIdentity: true };

    const externalIdRows = await sql<Array<{ provider: string; external_id: string }>>`
        SELECT provider, external_id FROM external_ids
        WHERE media_id = ${mediaItemId}
        ORDER BY
            CASE provider
                WHEN 'tmdb' THEN 1
                WHEN 'tvdb' THEN 2
                WHEN 'imdb' THEN 3
                ELSE 10
            END
    `;

    const usableIds = externalIdRows.filter((row) => row.provider.trim() && row.external_id.trim());
    if (usableIds.length === 0) return nullResult;

    const providers = getProvidersByPriority();

    // Match external ID provider against the new task registry's provider ids.
    // Sources here use short prefixes ('tmdb', 'jellyfin', 'imdb', ...);
    // the registry stores full ids ('tmdb-metadata-provider', etc.).
    for (const row of usableIds) {
        const provider = row.provider.trim().toLowerCase();
        // Guard against empty/whitespace provider rows — id.includes('')
        // would otherwise match every registered provider and pick whichever
        // sorts first by priority.
        if (!provider) continue;
        const matchedDef = providers.find((p) => {
            const id = p.id.toLowerCase();
            return id.startsWith(provider) || id.includes(provider);
        });

        if (matchedDef) {
            return {
                providerId: matchedDef.id,
                externalId: row.external_id.trim(),
                missingIdentity: false,
            };
        }
    }

    logger.info('No metadata provider matched any external ID for series', {
        mediaItemId,
        externalProviders: externalIdRows.map((r) => r.provider),
    });
    return { providerId: null, externalId: null, missingIdentity: false };
}

/**
 * Namespace for series-sync advisory locks — arbitrary int4 chosen once.
 * Kept here (not exported) so no other subsystem accidentally collides.
 */
const SERIES_SYNC_LOCK_NAMESPACE = 0x53455253; // "SERS"

/**
 * Thrown when another concurrent sync holds the lock past our deadline.
 * BullMQ retries the job with backoff — once the holding sync finishes, the
 * retry acquires the lock cleanly. This avoids the silent-success trap
 * where a timed-out sync reports {success:true} and the series is never
 * re-synced.
 */
export class SeriesSyncLockTimeoutError extends Error {
    constructor(mediaItemId: string) {
        super(`series-sync lock timeout for ${mediaItemId} — will retry`);
        this.name = 'SeriesSyncLockTimeoutError';
    }
}

/** An existing identity has no currently enabled metadata provider. */
export class SeriesSyncProviderUnavailableError extends Error {
    constructor(mediaItemId: string) {
        super(
            `Series metadata provider unavailable for existing identity on ${mediaItemId}; retry after restoring the provider`,
        );
        this.name = 'SeriesSyncProviderUnavailableError';
    }
}

/**
 * Thrown when the abort signal fires while series-sync is spinning on the
 * advisory lock. The task wrapper catches this and returns stopReason:
 * 'aborted' rather than letting BullMQ classify it as a generic failure.
 */
export class SeriesSyncAbortedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SeriesSyncAbortedError';
    }
}

/**
 * Acquire a PG advisory lock scoped to this mediaItemId, run `operation`,
 * then release. Uses `pg_try_advisory_lock` in a short polling loop bounded
 * by the caller's abort signal so a concurrent admin cancel still wins.
 *
 * CRITICAL: session-scoped advisory locks must be acquired AND released on
 * the same physical connection. postgres.js is a pool, so each bare
 * tagged-template call can pick a different connection. We pin via
 * `sql.reserve()` — the reserved handle owns one connection for the full
 * acquire→operate→release lifecycle, guaranteeing unlock targets the
 * correct session.
 *
 * The `operation` callback receives the SAME reserved connection so that
 * inner queries also land there. This is fine for this sync path — total
 * query volume is bounded by the number of seasons/episodes and the lock
 * intentionally serializes concurrent syncs of the same item anyway.
 */
async function withSeriesSyncLock<T>(
    sql: postgres.Sql,
    mediaItemId: string,
    signal: AbortSignal | undefined,
    operation: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
    const reserved = await sql.reserve();
    // postgres.js ReservedSql is callable as a tagged template but its type
    // isn't directly assignable to postgres.Sql; cast for use at call sites.
    const rSql = reserved as unknown as postgres.Sql;
    try {
        const [{ key }] = await rSql<[{ key: number }]>`
            SELECT hashtext(${mediaItemId})::int4 AS key
        `;

        let acquired = false;
        const deadline = Date.now() + 30_000;

        while (!acquired) {
            if (signal?.aborted) {
                throw new SeriesSyncAbortedError('series-sync aborted before lock acquired');
            }
            const [row] = await rSql<[{ ok: boolean }]>`
                SELECT pg_try_advisory_lock(${SERIES_SYNC_LOCK_NAMESPACE}, ${key}) AS ok
            `;
            acquired = row?.ok === true;
            if (acquired) break;
            if (Date.now() > deadline) {
                logger.info('series-sync lock timeout — yielding for retry', {
                    mediaItemId,
                });
                throw new SeriesSyncLockTimeoutError(mediaItemId);
            }
            await new Promise((r) => setTimeout(r, 500));
        }

        try {
            return await operation(rSql);
        } finally {
            try {
                await rSql`
                    SELECT pg_advisory_unlock(${SERIES_SYNC_LOCK_NAMESPACE}, ${key})
                `;
            } catch (err) {
                logger.warn(
                    'Failed to release series-sync advisory lock',
                    {
                        mediaItemId,
                    },
                    err as Error,
                );
            }
        }
    } finally {
        try {
            reserved.release();
        } catch {
            // postgres.js may throw if already released — harmless
        }
    }
}

/**
 * Sync metadata for a series and all its seasons/episodes.
 *
 * 1. Syncs the series itself (title, year, overview) — respects lock unless force
 * 2. Resolves the metadata provider from external_ids
 * 3. Fetches all seasons/episodes via getSeriesChildrenFromProvider()
 * 4. Upserts children into media_items — each child independently respects its own lock
 *
 * Wrapped in a per-mediaItemId advisory lock so two concurrent kickoffs
 * (e.g. admin sync + file-scanner afterMatched) can't interleave upserts
 * against the same season/episode rows. If the lock times out, throws
 * SeriesSyncLockTimeoutError so BullMQ retries rather than silently
 * reporting success.
 *
 * @param options - Sync policy (force: true to override per-item locks)
 * @param onProgress - Optional callback for streaming progress updates
 */
export async function syncSeriesWithChildren(
    sql: postgres.Sql,
    mediaItemId: string,
    options: SyncOptions,
    onProgress?: (event: SyncProgress) => void,
    signal?: AbortSignal,
): Promise<SeriesSyncResult> {
    // Created child ids are collected inside the advisory lock and flushed
    // through `afterCreated` AFTER the lock releases. The hook does pubsub
    // and a `sql.begin()` write on its own connection, so we don't want to
    // hold the per-series lock for the full N×fan-out duration.
    const createdChildIds: string[] = [];
    const result = await withSeriesSyncLock(sql, mediaItemId, signal, (rSql) =>
        syncSeriesWithChildrenInner(
            rSql,
            mediaItemId,
            options,
            onProgress,
            signal,
            createdChildIds,
        ),
    );

    for (const childId of createdChildIds) {
        if (signal?.aborted) break;
        try {
            await MediaLifecycleService.afterCreated(childId, 'series-sync', sql);
        } catch (err) {
            logger.warn('afterCreated lifecycle hook failed for series child', {
                mediaItemId: childId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return result;
}

// W2.2 contract: this restriction (Jellyfin metadata sync attaches IDs only,
// never creates episode rows) applies ONLY to metadata-sync-driven series
// children. The file scanner's hierarchy creation path
// (`findOrCreateSeriesHierarchy` in video-processor.ts) is independent and
// still creates rows from on-disk content as before.
/**
 * "Owned series" predicate: the series may grow season/episode rows.
 *
 * True when the series row itself has files or was ever added to a library
 * (`library_added_at`), or when any descendant has files (`has_files`) or a
 * `media_file_items` link. Missing episodes of an owned series are intended
 * (FEATURE_SHOW_MISSING_EPISODES); discovery series are not owned.
 */
export async function isOwnedSeries(sql: postgres.Sql, seriesId: string): Promise<boolean> {
    const rows = await sql<{ has_file: boolean }[]>`
        WITH RECURSIVE descendants AS (
            SELECT id FROM media_items WHERE parent_id = ${seriesId}
            UNION ALL
            SELECT c.id FROM media_items c
              JOIN descendants d ON c.parent_id = d.id
        )
        SELECT (
            EXISTS (
                SELECT 1 FROM media_items s
                WHERE s.id = ${seriesId}
                  AND (s.has_files OR s.library_added_at IS NOT NULL)
            )
            OR EXISTS (
                SELECT 1 FROM descendants d
                  JOIN media_items m ON m.id = d.id
                WHERE m.has_files
                   OR EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = d.id)
            )
        ) AS has_file
    `;
    return rows[0]?.has_file === true;
}

async function syncSeriesWithChildrenInner(
    sql: postgres.Sql,
    mediaItemId: string,
    options: SyncOptions,
    onProgress?: (event: SyncProgress) => void,
    signal?: AbortSignal,
    createdChildIds: string[] = [],
): Promise<SeriesSyncResult> {
    // Capture provider identity and consumed language before any provider I/O.
    // Child sync may legitimately update the graph; only these source inputs
    // are carried across that producer boundary.
    const completeReconciliationCatalog = await beginReconciliationCatalog(sql, mediaItemId);
    // Step 1: Sync series-level metadata (title, year, overview)
    const seriesResult = await syncSingleItemInternal(sql, mediaItemId, options);

    // Step 2: Resolve which metadata provider owns this series
    const { providerId, externalId, missingIdentity } = await resolveProviderForSeries(
        sql,
        mediaItemId,
    );
    if (!providerId || !externalId) {
        if (!missingIdentity) {
            throw new SeriesSyncProviderUnavailableError(mediaItemId);
        }
        logger.info('No metadata provider found for series children sync', {
            mediaItemId,
        });
        return {
            updated: seriesResult.updated,
            fieldsChanged: seriesResult.fieldsChanged,
            seasonsSynced: 0,
            episodesSynced: 0,
            episodesAttachFailed: 0,
            prerequisiteMissing: 'provider-identity',
        };
    }

    // Step 2.5: Phantom-series gate. A series that is not owned (see
    // `isOwnedSeries`) never gets seasons/episodes created: auto-fetching them
    // from TMDB for catalog rows seeded by discovery (Jellyseerr discover feed,
    // AI recommendation lookups) creates thousands of phantom episodes the user
    // will never own. Observed on preprod: 32k phantom roots -> 670k phantom
    // media_items -> 3.6M phantom stage_state rows.
    //
    // Without `force` the whole children expansion is skipped. With `force`
    // (admin re-sync, bulk-media-sync) the series still runs so EXISTING
    // children are refreshed, but `createMissing` stays false: no new
    // season/episode rows are created for an un-owned series. Only the
    // explicit admin re-sync passes `forceCreateChildren`, which lets it
    // expand a not-yet-owned series on purpose.
    const owned = await isOwnedSeries(sql, mediaItemId);
    if (!owned && !options.force) {
        logger.debug('Series children sync skipped — series is not owned (phantom series)', {
            mediaItemId,
            providerId,
            externalId,
        });
        return {
            updated: seriesResult.updated,
            fieldsChanged: seriesResult.fieldsChanged,
            seasonsSynced: 0,
            episodesSynced: 0,
            episodesAttachFailed: 0,
            // Terminal skip (not an abort) — see SeriesSyncResult.phantomSkipped.
            phantomSkipped: true,
            childrenSkipped: 'not-owned',
        };
    }
    const createMissing = owned || options.forceCreateChildren === true;
    if (!createMissing) {
        logger.info('Series children sync: series is not owned, creating no new children', {
            mediaItemId,
            childrenSkipped: 'not-owned',
        });
    }

    // Step 3: Fetch seasons + episodes from the resolved provider via the
    // per-provider series-children helpers (extracted from the legacy
    // MetadataProviderPlugin.getSeriesChildren paths during Phase 3).
    // Pass the abort signal so a runner-side watchdog cancellation
    // propagates into the TMDB per-season fetch loop — the canonical
    // 24-min-past-the-cap symptom that motivated commit 918d7e26b's
    // false-coverage guards.
    //
    // Reuse the SAME language resolution `syncSingleItemInternal` already
    // performed above (per-library override, else current
    // config.TMDB_LANGUAGE) so episode/season text syncs in the same
    // language as the series-level sync — this is the fix for the
    // frozen-singleton bug (episodes previously synced in whatever language
    // was configured at process boot via the `tmdbApi` singleton, regardless
    // of current config or library setting). Reusing `seriesResult` avoids a
    // second DB round-trip for the same lookup.
    const children = await fetchSeriesChildren(
        providerId,
        externalId,
        signal,
        seriesResult.libraryLanguage,
        // Any explicit/forced flag = full sync of every season.
        options.force || options.forceChildren || options.forceCreateChildren
            ? undefined
            : { sql, mediaItemId },
    );
    if (signal?.aborted) {
        throw new SeriesSyncAbortedError('series-sync aborted during children fetch');
    }

    onProgress?.({
        phase: 'series',
        message: `Fetched ${children.seasons.length} season(s) from ${providerId}`,
        seasonsSynced: 0,
        episodesSynced: 0,
        totalSeasons: children.seasons.length,
    });

    // Step 4: Branch on resolved provider.
    //
    // Jellyfin's `getSeriesChildren` returns whatever the local Jellyfin
    // instance has under this SeriesId — including episodes from a foreign
    // TMDB series that the Jellyfin operator merged into one library entry
    // (the Office AU / Glimmers UK contamination). We therefore refuse to let
    // Jellyfin metadata sync CREATE episode rows. It can only ATTACH its own
    // external_id to TMDB-derived rows that already exist; anything else is
    // quarantined for admin review.
    //
    // TMDB (and any future authoritative provider) keeps the original
    // create-or-update behavior because TMDB's series→episode relationship
    // is canonical, not user-shaped.
    const isJellyfinProvider = providerId === 'jellyfin-metadata-provider';

    if (isJellyfinProvider) {
        const attachResult = await jellyfinAttachOnlySync({
            sql,
            mediaItemId,
            children,
            externalId,
            providerLabel: providerId,
            onProgress,
            signal,
        });

        if (attachResult.episodesAttached > 0 && !signal?.aborted) {
            try {
                const { cacheInvalidation } = await import('$lib/server/cache');
                await cacheInvalidation.onContentAdded([mediaItemId]);
            } catch {
                // Non-fatal
            }
        }

        return {
            updated: seriesResult.updated || attachResult.episodesAttached > 0,
            fieldsChanged: seriesResult.fieldsChanged,
            // Surface attaches/quarantines through the existing counters so the
            // queue/admin UI still shows progress. seasonsSynced counts the
            // Jellyfin seasons we successfully matched against an existing
            // local season; episodesSynced counts attaches.
            seasonsSynced: attachResult.seasonsMatched,
            episodesSynced: attachResult.episodesAttached,
            episodesAttachFailed: attachResult.episodesAttachFailed,
        };
    }

    // Non-Jellyfin path (TMDB, future authoritative providers): unchanged
    // behavior — create or update season/episode rows from the provider's
    // canonical children list.
    const catalogService = new CatalogService(sql);
    let seasonsSynced = 0;
    let episodesSynced = 0;

    // Derive short provider name for external_ids (e.g. 'tmdb' from 'tmdb-metadata-provider')
    const providerName = providerId.replace(/-metadata-provider$/, '').replace(/-metadata$/, '');

    // Children use forceChildren (defaults to false — per-row lock independence).
    const childOptions: SyncOptions = {
        force: options.forceChildren === true,
        forceChildren: options.forceChildren === true,
        respectLocks: options.respectLocks,
    };

    // Positional metadata must not move an existing provider identity. Providers
    // can renumber episodes (including specials), and file-backed local seasons
    // can intentionally differ from the provider's canonical season structure.
    // Check ownership before the batch metadata UPDATE, not only when attaching
    // the external id afterward: that would leave a new title on the old identity.
    const incomingEpisodeIds = [
        ...new Set(
            children.seasons.flatMap((season) =>
                season.episodes.flatMap((episode) =>
                    episode.externalId ? [String(episode.externalId)] : [],
                ),
            ),
        ),
    ];
    const positionsByExternalId = new Map<string, Set<string>>();
    for (const season of children.seasons) {
        for (const episode of season.episodes) {
            if (!episode.externalId || episode.episode == null) continue;
            const externalId = String(episode.externalId);
            const positions = positionsByExternalId.get(externalId) ?? new Set<string>();
            positions.add(`${season.seasonNumber}:${episode.season}:${episode.episode}`);
            positionsByExternalId.set(externalId, positions);
        }
    }
    const duplicatedEpisodeIds = new Set(
        [...positionsByExternalId].filter(([, positions]) => positions.size > 1).map(([id]) => id),
    );
    const identityOwners =
        incomingEpisodeIds.length > 0
            ? await sql<
                  {
                      external_id: string;
                      media_id: string;
                      season_id: string | null;
                      series_id: string | null;
                      parent_season_number: number | null;
                      season_number: number | null;
                      episode_number: number | null;
                  }[]
              >`
            SELECT ei.external_id, owner.id AS media_id, owner.parent_id AS season_id,
                   owner.season_number, owner.episode_number,
                   owner_season.parent_id AS series_id,
                   owner_season.season_number AS parent_season_number
            FROM external_ids ei
            JOIN media_items owner ON owner.id = ei.media_id AND owner.media_type = 'episode'
            LEFT JOIN media_items owner_season ON owner_season.id = owner.parent_id
                AND owner_season.media_type = 'season'
            WHERE ei.provider = ${providerName} AND ei.media_type = 'episode'
              AND ei.external_id = ANY(${incomingEpisodeIds}::text[])
        `
            : [];
    const ownerByExternalId = new Map(identityOwners.map((owner) => [owner.external_id, owner]));
    const identityConflicts: Array<{
        externalId: string;
        ownerMediaId: string | null;
        reason: 'duplicate-provider-id' | 'identity-owned-elsewhere';
        seasonNumber: number;
        episodeNumber: number;
    }> = [];

    // Identity-aware title binding maps (built once for the whole series).
    const localRows = await sql<
        {
            season_number: number;
            episode_number: number;
            tmdb_id: string | null;
            title_binding: string;
        }[]
    >`
        SELECT mi.season_number, mi.episode_number, mi.title_binding,
               ei.external_id AS tmdb_id
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        LEFT JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
        WHERE season.parent_id = ${mediaItemId} AND mi.media_type = 'episode'
    `;
    const localByPosition = new Map<string, LocalEpisodeBinding>();
    for (const r of localRows) {
        if (r.season_number != null && r.episode_number != null) {
            localByPosition.set(`${r.season_number}:${r.episode_number}`, {
                externalTmdbId: r.tmdb_id,
                titleBinding: r.title_binding,
            });
        }
    }
    // TMDB episode ids identity-bound somewhere in this series. A canonical
    // position whose episode id is identity-bound to a DIFFERENT local row is
    // skipped entirely below — otherwise sync would recreate the ghost row
    // (and fight over the external id) that episode/season-structure
    // reconciliation deliberately rebound to a file-backed row.
    const identityBoundTmdbIds = new Set<string>();
    for (const r of localRows) {
        if (r.title_binding === 'identity' && r.tmdb_id) {
            identityBoundTmdbIds.add(r.tmdb_id);
        }
    }
    const catalogById = new Map<string, { name: string; overview: string | null }>();
    const tmdbCatalogForReconcile: TmdbCatalogEpisode[] = [];
    for (const s of children.seasons) {
        for (const ep of s.episodes) {
            catalogById.set(String(ep.externalId), {
                name: ep.title ?? `Episode ${ep.episode}`,
                overview: ep.overview ?? null,
            });
            if (ep.externalId && ep.title && !duplicatedEpisodeIds.has(String(ep.externalId))) {
                // stillUrl is a full CDN URL; TmdbCatalogEpisode.stillPath wants the
                // raw TMDB path ("/abc.jpg"). Only extract when it IS a TMDB URL —
                // this loop also runs for other child-list providers.
                const stillMatch = ep.stillUrl?.match(
                    /^https:\/\/image\.tmdb\.org\/t\/p\/[^/]+(\/.+)$/,
                );
                tmdbCatalogForReconcile.push({
                    tmdbEpisodeId: String(ep.externalId),
                    name: ep.title,
                    altNames: [],
                    overview: ep.overview ?? null,
                    seasonNumber: ep.season,
                    episodeNumber: ep.episode ?? 0,
                    stillPath: stillMatch?.[1] ?? null,
                });
            }
        }
    }

    // Seasons whose provider returned a poster — materialized after the loop. The
    // poster URL travels with the id so the enqueue can tell "already local" from
    // "upstream poster changed" without another TMDB call.
    const seasonsNeedingArtwork: Array<{ mediaItemId: string; posterUrl: string }> = [];

    for (const season of children.seasons) {
        if (signal?.aborted) break;

        // Filter identity conflicts before creating/updating the season, too:
        // a wholly rejected provider season must not resurrect an empty shell.
        const eligibleEpisodes = season.episodes.filter((episode) => {
            if (episode.episode == null || !episode.externalId) return true;
            const externalId = String(episode.externalId);
            if (identityBoundTmdbIds.has(externalId)) {
                const local = localByPosition.get(`${episode.season}:${episode.episode}`);
                if (!(local?.titleBinding === 'identity' && local.externalTmdbId === externalId)) {
                    return false;
                }
            }
            const owner = ownerByExternalId.get(externalId);
            const duplicate = duplicatedEpisodeIds.has(externalId);
            const ownedElsewhere =
                owner &&
                (owner.series_id !== mediaItemId ||
                    owner.parent_season_number !== season.seasonNumber ||
                    owner.season_number !== episode.season ||
                    owner.episode_number !== episode.episode);
            if (duplicate || ownedElsewhere) {
                identityConflicts.push({
                    externalId,
                    ownerMediaId: owner?.media_id ?? null,
                    reason: duplicate ? 'duplicate-provider-id' : 'identity-owned-elsewhere',
                    seasonNumber: episode.season,
                    episodeNumber: episode.episode,
                });
                return false;
            }
            return true;
        });
        if (season.episodes.length > 0 && eligibleEpisodes.length === 0) continue;

        const seasonResult = await findOrCreateChild(
            sql,
            {
                parentId: mediaItemId,
                mediaType: 'season',
                seasonNumber: season.seasonNumber,
                title: season.name,
                overview: season.overview ?? null,
                premiereDate: season.airDate ?? null,
                sortOrder: season.seasonNumber,
            },
            childOptions,
            createMissing,
        );
        if (!seasonResult) continue;
        const seasonMediaId = seasonResult.id;
        if (seasonResult.created) createdChildIds.push(seasonResult.id);

        // Per-season poster. Seasons carry no provider external_id and no
        // Jellyfin image_tag in a TMDB-only deployment, so the image proxy has
        // nothing season-specific to serve and the UI falls back to an "S1"
        // placeholder.
        //
        // This used to stash the absolute TMDB URL on custom_poster_url. That left
        // the bytes remote (so the library was neither portable nor offline-capable),
        // made seasons the only artwork slot with no durable local file, and walked
        // into upsertLocalArtwork's only-set-when-NULL trap
        // (media-artwork.queries.ts:135). It also only ran on afterMatched syncs, so
        // every series matched before 2026-06-21 kept a NULL column permanently.
        //
        // ENQUEUE instead of materializing inline: this loop runs under onProgress
        // and an abort check, and a CDN fetch + disk write + three path-resolution
        // queries per season would inflate this task's wall clock by the season
        // count. The backfill task owns the fetch and the write.
        if (season.posterUrl) {
            await registerImageCandidate(sql, {
                mediaItemId: seasonMediaId,
                role: 'poster',
                provider: deriveImageProvider(season.posterUrl),
                providerRef: season.posterUrl,
                remoteUrl: season.posterUrl,
            });
            seasonsNeedingArtwork.push({ mediaItemId: seasonMediaId, posterUrl: season.posterUrl });
        }

        // Note: we deliberately don't write a per-season external_id under the metadata
        // provider's namespace. SeasonMetadata has no provider-given season ID, and the
        // previous synthetic `${seriesId}_S${seasonNumber}` value (a) violated the
        // valid_tmdb_id CHECK constraint when providerName == 'tmdb' and (b) wasn't read
        // by any query — seasons are joined through parent_id to the series row, which
        // carries the real series external_id. The synthetic upsert produced thousands
        // of constraint-violation warnings per minute on busy series-rematch loops.

        seasonsSynced++;

        onProgress?.({
            phase: 'season',
            message: `Syncing ${season.name} (${season.episodes.length} episodes)…`,
            seasonsSynced,
            episodesSynced,
            totalSeasons: children.seasons.length,
        });

        if (signal?.aborted) break;

        // SQL-C3: batch all of this season's episode upserts into a single
        // multi-row statement instead of one round-trip per episode. Episodes
        // with a missing number are skipped first (they have no natural key),
        // then the survivors are upserted together. external_id writes still
        // run per-episode through CatalogService (composite-key integrity).
        const episodesToUpsert: EpisodeUpsertInput[] = [];
        const upsertSources: typeof season.episodes = [];
        for (const episode of eligibleEpisodes) {
            if (episode.episode == null) {
                logger.warn('Skipping episode with missing episode number', {
                    season: episode.season,
                    title: episode.title,
                    provider: providerId,
                });
                continue;
            }
            const bound = resolveEpisodeTitleBindings(
                {
                    seasonNumber: episode.season,
                    episodeNumber: episode.episode,
                    title: episode.title ?? `Episode ${episode.episode}`,
                    overview: episode.overview ?? null,
                },
                localByPosition,
                catalogById,
            );
            episodesToUpsert.push({
                seasonNumber: episode.season,
                episodeNumber: episode.episode,
                title: bound.title,
                overview: bound.overview,
                premiereDate: episode.airDate ?? null,
                runtimeSeconds: episode.runtime ? episode.runtime * 60 : null,
                sortOrder: episode.episode,
            });
            upsertSources.push(episode);
        }

        const episodeResults = await batchFindOrCreateEpisodes(
            sql,
            seasonMediaId,
            episodesToUpsert,
            childOptions,
            createMissing,
        );

        for (let i = 0; i < upsertSources.length; i++) {
            const episode = upsertSources[i];
            const episodeResult = episodeResults[i];
            if (!episodeResult) continue;
            const episodeMediaId = episodeResult.id;
            if (episodeResult.created) createdChildIds.push(episodeResult.id);

            const isIdentityBound =
                localByPosition.get(`${episode.season}:${episode.episode}`)?.titleBinding ===
                'identity';
            if (episode.externalId && !isIdentityBound) {
                if (signal?.aborted) break;
                const episodeExtId: ExternalIdWrite = {
                    provider: providerName,
                    id: episode.externalId,
                    mediaType: 'episode',
                    source: 'metadata-sync',
                };
                try {
                    await catalogService.upsertExternalId(episodeMediaId, episodeExtId, true);
                } catch (err) {
                    logger.warn('Episode external ID upsert failed', {
                        episodeExternalId: episode.externalId,
                        episodeMediaId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            episodesSynced++;
        }
    }

    if (identityConflicts.length > 0) {
        logger.warn('Skipped positional episode metadata with conflicting provider identities', {
            mediaItemId,
            provider: providerName,
            skipped: identityConflicts.length,
            examples: identityConflicts.slice(0, 5),
        });
    }

    // Fire after the loop so the enqueues never sit inside the abort-budgeted
    // per-season path. Failures are reported and swallowed by the helper.
    if (seasonsNeedingArtwork.length > 0 && !signal?.aborted) {
        const enqueued = await enqueueSeasonArtworkMaterialization(
            sql,
            seasonsNeedingArtwork,
            'metadata-sync-single.syncSeriesWithChildren',
        );
        logger.debug('Enqueued season artwork materialization', {
            mediaItemId,
            seasons: seasonsNeedingArtwork.length,
            enqueued,
        });
    }

    logger.info('Synced series with children', {
        mediaItemId,
        provider: providerId,
        seasonsSynced,
        episodesSynced,
    });

    if ((seasonsSynced > 0 || episodesSynced > 0) && !signal?.aborted) {
        try {
            const { cacheInvalidation } = await import('$lib/server/cache');
            await cacheInvalidation.onContentAdded([mediaItemId]);
        } catch {
            // Non-fatal
        }
    }

    // Season-structure auto-fix: if file-backed episodes remain without a TMDB
    // identity after a full canonical sync (TVDB-vs-TMDB season splits, e.g.
    // Sonarr's 2×25 vs TMDB's 1×50), try to resolve them via episode groups.
    // Cheap SQL gate inside; skips series with a manual ordering; non-fatal.
    if (providerName === 'tmdb' && !signal?.aborted) {
        try {
            const { maybeAutoFixSeasonStructure } =
                await import('./season-structure-reconciliation.service.js');
            // Pass the catalog built above: it carries the LIBRARY-language
            // titles from this fetch (loadTmdbCatalog would re-fetch in the
            // global TMDB_LANGUAGE and freeze wrong-language titles via
            // title_binding='identity').
            await maybeAutoFixSeasonStructure(sql, mediaItemId, {
                signal,
                catalog: tmdbCatalogForReconcile,
            });
        } catch (err) {
            logger.warn('Season-structure auto-fix failed (non-fatal)', {
                mediaItemId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Absolute-numbering auto-fix: catches what episode groups can't — releases
    // numbered absolutely under a season the provider doesn't use, matched to
    // the canonical ghost by absolute episode number (Sky Harbor: `S01E0422` in
    // a `Season 13/` folder). Runs after the season-structure pass so a group
    // match always wins; detection is one query, so there is no gate to pay.
    if (providerName === 'tmdb' && !signal?.aborted) {
        try {
            const { maybeAutoFixAbsoluteNumbering } =
                await import('./absolute-numbering-reconciliation.service.js');
            // Same library-language catalog as above — loadTmdbCatalog would
            // re-fetch in the global TMDB_LANGUAGE and freeze wrong-language
            // titles via title_binding='identity'.
            await maybeAutoFixAbsoluteNumbering(sql, mediaItemId, {
                signal,
                catalog: tmdbCatalogForReconcile,
            });
        } catch (err) {
            logger.warn('Absolute-numbering auto-fix failed (non-fatal)', {
                mediaItemId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Daily-show files ("The Show 2021.03.14.mkv") scanned before this sync
    // created the provider's episodes were auto-numbered; move each onto the
    // episode that aired on its date. One query for a show without such files.
    if (providerName === 'tmdb' && !signal?.aborted) {
        try {
            const { maybeRelinkByAirDate } = await import('./air-date-reconciliation.service.js');
            await maybeRelinkByAirDate(sql, mediaItemId, signal);
        } catch (err) {
            logger.warn('Air-date relink failed (non-fatal)', {
                mediaItemId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const incompleteSeasons = children.incompleteSeasons ?? [];
    // A COMPLETE fetch of every season (forced, periodic or a routine run that
    // happened to select them all) restarts the full-refresh window.
    if (
        providerName === 'tmdb' &&
        !children.partial &&
        incompleteSeasons.length === 0 &&
        !signal?.aborted
    ) {
        await sql`
            UPDATE provider_metadata
            SET metadata = metadata || jsonb_build_object(
                ${FULL_REFRESH_METADATA_KEY}::text, to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
            WHERE media_id = ${mediaItemId} AND provider = 'tmdb'
        `.catch((err: unknown) => {
            logger.warn('Could not record the full season fetch time (non-fatal)', {
                mediaItemId,
                error: err instanceof Error ? err.message : String(err),
            });
        });
    }

    const reconciliationCatalog = await completeReconciliationCatalog(tmdbCatalogForReconcile);
    return {
        updated: seriesResult.updated || seasonsSynced > 0 || episodesSynced > 0,
        fieldsChanged: seriesResult.fieldsChanged,
        seasonsSynced,
        episodesSynced,
        episodesAttachFailed: 0,
        ...(children.partial
            ? { fetchedSeasonNumbers: children.seasons.map((season) => season.seasonNumber) }
            : {}),
        ...(incompleteSeasons.length > 0 ? { incompleteSeasons } : {}),
        ...(reconciliationCatalog.status === 'ready'
            ? { tmdbCatalog: reconciliationCatalog.catalog }
            : { reconciliationSkipped: reconciliationCatalog }),
        ...(createMissing ? {} : { childrenSkipped: 'not-owned' as const }),
    };
}

/**
 * Jellyfin attach-only sync (W2.2).
 *
 * Resolves each Jellyfin season+episode against existing TMDB-derived rows
 * under the given series. For every match, attaches Jellyfin's external_id
 * to the local episode row (NOT primary — TMDB stays primary). For every
 * non-match, writes a `sync_quarantine` entry so an admin can review and
 * decide whether the missing local row is a real gap or a contamination
 * artifact. No season or episode rows are CREATED in this path.
 *
 * Why a season match is required before processing episodes: episodes are
 * keyed on (series → season → episode), so without a local season row there
 * is no parent for an attach. Skipping the season's episodes is the safe
 * default; the season-level quarantine entry communicates the gap.
 */
async function jellyfinAttachOnlySync(args: {
    sql: postgres.Sql;
    mediaItemId: string;
    children: SeriesChildrenResult;
    /** Jellyfin's series-level external id (used as fallback in season quarantine keys). */
    externalId: string;
    /** Display name from the plugin manifest, used only for progress events. */
    providerLabel: string;
    onProgress?: (event: SyncProgress) => void;
    signal?: AbortSignal;
}): Promise<{
    seasonsMatched: number;
    seasonsQuarantined: number;
    episodesAttached: number;
    episodesQuarantined: number;
    /**
     * Episodes where the (season, episode) position matched a local row, but
     * the Jellyfin payload didn't carry an `externalId` for the episode —
     * so there was nothing to attach. Surfaced separately from
     * episodesQuarantined because this is a provider-data shortfall, not a
     * contamination shape; admins should investigate the upstream Jellyfin
     * configuration rather than triage the local row.
     */
    matchedWithoutId: number;
    /** Episodes where upsertExternalId threw mid-attach (known root cause: CatalogService.withTx bug). */
    episodesAttachFailed: number;
}> {
    const { sql, mediaItemId, children, externalId, onProgress, signal } = args;
    const catalogService = new CatalogService(sql);

    // Guard: if Jellyfin is the only configured metadata provider, attaching
    // episode IDs is meaningless — there are no TMDB-derived rows to attach to.
    // Write a single series-level quarantine entry and return early so we don't
    // flood the table with per-episode noise.
    const nonJellyfinProviders = getProvidersByPriority().filter(
        (p) => p.id !== 'jellyfin-metadata-provider',
    );
    if (nonJellyfinProviders.length === 0) {
        logger.error(
            'Jellyfin is the only configured metadata provider — cannot run attach-only sync without a non-Jellyfin provider',
            undefined,
            { mediaItemId },
        );
        await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId,
            mediaType: 'tv',
            expectedSeriesId: mediaItemId,
            payload: { seriesId: mediaItemId },
            reason: 'Jellyfin is the only configured metadata provider; cannot attach-only without TMDB. Configure TMDB or another non-Jellyfin provider.',
            source: 'jellyfin-attach-only-sync',
        });
        return {
            seasonsMatched: 0,
            seasonsQuarantined: 0,
            episodesAttached: 0,
            episodesQuarantined: 0,
            matchedWithoutId: 0,
            episodesAttachFailed: 0,
        };
    }

    // Look up the series' TMDB id (if any) once — used as `parent_tmdb_id` on
    // every quarantine row so admins can match against the canonical series.
    const tmdbRows = await sql<{ external_id: string }[]>`
        SELECT external_id FROM external_ids
        WHERE media_id = ${mediaItemId}
          AND provider = 'tmdb'
          AND media_type = 'tv'
        LIMIT 1
    `;
    const seriesTmdbId = tmdbRows[0]?.external_id ?? null;

    let seasonsMatched = 0;
    let seasonsQuarantined = 0;
    let episodesAttached = 0;
    let episodesQuarantined = 0;
    let matchedWithoutId = 0;
    let episodesAttachFailed = 0;

    for (const season of children.seasons) {
        if (signal?.aborted) break;

        const localSeasonId = await findSeasonByNumber(sql, mediaItemId, season.seasonNumber);

        if (!localSeasonId) {
            // No TMDB-derived season row exists. Quarantine the season payload
            // and skip its episodes — without a local season parent there is
            // nowhere to attach them. SeasonMetadata has no provider-given
            // season id, so use a synthetic `${seriesId}#${seasonNumber}` key
            // for dedup in the admin UI.
            //
            // TODO(W6): integrity scanner should retroactively fill
            // parent_tmdb_id after series-level TMDB resolution so
            // admins can cross-reference the canonical series.
            await quarantineWrite(sql, {
                provider: 'jellyfin',
                externalId: `${externalId}#${season.seasonNumber}`,
                mediaType: 'season',
                parentTmdbId: seriesTmdbId,
                expectedSeriesId: mediaItemId,
                payload: {
                    seasonNumber: season.seasonNumber,
                    name: season.name,
                    overview: season.overview ?? null,
                    airDate: season.airDate ?? null,
                    episodeCount: season.episodes.length,
                },
                reason: 'No TMDB-derived season row exists for this Jellyfin season',
                source: 'jellyfin-attach-only-sync',
            });
            seasonsQuarantined++;
            continue;
        }

        seasonsMatched++;

        onProgress?.({
            phase: 'season',
            message: `Attaching ${season.name} (${season.episodes.length} episodes)…`,
            seasonsSynced: seasonsMatched,
            episodesSynced: episodesAttached,
            totalSeasons: children.seasons.length,
        });

        for (const episode of season.episodes) {
            if (signal?.aborted) break;

            if (episode.episode == null) {
                logger.warn('Skipping Jellyfin episode with missing episode number', {
                    season: episode.season,
                    title: episode.title,
                });
                continue;
            }

            const localEpisodeId = await findEpisodeByPosition(
                sql,
                mediaItemId,
                episode.season,
                episode.episode,
            );

            if (!localEpisodeId) {
                // Foreign-shaped episode: position has no TMDB-derived row.
                // Most common case is the contamination shape (Office AU's
                // German Jellyfin returning UK episodes for the same SeriesId).
                //
                // TODO(W6): integrity scanner should retroactively fill
                // parent_tmdb_id after series-level TMDB resolution so
                // admins can cross-reference the canonical series.
                await quarantineWrite(sql, {
                    provider: 'jellyfin',
                    externalId:
                        episode.externalId ?? `${externalId}#S${episode.season}E${episode.episode}`,
                    mediaType: 'episode',
                    parentTmdbId: seriesTmdbId,
                    expectedSeriesId: mediaItemId,
                    payload: {
                        seasonNumber: episode.season,
                        episodeNumber: episode.episode,
                        title: episode.title ?? null,
                        overview: episode.overview ?? null,
                        airDate: episode.airDate ?? null,
                        runtime: episode.runtime ?? null,
                        jellyfinExternalId: episode.externalId ?? null,
                    },
                    reason: `No TMDB-derived episode row exists for season ${episode.season} episode ${episode.episode}`,
                    source: 'jellyfin-attach-only-sync',
                });
                episodesQuarantined++;
                continue;
            }

            // Match found, but the Jellyfin payload didn't carry an
            // external_id for the episode — there is nothing to attach.
            // Surface this as a separate counter (matchedWithoutId) rather
            // than silently skipping; the position matched a real local row
            // so quarantining is wrong, but the operator should see the
            // upstream Jellyfin data shortfall in the run summary.
            if (!episode.externalId) {
                matchedWithoutId++;
                logger.warn('Matched episode but provider returned no external_id', {
                    mediaItemId,
                    localEpisodeId,
                    seasonNumber: episode.season,
                    episodeNumber: episode.episode,
                });
                continue;
            }

            // Match found: attach the Jellyfin external_id to the existing
            // TMDB-derived episode row. Not primary — TMDB stays primary.
            const episodeExtId: ExternalIdWrite = {
                provider: 'jellyfin',
                id: episode.externalId,
                mediaType: 'episode',
                source: 'jellyfin-attach-only-sync',
            };

            // Wrap upsertExternalId in its own try/catch so an attach
            // failure does NOT inhibit progress on the rest of the season.
            // Counted as attached only when the upsert succeeds.
            let attached = false;
            try {
                await catalogService.upsertExternalId(localEpisodeId, episodeExtId, false);
                episodesAttached++;
                attached = true;
            } catch (err) {
                // Each warn here = one episode permanently un-identified
                // (no retry path other than a full rescan). Known to be the
                // root cause of the ~41k jellyfin-only episode_ids in preprod
                // (memory: bug_catalog_withTx_reserved_sql). Use a structured
                // tag so a future bulk-recovery script can grep + re-attach.
                episodesAttachFailed++;
                logger.error(
                    'JELLYFIN_EPISODE_ATTACH_FAILED: upsertExternalId threw mid-attach',
                    err instanceof Error ? err : new Error(String(err)),
                    {
                        tag: 'JELLYFIN_EPISODE_ATTACH_FAILED',
                        episodeExternalId: episode.externalId,
                        localEpisodeId,
                    },
                );
            }

            // Resolve any prior quarantine entry only if the attach
            // succeeded. Wrap separately so a quarantine-resolve failure
            // doesn't undo the attach counter — the attach DID succeed
            // and the row now has the Jellyfin id, so reporting it as
            // "not attached" because the bookkeeping cleanup failed
            // would mislead the admin UI.
            if (attached) {
                try {
                    await resolveByExternalKey(
                        sql,
                        {
                            provider: 'jellyfin',
                            externalId: episode.externalId,
                            mediaType: 'episode',
                        },
                        'auto:jellyfin-attach-only-sync',
                        'reattached',
                    );
                } catch (err) {
                    logger.warn('Failed to resolve prior quarantine entry after attach', {
                        episodeExternalId: episode.externalId,
                        localEpisodeId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        }
    }

    logger.info('Jellyfin attach-only sync complete', {
        mediaItemId,
        seasonsMatched,
        seasonsQuarantined,
        episodesAttached,
        episodesQuarantined,
        matchedWithoutId,
        episodesAttachFailed,
    });

    return {
        seasonsMatched,
        seasonsQuarantined,
        episodesAttached,
        episodesQuarantined,
        matchedWithoutId,
        episodesAttachFailed,
    };
}

/**
 * Find an existing child media_item by parent + type + season/episode number,
 * or create a new one.
 *
 * On conflict, preserves user-edited fields when the existing child is
 * locked (`metadata_locked = true`) and options.force is false. The lock
 * itself is never modified here — unlock is always an explicit user action.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE (upsert) backed by unique partial
 * indexes (migration 11.36.0) so concurrent sync jobs converge on the same
 * row instead of racing to create duplicates.
 *
 * With `createMissing = false` (series is not owned, see `isOwnedSeries`) no
 * row is ever INSERTed: an existing child is updated, a missing one returns
 * null.
 *
 * Returns `{ id, created }`. `created` is true only when the row was newly
 * INSERTed (detected via Postgres' `xmax = 0` trick). Callers use this to
 * fire `MediaLifecycleService.afterCreated` for fresh episodes/seasons so
 * stage-state coverage is seeded immediately instead of waiting up to 60s
 * for the stage-sweep self-heal pass.
 */
async function findOrCreateChild(
    sql: postgres.Sql,
    params: {
        parentId: string;
        mediaType: 'season' | 'episode';
        seasonNumber: number;
        episodeNumber?: number;
        title: string;
        overview: string | null;
        premiereDate: string | null;
        runtimeSeconds?: number | null;
        sortOrder: number;
    },
    options: SyncOptions,
    createMissing: boolean,
): Promise<{ id: string; created: boolean } | null> {
    // Update-only mode (un-owned series): never INSERT. A single UPDATE
    // (falling back to a plain SELECT of the id when the lock guard skipped
    // the write) keeps this atomic: a child deleted concurrently yields null
    // instead of being re-created as a skeleton row or hitting an FK error.
    if (!createMissing) {
        const [row] = isSeason(params.mediaType)
            ? await sql<Array<{ id: string }>>`
                WITH upd AS (
                    UPDATE media_items SET
                        title         = ${params.title},
                        overview      = ${params.overview},
                        premiere_date = ${params.premiereDate},
                        sort_order    = ${params.sortOrder},
                        updated_at    = NOW()
                    WHERE media_type = 'season' AND parent_id = ${params.parentId}
                        AND season_number = ${params.seasonNumber}
                        AND (${options.force && !options.respectLocks} OR NOT metadata_locked)
                    RETURNING id
                )
                SELECT id FROM upd
                UNION ALL
                SELECT id FROM media_items
                WHERE media_type = 'season' AND parent_id = ${params.parentId}
                    AND season_number = ${params.seasonNumber}
                    AND NOT EXISTS (SELECT 1 FROM upd)
                LIMIT 1
            `
            : await sql<Array<{ id: string }>>`
                WITH upd AS (
                    UPDATE media_items SET
                        title           = ${params.title},
                        overview        = ${params.overview},
                        premiere_date   = ${params.premiereDate},
                        runtime_seconds = ${params.runtimeSeconds ?? null},
                        sort_order      = COALESCE(sort_order, ${params.sortOrder}),
                        updated_at      = NOW()
                    WHERE media_type = 'episode' AND parent_id = ${params.parentId}
                        AND season_number = ${params.seasonNumber}
                        AND episode_number = ${params.episodeNumber ?? 0}
                        AND (${options.force && !options.respectLocks} OR NOT metadata_locked)
                    RETURNING id
                )
                SELECT id FROM upd
                UNION ALL
                SELECT id FROM media_items
                WHERE media_type = 'episode' AND parent_id = ${params.parentId}
                    AND season_number = ${params.seasonNumber}
                    AND episode_number = ${params.episodeNumber ?? 0}
                    AND NOT EXISTS (SELECT 1 FROM upd)
                LIMIT 1
            `;
        if (row) await refreshSortTitles(sql, [row.id]);
        return row ? { id: row.id, created: false } : null;
    }

    // The upsert uses `DO UPDATE ... WHERE (force OR NOT metadata_locked)`
    // instead of `CASE WHEN ... ELSE col END` on each column. With the
    // CASE form, locked rows still get rewritten to identical values, which
    // bumps xmin and produces dead tuples on every sync — real MVCC churn
    // on large series. With the WHERE form, locked rows are skipped
    // outright, so no row version is created.
    //
    // Tradeoff: when the WHERE predicate is false, the UPDATE doesn't fire
    // and RETURNING yields nothing. We fall back to a plain SELECT through
    // the CTE `coalesce` step to recover the existing row's id.
    // `(xmax = 0)` is true only for rows that were newly INSERTed in this
    // statement. For DO UPDATE hits (existing row updated) xmax carries the
    // transaction's xid, so the comparison is false. The fallback SELECT
    // branch returns false explicitly (existing row, no write).
    if (isSeason(params.mediaType)) {
        const [row] = await sql<Array<{ id: string; created: boolean }>>`
            WITH upsert AS (
                INSERT INTO media_items (
                    title, media_type, parent_id, season_number,
                    overview, premiere_date, sort_order
                )
                VALUES (
                    ${params.title}, 'season', ${params.parentId}, ${params.seasonNumber},
                    ${params.overview}, ${params.premiereDate}, ${params.sortOrder}
                )
                ON CONFLICT (parent_id, season_number)
                    WHERE media_type = 'season' AND parent_id IS NOT NULL AND season_number IS NOT NULL
                DO UPDATE SET
                    title         = EXCLUDED.title,
                    overview      = EXCLUDED.overview,
                    premiere_date = EXCLUDED.premiere_date,
                    sort_order    = EXCLUDED.sort_order,
                    updated_at    = NOW()
                WHERE ${options.force && !options.respectLocks} OR NOT media_items.metadata_locked
                RETURNING id, (xmax = 0) AS created
            )
            SELECT id, created FROM upsert
            UNION ALL
            SELECT id, FALSE AS created FROM media_items
            WHERE media_type = 'season'
                AND parent_id = ${params.parentId}
                AND season_number = ${params.seasonNumber}
                AND NOT EXISTS (SELECT 1 FROM upsert)
            LIMIT 1
        `;
        if (!row) {
            // CTE contract guarantees one branch returns a row: the upsert
            // hits the unique index (inserts or returns via DO UPDATE) OR
            // the fallback SELECT finds the pre-existing row. A zero-row
            // result means a concurrent hard-delete slipped between them,
            // or the unique partial index is missing (migration drift).
            throw new Error(
                `findOrCreateChild: no row returned for season ` +
                    `(parentId=${params.parentId}, season=${params.seasonNumber})`,
            );
        }
        await refreshSortTitles(sql, [row.id]);
        return { id: row.id, created: row.created };
    }

    const [row] = await sql<Array<{ id: string; created: boolean }>>`
        WITH upsert AS (
            INSERT INTO media_items (
                title, media_type, parent_id, season_number,
                episode_number, runtime_seconds,
                overview, premiere_date, sort_order
            )
            VALUES (
                ${params.title}, 'episode', ${params.parentId}, ${params.seasonNumber},
                ${params.episodeNumber ?? 0}, ${params.runtimeSeconds ?? null},
                ${params.overview}, ${params.premiereDate}, ${params.sortOrder}
            )
            ON CONFLICT (parent_id, season_number, episode_number)
                WHERE media_type = 'episode' AND parent_id IS NOT NULL AND season_number IS NOT NULL AND episode_number IS NOT NULL
            DO UPDATE SET
                title           = EXCLUDED.title,
                overview        = EXCLUDED.overview,
                premiere_date   = EXCLUDED.premiere_date,
                runtime_seconds = EXCLUDED.runtime_seconds,
                sort_order      = COALESCE(media_items.sort_order, EXCLUDED.sort_order),
                updated_at      = NOW()
            WHERE ${options.force && !options.respectLocks} OR NOT media_items.metadata_locked
            RETURNING id, (xmax = 0) AS created
        )
        SELECT id, created FROM upsert
        UNION ALL
        SELECT id, FALSE AS created FROM media_items
        WHERE media_type = 'episode'
            AND parent_id = ${params.parentId}
            AND season_number = ${params.seasonNumber}
            AND episode_number = ${params.episodeNumber ?? 0}
            AND NOT EXISTS (SELECT 1 FROM upsert)
        LIMIT 1
    `;
    if (!row) {
        throw new Error(
            `findOrCreateChild: no row returned for episode ` +
                `(parentId=${params.parentId}, season=${params.seasonNumber}, ` +
                `episode=${params.episodeNumber ?? 0})`,
        );
    }
    await refreshSortTitles(sql, [row.id]);
    return { id: row.id, created: row.created };
}

/** One episode to upsert under a single season's parent_id. */
interface EpisodeUpsertInput {
    seasonNumber: number;
    episodeNumber: number;
    title: string;
    overview: string | null;
    premiereDate: string | null;
    runtimeSeconds: number | null;
    sortOrder: number;
}

/** Resolved id + creation flag for one upserted episode, keyed by its position. */
interface EpisodeUpsertResult {
    episodeNumber: number;
    id: string;
    created: boolean;
}

/**
 * Batched episode upsert (SQL-C3).
 *
 * Replaces the per-episode `findOrCreateChild` round-trip inside a season with
 * a single multi-row `INSERT ... ON CONFLICT DO UPDATE` driven by `unnest`.
 * On large series this collapses O(seasons×episodes) sequential statements into
 * O(seasons) statements.
 *
 * Semantics match the single-row episode branch of `findOrCreateChild` exactly:
 *  - `ON CONFLICT (parent_id, season_number, episode_number) DO UPDATE` with the
 *    same column set and the `force OR NOT metadata_locked` guard, so locked
 *    rows are skipped (no dead-tuple churn) rather than rewritten.
 *  - `created` is `(xmax = 0)` — true only for rows newly INSERTed by this
 *    statement.
 *  - Locked rows whose `DO UPDATE` predicate is false produce no RETURNING row;
 *    a fallback LEFT JOIN against the input set recovers their existing id with
 *    `created = false`, mirroring the UNION-ALL fallback SELECT in the single
 *    helper. A missing id (concurrent hard-delete or missing partial index)
 *    throws, same as the single-row contract.
 *
 * All input episodes share one `parentId` (the season row), so the natural key
 * collapses to `episode_number` for result mapping.
 */
async function batchFindOrCreateEpisodes(
    sql: postgres.Sql,
    parentId: string,
    episodes: EpisodeUpsertInput[],
    options: SyncOptions,
    createMissing: boolean,
): Promise<Array<EpisodeUpsertResult | null>> {
    if (episodes.length === 0) return [];

    // Update-only mode (un-owned series): never INSERT. One UPDATE ... FROM
    // unnest per season updates rows that still exist; episodes without a row
    // (never created, or deleted concurrently) are reported as null so callers
    // keep positional alignment. Locked rows skipped by the guard are
    // recovered by a plain SELECT of their id.
    if (!createMissing) {
        const rows = await sql<
            Array<{ season_number: number; episode_number: number; id: string }>
        >`
            WITH input AS (
                SELECT * FROM unnest(
                    ${sql.array(episodes.map((e) => e.seasonNumber))}::int[],
                    ${sql.array(episodes.map((e) => e.episodeNumber))}::int[],
                    ${sql.array(episodes.map((e) => e.title))}::text[],
                    ${sql.array(episodes.map((e) => e.overview))}::text[],
                    ${sql.array(episodes.map((e) => e.premiereDate))}::date[],
                    ${sql.array(episodes.map((e) => e.runtimeSeconds))}::int[],
                    ${sql.array(episodes.map((e) => e.sortOrder))}::int[]
                ) AS t(season_number, episode_number, title, overview, premiere_date, runtime_seconds, sort_order)
            ),
            upd AS (
                UPDATE media_items mi SET
                    title           = input.title,
                    overview        = input.overview,
                    premiere_date   = input.premiere_date,
                    runtime_seconds = input.runtime_seconds,
                    sort_order      = COALESCE(mi.sort_order, input.sort_order),
                    updated_at      = NOW()
                FROM input
                WHERE mi.media_type = 'episode' AND mi.parent_id = ${parentId}
                    AND mi.season_number = input.season_number
                    AND mi.episode_number = input.episode_number
                    AND (${options.force && !options.respectLocks} OR NOT mi.metadata_locked)
                RETURNING mi.season_number, mi.episode_number, mi.id
            )
            SELECT season_number, episode_number, id FROM upd
            UNION ALL
            SELECT mi.season_number, mi.episode_number, mi.id
            FROM input
            JOIN media_items mi
                ON mi.media_type = 'episode' AND mi.parent_id = ${parentId}
                AND mi.season_number = input.season_number
                AND mi.episode_number = input.episode_number
            WHERE NOT EXISTS (
                SELECT 1 FROM upd
                WHERE upd.season_number = input.season_number
                    AND upd.episode_number = input.episode_number
            )
        `;
        await refreshSortTitles(
            sql,
            rows.map((r) => r.id),
        );
        const byKey = new Map(rows.map((r) => [`${r.season_number}:${r.episode_number}`, r.id]));
        return episodes.map((e) => {
            const id = byKey.get(`${e.seasonNumber}:${e.episodeNumber}`);
            return id ? { episodeNumber: e.episodeNumber, id, created: false } : null;
        });
    }
    const toUpsert = episodes;
    const upserted = new Set(toUpsert);

    const seasonNumbers = toUpsert.map((e) => e.seasonNumber);
    const episodeNumbers = toUpsert.map((e) => e.episodeNumber);
    const titles = toUpsert.map((e) => e.title);
    const overviews = toUpsert.map((e) => e.overview);
    const premiereDates = toUpsert.map((e) => e.premiereDate);
    const runtimeSecondsList = toUpsert.map((e) => e.runtimeSeconds);
    const sortOrders = toUpsert.map((e) => e.sortOrder);

    const rows = await sql<Array<{ episode_number: number; id: string; created: boolean }>>`
        WITH input AS (
            SELECT * FROM unnest(
                ${sql.array(seasonNumbers)}::int[],
                ${sql.array(episodeNumbers)}::int[],
                ${sql.array(titles)}::text[],
                ${sql.array(overviews)}::text[],
                ${sql.array(premiereDates)}::date[],
                ${sql.array(runtimeSecondsList)}::int[],
                ${sql.array(sortOrders)}::int[]
            ) AS t(season_number, episode_number, title, overview, premiere_date, runtime_seconds, sort_order)
        ),
        upsert AS (
            INSERT INTO media_items (
                title, media_type, parent_id, season_number,
                episode_number, runtime_seconds,
                overview, premiere_date, sort_order
            )
            SELECT
                input.title, 'episode', ${parentId}, input.season_number,
                input.episode_number, input.runtime_seconds,
                input.overview, input.premiere_date, input.sort_order
            FROM input
            ON CONFLICT (parent_id, season_number, episode_number)
                WHERE media_type = 'episode' AND parent_id IS NOT NULL AND season_number IS NOT NULL AND episode_number IS NOT NULL
            DO UPDATE SET
                title           = EXCLUDED.title,
                overview        = EXCLUDED.overview,
                premiere_date   = EXCLUDED.premiere_date,
                runtime_seconds = EXCLUDED.runtime_seconds,
                sort_order      = COALESCE(media_items.sort_order, EXCLUDED.sort_order),
                updated_at      = NOW()
            WHERE ${options.force && !options.respectLocks} OR NOT media_items.metadata_locked
            RETURNING episode_number, id, (xmax = 0) AS created
        )
        SELECT episode_number, id, created FROM upsert
        UNION ALL
        SELECT input.episode_number, mi.id, FALSE AS created
        FROM input
        JOIN media_items mi
            ON mi.media_type = 'episode'
            AND mi.parent_id = ${parentId}
            AND mi.season_number = input.season_number
            AND mi.episode_number = input.episode_number
        WHERE NOT EXISTS (
            SELECT 1 FROM upsert WHERE upsert.episode_number = input.episode_number
        )
    `;

    await refreshSortTitles(
        sql,
        rows.map((r) => r.id),
    );
    const byEpisode = new Map<number, EpisodeUpsertResult>();
    for (const row of rows) {
        byEpisode.set(row.episode_number, {
            episodeNumber: row.episode_number,
            id: row.id,
            created: row.created,
        });
    }

    return episodes.map((episode) => {
        if (!upserted.has(episode)) return null;
        const result = byEpisode.get(episode.episodeNumber);
        if (!result) {
            // CTE contract guarantees one branch returns a row per input
            // episode: the upsert hits the unique index OR the fallback JOIN
            // finds the pre-existing row. A miss means a concurrent hard-delete
            // slipped in, or the unique partial index is missing (migration
            // drift) — same failure mode as the single-row helper.
            throw new Error(
                `batchFindOrCreateEpisodes: no row returned for episode ` +
                    `(parentId=${parentId}, season=${episode.seasonNumber}, ` +
                    `episode=${episode.episodeNumber})`,
            );
        }
        return result;
    });
}
