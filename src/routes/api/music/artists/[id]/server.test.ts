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
 * Wiring tests for the artist-detail endpoint pair — mirror of
 * src/routes/api/music/albums/[id]/server.test.ts. See that file's header for
 * the rationale (core-level tests cannot catch a swapped options literal).
 *
 *   - src/routes/api/music/artists/[id]/+server.ts  → {surface:'internal', fullAudioFeatures:false}
 *   - src/lib/server/api/defs/music/artists/[id].ts → {surface:'v1',       fullAudioFeatures:true}
 *
 * NOTE: named server.test.ts (NOT +server.test.ts) — the `+` prefix is reserved
 * by SvelteKit for route files and breaks `vite build`. Distinct from the
 * pre-existing server.integration.test.ts in this directory, which needs a real
 * database; this file needs none.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockGetSql = vi.fn();
const mockGetArtistWithAlbums = vi.fn();
const mockGetArtistTracks = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockFilterAccessibleRows = vi.fn();
const mockGetArtistPopularity = vi.fn();
const mockGetTrackPopularityForArtist = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getArtistWithAlbums: (...args: unknown[]) => mockGetArtistWithAlbums(...args),
    getArtistTracks: (...args: unknown[]) => mockGetArtistTracks(...args),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    searchAccessBoundary: (ctx: unknown) => ctx,
}));
vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleRows: (...args: unknown[]) => mockFilterAccessibleRows(...args),
}));
vi.mock('$lib/server/database/queries/popularity.queries.js', () => ({
    getArtistPopularity: (...args: unknown[]) => mockGetArtistPopularity(...args),
    getTrackPopularityForArtist: (...args: unknown[]) => mockGetTrackPopularityForArtist(...args),
}));

// Collapse the auth/error wrappers so the exported GET is the raw core call.
vi.mock('$lib/server/middleware/auth.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/middleware/auth.js')>()),
    requireAuth: (handler: unknown) => handler,
}));
vi.mock('$lib/server/middleware/error-handler.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/middleware/error-handler.js')>()),
    withErrorHandler: (handler: unknown) => handler,
}));

const TRACK = {
    id: 't1',
    custom_poster_url: '/cover.jpg',
    title: 'Track One',
    custom_metadata: { essentia: { bpm: 100, key: 'Cm', energy: 0.5 } },
    album_id: 'al1',
    artist_id: 'ar1',
    artist_title: 'Artist',
    file_path: '/data/media/libraries/music/artist/album/01.flac',
};

function makeEvent(): RequestEvent {
    return {
        params: { id: 'ar1' },
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/music/artists/ar1'),
        request: new Request('http://localhost/api/music/artists/ar1'),
    } as unknown as RequestEvent;
}

describe('artist detail — real route/def wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockGetArtistWithAlbums.mockResolvedValue({
            artist: {
                id: 'ar1',
                custom_poster_url: '/artist.jpg',
                title: 'Artist One',
                is_various_artists: false,
            },
            albums: [{ id: 'al1', title: 'Album One' }],
        });
        mockGetArtistTracks.mockResolvedValue([TRACK]);
        mockCheckMediaAccess.mockResolvedValue(true);
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockFilterAccessibleRows.mockImplementation((_sql, rows: unknown[]) =>
            Promise.resolve(rows),
        );
        mockGetArtistPopularity.mockResolvedValue(null);
        mockGetTrackPopularityForArtist.mockResolvedValue([]);
    });

    it('the internal +server.ts GET is wired to the public DTO on the internal surface', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET(makeEvent() as never);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.tracks[0].audioFeatures).toMatchObject({ bpm: 100, key: 'Cm', energy: 0.5 });
        expect(body.images.primary?.href).toContain('/api/media/ar1/images/poster');
        expect(body.images.primary?.href).not.toContain('/api/v1/');
    });

    it('the v1 def handler is wired to the same DTO on the v1 surface', async () => {
        const { def } = await import('$lib/server/api/defs/music/artists/[id].js');
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as ApiContext);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.tracks[0].audioFeatures).toEqual({
            bpm: 100,
            key: 'Cm',
            energy: 0.5,
        });
        expect(body.images.primary?.href).toContain('/api/v1/media/ar1/images/poster');
    });
});
