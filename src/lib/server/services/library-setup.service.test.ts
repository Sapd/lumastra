// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the composite library-setup service: a group + its paths are
 * created in one transaction, every path inherits the library's single
 * media_type and the new group id, and cache/watcher hooks fire after commit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

vi.mock('$lib/server/config.js', () => ({ config: { TMDB_LANGUAGE: 'de-DE' } }));

const createLibraryGroup = vi.fn();
const createLibraryPath = vi.fn();
const afterLibraryGroupChanged = vi.fn(async (..._a: unknown[]) => {});
const afterLibraryPathChanged = vi.fn(async (..._a: unknown[]) => {});

vi.mock('$lib/server/database/queries/library-groups.queries', () => ({
    createLibraryGroup: (...a: unknown[]) => createLibraryGroup(...a),
}));
vi.mock('$lib/server/database/queries/library-paths.queries', async (importOriginal) => ({
    // The real normalizeLibraryPath: dedup must match what the insert stores.
    ...(await importOriginal<Record<string, unknown>>()),
    createLibraryPath: (...a: unknown[]) => createLibraryPath(...a),
}));
vi.mock('$lib/server/services/library-path-sync.service', () => ({
    afterLibraryGroupChanged: (...a: unknown[]) => afterLibraryGroupChanged(...a),
    afterLibraryPathChanged: (...a: unknown[]) => afterLibraryPathChanged(...a),
}));

// Folder validation touches the real filesystem (realpath); these tests cover
// the handler around it, so the folders are taken as valid here. The rules
// themselves: services/library-root-validation.test.ts.
vi.mock('$lib/server/services/library-root-validation.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/services/library-root-validation.js')>();
    const norm = (p: string): string =>
        p
            .trim()
            .replace(/\/{2,}/g, '/')
            .replace(/(.)\/+$/, '$1');
    return {
        ...actual,
        assertLibraryRootAllowed: async (_sql: unknown, p: string) => norm(p),
        checkLibraryRootForApi: async (_sql: unknown, p: string) => ({ path: norm(p) }),
        isWithinAllowedLibraryRoots: async () => true,
        configuredLibraryRoots: () => [],
    };
});

import { createLibrary } from './library-setup.service.js';

/** Fake sql whose begin() runs the callback with the same handle (single tx). */
function makeFakeSql(): Sql {
    const sql = {
        begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql),
    };
    return sql as unknown as Sql;
}

beforeEach(() => {
    vi.clearAllMocks();
    createLibraryGroup.mockResolvedValue({ id: 'grp-1', name: 'Movies' });
    createLibraryPath.mockImplementation(async (_sql: unknown, params: { path: string }) => ({
        id: `path-${params.path}`,
        ...params,
    }));
});

