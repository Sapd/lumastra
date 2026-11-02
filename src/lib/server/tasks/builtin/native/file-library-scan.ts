// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File Library Scan — native defineTask implementation.
 *
 * Periodic safety-net scan of library paths for new media files (Lumastra/Hybrid mode).
 * Catches files added while the server was down or on network mounts where
 * inotify/fsevents don't work. The native watcher handles real-time detection;
 * this task is the scheduled fallback.
 *
 * Configuration:
 * - SYNC_FILE_LIBRARY_SCAN_INTERVAL: Duration-string override for the 1h cadence
 *   (e.g. '30m', '2h').
 * - DISABLE_FILE_LIBRARY_SCAN: Set to 'true' to disable (both scheduled and
 *   manual triggers). Checked at execute() entry.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { config, features } from '$lib/server/config.js';
import { libraryIngestKey } from '../../library-ingest-key.js';
import { classifyMediaInfraError } from '../../infra-retry.js';
import { requestJellyfinSetupInventory } from '$lib/server/services/jellyfin-setup-sync.service.js';

const inputSchema = z
    .object({
        /** When provided, scan only this specific library path id. */
        libraryPathId: z.string().optional(),
    })
    .passthrough();

type FileScanInput = z.infer<typeof inputSchema>;

/** How many failed files a run names in its result (the rest are counted). */
const SCAN_ERROR_SAMPLE = 5;

interface FileScanResult {
    added: number;
    updated: number;
    skipped: number;
    unmatched: number;
    scanErrors: number;
    /** First few `result.errors` entries (file + reason), so run history names the files. */
    scanErrorSample?: string[];
    /** Human-readable summary, including the failed-file preview when there are errors. */
    message?: string;
    /** Files added without metadata because the provider could not be asked (S5). */
    metadataUnavailable?: number;
    /** 'auth' = the provider rejected its API key; 'unavailable' = none configured. */
    metadataProviderError?: 'auth' | 'unavailable';
    metadataProviderId?: string;
}

