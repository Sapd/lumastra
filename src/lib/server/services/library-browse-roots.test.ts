// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * getAllowedBrowseRoots: which directories the admin folder picker may list.
 * The parent of each filesystem library folder is a root — except that a
 * folder directly under `/` must never make `/` itself a root.
 */
import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';

const { mockGetAllLibraryPaths } = vi.hoisted(() => ({ mockGetAllLibraryPaths: vi.fn() }));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getAllLibraryPaths: mockGetAllLibraryPaths,
    FILESYSTEM_LIBRARY_PROVIDERS: ['tmdb', 'jellyfin', 'anidb', 'tvdb', 'musicbrainz'],
}));

import { getAllowedBrowseRoots } from './library-browse.service.js';

const sql = {} as unknown as postgres.Sql;

describe('getAllowedBrowseRoots', () => {
    it('adds the parent of a nested library folder', async () => {
        mockGetAllLibraryPaths.mockResolvedValue([{ path: '/srv/stuff/a', provider: 'tmdb' }]);
        expect(await getAllowedBrowseRoots(sql)).toContain('/srv/stuff');
    });

    it('never makes the filesystem root browsable for a top-level folder', async () => {
        mockGetAllLibraryPaths.mockResolvedValue([{ path: '/family', provider: 'tmdb' }]);
        const roots = await getAllowedBrowseRoots(sql);
        expect(roots).not.toContain('/');
        expect(roots).toContain('/family');
    });

    it('ignores remote-source rows, whose path is a sentinel, not a folder', async () => {
        mockGetAllLibraryPaths.mockResolvedValue([
            { path: 'abs://0000-shelf', provider: 'audiobookshelf' },
        ]);
        const roots = await getAllowedBrowseRoots(sql);
        expect(roots.some((r) => r.startsWith('abs:'))).toBe(false);
    });
});
