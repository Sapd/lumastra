// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/network/speed-test-results.ts — POST the client's own
 * timings back.
 *
 * Driven through `mount()` so the def-level `request.body` schema (the source of
 * the 422s) and the 201 response contract are both genuinely exercised —
 * mount()'s response gate THROWS on schema drift under NODE_ENV=test, so a
 * response field that stops matching SpeedTestResultResponseSchema fails here.
 *
 * `insertSpeedTest` is mocked to echo its own input back as a row, so the
 * asserted 201 body is the real product of summariseSpeedTest() → insert input
 * → toSpeedTestResponse(), not a hand-written fixture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { def } from './speed-test-results.js';
import * as rateLimit from '$lib/server/middleware/valkey-rate-limit.js';
import * as dbConn from '$lib/server/database/connection.js';
import type {
    SpeedTestRow,
    InsertSpeedTestInput,
} from '$lib/server/database/queries/network-speed-tests.queries.js';

const mockInsertSpeedTest = vi.fn();

vi.mock('$lib/server/database/queries/network-speed-tests.queries.js', () => ({
    insertSpeedTest: (...args: unknown[]) => mockInsertSpeedTest(...args),
}));

const ROUTE_ID = '/api/v1/network/speed-test/results';
const USER = { userId: 'd7f2a0c1-0000-4000-8000-000000000001', username: 'alice' };
const CREATED_AT = new Date('2026-09-12T10:11:12.000Z');

