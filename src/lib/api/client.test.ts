// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the core typed API client (apiFetch and friends).
 */

import { PlaybackPreferencesResponseSchema } from '$lib/schemas/api-user-responses';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

// Mutable env state so individual tests can flip `browser`/`dev` — the
// mocked module exposes them as getters so live bindings picked up by
// client.ts stay in sync with this object.
const envState = { browser: false, dev: false };

vi.mock('$app/environment', () => ({
    get browser() {
        return envState.browser;
    },
    get dev() {
        return envState.dev;
    },
}));

const mockMonitoredFetch = vi.fn();
const mockHandleAuthExpiration = vi.fn();

vi.mock('$lib/auth-monitor.js', () => ({
    monitoredFetch: (...args: unknown[]) => mockMonitoredFetch(...args),
    handleAuthExpiration: (...args: unknown[]) => mockHandleAuthExpiration(...args),
}));

const mockContractReport = vi.hoisted(() => vi.fn());
vi.mock('./contract-reporter.js', () => ({ reportApiContractMismatch: mockContractReport }));
const mockFailureReport = vi.hoisted(() => vi.fn());
vi.mock('$lib/client-diagnostics/web-reporter.js', () => ({ reportApiFailure: mockFailureReport }));

const { apiGet, ApiContractError, isApiContractStrict, setApiContractStrictForTests } =
    await import('./client.js');

function jsonResponse(body: unknown, status: number, contentType = 'application/json'): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': contentType },
    });
}

