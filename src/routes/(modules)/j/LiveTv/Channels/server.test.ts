// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for /j/LiveTv/Channels paging semantics.
//
// jellyfin-androidtv's loadLiveTvChannels() sends NO Limit and NO StartIndex —
// it expects the full channel list in one response and pages client-side
// (TvManager.allChannels). A server-side default limit silently truncates the
// guide, which the user experiences as "load more channels does nothing".

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const { mockGetChannels, mockGetCategories, mockGetFavoriteChannelIds } = vi.hoisted(() => ({
    mockGetChannels: vi.fn(),
    mockGetCategories: vi.fn(),
    mockGetFavoriteChannelIds: vi.fn(),
}));

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/services/livetv/index', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({
        getChannels: mockGetChannels,
        getCategories: mockGetCategories,
    }),
}));

vi.mock('$lib/server/database', () => ({
    getDb: vi.fn(() => ({})),
}));

vi.mock('$lib/server/database/queries/livetv-channels.queries', () => ({
    getFavoriteChannelIds: mockGetFavoriteChannelIds,
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

import { GET } from './+server';

function makeChannels(count: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, i) => ({
        id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        name: `Channel ${i}`,
        sortOrder: i,
        images: {},
        currentProgram: undefined,
    }));
}

function makeEvent(query: string): RequestEvent {
    return {
        url: new URL(`https://example.test/j/LiveTv/Channels${query}`),
        locals: {
            user: {
                userId: '00000000-0000-0000-0000-000000000001',
                hasLiveTvPermission: true,
            },
        },
    } as unknown as RequestEvent;
}

async function callGet(query: string): Promise<{ Items: unknown[]; TotalRecordCount: number }> {
    const response = await (GET as unknown as (event: RequestEvent) => Promise<Response>)(
        makeEvent(query),
    );
    return (await response.json()) as { Items: unknown[]; TotalRecordCount: number };
}

describe('/j/LiveTv/Channels', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetCategories.mockResolvedValue([]);
        mockGetFavoriteChannelIds.mockResolvedValue([]);
    });

    it('returns every channel when the client sends no Limit (jellyfin-androidtv)', async () => {
        mockGetChannels.mockResolvedValue(makeChannels(1390));

        // The exact query jellyfin-androidtv 0.19.9 sends.
        const body = await callGet(
            '?sortBy=SortName&sortOrder=Ascending&enableFavoriteSorting=true&addCurrentProgram=true',
        );

        expect(body.TotalRecordCount).toBe(1390);
        expect(body.Items).toHaveLength(1390);
    });

    it('honours an explicit Limit above the old 500 cap', async () => {
        mockGetChannels.mockResolvedValue(makeChannels(1390));

        const body = await callGet('?Limit=800');

        expect(body.Items).toHaveLength(800);
        expect(body.TotalRecordCount).toBe(1390);
    });

    // sort_order restarts at 0 per category, so it repeats across the flat list a
    // Jellyfin client renders — the guide showed every number two or three times.
    it('never reuses a number when sortOrder values collide', async () => {
        const channels = makeChannels(30).map((channel, i) => ({
            ...channel,
            sortOrder: i % 10, // three categories' worth of colliding sort orders
        }));
        mockGetChannels.mockResolvedValue(channels);

        const body = await callGet('');

        const numbers = (body.Items as Array<{ Number: string }>).map((item) => item.Number);
        expect(numbers.slice(0, 3)).toEqual(['1', '2', '3']);
        expect(new Set(numbers).size).toBe(30);
    });

    it('keeps numbering continuous when the client pages with StartIndex', async () => {
        mockGetChannels.mockResolvedValue(makeChannels(1390));

        const body = await callGet('?StartIndex=1380&Limit=100');

        const numbers = (body.Items as Array<{ Number: string }>).map((item) => item.Number);
        expect(numbers[0]).toBe('1381');
        expect(numbers.at(-1)).toBe('1390');
    });

    it('marks favorite channels in UserData', async () => {
        const channels = makeChannels(2);
        mockGetChannels.mockResolvedValue(channels);
        mockGetFavoriteChannelIds.mockResolvedValue([channels[1].id]);

        const body = await callGet('');

        expect((body.Items[0] as { UserData: { IsFavorite: boolean } }).UserData.IsFavorite).toBe(
            false,
        );
        expect((body.Items[1] as { UserData: { IsFavorite: boolean } }).UserData.IsFavorite).toBe(
            true,
        );
    });

    it('blocks numbers per category and groups the list by category', async () => {
        mockGetCategories.mockResolvedValue([
            { id: 'sports', name: 'Sports', sortOrder: 0, isVisible: true },
            { id: 'free', name: 'Free TV', sortOrder: 1, isVisible: true },
        ]);
        // Interleaved, as getChannels() actually returns them (global sort_order).
        mockGetChannels.mockResolvedValue([
            { ...makeChannels(1)[0], id: 'f-0', categoryId: 'free', sortOrder: 0 },
            { ...makeChannels(1)[0], id: 's-0', categoryId: 'sports', sortOrder: 0 },
            { ...makeChannels(1)[0], id: 's-1', categoryId: 'sports', sortOrder: 1 },
        ]);

        const body = await callGet('');

        const items = body.Items as Array<{ Id: string; Number: string }>;
        expect(items.map((item) => item.Id)).toEqual(['s-0', 's-1', 'f-0']);
        expect(items.map((item) => item.Number)).toEqual(['1', '2', '200']);
    });

    // jellyfin-androidtv's "Favoriten an den Anfang setzen" (LiveTvPreferences
    // .favsAtTop) is a SERVER-side sort: the client just forwards it as
    // EnableFavoriteSorting=true and renders the response order verbatim. Ignoring
    // the flag left favorites scattered through the guide with the toggle on.
    it('puts favorites first when the client asks for EnableFavoriteSorting', async () => {
        const channels = makeChannels(5);
        mockGetChannels.mockResolvedValue(channels);
        mockGetFavoriteChannelIds.mockResolvedValue([channels[3].id, channels[1].id]);

        const body = await callGet(
            '?sortBy=SortName&sortOrder=Ascending&enableFavoriteSorting=true&addCurrentProgram=true',
        );

        const items = body.Items as Array<{ Id: string; Number: string }>;
        expect(items.map((item) => item.Id)).toEqual([
            channels[1].id,
            channels[3].id,
            channels[0].id,
            channels[2].id,
            channels[4].id,
        ]);
        // Favorites move, their channel numbers don't — the guide still reads
        // like the lineup it was numbered as.
        expect(items.map((item) => item.Number)).toEqual(['2', '4', '1', '3', '5']);
    });

    it('leaves the order alone when EnableFavoriteSorting is absent or false', async () => {
        const channels = makeChannels(4);
        mockGetChannels.mockResolvedValue(channels);
        mockGetFavoriteChannelIds.mockResolvedValue([channels[2].id]);

        for (const query of ['', '?enableFavoriteSorting=false']) {
            const body = await callGet(query);
            const items = body.Items as Array<{ Id: string }>;
            expect(items.map((item) => item.Id)).toEqual(channels.map((c) => c.id));
        }
    });

    // The sort has to happen before the slice, or a favorite past the page
    // boundary stays invisible however far the user scrolls.
    it('sorts favorites to the front before paging, not within the page', async () => {
        const channels = makeChannels(50);
        mockGetChannels.mockResolvedValue(channels);
        mockGetFavoriteChannelIds.mockResolvedValue([channels[47].id]);

        const body = await callGet('?enableFavoriteSorting=true&Limit=5');

        const items = body.Items as Array<{ Id: string }>;
        expect(items[0].Id).toBe(channels[47].id);
    });

    it('still pages with explicit StartIndex + Limit', async () => {
        mockGetChannels.mockResolvedValue(makeChannels(1390));

        const body = await callGet('?StartIndex=1380&Limit=100');

        expect(body.Items).toHaveLength(10);
        expect(body.TotalRecordCount).toBe(1390);
    });
});

