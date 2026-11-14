// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** GET /j/Items/Counts → Jellyfin ItemCounts from the scoped counts query. */

import type { RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCounts, mockAccess } = vi.hoisted(() => ({
    mockCounts: vi.fn(),
    mockAccess: vi.fn(),
}));

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) as never }));
vi.mock('$lib/server/database/queries/jellyfin-browse.queries', () => ({
    getLibraryItemCounts: mockCounts,
}));
vi.mock('$lib/server/jellyfin-compat/access-context', () => ({
    buildJellyfinAccessContext: mockAccess,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const USER = { username: 'denis', userId: '00000000-0000-0000-0000-0000000000de' };
const BOUNDARY = { library: { kind: 'denyGroups', ids: ['g'] }, age: { kind: 'any' } };

async function call(query = ''): Promise<Record<string, unknown>> {
    const { GET } = await import('./+server');
    const res = await (GET as (e: never) => Promise<Response>)({
        url: new URL(`http://localhost/j/Items/Counts${query}`),
        locals: { user: USER },
    } as never);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue({ boundary: BOUNDARY });
    mockCounts.mockResolvedValue({ movie: 3, tv: 2, episode: 40, artist: 1, album: 4, track: 50 });
});

describe('GET /j/Items/Counts', () => {
    it('maps the scoped counts onto ItemCounts', async () => {
        expect(await call()).toEqual({
            MovieCount: 3,
            SeriesCount: 2,
            EpisodeCount: 40,
            ArtistCount: 1,
            ProgramCount: 0,
            TrailerCount: 0,
            SongCount: 50,
            AlbumCount: 4,
            MusicVideoCount: 0,
            BoxSetCount: 0,
            BookCount: 0,
            ItemCount: 100,
        });
        expect(mockCounts).toHaveBeenCalledWith(expect.anything(), {
            access: BOUNDARY,
            userId: USER.userId,
            isFavorite: null,
        });
    });

    it('honours isFavorite', async () => {
        await call('?isFavorite=true');
        expect(mockCounts.mock.calls[0][1]).toMatchObject({ isFavorite: true });
        await call('?IsFavorite=false');
        expect(mockCounts.mock.calls[1][1]).toMatchObject({ isFavorite: false });
    });
});
