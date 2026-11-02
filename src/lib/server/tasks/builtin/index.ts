// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builtin task loader for the new task system.
 *
 * All builtin tasks are written directly against `defineTask` / `defineProvider`
 * / `defineWatchSync` / `defineFeature` / `defineIntegration` (native path).
 *
 * Module side-effects: NONE. Call `loadBuiltins()` from the orchestrator
 * boot path so the registry is populated before the runner subscribes to
 * queue events. Avoid importing this from anything that runs at module
 * eval time — it pulls in ~30 plugins.
 */

import type { TaskRegistry } from '../registry.js';
import { registry as defaultRegistry } from '../registry.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { WatchSyncDefinition, TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import { getAuthoritativeStageIds, validateAuthoritativeStageIds } from '$lib/server/config.js';

const log = Logger.for('TasksBuiltin');

// ──────────────────────────────────────────────────────────────────────────────
// Registration error capture — surfaces silently-failed builtin loads to the
// admin UI so an operator notices when a task disappears. Populated by
// loadBuiltins(); read via getBuiltinRegistrationErrors() from the API layer.
//
// Module-level state is fine here: loadBuiltins() runs once per replica at
// boot. A second call (test) clears prior errors via the export below.
// ──────────────────────────────────────────────────────────────────────────────

export interface BuiltinRegistrationError {
    name: string;
    message: string;
    /** Sub-category ('task' for execute-able tasks, 'provider' for metadata
     *  providers, etc.) — lets the UI group similar failures together. */
    kind:
        | 'task'
        | 'provider'
        | 'trickplay-provider'
        | 'media-source'
        | 'external-service'
        | 'feature'
        | 'integration'
        | 'watch-sync';
    timestamp: string;
}

const registrationErrors: BuiltinRegistrationError[] = [];

export function getBuiltinRegistrationErrors(): readonly BuiltinRegistrationError[] {
    return registrationErrors;
}

export function clearBuiltinRegistrationErrors(): void {
    registrationErrors.length = 0;
}

