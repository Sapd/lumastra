// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Season-poster lane: how an empty seasons answer is classified.
 *
 * Observed on prod 2026-08-26 — series 216416 sat on the "Stuck items" rail at
 * 17 attempts against a TMDB hard 404. The lane called the LENIENT
 * `getTVShowSeasons`, which collapses 404 / 429 / 5xx / network into the same
 * `[]`, so the only safe reading of `[]` was `transient` and an unfixable id
 * retried forever.
 *
 * The inverse mistake is worse: classifying every `[]` as permanent would
 * dead-letter every season row touched during a routine TMDB rate-limit. Both
 * directions are pinned here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskError } from '@sapd/lumastra-plugin-sdk';

const {
    mockConsumeBudget,
    mockPeekBudget,
    mockCheckHeadroom,
    mockGetSeasonBackfillTarget,
    mockGetOwnLocalArtwork,
    mockMaterializeProviderArtwork,
    mockGetTVShowSeasonsResult,
    mockIsAvailable,
    configState,
} = vi.hoisted(() => ({
    mockConsumeBudget: vi.fn(),
    mockPeekBudget: vi.fn(),
    mockCheckHeadroom: vi.fn(),
    mockGetSeasonBackfillTarget: vi.fn(),
    mockGetOwnLocalArtwork: vi.fn(),
    mockMaterializeProviderArtwork: vi.fn(),
    mockGetTVShowSeasonsResult: vi.fn(),
    mockIsAvailable: vi.fn(),
    configState: {
        PROVIDER_ARTWORK_BACKFILL_ENABLED: true,
        PROVIDER_ARTWORK_MIN_FREE_GB: 0,
        PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR: 2000,
        TMDB_API_KEY: 'test-key',
    },
}));

vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('../../../../utils/artwork-rate-budget.js', () => ({
    peekArtworkBudget: mockPeekBudget,
    consumeArtworkBudget: mockConsumeBudget,
}));
vi.mock('../../../../utils/artwork-volume-headroom.js', () => ({
    checkArtworkDiskHeadroom: mockCheckHeadroom,
}));
vi.mock('../../../../config.js', () => ({ config: configState }));
vi.mock('../../../../database/queries/provider-artwork.queries.js', () => ({
    getWinningProviderArtworkPath: vi.fn(),
    getSeasonBackfillTarget: mockGetSeasonBackfillTarget,
}));
vi.mock('../../../../database/queries/media-artwork.queries.js', () => ({
    getOwnLocalArtwork: mockGetOwnLocalArtwork,
}));
vi.mock('../../../../services/media-image-storage.service.js', () => ({
    materializeProviderArtwork: mockMaterializeProviderArtwork,
    resolveArtworkWritePath: vi.fn(),
    buildSeasonArtworkFileNameResolver: vi.fn().mockResolvedValue(() => 'poster.jpg'),
}));
vi.mock('../../../../providers/implementations/tmdb/client.js', () => ({
    tmdbApi: {
        isAvailable: mockIsAvailable,
        getTVShowSeasonsResult: mockGetTVShowSeasonsResult,
    },
}));

import { providerArtworkSeasonPosterTask } from '../provider-artwork-backfill.js';
import { countExternalCall } from '../../../../utils/external-request-counter.js';

