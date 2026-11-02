// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Retry disposition of per-item outcomes — regression coverage for the
 * 2026-07-30 prod incident in which the provider-artwork tasks fed their own
 * circuit breakers a steady stream of failures over conditions that retrying
 * could never change.
 *
 * Two independent halves, both about the SAME question: "is this outcome a
 * failure, or a decision?"
 *
 *  1. Lane A — a REFUSED payload (TMDB's SVG logos, oversized bodies) used to
 *     share the retryable `fetch-failed` reason. 29 items ground toward
 *     `maxAttempts: 30`, 145 failed runs in 24h, re-deriving the same refusal
 *     each time. It must be terminal, and a genuine transport failure must
 *     stay retryable.
 *
 *  2. Lane B — a season failing the backfill gate threw `kind: 'transient'`.
 *     Only transient/fatal failures count toward the circuit breaker
 *     (runner.ts:3619), so a handful of catalog-only `Specials` seasons
 *     re-enqueued by every series sync opened the circuit and paused the whole
 *     stage. It must throw `kind: 'permanent'`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskError } from '@sapd/lumastra-plugin-sdk';

const {
    mockConsumeBudget,
    mockPeekBudget,
    mockCheckHeadroom,
    mockGetWinningProviderArtworkPath,
    mockGetSeasonBackfillTarget,
    mockGetOwnLocalArtwork,
    mockMaterializeProviderArtwork,
    configState,
} = vi.hoisted(() => ({
    mockConsumeBudget: vi.fn(),
    mockPeekBudget: vi.fn(),
    mockCheckHeadroom: vi.fn(),
    mockGetWinningProviderArtworkPath: vi.fn(),
    mockGetSeasonBackfillTarget: vi.fn(),
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
    getSeasonBackfillTarget: mockGetSeasonBackfillTarget,
}));
vi.mock('../../../../database/queries/media-artwork.queries.js', () => ({
    getOwnLocalArtwork: mockGetOwnLocalArtwork,
}));
vi.mock('../../../../services/media-image-storage.service.js', () => ({
    materializeProviderArtwork: mockMaterializeProviderArtwork,
    resolveArtworkWritePath: vi.fn(),
    buildSeasonArtworkFileNameResolver: vi.fn(),
}));

import {
    providerArtworkLogoTask,
    providerArtworkSeasonPosterTask,
} from '../provider-artwork-backfill.js';

function makeCtx(input: { mediaItemId: string; dryRun?: boolean }) {
    return {
        signal: { aborted: false },
        input,
        sql: {} as never,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as never;
}

describe('provider-artwork-backfill: retry disposition', () => {
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
        mockGetWinningProviderArtworkPath.mockResolvedValue({
            provider: 'tmdb',
            path: '/umNJYUzgeOilCwFzp341ysKBgL8.svg',
        });
    });

    describe('Lane A — refused payload vs transport failure', () => {
        it('treats a refused payload as terminal: completes without throwing', async () => {
            mockMaterializeProviderArtwork.mockResolvedValue({
                materialized: false,
                reason: 'unsupported-content-type',
            });

            const result = await providerArtworkLogoTask.execute(
                makeCtx({ mediaItemId: 'item-svg' }),
            );

            expect(result).toMatchObject({
                success: true,
                itemsProcessed: 0,
                result: { materialized: false, reason: 'unsupported-content-type' },
            });
        });

        it('still retries a genuine transport failure', async () => {
            mockMaterializeProviderArtwork.mockResolvedValue({
                materialized: false,
                reason: 'fetch-failed',
            });

            await expect(
                providerArtworkLogoTask.execute(makeCtx({ mediaItemId: 'item-timeout' })),
            ).rejects.toMatchObject({ kind: 'transient' });
        });

        it('still retries an unresolvable write path (an operator CAN fix that)', async () => {
            mockMaterializeProviderArtwork.mockResolvedValue({
                materialized: false,
                reason: 'write-path-failed',
            });

            await expect(
                providerArtworkLogoTask.execute(makeCtx({ mediaItemId: 'item-ro-mount' })),
            ).rejects.toMatchObject({ kind: 'transient' });
        });
    });

    describe('Lane B — a season failing the gate must not feed the circuit breaker', () => {
        it('throws kind "permanent", never "transient"', async () => {
            mockGetSeasonBackfillTarget.mockResolvedValue(null);

            const err = await providerArtworkSeasonPosterTask
                .execute(makeCtx({ mediaItemId: 'season-no-files' }))
                .then(
                    () => null,
                    (e: unknown) => e,
                );

            expect(err).toBeInstanceOf(TaskError);
            // 'transient' here is what opened the prod circuit — only
            // transient/fatal failures count toward consecutive_failures.
            expect((err as TaskError).kind).toBe('permanent');
        });

        it('does not blame a missing tmdb parent for every gate failure', async () => {
            mockGetSeasonBackfillTarget.mockResolvedValue(null);

            const err = await providerArtworkSeasonPosterTask
                .execute(makeCtx({ mediaItemId: 'season-no-files' }))
                .then(
                    () => null,
                    (e: unknown) => e,
                );

            // The old message named one cause ("no tmdb-identified tv parent") and
            // sent an operator hunting for a missing provider id when the real
            // cause was has_files = false.
            const message = (err as Error).message;
            expect(message).toContain('season-no-files');
            expect(message).toContain('has_files');
        });
    });
});
