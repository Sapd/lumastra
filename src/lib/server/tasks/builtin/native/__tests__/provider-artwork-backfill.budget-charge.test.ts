// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression coverage for the "budget charged on no-ops" prod incident:
 * every provider-artwork-backfill run used to consume one hourly-budget slot
 * BEFORE checking whether there was any work to do, so a backlog dominated by
 * `already-local` items burned the entire hourly cap confirming it had
 * nothing to fetch, starving genuine downloads. The budget must be consumed
 * only immediately before `materializeProviderArtwork` is actually invoked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockConsumeBudget,
    mockPeekBudget,
    mockCheckHeadroom,
    mockGetWinningProviderArtworkPath,
    mockGetOwnLocalArtwork,
    mockMaterializeProviderArtwork,
    configState,
} = vi.hoisted(() => ({
    mockConsumeBudget: vi.fn(),
    mockPeekBudget: vi.fn(),
    mockCheckHeadroom: vi.fn(),
    mockGetWinningProviderArtworkPath: vi.fn(),
    mockGetOwnLocalArtwork: vi.fn(),
    mockMaterializeProviderArtwork: vi.fn(),
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
    getWinningProviderArtworkPath: mockGetWinningProviderArtworkPath,
    getSeasonBackfillTarget: vi.fn(),
}));
vi.mock('../../../../database/queries/media-artwork.queries.js', () => ({
    getOwnLocalArtwork: mockGetOwnLocalArtwork,
}));
vi.mock('../../../../services/media-image-storage.service.js', () => ({
    materializeProviderArtwork: mockMaterializeProviderArtwork,
    resolveArtworkWritePath: vi.fn(),
    buildSeasonArtworkFileNameResolver: vi.fn(),
}));

import { providerArtworkPosterTask } from '../provider-artwork-backfill.js';

function makeCtx(input: { mediaItemId: string; dryRun?: boolean }) {
    return {
        signal: { aborted: false },
        input,
        sql: {} as never,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as never;
}

describe('provider-artwork-backfill: budget charged only at the point of no return', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configState.PROVIDER_ARTWORK_BACKFILL_ENABLED = true;
        configState.PROVIDER_ARTWORK_MIN_FREE_GB = 0;
        configState.PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR = 2000;
        configState.TMDB_API_KEY = 'test-key';
        mockPeekBudget.mockResolvedValue(0);
        mockCheckHeadroom.mockResolvedValue({ ok: true, volumes: [] });
        mockConsumeBudget.mockResolvedValue(true);
    });

    it('completes an already-local item WITHOUT consuming the hourly budget', async () => {
        mockGetWinningProviderArtworkPath.mockResolvedValue({
            provider: 'tmdb',
            path: '/abc.jpg',
        });
        mockGetOwnLocalArtwork.mockResolvedValue({
            id: 'art-1',
            media_item_id: 'item-1',
            artwork_type: 'poster',
            source: 'local',
            file_path: '/data/poster.jpg',
            remote_url: null,
            language: null,
            sort_order: 0,
            created_at: new Date(),
        });

        const result = await providerArtworkPosterTask.execute(makeCtx({ mediaItemId: 'item-1' }));

        expect(mockConsumeBudget).not.toHaveBeenCalled();
        expect(mockMaterializeProviderArtwork).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            success: true,
            itemsProcessed: 0,
            result: { materialized: false, reason: 'already-local' },
        });
    });

    it('completes an item with no provider path WITHOUT consuming the hourly budget', async () => {
        mockGetWinningProviderArtworkPath.mockResolvedValue(null);

        const result = await providerArtworkPosterTask.execute(makeCtx({ mediaItemId: 'item-2' }));

        expect(mockConsumeBudget).not.toHaveBeenCalled();
        expect(mockGetOwnLocalArtwork).not.toHaveBeenCalled();
        expect(mockMaterializeProviderArtwork).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            success: true,
            itemsProcessed: 0,
            result: { materialized: false, reason: 'no-provider-path' },
        });
    });

    it('consumes exactly one budget slot when an item genuinely materializes', async () => {
        mockGetWinningProviderArtworkPath.mockResolvedValue({
            provider: 'tmdb',
            path: '/abc.jpg',
        });
        mockGetOwnLocalArtwork.mockResolvedValue(null);
        mockMaterializeProviderArtwork.mockResolvedValue({
            materialized: true,
            filePath: '/data/poster.jpg',
        });

        const result = await providerArtworkPosterTask.execute(makeCtx({ mediaItemId: 'item-3' }));

        expect(mockConsumeBudget).toHaveBeenCalledTimes(1);
        expect(mockMaterializeProviderArtwork).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            success: true,
            itemsProcessed: 1,
            result: { materialized: true, filePath: '/data/poster.jpg' },
        });
    });

    it('returns the hourly-budget-exhausted blocked result when the budget is genuinely exhausted at the point of no return', async () => {
        mockGetWinningProviderArtworkPath.mockResolvedValue({
            provider: 'tmdb',
            path: '/abc.jpg',
        });
        mockGetOwnLocalArtwork.mockResolvedValue(null);
        mockConsumeBudget.mockResolvedValue(false);

        const result = await providerArtworkPosterTask.execute(makeCtx({ mediaItemId: 'item-4' }));

        expect(mockMaterializeProviderArtwork).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            success: false,
            itemsProcessed: 0,
            stopReason: 'budget',
            result: { materialized: false, reason: 'hourly-budget-exhausted' },
        });
    });

    it('dry run consumes no budget and does not check already-local', async () => {
        mockGetWinningProviderArtworkPath.mockResolvedValue({
            provider: 'tmdb',
            path: '/abc.jpg',
        });
        const { resolveArtworkWritePath } =
            await import('../../../../services/media-image-storage.service.js');
        vi.mocked(resolveArtworkWritePath).mockResolvedValue({
            filePath: '/data/poster.jpg',
        } as never);

        const result = await providerArtworkPosterTask.execute(
            makeCtx({ mediaItemId: 'item-5', dryRun: true }),
        );

        expect(mockConsumeBudget).not.toHaveBeenCalled();
        expect(mockMaterializeProviderArtwork).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            success: false,
            stopReason: 'skipped',
            result: { materialized: false, reason: 'dry-run' },
        });
    });
});
