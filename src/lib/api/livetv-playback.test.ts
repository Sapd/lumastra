// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    getStreamInfoWithLimitCheck,
    getPlaybackSessionFailure,
    sendHeartbeat,
    searchPrograms,
    groupProgramAirings,
} from './livetv-playback.js';
import { ProgramSearchResponseSchema } from '$lib/schemas/livetv.js';

const ST = '11111111-1111-4111-8111-111111111111';
const AIRING = '22222222-2222-4222-8222-222222222222';

describe('getStreamInfoWithLimitCheck', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('returns a superseded error for a superseded 410 without reporting a kick', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ reason: 'superseded' }), { status: 410 }),
            );

        expect(await getStreamInfoWithLimitCheck('ch-1')).toEqual({
            ok: false,
            error: 'superseded',
            status: 410,
        });
    });

    it('reports a kick for an evicted 410 with higher-priority details', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(
                new Response(
                    JSON.stringify({ reason: 'evicted', details: 'higher_priority_viewer' }),
                    { status: 410 },
                ),
            );

        expect(await getStreamInfoWithLimitCheck('ch-1')).toEqual({
            ok: false,
            kicked: true,
            reason: 'evicted',
        });
    });

    it('returns { ok: true, streamInfo } on 201', async () => {
        const streamInfo = {
            playbackSessionId: '00000000-0000-4000-8000-000000000001',
            kind: 'live',
            stationId: '00000000-0000-4000-8000-000000000002',
            reporting: {
                kind: 'keepalive',
                method: 'POST',
                playbackSessionId: '00000000-0000-4000-8000-000000000001',
                intervalMs: 10_000,
                href: '/api/livetv/playback-sessions/00000000-0000-4000-8000-000000000001/keepalive',
            },
            delivery: {
                kind: 'live-hls',
                url: '/api/livetv/channels/ch-1/stream/master.m3u8',
                feedId: '00000000-0000-4000-8000-000000000003',
                requestedQuality: 'server',
                appliedQuality: 'original',
                requiresProxy: true,
                sourceId: 'src-1',
                maxStreams: 2,
                rungId: null,
                requestedMaxBitrateBps: null,
                appliedMaxBitrateBps: null,
                appliedMaxHeight: null,
                reason: null,
            },
            grant: {
                id: '00000000-0000-4000-8000-000000000009',
                ipPinned: true,
                token: 'tok',
                mediaId: '00000000-0000-4000-8000-000000000002',
                playbackSessionId: '00000000-0000-4000-8000-000000000001',
                kind: 'live',
                param: 'grant',
                expiresAt: '2099-01-01T00:00:00.000Z',
                renewAfter: '2098-12-31T23:55:00.000Z',
                renewHref: '/api/v1/playback/grants/00000000-0000-4000-8000-000000000009/renew',
            },
        };

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 201,
            json: () => Promise.resolve(streamInfo),
        });

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.streamInfo.delivery.url).toBe(streamInfo.delivery.url);
            expect(result.streamInfo.delivery.requiresProxy).toBe(true);
        }
    });

    it('sends the requested bitrate ceiling', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 201,
            json: () =>
                Promise.resolve({
                    grant: {
                        id: '00000000-0000-4000-8000-000000000009',
                        ipPinned: true,
                        token: 'tok',
                        mediaId: '00000000-0000-4000-8000-000000000002',
                        playbackSessionId: '00000000-0000-4000-8000-000000000001',
                        kind: 'live',
                        param: 'grant',
                        expiresAt: '2099-01-01T00:00:00.000Z',
                        renewAfter: '2098-12-31T23:55:00.000Z',
                        renewHref:
                            '/api/v1/playback/grants/00000000-0000-4000-8000-000000000009/renew',
                    },
                    playbackSessionId: '00000000-0000-4000-8000-000000000001',
                    kind: 'live',
                    stationId: '00000000-0000-4000-8000-000000000002',
                    reporting: {
                        kind: 'keepalive',
                        method: 'POST',
                        playbackSessionId: '00000000-0000-4000-8000-000000000001',
                        intervalMs: 10_000,
                        href: '/api/livetv/playback-sessions/00000000-0000-4000-8000-000000000001/keepalive',
                    },
                    delivery: {
                        kind: 'live-hls',
                        url: '/api/livetv/channels/ch-1/stream/r/540p2m/master.m3u8',
                        feedId: '00000000-0000-4000-8000-000000000003',
                        requestedQuality: 'server',
                        appliedQuality: 'original',
                        requiresProxy: true,
                        rungId: '540p2m',
                        requestedMaxBitrateBps: 3_000_000,
                        appliedMaxBitrateBps: 2_000_000,
                        appliedMaxHeight: 540,
                        reason: null,
                    },
                }),
        });

        const result = await getStreamInfoWithLimitCheck('ch/1', 3_000_000);

        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/api/livetv/playback-sessions',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ stationId: 'ch/1', maxBitrateBps: 3000000 }),
            }),
        );
        expect(result).toMatchObject({
            ok: true,
            streamInfo: {
                delivery: { appliedMaxBitrateBps: 2_000_000, appliedMaxHeight: 540 },
            },
        });
    });

    it('forwards an abort signal to the stream request', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 201,
            json: () =>
                Promise.resolve({
                    grant: {
                        id: '00000000-0000-4000-8000-000000000009',
                        ipPinned: true,
                        token: 'tok',
                        mediaId: '00000000-0000-4000-8000-000000000002',
                        playbackSessionId: '00000000-0000-4000-8000-000000000001',
                        kind: 'live',
                        param: 'grant',
                        expiresAt: '2099-01-01T00:00:00.000Z',
                        renewAfter: '2098-12-31T23:55:00.000Z',
                        renewHref:
                            '/api/v1/playback/grants/00000000-0000-4000-8000-000000000009/renew',
                    },
                    playbackSessionId: '00000000-0000-4000-8000-000000000001',
                    kind: 'live',
                    stationId: '00000000-0000-4000-8000-000000000002',
                    reporting: {
                        kind: 'keepalive',
                        method: 'POST',
                        playbackSessionId: '00000000-0000-4000-8000-000000000001',
                        intervalMs: 10_000,
                        href: '/api/livetv/playback-sessions/00000000-0000-4000-8000-000000000001/keepalive',
                    },
                    delivery: {
                        kind: 'live-hls',
                        url: '/api/livetv/channels/ch-1/stream/master.m3u8',
                        feedId: '00000000-0000-4000-8000-000000000003',
                        requestedQuality: 'server',
                        appliedQuality: 'original',
                        requiresProxy: true,
                        rungId: null,
                        requestedMaxBitrateBps: null,
                        appliedMaxBitrateBps: null,
                        appliedMaxHeight: null,
                        reason: null,
                    },
                }),
        });
        const controller = new AbortController();

        await getStreamInfoWithLimitCheck('ch-1', undefined, controller.signal);

        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/api/livetv/playback-sessions',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ stationId: 'ch-1', quality: 'server' }),
                signal: controller.signal,
            }),
        );
    });

    it('returns { ok: false, streamLimit } on 503 with valid body', async () => {
        const limitBody = {
            error: 'stream_limit_reached',
            limit: 2,
            active: [{ channelId: 'ch-2', channelName: 'LRV', viewers: 2 }],
            showActiveStreams: true,
        };

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            json: () => Promise.resolve(limitBody),
        });

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result.ok).toBe(false);
        if (!result.ok && 'streamLimit' in result) {
            expect(result.streamLimit.limit).toBe(2);
            expect(result.streamLimit.active).toHaveLength(1);
            expect(result.streamLimit.active[0].channelName).toBe('LRV');
            expect(result.streamLimit.showActiveStreams).toBe(true);
        } else {
            expect.fail('Expected streamLimit in result');
        }
    });

    // The /api/livetv/.../stream def answers with problem+json — `code`,
    // a human-readable `error`, and the structured payload JSON-encoded in
    // `details` (see streamLimitResponse in stream-helpers.ts). Parsing only
    // the flat legacy shape silently degraded every real stream-limit refusal
    // to "Stream unavailable (503)", so the grid's stream-limit modal never
    // opened and the player showed a generic failure.
    it('returns { ok: false, streamLimit } on a problem+json 503', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            json: () =>
                Promise.resolve({
                    code: 'stream_limit',
                    error: 'Stream limit reached — no viewer slot available',
                    status: 503,
                    retryAfter: 30,
                    details: JSON.stringify({
                        limit: 2,
                        active: [{ channelId: 'ch-2', channelName: 'LRV', viewers: 2 }],
                        showActiveStreams: true,
                    }),
                }),
        });

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result.ok).toBe(false);
        if (!result.ok && 'streamLimit' in result) {
            expect(result.streamLimit.limit).toBe(2);
            expect(result.streamLimit.active[0].channelName).toBe('LRV');
            expect(result.streamLimit.showActiveStreams).toBe(true);
        } else {
            expect.fail('Expected streamLimit in result');
        }
    });

    it('returns { ok: false, error } on 503 with invalid body', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            json: () => Promise.resolve({ error: 'something_else' }),
        });

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result.ok).toBe(false);
        if (!result.ok && 'error' in result) {
            expect(result.error).toContain('503');
        } else {
            expect.fail('Expected error string in result');
        }
    });

    it('returns { ok: false, error } on other HTTP errors (404)', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ message: 'Not found' }),
        });

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result.ok).toBe(false);
        if (!result.ok && 'error' in result) {
            expect(result.error).toContain('404');
        } else {
            expect.fail('Expected error string in result');
        }
    });

    it('returns { ok: false, error } on 500 server error', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ message: 'Internal error' }),
        });

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result.ok).toBe(false);
        if (!result.ok && 'error' in result) {
            expect(result.error).toContain('500');
        } else {
            expect.fail('Expected error string in result');
        }
    });

    it.each([
        ['channel_offline', 502, false, undefined],
        ['provider_auth_failed', 502, false, undefined],
        ['provider_connection_limit', 503, true, 30_000],
        ['provider_unreachable', 504, true, 10_000],
        ['geo_blocked', 502, false, undefined],
        ['no_video', 502, false, undefined],
        ['encoder_failed', 500, true, 5_000],
        ['all_feeds_failed', 502, false, undefined],
        ['upstream_stalled', 502, true, 3_000],
        ['dependency_unavailable', 503, true, 5_000],
    ])(
        'returns a typed failure for problem code %s (%i)',
        async (code, status, retryable, wait) => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status,
                json: () =>
                    Promise.resolve({
                        code,
                        error: 'x',
                        status,
                        failure: { retryable },
                        ...(wait !== undefined ? { retryAfter: wait / 1000 } : {}),
                    }),
            });

            const result = await getStreamInfoWithLimitCheck('ch-1');
            expect(result).toEqual({
                ok: false,
                failure: {
                    kind: 'failure',
                    code,
                    retryable,
                    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
                },
            });
        },
    );

    it('carries feedsTried for admins and takes retry fields from the body', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 502,
            json: () =>
                Promise.resolve({
                    code: 'all_feeds_failed',
                    retryAfter: 10,
                    failure: {
                        retryable: true,
                        feedsTried: [
                            { feedId: 'f1', feedName: 'Main', reason: 'provider_unreachable' },
                            { feedId: 'f2', reason: 'channel_offline', upstreamStatus: 404 },
                        ],
                    },
                }),
        });

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result).toMatchObject({
            ok: false,
            failure: {
                code: 'all_feeds_failed',
                retryable: true,
                retryAfterMs: 10_000,
                feedsTried: [
                    { feedId: 'f1', feedName: 'Main', reason: 'provider_unreachable' },
                    { feedId: 'f2', reason: 'channel_offline', upstreamStatus: 404 },
                ],
            },
        });
    });

    it('keeps stream_limit as a stream limit, not a failure', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            json: () =>
                Promise.resolve({
                    code: 'stream_limit',
                    retryable: true,
                    details: JSON.stringify({
                        limit: 2,
                        active: [],
                        showActiveStreams: false,
                    }),
                }),
        });

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result).toMatchObject({ ok: false, streamLimit: { limit: 2 } });
    });

    it('returns { ok: false, error } for a body without a known code', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 502,
            json: () => Promise.resolve({ error: 'totally_unknown_code' }),
        });

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result.ok).toBe(false);
        if (!result.ok && 'error' in result) {
            expect(result.error).toContain('502');
        } else {
            expect.fail('Expected error string in result');
        }
    });

    it('returns { ok: false, error } when the failure body is not JSON', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 502,
            json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        });

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result).toEqual({ ok: false, error: 'Stream unavailable (502)', status: 502 });
    });

    it('treats a network error as dependency_unavailable (retryable)', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

        const result = await getStreamInfoWithLimitCheck('ch-1');
        expect(result).toMatchObject({
            ok: false,
            failure: { code: 'dependency_unavailable', retryable: true },
        });
    });
});