function postEvent(body: unknown, user?: { userId: string; username: string }): RequestEvent {
    const url = `http://localhost${ROUTE_ID}`;
    return {
        url: new URL(url),
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
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

/** 1 MB received in 1500 ms with a 500 ms TTFB = 8 Mbit/s over the transfer. */
const VALID_RESULT = {
    bytesRequested: 1_048_576,
    bytesReceived: 1_000_000,
    durationMs: 1500,
    ttfbMs: 500,
    aborted: false,
    buckets: [
        { ms: 250, bytes: 100_000 },
        { ms: 250, bytes: 250_000 },
        { ms: 250, bytes: 0 },
        { ms: 250, bytes: 250_000 },
    ],
    deviceId: 'device-1',
    clientInfo: { ua: 'vitest' },
};

function allowRateLimit() {
    return vi.spyOn(rateLimit, 'checkRateLimit').mockResolvedValue({
        allowed: true,
        remaining: 5,
        resetAt: Date.now() / 1000 + 60,
        total: 6,
    });
}

describe('defs/network/speed-test-results (POST)', () => {
    const { POST } = mount(def, { surface: 'v1' });

    beforeEach(() => {
        mockInsertSpeedTest.mockReset();
        // Echo the insert input back as the stored row so the 201 body is the
        // genuine output of the summary maths + the row→response mapping.
        mockInsertSpeedTest.mockImplementation(
            async (_sql: unknown, input: InsertSpeedTestInput): Promise<SpeedTestRow> => ({
                id: 4242,
                user_id: input.userId,
                device_id: input.deviceId ?? null,
                client_info: input.clientInfo ?? null,
                bytes_requested: input.result.bytesRequested,
                bytes_received: input.result.bytesReceived,
                duration_ms: input.result.durationMs,
                ttfb_ms: input.result.ttfbMs,
                throughput_bps: input.summary.throughputBps,
                min_bucket_bps: input.summary.minBucketBps,
                stall_ms: input.summary.stallMs,
                mode: input.result.mode,
                request_count: input.summary.requestCount,
                max_ttfb_ms: input.summary.maxTtfbMs,
                min_request_bps: input.summary.minRequestBps,
                gap_ms: input.summary.gapMs,
                requests: input.result.requests?.length ? input.result.requests : null,
                aborted: input.result.aborted,
                buckets: input.result.buckets,
                created_at: CREATED_AT,
            }),
        );
        allowRateLimit();
        vi.spyOn(dbConn, 'getDb').mockReturnValue({} as never);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('stores a valid result and returns 201 with the derived throughput', async () => {
        const res = await POST!(postEvent(VALID_RESULT, USER));

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body).toEqual({
            id: 4242,
            mode: 'single',
            throughputBps: 8_000_000,
            ttfbMs: 500,
            // Slowest non-first bucket is the 0-byte one → 0 bps.
            minBucketBps: 0,
            stallMs: 250,
            requestCount: 1,
            maxTtfbMs: null,
            minRequestBps: null,
            bytesReceived: 1_000_000,
            durationMs: 1500,
            aborted: false,
            createdAt: CREATED_AT.toISOString(),
        });
    });

    it('persists the row against the authenticated user, device and client info', async () => {
        await POST!(postEvent(VALID_RESULT, USER));

        expect(mockInsertSpeedTest).toHaveBeenCalledTimes(1);
        const [, input] = mockInsertSpeedTest.mock.calls[0] as [unknown, InsertSpeedTestInput];
        expect(input.userId).toBe(USER.userId);
        expect(input.deviceId).toBe('device-1');
        expect(input.clientInfo).toEqual({ ua: 'vitest' });
        expect(input.summary.throughputBps).toBe(8_000_000);
    });

    it('rejects bytesReceived above bytesRequested with 422 and stores nothing', async () => {
        const res = await POST!(
            postEvent({ ...VALID_RESULT, bytesReceived: VALID_RESULT.bytesRequested + 1 }, USER),
        );

        expect(res.status).toBe(422);
        expect(mockInsertSpeedTest).not.toHaveBeenCalled();
    });

    it('returns 503 when the database is unavailable', async () => {
        vi.spyOn(dbConn, 'getDb').mockReturnValue(null as never);

        const res = await POST!(postEvent(VALID_RESULT, USER));

        expect(res.status).toBe(503);
        expect(mockInsertSpeedTest).not.toHaveBeenCalled();
    });

    it('returns 401 with no authenticated user', async () => {
        const res = await POST!(postEvent(VALID_RESULT));

        expect(res.status).toBe(401);
        expect(mockInsertSpeedTest).not.toHaveBeenCalled();
    });

    it('rate-limits at 6 per 60 s on a per-user key, before storing anything', async () => {
        const spy = vi.spyOn(rateLimit, 'checkRateLimit').mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: Date.now() / 1000 + 42,
            total: 6,
        });

        const res = await POST!(postEvent(VALID_RESULT, USER));

        expect(res.status).toBe(429);
        expect(spy).toHaveBeenCalledWith(`speedtest:post:${USER.userId}`, 6, 60);
        expect(mockInsertSpeedTest).not.toHaveBeenCalled();
    });

    describe('modes', () => {
        /**
         * Two 1 s fetches 2 s apart: 1.5 MB over 2 s in flight = 6 Mbit/s. The
         * wall clock (4.6 s, pauses included) would say ~2.6 Mbit/s, so this
         * asserts the endpoint really applies the cadence maths and not the
         * single-download one.
         */
        const CADENCE_RESULT = {
            bytesRequested: 8 * 1024 * 1024,
            bytesReceived: 1_500_000,
            durationMs: 4_600,
            ttfbMs: 100,
            aborted: false,
            mode: 'cadence',
            buckets: [],
            requests: [
                { bytes: 1_000_000, ttfbMs: 100, durationMs: 1_100 },
                { bytes: 500_000, ttfbMs: 500, durationMs: 1_500 },
            ],
        };

        it('stores a cadence run and returns the per-request numbers', async () => {
            const res = await POST!(postEvent(CADENCE_RESULT, USER));

            expect(res.status).toBe(201);
            const body = await res.json();
            expect(body.mode).toBe('cadence');
            expect(body.throughputBps).toBe(6_000_000);
            expect(body.requestCount).toBe(2);
            expect(body.minRequestBps).toBe(4_000_000);
            expect(body.maxTtfbMs).toBe(500);
            // No bucket series was sent, so neither bucket number is claimed.
            expect(body.minBucketBps).toBeNull();
            expect(body.stallMs).toBe(0);
            // The raw per-request series is not echoed back — it stays server-side.
            expect(body.requests).toBeUndefined();
        });

        it('persists the mode, the gap and the raw per-request series', async () => {
            await POST!(postEvent(CADENCE_RESULT, USER));

            const [, input] = mockInsertSpeedTest.mock.calls[0] as [unknown, InsertSpeedTestInput];
            expect(input.result.mode).toBe('cadence');
            expect(input.result.requests).toHaveLength(2);
            expect(input.summary.gapMs).toBe(2000);
        });

        it('rejects cadence without requests with 422 and stores nothing', async () => {
            const { requests: _requests, ...withoutRequests } = CADENCE_RESULT;
            const res = await POST!(postEvent(withoutRequests, USER));

            expect(res.status).toBe(422);
            expect(mockInsertSpeedTest).not.toHaveBeenCalled();
        });

        it('rejects a single run that carries requests with 422', async () => {
            const res = await POST!(
                postEvent({ ...VALID_RESULT, requests: CADENCE_RESULT.requests }, USER),
            );

            expect(res.status).toBe(422);
            expect(mockInsertSpeedTest).not.toHaveBeenCalled();
        });

        it('accepts a long run with the full 240 buckets', async () => {
            const res = await POST!(
                postEvent(
                    {
                        ...VALID_RESULT,
                        mode: 'long',
                        bytesRequested: 64 * 1024 * 1024,
                        bytesReceived: 60_000_000,
                        durationMs: 60_000,
                        ttfbMs: 100,
                        buckets: Array.from({ length: 240 }, () => ({ ms: 250, bytes: 250_000 })),
                    },
                    USER,
                ),
            );

            expect(res.status).toBe(201);
            const body = await res.json();
            expect(body.mode).toBe('long');
            expect(body.requestCount).toBe(1);
            expect(body.maxTtfbMs).toBeNull();
            expect(body.minRequestBps).toBeNull();
        });

        it('rejects a 241st bucket with 422', async () => {
            const res = await POST!(
                postEvent(
                    {
                        ...VALID_RESULT,
                        mode: 'long',
                        buckets: Array.from({ length: 241 }, () => ({ ms: 250, bytes: 1000 })),
                    },
                    USER,
                ),
            );

            expect(res.status).toBe(422);
            expect(mockInsertSpeedTest).not.toHaveBeenCalled();
        });

        it('defaults an omitted mode to single', async () => {
            const res = await POST!(postEvent(VALID_RESULT, USER));

            expect(res.status).toBe(201);
            const [, input] = mockInsertSpeedTest.mock.calls[0] as [unknown, InsertSpeedTestInput];
            expect(input.result.mode).toBe('single');
        });
    });

    it('documents exactly the methods it implements', () => {
        expect(Object.keys(def.handlers)).toEqual(['POST']);
        expect(Object.keys(def.docs ?? {})).toEqual(['POST']);
        expect(def.docs?.POST?.stability).toBe('beta');
        expect(def.docs?.POST?.tags).toEqual(['Network']);
    });
});
