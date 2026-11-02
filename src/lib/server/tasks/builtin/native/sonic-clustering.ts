// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic Clustering Task
 *
 * Background task that assigns KMeans cluster labels to all tracks that have
 * MSCLAP audio embeddings (media_audio_embeddings, model_id='msclap-2023'),
 * then stores the assignments in media_audio_clusters.
 *
 * Pipeline:
 *   1. Spawn cluster.py with DATABASE_URL (reads embeddings directly via psycopg2).
 *   2. Parse JSONL output: { media_id, cluster_id } per line.
 *   3. Map the raw KMeans indices to STABLE ids: each new cluster keeps the id
 *      of the previous cluster it overlaps most, the rest get never-used ids
 *      (audio-cluster-id-matching.ts, registry table audio_cluster_ids).
 *   4. Clear stale assignments for model 'msclap-2023'.
 *   5. Bulk-upsert fresh assignments in batches.
 *
 * Gating:
 *   - No-ops when features.musicClusters is false.
 *   - Manual-start only (no automatic schedule).
 *
 * Resource class:
 *   'analysis' with quotas.maxConcurrent=1 — KMeans over large embedding
 *   matrices is CPU-bound and can take many minutes. Serialises runs without
 *   starving other resource classes.
 */

import { warmMusicCollages } from '$lib/server/services/music/collage-warmup.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { features, config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { registry } from '../../registry.js';
import {
    upsertClusterAssignments,
    getClusters,
    clearClusterAssignments,
    countClusterAssignments,
    getClusterAssignmentMap,
    getHighestIssuedClusterId,
    recordIssuedClusterIds,
    CLUSTER_MODEL_ID,
    type ClusterAssignmentInput,
} from '$lib/server/database/queries/audio-clusters.queries.js';
import {
    parseCpuThreadsSetting,
    SONIC_CPU_THREADS_FIELD_DEF,
    runSonicSubprocess,
    parseNdjsonLines,
} from './sonic-task-shared.js';
import { matchStableClusterIds } from '$lib/server/services/music/audio-cluster-id-matching.js';
import type postgres from 'postgres';

const logger = Logger.for('SonicClustering');

// ============================================================================
// Constants
// ============================================================================

/** Batch size for bulk upsert into media_audio_clusters. */
const UPSERT_BATCH_SIZE = 500;

// ============================================================================
// Schema / types
// ============================================================================

const inputSchema = z.object({}).passthrough();
type ClusteringInput = z.infer<typeof inputSchema>;

interface ClusteringResult {
    assigned: number;
    parseErrors: number;
    clusters: number;
}

// ============================================================================
// NDJSON parser (shared by HTTP and subprocess paths)
// ============================================================================

function parseClusteringNdjson(ndjson: string): {
    assignments: ClusterAssignmentInput[];
    parseErrors: number;
} {
    const { records, parseErrors } = parseNdjsonLines(ndjson, (rec) => {
        const mediaId = typeof rec.media_id === 'string' ? rec.media_id : null;
        const clusterId = typeof rec.cluster_id === 'number' ? rec.cluster_id : null;

        if (!mediaId || clusterId === null) {
            return null;
        }

        return { mediaId, clusterId };
    });

    return { assignments: records, parseErrors };
}

// ============================================================================
// Clustering runner
// ============================================================================

/**
 * Run KMeans clustering via HTTP sidecar or subprocess fallback.
 * Returns an array of validated {mediaId, clusterId} pairs.
 *
 * @param databaseUrl Postgres connection string for the subprocess fallback.
 * @param clusterK    Number of KMeans clusters.
 * @param threads     Optional CPU thread cap forwarded to the sidecar or subprocess.
 * @param signal      Optional abort signal for admin-cancel propagation (Bug 3).
 */