describe('sendHeartbeat', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('returns the typed failure of a keepalive 410 with reason failed', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 410,
            json: () =>
                Promise.resolve({
                    code: 'upstream_stalled',
                    error: 'playback_session_ended',
                    reason: 'failed',
                    retryAfter: 3,
                    failure: { retryable: true },
                }),
        });
        const result = await sendHeartbeat('s1');
        expect(result.reason).toBe('failed');
        expect(result.failure).toEqual({
            kind: 'failure',
            code: 'upstream_stalled',
            retryable: true,
            retryAfterMs: 3000,
        });
    });

    it('has no failure for an eviction 410', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 410,
            json: () =>
                Promise.resolve({
                    code: 'gone',
                    error: 'playback_session_ended',
                    reason: 'evicted',
                }),
        });
        const result = await sendHeartbeat('s1');
        expect(result.reason).toBe('evicted');
        expect(result.failure).toBeUndefined();
    });
});

describe('getPlaybackSessionFailure', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('reads the failure block of an ended session', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: () =>
                Promise.resolve({
                    state: 'ended',
                    endReason: 'failed',
                    failure: { code: 'geo_blocked', retryable: false, at: '2026-10-20T10:00:00Z' },
                }),
        });
        expect(await getPlaybackSessionFailure('s1')).toEqual({
            kind: 'failure',
            code: 'geo_blocked',
            retryable: false,
        });
    });

    it('returns null without a failure block, on an error status and on a network error', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ state: 'active' }),
        });
        expect(await getPlaybackSessionFailure('s1')).toBeNull();
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
        expect(await getPlaybackSessionFailure('s1')).toBeNull();
        globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('offline'));
        expect(await getPlaybackSessionFailure('s1')).toBeNull();
    });
});

