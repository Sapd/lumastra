// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getEpisodeLanguageSummaries } from '$lib/server/database/queries/admin-language-summary.queries.js';
import { tmdbIdentityUrl, type TmdbContext } from '$lib/components/admin/media/tmdb-identity.js';
import { projectDiscogsAttribution } from '$lib/shared/music-provenance';
import type { PageServerLoad } from './$types';
import { canonicalDetailTab } from './detail-tabs.js';
import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { getAllExternalIds } from '$lib/server/database/queries/external-ids.queries.js';
import {
    coverageHealthStatus,
    getSeriesEpisodeCoverage,
    getSeasonCoverageBatch,
    type SeriesEpisodeCoverage,
    type SeasonCoverage,
} from '$lib/server/database/queries/series-health.queries.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import {
    getFileHealthIssuesForItemTree,
    getMediaFileSummary,
    type MediaFileSummary,
} from '$lib/server/database/queries/media-files.queries.js';
import {
    getLastProviderSyncAt,
    getMediaItemById,
    getMediaItemChildCounts,
    listAdminMediaItems,
    resolveAncestorChain,
} from '$lib/server/database/queries/admin-media.queries.js';
import { issuesForAdminRow } from '$lib/server/services/admin-media-issues.js';
import type { MediaIssue } from '$lib/shared/media-issues.js';
import {
    getMusicContainerSummary,
    getArtistAlbumCount,
} from '$lib/server/database/queries/music-admin.queries.js';
import {
    isSeries as isSeriesType,
    isSeason as isSeasonType,
    isEpisode as isEpisodeType,
    isNonEntertainment,
    isAudiobook as isAudiobookType,
} from '$lib/server/utils/media-types.js';
import { getAudiobookAdminDetail } from '$lib/server/database/queries/audiobook-admin-detail.queries.js';
import { config, features } from '$lib/server/config.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import type { Run } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('admin/media/[id]');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface AncestorInfo {
    id: string;
    title: string | null;
    mediaType: string;
    seasonNumber: number | null;
}

/**
 * In-flight task runs whose subject is this media item — the SSR seed for the
 * client-side run tracker, so a run started before this page loaded (or in
 * another tab, or by another admin) is visible on a cold load instead of the
 * page rendering as though nothing were running.
 *
 * Two deliberate costs, both called out in the design: this runs on EVERY cold
 * load of the media page (the load does not re-run per `?tab=`), and
 * `orchestrator.listRuns` uses the TASK pool while the rest of this load uses
 * the web pool, so a page view now also takes a task-pool connection. At the
 * typical 0-2 subject runs that is negligible.
 *
 * The 7-day `since` bound keeps the query serviceable on
 * `idx_task_history_started_id` even where the 16.219.0 subject index build was
 * skipped by its large-table guard.
 */
async function loadSubjectRuns(subjectId: string): Promise<Run[]> {
    try {
        const { runs } = await orchestrator.listRuns({
            subjectId,
            state: ['pending', 'active', 'cancelling'],
            since: new Date(Date.now() - SEVEN_DAYS_MS),
            limit: 50,
        });
        return runs;
    } catch (err: unknown) {
        // Degrade to "nothing seeded" rather than 500ing an admin page over the
        // task pool: the tracker re-fetches from /api/runs on mount anyway.
        logger.error(
            'listRuns for subject failed; degrading to an empty seed',
            err instanceof Error ? err : new Error(String(err)),
            { subjectId },
        );
        return [];
    }
}

