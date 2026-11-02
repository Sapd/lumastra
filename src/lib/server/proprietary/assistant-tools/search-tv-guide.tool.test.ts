// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `search_tv_guide` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchTvGuideTool } from './search-tv-guide.tool.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { AssistantToolContext } from './types.js';
import type { GroupedProgramRow } from '../../database/queries/livetv-programs.queries.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');

vi.mock('../../database/queries/livetv-programs.queries.js', () => ({
    searchProgramsByTextGrouped: vi.fn(),
}));

import { searchProgramsByTextGrouped } from '../../database/queries/livetv-programs.queries.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(liveTvAllowed = true): AssistantToolContext {
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
            liveTvAllowed,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

const grouped: GroupedProgramRow[] = [
    {
        title: 'Topliga: Live',
        description: 'Spieltag',
        temporal_status: 'upcoming_today',
        start_time: '2026-06-07T18:30:00Z',
        end_time: '2026-06-07T20:30:00Z',
        channels: [
            { id: 'c1', name: 'Orb Sport', logo_url: null },
            { id: 'c2', name: 'ZAVO', logo_url: null },
        ],
    },
];

describe('searchTvGuideTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns matching guide programs with channels + status', async () => {
        vi.mocked(searchProgramsByTextGrouped).mockResolvedValue(grouped);
        const result = await searchTvGuideTool.execute({ query: 'Topliga' }, makeCtx());
        const d = JSON.parse(result.summaryForModel);
        expect(d.found).toBe(true);
        expect(d.programs[0].title).toBe('Topliga: Live');
        expect(d.programs[0].status).toBe('upcoming_today');
        expect(d.programs[0].channels).toEqual(['Orb Sport', 'ZAVO']);
    });

    it('reports empty when nothing matches', async () => {
        vi.mocked(searchProgramsByTextGrouped).mockResolvedValue([]);
        const result = await searchTvGuideTool.execute({ query: 'nope' }, makeCtx());
        expect(JSON.parse(result.summaryForModel).found).toBe(false);
    });

    it('refuses when Live TV is not allowed', async () => {
        const result = await searchTvGuideTool.execute({ query: 'Topliga' }, makeCtx(false));
        expect(JSON.parse(result.summaryForModel).available).toBe(false);
        expect(searchProgramsByTextGrouped).not.toHaveBeenCalled();
    });
});
