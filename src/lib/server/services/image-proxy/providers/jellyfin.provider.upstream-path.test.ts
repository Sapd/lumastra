// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The image id of `/api/image/jellyfin:<X>:movie` is request-controlled and the
 * upstream request carries the Jellyfin admin token. Asserted at the network
 * seam: whatever X is, the requested URL must stay under `/Items/<one segment>/Images/`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return {
        ...actual,
        features: new Proxy(actual.features, {
            get: (target, prop: string) => (prop === 'jellyfinSync' ? true : target[prop as never]),
        }),
        config: new Proxy(actual.config, {
            get: (target, prop: string) =>
                prop === 'JELLYFINURL'
                    ? 'http://jellyfin.invalid'
                    : prop === 'JELLYFINAPIKEY'
                      ? 'token'
                      : target[prop as never],
        }),
    };
});

vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const mockGetItemInfo = vi.fn();
vi.mock('$lib/server/jellyfin', () => ({
    jellyfinMediaService: { getItemInfo: (...args: unknown[]) => mockGetItemInfo(...args) },
}));

const mockFetchWithTimeout = vi.fn();
vi.mock('$lib/server/utils/fetch-utils.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/fetch-utils.js')>();
    return { ...actual, fetchWithTimeout: mockFetchWithTimeout };
});

const { JellyfinImageProvider } = await import('./jellyfin.provider.js');
const { circuitBreaker } = await import('$lib/server/jellyfin/base-client.js');
const { connectionStatus } = await import('$lib/server/services/connection-status.service.js');

type PrivateProvider = {
    fetchJellyfinImage: (
        itemId: string,
        jellyfinType: string,
        options: Record<string, unknown>,
    ) => Promise<Buffer>;
};

describe('JellyfinImageProvider upstream URL', () => {
    beforeEach(() => {
        circuitBreaker.reset();
        connectionStatus.setConnected('jellyfin', { serverName: 'jf', version: '10' });
        mockGetItemInfo.mockReset().mockResolvedValue(null);
        mockFetchWithTimeout
            .mockReset()
            .mockImplementation(
                async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
            );
    });

    it.each(['../Users', 'x/../../Users', 'abc?x=1', 'abc#frag', '..'])(
        'item id %j cannot leave /Items/<id>/Images/',
        async (hostile) => {
            const p = new JellyfinImageProvider() as unknown as PrivateProvider;
            await p.fetchJellyfinImage(hostile, 'Primary', {}).catch(() => undefined);
            for (const call of mockFetchWithTimeout.mock.calls) {
                const u = new URL(String(call[0]));
                expect(u.pathname).toMatch(/^\/Items\/[^/]+\/Images\/Primary$/);
                // `..%2F` inside one segment is harmless; a bare `..` segment is not.
                expect(u.pathname.split('/')).not.toContain('..');
            }
        },
    );

    it('a normal 32-hex id is requested unchanged', async () => {
        const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
        const p = new JellyfinImageProvider() as unknown as PrivateProvider;
        await p.fetchJellyfinImage(id, 'Primary', {});
        expect(String(mockFetchWithTimeout.mock.calls[0][0])).toMatch(
            new RegExp(`^http://jellyfin\\.invalid/Items/${id}/Images/Primary\\?`),
        );
    });

    it('an unusable fallback id only loses that fallback step', async () => {
        const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
        mockFetchWithTimeout.mockImplementation(async () => new Response('', { status: 404 }));
        mockGetItemInfo.mockResolvedValue({ Type: 'Episode', SeriesId: '..' });
        const p = new JellyfinImageProvider() as unknown as PrivateProvider;
        await expect(p.fetchJellyfinImage(id, 'Primary', {})).rejects.toThrow('Image not found');
        for (const call of mockFetchWithTimeout.mock.calls) {
            expect(new URL(String(call[0])).pathname.split('/')).not.toContain('..');
        }
    });
});
