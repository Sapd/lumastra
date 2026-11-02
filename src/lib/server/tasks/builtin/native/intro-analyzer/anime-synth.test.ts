// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * anime-synth.ts — unit tests.
 *
 * Covers `synthesiseAnimePreviews` edge cases without a real database.
 * The function reads the RESOLVED Outro end via a single aggregating query
 * (`getAnimePreviewInputs`) and writes its Preview as an `anime-synth`
 * CANDIDATE via `replaceCandidatesForMethod`; the caller re-resolves and
 * materializes. Both queries are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger as SdkLogger } from '@sapd/lumastra-plugin-sdk';
import type postgres from 'postgres';
import type { AnimePreviewInput } from '$lib/server/database/queries/media-segments.queries.js';
import type { EpisodeWithFile } from './types.js';

// ── hoist mock refs ──────────────────────────────────────────────────────────
const {
    mockGetAnimePreviewInputs,
    mockReplaceCandidatesForMethod,
    mockAcquireResolutionLock,
    mockMaterialize,
} = vi.hoisted(() => ({
    mockGetAnimePreviewInputs: vi.fn(),
    mockReplaceCandidatesForMethod: vi.fn(),
    mockAcquireResolutionLock: vi.fn(),
    mockMaterialize: vi.fn(),
}));

vi.mock('$lib/server/database/queries/media-segments.queries.js', () => ({
    getAnimePreviewInputs: mockGetAnimePreviewInputs,
}));

vi.mock('$lib/server/database/queries/media-segment-candidates.queries.js', () => ({
    replaceCandidatesForMethod: mockReplaceCandidatesForMethod,
}));

vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: async <T>(sql: postgres.Sql, cb: (tx: postgres.Sql) => Promise<T>): Promise<T> =>
        cb(sql),
}));

vi.mock('./resolution-lock.js', () => ({
    acquireMediaSegmentResolutionLock: mockAcquireResolutionLock,
}));

import { synthesiseAnimePreviews, type AnimeSynthOptions } from './anime-synth.js';

const PLUGIN_ID = 'lumastra-intro-analyzer';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEpisode(overrides: Partial<EpisodeWithFile> = {}): EpisodeWithFile {
    return {
        episodeId: 'ep-abc',
        title: 'Episode 1',
        seasonNumber: 1,
        episodeNumber: 1,
        filePath: '/media/ep1.mkv',
        durationSeconds: 1440,
        ...overrides,
    };
}

function makeLogger(): SdkLogger {
    return {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
    } as unknown as SdkLogger;
}

const fakeSql = vi.fn() as unknown as postgres.Sql;

function makeInput(overrides: Partial<AnimePreviewInput> = {}): AnimePreviewInput {
    return {
        episodeId: 'ep-abc',
        outroEndSec: 1420,
        hasExistingPreview: false,
        ...overrides,
    };
}

/** The candidate payload written for `episodeId`, or undefined if it never was. */
function writtenCandidates(episodeId: string): unknown[] | undefined {
    const call = mockReplaceCandidatesForMethod.mock.calls.find((c) => c[1] === episodeId);
    return call?.[3] as unknown[] | undefined;
}

