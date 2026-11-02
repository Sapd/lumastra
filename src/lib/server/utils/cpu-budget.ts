// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Effective CPU budget detection.
 *
 * Containers are commonly capped with Docker `cpus:` / `--cpus` (or a Kubernetes
 * CPU limit), which the kernel enforces as a **cgroup CFS quota**. Node's
 * `os.availableParallelism()` does NOT see that quota — it reports the number of
 * CPUs allowed by the process's *affinity mask* (only `--cpuset-cpus` changes
 * that), so on a quota-capped worker it over-reports the host's full core count
 * and any pool sized off it (ffmpeg threads, Essentia concurrency, task-runner
 * defaults) over-subscribes the cap and starves the serving path.
 *
 * This module reads the CFS quota directly (cgroup v2 `cpu.max`, falling back to
 * cgroup v1 `cpu.cfs_quota_us`/`cpu.cfs_period_us`) and exposes the *effective*
 * core budget so callers can size defaults to what the container may actually use.
 * It is server-only (reads `/sys/fs/cgroup` + `node:os`) — never import it from
 * client/shared code or from `$lib/config/schema` (which the admin UI bundles).
 */

import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Logger } from './logger.js';

const logger = Logger.for('CpuBudget');

export interface CpuBudget {
    /**
     * Cores this process may actually use: the cgroup CFS quota when set, else the
     * host parallelism. A float (Docker allows fractional `cpus: 1.5`), always ≥ 1.
     */
    effectiveCores: number;
    /** Host-visible parallelism — ignores the cgroup CFS quota (what Node reports). */
    hostCores: number;
    /** Where {@link CpuBudget.effectiveCores} came from, for operator logging. */
    source: 'cgroup-v2' | 'cgroup-v1' | 'host';
}

/**
 * Parse cgroup-v2 `cpu.max` contents. Format is `"<quota> <period>"` in
 * microseconds, or `"max <period>"` when uncapped. Returns the effective core
 * count (`quota / period`), or `null` when uncapped or unparseable.
 */
export function parseCgroupV2CpuMax(contents: string): number | null {
    const parts = contents.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const [quotaRaw, periodRaw] = parts;
    if (quotaRaw === 'max') return null; // uncapped
    const quota = Number(quotaRaw);
    const period = Number(periodRaw);
    if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) {
        return null;
    }
    return quota / period;
}

/**
 * Parse cgroup-v1 CFS quota/period (microseconds). A quota of `-1` (or any value
 * ≤ 0) means uncapped → `null`. Returns `quota / period` cores otherwise.
 */
export function parseCgroupV1Cfs(quotaContents: string, periodContents: string): number | null {
    const quota = Number(quotaContents.trim());
    const period = Number(periodContents.trim());
    if (!Number.isFinite(quota) || quota <= 0) return null; // -1 = uncapped
    if (!Number.isFinite(period) || period <= 0) return null;
    return quota / period;
}

/** Injection seam so {@link computeCpuBudget} is testable without touching the FS. */
export interface CpuBudgetReaders {
    /** Contents of `/sys/fs/cgroup/cpu.max`, or `null` if absent/unreadable. */
    readV2(): string | null;
    /** Contents of `/sys/fs/cgroup/cpu/cpu.cfs_quota_us`, or `null`. */
    readV1Quota(): string | null;
    /** Contents of `/sys/fs/cgroup/cpu/cpu.cfs_period_us`, or `null`. */
    readV1Period(): string | null;
    /** Host parallelism (`os.availableParallelism()`). */
    hostCores(): number;
}

function safeRead(path: string): string | null {
    try {
        return readFileSync(path, 'utf-8');
    } catch {
        return null;
    }
}

const defaultReaders: CpuBudgetReaders = {
    readV2: () => safeRead('/sys/fs/cgroup/cpu.max'),
    readV1Quota: () => safeRead('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
    readV1Period: () => safeRead('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
    hostCores: () => availableParallelism(),
};

/**
 * Compute the CPU budget from the given readers (real FS by default). A CFS quota
 * above the host core count is clamped to the host — a quota larger than the box
 * is meaningless for sizing pools — and the result is floored at 1 core.
 */
export function computeCpuBudget(readers: CpuBudgetReaders = defaultReaders): CpuBudget {
    const hostCores = Math.max(1, readers.hostCores());

    const v2 = readers.readV2();
    if (v2 !== null) {
        const cores = parseCgroupV2CpuMax(v2);
        if (cores !== null) {
            return {
                effectiveCores: clampToHost(cores, hostCores),
                hostCores,
                source: 'cgroup-v2',
            };
        }
    }

    const quota = readers.readV1Quota();
    if (quota !== null) {
        // The quota file is the one that actually carries the cap. If the period
        // file is missing/unreadable, fall back to the kernel default period
        // (100ms = 100000µs) rather than ignoring the cap and over-subscribing.
        const period = readers.readV1Period() ?? '100000';
        const cores = parseCgroupV1Cfs(quota, period);
        if (cores !== null) {
            return {
                effectiveCores: clampToHost(cores, hostCores),
                hostCores,
                source: 'cgroup-v1',
            };
        }
    }

    return { effectiveCores: hostCores, hostCores, source: 'host' };
}

function clampToHost(cores: number, hostCores: number): number {
    return Math.max(1, Math.min(cores, hostCores));
}

let cached: CpuBudget | null = null;

/**
 * The process's effective CPU budget, detected once and memoized. Logs the
 * decision on first call so operators can see what core count the app sized
 * itself to (and whether a cgroup cap was detected).
 */
export function getCpuBudget(): CpuBudget {
    if (cached) return cached;
    cached = computeCpuBudget();
    const { effectiveCores, hostCores, source } = cached;
    logger.info('Detected CPU budget', {
        effectiveCores: Math.round(effectiveCores * 100) / 100,
        hostCores,
        source,
        // True when a cgroup CPU cap below the host was detected — the case Node's
        // availableParallelism() misses.
        capped: source !== 'host' && effectiveCores < hostCores,
    });
    return cached;
}

/**
 * Effective cores as an integer floor (≥ 1), for sizing concurrency / thread
 * pools. Prefer this over `os.availableParallelism()` for any background-work
 * budget so a `cpus:` cap is respected.
 */
export function getCpuBudgetCores(): number {
    return Math.max(1, Math.floor(getCpuBudget().effectiveCores));
}

/** Test-only: drop the memoized detection so a test can re-detect. */
export function __resetCpuBudgetForTests(): void {
    cached = null;
}
