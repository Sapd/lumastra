// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary';
import type { GenreTrackRow } from '$lib/server/database/queries/music.queries';

vi.mock('$lib/server/database/queries/music.queries', () => ({
    getTracksByGenre: vi.fn(),
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

import { getTracksByGenre } from '$lib/server/database/queries/music.queries';
import { computeGenrePlan, selectGenreTrackBatch, genreBatchRng } from './genre-plan.service';

function mkTrack(id: string, overrides: Partial<GenreTrackRow> = {}): GenreTrackRow {
    return {
        id,
        title: overrides.title ?? `Title ${id}`,
        sort_order: null,
        runtime_seconds: 180,
        custom_poster_url: null,
        custom_metadata: {},
        album_id: overrides.album_id ?? `album-${id}`,
        album_title: overrides.album_title ?? `Album ${id}`,
        album_custom_poster_url: null,
        artist_id: overrides.artist_id ?? `artist-${id}`,
        artist_title: overrides.artist_title ?? `Artist ${id}`,
        year: 2020,
        file_path: null,
        ...overrides,
    };
}

const sqlStub = {} as postgres.Sql;

describe('computeGenrePlan', () => {
    test('returns empty record for empty genre list', async () => {
        const plan = await computeGenrePlan(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: [],
            access: unrestrictedAccess(),
        });
        expect(plan).toEqual({});
    });

    test('returns up to 20 IDs per genre', async () => {
        vi.mocked(getTracksByGenre).mockResolvedValue(
            Array.from({ length: 28 }, (_, i) => mkTrack(`t${i}`)),
        );
        const plan = await computeGenrePlan(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock'],
            access: unrestrictedAccess(),
        });
        expect(plan.Rock.length).toBeLessThanOrEqual(20);
        expect(plan.Rock.length).toBeGreaterThan(0);
    });

    test('excludes recently-played IDs from every genre', async () => {
        vi.mocked(getTracksByGenre).mockResolvedValue([
            mkTrack('keep1'),
            mkTrack('drop1'),
            mkTrack('keep2'),
        ]);
        const plan = await computeGenrePlan(sqlStub, 'denis', {
            recentlyPlayedIds: ['drop1'],
            genreCarouselNames: ['Rock'],
            access: unrestrictedAccess(),
        });
        expect(plan.Rock).not.toContain('drop1');
        expect(plan.Rock).toContain('keep1');
        expect(plan.Rock).toContain('keep2');
    });

    test('deduplicates tracks across genres (first-come-first-served)', async () => {
        vi.mocked(getTracksByGenre).mockImplementation((_sql, genre) => {
            if (genre === 'Rock') {
                return Promise.resolve([mkTrack('shared1'), mkTrack('rock-only')]);
            }
            return Promise.resolve([mkTrack('shared1'), mkTrack('pop-only')]);
        });
        const plan = await computeGenrePlan(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock', 'Pop'],
            access: unrestrictedAccess(),
        });
        expect(plan.Rock).toContain('shared1');
        expect(plan.Pop).not.toContain('shared1');
        expect(plan.Pop).toContain('pop-only');
    });

    test('enforces 1-2 tracks per album across all genres (album cap)', async () => {
        vi.mocked(getTracksByGenre).mockResolvedValue(
            Array.from({ length: 5 }, (_, i) => mkTrack(`t${i}`, { album_id: 'big-album' })),
        );
        const plan = await computeGenrePlan(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock'],
            access: unrestrictedAccess(),
        });
        expect(plan.Rock.length).toBeLessThanOrEqual(2);
    });

    test('prefers the untagged original over a remix within a genre', async () => {
        vi.mocked(getTracksByGenre).mockResolvedValue([
            mkTrack('remix', {
                title: 'Song (Extended Mix)',
                artist_title: 'Band',
                album_id: 'al-remix',
            }),
            mkTrack('orig', { title: 'Song', artist_title: 'Band', album_id: 'al-orig' }),
        ]);
        const plan = await computeGenrePlan(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock'],
            access: unrestrictedAccess(),
        });
        expect(plan.Rock).toEqual(['orig']);
    });

    test('prefers the untagged original ACROSS genre boundaries (A6): a later genre swaps an earlier version-tagged pick in place', async () => {
        vi.mocked(getTracksByGenre).mockImplementation((_sql, genre) => {
            if (genre === 'Rock') {
                return Promise.resolve([
                    mkTrack('remix', {
                        title: 'Song (Extended Mix)',
                        artist_title: 'Band',
                        album_id: 'al-remix',
                    }),
                ]);
            }
            // Pop, processed after Rock, sees the untagged original by the
            // same artist.
            return Promise.resolve([
                mkTrack('orig', { title: 'Song', artist_title: 'Band', album_id: 'al-orig' }),
            ]);
        });
        const plan = await computeGenrePlan(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock', 'Pop'],
            access: unrestrictedAccess(),
        });
        // The original replaces the remix IN PLACE within Rock's array —
        // Pop's own slot for this song stays empty since the song already
        // lives in Rock.
        expect(plan.Rock).toEqual(['orig']);
        expect(plan.Pop).toEqual([]);
    });

    test('handles getTracksByGenre rejection by returning empty genre slot', async () => {
        vi.mocked(getTracksByGenre).mockImplementation((_sql, genre) => {
            if (genre === 'Rock') return Promise.reject(new Error('db down'));
            return Promise.resolve([mkTrack('pop1')]);
        });
        const plan = await computeGenrePlan(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock', 'Pop'],
            access: unrestrictedAccess(),
        });
        expect(plan.Rock).toEqual([]);
        expect(plan.Pop).toEqual(['pop1']);
    });
});

