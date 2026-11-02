// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The "New episodes available" rule (new-release-rule.ts). The first case is
 * the prod report of 2026-10-20: a requested 2017 series became available and
 * its whole first season showed as "new" with "+11 more".
 */

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_NEW_RELEASE_CONFIG,
    followReasonFor,
    isBulkArrival,
    isNewRelease,
    qualifiesAsNewRelease,
    releaseDateOf,
    selectNewReleases,
    type EpisodeCandidate,
    type SeriesFollowState,
} from './new-release-rule.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * DAY);
/** An air date: a calendar day at UTC midnight. */
const airedDaysAgo = (d: number): Date => {
    const t = daysAgo(d);
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
};

function series(over: Partial<SeriesFollowState> = {}): SeriesFollowState {
    return {
        seriesId: 's1',
        watchedEpisodeCount: 10,
        watchedMomentCount: 10,
        lastWatchedAt: daysAgo(6),
        newestWatchedAirDate: airedDaysAgo(7),
        explicitlyFollowed: false,
        inWatchlist: false,
        airing: true,
        ...over,
    };
}

let nextId = 0;
function ep(over: Partial<EpisodeCandidate> = {}): EpisodeCandidate {
    nextId += 1;
    return {
        id: `e${nextId}`,
        seriesId: 's1',
        seasonNumber: 5,
        episodeNumber: nextId,
        airDate: airedDaysAgo(2),
        fileAddedAt: daysAgo(2),
        hasFile: true,
        watched: false,
        ...over,
    };
}

