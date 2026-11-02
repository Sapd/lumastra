// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards the published contract of the smart-download candidates def, which
 * had zero handler-level coverage before this suite: `rank` assignment, the
 * `reason` mapping ('rating' -> 'favourite', 'play_count' -> 'heavy_rotation'),
 * `reasonSubject` null-vs-object, `estBytes` wiring through `bitrateKbps`,
 * `maxConcurrentDownloads`, the unknown-lane 422, and the 429/401/503 gates.
 *
 * The pure helpers (`estimateBytes`, `mergeRotationSources`) already have
 * unit coverage in candidates.test.ts — this file is specifically the HTTP
 * handler wiring around them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetSql = vi.fn();
const mockGetRotationHeadByPlayCount = vi.fn();
const mockGetRotationHeadByRating = vi.fn();
const mockGetRotationEtagInputs = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockCheckRateLimit = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/music-downloads.queries.js', () => ({
    getRotationHeadByPlayCount: (...args: unknown[]) => mockGetRotationHeadByPlayCount(...args),
    getRotationHeadByRating: (...args: unknown[]) => mockGetRotationHeadByRating(...args),
    getRotationEtagInputs: (...args: unknown[]) => mockGetRotationEtagInputs(...args),
    ROTATION_SCORE_VERSION: 1,
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
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

// maxConcurrentDownloads() = perUser < 2 ? 0 : min(2, floor(perUser / 2)).
// A value of 4 exercises the min(2, ...) clamp, which is the interesting branch.
// Held in a mutable vi.hoisted object (rather than a plain literal in the
// factory) so individual tests can flip MUSIC_TRANSCODE_MAX_PER_USER to
// exercise the perUser < 2 branch too, then restore it.
const mockConfig = vi.hoisted(() => ({ MUSIC_TRANSCODE_MAX_PER_USER: 4 }));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
}));

const { def, computeCandidatesEtag, etagMatches } = await import('./candidates.js');

function makeEvent(headers?: Record<string, string>): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/v1/music/downloads/candidates?lane=rotation'),
        params: {},
        request: new Request('http://localhost/api/v1/music/downloads/candidates?lane=rotation', {
            headers,
        }),
    } as unknown as RequestEvent;
}

function makeCtx(query: { lane?: string; want?: number; bitrateKbps?: number } = {}) {
    return {
        surface: 'v1',
        input: {
            query: { lane: 'rotation', want: 100, bitrateKbps: 128, ...query },
            body: undefined,
            params: undefined,
        },
    };
}

