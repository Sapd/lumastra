// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for fetch-timeout.ts fetchWithTimeout.
 *
 * Covers timeout signal composition (existing behaviour) and the same-host
 * redirect policy added for the C29 fix-plan finding, corrected per fix-plan
 * ledger Task 11 / C22 fix round 1: a redirect Location must stay on the
 * same HOSTNAME as the requested URL, but scheme/port may change — subject
 * to the scheme only ever being equal or UPGRADED (http -> https), never
 * downgraded. A cross-host redirect, or a same-host scheme downgrade, is
 * refused before the target is ever contacted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FetchRedirectError, fetchWithTimeout } from './fetch-timeout';

describe('fetchWithTimeout', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockFetch = vi.fn();
        global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns a successful response', async () => {
        const mockResponse = new Response('ok', { status: 200 });
        mockFetch.mockResolvedValueOnce(mockResponse);

        const result = await fetchWithTimeout('https://example.com');
        expect(result.status).toBe(200);
        expect(await result.text()).toBe('ok');
    });

    it('passes a combined abort signal through to fetch', async () => {
        mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

        await fetchWithTimeout('https://example.com', {}, 5000);

        const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('issues the request with redirect:"manual"', async () => {
        mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

        await fetchWithTimeout('https://example.com/api');

        const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(options.redirect).toBe('manual');
    });

    it('accepts a URL object', async () => {
        mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

        await fetchWithTimeout(new URL('https://example.com/api'));

        expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/api');
    });
});

