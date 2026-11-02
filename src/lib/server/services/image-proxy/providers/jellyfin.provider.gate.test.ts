// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stopped or removed Jellyfin must cost the image proxy nothing.
 *
 * Asserted at the network seam (`fetchWithTimeout`) with the REAL runtime gate,
 * connection status and circuit breaker — the bug was a direct fetch that knew
 * about none of them and waited the 10 s default per uncached image.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const featureState = vi.hoisted(() => ({ jellyfinSync: true }));
vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return {
        ...actual,
        features: new Proxy(actual.features, {
            get: (target, prop: string) =>
                prop === 'jellyfinSync' ? featureState.jellyfinSync : target[prop as never],
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

// Behaves like the real fetchWithTimeout against a server that never answers:
// rejects with FetchTimeoutError once the caller's timeout elapses.
const mockFetchWithTimeout = vi.fn();
vi.mock('$lib/server/utils/fetch-utils.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/fetch-utils.js')>();
    return { ...actual, fetchWithTimeout: mockFetchWithTimeout };
});

const { FetchTimeoutError } = await import('$lib/server/utils/fetch-utils.js');
const { JellyfinImageProvider, JellyfinUnavailableError } = await import('./jellyfin.provider.js');
const { circuitBreaker } = await import('$lib/server/jellyfin/base-client.js');
const { connectionStatus } = await import('$lib/server/services/connection-status.service.js');

type PrivateProvider = {
    fetchJellyfinImage: (
        itemId: string,
        jellyfinType: string,
        options: Record<string, unknown>,
    ) => Promise<Buffer>;
};

function provider(): PrivateProvider {
    return new JellyfinImageProvider() as unknown as PrivateProvider;
}

function hangingFetch(_url: string, _init: unknown, timeout: number): Promise<Response> {
    return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new FetchTimeoutError(_url, timeout)), timeout);
    });
}

describe('JellyfinImageProvider — runtime Jellyfin gate', () => {
    beforeEach(() => {
        featureState.jellyfinSync = true;
        circuitBreaker.reset();
        connectionStatus.setConnected('jellyfin', { serverName: 'jf', version: '10' });
        mockGetItemInfo.mockReset().mockResolvedValue(null);
        mockFetchWithTimeout
            .mockReset()
            .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    });

    afterEach(() => {
        vi.useRealTimers();
        circuitBreaker.reset();
    });

    it('sync off: no request, even with URL + key set', async () => {
        featureState.jellyfinSync = false;
        await expect(
            provider().fetchJellyfinImage('a'.repeat(32), 'Primary', {}),
        ).rejects.toBeInstanceOf(JellyfinUnavailableError);
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();
        expect(mockGetItemInfo).not.toHaveBeenCalled();
    });

    it('breaker open: no request', async () => {
        for (let i = 0; i < 5; i++) circuitBreaker.recordFailure();
        expect(circuitBreaker.isOpen).toBe(true);

        await expect(
            provider().fetchJellyfinImage('a'.repeat(32), 'Primary', {}),
        ).rejects.toBeInstanceOf(JellyfinUnavailableError);
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('connection status disconnected: no request', async () => {
        connectionStatus.setDisconnected('jellyfin', 'down');
        await expect(
            provider().fetchJellyfinImage('a'.repeat(32), 'Primary', {}),
        ).rejects.toBeInstanceOf(JellyfinUnavailableError);
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('a hung Jellyfin costs the short timeout once, skips the fallback chain, then trips the breaker', async () => {
        vi.useFakeTimers();
        mockFetchWithTimeout.mockImplementation(hangingFetch);

        for (let i = 0; i < 5; i++) {
            const pending = provider().fetchJellyfinImage(`item-${i}`, 'Primary', {});
            const outcome = expect(pending).rejects.toBeInstanceOf(JellyfinUnavailableError);
            // 2.5 s — not the 10 s default — and no second fetch / item lookup.
            await vi.advanceTimersByTimeAsync(2_500);
            await outcome;
        }
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(5);
        for (const call of mockFetchWithTimeout.mock.calls) expect(call[2]).toBe(2_500);
        expect(mockGetItemInfo).not.toHaveBeenCalled();

        // Five transport failures opened the shared breaker and marked Jellyfin
        // unreachable (which starts the reconnect loop) …
        expect(circuitBreaker.isOpen).toBe(true);
        expect(connectionStatus.isJellyfinAvailable()).toBe(false);

        // … so the next uncached image does not even try.
        await expect(provider().fetchJellyfinImage('item-6', 'Primary', {})).rejects.toBeInstanceOf(
            JellyfinUnavailableError,
        );
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(5);
    });

    it('sync on + reachable: fetches as before (with the short timeout)', async () => {
        const buffer = await provider().fetchJellyfinImage('item-1', 'Primary', {});
        expect(Buffer.from(buffer)).toEqual(Buffer.from([1, 2, 3]));
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
        expect(mockFetchWithTimeout.mock.calls[0][0]).toContain(
            'http://jellyfin.invalid/Items/item-1/Images/Primary',
        );
        expect(mockFetchWithTimeout.mock.calls[0][2]).toBe(2_500);
        expect(mockFetchWithTimeout.mock.calls[0][1]).toEqual({
            headers: {
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="token"$/,
                ),
            },
        });
        expect(
            new URL(String(mockFetchWithTimeout.mock.calls[0][0])).searchParams.has('api_key'),
        ).toBe(false);
    });

    it('sync on + reachable + 404: still walks the fallback chain', async () => {
        mockFetchWithTimeout.mockResolvedValue(new Response(null, { status: 404 }));
        await expect(provider().fetchJellyfinImage('item-1', 'Primary', {})).rejects.toThrow(
            'Image not found',
        );
        expect(mockGetItemInfo).toHaveBeenCalledWith('item-1');
    });
});