describe('/j/LiveTv/Channels filters and sorting (Jellyfin GetLiveTvChannels)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetCategories.mockResolvedValue([]);
        mockGetFavoriteChannelIds.mockResolvedValue([]);
    });

    const ids = (body: { Items: unknown[] }): string[] =>
        (body.Items as Array<{ Id: string }>).map((item) => item.Id);

    it('IsFavorite=true/false', async () => {
        const channels = makeChannels(3);
        mockGetChannels.mockResolvedValue(channels);
        mockGetFavoriteChannelIds.mockResolvedValue([channels[1].id]);
        expect(ids(await callGet('?isFavorite=true'))).toEqual([channels[1].id]);
        expect(ids(await callGet('?isFavorite=false'))).toEqual([channels[0].id, channels[2].id]);
    });

    it('Type: only TV channels exist', async () => {
        mockGetChannels.mockResolvedValue(makeChannels(2));
        expect(await callGet('?type=Radio')).toMatchObject({ Items: [], TotalRecordCount: 0 });
        expect((await callGet('?type=TV')).Items).toHaveLength(2);
    });

    it('IsLiked / IsDisliked: no channel is liked or disliked', async () => {
        mockGetChannels.mockResolvedValue(makeChannels(2));
        expect((await callGet('?isLiked=true')).Items).toHaveLength(0);
        expect((await callGet('?isLiked=false')).Items).toHaveLength(2);
        expect((await callGet('?isDisliked=true')).Items).toHaveLength(0);
    });

    it('content flags follow the channel category', async () => {
        const [a, b] = makeChannels(2);
        mockGetChannels.mockResolvedValue([
            { ...a, category: 'Movies' },
            { ...b, category: 'Sport' },
        ]);
        expect(ids(await callGet('?isMovie=true'))).toEqual([a.id]);
        expect(ids(await callGet('?isSports=true'))).toEqual([b.id]);
        expect(ids(await callGet('?isKids=true'))).toEqual([]);
    });

    it('SortBy=Name sorts alphabetically, SortName keeps the numbered lineup, Descending reverses', async () => {
        const channels = makeChannels(3).map((c, i) => ({
            ...c,
            id: String(c.id),
            name: ['Zed', 'Alpha', 'Mid'][i],
        }));
        mockGetChannels.mockResolvedValue(channels);
        expect(ids(await callGet('?sortBy=Name'))).toEqual([
            channels[1].id,
            channels[2].id,
            channels[0].id,
        ]);
        expect(ids(await callGet('?sortBy=SortName'))).toEqual(channels.map((c) => c.id));
        expect(ids(await callGet('?sortBy=SortName&sortOrder=Descending'))).toEqual(
            channels.map((c) => c.id).reverse(),
        );
    });

    it('AddCurrentProgram=false drops CurrentProgram', async () => {
        const [channel] = makeChannels(1);
        mockGetChannels.mockResolvedValue([
            {
                ...channel,
                currentProgram: {
                    id: 'p',
                    channelId: channel.id,
                    title: 'Now',
                    startTime: new Date(Date.now() - 60_000).toISOString(),
                    endTime: new Date(Date.now() + 60_000).toISOString(),
                },
            },
        ]);
        const withProgram = (await callGet('')).Items[0] as Record<string, unknown>;
        expect(withProgram.CurrentProgram).toBeDefined();
        const without = (await callGet('?addCurrentProgram=false')).Items[0] as Record<
            string,
            unknown
        >;
        expect(without).not.toHaveProperty('CurrentProgram');
    });

    it('returns an empty result without Live TV permission', async () => {
        mockGetChannels.mockResolvedValue(makeChannels(2));
        const event = {
            url: new URL('https://example.test/j/LiveTv/Channels'),
            locals: { user: { userId: 'u', hasLiveTvPermission: false } },
        } as unknown as RequestEvent;
        const res = await (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
        expect(await res.json()).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    });
});
