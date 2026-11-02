// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * music-popularity task — unit tests.
 *
 * Covers execute() logic (provider configured/unconfigured), abort-before-start
 * guard, and backlog.stages() producing correct BacklogStage[].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import type * as DrainBacklogModule from '$lib/server/plugins/runtime/drain-backlog.js';

// ─── hoist all mocks so vi.mock factories can reference them ────────────────
const {
    mockCountPopularityBacklog,
    mockCountTotalArtists,
    mockGetStaleArtists,
    mockWipePopularityForSource,
    mockGetTaskSettings,
    mockUpsertTaskSettings,
    mockIsConfigured,
    mockEnrichArtist,
    mockDrainBacklog,
} = vi.hoisted(() => ({
    mockCountPopularityBacklog: vi.fn(),
    mockCountTotalArtists: vi.fn(),
    mockGetStaleArtists: vi.fn(),
    mockWipePopularityForSource: vi.fn(),
    mockGetTaskSettings: vi.fn(),
    mockUpsertTaskSettings: vi.fn(),
    mockIsConfigured: vi.fn(),
    mockEnrichArtist: vi.fn(),
    mockDrainBacklog: vi.fn(),
}));

// ─── mock the popularity query module ───────────────────────────────────────
vi.mock('$lib/server/database/queries/popularity.queries.js', () => ({
    countPopularityBacklog: mockCountPopularityBacklog,
    countTotalArtists: mockCountTotalArtists,
    getStaleArtists: mockGetStaleArtists,
    wipePopularityForSource: mockWipePopularityForSource,
    DEFAULT_WIPE_BATCH_SIZE: 500,
}));

// ─── mock task-settings queries ──────────────────────────────────────────────
vi.mock('$lib/server/database/queries/task-settings.queries.js', () => ({
    getTaskSettings: mockGetTaskSettings,
    upsertTaskSettings: mockUpsertTaskSettings,
}));

// ─── mock the Last.fm provider ───────────────────────────────────────────────
vi.mock('$lib/server/services/popularity/lastfm-provider.js', () => ({
    createLastFmProvider: vi.fn(() => ({
        id: 'lastfm',
        isConfigured: mockIsConfigured,
    })),
}));

// ─── mock enrichArtist (orchestrator) ───────────────────────────────────────
vi.mock('$lib/server/services/popularity/orchestrator.js', () => ({
    enrichArtist: mockEnrichArtist,
}));

// ─── mock drainBacklog so execute() doesn't need real drain logic ────────────
vi.mock('$lib/server/plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: mockDrainBacklog };
});

import { musicPopularityTask } from './music-popularity.js';

type MusicPopularityInput = Record<string, unknown>;

function makeContext(
    overrides: Partial<TaskContext<MusicPopularityInput>> = {},
): TaskContext<MusicPopularityInput> {
    const ac = new AbortController();
    return {
        runId: 'test-run-1',
        attemptNumber: 1,
        input: {},
        scope: {},
        mode: 'scheduled',
        sql: { tag: 'ctx-sql' } as never,
        logger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        reportProgress: vi.fn(),
        dep: vi.fn(),
        settings: vi.fn(),
        secrets: { get: vi.fn(), getOptional: vi.fn(), getUser: vi.fn() },
        reportFailure: vi.fn(),
        spend: vi.fn(),
        drain: vi.fn(),
        ...overrides,
    } as unknown as TaskContext<MusicPopularityInput>;
}

