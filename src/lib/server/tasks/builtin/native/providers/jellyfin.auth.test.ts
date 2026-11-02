// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
vi.mock('../../../registry.js', () => ({ registry: { registerProvider: vi.fn() } }));
vi.mock('../../../../config.js', () => ({
    config: { JELLYFINURL: 'http://172.25.0.4:8096/jellyfin', JELLYFINAPIKEY: 'provider-key' },
    features,
}));
const { canCall, shouldAllowRequest, success, failure, features } = vi.hoisted(() => ({
    features: { jellyfinSync: true },
    shouldAllowRequest: vi.fn(() => true),
    canCall: vi.fn(() => true),
    success: vi.fn(),
    failure: vi.fn(),
}));
vi.mock('$lib/server/jellyfin/runtime-gate.js', () => ({
    canCallJellyfin: canCall,
    JELLYFIN_DIRECT_FETCH_TIMEOUT_MS: 2500,
    recordJellyfinTransportSuccess: success,
    recordJellyfinTransportFailure: failure,
}));
vi.mock('$lib/server/jellyfin/base-client.js', () => ({
    circuitBreaker: { shouldAllowRequest },
}));
import { jellyfinProvider } from './jellyfin.js';

describe('Jellyfin metadata provider auth', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        canCall.mockReturnValue(true);
        shouldAllowRequest.mockReturnValue(true);
        features.jellyfinSync = true;
    });
    it('authenticates search, detail, seasons and episodes at the HTTP seam', async () => {
        const ctx = mockContext({ input: {} });
        const get = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (url) =>
                Response.json(
                    String(url).includes('/Items/item')
                        ? { Id: 'item', Name: 'Movie' }
                        : { Items: [] },
                ),
            );
        await jellyfinProvider.search!(ctx, { type: 'movie', query: 'Movie' });
        await jellyfinProvider.detail!(ctx, 'item');
        await jellyfinProvider.childList!(ctx, 'series');
        expect(get).toHaveBeenCalledTimes(4);
        expect(get.mock.calls[0][1]?.signal).toBeDefined();
        expect(get.mock.calls.map(([url]) => new URL(String(url)).pathname).sort()).toEqual([
            '/jellyfin/Items',
            '/jellyfin/Items/item',
            '/jellyfin/Shows/series/Episodes',
            '/jellyfin/Shows/series/Seasons',
        ]);
        for (const [url, opts] of get.mock.calls) {
            expect(opts?.headers).toEqual({
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="provider-key"$/,
                ),
            });
            expect(new URL(String(url)).searchParams.has('api_key')).toBe(false);
        }
    });
    it.each(['http://172.25.0.5:8096/Items', 'http://arbitrary.example/Items'])(
        'refuses a redirect to %s before sending the key',
        async (location) => {
            const fetch = vi
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(
                    new Response(null, { status: 302, headers: { Location: location } }),
                );
            await expect(
                jellyfinProvider.search!(mockContext({ input: {} }), {
                    type: 'movie',
                    query: 'Movie',
                }),
            ).rejects.toThrow(/redirect/i);
            expect(fetch).toHaveBeenCalledTimes(1);
        },
    );
    it('reports unavailable and skips HTTP while the shared breaker refuses calls', async () => {
        shouldAllowRequest.mockReturnValue(false);
        expect(await jellyfinProvider.isConfigured(mockContext())).toBe(false);
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ Items: [] }));
        await expect(
            jellyfinProvider.search!(mockContext({ input: {} }), { type: 'movie', query: 'Movie' }),
        ).rejects.toThrow(/not available/);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('reports metadata-only configuration available with watch sync off', async () => {
        features.jellyfinSync = false;
        canCall.mockReturnValue(false);
        expect(await jellyfinProvider.isConfigured(mockContext())).toBe(true);
    });
    it('fetches metadata without watch sync or a connected sync status', async () => {
        features.jellyfinSync = false;
        canCall.mockReturnValue(false);
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ Items: [] }));
        await expect(
            jellyfinProvider.search!(mockContext(), { type: 'tv', query: 'Series' }),
        ).resolves.toEqual([]);
        expect(fetch).toHaveBeenCalledOnce();
    });
    it('allows 30 seconds for large season and episode metadata responses', async () => {
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ Items: [] }));
        await jellyfinProvider.childList!(mockContext(), 'big-series');
        expect(timeout).toHaveBeenCalledTimes(2);
        for (const [deadline] of timeout.mock.calls) expect(deadline).toBe(30_000);
    });
    it.each(['before', 'during'])(
        'does not penalize the breaker for a task aborted %s fetch',
        async (when) => {
            const controller = new AbortController();
            const error = new DOMException('Task cancelled', 'AbortError');
            if (when === 'before') controller.abort(error);
            vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
                if (when === 'during') controller.abort(error);
                throw error;
            });
            await expect(
                jellyfinProvider.detail!(mockContext({ signal: controller.signal }), 'item'),
            ).rejects.toThrow('Task cancelled');
            expect(failure).not.toHaveBeenCalled();
        },
    );
    it('feeds transport failures into the shared breaker', async () => {
        const error = new TypeError('fetch failed');
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
        await expect(jellyfinProvider.detail!(mockContext({ input: {} }), 'item')).rejects.toThrow(
            'fetch failed',
        );
        expect(failure).toHaveBeenCalledWith(error);
    });
});
