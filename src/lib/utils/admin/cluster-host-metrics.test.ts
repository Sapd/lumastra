// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ClusterNode } from '$lib/schemas/api-admin-responses';
import { ClusterHostMetricsSchema } from '$lib/schemas/admin-types';
import { toClusterHostMetrics } from './cluster-host-metrics.js';

const GiB = 1024 ** 3;

function node(
    instanceId: string,
    role: ClusterNode['role'],
    over: Partial<ClusterNode>,
): ClusterNode {
    return {
        instanceId,
        role,
        version: '0.1.0',
        hostname: `${instanceId}-pod`,
        startedAt: '2026-10-22T11:00:00.000Z',
        uptimeSeconds: 3600,
        heartbeatAgeMs: 2_000,
        implementation: 'node',
        ...over,
    };
}

describe('toClusterHostMetrics', () => {
    it('reports every machine once with CPU, memory, GPU and its services (global metrics from the heartbeats)', () => {
        const media = {
            id: 'boot:media',
            name: 'media',
            cpuCount: 16,
            cpuPercent: 37.5,
            memTotalBytes: 64 * GiB,
            memAvailableBytes: 40 * GiB,
            gpus: [
                {
                    kind: 'dri' as const,
                    device: 'renderD128',
                    driver: 'i915',
                    name: 'Intel Arc A380',
                    awakePercent: 100,
                },
            ],
        };
        const hosts = toClusterHostMetrics({
            generatedAt: '2026-10-22T12:00:00.000Z',
            expected: { proxy: false },
            sidecars: [],
            nodes: [
                node('web-0', 'web', {
                    host: media,
                    process: {
                        rssBytes: GiB,
                        cpuPercent: 12,
                        gpu: { clients: 1, engines: { video: 10 } },
                    },
                }),
                node('worker-1', 'worker', {
                    host: media,
                    process: {
                        rssBytes: GiB,
                        childRssBytes: GiB,
                        gpu: { clients: 2, engines: { video: 35, render: 4 } },
                    },
                }),
            ],
        });
        expect(hosts).toHaveLength(1);
        const [h] = hosts;
        expect(ClusterHostMetricsSchema.parse(h)).toEqual(h);
        expect(h).toMatchObject({
            id: 'boot:media',
            name: 'media',
            cpuPercent: 37.5,
            cpuCount: 16,
            gpuEngines: { video: 45, render: 4 },
            gpuEncodes: { inUse: 3 },
        });
        expect(h.gpus?.[0].name).toBe('Intel Arc A380');
        expect(h.services).toEqual([
            { kind: 'web', hostname: 'web-0-pod', state: 'healthy', cpuPercent: 12, rssBytes: GiB },
            { kind: 'worker', hostname: 'worker-1-pod', state: 'healthy', rssBytes: 2 * GiB },
        ]);
    });

    it('is empty when no service published a heartbeat (Valkey down)', () => {
        expect(
            toClusterHostMetrics({
                generatedAt: undefined,
                nodes: [],
                sidecars: [],
                expected: undefined,
            }),
        ).toEqual([]);
    });
});
