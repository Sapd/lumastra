// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audiobookshelf media source.
 *
 * `scan()` is a full reconcile sweep, not an incremental cursor walk: ABS
 * exposes no `changed-since` parameter and no `updatedAt` sort, so the only way
 * to learn about additions, edits, file replacements and deletions is to page
 * every library and diff the id set against `media_items`.
 *
 * The diff itself lives in `_helpers/audiobookshelf/sweep-diff.ts` (pure) and the
 * orchestration in `_helpers/audiobookshelf/sweep.ts`. This file is the plugin
 * shell: settings, configuration gates, and wiring the live client, the database
 * port and the operator-configured deletion threshold together.
 */

import { defineMediaSource, type PluginContext, type ScanResult } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { config } from '$lib/server/config.js';
import { AudiobookshelfClient } from '$lib/server/audiobookshelf.js';
import {
    countAudiobooks,
    AUDIOBOOKSHELF_PROVIDER,
} from '$lib/server/database/queries/audiobooks.queries.js';
import { getEnabledLibraryPathsByProvider } from '$lib/server/database/queries/library-paths.queries.js';
import {
    runAudiobookshelfSweep,
    resolveDismissalRatio,
    DISMISS_MAX_PERCENT_KEY,
    type AudiobookLibrarySweepResult,
} from './_helpers/audiobookshelf/sweep.js';
import { createAudiobookSweepStore } from './_helpers/audiobookshelf/sweep-store.js';
import {
    isAudiobookSweepRunning,
    withAudiobookSweepLock,
    SWEEP_ALL_KEY,
} from './_helpers/audiobookshelf/sweep-lock.js';

const isConfigured = (): boolean => !!config.AUDIOURL && !!config.AUDIOAPIKEY;

/**
 * What this source's `scan()` actually returns: the SDK `ScanResult` plus the
 * per-library split keyed by `library_paths.id`. A run that swept nothing
 * carries an empty map.
 */
export type AudiobookshelfScanResult = ScanResult & {
    libraries: Record<string, AudiobookLibrarySweepResult>;
};

/**
 * Narrow a `scan()` result (typed as the SDK's `ScanResult`) to the per-library
 * shape this source returns.
 */
export function hasSweepLibraries(result: ScanResult): result is AudiobookshelfScanResult {
    return (
        'libraries' in result &&
        typeof result.libraries === 'object' &&
        result.libraries !== null &&
        !Array.isArray(result.libraries)
    );
}

/** Plugin id every AudiobookShelf ingest setting is stored under. */
export const AUDIOBOOKSHELF_SOURCE_ID = 'audiobookshelf-media-source';

/** `plugin_settings` key for the reconcile cadence, in minutes. */
export const SYNC_INTERVAL_MINUTES_KEY = 'SYNC_INTERVAL_MINUTES';

/**
 * Default reconcile cadence. Matches `sourceConfig.defaultScanIntervalHours`
 * (0.25h) — which nothing reads, because a media source is not a task and the
 * host has no generic media-source scheduler. `audiobookshelf-sync` is what
 * actually fires the sweep, and it reads THIS value.
 */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;

/**
 * Bounds on the operator-set cadence.
 *
 * The floor is not cosmetic: the sweep pages every library on every run (ABS has
 * no changed-since cursor), so a 1-minute cadence on a large library means a
 * permanently-running full reconcile. The ceiling keeps "a book added upstream
 * appears in Lumastra" from becoming a multi-day wait by typo.
 */
export const MIN_SYNC_INTERVAL_MINUTES = 5;
export const MAX_SYNC_INTERVAL_MINUTES = 1440;

/**
 * Resolve the reconcile cadence from stored settings.
 *
 * Clamps rather than rejects, and falls back on anything unparseable: this feeds
 * a scheduler loader, where throwing would silently stop all syncing and a `NaN`
 * interval would make the time bucket `NaN` and dedup every run away forever.
 *
 * Admin array/number settings arrive as STRINGS from the generic settings form,
 * so a `typeof === 'number'` check alone reads every operator-set value as
 * absent and silently pins the default.
 */
export function resolveSyncIntervalMinutes(settings: Record<string, unknown>): number {
    const raw = settings[SYNC_INTERVAL_MINUTES_KEY];
    const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
    if (!Number.isFinite(parsed)) return DEFAULT_SYNC_INTERVAL_MINUTES;
    return Math.min(MAX_SYNC_INTERVAL_MINUTES, Math.max(MIN_SYNC_INTERVAL_MINUTES, parsed));
}

