// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video file processing for the file scanner.
 *
 * Handles matching, hierarchy creation, version/edition linking, and change
 * detection for non-audio media files.  The single public export is
 * `processVideoFile` (renamed from the former inline `processFile`).
 */

import { queueRecencyRefresh } from './watcher-recency.js';
import {
    withVerifiedSeriesFolderOwner,
    withSeriesFolderLock,
    currentSeriesFolderOwnerId,
    type FolderSeriesEvidence,
} from './series-folder-owner.js';
import path from 'node:path';
import type postgres from 'postgres';
import type { PluginContext } from '../../../../../../plugins/types/base-plugin.js';
import type { FileScannerContext } from './shared.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import type { MetadataCandidate, MediaMetadata } from '../../../../../../providers/types.js';
import { invokeProviderDetail, isProviderConfigured } from '$lib/server/tasks/plugin-context.js';
import { normalizeDetail } from '$lib/server/providers/normalize.js';
import { encodeDetailId } from '$lib/server/providers/encode-id.js';
import { tmdbResolveExternalId } from '$lib/server/providers/implementations/tmdb/resolve-external.js';
import {
    parseMediaFilename,
    editionCanonicalToDisplayName,
    seriesYearHint,
} from '../../../../../../utils/filename-parser.js';
import {
    isNonEntertainment,
    isEpisode,
    NON_ENTERTAINMENT_LIBRARY_TYPES,
} from '$lib/server/utils/media-types.js';
import {
    isManuallyLinkedFile,
    refreshSegmentsForFile,
} from '$lib/server/database/queries/file-segments.queries.js';
import {
    hasManualLinkSets,
    restoreManualLinksForNewFile,
    revalidateManualLinksAfterContentChange,
} from '$lib/server/services/manual-file-links.service.js';
import { refreshSortTitles } from '$lib/server/database/queries/sort-title.queries.js';
import { applyNationalAgeRating } from '$lib/server/database/queries/age-rating-source.queries.js';
import {
    getLibraryTypeTemplate,
    type FolderParseRule,
} from '$lib/shared/library-type-templates.js';
import { resolveExternalIdToUuid } from '../../../../../../database/queries/media-lookup.queries.js';
import type { ExternalIdProvider } from '../../../../../../utils/provider-config.js';
import {
    insertScannedMediaItem,
    findPersonalMediaItemByTitleYear,
    normalizeTitleForVersionDedupe,
    findAdoptableDiscoveryRowByTitle,
    backfillLocalMediaContent,
    applyLocalNfoDisplayMetadata,
    type LocalNfoContent,
    findLocalContentGapMovieByFile,
    getMediaItemTypeTitleYear,
    findOrCreatePersonalSeason,
    findOrCreatePersonalEpisode,
    getNextEpisodeNumber,
    seasonHasCanonicalEpisodes,
    listCanonicalEpisodeTitles,
    findCanonicalEpisodesByAirDate,
    seriesHasCanonicalEpisodes,
    findOrCreateSeries,
    renamePersonalSeries,
    setRuntimeSecondsIfNull,
    backfillLibraryGroupIdIfNull,
} from '../../../../../../database/queries/media-items.queries.js';
import {
    upsertMediaFile,
    listDirectChildMediaFilePaths,
    setAbsoluteEpisodeIfChanged,
    attachFileToItem,
    touchLibraryAddedAt,
    isFileLinkedToMediaItem,
    getLinkedEpisodeNumbersForFile,
    detachAndClearAwaitingMatchForFile,
    findAwaitingMatchItemIdsForFile,
    findSeriesForInPlaceRematch,
    seriesHoldsExternalId,
    markEpisodesAwaitingProviderMatch,
    clearAwaitingMatchFlag,
    findAllLinkedMediaItemsByFilePath,
    findParentMediaItemByFolder,
    findMediaItemByFilePath,
    getFilesForMediaItem,
    findMediaFileByPath,
    updateFileStat,
    updateScannedPhysicalMetadata,
    mediaItemHasFile,
    linkFileAsVersion,
    recordFileScanIssue,
    clearFileScanIssue,
    clearRangeSupersededIfLinked,
    getFileScanRetryAt,
    type KnownFileRow,
} from '../../../../../../database/queries/media-files.queries.js';
import {
    claimPersonalMediaRematch,
    isPersonalMediaKept,
} from '../../../../../../database/queries/unmatched-files.queries.js';
import { peekScanProbe } from '$lib/server/utils/scan-probe-cache.js';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import { isMangledFilename } from './mangled-filename.js';
import { hasControlChars } from './filename-safety.js';
import { createCatalogService } from '../../../../../../services/catalog.service.js';
import { matchFileToMetadata } from '../../../../../../services/metadata-matching.service.js';
import { readScanChapters, storeScanChapters } from './scan-chapters.js';
import { resolveMediaPath } from '../../../../../../utils/media-path-resolver.js';
import { loadKnownFileChapters } from '../../../../../../database/queries/episode-chapters.queries.js';
import { readNfoForVideo } from '../../../../../../utils/nfo-parser.js';
import { pickCertificationForCountry } from '../../../../../../utils/certification-country.js';
import { isAudioFile } from '../../../../../../utils/walk-directory.js';
import {
    deleteStaleMediaFile,
    keepProbedFileStat,
} from '../../../../../../database/queries/media-files.queries.js';
import { withTx } from '../../../../../../database/with-tx.js';
import {
    findDedicatedFileForEpisodeNumber,
    findDedicatedEpisodeFile,
    isDedicatedEpisodeFile,
    findSeasonIdForLinkedFile,
    findUnsegmentedLinkEpisodesForFile,
    evictRangeLinksSupersededByDedicatedFile,
    recordStubIfRangeFullySuperseded,
    withEpisodeLinkLock,
    type DedicatedEpisodeFile,
} from './multi-episode-links.js';
import { assessFilePresence } from '../../../../../../utils/file-presence.js';
import { backfillSiblingParts, confirmStackedPart } from './stacked-parts.js';
import { MediaLifecycleService } from '../../../../../../services/media-lifecycle.service.js';
import {
    restoreScannedFile,
    toDbMediaType,
    initFileChangeDetection,
    tryHashFileHead,
    episodeTitleFromPath,
    extractSeriesTitleFromPath,
    extractSeasonNumberFromPath,
    resolveSeasonNumber,
    recordScanIssueWithCooldown,
    applyContentChange,
    probeNewFileForScan,
    clearStaleRefusalAndEnsureChangeDetection,
    noteMetadataUnavailable,
    filesAllMissingFromLibrary,
} from './shared.js';
import { detectFileChanges } from './change-detection.js';
import { processAudioFile } from './audio-processor.js';
import { isMusic, isMovie } from '$lib/server/utils/media-types.js';
import { toProviderMediaType } from '$lib/shared/media-type-domain';
import { normalizeJellyfinId } from '../../../../../../utils/jellyfin-id.js';
import { extractSeriesYearFromPath } from '$lib/server/utils/path-parsing.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { isExtrasFilePath } from '$lib/server/utils/media-extras.js';
import {
    matchEpisodeByTitle,
    type EpisodeTitleCandidate,
} from '$lib/server/utils/episode-title-match.js';
import { config } from '$lib/server/config.js';
import { effectiveAgeRatingCountry } from '$lib/server/utils/age-rating-country.js';
import { pickAirDateEpisode } from '$lib/server/utils/air-date-episode.js';
import { hashFileHead } from '$lib/server/utils/file-hash.js';
import {
    findReclaimableByHash,
    deferHashReclaim,
    clearHashReclaimDeferral,
    findActiveItemByLiveHeadHash,
    findPersonalSeriesOfEpisode,
    listSeriesFilePaths,
    undismissMediaItem,
} from '../../../../../../database/queries/file-rematch.queries.js';
import type { ReclaimCandidate } from '../../../../../../database/queries/file-rematch.queries.js';

// ---------------------------------------------------------------------------
// TMDB search result cache (per-scan, per-library-path)
//
// A TV library with N episodes of the same series makes N identical TMDB
// search calls. This Map collapses them to one. The value is:
//   { candidate, matchedProviderId } — a positive hit to reuse
//   null                             — a definitive miss (no match found)
//
// The caller (file-scanner.ts) creates one Map per library path and passes
// it in; clearing between paths ensures stale results from a different
// library root don't cross-contaminate.
// ---------------------------------------------------------------------------

export interface MetadataSearchCacheHit {
    candidate: MetadataCandidate;
    matchedProviderId: string;
}

/** An in-process Map keyed by `${providerId}:${type}:${title}:${year}`. */
export type MetadataSearchCache = Map<string, MetadataSearchCacheHit | null>;

// ---------------------------------------------------------------------------
// S5 — Series + season UUID caches (per-scan, per-library-path)
//
// findOrCreateSeries + findOrCreatePersonalSeason run under pg_advisory_xact_lock.
// On a 500-series × 130-episode library that is ~390k advisory locks on MISSes
// (first-seen episodes) even after the lock would be a no-op (series exists).
// Caching the returned UUID on HIT lets subsequent episodes of the same series
// skip both the SELECT and the lock. MISS still fires the full path so the lock
// still guards concurrent creation.
//
// Keys:
//   seriesCache: serialized title/year/namespace and supported evidence → seriesId
//   seasonCache: `${seriesId}:${seasonNumber}`     → seasonId
//
// Both caches have per-path lifetime (cleared between library paths) and are
// populated from the function's return value only — never from a pre-check.
// ---------------------------------------------------------------------------

/**
 * Keyed by a JSON tuple of lowercased title, series media type, year (or null),
 * and candidate identity [provider, external ID, provider media type] (or null
 * for title-only inputs), IMDb ID and sorted supported cross-provider evidence.
 * Value = series media_item UUID.
 */
export type SeriesIdCache = Map<string, string>;

/** Identity writes are serialized by UUID; only successful mappings are cached. */
export interface SeriesIdentityWriteState {
    completed: Set<string>;
    pending: Map<string, Promise<void>>;
}

/**
 * The file's identity evidence contradicts itself or the catalog. The file is
 * not linked (it would land on the wrong item); processVideoFile records it as
 * a scan issue of `issueType` so it shows on the Ingest Map.
 */
class IdentityConflictError extends Error {
    constructor(
        message: string,
        readonly issueType: 'series_identity_conflict' | 'movie_identity_conflict',
    ) {
        super(message);
    }
}

/** A series' evidence conflicts: see {@link IdentityConflictError}. */
class SeriesIdentityConflictError extends IdentityConflictError {
    constructor(message: string) {
        super(message, 'series_identity_conflict');
    }
}

function describeEvidence(evidence: [string, string][]): string {
    return evidence.map(([provider, id]) => `${provider} ${id}`).join(', ');
}
const scanInlineEnrichment = new WeakMap<SeriesIdentityWriteState, Set<string>>();

const scanIdentityWrites = new WeakMap<Set<string>, SeriesIdentityWriteState>();

function identityWriteState(announcements?: Set<string>): SeriesIdentityWriteState {
    let state = announcements ? scanIdentityWrites.get(announcements) : undefined;
    if (!state) {
        state = { completed: new Set(), pending: new Map() };
        if (announcements) scanIdentityWrites.set(announcements, state);
    }
    return state;
}

const seriesCrossProviders: ExternalIdProvider[] = ['tmdb', 'imdb', 'tvdb', 'trakt', 'mal'];
/** Keyed `${seriesId}:${seasonNumber}`. Value = season media_item UUID. */
export type SeasonIdCache = Map<string, string>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a stable cache key for a TMDB/provider title search.
 *
 * For TV the search query is the folder-derived series title (not the
 * filename-episode title) and the folder year that scores its results, so
 * "Scrubs (2001)" and "Scrubs (2026)" never share a result. For movies it's
 * the parsed filename title + year.
 * Replicates the logic inside matchFileToMetadata so the key matches what
 * would actually be searched.
 */
function buildSearchCacheKey(
    providerId: string,
    filePath: string,
    libraryPath: LibraryPathRow,
): string {
    const parsed = parseMediaFilename(filePath);
    if (isMovie(libraryPath.media_type)) {
        return `${providerId}:movie:${parsed.title}:${parsed.year ?? ''}`;
    }
    const seriesTitle = extractSeriesTitleFromPath(filePath, libraryPath.path, parsed.title);
    const seriesYear = extractSeriesYearFromPath(filePath, libraryPath.path);
    return `${providerId}:tv:${seriesTitle}:${seriesYear ?? ''}`;
}

/** What one episode's link decision under its lock produced. */
type EpisodeLinkResult =
    | {
          kind: 'yielded';
          /** The dedicated file that took the episode. */
          dedicated: DedicatedEpisodeFile;
          evicted: string[];
      }
    | {
          kind: 'linked';
          episodeId: string;
          episodeCreated: boolean;
          fileId: string;
          fileCreated: boolean;
          evicted: string[];
      };

/**
 * A range file yields episode `episodeNumber` to `dedicated`: any range link
 * the episode already holds goes too, under the episode's lock. That is the
 * repair for a double link left by an older scan or by the race this lock
 * closes. Returns the evicted range files for logging.
 */
async function yieldEpisodeToDedicatedFile(
    sql: postgres.Sql,
    seasonId: string,
    episodeNumber: number,
    dedicated: DedicatedEpisodeFile,
): Promise<string[]> {
    return withEpisodeLinkLock(sql, seasonId, episodeNumber, (tx) =>
        evictRangeLinksSupersededByDedicatedFile(
            tx,
            dedicated.episodeId,
            episodeNumber,
            dedicated.fileId,
            dedicated.filePath,
        ),
    );
}

/**
 * Record the stub of every evicted range file that its eviction left with no
 * link (see recordStubIfRangeFullySuperseded). Call it only after the lock
 * transaction that evicted has committed. `skipPath` is the file being scanned:
 * its own fully-superseded branch records its stub.
 */
async function recordEvictedRangeStubs(
    sql: postgres.Sql,
    seasonId: string,
    libraryGroupId: string | null,
    evicted: readonly string[],
    skipPath?: string,
    signal?: AbortSignal,
): Promise<void> {
    for (const rangePath of evicted) {
        if (rangePath === skipPath) continue;
        await recordStubIfRangeFullySuperseded(sql, rangePath, seasonId, libraryGroupId, signal);
    }
}

function logEvictedRangeLinks(
    context: FileScannerContext,
    filePath: string,
    episodeNumber: number,
    seasonNumber: number,
    evicted: readonly string[],
): void {
    if (evicted.length === 0) return;
    context.logger.info(
        '[FileScanner] Evicted multi-episode range links superseded by dedicated file',
        {
            filePath,
            episodeNumber,
            seasonNumber,
            evicted,
        },
    );
}

/**
 * Attach a file to a media item and stamp library_added_at on the item and its
 * ancestors. Wraps attachFileToItem so all new-file code paths update the
 * timestamp in one place.
 */
async function attachFile(sql: postgres.Sql, fileId: string, mediaItemId: string): Promise<void> {
    await attachFileToItem(sql, fileId, mediaItemId);
    await touchLibraryAddedAt(sql, mediaItemId, config.RECENTLY_ADDED_PROPAGATE_TO_SERIES);
}

/**
 * Extract metadata from folder structure using library type template rules.
 */
function extractFolderMetadata(
    filePath: string,
    libraryRoot: string,
    rules: FolderParseRule[],
): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    const relativePath = filePath.replace(libraryRoot, '').replace(/^\//, '');
    const segments = relativePath.split('/').slice(0, -1); // exclude filename

    for (const rule of rules) {
        const segment = segments[rule.depth - 1];
        if (!segment) continue;

        if (rule.extractYear) {
            const yearMatch = segment.match(/\b(19|20)\d{2}\b/);
            if (yearMatch) {
                metadata[rule.metadataKey] = yearMatch[0];
                continue;
            }
        }
        metadata[rule.metadataKey] = segment;
    }

    return metadata;
}

/**
 * Order-independent rename reclaim for non-entertainment media (rename-race
 * fix #4). Mirror of the audio fallback in audio-processor.ts.
 *
 * Personal/home-video items have no external-id net and no dismissed-hash
 * snapshot in the add-before-unlink rename ordering (the old item is still
 * active, undismissed). Match the still-active old item by its LIVE
 * media_files head hash instead, scoped to the non-entertainment library
 * media types so provider movies/TV are never hash-merged.
 *
 * Returns the reclaimed media_item_id, or null when no live-hash match
 * exists (caller falls through to the normal mint path).
 */
async function tryReclaimNonEntertainmentByLiveHash(
    sql: postgres.Sql,
    filePath: string,
    parsed: { edition?: string; part?: number },
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
): Promise<string | null> {
    let contentHash: string;
    try {
        contentHash = await hashFileHead(filePath);
    } catch (err) {
        context.logger.debug(
            '[FileScanner] Live-hash reclaim: head hash failed; skipping reclaim',
            {
                filePath,
                error: err instanceof Error ? err.message : String(err),
            },
        );
        return null;
    }

    const match = await findActiveItemByLiveHeadHash(sql, contentHash, [
        ...NON_ENTERTAINMENT_LIBRARY_TYPES,
    ]);
    if (!match) return null;

    // Same reattach block as tryReclaimByHash: link the renamed file to the
    // original media_item and stamp the head hash on the new file row.
    // undismissMediaItem is a no-op here (the matched row is active), kept
    // for symmetry with the dismissed-snapshot path.
    let aborted = false;
    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // Finding-3 guard: findActiveItemByLiveHeadHash matched a single-file
        // item OUTSIDE any lock. Two concurrent copies of the same file could
        // both pass that count==1 check and both attach, inflating the item to
        // 3+ files. Re-verify the single-file invariant under the same advisory
        // lock attachFileToItem uses; back off if another reclaim already
        // attached, so this copy mints a distinct item.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${match.media_item_id}))`;
        const rows = await tx<{ count: string }[]>`
            SELECT count(*)::text AS count
              FROM media_file_items WHERE media_item_id = ${match.media_item_id}
        `;
        if (parseInt(rows[0]?.count ?? '0', 10) !== 1) {
            aborted = true;
            return;
        }
        const { id: fileId } = await upsertMediaFile(tx, {
            filePath,
            edition: parsed.edition,
            partNumber: parsed.part,
            libraryGroupId: libraryPath.library_group_id,
        });
        await attachFileToItem(tx, fileId, match.media_item_id);
        await touchLibraryAddedAt(
            tx,
            match.media_item_id,
            config.RECENTLY_ADDED_PROPAGATE_TO_SERIES,
        );
        await undismissMediaItem(tx, match.media_item_id);
        await tx`
            UPDATE media_files
               SET file_hash_head = ${contentHash},
                   updated_at = NOW()
             WHERE id = ${fileId}
        `;
    });
    if (aborted) {
        context.logger.debug(
            '[FileScanner] Live-hash reclaim backed off: item gained a file concurrently; minting distinct item',
            { mediaItemId: match.media_item_id, filePath },
        );
        return null;
    }

    context.logger.info(
        '[FileScanner] Reclaimed active non-entertainment item via live head hash (rename Window 1)',
        {
            mediaItemId: match.media_item_id,
            newFilePath: filePath,
            contentHashPrefix: contentHash.slice(0, 12),
        },
    );

    MediaLifecycleService.afterReclaimed(match.media_item_id, sql).catch((err: unknown) => {
        if (process.env.NODE_ENV !== 'production') throw err;
        context.logger.warn('[FileScanner] afterReclaimed enqueue failed (live-hash)', {
            mediaItemId: match.media_item_id,
            error: err instanceof Error ? err.message : String(err),
        });
    });

    return match.media_item_id;
}

/**
 * Create a media item for non-entertainment library types.
 * Skips the entire provider matching pipeline and extracts metadata from folder structure.
 */
