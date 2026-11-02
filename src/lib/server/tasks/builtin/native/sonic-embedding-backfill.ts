// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic Embedding Backfill Task
 *
 * Background task that embeds music tracks with MSCLAP (Microsoft CLAP '2023')
 * audio embeddings for sound-based similarity search.
 *
 * Drain query:
 *   SELECT tracks that are media_type='track', have a media_files row,
 *   and do NOT have a 'done' row in media_audio_embedding_state for
 *   model_id='msclap-2023'.
 *
 * Per-batch:
 *   1. Spawn the Python CLI (embed.py) via execFile with paths on stdin.
 *   2. Write successful vectors to media_audio_embeddings.
 *   3. Write done/failed status to media_audio_embedding_state.
 *
 * Gating:
 *   - No-ops immediately when features.sonicEmbeddings is false, or when no
 *     embedder is configured (isSonicEngineConfigured()).
 *   - Runs on a 2-hour schedule (automatic backlog drain) when the feature
 *     is enabled. Can also be triggered manually at any time.
 *
 * Incremental embedding (processItems):
 *   When new track files are attached (file.attached event via coversStages),
 *   processItems embeds each new track immediately so the sidecar warm-start
 *   advantage is leveraged without waiting for the next scheduled sweep.
 *   preserveCompletedOn: ['file.attached'] prevents re-embedding already-done
 *   tracks on re-attach events.
 *
 * Resource class:
 *   Uses the 'embedding' class with quotas.maxConcurrent=1 to serialize the
 *   GPU-bound runs (one backfill at a time) without starving other embedders.
 *   NEVER uses the 'analysis' class (30h starvation incident precedent).
 */

import { backgroundCpuCheckpoint } from '../../background-cpu-scope.js';

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type {
    TaskContext,
    BacklogStage,
    FailedItem as SdkFailedItem,
} from '@sapd/lumastra-plugin-sdk';
import { config, features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    embedPaths,
    isEmbedSuccess,
    isSonicEmbedderReady,
    isSonicEngineConfigured,
    SonicBusyError,
    SonicEngineError,
    SONIC_MODEL_ID,
} from '../../../services/sonic-embedding.service.js';
import {
    clearCrashSuspects,
    loadCrashSuspects,
    markCrashSuspects,
    strikeCrashSuspect,
} from '../../../services/sonic-crash-suspects.js';
import { registry } from '../../registry.js';
import { getActiveProjectionBasis } from '$lib/server/database/queries/music-embedding-projection.queries.js';
import {
    projectAndQuantize,
    int8VectorToBuffer,
} from '../../../services/music-embedding-projection/quantize.js';
import type { ProjectionBasis } from '../../../services/music-embedding-projection/types.js';
import { parseCpuThreadsSetting, SONIC_CPU_THREADS_FIELD_DEF } from './sonic-task-shared.js';
import { stripSecrets } from '$lib/shared/transcode-failure-report.js';
import {
    getFailureAggregates,
    type FailureAggregateRow,
} from '$lib/server/database/queries/plugin-failure-events.queries.js';
import type postgres from 'postgres';

// Inlined from the retired `plugins/types/sync-plugin-ui.ts` — the legacy
// sync-plugin UI module is gone but processItems still needs this shape
// to type the item bundle passed by the task runner on file events.
interface NewMediaItem {
    id: string;
    mediaType: string;
    filePath?: string;
    jellyfinId?: string;
}

const logger = Logger.for('SonicEmbeddingBackfill');

// ============================================================================
// Constants
// ============================================================================

/**
 * Drain chunk size: how many tracks to fetch from the DB per iteration.
 * The actual Python batch size is controlled by config.SONIC_EMBEDDER_BATCH_SIZE
 * (honoured inside embedPaths). We fetch a larger chunk so the DB round-trip
 * amortises across multiple Python spawns when the config batch size is small.
 */
const DRAIN_CHUNK_SIZE = 64;

/**
 * `skipped_reason` stamped on `sonic-embedding-backfill` rows while
 * `features.sonicEmbeddings` is off; the eligibility heal reclaims them when it
 * turns on.
 */
export const SONIC_DISABLED_REASON = 'sonic-embeddings-disabled';

/**
 * `skipped_reason` stamped while the feature is on but no embedder is
 * configured (no `SONIC_EMBEDDER_URL`, no subprocess fallback installed).
 */
export const SONIC_NO_ENGINE_REASON = 'sonic-embedder-unavailable';

// When the embedder is transiently unavailable (classically: the CLAP model is still
// cold-loading on the sidecar at first boot), embedPaths fails for the whole chunk and
// those rows stay eligible — fetchPendingTracks only excludes status='done', so 'failed'
// rows are re-selected on the next round. Without backoff the drain re-fetches and
// re-attempts the same rows in a tight spin, hammering the sidecar and inflating the
// failure tally (151 cold rounds × 48 tracks once logged "failed: 7248"). Pace the
// retries and give up after a few fruitless rounds; the scheduled sweep / next manual
// run retries later once the sidecar is warm.
const NO_PROGRESS_BACKOFF_MS = 5_000;
const MAX_NO_PROGRESS_ROUNDS = 4;

/**
 * Consecutive failures after which a track stops being offered to the embedder.
 *
 * The backoff above paces retries WITHIN one run. It does nothing across runs,
 * and that is where the real leak was: `fetchPendingTracks` excluded only
 * `status = 'done'`, so a file the decoder can never read came back on every
 * two-hourly sweep, failed, wrote an audit row, and came back again. Prod
 * 2026-09-11 had two such mp3s (garbage between the ID3 tag and the first MPEG
 * frame) that had between them produced 1,152 failure rows since August against
 * 30,081 successfully embedded tracks. Nothing counted, so nothing stopped.
 *
 * Three, not one: the sidecar is a separate container and a genuinely transient
 * outage (restart, OOM, cold model load) must not write a healthy track off.
 * Three consecutive failures across three separate sweeps is six hours of the
 * same answer.
 *
 * Counted at most once per run (see the failure branch in execute()), so three means
 * three runs, not three drain rounds of one run.
 *
 * NOT a dead end for the operator: the counter resets to 0 on any success (the per-item
 * Retry action embeds the track inline), "Retry all failed items" zeroes it for every
 * failed track (PipelineRemediationService.resetFailedForStage), and a full re-embed
 * (`force`) ignores it outright — so repairing the file is all it takes to bring a
 * track back.
 */
