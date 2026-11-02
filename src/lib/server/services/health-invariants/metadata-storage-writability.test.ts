// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

vi.mock('$lib/server/config.js', () => ({
    config: {
        get METADATA_STORAGE_LOCATION() {
            return mockMode;
        },
    },
}));

vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: vi.fn(),
}));

vi.mock('$lib/server/services/metadata-storage.service.js', () => ({
    metadataCentralBaseDir: () => CENTRAL,
}));

vi.mock('$lib/server/utils/safe-fs.js', () => {
    class FsTimeoutError extends Error {
        constructor(
            public readonly op: string,
            public readonly path: string,
            public readonly timeoutMs: number,
        ) {
            super(`fs ${op} timed out after ${timeoutMs}ms: ${path}`);
            this.name = 'FsTimeoutError';
        }
    }
    return {
        FsTimeoutError,
        safeWriteFile: vi.fn(),
        safeUnlink: vi.fn(),
        safeMkdir: vi.fn(),
    };
});

let mockMode: 'central' | 'alongside' | 'alongside-prefer' = 'central';

/**
 * Stand-in for `metadataCentralBaseDir()`. The central root is probed FIRST and
 * in every mode, so it occupies `safeWriteFile` call 0 in every test below —
 * hence a sentinel distinct from any `/mnt/*` root, and the `writableExcept`
 * helper so a test can fail one root without also failing central.
 */
const CENTRAL = '/central';

/**
 * The probe targets `<base>/.metadata` — the directory `resolveWritePath` actually
 * mkdir -p's and writes into — not the bare base.
 */
const CENTRAL_METADATA = `${CENTRAL}/.metadata`;

const probeOf = (dir: string): string => `${dir}/.lumastra-writability-probe`;

import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { safeWriteFile, safeUnlink, safeMkdir, FsTimeoutError } from '$lib/server/utils/safe-fs.js';
import {
    checkMetadataStorageWritability,
    __resetWritabilityProbeCacheForTests,
    __resetProbeRotationForTests,
} from './metadata-storage-writability.js';

const fakeSql = {} as postgres.Sql;

function libraryPathRow(id: string, path: string) {
    return {
        id,
        path,
        media_type: 'movie' as const,
        language: 'en',
        provider: 'tmdb' as const,
        enabled: true,
        provider_path: null,
        library_group_id: 'group-1',
        edition_label: null,
        scan_chapters: false,
        fallback_providers: [],
        source_prefix: null,
        created_at: new Date(),
        updated_at: new Date(),
    };
}

/**
 * `safeWriteFile` mock that succeeds everywhere except the given probe dirs.
 * Lets a test fail ONE library root without also failing the central root, which
 * is probed on every call.
 */
function writableExcept(failing: Record<string, Error>): void {
    vi.mocked(safeWriteFile).mockImplementation(async (filePath: string) => {
        for (const [dir, err] of Object.entries(failing)) {
            if (filePath === probeOf(dir)) throw err;
        }
    });
}