describe('candidates published contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        mockGetRotationHeadByPlayCount.mockResolvedValue([]);
        mockGetRotationHeadByRating.mockResolvedValue([]);
        mockGetRotationEtagInputs.mockResolvedValue({
            musicStateMaxLastPlayed: null,
            musicStateCount: 0,
            musicStatePlayCountSum: 0,
            ratingsMaxUpdated: null,
            ratingsCount: 0,
        });
    });

    it('returns 401 when unauthenticated', async () => {
        const event = { ...makeEvent(), locals: { user: null } } as unknown as RequestEvent;
        const res = await def.handlers.GET!(event, makeCtx() as never);
        expect(res.status).toBe(401);
    });

    it('checks the rate limit AFTER the DB-availability check', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        expect(res.status).toBe(503);
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('returns 429 when the per-user limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: Date.now() / 1000 + 30 });
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        expect(res.status).toBe(429);
        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            expect.stringContaining('u1'),
            expect.any(Number),
            expect.any(Number),
        );
    });

    it('returns 422 for an unsupported lane', async () => {
        const res = await def.handlers.GET!(makeEvent(), makeCtx({ lane: 'discovery' }) as never);
        expect(res.status).toBe(422);
    });

    it('assigns contiguous rank starting at 0, in merged order', async () => {
        mockGetRotationHeadByPlayCount.mockResolvedValue([
            {
                media_id: 'p1',
                title: 'P1',
                artist_id: null,
                artist_title: '',
                runtime_seconds: 100,
                play_count: 5,
                source: 'play_count',
            },
            {
                media_id: 'p2',
                title: 'P2',
                artist_id: null,
                artist_title: '',
                runtime_seconds: 100,
                play_count: 3,
                source: 'play_count',
            },
        ]);

        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.candidates.map((c: { rank: number }) => c.rank)).toEqual([0, 1]);
    });

    it('maps a rating-sourced row to reason "favourite"', async () => {
        mockGetRotationHeadByRating.mockResolvedValue([
            {
                media_id: 'r1',
                title: 'R1',
                artist_id: 'a1',
                artist_title: 'Artist',
                runtime_seconds: 100,
                play_count: 0,
                source: 'rating',
            },
        ]);

        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.candidates[0].reason).toBe('favourite');
    });

    it('maps a play-count-sourced row to reason "heavy_rotation"', async () => {
        mockGetRotationHeadByPlayCount.mockResolvedValue([
            {
                media_id: 'p1',
                title: 'P1',
                artist_id: 'a1',
                artist_title: 'Artist',
                runtime_seconds: 100,
                play_count: 5,
                source: 'play_count',
            },
        ]);

        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.candidates[0].reason).toBe('heavy_rotation');
    });

    it('sets reasonSubject to an artist object when artist_id is present', async () => {
        mockGetRotationHeadByPlayCount.mockResolvedValue([
            {
                media_id: 'p1',
                title: 'P1',
                artist_id: 'a1',
                artist_title: 'Artist One',
                runtime_seconds: 100,
                play_count: 5,
                source: 'play_count',
            },
        ]);

        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.candidates[0].reasonSubject).toEqual({
            type: 'artist',
            id: 'a1',
            name: 'Artist One',
        });
    });

    it('sets reasonSubject to null when artist_id is absent', async () => {
        mockGetRotationHeadByPlayCount.mockResolvedValue([
            {
                media_id: 'p1',
                title: 'P1',
                artist_id: null,
                artist_title: '',
                runtime_seconds: 100,
                play_count: 5,
                source: 'play_count',
            },
        ]);

        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.candidates[0].reasonSubject).toBeNull();
    });

    it('wires bitrateKbps into estBytes: 240s at 128kbps = 3_840_000 bytes', async () => {
        mockGetRotationHeadByPlayCount.mockResolvedValue([
            {
                media_id: 'p1',
                title: 'P1',
                artist_id: null,
                artist_title: '',
                runtime_seconds: 240,
                play_count: 5,
                source: 'play_count',
            },
        ]);

        const res = await def.handlers.GET!(makeEvent(), makeCtx({ bitrateKbps: 128 }) as never);
        const body = await res.json();

        expect(body.candidates[0].estBytes).toBe(3_840_000);
    });

    it('returns null estBytes when runtime is unknown', async () => {
        mockGetRotationHeadByPlayCount.mockResolvedValue([
            {
                media_id: 'p1',
                title: 'P1',
                artist_id: null,
                artist_title: '',
                runtime_seconds: null,
                play_count: 5,
                source: 'play_count',
            },
        ]);

        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.candidates[0].estBytes).toBeNull();
    });

    it('derives maxConcurrentDownloads from the per-user transcode cap, clamped to 2', async () => {
        // MUSIC_TRANSCODE_MAX_PER_USER=4 -> floor(4/2)=2 -> min(2,2)=2
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.maxConcurrentDownloads).toBe(2);
    });

    it('returns 200 with maxConcurrentDownloads: 0 when the per-user transcode cap leaves no spare capacity', async () => {
        // A server configured with MUSIC_TRANSCODE_MAX_PER_USER=1 has no room to
        // spare for a pool download once playback's own slots are accounted for,
        // so maxConcurrentDownloads() truthfully returns 0. The response schema
        // must accept that value (min(0), not min(1)) or this legitimate,
        // low-capacity configuration 500s on every request instead of serving a
        // 200 that tells the client to stand its download pool down.
        mockConfig.MUSIC_TRANSCODE_MAX_PER_USER = 1;
        try {
            const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);

            expect(res.status).toBe(200);

            const body = await res.json();
            expect(body.maxConcurrentDownloads).toBe(0);
        } finally {
            mockConfig.MUSIC_TRANSCODE_MAX_PER_USER = 4;
        }
    });

    it('keys the rate limit per (user, lane) so two lanes get independent budgets', async () => {
        await def.handlers.GET!(makeEvent(), makeCtx({ lane: 'rotation' }) as never);
        await def.handlers.GET!(makeEvent(), makeCtx({ lane: 'discovery' }) as never);

        expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
        const keys = mockCheckRateLimit.mock.calls.map((call) => call[0] as string);
        expect(keys[0]).not.toBe(keys[1]);
        expect(keys[0]).toContain(':rotation');
        expect(keys[1]).toContain(':discovery');
    });

    it('stamps scoreVersion on the response, from ROTATION_SCORE_VERSION', async () => {
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.scoreVersion).toBe(1);
    });
});

