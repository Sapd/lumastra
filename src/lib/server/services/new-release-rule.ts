// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The "New episodes available" rule: which library episodes count as a NEW
 * RELEASE for one user. Pure — the SQL that feeds it lives in
 * `new-release-episodes.queries.ts`. It decides both the banner and the
 * watching strip (`new-episodes.service.ts`, user → series) and the
 * `library.new_episode` notification (`user-notifier.service.ts`,
 * series → users), so the two never disagree about what is new.
 *
 * The row is for newly RELEASED episodes of series the user follows (a new
 * episode the week it airs). It is not a "recently added" list: a fulfilled
 * request, a season pack or a newly added old series brings files with old
 * air dates, and none of those qualify. They belong in "Recently added" and
 * "Your requests are ready".
 *
 * An episode qualifies when ALL of these hold:
 *
 * 1. It has a file and the user has not watched it.
 * 2. The user follows the series (`followReasonFor`): watched at least
 *    `minWatchedEpisodes` episodes, explicitly follows it (the per-series
 *    episode notification switch, `series_episode_notifications`), or has it
 *    on the watchlist and has watched at least one episode. Watched episodes
 *    are counted as viewing moments (`series-interest.service.ts`): a bulk
 *    "mark season watched" is one moment, not a fan.
 * 3. It is a new release (`releaseDateOf` + `isNewRelease`): its release date
 *    is within the last `windowDays` days (up to `futureToleranceHours` ahead,
 *    for time-zone skew), AND it was released after the user last watched the
 *    series, OR it is newer than the newest episode the user has watched (the
 *    user has not reached it yet).
 *    The release date is the air date, unless the file arrived EARLIER: a
 *    file that is in the library before its stored air date (simulcasts,
 *    regional releases, a TMDB date of the wrong time zone; on prod weekly
 *    shows arrived up to 6.4 days early) is released when it arrived. That
 *    only holds up to `earlyFileDays` before the air date; a file further
 *    ahead keeps the air date, so a far-future or bad date still never
 *    qualifies. An episode without an air date falls back to the time its
 *    file arrived, but only when the series is still airing
 *    (`airing === true`) and only for regular seasons: an undated special or
 *    an ended show's undated episode never qualifies.
 * 4. It did not arrive in a bulk back-catalogue import (`isBulkArrival`): when
 *    `bulkMinEpisodes` or more episodes of the series arrived within
 *    `bulkSpanHours` of each other and at least half of that batch is old (or
 *    undated), nothing in the batch qualifies — not even its one recent
 *    episode. A new season released all at once has recent air dates, so it
 *    is not a bulk import.
 *
 * Specials (season 0) follow the same rule; they just never use the
 * file-arrival fallback.
 */

export interface NewReleaseConfig {
    /** How old a release may be and still count as new. */
    windowDays: number;
    /** Watched episodes that make a series "followed" on their own. */
    minWatchedEpisodes: number;
    /** Batch size from which an arrival counts as a possible bulk import. */
    bulkMinEpisodes: number;
    /** Files that arrive within this span of each other form one batch. */
    bulkSpanHours: number;
    /** Air dates up to this far in the future still count (time zones). */
    futureToleranceHours: number;
    /**
     * A file that arrived up to this many days before its air date is
     * released when it arrived (see `releaseDateOf`).
     */
    earlyFileDays: number;
}

