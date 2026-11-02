// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * play-session-cleanup task tests.
 * Verifies ctx.sql is used (not aiDbService), happy-path count, and
 * pre-execution abort guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

const { reapStaleSessions } = vi.hoisted(() => ({
    reapStaleSessions: vi.fn(),
}));

vi.mock('../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

vi.mock('$lib/server/services/play-sessions.service.js', () => ({
    reapStaleSessions,
}));

import { playSessionCleanupTask } from './play-session-cleanup.js';

type PlaySessionCleanupInput = Record<string, unknown>;

function makeContext(
    overrides: Partial<TaskContext<PlaySessionCleanupInput>> = {},
): TaskContext<PlaySessionCleanupInput> {
    const ac = new AbortController();
    return {
        sql: { tag: 'ctx-sql' } as never,
        logger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        input: {},
        reportProgress: vi.fn(),
        ...overrides,
    } as unknown as TaskContext<PlaySessionCleanupInput>;
}

describe('play-session-cleanup task', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses ctx.sql when calling reapStaleSessions', async () => {
        reapStaleSessions.mockResolvedValue({ crashed: 3, completed: 0 });
        const ctx = makeContext();
        const result = await playSessionCleanupTask.execute(ctx);

        expect(reapStaleSessions).toHaveBeenCalledWith(ctx.sql);
        expect(result.itemsProcessed).toBe(3);
        expect(result.result?.message).toContain('Marked 3');
    });

    it('returns aborted result without calling reapStaleSessions when signal is pre-aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const result = await playSessionCleanupTask.execute(makeContext({ signal: ac.signal }));

        expect(reapStaleSessions).not.toHaveBeenCalled();
        expect(result.stopReason).toBe('aborted');
        expect(result.result?.message).toContain('Aborted');
    });

    it('returns zero itemsProcessed and correct message when no stale sessions', async () => {
        reapStaleSessions.mockResolvedValue({ crashed: 0, completed: 0 });
        const result = await playSessionCleanupTask.execute(makeContext());

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(result.result?.message).toContain('No stale play sessions');
    });

    it('logs a separate message when candidates were finalized as COMPLETED instead of crashed', async () => {
        reapStaleSessions.mockResolvedValue({ crashed: 1, completed: 2 });
        const ctx = makeContext();
        await playSessionCleanupTask.execute(ctx);

        expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('Finalized 2'));
    });
});
