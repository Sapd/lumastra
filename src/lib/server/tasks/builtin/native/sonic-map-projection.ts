// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic Map Projection Task
 *
 * Background task that projects MSCLAP audio embeddings into 2D space using
 * UMAP (Python umap-learn via workers/sonic-embedder/project_map.py), then
 * upserts the resulting coordinates into media_audio_map_coords.
 *
 * Pipeline:
 *   1. Spawn project_map.py with DATABASE_URL (reads embeddings directly).
 *   2. Parse JSONL output: { media_id, x, y } per line.
 *   3. Bulk-upsert into media_audio_map_coords (clears stale rows first).
 *
 * Gating:
 *   - No-ops when features.musicMap is false.
 *   - Runs automatically every 24h (UMAP is CPU-heavy, so daily is sufficient)
 *     to keep the map fresh as the sonic embedding backfill grows; the manual
 *     admin button remains available for an immediate on-demand run.
 *
 * Resource class:
 *   'analysis' with quotas.maxConcurrent=1 — UMAP is a long-running CPU-bound
 *   subprocess (up to ~45m) and single-threaded by default. Per the resource
 *   class rubric, CPU-heavy long jobs go to 'analysis', not 'embedding'
 *   (reserved for OpenAI/Voyage-style API-bound embedders). maxConcurrent=1
 *   serialises runs so two projections never thrash the CPU or produce
 *   non-deterministic results by racing each other.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { features, config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { registry } from '../../registry.js';
import {
    upsertMapCoords,
    clearMapCoords,
    countMapCoords,
    type MapCoordInput,
} from '$lib/server/database/queries/music-map.queries.js';
import { MSCLAP_MODEL_ID } from '$lib/server/database/queries/sonic-constants.js';
import {
    parseCpuThreadsSetting,
    SONIC_CPU_THREADS_FIELD_DEF,
    runSonicSubprocess,
    parseNdjsonLines,
} from './sonic-task-shared.js';
import type postgres from 'postgres';

const logger = Logger.for('SonicMapProjection');

// ============================================================================
// Constants
// ============================================================================

/** Batch size for bulk upsert into media_audio_map_coords. */
const UPSERT_BATCH_SIZE = 500;

// ============================================================================
// Schema / types
// ============================================================================

const inputSchema = z.object({}).passthrough();
type ProjectionInput = z.infer<typeof inputSchema>;

interface ProjectionResult {
    projected: number;
    parseErrors: number;
}

// ============================================================================
// NDJSON parser (shared by HTTP and subprocess paths)
// ============================================================================

function parseProjectionNdjson(ndjson: string): { coords: MapCoordInput[]; parseErrors: number } {
    const { records, parseErrors } = parseNdjsonLines(ndjson, (rec) => {
        const mediaId = typeof rec.media_id === 'string' ? rec.media_id : null;
        const x = typeof rec.x === 'number' ? rec.x : null;
        const y = typeof rec.y === 'number' ? rec.y : null;

        if (!mediaId || x === null || y === null) {
            return null;
        }

        // Clamp to [0, 1] for safety (should already be normalised by script)
        return {
            mediaId,
            x: Math.max(0, Math.min(1, x)),
            y: Math.max(0, Math.min(1, y)),
        };
    });

    return { coords: records, parseErrors };
}

// ============================================================================
// Projection runner
// ============================================================================

/**
 * Run UMAP projection via HTTP sidecar or subprocess fallback.
 * Returns an array of validated (media_id, x, y) tuples.
 *
 * @param databaseUrl Postgres connection string for the subprocess fallback.
 * @param threads     Optional CPU thread cap forwarded to the sidecar or subprocess.
 * @param signal      Optional abort signal for admin-cancel propagation (Bug 3).
 */
async function runProjection(
    databaseUrl: string,
    threads?: number,
    signal?: AbortSignal,
): Promise<{ coords: MapCoordInput[]; parseErrors: number }> {
    // --- HTTP sidecar path ---
    const sidecarUrl = config.SONIC_EMBEDDER_URL;
    if (sidecarUrl) {
        logger.debug('Calling sonic-embedder sidecar /project-map', { url: sidecarUrl });

        const sidecarBody: Record<string, unknown> = {};
        if (typeof threads === 'number' && threads > 0) {
            sidecarBody.threads = threads;
        }

        // 30-minute timeout — matches the task hard-timeout budget.
        // fetchWithTimeout composes this with ctx.signal (when provided) via
        // AbortSignal.any internally, so an admin Cancel actually aborts the
        // in-flight fetch instead of running to the timeout regardless. It
        // also routes the request through the same-origin-only redirect
        // guard (C22 fix-plan finding) — SONIC_EMBEDDER_URL is an
        // admin-configured host, same class as ABS/Kavita/the arr apps.
        const response = await fetchWithTimeout(
            `${sidecarUrl}/project-map`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sidecarBody),
                signal,
            },
            30 * 60_000,
        );

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(
                `Sonic sidecar /project-map returned ${response.status}: ${body.slice(0, 200)}`,
            );
        }

        const ndjson = await response.text();
        return parseProjectionNdjson(ndjson);
    }

    // --- Subprocess fallback ---
    const pythonBin = config.SONIC_EMBEDDER_PYTHON;
    const scriptPath = config.SONIC_MAP_PROJECTION_SCRIPT;

    const stdout = await runSonicSubprocess({
        pythonBin,
        scriptPath,
        extraEnv: { DATABASE_URL: databaseUrl, MODEL_ID: MSCLAP_MODEL_ID },
        threads,
        timeoutMs: 30 * 60_000,
        logLabel: 'UMAP projection',
        logger,
        signal,
    });

    return parseProjectionNdjson(stdout);
}

