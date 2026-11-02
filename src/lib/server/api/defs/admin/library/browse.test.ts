// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/library/browse — the def's own job is thin: resolve the
 * allowed roots, delegate to the pure `listBrowseEntries`, map its result to
 * a status code, and annotate entries that are already a configured library
 * folder. The confinement logic itself is covered by
 * `library-browse.service.test.ts` against real temp directories.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const {
    mockGetDb,
    mockGetAllowedBrowseRoots,
    mockListBrowseEntries,
    mockGetAllLibraryPaths,
    mockGetLibraryGroupById,
} = vi.hoisted(() => ({
    mockGetDb: vi.fn(),
    mockGetAllowedBrowseRoots: vi.fn(),
    mockListBrowseEntries: vi.fn(),
    mockGetAllLibraryPaths: vi.fn(),
    mockGetLibraryGroupById: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: mockGetDb }));
vi.mock('$lib/server/services/library-browse.service.js', () => ({
    getAllowedBrowseRoots: mockGetAllowedBrowseRoots,
    listBrowseEntries: mockListBrowseEntries,
}));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getAllLibraryPaths: mockGetAllLibraryPaths,
}));
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getLibraryGroupById: mockGetLibraryGroupById,
}));

import { def } from './browse.js';

function call(path?: string) {
    return def.handlers.GET!({} as RequestEvent, { input: { query: { path } } } as never);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockGetAllowedBrowseRoots.mockResolvedValue(['/srv/stuff']);
    mockGetAllLibraryPaths.mockResolvedValue([]);
});

describe('GET /api/admin/library/browse', () => {
    it('503s when the database is unavailable', async () => {
        mockGetDb.mockReturnValue(null);
        const res = (await call('/srv/stuff/a')) as Response;
        expect(res.status).toBe(503);
    });

    it('maps a 403 result to a forbidden response', async () => {
        mockListBrowseEntries.mockResolvedValue({
            ok: false,
            status: 403,
            message: 'outside allowed roots',
        });
        const res = (await call('/etc')) as Response;
        expect(res.status).toBe(403);
    });

    it('maps a 400 result to a validation-failed response', async () => {
        mockListBrowseEntries.mockResolvedValue({
            ok: false,
            status: 400,
            message: 'not a directory',
        });
        const res = (await call('/srv/stuff/a-file')) as Response;
        expect(res.status).toBe(422);
    });

    it('annotates an entry that is already a configured library folder', async () => {
        mockListBrowseEntries.mockResolvedValue({
            ok: true,
            path: '/srv/stuff',
            entries: [{ name: 'a', path: '/srv/stuff/a', readable: true, childCount: 2 }],
        });
        mockGetAllLibraryPaths.mockResolvedValue([
            {
                id: 'lp-1',
                path: '/srv/stuff/a',
                library_group_id: 'grp-1',
                provider: 'tmdb',
            },
        ]);
        // Name deliberately doesn't describe a media type.
        mockGetLibraryGroupById.mockResolvedValue({ id: 'grp-1', name: 'Family Vault' });

        const res = (await call('/srv/stuff')) as Response;
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            entries: { libraryGroupId?: string; libraryName?: string }[];
        };
        expect(body.entries[0].libraryGroupId).toBe('grp-1');
        expect(body.entries[0].libraryName).toBe('Family Vault');
    });

    it('leaves an unconfigured entry unannotated', async () => {
        mockListBrowseEntries.mockResolvedValue({
            ok: true,
            path: '/srv/stuff',
            entries: [{ name: 'a', path: '/srv/stuff/a', readable: true, childCount: 0 }],
        });
        const res = (await call('/srv/stuff')) as Response;
        const body = (await res.json()) as { entries: { libraryGroupId?: string }[] };
        expect(body.entries[0].libraryGroupId).toBeUndefined();
    });

    it('returns the roots listing when no path is given', async () => {
        mockListBrowseEntries.mockResolvedValue({
            ok: true,
            path: null,
            entries: [{ name: 'stuff', path: '/srv/stuff', readable: true, childCount: 1 }],
        });
        const res = (await call(undefined)) as Response;
        const body = (await res.json()) as { path: string | null };
        expect(body.path).toBeNull();
        expect(mockListBrowseEntries).toHaveBeenCalledWith(undefined, ['/srv/stuff']);
    });
});