describe('music-popularity task', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: valid settings, provider configured
        mockGetTaskSettings.mockResolvedValue({
            source: 'lastfm',
            lastfm_api_key: 'test-key',
            refresh_days: 7,
        });
        mockIsConfigured.mockReturnValue(true);
        mockDrainBacklog.mockResolvedValue({
            stopReason: 'empty',
            processedCount: 0,
        });
    });

    it('declares exclusiveWith so catchup/manual/force runs cannot overlap (Bug 5)', () => {
        expect(musicPopularityTask.exclusiveWith).toMatchObject({ scope: 'global' });
        expect(musicPopularityTask.exclusiveWith?.ttl).toBe('35m');
        // ttl must be >= timeout.hard (SDK-enforced) so the dedup key can't
        // expire mid-run.
        expect(musicPopularityTask.timeout?.hard).toBe('30m');
    });

    it('identityFor is mode-independent so exclusiveWith dedups ACROSS catchup/manual/force', () => {
        // Regression guard: identityFor used to be `global-${mode}`, which gave
        // catchup/manual/force each their own exclusiveWith dedup key (the SETNX
        // mutex key is identityKey(taskId, identityFor(input)) — it has no
        // separate formula, so a mode-suffixed identityFor silently reopened the
        // cross-mode overlap exclusiveWith was added to close). identityFor must
        // now return the same value regardless of `mode` so a manual/force
        // trigger collapses onto an in-flight catchup run instead of running
        // alongside it.
        expect(musicPopularityTask.identityFor({})).toBe('global');
        expect(musicPopularityTask.identityFor({ mode: 'catchup' })).toBe('global');
        expect(musicPopularityTask.identityFor({ mode: 'manual' })).toBe('global');
        expect(musicPopularityTask.identityFor({ mode: 'force' })).toBe('global');
    });

    it('returns aborted stopReason when signal is already aborted before execute', async () => {
        const ac = new AbortController();
        ac.abort();
        const ctx = makeContext({ signal: ac.signal, abortSignal: ac.signal });

        const result = await musicPopularityTask.execute(ctx);

        expect(mockDrainBacklog).not.toHaveBeenCalled();
        expect(result.stopReason).toBe('aborted');
        expect(result.itemsProcessed).toBe(0);
    });

    it('skips cleanly (success, 0 processed) when provider is not configured', async () => {
        // Optional integration unconfigured must be a graceful skip, NOT a
        // failed run — otherwise a fresh install trips the amber
        // "Actionable Task Failures" health signal. The global-guard
        // disposition drains the pending stage rows separately.
        mockIsConfigured.mockReturnValue(false);

        const ctx = makeContext();
        const result = await musicPopularityTask.execute(ctx);

        expect(mockDrainBacklog).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(result.result?.message).toContain('not configured');
        expect(result.result?.message).toContain('lastfm');
    });

    it('calls drainBacklog and returns itemsProcessed from fetched count', async () => {
        mockDrainBacklog.mockResolvedValue({
            stopReason: 'empty',
            processedCount: 0,
        });

        const ctx = makeContext();
        const result = await musicPopularityTask.execute(ctx);

        expect(mockDrainBacklog).toHaveBeenCalledOnce();
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });

    it('passes mode from ctx.input to resolveDrainMode via drainBacklog call', async () => {
        mockDrainBacklog.mockResolvedValue({
            stopReason: 'empty',
            processedCount: 0,
        });

        const ctx = makeContext({ input: { mode: 'force' } });
        await musicPopularityTask.execute(ctx);

        // The options passed to drainBacklog should include a drain mode that
        // was resolved from 'force'. We verify drainBacklog was called with an
        // options object that includes mode.
        expect(mockDrainBacklog).toHaveBeenCalledWith(
            expect.objectContaining({ abortSignal: ctx.signal }),
            expect.objectContaining({ mode: expect.any(String) }),
        );
    });

    it('returns "All artists have fresh popularity data" message when 0 processed', async () => {
        mockDrainBacklog.mockResolvedValue({
            stopReason: 'empty',
            processedCount: 0,
        });

        const ctx = makeContext();
        const result = await musicPopularityTask.execute(ctx);

        expect(result.result?.message).toBe('All artists have fresh popularity data');
    });

    it('backlog.stages returns remaining stage when provider configured', async () => {
        mockCountPopularityBacklog.mockResolvedValue({
            analyzed: 150,
            remaining: 75,
        });

        const ctx = makeContext();
        const stages = await musicPopularityTask.backlog!.stages(ctx);

        expect(mockCountPopularityBacklog).toHaveBeenCalledOnce();
        expect(stages).toEqual([{ id: 'remaining', label: 'Remaining', count: 75 }]);
    });

    it('backlog.stages returns empty array when all artists have fresh data', async () => {
        mockCountPopularityBacklog.mockResolvedValue({
            analyzed: 100,
            remaining: 0,
        });

        const ctx = makeContext();
        const stages = await musicPopularityTask.backlog!.stages(ctx);

        expect(stages).toHaveLength(0);
    });

    it('backlog.stages uses countTotalArtists when provider is not configured', async () => {
        mockIsConfigured.mockReturnValue(false);
        mockCountTotalArtists.mockResolvedValue(42);

        const ctx = makeContext();
        const stages = await musicPopularityTask.backlog!.stages(ctx);

        expect(mockCountTotalArtists).toHaveBeenCalledOnce();
        expect(mockCountPopularityBacklog).not.toHaveBeenCalled();
        expect(stages).toEqual([{ id: 'remaining', label: 'Remaining', count: 42 }]);
    });

    it('backlog.wipe calls wipePopularityForSource when provider configured', async () => {
        mockWipePopularityForSource.mockResolvedValue(200);

        const ctx = makeContext();
        await musicPopularityTask.backlog!.wipe!(ctx);

        expect(mockWipePopularityForSource).toHaveBeenCalledOnce();
        expect(mockWipePopularityForSource).toHaveBeenCalledWith(
            ctx.sql,
            'lastfm',
            expect.any(Number),
            ctx.signal,
        );
    });

    it('backlog.wipe warns and returns without calling wipePopularityForSource when no provider', async () => {
        mockIsConfigured.mockReturnValue(false);

        const ctx = makeContext();
        await musicPopularityTask.backlog!.wipe!(ctx);

        expect(mockWipePopularityForSource).not.toHaveBeenCalled();
        expect(vi.mocked(ctx.logger.warn)).toHaveBeenCalledWith(
            expect.stringContaining('no provider configured'),
        );
    });
});
