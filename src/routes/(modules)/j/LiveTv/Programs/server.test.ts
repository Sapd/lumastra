// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for /j/LiveTv/Programs channel filtering.
//
// jellyfin-androidtv's TvManager.fillChannelIds() returns early when the device
// has no last-played Live TV channel, leaving its channelIds[] array full of
// nulls. The guide then requests `channelIds=null&channelIds=null&...`, so a
// literal-minded server filter matches nothing and the EPG renders empty.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

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
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

import { GET, POST } from './+server';

const CHANNEL_A = '11111111-1111-1111-1111-111111111111';
const CHANNEL_B = '22222222-2222-2222-2222-222222222222';

function makeProgram(channelId: string, offsetMinutes: number): Record<string, unknown> {
    const start = new Date(Date.now() + offsetMinutes * 60_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    return {
        id: `${channelId}-${offsetMinutes}`,
        channelId,
        title: `Program ${offsetMinutes}`,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        description: null,
        genres: [],
    };
}

function makeEvent(query: string): RequestEvent {
    return {
        url: new URL(`https://example.test/j/LiveTv/Programs${query}`),
        locals: { user: { hasLiveTvPermission: true } },
    } as unknown as RequestEvent;
}

async function callGet(query: string): Promise<{
    Items: Array<Record<string, unknown>>;
    TotalRecordCount: number;
}> {
    const response = await (GET as unknown as (event: RequestEvent) => Promise<Response>)(
        makeEvent(query),
    );
    return (await response.json()) as {
        Items: Array<Record<string, unknown>>;
        TotalRecordCount: number;
    };
}

function makePostEvent(body: unknown): RequestEvent {
    return {
        url: new URL('https://example.test/j/LiveTv/Programs'),
        request: new Request('http://localhost/test', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
        locals: { user: { hasLiveTvPermission: true } },
    } as unknown as RequestEvent;
}

async function callPost(body: unknown): Promise<{
    Items: Array<Record<string, unknown>>;
    TotalRecordCount: number;
}> {
    const response = await (POST as unknown as (event: RequestEvent) => Promise<Response>)(
        makePostEvent(body),
    );
    return (await response.json()) as {
        Items: Array<Record<string, unknown>>;
        TotalRecordCount: number;
    };
}

describe('/j/LiveTv/Programs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetChannels.mockResolvedValue([
            { id: CHANNEL_A, name: 'Channel A', sortOrder: 1, images: {} },
            { id: CHANNEL_B, name: 'Channel B', sortOrder: 2, images: {} },
        ]);
        mockGetGuidePrograms.mockResolvedValue({
            [CHANNEL_A]: [makeProgram(CHANNEL_A, 10)],
            [CHANNEL_B]: [makeProgram(CHANNEL_B, 20)],
        });
    });

    it('falls back to all channels when every ChannelIds value is the literal "null"', async () => {
        const body = await callGet('?channelIds=null&channelIds=null&sortBy=StartDate');

        expect(body.Items).toHaveLength(2);
        expect(body.Items.map((item) => item.ChannelId).sort()).toEqual([CHANNEL_A, CHANNEL_B]);
    });

    it('still filters normally when real channel ids are supplied', async () => {
        const body = await callGet(`?channelIds=${CHANNEL_A}`);

        expect(body.Items).toHaveLength(1);
        expect(body.Items[0].ChannelId).toBe(CHANNEL_A);
    });

    it('ignores stray "null" entries mixed in with real channel ids', async () => {
        const body = await callGet(`?channelIds=null&channelIds=${CHANNEL_B}`);

        expect(body.Items).toHaveLength(1);
        expect(body.Items[0].ChannelId).toBe(CHANNEL_B);
    });

    it('accepts POST with a JSON body (Moonfin switches to POST for large ChannelIds lists)', async () => {
        const body = await callPost({ ChannelIds: [CHANNEL_A] });

        expect(body.Items).toHaveLength(1);
        expect(body.Items[0].ChannelId).toBe(CHANNEL_A);
    });

    it('POST falls back to all channels when ChannelIds is empty', async () => {
        const body = await callPost({ ChannelIds: [] });

        expect(body.Items).toHaveLength(2);
    });

    it('POST answers 413 for a body past the 4 MiB cap instead of widening to all channels', async () => {
        const huge = { ChannelIds: [CHANNEL_A], Filler: 'x'.repeat(4 * 1024 * 1024 + 1024) };
        const response = await (POST as unknown as (event: RequestEvent) => Promise<Response>)(
            makePostEvent(huge),
        );
        expect(response.status).toBe(413);
    });

    it('POST still honours a 12k-id ChannelIds list (well past the default 256 KiB cap)', async () => {
        const ids = Array.from(
            { length: 12_000 },
            (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        );
        ids.push(CHANNEL_A);
        expect(JSON.stringify({ ChannelIds: ids }).length).toBeGreaterThan(256 * 1024);
        const body = await callPost({ ChannelIds: ids });
        expect(body.Items).toHaveLength(1);
        expect(body.Items[0].ChannelId).toBe(CHANNEL_A);
    });

    it('POST still treats malformed JSON as no filter (all channels)', async () => {
        const response = await (POST as unknown as (event: RequestEvent) => Promise<Response>)({
            url: new URL('https://example.test/j/LiveTv/Programs'),
            request: new Request('http://localhost/test', { method: 'POST', body: '{nope' }),
            locals: { user: { hasLiveTvPermission: true } },
        } as unknown as RequestEvent);
        const body = (await response.json()) as { Items: unknown[] };
        expect(body.Items).toHaveLength(2);
    });
});