export const load: PageServerLoad = async ({ params, locals, depends, url }) => {
    // Invalidation key used by `onSettled` in the tabs. Narrower than
    // invalidateAll() (it does not re-run layout loads), but NOT per-query:
    // depends() registers the key for the WHOLE load, so the media item,
    // external ids, lock status and series health re-run too. Acceptable at
    // terminal-transition frequency; the tracker owns live state via the bus.
    depends('media:runs');

    if (!localsIsAdmin(locals)) {
        throw error(403, 'Admin access required');
    }

    const canonical = canonicalDetailTab(url.searchParams.get('tab'));
    if (url.searchParams.has('tab') && canonical.tab !== url.searchParams.get('tab')) {
        const target = new URL(url);
        target.searchParams.set('tab', canonical.tab);
        if (canonical.section) target.searchParams.set('section', canonical.section);
        throw redirect(303, target.pathname + target.search);
    }

    const sql = getDb();
    if (!sql) {
        throw error(503, 'Database not available');
    }

    const mediaId = params.id;
    // `id` is a uuid column: anything else (a typo, an old bookmark) would raise
    // a cast error and 500 instead of the 404 below.
    if (!isUuid(mediaId)) {
        throw error(404, 'Media item not found');
    }

    // Load media item
    const item = await getMediaItemById(sql, mediaId);
    if (!item) {
        throw error(404, 'Media item not found');
    }

    // The item's issues (triage spec §7), from the browser's own list query
    // and mapping so the detail page and the list row agree. File problems on
    // the item's OWN files are left to FileIssuesPanel, which already shows
    // them with per-file detail; a series' rolled-up episode problems stay,
    // since that panel only covers the item's own files. Best-effort: a
    // failure here costs the strip, not the page.
    let issues: MediaIssue[] = [];
    try {
        const [row] = await listAdminMediaItems(sql, {
            types: [item.media_type],
            itemIds: [item.id],
            showUnavailable: true,
            showDismissed: true,
            limit: 1,
            offset: 0,
        });
        if (row) {
            issues = issuesForAdminRow(row, features.jellyfinSync).filter(
                (i) => i.kind !== 'file_problem' || i.subtype === 'episodes',
            );
        }
    } catch (err: unknown) {
        logger.warn('Detail issues strip failed', { mediaId, error: String(err) });
    }

    // Load auxiliary detail data in parallel. Each call is wrapped so
    // a JSONB-shape mismatch or null reference degrades the affected field
    // to a safe default instead of turning the whole admin page into a 500.
    // The pipeline tab pulls its data from a separate API endpoint, so the
    // page must keep rendering even if the auxiliary queries throw.
    const [externalIdsObj, activeRuns, fileSummaryOutcome, lastSyncedAt] = await Promise.all([
        getAllExternalIds.one(sql, { mediaId }).catch((err: unknown) => {
            logger.error(
                'getAllExternalIds failed; degrading to empty',
                err instanceof Error ? err : new Error(String(err)),
                { mediaId },
            );
            return null;
        }),
        loadSubjectRuns(item.id),
        // `determined: false` means "we could not establish this item's file
        // state" and must NOT be treated the same as a genuine zero — the
        // action bar's `hasFiles` fails OPEN on it (see actionCtx below),
        // rather than silently hiding a Watch link on an item that does
        // have files. Audiobooks are the one case where `{ count: 0 }` is
        // the correct, fully-determined answer rather than a fallback:
        // their bytes live on the AudiobookShelf server, so a book has no
        // media_files rows and this is a guaranteed-empty aggregate on
        // every page view, not something the query could have failed to
        // establish. `fileSummary` itself stays non-optional either way.
        isAudiobookType(item.media_type)
            ? Promise.resolve<{ summary: MediaFileSummary; determined: boolean }>({
                  summary: { count: 0, totalBytes: null },
                  determined: true,
              })
            : getMediaFileSummary(sql, mediaId)
                  .then((summary) => ({ summary, determined: true }))
                  .catch((err: unknown) => {
                      logger.error(
                          'getMediaFileSummary failed; degrading to an UNDETERMINED zero (not a genuine "no files")',
                          err instanceof Error ? err : new Error(String(err)),
                          { mediaId },
                      );
                      const degraded: MediaFileSummary = { count: 0, totalBytes: null };
                      return { summary: degraded, determined: false };
                  }),
        getLastProviderSyncAt(sql, mediaId).catch((err: unknown) => {
            logger.error(
                'getLastProviderSyncAt failed; degrading to undefined',
                err instanceof Error ? err : new Error(String(err)),
                { mediaId },
            );
            return undefined;
        }),
    ]);

    const fileSummary = fileSummaryOutcome.summary;
    const fileSummaryDetermined = fileSummaryOutcome.determined;

    // For music/audio: extract custom_metadata as audioFeatures
    let audioFeatures: Record<string, unknown> | null = null;
    if (
        item.media_type === 'artist' ||
        item.media_type === 'album' ||
        item.media_type === 'track'
    ) {
        const raw: unknown = item.custom_metadata;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            audioFeatures = raw as Record<string, unknown>;
        }
    }

    // For non-entertainment items: extract custom_metadata as a dedicated field
    // (separate from audioFeatures to avoid dual-prop aliasing and latent music-UI risk)
    let nonEntertainmentMetadata: Record<string, unknown> | null = null;
    if (isNonEntertainment(item.media_type)) {
        const raw: unknown = item.custom_metadata;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            nonEntertainmentMetadata = raw as Record<string, unknown>;
        }
    }

    const isAudiobook = isAudiobookType(item.media_type);

    // File-health issues across this item and its descendants, so the Overview
    // can say what is wrong with the media itself rather than making the admin
    // find the Files tab. Degrades to an empty list — a broken annotation query
    // must not take the whole detail page down.
    //
    // Skipped entirely for audiobooks: their bytes live on the AudiobookShelf
    // server, so a book has no `media_files` rows to carry health issues and this
    // is a guaranteed-empty tree walk on every page view.
    const fileIssues = isAudiobook
        ? []
        : await getFileHealthIssuesForItemTree(sql, mediaId).catch((err: unknown) => {
              logger.error(
                  'getFileHealthIssuesForItemTree failed; degrading to no file issues',
                  err instanceof Error ? err : new Error(String(err)),
                  { mediaId },
              );
              return [];
          });

    // The AudiobookShelf payload behind the Book tab. Degrades to null on a bad
    // read so the page still renders the item's title, artwork and delete
    // control — the things an operator needs when a book is broken enough that
    // this query is the thing that failed.
    const audiobookDetail = isAudiobook
        ? await getAudiobookAdminDetail(sql, mediaId).catch((err: unknown) => {
              logger.error(
                  'getAudiobookAdminDetail failed; degrading to null',
                  err instanceof Error ? err : new Error(String(err)),
                  { mediaId },
              );
              return null;
          })
        : null;

    // For series: load child counts and the live episode coverage in parallel
    let episodeCoverage: SeriesEpisodeCoverage | null = null;
    let seasonCoverage: SeasonCoverage[] = [];
    let childCounts: { seasons: number; episodes: number } | null = null;
    let healthStatus: 'healthy' | 'notice' | 'warning' | 'mismatch' | 'unknown' | null = null;
    let healthDetail: {
        episodeCountLocal: number;
        episodeCountProvider: number;
        seasonCountLocal: number;
        seasonCountProvider: number;
    } | null = null;

    if (isSeriesType(item.media_type)) {
        const [counts, coverage] = await Promise.all([
            getMediaItemChildCounts(sql, mediaId).catch((err: unknown) => {
                logger.error(
                    'getMediaItemChildCounts failed; degrading to unknown counts',
                    err instanceof Error ? err : new Error(String(err)),
                    { mediaId },
                );
                return null;
            }),
            getSeriesEpisodeCoverage(sql, getPrimaryExternalIdProvider(), mediaId).catch(
                (err: unknown) => {
                    logger.error(
                        'getSeriesEpisodeCoverage failed; degrading to null',
                        err instanceof Error ? err : new Error(String(err)),
                        { mediaId },
                    );
                    return null;
                },
            ),
        ]);
        // A failed count stays null (unknown), not 0: the header would show
        // "0 seasons" and the sidebar rule would collapse over a real series.
        childCounts = counts
            ? { seasons: counts.seasonCount, episodes: counts.episodeCount }
            : null;
        episodeCoverage = coverage;
        seasonCoverage = await getSeasonCoverageBatch(sql, getPrimaryExternalIdProvider(), [
            mediaId,
        ]).catch(() => []);
        if (coverage) {
            healthStatus = coverageHealthStatus(coverage);
            healthDetail = {
                episodeCountLocal: coverage.episodesHeld,
                episodeCountProvider: coverage.episodesListed,
                seasonCountLocal: coverage.seasonsHeld,
                seasonCountProvider: coverage.seasonsListed,
            };
        }
    }

    // Resolve parent chain for breadcrumbs using recursive CTE (single query)
    const parentChain: AncestorInfo[] = [];
    let seriesId: string | null = null;
    let ancestorChainFailed = false;

    if (isSeriesType(item.media_type)) {
        seriesId = mediaId;
    } else if (item.parent_id) {
        const ancestors = await resolveAncestorChain(sql, mediaId).catch((err: unknown) => {
            logger.error(
                'resolveAncestorChain failed; degrading to empty chain',
                err instanceof Error ? err : new Error(String(err)),
                { mediaId },
            );
            return null;
        });

        if (ancestors === null) {
            // CTE failed — attempt a shallow two-level parent walk to recover seriesId/artistId.
            // This avoids silently passing the item's own UUID as the series/artist ID to child tabs.
            ancestorChainFailed = true;
            try {
                const directParent = await getMediaItemById(sql, item.parent_id);
                if (directParent) {
                    parentChain.push({
                        id: directParent.id,
                        title: directParent.title,
                        mediaType: directParent.media_type,
                        seasonNumber: directParent.season_number,
                    });
                    if (isSeriesType(directParent.media_type)) {
                        seriesId = directParent.id;
                    } else if (directParent.parent_id) {
                        // Episode → season → series: fetch the grandparent
                        const grandParent = await getMediaItemById(sql, directParent.parent_id);
                        if (grandParent) {
                            parentChain.unshift({
                                id: grandParent.id,
                                title: grandParent.title,
                                mediaType: grandParent.media_type,
                                seasonNumber: grandParent.season_number,
                            });
                            if (isSeriesType(grandParent.media_type)) {
                                seriesId = grandParent.id;
                            }
                        }
                    }
                }
            } catch (fallbackErr: unknown) {
                logger.error(
                    'Shallow parent fallback also failed; seriesId will remain null',
                    fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)),
                    { mediaId },
                );
            }
        } else {
            for (const ancestor of ancestors) {
                parentChain.push({
                    id: ancestor.id,
                    title: ancestor.title,
                    mediaType: ancestor.media_type,
                    seasonNumber: ancestor.season_number,
                });
                if (isSeriesType(ancestor.media_type)) {
                    seriesId = ancestor.id;
                }
            }
            // resolveAncestorChain returns parent→root order; reverse for root→child
            parentChain.reverse();
        }
    }

    // For music items: resolve the root artist ID
    let artistId: string | null = null;
    if (item.media_type === 'artist') {
        artistId = mediaId;
    } else if (item.media_type === 'album' || item.media_type === 'track') {
        for (const ancestor of parentChain) {
            if (ancestor.mediaType === 'artist') {
                artistId = ancestor.id;
                break;
            }
        }
    }

    // Guard: seasons and episodes require a resolved seriesId to render correctly.
    // The EpisodesTab and SeasonDetailTab components receive seriesId as a prop and
    // use it as the key for all API calls. If seriesId is null here, the Svelte page
    // falls back to data.mediaItem.id (the season/episode's own UUID), which causes
    // those tabs to silently query the wrong resource. Surfacing a clear server error
    // is safer than rendering with a guaranteed-wrong ID.
    if (
        seriesId === null &&
        item.parent_id &&
        (isSeasonType(item.media_type) || isEpisodeType(item.media_type))
    ) {
        logger.error(
            'Could not resolve seriesId for season/episode after all fallbacks — aborting render',
            new Error('unresolvable ancestor chain'),
            { mediaId, mediaType: item.media_type, parentId: item.parent_id },
        );
        throw error(
            502,
            'Could not resolve parent series for this item. The database hierarchy may be inconsistent.',
        );
    }

    // How many rows the hierarchy sidebar will render, for the client's
    // auto-collapse rule (sidebar-collapse.ts). `null` means "could not be
    // determined" and must stay `null` all the way to the client — the rule
    // treats an unknown count differently from a real zero, collapsing over a
    // genuinely empty hierarchy but never collapsing just because this page
    // had nothing to report. A query failure therefore also degrades to
    // `null`, not `0`.
    let sidebarEntryCount: number | null = null;
    if (isSeriesType(item.media_type)) {
        // Series page: the season count computed above already answers this
        // at no extra query — this IS the sidebar's row count.
        sidebarEntryCount = childCounts?.seasons ?? null;
    } else if (isSeasonType(item.media_type) && seriesId) {
        // Season page: MediaHierarchySidebar's auto-expand effect only matches
        // `currentItemId` against an EPISODE id (it searches each season's
        // episode list for it), never a season's own id — so on a season page
        // every season row stays collapsed until the operator clicks one
        // open. The series' season count is exactly the rendered row count.
        sidebarEntryCount = await getMediaItemChildCounts(sql, seriesId)
            .then((counts) => counts.seasonCount)
            .catch((err: unknown) => {
                logger.error(
                    'getMediaItemChildCounts (sidebar entry count) failed; degrading to unknown',
                    err instanceof Error ? err : new Error(String(err)),
                    { mediaId, seriesId },
                );
                return null;
            });
    } else if (isEpisodeType(item.media_type) && seriesId && item.parent_id) {
        // Episode page: `currentItemId` IS an episode id here, so the same
        // auto-expand effect matches immediately and the sidebar renders
        // every episode of THIS item's own season alongside the season list,
        // with nothing to click first. The Episodes tab is also
        // series/season-only (see `episodesTabVisible` in +page.svelte), so
        // this sidebar is the only episode navigation an episode page has.
        // Counting only the series' season total (as a season page does)
        // undercounts what actually renders — a single-season show has
        // seasonCount === 1, which auto-collapsed the only way to reach a
        // sibling episode even when that one season had a dozen of them. The
        // row count here is the season total PLUS the episodes nested under
        // this item's own season.
        const seasonId = item.parent_id;
        sidebarEntryCount = await Promise.all([
            getMediaItemChildCounts(sql, seriesId),
            getMediaItemChildCounts(sql, seasonId),
        ])
            .then(
                ([seriesCounts, seasonCounts]) =>
                    seriesCounts.seasonCount + seasonCounts.episodeCount,
            )
            .catch((err: unknown) => {
                logger.error(
                    'getMediaItemChildCounts (sidebar entry count, episode page) failed; degrading to unknown',
                    err instanceof Error ? err : new Error(String(err)),
                    { mediaId, seriesId, seasonId },
                );
                return null;
            });
    } else if (artistId) {
        sidebarEntryCount = await getArtistAlbumCount(sql, artistId).catch((err: unknown) => {
            logger.error(
                'getArtistAlbumCount (sidebar entry count) failed; degrading to unknown',
                err instanceof Error ? err : new Error(String(err)),
                { mediaId, artistId },
            );
            return null;
        });
    }

    const tmdbContext: TmdbContext = {
        seasonNumber: item.season_number,
        episodeNumber: item.episode_number,
    };
    if ((isEpisodeType(item.media_type) || isSeasonType(item.media_type)) && seriesId) {
        const seriesIds = await getAllExternalIds.one(sql, { mediaId: seriesId }).catch(() => null);
        tmdbContext.seriesTmdbId = seriesIds?.tmdb_id ?? null;
    }
    const tmdbUrl = tmdbIdentityUrl(item.media_type, externalIdsObj?.tmdb_id, tmdbContext);

    const musicSummary =
        item.media_type === 'album' || item.media_type === 'artist'
            ? await getMusicContainerSummary(sql, mediaId).catch(() => null)
            : null;

    const languageSummary = isEpisodeType(item.media_type)
        ? ((await getEpisodeLanguageSummaries(sql, [mediaId])).get(mediaId) ?? null)
        : null;
    return {
        languageSummary,
        issues,
        musicSummary,
        tmdbUrl,
        tmdbContext,
        activeRuns,
        parentChain,
        seriesId,
        artistId,
        ancestorChainFailed,
        mediaItem: {
            id: item.id,
            title: item.title ?? 'Untitled',
            titleSource: item.title_source ?? undefined,
            dismissed: item.is_dismissed,
            canonicalId: item.canonical_id ?? undefined,
            originalTitle: item.original_title ?? undefined,
            englishTitle: item.english_title ?? undefined,
            year: item.year ?? undefined,
            mediaType: item.media_type,
            status: item.status ?? undefined,
            parentId: item.parent_id ?? undefined,
            seasonNumber: item.season_number ?? undefined,
            episodeNumber: item.episode_number ?? undefined,
            runtimeSeconds: item.runtime_seconds ?? undefined,
            premiereDate: item.premiere_date ?? undefined,
            overview: item.overview ?? undefined,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
        },
        externalIds: externalIdsObj
            ? {
                  internal: externalIdsObj.internal_id ?? undefined,
                  tmdb: externalIdsObj.tmdb_id != null ? String(externalIdsObj.tmdb_id) : undefined,
                  imdb: externalIdsObj.imdb_id ?? undefined,
                  jellyfin: externalIdsObj.jellyfin_id ?? undefined,
                  tvdb: externalIdsObj.tvdb_id != null ? String(externalIdsObj.tvdb_id) : undefined,
              }
            : {},
        lockStatus: {
            locked: item.metadata_locked,
            lockedBy: item.metadata_locked_by,
            lockedAt: item.lock_version ?? undefined,
        },
        childCounts,
        /**
         * Row count for the hierarchy sidebar's auto-collapse rule — see
         * `sidebar-collapse.ts`. `null` means "unknown", which the rule must
         * never treat as zero.
         */
        sidebarEntryCount,
        healthStatus,
        healthDetail,
        episodeCoverage,
        seasonCoverage,
        fileIssues: fileIssues.map((r) => ({
            fileId: r.file_id,
            filePath: r.file_path,
            mediaItemId: r.media_item_id,
            mediaTitle: r.media_title,
            seasonNumber: r.season_number,
            episodeNumber: r.episode_number,
            // Issue objects stay in their stored snake_case shape on purpose:
            // the shared formatter reads those field names, and the Files tab
            // already receives them straight from the API that way. Converting
            // here produced a panel that read "ends at 0s but reports 0s".
            issues: r.issues,
        })),
        /**
         * File totals for the header's state line. NOT already in this payload —
         * `fileIssues` only covers files that HAVE an issue, so it cannot answer
         * "how many files does this item have and how big are they". Always
         * `{ count: 0, totalBytes: null }` when `fileSummaryDetermined` is
         * `false` — see that field before treating a zero count here as
         * "genuinely has no files".
         */
        fileSummary,
        /**
         * Whether `fileSummary` is a real answer (including a genuine zero,
         * e.g. an audiobook or a movie with no files) rather than a fallback
         * from a failed query. The header must not render a bogus file count
         * off an undetermined summary, and the action bar's `hasFiles` must
         * fail OPEN — not closed — when this is `false`, so a DB hiccup can't
         * silently remove a working Watch link.
         */
        fileSummaryDetermined,
        /**
         * When a metadata provider last wrote to this item. Feeds the header's
         * state line so an operator can tell a stale item from a fresh one
         * without opening the Sync tab.
         */
        lastSyncedAt,
        discogsAttribution:
            item.media_type === 'artist' || item.media_type === 'album'
                ? projectDiscogsAttribution(
                      item.custom_metadata,
                      item.media_type === 'artist' ? 'artist_enrichment' : 'album_enrichment',
                      {
                          poster: item.custom_poster_url,
                          backdrop: item.custom_backdrop_url,
                          logo: item.custom_logo_url,
                      },
                  )
                : undefined,
        audioFeatures,
        nonEntertainmentMetadata,
        audiobookDetail,
        /**
         * The AudiobookShelf server this install syncs from, for the Book tab's
         * deep link. Null (rather than an empty string) when unconfigured, so the
         * tab suppresses the link instead of rendering `/item/li_abc`.
         */
        absBaseUrl: isAudiobook ? config.AUDIOURL || null : null,
        maxImageUploadMb: config.MAX_IMAGE_UPLOAD_MB,
    };
};