async function createNonEntertainmentItem(
    sql: postgres.Sql,
    filePath: string,
    parsed: ReturnType<typeof parseMediaFilename>,
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
    durationSeconds?: number,
): Promise<'added' | 'updated' | 'skipped'> {
    // Rename reclaim (fix #4): before minting a new item for an unlinked
    // file, check whether a still-active non-entertainment item's live file
    // shares this file's head hash — the add-before-unlink rename ordering.
    // Guarded on "not already linked" so steady-state re-scans of linked
    // files never pay the 64KB head read.
    if (!(await isFileLinkedToMediaItem(sql, filePath))) {
        const reclaimedId = await tryReclaimNonEntertainmentByLiveHash(
            sql,
            filePath,
            parsed,
            libraryPath,
            context,
        );
        if (reclaimedId) return 'updated';
    }

    const template = getLibraryTypeTemplate(libraryPath.media_type);
    const customMetadata = template
        ? extractFolderMetadata(filePath, libraryPath.path, template.folderParsingRules)
        : {};

    const useHierarchy = template?.hierarchyMode === 'series';

    // For hierarchy mode, use the immediate parent folder as the series title so all
    // files in the same folder (e.g. "Linear Algebra/") share one series item.
    // For flat mode, use the parsed filename title.
    let seriesTitle = parsed.title;
    if (useHierarchy) {
        const relativePath = filePath.replace(libraryPath.path, '').replace(/^\//, '');
        const segments = relativePath.split('/').slice(0, -1); // exclude filename
        if (segments.length > 0) {
            seriesTitle = segments[segments.length - 1];
        }
    }

    let result: 'added' | 'updated' | 'skipped';
    let seriesItemId: string | undefined;

    if (useHierarchy) {
        const hierarchyResult = await findOrCreateSeriesHierarchy(sql, filePath, parsed, context, {
            year: seriesYearHint(parsed),
            libraryGroupId: libraryPath.library_group_id,
            libraryRoot: libraryPath.path,
            mediaType: libraryPath.media_type,
            seriesTitle,
            durationSeconds,
        });
        result = hierarchyResult.outcome;
        seriesItemId = hierarchyResult.seriesId;
    } else {
        result = await createPersonalMediaItem(
            sql,
            filePath,
            parsed,
            libraryPath.media_type,
            parsed.year,
            libraryPath.library_group_id,
            durationSeconds,
        );
    }

    // Resolve all items linked to this file once (M:N: multi-episode files)
    const linkedItemIds = await findAllLinkedMediaItemsByFilePath(sql, filePath);

    // Set custom_metadata on the series/top-level item (not the episode)
    if (Object.keys(customMetadata).length > 0) {
        const targetId = seriesItemId ?? linkedItemIds[0] ?? undefined;
        if (targetId) {
            // Merge metadata using sql.json() to avoid double-encoding issues.
            // Since custom_metadata defaults to '{}', it is never null.
            await sql`
                UPDATE media_items
                SET custom_metadata = custom_metadata || ${sql.json(customMetadata as Record<string, never>)}
                WHERE id = ${targetId}
            `;
        }
    }

    // Auto-extract poster from video frame for non-entertainment items.
    // Also runs on 'updated' so items scanned before this feature existed
    // get posters backfilled; extractPosterForItem skips if artwork already exists.
    if (config.IMAGE_SYNC_AUTO_VIDEO_EXTRACTION && (result === 'added' || result === 'updated')) {
        try {
            const { extractPosterForItem } =
                await import('../../../../../../services/video-frame-extractor.service.js');

            // Extract episode thumbnails. For multi-episode files, distribute
            // timestamps proportionally so each episode gets a distinct frame.
            // Sort by episode_number first to ensure consistent assignment.
            const episodeCount = linkedItemIds.length;
            let orderedIds = linkedItemIds;
            if (episodeCount > 1) {
                const rows = await sql<{ id: string; episode_number: number | null }[]>`
                    SELECT id, episode_number FROM media_items
                    WHERE id = ANY(${sql.array(linkedItemIds)})
                    ORDER BY episode_number ASC NULLS LAST
                `;
                orderedIds = rows.map((r) => r.id);
            }
            for (let i = 0; i < orderedIds.length; i++) {
                const timestampPercent =
                    episodeCount > 1 ? ((2 * i + 1) / (2 * episodeCount)) * 100 : undefined;
                await extractPosterForItem(sql, {
                    mediaItemId: orderedIds[i],
                    artworkType: 'thumb',
                    ...(timestampPercent !== undefined && { timestampPercent }),
                });
            }

            // Extract for the series item — pass filePath directly since series
            // has no linked file in media_file_items
            // The duration is this file's own (the scan probe's), so the frame
            // needs no second ffprobe here. Episode calls above take the stored
            // duration of the file they resolve to, so they need nothing extra.
            if (seriesItemId) {
                await extractPosterForItem(sql, {
                    mediaItemId: seriesItemId,
                    artworkType: 'poster',
                    videoFilePath: filePath,
                    ...(durationSeconds !== undefined && { durationSeconds }),
                });
            }
        } catch (e) {
            context.logger.warn(
                `[FileScanner] Failed to extract poster for non-entertainment item`,
                { filePath, error: e instanceof Error ? e.message : String(e) },
            );
        }
    }

    return result;
}

/**
 * Resolve a known candidate to an internal UUID, or create a new media_item row.
 * Returns null if the candidate has no useful data.
 *
 * R2-C2: The movie path previously did an unguarded `INSERT` after a
 * miss-on-lookup. Concurrent per-path scans (index.ts runs targets[] in a
 * for loop but multiple invocations of `scanImpl` with different keys can
 * run in parallel) could both SELECT, both miss, and both INSERT — producing
 * duplicate movie media_items rows sharing the same external ID.
 *
 * Fix: wrap the entire lookup-or-insert in a transaction guarded by
 * `pg_advisory_xact_lock` keyed on `movie-scan:<provider>:<externalId>`.
 * The lock serializes concurrent scans that see the same provider ID while
 * letting unrelated movies proceed in parallel. `hashtext()` is cheap and
 * returns int4; lock key namespace is `movie-scan:*`, distinct from the
 * existing `series:*` / plain `<uuid>` keys elsewhere in the codebase.
 *
 * TV uses `findOrCreateSeries` (already lock-guarded on normalized title),
 * so this change closes the last remaining scanner-duplication window.
 */
export async function resolveOrCreateMediaItem(
    sql: postgres.Sql,
    candidate: {
        externalId: string;
        provider: string;
        title: string;
        year?: number;
        mediaType: string;
        confidence: number;
        externalIds?: Record<string, string>;
        /** Provider-supplied national certification (Jellyfin OfficialRating). */
        certification?: string;
    },
    imdbId: string | undefined,
    context: FileScannerContext,
    durationSeconds?: number,
    libraryGroupId?: string,
    metadataProviderId?: string,
    /**
     * The provider-less item this file already lives on, when the call is an
     * awaiting_provider_match rematch. With no item holding the matched id yet,
     * that item takes the id instead of a new row being minted next to it.
     */
    adoptItemId?: string,
): Promise<string | null> {
    // candidate.mediaType is a MetadataCandidate ('movie' | 'tv' | 'episode' |
    // 'season' | 'anime', see providers/types.ts) and this function is only ever
    // reached for the 'movie' branch — the caller routes 'tv'/'episode'/'season'/
    // 'anime' candidates (all of which fold onto 'tv') into
    // findOrCreateSeriesHierarchy before resolveOrCreateMediaItem is called. The
    // fallback is therefore unreachable; it exists only because toTmdbMediaType's
    // signature is generically nullable.
    const dbMediaType = toDbMediaType(candidate.mediaType) ?? 'movie';
    const lockKey = `movie-scan:${candidate.provider}:${candidate.externalId}`;

    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // Bound the lock wait so a wedged holder can't pin this pooled
        // connection for the full stall-fail window (~10 min), which under
        // concurrent scans starves the shared app pool (web routes included).
        // On timeout the txn errors and releases the connection.
        await tx`SET LOCAL lock_timeout = '30s'`;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        // 1. Try resolving by IMDB ID first (most reliable)
        if (imdbId) {
            const byImdb = await resolveExternalIdToUuid(tx, imdbId, dbMediaType, 'imdb');
            if (byImdb) {
                if (durationSeconds && durationSeconds > 0 && dbMediaType === 'movie') {
                    await setRuntimeSecondsIfNull(tx, byImdb, durationSeconds);
                }
                await backfillLibraryGroupIdIfNull(tx, byImdb, libraryGroupId);
                return byImdb;
            }
        }

        // 2. Try resolving by provider ID (e.g. TMDB)
        const byProvider = await resolveExternalIdToUuid(
            tx,
            candidate.externalId,
            dbMediaType,
            candidate.provider as Parameters<typeof resolveExternalIdToUuid>[3],
        );
        if (byProvider) {
            if (durationSeconds && durationSeconds > 0 && dbMediaType === 'movie') {
                await setRuntimeSecondsIfNull(tx, byProvider, durationSeconds);
            }
            await backfillLibraryGroupIdIfNull(tx, byProvider, libraryGroupId);
            return byProvider;
        }

        // 2b. Cross-link: if the candidate carries cross-provider IDs (e.g. a
        // Jellyfin search result with ProviderIds.Tmdb/Imdb/Tvdb), try to find
        // an existing row keyed by one of those IDs before creating a new one.
        // This prevents duplicate rows when a TMDB-discovery row (has_files=false)
        // already exists for the same title.
        if (candidate.externalIds && Object.keys(candidate.externalIds).length > 0) {
            const crossProviders: ExternalIdProvider[] = ['tmdb', 'imdb', 'tvdb'];
            // Skip the candidate's own provider and any ID already tried via imdbId param.
            const alreadyTriedImdb = !!imdbId;
            for (const xProvider of crossProviders) {
                if (xProvider === candidate.provider) continue;
                if (xProvider === 'imdb' && alreadyTriedImdb) continue;
                const xId = candidate.externalIds[xProvider];
                if (!xId) continue;

                const byXProvider = await resolveExternalIdToUuid(tx, xId, dbMediaType, xProvider);
                if (byXProvider) {
                    if (durationSeconds && durationSeconds > 0 && dbMediaType === 'movie') {
                        await setRuntimeSecondsIfNull(tx, byXProvider, durationSeconds);
                    }
                    const catalogService = createCatalogService(tx);
                    // Attach the candidate's own provider ID as a secondary alias so
                    // future Jellyfin-id lookups resolve directly (no cross-link needed).
                    try {
                        await catalogService.upsertExternalId(
                            byXProvider,
                            {
                                provider: candidate.provider,
                                id: candidate.externalId,
                                mediaType: dbMediaType,
                                source: 'scanner',
                                confidence: candidate.confidence,
                            },
                            false,
                        );
                    } catch {
                        // Alias already mapped to a different item — ignore.
                    }
                    // Best-effort: attach any other cross-provider IDs from the candidate.
                    const knownCross: ExternalIdProvider[] = [
                        'tmdb',
                        'imdb',
                        'tvdb',
                        'trakt',
                        'mal',
                    ];
                    for (const [xp, xv] of Object.entries(candidate.externalIds)) {
                        if (xp === candidate.provider || xp === xProvider) continue;
                        if (!knownCross.includes(xp as ExternalIdProvider)) continue;
                        try {
                            await catalogService.upsertExternalId(
                                byXProvider,
                                {
                                    provider: xp as ExternalIdProvider,
                                    id: xv,
                                    mediaType: dbMediaType,
                                    source: 'scanner',
                                    confidence: 0.9,
                                },
                                false,
                            );
                        } catch {
                            // Already mapped elsewhere — skip.
                        }
                    }
                    await backfillLibraryGroupIdIfNull(tx, byXProvider, libraryGroupId);
                    return byXProvider;
                }
            }
        }

        // 2c. Title fallback (movies only): no id-based match succeeded. Before
        // creating a sibling, adopt an existing file-less discovery row with the
        // same normalized title + year. This closes the duplicate window for
        // library files that carry NO provider id at all — the case step 2b
        // (cross-link by provider id) cannot cover. Conservative: exact title +
        // concrete year, unambiguous single match only. TV is excluded here —
        // it resolves through findOrCreateSeries' own title-locked path.
        if (dbMediaType === 'movie' && candidate.year !== undefined && candidate.year > 0) {
            const adopted = await findAdoptableDiscoveryRowByTitle(tx, {
                title: candidate.title,
                year: candidate.year,
                mediaType: dbMediaType,
            });
            if (adopted) {
                if (durationSeconds && durationSeconds > 0) {
                    await setRuntimeSecondsIfNull(tx, adopted, durationSeconds);
                }
                // Attach the candidate's own provider id (e.g. jellyfin) as a
                // secondary alias so future lookups resolve directly.
                const catalogService = createCatalogService(tx);
                try {
                    await catalogService.upsertExternalId(
                        adopted,
                        {
                            provider: candidate.provider,
                            id: candidate.externalId,
                            mediaType: dbMediaType,
                            source: 'scanner',
                            confidence: candidate.confidence,
                        },
                        false,
                    );
                } catch {
                    // Alias already mapped to a different item — ignore.
                }
                context.logger.info('Adopted file-less discovery row by title match', {
                    id: adopted,
                    title: candidate.title,
                    year: candidate.year,
                    provider: candidate.provider,
                    externalId: candidate.externalId,
                });
                await backfillLibraryGroupIdIfNull(tx, adopted, libraryGroupId);
                return adopted;
            }
        }

        // 2d. Re-identification in place. The file sits on a provider-less item
        // made while no provider could answer (no key yet), and nothing holds the
        // matched id: that item IS the movie. Giving it the id keeps its media_items
        // id, watch state and ratings, and the external_ids insert emits
        // identity.assigned, which re-opens the stages that gave up on it
        // (metadata-update's no-primary-external-id skip). Minting a new row here
        // left the old one behind as a dismissed duplicate.
        if (adoptItemId && dbMediaType === 'movie') {
            const [adopted] = await tx<{ id: string }[]>`
                UPDATE media_items mi
                   SET title = CASE WHEN mi.metadata_locked THEN mi.title ELSE ${candidate.title} END,
                       year = CASE WHEN mi.metadata_locked THEN mi.year
                                   ELSE COALESCE(${candidate.year ?? null}::int, mi.year) END,
                       updated_at = now()
                 WHERE mi.id = ${adoptItemId}::uuid
                   AND mi.media_type = 'movie'
                   AND NOT mi.is_dismissed
                   AND (mi.custom_metadata->>'awaiting_provider_match')::boolean IS TRUE
                   AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND source IS DISTINCT FROM 'watch-sync-file')
             RETURNING mi.id
            `;
            if (adopted) {
                await refreshSortTitles(tx, [adopted.id]);
                const catalogService = createCatalogService(tx);
                if (imdbId) {
                    await catalogService.upsertExternalId(
                        adopted.id,
                        {
                            provider: 'imdb',
                            id: imdbId,
                            mediaType: dbMediaType,
                            source: 'scanner',
                            confidence: 1.0,
                        },
                        false,
                    );
                }
                await catalogService.upsertExternalId(
                    adopted.id,
                    {
                        provider: candidate.provider,
                        id: candidate.externalId,
                        mediaType: dbMediaType,
                        source: 'scanner',
                        confidence: candidate.confidence,
                    },
                    true,
                );
                if (candidate.certification) {
                    await applyNationalAgeRating(tx, adopted.id, candidate.certification, {
                        onlyFill: true,
                    });
                }
                if (durationSeconds && durationSeconds > 0) {
                    await setRuntimeSecondsIfNull(tx, adopted.id, durationSeconds);
                }
                await backfillLibraryGroupIdIfNull(tx, adopted.id, libraryGroupId);
                context.logger.info('[FileScanner] Identified awaiting movie in place', {
                    id: adopted.id,
                    provider: candidate.provider,
                    externalId: candidate.externalId,
                });
                return adopted.id;
            }
        }

        // 3. Create new media_items row (normalise 'anime' → 'tv')
        const mediaType = candidate.mediaType === 'anime' ? 'tv' : candidate.mediaType;
        const newId = await insertScannedMediaItem(tx, {
            title: candidate.title,
            mediaType,
            year: candidate.year,
            runtimeSeconds: durationSeconds,
            libraryGroupId,
        });

        // Provider-supplied national certification (Jellyfin OfficialRating) sets the
        // age rating at identification time. Jellyfin-identified titles have no TMDB
        // id for the later TMDB sync to read a certification from.
        if (candidate.certification) {
            await applyNationalAgeRating(tx, newId, candidate.certification, { onlyFill: true });
        }

        const catalogService = createCatalogService(tx);

        if (imdbId) {
            await catalogService.upsertExternalId(
                newId,
                {
                    provider: 'imdb',
                    id: imdbId,
                    mediaType: dbMediaType,
                    source: 'scanner',
                    confidence: 1.0,
                },
                false,
            );
        }

        await catalogService.upsertExternalId(
            newId,
            {
                provider: candidate.provider,
                id: candidate.externalId,
                mediaType: dbMediaType,
                source: 'scanner',
                confidence: candidate.confidence,
            },
            true,
        );

        context.logger.debug('Created new media_item from scanner', {
            id: newId,
            title: candidate.title,
            provider: candidate.provider,
            externalId: candidate.externalId,
        });

        // S4: Inline TMDB detail enrichment is gated behind SCAN_ENRICH_INLINE
        // (default OFF). When OFF, tmdb-metadata-sync (enqueued via afterMatched)
        // fills in original_title/english_title/overview asynchronously — it is
        // already the authoritative enrichment path and is retryable. Inline
        // enrichment adds ~200ms per new movie/item over HTTP and is the largest
        // remaining first-scan bottleneck at 40k+ movies. Set
        // SCAN_ENRICH_INLINE=true for offline installs that cannot rely on a
        // background queue.
        //
        // Scanner-path invariant: this UPDATE is gated on `metadata_locked = false`.
        if (metadataProviderId && process.env.SCAN_ENRICH_INLINE === 'true') {
            try {
                const detailType: 'movie' | 'tv' = dbMediaType === 'tv' ? 'tv' : 'movie';
                let detail: MediaMetadata | null = null;
                try {
                    const raw = await invokeProviderDetail<unknown>(
                        metadataProviderId,
                        encodeDetailId(metadataProviderId, detailType, candidate.externalId),
                    );
                    detail = normalizeDetail(metadataProviderId, raw, detailType);
                } catch {
                    // Non-fatal: enrichment can be retried by metadata-sync later
                }

                if (detail) {
                    const d = detail as unknown as Record<string, unknown>;
                    await tx`
                        UPDATE media_items SET
                            original_title = COALESCE(${(d.originalTitle as string) || null}, original_title),
                            english_title = COALESCE(${(d.englishTitle as string) || null}, english_title),
                            overview = COALESCE(${(d.overview as string) || null}, overview)
                        WHERE id = ${newId} AND metadata_locked = false
                    `;
                    await refreshSortTitles(tx, [newId]);
                }
            } catch {
                // Non-fatal: enrichment can be retried by metadata-sync later
            }
        }

        return newId;
    });
}

/**
 * State for re-matching a file whose item is flagged awaiting_provider_match.
 * Set by the unchanged branch of processVideoFileInner, settled by
 * settleAwaitingRematch once matching has run.
 */
interface AwaitingRematch {
    fileId?: string;
    /** The awaiting items the file is linked to while it re-matches. */
    itemIds: string[];
    /** Every item the file was linked to when the rematch started. */
    linkedBefore?: string[];
    /** Connection-scoped claim prevents Keep from racing through provider work. */
    claim?: { sql: postgres.Sql; release: () => Promise<void> };
    /** No definitive answer from a provider — keep the awaiting flag. */
    stillAwaiting?: boolean;
}

/** The library's metadata provider id (substring match against registry ids). */
function libraryProviderId(providerIds: string[], libraryPath: LibraryPathRow): string | undefined {
    return (
        providerIds.find((id) => id.toLowerCase().includes(libraryPath.provider.toLowerCase())) ??
        providerIds[0]
    );
}

/** The library's provider id when it is registered AND configured, else null. */
async function resolveUsableProviderId(
    providerIds: string[],
    libraryPath: LibraryPathRow,
): Promise<string | null> {
    const providerId = libraryProviderId(providerIds, libraryPath);
    if (!providerId) return null;
    return (await isProviderConfigured(providerId)) ? providerId : null;
}

/**
 * N3: Narrow FileScannerContext into the shape expected by metadata provider
 * methods. Avoids the `as PluginContext` cast — the provider interface only
 * reads `logger`, and FileScannerContext already guarantees that field.
 *
 * Returns the scanner context typed as PluginContext; the remaining members
 * of PluginContext (cache, http, ffmpeg, config) are not accessed by any
 * provider method that the scanner invokes — a runtime access would surface
 * as undefined and fail loudly, which is the desired "bug, not silent
 * degradation" behavior. If provider interfaces begin relying on those
 * fields, this helper is the single place to tighten.
 */
function narrowProviderContext(context: FileScannerContext): PluginContext {
    return { logger: context.logger } as PluginContext;
}

/**
 * Try a list of provider IDs in order, returning the first confident match.
 * Used to walk `libraryPath.fallback_providers` after the primary provider misses.
 * Exported for unit testing.
 *
 * `allProviderIds` is the full set of registered provider ids (e.g.
 * `['tmdb-metadata-provider', 'anidb-metadata-provider']`); `orderedIds`
 * is the short fallback list from `libraryPath.fallback_providers`
 * (e.g. `['anidb', 'tvdb']`). We match short→full by substring on the id
 * to mirror the legacy `manifest.id.includes(short)` lookup.
 */
export async function tryProvidersInOrder(
    allProviderIds: string[],
    orderedIds: string[],
    filePath: string,
    libraryPath: LibraryPathRow,
    context: PluginContext,
    searchCache?: MetadataSearchCache,
): Promise<{ candidate: MetadataCandidate; matchedProviderId: string } | null> {
    for (const short of orderedIds) {
        const fullId = allProviderIds.find((id) => id.toLowerCase().includes(short.toLowerCase()));
        if (!fullId) continue;
        if (!(await isProviderConfigured(fullId))) continue;

        const cacheKey = searchCache
            ? buildSearchCacheKey(fullId, filePath, libraryPath)
            : undefined;

        if (cacheKey && searchCache!.has(cacheKey)) {
            const cached = searchCache!.get(cacheKey)!;
            if (cached === null) continue;
            if (cached.matchedProviderId === fullId) {
                return cached;
            }
        }

        const result = await matchFileToMetadata(filePath, libraryPath, fullId, context);
        if (result.matched && result.candidate) {
            const hit = { candidate: result.candidate, matchedProviderId: fullId };
            if (cacheKey && searchCache) searchCache.set(cacheKey, hit);
            return hit;
        }
        // A failed search (rejected key, outage) said nothing about this
        // title — don't cache it as a miss for the rest of the scan.
        if (cacheKey && searchCache && !result.providerError) searchCache.set(cacheKey, null);
    }
    return null;
}

/**
 * Create a personal (unmatched) media_item from a parsed filename and link it
 * to a media_files row.  Returns 'added' if a new file row was created, 'updated'
 * if an existing file was re-linked.
 *
 * S12: When called because the metadata provider was unavailable (not because
 * the file genuinely has no match), pass `awaitingProviderMatch: true`. The
 * resulting media_item is flagged in `custom_metadata.awaiting_provider_match`
 * so a future post-scan pass (Wave 9/10) can re-attempt matching once
 * providers are healthy. Without the flag, the row looks identical to
 * permanently-personal items and stays personal forever.
 *
 * The retry pass itself is deferred — the flag is the seed so the work isn't
 * lost. The admin can also trigger a "Re-match awaiting" job manually if the
 * flag makes it to the UI.
 */
