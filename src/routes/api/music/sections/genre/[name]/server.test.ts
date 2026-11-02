// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: { getSql: vi.fn(() => Promise.resolve({})) },
}));

vi.mock('$lib/server/database/queries/music.queries', () => ({
    getTracksByGenre: vi.fn(),
    getTracksByIds: vi.fn(),
}));

// The handler's access boundary. Real-DB coverage of what it hides lives in
// src/routes/music/music-browse-access.integration.test.ts.
const BOUNDARY = {
    library: { kind: 'denyGroups', ids: ['g1'] },
    age: { kind: 'any' },
} as const;
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({})),
    searchAccessBoundary: vi.fn(() => BOUNDARY),
}));

vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleRows: vi.fn(async (_sql: unknown, rows: unknown[]) => rows),
}));

vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
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

import { getTracksByGenre, getTracksByIds } from '$lib/server/database/queries/music.queries';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { GET } from './+server';

type Event = Parameters<NonNullable<typeof GET>>[0];

function mkEvent(params: { name: string }, url: URL, user?: { username: string }): Event {
    return {
        params,
        url,
        request: new Request(url.toString()),
        locals: { user },
    } as unknown as Event;
}

function mkTrack(id: string) {
    return {
        id,
        title: `Song ${id}`,
        sort_order: null,
        runtime_seconds: 200,
        custom_poster_url: null,
        custom_metadata: {},
        album_id: `album-${id}`,
        album_title: 'Album',
        album_custom_poster_url: null,
        artist_id: 'ar1',
        artist_title: 'Artist',
        year: 2020,
        file_path: null,
    };
}

describe('GET /api/music/sections/genre/[name]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('returns 401 when unauthenticated', async () => {
        const event = mkEvent(
            { name: 'rock' },
            new URL('http://x/api/music/sections/genre/rock'),
            undefined,
        );
        const res = await GET!(event);
        expect(res.status).toBe(401);
    });

    test('uses getTracksByIds when ?ids= is provided', async () => {
        vi.mocked(getTracksByIds).mockResolvedValue([mkTrack('t1')]);
        const event = mkEvent(
            { name: 'rock' },
            new URL('http://x/api/music/sections/genre/rock?ids=t1,t2'),
            { username: 'denis' },
        );
        const res = await GET!(event);
        expect(res.status).toBe(200);
        expect(getTracksByIds).toHaveBeenCalled();
        expect(getTracksByGenre).not.toHaveBeenCalled();
        const body = await res.json();
        expect(body).not.toBeNull();
        expect(body.id).toMatch(/^music-genre-/);
        expect(body.title).toBe('rock');
    });

    test('?ids= serves only the ids that pass the caller boundary', async () => {
        vi.mocked(getTracksByIds).mockResolvedValue([mkTrack('t1'), mkTrack('t2')]);
        vi.mocked(filterAccessibleRows).mockImplementationOnce(async (_sql, rows) =>
            rows.filter((r) => r.id === 't1'),
        );
        const event = mkEvent(
            { name: 'rock' },
            new URL('http://x/api/music/sections/genre/rock?ids=t1,t2'),
            { username: 'denis' },
        );
        const res = await GET!(event);
        expect(res.status).toBe(200);
        expect(filterAccessibleRows).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(Array),
            BOUNDARY,
        );
        const body = await res.json();
        expect(body.items.map((i: { id: string }) => i.id)).toEqual(['t1']);
    });

    test('items carry the ImageSet resolved for the mount surface', async () => {
        vi.mocked(getTracksByIds).mockResolvedValue([mkTrack('t1')]);
        const images = {
            primary: {
                href: '/api/media/t1/images/primary?v=r1',
                revision: 'r1',
                source: 'self' as const,
                variants: { thumb: '/api/media/t1/images/primary?size=thumb&v=r1' },
            },
        };
        vi.mocked(resolveImageSets).mockResolvedValueOnce(new Map([['t1', images]]) as never);
        const event = mkEvent(
            { name: 'rock' },
            new URL('http://x/api/music/sections/genre/rock?ids=t1'),
            { username: 'denis' },
        );
        const res = await GET!(event);
        expect(res.status).toBe(200);
        expect(resolveImageSets).toHaveBeenCalledWith(expect.anything(), 'internal', [
            { id: 't1', mediaType: 'track' },
        ]);
        const body = await res.json();
        expect(body.items[0].images).toEqual(images);
        expect(body.items[0].image).toBe('/api/media/t1/images/primary?size=thumb&v=r1');
    });

    test('genre pools are drawn under the caller boundary', async () => {
        vi.mocked(getTracksByGenre).mockResolvedValue([mkTrack('t1')]);
        for (const query of ['', '?exclude=']) {
            const event = mkEvent(
                { name: 'rock' },
                new URL(`http://x/api/music/sections/genre/rock${query}`),
                { username: 'denis' },
            );
            expect((await GET!(event)).status).toBe(200);
        }
        expect(getTracksByGenre).toHaveBeenCalledTimes(2);
        for (const call of vi.mocked(getTracksByGenre).mock.calls) {
            expect(call[2]).toBe(BOUNDARY);
        }
    });

    test('falls back to getTracksByGenre when ?ids= is absent', async () => {
        vi.mocked(getTracksByGenre).mockResolvedValue([mkTrack('t1')]);
        const event = mkEvent({ name: 'rock' }, new URL('http://x/api/music/sections/genre/rock'), {
            username: 'denis',
        });
        const res = await GET!(event);
        expect(res.status).toBe(200);
        expect(getTracksByGenre).toHaveBeenCalled();
        expect(getTracksByIds).not.toHaveBeenCalled();
    });

    test('returns 200 with null body when no tracks found', async () => {
        vi.mocked(getTracksByGenre).mockResolvedValue([]);
        const event = mkEvent({ name: 'rock' }, new URL('http://x/api/music/sections/genre/rock'), {
            username: 'denis',
        });
        const res = await GET!(event);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toBeNull();
    });

    test('empty ?ids= respects plan (returns null, skips fallback)', async () => {
        // An empty ?ids= param means the plan computed an empty slot — all
        // candidates were already absorbed by another section. Do NOT fall
        // back to getTracksByGenre; that would bypass the Quick Picks dedup.
        const event = mkEvent(
            { name: 'rock' },
            new URL('http://x/api/music/sections/genre/rock?ids='),
            { username: 'denis' },
        );
        const res = await GET!(event);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toBeNull();
        expect(getTracksByGenre).not.toHaveBeenCalled();
        expect(getTracksByIds).not.toHaveBeenCalled();
    });

    test('?ids= with only commas/whitespace respects empty plan (no fallback)', async () => {
        const event = mkEvent(
            { name: 'rock' },
            new URL('http://x/api/music/sections/genre/rock?ids=,,,'),
            { username: 'denis' },
        );
        const res = await GET!(event);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toBeNull();
        expect(getTracksByGenre).not.toHaveBeenCalled();
        expect(getTracksByIds).not.toHaveBeenCalled();
    });
});
