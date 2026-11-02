// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mission Control `/now` snapshot assembly (Slice 4).
 *
 * Pure functions that compose the slow-changing context the `/api/admin/
 * task-system/now` endpoint returns — per-class queue depths + caps →
 * saturation, cluster node identities, and the health summary. The endpoint is
 * a thin wrapper that gathers the inputs (orchestrator queue depths/caps,
 * `readClusterNodes`, `readClassLeaders`, the observability verdict) and hands
 * them here, so the composition is unit-testable without SvelteKit/Valkey
 * plumbing — mirroring the Slice-1 `computeHealthVerdict` precedent.
 *
 * No new SQL, no new hot path: every input is read via the SAME helper the
 * existing endpoints use (slice-4 spec §5).
 */

import type {
    ClassSnapshot,
    EmbeddingCoverage,
    NodeSnapshot,
    NowHealth,
} from '$lib/schemas/mission-control.schema.js';
import type { HealthTaxonomy } from '$lib/schemas/task-system-health.schema.js';
import type { LiveClusterNode } from '$lib/server/services/cluster-heartbeat.service.js';

/** Per-class queue depth shape (mirrors `orchestrator.getQueueDepths()`). */
export interface QueueDepthEntry {
    waiting: number;
    active: number;
    delayed: number;
    paused: boolean;
}

/** Per-class leader holder (subset of Slice 0's `ClassLeader`). */
export interface LeaderEntry {
    resourceClass: string;
    holderInstanceId: string | null;
}

export interface AssembleNowSnapshotInput {
    /** Canonical RESOURCE_CLASSES list — the iteration order for group headers. */
    resourceClasses: readonly string[];
    /** Per-class queue depths from `orchestrator.getQueueDepths()`. */
    queueDepths: Partial<Record<string, QueueDepthEntry>>;
    /** Per-class concurrency caps from `orchestrator.getConcurrencyCaps()`. */
    caps: Partial<Record<string, number>>;
    /** Per-class leaders (Slice 0). Empty when Slice 0 absent — leader omitted. */
    leaders: LeaderEntry[];
    /** Live cluster nodes from `readClusterNodes()`. */
    nodes: LiveClusterNode[];
    /** This replica's instance id (config.INSTANCE_ID), for `isSelf`. */
    selfInstanceId: string;
    /** Slice 1 health verdict status; null/undefined when observability absent. */
    healthStatus: HealthTaxonomy | null;
    /** Whether the observability endpoint/inputs were readable. */
    healthAvailable: boolean;
}

/**
 * Saturation ratio for a class. `null` when the cap is unknown/uncapped
 * (`cap <= 0`) so the UI can render "—" instead of a misleading 0%. Otherwise
 * `active / cap` (can exceed 1 transiently if more workers than the boot-time
 * cap are draining — the badge clamps display, but the raw ratio is preserved).
 */
export function computeSaturation(active: number, cap: number): number | null {
    if (!Number.isFinite(cap) || cap <= 0) return null;
    return active / cap;
}

/** True when the class is at or over its cap (amber badge). */
export function isSaturated(active: number, cap: number): boolean {
    return Number.isFinite(cap) && cap > 0 && active >= cap;
}

/** Build the per-class snapshots in canonical RESOURCE_CLASSES order. */
export function buildClassSnapshots(input: AssembleNowSnapshotInput): ClassSnapshot[] {
    const leaderByClass = new Map<string, string | null>();
    for (const l of input.leaders) leaderByClass.set(l.resourceClass, l.holderInstanceId);
    const hasLeaders = input.leaders.length > 0;

    return input.resourceClasses.map((cls): ClassSnapshot => {
        const depth = input.queueDepths[cls] ?? {
            waiting: 0,
            active: 0,
            delayed: 0,
            paused: false,
        };
        const cap = input.caps[cls] ?? 0;
        const snapshot: ClassSnapshot = {
            resourceClass: cls,
            waiting: depth.waiting,
            active: depth.active,
            delayed: depth.delayed,
            paused: depth.paused,
            cap,
            saturationPct: computeSaturation(depth.active, cap),
        };
        // Only attach the leader field when Slice 0 supplied leaders at all —
        // absent leaders mean "unknown", which the UI hides (no badge), not
        // "no leader" (which would be a red signal). `?? null` keeps the field
        // present-but-null for a class that has leaders generally but not this one.
        if (hasLeaders) {
            snapshot.leaderInstanceId = leaderByClass.get(cls) ?? null;
        }
        return snapshot;
    });
}

/** Build the cluster node identity snapshots. */
export function buildNodeSnapshots(input: AssembleNowSnapshotInput): NodeSnapshot[] {
    return input.nodes.map((n): NodeSnapshot => ({
        instanceId: n.instanceId,
        isSelf: n.instanceId === input.selfInstanceId,
        // A node present in the live heartbeat set is, by definition, online.
        online: true,
        version: n.version || null,
    }));
}

/** Build the header health summary. */
export function buildNowHealth(input: AssembleNowSnapshotInput): NowHealth {
    const status: HealthTaxonomy = input.healthStatus ?? 'unknown';
    return { status, available: input.healthAvailable };
}

/**
 * Build the library-embedding coverage scalar from raw eligible/embedded counts.
 * `coveragePct` is null when nothing is eligible (avoids a misleading 0/0 → 0%).
 * Clamps `missing` at 0 in case a race makes embedded momentarily exceed
 * eligible.
 */
export function buildEmbeddingCoverage(counts: {
    eligible: number;
    embedded: number;
}): EmbeddingCoverage {
    const eligible = Math.max(0, counts.eligible);
    const embedded = Math.max(0, counts.embedded);
    return {
        eligible,
        embedded,
        missing: Math.max(0, eligible - embedded),
        coveragePct: eligible > 0 ? Math.min(1, embedded / eligible) : null,
    };
}
