// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Re-scan libraries with provider-less items once a metadata provider key is saved.
 *
 * A library scanned before the TMDB key existed holds movies and episodes the
 * scanner flagged `awaiting_provider_match`. The scanner re-matches those files
 * on its next pass over the library and identifies the items in place
 * (video-processor's rematch path), but nothing ran that pass when the key was
 * saved from Admin -> Settings: the items stayed file-name items until the next
 * manual scan. This starts that scan for exactly the libraries that need it.
 *
 * Only the process that saved the key sees the changed key names (the reload
 * the other replicas get carries none), and the idempotency key collapses a
 * second save while the scan is still queued or running.
 */

import type postgres from 'postgres';
import { getDb } from '$lib/server/database/connection.js';
import { findLibraryPathIdsWithAwaitingMatch } from '$lib/server/database/queries/media-files.queries.js';
import { onConfigChange } from '$lib/server/config/config.service.js';
import { isProviderConfigured } from '$lib/server/tasks/plugin-context.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('ProviderKeyRematch');

/** Settings whose save can make a metadata provider usable, and that provider's id. */
const PROVIDER_KEYS: Readonly<Record<string, string>> = {
    TMDB_API_KEY: 'tmdb-metadata-provider',
};

type StartRun = (
    taskId: string,
    input: Record<string, unknown>,
    opts: { trigger: { kind: 'manual'; sourceRoute: string }; idempotencyKey: string },
) => Promise<unknown>;

/**
 * Start a file-library-scan for every library holding awaiting items. Returns
 * the library path ids a scan was requested for.
 */
export async function rescanLibrariesAwaitingMatch(
    sql: postgres.Sql,
    startRun: StartRun,
): Promise<string[]> {
    const libraryPathIds = await findLibraryPathIdsWithAwaitingMatch(sql);
    for (const libraryPathId of libraryPathIds) {
        try {
            await startRun(
                'file-library-scan',
                { libraryPathId, mode: 'manual' },
                {
                    trigger: { kind: 'manual', sourceRoute: 'settings.provider-key' },
                    idempotencyKey: `provider-key-rematch:${libraryPathId}`,
                },
            );
        } catch (err) {
            // The scan's own schedule still reaches the library.
            logger.warn('Could not start a re-match scan', {
                libraryPathId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return libraryPathIds;
}

/** Called with the changed setting names after a local config save. */
export async function handleProviderKeyChange(
    changedKeys: readonly string[],
    deps: { sql: postgres.Sql | null; startRun: StartRun },
): Promise<string[]> {
    const providerIds = changedKeys.flatMap((key) => PROVIDER_KEYS[key] ?? []);
    if (providerIds.length === 0 || !deps.sql) return [];
    let usable = false;
    for (const providerId of providerIds) {
        // A provider not registered in this process throws: not usable here.
        if (await isProviderConfigured(providerId).catch(() => false)) usable = true;
    }
    if (!usable) return [];
    const started = await rescanLibrariesAwaitingMatch(deps.sql, deps.startRun);
    if (started.length > 0) {
        logger.info('Metadata provider key saved; re-matching provider-less items', {
            libraryPaths: started.length,
        });
    }
    return started;
}

let installed = false;

/** Register the config-change listener (web process, once). */
export function installProviderKeyRematchTrigger(): void {
    if (installed) return;
    installed = true;
    onConfigChange((changedKeys) => {
        if (!changedKeys) return;
        if (!changedKeys.some((key) => key in PROVIDER_KEYS)) return;
        void (async () => {
            const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
            await handleProviderKeyChange(changedKeys, {
                sql: getDb(),
                startRun: (taskId, input, opts) => orchestrator.startRun(taskId, input, opts),
            });
        })().catch((err: unknown) => {
            logger.warn('Provider key re-match trigger failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        });
    });
}
