// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/admin/playback-incidents/[id]/index.ts
 * (GET /api/admin/playback-incidents/[id]).
 *
 * Covers the 404 path, the snake_case → camelCase response mapping, and —
 * the load-bearing invariant for this admin surface — that the correlated
 * transcode-failure lookup is scoped by the INCIDENT'S OWN user_id (read
 * from the fetched row), never a client-supplied one. The delivery-evidence
 * blocks (receiver-timed windows + the user's own speed tests) are held to the
 * same scoping rule: windows by the incident's play_session_id, speed tests by
 * the incident's user_id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type { PlaybackIncidentRow } from '$lib/server/database/queries/playback-incident-events.queries.js';

const mockGetDb = vi.fn();
const mockGetPlaybackIncidentById = vi.fn();
const mockListCorrelatedTranscodeFailures = vi.fn();
const mockListDeliveryWindows = vi.fn();
const mockListRecentSpeedTests = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/playback-incident-events.queries.js', () => ({
    getPlaybackIncidentById: (...args: unknown[]) => mockGetPlaybackIncidentById(...args),
    listCorrelatedTranscodeFailures: (...args: unknown[]) =>
        mockListCorrelatedTranscodeFailures(...args),
}));

vi.mock('$lib/server/database/queries/delivery-windows.queries.js', () => ({
    listDeliveryWindows: (...args: unknown[]) => mockListDeliveryWindows(...args),
}));

vi.mock('$lib/server/database/queries/network-speed-tests.queries.js', () => ({
    listRecentSpeedTests: (...args: unknown[]) => mockListRecentSpeedTests(...args),
}));

/** One stored speed-test row, as `listRecentSpeedTests` hands it back. */
function makeSpeedTestRow() {
    return {
        id: 7,
        user_id: 'user-uuid-1',
        device_id: 'device-abc',
        client_info: null,
        bytes_requested: 20_000_000,
        bytes_received: 20_000_000,
        duration_ms: 4_000,
        ttfb_ms: 120,
        throughput_bps: 40_000_000,
        min_bucket_bps: 9_000_000,
        stall_ms: 250,
        mode: 'single' as const,
        request_count: 1,
        max_ttfb_ms: null,
        min_request_bps: null,
        gap_ms: null,
        requests: null,
        aborted: false,
        buckets: [],
        created_at: new Date('2026-09-12T11:00:00Z'),
    };
}

/** One delivery window, already projected by the query layer. */
function makeDeliveryWindow() {
    return {
        recordedAt: '2026-09-12T11:59:30.000Z',
        throughputBps: 1_200_000,
        bytes: 4_500_000,
        segments: 3,
        mediaSec: 30,
        transferMs: 29_000,
        wallMaxMs: 12_000,
        ttfbMaxMs: 800,
        minSegBps: 400_000,
        overdue: 2,
        stalls: 1,
        bufferAheadSec: 1.5,
        engine: 'native_hls',
    };
}

const { def } = await import('./index.js');

function makeRow(overrides: Partial<PlaybackIncidentRow> = {}): PlaybackIncidentRow {
    return {
        id: 1,
        attempt_id: 'a1',
        play_session_id: 's1',
        incident_at: new Date('2026-08-13T12:00:00Z'),
        occurred_at: new Date('2026-08-13T12:00:01Z'),
        trigger_type: 'error',
        error_type: 'network',
        stage: 'manifest',
        http_status: 502,
        server_diagnostic_code: null,
        reconnect_cause: null,
        message: 'boom',
        user_id: 'user-uuid-1',
        device_id: 'device-abc',
        media_id: null,
        timeline: [{ t: 0, kind: 'seek' }],
        client_info: { userAgent: 'test' },
        resolved_at: null,
        username: null,
        device_name: null,
        media_title: null,
        ...overrides,
    };
}

function makeEvent(id: string): RequestEvent {
    const url = new URL(`http://localhost/api/admin/playback-incidents/${id}`);
    return { url, params: { id } } as unknown as RequestEvent;
}

function makeCtx(id: number): ApiContext<NonNullable<typeof def.request>> {
    return {
        surface: 'internal',
        input: { body: undefined, query: undefined, params: { id } },
    } as unknown as ApiContext<NonNullable<typeof def.request>>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockListCorrelatedTranscodeFailures.mockResolvedValue([]);
    mockListDeliveryWindows.mockResolvedValue([]);
    mockListRecentSpeedTests.mockResolvedValue([]);
});