describe('searchPrograms', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('calls correct URL with encoded query and limit', async () => {
        const mockResponse = {
            items: [],
            page: { limit: 5, offset: 0, hasMore: false },
        };

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.resolve(mockResponse),
        });

        await searchPrograms('test query', 5);

        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/api/livetv/programs/search?q=test%20query&limit=5',
            expect.any(Object),
        );
    });

    it('uses default limit of 30', async () => {
        const mockResponse = {
            items: [],
            page: { limit: 10, offset: 0, hasMore: false },
        };

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.resolve(mockResponse),
        });

        await searchPrograms('batman');

        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/api/livetv/programs/search?q=batman&limit=30',
            expect.any(Object),
        );
    });

    it('returns validated data on success', async () => {
        const mockResponse = {
            items: [
                {
                    id: AIRING,
                    stationId: ST,
                    title: 'News',
                    temporalStatus: 'live',
                    startTime: '2026-03-11T20:00:00Z',
                    endTime: '2026-03-11T21:00:00Z',
                    station: { id: ST, name: 'LRV', images: {} },
                },
            ],
            page: { limit: 10, offset: 0, hasMore: false, total: 1 },
        };

        globalThis.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify(mockResponse), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const result = await searchPrograms('news');
        expect(result.data).toBeDefined();
        expect(result.data?.items).toHaveLength(1);
        expect(result.data?.items[0].title).toBe('News');
        expect(result.data?.items[0].temporalStatus).toBe('live');
    });
});

