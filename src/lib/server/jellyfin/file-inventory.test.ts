// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('./user.service.js', () => ({
    jellyfinUserService: {
        getAxiosInstance: () => client,
        getBaseUrl: () => 'http://jellyfin.test',
        getApiToken: () => 'inventory-key',
    },
}));
vi.mock('./retry.js', () => ({ withJellyfinRetry: (fn: () => Promise<unknown>) => fn() }));
import { getJellyfinFileDetails, getJellyfinFileInventory } from './file-inventory.js';

const folders = [{ ItemId: 'movies', Locations: ['/media/movies'] }];
const item = (id = 'a') => ({ Id: id, Type: 'Movie', Path: '/media/movies/Film.mkv', Size: 1234 });

beforeEach(() => {
    client.get.mockReset();
});
describe('Jellyfin file inventory', () => {
    it('uses each library own roots, explicit file fields, auth header and cancellation', async () => {
        client.get
            .mockResolvedValueOnce({
                data: [...folders, { ItemId: 'tv', Locations: ['/shows'] }, { Locations: [] }],
            })
            .mockResolvedValueOnce({ data: { Items: [item()], TotalRecordCount: 1 } })
            .mockResolvedValueOnce({
                data: {
                    Items: [{ ...item('b'), Type: 'Episode', Path: '/shows/Film.mkv' }],
                    TotalRecordCount: 1,
                },
            });
        const signal = new AbortController().signal;
        const result = await getJellyfinFileInventory(signal);
        expect(result[0].roots).toEqual(['/media/movies']);
        expect(result[1].roots).toEqual(['/shows']);
        expect(client.get.mock.calls[1][1]).toMatchObject({
            signal,
            params: {
                ParentId: 'movies',
                Fields: 'Path,ProviderIds,MediaSourceCount,ParentIndexNumber,IndexNumber,IndexNumberEnd',
                SortBy: 'SortName,DateCreated,Id',
                IncludeItemTypes: 'Movie,Episode,Video',
            },
        });
        expect(client.get.mock.calls[2][1].params.ParentId).toBe('tv');
        for (const [, options] of client.get.mock.calls) {
            expect(options.headers.Authorization).toContain('Token="inventory-key"');
        }
    });
    it('reads every page so an unwatched duplicate beyond the first page cannot be missed', async () => {
        const first = Array.from({ length: 500 }, (_, n) => item(String(n)));
        client.get
            .mockResolvedValueOnce({ data: folders })
            .mockResolvedValueOnce({ data: { Items: first, TotalRecordCount: 501 } })
            .mockResolvedValueOnce({ data: { Items: [item('last')], TotalRecordCount: 501 } });
        expect(await getJellyfinFileInventory()).toHaveLength(501);
        expect(client.get.mock.calls[2][1].params.StartIndex).toBe(500);
    });
    it('retains media-source paths and sizes, including direct Path evidence', async () => {
        client.get.mockResolvedValueOnce({ data: folders }).mockResolvedValueOnce({
            data: {
                Items: [
                    {
                        ...item(),
                        MediaSources: [{ Path: '/media/movies/alternate.mkv', Size: 4567 }],
                    },
                ],
                TotalRecordCount: 1,
            },
        });
        expect((await getJellyfinFileInventory())[0].files).toEqual([
            { path: '/media/movies/alternate.mkv', size: 4567, roots: ['/media/movies'] },
            { path: '/media/movies/Film.mkv', size: 1234, roots: ['/media/movies'] },
        ]);
    });
    it('keeps combined files in the ambiguity graph but marks them unpairable', async () => {
        client.get.mockResolvedValueOnce({ data: folders }).mockResolvedValueOnce({
            data: {
                Items: [{ ...item(), Type: 'Episode', IndexNumber: 1, IndexNumberEnd: 2 }],
                TotalRecordCount: 1,
            },
        });
        expect((await getJellyfinFileInventory())[0]).toMatchObject({
            pairable: false,
            mediaType: 'episode',
        });
    });
    it.each([
        { Items: [] },
        { Items: [], TotalRecordCount: 1 },
        { Items: [item(), item()], TotalRecordCount: 2 },
    ])('rejects incomplete or unstable inventories', async (page) => {
        client.get.mockImplementation(async (url: string) => ({
            data: url.endsWith('/Library/VirtualFolders') ? folders : page,
        }));
        await expect(getJellyfinFileInventory()).rejects.toThrow(/inventory/i);
    });
    it('loads size-bearing media sources only for local path candidates', async () => {
        const target = item('a');
        client.get
            .mockResolvedValueOnce({ data: folders })
            .mockResolvedValueOnce({
                data: {
                    Items: [target, { ...item('b'), Path: '/media/movies/Other.mkv' }],
                    TotalRecordCount: 2,
                },
            })
            .mockResolvedValueOnce({
                data: { Items: [{ ...target, MediaSources: [{ Path: target.Path, Size: 1234 }] }] },
            });
        const result = await getJellyfinFileInventory(undefined, [
            {
                id: 'local',
                mediaType: 'movie',
                roots: ['/data'],
                files: [{ path: '/data/Film.mkv', size: 1234 }],
            },
        ]);
        expect(client.get.mock.calls[2][1].params).toMatchObject({
            Ids: 'a',
            Fields: 'Path,MediaSources,ProviderIds',
        });
        expect(result.find((item) => item.id === 'a')?.files[0].size).toBe(1234);
        expect(client.get).toHaveBeenCalledTimes(3);
    });
    it('retries a whole inventory once after page drift', async () => {
        client.get
            .mockResolvedValueOnce({ data: folders })
            .mockResolvedValueOnce({
                data: {
                    Items: Array.from({ length: 500 }, (_, n) => item(String(n))),
                    TotalRecordCount: 501,
                },
            })
            .mockResolvedValueOnce({ data: { Items: [item('0')], TotalRecordCount: 501 } })
            .mockResolvedValueOnce({ data: folders })
            .mockResolvedValueOnce({ data: { Items: [item('fresh')], TotalRecordCount: 1 } });
        expect((await getJellyfinFileInventory()).map((item) => item.id)).toEqual(['fresh']);
        expect(client.get).toHaveBeenCalledTimes(5);
    });
    it('propagates transport failures', async () => {
        client.get.mockRejectedValue(new Error('connection lost'));
        await expect(getJellyfinFileInventory()).rejects.toThrow('connection lost');
    });
    it('restarts with the compatible sort when an older server rejects Id', async () => {
        client.get
            .mockResolvedValueOnce({ data: folders })
            .mockRejectedValueOnce(
                Object.assign(new Error('Invalid ItemSortBy'), { response: { status: 400 } }),
            )
            .mockResolvedValueOnce({ data: folders })
            .mockResolvedValueOnce({ data: { Items: [item()], TotalRecordCount: 1 } });
        expect(await getJellyfinFileInventory()).toHaveLength(1);
        expect(client.get.mock.calls[1][1].params.SortBy).toBe('SortName,DateCreated,Id');
        expect(client.get.mock.calls[3][1].params.SortBy).toBe('SortName,DateCreated');
    });
});