describe('back catalogue vs new release', () => {
    it('a fulfilled request of a 2017 season (1 episode watched) shows nothing', () => {
        // The Worst Witch on prod: 13 files added two days ago, aired 2017, S1E1 watched.
        const s = series({
            watchedEpisodeCount: 1,
            watchedMomentCount: 1,
            lastWatchedAt: daysAgo(2),
            newestWatchedAirDate: new Date('2017-01-11T00:00:00Z'),
            airing: false,
        });
        const season = Array.from({ length: 13 }, (_, i) =>
            ep({
                seasonNumber: 1,
                episodeNumber: i + 1,
                airDate: new Date(Date.UTC(2017, 0, 11 + i * 7)),
                fileAddedAt: daysAgo(3),
                watched: i === 0,
            }),
        );
        expect(selectNewReleases([s], season, NOW)).toEqual([]);
    });

    it('the same season pack stays out for a real fan too (old air dates)', () => {
        const s = series({ airing: false, newestWatchedAirDate: new Date('2016-03-01T00:00:00Z') });
        const season = Array.from({ length: 13 }, (_, i) =>
            ep({
                seasonNumber: 2,
                episodeNumber: i + 1,
                airDate: new Date(Date.UTC(2017, 0, 11 + i * 7)),
            }),
        );
        expect(selectNewReleases([s], season, NOW)).toEqual([]);
    });

    it('a new episode of an airing show the user follows qualifies', () => {
        const fresh = ep({ seasonNumber: 29, episodeNumber: 4, airDate: airedDaysAgo(1) });
        const groups = selectNewReleases([series()], [fresh], NOW);
        expect(groups).toHaveLength(1);
        expect(groups[0].episodes.map((e) => e.id)).toEqual([fresh.id]);
        expect(groups[0].followReason).toBe('watched');
    });

    it('a release older than the window does not qualify', () => {
        const s = series({ lastWatchedAt: daysAgo(90), newestWatchedAirDate: airedDaysAgo(100) });
        expect(isNewRelease(ep({ airDate: airedDaysAgo(31) }), s, NOW)).toBe(false);
        expect(isNewRelease(ep({ airDate: airedDaysAgo(29) }), s, NOW)).toBe(true);
    });

    it('an air date far in the future (a leak, a bad date) does not qualify', () => {
        // The file arrived more than earlyFileDays before the air date.
        expect(
            isNewRelease(
                ep({ airDate: airedDaysAgo(-20), fileAddedAt: daysAgo(1) }),
                series(),
                NOW,
            ),
        ).toBe(false);
        // No file: the future air date stands.
        expect(
            isNewRelease(
                ep({ airDate: airedDaysAgo(-3), fileAddedAt: null, hasFile: false }),
                series(),
                NOW,
            ),
        ).toBe(false);
    });

    it('a file that arrived days before its air date is released when it arrived', () => {
        // A Wild Last Boss Appeared! / Overgeared / Dark Matter on prod: weekly
        // files 2 to 6.4 days ahead of the TMDB air date.
        const s = series({ lastWatchedAt: daysAgo(6), newestWatchedAirDate: airedDaysAgo(1) });
        for (const ahead of [2, 4, 7]) {
            const early = ep({ airDate: airedDaysAgo(-ahead), fileAddedAt: daysAgo(0.5) });
            expect(isNewRelease(early, s, NOW)).toBe(true);
            expect(releaseDateOf(early, s)).toEqual(early.fileAddedAt);
            expect(qualifiesAsNewRelease(early, s, [early], NOW)).toBe(true);
        }
        // The file arrived before the last watch: not new for this user.
        const watchedSince = series({ lastWatchedAt: daysAgo(0.1), newestWatchedAirDate: null });
        const seen = ep({ airDate: airedDaysAgo(-3), fileAddedAt: daysAgo(1) });
        expect(
            isNewRelease(seen, { ...watchedSince, newestWatchedAirDate: airedDaysAgo(-5) }, NOW),
        ).toBe(false);
        // ...but it still counts as beyond the newest watched episode by its air date.
        expect(
            isNewRelease(seen, { ...watchedSince, newestWatchedAirDate: airedDaysAgo(1) }, NOW),
        ).toBe(true);
    });

    it('earlyFileDays bounds the early-file release', () => {
        const early = ep({ airDate: airedDaysAgo(-5), fileAddedAt: daysAgo(1) });
        const config = { ...DEFAULT_NEW_RELEASE_CONFIG, earlyFileDays: 3 };
        expect(isNewRelease(early, series(), NOW, config)).toBe(false);
        expect(isNewRelease(early, series(), NOW)).toBe(true);
    });

    it('needs a release after the last watch OR beyond the newest watched episode', () => {
        // Watched yesterday, up to an episode that aired yesterday: an
        // unwatched episode that aired five days ago is an older one they skipped.
        const s = series({ lastWatchedAt: daysAgo(1), newestWatchedAirDate: airedDaysAgo(1) });
        expect(isNewRelease(ep({ airDate: airedDaysAgo(5) }), s, NOW)).toBe(false);
        // A behind viewer (newest watched aired months ago) still hears about this week's episode
        // even if they watched an old one after it came out.
        const behind = series({
            lastWatchedAt: daysAgo(0.1),
            newestWatchedAirDate: airedDaysAgo(400),
        });
        expect(isNewRelease(ep({ airDate: airedDaysAgo(5) }), behind, NOW)).toBe(true);
    });

    it('drops watched episodes and episodes without a file', () => {
        const groups = selectNewReleases(
            [series()],
            [ep({ watched: true }), ep({ hasFile: false })],
            NOW,
        );
        expect(groups).toEqual([]);
    });
});

describe('who follows a series', () => {
    it('one watched episode is not following', () => {
        const s = series({ watchedEpisodeCount: 1, watchedMomentCount: 1 });
        expect(followReasonFor(s)).toBeNull();
        expect(selectNewReleases([s], [ep()], NOW)).toEqual([]);
    });

    it('one watched episode plus the watchlist is following', () => {
        const s = series({ watchedEpisodeCount: 1, watchedMomentCount: 1, inWatchlist: true });
        expect(followReasonFor(s)).toBe('watchlist');
    });

    it('the watchlist alone (not started) is not following', () => {
        expect(
            followReasonFor(
                series({ watchedEpisodeCount: 0, watchedMomentCount: 0, inWatchlist: true }),
            ),
        ).toBeNull();
    });

    it('explicit episode notifications are following without any watch', () => {
        const s = series({
            watchedEpisodeCount: 0,
            watchedMomentCount: 0,
            lastWatchedAt: null,
            newestWatchedAirDate: null,
            explicitlyFollowed: true,
        });
        expect(followReasonFor(s)).toBe('followed');
        expect(selectNewReleases([s], [ep()], NOW)).toHaveLength(1);
    });

    it('a bulk "mark season watched" is one viewing moment, not a fan', () => {
        expect(
            followReasonFor(series({ watchedEpisodeCount: 24, watchedMomentCount: 1 })),
        ).toBeNull();
    });
});

