// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Valkey-based rate limiting middleware
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runImageEncode } from '$lib/server/services/image-proxy/encode';
import { requireImageProviderBudget } from '$lib/server/services/image-proxy/work-budget';
import { config } from '$lib/server/config';
import { signUrl, verifySignedUrl } from '$lib/server/utils/signed-url';
import { toUserId } from '$lib/shared/user-id.js';
import type { RequestEvent } from '@sveltejs/kit';
import {
    checkRateLimit,
    IMAGE_PROXY_RATE_LIMIT,
    IMAGE_ENCODE_RATE_LIMIT,
    withImageProxyRateLimit,
    RateLimitPresets,
    withValkeyRateLimit,
    getRateLimitStats,
} from './valkey-rate-limit';

// Counter for unique test keys to avoid collisions with shared memoryStore
let testKeyCounter = 0;
const getUniqueKey = () => `test-key-${testKeyCounter++}-${Date.now()}`;

// Override shape for the mock RequestEvent builder. `locals` is deep-partial
// (unlike `Partial<RequestEvent>`, which keeps `locals` as the full `App.Locals`)
// so tests can supply just `{ user }` without the other required Locals fields.
type MockEventOverrides = Partial<Omit<RequestEvent, 'locals'>> & {
    locals?: Partial<App.Locals>;
};

function mockUser(username: string): App.Locals['user'] {
    return {
        userId: toUserId(randomUUID()),
        username,
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    };
}

// Helper to create a mock RequestEvent
function createMockEvent(overrides: MockEventOverrides = {}): RequestEvent {
    const mockUrl = new URL('http://localhost/api/test');

    return {
        url: mockUrl,
        params: {},
        route: { id: '/api/test' },
        request: new Request(mockUrl),
        locals: { user: { username: 'testuser', groups: [] } },
        getClientAddress: () => '192.168.1.1',
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => {},
            delete: () => {},
            serialize: () => '',
        },
        fetch: vi.fn(),
        platform: undefined,
        setHeaders: vi.fn(),
        isDataRequest: false,
        isSubRequest: false,
        ...overrides,
    } as unknown as RequestEvent;
}

// Helper to create a mock handler
function createMockHandler(response: Response = new Response('OK', { status: 200 })) {
    return vi.fn().mockResolvedValue(response);
}

describe('checkRateLimit', () => {
    it('should allow first request', async () => {
        const key = getUniqueKey();
        const result = await checkRateLimit(key, 10, 60);

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(9);
        expect(result.total).toBe(10);
        expect(result.resetAt).toBeGreaterThan(0);
    });

    it('should track request count within window', async () => {
        const key = getUniqueKey();

        // First request
        const result1 = await checkRateLimit(key, 5, 60);
        expect(result1.remaining).toBe(4);

        // Second request
        const result2 = await checkRateLimit(key, 5, 60);
        expect(result2.remaining).toBe(3);

        // Third request
        const result3 = await checkRateLimit(key, 5, 60);
        expect(result3.remaining).toBe(2);
    });

    it('should block requests exceeding limit', async () => {
        const key = getUniqueKey();
        const limit = 3;

        // Use up all requests
        await checkRateLimit(key, limit, 60);
        await checkRateLimit(key, limit, 60);
        await checkRateLimit(key, limit, 60);

        // Fourth request should be blocked
        const result = await checkRateLimit(key, limit, 60);
        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);
    });

    it('should return correct remaining count', async () => {
        const key = getUniqueKey();
        const limit = 5;

        const result = await checkRateLimit(key, limit, 60);
        expect(result.remaining).toBe(limit - 1);
        expect(result.total).toBe(limit);
    });

    it('should calculate resetAt correctly', async () => {
        const key = getUniqueKey();
        const windowSeconds = 60;
        const beforeCall = Math.floor(Date.now() / 1000);

        const result = await checkRateLimit(key, 10, windowSeconds);

        const expectedReset = (Math.floor(beforeCall / windowSeconds) + 1) * windowSeconds;
        // Allow small variance due to timing
        expect(Math.abs(result.resetAt - expectedReset)).toBeLessThanOrEqual(1);
    });

    it('should handle very small window sizes', async () => {
        const key = getUniqueKey();
        const result = await checkRateLimit(key, 1, 1);

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(0);
    });

    it('should handle large limits', async () => {
        const key = getUniqueKey();
        const result = await checkRateLimit(key, 10000, 60);

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(9999);
        expect(result.total).toBe(10000);
    });

    it('should use unique key per request type', async () => {
        const key1 = getUniqueKey();
        const key2 = getUniqueKey();

        // Use up key1
        await checkRateLimit(key1, 1, 60);
        const result1 = await checkRateLimit(key1, 1, 60);
        expect(result1.allowed).toBe(false);

        // key2 should still be allowed
        const result2 = await checkRateLimit(key2, 1, 60);
        expect(result2.allowed).toBe(true);
    });
});

