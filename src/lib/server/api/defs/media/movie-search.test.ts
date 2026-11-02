// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/movie/search: availability comes from the row's own `has_files`
 * (searchMedia's `is_available`), never from a Jellyfin id. A standalone
 * install has no Jellyfin ids, so a library movie must still be available,
 * playable and not requestable, and the canonical id is the internal UUID.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockSearchMedia = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}) as unknown,
}));

vi.mock('$lib/server/database/queries/search.queries.js', () => ({
    searchMedia: (...args: unknown[]) => mockSearchMedia(...args),
}));

vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: async () => ({
            allowedLibraryIds: null,
            maxAgeRating: null,
        }),
        searchAccessBoundary: () => ({}),
    };
});

const { def } = await import('./movie-search.js');

const INTERNAL = '11111111-2222-4333-8444-555555555555';

function makeEvent(name: string): RequestEvent {
    const url = new URL('http://localhost/api/movie/search');
    url.searchParams.set('name', name);
    return {
        url,
        params: {},
        locals: { user: undefined },
        request: new Request(url.toString()),
    } as unknown as RequestEvent;
}

async function search(name: string): Promise<Record<string, unknown>> {
    const res = (await def.handlers.GET!(makeEvent(name), { surface: 'internal' })) as Response;
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

describe('GET /api/movie/search without Jellyfin ids', () => {
    beforeEach(() => {
        mockSearchMedia.mockReset();
    });

    it('a library movie (has_files) is available + playable, not requestable, id = internal UUID', async () => {
        mockSearchMedia.mockResolvedValue([
            {
                internal_id: INTERNAL,
                tmdb_id: 603,
                title: 'Night Harbour',
                release_date: '1999-03-31',
                genres: [],
                is_available: true,
                jellyfin_id: null,
            },
        ]);

        const body = await search('Night Harbour');

        expect(body.id).toBe(INTERNAL);
        expect(body.isAvailable).toBe(true);
        expect(body.playbackAvailable).toBe(true);
        expect(body.canRequest).toBe(false);
        expect(body.ids).toEqual({ tmdb: '603', internal: INTERNAL });
    });

    it('a catalog-only movie (no files) is requestable and not playable', async () => {
        mockSearchMedia.mockResolvedValue([
            {
                internal_id: INTERNAL,
                tmdb_id: 604,
                title: 'Night Harbour',
                release_date: null,
                genres: [],
                is_available: false,
            },
        ]);

        const body = await search('Night Harbour');

        expect(body.isAvailable).toBe(false);
        expect(body.playbackAvailable).toBe(false);
        expect(body.canRequest).toBe(true);
    });

    it('never emits a Jellyfin id even when the row still carries one', async () => {
        mockSearchMedia.mockResolvedValue([
            {
                internal_id: INTERNAL,
                tmdb_id: 605,
                title: 'Night Harbour',
                release_date: null,
                genres: [],
                is_available: true,
                jellyfin_id: 'abcdef0123456789abcdef0123456789',
            },
        ]);

        const body = await search('Night Harbour');

        expect(body.id).toBe(INTERNAL);
        expect(body.ids).not.toHaveProperty('jellyfin');
    });
});