async function createPersonalMediaItem(
    sql: postgres.Sql,
    filePath: string,
    parsed: { title: string; edition?: string; part?: number },
    dbMediaType: string,
    year: number | undefined,
    libraryGroupId?: string,
    durationSeconds?: number,
    awaitingProviderMatch?: boolean,
    /**
     * NFO sidecar content for a provider-less local movie — applied as the
     * item's overview/year so a movie not in TMDB (and with no metadata-sync
     * source) still shows its description. NFO year takes priority over the
     * folder/filename-parsed year (the NFO is the authoritative sidecar).
     */
    nfoContent?: LocalNfoContent,
): Promise<'added' | 'updated'> {
    // Idempotent: if the file is already linked to a media item, skip insertion.
    // Re-scan content-heal for already-linked movies runs earlier in the movie
    // path (matchMovie), before the link short-circuits reach here.
    if (await isFileLinkedToMediaItem(sql, filePath)) return 'updated';

    const customMetadata = awaitingProviderMatch
        ? {
              awaiting_provider_match: true,
              awaiting_provider_match_since: new Date().toISOString(),
          }
        : undefined;

    const fileHashHead = await tryHashFileHead(filePath);
    // The check above and the insert+attach below are a check-then-insert that
    // two ingests of the same new file can both pass: the bulk scan and the file
    // watcher / file-delta-ingest, in different processes or replicas, so the
    // in-process title lock does not serialize them. Both minted an item and
    // linked the one file to each (a duplicate in the library). Re-check and
    // create under a per-file lock; the loser sees the winner's link. Not a
    // unique constraint: media_file_items is M:N on purpose (multi-episode files).
    const linked = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SET LOCAL lock_timeout = '30s'`;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`media-file-link:${filePath}`}))`;
        if (await isFileLinkedToMediaItem(tx, filePath)) return null;

        const mediaItemId = await insertScannedMediaItem(tx, {
            title: parsed.title,
            mediaType: dbMediaType,
            year: nfoContent?.year ?? year,
            overview: nfoContent?.overview,
            runtimeSeconds: durationSeconds,
            libraryGroupId,
            customMetadata,
        });
        // Surface the NFO description/year on the display path (provider_metadata),
        // which is where the detail modal reads overview/year from — media_items
        // alone does not render in the modal.
        if (nfoContent) await applyLocalNfoDisplayMetadata(tx, mediaItemId, nfoContent);
        const file = await upsertMediaFile(tx, {
            filePath,
            edition: parsed.edition,
            partNumber: parsed.part,
            libraryGroupId,
            fileHashHead,
        });
        await attachFile(tx, file.id, mediaItemId);
        return file;
    });
    if (!linked) return 'updated';
    const { id: fileId, created } = linked;
    if (created) await initFileChangeDetection(sql, fileId, filePath, fileHashHead);
    return created ? 'added' : 'updated';
}

/**
 * Unified TV hierarchy creation: always builds series → season → episode,
 * with optional external ID enrichment from a metadata match.
 *
 * This replaces both:
 *   - resolveOrCreateMediaItem() for TV (matched path — was flat, no hierarchy)
 *   - createPersonalEpisodeHierarchy() (unmatched path — hierarchy but no IDs)
 *
 * Files always link to episode-level items.
 */
export async function findOrCreateSeriesHierarchy(
    ...args: SeriesHierarchyArgs
): Promise<SeriesHierarchyResult> {
    const deferred: DeferredSeriesMatch = { identityChanged: false };
    let result: SeriesHierarchyResult;
    try {
        result = await findOrCreateSeriesHierarchyInner(deferred, ...args);
    } catch (err) {
        // The file failed after its series was resolved: announce as before, so
        // the series still gets its sync; the retry may never come.
        if (deferred.announce && !(args[7]?.has(deferred.seriesId ?? '') ?? false)) {
            if (deferred.seriesId) args[7]?.add(deferred.seriesId);
            deferred.announce();
        }
        throw err;
    }
    if (deferred.announce) {
        // A file the scan deliberately skipped (superseded multi-episode duplicate,
        // unparseable name) is re-read by EVERY full scan, because it never gets a
        // media_files row. Announcing the series match for it queued a full
        // series-sync each hour, forever (SpongeBob, Pinky and the Brain on prod,
        // 2026-09-30). Only a file that actually entered the library, or a pass
        // that changed the series' identity, is news worth a sync.
        if (result.outcome !== 'skipped' || deferred.identityChanged) {
            if (!(args[7]?.has(result.seriesId) ?? false)) {
                args[7]?.add(result.seriesId);
                deferred.announce();
            }
        }
    }
    return result;
}

/** Deferred "series matched" side effect, decided once the file's outcome is known. */
interface DeferredSeriesMatch {
    seriesId?: string;
    /** Whether this pass changed the series' external-id mapping. */
    identityChanged: boolean;
    /** Fires MediaLifecycleService.afterMatched for the series (fire-and-forget). */
    announce?: () => void;
}

type SeriesHierarchyArgs =
    Parameters<typeof findOrCreateSeriesHierarchyInner> extends [DeferredSeriesMatch, ...infer R]
        ? R
        : never;

type SeriesHierarchyResult = Awaited<ReturnType<typeof findOrCreateSeriesHierarchyInner>>;

