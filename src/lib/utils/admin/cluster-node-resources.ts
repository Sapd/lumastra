// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Display helpers for the per-node CPU/memory block on the cluster node card.
 * Binary units on purpose: Kubernetes limits are written as Mi/Gi, so a 4Gi
 * limit must read "4.0 GiB", not "4.3 GB".
 */

export type ResourceLevel = 'ok' | 'warn' | 'critical';

/** Memory share at which the bar turns amber / red. The OOM killer fires at 100 %. */
export const MEMORY_WARN_RATIO = 0.75;
export const MEMORY_CRITICAL_RATIO = 0.9;

export function formatBinaryBytes(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    if (unit === 0) return `${Math.round(value)} B`;
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Cores with two significant decimals below one core, one above ("0.35", "1.5", "12"). */
export function formatCores(cores: number): string {
    if (cores >= 10) return cores.toFixed(0);
    if (cores >= 1) return String(Number(cores.toFixed(1)));
    return String(Number(cores.toFixed(2)));
}

/** Share of the limit in use (0..1+, can exceed 1 for CPU bursts) or null without a limit. */
export function usageRatio(used: number | undefined, limit: number | undefined): number | null {
    if (used === undefined || limit === undefined || limit <= 0) return null;
    return used / limit;
}

export function memoryLevel(ratio: number | null): ResourceLevel {
    if (ratio === null) return 'ok';
    if (ratio >= MEMORY_CRITICAL_RATIO) return 'critical';
    if (ratio >= MEMORY_WARN_RATIO) return 'warn';
    return 'ok';
}
