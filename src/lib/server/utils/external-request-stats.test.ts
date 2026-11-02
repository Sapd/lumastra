// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => new Map<string, Map<string, number>>());
const valkey = vi.hoisted(() => ({
    hIncrBy: vi.fn(async (key: string, field: string, n: number) => {
        const h = store.get(key) ?? new Map<string, number>();
        h.set(field, (h.get(field) ?? 0) + n);
        store.set(key, h);
        return h.get(field);
    }),
    hGetAll: vi.fn(async (key: string) => Object.fromEntries(store.get(key) ?? [])),
    expire: vi.fn(async () => true),
}));
vi.mock('$lib/server/cache/valkey.js', () => valkey);

import {
    recordRequestPathCall,
    flushRequestPathCalls,
    readRequestPathCalls,
    buildProviderCallRows,
} from './external-request-stats.js';

const NOW = Date.UTC(2026, 9, 29, 14, 30); // 2026-10-29T14:30Z

describe('request-path call stats', () => {
    beforeEach(() => {
        store.clear();
        valkey.hIncrBy.mockClear();
        valkey.expire.mockClear();
    });

    it('batches increments per hour bucket and flushes them with a TTL, never one write per call', async () => {
        for (let i = 0; i < 50; i++) recordRequestPathCall('api.themoviedb.org', 'ok', NOW);
        recordRequestPathCall('api.themoviedb.org', 'rate_limited', NOW);
        recordRequestPathCall('musicbrainz.org', 'server_error', NOW + 60 * 60 * 1000);

        await flushRequestPathCalls();

        expect(valkey.hIncrBy).toHaveBeenCalledTimes(3);
        expect(valkey.hIncrBy).toHaveBeenCalledWith(
            'extcall:h:2026-10-29T14',
            'api.themoviedb.org|ok',
            50,
        );
        expect(valkey.hIncrBy).toHaveBeenCalledWith(
            'extcall:h:2026-10-29T14',
            'api.themoviedb.org|rate_limited',
            1,
        );
        expect(valkey.hIncrBy).toHaveBeenCalledWith(
            'extcall:h:2026-10-29T15',
            'musicbrainz.org|server_error',
            1,
        );
        expect(valkey.expire).toHaveBeenCalledWith('extcall:h:2026-10-29T14', expect.any(Number));
    });

    it('reads counts for the window, summing hour buckets per host and outcome', async () => {
        recordRequestPathCall('api.themoviedb.org', 'ok', NOW);
        recordRequestPathCall('api.themoviedb.org', 'rate_limited', NOW);
        recordRequestPathCall('lrclib.net', 'network_error', NOW - 2 * 60 * 60 * 1000);
        await flushRequestPathCalls();

        const read = await readRequestPathCalls(1, new Date(NOW));
        expect(read.windowDays).toBe(1);
        expect(read.byHost.get('api.themoviedb.org')).toEqual({
            ok: 1,
            not_found: 0,
            client_error: 0,
            rate_limited: 1,
            server_error: 0,
            network_error: 0,
        });
        expect(read.byHost.get('lrclib.net')?.network_error).toBe(1);
    });

    it('clamps the read window to the 8-day retention', async () => {
        const read = await readRequestPathCalls(30, new Date(NOW));
        expect(read.windowDays).toBe(8);
    });

    it('builds one provider row per host from task and live counts', () => {
        const rows = buildProviderCallRows(
            [
                { host: 'api.themoviedb.org', calls: 10, errors: 2, rateLimited: 1 },
                { host: 'musicbrainz.org', calls: 4, errors: 0, rateLimited: 0 },
            ],
            new Map([
                [
                    'api.themoviedb.org',
                    {
                        ok: 5,
                        not_found: 0,
                        client_error: 0,
                        rate_limited: 3,
                        server_error: 1,
                        network_error: 0,
                    },
                ],
                [
                    'api.acoustid.org',
                    {
                        ok: 0,
                        not_found: 0,
                        client_error: 0,
                        rate_limited: 0,
                        server_error: 0,
                        network_error: 2,
                    },
                ],
            ]),
        );
        expect(rows).toEqual([
            {
                host: 'api.themoviedb.org',
                taskCalls: 10,
                liveCalls: 9,
                errors: 2 + 4,
                rateLimited: 1 + 3,
            },
            { host: 'musicbrainz.org', taskCalls: 4, liveCalls: 0, errors: 0, rateLimited: 0 },
            { host: 'api.acoustid.org', taskCalls: 0, liveCalls: 2, errors: 2, rateLimited: 0 },
        ]);
    });
});

it('flushes the last partial bucket at graceful shutdown before Valkey closes', async () => {
    const { createWebShutdown, _resetWebShutdownForTests } =
        await import('../lifecycle/web-shutdown.js');
    _resetWebShutdownForTests();
    store.clear();
    valkey.hIncrBy.mockClear();
    recordRequestPathCall('lrclib.net', 'ok', NOW);
    const close = vi.fn(() => {
        expect(valkey.hIncrBy).toHaveBeenCalledWith('extcall:h:2026-10-29T14', 'lrclib.net|ok', 1);
    });
    const shutdown = createWebShutdown({
        services: [],
        pools: [{ name: 'Valkey', run: close }],
        drainTimeoutMs: 50,
        exit: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    try {
        await shutdown('SIGTERM');
        expect(close).toHaveBeenCalledOnce();
        // Shutdown catches step failures; assert outside the callback too.
        expect(valkey.hIncrBy).toHaveBeenCalledWith('extcall:h:2026-10-29T14', 'lrclib.net|ok', 1);
    } finally {
        _resetWebShutdownForTests();
    }
});

it('includes not-found requests in live totals, but excludes them from errors', () => {
    const rows = buildProviderCallRows(
        [],
        new Map([
            [
                'lrclib.net',
                {
                    ok: 1,
                    not_found: 3,
                    client_error: 1,
                    rate_limited: 1,
                    server_error: 1,
                    network_error: 1,
                },
            ],
        ]),
    );
    expect(rows).toEqual([
        { host: 'lrclib.net', taskCalls: 0, liveCalls: 8, errors: 4, rateLimited: 1 },
    ]);
});

it('waits for an already-running flush before shutdown closes Valkey', async () => {
    const { createWebShutdown, _resetWebShutdownForTests } =
        await import('../lifecycle/web-shutdown.js');
    _resetWebShutdownForTests();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    valkey.hIncrBy.mockImplementationOnce(async () => {
        await waiting;
        return 1;
    });
    recordRequestPathCall('lrclib.net', 'ok', NOW);
    const flushing = flushRequestPathCalls();
    const close = vi.fn();
    const stop = createWebShutdown({
        services: [],
        pools: [{ name: 'Valkey', run: close }],
        drainTimeoutMs: 50,
        exit: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })('SIGTERM');
    try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(close).not.toHaveBeenCalled();
    } finally {
        release();
        await Promise.all([flushing, stop]);
        _resetWebShutdownForTests();
    }
    expect(close).toHaveBeenCalledOnce();
});