describe('ProgramSearchResponseSchema validation', () => {
    it('validates a valid response', () => {
        const valid = {
            items: [
                {
                    id: AIRING,
                    stationId: ST,
                    title: 'Test Program',
                    description: 'A description',
                    temporalStatus: 'live',
                    startTime: '2026-03-11T20:00:00Z',
                    endTime: '2026-03-11T21:00:00Z',
                    station: {
                        id: ST,
                        name: 'Channel 1',
                        images: {
                            primary: { href: '/logo.png', revision: '0', source: 'self' },
                        },
                    },
                },
            ],
            page: { limit: 20, offset: 0, hasMore: false, total: 1 },
        };
        const result = ProgramSearchResponseSchema.safeParse(valid);
        expect(result.success).toBe(true);
    });

    it('rejects invalid temporalStatus', () => {
        const invalid = {
            items: [
                {
                    id: AIRING,
                    stationId: ST,
                    title: 'Test',
                    temporalStatus: 'invalid_status',
                    startTime: '2026-03-11T20:00:00Z',
                    endTime: '2026-03-11T21:00:00Z',
                    station: { id: ST, name: 'X', images: {} },
                },
            ],
            page: { limit: 20, offset: 0, hasMore: false },
        };
        const result = ProgramSearchResponseSchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });

    it('accepts empty items array', () => {
        const valid = {
            items: [],
            page: { limit: 20, offset: 0, hasMore: false, total: 0 },
        };
        const result = ProgramSearchResponseSchema.safeParse(valid);
        expect(result.success).toBe(true);
    });

    it('accepts item without description (optional field)', () => {
        const valid = {
            items: [
                {
                    id: AIRING,
                    stationId: ST,
                    title: 'No Description',
                    temporalStatus: 'upcoming_today',
                    startTime: '2026-03-11T20:00:00Z',
                    endTime: '2026-03-11T21:00:00Z',
                    station: { id: ST, name: 'KWF', images: {} },
                },
            ],
            page: { limit: 20, offset: 0, hasMore: false, total: 1 },
        };
        const result = ProgramSearchResponseSchema.safeParse(valid);
        expect(result.success).toBe(true);
    });
});

