// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for src/routes/api/person/search/+server.ts
 *
 * Covers:
 *   - The exported GET handler is wrapped by withSearchRateLimit (the distributed
 *     Valkey-backed middleware), NOT the old in-memory throttle. We assert this
 *     by mocking withSearchRateLimit to a spy and verifying the exported GET is
 *     the product of that call (not the raw inner handler).
 *   - When the rate-limit cap is exceeded the route returns 429.
 *   - When the rate-limit is not exceeded the inner handler is called.
 *   - The inner handler returns 400 when name is absent.
 *   - The inner handler uses the cache and skips the TMDB fetch on a hit.
 *
 * All external I/O (TMDB fetch, cacheManager, config, Logger) is mocked so
 * tests run without network or Valkey.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module-level captures ─────────────────────────────────────────────────────
// capturedInnerHandler holds the personSearchHandler passed to withSearchRateLimit
// so we can call it directly in some assertions.
let capturedInnerHandler: (event: RequestEvent) => Promise<Response>;
let rateLimitAllowed = true;

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

const mockWithSearchRateLimit = vi.fn();

vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    withSearchRateLimit: mockWithSearchRateLimit,
    checkRateLimit: vi.fn(),
    withValkeyRateLimit: vi.fn(() => (handler: unknown) => handler),
}));

const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();

vi.mock('$lib/server/cache', () => ({
    cacheManager: {
        for: () => ({
            get: (...args: unknown[]) => mockCacheGet(...args),
            set: (...args: unknown[]) => mockCacheSet(...args),
        }),
    },
    CACHE_NAMESPACES: {
        personDetails: 'personDetails',
    },
}));

