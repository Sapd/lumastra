// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getImageDescriptorOwners } from '$lib/server/database/queries/image-descriptor.queries.js';
vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { MusicTracksResponseSchema } from '$lib/schemas/api-music-responses.js';

const mockGetSql = vi.fn();
const mockGetTracksPaged = vi.fn();
const mockCountTracksPaged = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockSearchAccessBoundary = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTracksPaged: (...args: unknown[]) => mockGetTracksPaged(...args),
    countTracksPaged: (...args: unknown[]) => mockCountTracksPaged(...args),
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    searchAccessBoundary: (...args: unknown[]) => mockSearchAccessBoundary(...args),
}));

const { def } = await import('./tracks.js');

/** One row in the shape getTracksPaged actually returns (RecentTrackRow). */
function dbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 't1',
        title: 'A Song',
        sort_order: 3,
        runtime_seconds: 210,
        custom_poster_url: '/cover.jpg',
        custom_metadata: { artist: 'Someone' },
        album_id: 'al1',
        album_title: 'An Album',
        album_custom_poster_url: '/cover.jpg',
        artist_id: 'ar1',
        artist_title: 'Someone',
        last_played_at: '2026-08-19T00:00:00.000Z',
        hours_since_played: null,
        file_path: '/data/music/someone/an album/03 - a song.flac',
        ...overrides,
    };
}

function makeEvent(query = ''): RequestEvent {
    const url = `http://localhost/api/v1/music/tracks${query}`;
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL(url),
        params: {},
        request: new Request(url),
    } as unknown as RequestEvent;
}

const ctx = { surface: 'v1' } as never;