describe('bulk back-catalogue import', () => {
    it('one recent episode inside a mostly old batch does not qualify', () => {
        // A newly added airing series: 10 old episodes and last week's arrive in one hour.
        const s = series({ explicitlyFollowed: true });
        const batch = [
            ...Array.from({ length: 10 }, (_, i) =>
                ep({
                    seasonNumber: 1,
                    episodeNumber: i + 1,
                    airDate: airedDaysAgo(800 - i),
                    fileAddedAt: daysAgo(3),
                }),
            ),
            ep({
                seasonNumber: 2,
                episodeNumber: 1,
                airDate: airedDaysAgo(5),
                fileAddedAt: daysAgo(3),
            }),
        ];
        expect(isBulkArrival(batch[10], s, batch, NOW)).toBe(true);
        expect(selectNewReleases([s], batch, NOW)).toEqual([]);
    });

    it('a whole new season released at once is not a bulk import', () => {
        const s = series();
        const drop = Array.from({ length: 8 }, (_, i) =>
            ep({
                seasonNumber: 3,
                episodeNumber: i + 1,
                airDate: airedDaysAgo(2),
                fileAddedAt: daysAgo(1),
            }),
        );
        const groups = selectNewReleases([s], drop, NOW);
        expect(groups).toHaveLength(1);
        expect(groups[0].episodes).toHaveLength(8);
    });

    it('the next weekly episode after a bulk import qualifies on its own', () => {
        const s = series({
            explicitlyFollowed: true,
            lastWatchedAt: null,
            newestWatchedAirDate: null,
        });
        const old = Array.from({ length: 10 }, (_, i) =>
            ep({
                seasonNumber: 1,
                episodeNumber: i + 1,
                airDate: airedDaysAgo(900 - i),
                fileAddedAt: daysAgo(10),
            }),
        );
        const weekly = ep({
            seasonNumber: 2,
            episodeNumber: 1,
            airDate: airedDaysAgo(1),
            fileAddedAt: daysAgo(1),
        });
        const groups = selectNewReleases([s], [...old, weekly], NOW);
        expect(groups.map((g) => g.episodes.map((e) => e.id))).toEqual([[weekly.id]]);
    });
});

describe('specials and missing air dates', () => {
    it('a special that aired this week qualifies like any episode', () => {
        const special = ep({ seasonNumber: 0, episodeNumber: 3, airDate: airedDaysAgo(2) });
        expect(selectNewReleases([series()], [special], NOW)[0]?.episodes).toEqual([special]);
    });

    it('an old special that just got a file does not', () => {
        const special = ep({
            seasonNumber: 0,
            episodeNumber: 1,
            airDate: new Date('2019-12-24T00:00:00Z'),
        });
        expect(selectNewReleases([series()], [special], NOW)).toEqual([]);
    });

    it('an undated special never qualifies, even on an airing show', () => {
        const special = ep({
            seasonNumber: 0,
            episodeNumber: 9,
            airDate: null,
            fileAddedAt: daysAgo(1),
        });
        expect(releaseDateOf(special, series())).toBeNull();
        expect(selectNewReleases([series()], [special], NOW)).toEqual([]);
    });

    it('an undated episode of an airing show falls back to its file arrival', () => {
        const undated = ep({ airDate: null, fileAddedAt: daysAgo(1) });
        expect(releaseDateOf(undated, series())).toEqual(undated.fileAddedAt);
        expect(selectNewReleases([series()], [undated], NOW)).toHaveLength(1);
    });

    it('an undated episode of an ended or unknown-status show does not', () => {
        const undated = ep({ airDate: null, fileAddedAt: daysAgo(1) });
        expect(selectNewReleases([series({ airing: false })], [undated], NOW)).toEqual([]);
        expect(selectNewReleases([series({ airing: null })], [undated], NOW)).toEqual([]);
    });
});

