// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: { for: () => ({ get: async () => null, set: async () => undefined }) },
    CACHE_NAMESPACES: new Proxy({}, { get: (_t, k) => String(k) }),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(() => Promise.resolve({})) },
}));

vi.mock('$lib/server/database/queries/music-recommendations.queries.js', () => ({
    getMusicSmartMixes: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn().mockResolvedValue({
        deniedGroupIds: [],
        ageRating: null,
    }),
    // The route also imports scopedCacheKey from this module. A vi.mock factory
    // replaces the module wholesale, so omitting it left the route calling
    // undefined() inside its try block — surfacing as a 503 from the catch
    // rather than as the TypeError it actually was.
    scopedCacheKey: vi.fn((prefix: string) => `${prefix}:test`),
}));

vi.mock('$lib/server/database/queries/music-quick-picks.queries.js', () => ({
    getDislikedTrackIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));

vi.mock('$lib/server/utils/music-section-builder.js', () => ({
    buildSmartMixSection: vi.fn((mix) => ({
        id: `music-mix-${mix.genre}`,
        type: 'carousel',
        title: mix.genre,
        items: [],
        meta: {},
    })),
}));

import { getMusicSmartMixes } from '$lib/server/database/queries/music-recommendations.queries';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { GET } from './+server';

type Event = Parameters<NonNullable<typeof GET>>[0];

function mkEvent(user?: { username: string; userId?: string }): Event {
    const url = new URL('http://x/api/music/sections/smart-mixes');
    return {
        params: {},
        url,
        request: new Request(url),
        locals: {
            user: user
                ? {
                      userId: user.userId ?? 'test-user-id',
                      username: user.username,
                      groups: '',
                      userGroups: [],
                      hasWatchPermission: true,
                      hasLiveTvPermission: false,
                      hasRequestPermission: false,
                      isAdmin: false,
                      maxAgeRating: null,
                      isAgeRestricted: false,
                  }
                : undefined,
        },
    } as unknown as Event;
}

describe('GET /api/music/sections/smart-mixes', () => {
    beforeEach(() => vi.clearAllMocks());

    test('401 when unauthenticated', async () => {
        const res = await GET!(mkEvent(undefined));
        expect(res.status).toBe(401);
    });

    test('returns { sections: [] } when user has no smart mixes', async () => {
        vi.mocked(getMusicSmartMixes).mockResolvedValue([]);
        const res = await GET!(mkEvent({ username: 'denis' }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ sections: [] });
    });

    test('returns 503 dependency_unavailable when the query throws', async () => {
        // v1 contract: dependency-down is surfaced as 503 dependency_unavailable,
        // NEVER a 200 with an empty array (which would be indistinguishable from
        // "no smart mixes"). SDUI graceful-degradation is handled at the /feed
        // aggregation layer (per-section fault isolation drops the failing
        // section while keeping the feed 200) — not by this endpoint lying.
        vi.mocked(getMusicSmartMixes).mockRejectedValue(new Error('embedding lookup failed'));
        const res = await GET!(mkEvent({ username: 'denis' }));
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.code).toBe('dependency_unavailable');
    });

    test('returns { sections: PageSection[] } for each mix', async () => {
        vi.mocked(getMusicSmartMixes).mockResolvedValue([
            {
                genre: 'rock',
                tracks: [
                    {
                        id: 't1',
                        title: 'Rock song',
                        artist_title: 'Rocker',
                        album_title: 'Rock album',
                        runtime_seconds: 200,
                        custom_poster_url: null,
                    },
                ],
            },
        ] as never);
        const res = await GET!(mkEvent({ username: 'denis' }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.sections)).toBe(true);
        expect(body.sections.length).toBe(1);
        expect(body.sections[0].id).toMatch(/^music-mix-/);
    });

    test('resolves mix track ImageSets for the mount surface', async () => {
        vi.mocked(getMusicSmartMixes).mockResolvedValue([
            {
                genre: 'rock',
                tracks: [{ id: 't1', title: 'Rock song', artist_title: 'Rocker' }],
            },
        ] as never);
        const res = await GET!(mkEvent({ username: 'denis' }));
        expect(res.status).toBe(200);
        expect(resolveImageSets).toHaveBeenCalledWith(expect.anything(), 'internal', [
            { id: 't1', mediaType: 'track' },
        ]);
    });
});
