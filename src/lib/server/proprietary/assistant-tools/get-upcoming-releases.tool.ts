// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_upcoming_releases` tool — future EPISODE air dates from the release
 * calendar, so "wann kommt Staffel 3 von X" and "was kommt diese Woche raus"
 * are answered from `upcoming_releases` / `media_items.premiere_date` instead
 * of from the model's training memory. TEXT-ONLY.
 *
 * WHY EPISODES ONLY. `getCalendarItemsFromDb` has a movie branch, and it is
 * deliberately discarded here. `premiere_date` is populated on 26 of 12,687
 * movies in the real catalog (0.2%) because only `release-calendar-sync`
 * writes it, from Radarr's calendar; episodes sit at 95%. A tool that answers
 * "which movies come out this week" from a column that is empty 99.8% of the
 * time returns zero rows and the model narrates that emptiness as a fact about
 * the world. Dropping the rows and saying so in `coverageNote` is the honest
 * version, and it costs 2 rows in a 30-day window.
 *
 * WHY ~90 DAYS. `release-calendar-sync.ts` asks Sonarr for `now + 90 days`, so
 * the horizon is a property of the ingest, not a limit invented here: 354
 * episodes land inside 90 days and only 14 more in the following 275. Past
 * that the honest answer is "no date is known yet", which is exactly what a
 * model must not paper over with a remembered premiere date.
 *
 * THREE THINGS THE QUERY DOES NOT DO, and this tool therefore must:
 *   1. The `series_excluded` opt-out lives in the HTTP layer, not the query, so
 *      it is re-applied here via the shared id-based predicate. Skipping it makes the
 *      assistant announce shows the user muted in the calendar UI.
 *   2. The query is unbounded over its window (246 rows at 30 days). Grouping
 *      and capping happens here.
 *   3. The library access axis is a NO-OP on these rows — upcoming episodes
 *      have no files and no library group, and `buildLibraryAccessFilter`
 *      treats a file-less row as visible to everyone. Only the age axis bites
 *      (applied to the SERIES row by the query's deliberate alias split). The
 *      real control is the registry gate mirroring `/api/calendar`'s 403 for
 *      age-restricted profiles — do not remove it on the theory that the
 *      boundary handles it.
 *
 * @module server/proprietary/assistant-tools/get-upcoming-releases.tool
 */

import {
    getUpcomingReleasesArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetUpcomingReleasesArgs,
} from '../../../schemas/assistant-tools.js';
import {
    getCalendarItemsFromDb,
    type CalendarRow,
} from '../../database/queries/calendar.queries.js';
import { getWatchedSeriesIds } from '../../database/queries/episode-detail.queries.js';
import { searchMediaByTitle } from '../../database/queries/assistant-rag.queries.js';
import { isUnrestricted } from '../../database/queries/builders/media-access-boundary.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import { getExcludedSeriesKeys } from '../../utils/excluded-series.js';
import {
    hasExclusions,
    isCalendarRowExcluded,
    isCatalogItemExcluded,
    NO_EXCLUSIONS,
} from '../../utils/excluded-series-match.js';
import { normalizeTitle } from '../../utils/string-utils.js';
import { config } from '../../config.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

/** Default look-ahead for an open "what's coming up" question. */
const DEFAULT_DAYS = 7;
/** The sync horizon (`release-calendar-sync` requests now + 90 days). */
const MAX_DAYS = 90;
const MS_PER_DAY = 86_400_000;

const MAX_SERIES_LISTED = 40;
const MAX_EPISODES_PER_SERIES = 12;

/**
 * TMDB writes `Episode 12` as a stand-in when an episode has no announced
 * title. Passing that through invites the model to present it as a real one,
 * so it is nulled — 214 of the 246 upcoming catalog episodes are placeholders.
 */
const PLACEHOLDER_TITLE = /^Episode\s+\d+$/i;

/**
 * Both `media_items.premiere_date` and `upcoming_releases.air_date` are DATE,
 * not TIMESTAMP, and `release-calendar-sync` derives them from the UTC calendar
 * day of Sonarr's `airDateUtc` — discarding the network-local `airDate`. A
 * title broadcast 01:00 JST is therefore stored one day early, and this
 * library's upcoming list is dominated by anime. The skew is NOT corrected
 * here: matching the calendar UI matters more than being differently wrong.
 * The model is told to hedge instead.
 */
const DATE_NOTE =
    'Air dates are UTC calendar days from the release calendar, not confirmed local broadcast times, and can be off by a day for non-UTC networks. Say an episode "airs around" a date rather than stating a guaranteed broadcast time.';

const COVERAGE_NOTE =
    'TV episode air dates only, reaching about 90 days ahead. This library has no movie release dates — do not answer questions about upcoming MOVIES from this result.';

const HORIZON_NOTE =
    'The release calendar only holds about 90 days of future air dates, so a later date may simply not be announced yet rather than not existing.';

interface EpisodeEntry {
    season: number | null;
    episode: number | null;
    title: string | null;
    airDate: string | null;
    /** Present only when true: the file is already in the library. */
    onServer?: true;
}

interface SeriesGroup {
    title: string;
    inLibrary: boolean;
    watchedByUser?: boolean;
    nextAirDate: string | null;
    episodes: EpisodeEntry[];
    /** Set when the series had more episodes than `MAX_EPISODES_PER_SERIES`. */
    moreEpisodes?: number;
}

/** UTC calendar day, the same reduction `getCalendarItemsFromDb` applies. */
function utcDay(d: Date): string {
    return d.toISOString().split('T')[0];
}

function toEpisodeEntry(row: CalendarRow): EpisodeEntry {
    const title = row.title && !PLACEHOLDER_TITLE.test(row.title.trim()) ? row.title : null;
    const entry: EpisodeEntry = {
        season: row.season_number,
        episode: row.episode_number,
        title,
        airDate: row.premiere_date,
    };
    // Mirrors /api/calendar's `onServer`: a monitored row's has_file describes
    // the arr instance, not this library, so it is never "on server".
    if (row.source !== 'monitored' && row.has_files) entry.onServer = true;
    return entry;
}

/**
 * Group episode rows by series, soonest series first.
 *
 * Monitored rows carry a `series_id` only when their series is in the catalog,
 * so groups are keyed by normalised name — otherwise every arr gap-fill row of
 * an unknown series would collapse into one group.
 */
function groupBySeries(rows: CalendarRow[], watched: Set<string> | null): SeriesGroup[] {
    const groups = new Map<string, SeriesGroup>();

    for (const row of rows) {
        const name = row.series_name ?? row.title;
        // Key on the NAME, always. A monitored row of a series that is not in
        // the catalog carries series_id = NULL — so a series with catalog and such
        // gap-fill rows in the window landed in two buckets and was reported
        // twice, with two different nextAirDates and contradictory inLibrary
        // flags. A series with no ('tmdb','tv') external id split every time.
        const key = `name:${normalizeTitle(name)}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                title: name,
                inLibrary: row.source !== 'monitored',
                nextAirDate: null,
                episodes: [],
            };
            if (watched) group.watchedByUser = row.series_id !== null && watched.has(row.series_id);
            groups.set(key, group);
        }
        group.episodes.push(toEpisodeEntry(row));
    }

    for (const group of groups.values()) {
        group.episodes.sort(
            (a, b) =>
                (a.airDate ?? '').localeCompare(b.airDate ?? '') ||
                (a.season ?? 0) - (b.season ?? 0) ||
                (a.episode ?? 0) - (b.episode ?? 0),
        );
        group.nextAirDate = group.episodes[0]?.airDate ?? null;
        if (group.episodes.length > MAX_EPISODES_PER_SERIES) {
            group.moreEpisodes = group.episodes.length - MAX_EPISODES_PER_SERIES;
            group.episodes = group.episodes.slice(0, MAX_EPISODES_PER_SERIES);
        }
    }

    return [...groups.values()].sort((a, b) =>
        (a.nextAirDate ?? '￿').localeCompare(b.nextAirDate ?? '￿'),
    );
}

export const getUpcomingReleasesTool: AssistantTool<GetUpcomingReleasesArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_UPCOMING_RELEASES,
    description:
        'Upcoming TV episode air dates from the release calendar: what airs in the next N days, when the next episode of a series airs, and when an announced new season starts. Covers roughly the next 90 days only. It does NOT cover movie release dates — this library has almost no movie release-date data. TEXT-ONLY; returns air dates grouped by series.',
    argsSchema: getUpcomingReleasesArgsSchema,

    async execute(
        args: GetUpcomingReleasesArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const accessBoundary = searchAccessBoundary(ctx.accessCtx);

        // Resolve the series FIRST: "when does X come back" for an unknown title
        // is answerable without touching the calendar at all, and answering it
        // as "found: false" rather than "no episodes" is what stops the model
        // filling the gap from memory.
        let resolvedSeries: { id: string; title: string } | null = null;
        if (args.series) {
            const matches = await searchMediaByTitle(ctx.sql, {
                title: args.series,
                mediaTypes: ['tv'],
                access: accessBoundary,
            });
            const hit = matches.find((m) => m.media_type === 'tv') ?? matches[0];
            if (!hit?.media_id) {
                return {
                    summaryForModel: JSON.stringify({
                        found: false,
                        note: `No accessible series matching "${args.series}". Do not supply an air date from memory.`,
                    }),
                };
            }
            resolvedSeries = { id: hit.media_id, title: hit.title };
        }

        // A single-series lookup is a "when" question, so it gets the full sync
        // horizon unless the model asked for a narrower one; the open
        // "what's coming up" question keeps the short default.
        const days = args.days ?? (resolvedSeries ? MAX_DAYS : DEFAULT_DAYS);
        const start = new Date();
        const end = new Date(start.getTime() + days * MS_PER_DAY);

        // Mirror /api/calendar exactly: the RAW SHOW_UNAVAILABLE_MEDIA toggle,
        // not accessCtx.showUnavailableMedia (which additionally requires a
        // configured request path — monitored arr titles arrive regardless).
        // getCalendarItemsFromDb re-checks the access half itself, so a slip
        // here cannot leak monitored titles to a restricted caller.
        const includeMonitored = config.SHOW_UNAVAILABLE_MEDIA && isUnrestricted(accessBoundary);

        const rows = await getCalendarItemsFromDb(
            ctx.sql,
            start,
            end,
            accessBoundary,
            includeMonitored,
        );

        // Episodes only (see module header). Monitored MOVIE rows are dropped by
        // the same predicate.
        let episodes = rows.filter((r) => r.media_type === 'episode');

        // The user's own opt-out list. It is applied post-cache in the HTTP
        // layer and NOT inside the query, so it has to be re-applied here.
        //
        // It is a LISTING preference, not an access control, so it must not
        // apply when the user named the series themselves. /api/calendar only
        // ever uses it to trim a whole-window listing. Applied to a by-name
        // lookup it turned "you muted this series" into "no announced air
        // dates for this series" — inventing an absence, which is the exact
        // fabrication class this whole campaign exists to remove.
        let mutedTheAskedForSeries = false;
        const exclusions = ctx.accessCtx.username
            ? await getExcludedSeriesKeys(ctx.accessCtx.username)
            : NO_EXCLUSIONS;
        if (hasExclusions(exclusions)) {
            if (resolvedSeries) {
                mutedTheAskedForSeries = isCatalogItemExcluded(exclusions, resolvedSeries.id);
            } else {
                episodes = episodes.filter((r) => !isCalendarRowExcluded(exclusions, r));
            }
        }

        if (resolvedSeries) {
            const wanted = normalizeTitle(resolvedSeries.title);
            episodes = episodes.filter(
                (r) =>
                    r.series_id === resolvedSeries.id ||
                    // A monitored row has a series_id only when its series is in
                    // the catalog; else fall back to the name so an arr-tracked
                    // return date is still reachable.
                    (r.series_id === null && normalizeTitle(r.series_name ?? '') === wanted),
            );
        }

        // "My shows": the only positive per-user signal available, since no
        // follows table exists. A monitored row without a series_id (its series
        // is not in the catalog) can never carry watch state — it is dropped
        // rather than silently presented as unwatched.
        let watched: Set<string> | null = null;
        // Whether anything existed BEFORE onlyMyShows narrowed it. Reporting a
        // filtered-to-empty result as "no announced air dates" invents an
        // absence — the dates are there, the user just has not watched the show
        // — which is the same fabrication the muted branch below exists to stop.
        const hadEpisodesBeforeMyShows = episodes.length > 0;
        if (args.onlyMyShows) {
            const seriesIds = [
                ...new Set(episodes.map((r) => r.series_id).filter((id): id is string => !!id)),
            ];
            const watchedIds = await getWatchedSeriesIds(ctx.sql, ctx.userId, seriesIds);
            watched = watchedIds;
            episodes = episodes.filter((r) => r.series_id !== null && watchedIds.has(r.series_id));
        }
        const zeroedByMyShows =
            args.onlyMyShows && hadEpisodesBeforeMyShows && episodes.length === 0;

        const from = utcDay(start);
        const to = utcDay(end);
        const scope = resolvedSeries
            ? `series:${resolvedSeries.title}`
            : args.onlyMyShows
              ? 'my-shows'
              : 'all';

        ctx.logger?.debug('get_upcoming_releases executed', {
            days,
            scope,
            rows: rows.length,
            episodes: episodes.length,
            includeMonitored,
        });

        // ---- Empty is a first-class answer, never an error ------------------
        if (episodes.length === 0) {
            if (resolvedSeries) {
                return {
                    summaryForModel: JSON.stringify({
                        found: true,
                        series: resolvedSeries.title,
                        windowDays: days,
                        from,
                        to,
                        episodeCount: 0,
                        mutedByUser: mutedTheAskedForSeries || undefined,
                        hiddenByOnlyMyShows: zeroedByMyShows || undefined,
                        note: mutedTheAskedForSeries
                            ? `The user has HIDDEN this series from their calendar, so nothing is listed for it. That is a display preference, not an absence of dates — tell them it is muted and offer to unhide it. Do NOT say the air date is unknown, and do NOT state a date from memory.`
                            : zeroedByMyShows
                              ? `This series HAS upcoming dates in the window, but they were filtered out because the user has not watched it and onlyMyShows was set. Say that — do NOT say the air date is unknown, and offer to look again without the filter.`
                              : `No announced air dates for this series within the next ${days} days. ${HORIZON_NOTE} Say the date is not known — do NOT state a season or premiere date from memory.`,
                    }),
                };
            }
            return {
                summaryForModel: JSON.stringify({
                    windowDays: days,
                    from,
                    to,
                    scope,
                    seriesCount: 0,
                    episodeCount: 0,
                    series: [],
                    coverageNote: COVERAGE_NOTE,
                    note: `Nothing in the release calendar between ${from} and ${to} (the next ${days} days)${args.onlyMyShows ? ' for series this user has watched' : ''}. ${HORIZON_NOTE}`,
                }),
            };
        }

        const grouped = groupBySeries(episodes, watched);
        const listed = grouped.slice(0, MAX_SERIES_LISTED);

        return {
            summaryForModel: JSON.stringify({
                windowDays: days,
                from,
                to,
                scope,
                coverageNote: COVERAGE_NOTE,
                dateNote: DATE_NOTE,
                seriesCount: grouped.length,
                episodeCount: episodes.length,
                truncated: grouped.length > listed.length,
                series: listed,
            }),
        };
        // TEXT-ONLY on purpose: CalendarRow carries no primary_ext_id, and
        // tmdb_id is NULL on every catalog row, so there is nothing to build a
        // `ref` from without a second query — and a `${uuid}:tv` ref is a dead
        // link.
    },
};