async function runClustering(
    databaseUrl: string,
    clusterK: number,
    threads?: number,
    signal?: AbortSignal,
): Promise<{ assignments: ClusterAssignmentInput[]; parseErrors: number }> {
    // --- HTTP sidecar path ---
    const sidecarUrl = config.SONIC_EMBEDDER_URL;
    if (sidecarUrl) {
        logger.debug('Calling sonic-embedder sidecar /cluster', {
            url: sidecarUrl,
            k: clusterK,
        });

        const sidecarBody: Record<string, unknown> = { k: clusterK };
        if (typeof threads === 'number' && threads > 0) {
            sidecarBody.threads = threads;
        }

        // 60-minute timeout — matches the task hard-timeout budget.
        // fetchWithTimeout composes this with ctx.signal (when provided) via
        // AbortSignal.any internally, so an admin Cancel actually aborts the
        // in-flight fetch instead of running to the timeout regardless. It
        // also routes the request through the same-origin-only redirect
        // guard (C22 fix-plan finding) — SONIC_EMBEDDER_URL is an
        // admin-configured host, same class as ABS/Kavita/the arr apps.
        const response = await fetchWithTimeout(
            `${sidecarUrl}/cluster`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sidecarBody),
                signal,
            },
            60 * 60_000,
        );

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(
                `Sonic sidecar /cluster returned ${response.status}: ${body.slice(0, 200)}`,
            );
        }

        const ndjson = await response.text();
        return parseClusteringNdjson(ndjson);
    }

    // --- Subprocess fallback ---
    const pythonBin = config.SONIC_EMBEDDER_PYTHON;
    const scriptPath = config.SONIC_CLUSTER_SCRIPT;

    const stdout = await runSonicSubprocess({
        pythonBin,
        scriptPath,
        extraEnv: {
            DATABASE_URL: databaseUrl,
            MODEL_ID: CLUSTER_MODEL_ID,
            SONIC_CLUSTER_K: String(clusterK),
        },
        threads,
        timeoutMs: 60 * 60_000,
        logLabel: 'KMeans clustering',
        logger,
        signal,
    });

    return parseClusteringNdjson(stdout);
}

// ============================================================================
// Task definition
// ============================================================================