describe('genreBatchRng — the stability contract', () => {
    // The rail must not reshuffle under a viewer who scrolls away and back.
    // /music/sections/genre/{name} used to fall through to Math.random here,
    // so nothing a viewer had just seen was findable again.
    const POOL = Array.from({ length: 40 }, (_, i) => mkTrack(`t${i}`));

    test('the same user and genre get the same batch across calls', () => {
        const a = selectGenreTrackBatch(POOL, 20, genreBatchRng('user-1', 'Rock'));
        const b = selectGenreTrackBatch(POOL, 20, genreBatchRng('user-1', 'Rock'));
        expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
    });

    test('a different genre gets a different batch', () => {
        const rock = selectGenreTrackBatch(POOL, 20, genreBatchRng('user-1', 'Rock'));
        const jazz = selectGenreTrackBatch(POOL, 20, genreBatchRng('user-1', 'Jazz'));
        expect(rock.map((t) => t.id)).not.toEqual(jazz.map((t) => t.id));
    });

    test('a different user gets a different batch', () => {
        const one = selectGenreTrackBatch(POOL, 20, genreBatchRng('user-1', 'Rock'));
        const two = selectGenreTrackBatch(POOL, 20, genreBatchRng('user-2', 'Rock'));
        expect(one.map((t) => t.id)).not.toEqual(two.map((t) => t.id));
    });

    test('a shrinking pool still yields a prefix-stable-ish batch, not noise', () => {
        // Load-more excludes already-shown ids, so the pool changes between
        // calls by design. The point is only that the SAME pool is stable.
        const first = selectGenreTrackBatch(POOL, 10, genreBatchRng('user-1', 'Rock'));
        const shown = new Set(first.map((t) => t.id));
        const rest = POOL.filter((t) => !shown.has(t.id));
        const second = selectGenreTrackBatch(rest, 10, genreBatchRng('user-1', 'Rock'));
        expect(second.some((t) => shown.has(t.id))).toBe(false);
    });
});

describe('selectGenreTrackBatch', () => {
    // Deterministic RNG (always 0) → no shuffle reorder, album cap = 1.
    const rngZero = () => 0;

    test('returns at most `limit` tracks', () => {
        const tracks = Array.from({ length: 30 }, (_, i) => mkTrack(`t${i}`));
        expect(selectGenreTrackBatch(tracks, 20, rngZero)).toHaveLength(20);
    });

    test('returns an empty array when given no candidates', () => {
        expect(selectGenreTrackBatch([], 20, rngZero)).toEqual([]);
    });

    test('caps tracks per album (1 when rng() < 0.5)', () => {
        const tracks = Array.from({ length: 5 }, (_, i) =>
            mkTrack(`t${i}`, { album_id: 'same-album' }),
        );
        const picked = selectGenreTrackBatch(tracks, 20, rngZero);
        expect(picked).toHaveLength(1);
    });

    test('deduplicates by normalized title + artist (one "Song" variant survives)', () => {
        const tracks = [
            mkTrack('a', { title: 'Song', artist_title: 'Band', album_id: 'al1' }),
            mkTrack('b', { title: 'Song (Remastered)', artist_title: 'Band', album_id: 'al2' }),
            mkTrack('c', { title: 'Other', artist_title: 'Band', album_id: 'al3' }),
        ];
        const picked = selectGenreTrackBatch(tracks, 20, rngZero);
        const titles = picked.map((t) => t.title);
        // 'Song' and 'Song (Remastered)' normalize to the same key → exactly one
        // is kept (which one depends on shuffle order); 'Other' is distinct.
        expect(titles).toContain('Other');
        const songVariants = titles.filter((t) => t.startsWith('Song'));
        expect(songVariants).toHaveLength(1);
        expect(picked).toHaveLength(2);
    });

    test('prefers the untagged original over a remix when both are candidates', () => {
        // With rngZero the shuffle is a no-op, so without the original-preference
        // grouping the FIRST array entry ("Song (Extended Mix)") would win.
        // pickOriginalPerTitle must override that and keep "Song" instead.
        const tracks = [
            mkTrack('remix', {
                title: 'Song (Extended Mix)',
                artist_title: 'Band',
                album_id: 'al-remix',
            }),
            mkTrack('orig', { title: 'Song', artist_title: 'Band', album_id: 'al-orig' }),
        ];
        const picked = selectGenreTrackBatch(tracks, 20, rngZero);
        expect(picked).toHaveLength(1);
        expect(picked[0].id).toBe('orig');
        expect(picked[0].title).toBe('Song');
    });

    test('returns full rows (not just ids) for hydration-free section building', () => {
        const picked = selectGenreTrackBatch([mkTrack('only')], 20, rngZero);
        expect(picked[0]).toMatchObject({ id: 'only', title: 'Title only' });
    });
});
