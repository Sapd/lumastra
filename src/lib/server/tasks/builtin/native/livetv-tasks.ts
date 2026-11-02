// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV import + refresh tasks.
 *
 *  - import-m3u  → wraps `importM3uSource()`   (admin-triggered)
 *  - import-epg  → wraps `importEpgSource()`   (admin-triggered)
 *  - refresh-m3u → wraps `refreshM3uSource()`  (DB-row-driven schedule)
 *  - refresh-epg → wraps `refreshEpgSource()`  (DB-row-driven schedule)
 *
 * Imports are admin-triggered and declare `manualOnly: true` so the boot
 * audit recognises them as trigger-covered. Refresh tasks use the SDK's
 * `dynamicSchedule` contract: per-source `refresh_cron` lives in
 * `livetv_sources`, the loader returns sources whose `last_refresh_at`
 * is older than their cron-implied interval, and the scheduler fires
 * one run per due source with a per-bucket idempotency key.
 */

import { parseLiveTvRefreshIntervalMs } from '$lib/shared/livetv-refresh-schedule.js';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type { DynamicScheduleEntry, Logger as SdkLogger } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { getSourcesWithRefreshCron } from '$lib/server/database/queries/livetv-sources.queries.js';
import { LiveTvImportCancelledError } from '$lib/server/services/livetv/livetv-import-abort.js';

/**
 * Total-failure guard: a chronically-erroring IPTV source (dead URL, expired
 * credentials, malformed feed) previously returned `success: errors.length
 * === 0` WITHOUT throwing — a bare `success:false` return never marks the Run
 * failed or feeds the circuit breaker (only a thrown error does), so a source
 * that fails EVERY run stays invisible to both. Throw only when the run made
 * literally zero progress (nothing imported/refreshed) AND produced errors;
 * a partial run (some channels/programs succeeded alongside some parse
 * errors) is expected steady state for a slightly malformed feed and keeps
 * returning normally with the errors recorded.
 */
function throwIfTotalFailure(taskLabel: string, itemsProcessed: number, errors: string[]): void {
    if (errors.length === 0 || itemsProcessed > 0) return;
    throw new TaskError({
        message:
            `${taskLabel}: total failure — 0 items processed across ${errors.length} error(s): ` +
            `${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '...' : ''}`,
        kind: 'transient',
    });
}

/**
 * Shared loader: returns DynamicScheduleEntry per source that is due to
 * refresh, filtered by which URL the caller cares about (xmltv vs m3u).
 * The bucket key uses the cron-implied interval so two replicas firing
 * within the same cycle collapse to a single run via the orchestrator's
 * identity SETNX.
 *
 * Why exported: the integration test imports this directly to assert
 * filtering + bucketing behaviour without spinning up the scheduler.
 */
export async function buildLivetvDueEntries(
    sql: Sql,
    logger: SdkLogger,
    kind: 'epg' | 'm3u',
    now: Date,
): Promise<Array<DynamicScheduleEntry<{ sourceId: string }>>> {
    const sources = await getSourcesWithRefreshCron(sql);
    const nowMs = now.getTime();
    const out: Array<DynamicScheduleEntry<{ sourceId: string }>> = [];

    for (const source of sources) {
        const urlPresent = kind === 'epg' ? Boolean(source.xmltv_url) : Boolean(source.m3u_url);
        if (!urlPresent) continue;

        const intervalMs = parseLiveTvRefreshIntervalMs(source.refresh_cron, { stored: true });
        if (intervalMs === null) {
            logger.warn('livetv: unrecognised refresh_cron — skipping source', {
                sourceId: source.id,
                refresh_cron: source.refresh_cron,
            });
            continue;
        }

        const lastRefresh =
            kind === 'epg'
                ? (source.last_epg_refresh_at ?? source.last_refresh_at)
                : source.last_refresh_at;
        const lastRefreshMs = lastRefresh?.getTime() ?? 0;
        const sinceLastMs = nowMs - lastRefreshMs;

        // Clock-skew tolerance: if `last_refresh_at` is at least 60s in
        // the future (NTP jitter, manual SQL backdate, test rollback),
        // treat the source as due now. Without this guard, a negative diff
        // is always less than `intervalMs` and the source never refreshes
        // until natural drift catches up. `<=` is deliberate so the exact
        // -60_000 boundary doesn't fall through both branches to a no-op.
        if (sinceLastMs <= -60_000) {
            logger.warn('livetv: last_refresh_at is in the future — treating as due now', {
                sourceId: source.id,
                lastRefreshAt: source.last_refresh_at?.toISOString(),
                nowMs,
                skewMs: sinceLastMs,
            });
        } else if (sinceLastMs < intervalMs) {
            continue;
        }

        out.push({
            rowId: source.id,
            // Bucket on `now` (not on the maybe-future `lastRefresh`) so a
            // clock-skewed source still gets a stable per-cycle key.
            bucket: String(Math.floor(nowMs / intervalMs)),
            input: { sourceId: source.id },
        });
    }

    return out;
}

