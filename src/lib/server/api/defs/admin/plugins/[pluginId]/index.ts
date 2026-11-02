// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/plugins/[pluginId]/index.ts
 *
 * GET  /api/admin/plugins/[pluginId]  — plugin run status (isRunning + progress)
 * POST /api/admin/plugins/[pluginId]  — trigger a run, or abort via { action:'abort' }
 *
 * Auth: admin.  Surface: internal.
 * Scope used: { kind: 'admin' } — internal admin BFF; no v1 surface.
 *
 * GET  response: bare object { isRunning, progress?, libraries? } — `libraries`
 *      (file-scanner) is one entry per queued/running library scan; `progress`
 *      is the legacy all-scans aggregate.
 * POST response: bare object { jobId?, message, alreadyRunning? }
 *      abort: { action:'abort' } stops every run; file-scanner also takes
 *      { action:'abort', paths } to stop only those libraries.
 * 503  dependency_unavailable on dependency-down.
 * 409  conflict (BackpressureError / queue at capacity).
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { BackpressureError } from '$lib/server/tasks/backpressure.js';
import { pluginIdParamsSchema, pluginTriggerBodySchema } from '$lib/schemas/admin.js';
import {
    LibraryScanStatusSchema,
    type LibraryScanStatus,
} from '$lib/schemas/api-admin-library-responses.js';
import type { Run } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('api.admin.plugin');

// ── schemas ───────────────────────────────────────────────────────────────────

const ProgressSchema = z
    .object({
        totalItems: z.number().int().nonnegative().optional(),
        processedItems: z.number().int().nonnegative().optional(),
        currentItem: z.string().optional(),
        currentSubStatus: z.string().optional(),
        created: z.number().int().nonnegative().optional(),
        updated: z.number().int().nonnegative().optional(),
        skipped: z.number().int().nonnegative().optional(),
        phase: z.string().optional(),
    })
    .nullable();

const PluginStatusSchema = z.object({
    isRunning: z.boolean().optional(),
    progress: ProgressSchema.optional(),
    libraries: z.array(LibraryScanStatusSchema).optional(),
    jobId: z.string().optional(),
    message: z.string().optional(),
    alreadyRunning: z.boolean().optional(),
});

// ── constants ─────────────────────────────────────────────────────────────────

const FILE_SCANNER_ID = 'file-scanner';
const SCAN_TASK_ID = 'file-library-scan';

// ── helpers ───────────────────────────────────────────────────────────────────

const RUN_STATE_TO_SCAN_STATE: Partial<Record<Run['state'], LibraryScanStatus['state']>> = {
    pending: 'queued',
    active: 'running',
    cancelling: 'cancelling',
};

const SCAN_STATE_RANK: Record<LibraryScanStatus['state'], number> = {
    running: 3,
    queued: 2,
    cancelling: 1,
};

function runLibraryPathId(run: Run): string | undefined {
    const input = run.input as { libraryPathId?: unknown } | null;
    return typeof input?.libraryPathId === 'string' ? input.libraryPathId : undefined;
}

/**
 * Who started a per-library run. Fan-out children are `in-process` whether the
 * parent was the periodic schedule or an admin's "scan all", so they inherit
 * their parent's kind (one lookup per distinct parent).
 */
async function scanTriggerOf(
    run: Run,
    parentCache: Map<string, Promise<Run | null>>,
): Promise<LibraryScanStatus['trigger']> {
    let kind = run.trigger.kind;
    if (run.parentRunId && kind !== 'manual' && kind !== 'scheduled') {
        let parent = parentCache.get(run.parentRunId);
        if (!parent) {
            parent = orchestrator.getRun(run.parentRunId).catch(() => null);
            parentCache.set(run.parentRunId, parent);
        }
        kind = (await parent)?.trigger.kind ?? kind;
    }
    return kind === 'manual' || kind === 'scheduled' ? kind : 'other';
}

