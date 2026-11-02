// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for Media Path Resolver
 *
 * Tests path resolution from Jellyfin paths to container-accessible paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { resolveMediaPath, isPathWithin } from './media-path-resolver';
import type { Stats } from 'fs';

// media-path-resolver.ts now routes all fs access through safe-fs.ts (global
// concurrency cap + timeout — see safe-fs.ts's F1 NFS-wedge rationale), so the
// mock target is safe-fs's guarded wrappers, not node:fs/promises directly.
vi.mock('./safe-fs.js', () => ({
    safeStat: vi.fn(),
    safeAccess: vi.fn(),
}));

// Mock fs (for constants)
vi.mock('fs', () => ({
    constants: { R_OK: 4 },
}));

import { safeStat, safeAccess } from './safe-fs.js';

// Mock config module
vi.mock('../config', () => ({
    config: {
        TRANSCODING_MODE: 'full',
    },
}));

// Mock cache module — always return null (cache miss) so DB is queried
vi.mock('../cache/index', () => ({
    cacheManager: {
        for: vi.fn(() => ({
            get: vi.fn(() => Promise.resolve(null)),
            set: vi.fn(() => Promise.resolve()),
            delete: vi.fn(() => Promise.resolve()),
        })),
    },
    CACHE_NAMESPACES: {
        libraryPathMappings: 'libraryPathMappings',
    },
}));

// Mock library-paths queries
vi.mock('../database/queries/library-paths.queries', () => ({
    getEnabledLibraryPaths: vi.fn(() => Promise.resolve([])),
}));

import * as libraryPathsModule from '../database/queries/library-paths.queries';

describe('isPathWithin', () => {
    it('accepts a file directly inside the root', () => {
        expect(isPathWithin('/config/image-sync/batch/x/y-thumb.jpg', '/config/image-sync')).toBe(
            true,
        );
    });
    it('accepts the root itself', () => {
        expect(isPathWithin('/config/image-sync', '/config/image-sync')).toBe(true);
    });
    it('rejects a sibling directory sharing a prefix', () => {
        // /config/image-sync-evil must NOT be treated as inside /config/image-sync
        expect(isPathWithin('/config/image-sync-evil/x.jpg', '/config/image-sync')).toBe(false);
    });
    it('rejects a path outside the root', () => {
        expect(isPathWithin('/etc/passwd', '/config/image-sync')).toBe(false);
    });
    it('rejects traversal that escapes the root', () => {
        expect(isPathWithin('/config/image-sync/../secret.txt', '/config/image-sync')).toBe(false);
    });
});