const MAX_EMBED_ATTEMPTS = 3;

/**
 * Redact credentials (e.g. a SONIC_EMBEDDER_URL with userinfo echoed into
 * subprocess/fetch error text) before the reason is durably written to
 * plugin_failure_events. stripSecrets is write-time protection for the
 * database itself, distinct from the copy-time redactPaths pass applied when
 * an operator exports the row.
 *
 * Redaction ONLY — the length cap belongs to `condenseFailureReason`, which
 * `recordPluginFailure` applies on the way into the table. This function used
 * to also `.slice(0, 500)`, which ran FIRST and so decided what the condenser
 * would ever see: an execFile rejection that leads with a tool banner arrived
 * already stripped of its actual error. Redact here, condense there.
 */
function sanitizeFailureReason(reason: string): string {
    return stripSecrets(reason);
}

// ============================================================================
// Schema / types
// ============================================================================

const inputSchema = z.object({}).passthrough();

type BackfillInput = z.infer<typeof inputSchema>;

interface BackfillResult {
    embedded: number;
    failed: number;
    skipped: number;
}

interface TrackRow {
    media_item_id: string;
    file_path: string;
}

// ============================================================================
// Drain helpers (typed postgres.Sql helpers)
// ============================================================================

/**
 * Fetch the next batch of tracks that need embedding.
 *
 * Tracks are eligible when:
 *   - media_items.media_type = 'track'
 *   - They have at least one media_files row (file_path)
 *   - They do NOT have a 'done' row in media_audio_embedding_state for
 *     model_id = 'msclap-2023'
 *   - They have not failed `MAX_EMBED_ATTEMPTS` times in a row
 *
 * That last clause is the whole reason `attempts` exists. Excluding only
 * `status = 'done'` left a permanently-undecodable file eligible on every
 * two-hourly sweep for the rest of time — see MAX_EMBED_ATTEMPTS.
 */
export async function fetchPendingTracks(
    sql: postgres.Sql,
    limit: number,
    /** Tracks this run already set aside (crash suspects waiting for a ready sidecar). */
    excludeIds: readonly string[] = [],
): Promise<TrackRow[]> {
    return sql<TrackRow[]>`
        SELECT DISTINCT ON (mfi.media_item_id)
            mfi.media_item_id::text AS media_item_id,
            mf.file_path
        FROM media_file_items mfi
        JOIN media_files mf
          ON mf.id = mfi.file_id
        JOIN media_items mi
          ON mi.id = mfi.media_item_id
        WHERE mi.media_type = 'track'
          AND mf.file_path IS NOT NULL
          AND NOT mf.is_missing
          AND mfi.media_item_id <> ALL(${excludeIds as string[]}::uuid[])
          AND NOT EXISTS (
              SELECT 1
              FROM media_audio_embedding_state s
              WHERE s.media_id  = mfi.media_item_id
                AND s.model_id  = ${SONIC_MODEL_ID}
                AND (
                    s.status = 'done'
                    OR (s.status = 'failed' AND s.attempts >= ${MAX_EMBED_ATTEMPTS})
                )
          )
        ORDER BY mfi.media_item_id
        LIMIT ${limit}
    `;
}

/** Abort-aware sleep used to back off between fruitless drain rounds. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}

/**
 * Upsert a vector embedding for a track.
 * Uses ON CONFLICT to update an existing row (idempotent).
 *
 * When `basis` is available (the fit task has produced one — see
 * `music-embedding-projection-fit.ts`), also stamps the quantized download-pool
 * projection in the same write, so a freshly embedded track never has to wait
 * for the separate backfill sweep. `basis` is loaded ONCE per task run (see
 * `execute`/`processItems` below), never re-fit here — this function only
 * ever APPLIES a basis handed to it; see `quantize.ts`'s module docstring for
 * why fit and apply must never share a call site.
 */
async function upsertEmbedding(
    sql: postgres.Sql,
    mediaId: string,
    embedding: number[],
    basis: ProjectionBasis | null,
): Promise<void> {
    const vector = `[${embedding.join(',')}]`;
    const projectedVector = basis ? int8VectorToBuffer(projectAndQuantize(embedding, basis)) : null;
    const projectionVersion = basis ? basis.version : null;
    await sql`
        INSERT INTO media_audio_embeddings
            (media_id, model_id, embedding, projection_version, projected_vector, created_at)
        VALUES (
            ${mediaId}::uuid, ${SONIC_MODEL_ID}, ${vector}::vector,
            ${projectionVersion}, ${projectedVector}, now()
        )
        ON CONFLICT (media_id, model_id)
        DO UPDATE SET embedding = EXCLUDED.embedding,
                      projection_version = EXCLUDED.projection_version,
                      projected_vector = EXCLUDED.projected_vector,
                      created_at = EXCLUDED.created_at
    `;
}

/**
 * Upsert a processing state row for a track.
 *
 * `attempts` counts CONSECUTIVE failures and is what
 * `MAX_EMBED_ATTEMPTS` is measured against. A failure increments it; a
 * success resets it to 0, so a file that is repaired and re-embedded starts
 * from a clean slate and an intermittent sidecar hiccup never accumulates
 * toward the give-up threshold across months.
 */
async function upsertState(
    sql: postgres.Sql,
    mediaId: string,
    status: 'done' | 'failed',
): Promise<void> {
    await sql`
        INSERT INTO media_audio_embedding_state
            (media_id, model_id, status, processing_version, attempts, updated_at)
        VALUES
            (${mediaId}::uuid, ${SONIC_MODEL_ID}, ${status}, 1,
             ${status === 'failed' ? 1 : 0}, now())
        ON CONFLICT (media_id, model_id)
        DO UPDATE SET status     = EXCLUDED.status,
                      attempts   = CASE
                                       WHEN EXCLUDED.status = 'failed'
                                       THEN media_audio_embedding_state.attempts + 1
                                       ELSE 0
                                   END,
                      updated_at = EXCLUDED.updated_at
    `;
}

