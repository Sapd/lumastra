// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library folder rules against a REAL temp directory (realpath, symlinks):
 * only the library_paths read and the config are faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';

const state = vi.hoisted(() => ({
    allowedRoots: '',
    rows: [] as Array<{ id: string; path: string }>,
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        get LIBRARY_ALLOWED_ROOTS() {
            return state.allowedRoots;
        },
    },
}));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getAllLibraryPaths: async () => state.rows,
    normalizeLibraryPath: (p: string) =>
        p
            .trim()
            .replace(/\/{2,}/g, '/')
            .replace(/(.)\/+$/, '$1'),
}));

import {
    assertLibraryRootAllowed,
    isWithinAllowedLibraryRoots,
    LibraryRootRejectedError,
} from './library-root-validation.js';

const sql = {} as postgres.Sql;
let root: string;

async function reason(p: string, opts?: { excludeId?: string }): Promise<string | null> {
    try {
        await assertLibraryRootAllowed(sql, p, opts);
        return null;
    } catch (err) {
        if (err instanceof LibraryRootRejectedError) return err.reason;
        throw err;
    }
}

beforeEach(async () => {
    // realpath: macOS /var → /private/var; compare like the code does.
    root = await realpath(await mkdtemp(join(tmpdir(), 'libroot-')));
    await mkdir(join(root, 'media', 'movies'), { recursive: true });
    await mkdir(join(root, 'media', 'tv'), { recursive: true });
    await mkdir(join(root, 'elsewhere'), { recursive: true });
    state.allowedRoots = '';
    state.rows = [];
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('assertLibraryRootAllowed', () => {
    it('accepts an existing absolute folder and returns it normalized', async () => {
        await expect(assertLibraryRootAllowed(sql, ` ${root}/media//movies/ `)).resolves.toBe(
            `${root}/media/movies`,
        );
    });

    it('rejects relative paths, dot segments and the filesystem root', async () => {
        expect(await reason('media/movies')).toBe('not-absolute');
        expect(await reason(`${root}/media/../elsewhere`)).toBe('invalid');
        expect(await reason('/')).toBe('filesystem-root');
        expect(await reason('//')).toBe('filesystem-root');
    });

    it('rejects a folder that does not exist', async () => {
        expect(await reason(`${root}/media/missing`)).toBe('not-found');
    });

    it('rejects a symlink that resolves to /', async () => {
        await symlink('/', join(root, 'everything'));
        expect(await reason(`${root}/everything`)).toBe('filesystem-root');
    });

    it('refuses the same folder, a folder inside one, and a folder around one', async () => {
        state.rows = [{ id: 'a', path: `${root}/media/movies` }];
        expect(await reason(`${root}/media/movies`)).toBe('duplicate');
        await mkdir(join(root, 'media', 'movies', '4k'));
        expect(await reason(`${root}/media/movies/4k`)).toBe('overlaps');
        expect(await reason(`${root}/media`)).toBe('overlaps');
        // A sibling whose name only starts the same is fine.
        await mkdir(join(root, 'media', 'movies-4k'));
        expect(await reason(`${root}/media/movies-4k`)).toBeNull();
    });

    it('sees through a symlinked alias of an existing folder', async () => {
        state.rows = [{ id: 'a', path: `${root}/media/movies` }];
        await symlink(join(root, 'media', 'movies'), join(root, 'alias'));
        expect(await reason(`${root}/alias`)).toBe('duplicate');
    });

    it('lets a folder keep its own path when it is the row being edited', async () => {
        state.rows = [{ id: 'a', path: `${root}/media/movies` }];
        expect(await reason(`${root}/media/movies`, { excludeId: 'a' })).toBeNull();
    });

    it('ignores remote sentinel rows', async () => {
        state.rows = [{ id: 'r', path: 'abs://abc' }];
        expect(await reason(`${root}/media/tv`)).toBeNull();
    });

    it('enforces LIBRARY_ALLOWED_ROOTS by realpath when set', async () => {
        state.allowedRoots = `${root}/media`;
        expect(await reason(`${root}/media/tv`)).toBeNull();
        expect(await reason(`${root}/elsewhere`)).toBe('outside-allowed-roots');
        // A symlink inside the allowed root that points outside it is outside.
        await symlink(join(root, 'elsewhere'), join(root, 'media', 'escape'));
        expect(await reason(`${root}/media/escape`)).toBe('outside-allowed-roots');
    });
});

describe('isWithinAllowedLibraryRoots', () => {
    it('allows everything without an allow-list', async () => {
        expect(await isWithinAllowedLibraryRoots('/etc')).toBe(true);
    });

    it('confines to the allow-list when set', async () => {
        state.allowedRoots = `${root}/media`;
        expect(await isWithinAllowedLibraryRoots(`${root}/media/tv`)).toBe(true);
        expect(await isWithinAllowedLibraryRoots('/etc')).toBe(false);
    });
});
