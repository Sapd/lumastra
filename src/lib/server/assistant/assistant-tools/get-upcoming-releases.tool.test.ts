// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the `get_upcoming_releases` assistant tool.
 *
 * SCOPE WARNING: `calendar.queries.js` is MOCKED here, as in every other
 * assistant-tool suite. These tests pin the ARGUMENTS the tool passes down
 * (crucially the access boundary and the date window) and the SHAPE it hands
 * the model. They prove nothing about the SQL or the real calendar data —
 * that was verified separately against prod.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssistantToolContext } from './types.js';
import type { CalendarRow } from '../../database/queries/calendar.queries.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

vi.mock('../../database/queries/calendar.queries.js', () => ({
    getCalendarItemsFromDb: vi.fn(),
}));
vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    searchMediaByTitle: vi.fn(),
}));
vi.mock('../../database/queries/episode-detail.queries.js', () => ({
    getWatchedSeriesIds: vi.fn(),
}));
// Only the DB-backed read is stubbed. The id-based predicates live in their own
// dependency-free module and stay REAL, so this suite exercises the same
// matching /api/calendar applies.
vi.mock('../../utils/excluded-series.js', () => ({
    getExcludedSeriesKeys: vi.fn(),
}));
vi.mock('../../config.js', () => ({
    config: { SHOW_UNAVAILABLE_MEDIA: true },
    // search-access-context.ts imports this from the same module; without it the
    // named import throws at load time and the whole suite reports "no tests".
    isUnavailableMediaVisible: () => true,
}));

import { getUpcomingReleasesTool } from './get-upcoming-releases.tool.js';
import { buildToolParameters } from './to-openai-schema.js';
import { getCalendarItemsFromDb } from '../../database/queries/calendar.queries.js';
import { searchMediaByTitle } from '../../database/queries/assistant-rag.queries.js';
import { getWatchedSeriesIds } from '../../database/queries/episode-detail.queries.js';
import { getExcludedSeriesKeys } from '../../utils/excluded-series.js';
import { NO_EXCLUSIONS, type SeriesExclusions } from '../../utils/excluded-series-match.js';
import { assistantTestUser } from './test-context.js';

const TEST_USER_ID: UserId = toUserId('00000000-0000-0000-0000-000000000001');

const SERIES_A = 'aaaaaaaa-0000-4000-a000-000000000001';
const SERIES_B = 'bbbbbbbb-0000-4000-a000-000000000002';

function makeCtx(overrides: Partial<AssistantToolContext> = {}): AssistantToolContext {
    return {
        sql: {} as never,
        userId: TEST_USER_ID,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
        ...overrides,
    };
}

/** A catalog episode row as `getCalendarItemsFromDb` returns it. */
function episodeRow(over: Partial<CalendarRow> = {}): CalendarRow {
    return {
        id: 'ep-1',
        title: 'No Safe Haven',
        media_type: 'episode',
        series_name: 'Alone',
        series_id: SERIES_A,
        season_number: 13,
        episode_number: 10,
        premiere_date: '2026-08-20',
        has_files: false,
        overview: null,
        year: 2015,
        source: 'catalog',
        source_series_id: null,
        tmdb_id: null,
        ...over,
    };
}

function muting(over: Partial<SeriesExclusions>): SeriesExclusions {
    return { ...NO_EXCLUSIONS, ...over };
}

function parse(summary: string): Record<string, unknown> {
    return JSON.parse(summary) as Record<string, unknown>;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getExcludedSeriesKeys).mockResolvedValue(NO_EXCLUSIONS);
    vi.mocked(getWatchedSeriesIds).mockResolvedValue(new Set<string>());
    vi.mocked(getCalendarItemsFromDb).mockResolvedValue([]);
});

