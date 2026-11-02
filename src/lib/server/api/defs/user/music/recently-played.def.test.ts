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
 * Guards the published contract of the recently-played def: 401 when
 * unauthenticated, 503 when the DB is down, and that the response never
 * carries a raw file_path (the exact leak toMusicTrack exists to prevent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetSql = vi.fn();
const mockGetRecentlyPlayed = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockFilterAccessibleRows = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getRecentlyPlayed: (...args: unknown[]) => mockGetRecentlyPlayed(...args),
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    searchAccessBoundary: (ctx: unknown) => ctx,
}));

vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleRows: (...args: unknown[]) => mockFilterAccessibleRows(...args),
}));

const { def } = await import('./recently-played.js');

function makeEvent(query = ''): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL(`http://localhost/api/v1/me/music/recently-played${query}`),
        params: {},
        request: new Request(`http://localhost/api/v1/me/music/recently-played${query}`),
    } as unknown as RequestEvent;
}

describe('recently-played published contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
    });

    it('returns 401 when unauthenticated', async () => {
        const event = { ...makeEvent(), locals: { user: null } } as unknown as RequestEvent;
        const res = await def.handlers.GET!(event, { surface: 'v1' } as never);
        expect(res.status).toBe(401);
    });

    it('returns 503 when the DB is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        expect(res.status).toBe(503);
    });

    it('never leaks file_path in the response', async () => {
        mockGetRecentlyPlayed.mockResolvedValue([
            {
                id: 't1',
                title: 'Track One',
                custom_metadata: {},
                artist_title: 'Artist',
                album_title: 'Album',
                album_id: 'al1',
                artist_id: 'ar1',
                file_path: '/data/media/libraries/music/artist/album/01.flac',
            },
        ]);
        mockFilterAccessibleRows.mockImplementation((_sql, rows: unknown[]) =>
            Promise.resolve(rows),
        );
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(JSON.stringify(body)).not.toContain('file_path');
        expect(JSON.stringify(body)).not.toContain('/data/media');
        expect(body.items[0].id).toBe('t1');
    });

    it('fetches one extra row and reports page.truncated', async () => {
        mockGetRecentlyPlayed.mockResolvedValue([
            {
                id: 't1',
                title: 'T',
                custom_metadata: {},
                artist_title: 'A',
                album_title: 'B',
                album_id: 'al',
                artist_id: 'ar',
            },
            {
                id: 't2',
                title: 'T',
                custom_metadata: {},
                artist_title: 'A',
                album_title: 'B',
                album_id: 'al',
                artist_id: 'ar',
            },
            {
                id: 't3',
                title: 'T',
                custom_metadata: {},
                artist_title: 'A',
                album_title: 'B',
                album_id: 'al',
                artist_id: 'ar',
            },
        ]);
        mockFilterAccessibleRows.mockImplementation((_sql, rows: unknown[]) =>
            Promise.resolve(rows),
        );
        const res = await def.handlers.GET!(makeEvent('?limit=2'), { surface: 'v1' } as never);
        const body = await res.json();
        expect(mockGetRecentlyPlayed).toHaveBeenCalledWith(expect.anything(), 'u1', 3);
        expect(body.items).toHaveLength(2);
        expect(body.page).toEqual({ limit: 2, truncated: true });
    });

    it('is not truncated when the list fits', async () => {
        mockGetRecentlyPlayed.mockResolvedValue([
            {
                id: 't1',
                title: 'T',
                custom_metadata: {},
                artist_title: 'A',
                album_title: 'B',
                album_id: 'al',
                artist_id: 'ar',
            },
        ]);
        mockFilterAccessibleRows.mockImplementation((_sql, rows: unknown[]) =>
            Promise.resolve(rows),
        );
        const res = await def.handlers.GET!(makeEvent('?limit=2'), { surface: 'v1' } as never);
        const body = await res.json();
        expect(body.page).toEqual({ limit: 2, truncated: false });
    });
});