/** Every queued/running per-library scan, with its own progress when it has any. */
async function libraryScanStatuses(): Promise<LibraryScanStatus[]> {
    const { getScanProgressByKey } =
        await import('$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/progress-store.js');
    const [{ runs }, progressByKey] = await Promise.all([
        orchestrator.listRuns({
            taskId: SCAN_TASK_ID,
            state: ['active', 'pending', 'cancelling'],
            limit: 100,
        }),
        getScanProgressByKey(),
    ]);
    const parentCache = new Map<string, Promise<Run | null>>();
    const byPath = new Map<string, LibraryScanStatus>();
    const stoppingPaths = new Set<string>();
    for (const run of runs) {
        const libraryPathId = runLibraryPathId(run);
        const state = RUN_STATE_TO_SCAN_STATE[run.state];
        if (!libraryPathId || !state) continue; // the fan-out parent itself has no path
        if (state === 'cancelling') stoppingPaths.add(libraryPathId);
        // Several runs for one path (a queued manual click behind a running
        // scheduled scan, or a new request behind one being stopped): the live
        // one wins the row — running, then queued, then cancelling. A dying run
        // must not hide the scan the admin just asked for.
        const prior = byPath.get(libraryPathId);
        if (prior && SCAN_STATE_RANK[prior.state] >= SCAN_STATE_RANK[state]) continue;
        byPath.set(libraryPathId, {
            libraryPathId,
            state,
            trigger: await scanTriggerOf(run, parentCache),
        });
    }
    // Progress is written by the process doing the walk; a key without a
    // listed run (listRuns lag, or an orchestrator-less deployment) still
    // means that library is being scanned.
    for (const [scanKey, progress] of progressByKey) {
        if (scanKey === 'all') continue;
        const row = byPath.get(scanKey) ?? {
            libraryPathId: scanKey,
            state: 'running' as const,
            trigger: 'other' as const,
        };
        // A progress key next to a QUEUED row is normally that run having just
        // started. But if a run for this path is still being stopped, the key
        // is the dying run's — showing its numbers would dress the new request
        // up as "Scanning", and a second Stop would cancel the queued scan.
        if (row.state === 'queued' && stoppingPaths.has(scanKey)) continue;
        if (row.state === 'queued') row.state = 'running';
        byPath.set(scanKey, {
            ...row,
            processedItems: progress.processedFiles,
            totalItems: progress.totalFiles,
            phase: progress.phase,
        });
    }
    return [...byPath.values()];
}