function recordBuiltinFailure(
    kind: BuiltinRegistrationError['kind'],
    name: string,
    err: unknown,
): void {
    registrationErrors.push({
        name,
        kind,
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// Native exemplars — registered eagerly via top-level side effects in their
// own files. Imports are kept lazy inside loadBuiltins() so the rest of the
// module remains side-effect free.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Adapter helper — register a plugin, catching dup-id errors so a single
 * misbehaving plugin doesn't poison the rest of the boot.
 */
function safeRegister(kind: string, id: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        log.warn(`builtin ${kind} "${id}" failed to register`, {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// loadBuiltins — single entry point invoked once during orchestrator boot.
// Single-flight: retain success OR failure, since registration is irreversible.
// ──────────────────────────────────────────────────────────────────────────────

let loading: Promise<void> | undefined;

export function loadBuiltins(_registry: TaskRegistry = defaultRegistry): Promise<void> {
    // A later producer retry must not turn a failed validation into success or
    // replay modules that already registered. Concurrent callers await the same boot.
    loading ??= initializeBuiltins();
    return loading;
}

async function initializeBuiltins(): Promise<void> {
    // Native exemplars first — they self-register via top-level
    // `registry.registerTask(defineTask({...}))` calls.
    //
    // Each import is wrapped in a try/catch so a duplicate-id collision or
    // other module-level error in one file cannot abort the loop and silently
    // drop every subsequent registration.
    //
    // IMPORTANT: each entry is a thunk with a STRING-LITERAL `import()` call.
    // Vite/Rollup can only statically bundle dynamic imports whose target is a
    // literal — a variable-target `await import(path)` produces "Cannot find
    // module" at runtime in the production build, silently dropping every
    // module via the per-iteration try/catch. Preserve the literal form.
    const coreModules: Array<[string, () => Promise<unknown>]> = [
        ['dummy-sync', () => import('./native/dummy-sync.js')],
        ['cache-cleanup', () => import('./native/cache-cleanup.js')],
        ['oauth-cleanup', () => import('./native/oauth-cleanup.js')],
        ['task-history-retention', () => import('./native/task-history-retention.js')],
        ['episode-thumbnail-backfill', () => import('./native/episode-thumbnail-backfill.js')],
        ['episode-thumbnail-generate', () => import('./native/episode-thumbnail-generate.js')],
        ['episode-thumbnail-extract', () => import('./native/episode-thumbnail-extract.js')],
        ['tmdb-metadata-sync', () => import('./native/tmdb-metadata-sync.js')],
        ['library-embeddings', () => import('./native/library-embeddings.js')],
        ['file-system-scan', () => import('./native/file-system-scan.js')],
        // Real production tasks. Loaded AFTER the tutorial exemplars so
        // any id collision surfaces against the exemplar's well-known names.
        ['discovery-embeddings', () => import('./native/discovery-embeddings.js')],
        ['library-embeddings-task', () => import('./native/library-embeddings-task.js')],
        ['mdblist-sync', () => import('./native/mdblist-sync.js')],
        ['tmdb-metadata-sync-task', () => import('./native/tmdb-metadata-sync-task.js')],
        ['metadata-sync', () => import('./native/metadata-sync.js')],
        ['metadata-cast-backfill', () => import('./native/metadata-cast-backfill.js')],
        ['age-rating-backfill', () => import('./native/age-rating-backfill.js')],
        [
            'metadata-aggregation-backfill',
            () => import('./native/metadata-aggregation-backfill.js'),
        ],
        ['metadata-translations-sync', () => import('./native/metadata-translations-sync.js')],
        ['music-embedding-generation', () => import('./native/music-embedding-generation.js')],
        ['acoustid-fingerprint', () => import('./native/acoustid-fingerprint.js')],
        ['embedding-reset', () => import('./native/embedding-reset.js')],
        ['media-item-tasks', () => import('./native/media-item-tasks.js')],
        ['livetv-tasks', () => import('./native/livetv-tasks.js')],
        ['play-session-cleanup', () => import('./native/play-session-cleanup.js')],
        ['database-cleanup', () => import('./native/database-cleanup.js')],
        ['library-storage-snapshot', () => import('./native/library-storage-snapshot.js')],
        ['unavailable-media-retention', () => import('./native/unavailable-media-retention.js')],
        ['never-owned-media-gc', () => import('./native/never-owned-media-gc.js')],
        ['watch-sync-pull', () => import('./native/watch-sync-pull.js')],
        ['watch-sync-push', () => import('./native/watch-sync-push.js')],
        ['jellyfin-file-inventory', () => import('./native/jellyfin-file-inventory.js')],
        ['watch-sync-manual', () => import('./native/watch-sync-manual.js')],
        ['telemetry-cleanup', () => import('./native/telemetry-cleanup.js')],
        ['plugin-update-check', () => import('./native/plugin-update-check.js')],
        ['lumastra-update-check', () => import('./native/lumastra-update-check.js')],
        ['music-transcode-cache-reaper', () => import('./native/music-transcode-cache-reaper.js')],
        ['valkey-memory-monitor', () => import('./native/valkey-memory-monitor.js')],
        // Wave 2E native migrations
        ['file-library-scan', () => import('./native/file-library-scan.js')],
        ['file-delta-ingest', () => import('./native/file-delta-ingest.js')],
        ['file-reconcile', () => import('./native/file-reconcile.js')],
        ['media-probe', () => import('./native/media-probe.js')],
        ['trickplay-params-sync', () => import('./native/trickplay-params-sync.js')],
        ['music-analysis', () => import('./native/music-analysis.js')],
        ['integrity-scanner', () => import('./native/integrity-scanner.js')],
        // Wave 2C native migrations — music enrichment plugins
        ['album-enrichment', () => import('./native/album-enrichment.js')],
        ['artist-enrichment', () => import('./native/artist-enrichment.js')],
        ['music-popularity', () => import('./native/music-popularity.js')],
        // Wave 2D native migrations — external-API pull plugins
        ['curated-lists-sync', () => import('./native/curated-lists-sync.js')],
        ['fribb-anime-sync', () => import('./native/fribb-anime-sync.js')],
        ['mal-anime-id-enrichment', () => import('./native/mal-anime-id-enrichment.js')],
        // Intro / outro / recap / preview segment analyzer
        ['lumastra-intro-analyzer', () => import('./native/lumastra-intro-analyzer.js')],
        [
            'lumastra-intro-analyzer-continuation',
            () => import('./native/lumastra-intro-analyzer-continuation.js'),
        ],
        // One-shot correction of the blackframe-shaped Outros the pre-evidence
        // pipeline wrote. Imports the analyzer above for its resolver and
        // settings; listed after it so the analyzer's own registration is the
        // one that reports a collision, not this module's transitive import.
        // Pipeline coverage Phase 2: drains media_item_stage_state by
        // enqueuing per-item runs for stages opted in via
        // coversStages[].enqueueable.
        ['stage-sweep', () => import('./native/stage-sweep.js')],
        ['provider-artwork-backfill', () => import('./native/provider-artwork-backfill.js')],
        ['provider-artwork-report', () => import('./native/provider-artwork-report.js')],
        // Database health invariants — runs every 15 min; persists to health_check_findings.
        ['health-invariants', () => import('./native/health-invariants.js')],
        // Attention board derivation — runs every 60s; persists to
        // admin_attention_alerts. Moves the signal fan-out off the read path (the
        // notification bell used to trigger it on every admin page load).
        ['problem-derive', () => import('./native/problem-derive.js')],
        // Server-side heartbeat for admin/ops/global-pause: runs every 60s so an
        // expired "pause everything" window or quiet-hours schedule resumes on
        // time even when nobody has the admin dashboard open to poll it.
        ['pause-reconcile', () => import('./native/pause-reconcile.js')],
        // Sonic embedding backfill — MSCLAP audio embeddings via Python CLI.
        // Scheduled every 2h (no-op when features.sonicEmbeddings is off); incremental on file events.
        // Dedicated 'embedding' resource class (concurrency=1).
        ['sonic-embedding-backfill', () => import('./native/sonic-embedding-backfill.js')],
        // Download-pool embedding projection: fit (manual, one-time, refuses to
        // overwrite an existing basis) + backfill (scheduled apply-only drain).
        // See .superpowers/embedding-quantization-eval.md.
        [
            'music-embedding-projection-fit',
            () => import('./native/music-embedding-projection-fit.js'),
        ],
        [
            'music-embedding-projection-backfill',
            () => import('./native/music-embedding-projection-backfill.js'),
        ],
        // Sonic map projection — UMAP 2D projection of MSCLAP embeddings for /music/map.
        // Manual-start only; requires sonic-embedding-backfill to have run first.
        ['sonic-map-projection', () => import('./native/sonic-map-projection.js')],
        // Sonic clustering — KMeans over MSCLAP embeddings → media_audio_clusters.
        // Manual-start only; gated by features.musicClusters; 'analysis' resource class.
        ['sonic-clustering', () => import('./native/sonic-clustering.js')],
        ['music-genre-centroids', () => import('./native/music-genre-centroids.js')],
        // Lyrics ingestion backfill — .lrc sidecar → plain text → text embedding.
        // Manual-start only; 'embedding' resource class (concurrency=1).
        // Gated by features.lyricsSearch.
        ['lyrics-ingestion-backfill', () => import('./native/lyrics-ingestion-backfill.js')],
        // Lyrics LRCLIB bulk fetch — sweeps tracks with no prior lyrics attempt
        // and calls resolveLyrics() (LRCLIB HTTP fetch + not-found marker write).
        // Scheduled every 6h; gated by features.musicLyricsFetch + features.autoLyrics.
        ['lyrics-lrclib-fetch', () => import('./native/lyrics-lrclib-fetch.js')],
        // Mood vector generation — populates mood_vectors table from music track embeddings.
        // Manual-start only; must be run at least once after sonic embeddings exist.
        // Gated by features.sonicQueue.
        ['mood-vector-generation', () => import('./native/mood-vector-generation.js')],
        // User profile backfill — rebuilds catalog_embedding for users with heavy watch
        // history but a missing or stale profile. Scheduled every 6h; 'maintenance' class.
        ['profile-backfill', () => import('./native/profile-backfill.js')],
        // Episode reconciliation backfill (WS4) — re-runs the content matcher over
        // existing series to correct historical mis-mappings. Confidence-gated;
        // never overrides metadata_locked / identity-bound rows; quarantines
        // low-confidence suspects. Scheduled every 24h; 'maintenance' class.
        ['reconciliation-backfill', () => import('./native/reconciliation-backfill.js')],
        // Arr calendar sync — pulls Sonarr + Radarr /api/v3/calendar over a wide
        // window (now-7d … now+90d) every 6h and upserts premiere_date + has_files
        // on existing episode stubs and movie rows. Keeps /api/calendar's DB read
        // current after the request-time arr calls were removed.
        ['release-calendar-sync', () => import('./native/release-calendar-sync.js')],
        ['airing-series-refresh', () => import('./native/airing-series-refresh.js')],
        // Watch history retention — deletes watch_history rows older than
        // DB_CLEANUP_WATCH_HISTORY_DAYS (default 400d) in 5k-row batches.
        // Scheduled every 24h; watch_history has no expiry and previously grew
        // without bound.
        ['watch-history-retention', () => import('./native/watch-history-retention.js')],
        // Artwork reaper — removes media_artwork rows whose file is gone (a
        // dangling row shadows inheritance, so a season with a deleted poster
        // renders nothing instead of falling back to the series poster).
        // maintenance class, bounded per cycle, N-consecutive-miss guarded.
        ['artwork-reaper', () => import('./native/artwork-reaper.js')],
    ];
    for (const [name, importer] of coreModules) {
        try {
            await importer();
        } catch (err) {
            log.error(
                'Failed to load builtin task module — skipping; other modules will continue to load',
                err as Error,
                { name },
            );
            recordBuiltinFailure('task', name, err);
        }
    }

    // Metadata providers
    try {
        await import('./native/providers/mdblist.js');
    } catch (err) {
        log.warn('failed to load native provider mdblist', {
            error: err instanceof Error ? err.message : String(err),
        });
        recordBuiltinFailure('provider', 'mdblist', err);
    }
    try {
        await import('./native/providers/anidb.js');
    } catch (err) {
        log.warn('failed to load native provider anidb', {
            error: err instanceof Error ? err.message : String(err),
        });
        recordBuiltinFailure('provider', 'anidb', err);
    }
    try {
        await import('./native/providers/musicbrainz.js');
    } catch (err) {
        log.warn('failed to load native provider musicbrainz', {
            error: err instanceof Error ? err.message : String(err),
        });
        recordBuiltinFailure('provider', 'musicbrainz', err);
    }
    try {
        await import('./native/providers/jellyfin.js');
    } catch (err) {
        log.warn('failed to load native provider jellyfin', {
            error: err instanceof Error ? err.message : String(err),
        });
        recordBuiltinFailure('provider', 'jellyfin', err);
    }
    try {
        await import('./native/providers/tmdb.js');
    } catch (err) {
        log.warn('failed to load native provider tmdb', {
            error: err instanceof Error ? err.message : String(err),
        });
        recordBuiltinFailure('provider', 'tmdb', err);
    }

    // Trickplay providers
    try {
        await import('./native/trickplay-providers/jellyfin-disk.js');
    } catch (err) {
        log.warn('failed to load native trickplay-provider jellyfin-disk', {
            error: err instanceof Error ? err.message : String(err),
        });
        recordBuiltinFailure('trickplay-provider', 'jellyfin-disk', err);
    }
    try {
        await import('./native/trickplay-providers/local.js');
    } catch (err) {
        log.warn('failed to load native trickplay-provider local', {
            error: err instanceof Error ? err.message : String(err),
        });
        recordBuiltinFailure('trickplay-provider', 'local', err);
    }

    // Feature plugins
    try {
        await import('./native/features/holiday-recommendations.js');
    } catch (err) {
        log.warn('failed to load native feature holiday-recommendations', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        await import('./native/features/dummy.js');
    } catch (err) {
        log.warn('failed to load native feature dummy', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    // (example-feature-plugin is a drop-in reference at
    // plugins/external/example-feature-plugin/, not a builtin — the external
    // loader picks it up when $PLUGINS_EXTERNAL_DIR points at the repo tree.)

    // Integration plugins
    try {
        await import('./native/integrations/jellyseerr.js');
    } catch (err) {
        log.warn('failed to load native integration jellyseerr', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        await import('./native/integrations/sonarr.js');
    } catch (err) {
        log.warn('failed to load native integration sonarr', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        await import('./native/integrations/radarr.js');
    } catch (err) {
        log.warn('failed to load native integration radarr', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        await import('./native/integrations/discogs.js');
    } catch (err) {
        log.warn('failed to load native integration discogs', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        await import('./native/integrations/dummy-integration.js');
    } catch (err) {
        log.warn('failed to load native integration dummy-integration', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // External services — API-key-only (no webhook / notification surface).
    try {
        await import('./native/external-services/openai.js');
    } catch (err) {
        log.warn('failed to load external service openai', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        await import('./native/external-services/voyage.js');
    } catch (err) {
        log.warn('failed to load external service voyage', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Media sources
    try {
        await import('./native/media-sources/kavita.js');
    } catch (err) {
        log.warn('failed to load media source kavita', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        await import('./native/media-sources/audiobookshelf.js');
    } catch (err) {
        log.warn('failed to load media source audiobookshelf', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        await import('./native/media-sources/file-scanner.js');
    } catch (err) {
        log.warn('failed to load media source file-scanner', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Watch syncs — native defineWatchSync ports. Each self-registers via
    // top-level `registerWatchSyncWithAutoTasks(...)` calls.
    try {
        await import('./native/watch-sync/jellyfin.js');
    } catch (err) {
        log.warn('failed to load native watch-sync jellyfin', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    try {
        await import('./native/watch-sync/audiobookshelf.js');
    } catch (err) {
        log.warn('failed to load native watch-sync audiobookshelf', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Drives `audiobookshelfMediaSource.scan()`. Imported AFTER the media source
    // above — it holds a module-scope reference to that definition, and the
    // registry rejects a task whose id collides with an already-registered one,
    // so load order is what keeps the two registrations independent.
    try {
        await import('./native/audiobookshelf-sync.js');
    } catch (err) {
        log.warn('failed to load native task audiobookshelf-sync', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Native plugins self-register into the module singleton `defaultRegistry`
    // rather than into the `registry` parameter (which exists only for testing).
    //
    // Full boot-time validation — task/provider/trickplay/feature/integration/
    // media-source ID format, processingVersion sanity, pipeline.after
    // dangling-reference + cycle detection, and diamond-DAG rejection (a
    // predecessor feeding more than one downstream stage within the same
    // pipeline — FlowProducer can't represent that as a tree). Also runs
    // `validateFeedsInto()` internally (feedsInto edges must point at
    // registered tasks). Deliberately fail-fast: `validateAt` throws on the
    // first violation, and loadBuiltins does not catch it, so a broken
    // declaration aborts the boot instead of sitting silently in production
    // producing no probes / periodically failing job submissions. This is the
    // one and only production call site for `validateAt` on the startup path
    // — previously the registry's cycle/diamond/ID-format checks existed only
    // in tests and were never exercised at boot.
    defaultRegistry.validateAt('startup');

    // P2-2: Boot-time validation — compare authoritative stage IDs from config
    // against the stages the registry actually knows about.
    validateAuthoritativeStageIds(
        getAuthoritativeStageIds(),
        defaultRegistry.allStageIds(),
        (msg) => log.warn(msg),
        (msg, meta) => log.info(msg, meta),
    );

    // Read counts from the singleton for an accurate boot log.
    log.info('builtin tasks loaded', {
        tasks: defaultRegistry.getAllTasks().length,
        providers: defaultRegistry.getAllProviders().length,
        trickplays: defaultRegistry.getAllTrickplays().length,
        watchSyncs: defaultRegistry.getAllWatchSyncs().length,
        features: defaultRegistry.getAllFeatures().length,
        integrations: defaultRegistry.getAllIntegrations().length,
        externalServices: defaultRegistry.getAllExternalServices().length,
        mediaSources: defaultRegistry.getAllMediaSources().length,
    });
}

/** Test helper — reset the retained boot outcome for an isolated registry test. */
export function _resetLoadedForTests(): void {
    loading = undefined;
}

// ──────────────────────────────────────────────────────────────────────────────
// Auto-task registration helper for defineWatchSync()
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Register a WatchSyncDefinition produced by defineWatchSync() (SDK contract).
 * If the definition carries __autoTasks (synthesized push + pull tasks),
 * each is registered as a full TaskDefinition in the task registry.
 */
export function registerWatchSyncWithAutoTasks(
    def: WatchSyncDefinition,
    reg: TaskRegistry = defaultRegistry,
): void {
    reg.registerWatchSync(def);
    const autoTasks = (def as { __autoTasks?: TaskDefinition[] }).__autoTasks;
    if (autoTasks && Array.isArray(autoTasks)) {
        for (const task of autoTasks) {
            safeRegister('watch-sync-auto', task.id, () => reg.registerTask(task));
        }
    }
}
