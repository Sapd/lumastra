// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C22 fix round 1: `fetchWithTimeout` THROWS (FetchRedirectError /
 * FetchTimeoutError) rather than returning a non-ok Response for a refused
 * redirect or a timeout. Before this fix, `fetchJellyfinImage`'s direct-image
 * call let that throw escape uncaught, which SKIPPED the fallback chain
 * entirely (Episode -> Series, Audio -> Album, etc.) — a cross-host 3xx (or
 * a timeout) from the configured Jellyfin server aborted image resolution
 * outright instead of falling through exactly like an ordinary 404 would.
 *
 * This test proves a redirect-guard error on the DIRECT image call still
 * reaches the fallback chain and returns the fallback's bytes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/config', () => ({
    config: { JELLYFINURL: 'http://jf.test/jellyfin/', JELLYFINAPIKEY: 'admin-jellyfin-token' },
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('$lib/server/jellyfin/runtime-gate.js', () => ({
    JELLYFIN_DIRECT_FETCH_TIMEOUT_MS: 2_500,
    canCallJellyfin: () => true,
    recordJellyfinTransportFailure: vi.fn(),
    recordJellyfinTransportSuccess: vi.fn(),
}));

const mockGetItemInfo = vi.fn();
vi.mock('$lib/server/jellyfin', () => ({
    jellyfinMediaService: { getItemInfo: (...args: unknown[]) => mockGetItemInfo(...args) },
}));

const mockGetFallbackChain = vi.fn();
vi.mock('./jellyfin-fallback-strategy', () => ({
    getFallbackChain: (...args: unknown[]) => mockGetFallbackChain(...args),
}));

// The direct-image call throws a cross-host FetchRedirectError; the
// fallback's call succeeds. Real FetchRedirectError/FetchTimeoutError classes
// are re-exported unmodified so `instanceof` checks elsewhere stay valid.
let fetchCall = 0;
vi.mock('$lib/server/utils/fetch-utils.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/fetch-utils.js')>();
    return {
        ...actual,
        fetchWithTimeout: vi.fn(async (url: string) => {
            expect(new URL(url).pathname).toMatch(
                /^\/jellyfin\/Items\/(episode-1|series-1)\/Images\/Primary$/,
            );
            fetchCall += 1;
            if (fetchCall === 1) {
                throw new actual.FetchRedirectError('evil.example.com');
            }
            return new Response(new Uint8Array([1, 2, 3]), {
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
            });
        }),
    };
});

const { JellyfinImageProvider } = await import('./jellyfin.provider.js');

type PrivateProvider = {
    fetchJellyfinImage: (
        itemId: string,
        jellyfinType: string,
        options: Record<string, unknown>,
    ) => Promise<Buffer>;
};

describe('JellyfinImageProvider.fetchJellyfinImage — redirect-guard errors fall through to the fallback chain', () => {
    beforeEach(() => {
        fetchCall = 0;
        mockGetItemInfo.mockReset().mockResolvedValue({ Type: 'Episode' });
        mockGetFallbackChain
            .mockReset()
            .mockReturnValue([
                { itemId: 'series-1', imageType: 'Primary', description: 'series poster' },
            ]);
    });

    it('a cross-host redirect on the DIRECT image still reaches and uses the fallback', async () => {
        const provider = new JellyfinImageProvider() as unknown as PrivateProvider;

        const buffer = await provider.fetchJellyfinImage('episode-1', 'Primary', {});

        expect(Buffer.from(buffer)).toEqual(Buffer.from([1, 2, 3]));
        expect(mockGetItemInfo).toHaveBeenCalledWith('episode-1');
        expect(mockGetFallbackChain).toHaveBeenCalled();
        expect(fetchCall).toBe(2);
    });
    it('inherit=none refuses the ancestor fallback after a direct miss', async () => {
        const provider = new JellyfinImageProvider() as unknown as PrivateProvider;
        await expect(
            provider.fetchJellyfinImage('episode-1', 'Primary', { inherit: 'none' }),
        ).rejects.toThrow();
        expect(mockGetItemInfo).not.toHaveBeenCalled();
        expect(mockGetFallbackChain).not.toHaveBeenCalled();
        expect(fetchCall).toBe(1);
    });
    it('isolates own-only disk cache entries from previously inherited bytes', () => {
        const provider = new JellyfinImageProvider() as unknown as {
            getCacheKey: (id: string, type: string, options: Record<string, unknown>) => string;
        };
        expect(provider.getCacheKey('episode-1', 'Primary', { inherit: 'none' })).not.toBe(
            provider.getCacheKey('episode-1', 'Primary', {}),
        );
    });
});
