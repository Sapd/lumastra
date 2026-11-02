// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';
import type { AccessContext } from './recommender.js';

const mockGetRecentMovies = vi.hoisted(() => vi.fn());
const mockGetRecentTv = vi.hoisted(() => vi.fn());
const mockGetRailItems = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/index.js', () => ({
    getRecentWatchedMoviesWithEmbeddings: { all: (...a: unknown[]) => mockGetRecentMovies(...a) },
    getRecentWatchedTvWithEmbeddings: { all: (...a: unknown[]) => mockGetRecentTv(...a) },
}));
vi.mock('$lib/server/database/queries/builders/media-access-boundary.js', () => ({
    restrictedAccess: () => ({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));
vi.mock('./recommender.js', () => ({ getRailItems: (...a: unknown[]) => mockGetRailItems(...a) }));

const { selectRecentVideoSeeds, buildBywSections } = await import('./feed-byw-sections.js');

function makeCtx(p: Partial<AccessContext> = {}): AccessContext {
    return {
        userId: 'usr_1' as UserId,
        username: 'a',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: true,
        isAgeRestricted: false,
        ...p,
    };
}

beforeEach(() => vi.clearAllMocks());

describe('selectRecentVideoSeeds', () => {
    it('returns the top-N most-recent seeds across movies and tv', async () => {
        mockGetRecentMovies.mockResolvedValue([
            {
                media_id: 'm1',
                title: 'Movie1',
                media_type: 'movie',
                watched_at: '2026-07-22T00:00:00Z',
            },
        ]);
        mockGetRecentTv.mockResolvedValue([
            {
                media_id: 't1',
                title: 'Show1',
                media_type: 'tv',
                watched_at: '2026-07-21T00:00:00Z',
            },
        ]);
        const seeds = await selectRecentVideoSeeds(makeCtx(), 2);
        expect(seeds.map((s) => s.id)).toEqual(['m1', 't1']);
        expect(seeds[0]).toMatchObject({ title: 'Movie1', mediaType: 'movie' });
    });
});

describe('buildBywSections', () => {
    it('emits one carousel per seed with a byw:<id> id and a seed-anchored source href', async () => {
        mockGetRecentMovies.mockResolvedValue([
            {
                media_id: 'm1',
                title: 'Movie1',
                media_type: 'movie',
                watched_at: '2026-07-22T00:00:00Z',
            },
        ]);
        mockGetRecentTv.mockResolvedValue([]);
        mockGetRailItems.mockResolvedValue({
            items: [
                {
                    media: { id: 'x', type: 'movie', title: 'Rec', ids: {} },
                    reason: { kind: 'because-you-watched' },
                },
            ],
            hasMore: false,
        });

        const sections = await buildBywSections(makeCtx(), 3, 10, '/api/v1', 'v1', new Set(), 'en');
        expect(sections).toHaveLength(1);
        expect(sections[0].type).toBe('carousel');
        expect(sections[0].id).toBe('byw:m1');
        expect(sections[0].title).toBe('Because you watched Movie1');
        expect(sections[0].source.href).toBe(
            '/api/v1/recommendations?type=because-you-watched&domain=video&seed=m1',
        );
    });

    it('skips a seed whose series is already shown in the watching section', async () => {
        mockGetRecentMovies.mockResolvedValue([]);
        mockGetRecentTv.mockResolvedValue([
            {
                media_id: 't1',
                title: 'Show1',
                media_type: 'tv',
                watched_at: '2026-07-22T00:00:00Z',
            },
        ]);
        const sections = await buildBywSections(
            makeCtx(),
            3,
            10,
            '/api/v1',
            'v1',
            new Set(['t1']),
            'en',
        );
        expect(sections).toHaveLength(0);
        expect(mockGetRailItems).not.toHaveBeenCalled();
    });

    it('drops a seed that yields no recommendations (empty rail)', async () => {
        mockGetRecentMovies.mockResolvedValue([
            {
                media_id: 'm1',
                title: 'Movie1',
                media_type: 'movie',
                watched_at: '2026-07-22T00:00:00Z',
            },
        ]);
        mockGetRecentTv.mockResolvedValue([]);
        mockGetRailItems.mockResolvedValue({ items: [], hasMore: false });
        const sections = await buildBywSections(makeCtx(), 3, 10, '/api/v1', 'v1', new Set(), 'en');
        expect(sections).toHaveLength(0);
    });

    it('returns [] for an age-restricted profile without calling getRailItems (policy parity with the strategy)', async () => {
        const sections = await buildBywSections(
            makeCtx({ isAgeRestricted: true }),
            3,
            10,
            '/api/v1',
            'v1',
            new Set(),
            'en',
        );

        expect(sections).toEqual([]);
        expect(mockGetRailItems).not.toHaveBeenCalled();
    });

    it('isolates a per-seed getRailItems failure — the surviving seed still yields its section', async () => {
        mockGetRecentMovies.mockResolvedValue([
            {
                media_id: 'm1',
                title: 'Movie1',
                media_type: 'movie',
                watched_at: '2026-07-22T00:00:00Z',
            },
        ]);
        mockGetRecentTv.mockResolvedValue([
            {
                media_id: 't1',
                title: 'Show1',
                media_type: 'tv',
                watched_at: '2026-07-21T00:00:00Z',
            },
        ]);
        mockGetRailItems.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({
            items: [{ media: { id: 'x', type: 'tv', title: 'Rec', ids: {} } }],
            hasMore: false,
        });

        const sections = await buildBywSections(makeCtx(), 3, 10, '/api/v1', 'v1', new Set(), 'en');

        expect(sections).toHaveLength(1);
        expect(mockGetRailItems).toHaveBeenCalledTimes(2);
    });
});
