// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import {
    runNeverOwnedMediaGc,
    summarizeNeverOwnedGc,
    type NeverOwnedGcResult,
} from '$lib/server/services/never-owned-media-gc.service.js';
vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
const settings = vi.hoisted(() => ({ enabled: false, minAgeDays: 30 }));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get NEVER_OWNED_MEDIA_GC_ENABLED(): boolean {
            return settings.enabled;
        },
        get NEVER_OWNED_MEDIA_GC_MIN_AGE_DAYS(): number {
            return settings.minAgeDays;
        },
    },
}));
vi.mock('$lib/server/services/never-owned-media-gc.service.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/services/never-owned-media-gc.service.js')
    >()),
    runNeverOwnedMediaGc: vi.fn(),
}));
import { neverOwnedMediaGcInput, neverOwnedMediaGcTask } from '../never-owned-media-gc.js';
import {
    discoveryLookbackDays,
    NEVER_OWNED_NO_FK_LOCK_TABLES,
    NO_FK_MEDIA_REFERENCES,
} from '$lib/server/database/queries/never-owned-media-gc.queries.js';

const rows = (n = 0): NeverOwnedGcResult['deleted'] => ({
    movieUnits: n,
    seriesUnits: n,
    seasons: n,
    episodes: n,
    extras: n,
    totalRows: n,
});

function result(over: Partial<NeverOwnedGcResult> = {}): NeverOwnedGcResult {
    const base: Omit<NeverOwnedGcResult, 'summary'> = {
        dryRun: true,
        enabled: false,
        forcedDryRun: true,
        minAgeDays: 30,
        batchLimit: 500,
        timeBudgetMs: 900_000,
        batches: 0,
        stoppedOnBudget: false,
        neverOwnedRoots: { movie: 10, series: 4 },
        tooYoung: { movie: 2, series: 1 },
        eligible: {
            ...rows(),
            movieUnits: 9,
            seriesUnits: 3,
            seasons: 5,
            episodes: 40,
            totalRows: 57,
        },
        kept: {
            movie: 1,
            series: 1,
            byRule: { 'user_ratings.media_id': 2 },
            byCategory: { 'user-data': 2, discovery: 1 },
            recentlySeenByDiscovery: 1,
        },
        selected: 12,
        deleted: rows(),
        skipped: 0,
        skipReasons: {},
        hasMore: false,
        sampleIds: [],
        evaluationComplete: true,
        ...over,
    };
    return { summary: summarizeNeverOwnedGc(base), ...base };
}

describe('never-owned media GC task contract', () => {
    beforeEach(() => {
        settings.enabled = false;
        settings.minAgeDays = 30;
        vi.mocked(runNeverOwnedMediaGc).mockReset();
    });

    it('registers a visible daily maintenance task', async () => {
        vi.resetModules();
        const { registry } = await import('../../../registry.js');
        const { neverOwnedMediaGcTask: loaded } = await import('../never-owned-media-gc.js');
        expect(registry.registerTask).toHaveBeenCalledWith(loaded);
        expect(neverOwnedMediaGcTask.id).toBe('never-owned-media-gc');
        expect(neverOwnedMediaGcTask.schedule).toEqual({ every: '24h', runOnStartup: false });
        expect(neverOwnedMediaGcTask.resourceClass).toBe('maintenance');
        expect(neverOwnedMediaGcTask.visibility).not.toBe('system');
        expect(neverOwnedMediaGcTask.quotas?.maxConcurrent).toBe(1);
    });

    it('accepts a preview flag, per-batch limit and bounded time budget', () => {
        expect(neverOwnedMediaGcInput.parse({})).toEqual({
            dryRun: false,
            batchLimit: 500,
            timeBudgetMs: 900_000,
        });
        expect(neverOwnedMediaGcInput.parse({ dryRun: true, batchLimit: 1000 })).toEqual({
            dryRun: true,
            batchLimit: 1000,
            timeBudgetMs: 900_000,
        });
        expect(neverOwnedMediaGcInput.parse({ timeBudgetMs: 3_600_000 }).timeBudgetMs).toBe(
            3_600_000,
        );
        for (const input of [
            { batchLimit: 0 },
            { batchLimit: 1001 },
            { timeBudgetMs: 0 },
            { timeBudgetMs: 3_600_001 },
            { timeBudgetMs: 1.5 },
            { minAgeDays: 1 },
            { force: true },
        ])
            expect(neverOwnedMediaGcInput.safeParse(input).success).toBe(false);
    });

    it('passes the settings to the run, so a disabled cleanup can only preview', async () => {
        const ctx = mockContext({
            input: { dryRun: false, batchLimit: 10, timeBudgetMs: 900_000 },
        });
        vi.mocked(runNeverOwnedMediaGc).mockResolvedValue(result());
        const out = await neverOwnedMediaGcTask.execute(ctx);
        expect(runNeverOwnedMediaGc).toHaveBeenCalledWith(
            ctx.sql,
            ctx.input,
            { enabled: false, minAgeDays: 30 },
            ctx.signal,
        );
        expect(out).toMatchObject({ success: true, itemsProcessed: 0 });

        settings.enabled = true;
        settings.minAgeDays = 60;
        await neverOwnedMediaGcTask.execute(ctx);
        expect(vi.mocked(runNeverOwnedMediaGc).mock.calls.at(-1)?.[2]).toEqual({
            enabled: true,
            minAgeDays: 60,
        });
    });

    it('reports deleted units as processed items', async () => {
        const ctx = mockContext({
            input: { dryRun: false, batchLimit: 10, timeBudgetMs: 900_000 },
        });
        vi.mocked(runNeverOwnedMediaGc).mockResolvedValue(
            result({
                dryRun: false,
                enabled: true,
                forcedDryRun: false,
                deleted: { ...rows(), movieUnits: 3, seriesUnits: 2, totalRows: 20 },
            }),
        );
        expect((await neverOwnedMediaGcTask.execute(ctx)).itemsProcessed).toBe(5);
    });

    it('summarises a forced preview in one readable line', () => {
        expect(result().summary).toBe(
            'Preview only (cleanup is off in Settings): would delete 9 movies and 3 series ' +
                '(5 seasons, 40 episodes, 0 extras; 57 rows); kept 2 referenced or protected units ' +
                '(user-data 2, discovery 1); 1 still listed by discovery; 3 younger than 30 days.',
        );
    });

    it('locks the table of every protect-class no-FK reference', () => {
        const protectTables = Object.entries(NO_FK_MEDIA_REFERENCES)
            .filter(([, entry]) => entry.class === 'protect')
            .map(([key]) => key.split('.')[0]);
        expect(protectTables.length).toBeGreaterThan(0);
        for (const table of protectTables) expect(NEVER_OWNED_NO_FK_LOCK_TABLES).toContain(table);
        for (const table of ['client_diagnostics', 'active_transcode_jobs', 'hls_playback_tokens'])
            expect(NEVER_OWNED_NO_FK_LOCK_TABLES).toContain(table);
    });

    it('looks back at least two discovery re-stamp periods', () => {
        expect(discoveryLookbackDays(7)).toBe(28);
        expect(discoveryLookbackDays(30)).toBe(30);
    });
});
