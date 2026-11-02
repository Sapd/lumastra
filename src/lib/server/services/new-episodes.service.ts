// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * New Episodes Service — "New episodes available".
 *
 * Newly RELEASED episodes of series the user follows, from the library alone
 * (no Sonarr). The rule is `new-release-rule.ts`; this module loads its input
 * (`new-release-episodes.queries.ts`), applies the user's mutes and banner
 * dismissals and the access boundary, and shapes the result for its two
 * surfaces:
 *
 * - {@link getNewReleaseGroupsForUser} + {@link buildNewEpisodePreviews}: one
 *   card per series for `GET /api/v1/for-you/new-episodes` (the web banner).
 * - {@link getNewEpisodesForUser}: one item per qualifying episode, merged into
 *   the watching strip by `effective-watching.service.ts`.
 *
 * Back-catalogue arrivals (a fulfilled request, a season pack, a newly added
 * old series) never qualify; they are shown by "Recently added" and "Your
 * requests are ready" (`fulfilled-requests`).
 *
 * The `library.new_episode` push (`user-notifier.service.ts`) applies the
 * same rule in the series → users direction.
 */

import type postgres from 'postgres';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { getActiveFlagTargets } from '$lib/server/database/queries/user-media-flags.queries.js';
import {
    getEpisodeArrivalsForSeries,
    getSeriesFollowStates,
    isAiringStatus,
    type EpisodeArrivalRow,
} from '$lib/server/database/queries/new-release-episodes.queries.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { filterAccessibleMediaIds } from '$lib/server/utils/media-access-batch.js';
import { Logger } from '$lib/server/utils/logger';
import { getCatalogPosterUrl } from '$lib/utils/image-utils.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { UserId } from '$lib/shared/user-id';
import { buildMediaPreviews, type MediaPreviewInput } from './media-preview.service.js';
import type { NewEpisodeAlert } from '$lib/schemas/api-for-you-responses.js';
import {
    isSeasonPremiere,
    isSeriesExcludedFor,
    loadSeriesExclusionsForUser,
    SERIES_INTEREST_MOMENT_GAP_SECONDS,
} from './series-interest.service.js';
import {
    DEFAULT_NEW_RELEASE_CONFIG,
    followReasonFor,
    releaseDateOf,
    selectNewReleases,
    type EpisodeCandidate,
    type FollowReason,
    type NewReleaseConfig,
    type SeriesFollowState,
} from './new-release-rule.js';

const logger = Logger.for('NewEpisodesService');

/** One episode as the rule sees it, plus what the surfaces display. */
export interface NewReleaseEpisode extends EpisodeCandidate {
    title: string | null;
    overview: string | null;
    runtimeSeconds: number | null;
}

export interface NewReleaseSeries extends SeriesFollowState {
    seriesTitle: string;
}

export interface NewReleaseSeriesGroup {
    series: NewReleaseSeries;
    followReason: FollowReason;
    /** Qualifying episodes in watch order; the first is the one to show. */
    episodes: NewReleaseEpisode[];
}

export interface NewReleaseOptions {
    /** Caller's library/age boundary; omit only when the caller vets the result itself. */
    access?: MediaAccessBoundary;
    /**
     * Series hidden with the banner's "Hide" (`new_episode_alert_dismissed`).
     * Loaded here when omitted.
     */
    dismissedSeriesIds?: ReadonlySet<string>;
    now?: Date;
    config?: NewReleaseConfig;
}

function toEpisode(row: EpisodeArrivalRow): NewReleaseEpisode {
    return {
        id: row.id,
        seriesId: row.series_id,
        seasonNumber: Number(row.season_number),
        episodeNumber: Number(row.episode_number),
        airDate: row.air_date,
        fileAddedAt: row.file_added_at,
        hasFile: true,
        watched: row.watched,
        title: row.title,
        overview: row.overview,
        runtimeSeconds: row.runtime_seconds,
    };
}

/** Every followed series with at least one new release, newest release first. */
export async function getNewReleaseGroupsForUser(
    sql: postgres.Sql,
    userId: UserId,
    options: NewReleaseOptions = {},
): Promise<NewReleaseSeriesGroup[]> {
    const config = options.config ?? DEFAULT_NEW_RELEASE_CONFIG;
    const now = options.now ?? new Date();

    const [rows, exclusions, dismissed] = await Promise.all([
        getSeriesFollowStates(sql, userId, SERIES_INTEREST_MOMENT_GAP_SECONDS),
        loadSeriesExclusionsForUser(sql, userId),
        options.dismissedSeriesIds
            ? Promise.resolve(options.dismissedSeriesIds)
            : getActiveFlagTargets(sql, { userId, flagType: 'new_episode_alert_dismissed' })
                  .then((ids) => new Set(ids))
                  .catch((error: unknown) => {
                      // Non-fatal: a dismissed banner may reappear once.
                      logger.warn('Failed to load new_episode_alert_dismissed flags', {
                          error: (error as Error).message,
                      });
                      return new Set<string>();
                  }),
    ]);

    let series: NewReleaseSeries[] = rows
        .map((r): NewReleaseSeries => ({
            seriesId: r.series_id,
            seriesTitle: r.series_title,
            watchedEpisodeCount: r.watched_episode_count,
            watchedMomentCount: r.watched_moment_count,
            lastWatchedAt: r.last_watched_at,
            newestWatchedAirDate: r.newest_watched_air_date,
            explicitlyFollowed: r.explicitly_followed,
            inWatchlist: r.in_watchlist,
            airing: isAiringStatus(r.series_status),
        }))
        .filter((s) => followReasonFor(s, config) !== null)
        .filter((s) => !isSeriesExcludedFor(exclusions, s.seriesId))
        .filter((s) => !dismissed.has(s.seriesId));

    if (options.access && series.length > 0) {
        const allowed = await filterAccessibleMediaIds(
            sql,
            series.map((s) => s.seriesId),
            options.access,
        );
        series = series.filter((s) => allowed.has(s.seriesId));
    }
    if (series.length === 0) return [];

    // Enough history to see an episode's whole arrival batch.
    const lookbackDays = config.windowDays + Math.ceil(config.bulkSpanHours / 24) + 1;
    const arrivals = await getEpisodeArrivalsForSeries(
        sql,
        userId,
        series.map((s) => s.seriesId),
        lookbackDays,
    );
    const groups = selectNewReleases(series, arrivals.map(toEpisode), now, config);
    return groups.map((g) => ({
        series: g.series as NewReleaseSeries,
        followReason: g.followReason,
        episodes: g.episodes,
    }));
}

