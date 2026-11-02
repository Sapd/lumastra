// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AudiobookShelf ingest sync — the task that actually FIRES the reconcile sweep.
 *
 * ## Why this file exists
 *
 * `audiobookshelfMediaSource` declares `scan()`, `fullSync()`,
 * `getStatus()` and `sourceConfig.defaultScanIntervalHours`, and every one of
 * them was dead code: `registry.registerMediaSource` only records the definition
 * in a Map, and the host has NO generic media-source scheduler — the only
 * readers of that Map are `getMediaSource(id)` (settings resolution) and the
 * developer registry page's row count. Nothing anywhere called `scan()`.
 *
 * The practical consequence was that an AudiobookShelf library ingested only
 * when a developer ran `runAudiobookshelfSweep` from a throwaway integration
 * test. Adding a library through the admin UI without this task would create a
 * correct-looking `library_paths` row that never produced a single book — the
 * "0 items, 0 errors" failure this integration has already shipped twice.
 *
 * ## Cadence
 *
 * `dynamicSchedule`, not a static `schedule.every`, because the interval is an
 * operator setting rather than a manifest constant — exactly the case the SDK
 * documents `dynamicSchedule` for.
 *
 * **The loader does its own last-fired bookkeeping, and must.** The `rowId +
 * bucket` idempotency key does NOT collapse repeat fires within a window:
 * measured 12 fire attempts in 5m20s locally, all with the same key, and 9 runs
 * in ~10 minutes on production against a 15-minute interval. Relying on the
 * bucket alone re-pages the operator's whole AudiobookShelf library every ~30
 * seconds. The loader reads the last run's `started_at` and returns nothing until
 * the interval has elapsed — the same approach `livetv-tasks` takes with
 * `last_refresh_at`.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type { DynamicScheduleEntry } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { buildPluginContext } from '../../plugin-context.js';
import { getTaskSettings } from '$lib/server/database/queries/task-settings.queries.js';
import { getEnabledLibraryPathsByProvider } from '$lib/server/database/queries/library-paths.queries.js';
import { getLastAudiobookshelfSyncStartedAt } from '$lib/server/database/queries/audiobookshelf-admin.queries.js';
import { AUDIOBOOKSHELF_PROVIDER } from '$lib/server/database/queries/audiobooks.queries.js';
import {
    audiobookshelfMediaSource,
    AUDIOBOOKSHELF_SOURCE_ID,
    hasSweepLibraries,
    resolveSyncIntervalMinutes,
} from './media-sources/audiobookshelf.js';

const inputSchema = z.object({
    /**
     * Restrict the sweep to one `library_paths` row. Omitted = every library.
     *
     * Deliberately NOT `.uuid()`. Zod 4's UUID format check enforces the RFC
     * version nibble, so it rejects perfectly valid `library_paths.id` values
     * whose version bits are zero — which is every hand-seeded row (migrations
     * and fixtures use ids like `00000000-0000-0000-0000-0000000abe01`). The
     * value is an opaque primary key that is only ever compared in memory
     * against ids already read from the database (`row.id === libraryPathId`);
     * it never reaches SQL, so there is nothing for stricter parsing to protect.
     * A non-matching value simply resolves to zero targets.
     */
    libraryPathId: z.string().min(1).max(64).optional(),
});

