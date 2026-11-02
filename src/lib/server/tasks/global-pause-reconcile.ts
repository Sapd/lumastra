// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared reconciliation logic for "pause everything for N hours" + quiet
 * hours — extracted out of `admin/ops/global-pause.ts` so the HTTP endpoint
 * and the `pause-reconcile` scheduled task (`builtin/native/pause-reconcile.ts`)
 * call the EXACT same code path rather than risking two implementations that
 * quietly disagree about when a pause expires.
 *
 * Before this split, the only caller of `reconcileAndReadStatus()` was the
 * endpoint, and the only regular caller of the endpoint was the admin
 * dashboard's Load Controls card polling `GET` every 20s while mounted.
 * Close the tab and an active pause outlived its "resume at T" deadline
 * until an operator happened to reopen the admin dashboard — on a
 * self-hosted server that can be days, with background processing stopped
 * silently and no error anywhere. `pause-reconcile.ts` now drives this same
 * function on a fixed cadence so that no longer depends on anyone having a
 * browser tab open.
 *
 * Composes the TWO existing pause primitives rather than adding a fourth:
 * BullMQ `Queue.pause()`/`resume()` per resource class (the same call
 * `POST/DELETE /api/v1/queues/{class}/pause` already makes) for the actual
 * work-stopping effect, and the Valkey `task:queue-paused:<class>` flag the
 * per-queue endpoints already write for display parity — so a queue this
 * pauses reads identically to one paused by hand.
 *
 * ── The one task this module must never pause ─────────────────────────────
 * `pauseClasses`/`resumeClasses` below are what "pause everything" actually
 * pauses. `pause-reconcile` — the scheduled task that calls
 * `reconcileAndReadStatus()` to LIFT an expired pause — shares its
 * `resourceClass` (`'maintenance'`) with plenty of other builtin tasks, so
 * without an explicit exemption it would be paused right along with them.
 * That would be a genuine deadlock, not just a delay: the one thing that
 * resumes the system would itself be sitting in a paused queue waiting for a
 * resume only it can trigger.
 *
 * `GLOBAL_PAUSE_RECONCILE_TASK_ID` is the single source of truth for that
 * exemption: `tasksForClass()` (used by both `pauseClasses` and
 * `resumeClasses` via `queuesFor`) filters it out of the per-class task list
 * it builds queues from, and `pause-reconcile.ts` declares this SAME
 * constant as its own task id — so the exemption and the task it protects
 * can never drift apart into two different strings.
 *
 * This exemption is effective under `FEATURE_PER_TASK_QUEUES` (default ON —
 * the deployed model since 2026-05-24, see `config.ts`), where every task
 * gets its own BullMQ queue keyed by task id. Under the legacy shared-
 * per-class-queue fallback (`FEATURE_PER_TASK_QUEUES=false`), every task in
 * a class shares ONE physical BullMQ queue and pausing that queue cannot
 * spare a single task's jobs from it — that mode is an env-var rollback path
 * only, not the production default, and is unaffected by this exemption.
 *
 * Quiet hours reuses the identical mechanism: `LUMASTRA_QUIET_HOURS_*`
 * (schema.ts) name a daily window; reconciliation pauses/resumes only the
 * `cpu` and `analysis` classes for it (watch-sync/scan/ingest keep working).
 * A class an active global pause is also holding is left alone when quiet
 * hours' own window ends — global pause owns the resume for that class.
 */