vi.mock('$lib/server/config', () => ({
    config: {
        TMDB_API_KEY: 'fake-tmdb-key',
    },
    features: {},
    FEATURE_PER_TASK_QUEUES: false,
    FEATURE_AUDIT_TAMPER_EVIDENCE: false,
    FEATURE_PIPELINE_EVENT_OUTBOX: false,
    FEATURE_PLUGIN_WORKER_ISOLATION: false,
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

vi.mock('$lib/server/middleware/error-handler', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

vi.mock('$lib/server/utils/typed-response', () => ({
    typedJson: (_schema: unknown, data: unknown) =>
        new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }),
}));

vi.mock('$lib/server/utils/api-responses', () => ({
    ApiResponses: {
        badRequest: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
        error: (msg: string, _err: unknown, status: number) =>
            new Response(JSON.stringify({ error: msg }), { status }),
        notFound: (resource: string) =>
            new Response(JSON.stringify({ error: `${resource} not found` }), { status: 404 }),
        rateLimited: (_resetTime?: number) =>
            new Response(JSON.stringify({ error: 'Rate limited' }), { status: 429 }),
    },
}));

// ── Configure the withSearchRateLimit spy BEFORE importing the module ─────────
//
// The module executes `export const GET = withSearchRateLimit(personSearchHandler)`
// at init time, so the mock must be set up before the dynamic import below.
//
// Strategy:
//   - Capture the inner handler passed to withSearchRateLimit.
//   - Return a wrapper that checks `rateLimitAllowed` to decide 429 or call-through.
mockWithSearchRateLimit.mockImplementation(
    (innerHandler: (event: RequestEvent) => Promise<Response>) => {
        capturedInnerHandler = innerHandler;
        return async (event: RequestEvent): Promise<Response> => {
            if (!rateLimitAllowed) {
                return new Response(JSON.stringify({ error: 'Rate limited' }), {
                    status: 429,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return innerHandler(event);
        };
    },
);

// ── Import module AFTER mocks ─────────────────────────────────────────────────

const serverModule = await import('./+server.js');
const { GET } = serverModule;

// Snapshot the module-init wrap count HERE, at import time. Vitest 5 clears
// mock call history between the collection phase (where this top-level import
// runs) and the execution phase, so reading `.mock.calls` inside a test reports
// 0 even though the call happened — verified: 1 immediately after this import,
// 0 inside the test body. The captured number is what the assertion below means.
const wrapCallsAtModuleInit = mockWithSearchRateLimit.mock.calls.length;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(name?: string): RequestEvent {
    const url = new URL('http://localhost/api/person/search');
    if (name) url.searchParams.set('name', name);

    return {
        url,
        params: {},
        route: { id: '/api/person/search' as const },
        request: new Request(url.toString()),
        locals: {
            user: { username: 'alice', userId: 'usr_1' },
        },
        cookies: {} as RequestEvent['cookies'],
        // The handler uses global fetch (not event.fetch); we mock globalThis.fetch
        // in beforeEach. event.fetch is only here for RequestEvent type conformance.
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

// ── Global fetch mock ─────────────────────────────────────────────────────────
// The handler uses `fetch` (global) directly, not `event.fetch`.
// We replace it with a vi.fn() so tests don't hit the real TMDB network.

const mockGlobalFetch = vi.fn();
const realFetch = globalThis.fetch;

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    // Reset call counts + clear all queued mock implementations, then re-set defaults.
    mockCacheGet.mockReset();
    mockCacheSet.mockReset();
    mockGlobalFetch.mockReset();
    rateLimitAllowed = true;
    mockCacheGet.mockResolvedValue(null); // cache miss by default
    mockCacheSet.mockResolvedValue(undefined);
    // Install global fetch mock with a successful TMDB response.
    globalThis.fetch = mockGlobalFetch;
    mockGlobalFetch.mockResolvedValue(
        new Response(
            JSON.stringify({
                results: [{ id: 287, name: 'Bram Fenwick', profile_path: '/img.jpg' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('person/search route — withSearchRateLimit wrapping', () => {
    it('withSearchRateLimit is called once at module init to wrap the inner handler', () => {
        // The module already executed — the wrap must have happened exactly once.
        expect(wrapCallsAtModuleInit).toBe(1);
    });

    it('the exported GET differs from the captured inner handler (it is the wrapper)', () => {
        // GET is the wrapper; capturedInnerHandler is the raw personSearchHandler.
        expect(typeof GET).toBe('function');
        // They must be distinct objects (GET is the output of withSearchRateLimit).
        expect(GET).not.toBe(capturedInnerHandler);
    });

    it('calls through to the inner handler when the rate limit is not exceeded', async () => {
        rateLimitAllowed = true;

        const event = makeEvent('Bram Fenwick');
        const res = await GET(event);

        expect(res.status).toBe(200);
        const body = await res.clone().json();
        expect(body.personId).toBe(287);
        expect(body.name).toBe('Bram Fenwick');
    });

    it('returns 429 when the rate limit is exceeded (distributed limiter fires)', async () => {
        rateLimitAllowed = false;

        const event = makeEvent('Bram Fenwick');
        const res = await GET(event);

        expect(res.status).toBe(429);
        // Global fetch must NOT have been called (rate limiter short-circuited).
        expect(mockGlobalFetch).not.toHaveBeenCalled();
    });
});

describe('person/search route — inner handler contract', () => {
    it('returns 422 when the name parameter is absent', async () => {
        rateLimitAllowed = true;

        // Call the raw inner handler directly to isolate the "no name" branch.
        const event = makeEvent(); // no name
        const res = await capturedInnerHandler(event);

        expect(res.status).toBe(422);
    });

    it('returns 422 when the name parameter is blank', async () => {
        rateLimitAllowed = true;

        const event = makeEvent('   ');
        const res = await capturedInnerHandler(event);

        expect(res.status).toBe(422);
    });

    it('returns a cache hit without calling the TMDB fetch', async () => {
        rateLimitAllowed = true;
        const cachedResult = { personId: 99, name: 'Cached Person', images: {} };
        mockCacheGet.mockResolvedValue(cachedResult);

        const event = makeEvent('Cached Person');
        const res = await GET(event);

        expect(res.status).toBe(200);
        const body = await res.clone().json();
        expect(body).toEqual(cachedResult);
        // Global fetch must NOT have been called — cache was hit.
        expect(mockGlobalFetch).not.toHaveBeenCalled();
    });

    it('stores the result in the cache after a TMDB fetch', async () => {
        rateLimitAllowed = true;
        mockCacheGet.mockResolvedValue(null); // cache miss

        const event = makeEvent('Bram Fenwick');
        await GET(event);

        expect(mockCacheSet).toHaveBeenCalledOnce();
        const [, storedValue] = mockCacheSet.mock.calls[0];
        expect(storedValue.personId).toBe(287);
    });
});
