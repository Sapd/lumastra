// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One-glance summary of Admin → System health → Cluster for the /admin home tile.
 *
 * Built server-side from the same cluster core the cluster view reads (and the same
 * service model, cluster-hosts.ts), then shipped inside the admin status payload, so
 * Home makes no fetch of its own and the tile can never disagree with the cluster
 * view about which services are up.
 *
 * Every figure is the WORST across hosts/services: the tile answers "is any machine
 * or container in trouble", and the cluster view says which one. The thresholds are
 * exported because the attention producers (attention/adapters.ts) use the same
 * numbers for the sustained-pressure alerts.
 */

import type { ClusterNode, ClusterStatusResponse } from '$lib/schemas/api-admin-responses';
import type { ClusterGlance, ClusterGlanceLevel } from '$lib/schemas/api-admin-status-payload';
import {
    buildServiceEntries,
    groupServicesByHost,
    hostGpuEncodes,
    hostLabel,
} from '$lib/components/admin/cluster/cluster-hosts.js';

/** Container memory share of its cgroup limit: amber, red. The OOM killer fires at 100 %. */
export const CONTAINER_MEMORY_WARN_RATIO = 0.85;
export const CONTAINER_MEMORY_CRITICAL_RATIO = 0.95;
/**
 * The 24 h peak working set at or above this share of the limit is amber even when
 * the service is calm now: it came within a burst of the OOM killer, and the next
 * burst may not stop there. Never red on its own — it is history, not the present.
 */
export const CONTAINER_PEAK_WARN_RATIO = 0.95;
/**
 * Host memory still available (MemAvailable / MemTotal): amber below, red below —
 * and only while the absolute amount is also under the matching floor. A 256 GB box
 * whose ZFS ARC keeps MemAvailable at 5 % still has 12 GB to give; a 32 GB node at
 * the same share has 1.6 GB and is where the kernel starts killing processes.
 */
export const HOST_MEMORY_AVAILABLE_WARN_RATIO = 0.1;
export const HOST_MEMORY_AVAILABLE_CRITICAL_RATIO = 0.05;
export const HOST_MEMORY_AVAILABLE_WARN_BYTES = 4 * 1024 ** 3;
export const HOST_MEMORY_AVAILABLE_CRITICAL_BYTES = 2 * 1024 ** 3;
/** Free share of a volume the services write to: amber below, red below. */
export const DISK_FREE_WARN_RATIO = 0.1;
export const DISK_FREE_CRITICAL_RATIO = 0.05;
/** A volume with at least this much free space is fine whatever its share. */
export const DISK_FREE_ENOUGH_BYTES = 100 * 1024 ** 3;
/**
 * Load average per CPU at which the tile turns amber. 1.0 means every core is
 * busy, which a transcode legitimately does; 1.5 means work is queueing. Never
 * red: a busy CPU slows things down but does not kill anything.
 */
export const CPU_LOAD_WARN_RATIO = 1.5;

const LEVEL_ORDER: Record<ClusterGlanceLevel, number> = { ok: 0, warn: 1, critical: 2 };

export function worseLevel(a: ClusterGlanceLevel, b: ClusterGlanceLevel): ClusterGlanceLevel {
    return LEVEL_ORDER[b] > LEVEL_ORDER[a] ? b : a;
}

export function containerPeakLevel(peakRatio: number): ClusterGlanceLevel {
    return peakRatio >= CONTAINER_PEAK_WARN_RATIO ? 'warn' : 'ok';
}

export function containerMemoryLevel(ratio: number): ClusterGlanceLevel {
    if (ratio >= CONTAINER_MEMORY_CRITICAL_RATIO) return 'critical';
    if (ratio >= CONTAINER_MEMORY_WARN_RATIO) return 'warn';
    return 'ok';
}

export function hostMemoryLevel(availableBytes: number, totalBytes: number): ClusterGlanceLevel {
    if (totalBytes <= 0) return 'ok';
    const ratio = availableBytes / totalBytes;
    if (
        ratio < HOST_MEMORY_AVAILABLE_CRITICAL_RATIO &&
        availableBytes < HOST_MEMORY_AVAILABLE_CRITICAL_BYTES
    ) {
        return 'critical';
    }
    if (
        ratio < HOST_MEMORY_AVAILABLE_WARN_RATIO &&
        availableBytes < HOST_MEMORY_AVAILABLE_WARN_BYTES
    ) {
        return 'warn';
    }
    return 'ok';
}

