// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), base: 'http://jf' }));
vi.mock('./base-client.js', () => ({
    JellyfinBaseClient: class {
        protected api = {
            get basePath() {
                return h.base;
            },
            accessToken: 'admin-key',
            axiosInstance: h,
        };
        protected logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        protected isConfigured(): boolean {
            return true;
        }
    },
}));
vi.mock('../config.js', () => ({ config: { DEFAULT_USER: 'admin', APP_NAME: 'Lumastra' } }));
vi.mock('../cache/index.js', () => ({
    CACHE_NAMESPACES: {
        jellyfinUsers: 'users',
        jellyfinLibrary: 'library',
        watchedSeries: 'watched',
    },
    cacheManager: {
        for: () => ({ get: async () => null, set: async () => {}, delete: async () => {} }),
    },
}));

import { JellyfinMediaService } from './media.service.js';
import { JellyfinSeriesService } from './series.service.js';
import { JellyfinWatchProgressService } from './watch-progress.service.js';
import { JellyfinPlaybackService } from './playback.service.js';
import { JellyfinUserService } from './user.service.js';
import { JellyfinAuthService } from './auth.service.js';

const m = new JellyfinMediaService();
const s = new JellyfinSeriesService();
const w = new JellyfinWatchProgressService();
const u = new JellyfinUserService();
const a = new JellyfinAuthService();

type Case = [string, () => Promise<unknown>, string[]];
const cases: Case[] = [
    ['media.searchMovie', () => m.searchMovie('u', 'query'), ['/Users/u/Items']],
    ['media.searchSeries', () => m.searchSeries('u', 'query'), ['/Users/u/Items']],
    ['media.searchByPerson', () => m.searchByPerson('u', 'person'), ['/Users/u/Items']],
    ['media.getItemById', () => m.getItemById('u', 'item'), ['/Users/u/Items/item']],
    [
        'media.getItemInfo + default-user lookup',
        () => m.getItemInfo('item'),
        ['/Users', '/Users/u/Items/item'],
    ],
    ['media.getItemType', () => m.getItemType('item', 'u'), ['/Users/u/Items/item']],
    ['media.getItems', () => m.getItems('u', ['Movie']), ['/Users/u/Items']],
    ['media.getFavoriteItems', () => m.getFavoriteItems('u', ['Movie']), ['/Users/u/Items']],
    ['media.getItemsByGenre', () => m.getItemsByGenre('u', 'Drama'), ['/Users/u/Items']],
    ['media.getGenresList', () => m.getGenresList('u'), ['/Genres']],
    ['media.searchLiveTvChannels', () => m.searchLiveTvChannels('news'), ['/LiveTv/Channels']],
    ['media.getItemDetails', () => m.getItemDetails('item'), ['/Items/item']],
    ['series.getSeriesSeasons', () => s.getSeriesSeasons('series', 'u'), ['/Shows/series/Seasons']],
    [
        'series.getSeasonEpisodes',
        () => s.getSeasonEpisodes('series', { userId: 'u' }),
        ['/Shows/series/Episodes'],
    ],
    [
        'series.getSeriesDetails',
        () => s.getSeriesDetails('series', 'u'),
        ['/Items/series', '/Shows/series/Seasons'],
    ],
    [
        'series.getAllSeriesEpisodes',
        () => s.getAllSeriesEpisodes('series', 'u'),
        ['/Shows/series/Episodes'],
    ],
    [
        'series.getItemWithChapters',
        () => s.getItemWithChapters('item', 'u'),
        ['/Users/u/Items/item'],
    ],
    [
        'series.getNextEpisode',
        () => s.getNextEpisode('series', 1, 1, 'u'),
        ['/Shows/series/Episodes'],
    ],
    [
        'series.findEpisode (all three search attempts)',
        () => s.findEpisode('Show', 1, 1),
        ['/Items', '/Items', '/Items'],
    ],
    ['watch.getContinueWatching', () => w.getContinueWatching('u'), ['/Users/u/Items/Resume']],
    ['watch.getRecentlyAdded', () => w.getRecentlyAdded('u'), ['/Users/u/Items']],
    ['watch.getNextUp', () => w.getNextUp('u'), ['/Shows/NextUp']],
    ['watch.getNextUpForSeries', () => w.getNextUpForSeries('series', 'u'), ['/Shows/NextUp']],
    [
        'watch.getFirstUnwatchedEpisode',
        () => w.getFirstUnwatchedEpisode('series', 'u'),
        ['/Shows/series/Episodes'],
    ],
    [
        'watch.getEpisodeBySeasonAndNumber',
        () => w.getEpisodeBySeasonAndNumber('series', 1, 1, 'u'),
        ['/Shows/series/Episodes'],
    ],
    [
        'watch.getEnhancedNextUp (all three requests)',
        () => w.getEnhancedNextUp('u'),
        ['/Users/u/Items/Resume', '/Shows/NextUp', '/Users/u/Items'],
    ],
    [
        'watch.getRecentUnwatchedEpisodes',
        () => w.getRecentUnwatchedEpisodes('u'),
        ['/Users/u/Items'],
    ],
    ['watch.getRecentlyPlayed', () => w.getRecentlyPlayed('u'), ['/Users/u/Items']],
    [
        'watch.getWatchedSeriesAndEpisodes',
        () => w.getWatchedSeriesAndEpisodes('u'),
        ['/Users/u/Items'],
    ],
    [
        'watch.getWatchedStatusBatch',
        () => w.getWatchedStatusBatch('u', [{ tmdbId: 1, mediaType: 'movie' }]),
        ['/Users/u/Items'],
    ],
    ['playback.getSessions', () => new JellyfinPlaybackService().getSessions(), ['/Sessions']],
    ['user.getUsers', () => u.getUsers(), ['/Users']],
    ['user.getUserByName', () => u.getUserByName('admin'), ['/Users']],
    ['user.getUserWithPolicy', () => u.getUserWithPolicy('u'), ['/Users/u']],
    ['auth.quickConnect', () => a.quickConnect('123456', 'u'), ['/QuickConnect/Authorize']],
    ['auth.initiateQuickConnect', () => a.initiateQuickConnect(), ['/QuickConnect/Initiate']],
    [
        'auth.authorizeQuickConnect',
        () => a.authorizeQuickConnect('123456', 'u'),
        ['/QuickConnect/Authorize'],
    ],
];