import { Queue } from 'bullmq';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { getQueueConnectionOptions } from './connection.js';
import {
    QUEUE_PREFIX,
    PER_TASK_QUEUE_PREFIX,
    taskQueueName,
    perTaskQueueName,
} from './queue-naming.js';
import { registry } from './registry.js';
import { FEATURE_PER_TASK_QUEUES } from '$lib/server/config.js';
import type { ResourceClass, TaskDefinition } from '@sapd/lumastra-plugin-sdk';
// Quiet hours are read straight from process.env rather than through the config
// SERVICE, and that is load-bearing rather than a style choice.
//
// `pause-reconcile` is a registered builtin, and scripts/build-sandbox.ts bundles
// loadBuiltins() for the plugin worker. `config/index.ts` reaches
// `config.service.ts`, which imports `$env/dynamic/private` — a SvelteKit virtual
// module that does not exist in the pruned production image, so the sandbox
// prod-import guard fails the build on it. A dynamic `import()` does NOT help:
// esbuild with `bundle: true` inlines dynamic imports, so the module lands in the
// bundle either way. The dependency has to actually go.
//
// process.env is the same source config.ts itself reads (see its header: in
// adapter-node `$env/dynamic/private` just proxies process.env), and
// config.service.ts mirrors saved settings back into process.env on every save —
// so an admin changing quiet hours in the UI is still observed here without a
// restart.
function envString(key: string, fallback: string): string {
    const v = process.env[key];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, type AuditActor } from '$lib/server/utils/audit-log.js';
import { TimeUnit } from '@valkey/valkey-glide';

const log = Logger.for('tasks.global-pause-reconcile');

/**
 * Actor for the auto-resume / quiet-hours events below — both fire from a
 * timer/reconcile path (`pause-reconcile`'s scheduled tick, or any GET/POST/
 * DELETE on `admin/ops/global-pause` reconciling a stale record) with NO
 * request in flight. There is no human actor and no credential to attribute
 * this to, so `{ username: null }` (→ logged/stored as 'system') is correct
 * — typed as an `AuditActor` rather than a bare 'system:auto-resume'/
 * 'system:quiet-hours' string, which `auditLog()` would otherwise store
 * verbatim as the actor name instead of normalizing it (security review
 * 2026-09-13, R5).
 */
const SYSTEM_ACTOR: AuditActor = { username: null };

/**
 * Task id of the scheduled reconcile heartbeat (`pause-reconcile.ts`). See
 * the module doc above — `tasksForClass` excludes this id from every
 * per-class task list it builds, and `pause-reconcile.ts` declares this same
 * constant as its own `id` so the two can never disagree.
 */
export const GLOBAL_PAUSE_RECONCILE_TASK_ID = 'pause-reconcile';

export const GLOBAL_PAUSE_KEY = 'admin:global-pause';
export const QUIET_HOURS_MARKER_KEY = 'admin:quiet-hours-paused';
/** "Heavy" classes quiet hours pauses — everything else (io/ingest/bulk/…) keeps working. */
export const QUIET_HOURS_CLASSES: ResourceClass[] = ['cpu', 'analysis'];

export interface GlobalPauseRecord {
    resumeAt: string; // ISO
    classes: ResourceClass[];
    reason?: string;
    pausedBy: string;
    pausedAt: string; // ISO
}

interface QuietHoursMarker {
    classes: ResourceClass[];
}

/**
 * Every task registered under `cls`, EXCLUDING the reconcile heartbeat
 * itself (`GLOBAL_PAUSE_RECONCILE_TASK_ID`) — see the module-level "one task
 * this module must never pause" note above. Kept pure and registry-only
 * (no BullMQ) so the exemption itself is unit-testable without a Valkey
 * connection.
 */
export function tasksForClass(cls: ResourceClass): TaskDefinition[] {
    return registry
        .getAllTasks()
        .filter((t) => t.resourceClass === cls && t.id !== GLOBAL_PAUSE_RECONCILE_TASK_ID);
}

async function queuesFor(
    classes: ResourceClass[],
    connection: NonNullable<ReturnType<typeof getQueueConnectionOptions>>,
): Promise<Map<ResourceClass, Queue[]>> {
    const map = new Map<ResourceClass, Queue[]>();
    for (const cls of classes) {
        if (FEATURE_PER_TASK_QUEUES) {
            map.set(
                cls,
                tasksForClass(cls).map(
                    (t) =>
                        new Queue(perTaskQueueName(t.id), {
                            connection,
                            prefix: PER_TASK_QUEUE_PREFIX,
                        }),
                ),
            );
        } else {
            map.set(cls, [new Queue(taskQueueName(cls), { connection, prefix: QUEUE_PREFIX })]);
        }
    }
    return map;
}

