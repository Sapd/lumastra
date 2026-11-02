// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the watch-sync-pull task.
 *
 * Validates success-flag semantics (N1) — strict success requires zero errors;
 * partial progress surfaces via result.partialSuccess so the admin UI can render
 * a degraded-but-productive state without false alarms.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import type { PullResult } from '$lib/server/services/watch-sync-engine.service.js';

const { mockRunPull } = vi.hoisted(() => ({
    mockRunPull: vi.fn<() => Promise<PullResult[]>>(() => Promise.resolve([])),
}));

vi.mock('$lib/server/services/watch-sync-engine.service.js', () => ({
    watchSyncEngine: { runPull: mockRunPull },
}));

vi.mock('../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

import { watchSyncPullTask } from './watch-sync-pull.js';

type WatchSyncPullInput = Record<string, unknown>;

function makeResult(overrides: Partial<PullResult> = {}): PullResult {
    return {
        provider: 'jellyfin',
        pulled: true,
        movies: { imported: 0, skipped: 0 },
        episodes: { imported: 0, skipped: 0, seriesResolved: 0 },
        resumeItems: { imported: 0, skipped: 0 },
        totalFromProvider: 0,
        totalResolved: 0,
        totalUpserted: 0,
        totalSkippedNoMatch: 0,
        totalBuffered: 0,
        usersSkippedNoLumastraAccount: 0,
        skippedUnavailable: false,
        errors: [],
        durationMs: 0,
        ...overrides,
    };
}

function makeContext(
    overrides: Partial<TaskContext<WatchSyncPullInput>> = {},
): TaskContext<WatchSyncPullInput> {
    const ac = new AbortController();
    return {
        sql: {} as never,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        input: {},
        reportProgress: vi.fn(),
        ...overrides,
    } as unknown as TaskContext<WatchSyncPullInput>;
}

describe('watch-sync-pull task (N1 success semantics)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reports unpaired titles without failing a successful sync', async () => {
        mockRunPull.mockResolvedValue([makeResult({ totalUpserted: 1, totalSkippedNoMatch: 2 })]);
        const result = await watchSyncPullTask.execute(makeContext());
        expect(result.success).toBe(true);
        expect(result.result?.partialSuccess).toBe(false);
        expect(result.result?.summary).toContain('2 titles not paired');
    });

    it('success=true when zero errors, result.partialSuccess=false', async () => {
        mockRunPull.mockResolvedValue([
            makeResult({
                totalUpserted: 3,
                movies: { imported: 3, skipped: 0 },
            }),
        ]);

        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.success).toBe(true);
        expect(result.result?.partialSuccess).toBe(false);
        expect(result.itemsProcessed).toBe(3);
    });

    it('success=false when any errors surface, even with progress', async () => {
        mockRunPull.mockResolvedValue([
            makeResult({
                totalUpserted: 5,
                movies: { imported: 5, skipped: 0 },
                errors: ['user=bob: something broke'],
            }),
        ]);

        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.success).toBe(false);
        expect(result.result?.partialSuccess).toBe(true);
        expect(result.result?.allErrors).toEqual(['user=bob: something broke']);
    });

    it('success=false when errors with zero progress', async () => {
        mockRunPull.mockResolvedValue([makeResult({ errors: ['fatal'] })]);

        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.success).toBe(false);
        expect(result.result?.partialSuccess).toBe(false);
    });

    it('passes ctx.signal down to engine.runPull', async () => {
        mockRunPull.mockResolvedValue([]);
        const ctx = makeContext();
        await watchSyncPullTask.execute(ctx);

        expect(mockRunPull).toHaveBeenCalledWith(undefined, ctx.signal, ctx.sql);
    });

    it('surfaces stopReason=aborted when signal is already aborted', async () => {
        mockRunPull.mockResolvedValue([]);
        const ac = new AbortController();
        ac.abort();
        const result = await watchSyncPullTask.execute(
            makeContext({ signal: ac.signal, abortSignal: ac.signal }),
        );

        expect(result.stopReason).toBe('aborted');
    });

    it('returns no-providers summary when results array is empty', async () => {
        mockRunPull.mockResolvedValue([]);
        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.result?.summary).toBe('No watch-sync providers with pull enabled');
    });

    it('propagates usersSkippedNoLumastraAccount into result.meta', async () => {
        mockRunPull.mockResolvedValue([makeResult({ usersSkippedNoLumastraAccount: 2 })]);

        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.result?.meta.usersSkippedNoLumastraAccount).toBe(2);
    });

    it('keeps skipped usernames and the true count per provider, Trakt apart from Jellyfin', async () => {
        mockRunPull.mockResolvedValue([
            makeResult({
                provider: 'jellyfin-watch-sync',
                usersSkippedNoLumastraAccount: 2,
                skippedNoLumastraAccountNames: ['alice', 'bob'],
            }),
            makeResult({
                provider: 'trakt',
                usersSkippedNoLumastraAccount: 1,
                skippedNoLumastraAccountNames: ['carol'],
            }),
        ]);

        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.result?.meta.usersSkippedNoLumastraAccount).toBe(3);
        expect(result.result?.meta.skippedNoLumastraAccountByProvider).toEqual({
            'jellyfin-watch-sync': ['alice', 'bob'],
            trakt: ['carol'],
        });
        expect(result.result?.meta.skippedNoLumastraAccountCountByProvider).toEqual({
            'jellyfin-watch-sync': 2,
            trakt: 1,
        });
    });

    it('lists a pulled Jellyfin provider with an empty list when no user was skipped', async () => {
        mockRunPull.mockResolvedValue([makeResult({ provider: 'jellyfin-watch-sync' })]);

        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.result?.meta.skippedNoLumastraAccountByProvider).toEqual({
            'jellyfin-watch-sync': [],
        });
        expect(result.result?.meta.skippedNoLumastraAccountCountByProvider).toEqual({
            'jellyfin-watch-sync': 0,
        });
    });

    it('leaves a provider that was unavailable this run out of the per-provider maps', async () => {
        mockRunPull.mockResolvedValue([
            makeResult({ provider: 'jellyfin-watch-sync', skippedUnavailable: true }),
        ]);

        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.result?.meta.skippedNoLumastraAccountByProvider).toEqual({});
        expect(result.result?.meta.skippedNoLumastraAccountCountByProvider).toEqual({});
    });

    it('leaves an available provider whose pull never ran out of the per-provider maps', async () => {
        mockRunPull.mockResolvedValue([
            { ...makeResult({ provider: 'jellyfin-watch-sync' }), pulled: false },
            makeResult({ provider: 'trakt', skippedNoLumastraAccountNames: ['bob'] }),
        ]);

        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.success).toBe(true);
        expect(result.result?.meta.skippedNoLumastraAccountByProvider).toEqual({ trakt: ['bob'] });
        expect(result.result?.meta.skippedNoLumastraAccountCountByProvider).toEqual({ trakt: 1 });
    });

    it("caps each provider's stored names at 50 while its count stays exact", async () => {
        const names = Array.from({ length: 60 }, (_, i) => `user-${i}`);
        mockRunPull.mockResolvedValue([
            makeResult({
                provider: 'jellyfin-watch-sync',
                usersSkippedNoLumastraAccount: 60,
                skippedNoLumastraAccountNames: names,
            }),
        ]);

        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.result?.meta.usersSkippedNoLumastraAccount).toBe(60);
        expect(
            result.result?.meta.skippedNoLumastraAccountByProvider['jellyfin-watch-sync'],
        ).toHaveLength(50);
        expect(result.result?.meta.skippedNoLumastraAccountCountByProvider).toEqual({
            'jellyfin-watch-sync': 60,
        });
    });

    it('de-duplicates names case-insensitively within a provider', async () => {
        mockRunPull.mockResolvedValue([
            makeResult({
                provider: 'jellyfin-watch-sync',
                usersSkippedNoLumastraAccount: 3,
                skippedNoLumastraAccountNames: ['Bob', 'bob', 'alice'],
            }),
        ]);

        const result = await watchSyncPullTask.execute(makeContext());

        expect(result.result?.meta.skippedNoLumastraAccountByProvider).toEqual({
            'jellyfin-watch-sync': ['Bob', 'alice'],
        });
        expect(result.result?.meta.skippedNoLumastraAccountCountByProvider).toEqual({
            'jellyfin-watch-sync': 2,
        });
    });

    it('writes lifecycle and per-provider outcomes to the task-run log', async () => {
        mockRunPull.mockResolvedValue([
            makeResult({ provider: 'jellyfin', totalUpserted: 3, totalSkippedNoMatch: 1 }),
        ]);
        const ctx = makeContext();

        await watchSyncPullTask.execute(ctx);

        expect(ctx.logger.info).toHaveBeenCalledWith('Watch sync pull started');
        expect(ctx.logger.warn).toHaveBeenCalledWith(
            'Watch sync pull jellyfin: 3 imported, 1 titles not paired, 0 buffered',
            expect.objectContaining({ errors: [] }),
        );
        expect(ctx.logger.info).toHaveBeenCalledWith(
            'Watch sync pull finished',
            expect.objectContaining({ totalProcessed: 3, providers: 1, errors: 0 }),
        );
    });

    it('writes provider errors to the task-run log', async () => {
        mockRunPull.mockResolvedValue([makeResult({ errors: ['provider request timed out'] })]);
        const ctx = makeContext();

        await watchSyncPullTask.execute(ctx);

        expect(ctx.logger.warn).toHaveBeenCalledWith(
            'Watch sync pull jellyfin: 0 imported, 0 titles not paired, 0 buffered',
            { errors: ['provider request timed out'] },
        );
    });

    it('throws when engine.runPull rejects', async () => {
        mockRunPull.mockRejectedValue(new Error('Engine exploded'));

        await expect(watchSyncPullTask.execute(makeContext())).rejects.toThrow('Engine exploded');
    });
});

describe('watch-sync-pull task (singleton guard)', () => {
    it('declares exclusiveWith so the 5-minute scheduler cannot pile up pending runs', () => {
        // identityFor is a constant ('global-catchup'); without exclusiveWith
        // every fire enqueues a fresh pending run and a slow pull accumulates a
        // deep backlog. exclusiveWith collapses concurrent fires into one run.
        expect(watchSyncPullTask.exclusiveWith).toMatchObject({ scope: 'global', ttl: '130m' });
    });

    it('keeps exclusiveWith.ttl >= timeout.hard so the dedup key cannot expire mid-run', () => {
        // SDK rejects ttl < hard; 130m must stay above the 2h (120m) hard cap.
        const ttlMin = 130;
        const hardMin = 120;
        expect(ttlMin).toBeGreaterThanOrEqual(hardMin);
        expect(watchSyncPullTask.timeout?.hard).toBe('2h');
    });
});
