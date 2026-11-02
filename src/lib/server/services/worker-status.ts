// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Background-worker availability check.
 *
 * Web servers enqueue work; a dedicated task process consumes it. Report a
 * missing worker up front on onboarding and library screens so operators can
 * start it before expecting scans, enrichment or recommendations.
 *
 * A worker process can confirm itself; web processes require a live worker
 * heartbeat from the shared cluster state.
 */

import { shouldStartWorkers } from '$lib/server/config.js';
import { readClusterNodes } from '$lib/server/services/cluster-heartbeat.service.js';
import { workerUnavailableReasons } from '$lib/server/services/worker-runtime-reason.js';

export interface WorkerStatus {
    available: boolean;
    /**
     * `probe-failed`: the cluster read threw, so absence was not measured.
     * `cluster-unavailable`: worker nodes heartbeat, but none can take work right now.
     */
    source: 'in-process' | 'cluster' | 'cluster-unavailable' | 'none' | 'probe-failed';
    detail: string;
    /** Stable reason codes when source is `cluster-unavailable`. */
    reasons?: string[];
}

const REASON_TEXT: Record<string, string> = {
    upgrade_preparing: 'an upgrade is being prepared',
    upgrade_prepared: 'an upgrade is prepared and consumers are paused',
    upgrade_stopping: 'the worker is stopping for an upgrade',
    upgrade_unknown: 'an upgrade left the worker in an unknown state',
    consumers_stopped: 'its queue consumers are stopped',
    consumers_paused: 'its queue consumers are paused',
    singleton_lease_not_held: 'it does not hold the singleton lease',
};

export async function getBackgroundWorkerStatus(): Promise<WorkerStatus> {
    if (shouldStartWorkers()) {
        return {
            available: true,
            source: 'in-process',
            detail: 'This dedicated worker process runs scans and background processing.',
        };
    }

    // Split deployment: look for a live, dedicated worker node.
    try {
        const nodes = await readClusterNodes();
        const workers = nodes.filter((n) => n.role === 'worker');
        if (workers.length > 0) {
            const states = workers.map((n) => workerUnavailableReasons(n.runtime));
            if (states.some((reasons) => reasons.length === 0)) {
                return {
                    available: true,
                    source: 'cluster',
                    detail: 'A dedicated worker node is online and will process background jobs.',
                };
            }
            const reasons = [...new Set(states.flat())];
            return {
                available: false,
                source: 'cluster-unavailable',
                reasons,
                detail:
                    'A dedicated worker node is online but not processing background jobs: ' +
                    reasons.map((r) => REASON_TEXT[r] ?? r).join('; ') +
                    '.',
            };
        }
    } catch {
        // Valkey/cluster read failed. Not "available" — we can't confirm it — but
        // not "none" either: a diagnostic that reads `none` names a missing
        // worker as the cause when nothing was measured.
        return {
            available: false,
            source: 'probe-failed',
            detail: 'Could not check for a dedicated worker node: the cluster state did not answer.',
        };
    }

    return {
        available: false,
        source: 'none',
        detail:
            'No background worker was detected. Library scans, metadata enrichment and AI recommendations will not run until one is online. ' +
            'Start the dedicated worker service alongside the web server.',
    };
}
