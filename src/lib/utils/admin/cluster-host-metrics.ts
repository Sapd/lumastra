// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cluster-wide host figures for GET /api/admin/system-metrics and
 * /api/v1/system-metrics (`hosts`). Built from the same cluster core and service
 * model as the cluster view (cluster-hosts.ts), so the API and the admin UI agree.
 * The data travels through Valkey: every service writes CPU, memory and GPU into
 * its heartbeat key every 10 s, and the cluster core reads all of them.
 */

import type { ClusterStatusResponse } from '$lib/schemas/api-admin-responses';
import type { ClusterHostMetrics } from '$lib/schemas/admin-types';
import {
    buildServiceEntries,
    groupServicesByHost,
    hostGpuEncodes,
} from '$lib/components/admin/cluster/cluster-hosts.js';

export function toClusterHostMetrics(
    status: Pick<ClusterStatusResponse, 'nodes' | 'sidecars' | 'expected' | 'generatedAt'> &
        Partial<Pick<ClusterStatusResponse, 'events'>>,
): ClusterHostMetrics[] {
    // No replica is "self" here: the figures describe the whole cluster.
    const { hosts } = groupServicesByHost(buildServiceEntries({ ...status, selfInstanceId: '' }));
    return hosts.map((group) => {
        const host = group.host;
        const encodes = hostGpuEncodes(group);
        const out: ClusterHostMetrics = {
            id: group.id,
            name: host?.name ?? group.nodeName,
            cpuPercent: group.cpuPercent,
            cpuCount: host?.cpuCount,
            load1: host?.load1,
            memTotalBytes: host?.memTotalBytes,
            memAvailableBytes: host?.memAvailableBytes,
            gpus: group.gpus,
            gpuEngines: group.gpuEngines,
            gpuEncodes: encodes,
            services: group.services.map((s) => ({
                kind: s.kind,
                hostname: s.hostname,
                state: s.state,
                cpuPercent: s.process?.cpuPercent,
                rssBytes: s.process
                    ? s.process.rssBytes + (s.process.childRssBytes ?? 0)
                    : undefined,
            })),
        };
        return JSON.parse(JSON.stringify(out)) as ClusterHostMetrics;
    });
}