/**
 * One card per series: the first qualifying episode (in watch order), with
 * how many episodes qualify and how many the user has watched.
 */
export async function buildNewEpisodePreviews(
    sql: postgres.Sql,
    groups: readonly NewReleaseSeriesGroup[],
    surface: ApiSurface,
    userId?: string,
): Promise<NewEpisodeAlert[]> {
    const inputs: MediaPreviewInput[] = groups.map((g) => {
        const ep = g.episodes[0];
        const released = releaseDateOf(ep, g.series);
        return {
            id: ep.id,
            type: 'episode',
            title: ep.title ?? `Episode ${ep.episodeNumber}`,
            overview: ep.overview,
            runtimeMinutes: ep.runtimeSeconds ? Math.round(ep.runtimeSeconds / 60) : null,
            context: {
                series: {
                    id: g.series.seriesId,
                    catalogId: g.series.seriesId,
                    title: g.series.seriesTitle,
                },
                seasonNumber: ep.seasonNumber,
                episodeNumber: ep.episodeNumber,
                ...(released && { airDate: released.toISOString() }),
            },
            isAvailable: true,
            hasFile: true,
            canRequest: false,
            reason: { kind: 'new_release', label: `S${ep.seasonNumber}E${ep.episodeNumber}` },
        };
    });
    const previews = await buildMediaPreviews(sql, surface, inputs, userId);
    const groupByEpisode = new Map(groups.map((g) => [g.episodes[0].id, g]));
    return previews.flatMap((preview) => {
        const g = groupByEpisode.get(preview.id);
        if (!g) return [];
        return [
            {
                ...preview,
                newEpisodes: {
                    count: g.episodes.length,
                    watchedEpisodeCount: g.series.watchedEpisodeCount,
                    followReason: g.followReason,
                },
            },
        ];
    });
}

export interface NewEpisodeItem {
    /** Internal UUID of the episode row. */
    episodeId: string;
    /** Internal UUID of the series row. */
    seriesId: string;
    externalIds?: { tmdb?: string };
    seriesName: string;
    episodeTitle: string;
    seasonNumber: number;
    episodeNumber: number;
    /** Release date: the air date, or the file arrival for an undated episode of an airing show. */
    airDate: Date;
    overview?: string;
    runtimeSeconds?: number;
    posterUrl: string;
    /** Qualifying new episodes of this series. */
    episodeCount: number;
    /** Episodes of this series the user has watched. */
    userWatchCount: number;
    lastWatchedDate: Date | null;
    isSeasonPremiere: boolean;
    followReason: FollowReason;
}

export interface GetNewEpisodesOptions {
    limit?: number;
    dismissedSeriesIds?: ReadonlySet<string>;
    now?: Date;
}

/**
 * Every qualifying episode for the watching strip, newest release first.
 * Applies no access boundary: `effective-watching.service.ts` vets the items
 * by series id itself.
 */
export async function getNewEpisodesForUser(
    sql: postgres.Sql,
    username: string,
    options: GetNewEpisodesOptions = {},
): Promise<NewEpisodeItem[]> {
    const { limit = 10 } = options;
    try {
        const uid = await getUserIdByUsername(sql, username);
        if (!uid) return [];
        const groups = await getNewReleaseGroupsForUser(sql, uid, {
            dismissedSeriesIds: options.dismissedSeriesIds,
            now: options.now,
        });
        const items: NewEpisodeItem[] = [];
        for (const g of groups) {
            for (const ep of g.episodes) {
                const released = releaseDateOf(ep, g.series) ?? new Date();
                items.push({
                    episodeId: ep.id,
                    seriesId: g.series.seriesId,
                    externalIds: createExternalIds({ internal: g.series.seriesId }),
                    seriesName: g.series.seriesTitle,
                    episodeTitle: ep.title || `Episode ${ep.episodeNumber}`,
                    seasonNumber: ep.seasonNumber,
                    episodeNumber: ep.episodeNumber,
                    airDate: released,
                    overview: ep.overview ?? undefined,
                    runtimeSeconds: ep.runtimeSeconds ?? undefined,
                    posterUrl: getCatalogPosterUrl(g.series.seriesId, { size: 'thumb' }),
                    episodeCount: g.episodes.length,
                    userWatchCount: g.series.watchedEpisodeCount,
                    lastWatchedDate: g.series.lastWatchedAt,
                    isSeasonPremiere: isSeasonPremiere(ep),
                    followReason: g.followReason,
                });
            }
        }
        items.sort((a, b) => b.airDate.getTime() - a.airDate.getTime());
        return items.slice(0, limit);
    } catch (error) {
        logger.error('Failed to get new episodes', error as Error, { username });
        return [];
    }
}
