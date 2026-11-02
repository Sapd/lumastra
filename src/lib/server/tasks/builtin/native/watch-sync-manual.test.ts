// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the watch-sync-manual task.
 *
 * Validates the per-direction wiring: `push` re-queues the user's decisive
 * events for the provider BEFORE calling `runPushForUser`; `pull` resets
 * the pull cursor BEFORE calling `runPullForUser`. Both forward the
 * engine's progress reporter into `ctx.reportProgress`, and a
 * pre-aborted `ctx.signal` short-circuits before either engine method
 * (or query helper) runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

type WatchSyncReporter = (p: { processed: number; total?: number; currentItem?: string }) => void;

const { mockRunPushForUser, mockRunPullForUser } = vi.hoisted(() => ({
    mockRunPushForUser: vi.fn<
        (userId: string, pluginId: string, reporter: WatchSyncReporter) => Promise<void>
    >(() => Promise.resolve()),
    mockRunPullForUser: vi.fn<
        (userId: string, pluginId: string, reporter: WatchSyncReporter) => Promise<void>
    >(() => Promise.resolve()),
}));

const { mockResetPullCursor, mockRequeueUserEventsForProvider } = vi.hoisted(() => ({
    mockResetPullCursor: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    mockRequeueUserEventsForProvider: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('$lib/server/services/watch-sync-engine.service.js', () => ({
    watchSyncEngine: {
        runPushForUser: mockRunPushForUser,
        runPullForUser: mockRunPullForUser,
    },
}));

vi.mock('$lib/server/database/queries/watch-sync-pull-log.queries.js', () => ({
    resetPullCursor: mockResetPullCursor,
}));

vi.mock('$lib/server/database/queries/user-media-events.queries.js', () => ({
    requeueUserEventsForProvider: mockRequeueUserEventsForProvider,
}));

vi.mock('../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

import { watchSyncManualTask } from './watch-sync-manual.js';

interface WatchSyncManualInput {
    userId: string;
    provider: 'mal' | 'trakt';
    direction: 'pull' | 'push';
}

const USER_ID = '11111111-1111-1111-1111-111111111111';

function makeContext(
    input: WatchSyncManualInput,
    overrides: Partial<TaskContext<WatchSyncManualInput>> = {},
): TaskContext<WatchSyncManualInput> {
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
        input,
        reportProgress: vi.fn(),
        ...overrides,
    } as unknown as TaskContext<WatchSyncManualInput>;
}

describe('watch-sync-manual task', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('push direction: requeues events THEN calls runPushForUser with the plugin id, forwarding the reporter', async () => {
        const ctx = makeContext({ userId: USER_ID, provider: 'mal', direction: 'push' });
        const callOrder: string[] = [];
        mockRequeueUserEventsForProvider.mockImplementation(() => {
            callOrder.push('requeue');
            return Promise.resolve();
        });
        mockRunPushForUser.mockImplementation(() => {
            callOrder.push('runPushForUser');
            return Promise.resolve();
        });

        await watchSyncManualTask.execute(ctx);

        expect(callOrder).toEqual(['requeue', 'runPushForUser']);
        expect(mockRequeueUserEventsForProvider).toHaveBeenCalledWith(ctx.sql, USER_ID, 'mal');
        expect(mockRunPushForUser).toHaveBeenCalledWith(
            USER_ID,
            'mal-watch-sync',
            expect.any(Function),
        );
        expect(mockResetPullCursor).not.toHaveBeenCalled();
        expect(mockRunPullForUser).not.toHaveBeenCalled();

        // The reporter passed to runPushForUser forwards to ctx.reportProgress.
        const reporter = mockRunPushForUser.mock.calls[0]![2] as (p: {
            processed: number;
            total?: number;
            currentItem?: string;
        }) => void;
        reporter({ processed: 3, total: 10, currentItem: 'foo' });
        expect(ctx.reportProgress).toHaveBeenCalledWith(3, 10, 'foo');
    });

    it('push direction with provider "trakt" targets pluginId "trakt-watch-sync"', async () => {
        const ctx = makeContext({ userId: USER_ID, provider: 'trakt', direction: 'push' });

        await watchSyncManualTask.execute(ctx);

        expect(mockRunPushForUser).toHaveBeenCalledWith(
            USER_ID,
            'trakt-watch-sync',
            expect.any(Function),
        );
    });

    it('pull direction: resets the cursor THEN calls runPullForUser with the plugin id, forwarding the reporter', async () => {
        const ctx = makeContext({ userId: USER_ID, provider: 'mal', direction: 'pull' });
        const callOrder: string[] = [];
        mockResetPullCursor.mockImplementation(() => {
            callOrder.push('resetCursor');
            return Promise.resolve();
        });
        mockRunPullForUser.mockImplementation(() => {
            callOrder.push('runPullForUser');
            return Promise.resolve();
        });

        await watchSyncManualTask.execute(ctx);

        expect(callOrder).toEqual(['resetCursor', 'runPullForUser']);
        expect(mockResetPullCursor).toHaveBeenCalledWith(ctx.sql, USER_ID, 'mal');
        expect(mockRunPullForUser).toHaveBeenCalledWith(
            USER_ID,
            'mal-watch-sync',
            expect.any(Function),
        );
        expect(mockRequeueUserEventsForProvider).not.toHaveBeenCalled();
        expect(mockRunPushForUser).not.toHaveBeenCalled();

        const reporter = mockRunPullForUser.mock.calls[0]![2] as (p: {
            processed: number;
            total?: number;
            currentItem?: string;
        }) => void;
        reporter({ processed: 7 });
        expect(ctx.reportProgress).toHaveBeenCalledWith(7, undefined, undefined);
    });

    it('short-circuits when ctx.signal is already aborted: no engine call, no query helper call', async () => {
        const ac = new AbortController();
        ac.abort();
        const ctx = makeContext(
            { userId: USER_ID, provider: 'trakt', direction: 'pull' },
            { signal: ac.signal, abortSignal: ac.signal },
        );

        const result = await watchSyncManualTask.execute(ctx);

        expect(mockRunPullForUser).not.toHaveBeenCalled();
        expect(mockRunPushForUser).not.toHaveBeenCalled();
        expect(mockResetPullCursor).not.toHaveBeenCalled();
        expect(mockRequeueUserEventsForProvider).not.toHaveBeenCalled();
        expect(result.stopReason).toBe('aborted');
        expect(result.success).toBe(true);
    });

    it('declares manualOnly + per-user identity + per-user exclusiveWith', () => {
        expect(watchSyncManualTask.manualOnly).toBe(true);
        expect(watchSyncManualTask.scope).toBe('user');
        expect(watchSyncManualTask.exclusiveWith).toMatchObject({ scope: 'user' });
        expect(
            watchSyncManualTask.identityFor({
                userId: USER_ID,
                provider: 'mal',
                direction: 'push',
            }),
        ).toBe(`${USER_ID}-mal-push`);
    });
});
