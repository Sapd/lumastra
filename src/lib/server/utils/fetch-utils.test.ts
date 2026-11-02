// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for fetch-utils
 *
 * Tests timeout behavior, error handling, JSON parsing, abort signal propagation,
 * and constant values.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    FetchTimeoutError,
    FetchRedirectError,
    fetchWithTimeout,
    fetchJsonWithTimeout,
    guardedDefaultFetch,
    TIMEOUTS,
} from './fetch-utils';

describe('FetchTimeoutError', () => {
    it('has correct message format', () => {
        const error = new FetchTimeoutError('https://example.com/test', 5000);
        expect(error.message).toBe('Request to https://example.com/test timed out after 5000ms');
    });

    it('has name property set to FetchTimeoutError', () => {
        const error = new FetchTimeoutError('https://example.com', 1000);
        expect(error.name).toBe('FetchTimeoutError');
    });

    it('is an instance of Error', () => {
        const error = new FetchTimeoutError('https://example.com', 1000);
        expect(error).toBeInstanceOf(Error);
    });
});

describe('fetchWithTimeout', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        mockFetch = vi.fn((_url: RequestInfo | URL, options: RequestInit = {}) => {
            return new Promise<Response>((_resolve, reject) => {
                const signal = options.signal as AbortSignal | undefined;
                if (signal) {
                    if (signal.aborted) {
                        const err = new Error('The operation was aborted');
                        err.name = 'AbortError';
                        reject(err);
                        return;
                    }
                    signal.addEventListener('abort', () => {
                        const err = new Error('The operation was aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                }
            });
        });
        global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('returns successful response correctly', async () => {
        const mockResponse = new Response('ok', { status: 200 });
        mockFetch.mockResolvedValueOnce(mockResponse);

        const result = await fetchWithTimeout('https://example.com');
        expect(result).toBe(mockResponse);
        expect(result.status).toBe(200);
        expect(await result.text()).toBe('ok');
    });

    it('throws FetchTimeoutError on timeout (not generic AbortError)', async () => {
        const promise = fetchWithTimeout('https://example.com', {}, 5000);
        vi.advanceTimersByTime(5000);

        await expect(promise).rejects.toBeInstanceOf(FetchTimeoutError);
        await expect(promise).rejects.toThrow(
            'Request to https://example.com timed out after 5000ms',
        );
    });

    it('propagates caller signal abort without converting to FetchTimeoutError', async () => {
        const controller = new AbortController();
        controller.abort();

        const promise = fetchWithTimeout('https://example.com', {
            signal: controller.signal,
        });

        await expect(promise).rejects.toBeInstanceOf(Error);
        await expect(promise).rejects.toHaveProperty('name', 'AbortError');
    });

    it('uses default timeout of 10000ms', async () => {
        const promise = fetchWithTimeout('https://example.com');
        vi.advanceTimersByTime(10000);

        await expect(promise).rejects.toThrow(
            'Request to https://example.com timed out after 10000ms',
        );
    });

    it('respects custom timeout', async () => {
        const promise = fetchWithTimeout('https://example.com', {}, 250);
        vi.advanceTimersByTime(250);

        await expect(promise).rejects.toThrow(
            'Request to https://example.com timed out after 250ms',
        );
    });

    it('merges options correctly', async () => {
        const mockResponse = new Response('ok', { status: 200 });
        mockFetch.mockResolvedValueOnce(mockResponse);

        await fetchWithTimeout('https://example.com/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ foo: 'bar' }),
        });

        const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(options.method).toBe('POST');
        expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(options.body).toBe(JSON.stringify({ foo: 'bar' }));
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('clears timeout on success so no timers leak', async () => {
        const mockResponse = new Response('ok', { status: 200 });
        mockFetch.mockResolvedValueOnce(mockResponse);

        await fetchWithTimeout('https://example.com', {}, 5000);
        expect(vi.getTimerCount()).toBe(0);
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

    it('issues the request with redirect:"manual"', async () => {
        mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

        await fetchWithTimeout('https://example.com/api');

        const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(options.redirect).toBe('manual');
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

    /**
     * Same-host redirect policy (fix-plan ledger, Task 11 standing policy):
     * "same-host redirects may change scheme and port; cross-host are
     * refused". A prior implementation refused ANY port change on the same
     * host, which was stricter than the ruled policy — fixed here with all
     * three directions covered explicitly.
     */
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
        // 1 initial + 5 hops = 6 requests before giving up
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
// read by anything — the redirect target is what gets fetched next — but
// undici keeps the underlying connection open until the body is either
// consumed or explicitly cancelled. A redirect chain of any length used to
// accumulate open connections instead of releasing them back to the pool.
describe('fetchWithTimeout — intermediate 3xx body is cancelled (undici connection release)', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    /** A redirect response with a REAL (non-null) body, so cancel() is observable. */
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

    it('does NOT cancel the FINAL (non-redirect) response body — the caller still reads it', async () => {
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

    it('cancels every intermediate body across a multi-hop redirect chain', async () => {
        const hop1 = redirectResponseWithBody('https://example.com/hop2');
        const hop2 = redirectResponseWithBody('https://example.com/hop3');
        const cancel1 = vi.spyOn(hop1.body!, 'cancel');
        const cancel2 = vi.spyOn(hop2.body!, 'cancel');
        mockFetch
            .mockResolvedValueOnce(hop1)
            .mockResolvedValueOnce(hop2)
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        await fetchWithTimeout('https://example.com/api');

        expect(cancel1).toHaveBeenCalledTimes(1);
        expect(cancel2).toHaveBeenCalledTimes(1);
    });

    it('is safe when the intermediate response has no body (null)', async () => {
        mockFetch
            .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/x' } }))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        await expect(fetchWithTimeout('https://example.com/api')).resolves.toBeDefined();
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

    it('301: converts a POST to GET and drops the body', async () => {
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

    it('302: converts a POST to GET and drops the body', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse(302, 'https://example.com/other'))
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

    it('307: preserves method and body', async () => {
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

    it('308: preserves method and body', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse(308, 'https://example.com/other'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));

        await fetchWithTimeout('https://example.com/api', {
            method: 'PUT',
            body: 'payload',
        });

        const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(secondInit.method).toBe('PUT');
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
        // Only the first hop was requested — the redirect target was never contacted.
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe('fetchJsonWithTimeout', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        mockFetch = vi.fn((_url: RequestInfo | URL, options: RequestInit = {}) => {
            return new Promise<Response>((_resolve, reject) => {
                const signal = options.signal as AbortSignal | undefined;
                if (signal) {
                    if (signal.aborted) {
                        const err = new Error('The operation was aborted');
                        err.name = 'AbortError';
                        reject(err);
                        return;
                    }
                    signal.addEventListener('abort', () => {
                        const err = new Error('The operation was aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                }
            });
        });
        global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('returns parsed JSON on success', async () => {
        const mockData = { id: 1, name: 'test' };
        const mockResponse = new Response(JSON.stringify(mockData), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
        mockFetch.mockResolvedValueOnce(mockResponse);

        const result = await fetchJsonWithTimeout<{ id: number; name: string }>(
            'https://api.example.com/data',
        );
        expect(result).toEqual(mockData);
    });

    it('throws on non-ok response with HTTP status in message', async () => {
        const mockResponse = new Response('Not Found', { status: 404 });
        mockFetch.mockResolvedValueOnce(mockResponse);

        await expect(fetchJsonWithTimeout('https://api.example.com/data')).rejects.toThrow(
            'HTTP 404: Not Found',
        );
    });

    it('calls fetchWithTimeout internally by forwarding timeout and options', async () => {
        const promise = fetchJsonWithTimeout('https://api.example.com', { method: 'POST' }, 100);
        vi.advanceTimersByTime(100);

        await expect(promise).rejects.toBeInstanceOf(FetchTimeoutError);
        await expect(promise).rejects.toThrow(
            'Request to https://api.example.com timed out after 100ms',
        );

        const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(options.method).toBe('POST');
    });
});

/**
 * `guardedDefaultFetch` is wired into both assistant chat SDKs
 * (openai-provider.ts / anthropic-provider.ts) via `fetch: guardedDefaultFetch`.
 * A non-streamed chat completion emits NO response headers until generation
 * finishes, so this MUST NOT inherit `fetchWithTimeout`'s short 10s
 * integration-call default — that would abort any generation slower than
 * 10s to first byte (routine with adaptive thinking), not just a genuinely
 * hung connection. Fix round 1, flagged by review.
 */
describe('guardedDefaultFetch — chat-generation timeout (fix round 1)', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    let pendingResolve: ((r: Response) => void) | undefined;

    beforeEach(() => {
        vi.useFakeTimers();
        pendingResolve = undefined;
        mockFetch = vi.fn((_url: RequestInfo | URL, options: RequestInit = {}) => {
            return new Promise<Response>((resolve, reject) => {
                pendingResolve = resolve;
                const signal = options.signal as AbortSignal | undefined;
                signal?.addEventListener('abort', () => {
                    const err = new Error('The operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });
        global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does NOT abort a slow (60s-to-first-byte) generation the way the 10s default would', async () => {
        const promise = guardedDefaultFetch('https://api.anthropic.com/v1/messages');
        // 60s elapsed with no response yet — under the pre-fix 10s default
        // this would already have aborted; under the fix (10 minutes) it
        // must still be waiting.
        await vi.advanceTimersByTimeAsync(60_000);
        pendingResolve?.(new Response('ok', { status: 200 }));

        const res = await promise;
        expect(res.status).toBe(200);
    });

    it('still has SOME ceiling — an unresponsive host beyond the chat budget is aborted', async () => {
        const promise = guardedDefaultFetch('https://api.anthropic.com/v1/messages');
        const assertion = expect(promise).rejects.toBeInstanceOf(FetchTimeoutError);
        // 10 minutes — CHAT_SDK_TIMEOUT_MS. Never resolved by the mock, so
        // this only settles via the timeout firing.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await assertion;
    });
});

describe('TIMEOUTS', () => {
    it('has correct values', () => {
        expect(TIMEOUTS.FAST).toBe(5000);
        expect(TIMEOUTS.DEFAULT).toBe(10000);
        expect(TIMEOUTS.MEDIUM).toBe(20000);
        expect(TIMEOUTS.SLOW).toBe(30000);
        expect(TIMEOUTS.BACKGROUND).toBe(60000);
    });
});
