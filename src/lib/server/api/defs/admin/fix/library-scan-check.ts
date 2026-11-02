// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/library-scan-check — the "new files aren't showing up" diagnostic.
 *
 * GET /api/admin/fix/library-scan-check → LibraryScanCheck.
 * Auth: admin. Errors: problem+json.
 *
 * ## What makes this a diagnostic and not a checklist
 *
 * Every field here is MEASURED on the instance serving the request:
 *   - is scanning switched on, and when did it last fire   (config + scheduler_state)
 *   - is each configured path there, and readable, RIGHT NOW (a real stat/access)
 *   - who does this process run as, and who owns the folder (uid/gid/mode)
 *   - what the last scan actually found                     (file_scanner_runs)
 *   - where the results of that are sitting                 (stage pipeline summary)
 *
 * ## The probe must never hang the request
 *
 * Media lives on NFS/SMB. A `stat()` against a hung `hard` mount blocks for the
 * mount's `timeo` — often 60s — and the honest answer for the operator ("this
 * path is not answering") is precisely the case where a naive probe wedges the
 * page that was supposed to tell them so. Every filesystem call therefore goes
 * through `safe-fs`, which is timeout-bounded and globally concurrency-capped,
 * and a timeout is reported as its OWN state rather than being flattened into
 * "missing" — those two have different fixes.
 *
 * ## Remote providers are not probed
 *
 * An `audiobookshelf` row's `path` is a synthetic `abs://<uuid>` URI, not a
 * directory. Probing it would produce a confident, wrong "missing" verdict, so
 * the classification comes from FILESYSTEM_LIBRARY_PROVIDERS rather than from
 * guessing at the string.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { constants as fsConstants } from 'node:fs';
import { safeStat, safeAccess, FsTimeoutError } from '$lib/server/utils/safe-fs.js';
import { getRuntimeEnvironment } from '$lib/server/utils/runtime-environment.js';
import {
    getAllLibraryPaths,
    FILESYSTEM_LIBRARY_PROVIDERS,
    type LibraryPathRow,
} from '$lib/server/database/queries/library-paths.queries.js';
import { getLibraryGroupsWithCounts } from '$lib/server/database/queries/library-groups.queries.js';
import {
    getRecentScannerRuns,
    ABANDONED_RUN_ERRORS_SENTINEL,
    deriveScannerRunStatus,
} from '$lib/server/database/queries/file-scanner-runs.queries.js';
import { getSchedulerState } from '$lib/server/tasks/scheduler-state.js';
import {
    listCleanupHolds,
    type CleanupHoldRow,
} from '$lib/server/database/queries/library-cleanup-holds.queries.js';
import { loadIngestPipelineSummary } from '$lib/server/database/queries/ingest-map.queries.js';
import { formatMode } from '$lib/components/admin/fix/fix-commands.js';
import type {
    LibraryScanCheck,
    PathProbe,
    ScanPathReport,
} from '$lib/components/admin/fix/library-scan-check.schema.js';

const logger = Logger.for('AdminFixLibraryScanCheck');

/**
 * The scheduled task that walks library paths. NOT `file-scanner` — that is the
 * media-source plugin id; `file-library-scan` is the row in `scheduler_state`
 * that decides whether the walk ever fires.
 */
const SCAN_TASK_ID = 'file-library-scan';

/**
 * Probe budget per path. Deliberately well under `safe-fs`'s 15s default: ten
 * dead mounts must not add up to a page that trips AsyncSection's own timeout,
 * and "it did not answer within four seconds" is already the diagnosis.
 */
const PROBE_TIMEOUT_MS = 4000;

const FILESYSTEM_PROVIDERS = new Set<string>(FILESYSTEM_LIBRARY_PROVIDERS);

function errnoOf(err: unknown): string | null {
    if (err instanceof FsTimeoutError) return 'ETIMEDOUT';
    if (err !== null && typeof err === 'object' && 'code' in err) {
        const code = (err as { code?: unknown }).code;
        if (typeof code === 'string') return code;
    }
    return err instanceof Error ? err.message : null;
}

/**
 * Physically check one directory. Returns owner/mode whenever `stat` succeeded,
 * even when the readability check then failed — that combination (stat works,
 * read does not) is exactly the permission case, and the owner numbers are what
 * the remedy is built from.
 */
