// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Protects device deduplication and fail-open, sequential probing of library mounts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dirent, type Stats, type StatsFs } from 'node:fs';

vi.mock('$lib/server/utils/safe-fs.js', async () => {
    const actual = await vi.importActual<typeof import('$lib/server/utils/safe-fs.js')>(
        '$lib/server/utils/safe-fs.js',
    );
    return {
        ...actual,
        safeStat: vi.fn(),
        safeReaddir: vi.fn(),
        safeStatfs: vi.fn(),
    };
});

import { FsTimeoutError, safeReaddir, safeStat, safeStatfs } from '$lib/server/utils/safe-fs.js';
import { measureLibraryVolumes, type LibraryPathRef } from './volume-probe.js';

const paths: LibraryPathRef[] = [
    { id: 'movies', path: '/media/movies' },
    { id: 'series', path: '/media/series' },
];
const filesystem: StatsFs = {
    type: 0,
    bsize: 4096,
    blocks: 1000,
    bfree: 300,
    bavail: 200,
    files: 100,
    ffree: 50,
};

/** The probe reads only `dev`; `Stats` has no public constructor. */
function stat(deviceId: number = 7): Stats {
    return { dev: deviceId } as Stats;
}

describe('measureLibraryVolumes', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(safeStat).mockResolvedValue(stat());
        const entry = new Dirent();
        entry.name = 'movie.mkv';
        vi.mocked(safeReaddir).mockResolvedValue([entry]);
        vi.mocked(safeStatfs).mockResolvedValue(filesystem);
    });

    it('measures one filesystem for two paths and uses bavail rather than bfree', async () => {
        const result = await measureLibraryVolumes(paths, 500);

        expect(safeStat).toHaveBeenCalledTimes(2);
        expect(safeStatfs).toHaveBeenCalledExactlyOnceWith('/media/movies', 500);
        expect(result).toEqual({
            rows: paths.map((path) => ({
                libraryPathId: path.id,
                deviceId: '7',
                freeBytes: 200 * 4096,
                totalBytes: 1000 * 4096,
            })),
            unreadable: [],
            filesystems: 1,
        });
    });

    it('reports a missing path as unreadable without a free-space row', async () => {
        vi.mocked(safeStat).mockRejectedValueOnce(
            Object.assign(new Error('missing mount'), { code: 'ENOENT' }),
        );

        expect(await measureLibraryVolumes([paths[0]])).toEqual({
            rows: [],
            unreadable: ['/media/movies'],
            filesystems: 0,
        });
        expect(safeReaddir).not.toHaveBeenCalled();
        expect(safeStatfs).not.toHaveBeenCalled();
    });

    it('treats an empty mountpoint as unreadable', async () => {
        vi.mocked(safeReaddir).mockResolvedValueOnce([]);

        expect(await measureLibraryVolumes([paths[0]])).toEqual({
            rows: [],
            unreadable: ['/media/movies'],
            filesystems: 0,
        });
        expect(safeStatfs).not.toHaveBeenCalled();
    });

    it('retries another path on the device after a non-timeout statfs error', async () => {
        vi.mocked(safeStatfs).mockRejectedValueOnce(
            Object.assign(new Error('stale handle'), { code: 'ESTALE' }),
        );

        const result = await measureLibraryVolumes(paths);

        expect(safeStatfs).toHaveBeenNthCalledWith(1, '/media/movies', undefined);
        expect(safeStatfs).toHaveBeenNthCalledWith(2, '/media/series', undefined);
        expect(safeStatfs).toHaveBeenCalledTimes(2);
        expect(result.rows).toEqual(
            paths.map((path) => ({
                libraryPathId: path.id,
                deviceId: '7',
                freeBytes: 200 * 4096,
                totalBytes: 1000 * 4096,
            })),
        );
        expect(result.unreadable).toEqual([]);
        expect(result.filesystems).toBe(1);
    });

    it('marks every path on a zero-sized filesystem unreadable', async () => {
        vi.mocked(safeStatfs).mockResolvedValueOnce({ ...filesystem, blocks: 0 });

        expect(await measureLibraryVolumes(paths)).toEqual({
            rows: [],
            unreadable: paths.map((path) => path.path),
            filesystems: 0,
        });
        expect(safeStatfs).toHaveBeenCalledTimes(1);
    });

    it('stops after a stat timeout and skips every later path', async () => {
        const laterPaths: LibraryPathRef[] = [...paths, { id: 'music', path: '/media/music' }];
        vi.mocked(safeStat).mockRejectedValueOnce(new FsTimeoutError('stat', paths[0].path, 500));

        expect(await measureLibraryVolumes(laterPaths, 500)).toEqual({
            rows: [],
            unreadable: laterPaths.map((path) => path.path),
            filesystems: 0,
        });
        expect(safeStat).toHaveBeenCalledExactlyOnceWith('/media/movies', 500);
        expect(safeReaddir).not.toHaveBeenCalled();
        expect(safeStatfs).not.toHaveBeenCalled();
    });

    it('does not start a second stat while the first is pending', async () => {
        let resolveFirst!: (value: Stats) => void;
        const first = new Promise<Stats>((resolve) => {
            resolveFirst = resolve;
        });
        vi.mocked(safeStat).mockReturnValueOnce(first);

        const pending = measureLibraryVolumes(paths);
        try {
            await Promise.resolve();
            expect(safeStat).toHaveBeenCalledExactlyOnceWith('/media/movies', undefined);
            expect(safeReaddir).not.toHaveBeenCalled();
            expect(safeStatfs).not.toHaveBeenCalled();
        } finally {
            resolveFirst(stat());
        }

        const result = await pending;
        expect(safeStat).toHaveBeenNthCalledWith(2, '/media/series', undefined);
        expect(safeStat).toHaveBeenCalledTimes(2);
        expect(result.rows).toHaveLength(2);
        expect(result.unreadable).toEqual([]);
    });
});
