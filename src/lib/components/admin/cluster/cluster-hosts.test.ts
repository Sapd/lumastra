// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ClusterNode, ClusterStatusResponse } from '$lib/schemas/api-admin-responses';
import {
    buildServiceEntries,
    groupServicesByHost,
    hostGpuEncodes,
    hostLabel,
    worstState,
} from './cluster-hosts.js';

const GENERATED_AT = '2026-10-20T12:00:00.000Z';
const GiB = 1024 ** 3;

function node(
    instanceId: string,
    role: ClusterNode['role'],
    hostId: string | null,
    extra: Partial<ClusterNode> = {},
): ClusterNode {
    return {
        instanceId,
        role,
        version: '0.1.0',
        hostname: `${instanceId}-ctr`,
        startedAt: '2026-10-20T11:00:00.000Z',
        uptimeSeconds: 3600,
        lastSeenAt: '2026-10-20T11:59:55.000Z',
        implementation: 'node',
        ...(hostId
            ? {
                  host: {
                      id: hostId,
                      memTotalBytes: 32 * GiB,
                      memAvailableBytes: 20 * GiB,
                      cpuCount: 8,
                      load1: 1,
                  },
              }
            : {}),
        process: { rssBytes: 1 * GiB },
        ...extra,
    };
}

function status(over: Partial<ClusterStatusResponse>): ClusterStatusResponse {
    return {
        nodes: [],
        events: [],
        totalOnline: 0,
        totalRegistered: 0,
        selfInstanceId: 'web-1',
        generatedAt: GENERATED_AT,
        expected: { proxy: true },
        sidecars: [],
        ...over,
    };
}