describe('apiFetch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Exercise the production fail-open contract independently of the Vitest build flag.
        setApiContractStrictForTests(false);
        envState.browser = false;
        envState.dev = false;
    });

    afterEach(() => {
        setApiContractStrictForTests(undefined);
        vi.restoreAllMocks();
    });

    it('forwards playback-preference keepalive options through the user adapter to fetch', async () => {
        const { updatePlaybackPreferences } = await import('./user.js');
        mockMonitoredFetch.mockResolvedValue(
            jsonResponse(
                PlaybackPreferencesResponseSchema.parse({
                    audioLanguage: 'en',
                    subtitleLanguage: null,
                    subtitlesEnabled: true,
                    forcedSubtitlesEnabled: true,
                    subtitleStyle: null,
                    qualityMode: 'original',
                    maxBitrateBps: null,
                    preferredResolution: null,
                    autoplayNextEpisode: true,
                    skipIntroAutomatically: false,
                    skipCreditsAutomatically: false,
                    nextEpisodeCountdownSecondsDefault: 15,
                }),
                200,
            ),
        );
        const result = await updatePlaybackPreferences(
            { audioLanguage: 'en' },
            { keepalive: true },
        );
        expect(result.error).toBeNull();
        expect(mockMonitoredFetch).toHaveBeenCalledWith(
            '/api/me/playback-preferences',
            expect.objectContaining({
                method: 'PATCH',
                body: JSON.stringify({ audioLanguage: 'en' }),
                keepalive: true,
            }),
            expect.any(Object),
        );
    });

    describe('Retry-After propagation', () => {
        it.each([
            ['7', 7000],
            ['Fri, 23 Oct 2026 12:00:07 GMT', 7000],
        ])('preserves rate-limit Retry-After %s for player retries', async (header, delay) => {
            vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T12:00:00Z'));
            const response = new Response(JSON.stringify({ code: 'rate_limited', error: 'Busy' }), {
                status: 429,
                headers: { 'Content-Type': 'application/problem+json', 'Retry-After': header },
            });
            mockMonitoredFetch.mockResolvedValue(response);
            const result = await apiGet('/probe', z.unknown());
            expect(result.status).toBe(429);
            expect(result.retryAfterMs).toBe(delay);
        });
        it('preserves Retry-After when a proxy sends a non-JSON 429', async () => {
            mockMonitoredFetch.mockResolvedValue(
                new Response('Busy', {
                    status: 429,
                    headers: { 'Retry-After': '5' },
                }),
            );
            expect((await apiGet('/probe', z.unknown())).retryAfterMs).toBe(5000);
        });
        it('uses the problem retryAfter when no header is available', async () => {
            mockMonitoredFetch.mockResolvedValue(
                jsonResponse(
                    {
                        code: 'rate_limited',
                        error: 'Busy',
                        retryAfter: 3,
                    },
                    429,
                    'application/problem+json',
                ),
            );
            expect((await apiGet('/probe', z.unknown())).retryAfterMs).toBe(3000);
        });
    });

    describe('[H2] fail-open on schema mismatch + prod observability', () => {
        const schema = z.object({ id: z.string(), name: z.string() });

        it('returns raw data with validationError set and error null (fail-open preserved)', async () => {
            const rawData = { id: '1' }; // missing required "name"
            mockMonitoredFetch.mockResolvedValue(jsonResponse(rawData, 200));

            const result = await apiGet('/things/1', schema);

            expect(result.error).toBeNull();
            expect(result.data).toEqual(rawData);
            expect(result.validationError).toBeDefined();
            expect(result.status).toBe(200);
            expect(mockContractReport).toHaveBeenCalledWith(
                '/things/1',
                'GET',
                200,
                result.validationError,
            );
        });

        it('strict: fails closed with an error instead of the raw payload', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockMonitoredFetch.mockResolvedValue(jsonResponse({ id: '1' }, 200));

            const result = await apiGet('/things/1', schema, { strict: true });

            expect(result.data).toBeNull();
            expect(result.error).toBeTruthy();
            expect(result.code).toBe('SCHEMA_MISMATCH');
            expect(result.validationError).toBeDefined();
            expect(result.status).toBe(200);
        });

        it('strict: an undeclared top-level field (version skew) also fails closed', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockMonitoredFetch.mockResolvedValue(
                jsonResponse({ id: '1', name: 'a', addedByNewerServer: true }, 200),
            );
            const result = await apiGet('/things/1', schema, { strict: true });
            expect(result.data).toBeNull();
            expect(result.code).toBe('SCHEMA_MISMATCH');
        });

        it('strict: a matching payload is returned as usual', async () => {
            mockMonitoredFetch.mockResolvedValue(jsonResponse({ id: '1', name: 'a' }, 200));
            const result = await apiGet('/things/1', schema, { strict: true });
            expect(result).toMatchObject({ data: { id: '1', name: 'a' }, error: null });
        });

        it('fires a prod-safe signal (console.warn) even outside dev/browser', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            envState.browser = false;
            envState.dev = false;

            const rawData = { id: '1' };
            mockMonitoredFetch.mockResolvedValue(jsonResponse(rawData, 200));

            await apiGet('/things/prod-signal', schema);

            expect(warnSpy).toHaveBeenCalledTimes(1);
            const [message] = warnSpy.mock.calls[0] as [string, unknown];
            expect(message).toContain('/things/prod-signal');
            expect(message).toContain('schema mismatch');
            // Must not leak the raw payload into the log line itself.
            expect(message).not.toContain('"id":"1"');
        });

        it('throttles repeated prod-safe warnings for the same endpoint', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const rawData = { id: '1' };
            mockMonitoredFetch.mockResolvedValue(jsonResponse(rawData, 200));

            await apiGet('/things/throttled', schema);
            await apiGet('/things/throttled', schema);
            await apiGet('/things/throttled', schema);

            expect(warnSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('[L1] parseErrorResponse / checkAuthErrorInBody', () => {
        it('problem+json code=unauthorized on an ok response triggers handleAuthExpiration', async () => {
            envState.browser = true;
            mockMonitoredFetch.mockResolvedValue(
                jsonResponse(
                    { code: 'unauthorized', error: 'nope' },
                    200,
                    'application/problem+json',
                ),
            );

            await apiGet('/things/auth', z.unknown());

            expect(mockHandleAuthExpiration).toHaveBeenCalledTimes(1);
        });

        it('problem+json missing code does not trigger handleAuthExpiration', async () => {
            envState.browser = true;
            mockMonitoredFetch.mockResolvedValue(
                jsonResponse(
                    { error: 'some resource-level denial' },
                    200,
                    'application/problem+json',
                ),
            );

            await apiGet('/things/no-code', z.unknown());

            expect(mockHandleAuthExpiration).not.toHaveBeenCalled();
        });

        it('legacy 200 {error:"Authentication required"} triggers handleAuthExpiration', async () => {
            envState.browser = true;
            mockMonitoredFetch.mockResolvedValue(
                jsonResponse({ error: 'Authentication required' }, 200, 'application/json'),
            );

            await apiGet('/things/legacy-auth', z.unknown());

            expect(mockHandleAuthExpiration).toHaveBeenCalledTimes(1);
        });

        it('problem+json error message precedence: detail > error > title > HTTP {status}', async () => {
            mockMonitoredFetch.mockResolvedValue(
                jsonResponse(
                    { detail: 'the detail', error: 'the error', title: 'the title' },
                    400,
                    'application/problem+json',
                ),
            );
            const detailResult = await apiGet('/things/precedence-detail', z.unknown());
            expect(detailResult.error).toBe('the detail');

            mockMonitoredFetch.mockResolvedValue(
                jsonResponse(
                    { error: 'the error', title: 'the title' },
                    400,
                    'application/problem+json',
                ),
            );
            const errorResult = await apiGet('/things/precedence-error', z.unknown());
            expect(errorResult.error).toBe('the error');

            mockMonitoredFetch.mockResolvedValue(
                jsonResponse({ title: 'the title' }, 400, 'application/problem+json'),
            );
            const titleResult = await apiGet('/things/precedence-title', z.unknown());
            expect(titleResult.error).toBe('the title');

            mockMonitoredFetch.mockResolvedValue(jsonResponse({}, 400, 'application/problem+json'));
            const fallbackResult = await apiGet('/things/precedence-fallback', z.unknown());
            expect(fallbackResult.error).toBe('HTTP 400');
        });
    });

    describe('[L8] abort listener cleanup on shared signal', () => {
        it('adds and removes exactly one abort listener per call on a long-lived shared signal', async () => {
            const controller = new AbortController();
            const addSpy = vi.spyOn(controller.signal, 'addEventListener');
            const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

            mockMonitoredFetch.mockResolvedValue(jsonResponse({ ok: true }, 200));

            const schema = z.object({ ok: z.boolean() });
            const callCount = 25;
            for (let i = 0; i < callCount; i++) {
                await apiGet('/things/shared-signal', schema, { signal: controller.signal });
            }

            expect(addSpy).toHaveBeenCalledTimes(callCount);
            expect(removeSpy).toHaveBeenCalledTimes(callCount);
        });
    });

    describe('in-flight GET coalescing', () => {
        const schema = z.object({ ok: z.boolean() });

        it('coalesces two concurrent identical GETs into ONE network request', async () => {
            let resolveFetch!: (r: Response) => void;
            mockMonitoredFetch.mockReturnValue(
                new Promise<Response>((res) => {
                    resolveFetch = res;
                }),
            );

            const p1 = apiGet('/things/coalesce', schema);
            const p2 = apiGet('/things/coalesce', schema);
            resolveFetch(jsonResponse({ ok: true }, 200));
            const [r1, r2] = await Promise.all([p1, p2]);

            expect(mockMonitoredFetch).toHaveBeenCalledTimes(1);
            expect(r1.data).toEqual({ ok: true });
            expect(r2.data).toEqual({ ok: true });
        });

        it('does NOT coalesce concurrent GETs to different URLs', async () => {
            mockMonitoredFetch.mockResolvedValue(jsonResponse({ ok: true }, 200));
            await Promise.all([apiGet('/things/a', schema), apiGet('/things/b', schema)]);
            expect(mockMonitoredFetch).toHaveBeenCalledTimes(2);
        });

        it('does NOT coalesce sequential GETs (entry evicted once settled)', async () => {
            mockMonitoredFetch.mockResolvedValue(jsonResponse({ ok: true }, 200));
            await apiGet('/things/seq', schema);
            await apiGet('/things/seq', schema);
            expect(mockMonitoredFetch).toHaveBeenCalledTimes(2);
        });

        it('opts out of coalescing when the caller supplies an abort signal', async () => {
            mockMonitoredFetch.mockResolvedValue(jsonResponse({ ok: true }, 200));
            const controller = new AbortController();
            await Promise.all([
                apiGet('/things/sig', schema, { signal: controller.signal }),
                apiGet('/things/sig', schema, { signal: controller.signal }),
            ]);
            expect(mockMonitoredFetch).toHaveBeenCalledTimes(2);
        });
    });
    // -----------------------------------------------------------------------
    // toStrict — undeclared fields must be REPORTED, not silently deleted
    //
    // The old implementation gated on `_def.unknownKeys === 'strip'`, a Zod 3
    // discriminator. On the installed Zod 4 that property is `undefined`, so
    // `.strict()` was never applied and an undeclared field was dropped from the
    // parsed result with no warning at all. These cases pin the observable
    // consequence rather than the internals.
    // -----------------------------------------------------------------------

    describe('undeclared response fields', () => {
        beforeEach(() => {
            envState.dev = false;
            mockMonitoredFetch.mockReset();
        });

        it('reports an extra top-level field instead of stripping it', async () => {
            const schema = z.object({ username: z.string() });
            mockMonitoredFetch.mockResolvedValue(
                jsonResponse({ username: 'a', positionMs: 700000 }, 200),
            );

            const res = await apiGet('/strict/extra', schema);

            expect(res.validationError).toBeDefined();
            // Fail-open hands back the RAW body, so the undeclared field survives
            // for a caller that wants it — the old path deleted it outright.
            expect(res.data).toEqual({ username: 'a', positionMs: 700000 });
        });

        it('accepts a body that matches the schema exactly', async () => {
            const schema = z.object({ username: z.string() });
            mockMonitoredFetch.mockResolvedValue(jsonResponse({ username: 'a' }, 200));

            const res = await apiGet('/strict/exact', schema);

            expect(res.validationError).toBeUndefined();
            expect(res.data).toEqual({ username: 'a' });
        });

        it('leaves a passthrough schema permissive', async () => {
            // `.passthrough()` is an explicit "extras are expected here"; making it
            // strict would turn every such endpoint into a permanent mismatch.
            const schema = z.object({ username: z.string() }).passthrough();
            mockMonitoredFetch.mockResolvedValue(jsonResponse({ username: 'a', extra: 1 }, 200));

            const res = await apiGet('/strict/passthrough', schema);

            expect(res.validationError).toBeUndefined();
            expect(res.data).toEqual({ username: 'a', extra: 1 });
        });

        it('does not choke on a non-object response schema', async () => {
            const schema = z.array(z.string());
            mockMonitoredFetch.mockResolvedValue(jsonResponse(['a', 'b'], 200));

            const res = await apiGet('/strict/array', schema);

            expect(res.validationError).toBeUndefined();
            expect(res.data).toEqual(['a', 'b']);
        });

        it('MEASURED LIMIT: a nested extra field is still stripped silently', async () => {
            // `.strict()` in Zod 4 constrains the outer object only. This is not
            // the behaviour we want, it is the behaviour we have — recorded so the
            // next person does not read `toStrict` as protecting item shapes. The
            // real protection for nested shapes is sharing ONE schema with the
            // server instead of keeping a private copy.
            const schema = z.object({ activities: z.array(z.object({ username: z.string() })) });
            mockMonitoredFetch.mockResolvedValue(
                jsonResponse({ activities: [{ username: 'a', positionMs: 700000 }] }, 200),
            );

            const res = await apiGet('/strict/nested', schema);

            expect(res.validationError).toBeUndefined();
            expect(res.data).toEqual({ activities: [{ username: 'a' }] });
        });
    });
});

