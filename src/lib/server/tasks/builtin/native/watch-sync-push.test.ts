// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the watch-sync-push task.
 *
 * Validates success-flag semantics (N1) and that skippedUnavailable is
 * decorated into the human-readable summary for the admin UI (S8).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import type { PushResult } from '$lib/server/services/watch-sync-engine.service.js';

const { mockRunPush } = vi.hoisted(() => ({
    mockRunPush: vi.fn<() => Promise<PushResult[]>>(() => Promise.resolve([])),
}));

vi.mock('$lib/server/services/watch-sync-engine.service.js', () => ({
    watchSyncEngine: { runPush: mockRunPush },
}));

vi.mock('../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

import { watchSyncPushTask } from './watch-sync-push.js';

type WatchSyncPushInput = Record<string, unknown>;

function makeResult(overrides: Partial<PushResult> = {}): PushResult {
    return {
        providerId: 'jellyfin-watch-sync',
        processed: 0,
        succeeded: 0,
        skipped: 0,
        failed: 0,
        skippedUnavailable: false,
        errors: [],
        durationMs: 0,
        ...overrides,
    };
}

function makeContext(
    overrides: Partial<TaskContext<WatchSyncPushInput>> = {},
): TaskContext<WatchSyncPushInput> {
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
    } as unknown as TaskContext<WatchSyncPushInput>;
}

describe('watch-sync-push task (N1 success semantics)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reports unpaired titles without failing a successful sync', async () => {
        mockRunPush.mockResolvedValue([makeResult({ processed: 3, succeeded: 1, notPaired: 2 })]);
        const result = await watchSyncPushTask.execute(makeContext());
        expect(result.success).toBe(true);
        expect(result.result?.partialSuccess).toBe(false);
        expect(result.result?.summary).toContain('2 titles not paired');
    });

    it('success=true when zero errors, result.partialSuccess=false', async () => {
        mockRunPush.mockResolvedValue([makeResult({ processed: 5, succeeded: 5 })]);

        const result = await watchSyncPushTask.execute(makeContext());

        expect(result.success).toBe(true);
        expect(result.result?.partialSuccess).toBe(false);
    });

    it('success=false when any errors surface; result.partialSuccess=true if some succeeded', async () => {
        mockRunPush.mockResolvedValue([
            makeResult({
                processed: 10,
                succeeded: 7,
                failed: 3,
                errors: ['alice/jf-1: boom'],
            }),
        ]);

        const result = await watchSyncPushTask.execute(makeContext());

        expect(result.success).toBe(false);
        expect(result.result?.partialSuccess).toBe(true);
    });

    it('decorates summary with "(unavailable)" for skipped providers (S8)', async () => {
        mockRunPush.mockResolvedValue([makeResult({ skippedUnavailable: true })]);

        const result = await watchSyncPushTask.execute(makeContext());

        expect(result.success).toBe(true);
        expect(result.result?.summary).toContain('(unavailable)');
    });

    it('threads ctx.signal into engine.runPush', async () => {
        mockRunPush.mockResolvedValue([]);
        const ctx = makeContext();
        await watchSyncPushTask.execute(ctx);

        expect(mockRunPush).toHaveBeenCalledWith(undefined, ctx.signal, ctx.sql);
    });

    it('surfaces stopReason=aborted when signal is already aborted', async () => {
        mockRunPush.mockResolvedValue([]);
        const ac = new AbortController();
        ac.abort();
        const result = await watchSyncPushTask.execute(
            makeContext({ signal: ac.signal, abortSignal: ac.signal }),
        );

        expect(result.stopReason).toBe('aborted');
    });

    it('returns no-providers summary when results array is empty', async () => {
        mockRunPush.mockResolvedValue([]);
        const result = await watchSyncPushTask.execute(makeContext());

        expect(result.result?.summary).toBe('No watch-sync providers enabled');
    });

    it('throws when engine.runPush rejects', async () => {
        mockRunPush.mockRejectedValue(new Error('Push engine failed'));

        await expect(watchSyncPushTask.execute(makeContext())).rejects.toThrow(
            'Push engine failed',
        );
    });
});

describe('watch-sync-push task (singleton guard)', () => {
    it('declares exclusiveWith so the 5-minute scheduler cannot pile up pending runs', () => {
        expect(watchSyncPushTask.exclusiveWith).toMatchObject({ scope: 'global', ttl: '6m' });
    });

    it('keeps exclusiveWith.ttl >= timeout.hard so the dedup key cannot expire mid-run', () => {
        // SDK rejects ttl < hard; 6m must stay above the 5m hard cap.
        expect(watchSyncPushTask.timeout?.hard).toBe('5m');
    });
});
