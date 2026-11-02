// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Is any dedicated worker alive?" — watched from the web container.
 *
 * Background work only runs in the dedicated worker (WORKER_MODE=enabled,
 * DEDICATED_WORKER=true). The web container defaults to WORKER_MODE=disabled,
 * so an install upgraded without adding the worker container gets no scans,
 * no metadata, no scheduled tasks — and, without this, no error anywhere.
 *
 * After a grace period from web startup this checks the `cluster:node:*`
 * heartbeats (task Valkey) for a live `role: worker` node every minute, logs an
 * ERROR on the transition to "missing", and exposes the state for
 * /api/health/ready (detail) and the admin config-health banner.
 */

import { Logger } from '../utils/logger.js';
import { VALKEY_UPGRADE_DOCS_URL } from '../config/valkey-endpoints.js';

const log = Logger.for('WorkerPresence');

/** Long enough for a worker started together with the web container to boot. */
export const WORKER_PRESENCE_GRACE_MS = 3 * 60_000;
const CHECK_INTERVAL_MS = 60_000;
/**
 * Consecutive empty checks before "missing": a worker restart or update
 * (heartbeat TTL 30 s + up to 120 s graceful stop + boot) must not raise the
 * alarm meant for an install that has no worker at all.
 */
export const MISSES_BEFORE_MISSING = 3;

export type WorkerPresenceStatus = 'starting' | 'present' | 'missing' | 'unknown';

export interface WorkerPresence {
    status: WorkerPresenceStatus;
    /** Live worker nodes seen at the last check. */
    workers: number;
    checkedAt: string | null;
}

export const WORKER_MISSING_MESSAGE =
    'No background worker is running: no live worker heartbeat in the task Valkey. ' +
    'Library scans, metadata, artwork and scheduled tasks are not running.';

export const WORKER_MISSING_REMEDIATION =
    'Run the dedicated worker container next to the web container (image entrypoint ./start-worker.sh, ' +
    'WORKER_MODE=enabled, DEDICATED_WORKER=true, the same DATABASE_URL and TASK_CACHE_URL). ' +
    `Upgrade guide: ${VALKEY_UPGRADE_DOCS_URL}`;

interface Deps {
    /** Live worker count, or null when the task Valkey cannot answer. */
    countWorkers: () => Promise<number | null>;
    now: () => number;
}

async function defaultCountWorkers(): Promise<number | null> {
    const { isCoordinationValkeyHealthy } = await import('../cache/valkey.js');
    // readClusterNodes() swallows Valkey errors into []; an outage must read as
    // "unknown", never as "no worker".
    if (!(await isCoordinationValkeyHealthy(2000))) return null;
    const { readClusterNodes } = await import('./cluster-heartbeat.service.js');
    const nodes = await readClusterNodes();
    return nodes.filter((node) => node.role === 'worker').length;
}

export function createWorkerPresenceMonitor(
    deps: Deps = { countWorkers: defaultCountWorkers, now: Date.now },
) {
    const startedAt = deps.now();
    let state: WorkerPresence = { status: 'starting', workers: 0, checkedAt: null };
    let timer: ReturnType<typeof setInterval> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let checking: Promise<void> | null = null;
    /** An outage was logged; cleared only by a seen worker, not by an "unknown" blip. */
    let missingLogged = false;
    let missStreak = 0;
    let stopped = false;

    async function check(): Promise<void> {
        let workers: number | null;
        try {
            workers = await deps.countWorkers();
        } catch (err) {
            log.debug('Worker presence check failed', { error: String(err) });
            workers = null;
        }
        if (stopped) return;
        const checkedAt = new Date(deps.now()).toISOString();
        if (workers === null) {
            state = {
                status: state.status === 'missing' ? 'missing' : 'unknown',
                workers: 0,
                checkedAt,
            };
            return;
        }
        if (workers > 0) {
            missStreak = 0;
            state = { status: 'present', workers, checkedAt };
            if (missingLogged) log.info('Background worker is back', { workers });
            missingLogged = false;
            return;
        }
        if (deps.now() - startedAt < WORKER_PRESENCE_GRACE_MS) {
            state = { status: 'starting', workers: 0, checkedAt };
            return;
        }
        missStreak++;
        if (missStreak < MISSES_BEFORE_MISSING) {
            state = {
                status: state.status === 'present' ? 'present' : 'starting',
                workers: 0,
                checkedAt,
            };
            return;
        }
        state = { status: 'missing', workers: 0, checkedAt };
        if (!missingLogged) {
            missingLogged = true;
            log.error(WORKER_MISSING_MESSAGE, undefined, {
                remediation: WORKER_MISSING_REMEDIATION,
            });
        }
    }

    function runCheck(): Promise<void> {
        checking ??= check().finally(() => {
            checking = null;
        });
        return checking;
    }

    return {
        start(): void {
            if (timer || graceTimer) return;
            stopped = false;
            graceTimer = setTimeout(() => {
                graceTimer = null;
                void runCheck();
                timer = setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
                timer.unref?.();
            }, WORKER_PRESENCE_GRACE_MS);
            graceTimer.unref?.();
        },
        stop(): void {
            stopped = true;
            if (graceTimer) clearTimeout(graceTimer);
            if (timer) clearInterval(timer);
            graceTimer = null;
            timer = null;
        },
        check: runCheck,
        get(): WorkerPresence {
            return state;
        },
    };
}

export type WorkerPresenceMonitor = ReturnType<typeof createWorkerPresenceMonitor>;

export const workerPresence = createWorkerPresenceMonitor();
