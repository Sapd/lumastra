// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Render-only bounds; never replace an unavailable sample with a measured zero. */
export function gpuMeterPercent(value: number): number {
    return Math.max(0, Math.min(100, value));
}

export interface GpuHistorySegment {
    points: string;
    firstX: number;
    firstY: number;
    count: number;
}

/** A missing poll breaks the line. Singleton measurements remain visible as dots. */
export function gpuHistorySegments(
    history: (number | null)[],
    capacity: number,
): GpuHistorySegment[] {
    const segments: GpuHistorySegment[] = [];
    let segment: GpuHistorySegment | undefined;
    for (const [i, value] of history.entries()) {
        if (value === null || !Number.isFinite(value)) {
            segment = undefined;
            continue;
        }
        const x = ((capacity - history.length + i) / (capacity - 1)) * 100;
        const y = 100 - gpuMeterPercent(value);
        const point = `${x.toFixed(2)},${y.toFixed(2)}`;
        if (segment) {
            segment.points += ` ${point}`;
            segment.count++;
        } else {
            segment = { points: point, firstX: x, firstY: y, count: 1 };
            segments.push(segment);
        }
    }
    return segments;
}

export interface GpuHistoryState {
    hostId: string;
    sampledAt: number;
    values: (number | null)[];
}

/** Keep a bounded rolling window; failed/delayed polls become explicit gaps on recovery. */
export function appendGpuHistory(
    previous: GpuHistoryState | undefined,
    hostId: string,
    sampledAt: number,
    value: number | null,
    capacity: number = 40,
    intervalMs: number = 10_000,
): GpuHistoryState {
    const sameHost = previous?.hostId === hostId;
    const values = sameHost ? previous.values : [];
    const missed = sameHost
        ? Math.min(
              capacity,
              Math.max(0, Math.round((sampledAt - previous.sampledAt) / intervalMs) - 1),
          )
        : 0;
    const gaps: null[] = Array.from({ length: missed }, () => null);
    return {
        hostId,
        sampledAt,
        values: [...values, ...gaps, value !== null && Number.isFinite(value) ? value : null].slice(
            -capacity,
        ),
    };
}
