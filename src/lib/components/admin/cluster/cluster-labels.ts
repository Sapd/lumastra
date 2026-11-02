// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Display strings and colours for the cluster view (cluster-hosts.ts holds the logic). */

import * as m from '$lib/paraglide/messages.js';
import type {
    ClusterServiceEntry,
    ServiceKind,
    ServiceReason,
    ServiceState,
} from './cluster-hosts.js';

export function serviceKindLabel(kind: ServiceKind): string {
    switch (kind) {
        case 'web':
            return m.admin_cluster_kind_web();
        case 'worker':
            return m.admin_cluster_kind_worker();
        case 'proxy':
            return m.admin_cluster_kind_proxy();
        case 'sonic':
            return m.admin_cluster_kind_sonic();
        default:
            return m.admin_cluster_kind_general();
    }
}

export function implementationLabel(impl: 'node' | 'rust' | 'python'): string {
    switch (impl) {
        case 'rust':
            return 'Rust';
        case 'python':
            return 'Python';
        default:
            return 'TypeScript';
    }
}

export function stateLabel(state: ServiceState): string {
    switch (state) {
        case 'healthy':
            return m.admin_cluster_state_healthy();
        case 'degraded':
            return m.admin_cluster_state_degraded();
        case 'stale':
            return m.admin_cluster_state_stale();
        default:
            return m.admin_cluster_state_not_configured();
    }
}

export function stateClasses(state: ServiceState): {
    dot: string;
    pill: string;
    text: string;
    border: string;
} {
    switch (state) {
        case 'healthy':
            return {
                dot: 'bg-green-400',
                pill: 'bg-green-500/15 text-green-300',
                text: 'text-surface-200',
                border: 'border-surface-700/60',
            };
        case 'degraded':
            return {
                dot: 'bg-amber-400',
                pill: 'bg-amber-500/15 text-amber-300',
                text: 'text-amber-300',
                border: 'border-amber-500/40',
            };
        case 'stale':
            return {
                dot: 'bg-red-500',
                pill: 'bg-red-500/15 text-red-300',
                text: 'text-red-300',
                border: 'border-red-500/40',
            };
        default:
            return {
                dot: 'bg-surface-500',
                pill: 'bg-surface-700/60 text-surface-400',
                text: 'text-surface-400',
                border: 'border-dashed border-surface-700',
            };
    }
}

export function reasonLabel(reason: ServiceReason, entry: ClusterServiceEntry): string {
    switch (reason) {
        case 'heartbeatLate':
            return m.admin_cluster_reason_heartbeat_late({
                seconds: Math.round((entry.lastSeenAgoMs ?? 0) / 1000),
            });
        case 'noHeartbeat':
            return m.admin_cluster_reason_no_heartbeat();
        case 'wentOffline':
            return m.admin_cluster_reason_went_offline();
        case 'memoryNearLimit':
            return m.admin_cluster_reason_memory_near_limit();
        case 'sidecarLoading':
            return m.admin_cluster_reason_sidecar_loading();
        case 'sidecarError':
            return m.admin_cluster_reason_sidecar_error({
                status: entry.sidecar?.httpStatus ?? 0,
            });
        case 'sidecarDown':
            return m.admin_cluster_reason_sidecar_down();
        case 'workerUnavailable':
            return m.admin_cluster_reason_worker_unavailable({
                reasons: (entry.node?.unavailableReasons ?? []).map(workerReasonLabel).join(', '),
            });
        case 'watcherDegraded':
            return m.admin_cluster_reason_watcher({
                state: entry.node?.runtime?.watcher?.state ?? '',
                restarts: entry.node?.runtime?.watcher?.restarts ?? 0,
            });
    }
}

export function formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours < 24) return `${hours}h ${mins}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}

/** Codes from worker-runtime-reason.ts (server) → words. Unknown codes pass through. */
export function workerReasonLabel(code: string): string {
    if (code.startsWith('upgrade_')) {
        return m.admin_cluster_worker_reason_upgrade({ state: code.slice('upgrade_'.length) });
    }
    switch (code) {
        case 'consumers_paused':
            return m.admin_cluster_worker_reason_consumers_paused();
        case 'consumers_stopped':
            return m.admin_cluster_worker_reason_consumers_stopped();
        case 'singleton_lease_not_held':
            return m.admin_cluster_worker_reason_lease();
        default:
            return code;
    }
}
