// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import type { WatchStateChange } from '@sapd/lumastra-plugin-sdk';
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('$lib/server/jellyfin/user.service.js', () => ({
    jellyfinUserService: {
        getAxiosInstance: () => h,
        getBaseUrl: () => 'http://jf',
        getApiToken: () => 'sync-key',
    },
}));
vi.mock('$lib/server/config.js', () => ({ features: { jellyfinSync: true } }));
vi.mock('$lib/server/jellyfin/base-client.js', () => ({
    circuitBreaker: {
        shouldAllowRequest: () => true,
        getState: () => ({ isOpen: false, failureCount: 0, timeSinceOpenMs: null }),
    },
}));
vi.mock('$lib/server/jellyfin/retry.js', () => ({
    withJellyfinRetry: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserIdByUserId: async () => 'u',
}));
vi.mock('../../index.js', () => ({ registerWatchSyncWithAutoTasks: vi.fn() }));
import { jellyfinWatchSync } from './jellyfin.js';

function assertAuth(): void {
    const calls = [...h.get.mock.calls, ...h.post.mock.calls, ...h.delete.mock.calls];
    expect(calls.length).toBeGreaterThan(0);
    for (const [url, second, third] of calls) {
        const opts = third ?? second;
        expect(opts.headers).toEqual({
            Authorization: expect.stringMatching(
                /^MediaBrowser Client="Lumastra", .*Token="sync-key"$/,
            ),
        });
        expect(new URL(String(url)).searchParams.has('api_key')).toBe(false);
    }
}

beforeEach(() => {
    h.get.mockReset();
    h.post.mockReset().mockResolvedValue({ data: {} });
    h.delete.mockReset().mockResolvedValue({ data: {} });
});

describe('watch sync outgoing authentication', () => {
    it('authenticates TMDB, IMDB fallback and episode resolution', async () => {
        h.get.mockImplementation(
            async (url: string, cfg: { params?: Record<string, unknown> }) => ({
                data: {
                    Items: url.includes('/Shows/')
                        ? [{ Id: 'ep', IndexNumber: 1 }]
                        : cfg.params?.IncludeItemTypes === 'Series'
                          ? [{ Id: 'series', ProviderIds: { Tmdb: '2' } }]
                          : String(cfg.params?.AnyProviderIdEquals).startsWith('imdb.')
                            ? [{ Id: 'movie', ProviderIds: { Imdb: 'tt1' } }]
                            : [],
                },
            }),
        );
        const resolved = await jellyfinWatchSync.resolveIds(mockContext({ input: {} }), [
            { mediaId: 'm', mediaType: 'movie', tmdbId: '1', imdbId: 'tt1' },
            {
                mediaId: 'e',
                mediaType: 'episode',
                seriesTmdbId: '2',
                tmdbId: null,
                imdbId: null,
                seasonNumber: 1,
                episodeNumber: 1,
            },
        ]);
        expect(resolved).toHaveLength(2);
        expect(h.get).toHaveBeenCalledTimes(4);
        assertAuth();
    });

    it('authenticates watched, unwatched, companion position writes and resume push', async () => {
        const ctx = mockContext({ input: {} });
        const watched: WatchStateChange = {
            providerId: 'item',
            mediaId: 'm',
            username: '10000000-0000-4000-8000-000000000001',
            isWatched: true,
            resumePositionMs: 0,
            runtimeMs: 100000,
            watchCount: 1,
        };
        await jellyfinWatchSync.pushWatchState!(ctx, [
            watched,
            { ...watched, isWatched: false, resumePositionMs: 1000 },
        ]);
        await jellyfinWatchSync.pushResumePosition!(ctx, [
            {
                username: '10000000-0000-4000-8000-000000000001',
                mediaId: 'm',
                providerId: 'item',
                resumePositionMs: 2000,
            },
        ]);
        expect(h.post).toHaveBeenCalledTimes(4);
        expect(h.delete).toHaveBeenCalledTimes(1);
        assertAuth();
    });

    it('authenticates users, sessions, movie/episode pages, resume items and series enrichment', async () => {
        h.get.mockImplementation(
            async (url: string, cfg?: { params?: Record<string, unknown> }) => ({
                data: url.endsWith('/Users')
                    ? [{ Id: 'u', Name: 'admin' }]
                    : url.endsWith('/Sessions')
                      ? []
                      : url.endsWith('/Items/series')
                        ? { ProviderIds: { Tmdb: '2' } }
                        : cfg?.params?.includeItemTypes === 'Episode'
                          ? {
                                Items: [
                                    {
                                        Id: 'ep',
                                        Type: 'Episode',
                                        SeriesId: 'series',
                                        IndexNumber: 1,
                                        ParentIndexNumber: 1,
                                        UserData: { Played: true },
                                    },
                                ],
                                TotalRecordCount: 1,
                            }
                          : { Items: [], TotalRecordCount: 0 },
            }),
        );
        const result = await jellyfinWatchSync.pullWatchState!(mockContext({ input: {} }), {
            knownUsernames: new Set(['admin']),
        });
        expect(result.errors).toEqual([]);
        expect(h.get).toHaveBeenCalledTimes(6);
        expect(h.get.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
            '/Users',
            '/Sessions',
            '/Users/u/Items',
            '/Users/u/Items',
            '/Users/u/Items/Resume',
            '/Users/u/Items/series',
        ]);
        assertAuth();
    });
});