describe('checkMetadataStorageWritability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetWritabilityProbeCacheForTests();
        __resetProbeRotationForTests();
        mockMode = 'central';
        // Default: everything writable. Individual tests override.
        vi.mocked(safeWriteFile).mockResolvedValue(undefined);
        vi.mocked(safeUnlink).mockResolvedValue(undefined);
        vi.mocked(safeMkdir).mockResolvedValue(undefined);
    });

    it("probes only the central root when mode is 'central'", async () => {
        mockMode = 'central';

        const result = await checkMetadataStorageWritability(fakeSql);

        expect(result).toEqual({
            mode: 'central',
            readOnlyRoots: [],
            unknownRoots: [],
            centralDir: CENTRAL_METADATA,
            centralWritable: 'writable',
        });
        expect(getEnabledLibraryPaths).not.toHaveBeenCalled();
        expect(safeWriteFile).toHaveBeenCalledTimes(1);
        expect(vi.mocked(safeWriteFile).mock.calls[0][0]).toBe(probeOf(CENTRAL_METADATA));
    });

    it('reports a writable root as neither read-only nor unknown', async () => {
        mockMode = 'alongside';
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([libraryPathRow('1', '/mnt/movies')]);

        const result = await checkMetadataStorageWritability(fakeSql);

        expect(result).toEqual({
            mode: 'alongside',
            readOnlyRoots: [],
            unknownRoots: [],
            centralDir: CENTRAL_METADATA,
            centralWritable: 'writable',
        });
        // Central + the one library root.
        expect(safeUnlink).toHaveBeenCalledTimes(2);
    });

    it.each(['EROFS', 'EACCES', 'EPERM'])(
        'classifies a %s write failure as read-only',
        async (code) => {
            mockMode = 'alongside';
            vi.mocked(getEnabledLibraryPaths).mockResolvedValue([
                libraryPathRow('1', '/mnt/movies'),
            ]);
            writableExcept({ '/mnt/movies': Object.assign(new Error(code), { code }) });

            const result = await checkMetadataStorageWritability(fakeSql);

            expect(result.readOnlyRoots).toEqual(['/mnt/movies']);
            expect(result.unknownRoots).toEqual([]);
            expect(result.centralWritable).toBe('writable');
        },
    );

    // The prod 2026-07-30 shape: library roots fine, central root owned by root
    // while the app runs as uid 1000. Central is the fallback target for any item
    // with no derivable media folder, so this must NOT read as green.
    it.each(['EROFS', 'EACCES', 'EPERM'])(
        'classifies a %s failure on the CENTRAL root as read-only, in alongside mode',
        async (code) => {
            mockMode = 'alongside';
            vi.mocked(getEnabledLibraryPaths).mockResolvedValue([
                libraryPathRow('1', '/mnt/movies'),
            ]);
            writableExcept({ [CENTRAL_METADATA]: Object.assign(new Error(code), { code }) });

            const result = await checkMetadataStorageWritability(fakeSql);

            expect(result.centralWritable).toBe('readonly');
            expect(result.centralDir).toBe(CENTRAL_METADATA);
            // The library root itself is fine — the two are independent.
            expect(result.readOnlyRoots).toEqual([]);
        },
    );

    // The central metadata dir does not exist until the first real write, so the
    // probe mkdir -p's it exactly as `resolveWritePath` does. A DENIED mkdir is the
    // failure being hunted — it must read 'readonly', not 'unknown'.
    it.each(['EROFS', 'EACCES', 'EPERM'])(
        'classifies a %s mkdir failure on the central dir as read-only',
        async (code) => {
            mockMode = 'central';
            vi.mocked(safeMkdir).mockRejectedValue(Object.assign(new Error(code), { code }));

            const result = await checkMetadataStorageWritability(fakeSql);

            expect(result.centralWritable).toBe('readonly');
            // The write is skipped — it could only fail with ENOENT and downgrade a
            // real 'readonly' verdict to 'unknown'.
            expect(safeWriteFile).not.toHaveBeenCalled();
        },
    );

    it('creates the central metadata dir before probing it', async () => {
        mockMode = 'central';

        await checkMetadataStorageWritability(fakeSql);

        expect(safeMkdir).toHaveBeenCalledWith(CENTRAL_METADATA, { recursive: true }, 3000);
    });

    it('never creates a missing LIBRARY root (that would mask a misconfiguration)', async () => {
        mockMode = 'alongside';
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([libraryPathRow('1', '/mnt/movies')]);

        await checkMetadataStorageWritability(fakeSql);

        expect(vi.mocked(safeMkdir).mock.calls.map((c) => c[0])).toEqual([CENTRAL_METADATA]);
    });

    it('classifies a hung central mkdir as unknown, never read-only', async () => {
        mockMode = 'central';
        vi.mocked(safeMkdir).mockRejectedValue(new FsTimeoutError('mkdir', CENTRAL_METADATA, 3000));

        const result = await checkMetadataStorageWritability(fakeSql);

        expect(result.centralWritable).toBe('unknown');
    });

    it('classifies a hung central root as unknown, never read-only', async () => {
        mockMode = 'central';
        writableExcept({
            [CENTRAL_METADATA]: new FsTimeoutError('writeFile', CENTRAL_METADATA, 3000),
        });

        const result = await checkMetadataStorageWritability(fakeSql);

        expect(result.centralWritable).toBe('unknown');
    });

    it('classifies a probe timeout as unknown, never read-only', async () => {
        mockMode = 'alongside';
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([libraryPathRow('1', '/mnt/movies')]);
        writableExcept({ '/mnt/movies': new FsTimeoutError('writeFile', '/mnt/movies', 3000) });

        const result = await checkMetadataStorageWritability(fakeSql);

        expect(result.readOnlyRoots).toEqual([]);
        expect(result.unknownRoots).toEqual(['/mnt/movies']);
    });

    it('classifies an unrelated error (e.g. ENOENT — missing root) as unknown', async () => {
        mockMode = 'alongside';
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([libraryPathRow('1', '/mnt/missing')]);
        writableExcept({
            '/mnt/missing': Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        });

        const result = await checkMetadataStorageWritability(fakeSql);

        expect(result.readOnlyRoots).toEqual([]);
        expect(result.unknownRoots).toEqual(['/mnt/missing']);
    });

    it('dedupes multiple library_paths rows sharing the same root', async () => {
        mockMode = 'alongside';
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([
            libraryPathRow('1', '/mnt/movies'),
            libraryPathRow('2', '/mnt/movies'),
        ]);

        await checkMetadataStorageWritability(fakeSql);

        // Central + one deduped library root.
        expect(safeWriteFile).toHaveBeenCalledTimes(2);
    });

    it('caches a probe result across calls instead of re-probing', async () => {
        mockMode = 'alongside';
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([libraryPathRow('1', '/mnt/movies')]);

        await checkMetadataStorageWritability(fakeSql);
        await checkMetadataStorageWritability(fakeSql);

        // Central + the library root, each probed once across two calls.
        expect(safeWriteFile).toHaveBeenCalledTimes(2);
        expect(getEnabledLibraryPaths).toHaveBeenCalledTimes(2);
    });

    it('reuses the same fixed probe filename per root across calls (self-heals a stuck orphan instead of accumulating one per cycle)', async () => {
        mockMode = 'alongside';
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([libraryPathRow('1', '/mnt/movies')]);

        await checkMetadataStorageWritability(fakeSql);
        __resetWritabilityProbeCacheForTests(); // force a second, uncached probe of the same root
        await checkMetadataStorageWritability(fakeSql);

        // Calls are [central, /mnt/movies] then [central, /mnt/movies] again;
        // compare the same position across the two rounds.
        const paths = vi.mocked(safeWriteFile).mock.calls.map((c) => c[0]);
        expect(paths).toEqual([
            probeOf(CENTRAL_METADATA),
            probeOf('/mnt/movies'),
            probeOf(CENTRAL_METADATA),
            probeOf('/mnt/movies'),
        ]);
    });

    it('stops probing once the aggregate loop budget is exceeded, marking the rest unknown (never readonly)', async () => {
        mockMode = 'alongside';
        vi.useFakeTimers();
        try {
            vi.mocked(getEnabledLibraryPaths).mockResolvedValue([
                libraryPathRow('1', '/mnt/a'),
                libraryPathRow('2', '/mnt/b'),
            ]);
            vi.mocked(safeWriteFile).mockImplementation(async () => {
                // Simulate the first (uncached) probe alone burning past the
                // loop's aggregate budget — the second root must never be probed.
                vi.advanceTimersByTime(31_000);
            });

            const result = await checkMetadataStorageWritability(fakeSql);

            // Central, then /mnt/a burns the loop budget, so /mnt/b is skipped.
            // The central probe runs BEFORE the loop clock starts — it is a single
            // bounded probe, so it is deliberately not charged to the loop budget.
            expect(vi.mocked(safeWriteFile).mock.calls.map((c) => c[0])).toEqual([
                probeOf(CENTRAL_METADATA),
                probeOf('/mnt/a'),
            ]);
            expect(result.readOnlyRoots).toEqual([]);
            expect(result.unknownRoots).toEqual(['/mnt/b']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reserves headroom for an in-flight probe’s own worst case, stopping before the raw budget is hit', async () => {
        mockMode = 'alongside';
        vi.useFakeTimers();
        try {
            vi.mocked(getEnabledLibraryPaths).mockResolvedValue([
                libraryPathRow('1', '/mnt/a'),
                libraryPathRow('2', '/mnt/b'),
            ]);
            vi.mocked(safeWriteFile).mockImplementation(async () => {
                // 25s: comfortably under the raw 30s budget, but past the
                // budget minus the 6s (2 * PROBE_TIMEOUT_MS) reserved headroom
                // for the next probe's own worst case — the second root must
                // still be skipped rather than started and risk overrunning.
                vi.advanceTimersByTime(25_000);
            });

            const result = await checkMetadataStorageWritability(fakeSql);

            expect(vi.mocked(safeWriteFile).mock.calls.map((c) => c[0])).toEqual([
                probeOf(CENTRAL_METADATA),
                probeOf('/mnt/a'),
            ]);
            expect(result.unknownRoots).toEqual(['/mnt/b']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rotates which root is probed first across consecutive calls (fairness against a chronically slow root)', async () => {
        mockMode = 'alongside';
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([
            libraryPathRow('1', '/mnt/a'),
            libraryPathRow('2', '/mnt/b'),
            libraryPathRow('3', '/mnt/c'),
        ]);

        const firstRootProbedPerCall: unknown[] = [];
        for (let call = 0; call < 4; call++) {
            __resetWritabilityProbeCacheForTests(); // force a fresh probe of every root each call
            vi.mocked(safeWriteFile).mockClear();
            await checkMetadataStorageWritability(fakeSql);
            // Index 1, not 0: the central root always takes call 0.
            firstRootProbedPerCall.push(vi.mocked(safeWriteFile).mock.calls[1]?.[0]);
        }

        // 3 roots rotate through 3 starting positions, then wrap back to the first.
        expect(firstRootProbedPerCall).toEqual([
            probeOf('/mnt/a'),
            probeOf('/mnt/b'),
            probeOf('/mnt/c'),
            probeOf('/mnt/a'),
        ]);
    });
});