describe('get_upcoming_releases — window and access threading', () => {
    it('defaults to a 7-day window and states it explicitly in the payload', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([episodeRow()]);

        const res = await getUpcomingReleasesTool.execute({}, makeCtx());
        const out = parse(res.summaryForModel);

        expect(out.windowDays).toBe(7);
        // The window must be restatable without arithmetic.
        expect(typeof out.from).toBe('string');
        expect(typeof out.to).toBe('string');
        const from = new Date(`${String(out.from)}T00:00:00Z`);
        const to = new Date(`${String(out.to)}T00:00:00Z`);
        expect((to.getTime() - from.getTime()) / 86_400_000).toBe(7);

        const [, start, end] = vi.mocked(getCalendarItemsFromDb).mock.calls[0];
        expect(Math.round((end.getTime() - start.getTime()) / 86_400_000)).toBe(7);
    });

    it('honours an explicit days argument', async () => {
        await getUpcomingReleasesTool.execute({ days: 30 }, makeCtx());
        const [, start, end] = vi.mocked(getCalendarItemsFromDb).mock.calls[0];
        expect(Math.round((end.getTime() - start.getTime()) / 86_400_000)).toBe(30);
    });

    it('passes the caller access boundary down, and blocks monitored gap-fill for a restricted caller', async () => {
        const restricted = makeCtx({
            accessCtx: {
                username: 'kid',
                deniedGroupIds: ['grp-1'],
                ageRating: { maxAgeRating: 12, allowUnrated: false },
                liveTvAllowed: false,
                showUnavailableMedia: false,
            },
        });

        await getUpcomingReleasesTool.execute({}, restricted);

        const [, , , access, includeMonitored] = vi.mocked(getCalendarItemsFromDb).mock.calls[0];
        expect(access.library).toEqual({ kind: 'denyGroups', ids: ['grp-1'] });
        expect(access.age).toEqual({ kind: 'limit', maxAgeRating: 12, allowUnrated: false });
        // isUnrestricted() is false on both axes → no arr gap-fill, whatever the
        // SHOW_UNAVAILABLE_MEDIA toggle says.
        expect(includeMonitored).toBe(false);
    });
});

describe('get_upcoming_releases — empty result is a first-class answer', () => {
    it('returns a counted, explained empty payload rather than an error', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([]);

        const res = await getUpcomingReleasesTool.execute({ days: 14 }, makeCtx());
        const out = parse(res.summaryForModel);

        expect(out.seriesCount).toBe(0);
        expect(out.episodeCount).toBe(0);
        expect(out.series).toEqual([]);
        expect(String(out.note)).toContain('14');
        // The model must be told emptiness may mean "not announced yet".
        expect(String(out.note).toLowerCase()).toContain('90');
        expect(out.windowDays).toBe(14);
    });

    it('still reports empty when every row was filtered out by the exclusion list', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([episodeRow()]);
        vi.mocked(getExcludedSeriesKeys).mockResolvedValue(
            muting({ itemIds: new Set([SERIES_A]) }),
        );

        const out = parse((await getUpcomingReleasesTool.execute({}, makeCtx())).summaryForModel);
        expect(out.episodeCount).toBe(0);
        expect(out.seriesCount).toBe(0);
    });
});

describe('get_upcoming_releases — row handling', () => {
    it('groups episodes by series and reports the next air date per series', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([
            episodeRow({ id: 'e1', episode_number: 10, premiere_date: '2026-08-22' }),
            episodeRow({ id: 'e2', episode_number: 11, premiere_date: '2026-08-29' }),
            episodeRow({
                id: 'e3',
                series_id: SERIES_B,
                series_name: 'Sora',
                title: 'Episode 8',
                season_number: 3,
                episode_number: 8,
                premiere_date: '2026-08-20',
            }),
        ]);

        const out = parse((await getUpcomingReleasesTool.execute({}, makeCtx())).summaryForModel);
        const series = out.series as Array<Record<string, unknown>>;

        expect(out.seriesCount).toBe(2);
        expect(out.episodeCount).toBe(3);
        // Soonest series first.
        expect(series[0].title).toBe('Sora');
        expect(series[0].nextAirDate).toBe('2026-08-20');
        expect(series[1].title).toBe('Alone');
        expect(series[1].nextAirDate).toBe('2026-08-22');
        expect((series[1].episodes as unknown[]).length).toBe(2);
    });

    it('nulls out placeholder episode titles like "Episode 8"', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([
            episodeRow({ title: 'Episode 8' }),
            episodeRow({ id: 'e2', episode_number: 11, title: 'Duct Tape Dystopia' }),
        ]);

        const out = parse((await getUpcomingReleasesTool.execute({}, makeCtx())).summaryForModel);
        const eps = (out.series as Array<Record<string, unknown>>)[0].episodes as Array<
            Record<string, unknown>
        >;
        expect(eps[0].title).toBeNull();
        expect(eps[1].title).toBe('Duct Tape Dystopia');
    });

    it('marks monitored rows as not in the library', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([
            episodeRow({
                id: null,
                series_id: null,
                series_name: 'Frontier',
                source: 'monitored',
                source_series_id: 42,
                tmdb_id: 93740,
            }),
        ]);

        const out = parse((await getUpcomingReleasesTool.execute({}, makeCtx())).summaryForModel);
        const series = (out.series as Array<Record<string, unknown>>)[0];
        expect(series.title).toBe('Frontier');
        expect(series.inLibrary).toBe(false);
    });

    it('drops movie rows — this library has no usable movie release dates', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([
            episodeRow(),
            episodeRow({
                id: 'mv-1',
                media_type: 'movie',
                title: 'Project Hail Mary',
                series_id: null,
                series_name: null,
                season_number: null,
                episode_number: null,
            }),
        ]);

        const out = parse((await getUpcomingReleasesTool.execute({}, makeCtx())).summaryForModel);
        expect(out.episodeCount).toBe(1);
        expect(JSON.stringify(out.series)).not.toContain('Project Hail Mary');
        expect(String(out.coverageNote).toLowerCase()).toContain('movie');
    });

    it('never leaks the internal media_type strings "episode"/"tv"', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([episodeRow()]);
        const res = await getUpcomingReleasesTool.execute({}, makeCtx());
        expect(res.summaryForModel).not.toMatch(/"(media_?[tT]ype)":\s*"(episode|tv)"/);
        // TEXT-ONLY: no cards, because CalendarRow carries no ref-able external id.
        expect(res.media).toBeUndefined();
    });
});

