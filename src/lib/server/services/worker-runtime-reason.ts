// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runtime state a dedicated worker publishes in its cluster heartbeat, and the
 * rule that decides whether that state makes the worker unavailable.
 *
 * Every field is optional: nodes running an older build publish none of it and
 * are treated as available. Values are bounded enums and counters only; no
 * hostnames, URLs or error text.
 */

export interface HeartbeatRuntimeState {
    upgradeState?: string;
    consumers?: { running: number; paused: number; lastProgressAt?: string };
    watcher?: { state: string; restarts: number; coverage?: string };
    lease?: { held: boolean; lastRenewAt?: string };
    lastTickAt?: string;
    uncaughtExceptions?: number;
}

const UPGRADE_UNAVAILABLE = new Set(['preparing', 'prepared', 'stopping', 'unknown']);

/** Reasons the node cannot take work right now; empty when it is available. */
export function workerUnavailableReasons(runtime: HeartbeatRuntimeState | undefined): string[] {
    if (!runtime) return [];
    const reasons: string[] = [];
    if (runtime.upgradeState && UPGRADE_UNAVAILABLE.has(runtime.upgradeState)) {
        reasons.push(`upgrade_${runtime.upgradeState}`);
    }
    if (runtime.consumers && runtime.consumers.running === 0) {
        // `running` already excludes paused workers.
        reasons.push(runtime.consumers.paused > 0 ? 'consumers_paused' : 'consumers_stopped');
    }
    if (runtime.lease && !runtime.lease.held) reasons.push('singleton_lease_not_held');
    return reasons;
}
