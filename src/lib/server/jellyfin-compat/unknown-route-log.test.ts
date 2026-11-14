// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warn, debug } = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn() }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: (namespace: string) => ({
            warn: namespace === 'JellyfinCompat:UnknownRoute' ? warn : vi.fn(),
            debug: namespace === 'JellyfinCompat:UnknownRoute' ? debug : vi.fn(),
            info: vi.fn(),
            error: vi.fn(),
        }),
    },
}));
const getCoordinationClient = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/cache/valkey.js')>()),
    getCoordinationClient: () => getCoordinationClient(),
}));

import {
    normaliseUnknownRoute,
    shouldLogOnce,
    recordUnknownRoute,
    clientFromHeaders,
    takeWarnBudget,
    __resetUnknownRouteLogForTests,
} from './unknown-route-log.js';
import { getContractDigest } from './contract/digest.js';
import { Logger } from '$lib/server/utils/logger.js';

beforeEach(() => {
    vi.clearAllMocks();
    __resetUnknownRouteLogForTests();
});

// recordUnknownRoute queues its log synchronously in a microtask. Await that
// boundary explicitly; Valkey's separate async counter is awaited below.
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('normaliseUnknownRoute', () => {
    it('maps a spec route to its template (case-insensitive, /j stripped, query dropped)', () => {
        const spec = getContractDigest().routes.find(
            (r) => r.method.toUpperCase() === 'GET' && r.path.includes('{'),
        );
        expect(spec).toBeTruthy();
        const concrete = spec!.path.replace(/\{[^}]+\}/g, 'abc');
        const r = normaliseUnknownRoute('get', `/J${concrete}?x=1`);
        expect(r.known).toBe(true);
        expect(r.key.startsWith('GET ')).toBe(true);
    });

    it('replaces id-like segments and drops the query for unknown shapes', () => {
        const r = normaliseUnknownRoute(
            'POST',
            '/j/zzz-nope/0a1b2c3d-0a1b-0a1b-0a1b-0a1b2c3d4e5f/12345/' +
                'x'.repeat(30) +
                '?api_key=secret',
        );
        expect(r).toEqual({ key: 'POST /j/zzz-nope/{id}/{id}/{id}', known: false });
    });

    it('truncates to 120 chars', () => {
        const r = normaliseUnknownRoute('GET', '/j/' + 'ab/'.repeat(100));
        expect(r.key.length).toBeLessThanOrEqual(120);
    });
});

describe('clientFromHeaders', () => {
    it('reads only Client and Version, never the token', () => {
        const h = new Headers({
            'X-Emby-Authorization':
                'MediaBrowser Client="Finamp", Device="Phone", DeviceId="abc", Version="0.9.1", Token="SECRET"',
        });
        expect(clientFromHeaders(h)).toEqual({ name: 'Finamp', version: '0.9.1' });
    });
    it('falls back to unknown', () => {
        expect(clientFromHeaders(new Headers())).toEqual({ name: 'unknown', version: '' });
    });
});

describe('dedupe', () => {
    it('logs once per key+client per hour', () => {
        expect(shouldLogOnce('GET /a', 'App', 1000)).toBe(true);
        expect(shouldLogOnce('GET /a', 'App', 2000)).toBe(false);
        expect(shouldLogOnce('GET /a', 'Other', 2000)).toBe(true);
        expect(shouldLogOnce('GET /a', 'App', 1000 + 3_600_001)).toBe(true);
    });
    it('caps the map by evicting the oldest', () => {
        for (let i = 0; i < 2100; i++) shouldLogOnce(`GET /k${i}`, 'c', i);
        expect(shouldLogOnce('GET /k0', 'c', 3000)).toBe(true); // evicted, so logs again
        expect(shouldLogOnce('GET /k2099', 'c', 3000)).toBe(false);
    });
});