function makeCtx(input: { mediaItemId: string; dryRun?: boolean }) {
    return {
        signal: { aborted: false },
        input,
        sql: {} as never,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as never;
}

async function runAndCatch(mediaItemId: string): Promise<unknown> {
    return providerArtworkSeasonPosterTask.execute(makeCtx({ mediaItemId })).then(
        () => null,
        (e: unknown) => e,
    );
}

describe('provider-artwork-backfill: empty-seasons classification', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configState.PROVIDER_ARTWORK_BACKFILL_ENABLED = true;
        configState.PROVIDER_ARTWORK_MIN_FREE_GB = 0;
        configState.PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR = 2000;
        configState.TMDB_API_KEY = 'test-key';
        mockPeekBudget.mockResolvedValue(0);
        mockCheckHeadroom.mockResolvedValue({ ok: true, volumes: [] });
        mockConsumeBudget.mockResolvedValue(true);
        mockGetOwnLocalArtwork.mockResolvedValue(null);
        mockIsAvailable.mockReturnValue(true);
        // A season that passes the gate, so every test below reaches the TMDB call.
        mockGetSeasonBackfillTarget.mockResolvedValue({
            seriesId: 'series-uuid',
            seriesTmdbId: '216416',
            seasonNumber: 1,
        });
    });

    it('dead-letters a 404 series immediately instead of retrying it forever', async () => {
        mockGetTVShowSeasonsResult.mockResolvedValue({
            ok: false,
            reason: 'not-found',
            message: 'TMDB API request failed: 404 Not Found',
        });

        const err = await runAndCatch('season-of-216416');

        expect(err).toBeInstanceOf(TaskError);
        expect((err as TaskError).kind).toBe('permanent');
        // The message must point at the actual remedy — the id is wrong.
        expect((err as Error).message).toContain('404');
        expect((err as Error).message).toContain('re-identify');
    });

    it('dead-letters a series TMDB answers for but lists no seasons on', async () => {
        mockGetTVShowSeasonsResult.mockResolvedValue({ ok: true, seasons: [] });

        const err = await runAndCatch('season-of-empty-series');

        expect(err).toBeInstanceOf(TaskError);
        expect((err as TaskError).kind).toBe('permanent');
        expect((err as Error).message).toContain('no seasons');
    });

    it.each([
        ['rate limit', 'rate limited'],
        ['upstream 5xx', 'server error'],
        ['network failure', 'fetch failed'],
    ])('STILL retries when TMDB is merely unreachable (%s)', async (_label, message) => {
        // The regression guard in the other direction: a routine TMDB blip must
        // not dead-letter every season row it touches.
        mockGetTVShowSeasonsResult.mockResolvedValue({
            ok: false,
            reason: 'unavailable',
            message,
        });

        const err = await runAndCatch('season-during-outage');

        expect(err).toBeInstanceOf(TaskError);
        expect((err as TaskError).kind).toBe('transient');
        expect((err as Error).message).toContain(message);
    });

    it('proceeds normally when the season exists and has a poster', async () => {
        mockGetTVShowSeasonsResult.mockResolvedValue({
            ok: true,
            seasons: [
                { seasonNumber: 1, name: 'Season 1', episodeCount: 10, posterPath: '/p.jpg' },
            ],
        });
        mockMaterializeProviderArtwork.mockResolvedValue({ materialized: true });

        const result = await providerArtworkSeasonPosterTask.execute(
            makeCtx({ mediaItemId: 'season-ok' }),
        );

        expect(result).toMatchObject({ success: true });
        expect(mockMaterializeProviderArtwork).toHaveBeenCalled();
    });

    it('records its TMDB request on the cost page (api_calls per host)', async () => {
        // The five provider-artwork tasks called TMDB without withApiCallSpend, so
        // the season-poster stage (760 runs on a busy prod day) showed no spend.
        mockGetTVShowSeasonsResult.mockImplementation(async () => {
            countExternalCall('https://api.themoviedb.org/3/tv/216416', 200);
            return { ok: true, seasons: [{ seasonNumber: 1, name: 'S1', episodeCount: 10 }] };
        });
        const spend = vi.fn();
        const ctx = Object.assign(makeCtx({ mediaItemId: 'season-cost' }) as object, { spend });

        await providerArtworkSeasonPosterTask.execute(ctx as never);

        expect(spend).toHaveBeenCalledWith('api_calls', 1);
        expect(spend).toHaveBeenCalledWith('api_calls:api.themoviedb.org', 1);
    });

    it('never calls the lenient getTVShowSeasons, which would erase the distinction', async () => {
        mockGetTVShowSeasonsResult.mockResolvedValue({ ok: true, seasons: [] });
        await runAndCatch('season-of-empty-series');

        // The mocked tmdbApi exposes no `getTVShowSeasons` at all — reaching for
        // it would TypeError rather than silently reclassify. This asserts the
        // strict variant is the one actually wired up.
        expect(mockGetTVShowSeasonsResult).toHaveBeenCalledWith(216416);
    });
});

describe('provider-artwork-backfill: already-local season makes no TMDB request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configState.PROVIDER_ARTWORK_BACKFILL_ENABLED = true;
        configState.PROVIDER_ARTWORK_MIN_FREE_GB = 0;
        configState.PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR = 2000;
        configState.TMDB_API_KEY = 'test-key';
        mockPeekBudget.mockResolvedValue(0);
        mockCheckHeadroom.mockResolvedValue({ ok: true, volumes: [] });
        mockConsumeBudget.mockResolvedValue(true);
        mockIsAvailable.mockReturnValue(true);
        mockGetSeasonBackfillTarget.mockResolvedValue({
            seriesId: 'series-uuid',
            seriesTmdbId: '216416',
            seasonNumber: 1,
        });
    });

    // The counted TMDB call for an already-local run was a REAL HTTP request:
    // `getTVShowSeasonsResult` misses the response cache and `makeRequest` fetches,
    // counting each attempt. The local check ran after that fetch, so every
    // already-local season cost one api call with nothing to show for it.
    it('does not fetch TMDB or record api_calls when the season already has a local poster', async () => {
        mockGetOwnLocalArtwork.mockResolvedValue({ id: 'local-row' });
        mockGetTVShowSeasonsResult.mockImplementation(async () => {
            countExternalCall('https://api.themoviedb.org/3/tv/216416', 200);
            return {
                ok: true,
                seasons: [{ seasonNumber: 1, name: 'S1', episodeCount: 10, posterPath: '/p.jpg' }],
            };
        });
        const spend = vi.fn();
        const ctx = Object.assign(makeCtx({ mediaItemId: 'season-local' }) as object, { spend });

        const result = await providerArtworkSeasonPosterTask.execute(ctx as never);

        expect(mockGetTVShowSeasonsResult).not.toHaveBeenCalled();
        expect(spend).not.toHaveBeenCalled();
        expect(mockMaterializeProviderArtwork).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            success: true,
            itemsProcessed: 0,
            result: { materialized: false, reason: 'already-local' },
        });
    });
});
