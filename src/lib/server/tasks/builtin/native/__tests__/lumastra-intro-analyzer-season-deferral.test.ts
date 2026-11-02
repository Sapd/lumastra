// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A season whose files are still arriving must not be fingerprinted, and the
 * drain must not overwrite its deferral with completion marks.
 *
 * Before the fix the per-item visual pass ran first, then the fingerprint pass
 * returned 0 for "deferred" exactly as it did for "found nothing". The drain set
 * `chromaRan`, and markAnalyzed wrote 'completed' over the deferred rows for both
 * stages, so the season was never fingerprinted.
 *
 * Query modules are mocked; the SQL is a fake that answers by query text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';

const stageState = vi.hoisted(() => ({
    upsertCompletedRow: vi.fn(async (_sql: unknown, _input: unknown) => {}),
    upsertSkippedPermanentRow: vi.fn(async (_sql: unknown, _input: unknown) => {}),
}));

vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: stageState.upsertCompletedRow,
    upsertSkippedPermanentRow: stageState.upsertSkippedPermanentRow,
}));

vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn(async () => {}),
    getFailureAggregates: vi.fn(async () => new Map()),
    markFailureEventsResolved: vi.fn(async () => {}),
}));

import {
    analyzeSliceOfSeasons,
    analyzeSingleSeasonChromaprint,
    type EffectiveConfig,
} from '../lumastra-intro-analyzer.js';

const source = readFileSync(
    resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'lumastra-intro-analyzer.ts'),
    'utf8',
);

const SEASON_ID = '22222222-2222-4222-8222-222222222222';
const EPISODE_A = '33333333-3333-4333-8333-333333333333';
const EPISODE_B = '44444444-4444-4444-8444-444444444444';

const baseConfig: EffectiveConfig = {
    chapterDetection: false,
    blackframeDetection: false,
    chromaprintDetection: true,
    batchSize: 150,
    episodeConcurrency: 1,
    ffmpegThreads: 1,
    maxIntroDuration: 120,
    maxCreditsDuration: 300,
    maxMovieCreditsDuration: 900,
    maxPlausibleCreditsDuration: 90,
    maxPlausibleMovieCreditsDuration: 900,
    outroMinStartFraction: 0.8,
    snapToleranceSec: 10,
    maxPointDifferences: 6,
    maxTimeSkip: 3.5,
    introWindowFraction: 0.25,
    introWindowMaxSec: 600,
    invertedIndexShift: 2,
    minSegmentDuration: 15,
    animePreviewFromCreditsEnd: false,
};

interface RecordedQuery {
    text: string;
    values: unknown[];
}

/**
 * A stand-in for the postgres tagged-template client. It answers only the
 * queries the season path issues; everything else gets an empty result, which
 * is what a database with no such rows would return.
 */
function fakeSql(freshest: Date | null): { sql: postgres.Sql; queries: RecordedQuery[] } {
    const queries: RecordedQuery[] = [];
    const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
        if (typeof strings === 'string') return Promise.resolve([]);
        const text = strings.join('?');
        queries.push({ text, values });
        if (text.includes('DISTINCT ep.id')) {
            return Promise.resolve([
                { id: EPISODE_A, visual_blocked: false, acoustic_blocked: false },
                { id: EPISODE_B, visual_blocked: false, acoustic_blocked: false },
            ]);
        }
        if (text.includes('DISTINCT ON (mi.id)'))
            return Promise.resolve(
                [episodeWithFile(EPISODE_A, 1), episodeWithFile(EPISODE_B, 2)].map((row) => ({
                    ...row,
                    mediaId: row.episodeId,
                    mediaType: 'episode',
                    parentId: null,
                    isDefault: true,
                    startOffsetMs: null,
                    endOffsetMs: null,
                })),
            );
        if (text.includes('MAX(GREATEST')) return Promise.resolve([{ freshest }]);
        if (text.includes('DISTINCT ON (ep.id)')) {
            return Promise.resolve([episodeWithFile(EPISODE_A, 1), episodeWithFile(EPISODE_B, 2)]);
        }
        return Promise.resolve([]);
    };
    return { sql: sql as unknown as postgres.Sql, queries };
}

function episodeWithFile(episodeId: string, episodeNumber: number): Record<string, unknown> {
    return {
        episodeId,
        title: `episode ${episodeNumber}`,
        seasonNumber: 1,
        episodeNumber,
        filePath: `/season-deferral-${episodeNumber}.mkv`,
        durationSeconds: 1500,
        fileId: `file-${episodeNumber}`,
        fileGeneration: '1',
        mediaGeneration: '1',
        globalGeneration: null,
    };
}

/** True when the fake saw the stage-state write that defers a season. */
function wroteDeferral(queries: RecordedQuery[]): boolean {
    return queries.some((q) => q.values.includes('season-scan-not-yet-stable'));
}

const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
} as never;

describe('lumastra-intro-analyzer: a deferred season is neither fingerprinted nor marked', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('the drain defers a season whose newest file is inside the window and marks no stage', async () => {
        const { sql, queries } = fakeSql(new Date());

        await analyzeSliceOfSeasons(
            sql,
            logger,
            new AbortController().signal,
            [{ seasonId: SEASON_ID, visualStale: true, acousticStale: true }],
            baseConfig,
            '/tmp',
        );

        expect(wroteDeferral(queries)).toBe(true);
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('the drain skips the per-item visual pass for a deferred season', async () => {
        // Chapter detection on, so a visual pass would reach analyzeItem, which
        // starts by reading the item's input snapshot ('mi.media_type').
        const { sql, queries } = fakeSql(new Date());

        await analyzeSliceOfSeasons(
            sql,
            logger,
            new AbortController().signal,
            [{ seasonId: SEASON_ID, visualStale: true, acousticStale: true }],
            { ...baseConfig, chapterDetection: true },
            '/tmp',
        );

        expect(queries.some((q) => q.text.includes('mi.media_type'))).toBe(false);
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('analyzeSingleSeasonChromaprint reports a deferral instead of returning 0', async () => {
        const { sql } = fakeSql(new Date());

        const outcome = await analyzeSingleSeasonChromaprint(
            sql,
            logger,
            new AbortController().signal,
            SEASON_ID,
            '/tmp',
            baseConfig,
        );

        expect(outcome).toEqual({ segments: 0, deferred: true });
    });

    it('the targeted path keeps a deferred season out of the visual mark', () => {
        // The targeted path runs analyzeSingleSeasonChromaprint directly, so the
        // season's per-item visual evidence is written before the deferral is
        // known. Its visual mark must still skip deferred episodes, or it would
        // overwrite the deferral the same way the drain did. The targeted path is
        // module-private code inside execute(), so it is checked on its source,
        // as the other analyzer suites do.
        const start = source.indexOf('const toMark: string[] = [];');
        expect(start).toBeGreaterThanOrEqual(0);
        const block = source.slice(start, source.indexOf('if (toMark.length > 0', start));
        expect(block).toContain('chromaDeferred.has(seasonId)');
    });
});
