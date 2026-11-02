// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Popularity — native defineTask implementation.
 *
 * Fetches listener counts, playcount, and per-track popularity ranks from a
 * provider (Last.fm initially; provider-agnostic architecture allows
 * ListenBrainz/local/etc later) and writes them to the media_popularity
 * table.
 *
 * Popularity refreshes on staleness — an artist is considered "remaining"
 * when either (a) no popularity row exists for the current source or (b)
 * the row's `fetched_at` is older than `refresh_days`. This differs from
 * version-gated plugins (intro-analyzer, music-analysis) where processed
 * items stay done until a version bump. Here the backlog naturally rolls
 * over daily as rows age past the threshold.
 *
 * Why separate from artist-enrichment:
 *   - artist-enrichment processes only artists missing an image
 *     (`custom_poster_url IS NULL`) once, per PROCESSING_VERSION
 *   - popularity must refresh periodically on ALL artists
 *   - failure isolation: one provider unavailable shouldn't block image fills
 *   - different quota shape: popularity is sustained, enrichment is bursty
 *
 * Mode semantics (read from ctx.input.mode, default 'catchup'):
 *   - catchup  (scheduled tick): one slice per run, respects soft budget.
 *   - manual   ("Analyze remaining"): drain until empty.
 *   - force    ("Re-analyze everything"): wipe source rows then drain.
 *
 * Settings (admin UI):
 *   LASTFM_API_KEY   — secret; required if source='lastfm'
 *   source           — which PopularityProvider to use (only 'lastfm' today)
 *   refresh_days     — staleness threshold (default 7). Single source of
 *                      truth — both the drain and backlog-status predicates
 *                      derive their "stale before" cutoff from this value.
 *
 * Admin UX for the backlog card:
 *   - Fresh install: every artist is "remaining" (no rows) — ticks down each
 *     scheduled catchup run and visibly empties on manual drain.
 *   - Steady state: stale artists trickle in as rows age past the
 *     refresh window. A daily catchup run at slice=100 comfortably keeps
 *     up with typical library churn without starving other plugins.
 *   - Bulk artist import: treated as fresh install for the new artists;
 *     admins can click the primary "manual" action to force an immediate
 *     drain-to-empty.
 *
 * Configuration:
 * - SYNC_MUSIC_POPULARITY_INTERVAL: Duration-string override for the 24h
 *   cadence (e.g. '12h', '2d'). Read via schedule.envOverride.
 *
 * NO_PROCESSING_VERSION: time-based plugin — rows refresh on
 * staleness (refresh_days) rather than on a version bump, so
 * `processingVersion` is intentionally omitted from the manifest.
 * A future schema change that forces a cohort refresh can adopt a
 * version at that time. Grep for `processingVersion` finds this
 * site via the NO_PROCESSING_VERSION tag so the absence is
 * machine-discoverable.
 */

import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext, BacklogStage } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import {
    drainBacklog,
    resolveDrainMode,
    formatStopReason,
    computeRemainingHint,
    isAbortedStop,
    lazyBacklog,
} from '../../../plugins/runtime/drain-backlog.js';
import type { PluginContext } from '../../../plugins/types/index.js';
import {
    getTaskSettings,
    upsertTaskSettings,
} from '../../../database/queries/task-settings.queries.js';
import {
    countPopularityBacklog,
    countTotalArtists,
    DEFAULT_WIPE_BATCH_SIZE,
    findPopularityCoverageTableBacklog,
    getStaleArtists,
    rebuildPopularityRank,
    wipePopularityForSource,
    type StaleArtistRow,
} from '../../../database/queries/popularity.queries.js';
import {
    upsertCompletedRow,
    markFailedTransient,
} from '../../../database/queries/stage-state.queries.js';
import { createLastFmProvider } from '../../../services/popularity/lastfm-provider.js';
import { enrichArtist } from '../../../services/popularity/orchestrator.js';
import type { PopularityProvider, PopularitySource } from '../../../services/popularity/types.js';
import { getAuthoritativeStageIds } from '$lib/server/config.js';
import { classifyInfraError } from '../../infra-retry.js';

// ============================================================================
// Constants
// ============================================================================

const TASK_ID = 'music-popularity';

/**
 * Whether the Last.fm key is stored — presence of the encrypted secret row,
 * which is what buildProvider() gates on (it cannot read the ciphertext).
 */
