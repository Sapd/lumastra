// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout, guardedDefaultFetch } from './fetch-utils.js';
import {
    trackExternalCall,
    withExternalCallCounting,
    withExternalRequestCount,
} from './external-request-counter.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('counting at the HTTP transport', () => {
    it('counts redirects and retries, without double counting an outer client wrapper', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/b' } }))
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetch);
        const url = 'https://api.openai.com/a';
        const counts = await withExternalRequestCount(async () => {
            const wrapped = withExternalCallCounting(guardedDefaultFetch);
            await wrapped(url);
            await wrapped(url);
        });
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(counts.total).toBe(3);
        expect(counts.errorsByHost.get('api.openai.com')).toBe(1);
    });

    it('counts a rejected redirect as an error without inventing a request to its target', async () => {
        const fetch = vi.fn().mockResolvedValue(
            new Response(null, {
                status: 302,
                headers: { location: 'http://private.example/x' },
            }),
        );
        vi.stubGlobal('fetch', fetch);
        const counts = await withExternalRequestCount(async () => {
            await trackExternalCall('https://lrclib.net/a', () =>
                fetchWithTimeout('https://lrclib.net/a'),
            ).catch(() => undefined);
        });
        expect(fetch).toHaveBeenCalledOnce();
        expect(counts.total).toBe(1);
        expect(counts.errorsByHost.get('lrclib.net')).toBe(1);
    });

    it('preserves Request cancellation through the SDK default fetch', async () => {
        const controller = new AbortController();
        const fetch = vi.fn(async (_url: string, init: RequestInit) => {
            expect(init.signal?.aborted).toBe(true);
            throw new DOMException('cancelled', 'AbortError');
        });
        vi.stubGlobal('fetch', fetch);
        controller.abort();
        const request = new Request('https://api.openai.com/a', { signal: controller.signal });
        const counts = await withExternalRequestCount(async () => {
            await withExternalCallCounting(guardedDefaultFetch)(request).catch(() => undefined);
        });
        expect(fetch).toHaveBeenCalledOnce();
        expect(counts.errorsByHost.size).toBe(0);
    });
});
