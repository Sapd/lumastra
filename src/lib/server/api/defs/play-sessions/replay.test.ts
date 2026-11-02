// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sql: vi.fn(), rate: vi.fn(), batch: vi.fn() }));
vi.mock('$lib/server/services/database.service.js', () => ({ aiDbService: { getSql: mocks.sql } }));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: mocks.rate,
    rateLimitHeaders: () => ({}),
}));
vi.mock('$lib/server/services/music/play-end-batch.service.js', () => ({
    processReplayBatch: mocks.batch,
}));
import { def } from './replay.js';
function invoke(body: unknown, authenticated = true) {
    return def.handlers.POST!(
        {
            locals: { user: authenticated ? { userId: 'listener' } : undefined },
            request: new Request('http://localhost/api/play-sessions/replay', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
        } as never,
        {} as never,
    );
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockResolvedValue({});
    mocks.rate.mockResolvedValue({ allowed: true, resetAt: Date.now() / 1000 + 60 });
    mocks.batch.mockResolvedValue({
        results: [],
        summary: { recorded: 0, duplicate: 0, rejected: 0 },
    });
});
describe('POST /play-sessions/replay', () => {
    it('returns 401 without a user', async () => {
        expect((await invoke({ items: [null] }, false)).status).toBe(401);
        expect(mocks.batch).not.toHaveBeenCalled();
    });
    it.each([null, {}, { items: [] }, { items: Array(101).fill(null) }])(
        'returns 422 for an invalid envelope: %j',
        async (body) => {
            expect((await invoke(body)).status).toBe(422);
            expect(mocks.batch).not.toHaveBeenCalled();
        },
    );
    it('returns 429 using its own request budget', async () => {
        mocks.rate.mockResolvedValue({ allowed: false, resetAt: Date.now() / 1000 + 60 });
        expect((await invoke({ items: [null] })).status).toBe(429);
        expect(mocks.rate).toHaveBeenCalledWith('play-sessions:replay:listener', 60, 3600);
        expect(mocks.batch).not.toHaveBeenCalled();
    });
    it('degrades to computed results when response parsing fails after writes', async () => {
        const computed = { results: [], summary: { recorded: 1, duplicate: 0, rejected: 0 } };
        mocks.batch.mockResolvedValue(computed);
        const { ReplayResponseSchema } = await import('$lib/schemas/play-session-replay.js');
        const parse = vi
            .spyOn(ReplayResponseSchema, 'safeParse')
            .mockReturnValueOnce({ success: false } as never);
        try {
            const response = await invoke({ items: [null] });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(computed);
        } finally {
            parse.mockRestore();
        }
    });
});
