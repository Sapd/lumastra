// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/cluster maps each live node's heartbeat (placement, cgroup
 * resources) and its restart counts from cluster_node_events into the response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ClusterStatusResponse } from '$lib/schemas/api-admin-responses.js';

const { mockGetAdminDb, mockQueries, mockReadClusterNodes } = vi.hoisted(() => ({
    mockGetAdminDb: vi.fn(),
    mockQueries: {
        getRecentEvents: vi.fn(),
        getInstancesExpectedOnline: vi.fn(),
        countRestartsSince: vi.fn(),
    },
    mockReadClusterNodes: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getAdminDb: mockGetAdminDb }));
vi.mock('$lib/server/database/queries/cluster-nodes.queries.js', () => mockQueries);
vi.mock('$lib/server/services/cluster-heartbeat.service.js', () => ({
    readClusterNodes: mockReadClusterNodes,
}));
vi.mock('$lib/server/services/admin-cluster-cache.js', () => ({
    getOrComputeClusterCore: (compute: () => Promise<string>) => compute(),
}));
const mockConfig = vi.hoisted(() => ({
    INSTANCE_ID: 'web-0',
    STREAM_PROXY_URL: '',
    APP_VERSION: 'v2.0.0',
}));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));
const mockProbe = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/cluster-sidecar-probe.js', () => ({
    probeClusterSidecars: mockProbe,
}));

vi.mock('$lib/server/services/livetv/proxy-compat.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/livetv/proxy-compat.js')>()),
    appProxyExpectation: () => ({ protocol: 1, minProtocol: 0, build: 'aaaaaaaaaaaaaaaa' }),
}));

import { def } from './cluster.js';

const base = {
    role: 'web',
    version: '1.0.0',
    startedAt: '2026-10-02T00:00:00.000Z',
    uptimeSeconds: 60,
    keyFingerprint: '',
};

async function get(): Promise<ClusterStatusResponse> {
    const res = await def.handlers.GET!({} as RequestEvent, {} as never);
    expect(res.status).toBe(200);
    return (await res.json()) as ClusterStatusResponse;
}

describe('GET /api/admin/cluster', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.STREAM_PROXY_URL = '';
        mockProbe.mockResolvedValue([
            { kind: 'sonic', state: 'notConfigured', checkedAt: '2026-10-20T12:00:00.000Z' },
        ]);
        mockGetAdminDb.mockReturnValue({});
        mockQueries.getRecentEvents.mockResolvedValue([]);
        mockQueries.getInstancesExpectedOnline.mockResolvedValue(['web-0', 'web-1']);
        mockQueries.countRestartsSince.mockResolvedValue(
            new Map([['web-0', { restarts: 3, unclean: 1 }]]),
        );
        mockReadClusterNodes.mockResolvedValue([
            {
                ...base,
                instanceId: 'web-0',
                hostname: 'web-0',
                placement: { nodeName: 'worker-2', podIp: '10.42.1.23', namespace: 'lumastra' },
                resources: { memoryUsedBytes: 1024, memoryLimitBytes: 4096 },
            },
            { ...base, instanceId: 'web-1', hostname: 'web-1' },
        ]);
    });

    it('passes placement and resources through and attaches restart counts', async () => {
        const body = await get();
        const byId = new Map(body.nodes.map((n) => [n.instanceId, n]));

        expect(mockQueries.countRestartsSince).toHaveBeenCalledWith(
            {},
            { instanceIds: ['web-0', 'web-1'], hours: 24 },
        );
        expect(byId.get('web-0')).toMatchObject({
            placement: { nodeName: 'worker-2', podIp: '10.42.1.23', namespace: 'lumastra' },
            resources: { memoryUsedBytes: 1024, memoryLimitBytes: 4096 },
            restarts24h: 3,
            uncleanExits24h: 1,
        });
        // No restart rows = 0 restarts, not unknown.
        expect(byId.get('web-1')).toMatchObject({ restarts24h: 0, uncleanExits24h: 0 });
        expect(byId.get('web-1')?.placement).toBeUndefined();
        expect(body.selfInstanceId).toBe('web-0');
    });

    it('leaves restart counts absent when the database is unavailable', async () => {
        mockGetAdminDb.mockReturnValue(null);
        const body = await get();

        expect(mockQueries.countRestartsSince).not.toHaveBeenCalled();
        for (const node of body.nodes) {
            expect(node.restarts24h).toBeUndefined();
            expect(node.uncleanExits24h).toBeUndefined();
        }
    });

    it('maps host, process, heartbeat age and worker runtime; adds sidecars, expected and generatedAt', async () => {
        mockReadClusterNodes.mockResolvedValue([
            {
                ...base,
                role: 'worker',
                instanceId: 'web-0',
                hostname: 'w',
                sentAt: '2026-10-20T11:59:58.000Z',
                heartbeatAgeMs: 2000,
                implementation: 'node',
                host: { id: 'boot:abc', memTotalBytes: 10 },
                process: { rssBytes: 5, childRssBytes: 1, childCount: 1 },
                runtime: { consumers: { running: 0, paused: 1 } },
            },
        ]);
        let body = await get();
        expect(mockReadClusterNodes).toHaveBeenCalledWith({ withHeartbeatAge: true });
        expect(body.nodes[0]).toMatchObject({
            lastSeenAt: '2026-10-20T11:59:58.000Z',
            heartbeatAgeMs: 2000,
            implementation: 'node',
            host: { id: 'boot:abc', memTotalBytes: 10 },
            process: { rssBytes: 5, childRssBytes: 1, childCount: 1 },
            runtime: { consumers: { running: 0, paused: 1 } },
            unavailableReasons: ['consumers_paused'],
        });
        expect(body.sidecars).toEqual([
            { kind: 'sonic', state: 'notConfigured', checkedAt: '2026-10-20T12:00:00.000Z' },
        ]);
        expect(body.expected).toEqual({ proxy: false });
        expect(Date.parse(body.generatedAt ?? '')).not.toBeNaN();

        mockConfig.STREAM_PROXY_URL = 'http://proxy:8080';
        body = await get();
        expect(body.expected).toEqual({ proxy: true });
    });

    it('adds proxyCompat to Live TV proxy nodes only, naming this server as the target', async () => {
        mockReadClusterNodes.mockResolvedValue([
            { ...base, instanceId: 'web-0', hostname: 'w' },
            {
                ...base,
                role: 'proxy',
                version: 'v1.0.0',
                instanceId: 'proxy-0',
                hostname: 'p',
                proxyProtocol: 1,
                proxyBuild: 'bbbbbbbbbbbbbbbb',
            },
            {
                ...base,
                role: 'proxy',
                version: 'v2.0.0',
                instanceId: 'proxy-1',
                hostname: 'p1',
                proxyProtocol: 1,
                proxyBuild: 'aaaaaaaaaaaaaaaa',
            },
        ]);
        const byId = new Map((await get()).nodes.map((n) => [n.instanceId, n]));
        expect(byId.get('web-0')?.proxyCompat).toBeUndefined();
        expect(byId.get('proxy-0')?.proxyCompat).toEqual({
            state: 'update',
            reason: 'build_differs',
            proxyProtocol: 1,
            serverProtocol: 1,
            serverVersion: 'v2.0.0',
        });
        expect(byId.get('proxy-1')?.proxyCompat).toMatchObject({ state: 'current' });
    });
});