async function probePath(row: LibraryPathRow): Promise<PathProbe> {
    if (!row.enabled) {
        return { state: 'disabled', ownerUid: null, ownerGid: null, mode: null, detail: null };
    }
    if (!FILESYSTEM_PROVIDERS.has(row.provider)) {
        return { state: 'remote', ownerUid: null, ownerGid: null, mode: null, detail: null };
    }

    // No initialisers: every catch in the stat block below returns, so control
    // only reaches the access probe once all three have been assigned from
    // `stats`. Seeding them with null was dead (no-useless-assignment) and made
    // it look as though a null could survive to the success return.
    let ownerUid: number | null;
    let ownerGid: number | null;
    let mode: string | null;

    try {
        const stats = await safeStat(row.path, PROBE_TIMEOUT_MS);
        ownerUid = stats.uid;
        ownerGid = stats.gid;
        mode = formatMode(stats.mode);
        if (!stats.isDirectory()) {
            return { state: 'not-a-directory', ownerUid, ownerGid, mode, detail: null };
        }
    } catch (err) {
        const code = errnoOf(err);
        if (code === 'ETIMEDOUT') {
            return { state: 'timeout', ownerUid: null, ownerGid: null, mode: null, detail: code };
        }
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return { state: 'missing', ownerUid: null, ownerGid: null, mode: null, detail: code };
        }
        if (code === 'EACCES' || code === 'EPERM') {
            // Denied on the PARENT — we cannot even see the entry. Still a
            // permission problem, and still actionable from the process uid.
            return {
                state: 'permission-denied',
                ownerUid: null,
                ownerGid: null,
                mode: null,
                detail: code,
            };
        }
        return { state: 'error', ownerUid: null, ownerGid: null, mode: null, detail: code };
    }

    // Readable AND traversable — a directory the process can stat but not enter
    // scans as empty, which is the subtler half of this failure.
    try {
        await safeAccess(row.path, fsConstants.R_OK | fsConstants.X_OK, PROBE_TIMEOUT_MS);
    } catch (err) {
        const code = errnoOf(err);
        if (code === 'ETIMEDOUT')
            return { state: 'timeout', ownerUid, ownerGid, mode, detail: code };
        return { state: 'permission-denied', ownerUid, ownerGid, mode, detail: code };
    }

    return { state: 'ok', ownerUid, ownerGid, mode, detail: null };
}

