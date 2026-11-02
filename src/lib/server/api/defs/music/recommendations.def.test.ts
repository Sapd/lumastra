// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

/**
 * Guards the per-user rate limit on the POST /music/recommendations cold start (mood seed). The underlying
 * query is an uncacheable full-library scan (random() over non-indexable
 * JSONB predicates plus a per-row cosine), and the endpoint is published on
 * /api/v1, where nothing else throttles an authenticated caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckRateLimit = vi.fn();
const mockGetSql = vi.fn();

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

const mockGetMoodBootstrapTrack = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockGetTrackDetail = vi.fn();
const mockIsMediaItemOfType = vi.fn();
const mockRecommendNext = vi.fn();

vi.mock('$lib/server/services/music/recommendations.service.js', () => ({
    recommendNext: (...args: unknown[]) => mockRecommendNext(...args),
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    isMediaItemOfType: (...args: unknown[]) => mockIsMediaItemOfType(...args),
    getMoodBootstrapTrack: (...args: unknown[]) => mockGetMoodBootstrapTrack(...args),
    getTrackDetail: (...args: unknown[]) => mockGetTrackDetail(...args),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

const { def } = await import('./recommendations.js');

function makeEvent(): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/v1/music/recommendations'),
        params: {},
        request: new Request('http://localhost/api/v1/music/recommendations', { method: 'POST' }),
    } as unknown as RequestEvent;
}

describe('recommendations cold-start rate limiting', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
    });

    it('returns 429 when the per-user limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({
            allowed: false,
            resetAt: Date.now() / 1000 + 30,
        });

        const res = await def.handlers.POST!(makeEvent(), {
            surface: 'v1',
            input: { body: { seed: { type: 'mood', mood: 'chill' } } },
        } as never);

        expect(res.status).toBe(429);
        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            expect.stringContaining('u1'),
            expect.any(Number),
            expect.any(Number),
        );
    });
});

describe('recommendations request rules', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockCheckRateLimit.mockResolvedValue({
            allowed: true,
            total: 30,
            remaining: 29,
            resetAt: Date.now() / 1000 + 60,
        });
        mockCheckMediaAccess.mockResolvedValue(true);
        mockIsMediaItemOfType.mockResolvedValue(true);
    });

    const post = (body: unknown) =>
        def.handlers.POST!(makeEvent(), { surface: 'v1', input: { body } } as never);

    it.each([
        [
            'an artist seed',
            { seed: { type: 'artist', id: '11111111-1111-4111-8111-111111111111' } },
        ],
        ['a genre seed', { seed: { type: 'genre', genre: 'Trance' } }],
        ['no seed at all', {}],
    ])('answers 422 without a current track for %s', async (_label, body) => {
        const res = await post(body);
        expect(res.status).toBe(422);
        expect(mockGetMoodBootstrapTrack).not.toHaveBeenCalled();
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('cold start: a mood seed alone returns the radio track, no alternatives, source mood', async () => {
        mockGetMoodBootstrapTrack.mockResolvedValue({
            id: '22222222-2222-4222-8222-222222222222',
            title: 'Opener',
            custom_metadata: {},
        });
        const res = await post({ seed: { type: 'mood', mood: 'chill' } });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.source).toBe('mood');
        expect(data.alternatives).toEqual([]);
        expect(data.next.id).toBe('22222222-2222-4222-8222-222222222222');
        expect(mockGetMoodBootstrapTrack).toHaveBeenCalledWith({}, 'chill', 'u1');
    });

    it('cold start: nothing fitting the mood is a 404, never a null next', async () => {
        mockGetMoodBootstrapTrack.mockResolvedValue(null);
        const res = await post({ seed: { type: 'mood', mood: 'chill' } });
        expect(res.status).toBe(404);
    });

    it('an unknown current track is a 404', async () => {
        mockGetTrackDetail.mockResolvedValue(null);
        const res = await post({
            context: { currentTrackId: '33333333-3333-4333-8333-333333333333' },
        });
        expect(res.status).toBe(404);
    });

    it('an inaccessible artist seed is a 404', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await post({
            seed: { type: 'artist', id: '11111111-1111-4111-8111-111111111111' },
            context: { currentTrackId: '33333333-3333-4333-8333-333333333333' },
        });
        expect(res.status).toBe(404);
        expect(mockGetTrackDetail).not.toHaveBeenCalled();
    });

    it('answers 503 when the database is down', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await post({ seed: { type: 'mood', mood: 'chill' } });
        expect(res.status).toBe(503);
    });
});

describe('recommendations seed and cold-start rules', () => {
    const ARTIST = '11111111-1111-4111-8111-111111111111';
    const TRACK = '33333333-3333-4333-8333-333333333333';
    const OTHER = '44444444-4444-4444-8444-444444444444';

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockCheckRateLimit.mockResolvedValue({
            allowed: true,
            total: 30,
            remaining: 29,
            resetAt: Date.now() / 1000 + 60,
        });
        mockCheckMediaAccess.mockResolvedValue(true);
        mockIsMediaItemOfType.mockResolvedValue(true);
        mockGetTrackDetail.mockResolvedValue({ id: TRACK });
        mockRecommendNext.mockResolvedValue({ alternatives: [], source: 'metadata' });
    });

    const post = (body: unknown) =>
        def.handlers.POST!(makeEvent(), { surface: 'v1', input: { body } } as never);

    it.each(['artist', 'album'] as const)(
        'a %s seed id that is another media type is a 404',
        async (type) => {
            mockIsMediaItemOfType.mockResolvedValue(false);
            const res = await post({
                seed: { type, id: ARTIST },
                context: { currentTrackId: TRACK },
            });
            expect(res.status).toBe(404);
            expect(mockIsMediaItemOfType).toHaveBeenCalledWith({}, ARTIST, type);
            expect(mockRecommendNext).not.toHaveBeenCalled();
        },
    );

    it('cold start retries an inaccessible mood pick before answering 404', async () => {
        mockGetMoodBootstrapTrack.mockResolvedValue({ id: OTHER, title: 'x', custom_metadata: {} });
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await post({ seed: { type: 'mood', mood: 'chill' } });
        expect(res.status).toBe(404);
        expect(mockGetMoodBootstrapTrack).toHaveBeenCalledTimes(3);
    });

    it('cold start answers with a later accessible pick', async () => {
        mockGetMoodBootstrapTrack.mockResolvedValue({ id: OTHER, title: 'x', custom_metadata: {} });
        mockCheckMediaAccess.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const res = await post({ seed: { type: 'mood', mood: 'chill' } });
        expect(res.status).toBe(200);
        expect(mockGetMoodBootstrapTrack).toHaveBeenCalledTimes(2);
    });

    it('passes the context through to recommendNext and maps the seed ids', async () => {
        const context = {
            currentTrackId: TRACK,
            history: [OTHER],
            upcoming: [ARTIST],
            exclude: [OTHER],
            skipped: [ARTIST],
            crossfade: false,
            startedBy: 'user' as const,
        };
        const res = await post({ seed: { type: 'artist', id: ARTIST }, context });
        expect(res.status).toBe(200);
        const params = mockRecommendNext.mock.calls[0][3];
        expect(params).toMatchObject({
            currentTrack: { id: TRACK },
            history: [OTHER],
            upcoming: [ARTIST],
            exclude: [OTHER],
            skipped: [ARTIST],
            seed: { type: 'artist', artistId: ARTIST },
            crossfade: false,
            startedBy: 'user',
        });
    });

    it('maps an album seed to albumId and defaults empty lists', async () => {
        await post({ seed: { type: 'album', id: ARTIST }, context: { currentTrackId: TRACK } });
        const params = mockRecommendNext.mock.calls[0][3];
        expect(params.seed).toEqual({ type: 'album', albumId: ARTIST });
        expect(params.history).toEqual([]);
        expect(params.crossfade).toBeUndefined();
    });

    it('rejects an oversized mood or genre key through the schema', async () => {
        const { MusicRecommendationsRequestSchema } =
            await import('$lib/schemas/api-music-responses.js');
        expect(
            MusicRecommendationsRequestSchema.safeParse({
                seed: { type: 'mood', mood: 'x'.repeat(65) },
            }).success,
        ).toBe(false);
        expect(
            MusicRecommendationsRequestSchema.safeParse({
                seed: { type: 'genre', genre: 'x'.repeat(129) },
            }).success,
        ).toBe(false);
        expect(
            MusicRecommendationsRequestSchema.safeParse({
                seed: { type: 'mood', mood: 'x'.repeat(64) },
            }).success,
        ).toBe(true);
    });
});