describe('createLibrary', () => {
    it('creates the group then every path with the library media_type + group id', async () => {
        const result = await createLibrary(makeFakeSql(), {
            name: 'Movies',
            media_type: 'movie',
            paths: [{ path: '/media/movies' }, { path: '/media/movies2' }],
        });

        expect(createLibraryGroup).toHaveBeenCalledTimes(1);
        expect(createLibraryPath).toHaveBeenCalledTimes(2);
        // Every path inherits the single media_type + the created group id.
        for (const call of createLibraryPath.mock.calls) {
            expect(call[1]).toMatchObject({
                media_type: 'movie',
                library_group_id: 'grp-1',
            });
        }
        expect(result.group.id).toBe('grp-1');
        expect(result.paths).toHaveLength(2);
    });

    it('fires both cache/watcher hooks after commit', async () => {
        await createLibrary(makeFakeSql(), {
            name: 'TV',
            media_type: 'tv',
            paths: [{ path: '/media/tv' }],
        });
        expect(afterLibraryGroupChanged).toHaveBeenCalledTimes(1);
        expect(afterLibraryPathChanged).toHaveBeenCalledTimes(1);
    });

    it('rejects an empty paths list', async () => {
        await expect(
            createLibrary(makeFakeSql(), {
                name: 'X',
                media_type: 'movie',
                paths: [],
            }),
        ).rejects.toThrow(/at least one folder/i);
        expect(createLibraryGroup).not.toHaveBeenCalled();
    });

    it('treats a trailing slash as the same folder (no UNIQUE(path) error mid-insert)', async () => {
        await expect(
            createLibrary(makeFakeSql(), {
                name: 'Movies',
                media_type: 'movie',
                paths: [{ path: '/media/movies' }, { path: '/media/movies/' }],
            }),
        ).rejects.toThrow(/Duplicate folder path/);
        expect(createLibraryGroup).not.toHaveBeenCalled();
    });

    it('rejects duplicate paths before writing anything', async () => {
        await expect(
            createLibrary(makeFakeSql(), {
                name: 'X',
                media_type: 'movie',
                paths: [{ path: '/media/dup' }, { path: '/media/dup' }],
            }),
        ).rejects.toThrow(/duplicate/i);
        expect(createLibraryGroup).not.toHaveBeenCalled();
    });

    it('treats whitespace-only differences as duplicates and inserts trimmed paths', async () => {
        // "/media" and "/media " must be caught as duplicates (dedup uses the
        // trimmed value), so nothing is written.
        await expect(
            createLibrary(makeFakeSql(), {
                name: 'X',
                media_type: 'movie',
                paths: [{ path: '/media' }, { path: '/media ' }],
            }),
        ).rejects.toThrow(/duplicate/i);
        expect(createLibraryGroup).not.toHaveBeenCalled();

        // A single padded path is inserted trimmed.
        await createLibrary(makeFakeSql(), {
            name: 'X',
            media_type: 'movie',
            paths: [{ path: '  /media/movies  ' }],
        });
        expect(createLibraryPath.mock.calls[0][1]).toMatchObject({
            path: '/media/movies',
        });
    });

    it('maps a UNIQUE(path) violation to a friendly error', async () => {
        createLibraryPath.mockRejectedValueOnce(
            Object.assign(new Error('duplicate key value violates unique constraint'), {
                code: '23505',
            }),
        );
        await expect(
            createLibrary(makeFakeSql(), {
                name: 'X',
                media_type: 'movie',
                paths: [{ path: '/media/already-registered' }],
            }),
        ).rejects.toThrow(/already part of another library/i);
    });
});

describe('createLibrary — audiobooks only from AudiobookShelf', () => {
    it('rejects an audiobook library of local folders before writing anything', async () => {
        await expect(
            createLibrary(makeFakeSql(), {
                name: 'Audiobooks',
                media_type: 'audiobook',
                paths: [{ path: '/media/audiobooks', provider: 'musicbrainz' }],
            }),
        ).rejects.toThrow(/AudiobookShelf/);
        expect(createLibraryGroup).not.toHaveBeenCalled();
        expect(createLibraryPath).not.toHaveBeenCalled();
    });

    it('rejects it when the provider is omitted', async () => {
        await expect(
            createLibrary(makeFakeSql(), {
                name: 'Audiobooks',
                media_type: 'audiobook',
                paths: [{ path: '/media/audiobooks' }],
            }),
        ).rejects.toThrow(/AudiobookShelf/);
    });
});

describe('createLibrary — configured default language', () => {
    it('uses the bare configured primary language and preserves explicit overrides', async () => {
        await createLibrary(makeFakeSql(), {
            name: 'Movies',
            media_type: 'movie',
            paths: [{ path: '/media/movies' }, { path: '/media/french', language: 'fr-FR' }],
        });
        expect(createLibraryPath.mock.calls[0][1]).toMatchObject({ language: 'de' });
        expect(createLibraryPath.mock.calls[1][1]).toMatchObject({ language: 'fr-FR' });
    });
});