describe('build contract strictness', () => {
    afterEach(() => setApiContractStrictForTests(undefined));

    it('is enabled by the vitest define', () => {
        setApiContractStrictForTests(undefined);
        expect(isApiContractStrict()).toBe(true);
    });

    it.each([undefined, true])(
        'throws with JSON issues even for strict=%s callers',
        async (strict) => {
            setApiContractStrictForTests(true);
            mockMonitoredFetch.mockResolvedValue(jsonResponse({}, 200));
            await expect(
                apiGet('/api/media/123?secret=x', z.object({ name: z.string() }), { strict }),
            ).rejects.toMatchObject({
                name: 'ApiContractError',
                endpoint: '/api/media/:id',
                method: 'GET',
                status: 200,
                issues: [{ path: 'name', message: expect.any(String) }],
            });
        },
    );

    it('throws ApiContractError for incompatible 204 schemas', async () => {
        setApiContractStrictForTests(true);
        mockMonitoredFetch.mockResolvedValue(new Response(null, { status: 204 }));
        await expect(apiGet('/api/things', z.object({ name: z.string() }))).rejects.toBeInstanceOf(
            ApiContractError,
        );
    });

    it('preserves both non-strict-build behaviors for 204 mismatches', async () => {
        setApiContractStrictForTests(false);
        mockMonitoredFetch.mockResolvedValue(new Response(null, { status: 204 }));
        const schema = z.object({ name: z.string() });
        expect(await apiGet('/api/things', schema)).toMatchObject({
            data: null,
            error: null,
            status: 204,
            validationError: expect.anything(),
        });
        expect(await apiGet('/api/things', schema, { strict: true })).toMatchObject({
            data: null,
            code: 'SCHEMA_MISMATCH',
            status: 204,
        });
    });

    it('limits the exposed issues to five', async () => {
        setApiContractStrictForTests(true);
        mockMonitoredFetch.mockResolvedValue(jsonResponse([1, 2, 3, 4, 5, 6], 200));
        try {
            await apiGet('/api/things', z.array(z.string()));
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(ApiContractError);
            expect((error as { issues: unknown[] }).issues).toHaveLength(5);
        }
    });
});

