// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-interval deltas from snapshots of CUMULATIVE per-process counters.
 *
 * A counter that went down (process restart) contributes 0, not a negative
 * spike. Snapshots are written by whichever replica leads, so two adjacent
 * rows may come from different processes whose counters are unrelated; a
 * change of `instanceId` is treated like a restart (0) instead of being diffed.
 */
export function deltaSeries<T extends { instanceId: string }>(
    points: readonly T[],
    value: (p: T) => number,
): number[] {
    if (points.length === 0) return [];
    const out: number[] = [0];
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const cur = points[i];
        out.push(cur.instanceId === prev.instanceId ? Math.max(0, value(cur) - value(prev)) : 0);
    }
    return out;
}