describe('groupProgramAirings', () => {
    const airing = (id: string, stationId: string, title: string, start: string) => ({
        id,
        stationId,
        title,
        startTime: start,
        endTime: '2026-03-11T22:00:00.000Z',
        temporalStatus: 'live' as const,
        station: { id: stationId, name: `Station ${stationId}`, images: {} },
    });

    it('merges the same show across stations and keeps server order', () => {
        const grouped = groupProgramAirings([
            airing('a1', 's1', 'Evening News', '2026-03-11T20:00:00.000Z'),
            airing('a2', 's2', 'Other Show', '2026-03-11T20:00:00.000Z'),
            airing('a3', 's2', 'evening news', '2026-03-11T20:30:00.000Z'),
            airing('a4', 's1', 'Evening News', '2026-03-11T21:00:00.000Z'),
        ]);
        expect(grouped.map((g) => g.title)).toEqual(['Evening News', 'Other Show']);
        expect(grouped[0].channels.map((c) => c.id)).toEqual(['s1', 's2']);
        expect(grouped[0].startTime).toBe('2026-03-11T20:00:00.000Z');
    });

    it('keeps different days and temporal statuses apart', () => {
        const next = { ...airing('b', 's1', 'News', '2026-03-12T20:00:00.000Z') };
        const ended = {
            ...airing('c', 's1', 'News', '2026-03-11T20:00:00.000Z'),
            temporalStatus: 'ended' as const,
        };
        expect(
            groupProgramAirings([
                airing('a', 's1', 'News', '2026-03-11T20:00:00.000Z'),
                next,
                ended,
            ]),
        ).toHaveLength(3);
    });
});
