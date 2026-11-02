// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards the taste-station tracks def as published on /api/v1:
 *
 *  1. The route param is named `id`. The def's ParamsSchema requires that
 *     exact key, so a route directory named otherwise would 422 on every
 *     request. The mounted-export test exercises mount()'s validateRequest().
 *  2. A per-user rate limit exists, keyed to the caller's userId.
 *  3. The service result kinds map to 422 / 410 / 404 / 503 and the success
 *     envelope is `{ items, page: { limit, truncated } }`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckRateLimit = vi.fn();
const mockGetSql = vi.fn();
const mockGetStationQueue = vi.fn();

vi.mock('$lib/server/services/music/stations.service.js', () => ({
    getStationQueue: (...args: unknown[]) => mockGetStationQueue(...args),
    parseStationId: (id: string) => {
        const m = /^([0-9a-f]{12})\.(\d{1,3})$/.exec(id);
        return m ? { version: m[1], n: Number.parseInt(m[2], 10) } : null;
    },
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    // Faithful stand-in for the real helper: it sets the X-RateLimit-*
    // headers on the response it is handed and returns that same response.
    withRateLimitHeaders: (
        response: Response,
        result: { total: number; remaining: number; resetAt: number },
    ) => {
        response.headers.set('X-RateLimit-Limit', String(result.total));
        response.headers.set('X-RateLimit-Remaining', String(result.remaining));
        response.headers.set('X-RateLimit-Reset', String(result.resetAt));
        return response;
    },
}));

// The handler checks DB-availability before the rate limit (auth → DB → rate
// limit), so this must resolve a usable value or every request 503s before
// the limiter is ever reached.
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

const { def } = await import('./tracks.js');
const { mount } = await import('$lib/server/api/mount.js');

const STATION_ID = 'a1b2c3d4e5f6.0';

function makeEvent(params: Record<string, string>): RequestEvent {
    const url = `http://localhost/api/v1/me/music/taste-stations/${STATION_ID}/tracks`;
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL(url),
        params,
        request: new Request(url),
    } as unknown as RequestEvent;
}

const emptyOk = { kind: 'ok', tracks: [], truncated: false };

describe('taste-station tracks contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        mockGetStationQueue.mockResolvedValue(emptyOk);
    });

    it('404s when the station genuinely has no playable tracks', async () => {
        const res = await def.handlers.GET!(makeEvent({ id: STATION_ID }), {} as never);
        expect(res.status).toBe(404);
    });

    it('404s when the id points past the stored clustering', async () => {
        mockGetStationQueue.mockResolvedValue({ kind: 'not_found' });
        const res = await def.handlers.GET!(makeEvent({ id: STATION_ID }), {} as never);
        expect(res.status).toBe(404);
    });

    it('410s when the clustering behind the id has expired', async () => {
        mockGetStationQueue.mockResolvedValue({ kind: 'expired' });
        const res = await def.handlers.GET!(makeEvent({ id: STATION_ID }), {} as never);
        expect(res.status).toBe(410);
        const body = await res.json();
        expect(JSON.stringify(body)).toContain('list the stations again');
    });

    it('422s a malformed id before spending rate limit or touching the service', async () => {
        const res = await def.handlers.GET!(makeEvent({ id: 'nope' }), {} as never);
        expect(res.status).toBe(422);
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
        expect(mockGetStationQueue).not.toHaveBeenCalled();
    });

    it('422s a malformed id even when the caller is already rate limited', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: Date.now() / 1000 + 30 });
        const res = await def.handlers.GET!(makeEvent({ id: 'nope' }), {} as never);
        expect(res.status).toBe(422);
    });

    it('503s — not 410 — when the snapshot store is unreadable and the clustering moved', async () => {
        mockGetStationQueue.mockResolvedValue({ kind: 'unavailable' });
        const res = await def.handlers.GET!(makeEvent({ id: STATION_ID }), {} as never);
        expect(res.status).toBe(503);
    });

    it('503s — not 404 — when the station lookup fails', async () => {
        // An empty queue and a failed kNN used to be indistinguishable: the
        // service swallowed the error into [] and clients were told the
        // station was permanently empty.
        mockGetStationQueue.mockRejectedValue(new Error('pgvector down'));
        const res = await def.handlers.GET!(makeEvent({ id: STATION_ID }), {} as never);
        expect(res.status).toBe(503);
    });

    it('declares its route param as id', () => {
        const shape = (def.request?.params as { shape?: Record<string, unknown> })?.shape;
        expect(shape).toBeDefined();
        expect(Object.keys(shape!)).toContain('id');
    });

    it('422s through the mounted export when the param is named differently', async () => {
        // mount()'s validateRequest() runs ParamsSchema against event.params
        // BEFORE the handler, so a mis-named route directory is caught by the
        // Zod gate itself.
        const mounted = mount(def, { surface: 'v1' });
        const res = await mounted.GET!(makeEvent({ stationIndex: '0' }));
        expect(res.status).toBe(422);
    });

    it('returns 429 when the per-user limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({
            allowed: false,
            resetAt: Date.now() / 1000 + 30,
        });
        const res = await def.handlers.GET!(makeEvent({ id: STATION_ID }), {} as never);
        expect(res.status).toBe(429);
        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            expect.stringContaining('u1'),
            expect.any(Number),
            expect.any(Number),
        );
    });

    it('requests artwork on the response surface and preserves the resolved set', async () => {
        const images = {
            primary: {
                href: '/api/v1/media/album/images/poster?size=card&v=album-revision',
                revision: 'album-revision',
                source: 'album',
                placeholder: { blurhash: 'stored' },
            },
        };
        mockGetStationQueue.mockResolvedValue({
            kind: 'ok',
            tracks: [{ id: 'track', images }],
            truncated: true,
        });
        const response = await def.handlers.GET!(makeEvent({ id: STATION_ID }), {
            surface: 'v1',
        } as never);
        expect(mockGetStationQueue).toHaveBeenLastCalledWith(
            expect.anything(),
            'u1',
            STATION_ID,
            50,
            expect.anything(),
            'v1',
        );
        const body = await response.json();
        expect(body.items[0].images).toEqual(images);
        expect(body.page).toEqual({ limit: 50, truncated: true });
    });
});
