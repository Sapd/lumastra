// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Vitest hoists vi.mock(...) calls above all other top-level statements, so a
// factory that reads an outer `const` directly hits a TDZ error even with the
// "mock" name prefix. Sibling def tests (e.g. music/text-search.test.ts) work
// around this by wrapping the mock fn in a lambda that only reads the outer
// binding lazily, at call time — mirrored here.
const mockRun = vi.fn().mockResolvedValue({ musicState: 3 });
const mockCheckRateLimit = vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 4, resetAt: 0, total: 5 });

vi.mock('$lib/server/services/user-data-reset.service.js', () => ({
    userDataResetManager: {
        run: (...args: unknown[]) => mockRun(...args),
    },
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

import { def } from './data-reset.js';

function ctx(body: unknown) {
    return { input: { body } } as never;
}
function event(userId: string | undefined) {
    return {
        locals: {
            user: userId ? { userId } : undefined,
            principal: userId ? { kind: 'session', userId } : undefined,
        },
    } as never;
}

describe('POST /api/user/data/reset', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects a destructive action without confirm', async () => {
        const res = await def.handlers.POST!(event('u1'), ctx({ action: 'music-history' }));
        // ApiProblem.validationFailed() maps to 422 per STATUS_FOR_CODE in problem.ts
        // (confirmed against mount.ts's own `problem('validation_failed', ...)` call) —
        // the brief's draft expected 400, which no ApiProblem.* helper in this codebase
        // produces for validation_failed.
        expect(res.status).toBe(422);
        expect(mockRun).not.toHaveBeenCalled();
    });

    it('runs a destructive action when confirmed', async () => {
        const res = await def.handlers.POST!(
            event('u1'),
            ctx({ action: 'music-history', confirm: true }),
        );
        expect(mockRun).toHaveBeenCalledWith('u1', 'music-history');
        const json = await res.json();
        expect(json).toMatchObject({ action: 'music-history', cleared: { musicState: 3 } });
    });

    it('runs a one-click action without confirm', async () => {
        await def.handlers.POST!(event('u1'), ctx({ action: 'music-recs' }));
        expect(mockRun).toHaveBeenCalledWith('u1', 'music-recs');
    });

    it('401 without a user', async () => {
        const res = await def.handlers.POST!(event(undefined), ctx({ action: 'music-recs' }));
        expect(res.status).toBe(401);
    });
});