const sourceInputSchema = z
    .object({ sourceId: z.string(), requestId: z.string().optional() })
    .passthrough();
type SourceInput = z.infer<typeof sourceInputSchema>;

/**
 * Reusable helper: wraps the livetv service's progressCallback so it
 * doubles as an abort opportunity. The service invokes the callback
 * periodically (every batch / phase transition); when ctx.signal fires
 * we throw LiveTvImportCancelledError from inside the callback, which the
 * service propagates as a normal error. The task wrapper's catch then
 * maps it to stopReason: 'aborted'.
 *
 * This is the pragmatic shape recommended by the polish backlog — the
 * livetv services (importM3uSource, importEpgSource, refresh*) don't
 * accept an AbortSignal, but they already periodically call the
 * progress callback, so the callback IS the abort hook.
 */
function buildAbortableProgress(
    signal: AbortSignal,
    onProgress: (processed: number, total: number, message?: string) => void,
): (progress: { processed: number; total: number; message?: string }) => Promise<void> {
    return async (progress) => {
        if (signal.aborted) {
            throw new LiveTvImportCancelledError();
        }
        onProgress(progress.processed, progress.total, progress.message);
    };
}

// ──────────────────────────────────────────────────────────────────────────
// import-m3u
// ──────────────────────────────────────────────────────────────────────────

/**
 * The EPG import matches guide channels against the source's channel rows, so
 * it must run after the M3U import has written them. The routes used to start
 * both runs side by side; the EPG run then read the channel list while the M3U
 * run was deleting and re-inserting it (0 channels matched). Starting it here,
 * once the channels exist, orders the two.
 */