describe('/j/LiveTv/Programs Jellyfin query params', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetChannels.mockResolvedValue([
            { id: CHANNEL_A, name: 'Channel A', sortOrder: 1, images: {}, category: 'Movies' },
            { id: CHANNEL_B, name: 'Channel B', sortOrder: 2, images: {}, category: 'News' },
        ]);
        mockGetGuidePrograms.mockResolvedValue({
            [CHANNEL_A]: [makeProgram(CHANNEL_A, -10), makeProgram(CHANNEL_A, 40)],
            [CHANNEL_B]: [makeProgram(CHANNEL_B, -90), makeProgram(CHANNEL_B, 20)],
        });
    });

    const ids = (body: { Items: Array<Record<string, unknown>> }): unknown[] =>
        body.Items.map((item) => item.Id);

    it('IsAiring=false and HasAired=false are real filters, not ignored', async () => {
        expect(ids(await callGet('?isAiring=false'))).toEqual([
            `${CHANNEL_B}--90`,
            `${CHANNEL_B}-20`,
            `${CHANNEL_A}-40`,
        ]);
        expect(ids(await callGet('?hasAired=false'))).toEqual([
            `${CHANNEL_A}--10`,
            `${CHANNEL_B}-20`,
            `${CHANNEL_A}-40`,
        ]);
    });

    it('content flags and SortBy/SortOrder', async () => {
        expect(ids(await callGet('?isMovie=true&sortBy=StartDate&sortOrder=Descending'))).toEqual([
            `${CHANNEL_A}-40`,
            `${CHANNEL_A}--10`,
        ]);
        expect(ids(await callGet('?isNews=true'))).toEqual([`${CHANNEL_B}--90`, `${CHANNEL_B}-20`]);
    });

    it('MinStartDate/MaxStartDate bound the result and move the loaded window', async () => {
        const min = new Date(Date.now() + 15 * 60_000).toISOString();
        expect(ids(await callGet(`?minStartDate=${min}`))).toEqual([
            `${CHANNEL_B}-20`,
            `${CHANNEL_A}-40`,
        ]);
        const [start] = mockGetGuidePrograms.mock.calls.at(-1) as [Date, Date];
        expect(start.toISOString()).toBe(min);
    });

    it('EnableTotalRecordCount=false reports the page length', async () => {
        const body = await callGet('?limit=1&enableTotalRecordCount=false');
        expect(body.Items).toHaveLength(1);
        expect(body.TotalRecordCount).toBe(1);
        expect((await callGet('?limit=1')).TotalRecordCount).toBe(4);
    });

    it('POST body honours the same filters', async () => {
        const body = await callPost({ IsAiring: true, SortBy: ['StartDate'] });
        expect(ids(body)).toEqual([`${CHANNEL_A}--10`]);
    });

    it('returns an empty result without Live TV permission', async () => {
        const event = {
            url: new URL('https://example.test/j/LiveTv/Programs'),
            locals: { user: { hasLiveTvPermission: false } },
        } as unknown as RequestEvent;
        const res = await (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
        expect(await res.json()).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
        expect(mockGetGuidePrograms).not.toHaveBeenCalled();
    });
});