export const audiobookshelfSyncTask = defineTask({
    id: 'audiobookshelf-sync',
    name: 'AudiobookShelf Sync',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '1.0.0',
    description:
        'Reconciles the AudiobookShelf catalogue into Lumastra: adds new books, updates changed ones, and hides books that disappeared upstream.',
    capabilities: { http: true, database: true },

    // A full reconcile of ~1200 books measures at ~2 minutes, and a large
    // library scales past that. `bulk` is the class for minute-to-hour jobs and
    // keeps this from head-of-line blocking the seconds-scale `io` tasks it
    // would otherwise share a pool with.
    resourceClass: 'bulk',
    scope: 'global',
    inputSchema,

    // One in-flight sweep per target. The media source ALSO holds a
    // single-flight lock of its own (two concurrent sweeps of one library both
    // see the same books as absent locally, insert twice, and the second
    // external_ids write orphans the first row) — this is the cheaper outer
    // guard that stops the queue filling with runs that would immediately
    // no-op.
    identityFor: (input) => input.libraryPathId ?? 'all',
    quotas: { maxConcurrent: 1 },

    timeout: { hard: '30m', soft: '25m' },

    dynamicSchedule: {
        // How often the loader is CONSULTED, not how often the sweep runs — the
        // loader's own due-ness check is what enforces the interval. Kept at 1m so
        // an operator shortening the interval takes effect within a minute
        // instead of waiting out the old one.
        sweepEvery: '1m',
        async loader(ctx): Promise<DynamicScheduleEntry<{ libraryPathId?: string }>[]> {
            // Nothing to sync until at least one library exists. Checked before
            // the interval read so an install that never configured
            // AudiobookShelf costs one cheap query per sweep and no runs.
            const paths = await getEnabledLibraryPathsByProvider(ctx.sql, AUDIOBOOKSHELF_PROVIDER);
            if (paths.length === 0) return [];

            // `isConfigured` is optional on the definition; the ABS source
            // implements it as a zero-arg credentials check. Treat an absent
            // implementation as configured (the sweep's own gate then applies)
            // rather than silently never scheduling.
            const configured =
                audiobookshelfMediaSource.isConfigured?.(
                    buildPluginContext(AUDIOBOOKSHELF_SOURCE_ID, { sql: ctx.sql }),
                ) ?? true;
            if (!configured) return [];

            const settings = await getTaskSettings(ctx.sql, AUDIOBOOKSHELF_SOURCE_ID);
            const intervalMs = resolveSyncIntervalMinutes(settings) * 60_000;

            // Due-ness is decided HERE, from run history — the `bucket` below is
            // not sufficient on its own.
            //
            // Measured, not assumed: the scheduler consults this loader roughly
            // twice a minute, and every attempt carrying the same
            // `dyn-sched:<task>:<row>:<bucket>` idempotency key still produced a
            // run (12 attempts in 5m20s locally; 9 runs in ~10 minutes on prod
            // against a 15-minute interval). Emitting an entry whenever a library
            // exists therefore re-pages the operator's ENTIRE AudiobookShelf
            // library every ~30 seconds. Same shape as the `livetv-tasks`
            // exemplar, which returns only sources whose `last_refresh_at` is
            // older than their interval.
            const lastStartedAt = await getLastAudiobookshelfSyncStartedAt(ctx.sql);
            if (lastStartedAt && ctx.now.getTime() - lastStartedAt.getTime() < intervalMs) {
                return [];
            }

            // A single global entry. Per-library entries would defeat the media
            // source's cross-library dismissal accounting, which reasons about one
            // library at a time but must not race itself.
            //
            // The bucket is still supplied: it costs nothing and it collapses the
            // genuine case it was meant for — two replicas sweeping in the same
            // instant, before either has written a `task_history` row for the
            // due-ness check above to see.
            return [
                {
                    rowId: 'all',
                    bucket: String(Math.floor(ctx.now.getTime() / intervalMs)),
                    input: {},
                },
            ];
        },
    },

    async execute(ctx) {
        const input = inputSchema.parse(ctx.input ?? {});

        // The media source's own plugin context, NOT `ctx`.
        //
        // `ctx.settings()` is bound to the RUNNING task's plugin id, so handing
        // `ctx` straight to `scan()` would look up `plugin_settings` under
        // 'audiobookshelf-sync' and find nothing — silently resetting the
        // operator's removal cap to its default on every run. The settings live
        // under the media source's id because that is where `settings.fields`
        // declares them and where the admin UI writes them.
        const sourceCtx = buildPluginContext(AUDIOBOOKSHELF_SOURCE_ID, { signal: ctx.signal });

        // Logger swapped so the sweep's output lands in THIS run's log buffer
        // (that is what /admin/runs streams); everything else must stay the
        // media source's, especially `settings`. Safe to spread-override
        // because `logger` is read directly by the sweep and is not closed over
        // by any of the context's sub-stores — unlike `sql`, which is.
        const result = await audiobookshelfMediaSource.scan(
            { ...sourceCtx, logger: ctx.logger },
            { libraryPathId: input.libraryPathId },
        );

        const itemsProcessed = result.added + result.updated + result.removed;

        /**
         * Total-failure guard.
         *
         * A bare `success: false` return never marks the run failed nor feeds the
         * circuit breaker — only a throw does. The sweep reports its safety rails
         * as ERROR STRINGS (a tripped dismissal cap, a library claimed by two
         * rows, a row with no `provider_path`), so without a throw a
         * permanently-broken sync would report "completed" forever.
         *
         * **`skipped` counts as progress, and leaving it out breaks healthy
         * installs.** `itemsProcessed` only sums added/updated/removed, and on a
         * settled library at a 15-minute cadence all three are zero on nearly
         * every run while `skipped` holds the ~1200 books verified in sync
         * (`sweep.ts` adds `unchanged + skippedInactive + alreadyDismissed`). So
         * "zero itemsProcessed plus one error" is the ORDINARY shape of a run
         * where a single expanded fetch flaked — precisely the partial progress
         * this guard must not fail.
         *
         * It also has to not fire when the dismissal rail trips, and not for
         * cosmetic reasons: the rail moves its candidates into `skipped` and adds
         * one error string. Throwing there means `writeTerminalToPostgres` stores
         * a null `result`, so the counters never reach the database and the admin
         * page's "Removal safety cap tripped" banner — which reads the error
         * strings out of those counters — cannot render in the one scenario it
         * exists for.
         *
         * Every case the guard is meant to catch still reaches zero on BOTH: an
         * unreachable server returns before a plan is built, a fresh library whose
         * every item fails expansion has no `unchanged` rows, and a set of rows
         * with no `provider_path` never gets past `resolveTargets`.
         */
        if (result.errors.length > 0 && itemsProcessed === 0 && result.skipped === 0) {
            throw new TaskError({
                message:
                    `AudiobookShelf sync: no progress across ${result.errors.length} error(s): ` +
                    `${result.errors.slice(0, 3).join('; ')}${result.errors.length > 3 ? '…' : ''}`,
                kind: 'transient',
            });
        }

        // `result`, not a `metadata` key — `TaskResult` has no such field, and an
        // excess property would be dropped, taking the sync-health counters the
        // admin section renders with it.
        return {
            success: true,
            itemsProcessed,
            result: {
                added: result.added,
                updated: result.updated,
                dismissed: result.removed,
                unmatched: result.unmatched,
                skipped: result.skipped,
                errors: result.errors,
                // Per `library_paths.id`: lets retention judge each ABS library
                // on its own slice instead of failing every library for one
                // library's error.
                ...(hasSweepLibraries(result) ? { libraries: result.libraries } : {}),
            },
        };
    },
});

registry.registerTask(audiobookshelfSyncTask);