/**
 * A track the backfill would embed if both install gates were open: a present
 * file, and no `done` or written-off embedding state. Shared by
 * `eligibility.sql` and the gate predicates, so a predicate never claims a row
 * the eligibility dispose would mark 'ineligible' anyway.
 */
function embeddableTrackSql(sql: postgres.Sql): ReturnType<postgres.Sql> {
    return sql`
        EXISTS (
            SELECT 1 FROM media_file_items mfi
              JOIN media_files mf ON mf.id = mfi.file_id
             WHERE mfi.media_item_id = mi.id
               AND mf.file_path IS NOT NULL
               AND NOT mf.is_missing
        )
        AND NOT EXISTS (
            SELECT 1
            FROM media_audio_embedding_state s
            WHERE s.media_id = mi.id
              AND s.model_id = 'msclap-2023'
              AND (
                  s.status = 'done'
                  -- Same write-off rule as fetchPendingTracks. The stage sweep is
                  -- a SECOND door into the same work: capping retries only in the
                  -- drain loop would leave an undecodable track being re-enqueued
                  -- here forever instead.
                  OR (s.status = 'failed' AND s.attempts >= ${MAX_EMBED_ATTEMPTS})
              )
        )
    `;
}

// ============================================================================
// Task definition
// ============================================================================

