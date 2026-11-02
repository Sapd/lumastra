// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library Storage Snapshot — one row per library/media type with its bytes and
 * file count, and the free/total space of each library filesystem, per day.
 *
 * Feeds the growth sparkline on the admin home and the disk-full estimate
 * (`library-storage-growth.service.ts`). It runs as a task because the worker
 * is the process with the media mounts; the web container may not see them.
 *
 * Runs on startup too, so a new install starts collecting at once. A second
 * run on the same day replaces that day's rows. A filesystem that cannot be
 * measured (hung or missing mount) just has no row that day: the estimate then
 * has fewer points, it never reads "unknown" as "full".
 */

import { z } from 'zod';
import type postgres from 'postgres';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import {
    pruneLibraryStorageSnapshots,
    writeLibrarySizeSnapshot,
    writeLibraryVolumeSnapshots,
} from '$lib/server/database/queries/library-storage-history.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { measureLibraryVolumes } from '$lib/server/services/library-storage/volume-probe.js';

/** Two years: the sparkline's longest range. */
export const LIBRARY_STORAGE_SNAPSHOT_KEEP_DAYS = 730;

const inputSchema = z.object({}).passthrough();

interface SnapshotResult {
    sizeRows: number;
    volumeRows: number;
    filesystems: number;
    unreadablePaths: number;
    pruned: number;
}

export const libraryStorageSnapshotTask = defineTask<z.infer<typeof inputSchema>, SnapshotResult>({
    id: 'library-storage-snapshot',
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Library Storage Snapshot',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },

    schedule: { every: '24h', runOnStartup: true },

    identityFor: () => 'global',
    scope: 'global',
    resourceClass: 'maintenance',
    inputSchema,
    // One aggregate over media_files plus a statfs per filesystem; the fs calls
    // time out on their own, so minutes is already generous.
    timeout: { hard: '10m', soft: '9m' },

    async execute(ctx) {
        const sql = ctx.sql as postgres.Sql;

        const paths = await getEnabledLibraryPaths(sql);
        const measured = await measureLibraryVolumes(
            paths.filter((p) => !!p.path).map((p) => ({ id: p.id, path: p.path })),
        );
        if (measured.unreadable.length > 0) {
            ctx.logger.warn('library paths could not be measured; no free-space row today', {
                count: measured.unreadable.length,
                paths: measured.unreadable.slice(0, 5),
            });
        }

        let sizeRows = 0;
        let volumeRows = 0;
        await withTx(sql, async (tx) => {
            sizeRows = await writeLibrarySizeSnapshot(tx);
            volumeRows = await writeLibraryVolumeSnapshots(tx, measured.rows);
        });
        const pruned = await pruneLibraryStorageSnapshots(sql, LIBRARY_STORAGE_SNAPSHOT_KEEP_DAYS);

        return {
            success: true,
            itemsProcessed: sizeRows + volumeRows,
            result: {
                sizeRows,
                volumeRows,
                filesystems: measured.filesystems,
                unreadablePaths: measured.unreadable.length,
                pruned,
            },
        };
    },
});

registry.registerTask(libraryStorageSnapshotTask);