/** Pause every queue backing `classes`. Best-effort per class; never throws. */
export async function pauseClasses(classes: ResourceClass[]): Promise<ResourceClass[]> {
    if (classes.length === 0) return [];
    const connection = getQueueConnectionOptions();
    if (!connection) return [];
    const byClass = await queuesFor(classes, connection);
    const paused: ResourceClass[] = [];
    const client = getCoordinationClient();
    for (const [cls, queues] of byClass) {
        try {
            for (const q of queues) await q.pause();
            paused.push(cls);
            if (client) {
                try {
                    await client.set(`task:queue-paused:${cls}`, '1');
                } catch (err) {
                    log.warn('failed to set per-queue pause flag', { cls, err });
                }
            }
        } catch (err) {
            log.error('failed to pause resource class', err as Error, { cls });
        } finally {
            await Promise.all(byClass.get(cls)!.map((q) => q.close()));
        }
    }
    return paused;
}

/** Resume every queue backing `classes`. Best-effort per class; never throws. */
export async function resumeClasses(classes: ResourceClass[]): Promise<void> {
    if (classes.length === 0) return;
    const connection = getQueueConnectionOptions();
    if (!connection) return;
    const byClass = await queuesFor(classes, connection);
    const client = getCoordinationClient();
    for (const [cls, queues] of byClass) {
        try {
            for (const q of queues) await q.resume();
            if (client) {
                try {
                    await client.del([`task:queue-paused:${cls}`]);
                } catch (err) {
                    log.warn('failed to clear per-queue pause flag', { cls, err });
                }
            }
        } catch (err) {
            log.error('failed to resume resource class', err as Error, { cls });
        } finally {
            await Promise.all(byClass.get(cls)!.map((q) => q.close()));
        }
    }
}

export async function readGlobalPause(): Promise<GlobalPauseRecord | null> {
    const client = getCoordinationClient();
    if (!client) return null;
    try {
        const raw = await client.get(GLOBAL_PAUSE_KEY);
        if (!raw) return null;
        return JSON.parse(raw.toString()) as GlobalPauseRecord;
    } catch {
        return null;
    }
}

export async function writeGlobalPause(
    record: GlobalPauseRecord,
    ttlSeconds: number,
): Promise<void> {
    const client = getCoordinationClient();
    if (!client) return;
    await client.set(GLOBAL_PAUSE_KEY, JSON.stringify(record), {
        expiry: { type: TimeUnit.Seconds, count: ttlSeconds },
    });
}

export async function clearGlobalPause(): Promise<void> {
    const client = getCoordinationClient();
    if (!client) return;
    await client.del([GLOBAL_PAUSE_KEY]);
}

async function readQuietHoursMarker(): Promise<QuietHoursMarker | null> {
    const client = getCoordinationClient();
    if (!client) return null;
    try {
        const raw = await client.get(QUIET_HOURS_MARKER_KEY);
        if (!raw) return null;
        return JSON.parse(raw.toString()) as QuietHoursMarker;
    } catch {
        return null;
    }
}

async function writeQuietHoursMarker(marker: QuietHoursMarker | null): Promise<void> {
    const client = getCoordinationClient();
    if (!client) return;
    if (!marker || marker.classes.length === 0) {
        await client.del([QUIET_HOURS_MARKER_KEY]);
        return;
    }
    // 25h TTL: comfortably outlives one day's window even if a tick is missed,
    // while never surviving more than a day of an abandoned/orphaned marker.
    await client.set(QUIET_HOURS_MARKER_KEY, JSON.stringify(marker), {
        expiry: { type: TimeUnit.Seconds, count: 25 * 3600 },
    });
}

/** HH:MM in `timeZone` right now. */
export function currentHm(timeZone: string): string {
    try {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date());
    } catch {
        return new Intl.DateTimeFormat('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date());
    }
}

