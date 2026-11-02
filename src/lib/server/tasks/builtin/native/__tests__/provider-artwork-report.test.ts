// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operator dry-run for the provider-artwork drain: how many items remain, how
 * many bytes that is, where the bytes will land, and whether each target
 * volume has room. Read-only — it must not declare coversStages, or the
 * coverage wrapper would flip stage rows to `running` just to produce a report.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCountBacklog, mockCollectVolumes, mockMeasureHeadroom, mockPeekBudget } = vi.hoisted(
    () => ({
        mockCountBacklog: vi.fn(),
        mockCollectVolumes: vi.fn(),
        mockMeasureHeadroom: vi.fn(),
        mockPeekBudget: vi.fn(),
    }),
);

vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('../../../../database/queries/provider-artwork.queries.js', () => ({
    countProviderArtworkBacklog: mockCountBacklog,
}));
vi.mock('../../../../utils/artwork-volume-headroom.js', () => ({
    collectArtworkTargetVolumes: mockCollectVolumes,
    measureVolumeHeadroom: mockMeasureHeadroom,
}));
vi.mock('../../../../utils/artwork-rate-budget.js', () => ({ peekArtworkBudget: mockPeekBudget }));
vi.mock('../../../../config.js', () => ({
    config: {
        PROVIDER_ARTWORK_MIN_FREE_GB: 5,
        PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR: 2000,
        PROVIDER_ARTWORK_BACKFILL_ENABLED: true,
        METADATA_STORAGE_LOCATION: 'alongside-prefer',
    },
}));

import {
    providerArtworkReportTask,
    PROVIDER_ARTWORK_AVG_BYTES,
} from '../provider-artwork-report.js';

const ctx = {
    input: {},
    sql: {} as never,
    signal: new AbortController().signal,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    reportProgress: vi.fn(),
} as never;

describe('provider-artwork-report', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPeekBudget.mockResolvedValue(37);
        mockCollectVolumes.mockResolvedValue([
            { label: 'central', path: '/data/.metadata' },
            { label: 'library', path: '/media/movies' },
        ]);
        mockMeasureHeadroom.mockResolvedValue([
            {
                label: 'central',
                path: '/data/.metadata',
                freeBytes: 100,
                totalBytes: 1000,
                belowMargin: true,
            },
            {
                label: 'library',
                path: '/media/movies',
                freeBytes: 999_999_999_999,
                totalBytes: 2e12,
                belowMargin: false,
            },
        ]);
    });

    it('declares NO coversStages, so the coverage wrapper never engages', () => {
        expect(providerArtworkReportTask.coversStages).toBeUndefined();
    });

    it('is a global-identity, read-only maintenance task', () => {
        expect(providerArtworkReportTask.resourceClass).toBe('maintenance');
        expect(providerArtworkReportTask.identityFor({})).toBe(
            providerArtworkReportTask.identityFor({}),
        );
    });

    it('reports per-stage counts and estimated bytes', async () => {
        mockCountBacklog.mockResolvedValue([
            { stageId: 'provider-artwork-poster', pending: 100, withOwnFile: 80 },
            { stageId: 'provider-artwork-season-poster', pending: 10, withOwnFile: 0 },
        ]);

        const res = await providerArtworkReportTask.execute(ctx);
        const report = (
            res as unknown as { result: { perStage: Array<Record<string, number | string>> } }
        ).result;

        const poster = report.perStage.find((s) => s.stageId === 'provider-artwork-poster');
        expect(poster).toMatchObject({ pending: 100, withOwnFile: 80 });
        expect(poster?.estimatedBytes).toBe(
            100 * PROVIDER_ARTWORK_AVG_BYTES['provider-artwork-poster'],
        );
    });

    it('totals items, bytes and the transient peak (fetchFromUrl also fills customUrlCache)', async () => {
        mockCountBacklog.mockResolvedValue([
            { stageId: 'provider-artwork-logo', pending: 4, withOwnFile: 4 },
        ]);

        const res = await providerArtworkReportTask.execute(ctx);
        const report = (
            res as {
                result: {
                    totalItems: number;
                    totalEstimatedBytes: number;
                    transientPeakBytes: number;
                };
            }
        ).result;

        const expected = 4 * PROVIDER_ARTWORK_AVG_BYTES['provider-artwork-logo'];
        expect(report.totalItems).toBe(4);
        expect(report.totalEstimatedBytes).toBe(expected);
        expect(report.transientPeakBytes).toBe(expected * 2);
    });

    it('reports the alongside-vs-central estimate and the storage strategy', async () => {
        mockCountBacklog.mockResolvedValue([
            { stageId: 'provider-artwork-poster', pending: 10, withOwnFile: 7 },
        ]);

        const res = await providerArtworkReportTask.execute(ctx);
        const report = (
            res as {
                result: {
                    storageStrategy: string;
                    estimatedAlongsideItems: number;
                    estimatedCentralItems: number;
                };
            }
        ).result;

        expect(report.storageStrategy).toBe('alongside-prefer');
        expect(report.estimatedAlongsideItems).toBe(7);
        expect(report.estimatedCentralItems).toBe(3);
    });

    it('attributes everything to central when the strategy is central', async () => {
        const { config } = await import('../../../../config.js');
        (config as { METADATA_STORAGE_LOCATION: string }).METADATA_STORAGE_LOCATION = 'central';
        mockCountBacklog.mockResolvedValue([
            { stageId: 'provider-artwork-poster', pending: 10, withOwnFile: 7 },
        ]);

        const res = await providerArtworkReportTask.execute(ctx);
        const report = (
            res as { result: { estimatedAlongsideItems: number; estimatedCentralItems: number } }
        ).result;

        expect(report.estimatedAlongsideItems).toBe(0);
        expect(report.estimatedCentralItems).toBe(10);

        (config as { METADATA_STORAGE_LOCATION: string }).METADATA_STORAGE_LOCATION =
            'alongside-prefer';
    });

    it('surfaces per-volume free space and flags the ones below the margin', async () => {
        mockCountBacklog.mockResolvedValue([]);

        const res = await providerArtworkReportTask.execute(ctx);
        const report = (
            res as {
                result: {
                    volumes: Array<{ path: string; belowMargin: boolean }>;
                    headroomOk: boolean;
                    hourlyBudgetUsed: number;
                };
            }
        ).result;

        expect(report.headroomOk).toBe(false);
        expect(report.volumes.map((v) => v.path)).toEqual(['/data/.metadata', '/media/movies']);
        expect(report.hourlyBudgetUsed).toBe(37);
    });

    it('measures headroom against the configured GB margin', async () => {
        mockCountBacklog.mockResolvedValue([]);

        await providerArtworkReportTask.execute(ctx);

        expect(mockMeasureHeadroom).toHaveBeenCalledWith(expect.any(Array), 5 * 1024 ** 3);
    });
});
