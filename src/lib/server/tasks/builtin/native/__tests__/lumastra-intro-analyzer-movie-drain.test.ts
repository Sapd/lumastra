// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Films never got intro/outro analysis from the scheduled drain: it walked
 * seasons and single-episode seasons, and a movie was only analysed by a
 * targeted run. The drain now also works through movies that have no visual
 * row yet, with the same per-item handling as the single-episode fallback.
 *
 * The drain is driven through execute() against a query-dispatching fake. A
 * movie whose input snapshot is missing fails honestly without
 * detector work; a snapshot read that throws makes analyzeItem fail.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';

const GOOD_MOVIE = 'movie-good';
const BAD_MOVIE = 'movie-bad';

const stageState = vi.hoisted(() => ({
    upsertCompletedRow: vi.fn(async (_sql: unknown, _input: unknown) => {}),
    upsertSkippedPermanentRow: vi.fn(async (_sql: unknown, _input: unknown) => {}),
}));

vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: stageState.upsertCompletedRow,
    upsertSkippedPermanentRow: stageState.upsertSkippedPermanentRow,
}));

const failureEvents = vi.hoisted(() => ({
    recordFailure: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: failureEvents.recordFailure,
    getFailureAggregates: vi.fn(async () => new Map()),
    markFailureEventsResolved: vi.fn(async () => {}),
}));

// The drain writes its temp directory and cache sentinel on the way out; neither
// is part of what this test is about.
vi.mock('$lib/server/utils/safe-fs.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/safe-fs.js')>();
    return { ...actual, safeMkdir: vi.fn(async () => undefined) };
});

vi.mock('$lib/server/cache/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/index.js')>();
    const noopCache = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
    };
    return {
        ...actual,
        cacheManager: { ...actual.cacheManager, getCache: () => noopCache },
    };
});

import { lumastraIntroAnalyzerTask, ANALYZER_VISUAL_STAGE_ID } from '../lumastra-intro-analyzer.js';

interface RecordedQuery {
    text: string;
    values: unknown[];
}

/**
 * Answers the queries the scheduled drain issues on an empty library, except
 * for the movie backlog, which yields both test movies once and then nothing.
 */
function fakeSql(): { sql: postgres.Sql; queries: RecordedQuery[] } {
    const queries: RecordedQuery[] = [];
    let movieBacklogReads = 0;
    const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
        if (typeof strings === 'string') return Promise.resolve([]);
        const text = strings.join('?');
        queries.push({ text, values });
        if (text.includes("mi.media_type = 'movie'")) {
            movieBacklogReads += 1;
            return Promise.resolve(
                movieBacklogReads === 1 ? [{ mediaId: GOOD_MOVIE }, { mediaId: BAD_MOVIE }] : [],
            );
        }
        // The input snapshot read that analyzeItem starts with.
        if (text.includes('mi.media_type AS')) {
            if (values.flat().includes(BAD_MOVIE)) {
                return Promise.reject(new Error('ffprobe exploded'));
            }
            return Promise.resolve([]);
        }
        return Promise.resolve([]);
    };
    return { sql: sql as unknown as postgres.Sql, queries };
}

const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
};

function visualUpsertsFor(mediaItemId: string): unknown[] {
    return stageState.upsertCompletedRow.mock.calls
        .map((call) => call[1] as { mediaItemId: string; stageId: string })
        .filter((input) => input.mediaItemId === mediaItemId);
}

describe('lumastra-intro-analyzer: the scheduled drain analyses movies', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED', 'true');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('runs analyzeItem for a movie and refuses to complete a missing input', async () => {
        const { sql, queries } = fakeSql();

        await lumastraIntroAnalyzerTask.execute({
            sql,
            logger,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
            input: {},
        } as never);

        // analyzeItem starts by reading the movie's input snapshot.
        expect(
            queries.some(
                (q) => q.text.includes('mi.media_type AS') && q.values.flat().includes(GOOD_MOVIE),
            ),
        ).toBe(true);
        expect(visualUpsertsFor(GOOD_MOVIE)).toEqual([]);
        expect(failureEvents.recordFailure).toHaveBeenCalledWith(
            expect.anything(),
            'lumastra-intro-analyzer',
            GOOD_MOVIE,
            expect.stringContaining('No eligible local video file'),
            null,
            null,
            undefined,
        );
    });

    it('does not mark a failing movie, and records the failure through the poison guard', async () => {
        const { sql } = fakeSql();

        await lumastraIntroAnalyzerTask.execute({
            sql,
            logger,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
            input: {},
        } as never);

        expect(visualUpsertsFor(BAD_MOVIE)).toEqual([]);
        expect(failureEvents.recordFailure).toHaveBeenCalledWith(
            expect.anything(),
            'lumastra-intro-analyzer',
            BAD_MOVIE,
            expect.stringContaining('ffprobe exploded'),
            null,
            ANALYZER_VISUAL_STAGE_ID,
            undefined,
        );
    });
});