export const audiobookshelfMediaSource = defineMediaSource({
    id: 'audiobookshelf-media-source',
    name: 'Audiobookshelf',
    version: '2.0.0',
    description: 'Audiobook and radioplay library from Audiobookshelf',
    capabilities: { http: true, database: true },
    sourceConfig: {
        // ABS has no changed-since cursor, so every run is a full reconcile.
        supportsIncrementalScan: false,
        // ~15 minutes. The sweep is cheap (a handful of listing requests per
        // library; only changed books pay for an expanded fetch) and the
        // latency it hides is "a book added in ABS is not in Lumastra yet".
        defaultScanIntervalHours: 0.25,
    },
    /**
     * INGEST settings only — deliberately NOT the connection.
     *
     * `AUDIOURL` and `AUDIOAPIKEY` used to be declared here too, and they were
     * write-only decoration: this block is persisted to `plugin_settings` /
     * `plugin_secrets`, while every reader of those two keys — `isConfigured()`
     * immediately below, the client singleton, the byte proxy, the image
     * provider, the health checks — reads `config.AUDIOURL` / `config.AUDIOAPIKEY`
     * from the CONFIG system (settings.json > env > default). Nothing ever read
     * the `plugin_settings` copies. An operator who typed their server URL into
     * this form got a successful save and an integration that stayed
     * unconfigured. Verified on a working install: zero `plugin_settings` rows
     * exist for this plugin id while 1188 books are ingested.
     *
     * The connection lives in the config schema under section `services` (with a
     * `healthCheckProvider: 'audiobookshelf'` hint that drives the reachability
     * badge) and is rendered by /admin/settings/audiobookshelf.
     */
    settings: {
        fields: [
            {
                key: SYNC_INTERVAL_MINUTES_KEY,
                type: 'number',
                label: 'Sync interval (minutes)',
                description: `How often to reconcile against AudiobookShelf. Every run pages the whole library (AudiobookShelf has no changed-since cursor), so short intervals cost real work on large libraries. Clamped to ${MIN_SYNC_INTERVAL_MINUTES}–${MAX_SYNC_INTERVAL_MINUTES} minutes.`,
                default: DEFAULT_SYNC_INTERVAL_MINUTES,
                validation: {
                    min: MIN_SYNC_INTERVAL_MINUTES,
                    max: MAX_SYNC_INTERVAL_MINUTES,
                },
            },
            {
                key: DISMISS_MAX_PERCENT_KEY,
                type: 'number',
                label: 'Max removals per sync (%)',
                description:
                    'Safety cap: if more than this share of a library disappears from Audiobookshelf in one sync, nothing is hidden and an error is raised instead. Protects against a misconfigured or partially-restored server hiding the whole catalog. At least 3 books stay removable per sync so small libraries are not permanently blocked — set the value to 0 to switch removal off entirely.',
                default: 10,
                validation: { min: 0, max: 100 },
            },
        ],
    },
    isConfigured,
    isAvailable: () => Promise.resolve(isConfigured()),

    async scan(ctx, opts) {
        const start = Date.now();
        const empty = {
            added: 0,
            updated: 0,
            removed: 0,
            unmatched: 0,
            skipped: 0,
            durationMs: 0,
            errors: [] as string[],
            libraries: {},
        };

        if (!isConfigured()) {
            ctx.logger.info('Audiobookshelf sweep: not configured, nothing to do');
            return { ...empty, durationMs: Date.now() - start };
        }

        // Single-flight. Two concurrent sweeps of one ABS library would both see
        // the same books as "absent locally" and insert them twice, and the
        // second `external_ids` write silently steals the mapping from the
        // first — orphaning a catalogue row no later sweep can ever reach. See
        // sweep-lock.ts. A skipped run is not an error: the in-flight full
        // reconcile already covers everything this one would have done.
        return withAudiobookSweepLock(
            opts.libraryPathId ?? SWEEP_ALL_KEY,
            () => runSweep(ctx, opts, start),
            () => {
                ctx.logger.info('Audiobookshelf sweep: already running, skipping this trigger', {
                    libraryPathId: opts.libraryPathId ?? null,
                });
                return { ...empty, durationMs: Date.now() - start };
            },
        );
    },

    async fullSync(ctx) {
        // Identical work: every scan already reconciles the complete id set, so
        // there is no cheaper incremental mode for "full" to differ from. Going
        // through `scan` also keeps it under the same single-flight guard.
        const result = await audiobookshelfMediaSource.scan(ctx, {});
        return {
            added: result.added,
            updated: result.updated,
            removed: result.removed,
            durationMs: result.durationMs,
            errors: result.errors,
        };
    },

    async getStatus(ctx) {
        if (!isConfigured()) {
            return { itemCount: 0, isScanning: false };
        }
        return { itemCount: await countAudiobooks(ctx.sql), isScanning: isAudiobookSweepRunning() };
    },
});

/**
 * The sweep proper, split out of `scan` so the single-flight guard wraps a
 * single expression and always releases through its `finally`.
 */
async function runSweep(
    ctx: PluginContext,
    opts: { libraryPathId?: string },
    start: number,
): Promise<AudiobookshelfScanResult> {
    const empty = {
        added: 0,
        updated: 0,
        removed: 0,
        unmatched: 0,
        skipped: 0,
        durationMs: 0,
        errors: [] as string[],
        libraries: {},
    };

    // Built per run from LIVE config rather than reusing the module-level
    // singleton in `$lib/server/audiobookshelf.ts`: that one snapshots
    // AUDIOURL/AUDIOAPIKEY at import time (so an operator changing them in
    // /admin/settings would never be observed) and latches `connectionFailed`
    // permanently after the first unreachable server.
    const client = new AudiobookshelfClient(config.AUDIOURL, config.AUDIOAPIKEY);

    let libraryPaths = await getEnabledLibraryPathsByProvider(ctx.sql, AUDIOBOOKSHELF_PROVIDER);
    if (opts.libraryPathId) {
        libraryPaths = libraryPaths.filter((row) => row.id === opts.libraryPathId);
    }
    if (libraryPaths.length === 0) {
        ctx.logger.info('Audiobookshelf sweep: no enabled audiobookshelf library paths', {
            libraryPathId: opts.libraryPathId ?? null,
        });
        return { ...empty, durationMs: Date.now() - start };
    }

    let settings: Record<string, unknown> = {};
    try {
        settings = await ctx.settings();
    } catch (err) {
        ctx.logger.warn('Audiobookshelf sweep: could not read settings, using defaults', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return runAudiobookshelfSweep({
        source: client,
        store: createAudiobookSweepStore(ctx.sql),
        logger: ctx.logger,
        libraryPaths,
        signal: ctx.signal,
        thresholds: { maxDismissalRatio: resolveDismissalRatio(settings) },
    });
}

registry.registerMediaSource(audiobookshelfMediaSource);