describe('GET /admin/playback-incidents/[id]', () => {
    it('returns 404 when the incident does not exist', async () => {
        mockGetPlaybackIncidentById.mockResolvedValue(null);

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent('999'), makeCtx(999))) as Response;

        expect(res.status).toBe(404);
        expect(mockListCorrelatedTranscodeFailures).not.toHaveBeenCalled();
    });

    it('maps the row to the camelCase detail shape and includes correlated failures', async () => {
        mockGetPlaybackIncidentById.mockResolvedValue(makeRow());
        mockListCorrelatedTranscodeFailures.mockResolvedValue([
            {
                occurred_at: new Date('2026-08-13T11:59:00Z'),
                category: 'gpu-failure',
                summary: 'x',
            },
        ]);

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent('1'), makeCtx(1))) as Response;

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            incident: {
                id: number;
                attemptId: string;
                userId: string | null;
                deviceId: string | null;
                timeline: unknown[];
                clientInfo: Record<string, unknown> | null;
            };
            correlatedTranscodeFailures: { category: string; summary: string | null }[];
        };

        expect(body.incident).toMatchObject({
            id: 1,
            attemptId: 'a1',
            playSessionId: 's1',
            userId: 'user-uuid-1',
            deviceId: 'device-abc',
        });
        expect(body.incident.timeline).toEqual([{ t: 0, kind: 'seek' }]);
        expect(body.incident.clientInfo).toEqual({ userAgent: 'test' });
        expect(body.correlatedTranscodeFailures).toEqual([
            { occurredAt: '2026-08-13T11:59:00.000Z', category: 'gpu-failure', summary: 'x' },
        ]);
    });

    it("scopes the correlation lookup by the incident's OWN user_id, not a client-supplied one", async () => {
        mockGetPlaybackIncidentById.mockResolvedValue(
            makeRow({ user_id: 'owner-uuid', attempt_id: 'attempt-owner' }),
        );

        const handler = def.handlers.GET!;
        await handler(makeEvent('1'), makeCtx(1));

        expect(mockListCorrelatedTranscodeFailures).toHaveBeenCalledWith(
            expect.anything(),
            'attempt-owner',
            'owner-uuid',
        );
    });

    it('skips the correlation lookup entirely when the incident has no user_id', async () => {
        mockGetPlaybackIncidentById.mockResolvedValue(makeRow({ user_id: null }));

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent('1'), makeCtx(1))) as Response;
        const body = (await res.json()) as { correlatedTranscodeFailures: unknown[] };

        expect(mockListCorrelatedTranscodeFailures).not.toHaveBeenCalled();
        expect(body.correlatedTranscodeFailures).toEqual([]);
    });

    it('returns 503 dependency_unavailable when the DB is down', async () => {
        mockGetDb.mockReturnValue(null);

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent('1'), makeCtx(1))) as Response;

        expect(res.status).toBe(503);
        expect(mockGetPlaybackIncidentById).not.toHaveBeenCalled();
    });

    it("carries the receiver-timed delivery windows for the incident's own play session", async () => {
        mockGetPlaybackIncidentById.mockResolvedValue(
            makeRow({ play_session_id: 'SESSION-Upper' }),
        );
        mockListDeliveryWindows.mockResolvedValue([makeDeliveryWindow()]);

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent('1'), makeCtx(1))) as Response;
        const body = (await res.json()) as { deliveryWindows: { throughputBps: number }[] };

        expect(res.status).toBe(200);
        // The id comes from the fetched row, not from the request.
        expect(mockListDeliveryWindows).toHaveBeenCalledWith(expect.anything(), 'SESSION-Upper');
        expect(body.deliveryWindows).toEqual([makeDeliveryWindow()]);
    });

    it("carries the user's own recent speed tests, scoped to that user and the last 7 days", async () => {
        mockGetPlaybackIncidentById.mockResolvedValue(makeRow({ user_id: 'owner-uuid' }));
        mockListRecentSpeedTests.mockResolvedValue([makeSpeedTestRow()]);

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent('1'), makeCtx(1))) as Response;
        const body = (await res.json()) as { speedTests: { id: number; createdAt: string }[] };

        expect(res.status).toBe(200);
        const [, userId, limit, since] = mockListRecentSpeedTests.mock.calls[0] as [
            unknown,
            string,
            number,
            Date,
        ];
        expect(userId).toBe('owner-uuid');
        expect(limit).toBe(5);
        const sinceDaysAgo = (Date.now() - since.getTime()) / 86_400_000;
        expect(sinceDaysAgo).toBeGreaterThan(6.9);
        expect(sinceDaysAgo).toBeLessThan(7.1);
        // Projected onto the wire shape, not the raw row.
        expect(body.speedTests).toEqual([
            {
                id: 7,
                mode: 'single',
                throughputBps: 40_000_000,
                ttfbMs: 120,
                minBucketBps: 9_000_000,
                stallMs: 250,
                requestCount: 1,
                maxTtfbMs: null,
                minRequestBps: null,
                bytesReceived: 20_000_000,
                durationMs: 4_000,
                aborted: false,
                createdAt: '2026-09-12T11:00:00.000Z',
            },
        ]);
    });

    it('skips the speed-test lookup (but not the windows) when the incident has no user_id', async () => {
        mockGetPlaybackIncidentById.mockResolvedValue(makeRow({ user_id: null }));

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent('1'), makeCtx(1))) as Response;
        const body = (await res.json()) as { speedTests: unknown[]; deliveryWindows: unknown[] };

        expect(mockListRecentSpeedTests).not.toHaveBeenCalled();
        expect(mockListDeliveryWindows).toHaveBeenCalled();
        expect(body.speedTests).toEqual([]);
        expect(body.deliveryWindows).toEqual([]);
    });

    it('skips the delivery-window query when the incident carries no play session', async () => {
        // The no-session unload beacon stores an EMPTY STRING, which can never
        // match a uuid column — no point spending a round trip on it.
        mockGetPlaybackIncidentById.mockResolvedValue(makeRow({ play_session_id: '' }));

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent('1'), makeCtx(1))) as Response;
        const body = (await res.json()) as { deliveryWindows: unknown[] };

        expect(res.status).toBe(200);
        expect(mockListDeliveryWindows).not.toHaveBeenCalled();
        expect(body.deliveryWindows).toEqual([]);
    });

    it('returns 500 internal_error (not an uncaught exception) for an unrecognized trigger_type', async () => {
        mockGetPlaybackIncidentById.mockResolvedValue(makeRow({ trigger_type: 'bogus' }));

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent('1'), makeCtx(1))) as Response;

        expect(res.status).toBe(500);
    });
});
