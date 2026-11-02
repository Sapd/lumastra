// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLiveTvChannels } from './playback.js';
import { getStationFeeds, fetchGuidePrograms, getChannelPrograms } from './livetv-playback.js';
import { setLiveTvFavorite } from './livetv-favorites.js';
import { updateSimpleMode, updateUserSimpleMode } from './livetv-simple-mode.js';

const stationId = '00000000-0000-4000-8000-000000000001';
const from = new Date('2026-10-16T10:00:00Z');
const to = new Date('2026-10-16T16:00:00Z');
const window = { from: from.toISOString(), to: to.toISOString(), asOf: from.toISOString() };
const page = { limit: 200, nextCursor: null, hasMore: false };
const nowNext = { current: null, next: null };
const feedId = '00000000-0000-4000-8000-000000000002';
const mode = {
    enabled: true,
    layout: 'tv',
    textSize: 'large',
    autostart: false,
    locked: false,
    stationIds: [stationId],
};

function respond(body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('Live TV station wire contract', () => {
    it('retains the shown feed separately from the public station identity', async () => {
        const fetchMock = respond({
            items: [
                { id: stationId, feedId, name: 'News', images: {}, sortOrder: 0, isVisible: true, nowNext },
            ],
            page: { limit: 1, hasMore: false },
        });
        const result = await getLiveTvChannels();
        expect(result.data?.items[0]).toMatchObject({ id: stationId, feedId });
        expect(fetchMock).toHaveBeenCalledWith('/api/livetv/stations', expect.anything());
    });

    it('fetches the station feed menu and station programs', async () => {
        const fetchMock = respond({ stationId, feeds: [] });
        expect((await getStationFeeds(stationId)).data?.stationId).toBe(stationId);
        expect(fetchMock).toHaveBeenCalledWith(
            `/api/livetv/stations/${stationId}/feeds`,
            expect.anything(),
        );
        respond({ stationId, window, airings: [], nowNext });
        const result = await getChannelPrograms(stationId, from.toISOString(), to.toISOString());
        expect(result.data).toMatchObject({ airings: [], nowNext });
        expect(fetch).toHaveBeenCalledWith(
            `/api/livetv/stations/${stationId}/programs?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`,
            expect.anything(),
        );
    });

    it('scopes guide requests by stationIds', async () => {
        const fetchMock = respond({
            stations: [], window, page,
        });
        await fetchGuidePrograms(from, to, [stationId]);
        const url = String(fetchMock.mock.calls[0][0]);
        expect(url).toContain(`stationIds=${stationId}`);
        expect(url).not.toContain('channelIds=');
    });

    it('chunks every requested station into scopes of 50 without cursor paging', async () => {
        const fetchMock = respond({ stations: [], window, page });
        const ids = Array.from({ length: 251 }, (_, index) =>
            `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        );
        const result = await fetchGuidePrograms(from, to, ids);
        expect(result.error).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(6);
        const scopes = fetchMock.mock.calls.map(([input]) => {
            const url = new URL(String(input), 'https://example.test');
            expect(url.searchParams.has('cursor')).toBe(false);
            expect(url.searchParams.has('limit')).toBe(false);
            return url.searchParams.get('stationIds')!.split(',');
        });
        expect(scopes.map((scope) => scope.length)).toEqual([50, 50, 50, 50, 50, 1]);
        expect(scopes.flat()).toEqual(ids);
    });

    it('stops paging when the server repeats a cursor', async () => {
        const fetchMock = respond({
            stations: [], window,
            page: { ...page, hasMore: true, nextCursor: 'repeated' },
        });
        const result = await fetchGuidePrograms(from, to);
        expect(result.error).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.map(([input]) =>
            new URL(String(input), 'https://example.test').searchParams.get('cursor'),
        )).toEqual([null, 'repeated']);
        expect(result.data?.page).toEqual(page);
    });

    it('uses the first response asOf to select now/next across later pages', async () => {
        const current = {
            id: 'current', stationId, title: 'Current',
            startTime: '2026-10-16T09:00:00.000Z', endTime: '2026-10-16T11:00:00.000Z',
        };
        const next = {
            id: 'next', stationId, title: 'Next',
            startTime: current.endTime, endTime: '2026-10-16T13:00:00.000Z',
        };
        const fetchMock = respond({ stations: [], window, page });
        const response = (body: unknown) => new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json' },
        });
        fetchMock.mockResolvedValueOnce(response({
            stations: [], window, page: { ...page, hasMore: true, nextCursor: 'next' },
        })).mockResolvedValueOnce(response({
            stations: [{ stationId, airings: [current, next], nowNext }],
            window: { ...window, asOf: '2026-10-16T12:00:00.000Z' }, page,
        }));
        const result = await fetchGuidePrograms(from, to);
        expect(result.error).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.data?.window.asOf).toBe(window.asOf);
        expect(result.data?.stations[0].nowNext).toEqual({ current, next });
    });

    it('never turns an empty station scope into an unscoped guide', async () => {
        const fetchMock = respond({ stations: [], window, page });
        const result = await fetchGuidePrograms(from, to, []);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.data?.stations).toEqual([]);
    });

    it('splits long guide windows and follows every lineup cursor in each window', async () => {
        const end = new Date(from.getTime() + 30 * 3600_000);
        const airing = { id: 'boundary', stationId, title: 'News',
            startTime: new Date(from.getTime() + 23 * 3600_000).toISOString(),
            endTime: new Date(from.getTime() + 25 * 3600_000).toISOString() };
        const fetchMock = vi.fn().mockImplementation(async (input: string) => {
            const url = new URL(input, 'https://example.test');
            const cursor = url.searchParams.get('cursor');
            const requestFrom = url.searchParams.get('from')!;
            const requestTo = url.searchParams.get('to')!;
            expect(Date.parse(requestTo) - Date.parse(requestFrom)).toBeLessThanOrEqual(24 * 3600_000);
            expect(url.searchParams.get('limit')).toBe('200');
            return new Response(JSON.stringify({
                window: { from: requestFrom, to: requestTo, asOf: window.asOf },
                stations: [{ stationId: cursor ? feedId : stationId, airings: cursor ? [] : [airing], nowNext }],
                page: { limit: 200, nextCursor: cursor ? null : 'opaque/next', hasMore: !cursor },
            }), { headers: { 'Content-Type': 'application/json' } });
        });
        vi.stubGlobal('fetch', fetchMock);
        const result = await fetchGuidePrograms(from, end);
        expect(result.error).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(fetchMock.mock.calls.map(([url]) => new URL(url, 'https://example.test').searchParams.get('cursor')))
            .toEqual([null, 'opaque/next', null, 'opaque/next']);
        expect(result.data?.stations.map((station) => station.stationId)).toEqual([stationId, feedId]);
        expect(result.data?.stations[0].airings).toEqual([airing]);
        expect(result.data?.page.hasMore).toBe(false);
        expect(result.data?.window.to).toBe(end.toISOString());
    });

    it('does not return a partial guide when a later page fails', async () => {
        const fetchMock = respond({ stations: [], window,
            page: { ...page, hasMore: true, nextCursor: 'next' } });
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ stations: [], window,
            page: { ...page, hasMore: true, nextCursor: 'next' } }), { headers: { 'Content-Type': 'application/json' } }))
            .mockResolvedValueOnce(new Response('offline', { status: 503 }));
        const result = await fetchGuidePrograms(from, to);
        expect(result.error).toBeTruthy();
        expect(result.data).toBeNull();
    });

    it('writes favorites with station identity', async () => {
        const fetchMock = respond({ stationIds: [stationId] });
        expect((await setLiveTvFavorite(stationId, true)).data?.stationIds).toEqual([stationId]);
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/livetv/favorites',
            expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ stationId, favorite: true }),
            }),
        );
    });

    it('PATCHes own and admin simple-mode station settings', async () => {
        const update = { stationIds: [stationId], clearStartStation: true };
        const fetchMock = respond(mode);
        await updateSimpleMode(update);
        await updateUserSimpleMode('helper/user', update);
        for (const path of [
            '/api/livetv/simple-mode',
            '/api/admin/users/helper%2Fuser/livetv-simple-mode',
        ]) {
            expect(fetchMock).toHaveBeenCalledWith(
                path,
                expect.objectContaining({
                    method: 'PATCH',
                    body: JSON.stringify(update),
                }),
            );
        }
    });
});
