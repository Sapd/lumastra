// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `get_my_stats` assistant tool.
 *
 * The tool must NOT reimplement stat queries — it delegates to the shared
 * personalStatsService.getAllStats fan-out, which is mocked here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMyStatsTool } from './get-my-stats.tool.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { AssistantToolContext } from './types.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');

vi.mock('../../services/personal-stats.service.js', () => ({
    personalStatsService: { getAllStats: vi.fn() },
}));
vi.mock('../../cache/index.js', () => ({
    cacheManager: { for: vi.fn(() => ({})) },
    CACHE_NAMESPACES: { personalStats: {} },
}));
vi.mock('../../config.js', () => ({
    features: { personalStats: true },
}));

import { personalStatsService } from '../../services/personal-stats.service.js';
import { features } from '../../config.js';
import type { SearchAccessContext } from '../../utils/search-access-context.js';
import { assistantTestUser } from './test-context.js';

const DENIED_GROUP = '11111111-1111-4111-8111-111111111111';

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: ALICE,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

describe('getMyStatsTool', () => {
    // Observed on prod: "170 verschiedene Titel. 95 davon hast du abgeschlossen,
    // 176 abgebrochen" — 95 + 176 = 271, which cannot be "of" 170. The data was
    // right and the LABELS were wrong: uniqueContent is COUNT(DISTINCT media_id)
    // while completedCount/abandonedCount/moviesWatched are COUNT(*), i.e.
    // sessions. Names like "Completed content count" invited the conflation, so
    // the model-facing payload names the unit.
    it('names the unit on every overview counter so sessions cannot be read as titles', async () => {
        vi.mocked(personalStatsService.getAllStats).mockResolvedValue({
            period: 'year:2026',
            sessionCount: 271,
            stats: {
                overview: {
                    totalSessions: 271,
                    uniqueContent: 170,
                    completedCount: 95,
                    abandonedCount: 176,
                    moviesWatched: 69,
                    episodesWatched: 198,
                    totalWatchTimeFormatted: '4d 10h 50m',
                },
            },
        } as unknown as Awaited<ReturnType<typeof personalStatsService.getAllStats>>);

        const body = JSON.parse(
            (await getMyStatsTool.execute({ period: 'year:2026' }, makeCtx())).summaryForModel,
        );
        const overview = body.stats.overview;

        // Session-scoped counters say so in their name...
        expect(overview.completedSessions).toBe(95);
        expect(overview.abandonedSessions).toBe(176);
        expect(overview.movieSessions).toBe(69);
        expect(overview.episodeSessions).toBe(198);
        // ...and the one title-scoped number says that.
        expect(overview.distinctTitles).toBe(170);

        // The misleading originals must be GONE, not merely supplemented.
        expect(overview.completedCount).toBeUndefined();
        expect(overview.uniqueContent).toBeUndefined();
        expect(overview.moviesWatched).toBeUndefined();

        expect(body.stats.overview.countScopeNote).toMatch(/session/i);
    });
    beforeEach(() => {
        vi.clearAllMocks();
        (features as { personalStats: boolean }).personalStats = true;
    });

    it('delegates to getAllStats with the requested period', async () => {
        vi.mocked(personalStatsService.getAllStats).mockResolvedValue({
            period: '30d',
            sessionCount: 120,
            stats: { overview: { totalSessions: 120 } },
        } as unknown as Awaited<ReturnType<typeof personalStatsService.getAllStats>>);

        const result = await getMyStatsTool.execute({ period: '30d' }, makeCtx());

        const call = vi.mocked(personalStatsService.getAllStats).mock.calls[0];
        expect(call[0]).toBe(ALICE); // user scope
        expect(call[1]).toBe('30d'); // period
        expect(call[2]).toBe('personalStats'); // cache prefix (same as /all route)

        const d = JSON.parse(result.summaryForModel);
        expect(d.available).toBe(true);
        expect(d.sessionCount).toBe(120);
        // Renamed for the model: this counter is SESSIONS, and the old name did
        // not say so — see the denominator test above.
        expect(d.stats.overview.viewingSessions).toBe(120);
    });

    it('defaults the period to "all"', async () => {
        vi.mocked(personalStatsService.getAllStats).mockResolvedValue({
            period: 'all',
            sessionCount: 5,
            stats: {},
        } as unknown as Awaited<ReturnType<typeof personalStatsService.getAllStats>>);

        await getMyStatsTool.execute({}, makeCtx());
        expect(vi.mocked(personalStatsService.getAllStats).mock.calls[0][1]).toBe('all');
    });

    it("threads the caller's access boundary into the fan-out", async () => {
        // Regression: this call previously passed NO access argument, so
        // getAllStats computed completion / records / top-titles UNFILTERED and
        // — the fingerprint being empty — cached them under the same
        // un-fingerprinted key the /api/my-stats/all route reads WITH a
        // fingerprint, in the same 'personalStats' namespace. A restricted user
        // who asked the assistant for their stats got restricted titles read
        // back to them and cached for the full TTL.
        vi.mocked(personalStatsService.getAllStats).mockResolvedValue({
            period: 'all',
            sessionCount: 5,
            stats: {},
        } as unknown as Awaited<ReturnType<typeof personalStatsService.getAllStats>>);

        const ctx = makeCtx();
        (ctx as { accessCtx: SearchAccessContext }).accessCtx = {
            username: 'alice',
            deniedGroupIds: [DENIED_GROUP],
            ageRating: { maxAgeRating: 12, allowUnrated: false },
            liveTvAllowed: false,
            showUnavailableMedia: false,
        };

        await getMyStatsTool.execute({}, ctx);

        expect(vi.mocked(personalStatsService.getAllStats).mock.calls[0][4]).toEqual({
            library: { kind: 'denyGroups', ids: [DENIED_GROUP] },
            age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
        });
    });

    it('passes an unrestricted boundary through unchanged', async () => {
        // The permissive case must still be EXPLICIT rather than absent — an
        // unrestricted boundary is what keeps the un-fingerprinted cache key,
        // so it has to arrive as a value, not as a missing argument.
        vi.mocked(personalStatsService.getAllStats).mockResolvedValue({
            period: 'all',
            sessionCount: 5,
            stats: {},
        } as unknown as Awaited<ReturnType<typeof personalStatsService.getAllStats>>);

        await getMyStatsTool.execute({}, makeCtx());

        expect(vi.mocked(personalStatsService.getAllStats).mock.calls[0][4]).toEqual({
            library: { kind: 'all' },
            age: { kind: 'any' },
        });
    });

    it('reports unavailable when personal stats are disabled', async () => {
        (features as { personalStats: boolean }).personalStats = false;
        const result = await getMyStatsTool.execute({}, makeCtx());
        expect(JSON.parse(result.summaryForModel).available).toBe(false);
        expect(personalStatsService.getAllStats).not.toHaveBeenCalled();
    });
});
