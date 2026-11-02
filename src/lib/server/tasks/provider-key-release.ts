// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "The operator just saved the missing API key" — release the rows a task's
 * global guard parked for that reason and start the tasks that use the key,
 * instead of leaving everything until the guard's retry window (6h/12h) and
 * the next schedule tick come round.
 *
 * Two triggers: a host setting (`MDBLIST_API_KEY`) is watched through the
 * config-change listener in every worker process (see
 * {@link watchHostProviderKey}); a plugin secret (`LASTFM_API_KEY`) through the
 * task's `onConfigChange` hook, which the settings routes call after the save.
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { onConfigChange } from '$lib/server/config/index.js';
import { releaseSkippedTransientForReason } from '$lib/server/database/queries/stage-state.queries.js';

const log = Logger.for('ProviderKeyRelease');

export interface ProviderKeyRelease {
    /** Stage whose global guard parked rows for a missing key. */
    stageId: string;
    /** The guard's `reason`, as written to `skipped_reason`. */
    skippedReason: string;
    /** Tasks to start now; a run already in flight absorbs the trigger. */
    kickTaskIds: readonly string[];
    /**
     * 'always' for a hook that only fires on an actual key save; 'released'
     * for one that fires on ANY settings save of the task, so re-saving an
     * unrelated field does not start a run each time.
     */
    kickWhen: 'always' | 'released';
    sourceRoute: string;
}

/** MDBList key saved: mdblist-sync's parked rows, plus the curated lists. */
export const MDBLIST_KEY_RELEASE: ProviderKeyRelease = {
    stageId: 'mdblist-sync',
    skippedReason: 'no-mdblist-api-key-configured',
    kickTaskIds: ['mdblist-sync', 'curated-lists-sync'],
    kickWhen: 'always',
    sourceRoute: 'config.MDBLIST_API_KEY',
};

/** Last.fm key saved: music-popularity's parked artist rows. */
export const LASTFM_KEY_RELEASE: ProviderKeyRelease = {
    stageId: 'music-popularity',
    skippedReason: 'no-popularity-provider-configured',
    kickTaskIds: ['music-popularity'],
    kickWhen: 'released',
    sourceRoute: 'task.music-popularity.onConfigChange',
};

export const DISCOGS_KEY_RELEASE: ProviderKeyRelease = {
    stageId: 'artist-enrichment',
    skippedReason: 'no-usable-enrichment-source',
    kickTaskIds: ['artist-enrichment'],
    kickWhen: 'released',
    sourceRoute: 'task.artist-enrichment.onConfigChange',
};

export const DISCOGS_ALBUM_KEY_RELEASE: ProviderKeyRelease = {
    ...DISCOGS_KEY_RELEASE,
    stageId: 'album-enrichment',
    kickTaskIds: ['album-enrichment'],
    sourceRoute: 'task.album-enrichment.onConfigChange',
};

/**
 * Release the parked rows, then start each task. Never throws: the key is
 * saved either way, and the guard's own retry window is the fallback.
 */
export async function releaseAfterProviderKeySaved(
    sql: postgres.Sql,
    release: ProviderKeyRelease,
): Promise<{ released: number; started: string[] }> {
    let released = 0;
    try {
        released = await releaseSkippedTransientForReason(sql, {
            stageId: release.stageId,
            skippedReason: release.skippedReason,
        });
    } catch (err) {
        log.warn('could not release parked stage rows after key save', {
            stageId: release.stageId,
            err: err instanceof Error ? err.message : String(err),
        });
    }

    const started: string[] = [];
    if (release.kickWhen === 'released' && released === 0) return { released, started };
    for (const taskId of release.kickTaskIds) {
        try {
            const { orchestrator } = await import('./orchestrator.js');
            const result = await orchestrator.startRun(
                taskId,
                {},
                { trigger: { kind: 'in-process', sourceRoute: release.sourceRoute } },
            );
            // A run already in flight absorbed the trigger. It picks up the
            // released rows only if it has not chosen its candidates yet; the
            // stage sweep enqueues the rest, since they are eligible now.
            if (result?.deduped) {
                log.info('task already running; trigger absorbed', {
                    taskId,
                    existingRunId: result.existingRunId,
                });
                continue;
            }
            started.push(taskId);
        } catch (err) {
            log.warn('could not start task after key save', {
                taskId,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
    log.info('provider key saved: released parked rows and started tasks', {
        stageId: release.stageId,
        released,
        started,
    });
    return { released, started };
}

/**
 * Watch a host setting that a stage's global guard checks, and release that
 * stage when the key goes from unset to set.
 *
 * Runs from the config-change listener, so it fires in each process AFTER that
 * process holds the new value: right after a local save, or after the reload
 * the save broadcasts to the other replicas. Only worker processes act — they
 * run the sweep and the task, which read the key from their own memory, so
 * acting there cannot start a run that still sees the old (empty) key. A web
 * replica (WORKER_MODE=disabled) only reloads. With several workers each one
 * releases (idempotent) and starts the tasks (deduplicated by the orchestrator).
 */
export function watchHostProviderKey(readKey: () => string, release: ProviderKeyRelease): void {
    // Guarded: a test that mocks the config module partially has no listener API.
    if (typeof onConfigChange !== 'function') return;
    let wasSet = readKey().trim().length > 0;
    onConfigChange(() => {
        const isSet = readKey().trim().length > 0;
        const becameSet = isSet && !wasSet;
        wasSet = isSet;
        if (!becameSet || config.WORKER_MODE === 'disabled') return;
        void import('$lib/server/database/connection.js')
            .then(async ({ getTaskDb }) => {
                const db = getTaskDb();
                if (db) await releaseAfterProviderKeySaved(db, release);
            })
            .catch((err: unknown) => {
                log.warn('could not release stage after key was configured', {
                    stageId: release.stageId,
                    err: err instanceof Error ? err.message : String(err),
                });
            });
    });
}