describe('image encode budgets', () => {
    it('enforces the CPU limit in legacy wrappers while a cached response remains free', async () => {
        const event = createMockEvent({ locals: {}, getClientAddress: () => '192.0.2.245' });
        const policy = IMAGE_ENCODE_RATE_LIMIT;
        for (let i = 0; i < policy.limit(event); i++) {
            await checkRateLimit(policy.keyBy(event), policy.limit(event), policy.windowSec);
        }
        const cached = withImageProxyRateLimit(async () => new Response('cached cover'));
        expect((await cached(event)).status).toBe(200);
        const encode = vi.fn(async () => Buffer.from('encoded'));
        const miss = withImageProxyRateLimit(async () => {
            await runImageEncode(encode);
            return new Response('cover');
        });
        expect((await miss(event)).status).toBe(429);
        expect(encode).not.toHaveBeenCalled();
    });

    it('passes the request AbortSignal through legacy image budget scopes', async () => {
        const controller = new AbortController();
        const event = createMockEvent({
            request: new Request('http://localhost/image', { signal: controller.signal }),
        });
        const encode = vi.fn(async () => undefined);
        const handler = withImageProxyRateLimit(async () => {
            await runImageEncode(encode);
            return new Response();
        });
        controller.abort();
        await expect(handler(event)).rejects.toMatchObject({ name: 'AbortError' });
        expect(encode).not.toHaveBeenCalled();
    });

    it('uses 300/min for valid signed URLs, verified user when present and IP otherwise', () => {
        const secret = vi
            .spyOn(config, 'JWT_SECRET', 'get')
            .mockReturnValue('image-budget-test-secret');
        try {
            const signed = new URL(
                signUrl('/api/v1/media/cover/images/poster', { expiresIn: 60, purpose: 'image' }),
                'https://app.test',
            );
            expect(verifySignedUrl(signed, 'image').valid).toBe(true);
            const event = createMockEvent({
                url: signed,
                locals: {},
                getClientAddress: () => '192.0.2.201',
            });
            expect(IMAGE_ENCODE_RATE_LIMIT.limit(event)).toBe(300);
            expect(IMAGE_ENCODE_RATE_LIMIT.keyBy(event)).toBe('image-encode:ip:192.0.2.201');
            signed.searchParams.set('userId', 'forged-owner');
            signed.searchParams.set('tokenId', 'forged-token');
            expect(verifySignedUrl(signed, 'image').valid).toBe(true);
            expect(IMAGE_ENCODE_RATE_LIMIT.keyBy(event)).toBe('image-encode:ip:192.0.2.201');
            // HMAC URLs contain no identity claims. An independently verified
            // request principal is usable; arbitrary query parameters are not.
            event.locals.user = mockUser('verified-owner');
            expect(IMAGE_ENCODE_RATE_LIMIT.keyBy(event)).toBe(
                `image-encode:user:${event.locals.user.userId}`,
            );
            expect(IMAGE_ENCODE_RATE_LIMIT.limit(event)).toBe(300);
            event.locals.principal = {
                userId: toUserId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
                username: 'verified-owner',
            } as App.Locals['principal'];
            expect(IMAGE_ENCODE_RATE_LIMIT.keyBy(event)).toBe(
                'image-encode:user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            );
            signed.searchParams.delete('sig');
            expect(IMAGE_ENCODE_RATE_LIMIT.limit(event)).toBe(1000);
        } finally {
            secret.mockRestore();
        }
    });

    it.each([false, true])(
        'uses a separate bounded CPU counter (authenticated=%s)',
        async (authenticated) => {
            const event = createMockEvent({
                locals: authenticated ? { user: mockUser(getUniqueKey()) } : {},
            });
            const policy = IMAGE_ENCODE_RATE_LIMIT;
            const limit = policy.limit(event);
            expect(limit).toBe(authenticated ? 1000 : 300);
            expect(policy.windowSec).toBe(60);
            expect(policy.keyBy(event)).toMatch(
                authenticated ? /^image-encode:user:/ : /^image-encode:ip:/,
            );
            expect(policy.keyBy(event)).not.toBe(IMAGE_PROXY_RATE_LIMIT.keyBy(event));
            const key = `${policy.keyBy(event)}:${getUniqueKey()}`;
            for (let i = 0; i < limit; i++) {
                expect((await checkRateLimit(key, limit, 60)).allowed).toBe(true);
            }
            expect((await checkRateLimit(key, limit, 60)).allowed).toBe(false);
        },
    );
});

describe('image provider budgets', () => {
    it('legacy wrappers leave local responses free after the provider budget is exhausted', async () => {
        const event = createMockEvent({ locals: {}, getClientAddress: () => '192.0.2.244' });
        const policy = IMAGE_PROXY_RATE_LIMIT;
        const key = policy.keyBy(event);
        for (let i = 0; i < policy.limit(event); i++) {
            await checkRateLimit(key, policy.limit(event), 60);
        }
        const local = withImageProxyRateLimit(async () => new Response('local cover'));
        expect((await local(event)).status).toBe(200);
        const upstream = vi.fn();
        const provider = withImageProxyRateLimit(async () => {
            await requireImageProviderBudget();
            upstream();
            return new Response('upstream');
        });
        const response = await provider(event);
        expect(response.status).toBe(429);
        expect(response.headers.get('X-RateLimit-Limit')).toBe('300');
        expect(upstream).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'enforces the upstream threshold (authenticated=%s)',
        async (authenticated) => {
            vi.useFakeTimers();
            try {
                const event = createMockEvent({
                    locals: authenticated ? { user: mockUser(getUniqueKey()) } : {},
                });
                const limit = IMAGE_PROXY_RATE_LIMIT.limit(event);
                expect(limit).toBe(authenticated ? 2000 : 300);
                const key = `${IMAGE_PROXY_RATE_LIMIT.keyBy(event)}:${getUniqueKey()}`;
                for (let i = 0; i < limit; i++) {
                    expect((await checkRateLimit(key, limit, 60)).allowed).toBe(true);
                }
                expect((await checkRateLimit(key, limit, 60)).allowed).toBe(false);
                await vi.advanceTimersByTimeAsync(60_000);
                expect((await checkRateLimit(key, limit, 60)).allowed).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        },
    );
});

describe('RateLimitPresets', () => {
    it('should have AI_EMBEDDINGS preset with strict limits', () => {
        expect(RateLimitPresets.AI_EMBEDDINGS).toEqual({
            limit: 5,
            windowSeconds: 60,
        });
    });

    it('should have AI_SUGGESTIONS preset', () => {
        expect(RateLimitPresets.AI_SUGGESTIONS).toEqual({
            limit: 30,
            windowSeconds: 60,
        });
    });

    it('should have SEARCH preset', () => {
        expect(RateLimitPresets.SEARCH).toEqual({
            limit: 60,
            windowSeconds: 60,
        });
    });

    it('should have IMAGE_PROXY preset with higher limit', () => {
        // Anonymous upstream work keeps the 300/min IP budget.
        expect(RateLimitPresets.IMAGE_PROXY).toEqual({
            limit: 300,
            windowSeconds: 60,
        });
    });

    it('should have STANDARD preset', () => {
        expect(RateLimitPresets.STANDARD).toEqual({
            limit: 100,
            windowSeconds: 60,
        });
    });

    it('should have STRICT preset', () => {
        expect(RateLimitPresets.STRICT).toEqual({
            limit: 10,
            windowSeconds: 60,
        });
    });

    it('should have ADMIN_HEAVY preset', () => {
        expect(RateLimitPresets.ADMIN_HEAVY).toEqual({
            limit: 30,
            windowSeconds: 60,
        });
    });

    it('should be readonly', () => {
        // TypeScript ensures this at compile time, but we can verify structure
        const presets = RateLimitPresets;
        expect(Object.keys(presets)).toHaveLength(7);
    });

    it('should have AI_EMBEDDINGS as the most restrictive', () => {
        const limits = Object.values(RateLimitPresets).map((p) => p.limit);
        expect(Math.min(...limits)).toBe(RateLimitPresets.AI_EMBEDDINGS.limit);
    });
});

describe('withValkeyRateLimit middleware', () => {
    it('should allow requests within limit', async () => {
        const uniqueIp = `10.0.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
        const handler = createMockHandler();
        const middleware = withValkeyRateLimit(100, 60);
        const wrappedHandler = middleware(handler);

        const event = createMockEvent({
            getClientAddress: () => uniqueIp,
        });

        const response = await wrappedHandler(event);

        expect(response.status).toBe(200);
        expect(handler).toHaveBeenCalledWith(event);
    });

    it('should add rate limit headers to response', async () => {
        const uniqueIp = `10.1.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
        const handler = createMockHandler();
        const middleware = withValkeyRateLimit(100, 60);
        const wrappedHandler = middleware(handler);

        const event = createMockEvent({
            getClientAddress: () => uniqueIp,
        });

        const response = await wrappedHandler(event);

        expect(response.headers.get('X-RateLimit-Limit')).toBe('100');
        expect(response.headers.get('X-RateLimit-Remaining')).toBeDefined();
        expect(response.headers.get('X-RateLimit-Reset')).toBeDefined();
    });

    it('should block requests exceeding limit with 429', async () => {
        const uniqueIp = `10.2.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
        const handler = createMockHandler();
        const middleware = withValkeyRateLimit(2, 60);
        const wrappedHandler = middleware(handler);

        const event = createMockEvent({
            getClientAddress: () => uniqueIp,
        });

        // Use up limit
        await wrappedHandler(event);
        await wrappedHandler(event);

        // Third request should be blocked
        const response = await wrappedHandler(event);

        expect(response.status).toBe(429);
        expect(handler).toHaveBeenCalledTimes(2); // Only called for allowed requests
    });

    it('should include rate limit headers on 429 response', async () => {
        const uniqueIp = `10.3.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
        const handler = createMockHandler();
        const middleware = withValkeyRateLimit(1, 60);
        const wrappedHandler = middleware(handler);

        const event = createMockEvent({
            getClientAddress: () => uniqueIp,
        });

        await wrappedHandler(event); // Use up limit
        const response = await wrappedHandler(event); // Should be blocked

        expect(response.status).toBe(429);
        expect(response.headers.get('X-RateLimit-Limit')).toBe('1');
        expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
        expect(response.headers.get('X-RateLimit-Reset')).toBeDefined();
    });

    it('should use custom key generator when provided', async () => {
        const handler = createMockHandler();
        const customKeyGenerator = (event: RequestEvent) => `custom-${event.locals.user?.username}`;
        const middleware = withValkeyRateLimit(100, 60, customKeyGenerator);
        const wrappedHandler = middleware(handler);

        const event = createMockEvent({
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: 'customuser123',
                    groups: '',
                    userGroups: [],
                    hasWatchPermission: false,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });

        const response = await wrappedHandler(event);

        expect(response.status).toBe(200);
        expect(handler).toHaveBeenCalled();
    });

    it('should use default key with IP, username, and endpoint', async () => {
        const uniqueIp = `10.4.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
        const handler = createMockHandler();
        const middleware = withValkeyRateLimit(1, 60);
        const wrappedHandler = middleware(handler);

        // Two events with different usernames should have different keys
        const event1 = createMockEvent({
            getClientAddress: () => uniqueIp,
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: 'user1',
                    groups: '',
                    userGroups: [],
                    hasWatchPermission: false,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });

        const event2 = createMockEvent({
            getClientAddress: () => uniqueIp,
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: 'user2',
                    groups: '',
                    userGroups: [],
                    hasWatchPermission: false,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });

        await wrappedHandler(event1); // Use up user1's limit
        const response = await wrappedHandler(event2); // user2 should still be allowed

        expect(response.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should use anonymous for users without username', async () => {
        const uniqueIp = `10.5.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
        const handler = createMockHandler();
        const middleware = withValkeyRateLimit(100, 60);
        const wrappedHandler = middleware(handler);

        const event = createMockEvent({
            getClientAddress: () => uniqueIp,
            locals: {}, // No user
        });

        const response = await wrappedHandler(event);

        expect(response.status).toBe(200);
    });

    it('should use default values when no parameters provided', async () => {
        const uniqueIp = `10.6.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
        const handler = createMockHandler();
        const middleware = withValkeyRateLimit(); // No params = defaults
        const wrappedHandler = middleware(handler);

        const event = createMockEvent({
            getClientAddress: () => uniqueIp,
        });

        const response = await wrappedHandler(event);

        expect(response.status).toBe(200);
        expect(response.headers.get('X-RateLimit-Limit')).toBe('100'); // Default limit
    });

    it('should preserve handler response body', async () => {
        const uniqueIp = `10.7.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
        const expectedBody = JSON.stringify({ data: 'test' });
        const handler = createMockHandler(
            new Response(expectedBody, {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        const middleware = withValkeyRateLimit(100, 60);
        const wrappedHandler = middleware(handler);

        const event = createMockEvent({
            getClientAddress: () => uniqueIp,
        });

        const response = await wrappedHandler(event);
        const body = await response.text();

        expect(body).toBe(expectedBody);
    });

    it('should preserve original response headers', async () => {
        const uniqueIp = `10.8.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
        const handler = createMockHandler(
            new Response('OK', {
                status: 200,
                headers: {
                    'X-Custom-Header': 'custom-value',
                    'Content-Type': 'text/plain',
                },
            }),
        );
        const middleware = withValkeyRateLimit(100, 60);
        const wrappedHandler = middleware(handler);

        const event = createMockEvent({
            getClientAddress: () => uniqueIp,
        });

        const response = await wrappedHandler(event);

        expect(response.headers.get('X-Custom-Header')).toBe('custom-value');
        expect(response.headers.get('Content-Type')).toBe('text/plain');
    });

    it('should decrement remaining count correctly', async () => {
        const uniqueIp = `10.9.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
        const handler = createMockHandler();
        const middleware = withValkeyRateLimit(5, 60);
        const wrappedHandler = middleware(handler);

        const event = createMockEvent({
            getClientAddress: () => uniqueIp,
        });

        const response1 = await wrappedHandler(event);
        expect(response1.headers.get('X-RateLimit-Remaining')).toBe('4');

        const response2 = await wrappedHandler(event);
        expect(response2.headers.get('X-RateLimit-Remaining')).toBe('3');

        const response3 = await wrappedHandler(event);
        expect(response3.headers.get('X-RateLimit-Remaining')).toBe('2');
    });

    // security review 2026-09-12, C13
    describe('strict option (default key builder)', () => {
        it('rotating X-Forwarded-For from the SAME peer collapses into ONE bucket when strict:true', async () => {
            const uniquePeer = `10.20.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
            const handler = createMockHandler();
            const middleware = withValkeyRateLimit(2, 60, undefined, { strict: true });
            const wrappedHandler = middleware(handler);

            const mockUrl = new URL('http://localhost/api/test');
            const makeEvent = (xff: string) =>
                createMockEvent({
                    getClientAddress: () => uniquePeer,
                    locals: {},
                    request: new Request(mockUrl, { headers: { 'x-forwarded-for': xff } }),
                });

            // Two requests exhaust the limit, each with a DIFFERENT X-Forwarded-For.
            await wrappedHandler(makeEvent('198.51.100.1'));
            await wrappedHandler(makeEvent('198.51.100.2'));
            // A third request with yet another X-Forwarded-For must still be
            // blocked — proving all three shared one bucket keyed on the real
            // peer, not on the attacker-rotated header.
            const response = await wrappedHandler(makeEvent('198.51.100.3'));

            expect(response.status).toBe(429);
            expect(handler).toHaveBeenCalledTimes(2);
        });

        it('without strict, rotating X-Forwarded-For from the same peer gets a FRESH bucket per request (implicit trust)', async () => {
            const uniquePeer = `10.21.${Math.floor(testKeyCounter / 256)}.${testKeyCounter++ % 256}`;
            const handler = createMockHandler();
            const middleware = withValkeyRateLimit(1, 60); // no strict option
            const wrappedHandler = middleware(handler);

            const mockUrl = new URL('http://localhost/api/test');
            const makeEvent = (xff: string) =>
                createMockEvent({
                    getClientAddress: () => uniquePeer,
                    locals: {},
                    request: new Request(mockUrl, { headers: { 'x-forwarded-for': xff } }),
                });

            await wrappedHandler(makeEvent('198.51.100.10'));
            // Different XFF -> different bucket -> not rate-limited despite limit=1.
            const response = await wrappedHandler(makeEvent('198.51.100.11'));

            expect(response.status).toBe(200);
            expect(handler).toHaveBeenCalledTimes(2);
        });
    });
});

describe('getRateLimitStats', () => {
    it('should return stats object with backend type', async () => {
        const stats = await getRateLimitStats();

        expect(stats).toHaveProperty('backend');
        expect(['valkey', 'memory']).toContain(stats.backend);
    });

    it('should return memory entry count', async () => {
        const stats = await getRateLimitStats();

        expect(stats).toHaveProperty('memoryEntries');
        expect(typeof stats.memoryEntries).toBe('number');
        expect(stats.memoryEntries).toBeGreaterThanOrEqual(0);
    });

    it('should return memory backend when Valkey unavailable', async () => {
        // In test environment, Valkey is typically not available
        const stats = await getRateLimitStats();

        // Since we don't have Valkey in tests, it should be memory
        expect(stats.backend).toBe('memory');
    });

    it('should track memory entries after rate limit checks', async () => {
        // Make some rate limit checks to populate memory store
        const key = getUniqueKey();
        await checkRateLimit(key, 10, 60);

        const stats = await getRateLimitStats();

        // Should have at least one entry from our check
        expect(stats.memoryEntries).toBeGreaterThan(0);
    });
});

describe('Rate limit edge cases', () => {
    it('should handle concurrent requests correctly', async () => {
        const key = getUniqueKey();
        const limit = 10;

        // Make concurrent requests
        const promises = Array.from({ length: 15 }, () => checkRateLimit(key, limit, 60));

        const results = await Promise.all(promises);

        // First 10 should be allowed
        const allowedCount = results.filter((r) => r.allowed).length;
        const blockedCount = results.filter((r) => !r.allowed).length;

        expect(allowedCount).toBe(10);
        expect(blockedCount).toBe(5);
    });

    it('should handle empty key', async () => {
        const result = await checkRateLimit('', 10, 60);

        expect(result.allowed).toBe(true);
        expect(result.total).toBe(10);
    });

    it('should handle special characters in key', async () => {
        const key = `test:special/chars?query=1&foo=bar#hash`;
        const result = await checkRateLimit(key, 10, 60);

        expect(result.allowed).toBe(true);
    });

    it('should handle unicode in key', async () => {
        const key = `user-测试-пользователь-${getUniqueKey()}`;
        const result = await checkRateLimit(key, 10, 60);

        expect(result.allowed).toBe(true);
    });

    it('should handle very long keys', async () => {
        const key = 'a'.repeat(1000) + `-${getUniqueKey()}`;
        const result = await checkRateLimit(key, 10, 60);

        expect(result.allowed).toBe(true);
    });

    it('should handle limit of 0', async () => {
        const key = getUniqueKey();

        // First request in a new window is always allowed (sliding window behavior)
        const result1 = await checkRateLimit(key, 0, 60);
        expect(result1.allowed).toBe(true);

        // Second request exceeds limit of 0
        const result2 = await checkRateLimit(key, 0, 60);
        expect(result2.allowed).toBe(false);
        expect(result2.remaining).toBe(0);
    });

    it('should handle limit of 1', async () => {
        const key = getUniqueKey();

        const result1 = await checkRateLimit(key, 1, 60);
        expect(result1.allowed).toBe(true);
        expect(result1.remaining).toBe(0);

        const result2 = await checkRateLimit(key, 1, 60);
        expect(result2.allowed).toBe(false);
    });
});

describe('Rate limit window behavior', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should reset after window expires', async () => {
        const key = getUniqueKey();
        const windowSeconds = 10;

        // Use up limit
        await checkRateLimit(key, 1, windowSeconds);
        const blocked = await checkRateLimit(key, 1, windowSeconds);
        expect(blocked.allowed).toBe(false);

        // Advance time past window
        vi.advanceTimersByTime(windowSeconds * 1000 + 1000);

        // Should be allowed in new window
        const newWindow = await checkRateLimit(key, 1, windowSeconds);
        expect(newWindow.allowed).toBe(true);
    });
});