function runSynthesis(
    logger: SdkLogger,
    episodes: EpisodeWithFile[],
    signal?: AbortSignal,
    options?: AnimeSynthOptions,
): Promise<number> {
    return synthesiseAnimePreviews(
        fakeSql,
        logger,
        episodes,
        PLUGIN_ID,
        mockMaterialize,
        signal,
        options,
    );
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('synthesiseAnimePreviews', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockReplaceCandidatesForMethod.mockResolvedValue(undefined);
        mockAcquireResolutionLock.mockResolvedValue(undefined);
        mockMaterialize.mockResolvedValue(undefined);
    });

    it('skips synthesis when no Outro exists for the episode', async () => {
        mockGetAnimePreviewInputs.mockResolvedValue([makeInput({ outroEndSec: null })]);
        const logger = makeLogger();
        const episodes = [makeEpisode()];

        const count = await runSynthesis(logger, episodes);

        expect(count).toBe(0);
        // The empty-set replacement still runs: an abstention has to retract
        // whatever the previous pass claimed, or the resolver re-materializes it.
        expect(writtenCandidates('ep-abc')).toEqual([]);
    });

    it('skips synthesis when episode durationSeconds is null', async () => {
        mockGetAnimePreviewInputs.mockResolvedValue([makeInput({ outroEndSec: 1400 })]);
        const logger = makeLogger();
        const episodes = [makeEpisode({ durationSeconds: null })];

        const count = await runSynthesis(logger, episodes);

        expect(count).toBe(0);
        expect(writtenCandidates('ep-abc')).toBeUndefined();
        expect(mockAcquireResolutionLock).not.toHaveBeenCalled();
        expect(mockMaterialize).not.toHaveBeenCalled();
    });

    it('skips synthesis when episode durationSeconds is 0', async () => {
        mockGetAnimePreviewInputs.mockResolvedValue([makeInput({ outroEndSec: 0 })]);
        const logger = makeLogger();
        const episodes = [makeEpisode({ durationSeconds: 0 })];

        const count = await runSynthesis(logger, episodes);

        expect(count).toBe(0);
        expect(writtenCandidates('ep-abc')).toBeUndefined();
        expect(mockAcquireResolutionLock).not.toHaveBeenCalled();
        expect(mockMaterialize).not.toHaveBeenCalled();
    });

    it('skips synthesis when outro ends within 5s of episode end (creditsEnd + 5 >= duration)', async () => {
        // episode duration=1440, creditsEnd=1436 → 1436+5=1441 >= 1440 → skip
        mockGetAnimePreviewInputs.mockResolvedValue([makeInput({ outroEndSec: 1436 })]);
        const logger = makeLogger();
        const episodes = [makeEpisode({ durationSeconds: 1440 })];

        const count = await runSynthesis(logger, episodes);

        expect(count).toBe(0);
        expect(writtenCandidates('ep-abc')).toEqual([]);
    });

    it('skips synthesis when outro ends exactly at the 5s boundary (creditsEnd + 5 === duration)', async () => {
        // creditsEnd=1435, duration=1440 → 1435+5=1440 >= 1440 → skip
        mockGetAnimePreviewInputs.mockResolvedValue([makeInput({ outroEndSec: 1435 })]);
        const logger = makeLogger();
        const episodes = [makeEpisode({ durationSeconds: 1440 })];

        const count = await runSynthesis(logger, episodes);

        expect(count).toBe(0);
        expect(writtenCandidates('ep-abc')).toEqual([]);
    });

    it('writes a Preview candidate when outro ends more than 5s before episode end', async () => {
        // creditsEnd=1420, duration=1440 → 1420+5=1425 < 1440 → synthesise
        mockGetAnimePreviewInputs.mockResolvedValue([
            makeInput({
                episodeId: 'ep-abc',
                outroEndSec: 1420,
            }),
        ]);
        const logger = makeLogger();
        const episodes = [makeEpisode({ durationSeconds: 1440 })];

        const count = await runSynthesis(logger, episodes);

        expect(count).toBe(1);
        expect(mockReplaceCandidatesForMethod).toHaveBeenCalledOnce();
        expect(mockReplaceCandidatesForMethod).toHaveBeenCalledWith(
            expect.anything(), // sql
            'ep-abc',
            'anime-synth',
            [expect.objectContaining({ type: 'Preview', startTime: 1420, endTime: 1440 })],
        );
        expect(mockMaterialize).toHaveBeenCalledWith(fakeSql, episodes[0]);
        expect(mockAcquireResolutionLock.mock.invocationCallOrder[0]).toBeLessThan(
            mockReplaceCandidatesForMethod.mock.invocationCallOrder[0],
        );
        expect(mockReplaceCandidatesForMethod.mock.invocationCallOrder[0]).toBeLessThan(
            mockMaterialize.mock.invocationCallOrder[0],
        );
    });

    it('threads configHash and detectorVersion onto the candidate', async () => {
        mockGetAnimePreviewInputs.mockResolvedValue([makeInput({ outroEndSec: 1420 })]);
        const logger = makeLogger();
        const episodes = [makeEpisode({ durationSeconds: 1440 })];

        await runSynthesis(logger, episodes, undefined, {
            configHash: 'abc123',
            detectorVersion: 3,
        });

        expect(writtenCandidates('ep-abc')).toEqual([
            expect.objectContaining({ configHash: 'abc123', detectorVersion: 3 }),
        ]);
    });

    it('still writes its candidate when a Preview already exists — precedence is the resolver’s job', async () => {
        // EXPECTATION CHANGED with the evidence model. This used to assert that
        // an existing Preview suppressed synthesis, which was a read-then-skip
        // race against whatever wrote first. Now both are candidates and
        // METHOD_RANK decides: `chapter-title` (10) outranks `anime-synth` (25),
        // so an authored "Next episode" chapter still wins — on the merits,
        // durably, and visibly in the candidates table.
        mockGetAnimePreviewInputs.mockResolvedValue([
            makeInput({
                outroEndSec: 1420,
                hasExistingPreview: true,
            }),
        ]);
        const logger = makeLogger();
        const episodes = [makeEpisode({ durationSeconds: 1440 })];

        const count = await runSynthesis(logger, episodes);

        expect(count).toBe(1);
        expect(writtenCandidates('ep-abc')).toEqual([
            expect.objectContaining({ type: 'Preview', startTime: 1420, endTime: 1440 }),
        ]);
    });

    it('processes multiple episodes and counts only those that produce a Preview', async () => {
        // ep-1: eligible  ep-2: outro too close to end  ep-3: no outro
        const logger = makeLogger();
        const episodes = [
            makeEpisode({ episodeId: 'ep-1', durationSeconds: 1440 }),
            makeEpisode({ episodeId: 'ep-2', durationSeconds: 1440 }),
            makeEpisode({ episodeId: 'ep-3', durationSeconds: 1440 }),
        ];

        mockGetAnimePreviewInputs.mockResolvedValue([
            makeInput({
                episodeId: 'ep-1',
                outroEndSec: 1420,
            }),
            makeInput({
                episodeId: 'ep-2',
                outroEndSec: 1436,
            }),
            makeInput({
                episodeId: 'ep-3',
                outroEndSec: null,
            }),
        ]);

        const count = await runSynthesis(logger, episodes);

        expect(count).toBe(1);
        // One replace per episode — the two that produced nothing get the
        // empty-set write that retracts any stale candidate of theirs.
        expect(mockReplaceCandidatesForMethod).toHaveBeenCalledTimes(3);
        expect(writtenCandidates('ep-1')).toEqual([
            expect.objectContaining({ type: 'Preview', startTime: 1420, endTime: 1440 }),
        ]);
        expect(writtenCandidates('ep-2')).toEqual([]);
        expect(writtenCandidates('ep-3')).toEqual([]);
    });

    it('returns 0 and does not throw for an empty episodes array', async () => {
        mockGetAnimePreviewInputs.mockResolvedValue([]);
        const logger = makeLogger();

        const count = await runSynthesis(logger, []);

        expect(count).toBe(0);
        expect(mockReplaceCandidatesForMethod).not.toHaveBeenCalled();
    });

    it('logs a warning and continues when the candidate write throws, returning 0 for that episode', async () => {
        mockGetAnimePreviewInputs.mockResolvedValue([
            makeInput({
                episodeId: 'ep-abc',
                outroEndSec: 1420,
            }),
        ]);
        const logger = makeLogger();
        const episodes = [makeEpisode({ durationSeconds: 1440 })];

        mockReplaceCandidatesForMethod.mockRejectedValueOnce(new Error('DB constraint'));

        const count = await runSynthesis(logger, episodes);

        expect(count).toBe(0);
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
            expect.stringContaining('ep-abc'),
            expect.objectContaining({ error: 'DB constraint' }),
        );
    });

    it('stops writing once the abort signal fires', async () => {
        const logger = makeLogger();
        const episodes = [makeEpisode({ episodeId: 'ep-1' }), makeEpisode({ episodeId: 'ep-2' })];
        mockGetAnimePreviewInputs.mockResolvedValue([
            makeInput({ episodeId: 'ep-1', outroEndSec: 1420 }),
            makeInput({ episodeId: 'ep-2', outroEndSec: 1420 }),
        ]);
        const controller = new AbortController();
        controller.abort();

        const count = await runSynthesis(logger, episodes, controller.signal);

        expect(count).toBe(0);
        expect(mockReplaceCandidatesForMethod).not.toHaveBeenCalled();
    });
});