export const fileLibraryScanTask = defineTask<FileScanInput, FileScanResult>({
    id: 'file-library-scan',
    purpose: 'library',
    confirmBeforeRun: true,
    name: 'File Library Scan',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: '1h',
        runOnStartup: true,
        startupDelay: '2m',
        envOverride: 'SYNC_FILE_LIBRARY_SCAN_INTERVAL',
    },
    feedsInto: ['media-probe', 'music-analysis', 'trickplay-params-sync'],

    identityFor: (input) =>
        input.libraryPathId
            ? `path-${input.libraryPathId}`
            : `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    // Cross-replica, cross-time mutex keyed on identityFor. Without this,
    // identityFor is decorative and the per-path child runs have NO dedup, so a
    // parent retry, an overlapping manual "scan all", or a second worker replica
    // could run TWO concurrent scans of the same library path (racing on
    // media_files / file_scanner_runs). With it, `path-<id>` is one-in-flight
    // cluster-wide. TTL must EXCEED the 120m hard timeout (with margin) so the
    // lock can't expire while a scan is legitimately still running — the key is
    // set at claim time, slightly before execute() begins, so equality would
    // race. On a clean finish the orchestrator releases it immediately; only an
    // uncontrolled SIGKILL leaves it to self-expire after the TTL.
    exclusiveWith: { scope: 'global', ttl: '130m' },
    // Cap the scan's share of the pool so a fanned-out wave of per-path runs
    // can't claim every slot and starve other bulk tasks (tmdb/mdblist/
    // enrichment). Raised 2 → 5 as belt-and-suspenders. Two root fixes have
    // since landed that make a hung-fs wedge fail fast instead of holding a slot
    // to the 120m cap: (1) the directory walk is now timeout-bounded end-to-end
    // via safe-fs (per-op 15s + per-readdir 30s, see walk-directory.ts), and
    // (2) the stall/wall-clock watchdog now settles the wedged run's processor
    // promise so BullMQ frees the concurrency slot (see autoFailRun in runner.ts).
    // The cap stays at 5 for one release as headroom; it can drop back to the
    // default once the watchdog slot-reclaim is verified in preprod.
    quotas: { maxConcurrent: 5 },
    // Hard timeout is 120m — well above the 5-minute fast-path threshold.
    // `ingest` is reserved for short per-file tasks (media-probe, image-sync,
    // chapter-sync, trickplay-params-sync) that must stay responsive while a
    // library scan is running. A 2h scan on `ingest` starves those fast-path
    // tasks for the duration (TASK-H30). `bulk` gives the scan its own pool.
    resourceClass: 'bulk',

    inputSchema,

    timeout: { hard: '120m', soft: '110m' },

    retry: {
        attempts: 6,
        backoff: [30_000],
        retryOn: classifyMediaInfraError,
    },

    async execute(ctx) {
        const { logger, signal } = ctx;

        if (config.DISABLE_FILE_LIBRARY_SCAN) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    added: 0,
                    updated: 0,
                    skipped: 0,
                    unmatched: 0,
                    scanErrors: 0,
                },
            };
        }

        const libraryPathId = ctx.input.libraryPathId;

        // Fan-out: a scan triggered WITHOUT a specific libraryPathId (scheduled
        // cadence, runOnStartup, or a manual "scan all") dispatches one scoped
        // per-path run per enabled library path instead of a single monolithic
        // "all" walk. Each per-path run walks only its own tree and is an
        // independent, retryable, exclusiveWith-deduped run — so a restart or
        // 120m timeout mid-cycle only loses the in-flight path, and the next
        // cycle re-runs the rest. (Resilience comes from `media_files`
        // mtime/size/hash TRIAGE — already-ingested files are cheaply skipped on
        // replay; `file_scanner_runs` is telemetry only, NOT a resume cursor.)
        // The old single "all" walk processed paths in `library_group_id` order
        // with the movies group LAST, so every interrupted scan never reached it
        // and movies stayed unplayable.
        if (!libraryPathId) {
            const [{ getEnabledLibraryPaths }, { orchestrator }] = await Promise.all([
                import('$lib/server/database/queries/library-paths.queries.js'),
                import('../../orchestrator.js'),
            ]);
            const paths = await getEnabledLibraryPaths(ctx.sql);
            if (paths.length === 0) {
                logger.info('File library scan: no enabled library paths to scan');
                return {
                    success: true,
                    itemsProcessed: 0,
                    result: { added: 0, updated: 0, skipped: 0, unmatched: 0, scanErrors: 0 },
                };
            }

            // Dispatch movies/video libraries first so the most latency-sensitive,
            // most-visible playable content (a movie folder ≈ 1 file → 1 card)
            // appears soonest on a fresh install — rather than waiting behind the
            // large series/anime/music trees. Cheap: keys off the row's
            // media_type, no walking. Stable sort preserves group/created order
            // within a rank.
            const rank = (mediaType: string): number => {
                switch (mediaType) {
                    case 'movie':
                        return 0;
                    case 'tv':
                    case 'anime':
                        return 1;
                    case 'home_video':
                        return 2;
                    case 'music':
                        return 3;
                    case 'audiobook':
                        return 4;
                    default:
                        return 5;
                }
            };
            const ordered = [...paths].sort((a, b) => rank(a.media_type) - rank(b.media_type));

            logger.info('File library scan: dispatching per-path scans', {
                paths: ordered.length,
            });
            let dispatched = 0;
            let deduped = 0;
            let failed = 0;
            let lastError: unknown = null;
            for (const p of ordered) {
                if (signal.aborted) break;
                try {
                    const res = await orchestrator.startRun(
                        'file-library-scan',
                        { libraryPathId: p.id },
                        {
                            trigger: {
                                kind: 'in-process',
                                by: 'file-library-scan',
                                sourceRoute: 'task.file-library-scan.fanout',
                            },
                            idempotencyKey: libraryIngestKey('file-library-scan', p.id),
                            parentRunId: ctx.runId,
                            libraryGroupId: p.library_group_id,
                        },
                    );
                    dispatched++;
                    if (res.deduped) deduped++;
                } catch (err) {
                    failed++;
                    lastError = err;
                    logger.warn('File library scan: failed to dispatch per-path scan', {
                        libraryPathId: p.id,
                        path: p.path,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            logger.info('File library scan: per-path dispatch complete', {
                dispatched,
                deduped,
                failed,
            });
            // If EVERY attempted dispatch failed, THROW so the run is marked
            // failed + retried + visible in attention — a returned `success:false`
            // would record as `completed` and hide the problem (the runner only
            // retries/fails on a thrown error). Re-dispatch on retry is safe:
            // exclusiveWith dedups any paths already in flight.
            if (dispatched === 0 && failed > 0) {
                throw lastError instanceof Error
                    ? lastError
                    : new Error('file-library-scan: failed to dispatch any per-path scan');
            }
            // A partial failure (some dispatched, some not) self-heals on the
            // next hourly cycle (exclusiveWith-safe), so log loudly rather than
            // failing the whole dispatcher — failing it every cycle would risk
            // tripping this task's circuit breaker and halting ALL scanning.
            if (failed > 0) {
                logger.error(
                    'File library scan: some per-path scans failed to dispatch; remaining paths retry next cycle',
                    { dispatched, failed },
                );
            }
            // itemsProcessed = libraries queued, so the dispatcher run reads as
            // "queued N" rather than a 0-item no-op; it does no scanning itself.
            return {
                success: true,
                itemsProcessed: dispatched,
                result: { added: 0, updated: 0, skipped: 0, unmatched: 0, scanErrors: 0 },
            };
        }

        logger.info('Starting file library scan...', {
            libraryPathId,
        });

        // Dynamic import to keep the heavy file-scanner module out of the boot path until a scan actually runs
        const { scanForSync, requestFileScannerAbortForKey } =
            await import('./media-sources/file-scanner.js');

        // Bridge abort signal → file scanner's internal abort mechanism.
        // libraryPathId is always defined here (the no-id fan-out returned above).
        const scanKey = libraryPathId;
        const onAbort = (): void => {
            logger.info('Cancel signal received, aborting file scanner', {
                scanKey,
            });
            requestFileScannerAbortForKey(scanKey);
        };
        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener('abort', onAbort, { once: true });
        }

        // Build a minimal SyncExecutionContext for scanForSync
        const syncCtx = {
            sql: ctx.sql,
            // file-scanner expects the host LoggerInstance (with .child() returning
            // LoggerInstance), but ctx.logger is the SDK's structural Logger
            // interface. The scanner only calls level methods (debug/info/warn/error),
            // both of which are satisfied — through-unknown cast is necessary
            // because LoggerInstance has additional methods we don't provide.
            logger: ctx.logger as unknown as Parameters<typeof scanForSync>[1]['logger'],
            abortSignal: signal,
            mode: 'catchup' as const,
            jobOptions: ctx.input as Record<string, unknown>,
            jobId: ctx.runId,
            runGroupId: undefined,
            onProgress: (processed: number, total: number, meta?: Record<string, unknown>) => {
                ctx.reportProgress(processed, total, meta?.phase as string | undefined);
            },
        };

        const result = await scanForSync(libraryPathId, syncCtx);

        const totalProcessed = result.added + result.updated;
        const totalFiles =
            result.added +
            result.updated +
            result.skipped +
            result.unmatched +
            result.errors.length;
        const errorRate = totalFiles > 0 ? result.errors.length / totalFiles : 0;
        const scanSuccess = result.errors.length === 0 || (errorRate < 0.05 && totalProcessed > 0);
        // Preserve the existing <5% tolerance and counts. Classify the retained
        // cause, never `${path}: ${message}` (filenames are arbitrary text).
        const transient = result.errorDetails?.filter(({ err }) => classifyMediaInfraError(err));
        const transientRate = totalFiles > 0 ? (transient?.length ?? 0) / totalFiles : 0;
        if (
            transient?.length &&
            !signal.aborted &&
            (totalProcessed === 0 || transientRate >= 0.05)
        ) {
            throw new TaskError({
                kind: 'transient',
                message:
                    transient[0].err instanceof Error
                        ? transient[0].err.message
                        : String(transient[0].err),
                cause: transient[0].err,
            });
        }

        const messageParts = [
            `Scanned: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped, ${result.unmatched} unmatched`,
        ];
        if (result.errors.length > 0) {
            messageParts.push(`${result.errors.length} error(s)`);
            const preview = result.errors.slice(0, SCAN_ERROR_SAMPLE);
            messageParts.push(`Failed files: ${preview.join('; ')}`);
            if (result.errors.length > SCAN_ERROR_SAMPLE) {
                messageParts.push(`...and ${result.errors.length - SCAN_ERROR_SAMPLE} more`);
            }
        }

        logger.info('File library scan completed', {
            added: result.added,
            updated: result.updated,
            skipped: result.skipped,
            unmatched: result.unmatched,
            errors: result.errors.length,
            ...(result.metadataUnavailable
                ? { metadataUnavailable: result.metadataUnavailable }
                : {}),
        });
        if (result.metadataUnavailable) {
            // S5: a scan whose metadata provider could not be asked must not
            // read as "all good" — say why, once, at the end.
            logger.warn(
                result.metadataProviderError === 'auth'
                    ? `${result.metadataUnavailable} file(s) added without metadata: the metadata provider rejected its API key`
                    : `${result.metadataUnavailable} file(s) added without metadata: no metadata provider is available`,
                {
                    metadataProviderError: result.metadataProviderError,
                    providerId: result.metadataProviderId,
                },
            );
        }

        ctx.reportProgress(totalProcessed, totalProcessed, 'complete');

        if (!signal.aborted && features.jellyfinSync && totalProcessed > 0) {
            try {
                await requestJellyfinSetupInventory(ctx.sql, 'file-library-scan', logger);
            } catch {
                logger.warn('Jellyfin inventory could not start; scan remains successful');
            }
        }

        return {
            success: scanSuccess,
            itemsProcessed: totalProcessed,
            result: {
                added: result.added,
                updated: result.updated,
                skipped: result.skipped,
                unmatched: result.unmatched,
                scanErrors: result.errors.length,
                message: messageParts.join('. '),
                ...(result.errors.length > 0
                    ? { scanErrorSample: result.errors.slice(0, SCAN_ERROR_SAMPLE) }
                    : {}),
                // S5 — read by the setup wizard (via /api/setup/media-count)
                // to say "matching failed" instead of "your library is ready".
                ...(result.metadataUnavailable
                    ? {
                          metadataUnavailable: result.metadataUnavailable,
                          metadataProviderError: result.metadataProviderError,
                          metadataProviderId: result.metadataProviderId,
                      }
                    : {}),
            },
        };
    },
});

registry.registerTask(fileLibraryScanTask);
