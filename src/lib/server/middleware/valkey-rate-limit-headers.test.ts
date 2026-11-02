// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the budget headers that endpoints calling `checkRateLimit`
 * directly attach to their SUCCESS responses.
 *
 * The point of the feature is that a client can pace itself BEFORE it trips
 * the limit, so "the headers are present on a 200" is the contract — not an
 * implementation detail.
 */

import { describe, test, expect } from 'vitest';
import { json } from '@sveltejs/kit';
import { rateLimitHeaders, withRateLimitHeaders } from './valkey-rate-limit.js';

const RESULT = { total: 60, remaining: 57, resetAt: 1_800_000_000 };

describe('rateLimitHeaders', () => {
    test('uses the same header names the middleware already emits', () => {
        expect(rateLimitHeaders(RESULT)).toEqual({
            'X-RateLimit-Limit': '60',
            'X-RateLimit-Remaining': '57',
            'X-RateLimit-Reset': '1800000000',
        });
    });

    test('a fully-consumed budget reports 0 rather than omitting the header', () => {
        expect(rateLimitHeaders({ ...RESULT, remaining: 0 })['X-RateLimit-Remaining']).toBe('0');
    });
});

describe('withRateLimitHeaders', () => {
    test('attaches the budget to a success response without disturbing its body', async () => {
        const res = withRateLimitHeaders(json({ ok: true }), RESULT);
        expect(res.status).toBe(200);
        expect(res.headers.get('X-RateLimit-Remaining')).toBe('57');
        await expect(res.json()).resolves.toEqual({ ok: true });
    });

    test('preserves headers the handler already set (e.g. ETag)', () => {
        const res = withRateLimitHeaders(json({ a: 1 }, { headers: { ETag: '"abc"' } }), RESULT);
        expect(res.headers.get('ETag')).toBe('"abc"');
        expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    });

    test('keeps a 204 body-less', async () => {
        // Re-wrapping a 204 with a non-null body would make it invalid.
        const res = withRateLimitHeaders(new Response(null, { status: 204 }), RESULT);
        expect(res.status).toBe(204);
        expect(res.headers.get('X-RateLimit-Reset')).toBe('1800000000');
        await expect(res.text()).resolves.toBe('');
    });

    test('falls back to a re-wrap when the headers are immutable', async () => {
        const immutable = new Response('payload', {
            status: 200,
            headers: new Proxy(new Headers(), {
                get(target, prop) {
                    if (prop === 'set') {
                        return () => {
                            throw new TypeError('immutable');
                        };
                    }
                    const v = Reflect.get(target, prop);
                    return typeof v === 'function' ? v.bind(target) : v;
                },
            }),
        });
        const res = withRateLimitHeaders(immutable, RESULT);
        expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
        await expect(res.text()).resolves.toBe('payload');
    });
});
