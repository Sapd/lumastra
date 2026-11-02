// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Protects atomic daily snapshots, mount failure reporting, retention, and task registration. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type postgres from 'postgres';
import { mockContext, mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';
import type { VolumeSnapshotInsert } from '$lib/server/database/queries/library-storage-history.queries.js';

const transaction = vi.hoisted(() => ({ active: false }));

vi.mock('$lib/server/database/queries/library-storage-history.queries.js', () => ({
    writeLibrarySizeSnapshot: vi.fn(),
    writeLibraryVolumeSnapshots: vi.fn(),
    pruneLibraryStorageSnapshots: vi.fn(),
}));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: vi.fn(),
}));
vi.mock('$lib/server/services/library-storage/volume-probe.js', () => ({
    measureLibraryVolumes: vi.fn(),
}));
vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: vi.fn(
        async (
            sql: postgres.Sql,
            callback: (tx: postgres.Sql) => Promise<unknown>,
        ): Promise<unknown> => {
            transaction.active = true;
            try {
                return await callback(sql);
            } finally {
                transaction.active = false;
            }
        },
    ),
}));
vi.mock('../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));

import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import {
    pruneLibraryStorageSnapshots,
    writeLibrarySizeSnapshot,
    writeLibraryVolumeSnapshots,
} from '$lib/server/database/queries/library-storage-history.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { measureLibraryVolumes } from '$lib/server/services/library-storage/volume-probe.js';
import { registry } from '../../registry.js';
import {
    libraryStorageSnapshotTask,
    LIBRARY_STORAGE_SNAPSHOT_KEEP_DAYS,
} from './library-storage-snapshot.js';

// Import-time registrations precede Vitest's automatic mock-history clearing.
const registeredAtImport = vi.mocked(registry.registerTask).mock.calls.map(([task]) => task.id);

function libraryPath(id: string, path: string): LibraryPathRow {
    return {
        id,
        path,
        media_type: 'movie',
        language: 'en',
        provider: 'tmdb',
        enabled: true,
        provider_path: null,
        library_group_id: 'movies',
        edition_label: null,
        scan_chapters: false,
        fallback_providers: [],
        source_prefix: null,
        created_at: new Date('2026-10-21T00:00:00Z'),
        updated_at: new Date('2026-10-21T00:00:00Z'),
    };
}

const volumeRows: VolumeSnapshotInsert[] = [
    {
        libraryPathId: 'movies',
        deviceId: '7',
        freeBytes: 100 * 1024 ** 3,
        totalBytes: 1024 ** 4,
    },
];

describe('library-storage-snapshot task', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        transaction.active = false;
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([
            libraryPath('movies', '/media/movies'),
        ]);
        vi.mocked(measureLibraryVolumes).mockResolvedValue({
            rows: volumeRows,
            unreadable: [],
            filesystems: 1,
        });
        vi.mocked(writeLibrarySizeSnapshot).mockReset().mockResolvedValue(3);
        vi.mocked(writeLibraryVolumeSnapshots).mockReset().mockResolvedValue(1);
        vi.mocked(pruneLibraryStorageSnapshots).mockResolvedValue(5);
    });

    it('excludes paths with no filesystem path from the probe', async () => {
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([
            libraryPath('movies', '/media/movies'),
            libraryPath('remote', ''),
        ]);
        const ctx = mockContext({ input: {}, runId: 'snapshot-test' });

        await libraryStorageSnapshotTask.execute(ctx);

        expect(getEnabledLibraryPaths).toHaveBeenCalledExactlyOnceWith(ctx.sql);
        expect(measureLibraryVolumes).toHaveBeenCalledExactlyOnceWith([
            { id: 'movies', path: '/media/movies' },
        ]);
    });

    it('runs both writers during the transaction callback and prunes with two-year retention', async () => {
        const ctx = mockContext({ input: {}, runId: 'snapshot-test' });
        const callsInsideTransaction: boolean[] = [];
        vi.mocked(writeLibrarySizeSnapshot).mockImplementation(async (sql): Promise<number> => {
            callsInsideTransaction.push(transaction.active);
            expect(sql).toBe(ctx.sql);
            return 3;
        });
        vi.mocked(writeLibraryVolumeSnapshots).mockImplementation(
            async (sql, rows): Promise<number> => {
                callsInsideTransaction.push(transaction.active);
                expect(sql).toBe(ctx.sql);
                expect(rows).toBe(volumeRows);
                return 1;
            },
        );

        const result = await libraryStorageSnapshotTask.execute(ctx);

        expect(withTx).toHaveBeenCalledTimes(1);
        expect(callsInsideTransaction).toEqual([true, true]);
        expect(writeLibrarySizeSnapshot).toHaveBeenCalledTimes(1);
        expect(writeLibraryVolumeSnapshots).toHaveBeenCalledTimes(1);
        expect(transaction.active).toBe(false);
        expect(LIBRARY_STORAGE_SNAPSHOT_KEEP_DAYS).toBe(730);
        expect(pruneLibraryStorageSnapshots).toHaveBeenCalledExactlyOnceWith(ctx.sql, 730);
        expect(result).toEqual({
            success: true,
            itemsProcessed: 4,
            result: { sizeRows: 3, volumeRows: 1, filesystems: 1, unreadablePaths: 0, pruned: 5 },
        });
    });

    it('warns about unreadable mounts while succeeding with the measured counts', async () => {
        const logger = mockLogger();
        const ctx = mockContext({ input: {}, logger, runId: 'snapshot-test' });
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([
            libraryPath('movies', '/media/movies'),
            libraryPath('offline', '/media/offline'),
            libraryPath('empty', '/media/empty'),
        ]);
        vi.mocked(measureLibraryVolumes).mockResolvedValue({
            rows: volumeRows,
            unreadable: ['/media/offline', '/media/empty'],
            filesystems: 1,
        });

        const result = await libraryStorageSnapshotTask.execute(ctx);

        expect(logger.entries).toContainEqual({
            level: 'warn',
            msg: 'library paths could not be measured; no free-space row today',
            meta: { count: 2, paths: ['/media/offline', '/media/empty'] },
        });
        expect(writeLibraryVolumeSnapshots).toHaveBeenCalledExactlyOnceWith(ctx.sql, volumeRows);
        expect(result).toEqual({
            success: true,
            itemsProcessed: 4,
            result: { sizeRows: 3, volumeRows: 1, filesystems: 1, unreadablePaths: 2, pruned: 5 },
        });
    });

    it('registers on import and has a builtin autoloader entry', () => {
        expect(registeredAtImport).toEqual(['library-storage-snapshot']);
        const indexSource = readFileSync(
            resolve(process.cwd(), 'src/lib/server/tasks/builtin/index.ts'),
            'utf8',
        );
        expect(indexSource).toContain(
            "['library-storage-snapshot', () => import('./native/library-storage-snapshot.js')]",
        );
    });
});