async function startEpgImportAfterM3u(
    sql: Sql,
    sourceId: string,
    parentRunId: string,
    logger: SdkLogger,
): Promise<void> {
    try {
        const [{ getSourceById }, { orchestrator }] = await Promise.all([
            import('$lib/server/database/queries/livetv-sources.queries.js'),
            import('../../orchestrator.js'),
        ]);
        const source = await getSourceById(sql, sourceId);
        if (!source?.xmltv_url) return;
        const started = await orchestrator.startRun(
            'import-epg',
            { sourceId },
            {
                trigger: {
                    kind: 'in-process',
                    by: 'import-m3u',
                    sourceRoute: 'task.import-m3u',
                },
                parentRunId,
                idempotencyKey: `manual_import-epg_${sourceId}`,
            },
        );
        if (started.deduped) {
            // An earlier import-epg for this source is still running; it read
            // the channel list before this import replaced it, so its guide
            // may not attach. The next Import or EPG refresh fixes that.
            logger.warn('An earlier EPG import is still running; no new one started', {
                sourceId,
                runId: started.runId,
            });
        }
    } catch (err) {
        // The channels are imported; a missing guide is recoverable with
        // Import again or the scheduled EPG refresh.
        logger.warn('Could not start the EPG import after the M3U import', {
            sourceId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export const importM3uTask = defineTask<SourceInput, unknown>({
    id: 'import-m3u',
    purpose: 'livetv',
    name: 'Import M3U Channels',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    // Admin-triggered only (initial import — admin uploads a fresh source,
    // refresh-m3u handles steady-state cadence via dynamicSchedule).
    manualOnly: true,

    identityFor: (input) =>
        `source-${input.sourceId}${input.requestId ? `-${input.requestId}` : ''}`,
    scope: 'global',
    resourceClass: 'io',
    inputSchema: sourceInputSchema,

    // A 150k-entry playlist from a slow provider can take minutes to fetch.
    // Keep LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS (25m) well above this.
    timeout: { hard: '10m', soft: '9m' },

    async execute(ctx) {
        if (ctx.signal.aborted) {
            return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
        }
        ctx.logger.info('Live TV M3U import started', { sourceId: ctx.input.sourceId });
        const { importM3uSource } =
            await import('../../../services/livetv/livetv-import.service.js');
        try {
            const result = await importM3uSource(
                ctx.sql,
                ctx.input.sourceId,
                buildAbortableProgress(ctx.signal, (p, t, m) => ctx.reportProgress(p, t, m)),
                true,
            );
            throwIfTotalFailure('import-m3u', result.channelCount, result.errors);
            ctx.logger.info('Live TV M3U import finished', {
                sourceId: ctx.input.sourceId,
                channels: result.channelCount,
                errors: result.errors.length,
            });
            // A cancel that lands after the import finished: keep the channels,
            // but do not start the guide import the admin just cancelled.
            if (!ctx.signal.aborted) {
                await startEpgImportAfterM3u(ctx.sql, ctx.input.sourceId, ctx.runId, ctx.logger);
            }
            return {
                // Informational only now — total failure throws above instead
                // of relying on this flag (a bare success:false never trips
                // the circuit breaker or marks the Run failed).
                success: result.errors.length === 0,
                itemsProcessed: result.channelCount,
                result,
            };
        } catch (err) {
            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }
            throw err;
        }
    },
});

// ──────────────────────────────────────────────────────────────────────────
// import-epg
// ──────────────────────────────────────────────────────────────────────────

export const importEpgTask = defineTask<SourceInput, unknown>({
    id: 'import-epg',
    purpose: 'livetv',
    name: 'Import EPG Program Guide',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    // Admin-triggered only (refresh-epg handles steady-state cadence).
    manualOnly: true,

    identityFor: (input) =>
        `source-${input.sourceId}${input.requestId ? `-${input.requestId}` : ''}`,
    scope: 'global',
    // XMLTV fetch+parse is dominated by HTTP fetch and single-threaded JS
    // parsing; it does not spawn CPU-pegging subprocesses (unlike ffmpeg-based
    // cpu tasks). Putting it on `io` keeps it from sitting behind a long
    // trickplay-generation backlog on the `cpu` queue.
    resourceClass: 'io',
    inputSchema: sourceInputSchema,

    // Large guides: download, parse, match against 12k+ channels and write
    // the programmes. The match yields between chunks, so this is wall time.
    timeout: { hard: '20m', soft: '19m' },

    async execute(ctx) {
        if (ctx.signal.aborted) {
            return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
        }
        ctx.logger.info('Live TV EPG import started', { sourceId: ctx.input.sourceId });
        const { importEpgSource } =
            await import('../../../services/livetv/livetv-import.service.js');
        try {
            const result = await importEpgSource(
                ctx.sql,
                ctx.input.sourceId,
                buildAbortableProgress(ctx.signal, (p, t, m) => ctx.reportProgress(p, t, m)),
                true,
            );
            throwIfTotalFailure('import-epg', result.programCount, result.errors);
            ctx.logger.info('Live TV EPG import finished', {
                sourceId: ctx.input.sourceId,
                programs: result.programCount,
                errors: result.errors.length,
            });
            return {
                // Informational only now — total failure throws above instead
                // of relying on this flag (a bare success:false never trips
                // the circuit breaker or marks the Run failed).
                success: result.errors.length === 0,
                itemsProcessed: result.programCount,
                result,
            };
        } catch (err) {
            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }
            throw err;
        }
    },
});

// ──────────────────────────────────────────────────────────────────────────
// refresh-m3u
// ──────────────────────────────────────────────────────────────────────────

export const refreshM3uTask = defineTask<SourceInput, unknown>({
    id: 'refresh-m3u',
    purpose: 'livetv',
    name: 'Refresh M3U Channels',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    // Per-source cadence: schedule lives in `livetv_sources.refresh_cron`.
    // The loader returns only sources whose `last_refresh_at` is older than
    // their cron-implied interval AND whose m3u_url is set. Two replicas
    // sweeping the same row collapse via the orchestrator's idempotency key.
    dynamicSchedule: {
        loader: ({ sql, logger, now }) => buildLivetvDueEntries(sql, logger, 'm3u', now),
        sweepEvery: '5m',
        envOverride: 'LIVETV_REFRESH_SWEEP_INTERVAL',
    },

    identityFor: (input) =>
        `source-${input.sourceId}${input.requestId ? `-${input.requestId}` : ''}`,
    scope: 'global',
    resourceClass: 'io',
    inputSchema: sourceInputSchema,

    // A 150k-entry playlist from a slow provider can take minutes to fetch.
    // Keep LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS (25m) well above this.
    timeout: { hard: '10m', soft: '9m' },

    async execute(ctx) {
        if (ctx.signal.aborted) {
            return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
        }
        ctx.logger.info('Live TV M3U refresh started', { sourceId: ctx.input.sourceId });
        const { refreshM3uSource } =
            await import('../../../services/livetv/livetv-refresh.service.js');
        try {
            const result = await refreshM3uSource(
                ctx.sql,
                ctx.input.sourceId,
                buildAbortableProgress(ctx.signal, (p, t, m) => ctx.reportProgress(p, t, m)),
                true,
            );
            // RefreshResult exposes {newChannels, urlChanges, archivedChannels} — sum
            // them for a total "items touched" count. The previous `channelsAdded`
            // field never existed on this type, so itemsProcessed was hard-zero.
            const itemsProcessed =
                result.newChannels +
                result.urlChanges +
                result.archivedChannels +
                result.deletedChannels;
            throwIfTotalFailure('refresh-m3u', itemsProcessed, result.errors);
            ctx.logger.info('Live TV M3U refresh finished', {
                sourceId: ctx.input.sourceId,
                newChannels: result.newChannels,
                urlChanges: result.urlChanges,
                archivedChannels: result.archivedChannels,
                deletedChannels: result.deletedChannels,
                errors: result.errors.length,
            });
            return {
                // Informational only now — total failure throws above instead
                // of relying on this flag (a bare success:false never trips
                // the circuit breaker or marks the Run failed).
                success: result.errors.length === 0,
                itemsProcessed,
                result,
            };
        } catch (err) {
            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }
            throw err;
        }
    },
});

// ──────────────────────────────────────────────────────────────────────────
// refresh-epg
// ──────────────────────────────────────────────────────────────────────────

export const refreshEpgTask = defineTask<SourceInput, unknown>({
    id: 'refresh-epg',
    purpose: 'livetv',
    name: 'Refresh EPG Program Guide',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    // Per-source cadence: see refresh-m3u for the same shape. Filters on
    // `xmltv_url IS NOT NULL` — sources without an EPG URL skip this task.
    dynamicSchedule: {
        loader: ({ sql, logger, now }) => buildLivetvDueEntries(sql, logger, 'epg', now),
        sweepEvery: '5m',
        envOverride: 'LIVETV_REFRESH_SWEEP_INTERVAL',
    },

    identityFor: (input) =>
        `source-${input.sourceId}${input.requestId ? `-${input.requestId}` : ''}`,
    scope: 'global',
    // Same reasoning as import-epg above — HTTP fetch + single-threaded JS
    // XMLTV parsing, no CPU-pegging subprocess. Keep on `io` so the periodic
    // EPG refresh isn't blocked behind a long trickplay queue.
    resourceClass: 'io',
    inputSchema: sourceInputSchema,

    // Large guides: download, parse, match against 12k+ channels and write
    // the programmes. The match yields between chunks, so this is wall time.
    timeout: { hard: '20m', soft: '19m' },

    async execute(ctx) {
        if (ctx.signal.aborted) {
            return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
        }
        ctx.logger.info('Live TV EPG refresh started', { sourceId: ctx.input.sourceId });
        // refresh-epg is identical to import-epg in implementation — the
        // refresh-service re-exports importEpgSource as refreshEpgSource so
        // we can call either binding here.
        const { refreshEpgSource } =
            await import('../../../services/livetv/livetv-refresh.service.js');
        try {
            const result = await refreshEpgSource(
                ctx.sql,
                ctx.input.sourceId,
                buildAbortableProgress(ctx.signal, (p, t, m) => ctx.reportProgress(p, t, m)),
                true,
            );
            throwIfTotalFailure('refresh-epg', result.programCount, result.errors);
            ctx.logger.info('Live TV EPG refresh finished', {
                sourceId: ctx.input.sourceId,
                programs: result.programCount,
                errors: result.errors.length,
            });
            return {
                // Informational only now — total failure throws above instead
                // of relying on this flag (a bare success:false never trips
                // the circuit breaker or marks the Run failed).
                success: result.errors.length === 0,
                itemsProcessed: result.programCount,
                result,
            };
        } catch (err) {
            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }
            throw err;
        }
    },
});

registry.registerTask(importM3uTask);
registry.registerTask(importEpgTask);
registry.registerTask(refreshM3uTask);
registry.registerTask(refreshEpgTask);
