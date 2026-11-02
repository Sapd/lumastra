// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/network/speed-test.ts — GET the measurement payload.
 *
 * Driven through `mount()` rather than `def.handlers.GET` directly, because the
 * two contracts under test here live in the mount layer: `{kind:'user'}` auth
 * and `request.query` validation (the `bytes` floor/ceiling). Calling the
 * handler directly would hand it an already-parsed `ctx.input` and assert
 * nothing about what the wire actually rejects.
 *
 * The load-bearing negative assertion is that a download NEVER touches the
 * database: the client times itself and posts the result separately, so this
 * endpoint records nothing at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { def } from './speed-test.js';
import * as rateLimit from '$lib/server/middleware/valkey-rate-limit.js';
import * as dbConn from '$lib/server/database/connection.js';

const ROUTE_ID = '/api/v1/network/speed-test';

function getEvent(
    search: string,
    user?: { userId: string; username: string },
    headers?: Record<string, string>,
): RequestEvent {
    const url = `http://localhost${ROUTE_ID}${search}`;
    return {
        url: new URL(url),
        request: new Request(url, { method: 'GET', headers }),
        params: {},
        route: { id: ROUTE_ID },
        locals: { user },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const USER = { userId: 'd7f2a0c1-0000-4000-8000-000000000001', username: 'alice' };

function allowRateLimit() {
    return vi.spyOn(rateLimit, 'checkRateLimit').mockResolvedValue({
        allowed: true,
        remaining: 5,
        resetAt: Date.now() / 1000 + 60,
        total: 40,
    });
}

/** Reads a response body to completion and returns the byte count. */
async function drain(res: Response): Promise<number> {
    const reader = res.body!.getReader();
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value!.byteLength;
    }
    return total;
}

describe('defs/network/speed-test (GET)', () => {
    const { GET } = mount(def, { surface: 'v1' });

    beforeEach(() => {
        allowRateLimit();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('serves the 16 MiB default with unbuffered, uncacheable octet-stream headers', async () => {
        const res = await GET!(getEvent('', USER));

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        expect(res.headers.get('content-length')).toBe('16777216');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-accel-buffering')).toBe('no');
        await res.body?.cancel();
    });

    it('streams exactly the requested byte count', async () => {
        const res = await GET!(getEvent('?bytes=1048576', USER));

        expect(res.headers.get('content-length')).toBe('1048576');
        await expect(drain(res)).resolves.toBe(1048576);
    });

    it('rejects a size under the 1 MiB floor with 422', async () => {
        const res = await GET!(getEvent('?bytes=999', USER));
        expect(res.status).toBe(422);
    });

    it('rejects a size over the 64 MiB ceiling with 422', async () => {
        const res = await GET!(getEvent('?bytes=67108865', USER));
        expect(res.status).toBe(422);
    });

    it('returns 401 with no authenticated user', async () => {
        const res = await GET!(getEvent(''));
        expect(res.status).toBe(401);
    });

    it('rate-limits the default 16 MiB request on the LARGE key at 6 per 60 s', async () => {
        const spy = vi.spyOn(rateLimit, 'checkRateLimit').mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: Date.now() / 1000 + 42,
            total: 6,
        });

        const res = await GET!(getEvent('', USER));

        expect(res.status).toBe(429);
        expect(res.headers.get('content-length')).not.toBe('16777216');
        expect(spy).toHaveBeenCalledWith(`speedtest:get:large:${USER.userId}`, 6, 60);
    });

    it('rate-limits a 4 MiB cadence chunk on the SMALL key at 40 per 60 s', async () => {
        const spy = allowRateLimit();

        // One cadence run is 8 of these, so the small bucket has to be generous
        // enough to let a run finish — which the 6/min large bucket would not.
        await drain(await GET!(getEvent('?bytes=4194304', USER)));

        expect(spy).toHaveBeenCalledWith(`speedtest:get:small:${USER.userId}`, 40, 60);
    });

    it('puts the 64 MiB long payload on the large key, not the small one', async () => {
        const spy = allowRateLimit();

        await drain(await GET!(getEvent('?bytes=67108864', USER)));

        expect(spy).toHaveBeenCalledWith(`speedtest:get:large:${USER.userId}`, 6, 60);
    });

    it('the boundary is inclusive: 4 MiB is small, one byte more is large', async () => {
        const spy = allowRateLimit();

        await drain(await GET!(getEvent('?bytes=4194305', USER)));

        expect(spy).toHaveBeenCalledWith(`speedtest:get:large:${USER.userId}`, 6, 60);
    });

    it('records nothing server-side — a download never reaches the database', async () => {
        const getDbSpy = vi.spyOn(dbConn, 'getDb');

        const res = await GET!(getEvent('?bytes=1048576', USER));
        await drain(res);

        expect(res.status).toBe(200);
        expect(getDbSpy).not.toHaveBeenCalled();
    });

    /**
     * The attack this closes: the endpoint authenticates on ambient cookies, so
     * a hostile page could point an `<img>`/`fetch` at it and pull 6 x 64 MiB a
     * minute down a logged-in victim's line. `Sec-Fetch-Site` is set by the
     * browser and not settable from page script, so a `cross-site` value is
     * conclusive — and it must be honoured ONLY when present, or every native
     * client (which sends no `Sec-Fetch-*` at all) would 403.
     */
    it('refuses a browser-reported cross-site request with 403, before any bytes', async () => {
        const res = await GET!(getEvent('', USER, { 'Sec-Fetch-Site': 'cross-site' }));

        expect(res.status).toBe(403);
        expect(res.headers.get('content-length')).not.toBe('16777216');
    });

    it('serves a same-origin request', async () => {
        const res = await GET!(
            getEvent('?bytes=1048576', USER, { 'Sec-Fetch-Site': 'same-origin' }),
        );

        expect(res.status).toBe(200);
        await res.body?.cancel();
    });

    it('serves a request with no Sec-Fetch-Site at all — native clients send none', async () => {
        const res = await GET!(getEvent('?bytes=1048576', USER));

        expect(res.status).toBe(200);
        await res.body?.cancel();
    });

    it('documents exactly the methods it implements', () => {
        expect(Object.keys(def.handlers)).toEqual(['GET']);
        expect(Object.keys(def.docs ?? {})).toEqual(['GET']);
        expect(def.docs?.GET?.stability).toBe('beta');
        expect(def.docs?.GET?.tags).toEqual(['Network']);
    });
});