describe('fetchWithTimeout — redirect policy (C29)', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    function redirectResponse(location: string): Response {
        return new Response(null, { status: 302, headers: { location } });
    }

    beforeEach(() => {
        mockFetch = vi.fn();
        global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('follows a same-origin redirect', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse('https://example.com/other'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        const res = await fetchWithTimeout('https://example.com/api');

        expect(await res.text()).toBe('final');
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[1][0]).toBe('https://example.com/other');
    });

    it('follows a same-origin relative redirect', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse('/other-path'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        await fetchWithTimeout('https://example.com/api');

        expect(mockFetch.mock.calls[1][0]).toBe('https://example.com/other-path');
    });

    it('throws FetchRedirectError on a cross-origin redirect and never requests the target', async () => {
        mockFetch.mockResolvedValueOnce(redirectResponse('http://127.0.0.1:9999/'));

        await expect(fetchWithTimeout('https://example.com/api')).rejects.toBeInstanceOf(
            FetchRedirectError,
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('follows a same-host redirect to a DIFFERENT PORT (same scheme)', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse('https://example.com:8443/other'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        const res = await fetchWithTimeout('https://example.com/api');

        expect(await res.text()).toBe('final');
        expect(mockFetch.mock.calls[1][0]).toBe('https://example.com:8443/other');
    });

    it('follows a same-host scheme UPGRADE (http -> https)', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse('https://example.com/other'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        const res = await fetchWithTimeout('http://example.com/api');

        expect(await res.text()).toBe('final');
        expect(mockFetch.mock.calls[1][0]).toBe('https://example.com/other');
    });

    it('refuses a same-host scheme DOWNGRADE (https -> http)', async () => {
        mockFetch.mockResolvedValueOnce(redirectResponse('http://example.com/other'));

        await expect(fetchWithTimeout('https://example.com/api')).rejects.toBeInstanceOf(
            FetchRedirectError,
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws after exceeding the redirect hop limit', async () => {
        for (let i = 0; i < 10; i++) {
            mockFetch.mockResolvedValueOnce(redirectResponse('https://example.com/loop'));
        }

        await expect(fetchWithTimeout('https://example.com/api')).rejects.toThrow(/redirect/i);
        expect(mockFetch).toHaveBeenCalledTimes(6);
    });

    it('returns the response as-is when a 3xx has no Location header', async () => {
        mockFetch.mockResolvedValueOnce(new Response(null, { status: 304 }));

        const res = await fetchWithTimeout('https://example.com/api');
        expect(res.status).toBe(304);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

// Final fix wave (2026-09-13): an intermediate 3xx response's body is never
// read — the redirect target is what gets fetched next — but undici keeps
// the underlying connection open until the body is consumed or explicitly
// cancelled. A redirect chain of any length used to accumulate open
// connections instead of releasing them back to the pool.
describe('fetchWithTimeout — intermediate 3xx body is cancelled (undici connection release)', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    function redirectResponseWithBody(location: string, status = 302): Response {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
            },
        });
        return new Response(stream, { status, headers: { location } });
    }

    beforeEach(() => {
        mockFetch = vi.fn();
        global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('cancels the intermediate redirect response body before following it', async () => {
        const intermediate = redirectResponseWithBody('https://example.com/other');
        const cancelSpy = vi.spyOn(intermediate.body!, 'cancel');
        mockFetch
            .mockResolvedValueOnce(intermediate)
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        await fetchWithTimeout('https://example.com/api');

        expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT cancel the FINAL (non-redirect) response body', async () => {
        const finalRes = new Response('final', { status: 200 });
        const cancelSpy = vi.spyOn(finalRes.body!, 'cancel');
        mockFetch.mockResolvedValueOnce(finalRes);

        const res = await fetchWithTimeout('https://example.com/api');

        expect(cancelSpy).not.toHaveBeenCalled();
        expect(await res.text()).toBe('final');
    });

    it('cancels the intermediate body before throwing on a cross-origin redirect', async () => {
        const intermediate = redirectResponseWithBody('http://127.0.0.1:9999/');
        const cancelSpy = vi.spyOn(intermediate.body!, 'cancel');
        mockFetch.mockResolvedValueOnce(intermediate);

        await expect(fetchWithTimeout('https://example.com/api')).rejects.toBeInstanceOf(
            FetchRedirectError,
        );
        expect(cancelSpy).toHaveBeenCalledTimes(1);
    });
});

describe('fetchWithTimeout — redirect method/body semantics (RFC 7231 §6.4)', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    function redirectResponse(status: number, location: string): Response {
        return new Response(null, { status, headers: { location } });
    }

    beforeEach(() => {
        mockFetch = vi.fn();
        global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('303: converts a POST to GET, drops the body and body-related headers', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse(303, 'https://example.com/other'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        await fetchWithTimeout('https://example.com/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Custom': 'keep-me' },
            body: JSON.stringify({ a: 1 }),
        });

        const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(secondInit.method).toBe('GET');
        expect(secondInit.body).toBeUndefined();
        const headers = new Headers(secondInit.headers);
        expect(headers.has('content-type')).toBe(false);
        expect(headers.get('x-custom')).toBe('keep-me');
    });

    it('301/302: converts a POST to GET and drops the body', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse(301, 'https://example.com/other'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        await fetchWithTimeout('https://example.com/api', {
            method: 'POST',
            body: 'payload',
        });

        const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(secondInit.method).toBe('GET');
        expect(secondInit.body).toBeUndefined();
    });

    it('301/302 on a GET request: method stays GET (no-op downgrade)', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse(302, 'https://example.com/other'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        await fetchWithTimeout('https://example.com/api', { method: 'GET' });

        const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(secondInit.method).toBe('GET');
    });

    it('307/308: preserves method and body', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse(307, 'https://example.com/other'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        await fetchWithTimeout('https://example.com/api', {
            method: 'POST',
            body: 'payload',
        });

        const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(secondInit.method).toBe('POST');
        expect(secondInit.body).toBe('payload');
    });

    it('307/308 with a ReadableStream body: refuses rather than resending an empty body', async () => {
        mockFetch.mockResolvedValueOnce(redirectResponse(307, 'https://example.com/other'));
        const stream = new ReadableStream();

        await expect(
            fetchWithTimeout('https://example.com/api', {
                method: 'POST',
                body: stream,
                // @ts-expect-error — duplex is required by undici for a stream body but not in the lib.dom RequestInit type
                duplex: 'half',
            }),
        ).rejects.toBeInstanceOf(FetchRedirectError);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});
