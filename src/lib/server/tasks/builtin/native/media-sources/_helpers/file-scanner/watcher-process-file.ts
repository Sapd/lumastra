// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The watcher's per-file step: find the library path a changed file belongs to,
 * ingest it, and refresh the recently-added recency of its title.
 *
 * A factory with injected dependencies (not a closure in file-scanner.ts) so the
 * wiring, in particular "refresh runs after a fresh ingest and gets the library's
 * media type", can be unit tested without the whole scanner module.
 */

import type postgres from 'postgres';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';
import type { ProcessFileFn } from './watcher.js';
import { refreshRecencyAfterWatcherIngest, type WatcherIngestOutcome } from './watcher-recency.js';

type WatcherContext = Parameters<ProcessFileFn>[2];

export interface WatcherProcessFileDeps {
    getEnabledLibraryPaths: (sql: postgres.Sql) => Promise<LibraryPathRow[]>;
    ingestSingleFile: (
        sql: postgres.Sql,
        absPath: string,
        libraryPath: LibraryPathRow,
        context: WatcherContext,
    ) => Promise<WatcherIngestOutcome>;
}

export function createProcessFileForWatcher(deps: WatcherProcessFileDeps): ProcessFileFn {
    return async (sql, filePath, context): Promise<void> => {
        const paths = await deps.getEnabledLibraryPaths(sql);
        // Longest prefix wins, so a library nested inside another one is attributed
        // to the inner library's media type whatever the list order.
        const libraryPath = paths
            .filter((p) => filePath.startsWith(p.path.endsWith('/') ? p.path : p.path + '/'))
            .sort((a, b) => b.path.length - a.path.length)[0];
        if (!libraryPath) {
            context.logger.warn('File watcher: file is not under any enabled library path', {
                filePath,
            });
            return;
        }

        const result = await deps.ingestSingleFile(sql, filePath, libraryPath, context);
        refreshRecencyAfterWatcherIngest(
            sql,
            libraryPath.media_type,
            result,
            filePath,
            context.logger,
        );
    };
}