function emptyPayload(dbError: string | null): LibraryScanCheck {
    const env = getRuntimeEnvironment();
    return {
        generatedAt: new Date().toISOString(),
        schedule: {
            globallyDisabled: config.DISABLE_FILE_LIBRARY_SCAN === true,
            paused: false,
            pausedBy: null,
            lastFiredAt: null,
            nextFireAt: null,
            neverScheduled: true,
            unreadable: false,
        },
        process: {
            uid: process.getuid?.() ?? null,
            gid: process.getgid?.() ?? null,
            containerized: env.containerized,
            platform: env.platform,
        },
        paths: [],
        pipeline: null,
        dbError,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getAdminDb();
            if (!sql) {
                return json(emptyPayload('Database unavailable'));
            }

            // `emptyPayload` already fills in schedule defaults and the process
            // identity; the lookups below only overwrite what they can answer.
            const base = emptyPayload(null);

            // Every lookup is independently degradable: a page whose whole point
            // is diagnosing a broken instance must not blank itself because one
            // of its own reads failed.
            const [pathsResult, groupsResult, scheduleResult, pipelineResult, holdsResult] =
                await Promise.allSettled([
                    getAllLibraryPaths(sql),
                    getLibraryGroupsWithCounts(sql),
                    getSchedulerState(sql, SCAN_TASK_ID),
                    loadIngestPipelineSummary(sql),
                    listCleanupHolds(sql),
                ]);
            const holds = new Map<string, CleanupHoldRow>();
            if (holdsResult.status === 'fulfilled') {
                for (const h of holdsResult.value) holds.set(h.library_path_id, h);
            } else {
                logger.warn('Cleanup holds lookup failed', { error: String(holdsResult.reason) });
            }

            if (scheduleResult.status === 'fulfilled' && scheduleResult.value !== null) {
                const s = scheduleResult.value;
                base.schedule = {
                    globallyDisabled: config.DISABLE_FILE_LIBRARY_SCAN === true,
                    paused: s.paused,
                    pausedBy: s.pausedBy,
                    lastFiredAt: s.lastFiredAt?.toISOString() ?? null,
                    nextFireAt: s.nextFireAt.toISOString(),
                    neverScheduled: false,
                    unreadable: false,
                };
            } else if (scheduleResult.status === 'rejected') {
                // A failed read is not "never scheduled": that copy tells the
                // operator to wait for a worker that may be running fine.
                logger.warn('Scan schedule lookup failed', {
                    error: String(scheduleResult.reason),
                });
                base.schedule = { ...base.schedule, neverScheduled: false, unreadable: true };
            }

            if (pipelineResult.status === 'fulfilled') {
                const p = pipelineResult.value;
                base.pipeline = {
                    inFlight: p.inFlight,
                    running: p.running,
                    failedLastHour: p.failedLastHour,
                    deadLetterItems: p.deadLetterItems,
                    oldestPendingAgeSec: p.oldestPendingAgeSec ?? null,
                };
            }

            const groupNames = new Map<string, { name: string; count: number }>();
            if (groupsResult.status === 'fulfilled') {
                for (const g of groupsResult.value) {
                    groupNames.set(g.id, {
                        name: g.display_name || g.name,
                        count: Number(g.item_count) || 0,
                    });
                }
            }

            if (pathsResult.status === 'rejected') {
                logger.warn('Library paths lookup failed', { error: String(pathsResult.reason) });
                return json({ ...base, dbError: 'Could not read library paths' });
            }

            const rows = pathsResult.value;

            // Probes run CONCURRENTLY — ten paths must cost one timeout, not ten.
            // safe-fs's global semaphore is what keeps that from saturating the
            // libuv threadpool and starving DNS/Postgres underneath us.
            const reports: ScanPathReport[] = await Promise.all(
                rows.map(async (row): Promise<ScanPathReport> => {
                    const [probe, runs] = await Promise.all([
                        probePath(row),
                        getRecentScannerRuns(sql, 1, row.id).catch((err: unknown) => {
                            logger.warn('Scanner runs lookup failed', {
                                pathId: row.id,
                                error: String(err),
                            });
                            return null;
                        }),
                    ]);

                    const group = groupNames.get(row.library_group_id);
                    const run = runs?.[0];
                    // The same staleness rule the scan history uses: an open
                    // run older than the cutoff is a crash, not a long scan.
                    const runStatus = run === undefined ? null : deriveScannerRunStatus(run);
                    const hold = holds.get(row.id);

                    return {
                        id: row.id,
                        path: row.path,
                        mediaType: row.media_type,
                        provider: row.provider,
                        enabled: row.enabled,
                        libraryName: group?.name ?? null,
                        libraryItemCount: group?.count ?? null,
                        probe,
                        lastScanUnreadable: runs === null,
                        lastScan:
                            run === undefined
                                ? null
                                : {
                                      startedAt: run.started_at.toISOString(),
                                      completedAt: run.completed_at?.toISOString() ?? null,
                                      totalFiles: run.total_files,
                                      // The run row stores `matched = added + updated`;
                                      // there is no `added` column. Clamped because a
                                      // partially-written row must not render as -3.
                                      added: Math.max(0, run.matched - run.updated),
                                      updated: run.updated,
                                      unmatched: run.unmatched,
                                      errors:
                                          run.errors === ABANDONED_RUN_ERRORS_SENTINEL
                                              ? 0
                                              : run.errors,
                                      running: runStatus === 'running',
                                      abandoned: runStatus === 'abandoned',
                                  },
                        cleanupHold:
                            hold === undefined
                                ? undefined
                                : {
                                      reason: hold.reason,
                                      walked: hold.walked,
                                      known: hold.known,
                                      firstHeldAt: hold.first_held_at.toISOString(),
                                      lastHeldAt: hold.last_held_at.toISOString(),
                                      confirmedAt: hold.confirmed_at?.toISOString(),
                                  },
                    };
                }),
            );

            logger.debug('Library scan check completed', {
                paths: reports.length,
                failing: reports.filter((r) => r.probe.state !== 'ok' && r.probe.state !== 'remote')
                    .length,
            });

            return json({ ...base, paths: reports } satisfies LibraryScanCheck);
        },
    },
});