// ============================================================================
// Task definition
// ============================================================================

export const sonicMapProjectionTask = defineTask<ProjectionInput, ProjectionResult>({
    id: 'sonic-map-projection',
    purpose: 'music-ai',
    name: 'Music Map Projection',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    // Runs every 24h to keep the music map fresh as the sonic embedding backfill
    // grows. Daily cadence is appropriate given UMAP's CPU cost. The manual admin
    // button remains available for an immediate on-demand run.
    schedule: { every: '24h', runOnStartup: false },

    // Long-running CPU-bound subprocess (UMAP, up to ~45m) → 'analysis' class
    // (per the rubric: CPU-heavy long jobs go to 'analysis', not 'embedding',
    // which is for OpenAI/Voyage API calls). maxConcurrent=1 serializes runs.
    resourceClass: 'analysis',
    quotas: { maxConcurrent: 1 },

    scope: 'global',
    identityFor: () => 'global',

    inputSchema,

    timeout: { hard: '45m', soft: '40m' },

    settings: {
        fields: [SONIC_CPU_THREADS_FIELD_DEF],
    },

    async execute(ctx) {
        const { sql: rawSql, logger: ctxLogger, signal } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        // Feature gate — no-op when musicMap is off.
        if (!features.musicMap) {
            ctxLogger.info('musicMap feature is disabled — projection is a no-op');
            return {
                success: true,
                itemsProcessed: 0,
                result: { projected: 0, parseErrors: 0 },
            };
        }

        // Admin Cancel before any work started — clean stop, not an error.
        if (signal.aborted) {
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted' as const,
                result: { projected: 0, parseErrors: 0 },
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
                'sonic-map-projection: DATABASE_URL unavailable — skipping (unexpected internal state)',
            );
            throw new TaskError({
                message:
                    'sonic-map-projection: DATABASE_URL unavailable (unexpected internal state)',
                kind: 'permanent',
            });
        }

        // Read per-task cpuThreads setting (0 / absent → sidecar default ~half cores).
        const taskSettings = await ctx.settings();
        const cpuThreads = parseCpuThreadsSetting(taskSettings.cpuThreads);

        ctxLogger.info('Starting UMAP projection for music map', {
            cpuThreads: cpuThreads ?? 'sidecar-default',
        });

        // Run projection. `signal` threads ctx.signal into the sidecar fetch /
        // subprocess so admin Cancel actually interrupts the run instead of
        // being a no-op until the script's own timeout.
        let coords: MapCoordInput[];
        let parseErrors: number;
        try {
            ({ coords, parseErrors } = await runProjection(databaseUrl, cpuThreads, signal));
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            ctxLogger.error('UMAP projection subprocess failed', { error: errMsg });
            // A normal `return {success:false}` here used to be silently
            // recorded 'completed' by the runner. Rethrow as a transient
            // TaskError (sidecar/subprocess failure — worth a retry) so the
            // run is marked failed and the circuit breaker can see it.
            throw new TaskError({
                message: `UMAP projection subprocess failed: ${errMsg}`,
                kind: 'transient',
                cause: err,
            });
        }

        ctxLogger.info('UMAP projection complete', {
            points: coords.length,
            parseErrors,
        });

        if (coords.length === 0) {
            ctxLogger.info('No projection output — skipping DB upsert');
            return {
                success: true,
                itemsProcessed: 0,
                result: { projected: 0, parseErrors },
                message: 'No coordinates to store',
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
                result: { projected: 0, parseErrors },
                message: 'Aborted after projection computation, before DB write',
            };
        }

        // Clear stale coords and bulk-upsert fresh ones inside a single
        // transaction — a mid-loop failure previously left the dataset
        // partially emptied (clear committed, only some batches upserted).
        let upserted = 0;
        await sql.begin(async (tx) => {
            const txSql = tx as unknown as postgres.Sql;
            await clearMapCoords(txSql);
            ctxLogger.info('Cleared stale map coords');

            for (let i = 0; i < coords.length; i += UPSERT_BATCH_SIZE) {
                const batch = coords.slice(i, i + UPSERT_BATCH_SIZE);
                await upsertMapCoords(txSql, batch);
                upserted += batch.length;
                ctxLogger.debug('Upserted batch', { upserted, total: coords.length });
            }
        });

        // Verify the row count in DB after upsert (mirrors countClusterAssignments
        // in sonic-clustering task — useful for detecting partial-write issues).
        const stored = await countMapCoords(sql);

        const message = `Music map projection: ${upserted} points stored, ${parseErrors} parse errors`;
        ctxLogger.info(message, { stored });

        return {
            success: true,
            itemsProcessed: upserted,
            result: { projected: upserted, parseErrors },
            message,
        };
    },
});

// Self-register into the singleton registry.
registry.registerTask(sonicMapProjectionTask);
