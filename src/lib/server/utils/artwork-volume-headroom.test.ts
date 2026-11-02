// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Disk-headroom preflight for the provider-artwork drain.
 *
 * The drain writes 4-5 GB per 10k files across volumes that differ
 * (/config vs the media mounts), so the check must be PER VOLUME, memoized
 * (one statfs per volume per minute, not per item), and fail-OPEN on an
 * unreadable mount.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSafeStatfs, mockGetEnabledLibraryPaths } = vi.hoisted(() => ({
    mockSafeStatfs: vi.fn(),
    mockGetEnabledLibraryPaths: vi.fn(),
}));

vi.mock('./safe-fs.js', () => ({ safeStatfs: mockSafeStatfs }));
vi.mock('../database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: mockGetEnabledLibraryPaths,
}));
vi.mock('../config.js', () => ({ config: { BASE_PATH: '/data' } }));

import {
    collectArtworkTargetVolumes,
    measureVolumeHeadroom,
    checkArtworkDiskHeadroom,
    __resetArtworkHeadroomCacheForTests,
} from './artwork-volume-headroom.js';

const GIB = 1024 * 1024 * 1024;
const statfsWith = (freeGib: number) => ({
    bsize: 4096,
    blocks: (100 * GIB) / 4096,
    bfree: (freeGib * GIB) / 4096,
    bavail: (freeGib * GIB) / 4096,
    files: 0,
    ffree: 0,
    type: 0,
});

const fakeSql = {} as never;

describe('collectArtworkTargetVolumes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetArtworkHeadroomCacheForTests();
    });

    it('includes the central artwork root and every enabled library path, de-duplicated', async () => {
        mockGetEnabledLibraryPaths.mockResolvedValue([
            { path: '/media/movies' },
            { path: '/media/series' },
            { path: '/media/movies' },
        ]);

        const volumes = await collectArtworkTargetVolumes(fakeSql);

        expect(volumes).toEqual([
            { label: 'central', path: '/data' },
            { label: 'library', path: '/media/movies' },
            { label: 'library', path: '/media/series' },
        ]);
    });

    it('still returns the central volume when the library query fails', async () => {
        mockGetEnabledLibraryPaths.mockRejectedValue(new Error('db down'));

        const volumes = await collectArtworkTargetVolumes(fakeSql);

        expect(volumes).toEqual([{ label: 'central', path: '/data' }]);
    });
});

describe('measureVolumeHeadroom', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetArtworkHeadroomCacheForTests();
    });

    it('flags only the volumes below the margin', async () => {
        mockSafeStatfs.mockImplementation(async (p: string) =>
            p === '/media/full' ? statfsWith(1) : statfsWith(50),
        );

        const result = await measureVolumeHeadroom(
            [
                { label: 'central', path: '/data' },
                { label: 'library', path: '/media/full' },
            ],
            5 * GIB,
        );

        expect(result[0].belowMargin).toBe(false);
        expect(result[0].freeBytes).toBe(50 * GIB);
        expect(result[1].belowMargin).toBe(true);
        expect(result[1].freeBytes).toBe(1 * GIB);
    });

    it('fails OPEN when statfs throws (unmounted / NFS flap)', async () => {
        mockSafeStatfs.mockRejectedValue(new Error('ENOENT'));

        const result = await measureVolumeHeadroom(
            [{ label: 'library', path: '/media/gone' }],
            5 * GIB,
        );

        expect(result[0].freeBytes).toBeNull();
        expect(result[0].belowMargin).toBe(false);
    });
});

describe('checkArtworkDiskHeadroom', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetArtworkHeadroomCacheForTests();
        mockGetEnabledLibraryPaths.mockResolvedValue([{ path: '/media/movies' }]);
    });

    it('returns ok:false when ANY volume is below the margin', async () => {
        mockSafeStatfs.mockImplementation(async (p: string) =>
            p === '/media/movies' ? statfsWith(1) : statfsWith(50),
        );

        const result = await checkArtworkDiskHeadroom(fakeSql, 5 * GIB, 1_000);

        expect(result.ok).toBe(false);
        expect(result.volumes.filter((v) => v.belowMargin).map((v) => v.path)).toEqual([
            '/media/movies',
        ]);
    });

    it('memoizes within the cache window — one statfs per volume per minute', async () => {
        mockSafeStatfs.mockResolvedValue(statfsWith(50));

        await checkArtworkDiskHeadroom(fakeSql, 5 * GIB, 1_000);
        await checkArtworkDiskHeadroom(fakeSql, 5 * GIB, 30_000);

        // 2 volumes (central + one library), measured once.
        expect(mockSafeStatfs).toHaveBeenCalledTimes(2);
    });

    it('re-measures after the cache window expires', async () => {
        mockSafeStatfs.mockResolvedValue(statfsWith(50));

        await checkArtworkDiskHeadroom(fakeSql, 5 * GIB, 1_000);
        await checkArtworkDiskHeadroom(fakeSql, 5 * GIB, 1_000 + 60_001);

        expect(mockSafeStatfs).toHaveBeenCalledTimes(4);
    });

    it('re-measures when the margin changes', async () => {
        mockSafeStatfs.mockResolvedValue(statfsWith(50));

        await checkArtworkDiskHeadroom(fakeSql, 5 * GIB, 1_000);
        await checkArtworkDiskHeadroom(fakeSql, 10 * GIB, 1_500);

        expect(mockSafeStatfs).toHaveBeenCalledTimes(4);
    });
});