describe('music/tracks published contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({});
        mockSearchAccessBoundary.mockReturnValue({ boundary: true });
        mockGetTracksPaged.mockResolvedValue([]);
        mockCountTracksPaged.mockResolvedValue(0);
    });

    it('returns 401 when unauthenticated', async () => {
        const event = { ...makeEvent(), locals: { user: null } } as unknown as RequestEvent;
        const res = await def.handlers.GET!(event, ctx);
        expect(res.status).toBe(401);
    });

    it('returns 503 rather than an empty page when the database is down', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await def.handlers.GET!(makeEvent(), ctx);
        expect(res.status).toBe(503);
    });

    // The browse surface must not hand out on-disk paths. getTracksPaged
    // returns file_path because Subsonic needs it; this endpoint must drop it.
    it('never leaks file_path', async () => {
        mockGetTracksPaged.mockResolvedValue([dbRow()]);
        const res = await def.handlers.GET!(makeEvent(), ctx);
        const body = await res.json();

        expect(body.items).toHaveLength(1);
        expect(body.items[0]).not.toHaveProperty('file_path');
        expect(JSON.stringify(body)).not.toContain('/data/music');
    });

    // getTracksPaged aliases track.created_at as last_played_at (it reuses the
    // RecentTrackRow shape). Browse exposes that timestamp as addedAt.
    it('projects the added timestamp as addedAt', async () => {
        mockGetTracksPaged.mockResolvedValue([dbRow()]);
        const body = await (await def.handlers.GET!(makeEvent(), ctx)).json();

        expect(body.items[0].addedAt).toBe('2026-08-19T00:00:00.000Z');
        expect(body.items[0]).not.toHaveProperty('created_at');
        expect(body.items[0]).not.toHaveProperty('last_played_at');
    });

    it('emits addedAt as ISO 8601 when the query returns Postgres text timestamps', async () => {
        mockGetTracksPaged.mockResolvedValue([dbRow({ last_played_at: '2026-08-19 02:00:00+02' })]);
        const body = await (await def.handlers.GET!(makeEvent(), ctx)).json();

        expect(body.items[0].addedAt).toBe('2026-08-19T00:00:00.000Z');
        expect(body.items[0]).not.toHaveProperty('hours_since_played');
    });

    it('over-fetches one row to derive hasMore, and trims it from the page', async () => {
        mockGetTracksPaged.mockResolvedValue([
            dbRow({ id: 'a' }),
            dbRow({ id: 'b' }),
            dbRow({ id: 'c' }),
        ]);
        const body = await (await def.handlers.GET!(makeEvent('?limit=2'), ctx)).json();

        expect(mockGetTracksPaged).toHaveBeenCalledWith(
            expect.anything(),
            'u1',
            3, // limit + 1
            0,
            { boundary: true },
            { sort: 'alpha', genre: undefined, artist: undefined },
        );
        expect(body.items).toHaveLength(2);
        expect(getImageDescriptorOwners).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
            'a',
            'b',
        ]);
        expect(body.items[0].images.primary).toMatchObject({
            source: 'self',
            revision: expect.any(String),
            placeholder: { blurhash: 'stored-cover-blurhash' },
        });
        expect(body.items[0].images.primary.href).toContain(
            `&v=${body.items[0].images.primary.revision}`,
        );
        expect(body.page.hasMore).toBe(true);
    });

    it('omits total unless includeTotal is asked for', async () => {
        mockGetTracksPaged.mockResolvedValue([dbRow()]);
        const body = await (await def.handlers.GET!(makeEvent(), ctx)).json();

        expect(mockCountTracksPaged).not.toHaveBeenCalled();
        expect(body.page).not.toHaveProperty('total');
    });

    it('includes total when asked, and keeps a zero total', async () => {
        mockGetTracksPaged.mockResolvedValue([dbRow()]);
        mockCountTracksPaged.mockResolvedValue(42);
        const body = await (await def.handlers.GET!(makeEvent('?includeTotal=1'), ctx)).json();
        expect(body.page.total).toBe(42);

        // 0 is a real answer, not "not requested" — truthiness would drop it.
        mockGetTracksPaged.mockResolvedValue([]);
        mockCountTracksPaged.mockResolvedValue(0);
        const empty = await (await def.handlers.GET!(makeEvent('?includeTotal=true'), ctx)).json();
        expect(empty.page.total).toBe(0);
    });

    it('passes sort and filters through, defaulting an unknown sort to alpha', async () => {
        await def.handlers.GET!(makeEvent('?sort=artist&genre=Jazz&artist=Miles'), ctx);
        expect(mockGetTracksPaged).toHaveBeenLastCalledWith(
            expect.anything(),
            'u1',
            expect.any(Number),
            0,
            { boundary: true },
            { sort: 'artist', genre: 'Jazz', artist: 'Miles' },
        );

        await def.handlers.GET!(makeEvent('?sort=nonsense'), ctx);
        expect(mockGetTracksPaged).toHaveBeenLastCalledWith(
            expect.anything(),
            'u1',
            expect.any(Number),
            0,
            { boundary: true },
            { sort: 'alpha', genre: undefined, artist: undefined },
        );
    });

    it('counts the same filters it pages, so total describes the same set', async () => {
        await def.handlers.GET!(makeEvent('?genre=Jazz&includeTotal=1'), ctx);
        expect(mockCountTracksPaged).toHaveBeenCalledWith(
            expect.anything(),
            { boundary: true },
            { sort: 'alpha', genre: 'Jazz', artist: undefined },
        );
    });
    // This def is mounted on BOTH /api/music and /api/v1/music, and its
    // `images.primary` is built from ctx.surface. The sibling home def has these
    // two tests because the hardcoded-prefix bug reached production there; this
    // file had no assertion on images at all, on either surface, so the same
    // regression here would have left every test green.
    it('emits v1-surface image URLs on the v1 mount', async () => {
        mockGetTracksPaged.mockResolvedValue([dbRow()]);

        const res = await def.handlers.GET!(makeEvent(), ctx);
        const body = await res.json();

        const posters = body.items.flatMap(
            (i: { images: { primary: { href: string; variants: Record<string, string> } } }) => [
                i.images.primary.href,
                ...Object.values(i.images.primary.variants),
            ],
        );
        expect(posters.length).toBeGreaterThan(0);
        for (const poster of posters) {
            // A bearer client handed an /api/media/... href cannot fetch it.
            expect(poster).toContain('/api/v1/media/');
        }
    });

    it('emits internal-surface image URLs on the internal mount', async () => {
        mockGetTracksPaged.mockResolvedValue([dbRow()]);

        const internalCtx = { surface: 'internal' } as never;
        const res = await def.handlers.GET!(makeEvent(), internalCtx);
        const body = await res.json();

        const posters = body.items.flatMap(
            (i: { images: { primary: { href: string; variants: Record<string, string> } } }) => [
                i.images.primary.href,
                ...Object.values(i.images.primary.variants),
            ],
        );
        expect(posters.length).toBeGreaterThan(0);
        for (const poster of posters) {
            expect(poster).toContain('/api/media/');
            expect(poster).not.toContain('/api/v1/');
        }
    });

    it('emits a body that satisfies its own declared response schema', async () => {
        mockGetTracksPaged.mockResolvedValue([dbRow()]);

        const res = await def.handlers.GET!(makeEvent(), ctx);
        expect(res.status).toBe(200);
        const body = await res.json();

        const parsed = MusicTracksResponseSchema.safeParse(body);
        // The same check mount() runs in production before logging
        // RESPONSE CONFORMANCE. Strict native decoders reject a whole
        // response over one drifted field.
        expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    });

    it('stays schema-valid for an analysed track whose Essentia fields are null', async () => {
        // The prod row that tripped RESPONSE CONFORMANCE: storeAnalysis()
        // writes dj_intro_end_ms and the vocal bounds as null when absent.
        mockGetTracksPaged.mockResolvedValue([
            dbRow({
                custom_metadata: {
                    artist: 'Someone',
                    essentia: {
                        bpm: 124,
                        key: 'A',
                        loudness_lufs: -9.1,
                        dj_intro_end_ms: null,
                        first_vocal_start_ms: null,
                        last_vocal_end_ms: null,
                        energy_curve: [0.1, 0.4, 0.8],
                    },
                },
            }),
        ]);

        const res = await def.handlers.GET!(makeEvent(), ctx);
        const body = await res.json();

        const parsed = MusicTracksResponseSchema.safeParse(body);
        expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
        const essentia = body.items[0].audioFeatures;
        expect(essentia.bpm).toBe(124);
        expect(essentia).not.toHaveProperty('djIntroEndMs');
        expect(essentia.energyCurve).toEqual([0.1, 0.4, 0.8]);
    });
});