export const sonicEmbeddingBackfillTask = defineTask<BackfillInput, BackfillResult>({
    id: 'sonic-embedding-backfill',
    purpose: 'music-ai',
    confirmBeforeRun: true,
    name: 'Sonic Embedding Backfill',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    // Scheduled sweep: drains the backlog via the sidecar every 2 hours when
    // features.sonicEmbeddings is on. The execute() body no-ops when the
    // feature is off, so the schedule is effectively inactive until the flag
    // is enabled. Can also be triggered manually at any time.
    schedule: {
        every: '2h',
        runOnStartup: false,
    },

    // GPU-bound: the 'embedding' class (minutes-scale embedders) with a
    // per-task quota of 1 so only one sonic backfill runs at a time, without
    // starving other embedders. NOT 'analysis' (chromaprint/Essentia — 30h
    // starvation precedent), reserved for hour-scale CPU jobs.
    resourceClass: 'embedding',
    quotas: { maxConcurrent: 1 },

    scope: 'global',
    identityFor: () => 'global',

    inputSchema,

    // Incremental embedding: when new track files are attached, processItems
    // embeds them immediately via the sidecar (warm model, no cold-start).
    // preserveCompletedOn: ['file.attached'] avoids re-embedding already-done
    // tracks when a file re-attaches (e.g., alternate file path added).
    coversStages: [
        {
            id: 'sonic-embedding-backfill',
            appliesTo: ['track'] as const,
            // 🔴 The install gates belong HERE, not only in `execute()`. This is a
            // GLOBAL-identity task, so the early return in execute() writes nothing
            // and every seeded track row stayed `pending` forever — counted as
            // remaining work, so the admin drawer said "your library is being
            // processed" indefinitely on every install without the sonic sidecar
            // (all arm64 hosts: the sidecar image is amd64-only). Same hole and same
            // fix as trickplay-generation and music-analysis.
            //
            // Two gates, each with its own predicate below so the Ingest Map can
            // tell "you turned this off" from "this install has no embedder":
            //   - `features.sonicEmbeddings` (live config getter);
            //   - `isSonicEngineConfigured()` — a sidecar URL, or the subprocess
            //     interpreter + script. A sidecar that is DOWN still counts as
            //     configured: that is transient and the drain's backoff owns it.
            // Both are read INSIDE the builders the sweep calls every tick, so no
            // event is needed in either direction. A gate closing disposes on the
            // next tick; a gate opening re-enrols once the heal's per-stage quiet
            // window has lapsed (armed while the heal finds nothing,
            // PER_STAGE_HEAL_QUIET_MS), then up to `healLimit` rows per tick.
            eligibility: {
                sql: (sql) => sql`
                    ${features.sonicEmbeddings ? sql`true` : sql`false`}
                    AND ${isSonicEngineConfigured() ? sql`true` : sql`false`}
                    AND ${embeddableTrackSql(sql)}
                `,
                // The reasons the predicates below stamp. Listing them is what makes
                // opening a gate self-healing: the sweep's heal re-runs
                // `eligibility.sql` every tick and flips these rows back to `pending`
                // once it is TRUE. Without them they would be tombstoned for good —
                // `skipped_permanent` is never re-swept and no pipeline event fires
                // for a config change.
                recoverWhenAdditionalReasons: [SONIC_DISABLED_REASON, SONIC_NO_ENGINE_REASON],
            },
            // One-time bulk re-enrol when a gate opens. Flipping rows to `pending`
            // is cheap; the embedding itself stays bounded by the single-slot drain.
            healLimit: 500,
            invalidatedBy: ['file.attached', 'file.contentChanged', 'file.defaultChanged'] as const,
            preserveCompletedOn: ['file.attached'] as const,
            enqueueable: true,
            terminalDisposition: [
                // Whole-stage facts as predicates, not a `global-guard`: a guard
                // drains to `skipped_transient`, which progress counts as REMAINING,
                // so the bar still could not reach 100%. A closed gate means "not
                // applicable to this install", and `skipped_permanent` is safe only
                // because `eligibility.sql` carries the same gates and reclaims these
                // rows when they open.
                //
                // Each predicate is ANDed with `embeddableTrackSql`, so it only
                // claims rows that would otherwise be embedded. A track that is
                // already embedded, written off or file-less falls through to the
                // eligibility dispose ('ineligible') instead — otherwise it would
                // keep "disabled" after the gate opens, because the heal reclaims
                // only rows whose eligibility is TRUE and theirs never is.
                //
                // Known limit, shared with music-analysis: a row is labelled by the
                // gate that was closed when it was disposed. If that gate opens while
                // the OTHER stays closed, the row keeps the first label until both
                // are open (`skipped_permanent` is not re-swept, and the heal only
                // reclaims rows whose eligibility is TRUE). Status is right
                // throughout; only the reason can lag.
                {
                    kind: 'predicate' as const,
                    ruleId: 'sonic-embeddings-enabled',
                    disposeAs: 'skipped_permanent' as const,
                    reason: SONIC_DISABLED_REASON,
                    excludes: (sql) =>
                        features.sonicEmbeddings ? sql`false` : sql`(${embeddableTrackSql(sql)})`,
                },
                {
                    // Explicitly inert while the feature is off, so a row carries the
                    // reason the operator can act on first.
                    kind: 'predicate' as const,
                    ruleId: 'sonic-engine-configured',
                    disposeAs: 'skipped_permanent' as const,
                    reason: SONIC_NO_ENGINE_REASON,
                    excludes: (sql) =>
                        features.sonicEmbeddings && !isSonicEngineConfigured()
                            ? sql`(${embeddableTrackSql(sql)})`
                            : sql`false`,
                },
            ],
        },
    ],

    timeout: { hard: '12h', soft: '11h' },

    settings: {
        fields: [SONIC_CPU_THREADS_FIELD_DEF],
    },

    async execute(ctx) {
        const { sql: rawSql, signal, reportProgress, logger: ctxLogger } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        // Feature gate — no-op when sonicEmbeddings is off.
        if (!features.sonicEmbeddings) {
            ctxLogger.info('sonicEmbeddings feature is disabled — backfill is a no-op');
            return {
                success: true,
                itemsProcessed: 0,
                result: { embedded: 0, failed: 0, skipped: 0 },
            };
        }
        // No embedder at all: running would fail every track and, after
        // MAX_EMBED_ATTEMPTS runs, write the whole library off as undecodable —
        // stranding it even once a sidecar is added. The stage predicate has
        // already marked the rows not-applicable.
        if (!isSonicEngineConfigured()) {
            ctxLogger.info('No sonic embedder configured — backfill is a no-op');
            return {
                success: true,
                itemsProcessed: 0,
                result: { embedded: 0, failed: 0, skipped: 0 },
            };
        }

        // Read per-task cpuThreads setting (0 / absent → sidecar default ~half cores).
        const taskSettings = await ctx.settings();
        const cpuThreads = parseCpuThreadsSetting(taskSettings.cpuThreads);

        // Loaded ONCE for the whole run, not per track — this is an APPLY, never
        // a fit (see music-embedding-projection-fit.ts). null until an operator
        // has manually triggered that task and it has produced a basis; every
        // upsert below degrades to a null projected_vector until then.
        const projectionBasis = await getActiveProjectionBasis(sql, SONIC_MODEL_ID);

        let embedded = 0;
        // Distinct media that ended in a failed state — a Set, not a counter, so a row
        // that fails on a cold round and then succeeds on a warm retry isn't counted as
        // a failure (and the same row re-attempted across rounds isn't double-counted).
        const failedIds = new Set<string>();
        let skipped = 0;
        let totalProcessed = 0;
        let consecutiveNoProgress = 0;
        // Set when embedPaths() itself throws (sidecar down / process crash) —
        // as opposed to the sidecar responding with per-track failures, which
        // is handled separately by the no-progress backoff below. A thrown
        // embedPaths error means the run made no reliable progress and must
        // not be reported as a green 'completed' run (see throw below).
        let embedderCrashed: unknown = undefined;
        // Set when the sidecar's memory gate stayed full (HTTP 429) for longer than
        // embedPaths waits. Not a failure: the run stores what it got and ends; the
        // rest stays eligible for the next run, with no attempt charged.
        let sidecarBusy: SonicBusyError | undefined;

        // Crash suspects set aside for this run because the sidecar was not
        // confirmed ready; excluded from later fetches so the drain moves past them.
        const deferredSuspects = new Set<string>();

        ctxLogger.info('Starting sonic embedding backfill', {
            model: SONIC_MODEL_ID,
            drainChunkSize: DRAIN_CHUNK_SIZE,
            cpuThreads: cpuThreads ?? 'sidecar-default',
        });

        // Drain loop: fetch a chunk → embedPaths (honours config.SONIC_EMBEDDER_BATCH_SIZE
        // for Python sub-batching) → write state → repeat until empty or aborted.
        while (!signal.aborted) {
            await backgroundCpuCheckpoint();
            const tracks = await fetchPendingTracks(sql, DRAIN_CHUNK_SIZE, [...deferredSuspects]);

            if (tracks.length === 0) {
                ctxLogger.info('No more tracks to embed — drain complete');
                break;
            }

            type EmbedOutcome = Awaited<ReturnType<typeof embedPaths>>[number];
            const results: EmbedOutcome[] = [];
            // Suspects whose single-file call took the embedder down: charged
            // below like any failure, and kept as suspects for the next run.
            const crashedSuspects = new Set<string>();

            // 1. Crash suspects first (sidecar mode), one file at a time, each
            //    behind a readiness check — see sonic-crash-suspects.ts. Ready
            //    before, down during a call with ONE file in it: a strike for that
            //    file; from its second strike on, a charged attempt.
            const sidecarMode = Boolean(config.SONIC_EMBEDDER_URL);
            const suspects = sidecarMode ? await loadCrashSuspects() : new Set<string>();
            let suspectTracks = tracks.filter((t) => suspects.has(t.media_item_id));
            if (suspectTracks.length > 0 && !(await isSonicEmbedderReady())) {
                // Leave them for a run where the sidecar answers; the rest of the
                // chunk still goes out below (a real outage fails it there).
                logger.info('Sidecar not confirmed ready; crash suspects wait for the next run', {
                    suspects: suspectTracks.length,
                });
                for (const t of suspectTracks) deferredSuspects.add(t.media_item_id);
                suspectTracks = [];
            }
            for (const [i, track] of suspectTracks.entries()) {
                if (signal.aborted) break;
                // The first one was checked just above.
                if (i > 0 && !(await isSonicEmbedderReady())) {
                    embedderCrashed = new SonicEngineError(
                        'The sidecar stopped answering between crash suspects',
                    );
                    break;
                }
                try {
                    results.push(...(await embedPaths([track.file_path], cpuThreads, signal)));
                } catch (err) {
                    if (err instanceof SonicBusyError) {
                        // Busy says nothing about this suspect: no strike.
                        sidecarBusy = err;
                        results.push(...err.partial);
                        break;
                    }
                    embedderCrashed = err;
                    if (!(err instanceof SonicEngineError)) break;
                    logger.warn('The sidecar went down while embedding a crash suspect alone', {
                        mediaId: track.media_item_id,
                        error: err.message,
                    });
                    crashedSuspects.add(track.media_item_id);
                    if (await strikeCrashSuspect(track.media_item_id)) {
                        // Not its first time: charged like any per-file failure.
                        results.push({
                            path: track.file_path,
                            error: `The embedder went down while processing this file on its own: ${err.message}`,
                        });
                    }
                    break;
                }
            }
            const suspectsTried = new Set(suspectTracks.map((t) => t.media_item_id));

            // 2. Everything else as one batch, unless the embedder already failed.
            const restTracks = tracks.filter((t) => !suspects.has(t.media_item_id));
            // Suspects that waited (sidecar not confirmed ready) stay out of the batch
            // too: re-batching them is exactly what took the sidecar down before.
            if (
                embedderCrashed === undefined &&
                sidecarBusy === undefined &&
                restTracks.length > 0 &&
                !signal.aborted
            ) {
                try {
                    // embedPaths handles sub-batching according to config.SONIC_EMBEDDER_BATCH_SIZE,
                    // ensuring the operator-configured batch size is always honoured even when we
                    // fetch a larger chunk from the DB.
                    results.push(
                        ...(await embedPaths(
                            restTracks.map((t) => t.file_path),
                            cpuThreads,
                            signal,
                        )),
                    );
                } catch (err) {
                    if (err instanceof SonicBusyError) {
                        // Busy for longer than embedPaths waits: keep what the earlier
                        // batches embedded, charge nothing, mark no suspects.
                        sidecarBusy = err;
                        results.push(...err.partial);
                    } else {
                        // The embedder itself failed (SonicEngineError: unreachable, could
                        // not start, could not load the model) — log and bail. No per-track
                        // state is written, so an outage never counts toward a track's
                        // write-off; tracks stay eligible for the next run. Captured so the
                        // post-loop check below can throw a TaskError instead of silently
                        // completing this run "green" with 0 embedded — a dead embedder
                        // must be visible to the circuit breaker.
                        logger.error(
                            'embedPaths threw unexpectedly — stopping drain',
                            err instanceof Error ? err : undefined,
                            { chunkSize: restTracks.length },
                        );
                        embedderCrashed = err;
                        // Batches that completed before the failure are stored below.
                        // The tracks it had not finished become crash suspects: if one of
                        // them is what brought the embedder down, the next run finds it.
                        const partial = err instanceof SonicEngineError ? err.partial : [];
                        results.push(...partial);
                        // Only the request that was in flight can have caused it.
                        if (sidecarMode && err instanceof SonicEngineError) {
                            const inFlight = new Set(err.inFlight);
                            await markCrashSuspects(
                                restTracks
                                    .filter((t) => inFlight.has(t.file_path))
                                    .map((t) => t.media_item_id),
                            );
                        }
                    }
                }
            }
            if (
                results.length === 0 &&
                (embedderCrashed !== undefined || sidecarBusy !== undefined)
            ) {
                break;
            }
            // A chunk of nothing but deferred suspects is not "no progress": fetch on.
            if (results.length === 0 && restTracks.length === 0 && suspectTracks.length === 0) {
                continue;
            }

            // Map path → media_item_id for DB writes.
            const pathToId = new Map(tracks.map((t) => [t.file_path, t.media_item_id]));

            let embeddedThisChunk = 0;
            for (const result of results) {
                if (signal.aborted) break;

                const mediaId = pathToId.get(result.path);
                if (!mediaId) {
                    // Shouldn't happen, but guard defensively.
                    skipped++;
                    continue;
                }

                if (isEmbedSuccess(result)) {
                    try {
                        await upsertEmbedding(sql, mediaId, result.embedding, projectionBasis);
                        await upsertState(sql, mediaId, 'done');
                        embedded++;
                        embeddedThisChunk++;
                        failedIds.delete(mediaId); // cleared a prior cold-round failure
                        // Clear the durable audit rows too, not just the
                        // in-run set. This is a BATCH task, so it never goes
                        // through wrapExecute's per-item markCompleted — the
                        // runner has no other way to learn that this item
                        // recovered, and plugin_failure_events is append-only.
                        // Without it a track that succeeds after a sidecar
                        // outage keeps every row it wrote while the sidecar
                        // was down, forever, on the operator's board.
                        await ctx.reportSuccess(mediaId);
                    } catch (dbErr) {
                        logger.warn('Failed to write embedding to DB', {
                            mediaId,
                            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
                        });
                        // Don't write 'failed' state — leave the row eligible so next
                        // run retries. The DB error may be transient.
                        skipped++;
                    }
                } else {
                    // Python CLI reported an error for this path.
                    logger.warn('Embedder reported failure for track', {
                        mediaId,
                        error: result.error,
                    });
                    // Count a track's failure once per RUN, not once per drain round. The
                    // no-progress loop re-selects still-eligible rows up to
                    // MAX_NO_PROGRESS_ROUNDS times, so counting every round let ONE run with
                    // the sidecar unreachable (every path fails with "fetch failed") push the
                    // whole library past MAX_EMBED_ATTEMPTS and write it off for good.
                    if (!failedIds.has(mediaId)) {
                        try {
                            await upsertState(sql, mediaId, 'failed');
                        } catch {
                            // Best-effort — ignore DB write failures for failed rows.
                        }
                    }
                    // Persist the real Python error string (previously discarded
                    // entirely — media_audio_embedding_state has no reason column)
                    // into the shared plugin_failure_events table so the admin
                    // failure-timeline surface has something to show for embedder
                    // failures. Best-effort by design (ctx.reportFailure swallows
                    // its own DB errors); never let a failed audit write mask the
                    // real embedder failure above.
                    //
                    // Gated on failedIds.has(mediaId): fetchPendingTracks only
                    // excludes status='done', so a row written 'failed' stays
                    // eligible and gets re-selected on every subsequent drain
                    // round until it (or the tracks above it in id order) finish
                    // — without this guard the same track writes one near-
                    // identical audit row per round for the rest of the run.
                    if (!failedIds.has(mediaId)) {
                        try {
                            await ctx.reportFailure(mediaId, sanitizeFailureReason(result.error), {
                                modelId: SONIC_MODEL_ID,
                            });
                        } catch {
                            // Best-effort — audit trail only.
                        }
                    }
                    failedIds.add(mediaId);
                }

                totalProcessed++;
                // Report progress without blocking; approximate total unknown.
                reportProgress(totalProcessed, totalProcessed + tracks.length, result.path);
            }

            // A suspect that produced a real answer (embedded, or a per-file
            // failure) is cleared; one that took the embedder down again stays.
            await clearCrashSuspects(
                tracks
                    .filter((t) => suspectsTried.has(t.media_item_id))
                    .filter((t) => !crashedSuspects.has(t.media_item_id))
                    .filter((t) => results.some((r) => r.path === t.file_path))
                    .map((t) => t.media_item_id),
            );

            ctxLogger.info('Chunk complete', {
                chunkSize: tracks.length,
                embedded,
                embeddedThisChunk,
                failed: failedIds.size,
                skipped,
            });

            // The embedder failed part-way: what it finished is stored, stop here.
            if (embedderCrashed !== undefined) break;
            if (sidecarBusy !== undefined) {
                ctxLogger.info(
                    'Sonic sidecar busy, or the run stopped while waiting; ending this run',
                    {
                        embedded,
                        error: sidecarBusy.message,
                    },
                );
                break;
            }

            // Spin guard: a chunk that embedded nothing means the sidecar is likely
            // unavailable (cold CLAP model, network blip). Re-fetching would just
            // re-attempt the same still-eligible rows, so pace the retry and bail after
            // a few fruitless rounds — the scheduled sweep / next manual run retries.
            if (embeddedThisChunk === 0) {
                consecutiveNoProgress++;
                if (consecutiveNoProgress >= MAX_NO_PROGRESS_ROUNDS) {
                    ctxLogger.warn(
                        'Sonic backfill made no progress for several rounds — embedder likely unavailable; stopping (will retry on next scheduled/manual run)',
                        { rounds: consecutiveNoProgress },
                    );
                    break;
                }
                await sleep(NO_PROGRESS_BACKOFF_MS, signal);
            } else {
                consecutiveNoProgress = 0;
            }
        }

        const failed = failedIds.size;
        const message =
            `Sonic backfill: ${embedded} embedded, ${failed} failed, ${skipped} skipped` +
            (sidecarBusy !== undefined && !signal.aborted
                ? ' (stopped early: sidecar busy, the rest waits for the next run)'
                : '');
        ctxLogger.info(message);

        // embedPaths threw and the loop bailed out — unless the run was
        // cancelled by the operator (aborted path unchanged: that's a clean
        // stop, not an error), this must surface as a real failure. A normal
        // `return` here — even with `success: false` — is invisible to the
        // runner's bookkeeping (the run still records 'completed'), which is
        // exactly how a dead sidecar produced silent "0 embedded" green runs
        // forever. Throwing a transient TaskError makes the run 'failed',
        // lets it retry, and lets the circuit breaker see the sick sidecar.
        // Partial progress (embedded/failed > 0 before the crash) is folded
        // into the thrown message so the breaker/operator can see it — it's
        // still a failed run, just not a total wipeout.
        if (embedderCrashed !== undefined && !signal.aborted) {
            const errMsg =
                embedderCrashed instanceof Error
                    ? embedderCrashed.message
                    : String(embedderCrashed);
            const progressNote =
                embedded > 0 || failed > 0
                    ? ` (partial progress before failure: ${embedded} embedded, ${failed} failed, ${skipped} skipped)`
                    : '';
            throw new TaskError({
                message: `Sonic embedding backfill: the embedder is unavailable: ${errMsg}${progressNote}`,
                kind: 'transient',
                cause: embedderCrashed,
            });
        }

        return {
            success: true,
            itemsProcessed: embedded,
            result: { embedded, failed, skipped },
            message,
        };
    },

    /**
     * Backlog — required by the SDK when processItems is declared. Reports the
     * number of unembedded tracks (pending + failed) visible in the admin UI.
     * The `compute` method returns an empty slice because the scheduled sweep
     * in `execute()` drives the actual drain loop; backlog.compute is not used
     * for pagination here.
     */
    backlog: {
        unitLabel: 'tracks',
        sliceSize: DRAIN_CHUNK_SIZE,
        // Nominal: backlog.compute is a no-op here (execute() drives the drain
        // loop), so this slice budget is never consumed for pagination. Present
        // only to satisfy the SDK's required duration field.
        softBudget: '1s',
        idOf: (row) => {
            const r = row as { media_item_id?: string } | null | undefined;
            return r?.media_item_id ?? String(r);
        },
        async stages(ctx: TaskContext): Promise<BacklogStage[]> {
            const sql = ctx.sql as unknown as postgres.Sql;
            const [pending, failed] = await Promise.all([
                sql<[{ count: number }]>`
                    SELECT COUNT(DISTINCT mfi.media_item_id)::int AS count
                    FROM media_file_items mfi
                    JOIN media_files mf ON mf.id = mfi.file_id
                    JOIN media_items mi ON mi.id = mfi.media_item_id
                    WHERE mi.media_type = 'track'
                      AND mf.file_path IS NOT NULL
                      AND NOT mf.is_missing
                      AND NOT EXISTS (
                          SELECT 1 FROM media_audio_embedding_state s
                          WHERE s.media_id = mfi.media_item_id
                            AND s.model_id = ${SONIC_MODEL_ID}
                            AND s.status   = 'done'
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM media_audio_embedding_state s
                          WHERE s.media_id = mfi.media_item_id
                            AND s.model_id = ${SONIC_MODEL_ID}
                            AND s.status   = 'failed'
                      )
                `,
                sql<[{ count: number }]>`
                    SELECT COUNT(*)::int AS count
                    FROM media_audio_embedding_state
                    WHERE model_id = ${SONIC_MODEL_ID}
                      AND status   = 'failed'
                `,
            ]);
            const stages: BacklogStage[] = [];
            const pendingCount = pending[0]?.count ?? 0;
            const failedCount = failed[0]?.count ?? 0;
            if (pendingCount > 0) {
                stages.push({ id: 'pending', label: 'Pending', count: pendingCount });
            }
            if (failedCount > 0) {
                stages.push({ id: 'failed', label: 'Failed', count: failedCount });
            }
            return stages;
        },
        async compute(): Promise<{ items: unknown[]; remainingHint?: number }> {
            // Not used for pagination — execute() drives the drain loop directly.
            return { items: [], remainingHint: 0 };
        },
    },

    /**
     * Incremental embedding — called by the task runner when new track files
     * are attached (file.attached / file.contentChanged / file.defaultChanged
     * events declared in coversStages[].invalidatedBy).
     *
     * Mirrors the processItems pattern from music-analysis.ts:
     *   1. Filter items to tracks with a filePath.
     *   2. Guard feature flag.
     *   3. Call embedPaths for each track (sequential — one track per call to
     *      avoid OOM on the GPU worker and to keep abort-checking cheap).
     *   4. Write upsertEmbedding + upsertState('done') on success,
     *      upsertState('failed') on embedder-reported failure.
     *   5. Leave the track eligible (no state write) on a DB error so the next
     *      scheduled sweep retries.
     */
    async processItems(ctx: TaskContext, items: unknown[]): Promise<void> {
        const tracks = (items as NewMediaItem[]).filter(
            (i) =>
                i.mediaType === 'track' && typeof i.filePath === 'string' && i.filePath.length > 0,
        );
        if (tracks.length === 0) return;

        // Feature gate — same as execute().
        if (!features.sonicEmbeddings) {
            ctx.logger.info('sonicEmbeddings feature is disabled — skipping incremental embedding');
            return;
        }
        if (!isSonicEngineConfigured()) {
            ctx.logger.info('No sonic embedder configured — skipping incremental embedding');
            return;
        }

        const sql = ctx.sql as unknown as postgres.Sql;
        const signal = ctx.signal;
        const reportProgress = ctx.reportProgress;

        // Read cpuThreads from task settings (same as execute() — may differ per
        // operator configuration but is constant per run invocation).
        let cpuThreads: number | undefined;
        try {
            const taskSettings = await ctx.settings();
            cpuThreads = parseCpuThreadsSetting(taskSettings.cpuThreads);
        } catch {
            // settings() may not be available in all invocation contexts
            // (e.g., stage-sweep triggered runs). Fall back to sidecar default.
        }

        ctx.logger.info('Incremental sonic embedding: processing new tracks', {
            count: tracks.length,
            cpuThreads: cpuThreads ?? 'sidecar-default',
        });

        // Abort check BEFORE any DB work (including the basis load below) — an
        // already-aborted signal must result in zero `sql` calls, matching
        // execute()'s equivalent early-return contract.
        if (signal.aborted) return;

        // Loaded once per invocation — see the equivalent comment in execute().
        const projectionBasis = await getActiveProjectionBasis(sql, SONIC_MODEL_ID);

        let embedded = 0;
        let failed = 0;

        for (const track of tracks) {
            if (signal.aborted) break;

            // filePath guaranteed non-empty by the filter above.
            const filePath = track.filePath!;

            let results;
            try {
                results = await embedPaths([filePath], cpuThreads);
            } catch (err) {
                logger.warn('embedPaths threw during incremental embedding', {
                    id: track.id,
                    error: err instanceof Error ? err.message : String(err),
                });
                // Leave the track eligible — no state write; next sweep retries.
                // The embedder itself is down: every remaining track would fail
                // the same way, so stop instead of spawning it once per track.
                // Not marked as a crash suspect here: without a readiness check
                // before the call, an outage would flag every track ingested
                // during it. If this file is the cause, the backfill's batch
                // finds it (see sonic-crash-suspects.ts).
                if (err instanceof SonicEngineError) break;
                continue;
            }

            const result = results[0];
            if (!result) {
                // Defensive: embedPaths should always return one result per path.
                logger.warn('embedPaths returned no result for path (incremental)', {
                    id: track.id,
                    filePath,
                });
                continue;
            }

            if (isEmbedSuccess(result)) {
                try {
                    await upsertEmbedding(sql, track.id, result.embedding, projectionBasis);
                    await upsertState(sql, track.id, 'done');
                    embedded++;
                    // Same as the drain loop: a batch task must clear its own
                    // audit rows, nothing upstream does it for us.
                    await ctx.reportSuccess(track.id);
                } catch (dbErr) {
                    logger.warn('Failed to write incremental embedding to DB', {
                        id: track.id,
                        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
                    });
                    // Don't write 'failed' state — DB error may be transient;
                    // leave eligible for next sweep.
                }
            } else {
                logger.warn('Embedder reported failure for track (incremental)', {
                    id: track.id,
                    error: result.error,
                });
                try {
                    await upsertState(sql, track.id, 'failed');
                } catch {
                    // Best-effort — ignore DB write failures for failed rows.
                }
                // Same audit write as the batch drain loop — see comment there.
                // (No per-round dedup needed here: each item in `tracks` is
                // processed exactly once per processItems() invocation.)
                try {
                    await ctx.reportFailure(track.id, sanitizeFailureReason(result.error), {
                        modelId: SONIC_MODEL_ID,
                    });
                } catch {
                    // Best-effort — ignore DB write failures for failed rows.
                }
                failed++;
            }

            reportProgress(embedded + failed, tracks.length, filePath.split('/').pop());
        }

        ctx.logger.info('Incremental sonic embedding complete', {
            embedded,
            failed,
            total: tracks.length,
        });
    },

    /**
     * Per-item retry — what makes `MAX_EMBED_ATTEMPTS` a pause rather than a
     * dead end.
     *
     * Only `retry` is declared, not `list`: the generic
     * `GET /tasks/{id}/failures` reads `plugin_failure_events` directly and
     * already lists this task's failed items correctly. What was missing is the
     * action next to them — `POST /tasks/{id}/failures/{itemId}/retry` 400s
     * with "does not support per-item retry" unless the task declares this
     * hook, so before the attempt cap existed there was no way to ask for one
     * more try, and after it there would have been no way to come back from a
     * write-off at all. An operator who repairs a file needs exactly this.
     *
     * Runs the embed inline (one track, one sidecar call) rather than
     * enqueueing a run: the endpoint reports per-item success back to the
     * operator, and a queued run could not answer that question.
     */
    failures: {
        /**
         * Tracks the embedder currently cannot read.
         *
         * Reads `media_audio_embedding_state`, not `plugin_failure_events`.
         * The generic endpoint's default source is an append-only log, which
         * for a task that re-attempts on a two-hourly schedule reports one row
         * per attempt rather than one per item — on prod 2026-09-11 that was
         * 1,179 rows for FOUR items. The state table holds exactly one row per
         * track and answers "is this broken NOW", which is what the tab asks.
         * The event log is still the source of `firstSeen` / `failureCount` /
         * `lastSeen`, where per-attempt history is the right answer.
         */
        async list(
            ctx: TaskContext,
            opts: { limit: number; offset: number },
        ): Promise<{ items: SdkFailedItem[]; total: number }> {
            const limit = Math.min(100, Math.max(1, opts.limit));
            const offset = Math.max(0, opts.offset);
            const sql = ctx.sql as unknown as postgres.Sql;

            const [{ count }] = await sql<[{ count: number }]>`
                SELECT COUNT(*)::int AS count
                FROM media_audio_embedding_state
                WHERE model_id = ${SONIC_MODEL_ID}
                  AND status   = 'failed'
            `;

            const rows = await sql<
                Array<{
                    id: string;
                    title: string;
                    attempts: number;
                    updated_at: Date;
                }>
            >`
                SELECT mi.id::text AS id, mi.title, s.attempts, s.updated_at
                FROM media_audio_embedding_state s
                JOIN media_items mi ON mi.id = s.media_id
                WHERE s.model_id = ${SONIC_MODEL_ID}
                  AND s.status   = 'failed'
                ORDER BY s.updated_at DESC
                LIMIT ${limit} OFFSET ${offset}
            `;

            let aggregates = new Map<string, FailureAggregateRow>();
            try {
                aggregates = await getFailureAggregates(
                    sql,
                    'sonic-embedding-backfill',
                    rows.map((r) => r.id),
                );
            } catch (err) {
                logger.warn('Failure-aggregate fetch failed — listing without timeline counts', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            return {
                total: count,
                items: rows.map((r) => {
                    const agg = aggregates.get(r.id);
                    return {
                        id: r.id,
                        label: r.title,
                        // The per-attempt reason lives on the event log, which
                        // the timeline already shows. What this row adds is
                        // whether the item is still being tried at all.
                        reason:
                            r.attempts >= MAX_EMBED_ATTEMPTS
                                ? `Embedding failed ${r.attempts}× — no longer retried automatically; use Retry after fixing the file`
                                : `Embedding failed (attempt ${r.attempts} of ${MAX_EMBED_ATTEMPTS})`,
                        detectedAt: r.updated_at.toISOString(),
                        ...(agg && {
                            firstSeen: agg.first_seen.toISOString(),
                            failureCount: agg.failure_count,
                            lastSeen: agg.last_seen.toISOString(),
                        }),
                    };
                }),
            };
        },

        async retry(ctx: TaskContext, itemId: string): Promise<void> {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
                throw new Error('Invalid track id (expected UUID)');
            }
            const sql = ctx.sql as unknown as postgres.Sql;

            const [track] = await sql<Array<{ file_path: string | null }>>`
                SELECT (ARRAY_AGG(mf.file_path ORDER BY mf.id))[1] AS file_path
                FROM media_items mi
                JOIN media_file_items mfi ON mfi.media_item_id = mi.id
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mi.id = ${itemId}::uuid
                  AND mi.media_type = 'track'
                  AND mf.file_path IS NOT NULL
                  AND NOT mf.is_missing
                GROUP BY mi.id
            `;
            if (!track?.file_path) {
                throw new Error(`Track or file not found (id=${itemId})`);
            }

            // Same defensive read as processItems(): the admin retry path builds
            // its context via buildPluginContext, where settings() may not be
            // wired. Fall back to the sidecar default rather than failing a
            // retry over a configuration read.
            let cpuThreads: number | undefined;
            try {
                const taskSettings = await ctx.settings();
                cpuThreads = parseCpuThreadsSetting(taskSettings.cpuThreads);
            } catch {
                // Sidecar default.
            }

            let results: Awaited<ReturnType<typeof embedPaths>>;
            try {
                results = await embedPaths([track.file_path], cpuThreads);
            } catch (err) {
                // The embedder is down, which says nothing about this track: no
                // attempt is counted, and the message is sanitised like any other
                // failure reason (it can name the sidecar host).
                if (err instanceof SonicEngineError) {
                    throw new TaskError({
                        message: `Embedder unavailable: ${sanitizeFailureReason(err.message)}`,
                        kind: 'transient',
                        cause: err,
                    });
                }
                throw err;
            }
            const result = results[0];
            if (!result) {
                throw new Error('Embedder returned no result for the track');
            }

            if (!isEmbedSuccess(result)) {
                // Write the failure through the normal path so the attempt
                // counter advances. A retry that fails is still an attempt —
                // not counting it would let an operator with a retry loop
                // defeat the cap this hook exists to make recoverable.
                await upsertState(sql, itemId, 'failed');
                throw new Error(sanitizeFailureReason(result.error));
            }

            const projectionBasis = await getActiveProjectionBasis(sql, SONIC_MODEL_ID);
            await upsertEmbedding(sql, itemId, result.embedding, projectionBasis);
            // Resets `attempts` to 0 — see upsertState. The endpoint stamps
            // `resolved_at` on the failure rows itself once this returns.
            await upsertState(sql, itemId, 'done');
        },
    },
});

// Self-register into the singleton registry (mirrors music-analysis.ts pattern).
registry.registerTask(sonicEmbeddingBackfillTask);
