// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `whats_on_tv` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { whatsOnTvTool } from './whats-on-tv.tool.js';
import type { AssistantToolContext } from './types.js';
import { toUserId } from '$lib/shared/user-id.js';

const TEST_USER_ID = toUserId('00000000-0000-0000-0000-000000000001');
import type {
    ChannelSearchRow,
    ChannelRow,
} from '../../database/queries/livetv-channels.queries.js';
import type { ProgramRow } from '../../database/queries/livetv-programs.queries.js';

vi.mock('../../database/queries/livetv-channels.queries.js', () => ({
    searchChannels: vi.fn(),
    getAllVisibleChannels: vi.fn(),
}));
vi.mock('../../database/queries/livetv-programs.queries.js', () => ({
    getCurrentProgram: vi.fn(),
    getProgramsByDateRange: vi.fn(),
    getCurrentProgramsForAllChannels: vi.fn(),
}));

import {
    searchChannels,
    getAllVisibleChannels,
} from '../../database/queries/livetv-channels.queries.js';
import {
    getCurrentProgram,
    getProgramsByDateRange,
    getCurrentProgramsForAllChannels,
} from '../../database/queries/livetv-programs.queries.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(liveTvAllowed = true): AssistantToolContext {
    return {
        sql: {} as never,
        userId: TEST_USER_ID,
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

const kwf = {
    id: 'chan-kwf',
    name: 'KWF',
} as unknown as ChannelSearchRow;

function prog(title: string, startOffsetMin: number): ProgramRow {
    const start = new Date(Date.now() + startOffsetMin * 60_000);
    return {
        id: `p-${title}`,
        channel_id: 'chan-kwf',
        title,
        description: null,
        start_time: start,
        end_time: new Date(start.getTime() + 30 * 60_000),
        epg_id: null,
        genres: null,
        official_rating: null,
        source_id: null,
    };
}

describe('whatsOnTvTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns now + next for a named channel', async () => {
        vi.mocked(searchChannels).mockResolvedValue([kwf]);
        vi.mocked(getCurrentProgram).mockResolvedValue(prog('Abendblick', -5));
        vi.mocked(getProgramsByDateRange).mockResolvedValue([
            prog('Abendblick', -5), // already started — filtered out of "next"
            prog('Hafenkrimi', 25),
            prog('Abendblick spezial', 90),
        ]);

        const result = await whatsOnTvTool.execute({ channel: 'KWF' }, makeCtx());
        const d = JSON.parse(result.summaryForModel);
        expect(d.available).toBe(true);
        expect(d.found).toBe(true);
        expect(d.channel).toBe('KWF');
        expect(d.now.title).toBe('Abendblick');
        expect(d.next.map((p: { title: string }) => p.title)).toEqual([
            'Hafenkrimi',
            'Abendblick spezial',
        ]);
    });

    it('reports not-found when the channel does not resolve', async () => {
        vi.mocked(searchChannels).mockResolvedValue([]);
        const result = await whatsOnTvTool.execute({ channel: 'Nope' }, makeCtx());
        const d = JSON.parse(result.summaryForModel);
        expect(d.found).toBe(false);
    });

    it('lists only visible channels in the all-channels overview', async () => {
        vi.mocked(getAllVisibleChannels).mockResolvedValue([
            { id: 'chan-kwf', name: 'KWF' } as unknown as ChannelRow,
        ]);
        vi.mocked(getCurrentProgramsForAllChannels).mockResolvedValue([
            prog('Abendblick', -5),
            {
                ...prog('hidden show', -5),
                channel_id: 'chan-hidden',
            },
        ]);

        const result = await whatsOnTvTool.execute({}, makeCtx());
        const d = JSON.parse(result.summaryForModel);
        expect(d.onNow).toHaveLength(1);
        expect(d.onNow[0].channel).toBe('KWF');
        // Hidden-channel programs are dropped, but that is NOT truncation:
        // only 1 visible program, well under the cap.
        expect(d.truncated).toBe(false);
    });

    it('refuses when Live TV is not allowed', async () => {
        const result = await whatsOnTvTool.execute({ channel: 'KWF' }, makeCtx(false));
        expect(JSON.parse(result.summaryForModel).available).toBe(false);
        expect(searchChannels).not.toHaveBeenCalled();
    });
});
