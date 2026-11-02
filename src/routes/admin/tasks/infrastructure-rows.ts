// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AdminStatusResponse } from '$lib/schemas/api-admin-responses.js';

export type InfrastructureSeverity = 'ok' | 'warn' | 'info';

export interface InfrastructureRow {
    id: string;
    icon: string;
    message: string;
    severity: InfrastructureSeverity;
    /**
     * When true, the catalog page appends a "check the logs" link (to
     * /admin/system/health) after `message` instead of leaving the phrase
     * as inert text with nowhere to go.
     */
    showLogsLink?: boolean;
    /**
     * When true, the catalog page appends an "add a library" link (to
     * /admin/library) after `message` — used for the neutral zero-library
     * file-watcher hint.
     */
    showLibraryLink?: boolean;
}

// Watcher renews its Valkey lock every 10s (HEARTBEAT_INTERVAL_MS in
// _helpers/file-scanner/watcher.ts). 2x that is the spec's stale threshold —
// the leader has missed at least two consecutive renewal windows.
export const WATCHER_HEARTBEAT_INTERVAL_MS = 10_000;
export const STALE_HEARTBEAT_THRESHOLD_MS = 2 * WATCHER_HEARTBEAT_INTERVAL_MS;

export function formatAgo(deltaMs: number): string {
    if (deltaMs < 0) deltaMs = 0;
    const s = Math.round(deltaMs / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(deltaMs / 60_000);
    if (m < 60) return `${m}m`;
    const h = Math.round(deltaMs / 3_600_000);
    if (h < 24) return `${h}h`;
    return `${Math.round(deltaMs / 86_400_000)}d`;
}

function parseIso(v: string | undefined | null): number | null {
    if (!v) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
}

export function buildInfrastructureRows(
    status: AdminStatusResponse | null,
    now: number,
    /** True when zero library paths are configured — a fresh install with
     * nothing to watch yet, not a fault. */
    hasNoLibraries = false,
): InfrastructureRow[] {
    const rows: InfrastructureRow[] = [];
    const watcher = status?.lumastraChecks?.watcher;

    if (!watcher) return rows;

    const heartbeatMs = parseIso(watcher.leaderHeartbeatAt);

    // Case 1 — active here. This replica holds the lock.
    if (watcher.active) {
        const lastEventMs = parseIso(watcher.lastEventAt);
        const lastEventFragment = lastEventMs
            ? ` · last event ${formatAgo(now - lastEventMs)} ago`
            : ' · no events yet';
        const partial = watcher.coverage === 'partial';
        rows.push({
            id: 'file-watcher',
            icon: partial ? '⚠️' : '📡',
            severity: partial ? 'warn' : 'ok',
            message: partial
                ? `File watcher: active here with partial coverage · ${watcher.paths} paths${lastEventFragment}`
                : `File watcher: active here · ${watcher.paths} paths${lastEventFragment}`,
        });
    } else if (watcher.leaderElsewhere && heartbeatMs !== null) {
        // Case 2/3 — another server is handling it. Severity depends on freshness.
        const heartbeatAge = Math.max(0, now - heartbeatMs);
        if (heartbeatAge <= STALE_HEARTBEAT_THRESHOLD_MS) {
            rows.push({
                id: 'file-watcher',
                icon: '📡',
                severity: 'ok',
                message: `File watcher: handled by another server · last checked in ${formatAgo(heartbeatAge)} ago`,
            });
        } else {
            rows.push({
                id: 'file-watcher',
                icon: '⚠️',
                severity: 'warn',
                message: `File watcher: the server handling it hasn't checked in for ${formatAgo(heartbeatAge)}`,
                showLogsLink: true,
            });
        }
    } else if (watcher.leaderElsewhere) {
        // Server claims another server is handling it but didn't include a recent
        // check-in — distinct from "nothing is handling it", flag it explicitly so
        // an operator doesn't restart a healthy peer.
        rows.push({
            id: 'file-watcher',
            icon: '⚠️',
            severity: 'warn',
            message: "File watcher: another server claims to be handling it but hasn't checked in",
            showLogsLink: true,
        });
    } else if (hasNoLibraries) {
        // Case 4a — nothing is handling it, but that's expected: a fresh
        // install with zero libraries has nothing to watch yet. Neutral
        // hint instead of an amber warning.
        rows.push({
            id: 'file-watcher',
            icon: 'ℹ️',
            severity: 'info',
            message: 'No libraries yet — file watching starts once you add one.',
            showLibraryLink: true,
        });
    } else {
        // Case 4b — nothing is handling it, and libraries exist. A real fault.
        rows.push({
            id: 'file-watcher',
            icon: '⚠️',
            severity: 'warn',
            message: 'File watcher: inactive — no server is currently watching for new files',
        });
    }

    const limitations = watcher.limitations ?? [];
    if (limitations.includes('network_shares')) {
        const secs = watcher.networkReconcileSecs;
        const unreconciled = limitations.includes('network_unreconciled') || secs === 0;
        rows.push({
            id: 'file-watcher-network',
            icon: unreconciled ? '⚠️' : 'ℹ️',
            severity: unreconciled ? 'warn' : 'info',
            message: unreconciled
                ? 'Live updates limited on network shares — changes there are only picked up by scheduled scans'
                : `Live updates limited on network shares — changes there are picked up by a reconcile${secs ? ` every ${Math.max(1, Math.round(secs / 60))} min` : ''} and by scheduled scans`,
        });
    }
    if (limitations.includes('stalled_probes')) {
        rows.push({
            id: 'file-watcher-stalled',
            icon: '⚠️',
            severity: 'warn',
            message:
                'File watcher: a storage probe is stalled (hung mount?), so some folders are not being checked',
        });
    }
    if (limitations.includes('stalled_roots')) {
        rows.push({
            id: 'file-watcher-stalled-roots',
            icon: '⚠️',
            severity: 'warn',
            message:
                'File watcher: storage behind a library folder is not responding (hung mount?), so live updates there are paused; other libraries are still watched',
        });
    }
    if (limitations.includes('unwatched_dirs')) {
        rows.push({
            id: 'file-watcher-unwatched',
            icon: '⚠️',
            severity: 'warn',
            message:
                'File watcher: some folders are not watched live; changes there are found by scheduled scans',
        });
    }
    if (limitations.includes('unreadable_dirs')) {
        rows.push({
            id: 'file-watcher-unreadable',
            icon: '⚠️',
            severity: 'warn',
            message:
                'File watcher: some folders cannot be read, so changes there are only found by scheduled scans',
        });
    }

    // Leader-reported error (e.g. inotify limit hit). Surface as its own row so
    // the cause is visible even if the leader is otherwise healthy.
    if (watcher.leaderError) {
        rows.push({
            id: 'file-watcher-error',
            icon: '⚠️',
            severity: 'warn',
            message: `File watcher error: ${watcher.leaderError}`,
        });
    }

    return rows;
}