describe('buildServiceEntries', () => {
    it('flags a heartbeat older than 25 s at generatedAt as stale, regardless of the client clock', () => {
        const entries = buildServiceEntries(
            status({
                nodes: [
                    node('web-1', 'web', 'boot:a'),
                    node('worker-1', 'worker', 'boot:a', {
                        lastSeenAt: '2026-10-20T11:59:20.000Z',
                    }),
                ],
            }),
            Date.parse('2030-01-01T00:00:00Z'),
        );
        const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
        expect(byKey['node:web-1'].state).toBe('healthy');
        expect(byKey['node:web-1'].isSelf).toBe(true);
        expect(byKey['node:worker-1'].state).toBe('stale');
        expect(byKey['node:worker-1'].reasons).toEqual(['heartbeatLate']);
        expect(byKey['node:worker-1'].lastSeenAgoMs).toBe(40_000);
    });

    it('a container at 90 % of its memory limit is degraded', () => {
        const [entry] = buildServiceEntries(
            status({
                expected: undefined,
                nodes: [
                    node('web-1', 'web', 'k8s:n1', {
                        resources: { memoryUsedBytes: 0.95 * GiB, memoryLimitBytes: 1 * GiB },
                    }),
                ],
            }),
        );
        expect(entry.state).toBe('degraded');
        expect(entry.reasons).toEqual(['memoryNearLimit']);
    });

    it('a worker that cannot take work, or whose watcher failed, is degraded', () => {
        const [entry] = buildServiceEntries(
            status({
                expected: undefined,
                nodes: [
                    node('worker-1', 'worker', 'boot:a', {
                        runtime: {
                            consumers: { running: 0, paused: 2 },
                            watcher: { state: 'failed', restarts: 3 },
                        },
                        unavailableReasons: ['consumers_paused'],
                    }),
                ],
            }),
        );
        expect(entry.state).toBe('degraded');
        expect(entry.reasons).toEqual(['workerUnavailable', 'watcherDegraded']);
    });

    it('lists a configured proxy without heartbeat as stale and an unconfigured one as not configured', () => {
        const configured = buildServiceEntries(status({ nodes: [node('web-1', 'web', 'boot:a')] }));
        expect(configured.find((e) => e.kind === 'proxy')).toMatchObject({
            state: 'stale',
            reasons: ['noHeartbeat'],
        });
        const unconfigured = buildServiceEntries(
            status({ nodes: [node('web-1', 'web', 'boot:a')], expected: { proxy: false } }),
        );
        expect(unconfigured.find((e) => e.kind === 'proxy')?.state).toBe('notConfigured');
        const running = buildServiceEntries(
            status({
                nodes: [
                    node('web-1', 'web', 'boot:a'),
                    node('proxy-1', 'proxy', 'boot:a', {
                        implementation: 'rust',
                        version: '0.4.2',
                    }),
                ],
            }),
        );
        expect(running.filter((e) => e.kind === 'proxy')).toHaveLength(1);
        expect(running.find((e) => e.kind === 'proxy')?.implementation).toBe('rust');
    });

    it('a service that went offline recently stays as a stale card; older ones drop off', () => {
        const entries = buildServiceEntries(
            status({
                expected: undefined,
                nodes: [node('web-1', 'web', 'boot:a')],
                events: [
                    {
                        id: 'e3',
                        instanceId: 'worker-1',
                        eventType: 'offline',
                        role: 'worker',
                        hostname: 'w',
                        createdAt: '2026-10-20T11:58:00.000Z',
                    },
                    {
                        id: 'e2',
                        instanceId: 'worker-1',
                        eventType: 'online',
                        createdAt: '2026-10-20T10:00:00.000Z',
                    },
                    {
                        id: 'e1',
                        instanceId: 'old',
                        eventType: 'offline',
                        role: 'web',
                        createdAt: '2026-10-20T10:00:00.000Z',
                    },
                    {
                        id: 'e0',
                        instanceId: 'web-1',
                        eventType: 'offline',
                        createdAt: '2026-10-20T11:59:00.000Z',
                    },
                ],
            }),
        );
        expect(entries.map((e) => [e.key, e.state])).toEqual([
            ['node:web-1', 'healthy'],
            ['offline:worker-1', 'stale'],
        ]);
        expect(entries[1]).toMatchObject({
            kind: 'worker',
            reasons: ['wentOffline'],
            lastSeenAgoMs: 120_000,
        });
    });

    it('an instance replaced by a newer one of the same role (deploy) is not stale', () => {
        const entries = buildServiceEntries(
            status({
                expected: undefined,
                // startedAt 11:00 (node() default) is after the old instance came online.
                nodes: [node('web-new', 'web', 'boot:a')],
                events: [
                    {
                        id: 'e2',
                        instanceId: 'web-old',
                        eventType: 'offline',
                        role: 'web',
                        createdAt: '2026-10-20T11:58:00.000Z',
                    },
                    {
                        id: 'e1',
                        instanceId: 'web-old',
                        eventType: 'online',
                        role: 'web',
                        createdAt: '2026-10-19T08:00:00.000Z',
                    },
                ],
            }),
        );
        expect(entries.map((e) => e.key)).toEqual(['node:web-new']);
    });

    it('prefers the Valkey-clock heartbeat age over the producer clock', () => {
        const [entry] = buildServiceEntries(
            status({
                expected: undefined,
                nodes: [
                    node('web-1', 'web', 'boot:a', {
                        // Producer clock 5 min behind: sentAt alone would read as stale.
                        lastSeenAt: '2026-10-20T11:55:00.000Z',
                        heartbeatAgeMs: 4000,
                    }),
                ],
            }),
        );
        expect(entry.state).toBe('healthy');
        expect(entry.lastSeenAgoMs).toBe(4000);
    });

    it('maps sidecar probe states onto the four service states', () => {
        const entries = buildServiceEntries(
            status({
                expected: undefined,
                sidecars: [
                    { kind: 'sonic', state: 'healthy', checkedAt: GENERATED_AT },
                    {
                        kind: 'sonic',
                        state: 'degraded',
                        status: 'loading',
                        checkedAt: GENERATED_AT,
                    },
                    { kind: 'sonic', state: 'down', checkedAt: GENERATED_AT },
                    { kind: 'sonic', state: 'notConfigured', checkedAt: GENERATED_AT },
                ],
            }),
        );
        expect(entries.map((e) => [e.state, e.reasons])).toEqual([
            ['healthy', []],
            ['degraded', ['sidecarLoading']],
            ['stale', ['sidecarDown']],
            ['notConfigured', []],
        ]);
    });
});

