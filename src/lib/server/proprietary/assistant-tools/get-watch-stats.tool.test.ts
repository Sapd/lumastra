// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `get_watch_stats` assistant tool.
 *
 * Mocks the backing query module — no real DB, no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toUserId } from '$lib/shared/user-id.js';
import { getWatchStatsTool } from './get-watch-stats.tool.js';
import type { AssistantToolContext } from './types.js';

vi.mock('../../database/queries/user-watch-history.queries.js', () => ({
    getWatchedCount: { one: vi.fn() },
    getWatchedMovieCount: { one: vi.fn() },
    getWatchedTvCount: { one: vi.fn() },
}));

import {
    getWatchedCount,
    getWatchedMovieCount,
    getWatchedTvCount,
} from '../../database/queries/user-watch-history.queries.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: toUserId(randomUUID()),
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: ['g1'],
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

describe('getWatchStatsTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns total watched count when no mediaType filter is provided', async () => {
        vi.mocked(getWatchedCount.one).mockResolvedValue({ count: 42 });

        const result = await getWatchStatsTool.execute({}, makeCtx());

        expect(result.media).toBeUndefined();

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.watchedCount).toBe(42);
        expect(summary.mediaType).toBe('all');

        expect(getWatchedCount.one).toHaveBeenCalledTimes(1);
        expect(getWatchedMovieCount.one).not.toHaveBeenCalled();
        expect(getWatchedTvCount.one).not.toHaveBeenCalled();
    });

    it('returns movie count and calls the movie query', async () => {
        vi.mocked(getWatchedMovieCount.one).mockResolvedValue({ count: 10 });

        const ctx = makeCtx();
        const result = await getWatchStatsTool.execute({ mediaType: 'movie' }, ctx);

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.watchedCount).toBe(10);
        expect(summary.mediaType).toBe('movie');

        expect(getWatchedMovieCount.one).toHaveBeenCalledTimes(1);
        expect(getWatchedMovieCount.one).toHaveBeenCalledWith(expect.anything(), {
            userId: ctx.userId,
            // Explicitly unrestricted: these count queries cannot bind the
            // access predicates, so ctx.accessCtx must NOT be threaded here.
            access: { library: { kind: 'all' }, age: { kind: 'any' } },
        });
        expect(getWatchedCount.one).not.toHaveBeenCalled();
        expect(getWatchedTvCount.one).not.toHaveBeenCalled();
    });

    it('falls back to 0 when the backing query returns null', async () => {
        vi.mocked(getWatchedCount.one).mockResolvedValue(null);

        const result = await getWatchStatsTool.execute({}, makeCtx());

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.watchedCount).toBe(0);
        expect(summary.mediaType).toBe('all');
    });
});
