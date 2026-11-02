// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSurfaceMix = vi.fn();
const getSummary = vi.fn();
const getDeviceMix = vi.fn();

vi.mock('$lib/server/database/queries/admin-stats.queries.js', () => ({
    getSurfaceMix,
    getSummary,
    getDeviceMix,
    getTopMovies: vi.fn(),
    getTopTVShows: vi.fn(),
    getActivityStats: vi.fn(),
    getTopUsers: vi.fn(),
    getActiveUsers: vi.fn(),
    getGenreBreakdown: vi.fn(),
    getContentFreshness: vi.fn(),
    getDayHours: vi.fn(),
    getColdContent: vi.fn(),
    getCompletionLeaderboard: vi.fn(),
    getDormantUsers: vi.fn(),
}));
vi.mock('$lib/server/tasks/builtin/native/database-cleanup.js', () => ({
    PLAY_SESSION_RETENTION_DAYS: 90,
}));

const { fetchAdminStats } = await import('./admin-stats.service.js');
const { def } = await import('../api/defs/watch-stats/index.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sql = {} as any;
const base = {
    timeframe: 'AllTime' as const,
    limit: 10,
    sort: 'cold' as const,
    day: '',
    daySegment: '-',
};

describe('fetchAdminStats — surface-mix dispatch', () => {
    beforeEach(() => vi.clearAllMocks());

    it('routes surface-mix to getSurfaceMix, not the summary fallback', async () => {
        // The switch ends in `default: getSummary`, so a mismatch between the
        // endpoint's zod enum and the case label would not throw — it would
        // quietly serve summary data under a surface-mix key. That is the bug
        // this test exists for.
        getSurfaceMix.mockResolvedValue({ segments: [] });

        await fetchAdminStats(sql, { ...base, type: 'surface-mix' });

        expect(getSurfaceMix).toHaveBeenCalledOnce();
        expect(getSummary).not.toHaveBeenCalled();
    });

    it('asks for exactly the window the cleanup task retains', async () => {
        // Advertising a wider window than pruning keeps would show a falling-off
        // cliff at the tail and read as a decline in usage.
        getSurfaceMix.mockResolvedValue({ segments: [] });

        await fetchAdminStats(sql, { ...base, type: 'surface-mix' });

        expect(getSurfaceMix).toHaveBeenCalledWith(sql, 90);
    });

    it('is accepted by the endpoint query schema', async () => {
        // Pins the two strings together from the other side: the service case
        // label is unreachable unless the endpoint enum admits the same value.
        const parsed = def.request?.query?.parse({ type: 'surface-mix' });
        expect(parsed).toMatchObject({ type: 'surface-mix' });
    });
});