async function findOrCreateSeriesHierarchyInner(
    deferred: DeferredSeriesMatch,
    sql: postgres.Sql,
    filePath: string,
    parsed: ReturnType<typeof parseMediaFilename>,
    context: FileScannerContext,
    options: {
        year?: number;
        /** Disk observations taken before the folder transaction, when present. */
        folderIo?: { fileHashHead: string | undefined; missingDedicated: ReadonlySet<string> };
        libraryGroupId?: string;
        /** Library root path — used to resolve the file's season folder ("Season 02"/"Specials"). */
        libraryRoot?: string;
        mediaType?: string;
        candidate?: {
            externalId: string;
            provider: string;
            title: string;
            year?: number;
            mediaType: string;
            confidence: number;
            externalIds?: Record<string, string>;
        };
        imdbId?: string;
        seriesTitle?: string;
        durationSeconds?: number;
        metadataProviderId?: string;
        /** Pre-resolved series UUID — skips findOrCreateSeries entirely */
        resolvedSeriesId?: string;
        /** Actual automatic range-link removals, reported to the folder witness fence. */
        onAutomaticRangeLinksEvicted?: (episodeId: string, filePaths: readonly string[]) => void;
    },
    seriesIdCache?: SeriesIdCache,
    seasonIdCache?: SeasonIdCache,
    /** Per-scan UUIDs already announced; identity writes have their own state. */
    seriesSideEffectsDone?: Set<string>,
    identityWrites = identityWriteState(seriesSideEffectsDone),
): Promise<{
    outcome: 'added' | 'updated' | 'skipped';
    seriesId: string;
    episodeIds: string[];
}> {
    const title = options.candidate?.title ?? options.seriesTitle ?? parsed.title;
    const year = options.candidate?.year ?? options.year;
    const mediaType = options.mediaType ?? 'tv';

    // 1. Find or create series (with external ID resolution if matched)
    //
    // S5: Check the per-path series cache first. On HIT the advisory-lock
    // SELECT is skipped entirely — the series already exists and the lock
    // would have been a no-op. MISS falls through to findOrCreateSeries which
    // still acquires the lock, then we populate the cache from the result.
    // Unknown years and title-only inputs must not reuse concrete identities.
    // Keep provider and external-ID media namespaces distinct; equivalence
    // across providers is proved by the existing resolver on a cache miss.
    // JSON preserves tuple boundaries even when titles or IDs contain delimiters.
    const evidence: [string, string][] = options.candidate
        ? [[options.candidate.provider, options.candidate.externalId]]
        : [];
    if (options.imdbId) evidence.push(['imdb', options.imdbId]);
    evidence.push(
        ...Object.entries(options.candidate?.externalIds ?? {}).filter(
            ([provider, id]) =>
                !!id && seriesCrossProviders.includes(provider as ExternalIdProvider),
        ),
    );
    for (const identity of evidence) {
        if (identity[0] === 'jellyfin') identity[1] = normalizeJellyfinId(identity[1]);
    }
    const providerEvidence = new Map<string, string>();
    let contradictoryEvidence = false;
    for (const [provider, id] of evidence) {
        const previous = providerEvidence.get(provider);
        if (previous && previous !== id) contradictoryEvidence = true;
        providerEvidence.set(provider, id);
    }
    const seriesCacheKey = JSON.stringify([
        title.toLowerCase(),
        mediaType,
        year ?? null,
        options.candidate
            ? [
                  options.candidate.provider,
                  options.candidate.provider === 'jellyfin'
                      ? normalizeJellyfinId(options.candidate.externalId)
                      : options.candidate.externalId,
                  toProviderMediaType(options.candidate.mediaType) ?? 'tv',
              ]
            : null,
        options.imdbId ?? null,
        Object.entries(options.candidate?.externalIds ?? {})
            .filter(
                ([provider, id]) =>
                    !!id && seriesCrossProviders.includes(provider as ExternalIdProvider),
            )
            .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)),
    ]);
    if (contradictoryEvidence) {
        context.logger.warn('[FileScanner] Conflicting series identity evidence', {
            title,
            evidence,
        });
        if (!options.resolvedSeriesId) {
            seriesIdCache?.delete(seriesCacheKey);
            throw new SeriesIdentityConflictError(
                `Conflicting series identity evidence: ${describeEvidence(evidence)}`,
            );
        }
    }
    let seriesId: string;
    const cachedSeriesId = seriesIdCache?.get(seriesCacheKey);
    if (options.resolvedSeriesId) {
        seriesId = options.resolvedSeriesId;
        seriesIdCache?.set(seriesCacheKey, seriesId);
    } else if (cachedSeriesId) {
        seriesId = cachedSeriesId;
    } else {
        // Inspect all supported evidence, including the primary ID. Contradictory
        // owners cannot be resolved safely by provider ordering.
        const dbType = toProviderMediaType(options.candidate?.mediaType ?? mediaType) ?? 'tv';
        const owners = new Set<string>();
        // Cross-provider lookup remains unnecessary for primary-only candidates;
        // findOrCreateSeries is the advisory-locked authority for that path.
        if (evidence.length > 1) {
            for (const [provider, id] of evidence) {
                const owner = await resolveExternalIdToUuid(
                    sql,
                    id,
                    dbType,
                    provider as ExternalIdProvider,
                );
                if (owner) owners.add(owner);
            }
        }
        if (owners.size > 1) {
            context.logger.warn('[FileScanner] Conflicting series identity evidence', {
                title,
                evidence,
                owners: [...owners],
            });
            throw new SeriesIdentityConflictError(
                `Conflicting series identity evidence: ${describeEvidence(evidence)} belong to ${owners.size} different series`,
            );
        }
        const crossLinkedSeriesId = [...owners][0] ?? null;

        if (crossLinkedSeriesId) {
            seriesId = crossLinkedSeriesId;
            await backfillLibraryGroupIdIfNull(sql, seriesId, options.libraryGroupId);
        } else {
            seriesId = await findOrCreateSeries(sql, {
                title,
                year,
                libraryGroupId: options.libraryGroupId,
                mediaType,
                externalId: options.candidate
                    ? {
                          provider: options.candidate.provider,
                          id: options.candidate.externalId,
                          // Composite-key mediaType — see toProviderMediaType comment above.
                          mediaType: toProviderMediaType(options.candidate.mediaType) ?? 'tv',
                      }
                    : undefined,
            });
        }
        seriesIdCache?.set(seriesCacheKey, seriesId);
    }

    // 2. Serialize identity enrichment separately from outcome-based announcements.
    // Claim the announcement only after the episode outcome is known, so a
    // concurrent skipped episode cannot consume another episode's new evidence.
    const seriesMatched = !!options.candidate || !!(options.resolvedSeriesId && options.imdbId);
    const claimSideEffects =
        seriesMatched && !!seriesId && !(seriesSideEffectsDone?.has(seriesId) ?? false);
    deferred.seriesId = seriesId;

    if (options.candidate) {
        // Composite-key mediaType for every upsertExternalId/afterMatched call in
        // this block — see the toProviderMediaType comment on the cross-link
        // pre-check above for why this is toProviderMediaType rather than
        // toTmdbMediaType, and why the fallback is unreachable in practice.
        const seriesProviderMediaType = toProviderMediaType(options.candidate.mediaType);
        if (!seriesProviderMediaType) throw new Error('Unsupported series provider media type');
        await enrichSeriesIdentity(seriesProviderMediaType);

        // S4: Inline series enrichment is gated behind SCAN_ENRICH_INLINE (default
        // OFF). tmdb-metadata-sync (enqueued via afterMatched below) fills these
        // fields asynchronously and is the authoritative enrichment path.
        let inlineClaims = scanInlineEnrichment.get(identityWrites);
        if (!inlineClaims) {
            inlineClaims = new Set();
            scanInlineEnrichment.set(identityWrites, inlineClaims);
        }
        if (
            claimSideEffects &&
            options.metadataProviderId &&
            process.env.SCAN_ENRICH_INLINE === 'true' &&
            !inlineClaims.has(seriesId)
        ) {
            inlineClaims.add(seriesId);
            try {
                const [row] = await sql<[{ english_title: string | null }?]>`
                    SELECT english_title FROM media_items WHERE id = ${seriesId}
                `;
                if (!row?.english_title) {
                    let detail: MediaMetadata | null = null;
                    try {
                        const raw = await invokeProviderDetail<unknown>(
                            options.metadataProviderId,
                            encodeDetailId(
                                options.metadataProviderId,
                                'tv',
                                options.candidate.externalId,
                            ),
                        );
                        detail = normalizeDetail(options.metadataProviderId, raw, 'tv');
                    } catch {
                        // Non-fatal: enrichment can be retried by metadata-sync later
                    }
                    if (detail) {
                        const d = detail as unknown as Record<string, unknown>;
                        await sql`
                            UPDATE media_items SET
                                original_title = COALESCE(${(d.originalTitle as string) || null}, original_title),
                                english_title = COALESCE(${(d.englishTitle as string) || null}, english_title),
                                overview = COALESCE(${(d.overview as string) || null}, overview)
                            WHERE id = ${seriesId} AND metadata_locked = false
                        `;
                        await refreshSortTitles(sql, [seriesId]);
                    }
                }
            } catch {
                // Non-fatal: enrichment can be retried by metadata-sync later
            }
        }

        // S5: Fire-and-forget lifecycle hook — surface failures in the
        // scanner log rather than silently dropping them. Release the scan's
        // announcement claim on rejection so a later episode can retry the
        // idempotent hook without concurrent enqueue amplification.
        deferred.announce = (): void => {
            MediaLifecycleService.afterMatched(
                seriesId,
                seriesProviderMediaType,
                { enqueueMetadataSync: true },
                sql,
            ).catch((err: unknown) => {
                // A failed enqueue must remain eligible for the next episode.
                seriesSideEffectsDone?.delete(seriesId);
                // In dev: re-raise so an unhandled-rejection bubbles up and the
                // missing-task / config bug is impossible to miss. The inner
                // handleTriggerFailure already prod-logs at error+TAG, so the
                // dev-only re-raise is purely a visibility layer.
                if (process.env.NODE_ENV !== 'production') throw err;
                context.logger.warn('[FileScanner] afterMatched enqueue failed for series', {
                    seriesId,
                    externalId: options.candidate?.externalId,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        };
    } else if (options.resolvedSeriesId && options.imdbId) {
        const providerMediaType = toProviderMediaType(mediaType);
        if (!providerMediaType) throw new Error('Unsupported series provider media type');
        await enrichSeriesIdentity(providerMediaType);
        deferred.announce = (): void => {
            MediaLifecycleService.afterMatched(
                seriesId,
                toProviderMediaType(mediaType) ?? 'tv',
                { enqueueMetadataSync: true },
                sql,
            ).catch((err: unknown) => {
                seriesSideEffectsDone?.delete(seriesId);
                if (process.env.NODE_ENV !== 'production') throw err;
                context.logger.warn(
                    '[FileScanner] afterMatched enqueue failed for IMDB-resolved series',
                    {
                        seriesId,
                        imdbId: options.imdbId,
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            });
        };
    }

    async function enrichSeriesIdentity(
        providerMediaType: NonNullable<ReturnType<typeof toProviderMediaType>>,
    ): Promise<void> {
        const previous = identityWrites.pending.get(seriesId) ?? Promise.resolve();
        const work = previous
            .catch(() => undefined)
            .then(async () => {
                const catalog = createCatalogService(sql);
                const ids: {
                    provider: string;
                    id: string;
                    confidence: number;
                    primary: boolean;
                    /** Named by the matched provider item itself (not a folder tag). */
                    fromCandidate: boolean;
                }[] = [];
                if (options.candidate)
                    ids.push({
                        provider: options.candidate.provider,
                        id: options.candidate.externalId,
                        confidence: options.candidate.confidence,
                        primary: true,
                        fromCandidate: true,
                    });
                if (options.imdbId)
                    ids.push({
                        provider: 'imdb',
                        id: options.imdbId,
                        confidence: 1,
                        primary: false,
                        fromCandidate: false,
                    });
                for (const [provider, id] of Object.entries(options.candidate?.externalIds ?? {})) {
                    if (id && seriesCrossProviders.includes(provider as ExternalIdProvider))
                        ids.push({
                            provider,
                            id,
                            confidence: 0.9,
                            primary: false,
                            fromCandidate: true,
                        });
                }
                for (const identity of ids) {
                    if (identity.provider === 'jellyfin')
                        identity.id = normalizeJellyfinId(identity.id);
                }
                const currentMappings = await catalog.getExternalIds(seriesId);
                const heldBySeries = (provider: string, id: string): boolean =>
                    currentMappings.some(
                        (entry) =>
                            entry.provider === provider &&
                            entry.mediaType === providerMediaType &&
                            entry.id === id,
                    );
                // The provider's own item names an id this series already holds
                // (a Jellyfin item whose TMDB id is the series' TMDB id). A
                // different primary id is then the provider re-assigning its own
                // id — Jellyfin rescanned the item — not another show.
                const providerVouches = ids.some(
                    (identity) =>
                        !identity.primary &&
                        identity.fromCandidate &&
                        heldBySeries(identity.provider, identity.id),
                );
                const implicit = !options.resolvedSeriesId;
                const refuse = (message: string): never => {
                    seriesIdCache?.delete(seriesCacheKey);
                    throw new SeriesIdentityConflictError(message);
                };
                if (implicit && !providerVouches) {
                    // Refuse before any write: a different id from the match's
                    // own provider means this series is another show.
                    const primary = ids.find((identity) => identity.primary);
                    const rival =
                        primary &&
                        currentMappings.find(
                            (entry) =>
                                entry.provider === primary.provider &&
                                entry.mediaType === providerMediaType &&
                                entry.id !== primary.id,
                        );
                    if (primary && rival) {
                        context.logger.warn('[FileScanner] Conflicting series provider mapping', {
                            seriesId,
                            provider: primary.provider,
                            keeping: rival.id,
                            incoming: primary.id,
                        });
                        refuse(
                            `Conflicting series provider mapping: the series has ${primary.provider} ${rival.id}, the match is ${primary.provider} ${primary.id}`,
                        );
                    }
                }
                for (const identity of ids) {
                    const key = JSON.stringify([
                        seriesId,
                        identity.provider,
                        providerMediaType,
                        identity.id,
                    ]);
                    if (
                        identityWrites.completed.has(key) &&
                        heldBySeries(identity.provider, identity.id)
                    )
                        continue;
                    // Only the match's own provider id decides which series this is.
                    // A secondary id (tvdb, mal, an IMDb id) that disagrees with the
                    // stored one is a provider data mismatch: keep the stored id and
                    // keep ingesting.
                    const blocking = identity.primary && implicit;
                    try {
                        // CatalogService can replace historical same-provider mappings.
                        // A scanner may only confirm them or add a compatible new provider.
                        const existing = await catalog.getExternalIds(seriesId);
                        const rival = existing.find(
                            (entry) =>
                                entry.provider === identity.provider &&
                                entry.mediaType === providerMediaType &&
                                entry.id !== identity.id,
                        );
                        if (rival && blocking && providerVouches) {
                            // Re-assigned provider id: the catalog's replace-when-stale
                            // write. Inside its convergence window it keeps the fresh
                            // id, so two provider items cannot swap it back and forth.
                            const result = await catalog.upsertExternalIdDetailed(
                                seriesId,
                                {
                                    provider: identity.provider,
                                    id: identity.id,
                                    mediaType: providerMediaType,
                                    source: 'scanner',
                                    confidence: identity.confidence,
                                },
                                true,
                            );
                            deferred.identityChanged = result.changed || deferred.identityChanged;
                            if (result.written) identityWrites.completed.add(key);
                            context.logger.info('[FileScanner] Series provider id re-assigned', {
                                seriesId,
                                provider: identity.provider,
                                previous: rival.id,
                                incoming: identity.id,
                                replaced: result.written,
                            });
                            continue;
                        }
                        if (rival) {
                            if (identity.primary) {
                                context.logger.warn(
                                    '[FileScanner] Conflicting series provider mapping',
                                    {
                                        seriesId,
                                        keeping: rival.id,
                                        incoming: identity.id,
                                        provider: identity.provider,
                                    },
                                );
                            } else {
                                context.logger.warn(
                                    '[FileScanner] Skipping disagreeing secondary series id',
                                    {
                                        seriesId,
                                        keeping: rival.id,
                                        incoming: identity.id,
                                        provider: identity.provider,
                                    },
                                );
                            }
                            if (blocking) {
                                refuse(
                                    `Conflicting series provider mapping: the series has ${identity.provider} ${rival.id}, the match is ${identity.provider} ${identity.id}`,
                                );
                            }
                            continue;
                        }
                        const result = await catalog.upsertExternalIdDetailed(
                            seriesId,
                            {
                                provider: identity.provider,
                                id: identity.id,
                                mediaType: providerMediaType,
                                source: 'scanner',
                                confidence: identity.confidence,
                            },
                            identity.primary,
                            { preserveExisting: true },
                        );
                        // Evaluate every write before accumulating changed status.
                        deferred.identityChanged = result.changed || deferred.identityChanged;
                        if (result.written) identityWrites.completed.add(key);
                        else {
                            context.logger.warn('[FileScanner] Series identity write rejected', {
                                seriesId,
                                ...identity,
                            });
                            if (blocking) {
                                refuse(
                                    `Series identity write rejected: the series gained a different ${identity.provider} id while ${identity.id} was written`,
                                );
                            }
                        }
                    } catch (error) {
                        if (error instanceof SeriesIdentityConflictError) throw error;
                        const durableConflict =
                            error instanceof Error &&
                            (error.name === 'ExternalIdOwnedByAnotherItemError' ||
                                ('code' in error && error.code === '23505'));
                        if (durableConflict) {
                            // Two writers inserting the SAME mapping at once (scan and
                            // watcher, two replicas) collide on the unique index too.
                            // That is a confirmation, not an ownership conflict.
                            const owner = await resolveExternalIdToUuid(
                                sql,
                                identity.id,
                                providerMediaType,
                                identity.provider as ExternalIdProvider,
                            );
                            if (owner === seriesId) {
                                identityWrites.completed.add(key);
                                continue;
                            }
                            if (blocking) {
                                context.logger.warn(
                                    '[FileScanner] Conflicting series identity ownership',
                                    { seriesId, ...identity, owner },
                                );
                                refuse(
                                    `Conflicting series identity ownership: ${identity.provider} ${identity.id} belongs to another series`,
                                );
                            }
                        }
                        context.logger.warn('[FileScanner] Series identity enrichment failed', {
                            seriesId,
                            ...identity,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            });
        identityWrites.pending.set(seriesId, work);
        try {
            await work;
        } finally {
            if (identityWrites.pending.get(seriesId) === work)
                identityWrites.pending.delete(seriesId);
        }
    }

    // 3. Determine season number.
    // Precedence (matches Jellyfin):
    //   1. Explicit SxxExx in the filename wins — a "Series S01E15" in a
    //      mislabelled "Season 02" folder is season 1.
    //   2. Else the "Season NN"/"Specials" folder the file sits in (folder-driven;
    //      covers anime / simple "Show - 05.mkv" naming that carries no season).
    //   3. Else specials/OVA/ONA title tokens → season 0.
    //   4. Else default season 1.
    // A file like "Series - S01E15 - Special Operations Squad" has an explicit
    // season=1 that must not be overridden by the word "Special" in the title.
    const folderSeason = extractSeasonNumberFromPath(filePath, options.libraryRoot ?? '');

    const episodeStart = parsed.episodeStart ?? parsed.episode;
    const episodeEnd = parsed.episodeEnd;
    const hasEpisodeNumber = episodeStart !== undefined;

    // A descending filename is ambiguous, not an empty range covered by its
    // neighbours. Keep the endpoints as supplied and leave identity to review.
    if (episodeStart !== undefined && episodeEnd !== undefined && episodeEnd < episodeStart) {
        await clearRangeSupersededIfLinked(sql, filePath, true);
        await recordScanIssueWithCooldown(
            sql,
            filePath,
            options.libraryGroupId ?? null,
            'episode_number_unparsed',
            `The filename has a descending episode range (${episodeStart}-${episodeEnd}). Review its episode order manually before linking it.`,
        );
        return { outcome: 'skipped', seriesId, episodeIds: [] };
    }

    // 3b. A daily-show file ("The Show 2021.03.14.mkv") names its episode by air
    // date. The episode that aired that day decides the season too: providers
    // number daily shows by run or by year, whatever the folder says, so the
    // folder's "Season 2021" must not be created beside the real one. Only for
    // a file not linked yet; the first files of a new show arrive before the
    // provider's episodes exist, and the post-sync air-date pass
    // (air-date-reconciliation.service.ts) re-links those.
    let alreadyLinkedIds: string[] | undefined;
    let airDateMatch: Awaited<ReturnType<typeof findCanonicalEpisodesByAirDate>>[number] | null =
        null;
    if (!hasEpisodeNumber && parsed.airDate) {
        alreadyLinkedIds = await findAllLinkedMediaItemsByFilePath(sql, filePath);
        if (alreadyLinkedIds.length === 0) {
            const candidates = await findCanonicalEpisodesByAirDate(sql, seriesId, parsed.airDate);
            airDateMatch = pickAirDateEpisode(candidates, folderSeason);
            // Several episodes aired that day and nothing tells them apart.
            // Auto-numbering would invent one that no later pass can fix (the
            // air-date pass needs a single candidate too), so leave it unlinked
            // with a reason, like any other unreadable episode name.
            if (!airDateMatch && candidates.length > 1) {
                await recordScanIssueWithCooldown(
                    sql,
                    filePath,
                    options.libraryGroupId ?? null,
                    'episode_number_unparsed',
                    `The filename names the air date ${parsed.airDate}, and ${candidates.length} episodes of this show aired that day. Put the file in the right season folder, or rename it with SxxEyy (e.g. S01E05).`,
                );
                return { outcome: 'skipped', seriesId, episodeIds: [] };
            }
            // No episode aired that day, but the show HAS provider episodes:
            // the provider doesn't list this day yet (or the date is wrong).
            // Checked across the series, not the folder season: a daily show's
            // "Season 2021" folder never holds provider episodes, so the
            // season-level guard below would let it invent one every time.
            // Only a show with no provider episodes at all auto-numbers (its
            // first files, before the first sync; the air-date pass moves them).
            if (
                !airDateMatch &&
                candidates.length === 0 &&
                (await seriesHasCanonicalEpisodes(sql, seriesId))
            ) {
                await recordScanIssueWithCooldown(
                    sql,
                    filePath,
                    options.libraryGroupId ?? null,
                    'episode_number_unparsed',
                    `The filename names the air date ${parsed.airDate}, but no matched episode of this show aired that day yet, so it was not linked to an invented one. Later scans retry it, so it links once the metadata refresh lists that episode; if the date is wrong, rename it with SxxEyy (e.g. S01E05).`,
                );
                return { outcome: 'skipped', seriesId, episodeIds: [] };
            }
        }
    }

    const seasonNumber =
        airDateMatch?.season_number ??
        resolveSeasonNumber(parsed.season, folderSeason, parsed.episodeType);

    // 4. Find or create season
    // S5: Check the per-path season cache first (key: seriesId:seasonNumber).
    const seasonCacheKey = `${seriesId}:${seasonNumber}`;
    const cachedSeasonId = airDateMatch
        ? airDateMatch.season_id
        : seasonIdCache?.get(seasonCacheKey);
    const seasonId =
        cachedSeasonId ??
        (await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber,
        }));
    if (!cachedSeasonId) seasonIdCache?.set(seasonCacheKey, seasonId);

    // 5. Create episode(s) and link files
    let anyCreated = false;
    const episodeIds: string[] = [];

    if (hasEpisodeNumber) {
        const start = episodeStart!;
        const end = episodeEnd ?? start;
        // A combined file (S02E24E25) holds `episodeCount` episodes, so the file's
        // duration is NOT any single episode's runtime — writing the full duration
        // to each row both overstates every episode and mimics the signature of a
        // scanner mis-link, which would block segment derivation outright.
        const episodeCount = end - start + 1;
        const perEpisodeSeconds = options.durationSeconds
            ? Math.round(options.durationSeconds / episodeCount)
            : undefined;
        let attachedFileId: string | undefined;
        // Hoisted out of the per-episode loop below: a combined multi-episode
        // file (S02E24E25) shares the same filePath across every iteration,
        // so hashing once here avoids re-reading the same 64KB head N times.
        const fileHashHead = options.folderIo
            ? options.folderIo.fileHashHead
            : await tryHashFileHead(filePath);
        for (let ep = start; ep <= end; ep++) {
            // A range file (S06E01E03) yields to any episode in the span that
            // already has a file dedicated to exactly it — that layout is a
            // split anthology episode, not a genuine combined file. Checked
            // BEFORE findOrCreatePersonalEpisode so we never create an episode
            // row just to skip linking it. This pre-check stats the dedicated
            // file, so it stays outside the episode link lock; the same
            // question is asked again under the lock below.
            /** Dedicated files found missing on disk: they cover nothing. */
            const missingDedicated = new Set<string>();
            if (episodeCount > 1) {
                const dedicated = await findDedicatedEpisodeFile(sql, seasonId, ep, filePath);
                // A file that is gone from disk (its row not cleaned up yet: the
                // full scan removes stale rows after processing) covers nothing.
                if (dedicated) {
                    if (
                        (options.folderIo
                            ? options.folderIo.missingDedicated.has(dedicated.filePath)
                                ? 'missing'
                                : 'present'
                            : await assessFilePresence(dedicated.filePath, {
                                  mountRoot: options.libraryRoot,
                              })) !== 'missing'
                    ) {
                        const evicted = await yieldEpisodeToDedicatedFile(
                            sql,
                            seasonId,
                            ep,
                            dedicated,
                        );
                        context.logger.info(
                            '[FileScanner] Skipping multi-episode range link — episode has its own file',
                            {
                                filePath,
                                episodeNumber: ep,
                                seasonNumber,
                                episodeRange: `${start}-${end}`,
                                dedicatedFile: dedicated.filePath,
                            },
                        );
                        options.onAutomaticRangeLinksEvicted?.(dedicated.episodeId, evicted);
                        logEvictedRangeLinks(context, filePath, ep, seasonNumber, evicted);
                        await recordEvictedRangeStubs(
                            sql,
                            seasonId,
                            options.libraryGroupId ?? null,
                            evicted,
                            filePath,
                            context.abortSignal,
                        );
                        continue;
                    }
                    missingDedicated.add(dedicated.filePath);
                }
            }

            const epTitle = episodeTitleFromPath(filePath, ep);
            // Decide the episode's links under the per-episode lock: the
            // dedicated check, the attach and the eviction of range links are
            // one unit, so a single file for this episode cannot interleave
            // with the range file's check (see withEpisodeLinkLock).
            const link = await withEpisodeLinkLock(
                sql,
                seasonId,
                ep,
                async (tx): Promise<EpisodeLinkResult> => {
                    if (episodeCount > 1) {
                        const late = await findDedicatedEpisodeFile(
                            tx,
                            seasonId,
                            ep,
                            filePath,
                            missingDedicated,
                        );
                        if (late) {
                            const evicted = await evictRangeLinksSupersededByDedicatedFile(
                                tx,
                                late.episodeId,
                                ep,
                                late.fileId,
                                late.filePath,
                            );
                            return { kind: 'yielded', dedicated: late, evicted };
                        }
                    }

                    const { id: episodeId, created: episodeCreated } =
                        await findOrCreatePersonalEpisode(tx, {
                            seasonId,
                            seasonNumber,
                            episodeNumber: ep,
                            title: epTitle,
                        });
                    const { id: fileId, created: fileCreated } = await upsertMediaFile(tx, {
                        filePath,
                        edition: parsed.edition,
                        partNumber: parsed.part,
                        absoluteEpisode: parsed.absoluteEpisode ?? null,
                        libraryGroupId: options.libraryGroupId,
                        fileHashHead,
                    });
                    await attachFile(tx, fileId, episodeId);

                    // Reverse of the guard above, for the scan order where the range
                    // file was seen first and already holds the link (and the default
                    // flag). A file dedicated to exactly this episode evicts it.
                    // `episodeCount === 1` is only a cheap pre-filter — it also admits
                    // self-referential ranges (S06E01E01), so the callee re-checks the
                    // real predicate against filePath before deleting anything.
                    const evicted =
                        episodeCount === 1
                            ? await evictRangeLinksSupersededByDedicatedFile(
                                  tx,
                                  episodeId,
                                  ep,
                                  fileId,
                                  filePath,
                              )
                            : [];
                    return {
                        kind: 'linked',
                        episodeId,
                        episodeCreated,
                        fileId,
                        fileCreated,
                        evicted,
                    };
                },
            );

            if (link.kind === 'yielded') {
                // Another file took the episode while this one was being
                // scanned: the same outcome as the pre-check above.
                context.logger.info(
                    '[FileScanner] Skipping multi-episode range link — episode has its own file',
                    {
                        filePath,
                        episodeNumber: ep,
                        seasonNumber,
                        episodeRange: `${start}-${end}`,
                        dedicatedFile: link.dedicated.filePath,
                    },
                );
                options.onAutomaticRangeLinksEvicted?.(link.dedicated.episodeId, link.evicted);
                logEvictedRangeLinks(context, filePath, ep, seasonNumber, link.evicted);
                await recordEvictedRangeStubs(
                    sql,
                    seasonId,
                    options.libraryGroupId ?? null,
                    link.evicted,
                    filePath,
                    context.abortSignal,
                );
                continue;
            }

            options.onAutomaticRangeLinksEvicted?.(link.episodeId, link.evicted);
            episodeIds.push(link.episodeId);

            if (link.episodeCreated && perEpisodeSeconds) {
                await setRuntimeSecondsIfNull(sql, link.episodeId, perEpisodeSeconds);
            }

            attachedFileId = link.fileId;
            if (link.fileCreated) {
                await initFileChangeDetection(sql, link.fileId, filePath, fileHashHead);
            }
            logEvictedRangeLinks(context, filePath, ep, seasonNumber, link.evicted);
            await recordEvictedRangeStubs(
                sql,
                seasonId,
                options.libraryGroupId ?? null,
                link.evicted,
                filePath,
                context.abortSignal,
            );

            if (link.episodeCreated || link.fileCreated) anyCreated = true;
        }

        // Every episode in the range yielded to a dedicated file, so this file
        // is a redundant duplicate of content already in the library and no
        // media_files row was created (upsertMediaFile lives inside the loop).
        // Report 'skipped' rather than 'updated' — the same reasoning as the
        // unparseable-file branch below: scan stats must not claim a successful
        // update for a file that was intentionally left unlinked. Logged at
        // warn so an operator can see WHY the file never appears in the library.
        if (episodeIds.length === 0) {
            context.logger.warn(
                '[FileScanner] Multi-episode file fully superseded — every episode in its range has a dedicated file',
                {
                    filePath,
                    seasonNumber,
                    episodeRange: `${start}-${end}`,
                },
            );
            // Remembered on a stub row, so the next scans skip it while it and
            // its covering files stay as they are.
            await recordStubIfRangeFullySuperseded(
                sql,
                filePath,
                seasonId,
                options.libraryGroupId ?? null,
                context.abortSignal,
            );
            return { outcome: 'skipped', seriesId, episodeIds: [] };
        }

        // Derive each episode's window now that every row is attached. Chapters
        // usually arrive later; chapter-sync recomputes then.
        if (attachedFileId && episodeCount > 1) {
            await refreshSegmentsForFile(sql, attachedFileId);
        }
    } else {
        // No episode number — auto-number (same logic as former createPersonalEpisodeHierarchy)
        alreadyLinkedIds ??= await findAllLinkedMediaItemsByFilePath(sql, filePath);

        // A name without a number often still carries the episode TITLE
        // ("Season 00/The Ghost of Christmas.mp4", "Pinky.05.Die.Verfluchten.der.Maeuse").
        // Bind to the canonical episode with that exact title. Search the resolved
        // season; when neither the filename nor a folder named the season (files
        // straight in the series folder), search the whole series.
        let titleMatchId: string | null = airDateMatch?.id ?? null;
        if (alreadyLinkedIds.length === 0 && !titleMatchId) {
            titleMatchId = matchEpisodeByTitle(
                parsed.title,
                (await listCanonicalEpisodeTitles(sql, { seasonId })).map(toTitleCandidate),
            );
            if (!titleMatchId && parsed.season === undefined && folderSeason === undefined) {
                titleMatchId = matchEpisodeByTitle(
                    parsed.title,
                    (await listCanonicalEpisodeTitles(sql, { seriesId })).map(toTitleCandidate),
                );
            }
        }

        // Specials are the exception to the block below: a Specials season is
        // where bonus material the provider never listed lives (a making-of, a
        // staff documentary), so an unmatched file there becomes a local special
        // instead of being left unlinked.
        const isSpecialsSeason = seasonNumber === 0;

        // If parser failed AND nothing already links this file AND the season
        // has canonical episodes, skip episode creation entirely: auto-numbering
        // past the canonical range invents an episode, and the real one stays
        // file-less. The skip is recorded as a scan issue (a stub row with the
        // reason, like every other unlinked scan failure) rather than only
        // logged, so the file appears on the Ingest Map and the ingest funnel
        // instead of vanishing. Renaming the file clears it on the next scan.
        if (
            alreadyLinkedIds.length === 0 &&
            !titleMatchId &&
            !isSpecialsSeason &&
            (await seasonHasCanonicalEpisodes(sql, seasonId))
        ) {
            await recordScanIssueWithCooldown(
                sql,
                filePath,
                options.libraryGroupId ?? null,
                'episode_number_unparsed',
                `No episode number could be read from the filename, and season ${seasonNumber} already has matched episodes, so it was not linked to an invented one. Rename it with SxxEyy (e.g. S01E05) so it can be ingested.`,
            );
            context.logger.warn(
                '[FileScanner] Skipping auto-number for unparseable file in season with canonical episodes',
                {
                    filePath,
                    seriesId,
                    seasonId,
                    seasonNumber,
                },
            );
            // The episode was NOT linked (write skipped) — reporting 'updated'
            // here made scan stats claim a successful update while the file
            // silently never links. Return 'skipped' so the aggregated scan
            // stats reflect that this file was intentionally not processed.
            return {
                outcome: 'skipped',
                seriesId,
                episodeIds: [],
            };
        }

        const fileHashHead = options.folderIo
            ? options.folderIo.fileHashHead
            : await tryHashFileHead(filePath);
        const { id: fileId, created: fileCreated } = await upsertMediaFile(sql, {
            filePath,
            edition: parsed.edition,
            partNumber: parsed.part,
            absoluteEpisode: parsed.absoluteEpisode ?? null,
            libraryGroupId: options.libraryGroupId,
            fileHashHead,
        });
        if (fileCreated) await initFileChangeDetection(sql, fileId, filePath, fileHashHead);

        if (alreadyLinkedIds.length > 0) {
            for (const linkedId of alreadyLinkedIds) {
                await attachFile(sql, fileId, linkedId);
            }
            episodeIds.push(...alreadyLinkedIds);
        } else if (titleMatchId) {
            await attachFile(sql, fileId, titleMatchId);
            episodeIds.push(titleMatchId);
            if (fileCreated) anyCreated = true;
            context.logger.info(
                airDateMatch
                    ? '[FileScanner] Linked daily-show file to episode by air date'
                    : '[FileScanner] Linked unnumbered file to episode by title',
                {
                    filePath,
                    episodeId: titleMatchId,
                    airDate: parsed.airDate,
                },
            );
        } else {
            const MAX_RETRIES = 3;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                const epNum = await getNextEpisodeNumber(sql, seasonId);
                const epTitle = episodeTitleFromPath(filePath, epNum);
                const result = await findOrCreatePersonalEpisode(sql, {
                    seasonId,
                    seasonNumber,
                    episodeNumber: epNum,
                    title: epTitle,
                });
                if (result.created) {
                    await attachFile(sql, fileId, result.id);
                    episodeIds.push(result.id);
                    anyCreated = true;
                    if (options.durationSeconds) {
                        await setRuntimeSecondsIfNull(sql, result.id, options.durationSeconds);
                    }
                    break;
                }
                // Last attempt: use the existing episode (link file to it)
                if (attempt === MAX_RETRIES - 1) {
                    await attachFile(sql, fileId, result.id);
                    episodeIds.push(result.id);
                }
            }
        }
    }

    return {
        outcome: anyCreated ? 'added' : 'updated',
        seriesId,
        episodeIds,
    };
}

/**
 * Link a file as a secondary version of an existing media_item.
 *
 * - Creates/updates the media_files row for the new file.
 * - Links it to the existing media_item via media_file_items.
 * - Sets is_default and sort_order on media_file_items for the edition picker.
 * - Optionally extracts chapters when library is configured for it.
 *
 * Returns 'added' if the media_files row was newly created, 'updated' if it existed.
 */
async function linkAsVersion(
    sql: postgres.Sql,
    filePath: string,
    existingItemId: string,
    parsed: { edition?: string; part?: number },
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
): Promise<'added' | 'updated'> {
    let editionLabel: string;
    if (parsed.edition) {
        editionLabel = editionCanonicalToDisplayName(parsed.edition);
    } else {
        const stem = path.basename(filePath, path.extname(filePath));
        const parentDir = path.basename(path.dirname(filePath));
        editionLabel = parentDir && parentDir !== stem ? `${parentDir}/${stem}` : stem;
    }

    const fileHashHead = await tryHashFileHead(filePath);
    const { id: fileId, created } = await upsertMediaFile(sql, {
        filePath,
        edition: parsed.edition,
        partNumber: parsed.part,
        libraryGroupId: libraryPath.library_group_id,
        fileHashHead,
    });
    if (created) await initFileChangeDetection(sql, fileId, filePath, fileHashHead);

    // Wrap the read + all linkFileAsVersion calls in a single transaction with
    // advisory lock so two workers cannot compute the same sort_order.
    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // Bound the lock wait (see the movie-scan lock above) so a wedged
        // holder cannot pin a shared-pool connection for the full stall window.
        await tx`SET LOCAL lock_timeout = '30s'`;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${existingItemId}))`;

        const existingFiles = await getFilesForMediaItem(tx, existingItemId);
        const otherFiles = existingFiles.filter((ef) => ef.file_path !== filePath);

        // Assign sequential sort_order; first existing file keeps the default.
        let nextSortOrder = 0;
        for (const ef of otherFiles) {
            const label = ef.edition ?? path.basename(ef.file_path, path.extname(ef.file_path));
            await linkFileAsVersion(tx, ef.id, existingItemId, {
                label,
                isDefault: nextSortOrder === 0,
                sortOrder: nextSortOrder,
            });
            nextSortOrder++;
        }

        // Insert the new file with correct metadata — no intermediate is_default=true state.
        await linkFileAsVersion(tx, fileId, existingItemId, {
            label: editionLabel,
            isDefault: otherFiles.length === 0,
            sortOrder: nextSortOrder,
        });
    });

    if (libraryPath.scan_chapters) {
        await extractChapters(sql, filePath, context, fileId);
    }

    return created ? 'added' : 'updated';
}

/**
 * Extract and store chapters from a media file.
 * Only runs when the library path has scan_chapters enabled.
 * Skips files that already have chapters in the database.
 */
export async function extractChapters(
    sql: postgres.Sql,
    filePath: string,
    context: FileScannerContext,
    knownFileId?: string,
    isCancelled?: () => boolean,
): Promise<void> {
    try {
        if (context.abortSignal?.aborted || isCancelled?.()) return;
        const fileId = knownFileId ?? (await findMediaFileByPath(sql, filePath))?.id;
        if (!fileId) return;

        // A successful empty probe is cached too; old rows without a current
        // marker are not evidence about these bytes.
        if (await loadKnownFileChapters(sql, fileId)) return;

        const resolved = await resolveMediaPath(filePath, { skipLocalAccessCheck: true }, sql);
        if (!resolved || !resolved.isAccessible) return;

        // The scan's own probe of this file already carries the chapters
        // (probeFileForScan, chapters: true) while its stat still matches;
        // otherwise this is the chapter probe it always was. context.abortSignal
        // is the scan's top-level abort signal, so an abort still kills the probe.
        const scanned = await readScanChapters(
            filePath,
            resolved.containerPath,
            context.abortSignal,
        );
        // Stored in full, generic titles ("Opening", "Chapter 2") included: the
        // intro analyzer reads them, and chapter-sync stores this same list. A
        // failed probe stores and marks nothing; a probe whose file changed
        // mid-probe is stored but left unmarked (see storeScanChapters).
        await storeScanChapters(sql, fileId, scanned, { signal: context.abortSignal, isCancelled });

        if (scanned.success && scanned.chapters.length > 0) {
            context.logger.debug(`Extracted ${scanned.chapters.length} chapters from ${filePath}`);
        }
    } catch (err) {
        context.logger.warn(
            `Chapter extraction failed for ${filePath}: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
    }
}

/**
 * Version detection + fallback: try to link a file as a secondary version of an
 * existing media_item; if no version match, create a new personal media_item.
 *
 * Called whenever the metadata matcher returns no match. Two attempts are made:
 *   1. Folder-sibling check — another file in the same folder is already linked.
 *      Includes a media-type guard so cross-library mismatches are rejected.
 *   2. Title+year dedup (movies only) — an existing personal item has the same title.
 *
 * Returns the scan outcome for the caller to count.
 */
async function attemptVersionLinkOrCreate(
    sql: postgres.Sql,
    filePath: string,
    parsed: ReturnType<typeof parseMediaFilename>,
    dbMediaType: 'movie' | 'tv',
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
    durationSeconds?: number,
    awaitingProviderMatch?: boolean,
    nfoContent?: LocalNfoContent,
    seriesEvidence: FolderSeriesEvidence = {},
): Promise<'added' | 'updated' | 'skipped' | 'unmatched'> {
    // ALL TV files go through the hierarchy path (series → season → episode).
    // Files with parsed episode numbers use the parsed number; files without
    // get auto-numbered sequentially. This prevents duplicate standalone items
    // for shows where filename parsing can't extract episode info.
    if (dbMediaType === 'tv') {
        // Extract series title from the parent directory structure rather than
        // using the filename (which is the episode title). Walk up from the file
        // to find the series folder — typically the first folder above "Season XX".
        const seriesTitle = extractSeriesTitleFromPath(filePath, libraryPath.path, parsed.title);
        // The series folder's year keeps "Show (2001)" and "Show (2026)"
        // apart when the episode filenames carry no year.
        const seriesYear =
            seriesYearHint(parsed) ?? extractSeriesYearFromPath(filePath, libraryPath.path);
        if (
            seriesYear !== undefined &&
            seriesEvidence.year !== undefined &&
            seriesYear !== seriesEvidence.year
        ) {
            await recordScanIssueWithCooldown(
                sql,
                filePath,
                libraryPath.library_group_id,
                'series_identity_conflict',
                `The series folder year (${seriesYear}) conflicts with the NFO year (${seriesEvidence.year}). Correct the folder or NFO year; the file was left unlinked.`,
            );
            return 'skipped';
        }
        const fileHashHead = await tryHashFileHead(filePath);
        const start = parsed.episodeStart ?? parsed.episode;
        const end = parsed.episodeEnd;
        const isRange = start !== undefined && end !== undefined && end > start;
        const dedicatedPaths: string[] = [];
        if (isRange) {
            const owner =
                (await currentSeriesFolderOwnerId(sql, filePath, libraryPath, seriesYear)) ??
                (await findPersonalMediaItemByTitleYear(sql, seriesTitle, seriesYear, 'tv'));
            const season = resolveSeasonNumber(
                parsed.season,
                extractSeasonNumberFromPath(filePath, libraryPath.path),
                parsed.episodeType,
            );
            if (owner)
                dedicatedPaths.push(
                    ...(await listSeriesFilePaths(sql, owner, {
                        season,
                        start,
                        end,
                    })),
                );
            // Also cover direct siblings before an owner is established. Only
            // dedicated files in this range can affect its link arbitration.
            const siblings = await listDirectChildMediaFilePaths(sql, path.dirname(filePath));
            dedicatedPaths.push(
                ...siblings.filter((candidate) => {
                    const episode = parseMediaFilename(candidate).episode;
                    return (
                        episode !== undefined &&
                        episode >= start &&
                        episode <= end &&
                        isDedicatedEpisodeFile(candidate, episode)
                    );
                }),
            );
        }
        const missingDedicated = new Set<string>();
        for (const candidate of new Set(dedicatedPaths)) {
            if (
                (await assessFilePresence(candidate, { mountRoot: libraryPath.path })) === 'missing'
            )
                missingDedicated.add(candidate);
        }
        const folderIo = { fileHashHead, missingDedicated };
        const renameCandidate = await prepareRenamedPersonalSeries(
            sql,
            filePath,
            seriesTitle,
            libraryPath,
            fileHashHead,
        );
        for (const oldPath of renameCandidate?.oldPaths ?? []) missingDedicated.add(oldPath);
        const ownership = await withSeriesFolderLock(sql, filePath, libraryPath, async (tx) => {
            const finish = async (value: SeriesHierarchyResult): Promise<void> => {
                if (awaitingProviderMatch)
                    await markEpisodesAwaitingProviderMatch(tx, value.seriesId, value.episodeIds);
                if (value.outcome !== 'skipped')
                    await clearFileScanIssue(tx, filePath, [
                        'series_identity_conflict',
                        'series_folder_contention',
                    ]);
            };
            const ownership = await withVerifiedSeriesFolderOwner(
                tx,
                filePath,
                libraryPath,
                { ...seriesEvidence, year: seriesYear ?? seriesEvidence.year },
                (ownerTx, seriesId, recordRangeLinkEvictions) =>
                    findOrCreateSeriesHierarchy(ownerTx, filePath, parsed, context, {
                        year: seriesYear,
                        folderIo,
                        libraryGroupId: libraryPath.library_group_id,
                        libraryRoot: libraryPath.path,
                        seriesTitle,
                        durationSeconds,
                        resolvedSeriesId: seriesId,
                        onAutomaticRangeLinksEvicted: recordRangeLinkEvictions,
                    }),
            );
            if (ownership.kind !== 'none') {
                if (ownership.kind === 'reused') await finish(ownership.value);
                return ownership;
            }
            const renamedSeriesId = await adoptRenamedPersonalSeries(
                tx,
                filePath,
                seriesTitle,
                seriesYear,
                context,
                renameCandidate,
            );
            const value = await findOrCreateSeriesHierarchy(tx, filePath, parsed, context, {
                year: seriesYear,
                folderIo,
                libraryGroupId: libraryPath.library_group_id,
                libraryRoot: libraryPath.path,
                seriesTitle,
                durationSeconds,
                resolvedSeriesId: renamedSeriesId ?? undefined,
            });
            await finish(value);
            return { kind: 'reused' as const, value };
        });
        if (ownership.kind === 'uncertain') {
            const contention = ownership.contention === true;
            await recordScanIssueWithCooldown(
                sql,
                filePath,
                libraryPath.library_group_id,
                contention ? 'series_folder_contention' : 'series_identity_conflict',
                contention
                    ? `Series folder attachment is temporarily busy: ${ownership.reason}. Scans retry automatically; no conflicting series identity was established.`
                    : `Could not verify the series folder owner: ${ownership.reason}. The file was left unlinked to avoid attaching it to the wrong series. Check the folder's series links.`,
            );
            context.logger.warn(
                '[FileScanner] Uncertain current series-folder ownership; leaving episode unlinked',
                { filePath, reason: ownership.reason },
            );
            return 'skipped';
        }
        return ownership.value.outcome;
    }

    // Attempts 1–3 and the create are one check-then-insert. The bulk scan runs
    // up to 8 files at once, so two files with the same parsed title (e.g.
    // "Film (2026) 1080p" and "Film (2026) 2160p HDR", both "Film" once release
    // tags are stripped) could both miss every lookup and each create an item:
    // grouped as versions on one scan, split on the next, depending on slot
    // timing. Serialize them per title so the first creates and the rest find
    // it. (Same-folder files whose titles differ take different locks; that
    // window is unchanged.)
    return withMovieTitleLock(parsed.title, () =>
        linkOrCreateMovie(
            sql,
            filePath,
            parsed,
            dbMediaType,
            libraryPath,
            context,
            durationSeconds,
            awaitingProviderMatch,
            nfoContent,
        ),
    );
}

/**
 * A rename keeps the bytes: the new file must have the size stored for the old
 * one. Backs the 64 KB head hash, which short or templated files can share.
 * An unknown stored size never matches.
 */
async function sameSizeAsStored(filePath: string, storedSize: number | null): Promise<boolean> {
    if (storedSize === null) return false;
    const stat = await safeStat(filePath).catch(() => null);
    return stat !== null && Number(stat.size) === Number(storedSize);
}

/**
 * A provider-less movie whose file was renamed (or moved) since the last scan:
 * the new file carries the head hash of an unmatched single-file movie whose
 * only file is gone from this library. A full scan reaches the new path before
 * it retires the old one, so without this the new path mints a movie and stale
 * cleanup dismisses the old one with the user's watch state, ratings and
 * playlist entries on it. Attach the file to the old movie instead and give it
 * the new name, as the file name is all an unmatched movie's title comes from.
 *
 * Runs only after every provider lookup and version attempt missed: a rename
 * that now matches a provider gets the provider's movie, as before. The old
 * file must be MISSING (not merely unreadable): a copy under another name
 * stays its own movie.
 */
async function reclaimRenamedPersonalMovie(
    sql: postgres.Sql,
    filePath: string,
    parsed: ReturnType<typeof parseMediaFilename>,
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
    year: number | undefined,
    awaitingProviderMatch: boolean | undefined,
): Promise<'added' | 'updated' | null> {
    const fileHashHead = await tryHashFileHead(filePath);
    if (!fileHashHead) return null;
    const match = await findActiveItemByLiveHeadHash(sql, fileHashHead, ['movie']);
    if (!match) return null;
    const itemId = match.media_item_id;
    const oldFiles = await getFilesForMediaItem(sql, itemId);
    if (oldFiles.length !== 1 || oldFiles[0].file_path === filePath) return null;
    const oldPath = oldFiles[0].file_path;
    if (!(await sameSizeAsStored(filePath, oldFiles[0].file_size_bytes))) return null;
    if (!(await filesAllMissingFromLibrary([oldPath], libraryPath.path))) return null;

    const linked = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SET LOCAL lock_timeout = '30s'`;
        // The per-file lock createPersonalMediaItem takes, then the item lock
        // attachFileToItem takes: the same order as the create path. A watcher
        // ingest of this path that got here first has linked it; leave it.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`media-file-link:${filePath}`}))`;
        if (await isFileLinkedToMediaItem(tx, filePath)) return null;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${itemId}))`;
        // Re-check under the attach lock: still the provider-less movie with
        // exactly the file judged missing above. A concurrent copy of the same
        // bytes may have attached first; this one then mints its own movie.
        const [still] = await tx<{ id: string }[]>`
            SELECT mi.id
              FROM media_items mi
             WHERE mi.id = ${itemId}
               AND mi.media_type = 'movie'
               AND mi.status = 'active'
               AND NOT mi.is_dismissed
               AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND source IS DISTINCT FROM 'watch-sync-file')
               AND (SELECT count(*) FROM media_file_items mfi WHERE mfi.media_item_id = mi.id) = 1
               AND EXISTS (
                   SELECT 1 FROM media_file_items mfi
                   JOIN media_files mf ON mf.id = mfi.file_id
                   WHERE mfi.media_item_id = mi.id AND mf.file_path = ${oldPath}
               )
        `;
        if (!still) return null;
        const file = await upsertMediaFile(tx, {
            filePath,
            edition: parsed.edition,
            partNumber: parsed.part,
            libraryGroupId: libraryPath.library_group_id,
            fileHashHead,
        });
        await attachFileToItem(tx, file.id, itemId);
        await tx`
            UPDATE media_items mi
               SET title = CASE WHEN mi.metadata_locked THEN mi.title
                                ELSE COALESCE(NULLIF(${parsed.title ?? ''}, ''), mi.title) END,
                   year = CASE WHEN mi.metadata_locked THEN mi.year
                               ELSE COALESCE(${year ?? null}::int, mi.year) END,
                   custom_metadata = CASE WHEN ${awaitingProviderMatch === true}
                       THEN COALESCE(mi.custom_metadata, '{}'::jsonb)
                            || jsonb_build_object('awaiting_provider_match', true)
                       ELSE mi.custom_metadata END,
                   updated_at = now()
             WHERE mi.id = ${itemId}
        `;
        await refreshSortTitles(tx, [itemId]);
        return file;
    });
    if (!linked) return null;
    if (linked.created) await initFileChangeDetection(sql, linked.id, filePath, fileHashHead);
    if (libraryPath.scan_chapters) await extractChapters(sql, filePath, context, linked.id);
    context.logger.info('[FileScanner] Renamed unmatched movie keeps its item', {
        mediaItemId: itemId,
        newFilePath: filePath,
        previousFilePath: oldPath,
    });
    return linked.created ? 'added' : 'updated';
}

/**
 * A provider-less series whose folder was renamed since the last scan: this
 * episode file carries the head hash of an unmatched episode, and EVERY file of
 * that episode's series is gone from this library. Rename the series to the new
 * folder's title and hand its id to the hierarchy, which then finds the old
 * seasons and episodes by number and adds the new files to them; stale cleanup
 * retires the old files. Without it the scan built a second series and
 * dismissed the old episodes with their watch state.
 *
 * Only the unmatched path calls this, after the provider missed. Declines
 * (null) when the series keeps any file on disk (an episode moved out of a
 * series that stays), when its metadata is locked, or when another series
 * already answers to the new title (the files join that one, as before).
 */
async function prepareRenamedPersonalSeries(
    sql: postgres.Sql,
    filePath: string,
    seriesTitle: string,
    libraryPath: LibraryPathRow,
    fileHashHead: string | undefined,
): Promise<RenamedSeriesCandidate | null> {
    if (!fileHashHead) return null;
    const match = await findActiveItemByLiveHeadHash(sql, fileHashHead, ['episode']);
    if (!match) return null;
    const episodeFiles = await getFilesForMediaItem(sql, match.media_item_id);
    if (episodeFiles.length !== 1) return null;
    if (!(await sameSizeAsStored(filePath, episodeFiles[0].file_size_bytes))) return null;
    const series = await findPersonalSeriesOfEpisode(sql, match.media_item_id, 'tv');
    if (!series || series.metadata_locked) return null;
    const normalize = (t: string): string => t.toLowerCase().trim();
    if (normalize(series.title) === normalize(seriesTitle)) return null;
    const oldPaths = await listSeriesFilePaths(sql, series.id);
    if (oldPaths.includes(filePath)) return null;
    if (!(await filesAllMissingFromLibrary(oldPaths, libraryPath.path))) return null;

    return { series, oldPaths, episodeId: match.media_item_id, fileHashHead };
}

interface RenamedSeriesCandidate {
    series: { id: string; title: string };
    oldPaths: string[];
    episodeId: string;
    fileHashHead: string;
}

async function adoptRenamedPersonalSeries(
    sql: postgres.Sql,
    filePath: string,
    seriesTitle: string,
    year: number | undefined,
    context: FileScannerContext,
    candidate: RenamedSeriesCandidate | null,
): Promise<string | null> {
    if (!candidate) return null;
    // Hashing and the mount-aware preflight ran before BEGIN. Recheck the
    // identity evidence and old-file absence before mutating the title.
    const match = await findActiveItemByLiveHeadHash(sql, candidate.fileHashHead, ['episode']);
    if (match?.media_item_id !== candidate.episodeId) return null;
    const series = await findPersonalSeriesOfEpisode(sql, candidate.episodeId, 'tv');
    if (
        !series ||
        series.metadata_locked ||
        series.id !== candidate.series.id ||
        series.title !== candidate.series.title
    )
        return null;
    const oldPaths = await listSeriesFilePaths(sql, series.id);
    if (JSON.stringify([...oldPaths].sort()) !== JSON.stringify([...candidate.oldPaths].sort()))
        return null;
    // A file may have reappeared while we waited for the folder lock. One
    // bounded stat per old path is enough here; unreadable/timeout evidence
    // cannot establish absence and must decline the rename.
    for (const oldPath of oldPaths) {
        try {
            await safeStat(oldPath);
            return null;
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
        }
    }
    const seriesId = await renamePersonalSeries(sql, {
        seriesId: series.id,
        title: seriesTitle,
        year,
        mediaType: 'tv',
    });
    if (seriesId) {
        context.logger.info('[FileScanner] Renamed unmatched series folder keeps its series', {
            seriesId,
            previousTitle: series.title,
            title: seriesTitle,
            filePath,
        });
    }
    return seriesId;
}

/**
 * In-process mutex per movie title, keyed on the normalization
 * findPersonalMediaItemByTitleYear compares on (titles it can't compare fall
 * back to their own lowercase text, so they don't all share one key). It closes
 * the race between the concurrent slots of one scan — the case that made
 * grouping flip between installs. It does not cover a different replica
 * creating the same title at the same moment (e.g. a watcher ingest there
 * during a bulk scan here); that needs a DB-level lock and stays open.
 */
const movieTitleLocks = new Map<string, Promise<unknown>>();

async function withMovieTitleLock<T>(title: string, fn: () => Promise<T>): Promise<T> {
    const key = normalizeTitleForVersionDedupe(title) ?? `raw:${title.toLowerCase().trim()}`;
    const previous = movieTitleLocks.get(key) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const tail = current.catch(() => undefined);
    movieTitleLocks.set(key, tail);
    try {
        return await current;
    } finally {
        if (movieTitleLocks.get(key) === tail) movieTitleLocks.delete(key);
    }
}

/**
 * Whether `folderPath` is the movie folder of `folderItem` (the item that
 * already owns a file there), so a new unmatched file in it is a version of
 * that movie: the file carries the item's title, or the folder does (by title,
 * or by year when the item is dated and the file carries no year of its own,
 * which covers a provider title in another language than the folder name).
 * "Home Videos/" and "Movies 2020/" name none of their movies.
 */
function folderNamesMovie(
    folderPath: string,
    parsed: ReturnType<typeof parseMediaFilename>,
    folderItem: { title: string | null; year: number | null },
): boolean {
    const itemTitle = folderItem.title ? normalizeTitleForVersionDedupe(folderItem.title) : null;
    const fileTitle = parsed.title ? normalizeTitleForVersionDedupe(parsed.title) : null;
    if (itemTitle && fileTitle && itemTitle === fileTitle) return true;
    const folder = parseMediaFilename(folderPath);
    const folderTitle = folder.title ? normalizeTitleForVersionDedupe(folder.title) : null;
    if (itemTitle && folderTitle && itemTitle === folderTitle) return true;
    // A file with its own year and another title names its own movie
    // ("Movies 2020/Bravo (2020).mkv"), whatever the folder's year says.
    if (parsed.year !== undefined) return false;
    return folder.year !== undefined && folderItem.year !== null && folder.year === folderItem.year;
}

async function linkOrCreateMovie(
    sql: postgres.Sql,
    filePath: string,
    parsed: ReturnType<typeof parseMediaFilename>,
    dbMediaType: 'movie',
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
    durationSeconds?: number,
    awaitingProviderMatch?: boolean,
    nfoContent?: LocalNfoContent,
): Promise<'added' | 'updated' | 'skipped' | 'unmatched'> {
    // Attempt 1: another file in the same folder is already linked to a media_item.
    // Only the movie's OWN folder makes its files versions of one movie. The
    // library root (a flat movies folder) and a shared folder ("Home Videos/")
    // hold different movies: linking there made every unmatched movie a
    // "version" of whichever one was ingested first.
    const folderPath = path.dirname(filePath);
    const isLibraryRoot = path.resolve(folderPath) === path.resolve(libraryPath.path);
    const folderItemId = isLibraryRoot ? null : await findParentMediaItemByFolder(sql, folderPath);
    if (folderItemId) {
        const folderItem = await getMediaItemTypeTitleYear(sql, folderItemId);
        // Guard: only link when media types match (avoids cross-library false positives)
        if (
            folderItem?.media_type === dbMediaType &&
            folderNamesMovie(folderPath, parsed, folderItem)
        ) {
            return linkAsVersion(sql, filePath, folderItemId, parsed, libraryPath, context);
        }
    }

    // Attempt 2: a personal media_item with the same title+year already exists.
    if (parsed.title && parsed.season === undefined) {
        const dupItemId = await findPersonalMediaItemByTitleYear(
            sql,
            parsed.title,
            parsed.year,
            dbMediaType,
        );
        if (dupItemId) {
            return linkAsVersion(sql, filePath, dupItemId, parsed, libraryPath, context);
        }
    }

    // Attempt 3 (movies): adopt a pre-existing file-less metadata row (a Jellyfin
    // metadata-only import or a discovery row) with the same title+year before
    // spawning a bare personal-media duplicate. This is the no-provider-id
    // analogue of the matched-path adoption (resolveOrCreateMediaItem step 2c) —
    // it closes the duplicate-row window for local movies that aren't in TMDB
    // (fan edits, parodies, home movies) but were already imported metadata-only
    // via Jellyfin. Conservative: concrete year + exact normalized title, single
    // unambiguous match only. Prefer the NFO year (authoritative sidecar).
    const adoptYear = nfoContent?.year ?? parsed.year;
    if (
        dbMediaType === 'movie' &&
        parsed.title &&
        parsed.season === undefined &&
        adoptYear !== undefined &&
        adoptYear > 0
    ) {
        const adopted = await findAdoptableDiscoveryRowByTitle(sql, {
            title: parsed.title,
            year: adoptYear,
            mediaType: dbMediaType,
            providers: ['tmdb', 'imdb', 'tvdb', 'jellyfin'],
        });
        if (adopted) {
            const fileHashHead = await tryHashFileHead(filePath);
            const { id: fileId, created } = await upsertMediaFile(sql, {
                filePath,
                edition: parsed.edition,
                partNumber: parsed.part,
                libraryGroupId: libraryPath.library_group_id,
                fileHashHead,
            });
            await attachFile(sql, fileId, adopted);
            if (created) await initFileChangeDetection(sql, fileId, filePath, fileHashHead);
            // Backfill the NFO description if the adopted row has none (a Jellyfin
            // import usually already carries the plot as overview; a bare discovery
            // row may not).
            if (nfoContent) await backfillLocalMediaContent(sql, adopted, nfoContent);
            context.logger.info(
                '[FileScanner] Adopted file-less metadata row for local movie (no provider id)',
                { adopted, title: parsed.title, year: adoptYear },
            );
            return created ? 'added' : 'updated';
        }
    }

    // Attempt 4: the file is an unmatched movie renamed since the last scan.
    const renamed = await reclaimRenamedPersonalMovie(
        sql,
        filePath,
        parsed,
        libraryPath,
        context,
        nfoContent?.year ?? parsed.year,
        awaitingProviderMatch,
    );
    if (renamed) return renamed;

    // No version match — create as personal media (playable immediately, no external IDs)
    return createPersonalMediaItem(
        sql,
        filePath,
        parsed,
        dbMediaType,
        parsed.year,
        libraryPath.library_group_id,
        durationSeconds,
        awaitingProviderMatch,
        nfoContent,
    );
}

/**
 * Restore a hand-made file → episode link set on a renamed or moved file
 * (manual-file-links.service.ts). True when the file is now linked.
 */
async function tryRestoreManualLinks(
    sql: postgres.Sql,
    filePath: string,
    parsed: ReturnType<typeof parseMediaFilename>,
    libraryPath: LibraryPathRow,
    probedDurationSeconds: number | null,
    context: FileScannerContext,
): Promise<boolean> {
    let contentHash: string;
    try {
        contentHash = await hashFileHead(filePath);
    } catch {
        return false;
    }
    const st = await safeStat(filePath).catch(() => null);
    if (!st) return false;
    const outcome = await restoreManualLinksForNewFile(
        sql,
        {
            filePath,
            contentHash,
            sizeBytes: st.size,
            durationMs:
                probedDurationSeconds !== null && probedDurationSeconds > 0
                    ? Math.round(probedDurationSeconds * 1000)
                    : null,
        },
        async (tx) =>
            (
                await upsertMediaFile(tx, {
                    filePath,
                    edition: parsed.edition,
                    partNumber: parsed.part,
                    absoluteEpisode: parsed.absoluteEpisode ?? null,
                    libraryGroupId: libraryPath.library_group_id,
                })
            ).id,
    );
    if (outcome.restored) {
        context.logger.info('[FileScanner] Restored a hand-made episode link set on a moved file', {
            filePath,
            mediaItemIds: outcome.mediaItemIds,
        });
        return true;
    }
    if (outcome.reason !== 'no remembered set') {
        context.logger.info('[FileScanner] Hand-made episode link set not restored', {
            filePath,
            reason: outcome.reason,
        });
    }
    return false;
}

/**
 * Bug #3 (rename reconnect-by-hash).
 *
 * Look for a recently soft-dismissed media_item whose previously-linked file
 * shared the new file's 64KB head hash. When found, this is almost certainly
 * a rename (native watcher fires unlink+add, which earlier deleted the file row
 * and soft-dismissed the item) — reattach the new file to the original
 * media_item so user state (ratings, watch history, playlists, coverage
 * rows) is preserved instead of stranded on the dismissed UUID.
 *
 * Returns reclaimed, deferred (skip this scan), or null (normal matching).
 * Transient uncertainty gets three attempts to preserve the dismissed UUID,
 * then normal matching resumes so a permanently uncertain file can be linked.
 *
 * The hash computation is delegated to `hashFileHead` (same helper used by
 * `change-detection.ts`); on hash-failure (e.g. a transient read error) we
 * return null and let normal processing proceed.
 */
async function tryReclaimByHash(
    sql: postgres.Sql,
    filePath: string,
    parsed: ReturnType<typeof parseMediaFilename>,
    libraryPath: LibraryPathRow,
    dbMediaType: 'movie' | 'tv',
    context: FileScannerContext,
): Promise<'reclaimed' | 'deferred' | null> {
    let contentHash: string;
    try {
        contentHash = await hashFileHead(filePath);
    } catch (err) {
        context.logger.debug('[FileScanner] Reclaim-by-hash: head hash failed; skipping reclaim', {
            filePath,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }

    const candidate: ReclaimCandidate | null = await findReclaimableByHash(sql, contentHash);
    if (!candidate) return null;

    const refuse = async (reason: string): Promise<null> => {
        await clearHashReclaimDeferral(sql, candidate.media_item_id, contentHash);
        context.logger.info('[FileScanner] Hash reclaim refused', {
            filePath,
            mediaItemId: candidate.media_item_id,
            reason,
        });
        return null;
    };
    const defer = async (reason: string): Promise<'deferred' | null> => {
        if (!(await deferHashReclaim(sql, candidate.media_item_id, contentHash)))
            return refuse(`deferral budget exhausted: ${reason}`);
        context.logger.warn('[FileScanner] Hash reclaim deferred', {
            filePath,
            mediaItemId: candidate.media_item_id,
            reason,
        });
        return 'deferred';
    };

    // A cross-library move can reclassify the same bytes (episode -> movie).
    // Reclaim preserves rename state only when the destination produces the same kind.
    if (dbMediaType === 'tv' ? !isEpisode(candidate.media_type) : !isMovie(candidate.media_type)) {
        return refuse('destination media type differs');
    }
    // Renaming can correct a wrong episode link; the new numbers must win over the hash.
    // Only stored numbers can contradict the new name: a candidate without a stored
    // season or episode (e.g. an absolute-numbered anime row) has nothing to disagree
    // with, so it is reclaimed like any other rename.
    const episodeStart = parsed.episodeStart ?? parsed.episode;
    if (
        isEpisode(candidate.media_type) &&
        parsed.season !== undefined &&
        episodeStart !== undefined &&
        candidate.season_number !== null &&
        candidate.episode_number !== null &&
        (candidate.season_number !== parsed.season ||
            candidate.episode_number < episodeStart ||
            candidate.episode_number > (parsed.episodeEnd ?? episodeStart))
    ) {
        return refuse('episode numbers differ');
    }
    // Explicit path IDs override a hash match when the old identity disagrees.
    // Episodes compare against their series IDs, not episode-scoped provider IDs;
    // a missing ID is not a conflict, so ordinary renames still reconnect.
    if (
        candidate.external_ids.some((id) => {
            const explicitId = id.provider === 'tmdb' ? parsed.tmdbId : parsed.imdbId;
            return explicitId !== undefined && explicitId !== id.external_id;
        })
    ) {
        return refuse('explicit provider identity differs');
    }

    // Reattach atomically: create/upsert the new media_files row for the
    // current path, link it to the resurrected media_item, un-dismiss the
    // item, and stamp library_added_at via attachFile so the item resurfaces
    // in Recently Added.
    const reattach = async (tx: postgres.Sql): Promise<void> => {
        const { id: fileId, created } = await upsertMediaFile(tx, {
            filePath,
            edition: parsed.edition,
            partNumber: parsed.part,
            absoluteEpisode: parsed.absoluteEpisode ?? null,
            libraryGroupId: libraryPath.library_group_id,
        });
        await attachFileToItem(tx, fileId, candidate.media_item_id);
        await touchLibraryAddedAt(
            tx,
            candidate.media_item_id,
            config.RECENTLY_ADDED_PROPAGATE_TO_SERIES,
        );
        await undismissMediaItem(tx, candidate.media_item_id);
        // Store the head hash on the new file row immediately — without this
        // a follow-up rename in the same window would not find this item
        // because `findReclaimableByHash` joins on file_hash_head.
        await tx`
            UPDATE media_files
               SET file_hash_head = ${contentHash},
                   updated_at = NOW()
             WHERE id = ${fileId}
        `;
        // initFileChangeDetection inside the tx would re-stat the file and
        // re-hash; we already have the hash. Just stamp it directly.
        void created;
    };

    let attached = false;
    if (isEpisode(candidate.media_type)) {
        // A dismissed episode may have no series parent. That only prevents
        // reclaim when the destination has an owner to compare against (the
        // verified callback below); without witnesses, keep the hash match.
        const evidence = {
            imdbId: parsed.imdbId,
            tmdbId: parsed.tmdbId,
            year: seriesYearHint(parsed) ?? extractSeriesYearFromPath(filePath, libraryPath.path),
        };
        // Ordinary mass renames preserve the same series. Check equality in
        // one unlocked query before taking the cross-series witness fence;
        // otherwise every episode locks/stats all siblings (quadratic work).
        const owner = await currentSeriesFolderOwnerId(sql, filePath, libraryPath, evidence.year);
        if (owner && owner === candidate.series_id) {
            attached = await withTx(sql, async (tx) => {
                const current = await findReclaimableByHash(tx, contentHash);
                if (
                    current?.media_item_id !== candidate.media_item_id ||
                    current.series_id !== owner
                )
                    return false;
                await reattach(tx);
                return true;
            });
            if (!attached) return defer('hash candidate changed during reclaim');
        } else {
            // Unknown/different destination ownership still needs verified
            // witnesses. Durable conflicts must try normal matching immediately.
            const ownership = await withVerifiedSeriesFolderOwner(
                sql,
                filePath,
                libraryPath,
                evidence,
                async (tx, seriesId) => {
                    const current = await findReclaimableByHash(tx, contentHash);
                    if (current?.media_item_id !== candidate.media_item_id) return 'changed';
                    if (!current.series_id) return 'unknown';
                    if (current.series_id !== seriesId) return 'mismatch';
                    await reattach(tx);
                    return 'attached';
                },
            );
            if (ownership.kind === 'uncertain')
                return ownership.retryable ? defer(ownership.reason) : refuse(ownership.reason);
            if (ownership.kind === 'reused') {
                if (ownership.value === 'unknown') return refuse('candidate series is unknown');
                if (ownership.value === 'changed')
                    return defer('hash candidate changed during reclaim');
                if (ownership.value === 'mismatch')
                    return refuse('destination belongs to another series');
                attached = true;
            }
        }
    }
    if (!attached) await withTx(sql, reattach);

    context.logger.info(
        '[FileScanner] Reclaimed soft-dismissed item via hash match (bug #3 rename reconnect)',
        {
            mediaItemId: candidate.media_item_id,
            newFilePath: filePath,
            contentHashPrefix: contentHash.slice(0, 12),
        },
    );

    // Fire-and-forget lifecycle hook to re-seed coverage rows. Same pattern
    // as afterMatched call sites — dev re-raises, prod logs and continues.
    MediaLifecycleService.afterReclaimed(candidate.media_item_id, sql).catch((err: unknown) => {
        if (process.env.NODE_ENV !== 'production') throw err;
        context.logger.warn('[FileScanner] afterReclaimed enqueue failed', {
            mediaItemId: candidate.media_item_id,
            error: err instanceof Error ? err.message : String(err),
        });
    });

    return 'reclaimed';
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Process a single media file: match → write media_files + media_file_items.
 *
 * S2: Accepts an optional `abortSignal` so callers can cancel mid-probe.
 * ffprobe honors the signal via `child_process.execFile({ signal })`, so a
 * slow NFS mount doesn't keep the scanner locked up for 15s after the admin
 * clicks cancel. Provider HTTP calls do NOT yet honor the signal — see
 * resolveOrCreateMediaItem for details.
 */
export async function processVideoFile(
    sql: postgres.Sql,
    filePath: string,
    libraryPath: LibraryPathRow,
    providerIds: string[],
    context: FileScannerContext,
    knownFiles?: Map<string, KnownFileRow>,
    abortSignal?: AbortSignal,
    searchCache?: MetadataSearchCache,
    hasReclaimCandidates: boolean = true,
    seriesIdCache?: SeriesIdCache,
    seasonIdCache?: SeasonIdCache,
    seriesSideEffectsDone?: Set<string>,
    onError?: (reason: string) => void,
    identityWrites?: SeriesIdentityWriteState,
): Promise<'added' | 'updated' | 'skipped' | 'unmatched' | 'error'> {
    const rematch: AwaitingRematch = { itemIds: [] };
    // The provider-rematch claim reserves a connection. Keep a per-file
    // context so helpers that use context.sql follow that same connection
    // without mutating the shared scan context used by concurrent files.
    const fileContext = { ...context };
    // The file as it was before anything below read it (probe, tags, hash).
    const before = await safeStat(filePath).catch(() => null);
    let outcome: Awaited<ReturnType<typeof processVideoFileInner>>;
    try {
        outcome = await processVideoFileInner(
            sql,
            filePath,
            libraryPath,
            providerIds,
            fileContext,
            rematch,
            knownFiles,
            abortSignal,
            searchCache,
            hasReclaimCandidates,
            seriesIdCache,
            seasonIdCache,
            seriesSideEffectsDone,
            onError,
            identityWrites,
        );
        if (outcome === 'added' || outcome === 'updated') {
            await clearFileScanIssue(rematch.claim?.sql ?? sql, filePath, [
                'series_identity_conflict',
                'series_folder_contention',
            ]);
        }
        if (rematch.itemIds.length > 0) {
            await settleAwaitingRematch(rematch.claim?.sql ?? sql, rematch, context, filePath);
        }
    } catch (err) {
        if (!(err instanceof IdentityConflictError)) throw err;
        // Not linked on purpose. Record it on the file's stub row so it shows on
        // the Ingest Map instead of only in the run's error list; every scan
        // retries it, and fixing the series' ids or the folder tag clears it.
        const movie = err.issueType === 'movie_identity_conflict';
        const reason = `${err.message}. The file was not linked so it cannot land on the wrong ${movie ? 'movie' : 'series'}. Check the ${movie ? "movie's" : "series'"} provider IDs, or the ID tag in the folder name.`;
        await recordScanIssueWithCooldown(
            rematch.claim?.sql ?? sql,
            filePath,
            libraryPath.library_group_id,
            err.issueType,
            reason,
        );
        context.logger.warn('[FileScanner] Series identity conflict; recorded as scan issue', {
            filePath,
            error: err.message,
        });
        onError?.(reason);
        return 'error';
    } finally {
        try {
            await rematch.claim?.release();
        } catch (err) {
            context.logger.warn('[FileScanner] Failed to release personal-media rematch claim', {
                filePath,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    // A multi-episode file linked again (a covering file went away) drops its
    // `range_superseded` verdict, whichever path linked it. One statement that
    // matches nothing unless the row is linked and still carries the verdict.
    if (!isMusic(libraryPath.media_type) && outcome !== 'error') {
        await clearRangeSupersededIfLinked(sql, filePath);
    }
    // Every outcome: a probe or tag read can end as 'skipped' or 'error' too.
    if (before) await keepProbedStatIfFileMoved(sql, filePath, before, context);
    return outcome;
}

/**
 * A file that changed while it was processed (still being copied) keeps the
 * stat it had when processing began, so the next scan reads it again — see
 * {@link keepProbedFileStat}. A scan has no settle delay of its own.
 */
async function keepProbedStatIfFileMoved(
    sql: postgres.Sql,
    filePath: string,
    before: { mtime: Date; mtimeMs: number; size: number },
    context: FileScannerContext,
): Promise<void> {
    const after = await safeStat(filePath).catch(() => null);
    if (!after) return;
    if (after.size === before.size && Math.abs(after.mtimeMs - before.mtimeMs) <= 1000) return;
    if (await keepProbedFileStat(sql, filePath, { mtime: before.mtime, size: before.size })) {
        context.logger.info(
            '[FileScanner] File changed while it was scanned (still being copied?) — it is read again next scan',
            { filePath, sizeBefore: before.size, sizeAfter: after.size },
        );
    }
}

/**
 * Finish an awaiting_provider_match rematch (see the unchanged branch of
 * processVideoFileInner). The file stayed linked to its awaiting item(s) while
 * matching ran:
 *   - it now ALSO sits on an item it wasn't on before → the match found its real home: drop
 *     the awaiting links (detachAndClear… soft-dismisses an item left with no
 *     files, keeping its user data, exactly as before);
 *   - otherwise → no better home; keep the item, and clear the flag only when
 *     a provider answered with a definitive "no match".
 */
async function settleAwaitingRematch(
    sql: postgres.Sql,
    rematch: AwaitingRematch,
    context: FileScannerContext,
    filePath: string,
): Promise<void> {
    if (!rematch.fileId) return;
    const linked = await findAllLinkedMediaItemsByFilePath(sql, filePath);
    const before = new Set(rematch.linkedBefore ?? rematch.itemIds);
    if (linked.some((id) => !before.has(id))) {
        await detachAndClearAwaitingMatchForFile(sql, rematch.fileId);
        context.logger.info('[FileScanner] Awaiting file re-identified; released its old item', {
            filePath,
            previousItemIds: rematch.itemIds,
        });
    } else if (!rematch.stillAwaiting) {
        await clearAwaitingMatchFlag(sql, rematch.itemIds);
    }
}

async function processVideoFileInner(
    sql: postgres.Sql,
    filePath: string,
    libraryPath: LibraryPathRow,
    providerIds: string[],
    context: FileScannerContext,
    /** Filled by the unchanged branch when an awaiting file is re-matched. */
    rematch: AwaitingRematch,
    knownFiles?: Map<string, KnownFileRow>,
    abortSignal?: AbortSignal,
    searchCache?: MetadataSearchCache,
    /**
     * S6: When false, skip tryReclaimByHash entirely.
     * Pass false on a fresh install or when no dismissed content exists under
     * this library path — saves ~25 GB of head reads + 400k SELECTs at 400k
     * files. When undefined (watcher path, per-item triggers) defaults to true
     * so the conservative reclaim behavior is preserved.
     */
    hasReclaimCandidates: boolean = true,
    /**
     * Per-path series UUID cache keyed by title, year, namespace and supported
     * identity evidence. Hits skip the advisory-locked resolver.
     */
    seriesIdCache?: SeriesIdCache,
    /**
     * S5: Per-path season UUID cache. Maps `${seriesId}:${seasonNumber}` to
     * the season media_item UUID after findOrCreatePersonalSeason resolves it.
     */
    seasonIdCache?: SeasonIdCache,
    /**
     * Per-scan UUIDs whose completed file outcomes announced a series match.
     * Identity enrichment uses separate serialized mapping state.
     */
    seriesSideEffectsDone?: Set<string>,
    /**
     * Fix plan 6 follow-up: every 'error' return below already knows a
     * specific, human-readable reason (mangled filename, ffprobe failure,
     * permission denied, ...) from the WARN it logs right beside the return.
     * Without this callback that reason never left the function — the caller
     * only saw the bare 'error' outcome and recorded a generic
     * "file processing failed" string in the run's error_samples, which is
     * useless for anyone trying to diagnose e.g. the German-umlaut/non-UTF-8
     * filename case. Optional and additive: the outcome contract is
     * unchanged, so existing callers/tests that only check the return value
     * keep working; a caller that wants the detail passes this and reads it
     * after an 'error' outcome.
     */
    onError?: (reason: string) => void,
    identityWrites?: SeriesIdentityWriteState,
): Promise<'added' | 'updated' | 'skipped' | 'unmatched' | 'error'> {
    if (abortSignal?.aborted) return 'skipped';

    // Control-character filename guard (P1) — applies to BOTH music and
    // video, same shared entry point as the mangled-filename guard below.
    // Shares `hasControlChars()` with the upload `init.ts` zod schema and
    // `writeConcatTmpFile` (playback.service.ts): a filename containing a
    // raw C0 control byte or DEL must never reach the ffmpeg concat list
    // writer, which joins one `file '<path>'` directive per line under
    // `-f concat -safe 0` — an embedded newline there splits the list into
    // an attacker-influenced extra directive. Unlike the mangled-filename
    // case, no legitimate filename contains one, so this is an
    // unconditional skip (no openable() fallback).
    if (hasControlChars(filePath)) {
        await recordScanIssueWithCooldown(
            sql,
            filePath,
            libraryPath.library_group_id,
            'unsafe_filename',
            'Filename contains a control character (e.g. a newline). Rename the file to remove it so it can be ingested.',
        );
        context.logger.warn(
            '[FileScanner] Skipping file — filename contains a control character; recorded as scan issue',
            { filePath },
        );
        onError?.(
            'Filename contains a control character (e.g. a newline). Rename the file to remove it so it can be ingested.',
        );
        return 'error';
    }

    // Mangled (non-UTF-8) filename guard — applies to BOTH music and video,
    // and to both the bulk scan and the watcher's single-file ingest (this is
    // the shared entry point for all of them). When a file's on-disk name isn't
    // valid UTF-8, `fs.readdir` substitutes U+FFFD replacement characters, so
    // the path we hold can never re-open the real file: probe, track creation,
    // and linking all ENOENT and the item silently disappears from the library
    // (observed on prod with Latin-1-named music files). Detect it up front,
    // record a visible, actionable scan issue (surfaced in the Ingest Map), and
    // skip. The stub row is removed by stale-file cleanup once the file is
    // renamed to valid UTF-8 — the mangled path goes missing and the fixed name
    // scans in fresh.
    if (isMangledFilename(filePath)) {
        // A valid, UTF-8 filename could legitimately contain a literal U+FFFD,
        // in which case fs.open on this exact path still works. Only treat the
        // path as mangled — i.e. the byte-decode artifact — when the file can't
        // actually be stat'd; otherwise fall through and process it normally.
        const openable = await safeStat(filePath).then(
            () => true,
            () => false,
        );
        if (!openable) {
            // Honor the same backoff cooldown as the tag-parse path so we don't
            // rewrite the issue (and bump attempt_count) on every scan while the
            // file stays broken. First detection and post-backoff passes still
            // (re)record it.
            const cooldown = await getFileScanRetryAt(sql, filePath);
            if (!cooldown || cooldown.retryAt.getTime() <= Date.now()) {
                await recordFileScanIssue(sql, {
                    filePath,
                    libraryGroupId: libraryPath.library_group_id,
                    type: 'filename_not_utf8',
                    detail: 'Filename is not valid UTF-8 (contains U+FFFD replacement characters). Rename the file to UTF-8 so it can be ingested.',
                });
            }
            context.logger.warn(
                '[FileScanner] Skipping file — filename is not valid UTF-8; recorded as scan issue',
                { filePath },
            );
            onError?.(
                'filename is not valid UTF-8 (contains U+FFFD replacement characters) — rename the file to UTF-8 so it can be ingested',
            );
            return 'error';
        }
    }

    // Audio files — only process in music libraries.
    // Audio files in non-music libraries (e.g. TV theme.mp3) are skipped.
    const fileExt = path.extname(filePath).toLowerCase();
    if (isMusic(libraryPath.media_type)) {
        const audioOutcome = await processAudioFile(
            sql,
            filePath,
            libraryPath,
            context,
            abortSignal,
            knownFiles,
        );
        if (audioOutcome === 'error') {
            onError?.(
                'audio tag/probe processing failed — see server logs for the underlying error',
            );
            return 'error';
        }
        return audioOutcome;
    }
    if (isAudioFile(fileExt)) {
        return 'skipped';
    }

    // Extras (named subfolder or filename-suffix, e.g. `trailers/Film-trailer.mkv`
    // or `Film-trailer.mkv` beside the movie) must never be processed here as a
    // primary video/version — even when `filePath` reaches this function via a
    // candidate source that doesn't already exclude extras itself (the bulk
    // scan's disk walk and `triageFiles` both guard this too, but the watcher's
    // `ingestSingleFile` and any future per-item retry path do not). This
    // matters most for a DB-known-but-unlinked extras row (e.g. left behind by
    // a junction-row repair — see reconcile-series-fix-report.md): without this
    // guard, `existingFileBlock` below would treat "unlinked" as "needs its
    // link recreated" and re-attach the extra to the folder's primary item as a
    // version. Leave it for the dedicated `walkExtras` → `processExtra` pass,
    // which has the folder-listing context to attach it correctly.
    if (isExtrasFilePath(filePath, libraryPath.path)) {
        return 'skipped';
    }

    const dbMediaType = toDbMediaType(libraryPath.media_type);

    // S10: Parse once at the top and reuse across all branches (range check,
    // reclaim, non-entertainment, main path). Pure CPU — no I/O.
    // Daily-show air dates are a TV naming scheme; elsewhere a date belongs to
    // the name ("Birthday 2015_06_12").
    const parsed = parseMediaFilename(filePath, { airDates: dbMediaType === 'tv' });
    // A "Part N" counts only when the folder holds the other parts — otherwise
    // it is the title ("Deathly Hallows Part 1"). One readdir, only for files
    // whose name carries a part token.
    const stack = await confirmStackedPart(filePath, parsed.part);
    parsed.part = stack.part;
    if (stack.siblings.length > 0) await backfillSiblingParts(sql, stack.siblings);

    // Check if file is already known — use in-memory cache when available
    const existingFile = knownFiles
        ? (knownFiles.get(filePath) ?? null)
        : await findMediaFileByPath(sql, filePath);
    if (existingFile) {
        if (existingFile.is_missing) await restoreScannedFile(sql, existingFile.id, filePath);
        // Compared with the value the row already carries (the bulk load and
        // findMediaFileByPath select it), so an unchanged file costs no
        // round-trip. A row that does not carry the column (undefined) is only
        // written when the name has a number.
        const wanted = parsed.absoluteEpisode ?? null;
        const stored = existingFile.absolute_episode;
        if (stored === undefined ? wanted !== null : stored !== wanted) {
            await setAbsoluteEpisodeIfChanged(sql, existingFile.id, wanted);
            existingFile.absolute_episode = wanted;
        }
    }
    if (existingFile && libraryPath.scan_chapters) {
        // File-scoped catch-up also works for an unlinked warning stub; it
        // never assigns episode identity or overwrites manual windows.
        if (!existingFile.file_mtime || existingFile.file_size_bytes === null) {
            await initFileChangeDetection(sql, existingFile.id, filePath);
        }
        await extractChapters(sql, filePath, context, existingFile.id);
    }
    const descendingRange =
        dbMediaType === 'tv' &&
        parsed.episodeStart !== undefined &&
        parsed.episodeEnd !== undefined &&
        parsed.episodeEnd < parsed.episodeStart &&
        (!existingFile || !(await isManuallyLinkedFile(sql, existingFile.id)));
    const warnDescendingRange = async (): Promise<void> => {
        await clearRangeSupersededIfLinked(sql, filePath, true);
        await recordScanIssueWithCooldown(
            sql,
            filePath,
            libraryPath.library_group_id,
            'episode_number_unparsed',
            `The filename has a descending episode range (${parsed.episodeStart}-${parsed.episodeEnd}). Review its episode order manually before linking it.`,
        );
    };
    if (descendingRange && existingFile) await warnDescendingRange();
    existingFileBlock: if (existingFile) {
        // If the file has no linked media_item, skip change detection and fall
        // through to the new-file path to (re-)create the media_item link.
        // is_linked is pre-computed by loadMediaFilesByPrefix (bulk path);
        // undefined = fallback per-file path — query DB directly.
        const isLinked =
            existingFile.is_linked !== undefined
                ? existingFile.is_linked
                : await isFileLinkedToMediaItem(sql, filePath);

        if (!isLinked) {
            // File known in media_files but has no media_item link.
            // Fall through to new-file processing below to recreate the link.
        } else {
            // Range-aware link check for multi-episode files (e.g. S01E01E02.mkv).
            // isLinked=true only means the file is linked to SOME episode. For a
            // combined file, ep_start may be linked while ep_end is not — the plain
            // boolean short-circuit would permanently skip creating ep_end's link.
            // Use the top-level parsed result (S10 — already computed above).
            // For multi-episode files only, verify every episode in
            // [episodeStart..episodeEnd] is linked. If any is missing, break out
            // of existingFileBlock so the normal findOrCreateSeriesHierarchy path
            // runs and creates the missing link(s). attachFileToItem is idempotent
            // (ON CONFLICT DO NOTHING), so re-attaching ep_start is a no-op while
            // ep_end gets created. Single-episode files are unaffected.
            {
                const parsedForRangeCheck = parsed;
                const epStart = parsedForRangeCheck.episodeStart ?? parsedForRangeCheck.episode;
                const epEnd = parsedForRangeCheck.episodeEnd;
                // An admin linked this file to its episodes by hand (the
                // file-episodes editor): the name's range is what was wrong, so
                // re-creating its "missing" links would undo the fix.
                if (
                    epStart !== undefined &&
                    epEnd !== undefined &&
                    epEnd > epStart &&
                    !(await isManuallyLinkedFile(sql, existingFile.id))
                ) {
                    const seasonNumber =
                        parsedForRangeCheck.season !== undefined
                            ? parsedForRangeCheck.season
                            : parsedForRangeCheck.episodeType === 'special' ||
                                parsedForRangeCheck.episodeType === 'ova' ||
                                parsedForRangeCheck.episodeType === 'ona'
                              ? 0
                              : 1;
                    const linkedEpNums = await getLinkedEpisodeNumbersForFile(
                        sql,
                        existingFile.id,
                        seasonNumber,
                    );
                    // A season resolved from the file's own path, so the
                    // dedicated-file lookup below can be scoped without
                    // re-running hierarchy creation.
                    const seasonIdForFile = await findSeasonIdForLinkedFile(
                        sql,
                        existingFile.id,
                        seasonNumber,
                    );
                    // Links that a dedicated file of the same episode supersedes
                    // (a double link left by a scan race or an older scan) are
                    // only evicted by the hierarchy path: stop here so it runs.
                    // A link with a segment window is never evicted, so it does
                    // not count — the file stays a no-op for it.
                    const unsegmentedEpNums = await findUnsegmentedLinkEpisodesForFile(
                        sql,
                        existingFile.id,
                    );
                    for (let ep = epStart; ep <= epEnd; ep++) {
                        if (linkedEpNums.has(ep)) {
                            if (
                                seasonIdForFile &&
                                unsegmentedEpNums.has(ep) &&
                                (await findDedicatedFileForEpisodeNumber(
                                    sql,
                                    seasonIdForFile,
                                    ep,
                                    filePath,
                                ))
                            ) {
                                break existingFileBlock;
                            }
                            continue;
                        }
                        // Deliberately unlinked, not missing: the episode owns a
                        // file dedicated to exactly it, so the range link was
                        // suppressed. Without this the scan would break out and
                        // re-run the whole hierarchy path on EVERY pass, only for
                        // the loop below to suppress the link again.
                        if (
                            seasonIdForFile &&
                            (await findDedicatedFileForEpisodeNumber(
                                sql,
                                seasonIdForFile,
                                ep,
                                filePath,
                            ))
                        ) {
                            continue;
                        }
                        context.logger.info(
                            '[FileScanner] Multi-episode file missing link for episode — re-processing to create link',
                            {
                                filePath,
                                missingEpisode: ep,
                                seasonNumber,
                                episodeRange: `${epStart}-${epEnd}`,
                            },
                        );
                        break existingFileBlock;
                    }
                }
            }

            const changeResult = await detectFileChanges(existingFile, filePath);
            switch (changeResult.status) {
                case 'unchanged': {
                    // Heal awaiting_provider_match backlog: if any linked item
                    // is flagged as awaiting a provider match AND a provider can
                    // actually answer now, break out of this block so the
                    // new-file matching pipeline runs against the current
                    // provider chain. Without this escape, the unchanged fast
                    // path would permanently hide these items from re-matching.
                    //
                    // The file stays linked while it re-matches; processVideoFile
                    // moves it off the awaiting items only once it has landed on
                    // a different item. Detaching up front soft-dismissed the
                    // item and, with the provider still missing, minted a new
                    // personal item on every scan — a new id each time, with
                    // watch state, ratings and playlists left on the old one.
                    const awaitingItemIds = await findAwaitingMatchItemIdsForFile(
                        sql,
                        existingFile.id,
                    );
                    let hasKeptAwaitingItem = false;
                    for (const id of awaitingItemIds) {
                        if (await isPersonalMediaKept(sql, id)) {
                            hasKeptAwaitingItem = true;
                            break;
                        }
                    }
                    if (
                        !descendingRange &&
                        awaitingItemIds.length > 0 &&
                        !hasKeptAwaitingItem &&
                        !(await isManuallyLinkedFile(sql, existingFile.id)) &&
                        (await resolveUsableProviderId(providerIds, libraryPath))
                    ) {
                        rematch.claim =
                            (await claimPersonalMediaRematch(sql, awaitingItemIds)) ?? undefined;
                        if (!rematch.claim) return 'skipped';
                        // The reserved connection owns the session claim. Keep
                        // subsequent scanner work on that same handle so
                        // concurrent rematches cannot fill the pool and wait
                        // forever for a second connection.
                        sql = rematch.claim.sql;
                        context.sql = sql;
                        context.logger.info(
                            '[FileScanner] Re-matching awaiting_provider_match file',
                            { filePath },
                        );
                        rematch.fileId = existingFile.id;
                        rematch.itemIds = awaitingItemIds;
                        rematch.linkedBefore = await findAllLinkedMediaItemsByFilePath(
                            sql,
                            filePath,
                        );
                        // Until a provider gives a definitive "no match", every
                        // other way out (abort, probe failure, 'unmatched', ...)
                        // leaves the item awaiting.
                        rematch.stillAwaiting = true;
                        break existingFileBlock;
                    }
                    // NFO-content heal (provider-less local movies). The unchanged
                    // fast path must not permanently hide a fillable description
                    // gap — like the awaiting_provider_match escape above. Cheap-
                    // gated: findLocalContentGapMovieByFile returns non-null ONLY
                    // when the linked movie still lacks overview/year, so complete
                    // items pay a single indexed lookup and never re-read the NFO.
                    const gapMovieId = await findLocalContentGapMovieByFile(sql, existingFile.id);
                    if (gapMovieId) {
                        const healNfo = await readNfoForVideo(filePath);
                        if (
                            healNfo.kind !== 'episode' &&
                            healNfo.kind !== 'series' &&
                            (healNfo.plot !== undefined ||
                                healNfo.year !== undefined ||
                                healNfo.certification !== undefined)
                        ) {
                            await backfillLocalMediaContent(sql, gapMovieId, {
                                overview: healNfo.plot,
                                year: healNfo.year,
                                certification:
                                    pickCertificationForCountry(
                                        healNfo.certification,
                                        effectiveAgeRatingCountry(),
                                    ) ?? undefined,
                            });
                        }
                    }
                    // Extract chapters if missing (e.g. after enabling scan_chapters)
                    if (libraryPath.scan_chapters) {
                        await extractChapters(sql, filePath, context, existingFile.id);
                    }
                    return 'skipped';
                }
                case 'first-backfill':
                    await updateFileStat(
                        sql,
                        existingFile.id,
                        changeResult.fileStat!.mtime,
                        changeResult.fileStat!.size,
                        changeResult.currentHash!,
                    );
                    // Extract chapters for files that were scanned before chapter extraction was enabled
                    if (libraryPath.scan_chapters) {
                        await extractChapters(sql, filePath, context, existingFile.id);
                    }
                    return 'skipped';
                case 'content-changed': {
                    // A LINKED file whose bytes changed (e.g. an admin
                    // overwrites X.mkv with an ffconcat body) is re-probed
                    // before its row is trusted again. applyContentChange
                    // (shared.ts, also used by processExtra) owns what each
                    // probe outcome writes — ruling T7-probe-outcomes.
                    const change = await applyContentChange(
                        sql,
                        {
                            id: existingFile.id,
                            filePath,
                            libraryGroupId: libraryPath.library_group_id,
                        },
                        {
                            mtime: changeResult.fileStat!.mtime,
                            size: changeResult.fileStat!.size,
                            hash: changeResult.currentHash!,
                        },
                        context,
                        abortSignal,
                    );
                    if (change.kind === 'refused') {
                        onError?.(
                            'identified as a playlist/reference container after its content changed — the existing library entry was retired',
                        );
                        return 'error';
                    }
                    // Nothing was written, so the next scan still sees the
                    // change: an abort is a skip, a transient failure an error.
                    if (change.kind === 'aborted') return 'skipped';
                    if (change.kind === 'retry-next-scan') {
                        onError?.(
                            'probe failed transiently after the file changed — will retry next scan',
                        );
                        return 'error';
                    }

                    const { invalidatedMediaItemIds } = change;
                    // Windows an admin set by hand were set for the old bytes:
                    // kept only while they still fit the new duration.
                    await revalidateManualLinksAfterContentChange(
                        sql,
                        existingFile.id,
                        change.durationSeconds ? Math.round(change.durationSeconds * 1000) : null,
                    );
                    // Stamp library_added_at on the replaced items so they
                    // resurface in Recently Added. No ancestor propagation —
                    // a re-encoded episode shouldn't resurface its series.
                    if (invalidatedMediaItemIds.length > 0) {
                        await sql`
                            UPDATE media_items
                            SET library_added_at = NOW()
                            WHERE id = ANY(${invalidatedMediaItemIds}::uuid[])
                        `;
                    }
                    context.logger.info(
                        '[FileScanner] File changed, invalidated all content-dependent data',
                        {
                            filePath: path.basename(filePath),
                            mediaItems: invalidatedMediaItemIds.length,
                        },
                    );
                    // Re-extract chapters from the new file content
                    if (change.readable && libraryPath.scan_chapters) {
                        await extractChapters(sql, filePath, context, existingFile.id);
                    }
                    if (descendingRange) await warnDescendingRange();
                    return 'updated';
                }
                case 'metadata-only':
                    await updateFileStat(
                        sql,
                        existingFile.id,
                        changeResult.fileStat!.mtime,
                        changeResult.fileStat!.size,
                        changeResult.currentHash!,
                    );
                    if (libraryPath.scan_chapters) {
                        await extractChapters(sql, filePath, context, existingFile.id);
                    }
                    return 'skipped';
                case 'deleted':
                    // File vanished mid-scan (ENOENT/ESTALE) — benign churn, not a
                    // fault. Skip silently; the stale-cleanup / removal pass
                    // reconciles the now-missing file. Must NOT surface as 'error'.
                    return 'skipped';
                case 'error':
                    // A GENUINE stat/hash fault (EACCES / EIO / timeout) is a real
                    // error, not a benign skip. Returning 'skipped' hid it from
                    // result.errors so a partially-broken scan looked clean.
                    // Return 'error' so the aggregation records it in run history.
                    onError?.(
                        'a filesystem read failed while checking this file for changes (stat/hash — permission denied, I/O error, or timeout)',
                    );
                    return 'error';
            }
        } // end else (isLinked)
    }

    // 0. Probe the file to detect corruption or missing files before doing any DB work.
    //    S2: pass the scanner's abort signal through so a slow network probe
    //    aborts instantly when the admin cancels.
    //
    //    Playlist-class guard (P1+R2 residual, S-P1b): probeNewFileForScan
    //    (shared.ts, also used by processExtra) refuses a playlist/manifest
    //    body — by its head bytes, by ffprobe's format_name
    //    (hls/dash/concat/imf), or by a reference-demuxer probe error — and
    //    records a scan issue. Refusing it before a
    //    media_item LINK exists (recordFileScanIssue still upserts a STUB
    //    media_files row, exactly like the filename_not_utf8 case, so the file
    //    is visible on the Ingest Map) is the chokepoint: no playback query can
    //    select an unlinked file, so no downstream ffmpeg/ffprobe argv builder
    //    ever receives it. A file is linked only when the probe came back
    //    `ok` (ruling T7-probe-outcomes).
    if (abortSignal?.aborted) return 'skipped';
    const probeOutcome = await probeNewFileForScan(
        sql,
        filePath,
        libraryPath.library_group_id,
        context,
        abortSignal,
    );
    if (probeOutcome.kind === 'refused') {
        onError?.(
            `identified as a playlist/reference container (${probeOutcome.container}) — never ingested`,
        );
        return 'error';
    }
    if (probeOutcome.kind === 'aborted') {
        context.logger.debug('[FileScanner] probe aborted', { filePath });
        return 'skipped';
    }
    if (probeOutcome.kind === 'cooling-down') {
        context.logger.debug('[FileScanner] Skipping file — unreadable, inside its retry window', {
            filePath,
            retryAt: probeOutcome.retryAt.toISOString(),
        });
        return 'skipped';
    }
    if (probeOutcome.kind === 'failed') {
        const isNotFound =
            probeOutcome.error.includes('ENOENT') || probeOutcome.error.includes('No such file');
        const isPermissionError =
            probeOutcome.error.includes('EACCES') || probeOutcome.error.includes('EPERM');

        if (isNotFound) {
            // D2: A transient NFS unmount produces the same ENOENT as a real
            // delete. Classify with assessFilePresence — if the parent
            // directory is ALSO missing, the mount is likely offline and we
            // must NOT delete the media_files row. Only delete when the
            // parent dir is present, which confirms a real deletion.
            const presence = await assessFilePresence(filePath);
            if (presence === 'transient') {
                context.logger.warn(
                    '[FileScanner] ENOENT during probe but parent dir also missing — leaving DB row intact (mount likely offline)',
                    { filePath },
                );
                return 'skipped';
            }
            context.logger.info(
                '[FileScanner] File missing at probe time — removing stale media_files entry',
                { filePath },
            );
            const removed = await deleteStaleMediaFile(sql, filePath);
            queueRecencyRefresh(sql, removed?.affectedItemIds ?? [], context.logger);
            return 'skipped';
        }
        if (isPermissionError) {
            context.logger.warn('[FileScanner] Permission denied', {
                filePath,
            });
            onError?.('permission denied reading the file (EACCES/EPERM)');
            return 'error';
        }
        // Unreadable content or a transient probe fault — log and skip
        context.logger.warn('[FileScanner] FFprobe failed', {
            filePath,
            error: probeOutcome.error,
            failure: probeOutcome.failure,
        });
        onError?.(`ffprobe failed: ${probeOutcome.error}`);
        return 'error';
    }
    const probeResult = probeOutcome.probe;

    // M2 (fix plan 6, Task 7 fix round 2): a previously-refused file
    // (unsafe_filename / playlist_container_rejected) may reuse the SAME
    // stub row on successful re-ingest — upsertMediaFile's ON CONFLICT never
    // touches health_issues, and the ~10 downstream
    // `if (created) initFileChangeDetection(...)` guards below all skip
    // re-initializing change detection for a row that already existed
    // (`created=false` on the ON CONFLICT branch). Clear the stale badge and
    // make sure change detection is initialized HERE, at the one chokepoint
    // every media-type branch below passes through, rather than patching
    // every downstream call site.
    await clearStaleRefusalAndEnsureChangeDetection(sql, existingFile, filePath);

    if (descendingRange) {
        // Refuse guessed identity only after the ordinary physical safety
        // probe. Keep verified duration so the admin can set exact windows.
        await warnDescendingRange();
        const stub = await findMediaFileByPath(sql, filePath);
        if (stub) {
            await initFileChangeDetection(sql, stub.id, filePath);
            const st = await safeStat(filePath).catch(() => null);
            const verified = st
                ? peekScanProbe(filePath, { mtime: st.mtime, size: st.size })
                : null;
            if (st && verified)
                await updateScannedPhysicalMetadata(sql, stub.id, {
                    durationSeconds: verified.duration,
                    container: verified.container,
                    bitrate: verified.formatBitrate,
                    mtime: st.mtime,
                    size: st.size,
                });
            if (libraryPath.scan_chapters) await extractChapters(sql, filePath, context, stub.id);
        }
        return 'skipped';
    }

    // Capture file duration from probe for runtime_seconds population
    const probedDurationSeconds = probeResult.duration
        ? Math.round(probeResult.duration)
        : undefined;

    // 0a. Rename reconnect-by-hash (bug #3).
    //
    // native watcher emits `unlink(oldPath)` + `add(newPath)` as a rename pair;
    // the unlink path may have soft-dismissed the previously-linked
    // media_item if it lost its last file. Before falling into the
    // normal new-item creation flow, check whether the new file's 64KB
    // head hash matches a recently dismissed item. When it does, the
    // new file is reattached to the resurrected media_item and user
    // state (ratings, watch history, playlist membership, coverage rows)
    // stays attached to the original UUID.
    //
    // Skipped for non-entertainment libraries — those bypass the matching
    // pipeline entirely and have no soft-dismiss flow to recover from.
    //
    // S6: Skip entirely when no dismissed candidates exist for this path.
    // On a fresh install there are no dismissed items → the hash read and
    // DB SELECT are pure overhead (~25 GB of reads + 400k SELECTs at 400k
    // files). hasReclaimCandidates is threaded in from performScan once
    // per library path. A false-negative (dismiss happens mid-scan) misses
    // one reclaim; the next scan recovers it.
    // Not during an awaiting rematch: the file is unchanged and still linked, so
    // it is not a rename — and a hash match there would pull in a dismissed
    // sibling of this very file instead of asking the provider.
    // A file an admin linked to its episodes by hand, back under a new path
    // (rename or move): put the hand-made set back before anything links it by
    // name or reclaims one of its episodes alone. Before the per-item reclaim
    // below, which would attach only one of the set's episodes.
    if (dbMediaType === 'tv' && rematch.itemIds.length === 0 && (await hasManualLinkSets(sql))) {
        const restored = await tryRestoreManualLinks(
            sql,
            filePath,
            parsed,
            libraryPath,
            probeResult.duration,
            context,
        );
        if (restored) return 'updated';
    }

    if (
        !isNonEntertainment(libraryPath.media_type) &&
        dbMediaType !== null &&
        hasReclaimCandidates &&
        rematch.itemIds.length === 0
    ) {
        const reclaim = await tryReclaimByHash(
            sql,
            filePath,
            parsed,
            libraryPath,
            dbMediaType,
            context,
        );
        if (reclaim === 'deferred') return 'skipped';
        if (reclaim === 'reclaimed') return 'updated';
    }

    // 0b. Non-entertainment library types skip the entire matching pipeline
    if (isNonEntertainment(libraryPath.media_type)) {
        return createNonEntertainmentItem(
            sql,
            filePath,
            parsed,
            libraryPath,
            context,
            probedDurationSeconds,
        );
    }

    // 0c. libraryPath.media_type can be 'audiobook' — entertainment, but not a
    // library type music/non-entertainment already filtered above, and TMDB does
    // not catalog audiobooks (dbMediaType is null). Real audiobook files carry an
    // audio extension and are already caught by the isAudioFile() check earlier,
    // so reaching here with a null dbMediaType means a stray non-audio file (e.g.
    // a bonus video) landed inside an audiobook library path. Stop before any
    // provider match instead of guessing 'movie' — that guess is the exact
    // "audiobook rendered as a movie card" bug this module exists to prevent.
    if (dbMediaType === null) {
        context.logger.warn(
            '[FileScanner] Library media type has no TMDB representation — skipping provider match',
            { filePath, libraryMediaType: libraryPath.media_type },
        );
        return 'skipped';
    }

    // 1. Check NFO sidecar first — authoritative provider IDs
    const nfo = await readNfoForVideo(filePath);

    // 2. Apply path-level edition label when filename has none.
    // parsed was already populated at the top of processVideoFile (S10).
    if (!parsed.edition && libraryPath.edition_label) {
        parsed.edition = libraryPath.edition_label;
    }

    // NFO IDs take priority over filename-parsed IDs, but only when the NFO scope
    // matches the usage context. An <episodedetails> NFO contains an episode-scoped
    // IMDB ID (e.g. tt35287360 for a single FAM episode) — using it as the series
    // IMDB would corrupt the series external_ids row for every Sonarr-managed show.
    //
    // Rule: adopt nfo.imdbId as the series/movie-level IMDB only when the NFO is
    // NOT episode-scoped. For episode NFOs the folder-derived parsed.imdbId is the
    // only safe series-level candidate.
    //
    // episodeImdbId is kept for future episode-level attachment (see TODO below).
    const isEpisodeNfo = nfo.kind === 'episode';
    // TODO(episode-imdb-attach): episodeImdbId is the episode's own IMDB ID sourced
    // from an <episodedetails> NFO. Once findOrCreateSeriesHierarchy returns the
    // created episode media_item UUID, write this to that episode's external_ids via
    // CatalogService.upsertExternalId(episodeUUID, { provider: 'imdb', ... }).
    const episodeImdbId = isEpisodeNfo ? nfo.imdbId : undefined;
    void episodeImdbId; // used in TODO above; prevents unused-variable lint error
    const imdbId = isEpisodeNfo ? parsed.imdbId : (nfo.imdbId ?? parsed.imdbId);

    // Provider-less local content from the NFO sidecar (movie-scoped). Applied as
    // the item's overview/year on the create/adopt paths below when the file has
    // no TMDB/Jellyfin match — so a movie not in TMDB still shows its description.
    // Restricted to movie (or root-less) NFOs: an <episodedetails> <plot> belongs
    // to one episode and a <tvshow> <plot> to the series, neither of which is the
    // flat movie item these paths create/heal.
    const isMovieScopedNfo = nfo.kind !== 'episode' && nfo.kind !== 'series';
    // The content rating (<mpaa> / <certification>) for the configured country.
    const nfoCertification = isMovieScopedNfo
        ? (pickCertificationForCountry(nfo.certification, effectiveAgeRatingCountry()) ?? undefined)
        : undefined;
    const nfoContent =
        isMovieScopedNfo &&
        (nfo.plot !== undefined || nfo.year !== undefined || nfoCertification !== undefined)
            ? { overview: nfo.plot, year: nfo.year, certification: nfoCertification }
            : undefined;

    // Re-scan heal: if this movie file is already linked to an item, backfill the
    // item's overview/year from the NFO now — BEFORE the link paths below, which
    // short-circuit through linkAsVersion/folder-match without touching content.
    // This lets a movie ingested before NFO content was read (or before this fix)
    // pick up its description on the next scan. Movie-only, and the backfill
    // itself fills NULL columns only and skips metadata_locked rows, so it never
    // clobbers a metadata-sync value or a user edit on a matched item.
    if (dbMediaType === 'movie' && nfoContent) {
        const linkedId = await findMediaItemByFilePath(sql, filePath);
        if (linkedId) await backfillLocalMediaContent(sql, linkedId, nfoContent);
    }

    // 3. Short-circuit if we have an IMDB ID from NFO or filename and the
    //    item is already in the database. On a miss we fall through to fuzzy
    //    title search (step 4). Only TMDB currently exposes a reverse-lookup
    //    (`/find/{external_id}`); first-seen items from other providers fall
    //    through to fuzzy title search until step 4a's authoritative lookup
    //    is broadened.
    if (imdbId) {
        const existingId = await resolveExternalIdToUuid(sql, imdbId, dbMediaType, 'imdb');
        if (existingId) {
            // TV files with IMDB match: route through hierarchy so files link
            // to episode items, not the series item the IMDB ID resolves to.
            if (dbMediaType === 'tv') {
                const { outcome, episodeIds } = await findOrCreateSeriesHierarchy(
                    sql,
                    filePath,
                    parsed,
                    context,
                    {
                        year: seriesYearHint(parsed),
                        libraryGroupId: libraryPath.library_group_id,
                        libraryRoot: libraryPath.path,
                        imdbId,
                        durationSeconds: probedDurationSeconds,
                        resolvedSeriesId: existingId,
                    },
                    seriesIdCache,
                    seasonIdCache,
                    seriesSideEffectsDone,
                    identityWrites,
                );
                if (libraryPath.scan_chapters && episodeIds.length > 0) {
                    await extractChapters(sql, filePath, context);
                }
                return outcome;
            }

            // Movies: second file for same item → link as version
            if (!parsed.part && (await mediaItemHasFile(sql, existingId))) {
                return linkAsVersion(sql, filePath, existingId, parsed, libraryPath, context);
            }

            // First file (or multi-part): link directly to the resolved item
            const fileHashHead = await tryHashFileHead(filePath);
            const { id: fileId, created } = await upsertMediaFile(sql, {
                filePath,
                edition: parsed.edition,
                partNumber: parsed.part,
                libraryGroupId: libraryPath.library_group_id,
                fileHashHead,
            });
            await attachFile(sql, fileId, existingId);
            if (created) await initFileChangeDetection(sql, fileId, filePath, fileHashHead);
            if (libraryPath.scan_chapters) {
                // N1: fileId is already known — pass it so extractChapters
                // skips the redundant findMediaFileByPath lookup.
                await extractChapters(sql, filePath, context, fileId);
            }
            return created ? 'added' : 'updated';
        }
    }

    // 4. Resolve provider id (substring match against full registry ids).
    const providerId = libraryProviderId(providerIds, libraryPath);

    // A rematch that can't reach a provider (it went away since the unchanged
    // branch checked) or that the provider answered with nothing keeps the
    // file where it is: the existing item is already its home.
    if (rematch.itemIds.length > 0 && (!providerId || !(await isProviderConfigured(providerId)))) {
        rematch.stillAwaiting = true;
        return 'skipped';
    }

    if (!providerId) {
        context.logger.warn(
            `File scanner: no metadata provider for library ${libraryPath.id} — creating as personal media`,
        );
        noteMetadataUnavailable(context, 'unavailable');
        // S12: flag as awaiting-provider-match so a future pass can retry
        return attemptVersionLinkOrCreate(
            sql,
            filePath,
            parsed,
            dbMediaType,
            libraryPath,
            context,
            probedDurationSeconds,
            true,
            nfoContent,
            {
                imdbId,
                tmdbId: isEpisodeNfo ? parsed.tmdbId : (nfo.tmdbId ?? parsed.tmdbId),
                year: nfo.kind === 'series' ? nfo.year : undefined,
            },
        );
    }

    if (!(await isProviderConfigured(providerId))) {
        context.logger.warn(
            `File scanner: provider ${providerId} unavailable — creating as personal media`,
        );
        noteMetadataUnavailable(context, 'unavailable', providerId);
        // S12: flag as awaiting-provider-match so a future pass can retry
        return attemptVersionLinkOrCreate(
            sql,
            filePath,
            parsed,
            dbMediaType,
            libraryPath,
            context,
            probedDurationSeconds,
            true,
            nfoContent,
            {
                imdbId,
                tmdbId: isEpisodeNfo ? parsed.tmdbId : (nfo.tmdbId ?? parsed.tmdbId),
                year: nfo.kind === 'series' ? nfo.year : undefined,
            },
        );
    }

    // 4a. IMDB/TMDB ID from filename → authoritative provider lookup (no DB hit needed)
    //     This handles first-seen items where the IMDB ID is in the filename/folder
    //     but no external_ids row exists yet.
    //
    //     Only TMDB exposes a native /find/{external_id} bridge — other providers
    //     have no comparable endpoint, so we gate the lookup on the resolved
    //     primary provider being TMDB. First-seen items from non-TMDB providers
    //     still fall through to fuzzy title search until step 4a is broadened.
    //
    //     Note: The TMDB lookup below is called via tmdbResolveExternalId (not via
    //     an invoke helper), so `abortSignal` is not threaded through it.  The
    //     caller checks `abortSignal?.aborted` between top-level steps, which is
    //     sufficient: enrichment lookups are single-round-trip calls.
    const tmdbId = parsed.tmdbId;
    let candidate: MetadataCandidate | undefined;

    if ((imdbId || tmdbId) && providerId === 'tmdb-metadata-provider') {
        if (imdbId) {
            const resolved = await tmdbResolveExternalId(imdbId, 'imdb', dbMediaType);
            if (resolved) {
                context.logger.info('[FileScanner] Resolved IMDB ID to provider match', {
                    filePath,
                    imdbId,
                    resolvedId: resolved.externalId,
                    resolvedTitle: resolved.title,
                });
                candidate = resolved;
            }
        }
        if (!candidate && tmdbId) {
            // tmdbId from filename {tmdb-XXX} — create candidate directly
            candidate = {
                externalId: tmdbId,
                provider: 'tmdb',
                title: parsed.title,
                year: parsed.year,
                mediaType: dbMediaType,
                confidence: 1.0,
            };
            context.logger.info('[FileScanner] Using TMDB ID from filename', {
                filePath,
                tmdbId,
            });
        }
    }

    // A candidate from /find or a {tmdb-…} tag is the tagged show itself; one
    // from title search is only the best title match (see the TV branch below).
    const candidateFromIdTag = !!candidate;

    let matchedProviderId: string = providerId;
    // The primary provider rejected its key for this file (S5): the file is
    // added without metadata and counted, and the miss is NOT cached — the
    // next file retries once the key is fixed (the provider short-circuits a
    // known-bad key without a network call).
    let primaryAuthFailed = false;
    // The primary provider's search failed outright (network, timeout,
    // 429/5xx): like an auth failure, it said nothing about this file.
    let primaryUnavailable = false;

    // 4b. Fuzzy title search — primary first, then fallback_providers in order.
    // The searchCache collapses repeated identical queries (e.g. all episodes of
    // a series resolving to the same TMDB title search) to one network round-trip.
    if (!candidate) {
        const primaryCacheKey = searchCache
            ? buildSearchCacheKey(providerId, filePath, libraryPath)
            : undefined;

        const cachedPrimary = primaryCacheKey ? searchCache!.get(primaryCacheKey) : undefined;

        if (cachedPrimary !== undefined) {
            // Cache hit (positive or negative).
            if (cachedPrimary !== null) {
                candidate = cachedPrimary.candidate;
                matchedProviderId = cachedPrimary.matchedProviderId;
            }
            // null = cached miss — fall through to fallback providers below.
        } else {
            const primaryResult = await matchFileToMetadata(
                filePath,
                libraryPath,
                providerId,
                narrowProviderContext(context),
            );

            if (primaryResult.matched && primaryResult.candidate) {
                candidate = primaryResult.candidate;
                if (primaryCacheKey && searchCache) {
                    searchCache.set(primaryCacheKey, {
                        candidate,
                        matchedProviderId: providerId,
                    });
                }
            } else if (primaryResult.providerError === 'auth') {
                primaryAuthFailed = true;
            } else if (primaryResult.providerError === 'unavailable') {
                // Search failed (outage, rate limit): no answer, so not a
                // cached miss — the next file retries.
                primaryUnavailable = true;
            } else {
                if (primaryCacheKey && searchCache) {
                    searchCache.set(primaryCacheKey, null);
                }
            }
        }

        if (!candidate) {
            const fallback = await tryProvidersInOrder(
                providerIds,
                libraryPath.fallback_providers,
                filePath,
                libraryPath,
                narrowProviderContext(context),
                searchCache,
            );
            if (fallback) {
                context.logger.info('[FileScanner] Primary provider missed, matched via fallback', {
                    filePath,
                    fallbackProvider: fallback.matchedProviderId,
                    candidateId: fallback.candidate.externalId,
                });
                candidate = fallback.candidate;
                matchedProviderId = fallback.matchedProviderId;
            } else {
                if (primaryAuthFailed) noteMetadataUnavailable(context, 'auth', providerId);
                if (rematch.itemIds.length > 0) {
                    // Still no match: keep the existing item. A rejected key or
                    // a failed search is "still awaiting"; only a clean search
                    // with no confident candidate is a definitive miss.
                    rematch.stillAwaiting = primaryAuthFailed || primaryUnavailable;
                    return 'skipped';
                }
                return attemptVersionLinkOrCreate(
                    sql,
                    filePath,
                    parsed,
                    dbMediaType,
                    libraryPath,
                    context,
                    probedDurationSeconds,
                    // S12: a rejected key or a failed search is "provider
                    // unavailable", not "no match".
                    primaryAuthFailed || primaryUnavailable ? true : undefined,
                    nfoContent,
                    {
                        imdbId,
                        tmdbId: isEpisodeNfo ? parsed.tmdbId : (nfo.tmdbId ?? parsed.tmdbId),
                        year: nfo.kind === 'series' ? nfo.year : undefined,
                    },
                );
            }
        }
    }

    // 5. Route TV and movies differently
    //
    // candidate.mediaType is a MetadataCandidate ('movie' | 'tv' | 'episode' |
    // 'season' | 'anime', providers/types.ts) — every member maps onto a TMDB
    // namespace (episode/season/anime fold onto 'tv'), so this is never actually
    // null; the fallback exists only because toTmdbMediaType's signature is
    // generically nullable. Reused below instead of re-deriving from
    // candidate.mediaType a second time.
    const candidateMediaType = toDbMediaType(candidate.mediaType) ?? 'movie';

    // Keep may be chosen while provider lookup is in flight. Recheck the
    // source item and its ancestors after the network call, before either the
    // in-place metadata path or the canonical-link path can mutate the catalog.
    // Leave the awaiting state and every existing file/user row intact.
    if (rematch.itemIds.length > 0) {
        for (const itemId of rematch.itemIds) {
            if (await isPersonalMediaKept(sql, itemId)) {
                rematch.stillAwaiting = true;
                context.logger.info(
                    '[FileScanner] Skipped provider rematch for kept personal media',
                    {
                        filePath,
                        itemId,
                    },
                );
                return 'skipped';
            }
        }
    }
    if (abortSignal?.aborted) {
        if (rematch.itemIds.length > 0) rematch.stillAwaiting = true;
        return 'skipped';
    }

    // A folder/NFO IMDb id pairs with a title-search match only when the
    // provider's item confirms it (or contradicts it, which the series
    // hierarchy refuses visibly). Otherwise /find missed — an id TMDB has not
    // linked yet, or an API error — and the title match may be a same-title
    // show or film from another year: writing this IMDb id onto it is the
    // Scrubs 2001/2026 bleed. Without the tag the match stands on its own.
    const matchImdbId =
        candidateFromIdTag || getExternalIdFor(candidate.externalIds, 'imdb') ? imdbId : undefined;
    if (imdbId && !matchImdbId) {
        context.logger.debug('[FileScanner] IMDb tag not confirmed by the provider match', {
            filePath,
            imdbId,
            candidateId: candidate.externalId,
        });
    }

    if (candidateMediaType === 'tv') {
        // A rematch of an episode made while no provider could answer: identify
        // its provider-less series in place rather than building a second series
        // under the provider's title (which left the old episodes behind as
        // dismissed duplicates). The external id lands on the existing series,
        // so identity.assigned re-opens its series-sync and metadata-update, and
        // the file resolves to the episode it is already linked to.
        const inPlace =
            rematch.itemIds.length > 0
                ? await findSeriesForInPlaceRematch(sql, rematch.itemIds, candidate)
                : null;

        // TV: always build series → season → episode hierarchy, enrich with external IDs
        const { outcome, episodeIds } = await findOrCreateSeriesHierarchy(
            sql,
            filePath,
            parsed,
            context,
            {
                year: candidate.year ?? seriesYearHint(parsed),
                libraryGroupId: libraryPath.library_group_id,
                libraryRoot: libraryPath.path,
                candidate,
                imdbId: matchImdbId,
                durationSeconds: probedDurationSeconds,
                metadataProviderId: matchedProviderId,
                resolvedSeriesId: inPlace?.seriesId,
            },
            seriesIdCache,
            seasonIdCache,
            seriesSideEffectsDone,
            identityWrites,
        );
        if (rematch.itemIds.length > 0) {
            // The provider answered: settleAwaitingRematch clears the flag when
            // the file stayed on its episode, or releases the old one when it
            // moved. An in-place series whose id write lost (a concurrent owner,
            // a rival id) is not identified: keep it awaiting and its title.
            const identified =
                !inPlace || (await seriesHoldsExternalId(sql, inPlace.seriesId, candidate));
            rematch.stillAwaiting = !identified;
            if (inPlace && identified && !inPlace.identified) {
                await sql`
                    UPDATE media_items
                       SET title = ${candidate.title},
                           year = COALESCE(${candidate.year ?? null}::int, year),
                           updated_at = now()
                     WHERE id = ${inPlace.seriesId}::uuid AND NOT metadata_locked
                `;
                await refreshSortTitles(sql, [inPlace.seriesId]);
            }
        }

        // Extract chapters if enabled
        if (libraryPath.scan_chapters && episodeIds.length > 0) {
            await extractChapters(sql, filePath, context);
        }

        return outcome;
    }

    // Movies: the provider item names an IMDb id, the folder/NFO another. The
    // title match is then most likely another film of the same title; creating
    // or linking it would pair the two ids. Refuse it visibly, as series do.
    const providerImdbId = getExternalIdFor(candidate.externalIds, 'imdb');
    if (imdbId && providerImdbId && providerImdbId !== imdbId) {
        context.logger.warn('[FileScanner] Conflicting movie identity evidence', {
            filePath,
            imdbId,
            providerImdbId,
            candidate: `${candidate.provider} ${candidate.externalId}`,
        });
        throw new IdentityConflictError(
            `Conflicting movie identity evidence: the folder names imdb ${imdbId}, the matched ${candidate.provider} item names imdb ${providerImdbId}`,
            'movie_identity_conflict',
        );
    }

    // Movies: existing flat-item path (resolveOrCreateMediaItem)
    const primaryId = await resolveOrCreateMediaItem(
        sql,
        candidate,
        matchImdbId,
        context,
        probedDurationSeconds,
        libraryPath.library_group_id,
        matchedProviderId,
        rematch.itemIds.length === 1 ? rematch.itemIds[0] : undefined,
    );
    if (!primaryId) return 'unmatched';

    // Fire-and-forget lifecycle hook so metadata sync + identity-bound
    // stage-state invalidation runs on the matched movie. afterMatched is
    // idempotent — the orchestrator dedupes on identity, so re-scanning an
    // already-matched movie is a no-op for the queue. Mirrors the series-path
    // call sites above (findOrCreateSeriesHierarchy lines 717 / 756).
    MediaLifecycleService.afterMatched(
        primaryId,
        candidateMediaType,
        {
            enqueueMetadataSync: true,
            match: {
                provider: candidate.provider,
                externalId: candidate.externalId,
            },
        },
        sql,
    ).catch((err: unknown) => {
        // Dev: re-raise so an unhandled-rejection surfaces missing-task /
        // config bugs immediately. Prod: log and continue — afterMatched is
        // idempotent so the next scan recovers.
        if (process.env.NODE_ENV !== 'production') throw err;
        context.logger.warn('[FileScanner] afterMatched enqueue failed for movie', {
            primaryId,
            externalId: candidate.externalId,
            error: err instanceof Error ? err.message : String(err),
        });
    });

    // A rematch identified the item the file already lives on: nothing to link.
    // settleAwaitingRematch clears the awaiting flag.
    if (rematch.itemIds.includes(primaryId)) {
        rematch.stillAwaiting = false;
        if (libraryPath.scan_chapters) await extractChapters(sql, filePath, context);
        return 'updated';
    }

    // Second file for same movie: link as version
    if (!parsed.part && (await mediaItemHasFile(sql, primaryId))) {
        return linkAsVersion(sql, filePath, primaryId, parsed, libraryPath, context);
    }

    const fileHashHead = await tryHashFileHead(filePath);
    const { id: fileId, created: fileCreated } = await upsertMediaFile(sql, {
        filePath,
        edition: parsed.edition,
        partNumber: parsed.part,
        libraryGroupId: libraryPath.library_group_id,
        fileHashHead,
    });

    if (fileCreated) await initFileChangeDetection(sql, fileId, filePath, fileHashHead);
    await attachFile(sql, fileId, primaryId);

    if (libraryPath.scan_chapters) {
        // N1: reuse fileId rather than re-querying findMediaFileByPath.
        await extractChapters(sql, filePath, context, fileId);
    }

    return fileCreated ? 'added' : 'updated';
}

function toTitleCandidate(row: {
    id: string;
    title: string;
    english_title: string | null;
    original_title: string | null;
}): EpisodeTitleCandidate {
    return { id: row.id, titles: [row.title, row.english_title, row.original_title] };
}