export const sonicClusteringTask = defineTask<ClusteringInput, ClusteringResult>({
    id: 'sonic-clustering',
    purpose: 'music-ai',
    name: 'Sonic Clustering',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    // Auto-runs daily so Sonic Collections stay fresh as the embedding backfill
    // grows — OSS admins don't have to trigger it by hand. The admin "run now"
    // button still works (a schedule does not suppress on-demand triggers).
    schedule: { every: '24h', runOnStartup: false },

    // CPU-bound long job (KMeans over 1024-dim embeddings) → 'analysis' class.
    // maxConcurrent=1 serialises runs so only one clustering pass runs at a time.
    resourceClass: 'analysis',
    quotas: { maxConcurrent: 1 },

    scope: 'global',
    identityFor: () => 'global',

    inputSchema,

    timeout: { hard: '65m', soft: '60m' },

    settings: {
        fields: [SONIC_CPU_THREADS_FIELD_DEF],
    },

    async execute(ctx) {
        const { sql: rawSql, logger: ctxLogger, signal } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        // Feature gate — no-op when musicClusters is off.
        if (!features.musicClusters) {
            ctxLogger.info('musicClusters feature is disabled — clustering is a no-op');
            return {
                success: true,
                itemsProcessed: 0,
                result: { assigned: 0, parseErrors: 0, clusters: 0 },
            };
        }

        // Admin Cancel before any work started — clean stop, not an error.
        if (signal.aborted) {
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted' as const,
                result: { assigned: 0, parseErrors: 0, clusters: 0 },
                message: 'Aborted before starting',
            };
        }

        const databaseUrl = config.DATABASE_URL;
        if (!databaseUrl) {
            // Unreachable in practice — DATABASE_URL is mandatory for the whole
            // app. Keep the guard, but don't emit a misleading "database not
            // configured" ERROR on an instance whose DB obviously works. A
            // normal `return {success:false}` here used to be silently recorded
            // as 'completed' by the runner — throw a permanent TaskError
            // (config problem, retrying won't help) so the run shows failed.
            ctxLogger.warn(
                'sonic-clustering: DATABASE_URL unavailable — skipping (unexpected internal state)',
            );
            throw new TaskError({
                message: 'sonic-clustering: DATABASE_URL unavailable (unexpected internal state)',
                kind: 'permanent',
            });
        }

        // Read per-task cpuThreads setting (0 / absent → sidecar default ~half cores).
        const taskSettings = await ctx.settings();
        const cpuThreads = parseCpuThreadsSetting(taskSettings.cpuThreads);

        const clusterK = config.SONIC_CLUSTER_K;
        ctxLogger.info('Starting sonic clustering', {
            model: CLUSTER_MODEL_ID,
            k: clusterK,
            cpuThreads: cpuThreads ?? 'sidecar-default',
        });

        // Run the Python KMeans script. `signal` threads ctx.signal into the
        // sidecar fetch / subprocess so admin Cancel actually interrupts the
        // run instead of being a no-op until the script's own timeout.
        let assignments: ClusterAssignmentInput[];
        let parseErrors: number;
        try {
            ({ assignments, parseErrors } = await runClustering(
                databaseUrl,
                clusterK,
                cpuThreads,
                signal,
            ));
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            ctxLogger.error('Sonic clustering failed', { error: errMsg });
            // A normal `return {success:false}` here used to be silently
            // recorded 'completed' by the runner. Rethrow as a transient
            // TaskError (sidecar/subprocess failure — worth a retry) so the
            // run is marked failed and the circuit breaker can see it.
            throw new TaskError({
                message: `Sonic clustering failed: ${errMsg}`,
                kind: 'transient',
                cause: err,
            });
        }

        ctxLogger.info('Clustering script complete', {
            assignments: assignments.length,
            parseErrors,
        });

        if (assignments.length === 0) {
            ctxLogger.info('No cluster assignments — skipping DB upsert');
            return {
                success: true,
                itemsProcessed: 0,
                result: { assigned: 0, parseErrors, clusters: 0 },
                message: 'No assignments to store',
            };
        }

        // Between phases (subprocess compute → DB write) — honor a Cancel
        // that fired while the script was running rather than proceeding to
        // write a full batch of stale-cleared-then-upserted data.
        if (signal.aborted) {
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted' as const,
                result: { assigned: 0, parseErrors, clusters: 0 },
                message: 'Aborted after clustering computation, before DB write',
            };
        }

        // Clear stale assignments and bulk-upsert fresh ones inside a single
        // transaction — a mid-loop failure previously left the dataset
        // partially emptied (clear committed, only some batches upserted).
        let upserted = 0;
        let idStats = { kept: 0, issued: 0, retired: 0 };
        await sql.begin(async (tx) => {
            const txSql = tx as unknown as postgres.Sql;

            // Carry ids over BEFORE the clear wipes the previous run.
            const previous = await getClusterAssignmentMap(txSql, CLUSTER_MODEL_ID);
            const highestIssued = await getHighestIssuedClusterId(txSql, CLUSTER_MODEL_ID);
            const ids = matchStableClusterIds(
                previous,
                new Map(assignments.map((a) => [a.mediaId, a.clusterId])),
                highestIssued,
            );
            assignments = assignments.map((a) => ({
                mediaId: a.mediaId,
                clusterId: ids.idByRaw.get(a.clusterId)!,
            }));
            await recordIssuedClusterIds(txSql, CLUSTER_MODEL_ID, ids.issued);
            idStats = {
                kept: ids.kept.length,
                issued: ids.issued.length,
                retired: ids.retired.length,
            };
            ctxLogger.info('Mapped cluster ids', idStats);

            await clearClusterAssignments(txSql, CLUSTER_MODEL_ID);
            ctxLogger.info('Cleared stale cluster assignments');

            for (let i = 0; i < assignments.length; i += UPSERT_BATCH_SIZE) {
                const batch = assignments.slice(i, i + UPSERT_BATCH_SIZE);
                await upsertClusterAssignments(txSql, CLUSTER_MODEL_ID, batch);
                upserted += batch.length;
                ctxLogger.debug('Upserted cluster batch', { upserted, total: assignments.length });
            }
        });

        warmMusicCollages(sql, async () => {
            // Pre-render all cluster covers; image requests gate access before cache reads.
            // Exception documented in docs/dev/eslint-exceptions.md.
            // eslint-disable-next-line callback-safety/no-unrestricted-access-outside-allowlist
            const rows = await getClusters(sql, CLUSTER_MODEL_ID, unrestrictedAccess());
            return rows.map((row) => row.cover_media_ids);
        });

        const distinctClusters = new Set(assignments.map((a) => a.clusterId)).size;
        const stored = await countClusterAssignments(sql, CLUSTER_MODEL_ID);

        const message = `Sonic clustering: ${upserted} assignments stored, ${distinctClusters} clusters, ${parseErrors} parse errors`;
        ctxLogger.info(message, { stored });

        return {
            success: true,
            itemsProcessed: upserted,
            result: {
                assigned: upserted,
                parseErrors,
                clusters: distinctClusters,
                idsKept: idStats.kept,
                idsIssued: idStats.issued,
                idsRetired: idStats.retired,
            },
            message,
        };
    },
});

// Self-register into the singleton registry.
registry.registerTask(sonicClusteringTask);