export const DEFAULT_NEW_RELEASE_CONFIG: Readonly<NewReleaseConfig> = Object.freeze({
    windowDays: 30,
    minWatchedEpisodes: 2,
    bulkMinEpisodes: 5,
    bulkSpanHours: 24,
    futureToleranceHours: 24,
    earlyFileDays: 10,
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Why a series counts as followed. */
export type FollowReason = 'watched' | 'followed' | 'watchlist';

export interface SeriesFollowState {
    seriesId: string;
    /** Distinct episodes of the series the user has watched (for display). */
    watchedEpisodeCount: number;
    /**
     * Viewing moments: watched episodes less than two minutes apart count once,
     * so a bulk mark is one moment. The follow threshold applies to this.
     */
    watchedMomentCount: number;
    /** Last time the user finished an episode of the series. */
    lastWatchedAt: Date | null;
    /** Newest air date among the episodes the user has watched. */
    newestWatchedAirDate: Date | null;
    /** The user switched on episode notifications for the series. */
    explicitlyFollowed: boolean;
    inWatchlist: boolean;
    /** true = still airing, false = ended, null = unknown. */
    airing: boolean | null;
}

export interface EpisodeCandidate {
    id: string;
    seriesId: string;
    seasonNumber: number;
    episodeNumber: number;
    /** Air date (a calendar day, read as UTC midnight); null when unknown. */
    airDate: Date | null;
    /** When the file arrived in the library. */
    fileAddedAt: Date | null;
    hasFile: boolean;
    watched: boolean;
}

export interface NewReleaseGroup<E extends EpisodeCandidate = EpisodeCandidate> {
    series: SeriesFollowState;
    followReason: FollowReason;
    /** Qualifying episodes, in watch order (season, then episode). */
    episodes: E[];
}

export function followReasonFor(
    series: SeriesFollowState,
    config: NewReleaseConfig = DEFAULT_NEW_RELEASE_CONFIG,
): FollowReason | null {
    if (series.explicitlyFollowed) return 'followed';
    if (series.watchedMomentCount >= config.minWatchedEpisodes) return 'watched';
    if (series.inWatchlist && series.watchedMomentCount >= 1) return 'watchlist';
    return null;
}

/** The file arrived before the air date, and by no more than `earlyFileDays`. */
function arrivedEarly(episode: EpisodeCandidate, config: NewReleaseConfig): boolean {
    if (!episode.airDate || !episode.hasFile || !episode.fileAddedAt) return false;
    const lead = episode.airDate.getTime() - episode.fileAddedAt.getTime();
    return lead > 0 && lead <= config.earlyFileDays * DAY_MS;
}

/** The date an episode was released, or null when it cannot be told. */
export function releaseDateOf(
    episode: EpisodeCandidate,
    series: SeriesFollowState,
    config: NewReleaseConfig = DEFAULT_NEW_RELEASE_CONFIG,
): Date | null {
    if (episode.airDate)
        return arrivedEarly(episode, config) ? episode.fileAddedAt : episode.airDate;
    if (series.airing === true && episode.seasonNumber > 0) return episode.fileAddedAt;
    return null;
}

/** Condition 3 of the rule for one episode. */
export function isNewRelease(
    episode: EpisodeCandidate,
    series: SeriesFollowState,
    now: Date,
    config: NewReleaseConfig = DEFAULT_NEW_RELEASE_CONFIG,
): boolean {
    const released = releaseDateOf(episode, series, config);
    if (!released) return false;
    const t = released.getTime();
    if (t < now.getTime() - config.windowDays * DAY_MS) return false;
    if (t > now.getTime() + config.futureToleranceHours * HOUR_MS) return false;
    // An air date is a calendar day; the episode is out from the END of that
    // day at the latest, so compare the day's end against the last watch. A
    // file arrival is an exact time.
    const releasedBy = released === episode.airDate ? t + DAY_MS : t;
    const afterLastWatch =
        series.lastWatchedAt === null || releasedBy > series.lastWatchedAt.getTime();
    // Episode order is told by air dates, also for a file that came early.
    const order = (episode.airDate ?? released).getTime();
    const beyondWatched =
        series.newestWatchedAirDate === null || order > series.newestWatchedAirDate.getTime();
    return afterLastWatch || beyondWatched;
}

/**
 * Condition 4: the episode's file arrived together with many others of the
 * same series, mostly old ones. `seriesArrivals` are all episodes of the
 * series with a file (watched or not), so a batch is judged as a whole.
 */
export function isBulkArrival(
    episode: EpisodeCandidate,
    series: SeriesFollowState,
    seriesArrivals: readonly EpisodeCandidate[],
    now: Date,
    config: NewReleaseConfig = DEFAULT_NEW_RELEASE_CONFIG,
): boolean {
    if (!episode.fileAddedAt) return false;
    const center = episode.fileAddedAt.getTime();
    const span = config.bulkSpanHours * HOUR_MS;
    const batch = seriesArrivals.filter(
        (e) => e.fileAddedAt !== null && Math.abs(e.fileAddedAt.getTime() - center) <= span,
    );
    if (batch.length < config.bulkMinEpisodes) return false;
    const oldBefore = now.getTime() - config.windowDays * DAY_MS;
    const old = batch.filter((e) => {
        const released = releaseDateOf(e, series, config);
        return released === null || released.getTime() < oldBefore;
    }).length;
    return old * 2 >= batch.length;
}

/**
 * Conditions 1, 3 and 4 for one episode of a series the caller already knows
 * the user follows (condition 2, `followReasonFor`). `seriesArrivals` as in
 * {@link isBulkArrival}. The `library.new_episode` notifier asks this for the
 * one episode that just became playable; {@link selectNewReleases} asks it
 * for every candidate.
 */
export function qualifiesAsNewRelease(
    episode: EpisodeCandidate,
    series: SeriesFollowState,
    seriesArrivals: readonly EpisodeCandidate[],
    now: Date,
    config: NewReleaseConfig = DEFAULT_NEW_RELEASE_CONFIG,
): boolean {
    return (
        episode.hasFile &&
        !episode.watched &&
        isNewRelease(episode, series, now, config) &&
        !isBulkArrival(episode, series, seriesArrivals, now, config)
    );
}

function byWatchOrder(a: EpisodeCandidate, b: EpisodeCandidate): number {
    // Specials (season 0) sort after the regular seasons.
    const sa = a.seasonNumber === 0 ? Number.MAX_SAFE_INTEGER : a.seasonNumber;
    const sb = b.seasonNumber === 0 ? Number.MAX_SAFE_INTEGER : b.seasonNumber;
    return sa - sb || a.episodeNumber - b.episodeNumber;
}

/**
 * Apply the whole rule. `episodes` may contain episodes of any series and any
 * state; everything that does not qualify is dropped. One group per followed
 * series with at least one qualifying episode, newest release first.
 */
export function selectNewReleases<E extends EpisodeCandidate>(
    series: readonly SeriesFollowState[],
    episodes: readonly E[],
    now: Date,
    config: NewReleaseConfig = DEFAULT_NEW_RELEASE_CONFIG,
): NewReleaseGroup<E>[] {
    const bySeries = new Map<string, E[]>();
    for (const ep of episodes) {
        if (!ep.hasFile) continue;
        const list = bySeries.get(ep.seriesId);
        if (list) list.push(ep);
        else bySeries.set(ep.seriesId, [ep]);
    }

    const groups: Array<NewReleaseGroup<E> & { newest: number }> = [];
    for (const s of series) {
        const followReason = followReasonFor(s, config);
        if (!followReason) continue;
        const arrivals = bySeries.get(s.seriesId) ?? [];
        const qualifying = arrivals.filter((ep) =>
            qualifiesAsNewRelease(ep, s, arrivals, now, config),
        );
        if (qualifying.length === 0) continue;
        qualifying.sort(byWatchOrder);
        const newest = Math.max(
            ...qualifying.map((ep) => releaseDateOf(ep, s, config)?.getTime() ?? 0),
        );
        groups.push({ series: s, followReason, episodes: qualifying, newest });
    }
    groups.sort((a, b) => b.newest - a.newest);
    return groups.map(({ newest: _newest, ...group }) => group);
}