describe('get_upcoming_releases — onlyMyShows', () => {
    it('keeps only series the user has watched at least one episode of', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([
            episodeRow({ series_id: SERIES_A, series_name: 'Alone' }),
            episodeRow({ id: 'e2', series_id: SERIES_B, series_name: 'Sora' }),
        ]);
        vi.mocked(getWatchedSeriesIds).mockResolvedValue(new Set([SERIES_B]));

        const out = parse(
            (await getUpcomingReleasesTool.execute({ onlyMyShows: true }, makeCtx()))
                .summaryForModel,
        );
        const series = out.series as Array<Record<string, unknown>>;

        expect(out.scope).toBe('my-shows');
        expect(series).toHaveLength(1);
        expect(series[0].title).toBe('Sora');
        expect(series[0].watchedByUser).toBe(true);
        expect(vi.mocked(getWatchedSeriesIds).mock.calls[0][1]).toBe(TEST_USER_ID);
    });

    it('drops monitored rows under onlyMyShows and says why', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([
            episodeRow({
                id: null,
                series_id: null,
                series_name: 'Frontier',
                source: 'monitored',
            }),
        ]);

        const out = parse(
            (await getUpcomingReleasesTool.execute({ onlyMyShows: true }, makeCtx()))
                .summaryForModel,
        );
        expect(out.episodeCount).toBe(0);
        expect(String(out.note)).toBeTruthy();
    });

    it('does not run the watched lookup when onlyMyShows is off', async () => {
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([episodeRow()]);
        const out = parse((await getUpcomingReleasesTool.execute({}, makeCtx())).summaryForModel);

        expect(getWatchedSeriesIds).not.toHaveBeenCalled();
        expect(out.scope).toBe('all');
        expect((out.series as Array<Record<string, unknown>>)[0].watchedByUser).toBeUndefined();
    });
});