async function isLastfmKeyStored(sql: postgres.Sql): Promise<boolean> {
    const rows = await sql<{ present: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM plugin_secrets
             WHERE plugin_id = ${TASK_ID}
               AND key = 'LASTFM_API_KEY'
        ) AS present
    `;
    return rows[0]?.present === true;
}

// Artists processed per drain slice. Catchup runs one slice per tick (the
// scheduler's nibble); manual/force drain slices until empty. Sized to fit
// comfortably inside Last.fm's informal rate limit (~5 req/s) with headroom
// for the batched upsert writes that follow each fetch.
const SLICE_SIZE = 100;

// Row-batch size for the force-mode wipe. Keeps lock windows short on large
// libraries — media_popularity can grow to hundreds of thousands of rows
// once per-track ranks accumulate across many artists. Sourced from the
// query module so the scheduled wipe and the destructive admin action
// share a single tunable.
const WIPE_BATCH_SIZE = DEFAULT_WIPE_BATCH_SIZE;

const DAY_MS = 24 * 60 * 60 * 1000;

// Minimum allowed refresh_days. Lower values cause excessive provider
// traffic without meaningful benefit — Last.fm-style stats move slowly.
const MIN_REFRESH_DAYS = 1;
const MAX_REFRESH_DAYS = 365;

// ============================================================================
// Settings
// ============================================================================

interface MusicPopularitySettings {
    source: PopularitySource;
    /**
     * Staleness threshold in days. An artist is re-fetched once its
     * popularity row is older than this. Used by BOTH the drain loop
     * (fetchSlice predicate) and the backlog card (countPopularityBacklog)
     * so the admin UI and the scheduler agree on the same cutoff.
     */
    refresh_days: number;
}

const DEFAULTS: MusicPopularitySettings = {
    source: 'lastfm',
    refresh_days: 7,
};

const VALID_SOURCES = new Set<string>(['lastfm']);

function mergeSettings(raw: Record<string, unknown>): MusicPopularitySettings {
    const source =
        typeof raw.source === 'string' && VALID_SOURCES.has(raw.source)
            ? (raw.source as PopularitySource)
            : DEFAULTS.source;

    const rawRefresh = Number(raw.refresh_days);
    const refresh_days =
        Number.isFinite(rawRefresh) && rawRefresh >= MIN_REFRESH_DAYS
            ? Math.min(Math.floor(rawRefresh), MAX_REFRESH_DAYS)
            : DEFAULTS.refresh_days;

    return { source, refresh_days };
}

async function loadSettings(
    sql: postgres.Sql<Record<string, never>>,
): Promise<MusicPopularitySettings> {
    return mergeSettings(await getTaskSettings(sql, TASK_ID));
}

/**
 * Compute the ISO timestamp cutoff a row must be newer than to count as
 * "fresh" at the current refresh_days window. Callers pass this same string
 * to both `getStaleArtists` and `countPopularityBacklog` so the drain
 * fetcher and the admin progress card agree on which artists are stale.
 */
function staleBeforeIsoFor(settings: MusicPopularitySettings): string {
    return new Date(Date.now() - settings.refresh_days * DAY_MS).toISOString();
}

// ============================================================================
// Provider resolution
// ============================================================================

function buildProvider(
    settings: MusicPopularitySettings,
    lastfmApiKey: string,
): PopularityProvider | null {
    switch (settings.source) {
        case 'lastfm': {
            const provider = createLastFmProvider(lastfmApiKey);
            return provider.isConfigured() ? provider : null;
        }
        default:
            return null;
    }
}

// ============================================================================
// Helpers
// ============================================================================

interface SliceOutcome {
    /** Artists where the provider returned populated data we persisted. */
    fetched: number;
    /** Artists where the provider returned null — marked probed by orchestrator. */
    empty: number;
    /** Artists where the orchestrator threw (DB error or unexpected bug). */
    errors: number;
    /**
     * Count of artists whose row left the stale window this slice — either
     * via a successful upsert OR a successful probe-write. Distinguishes a
     * DB outage (every probe-write fails → advanced stays 0 → drain stops
     * cleanly at no-progress) from a library of unmatchable artists (every
     * probe lands → advanced > 0 → drain makes real progress).
     */
    advanced: number;
}

/**
 * Process a single slice of stale artists sequentially. Sequential (not
 * parallel) because the provider HTTP client is globally rate-limited and
 * parallel calls would just queue behind the shared throttle. Each artist's
 * outcome is tracked independently so one failure never poisons the slice.
 *
 * Progress reporting is handled by drainBacklog between slices; this function
 * just crunches items and returns totals. Inter-slice reporting is adequate
 * at SLICE_SIZE=100 over Last.fm's ~5 req/s (≈20s/slice).
 */
async function processArtistSlice(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    provider: PopularityProvider,
    artists: StaleArtistRow[],
    abortSignal: AbortSignal,
    onSuccess?: (artistId: string) => Promise<void>,
): Promise<SliceOutcome> {
    let fetched = 0;
    let empty = 0;
    let errors = 0;
    let advanced = 0;

    // Record a per-artist transient failure so the coverage row carries an
    // explicit `failed_transient` status (+ backoff) instead of silently
    // staying `pending` and relying solely on wedge-guard Invariant 2. Stays
    // sweepable, so it retries after backoff — not a wedge. Best-effort: in a
    // full DB outage this write also fails (caught), leaving the row pending to
    // retry next run, same as before. No retry endpoint shares this path.
    const recordTransient = async (artistId: string, reason: string): Promise<void> => {
        try {
            await markFailedTransient(sql, {
                mediaItemId: artistId,
                stageId: TASK_ID,
                error: {
                    message: reason,
                    code: 'popularity_probe_failed',
                    retryable: true,
                },
                backoffMs: 6 * 60 * 60 * 1000,
            });
        } catch {
            // Non-fatal — drainBacklog's no-progress detector still halts a true
            // DB outage; the row stays pending and retries next run.
        }
    };

    for (const artist of artists) {
        if (abortSignal.aborted) break;
        try {
            const result = await enrichArtist(
                sql,
                provider,
                {
                    artistId: artist.artistId,
                    title: artist.title,
                    mbid: artist.mbid ?? undefined,
                },
                { signal: abortSignal },
            );
            if (result.fetched) {
                fetched++;
            } else {
                empty++;
            }
            if (result.advanced) {
                advanced++;
                if (onSuccess) {
                    try {
                        await onSuccess(artist.artistId);
                    } catch (coverageErr) {
                        logger.warn(
                            'Failed to upsert coverage row for music-popularity (non-fatal)',
                            {
                                artistId: artist.artistId,
                                error:
                                    coverageErr instanceof Error
                                        ? coverageErr.message
                                        : String(coverageErr),
                            },
                        );
                    }
                }
            } else {
                // enrichArtist returned without advancing — the probe-write
                // failed (transient DB issue; see orchestrator). Record so the
                // row leaves `pending` with a backoff instead of looping silently.
                await recordTransient(artist.artistId, 'popularity-probe-write-failed');
            }
        } catch (err) {
            // enrichArtist swallows provider errors into `fetched: false`,
            // so a thrown exception here is either a DB error or an
            // unexpected orchestrator bug. Log and continue — one bad
            // artist must not derail the drain. Not credited toward
            // `advanced`.
            errors++;
            logger.warn('Popularity enrich failed for artist', {
                id: artist.artistId,
                title: artist.title,
                error: err instanceof Error ? err.message : String(err),
            });
            await recordTransient(
                artist.artistId,
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    return { fetched, empty, errors, advanced };
}

// ============================================================================
// Task definition
// ============================================================================

type MusicPopularityInput = Record<string, unknown>;

type MusicPopularityResult = {
    itemsProcessed: number;
    message: string;
};

const inputSchema = z.object({}).passthrough();

/**
 * Translate the backlog counts to BacklogStage[].
 * Music popularity has no failed bucket and no ineligible bucket
 * by design — only remaining.
 */
function toStages(status: {
    analyzed: number;
    remaining: number;
    ineligible: number;
    failed?: number;
}): BacklogStage[] {
    const stages: BacklogStage[] = [];
    if (status.remaining > 0) {
        stages.push({
            id: 'remaining',
            label: 'Remaining',
            count: status.remaining,
        });
    }
    if ((status.failed ?? 0) > 0) {
        stages.push({
            id: 'failed',
            label: 'Failed',
            count: status.failed ?? 0,
        });
    }
    if (status.ineligible > 0) {
        stages.push({
            id: 'ineligible',
            label: 'Ineligible',
            count: status.ineligible,
        });
    }
    return stages;
}

export const musicPopularityTask = defineTask<MusicPopularityInput, MusicPopularityResult>({
    id: TASK_ID,
    purpose: 'music-ai',
    name: 'Music Popularity',
    version: '1.1.0',
    // processingVersion is present to satisfy the SDK manifest contract.
    // This is a time-based plugin — items refresh on staleness (refresh_days)
    // rather than on a version bump. A future forced-cohort refresh can bump
    // this value. See NO_PROCESSING_VERSION comment in the file header.
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },

    schedule: {
        every: '24h',
        runOnStartup: false,
        envOverride: 'SYNC_MUSIC_POPULARITY_INTERVAL',
    },

    // identityFor is deliberately MODE-INDEPENDENT ('global', not
    // `global-${mode}`). exclusiveWith has no separate key formula — the
    // orchestrator's SETNX mutex key is `identityKey(taskId, identityFor(input))`
    // (see identity.ts / orchestrator.ts claimIdentity), so it fully inherits
    // whatever identityFor returns. A mode-suffixed identityFor (the shape
    // watch-sync-pull/push use deliberately, see below) would give catchup,
    // manual, and force EACH their own dedup key — exclusiveWith would only
    // collapse same-mode re-fires, not cross-mode overlap.
    //
    // Why this differs from watch-sync-pull/push: those are two SEPARATE
    // tasks (push and pull), each mode-suffixed only to distinguish that
    // task's own scheduled-vs-manual re-fires from one another — there is no
    // "pull-catchup running concurrently with pull-manual" scenario to guard
    // against beyond same-mode piling up. Here catchup/manual/force are the
    // SAME work (drain the stale-artist backlog) at different depths/entry
    // points — a manual "Analyze remaining" firing while a scheduled catchup
    // is mid-drain is redundant work against the identical candidate set, not
    // a distinct operation. Single-flight across modes is therefore the
    // correct semantics, not an accident to route around.
    identityFor: () => 'global',
    scope: 'global',

    // Singleton guard (mirrors watch-sync-pull/library-embeddings-task):
    // without exclusiveWith, catchup (24h schedule), manual ("Analyze
    // remaining"), and force ("Re-analyze everything") can all be in flight
    // at once — each drains the same stale-artist set concurrently, doubling
    // (or tripling) Last.fm API calls for no extra coverage. exclusiveWith
    // SETNX-claims the identity key for the duration of an in-flight run, so
    // a same-identity re-fire (e.g. two catchup ticks, OR a manual/force
    // trigger while catchup is in flight — identityFor is now the constant
    // 'global' so ALL modes share one key) no-ops until the current run
    // finishes. The admin run route reports this as `deduped: true` (200,
    // same runId as the in-flight run) rather than silently dropping the
    // trigger. ttl must be >= timeout.hard (SDK-enforced); 35m gives a 5m
    // margin over the 30m hard cap and is clamped up to the derived floor by
    // the host if needed.
    exclusiveWith: { scope: 'global', ttl: '35m' },

    // Mass-enrichment — drains via bulk pool.
    resourceClass: 'bulk',
    // Honours `{ mode: 'manual' }` — drains the whole backlog in one
    // run instead of the single batch a scheduled catchup cycle does.
    supportsFullRun: true,
    // Discards the stored popularity scores and recomputes them.
    supportsForceRun: true,

    inputSchema,

    // appliesTo is `['artist']` only — getStaleArtists is the sole candidate
    // source and the handler doesn't touch tracks or albums. The eligibility SQL
    // below is the single declaration of this stage's domain: only artist rows
    // are eligible. The framework dispose pass uses NOT(sql) to drain historical
    // track/album rows (seeded under the old ['track','album','artist'] declaration)
    // to skipped_permanent, replacing the former music-popularity-artists-only
    // predicate disposition.
    coversStages: [
        {
            id: 'music-popularity',
            appliesTo: ['artist'] as const,
            enqueueable: true,
            eligibility: {
                sql: (sql) => sql`mi.media_type = 'artist'`,
            },
            terminalDisposition: [
                {
                    // GLOBAL precondition: the popularity provider must be
                    // configured before any artist row can advance. When the
                    // Last.fm API key has never been entered, every pending
                    // artist row would otherwise sit pending forever (the
                    // no-provider early return in execute() makes no terminal
                    // write). The guard is a cheap, side-effect-free DB presence
                    // check for the encrypted secret row — it cannot validate the
                    // key value (it's AES-GCM ciphertext) but presence is exactly
                    // what buildProvider() gates on (apiKey.trim().length > 0).
                    // On false the framework drains the whole stage to
                    // skipped_transient and retries in 6h.
                    kind: 'global-guard' as const,
                    ruleId: 'music-popularity-provider-configured',
                    reason: 'no-popularity-provider-configured',
                    retryAfterMs: 6 * 60 * 60 * 1000,
                    guard: async (ctx): Promise<boolean> => {
                        try {
                            return await isLastfmKeyStored(ctx.sql as never);
                        } catch (err) {
                            // A probe failure must not wedge the stage by
                            // reporting "unconfigured" on a transient DB blip —
                            // assume configured and let the normal drain decide.
                            ctx.logger.warn(
                                'music-popularity provider-configured guard probe failed; assuming configured',
                                {
                                    error: err instanceof Error ? err.message : String(err),
                                },
                            );
                            return true;
                        }
                    },
                },
                {
                    // The canonical "Various Artists" row (mirrors
                    // artist-enrichment's `va-or-custom-poster` disposition) is a
                    // synthetic compilation bucket, not a real artist — Last.fm
                    // listener/playcount data for it is meaningless. Without this
                    // exclusion the coverage seed (which creates a pending row for
                    // every media_type='artist' item, including the canonical VA
                    // row inserted by migration 16.132.0 on every install) leaves
                    // a permanently-pending "Various Artists" train parked at the
                    // Popularity station on a fresh, zero-music-library install.
                    kind: 'predicate' as const,
                    ruleId: 'various-artists-placeholder',
                    disposeAs: 'skipped_permanent' as const,
                    reason: 'various-artists-not-applicable',
                    excludes: (sql) =>
                        sql`mi.media_type = 'artist' AND mi.is_various_artists = true`,
                },
            ],
        },
    ],

    timeout: { hard: '30m', soft: '28m' },

    settings: {
        fields: [
            {
                key: 'source',
                type: 'select',
                label: 'Provider',
                description:
                    'Which popularity provider to use. More providers will be added in future releases.',
                default: DEFAULTS.source,
                options: [{ value: 'lastfm', label: 'Last.fm' }],
            },
            {
                key: 'LASTFM_API_KEY',
                type: 'secret',
                label: 'Last.fm API Key',
                description:
                    'API key from last.fm/api/account/create. Free; required when source is Last.fm.',
            },
            {
                key: 'refresh_days',
                type: 'number',
                label: 'Refresh Interval (days)',
                description: `An artist is considered stale — and re-fetched on the next drain — once its popularity row is older than this many days. Default ${DEFAULTS.refresh_days}.`,
                default: DEFAULTS.refresh_days,
                validation: {
                    min: MIN_REFRESH_DAYS,
                    max: MAX_REFRESH_DAYS,
                },
            },
        ],
    },

    backlog: {
        unitLabel: 'artists',
        sliceSize: 1,
        softBudget: '1s',
        idOf: (row: unknown): string => {
            const r = row as { id?: unknown; artistId?: unknown } | null | undefined;
            if (r && typeof r.artistId === 'string') return r.artistId;
            if (r && typeof r.id === 'string') return r.id;
            return String(r);
        },
        async stages(ctx: TaskContext<MusicPopularityInput>): Promise<BacklogStage[]> {
            // No configured provider → surface total artist count as `remaining`
            // so the admin sees the sizing signal rather than a misleading "0 of 0 done".
            const settings = await loadSettings(ctx.sql as never);
            const lastfmApiKey = (await ctx.secrets.getOptional('LASTFM_API_KEY')) ?? '';
            const provider = buildProvider(settings, lastfmApiKey);
            if (!provider) {
                const total = await countTotalArtists(ctx.sql as never);
                return toStages({
                    analyzed: 0,
                    remaining: total,
                    ineligible: 0,
                });
            }
            const staleBeforeIso = staleBeforeIsoFor(settings);
            const counts = await countPopularityBacklog(
                ctx.sql as never,
                provider.id,
                staleBeforeIso,
            );
            return toStages({
                analyzed: counts.analyzed,
                remaining: counts.remaining,
                ineligible: 0,
            });
        },
        async wipe(ctx: TaskContext<MusicPopularityInput>): Promise<void> {
            const settings = await loadSettings(ctx.sql as never);
            const lastfmApiKey = (await ctx.secrets.getOptional('LASTFM_API_KEY')) ?? '';
            const provider = buildProvider(settings, lastfmApiKey);
            if (!provider) {
                ctx.logger.warn(
                    'Popularity wipe requested but no provider configured; nothing to remove',
                );
                return;
            }
            // Thread the abort signal through so the destructive admin
            // "Re-analyze everything" flow can be cancelled mid-wipe —
            // same contract the force-mode branch of execute() honors.
            const n = await wipePopularityForSource(
                ctx.sql as never,
                provider.id,
                WIPE_BATCH_SIZE,
                ctx.signal,
            );
            ctx.logger.info(`Wiped ${n} popularity row(s) for source ${provider.id}`);
        },
        async compute(): Promise<{ items: unknown[]; remainingHint: number }> {
            return { items: [], remainingHint: 0 };
        },
    },

    lifecycle: {
        // Fired by the settings routes after a settings/secret save commits
        // (admin plugin settings, and the setup wizard's Last.fm step). Once
        // the key is stored, the artist rows the provider-configured guard
        // parked for 6h are released and a catch-up run starts now.
        async onConfigChange(ctx: TaskContext<MusicPopularityInput>): Promise<void> {
            if (!(await isLastfmKeyStored(ctx.sql as never))) return;
            const { releaseAfterProviderKeySaved, LASTFM_KEY_RELEASE } =
                await import('../../provider-key-release.js');
            await releaseAfterProviderKeySaved(ctx.sql as never, LASTFM_KEY_RELEASE);
        },
    },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx: TaskContext<MusicPopularityInput>) {
        const { logger, sql, signal } = ctx;
        const startTime = Date.now();

        const rawInput = ctx.input as Record<string, unknown>;
        const mode = typeof rawInput.mode === 'string' ? rawInput.mode : 'catchup';

        if (signal.aborted) {
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted' as const,
                result: {
                    itemsProcessed: 0,
                    message: 'aborted before starting',
                },
            };
        }

        // Out-of-scope (track/album) stage_state rows are disposed by the
        // framework's eligibility pass (NOT(mi.media_type = 'artist') → skipped_permanent),
        // which stage-sweep runs before each candidate scan. No inline reconciliation needed.

        const settings = await loadSettings(sql as never);
        const lastfmApiKey = (await ctx.secrets.getOptional('LASTFM_API_KEY')) ?? '';
        const provider = buildProvider(settings, lastfmApiKey);
        if (!provider) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    itemsProcessed: 0,
                    message: `Provider '${settings.source}' is not configured. Set the API key in plugin settings.`,
                },
            };
        }

        const drainMode = resolveDrainMode(mode, logger);

        const useCoverageTable = getAuthoritativeStageIds().has(TASK_ID);

        // Staleness cutoff — used by fetchSlice and initialBacklog below.
        // Force mode wipes via onWipe; after the wipe every artist is
        // fetched_at IS NULL, so this same predicate still matches them
        // all. No separate "all rows are stale" branch needed.
        const staleBeforeIso = staleBeforeIsoFor(settings);

        let fetched = 0;
        let empty = 0;
        let errors = 0;

        const typedSql = sql as unknown as postgres.Sql<Record<string, never>>;

        const onPopularitySuccess = async (artistId: string): Promise<void> => {
            await upsertCompletedRow(typedSql, {
                mediaItemId: artistId,
                stageId: TASK_ID,
                processingVersion: 1,
            });
        };

        // Take the backlog snapshot lazily inside the first fetchSlice
        // call — this runs AFTER drainBacklog's onWipe for force mode,
        // so the count reflects the post-wipe state. Taking it eagerly
        // before drainBacklog would undercount in force mode (pre-wipe
        // counts only the already-stale cohort, not the ~real total).
        const initialBacklog = lazyBacklog(async () => {
            const counts = await countPopularityBacklog(sql as never, provider.id, staleBeforeIso);
            return counts.remaining;
        });

        const result = await drainBacklog<StaleArtistRow>(
            { logger, abortSignal: signal },
            {
                mode: drainMode,
                // The drain's own default budget is 110 min, but this task is
                // killed by the run watchdog at timeout.hard (30m) — a manual
                // drain would be marked FAILED mid-slice instead of stopping
                // cleanly. Finish under that cap so the run ends as
                // stopReason 'budget' and the remainder rolls to the next catchup.
                softBudgetMs: 25 * 60 * 1000,
                sliceSize: SLICE_SIZE,
                onWipe: async () => {
                    const n = await wipePopularityForSource(
                        sql as never,
                        provider.id,
                        WIPE_BATCH_SIZE,
                        signal,
                    );
                    logger.info(`Wiped ${n} popularity row(s) for source ${provider.id}`);
                },
                idOf: (row) => row.artistId,
                fetchSlice: async (limit) => {
                    const initial = await initialBacklog();
                    const rows = useCoverageTable
                        ? await findPopularityCoverageTableBacklog(sql as never, TASK_ID, limit)
                        : await getStaleArtists(sql as never, provider.id, staleBeforeIso, limit);
                    return {
                        items: rows,
                        remainingHint: computeRemainingHint(
                            initial,
                            fetched + empty + errors,
                            rows.length,
                        ),
                    };
                },
                processSlice: async (artists, sliceSignal) => {
                    const outcome = await processArtistSlice(
                        sql as never,
                        logger as never,
                        provider,
                        artists,
                        sliceSignal,
                        onPopularitySuccess,
                    );
                    fetched += outcome.fetched;
                    empty += outcome.empty;
                    errors += outcome.errors;
                    // Advanced now comes from the orchestrator's per-artist
                    // `advanced` flag: a successful upsert OR a successful
                    // `markArtistProbed` counts; provider throws and
                    // probe-write failures don't. This distinguishes a DB
                    // outage (every probe-write fails → advance 0 → drain
                    // stops at no-progress) from a library of unmatchable
                    // artists (every probe-write lands → advance > 0 →
                    // drain makes real progress through them).
                    return {
                        produced: outcome.fetched,
                        advanced: outcome.advanced,
                    };
                },
                onProgress: (processed, total, meta) => {
                    ctx.reportProgress(processed, total, meta?.currentItem);
                },
                phase: 'Fetching popularity',
                // Heartbeat — 100 Last.fm requests per slice at ~5 req/s
                // means a slice runs ~20-30s; still, a network hiccup can
                // stretch one slice past BullMQ's stall threshold. The
                // heartbeat emits progress every 2 min so the worker isn't
                // killed mid-slice.
                heartbeat: {
                    getTotal: () => initialBacklog.peek(),
                    getProcessed: () => fetched + empty + errors,
                    getStatus: () =>
                        `Fetching popularity... (${fetched} done, ${errors} errors, ${empty} skipped)`,
                },
            },
        );

        const duration = Date.now() - startTime;
        logger.info(
            `Popularity sync complete: ${fetched} fetched, ${empty} probed-empty, ${errors} errors (stop=${result.stopReason}, ${duration}ms)`,
        );

        // Refresh the precomputed popular-hits ordering now that
        // media_popularity has changed. Skipped when nothing was fetched --
        // rebuilding an unchanged projection is pure work.
        //
        // Fail-soft: a stale ordering degrades the popular-hits bucket
        // slightly; a throw here would fail an otherwise-successful sync and
        // discard the popularity data it just fetched.
        if (fetched > 0) {
            try {
                const ranked = await rebuildPopularityRank(sql as never, provider.id);
                logger.info(`Rebuilt popularity rank projection: ${ranked} row(s)`);
            } catch (err) {
                logger.warn(
                    `Popularity rank rebuild failed (ordering may be stale): ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }

        const suffix = formatStopReason(result.stopReason);

        return {
            success: !isAbortedStop(result.stopReason),
            itemsProcessed: fetched,
            result: {
                itemsProcessed: fetched,
                message:
                    fetched + empty + errors === 0
                        ? 'All artists have fresh popularity data'
                        : `Fetched popularity (${fetched} done, ${errors} errors, ${empty} skipped)${suffix}`,
            },
        };
    },
});

registry.registerTask(musicPopularityTask);

// ============================================================================
// Settings helpers (used by admin settings UI route)
// ============================================================================

export async function getMusicPopularitySettings(
    sql: postgres.Sql<Record<string, never>>,
): Promise<MusicPopularitySettings> {
    return loadSettings(sql);
}

export async function updateMusicPopularitySettings(
    sql: postgres.Sql<Record<string, never>>,
    data: Record<string, unknown>,
): Promise<void> {
    const current = await loadSettings(sql);
    const merged = mergeSettings({ ...current, ...data });
    await upsertTaskSettings(sql, TASK_ID, merged as unknown as Record<string, unknown>);
}
