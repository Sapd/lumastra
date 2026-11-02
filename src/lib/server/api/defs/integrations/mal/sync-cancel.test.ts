// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cancelRunMock = vi.fn();
const assertRunOwnedByMock = vi.fn();
const checkRateLimitMock = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/watch-sync-run.queries.js', () => ({
    assertRunOwnedBy: (...args: unknown[]) => assertRunOwnedByMock(...args),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { cancelRun: (...args: unknown[]) => cancelRunMock(...args) },
}));

import { malSyncCancelDef } from './sync-cancel.js';

const user = { username: 'u', userId: 'user-1' };
const event = { locals: { user } } as never;
const ctx = { input: { body: { runId: 'run-1' } } } as never;

beforeEach(() => {
    cancelRunMock.mockReset();
    assertRunOwnedByMock.mockReset();
    checkRateLimitMock.mockReset();
    checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 9, resetAt: 0, total: 10 });
});

describe('mal sync-cancel def', () => {
    it('401s without a user', async () => {
        const res = await malSyncCancelDef.handlers.POST!({ locals: {} } as never, ctx);
        expect(res.status).toBe(401);
    });

    it('404s when the run is not owned by the caller (never calls cancelRun)', async () => {
        assertRunOwnedByMock.mockResolvedValue(false);
        const res = await malSyncCancelDef.handlers.POST!(event, ctx);
        expect(res.status).toBe(404);
        expect(cancelRunMock).not.toHaveBeenCalled();
    });

    it('cancels an owned run and returns 200 with the cancel result', async () => {
        assertRunOwnedByMock.mockResolvedValue(true);
        cancelRunMock.mockResolvedValue({ accepted: true });
        const res = await malSyncCancelDef.handlers.POST!(event, ctx);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ accepted: true });
        expect(cancelRunMock).toHaveBeenCalledWith('run-1', { reason: 'user-requested' });
    });

    it('429s when the rate limit is exceeded (never checks ownership)', async () => {
        checkRateLimitMock.mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: Math.floor(Date.now() / 1000) + 10,
            total: 10,
        });
        const res = await malSyncCancelDef.handlers.POST!(event, ctx);
        expect(res.status).toBe(429);
        expect(assertRunOwnedByMock).not.toHaveBeenCalled();
    });
});