describe('apiFetch failure diagnostics', () => {
    const schema = z.object({ ok: z.boolean() });
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reports a problem+json failure with its code and request id', async () => {
        mockMonitoredFetch.mockResolvedValue(
            jsonResponse(
                { code: 'bad_gateway', error: 'Upstream failed', status: 502, requestId: 'req-42' },
                502,
                'application/problem+json',
            ),
        );
        await apiGet('/api/things/1', schema, { params: { q: 'private search' } });
        expect(mockFailureReport).toHaveBeenCalledWith({
            endpoint: '/api/things/1?q=private+search',
            method: 'GET',
            outcome: 'status_5xx',
            status: 502,
            problemCode: 'bad_gateway',
            requestId: 'req-42',
        });
    });

    it('reports a 4xx as status_4xx', async () => {
        mockMonitoredFetch.mockResolvedValue(jsonResponse({ error: 'nope' }, 404));
        await apiGet('/api/things/2', schema);
        expect(mockFailureReport).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'status_4xx', status: 404 }),
        );
    });

    it('leaves a 401 to the re-auth flow', async () => {
        mockMonitoredFetch.mockResolvedValue(
            jsonResponse(
                { code: 'unauthorized', error: 'x', status: 401 },
                401,
                'application/problem+json',
            ),
        );
        await apiGet('/api/things/3', schema);
        expect(mockFailureReport).not.toHaveBeenCalled();
    });

    it('does not report a request the caller aborted, but reports our timeout', async () => {
        mockMonitoredFetch.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () =>
                        reject(new DOMException('aborted', 'AbortError')),
                    );
                }),
        );
        const caller = new AbortController();
        const pending = apiGet('/api/things/4', schema, { signal: caller.signal });
        caller.abort();
        await pending;
        expect(mockFailureReport).not.toHaveBeenCalled();

        await apiGet('/api/things/5', schema, { timeout: 5 });
        expect(mockFailureReport).toHaveBeenCalledWith({
            endpoint: '/api/things/5',
            method: 'GET',
            outcome: 'timeout',
        });
    });

    it('reports a 2xx with a non-JSON body as decode, and a code bug not at all', async () => {
        mockMonitoredFetch.mockResolvedValue(
            new Response('<html>proxy error</html>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
            }),
        );
        await apiGet('/api/things/7', schema);
        expect(mockFailureReport).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'decode', detail: 'invalid JSON' }),
        );
        mockFailureReport.mockClear();
        mockMonitoredFetch.mockRejectedValue(new RangeError('a bug, not the network'));
        await apiGet('/api/things/8', schema);
        expect(mockFailureReport).not.toHaveBeenCalled();
    });

    it('reports a network error', async () => {
        mockMonitoredFetch.mockRejectedValue(new TypeError('Failed to fetch'));
        await apiGet('/api/things/6', schema);
        expect(mockFailureReport).toHaveBeenCalledWith({
            endpoint: '/api/things/6',
            method: 'GET',
            outcome: 'network',
        });
    });
});

