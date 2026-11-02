// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// loop-progress.ts - last-tick registry for the worker's long-running loops.
//
// "Progress" means the loop turned over, not that it completed a job: an idle
// scheduler or consumer set still ticks. The dedicated runtime's liveness probe
// fails when no loop has ticked for a configurable time.

export type LoopName = 'scheduler' | 'consumer';

const lastTick = new Map<LoopName, number>();

export function markLoopTick(loop: LoopName, now: number = Date.now()): void {
    lastTick.set(loop, now);
}

export function getLoopTick(loop: LoopName): number | undefined {
    return lastTick.get(loop);
}

/** Most recent tick across all loops, or undefined when none has ticked yet. */
export function getLastLoopTick(): number | undefined {
    let latest: number | undefined;
    for (const value of lastTick.values()) {
        if (latest === undefined || value > latest) latest = value;
    }
    return latest;
}

/** Test-only. */
export function resetLoopTicks(): void {
    lastTick.clear();
}