describe('recordUnknownRoute', () => {
    it('never throws when Valkey is null and still logs (debug for unknown shape)', async () => {
        getCoordinationClient.mockReturnValue(null);
        // Transitive imports can finish background initialization during this
        // test. Only this logger's lines belong in its exact call counts.
        Logger.for('UnrelatedBackgroundService').debug('initialized');
        expect(() => recordUnknownRoute(new Request('http://x/j/nope'), '/j/nope')).not.toThrow();
        await flush();
        expect(debug).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it('swallows Valkey errors', async () => {
        getCoordinationClient.mockReturnValue({
            hlen: vi.fn().mockRejectedValue(new Error('boom')),
        });
        const spec = getContractDigest().routes[0]!;
        const path = '/j' + spec.path.replace(/\{[^}]+\}/g, 'abc');
        expect(() =>
            recordUnknownRoute(new Request('http://x' + path, { method: spec.method }), path),
        ).not.toThrow();
        await flush();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('counts known routes only and skips when the hash is full', async () => {
        const hlen = vi.fn().mockResolvedValue(10);
        const hincrBy = vi.fn().mockResolvedValue(1);
        const expire = vi.fn().mockResolvedValue(true);
        getCoordinationClient.mockReturnValue({ hlen, hincrBy, expire });
        const spec = getContractDigest().routes[0]!;
        const path = '/j' + spec.path.replace(/\{[^}]+\}/g, 'abc');
        const req = () => new Request('http://x' + path, { method: spec.method });
        recordUnknownRoute(req(), path);
        recordUnknownRoute(new Request('http://x/j/zzz-probe'), '/j/zzz-probe');
        await flush();
        await vi.waitFor(() => {
            expect(hincrBy).toHaveBeenCalledTimes(1);
            expect(hincrBy.mock.calls[0]![1]).toBe(
                `${spec.method.toUpperCase()} ${spec.path}|unknown`,
            );
            expect(expire).toHaveBeenCalledWith(
                expect.stringMatching(/^jfunk:\d{4}-\d{2}-\d{2}$/),
                691200,
            );
        });

        // existing field: expire only on the first increment (returned 1), not later
        expire.mockClear();
        hincrBy.mockResolvedValue(7);
        recordUnknownRoute(req(), path);
        await flush();
        await vi.waitFor(() => expect(hincrBy).toHaveBeenCalledTimes(2));
        expect(expire).not.toHaveBeenCalled();
    });

    it('over the field cap: existing fields still count, new fields are skipped', async () => {
        const hlen = vi.fn().mockResolvedValue(5001);
        const hexists = vi.fn().mockResolvedValue(false);
        const hincrBy = vi.fn().mockResolvedValue(3);
        const expire = vi.fn().mockResolvedValue(true);
        getCoordinationClient.mockReturnValue({ hlen, hexists, hincrBy, expire });
        const spec = getContractDigest().routes[0]!;
        const path = '/j' + spec.path.replace(/\{[^}]+\}/g, 'abc');
        const req = () => new Request('http://x' + path, { method: spec.method });
        recordUnknownRoute(req(), path);
        await flush();
        expect(hexists).toHaveBeenCalledTimes(1);
        expect(hincrBy).not.toHaveBeenCalled();

        hexists.mockResolvedValue(true);
        recordUnknownRoute(req(), path);
        await flush();
        await vi.waitFor(() => expect(hincrBy).toHaveBeenCalledTimes(1));
    });

    it('caps warn lines process-wide, falling back to debug', async () => {
        getCoordinationClient.mockReturnValue(null);
        const spec = getContractDigest().routes[0]!;
        const path = '/j' + spec.path.replace(/\{[^}]+\}/g, 'abc');
        for (let i = 0; i < 40; i++) {
            const h = { 'X-Emby-Authorization': `MediaBrowser Client="c${i}", Version="1"` };
            recordUnknownRoute(
                new Request('http://x' + path, { method: spec.method, headers: h }),
                path,
            );
        }
        await flush();
        expect(warn).toHaveBeenCalledTimes(30);
        expect(debug).toHaveBeenCalledTimes(10);
    });

    it('warn budget resets after a minute', () => {
        for (let i = 0; i < 30; i++) expect(takeWarnBudget(1000)).toBe(true);
        expect(takeWarnBudget(2000)).toBe(false);
        expect(takeWarnBudget(1000 + 60_000)).toBe(true);
    });
});