export function diskLevel(freeBytes: number, totalBytes: number): ClusterGlanceLevel {
    if (totalBytes <= 0 || freeBytes >= DISK_FREE_ENOUGH_BYTES) return 'ok';
    const ratio = freeBytes / totalBytes;
    if (ratio < DISK_FREE_CRITICAL_RATIO) return 'critical';
    if (ratio < DISK_FREE_WARN_RATIO) return 'warn';
    return 'ok';
}

export function cpuLoadLevel(loadPerCpu: number): ClusterGlanceLevel {
    return loadPerCpu >= CPU_LOAD_WARN_RATIO ? 'warn' : 'ok';
}

/** Share of the cgroup memory limit in use, or null for a node without a limit. */
export function containerMemoryRatio(node: Pick<ClusterNode, 'resources'>): number | null {
    const res = node.resources;
    if (!res?.memoryLimitBytes || res.memoryLimitBytes <= 0) return null;
    return res.memoryUsedBytes / res.memoryLimitBytes;
}

export function summarizeCluster(
    status: Pick<
        ClusterStatusResponse,
        'nodes' | 'sidecars' | 'expected' | 'generatedAt' | 'selfInstanceId' | 'events'
    >,
    /**
     * Unclean exits of live services in 24 h with deploy waves already excluded
     * (loadUncleanExits) — NOT the nodes' raw `uncleanExits24h`, which counts a
     * deploy whose old process outlived its stop grace and would turn the tile
     * amber after an ordinary rollout.
     */
    uncleanExits24h: number = 0,
    now: number = Date.now(),
): ClusterGlance {
    const entries = buildServiceEntries(status, now);
    const active = entries.filter((e) => e.state !== 'notConfigured');
    // Late heartbeat = still listed, just slow; everything else stale is gone.
    const late = active.filter((e) => e.state === 'stale' && e.reasons.includes('heartbeatLate'));
    const down = active.filter((e) => e.state === 'stale' && !e.reasons.includes('heartbeatLate'));
    const { hosts } = groupServicesByHost(entries);
    const multiHost = hosts.length > 1;

    let level: ClusterGlanceLevel = down.length > 0 ? 'critical' : late.length > 0 ? 'warn' : 'ok';
    const glance: ClusterGlance = {
        level,
        services: {
            up: active.length - down.length - late.length,
            expected: active.length,
            late: late.length,
        },
        hostCount: hosts.length,
        uncleanExits24h,
    };

    let gpuPressure = -1;
    let gpuActivity = -1;
    for (const group of hosts) {
        const host = group.host;
        const name = multiHost ? hostLabel(group) : undefined;
        if (
            host?.memTotalBytes &&
            host.memAvailableBytes !== undefined &&
            Number.isFinite(host.memAvailableBytes)
        ) {
            const availableRatio = host.memAvailableBytes / host.memTotalBytes;
            const memoryLevel = hostMemoryLevel(host.memAvailableBytes, host.memTotalBytes);
            if (
                !glance.hostMemory ||
                LEVEL_ORDER[memoryLevel] > LEVEL_ORDER[glance.hostMemory.level] ||
                (memoryLevel === glance.hostMemory.level &&
                    1 - availableRatio > glance.hostMemory.usedRatio)
            ) {
                glance.hostMemory = {
                    usedRatio: 1 - availableRatio,
                    availableBytes: host.memAvailableBytes,
                    totalBytes: host.memTotalBytes,
                    host: name,
                    level: hostMemoryLevel(host.memAvailableBytes, host.memTotalBytes),
                };
            }
        }
        const load = [host?.load5, host?.load1].find((v) => v !== undefined && Number.isFinite(v));
        if (load !== undefined && Number.isFinite(load) && host?.cpuCount) {
            const ratio = load / host.cpuCount;
            if (!glance.cpu || ratio > glance.cpu.ratio) {
                glance.cpu = {
                    load,
                    cores: host.cpuCount,
                    ratio,
                    host: name,
                    level: cpuLoadLevel(ratio),
                };
            }
        }
        const encodes = hostGpuEncodes(group);
        if (encodes) {
            // A full device cannot be concealed by spare capacity on another GPU,
            // or by a host running more sessions against a much larger cap.
            const capacityPressure = Math.max(
                0,
                ...(group.gpus ?? []).map((g) =>
                    g.encodeSessions !== undefined && g.maxEncodeSessions
                        ? g.encodeSessions / g.maxEncodeSessions
                        : 0,
                ),
            );
            const measuredVideo = group.gpuEngines?.video;
            const encoder = Math.max(-1, ...(group.gpus ?? []).map((g) => g.encoderPercent ?? -1));
            const utilization = Math.max(-1, ...(group.gpus ?? []).map((g) => g.busyPercent ?? -1));
            // The representative video measurement may come from either scope.
            // An idle Lumastra engine must not hide host-wide encoder activity.
            const videoScope =
                measuredVideo !== undefined && measuredVideo >= encoder ? 'lumastra' : 'host';
            const videoPercent =
                videoScope === 'lumastra' ? measuredVideo : encoder >= 0 ? encoder : undefined;
            const activity = Math.max(videoPercent ?? -1, utilization);
            const pressure = Math.max(capacityPressure, activity / 100);
            const gpuLevel: ClusterGlanceLevel = capacityPressure >= 1 ? 'warn' : 'ok';
            const prev = glance.gpu;
            if (
                !prev ||
                LEVEL_ORDER[gpuLevel] > LEVEL_ORDER[prev.level] ||
                (gpuLevel === prev.level &&
                    (pressure > gpuPressure ||
                        (pressure === gpuPressure &&
                            (activity > gpuActivity ||
                                (activity === gpuActivity && encodes.inUse > prev.inUse)))))
            ) {
                gpuPressure = pressure;
                gpuActivity = activity;
                glance.gpu = {
                    inUse: encodes.inUse,
                    max: encodes.max,
                    videoPercent,
                    ...(videoPercent !== undefined ? { videoScope } : {}),
                    ...(utilization >= 0 ? { utilizationPercent: utilization } : {}),
                    host: name,
                    level: gpuLevel,
                };
            }
        }
        for (const disk of host?.disks ?? []) {
            if (
                !(disk.totalBytes > 0) ||
                !Number.isFinite(disk.totalBytes) ||
                !Number.isFinite(disk.freeBytes)
            )
                continue;
            const freeRatio = disk.freeBytes / disk.totalBytes;
            const diskLvl = diskLevel(disk.freeBytes, disk.totalBytes);
            // Rank by level first: a nearly full 50 GB cache volume matters more
            // than a 12 % free 20 TB data volume the absolute floor excuses.
            const prev = glance.disk;
            if (
                !prev ||
                LEVEL_ORDER[diskLvl] > LEVEL_ORDER[prev.level] ||
                (diskLvl === prev.level && freeRatio < prev.freeRatio)
            ) {
                glance.disk = {
                    role: disk.role,
                    freeBytes: disk.freeBytes,
                    totalBytes: disk.totalBytes,
                    freeRatio,
                    host: name,
                    level: diskLvl,
                };
            }
        }
    }

    // The busiest container is the one with the highest of (now, 24 h peak) against
    // its limit: a service that peaked at 97 % an hour ago is the one to look at.
    let busiest = -1;
    for (const node of status.nodes) {
        const ratio = containerMemoryRatio(node);
        const res = node.resources;
        if (ratio === null || !Number.isFinite(ratio) || !res?.memoryLimitBytes) continue;
        const peakBytes =
            res.memoryPeakBytes !== undefined && Number.isFinite(res.memoryPeakBytes)
                ? Math.max(res.memoryPeakBytes, res.memoryUsedBytes)
                : undefined;
        const peakRatio = peakBytes !== undefined ? peakBytes / res.memoryLimitBytes : undefined;
        const score = Math.max(ratio, peakRatio ?? 0);
        const containerLevel = worseLevel(
            containerMemoryLevel(ratio),
            containerPeakLevel(peakRatio ?? 0),
        );
        if (
            !glance.container ||
            LEVEL_ORDER[containerLevel] > LEVEL_ORDER[glance.container.level] ||
            (containerLevel === glance.container.level && score > busiest)
        ) {
            busiest = score;
            glance.container = {
                role: node.role,
                ...(multiHost && node.host ? { host: node.host.name ?? node.hostname } : {}),
                usedBytes: res.memoryUsedBytes,
                limitBytes: res.memoryLimitBytes,
                ratio,
                peakBytes,
                peakRatio,
                level: worseLevel(
                    containerMemoryLevel(ratio),
                    peakRatio !== undefined ? containerPeakLevel(peakRatio) : 'ok',
                ),
            };
        }
    }

    for (const part of [glance.hostMemory, glance.container, glance.cpu, glance.disk, glance.gpu]) {
        if (part) level = worseLevel(level, part.level);
    }
    if (glance.uncleanExits24h > 0) level = worseLevel(level, 'warn');
    glance.level = level;
    return glance;
}
