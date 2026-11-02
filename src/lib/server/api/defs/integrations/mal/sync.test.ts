// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

const startRunMock = vi.fn();
const getMalLinkStatusMock = vi.fn();
const checkRateLimitMock = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/mal-credentials.queries.js', () => ({
    getMalLinkStatus: (...args: unknown[]) => getMalLinkStatusMock(...args),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: (...args: unknown[]) => startRunMock(...args) },
}));

import { malSyncDef } from './sync.js';

const user = { username: 'u', userId: 'user-1' };
const event = { locals: { user } } as never;

function makeCtx(direction: 'pull' | 'push'): never {
    return { input: { body: { direction } } } as never;
}

beforeEach(() => {
    startRunMock.mockReset();
    getMalLinkStatusMock.mockReset();
    checkRateLimitMock.mockReset();
    checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 4, resetAt: 0, total: 5 });
    getMalLinkStatusMock.mockResolvedValue({ providerUsername: 'me', createdAt: new Date() });
});

describe('mal sync def', () => {
    it('401s without a user', async () => {
        const res = await malSyncDef.handlers.POST!({ locals: {} } as never, makeCtx('pull'));
        expect(res.status).toBe(401);
    });

    it('404s when MAL is not linked', async () => {
        getMalLinkStatusMock.mockResolvedValue(null);
        const res = await malSyncDef.handlers.POST!(event, makeCtx('pull'));
        expect(res.status).toBe(404);
        expect(startRunMock).not.toHaveBeenCalled();
    });

    it('429s when the rate limit is exceeded', async () => {
        checkRateLimitMock.mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: Math.floor(Date.now() / 1000) + 30,
            total: 5,
        });
        const res = await malSyncDef.handlers.POST!(event, makeCtx('pull'));
        expect(res.status).toBe(429);
        expect(getMalLinkStatusMock).not.toHaveBeenCalled();
    });

    it('returns 202 with the new run for a fresh start', async () => {
        startRunMock.mockResolvedValue({ runId: 'run-1', deduped: false });
        const res = await malSyncDef.handlers.POST!(event, makeCtx('pull'));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ runId: 'run-1', deduped: false });
        expect(startRunMock).toHaveBeenCalledWith(
            'watch-sync-manual',
            { userId: 'user-1', provider: 'mal', direction: 'pull' },
            expect.objectContaining({
                userId: 'user-1',
                idempotencyKey: 'user-1-mal-pull',
                trigger: expect.objectContaining({ kind: 'manual', by: 'user-1' }),
            }),
        );
    });

    it('returns 200 when an in-flight run is deduped instead of started', async () => {
        startRunMock.mockResolvedValue({ runId: 'run-1', deduped: true });
        const res = await malSyncDef.handlers.POST!(event, makeCtx('push'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ runId: 'run-1', deduped: true });
    });
});