async function fileScannerStatus(): Promise<Response> {
    const { fileScannerMediaSource, getFileScannerProgress } =
        await import('$lib/server/tasks/builtin/native/media-sources/file-scanner.js');
    const { buildPluginContext } = await import('$lib/server/tasks/plugin-context.js');

    const ctx = buildPluginContext(FILE_SCANNER_ID);
    const status = await fileScannerMediaSource.getStatus(ctx);
    const raw = await getFileScannerProgress();
    const libraries = await libraryScanStatuses().catch((err: unknown) => {
        log.warn('Per-library scan status unavailable', {
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    });

    const progress = raw
        ? {
              totalItems: raw.totalFiles,
              processedItems: raw.processedFiles,
              currentItem: raw.currentFile || raw.currentLibraryPath || undefined,
              currentSubStatus:
                  raw.phase === 'discovering'
                      ? 'Discovering files…'
                      : raw.currentLibraryPath || undefined,
              created: raw.added,
              updated: raw.updated,
              skipped: raw.skipped,
              phase: raw.phase,
          }
        : null;

    // `status.isScanning` reflects only THIS process's in-memory `_activeScans`
    // set, which is per-process (see file-scanner.ts module-state comment). In
    // a split app/worker deployment the scan runs in the worker process while
    // this GET is served by the app process, so `_activeScans` here is always
    // empty and `isScanning` is always false even mid-scan. The Valkey-backed
    // progress key is cross-process, so its presence is a reliable
    // cluster-wide "a scan is running" signal — OR it in so the admin UI can
    // detect an active scan (and its eventual completion) regardless of which
    // process handles the poll.
    return json(
        PluginStatusSchema.parse({
            // A queued scan counts: the page keeps polling until it has run.
            isRunning: status.isScanning || raw !== null || (libraries?.length ?? 0) > 0,
            progress,
            libraries,
        }),
    );
}

function targetPathIds(body: z.infer<typeof pluginTriggerBodySchema>): string[] {
    if (body.paths && body.paths.length > 0) return body.paths;
    if (body.libraryPathId) return [body.libraryPathId];
    return [];
}

async function triggerFileScan(
    body: z.infer<typeof pluginTriggerBodySchema>,
    username: string,
): Promise<Response> {
    if (body.paths !== undefined && body.libraryPathId !== undefined) {
        return ApiProblem.validationFailed("Send either 'paths' or 'libraryPathId', not both");
    }

    const pathIds = targetPathIds(body);
    const mode = body.mode ?? 'manual';
    const trigger = { kind: 'manual' as const, by: username, sourceRoute: 'admin.library' };

    try {
        if (pathIds.length === 0) {
            const result = await orchestrator.startRun(SCAN_TASK_ID, { mode }, { trigger });
            return json(
                PluginStatusSchema.parse({
                    jobId: result.runId,
                    message: result.deduped ? 'Scan already running' : 'Scan started',
                    alreadyRunning: result.deduped,
                }),
            );
        }

        let firstRunId: string | undefined;
        let dedupedAll = true;
        for (const libraryPathId of pathIds) {
            const result = await orchestrator.startRun(
                SCAN_TASK_ID,
                { libraryPathId, mode },
                { libraryGroupId: body.libraryGroupId, trigger },
            );
            if (!firstRunId) firstRunId = result.runId;
            if (!result.deduped) dedupedAll = false;
        }

        return json(
            PluginStatusSchema.parse({
                jobId: firstRunId,
                message: dedupedAll ? 'Scan already running' : 'Scan started',
                alreadyRunning: dedupedAll,
            }),
        );
    } catch (err) {
        if (err instanceof BackpressureError) {
            return ApiProblem.conflict('Queue at capacity; please retry');
        }
        log.error('Plugin trigger failed', err as Error);
        return ApiProblem.internalError('Failed to start scan');
    }
}

/**
 * Cancel active runs. With `paths` (file-scanner only) ONLY the per-library
 * scans of those library paths are cancelled — stopping one library must not
 * kill another admin's scan or the periodic scan of every other library.
 * Without `paths` every run of the task is cancelled (the "stop all" action).
 */
async function abortRuns(
    pluginId: string,
    username: string,
    paths?: readonly string[],
): Promise<Response> {
    const taskId = pluginId === FILE_SCANNER_ID ? SCAN_TASK_ID : pluginId;
    const { runs } = await orchestrator.listRuns({
        taskId,
        state: ['active', 'pending', 'cancelling'],
        limit: 100,
    });
    const scoped = paths ? new Set(paths) : null;
    const targets = scoped
        ? runs.filter((run) => {
              const id = runLibraryPathId(run);
              return id !== undefined && scoped.has(id);
          })
        : runs;

    let cancelled = 0;
    for (const run of targets) {
        const res = await orchestrator.cancelRun(run.id, {
            reason: `manual abort by ${username}`,
        });
        if (res.accepted) cancelled++;
    }

    if (pluginId === FILE_SCANNER_ID) {
        try {
            const { requestFileScannerAbort, requestFileScannerAbortForKey } =
                await import('$lib/server/tasks/builtin/native/media-sources/file-scanner.js');
            if (scoped) {
                for (const id of scoped) requestFileScannerAbortForKey(id);
            } else {
                requestFileScannerAbort();
            }
        } catch {
            // best-effort in-process nudge
        }
    }

    return json(
        PluginStatusSchema.parse({
            message: cancelled > 0 ? `Aborting ${cancelled} run(s)` : 'No active runs to abort',
        }),
    );
}

// ── def ───────────────────────────────────────────────────────────────────────

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: pluginIdParamsSchema,
        body: pluginTriggerBodySchema,
    },
    handlers: {
        GET: async (event) => {
            const pluginId = event.params.pluginId;
            if (!pluginId) return ApiProblem.validationFailed('Missing pluginId');

            if (pluginId === FILE_SCANNER_ID) return fileScannerStatus();

            const task = registry.getTask(pluginId);
            if (!task) return ApiProblem.notFound(`Plugin '${pluginId}' not found`);

            const { runs } = await orchestrator.listRuns({
                taskId: pluginId,
                state: ['active', 'pending'],
                limit: 1,
            });

            return json(
                PluginStatusSchema.parse({
                    isRunning: runs.length > 0,
                    progress: null,
                }),
            );
        },

        POST: async (event, _ctx) => {
            const pluginId = event.params.pluginId;
            if (!pluginId) return ApiProblem.validationFailed('Missing pluginId');

            let body: z.infer<typeof pluginTriggerBodySchema>;
            try {
                const raw: unknown = await event.request.json();
                const parsed = pluginTriggerBodySchema.safeParse(raw);
                if (!parsed.success) {
                    return ApiProblem.validationFailed(
                        parsed.error.issues.map((i) => ({
                            field: i.path.join('.'),
                            message: i.message,
                        })),
                    );
                }
                body = parsed.data;
            } catch {
                return ApiProblem.validationFailed('Invalid JSON body');
            }

            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? 'admin';

            if (body.action === 'abort') {
                if (
                    body.libraryPathId !== undefined ||
                    body.mode !== undefined ||
                    body.label !== undefined ||
                    body.libraryGroupId !== undefined ||
                    (body.paths !== undefined && pluginId !== FILE_SCANNER_ID)
                ) {
                    return ApiProblem.validationFailed(
                        "action='abort' accepts only { action: 'abort' } plus, for file-scanner, 'paths' to stop just those libraries",
                    );
                }
                return abortRuns(pluginId, username, body.paths);
            }

            if (pluginId === FILE_SCANNER_ID) {
                return triggerFileScan(body, username);
            }

            const task = registry.getTask(pluginId);
            if (!task) return ApiProblem.notFound(`Plugin '${pluginId}' not found`);

            // Mirror the tasks list/detail endpoints' prod filter: a demo task
            // is not triggerable in production, only hidden from listings.
            if (process.env.NODE_ENV === 'production' && task.demo) {
                return ApiProblem.notFound(`Plugin '${pluginId}' not found`);
            }

            try {
                const result = await orchestrator.startRun(
                    pluginId,
                    { mode: body.mode },
                    {
                        trigger: {
                            kind: 'manual',
                            by: username,
                            sourceRoute: 'admin.plugins',
                        },
                    },
                );
                return json(
                    PluginStatusSchema.parse({
                        jobId: result.runId,
                        message: result.deduped ? 'Already running' : 'Started',
                    }),
                );
            } catch (err) {
                if (err instanceof BackpressureError) {
                    return ApiProblem.conflict('Queue at capacity; please retry');
                }
                log.error('Plugin trigger failed', err as Error);
                return ApiProblem.internalError('Failed to start plugin');
            }
        },
    },
});