describe('Jellyfin file inventory episode numbers', () => {
    it('reads the season, first and last episode number of an episode, and none for a movie', async () => {
        client.get.mockResolvedValueOnce({ data: folders }).mockResolvedValueOnce({
            data: {
                Items: [
                    {
                        ...item('e'),
                        Type: 'Episode',
                        ParentIndexNumber: 0,
                        IndexNumber: 3,
                        IndexNumberEnd: 4,
                    },
                    item('m'),
                ],
                TotalRecordCount: 2,
            },
        });
        const [episode, movie] = await getJellyfinFileInventory();
        expect(episode).toMatchObject({ season: 0, episode: 3, episodeEnd: 4 });
        expect(movie.season).toBeUndefined();
        expect(client.get.mock.calls[1][1].params.Fields).toContain(
            'ParentIndexNumber,IndexNumber,IndexNumberEnd',
        );
    });
});

describe('Jellyfin file details for cached items', () => {
    it('looks up media sources only for the requested ids and keeps the listing roots', async () => {
        client.get.mockResolvedValueOnce({
            data: {
                Items: [
                    {
                        Id: 'AAAAAAAA-0000-0000-0000-000000000001',
                        Path: '/media/tv/Show/S01E01.mkv',
                        MediaSources: [{ Path: '/media/tv/Show/S01E01.mkv', Size: 4242 }],
                    },
                    // Not asked for: an unstable server answer must not leak in.
                    { Id: 'ffffffff000000000000000000000002', Path: '/media/tv/Other.mkv' },
                ],
            },
        });
        const roots = new Map([['aaaaaaaa000000000000000000000001', ['/media/tv']]]);
        const result = await getJellyfinFileDetails(['aaaaaaaa000000000000000000000001'], roots);
        expect(client.get.mock.calls[0][1].params).toMatchObject({
            Ids: 'aaaaaaaa000000000000000000000001',
            Fields: 'Path,MediaSources,ProviderIds',
        });
        expect([...result.keys()]).toEqual(['aaaaaaaa000000000000000000000001']);
        expect(result.get('aaaaaaaa000000000000000000000001')).toEqual([
            { path: '/media/tv/Show/S01E01.mkv', size: 4242, roots: ['/media/tv'] },
        ]);
    });
    it('propagates transport failures so the caller keeps its cache', async () => {
        client.get.mockRejectedValue(new Error('connection lost'));
        await expect(getJellyfinFileDetails(['a'], new Map())).rejects.toThrow('connection lost');
    });
});
