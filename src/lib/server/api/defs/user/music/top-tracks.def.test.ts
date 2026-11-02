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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetSql = vi.fn();
const mockGetMostPlayedTracks = vi.fn();
const mockBuildSearchAccessContext = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/music-quick-picks.queries.js', () => ({
    getMostPlayedTracks: (...args: unknown[]) => mockGetMostPlayedTracks(...args),
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
}));

const { def } = await import('./top-tracks.js');

function makeEvent(): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/v1/me/music/top-tracks'),
        params: {},
        request: new Request('http://localhost/api/v1/me/music/top-tracks'),
    } as unknown as RequestEvent;
}

describe('top-tracks published contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: ['g1'],
            ageRating: { maxAgeRating: 13, allowUnrated: true },
        });
        mockGetMostPlayedTracks.mockResolvedValue([]);
    });

    it('returns 401 when unauthenticated', async () => {
        const event = { ...makeEvent(), locals: { user: null } } as unknown as RequestEvent;
        const res = await def.handlers.GET!(event, { surface: 'v1' } as never);
        expect(res.status).toBe(401);
    });

    it('passes the access-scoping context through to the query', async () => {
        await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        expect(mockGetMostPlayedTracks).toHaveBeenCalledWith(
            expect.anything(),
            'u1',
            expect.any(Number),
            ['g1'],
            { maxAgeRating: 13, allowUnrated: true },
        );
    });

    it('never leaks file_path in the response', async () => {
        mockGetMostPlayedTracks.mockResolvedValue([
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
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(JSON.stringify(body)).not.toContain('file_path');
        expect(JSON.stringify(body)).not.toContain('/data/media');
        expect(body.items[0].id).toBe('t1');
    });

    it('fetches one extra row and reports page.truncated', async () => {
        mockGetMostPlayedTracks.mockResolvedValue([
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
        ]);
        const event = {
            ...makeEvent(),
            url: new URL('http://localhost/api/v1/me/music/top-tracks?limit=1'),
        } as unknown as RequestEvent;
        const res = await def.handlers.GET!(event, { surface: 'v1' } as never);
        const body = await res.json();
        expect(mockGetMostPlayedTracks).toHaveBeenCalledWith(expect.anything(), 'u1', 2, ['g1'], {
            maxAgeRating: 13,
            allowUnrated: true,
        });
        expect(body.items).toHaveLength(1);
        expect(body.page).toEqual({ limit: 1, truncated: true });
    });
});