beforeEach(() => {
    h.base = 'http://jf';
    h.get
        .mockReset()
        .mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => ({
            data: new URL(url).pathname.replace(/\/{2,}/g, '/').endsWith('/Users')
                ? [{ Id: 'u', Name: 'admin' }]
                : opts?.params?.includeItemTypes === 'Series'
                  ? { Items: [{ Id: 'series', Name: 'Show' }] }
                  : { Items: [], Id: 'item', Name: 'test', Type: 'Movie', TotalRecordCount: 0 },
        }));
    h.post.mockReset().mockResolvedValue({ status: 200, data: { AccessToken: 'new-token' } });
});

describe('outgoing Jellyfin service call sites', () => {
    it.each(cases)('%s', async (_name, run, paths) => {
        await run();
        const calls = [...h.get.mock.calls, ...h.post.mock.calls];
        expect(calls.map(([url]) => new URL(String(url)).pathname)).toEqual(paths);
        for (const [url, second, third] of calls) {
            const opts = third ?? second;
            expect(opts.headers).toEqual({
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="admin-key"$/,
                ),
            });
            expect(new URL(String(url)).searchParams.has('api_key')).toBe(false);
        }
    });

    it.each(cases)('keeps the subpath with a trailing slash: %s', async (_name, run, paths) => {
        h.base = 'http://proxy/jellyfin/';
        await run();
        const calls = [...h.get.mock.calls, ...h.post.mock.calls];
        expect(calls.map(([url]) => new URL(String(url)).pathname)).toEqual(
            paths.map((path) => `/jellyfin${path}`),
        );
    });

    it('validates /Users/Me with the user token, never the admin API key', async () => {
        await a.validateAccessToken('user-token');
        expect(h.get).toHaveBeenCalledWith('http://jf/Users/Me', {
            headers: {
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="user-token"$/,
                ),
            },
        });
    });

    it('keeps the stored device identity when validating a device token', async () => {
        await a.validateAccessToken('user-token', {
            deviceName: 'Lumastra - Den TV',
            deviceId: 'tv-session',
        });
        expect(h.get.mock.calls[0][1].headers.Authorization).toContain(
            'Device="Lumastra - Den TV", DeviceId="tv-session"',
        );
        expect(h.get.mock.calls[0][1].headers.Authorization).toContain('Token="user-token"');
    });

    it.each([false, true])(
        'Quick Connect authentication preserves tokenless device identity (custom=%s)',
        async (custom) => {
            if (custom) await a.connectQuickConnectWithDevice('secret', 'Den TV', 'tv-42');
            else await a.connectQuickConnect('secret');
            expect(h.post).toHaveBeenCalledTimes(1);
            const [url, , opts] = h.post.mock.calls[0];
            expect(url).toBe('http://jf/Users/AuthenticateWithQuickConnect');
            expect(Object.keys(opts.headers).sort()).toEqual(['Authorization', 'Content-Type']);
            expect(opts.headers.Authorization).toMatch(/^MediaBrowser Client="Lumastra", /);
            expect(opts.headers.Authorization).not.toContain('Token=');
            expect(opts.headers.Authorization).toContain(
                custom ? 'DeviceId="tv-42"' : 'DeviceId="lumastra-quickconnect"',
            );
            if (custom) expect(opts.headers.Authorization).toContain('Device="Den TV"');
        },
    );
});
