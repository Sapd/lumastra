// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const warn = vi.hoisted(() => vi.fn());
vi.mock('./logger.js', () => ({
    Logger: { for: () => ({ warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));
const customCommand = vi.hoisted(() => vi.fn());
const hmget = vi.hoisted(() => vi.fn());
const getCoordinationClient = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/cache/valkey.js', () => ({ getCoordinationClient }));
vi.mock('$lib/server/config.js', () => ({
    config: { JELLYFINURL: 'http://jellyfin.test:8096/base' },
}));
import {
    setProviderCallSink,
    emptyProviderCallCounts,
    flushProviderCalls,
    flushProviderCallsForShutdown,
    readProviderCalls,
    recordProviderCall,
    recordProviderCallForUrl,
    recordProviderRetry,
    withProviderCallScope,
} from './provider-calls.js';
import {
    countExternalCall,
    withExternalCallCounting,
    withExternalRequestCount,
} from './external-request-counter.js';
import { fetchWithTimeout } from './fetch-utils.js';
import { ProviderCallsResponseSchema } from '$lib/schemas/provider-calls.js';

beforeEach(async () => {
    await flushProviderCalls();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T23:59:00Z'));
    customCommand.mockReset().mockResolvedValue(1);
    hmget.mockReset().mockResolvedValue(Array(7).fill(null));
    getCoordinationClient.mockReset().mockReturnValue({ customCommand, hmget });
});
afterEach(async () => {
    setProviderCallSink(undefined);
    await flushProviderCalls();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function incrementFields(): Record<string, string> {
    const args = customCommand.mock.calls[0][0] as string[];
    expect(args.slice(2, 5)).toEqual(['1', 'pcalls:v1:tmdb:2026103123', '691200']);
    const fields: Record<string, string> = {};
    for (let i = 5; i < args.length; i += 2) fields[args[i]] = args[i + 1];
    return fields;
}

describe('provider HTTP counters', () => {
    it('relays isolated-thread observations without opening a local Valkey connection', async () => {
        const sink = vi.fn();
        setProviderCallSink(sink);
        recordProviderCall('tmdb', 429);
        recordProviderRetry('tmdb');
        await flushProviderCalls();
        expect(sink.mock.calls).toEqual([
            ['tmdb', 429, false, Date.now()],
            ['tmdb', null, true, Date.now()],
        ]);
        expect(customCommand).not.toHaveBeenCalled();
        sink.mockImplementation(() => {
            throw new Error('port closed');
        });
        expect(() => recordProviderCall('tmdb', 200)).not.toThrow();
        expect(() => recordProviderRetry('tmdb')).not.toThrow();
    });

    it('bounds pending keys at 512, preserves existing counters and aggregates drop logs once a minute', async () => {
        warn.mockClear();
        const now = Date.now();
        for (let i = 0; i < 512; i++) recordProviderCall('tmdb', 200, now + i * 3_600_000);
        recordProviderCall('tmdb', 429, now); // Existing bucket still accepts increments.
        recordProviderCall('tmdb', 429, now + 512 * 3_600_000);
        recordProviderRetry('tmdb', now + 513 * 3_600_000);
        recordProviderCall('tmdb', null, now + 514 * 3_600_000);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1]).toMatchObject({ dropped: 1, maxKeys: 512 });
        vi.setSystemTime(now + 60_000);
        recordProviderCall('tmdb', 200, now + 515 * 3_600_000);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[1][1]).toMatchObject({ dropped: 3, maxKeys: 512 });
        await flushProviderCalls();
        expect(customCommand).toHaveBeenCalledTimes(512);
        const first = customCommand.mock.calls[0][0] as string[];
        expect(first.slice(5)).toEqual([
            'requests',
            '2',
            'success2xx',
            '1',
            'client4xx',
            '1',
            'rateLimited429',
            '1',
        ]);
    });

    it('shares one in-flight batch instead of retaining queued batches behind a hung Valkey write', async () => {
        let release: () => void = () => {};
        customCommand.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        recordProviderCall('tmdb', 200);
        const first = flushProviderCalls();
        await Promise.resolve();
        try {
            for (let i = 0; i < 8; i++) {
                recordProviderCall('mdblist', 429);
                expect(flushProviderCalls()).toBe(first);
            }
            expect(customCommand).toHaveBeenCalledTimes(1);
        } finally {
            release();
            await first;
        }
        await flushProviderCalls();
        expect(customCommand).toHaveBeenCalledTimes(2);
        expect(customCommand.mock.calls[1][0].slice(5)).toEqual([
            'requests',
            '8',
            'client4xx',
            '8',
            'rateLimited429',
            '8',
        ]);
    });

    it('bounds shutdown flushing to 1.5 seconds and lets Valkey and DB cleanup continue', async () => {
        let release: () => void = () => {};
        customCommand.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        recordProviderCall('tmdb', 200);
        const closed: string[] = [];
        const cleanup = flushProviderCallsForShutdown().then(() => {
            closed.push('valkey', 'db');
        });
        try {
            await vi.advanceTimersByTimeAsync(1499);
            expect(closed).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            await cleanup;
            expect(closed).toEqual(['valkey', 'db']);
        } finally {
            release();
            await flushProviderCalls();
        }
        expect(vi.getTimerCount()).toBe(0);
    });

    it('drains pending observations after an in-flight flush when the shutdown budget permits', async () => {
        let release: () => void = () => {};
        customCommand.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        recordProviderCall('tmdb', 200);
        const first = flushProviderCalls();
        await Promise.resolve();
        recordProviderCall('mdblist', 429);
        const cleanup = flushProviderCallsForShutdown();
        release();
        await first;
        await cleanup;
        expect(customCommand).toHaveBeenCalledTimes(2);
        expect(customCommand.mock.calls[1][0][3]).toContain('mdblist');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the shutdown timeout when a flush finishes early', async () => {
        recordProviderCall('tmdb', 200);
        await flushProviderCallsForShutdown();
        expect(customCommand).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('counts each attempt and overlapping 429/4xx classes, never treating 3xx as 2xx', async () => {
        for (const status of [200, 299, 302, 400, 404, 429, 500, 599, null])
            recordProviderCall('tmdb', status);
        recordProviderRetry('tmdb');
        expect(customCommand).not.toHaveBeenCalled();
        await flushProviderCalls();
        expect(incrementFields()).toEqual({
            requests: '9',
            success2xx: '2',
            client4xx: '3',
            rateLimited429: '1',
            server5xx: '2',
            networkErrors: '1',
            retries: '1',
        });
        expect(customCommand.mock.calls[0][0][1]).toContain("redis.call('HINCRBY'");
        expect(customCommand.mock.calls[0][0][1]).toContain("redis.call('EXPIRE'");
    });

    it('uses UTC hours across a day boundary and sums aliases under a fixed provider', async () => {
        recordProviderCallForUrl('https://api.themoviedb.org/3/a?api_key=secret', 200);
        vi.setSystemTime(new Date('2026-11-01T00:01:00Z'));
        recordProviderCallForUrl('https://image.tmdb.org/a', 200);
        await flushProviderCalls();
        expect(customCommand.mock.calls.map(([args]) => args[3])).toEqual([
            'pcalls:v1:tmdb:2026103123',
            'pcalls:v1:tmdb:2026110100',
        ]);
        expect(JSON.stringify(customCommand.mock.calls)).not.toContain('secret');
    });

    it('swallows absent clients, rejected writes and synchronous client failures; later batches recover', async () => {
        getCoordinationClient.mockReturnValueOnce(null);
        recordProviderCall('tmdb', 200);
        await expect(flushProviderCalls()).resolves.toBeUndefined();
        customCommand.mockRejectedValueOnce(new Error('Valkey down'));
        recordProviderCall('tmdb', 429);
        await expect(flushProviderCalls()).resolves.toBeUndefined();
        getCoordinationClient.mockImplementationOnce(() => {
            throw new Error('client failed');
        });
        recordProviderCall('tmdb', null);
        await expect(flushProviderCalls()).resolves.toBeUndefined();
        recordProviderCall('tmdb', 200);
        await flushProviderCalls();
        expect(customCommand).toHaveBeenCalledTimes(2);
    });

    it('flushes automatically without awaiting the provider request', async () => {
        recordProviderCall('tmdb', 200);
        await vi.advanceTimersByTimeAsync(1000);
        expect(customCommand).toHaveBeenCalledOnce();
    });

    it('counts background and task-scoped traffic once through nested transport wrappers, including SDK retries', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 429 }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetch);
        const sdkFetch = withExternalCallCounting(
            (input, init) => fetchWithTimeout(String(input), init),
            'openai',
        );
        await withExternalRequestCount(async () => {
            await sdkFetch('https://custom-model.test/a');
            await sdkFetch('https://custom-model.test/a', {
                headers: { 'x-stainless-retry-count': '1' },
            });
        });
        countExternalCall('https://api.openai.com/a', 200);
        await flushProviderCalls();
        const args = customCommand.mock.calls[0][0] as string[];
        expect(args[3]).toBe('pcalls:v1:openai:2026103123');
        expect(args.slice(5)).toEqual([
            'requests',
            '3',
            'success2xx',
            '2',
            'client4xx',
            '1',
            'rateLimited429',
            '1',
            'retries',
            '1',
        ]);
    });

    it('counts retries performed by the real OpenAI SDK', async () => {
        const transport = vi
            .fn()
            .mockResolvedValueOnce(
                new Response('{}', { status: 429, headers: { 'retry-after-ms': '1' } }),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        data: [],
                        model: 'test',
                        usage: { prompt_tokens: 0, total_tokens: 0 },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
            );
        const client = new OpenAI({
            apiKey: 'test',
            maxRetries: 1,
            fetch: withExternalCallCounting(transport, 'openai'),
        });
        const request = client.embeddings.create({ model: 'test', input: 'test' });
        await vi.advanceTimersByTimeAsync(50);
        await request;
        await flushProviderCalls();
        expect(transport).toHaveBeenCalledTimes(2);
        expect(customCommand.mock.calls[0][0].slice(5)).toEqual([
            'requests',
            '2',
            'success2xx',
            '1',
            'client4xx',
            '1',
            'rateLimited429',
            '1',
            'retries',
            '1',
        ]);
    });

    it('counts a refused HTTP redirect as a response, not a network failure', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(null, {
                    status: 302,
                    headers: { location: 'https://untrusted.test/target' },
                }),
            ),
        );
        await expect(fetchWithTimeout('https://api.themoviedb.org/start')).rejects.toThrow(
            'redirect',
        );
        await flushProviderCalls();
        expect(incrementFields()).toEqual({ requests: '1' });
    });

    it('attributes configured integrations and archive mirrors without labelling arbitrary hosts', async () => {
        recordProviderCallForUrl('http://jellyfin.test:8096/base/Items', 200);
        recordProviderCallForUrl('http://jellyfin.test:8096/unrelated', 200);
        withProviderCallScope('audiobookshelf', () =>
            recordProviderCallForUrl('https://abs.test/a', 503),
        );
        withProviderCallScope('coverartarchive', () =>
            recordProviderCallForUrl('https://archive.org/cover', 200),
        );
        recordProviderCallForUrl('not a URL', null);
        await flushProviderCalls();
        expect(customCommand.mock.calls.map(([args]) => args[3])).toEqual([
            'pcalls:v1:jellyfin:2026103123',
            'pcalls:v1:audiobookshelf:2026103123',
            'pcalls:v1:coverartarchive:2026103123',
        ]);
    });

    it('reads oldest-first zero-filled series and totals, preserving 404/429 in the 4xx count', async () => {
        hmget.mockImplementation(async (key: string) =>
            key === 'pcalls:v1:tmdb:2026103122'
                ? ['5', '1', '3', '2', '0', '1', '2']
                : Array(7).fill(null),
        );
        const result = ProviderCallsResponseSchema.parse(await readProviderCalls(2));
        expect(result.from).toBe('2026-10-31T22:00:00.000Z');
        expect(result.to).toBe('2026-10-31T23:59:00.000Z');
        const tmdb = result.providers.find((row) => row.provider === 'tmdb')!;
        expect(tmdb.totals).toEqual({
            requests: 5,
            success2xx: 1,
            client4xx: 3,
            rateLimited429: 2,
            server5xx: 0,
            networkErrors: 1,
            retries: 2,
        });
        expect(tmdb.series[1]).toEqual({
            hour: '2026-10-31T23:00:00.000Z',
            ...emptyProviderCallCounts(),
        });
        expect(result.providers.find((row) => row.provider === 'mdblist')!.totals.requests).toBe(0);
    });

    it('rejects reads when Valkey is unavailable rather than inventing zero counts', async () => {
        getCoordinationClient.mockReturnValueOnce(null);
        await expect(readProviderCalls(24)).rejects.toThrow('unavailable');
        hmget.mockRejectedValueOnce(new Error('read failed'));
        await expect(readProviderCalls(24)).rejects.toThrow('read failed');
    });
});
