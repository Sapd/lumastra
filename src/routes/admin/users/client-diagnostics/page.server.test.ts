// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The load returns the library roots and the transcode directory. It must
 * not depend on the admin layout's redirect alone: SvelteKit runs page and
 * layout loads in parallel.
 */

import { describe, it, expect, vi } from 'vitest';

const getEnabledLibraryPaths = vi.hoisted(() => vi.fn(async () => [{ path: '/media/movies' }]));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths,
}));

import { load } from './+page.server.js';

describe('/admin/users/client-diagnostics load', () => {
    it('redirects a non-admin before reading any path', async () => {
        await expect(
            load({
                locals: { user: { ownerIsAdmin: false }, principal: { isAdmin: false } },
            } as never),
        ).rejects.toMatchObject({
            status: 303,
        });
        expect(getEnabledLibraryPaths).not.toHaveBeenCalled();
    });

    it('returns the roots to an admin', async () => {
        const result = (await load({
            locals: { user: { ownerIsAdmin: true }, principal: { isAdmin: true } },
        } as never)) as {
            roots: { libraryRoots: string[] };
        };
        expect(result.roots.libraryRoots).toEqual(['/media/movies']);
    });
});