describe('get_upcoming_releases — single-series lookups', () => {
    it('separates "series exists, no date known" from "series not found"', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            {
                media_id: SERIES_A,
                media_type: 'tv',
                title: 'Alone',
            } as unknown as AssistantMovieRow,
        ]);
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([]);

        const out = parse(
            (await getUpcomingReleasesTool.execute({ series: 'Alone' }, makeCtx())).summaryForModel,
        );
        expect(out.found).toBe(true);
        expect(out.series).toBe('Alone');
        expect(out.episodeCount).toBe(0);
        expect(String(out.note).toLowerCase()).toContain('90');
    });

    // The fabrication this branch exists to stop: a muted series has dates, the
    // user just hid them. Reporting "no announced air dates" invents an
    // absence. Nothing asserted on it — deleting the `mutedTheAskedForSeries`
    // assignment left the whole suite green.
    it('says a series is MUTED rather than claiming no dates are known', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            {
                media_id: SERIES_A,
                media_type: 'tv',
                title: 'Alone',
            } as unknown as AssistantMovieRow,
        ]);
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([]);
        vi.mocked(getExcludedSeriesKeys).mockResolvedValue(
            muting({ itemIds: new Set([SERIES_A]) }),
        );

        const out = parse(
            (await getUpcomingReleasesTool.execute({ series: 'Alone' }, makeCtx())).summaryForModel,
        );

        expect(out.mutedByUser).toBe(true);
        const note = String(out.note).toLowerCase();
        expect(note).toContain('hidden');
        // The exact sentence the bug produced must not come back.
        expect(note).not.toContain('no announced air dates');
    });

    it('says the dates were FILTERED, not that none are known', async () => {
        // onlyMyShows zeroing a resolved series' episodes reported "no announced
        // air dates" — inventing an absence for a show that has dates the user
        // simply has not watched. Same class as the muted case above.
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            {
                media_id: SERIES_A,
                media_type: 'tv',
                title: 'Alone',
            } as unknown as AssistantMovieRow,
        ]);
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([
            {
                series_id: SERIES_A,
                series_name: 'Alone',
                title: 'Episode 1',
                media_type: 'episode',
                air_date: '2026-08-25',
            },
        ] as never);
        // The user has watched nothing, so the filter empties the list.
        vi.mocked(getWatchedSeriesIds).mockResolvedValue(new Set<string>());

        const out = parse(
            (
                await getUpcomingReleasesTool.execute(
                    { series: 'Alone', onlyMyShows: true },
                    makeCtx(),
                )
            ).summaryForModel,
        );

        expect(out.episodeCount).toBe(0);
        expect(out.hiddenByOnlyMyShows).toBe(true);
        expect(String(out.note).toLowerCase()).not.toContain('no announced air dates');
    });

    it('reports found:false when the series does not resolve', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([]);

        const out = parse(
            (await getUpcomingReleasesTool.execute({ series: 'Nonexistent' }, makeCtx()))
                .summaryForModel,
        );
        expect(out.found).toBe(false);
        expect(getCalendarItemsFromDb).not.toHaveBeenCalled();
    });

    it('widens the window to the full sync horizon for a single-series lookup', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            {
                media_id: SERIES_A,
                media_type: 'tv',
                title: 'Alone',
            } as unknown as AssistantMovieRow,
        ]);
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([episodeRow()]);

        await getUpcomingReleasesTool.execute({ series: 'Alone' }, makeCtx());
        const [, start, end] = vi.mocked(getCalendarItemsFromDb).mock.calls[0];
        expect(Math.round((end.getTime() - start.getTime()) / 86_400_000)).toBe(90);
    });

    it('keeps only the resolved series and scopes the payload to it', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            { media_id: SERIES_B, media_type: 'tv', title: 'Sora' } as unknown as AssistantMovieRow,
        ]);
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([
            episodeRow({ series_id: SERIES_A, series_name: 'Alone' }),
            episodeRow({ id: 'e2', series_id: SERIES_B, series_name: 'Sora' }),
        ]);

        const out = parse(
            (await getUpcomingReleasesTool.execute({ series: 'Sora' }, makeCtx())).summaryForModel,
        );
        expect(out.scope).toBe('series:Sora');
        expect(out.seriesCount).toBe(1);
        expect((out.series as Array<Record<string, unknown>>)[0].title).toBe('Sora');
    });

    it('falls back to a normalised name match so monitored rows are reachable', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            {
                media_id: SERIES_A,
                media_type: 'tv',
                title: 'Star Harbor: Strange New Worlds',
            } as unknown as AssistantMovieRow,
        ]);
        vi.mocked(getCalendarItemsFromDb).mockResolvedValue([
            episodeRow({
                id: null,
                series_id: null,
                series_name: 'Star Harbor - Strange New Worlds',
                source: 'monitored',
            }),
        ]);

        const out = parse(
            (
                await getUpcomingReleasesTool.execute(
                    { series: 'Star Harbor: Strange New Worlds' },
                    makeCtx(),
                )
            ).summaryForModel,
        );
        expect(out.seriesCount).toBe(1);
    });
});

describe('get_upcoming_releases — model-facing contract', () => {
    it('exposes a flat, provider-safe parameter schema', () => {
        const params = buildToolParameters(getUpcomingReleasesTool);
        expect(params.type).toBe('object');
        expect(params).not.toHaveProperty('$defs');
        expect(params).not.toHaveProperty('$schema');
        expect(Object.keys(params.properties as object).sort()).toEqual([
            'days',
            'onlyMyShows',
            'series',
        ]);
        // No mediaType argument: movie premiere_date coverage is 0.2%, so a
        // movie filter would silently return nothing and be narrated as fact.
        expect(Object.keys(params.properties as object)).not.toContain('mediaType');
    });

    it('tells the model in its description that movies are not covered', () => {
        expect(getUpcomingReleasesTool.description.toLowerCase()).toContain('not cover movie');
    });

    it('rejects a days value beyond the sync horizon', () => {
        expect(getUpcomingReleasesTool.argsSchema.safeParse({ days: 120 }).success).toBe(false);
        expect(getUpcomingReleasesTool.argsSchema.safeParse({ days: 90 }).success).toBe(true);
    });
});