describe('computeCandidatesEtag (Change 4 — pure validator)', () => {
    const baseInputs = {
        musicStateMaxLastPlayed: new Date('2026-08-01T00:00:00Z'),
        musicStateCount: 10,
        musicStatePlayCountSum: 42,
        ratingsMaxUpdated: new Date('2026-08-02T00:00:00Z'),
        ratingsCount: 5,
    };
    const params = { lane: 'rotation', want: 100, bitrateKbps: 128 };
    const now = Date.parse('2026-08-20T10:05:00Z');

    it('is identical for identical inputs (same time bucket)', () => {
        const a = computeCandidatesEtag(baseInputs, params, now);
        const b = computeCandidatesEtag(baseInputs, params, now);
        expect(a).toBe(b);
    });

    it('changes when musicStateCount changes', () => {
        const a = computeCandidatesEtag(baseInputs, params, now);
        const b = computeCandidatesEtag({ ...baseInputs, musicStateCount: 11 }, params, now);
        expect(a).not.toBe(b);
    });

    it('changes when ratingsMaxUpdated changes', () => {
        const a = computeCandidatesEtag(baseInputs, params, now);
        const b = computeCandidatesEtag(
            { ...baseInputs, ratingsMaxUpdated: new Date('2026-08-03T00:00:00Z') },
            params,
            now,
        );
        expect(a).not.toBe(b);
    });

    it('changes when want or bitrateKbps changes, even with identical DB state', () => {
        const a = computeCandidatesEtag(baseInputs, params, now);
        const b = computeCandidatesEtag(baseInputs, { ...params, want: 200 }, now);
        const c = computeCandidatesEtag(baseInputs, { ...params, bitrateKbps: 320 }, now);
        expect(a).not.toBe(b);
        expect(a).not.toBe(c);
    });

    it('changes once the wall clock crosses into a new 15-minute bucket', () => {
        const a = computeCandidatesEtag(baseInputs, params, now);
        const fifteenMinutesLater = now + 15 * 60 * 1000;
        const b = computeCandidatesEtag(baseInputs, params, fifteenMinutesLater);
        expect(a).not.toBe(b);
    });

    it('is a strong (unquoted-prefix) validator', () => {
        const etag = computeCandidatesEtag(baseInputs, params, now);
        expect(etag.startsWith('"')).toBe(true);
        expect(etag.startsWith('W/')).toBe(false);
    });
});

describe('etagMatches', () => {
    it('matches an exact single value', () => {
        expect(etagMatches('"abc123"', '"abc123"')).toBe(true);
    });

    it('matches one entry in a comma-separated list', () => {
        expect(etagMatches('"zzz", "abc123", "yyy"', '"abc123"')).toBe(true);
    });

    it('matches the * wildcard', () => {
        expect(etagMatches('*', '"abc123"')).toBe(true);
    });

    it('does not match a different value', () => {
        expect(etagMatches('"zzz"', '"abc123"')).toBe(false);
    });
});

describe('candidates ETag / If-None-Match wiring (Change 4)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        mockGetRotationHeadByPlayCount.mockResolvedValue([]);
        mockGetRotationHeadByRating.mockResolvedValue([]);
        mockGetRotationEtagInputs.mockResolvedValue({
            musicStateMaxLastPlayed: new Date('2026-08-01T00:00:00Z'),
            musicStateCount: 10,
            musicStatePlayCountSum: 42,
            ratingsMaxUpdated: new Date('2026-08-02T00:00:00Z'),
            ratingsCount: 5,
        });
    });

    it('emits an ETag header on the 200 response', async () => {
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        expect(res.status).toBe(200);
        expect(res.headers.get('etag')).toMatch(/^".+"$/);
    });

    it('emits the same ETag across two calls with unchanged state', async () => {
        const res1 = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const res2 = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        expect(res1.headers.get('etag')).toBe(res2.headers.get('etag'));
    });

    it('emits a different ETag once the underlying state changes', async () => {
        const res1 = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        mockGetRotationEtagInputs.mockResolvedValue({
            musicStateMaxLastPlayed: new Date('2026-08-05T00:00:00Z'),
            musicStateCount: 11,
            musicStatePlayCountSum: 50,
            ratingsMaxUpdated: new Date('2026-08-02T00:00:00Z'),
            ratingsCount: 5,
        });
        const res2 = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        expect(res1.headers.get('etag')).not.toBe(res2.headers.get('etag'));
    });

    it('returns 304 with no body when If-None-Match matches, and does NOT consume rate-limit budget', async () => {
        const first = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const etag = first.headers.get('etag')!;
        mockCheckRateLimit.mockClear();

        const second = await def.handlers.GET!(
            makeEvent({ 'If-None-Match': etag }),
            makeCtx() as never,
        );

        expect(second.status).toBe(304);
        expect(await second.text()).toBe('');
        // MUTATION CHECK (see task instructions): temporarily moving the
        // rate-limit call above the ETag short-circuit in candidates.ts makes
        // this assertion fail, which is what proves it is actually guarding
        // the "304 must not burn budget" contract and not just trivially
        // green.
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('proceeds to the full query (200) when If-None-Match does not match', async () => {
        const res = await def.handlers.GET!(
            makeEvent({ 'If-None-Match': '"stale-etag"' }),
            makeCtx() as never,
        );
        expect(res.status).toBe(200);
        expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    });
});