describe('Live TV setup request budget', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setApiContractStrictForTests(false);
        envState.browser = false;
        envState.dev = false;
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        setApiContractStrictForTests(undefined);
    });
    it.each(['create', 'update'])(
        'waits for a valid slow provider during source %s',
        async (operation) => {
            const { createLiveTvSource, updateLiveTvSource } = await import('./livetv.js');
            mockMonitoredFetch.mockImplementation(
                (_url: unknown, init: RequestInit) =>
                    new Promise<Response>((resolve, reject) => {
                        setTimeout(
                            () =>
                                resolve(
                                    jsonResponse(
                                        {
                                            source: {
                                                id: 'slow-source',
                                                name: 'Provider',
                                                sourceType: 'm3u',
                                                maxStreams: 1,
                                            },
                                        },
                                        200,
                                    ),
                                ),
                            45_000,
                        );
                        init.signal?.addEventListener(
                            'abort',
                            () => reject(new DOMException('aborted', 'AbortError')),
                            { once: true },
                        );
                    }),
            );
            const pending =
                operation === 'create'
                    ? createLiveTvSource({
                          name: 'Provider',
                          sourceType: 'm3u',
                          m3uUrl: 'http://provider.example/list',
                      })
                    : updateLiveTvSource('slow-source', {
                          xmltvUrl: 'http://provider.example/epg',
                      });
            await vi.advanceTimersByTimeAsync(45_000);
            expect((await pending).data?.source.id).toBe('slow-source');
        },
    );
});
