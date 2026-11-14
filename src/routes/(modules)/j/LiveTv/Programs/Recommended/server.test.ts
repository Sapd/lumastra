// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetChannels, mockGetGuidePrograms } = vi.hoisted(() => ({
    mockGetChannels: vi.fn(),
    mockGetGuidePrograms: vi.fn(),
}));

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/services/livetv/index', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({
        getChannels: mockGetChannels,
        getGuidePrograms: mockGetGuidePrograms,
    }),
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { GET } from './+server';

const NEWS = '11111111-1111-1111-1111-111111111111';
const MOVIES = '22222222-2222-2222-2222-222222222222';

function program(channelId: string, id: string, offsetMin: number, durationMin = 60): unknown {
    const start = new Date(Date.now() + offsetMin * 60_000);
    return {
        id,
        channelId,
        title: id,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + durationMin * 60_000).toISOString(),
        genres: [],
    };
}

async function call(
    query: string,
    hasLiveTvPermission = true,
): Promise<{
    Items: Array<Record<string, unknown>>;
    TotalRecordCount: number;
    StartIndex: number;
}> {
    const event = {
        url: new URL(`https://x.test/j/LiveTv/Programs/Recommended${query}`),
        locals: { user: { userId: 'u', hasLiveTvPermission } },
    } as unknown as RequestEvent;
    const res = await (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
    return res.json();
}

describe('GET /j/LiveTv/Programs/Recommended', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetChannels.mockResolvedValue([
            { id: NEWS, name: 'News', sortOrder: 1, images: {}, category: 'News' },
            { id: MOVIES, name: 'Movies', sortOrder: 0, images: {}, category: 'Movies' },
        ]);
        mockGetGuidePrograms.mockResolvedValue({
            [NEWS]: [program(NEWS, 'news-now', -10), program(NEWS, 'news-later', 50)],
            [MOVIES]: [program(MOVIES, 'movie-now', -20), program(MOVIES, 'movie-later', 40)],
        });
    });

    it('IsAiring=true: what is on now, in channel order', async () => {
        const body = await call('?isAiring=true');
        expect(body.Items.map((i) => i.Id)).toEqual(['movie-now', 'news-now']);
        expect(body.TotalRecordCount).toBe(2);
    });

    it('IsAiring=true honours the content flags', async () => {
        const body = await call('?isAiring=true&isMovie=true');
        expect(body.Items.map((i) => i.Id)).toEqual(['movie-now']);
    });

    it('without IsAiring it is a plain program query ordered by start (Jellyfin)', async () => {
        const body = await call('?hasAired=false&isMovie=true');
        expect(body.Items.map((i) => i.Id)).toEqual(['movie-now', 'movie-later']);
    });

    it('pages with StartIndex/Limit and EnableTotalRecordCount', async () => {
        const body = await call(
            '?hasAired=false&startIndex=1&limit=2&enableTotalRecordCount=false',
        );
        expect(body.Items.map((i) => i.Id)).toEqual(['news-now', 'movie-later']);
        expect(body.StartIndex).toBe(1);
        expect(body.TotalRecordCount).toBe(2);
    });

    it('synthesizes one entry per channel when no EPG is airing', async () => {
        mockGetGuidePrograms.mockResolvedValue({});
        const body = await call('?isAiring=true');
        expect(body.Items.map((i) => i.Id)).toEqual([`${NEWS}-live`, `${MOVIES}-live`]);
        const movies = await call('?isAiring=true&isMovie=true');
        expect(movies.Items.map((i) => i.Id)).toEqual([`${MOVIES}-live`]);
    });

    it('returns an empty result without Live TV permission', async () => {
        const body = await call('?isAiring=true', false);
        expect(body).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
        expect(mockGetChannels).not.toHaveBeenCalled();
    });
});