describe('grouping', () => {
    it('lists only the qualifying episodes, in watch order, newest series first', () => {
        const a = series({ seriesId: 'a' });
        const b = series({ seriesId: 'b' });
        const a2 = ep({
            seriesId: 'a',
            seasonNumber: 4,
            episodeNumber: 2,
            airDate: airedDaysAgo(3),
        });
        const a1 = ep({
            seriesId: 'a',
            seasonNumber: 4,
            episodeNumber: 1,
            airDate: airedDaysAgo(4),
        });
        const aOld = ep({
            seriesId: 'a',
            seasonNumber: 1,
            episodeNumber: 1,
            airDate: airedDaysAgo(2000),
            fileAddedAt: daysAgo(20),
        });
        const b1 = ep({
            seriesId: 'b',
            seasonNumber: 1,
            episodeNumber: 7,
            airDate: airedDaysAgo(1),
        });
        const groups = selectNewReleases([a, b], [a2, aOld, a1, b1], NOW);
        expect(groups.map((g) => g.series.seriesId)).toEqual(['b', 'a']);
        expect(groups[1].episodes.map((e) => e.id)).toEqual([a1.id, a2.id]);
    });

    it('uses a config window', () => {
        const config = { ...DEFAULT_NEW_RELEASE_CONFIG, windowDays: 7 };
        expect(
            isNewRelease(
                ep({ airDate: airedDaysAgo(10) }),
                series({ lastWatchedAt: daysAgo(20) }),
                NOW,
                config,
            ),
        ).toBe(false);
    });
});

describe('one episode (qualifiesAsNewRelease, the library.new_episode notifier)', () => {
    it('an episode of a season pack with old air dates never qualifies, for an active fan either', () => {
        // The Middle on prod, 2026-10: a viewer in the middle of a binge got a
        // push for every 2010–2016 episode as each season arrived.
        const s = series({
            lastWatchedAt: daysAgo(0.1),
            newestWatchedAirDate: new Date('2012-05-02T00:00:00Z'),
        });
        const pack = Array.from({ length: 24 }, (_, i) =>
            ep({
                seasonNumber: 4,
                episodeNumber: i + 1,
                airDate: new Date(Date.UTC(2012, 8, 26 + i * 7)),
                fileAddedAt: daysAgo(0.05),
            }),
        );
        for (const e of pack) expect(qualifiesAsNewRelease(e, s, pack, NOW)).toBe(false);
    });

    it("this week's episode qualifies", () => {
        const weekly = ep({
            seasonNumber: 6,
            episodeNumber: 2,
            airDate: airedDaysAgo(1),
            fileAddedAt: daysAgo(0.5),
        });
        expect(qualifiesAsNewRelease(weekly, series(), [weekly], NOW)).toBe(true);
    });

    it('agrees with selectNewReleases on every candidate', () => {
        const s = series();
        const mixed = [
            ep({ airDate: airedDaysAgo(1) }),
            ep({ airDate: airedDaysAgo(400) }),
            ep({ airDate: airedDaysAgo(3), watched: true }),
            ep({ airDate: airedDaysAgo(2), hasFile: false }),
        ];
        const picked = new Set(
            selectNewReleases([s], mixed, NOW).flatMap((g) => g.episodes.map((e) => e.id)),
        );
        const withFiles = mixed.filter((e) => e.hasFile);
        for (const e of mixed) {
            expect(qualifiesAsNewRelease(e, s, withFiles, NOW)).toBe(picked.has(e.id));
        }
    });
});
