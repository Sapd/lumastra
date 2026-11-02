// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Validate once when timing data changes, rather than scanning at every tick. */
export function validBeatGrid(grid?: readonly number[]): readonly number[] | null {
    if (!grid?.length) return null;
    for (let i = 0; i < grid.length; i++) {
        if (!Number.isFinite(grid[i]) || grid[i] < 0 || (i > 0 && grid[i] <= grid[i - 1])) {
            return null;
        }
    }
    return grid;
}

/** Playback-position-driven envelope; BPM continues a truncated grid from its last beat. */
export function playheadBeatStrength(
    positionMs: number,
    grid: readonly number[] | null,
    bpm?: number,
): number {
    if (!Number.isFinite(positionMs) || positionMs < 0) return 0;
    const time = positionMs / 1000;
    let age: number;
    let interval: number;
    if (grid) {
        // Upper bound: the most recent beat, in O(log n).
        let lo = 0;
        let hi = grid.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (grid[mid] <= time) lo = mid + 1;
            else hi = mid;
        }
        const index = lo - 1;
        if (index < 0) return 0;
        age = time - grid[index];
        if (index + 1 < grid.length) {
            interval = grid[index + 1] - grid[index];
        } else {
            // Analysis stores a capped prefix of the track's beats. Continue
            // from the last measured beat, never from an unrelated time zero.
            const bpmInterval = bpm && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : 0;
            if (Number.isFinite(bpmInterval) && bpmInterval > 0) {
                interval = bpmInterval;
                age %= interval;
            } else {
                interval = index > 0 ? grid[index] - grid[index - 1] : 1;
            }
        }
    } else {
        if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return 0;
        interval = 60 / bpm;
        if (!Number.isFinite(interval) || interval <= 0) return 0;
        age = time % interval;
    }
    const duration = Math.min(0.22, interval / 2);
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - age / duration));
}