/** Whether `nowHm` falls in [start, end), wrapping past midnight when end <= start. */
export function inWindow(nowHm: string, start: string, end: string): boolean {
    if (start === end) return false;
    if (start < end) return nowHm >= start && nowHm < end;
    return nowHm >= start || nowHm < end; // wraps midnight, e.g. 22:00–06:00
}

interface QuietHoursConfig {
    enabled: boolean;
    start: string;
    end: string;
    timeZone: string;
}

async function readQuietHoursConfig(): Promise<QuietHoursConfig> {
    return {
        enabled: envString('LUMASTRA_QUIET_HOURS_ENABLED', 'false').toLowerCase() === 'true',
        start: envString('LUMASTRA_QUIET_HOURS_START', '01:00'),
        end: envString('LUMASTRA_QUIET_HOURS_END', '07:00'),
        timeZone: envString('DATE_TIMEZONE', 'UTC'),
    };
}

export interface GlobalPauseStatus {
    globalPause: {
        active: boolean;
        resumeAt?: string;
        reason?: string;
        pausedBy?: string;
        pausedAt?: string;
        classes?: ResourceClass[];
    };
    quietHours: {
        enabled: boolean;
        start: string;
        end: string;
        active: boolean;
    };
}

/**
 * Reconcile then report. Order matters: global pause resolves first so quiet
 * hours' own resume (below) can see which classes are still legitimately held
 * by an active global pause and leave those alone.
 *
 * Called from `GET/POST/DELETE admin/ops/global-pause` (operator-driven) AND
 * from the `pause-reconcile` scheduled task (time-driven) — see the module
 * doc above for why both MUST call this one function rather than two
 * implementations of the same expiry check.
 */
export async function reconcileAndReadStatus(): Promise<GlobalPauseStatus> {
    const now = Date.now();

    // 1. Global pause expiry.
    let record = await readGlobalPause();
    if (record && new Date(record.resumeAt).getTime() <= now) {
        await resumeClasses(record.classes);
        await clearGlobalPause();
        auditLog('queue.pause.global.auto-resume', 'global', SYSTEM_ACTOR, {
            classes: record.classes,
            scheduledResumeAt: record.resumeAt,
        });
        record = null;
    }

    // 2. Quiet hours.
    const qh = await readQuietHoursConfig();
    const nowHm = currentHm(qh.timeZone);
    const shouldBeActive = qh.enabled && inWindow(nowHm, qh.start, qh.end);
    const marker = await readQuietHoursMarker();

    if (shouldBeActive && !marker) {
        const currentlyGlobalPaused = new Set(record?.classes ?? []);
        const toPause = QUIET_HOURS_CLASSES.filter((c) => !currentlyGlobalPaused.has(c));
        const paused = await pauseClasses(toPause);
        await writeQuietHoursMarker({ classes: paused });
        if (paused.length > 0) {
            auditLog('queue.pause.quiet-hours', 'quiet-hours', SYSTEM_ACTOR, {
                classes: paused,
                window: `${qh.start}-${qh.end}`,
            });
        }
    } else if (!shouldBeActive && marker) {
        const currentlyGlobalPaused = new Set(record?.classes ?? []);
        const toResume = marker.classes.filter((c) => !currentlyGlobalPaused.has(c));
        await resumeClasses(toResume);
        await writeQuietHoursMarker(null);
        if (toResume.length > 0) {
            auditLog('queue.resume.quiet-hours', 'quiet-hours', SYSTEM_ACTOR, {
                classes: toResume,
            });
        }
    }

    return {
        globalPause: record
            ? {
                  active: true,
                  resumeAt: record.resumeAt,
                  reason: record.reason,
                  pausedBy: record.pausedBy,
                  pausedAt: record.pausedAt,
                  classes: record.classes,
              }
            : { active: false },
        quietHours: {
            enabled: qh.enabled,
            start: qh.start,
            end: qh.end,
            active: shouldBeActive,
        },
    };
}