describe('groupServicesByHost', () => {
    it('same host: one card, host memory once, service memory summed incl. children', () => {
        const { hosts, unplaced } = groupServicesByHost(
            buildServiceEntries(
                status({
                    nodes: [
                        node('worker-1', 'worker', 'boot:a', {
                            process: { rssBytes: 2 * GiB, childRssBytes: 1 * GiB, childCount: 1 },
                        }),
                        node('web-1', 'web', 'boot:a'),
                        node('proxy-1', 'proxy', 'boot:a', { implementation: 'rust' }),
                    ],
                    sidecars: [
                        {
                            kind: 'sonic',
                            state: 'healthy',
                            checkedAt: GENERATED_AT,
                            host: { id: 'boot:a', memTotalBytes: 32 * GiB },
                            process: { rssBytes: 3 * GiB },
                        },
                    ],
                }),
            ),
        );
        expect(unplaced).toEqual([]);
        expect(hosts).toHaveLength(1);
        const [h] = hosts;
        expect(h.services.map((s) => s.kind)).toEqual(['web', 'worker', 'proxy', 'sonic']);
        // web 1 + worker 2 + watcher 1 + proxy 1 + sonic 3
        expect(h.serviceRssBytes).toBe(8 * GiB);
        expect(h.host?.memTotalBytes).toBe(32 * GiB);
        expect(h.hostMemoryWarn).toBe(false);
    });

    it('different hosts: separate cards, self first; services without host info are unplaced', () => {
        const { hosts, unplaced } = groupServicesByHost(
            buildServiceEntries(
                status({
                    nodes: [
                        node('worker-1', 'worker', 'k8s:b-node', {
                            placement: { nodeName: 'b-node' },
                        }),
                        node('web-1', 'web', 'k8s:a-node', {
                            placement: { nodeName: 'a-node' },
                            host: {
                                id: 'k8s:a-node',
                                name: 'a-node',
                                memTotalBytes: 16 * GiB,
                                memAvailableBytes: 1 * GiB,
                            },
                        }),
                        node('legacy', 'web', null),
                    ],
                }),
            ),
        );
        expect(hosts.map((h) => h.id)).toEqual(['k8s:a-node', 'k8s:b-node']);
        expect(hosts.map((h) => hostLabel(h))).toEqual(['a-node', 'b-node']);
        expect(hosts[0].hostMemoryWarn).toBe(true);
        expect(unplaced.map((e) => e.key)).toEqual(['node:legacy', 'missing:proxy']);
    });

    it('takes host figures from the freshest member', () => {
        const { hosts } = groupServicesByHost(
            buildServiceEntries(
                status({
                    expected: undefined,
                    nodes: [
                        node('web-1', 'web', null, {
                            lastSeenAt: '2026-10-20T11:59:50.000Z',
                            host: { id: 'boot:a', memAvailableBytes: 1, memTotalBytes: 10 },
                        }),
                        node('worker-1', 'worker', null, {
                            lastSeenAt: '2026-10-20T11:59:59.000Z',
                            host: { id: 'boot:a', memAvailableBytes: 7, memTotalBytes: 10 },
                        }),
                    ],
                }),
            ),
        );
        expect(hosts[0].host?.memAvailableBytes).toBe(7);
    });
});

describe('worstState / hostLabel', () => {
    it('ignores not-configured services', () => {
        const entries = buildServiceEntries(
            status({ nodes: [node('web-1', 'web', 'boot:a')], expected: { proxy: false } }),
        );
        expect(worstState(entries)).toBe('healthy');
        expect(worstState(entries.filter((e) => e.state === 'notConfigured'))).toBe(
            'notConfigured',
        );
    });

    it('falls back to a short id', () => {
        const { hosts } = groupServicesByHost(
            buildServiceEntries(status({ nodes: [node('web-1', 'web', 'boot:0123456789abcdef')] })),
        );
        expect(hostLabel(hosts[0])).toBe('boot 01234567');
    });
});