describe('resolveMediaPath', () => {
    const makeStats = (isFile: boolean, size: number): Stats =>
        ({ isFile: () => isFile, size }) as Stats;
    type FsError = Error & { code?: string };

    // Fake sql object — never actually called (queries are mocked)
    const fakeSql = {} as Sql;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('null/undefined input', () => {
        it('returns null for undefined path', async () => {
            const result = await resolveMediaPath(undefined);
            expect(result).toBeNull();
        });

        it('returns null for null path', async () => {
            const result = await resolveMediaPath(null);
            expect(result).toBeNull();
        });

        it('returns null for empty string', async () => {
            const result = await resolveMediaPath('');
            expect(result).toBeNull();
        });
    });

    describe('direct path access', () => {
        it('returns accessible when file exists and is readable', async () => {
            vi.mocked(safeStat).mockResolvedValue(makeStats(true, 1024000));
            vi.mocked(safeAccess).mockResolvedValue(undefined);

            const result = await resolveMediaPath('/data/movies/test.mkv');

            expect(result).toEqual({
                providerPath: '/data/movies/test.mkv',
                containerPath: '/data/movies/test.mkv',
                isAccessible: true,
                fileSize: 1024000,
            });
        });

        it('returns not_found when file does not exist', async () => {
            const error = new Error('ENOENT') as FsError;
            error.code = 'ENOENT';
            vi.mocked(safeStat).mockRejectedValue(error);

            const result = await resolveMediaPath('/data/movies/nonexistent.mkv');

            expect(result).toEqual({
                providerPath: '/data/movies/nonexistent.mkv',
                containerPath: '/data/movies/nonexistent.mkv',
                isAccessible: false,
                reason: 'not_found',
            });
        });

        it('returns permission_denied when access denied', async () => {
            const error = new Error('EACCES') as FsError;
            error.code = 'EACCES';
            vi.mocked(safeStat).mockRejectedValue(error);

            const result = await resolveMediaPath('/data/movies/protected.mkv');

            expect(result).toEqual({
                providerPath: '/data/movies/protected.mkv',
                containerPath: '/data/movies/protected.mkv',
                isAccessible: false,
                reason: 'permission_denied',
            });
        });

        it('returns not_file when path is a directory', async () => {
            vi.mocked(safeStat).mockResolvedValue(makeStats(false, 0));

            const result = await resolveMediaPath('/data/movies');

            expect(result).toEqual({
                providerPath: '/data/movies',
                containerPath: '/data/movies',
                isAccessible: false,
                reason: 'not_file',
            });
        });

        it('returns error for other errors', async () => {
            const error = new Error('Unknown error') as FsError;
            error.code = 'UNKNOWN';
            vi.mocked(safeStat).mockRejectedValue(error);

            const result = await resolveMediaPath('/data/movies/test.mkv');

            expect(result).toEqual({
                providerPath: '/data/movies/test.mkv',
                containerPath: '/data/movies/test.mkv',
                isAccessible: false,
                reason: 'error',
            });
        });
    });

    describe('read permission check', () => {
        it('fails when file exists but is not readable', async () => {
            vi.mocked(safeStat).mockResolvedValue(makeStats(true, 1024000));

            const accessError = new Error('EACCES') as FsError;
            accessError.code = 'EACCES';
            vi.mocked(safeAccess).mockRejectedValue(accessError);

            const result = await resolveMediaPath('/data/movies/unreadable.mkv');

            expect(result).toEqual({
                providerPath: '/data/movies/unreadable.mkv',
                containerPath: '/data/movies/unreadable.mkv',
                isAccessible: false,
                reason: 'permission_denied',
            });
        });
    });

    describe('DB-backed library path mappings', () => {
        beforeEach(() => {
            // Reset Once queues to avoid bleed between tests
            vi.mocked(safeStat).mockReset();
            vi.mocked(safeAccess).mockReset();
        });

        it('uses DB mapping when direct path fails', async () => {
            const notFoundError = new Error('ENOENT') as FsError;
            notFoundError.code = 'ENOENT';

            vi.mocked(safeStat)
                .mockRejectedValueOnce(notFoundError) // Direct path fails
                .mockResolvedValueOnce(makeStats(true, 2048000)); // DB-mapped path succeeds

            vi.mocked(safeAccess).mockResolvedValue(undefined);

            vi.mocked(libraryPathsModule.getEnabledLibraryPaths).mockResolvedValue([
                {
                    id: '1',
                    path: '/mnt/media',
                    provider_path: '/jellyfin/data',
                    media_type: 'movie',
                    language: 'en',
                    provider: 'tmdb',
                    enabled: true,
                    library_group_id: '1',
                    edition_label: null,
                    scan_chapters: false,
                    fallback_providers: [],
                    source_prefix: null,
                    created_at: new Date(),
                    updated_at: new Date(),
                },
            ]);

            const result = await resolveMediaPath(
                '/jellyfin/data/movies/test.mkv',
                { skipLocalAccessCheck: true },
                fakeSql,
            );

            expect(result).toEqual({
                providerPath: '/jellyfin/data/movies/test.mkv',
                containerPath: '/mnt/media/movies/test.mkv',
                isAccessible: true,
                fileSize: 2048000,
            });
        });

        it('returns inaccessible when no DB mapping matches', async () => {
            const notFoundError = new Error('ENOENT') as FsError;
            notFoundError.code = 'ENOENT';

            vi.mocked(safeStat).mockRejectedValue(notFoundError);

            vi.mocked(libraryPathsModule.getEnabledLibraryPaths).mockResolvedValue([
                {
                    id: '2',
                    path: '/mnt/other',
                    provider_path: '/other/prefix',
                    media_type: 'tv',
                    language: 'en',
                    provider: 'tmdb',
                    enabled: true,
                    library_group_id: '2',
                    edition_label: null,
                    scan_chapters: false,
                    fallback_providers: [],
                    source_prefix: null,
                    created_at: new Date(),
                    updated_at: new Date(),
                },
            ]);

            const result = await resolveMediaPath(
                '/jellyfin/data/movies/test.mkv',
                { skipLocalAccessCheck: true },
                fakeSql,
            );

            expect(result?.isAccessible).toBe(false);
            expect(result?.containerPath).toBe('/jellyfin/data/movies/test.mkv');
        });

        it('skips DB lookup when sql is not provided', async () => {
            const notFoundError = new Error('ENOENT') as FsError;
            notFoundError.code = 'ENOENT';

            vi.mocked(safeStat).mockRejectedValue(notFoundError);

            // No sql argument — DB lookup skipped
            const result = await resolveMediaPath('/jellyfin/data/movies/test.mkv', {
                skipLocalAccessCheck: true,
            });

            expect(result?.isAccessible).toBe(false);
            expect(libraryPathsModule.getEnabledLibraryPaths).not.toHaveBeenCalled();
        });

        it('resolves longest-prefix-first when overlapping DB mappings exist', async () => {
            const notFoundError = new Error('ENOENT') as FsError;
            notFoundError.code = 'ENOENT';

            // Direct path fails, then the first mapping tried (longest prefix) succeeds
            vi.mocked(safeStat)
                .mockRejectedValueOnce(notFoundError) // Direct path fails
                .mockResolvedValueOnce(makeStats(true, 5000000)); // First mapping (longest prefix) succeeds

            vi.mocked(safeAccess).mockResolvedValue(undefined);

            // Return overlapping prefixes — shorter first to ensure sort logic works
            vi.mocked(libraryPathsModule.getEnabledLibraryPaths).mockResolvedValue([
                {
                    id: '1',
                    path: '/mnt/media',
                    provider_path: '/media',
                    media_type: 'movie',
                    language: 'en',
                    provider: 'tmdb',
                    enabled: true,
                    library_group_id: '1',
                    edition_label: null,
                    scan_chapters: false,
                    fallback_providers: [],
                    source_prefix: null,
                    created_at: new Date(),
                    updated_at: new Date(),
                },
                {
                    id: '2',
                    path: '/mnt/media/movies',
                    provider_path: '/media/movies',
                    media_type: 'movie',
                    language: 'en',
                    provider: 'tmdb',
                    enabled: true,
                    library_group_id: '2',
                    edition_label: null,
                    scan_chapters: false,
                    fallback_providers: [],
                    source_prefix: null,
                    created_at: new Date(),
                    updated_at: new Date(),
                },
            ]);

            const result = await resolveMediaPath(
                '/media/movies/daydream.mkv',
                { skipLocalAccessCheck: true },
                fakeSql,
            );

            // Should use /media/movies → /mnt/media/movies (longest prefix),
            // NOT /media → /mnt/media which would produce /mnt/media/movies/daydream.mkv
            expect(result).toEqual({
                providerPath: '/media/movies/daydream.mkv',
                containerPath: '/mnt/media/movies/daydream.mkv',
                isAccessible: true,
                fileSize: 5000000,
            });
        });
    });
});
