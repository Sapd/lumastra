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
 * Wiring tests for the album-detail endpoint pair.
 *
 * `music-album-detail.handler.test.ts` proves `albumDetailCore` behaves
 * correctly GIVEN options. This file proves the two REAL entry points hand it
 * the correct options literal:
 *
 *   - src/routes/api/music/albums/[id]/+server.ts  → {surface:'internal', fullAudioFeatures:false}
 *   - src/lib/server/api/defs/music/albums/[id].ts → {surface:'v1',       fullAudioFeatures:true}
 *
 * Without this, swapping the two literals between the files would leave every
 * core-level test green while the internal dashboard route started shipping the
 * full Essentia payload (and the v1 iOS client stopped receiving it).
 *
 * NOTE: named server.test.ts (NOT +server.test.ts) — the `+` prefix is reserved
 * by SvelteKit for route files and breaks `vite build`.
 *
 * No database required: the query layer, access checks and popularity queries
 * are mocked, and requireAuth/withErrorHandler are collapsed to identity so the
 * module-load-time `createAlbumDetailHandler(...)` in +server.ts yields the bare
 * core call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockGetSql = vi.fn();
const mockGetAlbumWithTracks = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockFilterAccessibleRows = vi.fn();
const mockGetArtistPopularity = vi.fn();
const mockGetTrackPopularityForAlbum = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getAlbumWithTracks: (...args: unknown[]) => mockGetAlbumWithTracks(...args),
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
    getTrackPopularityForAlbum: (...args: unknown[]) => mockGetTrackPopularityForAlbum(...args),
}));

// Collapse the auth/error wrappers so the exported GET is the raw core call.
// Partial mocks (importOriginal) keep every other export of these modules real
// for anything else in the graph that imports them.
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
    custom_metadata: { essentia: { bpm: 128, key: 'Am', energy: 0.8 } },
    album_id: 'al1',
    artist_id: 'ar1',
    artist_title: 'Artist',
    file_path: '/data/media/libraries/music/artist/album/01.flac',
};

function makeEvent(): RequestEvent {
    return {
        params: { id: 'al1' },
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/music/albums/al1'),
        request: new Request('http://localhost/api/music/albums/al1'),
    } as unknown as RequestEvent;
}

describe('album detail — real route/def wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockGetAlbumWithTracks.mockResolvedValue({
            album: { id: 'al1', title: 'Album One', artist_id: 'ar1' },
            tracks: [TRACK],
        });
        mockCheckMediaAccess.mockResolvedValue(true);
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockFilterAccessibleRows.mockImplementation((_sql, rows: unknown[]) =>
            Promise.resolve(rows),
        );
        mockGetArtistPopularity.mockResolvedValue(null);
        mockGetTrackPopularityForAlbum.mockResolvedValue([]);
    });

    it('the internal +server.ts GET is wired to the public DTO on the internal surface', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET(makeEvent() as never);
        const body = await res.json();

        expect(res.status).toBe(200);
        const track = body.tracks[0];
        expect(track.audioFeatures).toMatchObject({ bpm: 128, key: 'Am', energy: 0.8 });
        expect(track.images.primary?.href).toContain('/api/media/t1/images/poster');
        expect(track.images.primary?.href).not.toContain('/api/v1/');
    });

    it('the v1 def handler is wired to the same DTO on the v1 surface', async () => {
        const { def } = await import('$lib/server/api/defs/music/albums/[id].js');
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as ApiContext);
        const body = await res.json();

        expect(res.status).toBe(200);
        const track = body.tracks[0];
        expect(track.audioFeatures).toEqual({ bpm: 128, key: 'Am', energy: 0.8 });
        expect(track.images.primary?.href).toContain('/api/v1/media/t1/images/poster');
    });
});