describe('GPU and CPU per host', () => {
    const arc = { kind: 'dri' as const, device: 'renderD128', driver: 'i915' };

    function withHost(
        n: ClusterNode,
        host: Partial<NonNullable<ClusterNode['host']>>,
        proc?: ClusterNode['process'],
    ): ClusterNode {
        return { ...n, host: { ...n.host!, ...host }, ...(proc ? { process: proc } : {}) };
    }

    it("adds the services' engine use on one host (web pods + worker + proxy share one GPU), clamped to 100", () => {
        const nodes = [
            withHost(
                node('web-1', 'web', 'boot:media'),
                { gpus: [arc] },
                {
                    rssBytes: GiB,
                    gpu: { clients: 1, engines: { video: 20, render: 5 } },
                },
            ),
            withHost(
                node('worker-1', 'worker', 'boot:media'),
                { gpus: [arc] },
                {
                    rssBytes: GiB,
                    gpu: { clients: 2, engines: { video: 70, render: 10, compute: 3 } },
                },
            ),
            withHost(
                node('proxy-1', 'proxy', 'boot:media', { implementation: 'rust' }),
                {},
                {
                    rssBytes: GiB,
                    gpu: { clients: 1, engines: { video: 30 } },
                },
            ),
            node('web-2', 'web', 'boot:other'),
        ];
        const { hosts } = groupServicesByHost(buildServiceEntries(status({ nodes })));
        const media = hosts.find((h) => h.id === 'boot:media')!;
        expect(media.gpuEngines).toEqual({ video: 100, render: 15, compute: 3 });
        expect(media.gpuClients).toBe(4);
        expect(hostGpuEncodes(media)).toEqual({ inUse: 4 });
        const other = hosts.find((h) => h.id === 'boot:other')!;
        expect(other.gpuEngines).toBeUndefined();
        expect(hostGpuEncodes(other)).toBeUndefined();
    });

    it('takes CPU % and GPU device figures from the freshest member that reports them', () => {
        const nodes = [
            // Freshest, but an older build: no cpuPercent, GPU without live figures.
            withHost(node('web-1', 'web', 'boot:media', { heartbeatAgeMs: 1_000 }), {
                gpus: [arc],
            }),
            withHost(node('worker-1', 'worker', 'boot:media', { heartbeatAgeMs: 5_000 }), {
                cpuPercent: 42,
                gpus: [{ ...arc, name: 'Intel Arc A380', awakePercent: 100 }],
            }),
        ];
        const [media] = groupServicesByHost(buildServiceEntries(status({ nodes }))).hosts;
        expect(media.cpuPercent).toBe(42);
        expect(media.gpus?.[0]).toMatchObject({ name: 'Intel Arc A380', awakePercent: 100 });
    });

    it('reports NVENC sessions against the driver cap, and lists a failing encoder probe first', () => {
        const nv = {
            kind: 'nvidia' as const,
            device: 'nvidia0',
            encodeSessions: 3,
            maxEncodeSessions: 8,
        };
        const nodes = [
            withHost(
                node('web-1', 'web', 'boot:gpu', {
                    gpuAccess: { configured: 'nvenc', accessible: true, capabilities: ['NVENC'] },
                }),
                { gpus: [nv] },
            ),
            node('worker-1', 'worker', 'boot:gpu', {
                gpuAccess: { configured: 'nvenc', accessible: false, error: 'no device' },
            }),
        ];
        const [gpuHost] = groupServicesByHost(buildServiceEntries(status({ nodes }))).hosts;
        expect(hostGpuEncodes(gpuHost)).toEqual({ inUse: 3, max: 8 });
        expect(gpuHost.gpuAccess.map((a) => a.accessible)).toEqual([false, true]);
    });

    it('has no max when a card has no NVENC cap (data-centre cards report 0)', () => {
        expect(
            hostGpuEncodes({
                gpus: [
                    { kind: 'nvidia', device: 'nvidia0', encodeSessions: 5, maxEncodeSessions: 0 },
                ],
                gpuClients: 0,
            }),
        ).toEqual({ inUse: 5, max: undefined });
    });
});
