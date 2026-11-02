// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type {
    ClusterHostInfo,
    ClusterNode,
    ClusterStatusResponse,
} from '$lib/schemas/api-admin-responses';
import { ClusterGlanceSchema } from '$lib/schemas/api-admin-status-payload';
import type { ClusterGlance } from '$lib/schemas/api-admin-status-payload';
import { summarizeCluster } from './cluster-glance.js';

const GiB = 1024 ** 3;
const GENERATED_AT = '2026-10-20T12:00:00.000Z';
const NOW = Date.parse(GENERATED_AT);

type Status = Pick<
    ClusterStatusResponse,
    'nodes' | 'sidecars' | 'expected' | 'generatedAt' | 'selfInstanceId' | 'events'
>;

function node(instanceId: string, over: Partial<ClusterNode> = {}): ClusterNode {
    return {
        instanceId,
        role: 'general',
        version: '0.1.0',
        hostname: `${instanceId}-ctr`,
        startedAt: '2026-10-20T11:00:00.000Z',
        uptimeSeconds: 3600,
        lastSeenAt: '2026-10-20T11:59:55.000Z',
        implementation: 'node',
        heartbeatAgeMs: 2_000,
        ...over,
    };
}

function host(id: string, over: Partial<ClusterHostInfo> = {}): ClusterHostInfo {
    return {
        id,
        memTotalBytes: 16 * GiB,
        memAvailableBytes: 8 * GiB,
        cpuCount: 4,
        load5: 0.5,
        disks: [{ role: 'data', path: '/data', freeBytes: 500 * GiB, totalBytes: 1000 * GiB }],
        ...over,
    };
}

function status(over: Partial<Status> = {}): Status {
    return {
        nodes: [],
        sidecars: [],
        events: [],
        expected: { proxy: false },
        generatedAt: GENERATED_AT,
        selfInstanceId: 'gen-1',
        ...over,
    };
}

/**
 * Summarises and checks the result against the wire schema, so a figure the schema
 * would reject (a NaN, a missing field) fails the test instead of the tile.
 */
function summarize(s: Status, unclean = 0): ClusterGlance {
    const glance = summarizeCluster(s, unclean, NOW);
    ClusterGlanceSchema.parse(glance);
    return glance;
}

describe('summarizeCluster', () => {
    it('a single-container install with plenty of room is ok, with no cgroup or host label', () => {
        const glance = summarize(status({ nodes: [node('gen-1', { host: host('boot:a') })] }));
        expect(glance.level).toBe('ok');
        expect(glance.services).toEqual({ up: 1, expected: 1, late: 0 });
        expect(glance.hostCount).toBe(1);
        expect(glance.container).toBeUndefined();
        expect(glance.hostMemory?.host).toBeUndefined();
        expect(glance.hostMemory?.level).toBe('ok');
        expect(glance.cpu?.ratio).toBeCloseTo(0.125);
        expect(glance.cpu?.level).toBe('ok');
        expect(glance.disk?.level).toBe('ok');
        expect(glance.uncleanExits24h).toBe(0);
    });

    it('a node with no host and no resources gives its service count and no figures', () => {
        const glance = summarize(status({ nodes: [node('gen-1')] }));
        expect(glance.services).toEqual({ up: 1, expected: 1, late: 0 });
        expect(glance.level).toBe('ok');
        expect(glance.hostMemory).toBeUndefined();
        expect(glance.cpu).toBeUndefined();
        expect(glance.disk).toBeUndefined();
        expect(glance.container).toBeUndefined();
        // Nothing reported a machine, so none is counted.
        expect(glance.hostCount).toBe(0);
    });

    describe('container memory against its cgroup limit (1000-byte limit, exact ratios)', () => {
        const withContainer = (used: number) =>
            status({
                nodes: [
                    node('web-1', {
                        role: 'web',
                        host: host('boot:a'),
                        resources: { memoryUsedBytes: used, memoryLimitBytes: 1000 },
                    }),
                ],
            });

        it('0.84 of the limit is ok', () => {
            const glance = summarize(withContainer(840));
            expect(glance.container?.level).toBe('ok');
            expect(glance.level).toBe('ok');
        });

        it('0.85 of the limit is warn', () => {
            const glance = summarize(withContainer(850));
            expect(glance.container?.level).toBe('warn');
            expect(glance.container?.role).toBe('web');
            expect(glance.level).toBe('warn');
        });

        it('0.95 of the limit is critical', () => {
            const glance = summarize(withContainer(950));
            expect(glance.container?.level).toBe('critical');
            expect(glance.level).toBe('critical');
        });
    });

    describe('host memory available (32 GiB box unless stated)', () => {
        const withAvailable = (available: number, total = 32 * GiB) =>
            status({
                nodes: [
                    node('gen-1', {
                        host: host('boot:a', {
                            memTotalBytes: total,
                            memAvailableBytes: available,
                        }),
                    }),
                ],
            });

        it('8 % available on a 16 GiB box (1.28 GiB) is warn', () => {
            const glance = summarize(
                status({
                    nodes: [
                        node('gen-1', {
                            host: host('boot:a', { memAvailableBytes: 0.08 * 16 * GiB }),
                        }),
                    ],
                }),
            );
            expect(glance.hostMemory?.level).toBe('warn');
            expect(glance.hostMemory?.usedRatio).toBeCloseTo(0.92);
            expect(glance.level).toBe('warn');
        });

        it('4 % available on a 16 GiB box (0.64 GiB) is critical', () => {
            const glance = summarize(
                status({
                    nodes: [
                        node('gen-1', {
                            host: host('boot:a', { memAvailableBytes: 0.04 * 16 * GiB }),
                        }),
                    ],
                }),
            );
            expect(glance.hostMemory?.level).toBe('critical');
            expect(glance.level).toBe('critical');
        });

        it('10 % available on 32 GiB (3.2 GiB) is ok: the ratio is not below 10 %', () => {
            const glance = summarize(withAvailable(3.2 * GiB));
            expect(glance.hostMemory?.level).toBe('ok');
            expect(glance.level).toBe('ok');
        });

        it('9.9 % available on 32 GiB (3.168 GiB) is warn', () => {
            const glance = summarize(withAvailable(0.099 * 32 * GiB));
            expect(glance.hostMemory?.level).toBe('warn');
            expect(glance.level).toBe('warn');
        });

        it('4 % available on 32 GiB (1.28 GiB) is critical', () => {
            const glance = summarize(withAvailable(0.04 * 32 * GiB));
            expect(glance.hostMemory?.level).toBe('critical');
            expect(glance.level).toBe('critical');
        });

        it('5 % available on a 256 GiB box (12.8 GiB) is ok: plenty is still free', () => {
            const glance = summarize(withAvailable(0.05 * 256 * GiB, 256 * GiB));
            expect(glance.hostMemory?.level).toBe('ok');
            expect(glance.level).toBe('ok');
        });
    });

    describe('disk free space', () => {
        const withDisk = (disk: { freeBytes: number; totalBytes: number }) =>
            status({
                nodes: [
                    node('gen-1', {
                        host: host('boot:a', {
                            disks: [{ role: 'data', path: '/data', ...disk }],
                        }),
                    }),
                ],
            });

        it('5 % free of a 200 GiB volume is warn (5 % is not below the 5 % floor)', () => {
            const glance = summarize(withDisk({ freeBytes: 10 * GiB, totalBytes: 200 * GiB }));
            expect(glance.disk?.freeRatio).toBeCloseTo(0.05);
            expect(glance.disk?.level).toBe('warn');
            expect(glance.level).toBe('warn');
        });

        it('3 % free of a 200 GiB volume is critical', () => {
            const glance = summarize(withDisk({ freeBytes: 6 * GiB, totalBytes: 200 * GiB }));
            expect(glance.disk?.level).toBe('critical');
            expect(glance.level).toBe('critical');
        });

        it('5 % free of a 20 TiB volume is ok, because 100 GiB or more is always enough', () => {
            const glance = summarize(
                withDisk({ freeBytes: 1024 * GiB, totalBytes: 20 * 1024 * GiB }),
            );
            expect(glance.disk?.freeRatio).toBeCloseTo(0.05);
            expect(glance.disk?.level).toBe('ok');
            expect(glance.level).toBe('ok');
        });

        it('a warn small volume beats an ok big volume with a lower free ratio, in either order', () => {
            const big = {
                role: 'data' as const,
                path: '/data',
                freeBytes: 400 * GiB,
                totalBytes: 20 * 1024 * GiB,
            };
            const small = {
                role: 'cache' as const,
                path: '/cache',
                freeBytes: 4 * GiB,
                totalBytes: 50 * GiB,
            };

            const bigFirst = summarize(
                status({
                    nodes: [node('gen-1', { host: host('boot:a', { disks: [big, small] }) })],
                }),
            );
            const smallFirst = summarize(
                status({
                    nodes: [node('gen-1', { host: host('boot:a', { disks: [small, big] }) })],
                }),
            );
            for (const glance of [bigFirst, smallFirst]) {
                expect(glance.disk?.role).toBe('cache');
                expect(glance.disk?.totalBytes).toBe(50 * GiB);
                expect(glance.disk?.level).toBe('warn');
            }
        });

        it('a non-finite free figure is left out, not reported', () => {
            const glance = summarize(withDisk({ freeBytes: Number.NaN, totalBytes: 200 * GiB }));
            expect(glance.disk).toBeUndefined();
            expect(glance.level).toBe('ok');
        });

        it('a volume reporting an infinite size is left out', () => {
            // Not via summarize(): the schema would reject the Infinity in the
            // input-derived output and fail for the wrong reason.
            const glance = summarizeCluster(
                withDisk({ freeBytes: 10 * GiB, totalBytes: Number.POSITIVE_INFINITY }),
                0,
                NOW,
            );
            expect(glance.disk).toBeUndefined();
        });
    });

    describe('CPU load per core', () => {
        it('a 5-minute load of twice the CPU count is warn', () => {
            const glance = summarize(
                status({ nodes: [node('gen-1', { host: host('boot:a', { load5: 8 }) })] }),
            );
            expect(glance.cpu?.ratio).toBeCloseTo(2);
            expect(glance.cpu?.level).toBe('warn');
            expect(glance.level).toBe('warn');
        });

        it('falls back to the 1-minute load when the 5-minute one is missing', () => {
            const glance = summarize(
                status({
                    nodes: [
                        node('gen-1', {
                            host: host('boot:a', { load5: undefined, load1: 6 }),
                        }),
                    ],
                }),
            );
            expect(glance.cpu?.load).toBe(6);
            expect(glance.cpu?.ratio).toBeCloseTo(1.5);
            expect(glance.cpu?.level).toBe('warn');
        });

        it('on 100 CPUs, a load of 1.49 per CPU is ok', () => {
            const glance = summarize(
                status({
                    nodes: [node('gen-1', { host: host('boot:a', { cpuCount: 100, load5: 149 }) })],
                }),
            );
            expect(glance.cpu?.ratio).toBe(1.49);
            expect(glance.cpu?.level).toBe('ok');
            expect(glance.level).toBe('ok');
        });

        it('on 100 CPUs, a load of 1.5 per CPU is warn', () => {
            const glance = summarize(
                status({
                    nodes: [node('gen-1', { host: host('boot:a', { cpuCount: 100, load5: 150 }) })],
                }),
            );
            expect(glance.cpu?.ratio).toBe(1.5);
            expect(glance.cpu?.level).toBe('warn');
        });

        it('a NaN load is left out, not reported', () => {
            const glance = summarize(
                status({
                    nodes: [node('gen-1', { host: host('boot:a', { load5: Number.NaN }) })],
                }),
            );
            expect(glance.cpu).toBeUndefined();
            expect(glance.level).toBe('ok');
        });

        it('a NaN 5-minute load falls back to a valid 1-minute load', () => {
            const glance = summarize(
                status({
                    nodes: [
                        node('gen-1', { host: host('boot:a', { load5: Number.NaN, load1: 2 }) }),
                    ],
                }),
            );
            expect(glance.cpu?.load).toBe(2);
        });
    });

    describe('unclean exits come from the caller, never from the nodes', () => {
        it('a node reporting 3 unclean exits with a parameter of 0 is ok and counts 0', () => {
            const glance = summarize(
                status({
                    nodes: [node('gen-1', { host: host('boot:a'), uncleanExits24h: 3 })],
                }),
                0,
            );
            expect(glance.uncleanExits24h).toBe(0);
            expect(glance.level).toBe('ok');
        });

        it('the caller count is used as given and any exit makes the glance at least warn', () => {
            const glance = summarize(
                status({
                    nodes: [
                        node('gen-1', { host: host('boot:a'), uncleanExits24h: 9 }),
                        node('gen-2', { host: host('boot:a') }),
                    ],
                }),
                2,
            );
            expect(glance.uncleanExits24h).toBe(2);
            expect(glance.level).toBe('warn');
        });
    });

    it('a configured proxy with no heartbeat counts as expected but not up, and is critical', () => {
        const glance = summarize(
            status({
                expected: { proxy: true },
                nodes: [node('gen-1', { host: host('boot:a') })],
            }),
        );
        expect(glance.services).toEqual({ up: 1, expected: 2, late: 0 });
        expect(glance.level).toBe('critical');
    });

    it('a heartbeat 40 s old is counted as late, and the glance is warn', () => {
        const glance = summarize(
            status({
                nodes: [node('gen-1', { host: host('boot:a'), heartbeatAgeMs: 40_000 })],
            }),
        );
        expect(glance.services.late).toBe(1);
        expect(glance.services.expected).toBe(1);
        expect(glance.level).toBe('warn');
    });

    it('two machines give hostCount 2 and label the worst host memory', () => {
        const glance = summarize(
            status({
                nodes: [
                    node('web-1', {
                        role: 'web',
                        host: host('name:box-a', { memAvailableBytes: 8 * GiB }),
                    }),
                    node('worker-1', {
                        role: 'worker',
                        host: host('name:box-b', { memAvailableBytes: 1 * GiB }),
                    }),
                ],
            }),
        );
        expect(glance.hostCount).toBe(2);
        expect(glance.hostMemory?.host).toBe('box-b');
        expect(glance.hostMemory?.usedRatio).toBeCloseTo(15 / 16);
        expect(glance.hostMemory?.level).toBe('warn');
        expect(glance.level).toBe('warn');
    });

    it('a NaN memory figure is left out, and a NaN container figure too; the schema still accepts it', () => {
        const glance = summarize(
            status({
                nodes: [
                    node('gen-1', {
                        host: host('boot:a', { memAvailableBytes: Number.NaN, load5: Number.NaN }),
                        resources: { memoryUsedBytes: Number.NaN, memoryLimitBytes: GiB },
                    }),
                ],
            }),
        );
        expect(glance.hostMemory).toBeUndefined();
        expect(glance.cpu).toBeUndefined();
        expect(glance.container).toBeUndefined();
        expect(glance.level).toBe('ok');
    });
});

describe('24 h peak working set on the container figure', () => {
    /**
     * A web service at `used` with an optional 24 h `peak`, next to a worker at 700 of
     * the same 1000-byte limit. Byte counts this small keep every ratio exact.
     */
    function withPeak(web: { used: number; peak?: number }): Status {
        return status({
            nodes: [
                node('web-1', {
                    role: 'web',
                    host: host('boot:a'),
                    resources: {
                        memoryUsedBytes: web.used,
                        memoryLimitBytes: 1000,
                        memoryPeakBytes: web.peak,
                    },
                }),
                node('worker-1', {
                    role: 'worker',
                    host: host('boot:a'),
                    resources: { memoryUsedBytes: 700, memoryLimitBytes: 1000 },
                }),
            ],
        });
    }

    it('a calm service with a 96 % peak is shown in place of a 70 % service, at warn', () => {
        const glance = summarize(withPeak({ used: 400, peak: 960 }));
        expect(glance.container?.role).toBe('web');
        expect(glance.container?.ratio).toBeCloseTo(0.4);
        expect(glance.container?.peakRatio).toBe(0.96);
        expect(glance.container?.peakBytes).toBe(960);
        expect(glance.container?.level).toBe('warn');
        expect(glance.level).toBe('warn');
    });

    it('a peak below the current figure is clamped up to it', () => {
        const glance = summarize(withPeak({ used: 700, peak: 500 }));
        expect(glance.container?.role).toBe('web');
        expect(glance.container?.peakBytes).toBe(700);
        expect(glance.container?.peakRatio).toBe(0.7);
        expect(glance.container?.level).toBe('ok');
        expect(glance.level).toBe('ok');
    });

    it('a peak of 95 % is warn and a peak of 94.9 % is not', () => {
        expect(summarize(withPeak({ used: 100, peak: 950 })).container?.level).toBe('warn');
        expect(summarize(withPeak({ used: 100, peak: 949 })).container?.level).toBe('ok');
    });

    it('a peak alone never makes the glance critical', () => {
        const glance = summarize(withPeak({ used: 400, peak: 1000 }));
        expect(glance.container?.peakRatio).toBe(1);
        expect(glance.container?.level).toBe('warn');
        expect(glance.level).toBe('warn');
    });

    it('a current figure at critical is still critical with a peak', () => {
        const glance = summarize(withPeak({ used: 960, peak: 960 }));
        expect(glance.container?.level).toBe('critical');
        expect(glance.level).toBe('critical');
    });

    it('no peak figure, or a NaN one, leaves the peak fields out', () => {
        const none = summarize(withPeak({ used: 400 }));
        expect(none.container?.peakBytes).toBeUndefined();
        expect(none.container?.peakRatio).toBeUndefined();
        expect(none.container?.level).toBe('ok');

        const nan = summarize(withPeak({ used: 400, peak: Number.NaN }));
        expect(nan.container?.peakBytes).toBeUndefined();
        expect(nan.container?.level).toBe('ok');
    });
});

describe('GPU encodes figure', () => {
    it('shows FFmpeg processes on the GPU and the video engine for Intel (no session cap)', () => {
        const g = summarize(
            status({
                nodes: [
                    node('web-1', {
                        role: 'web',
                        host: host('boot:media', {
                            gpus: [{ kind: 'dri', device: 'renderD128', driver: 'i915' }],
                        }),
                        process: {
                            rssBytes: GiB,
                            gpu: { clients: 2, engines: { video: 45, render: 3 } },
                        },
                    }),
                ],
            }),
        );
        expect(g.gpu).toEqual({ inUse: 2, videoPercent: 45, videoScope: 'lumastra', level: 'ok' });
        expect(g.level).toBe('ok');
    });

    it('turns amber when every NVENC session is taken', () => {
        const g = summarize(
            status({
                nodes: [
                    node('worker-1', {
                        role: 'worker',
                        host: host('boot:gpu', {
                            gpus: [
                                {
                                    kind: 'nvidia',
                                    device: 'nvidia0',
                                    encodeSessions: 8,
                                    maxEncodeSessions: 8,
                                    encoderPercent: 90,
                                },
                            ],
                        }),
                    }),
                ],
            }),
        );
        expect(g.gpu).toMatchObject({ inUse: 8, max: 8, videoPercent: 90, level: 'warn' });
        expect(g.level).toBe('warn');
    });

    it('is absent on a host without a GPU', () => {
        const g = summarize(status({ nodes: [node('gen-1', { host: host('boot:a') })] }));
        expect(g.gpu).toBeUndefined();
    });
});

describe('representative resource pressure', () => {
    it('a full smaller GPU beats a host with more sessions and spare capacity, regardless of order', () => {
        const full = node('small', {
            host: host('name:small', {
                gpus: [
                    { kind: 'nvidia', device: 'nvidia0', encodeSessions: 2, maxEncodeSessions: 2 },
                ],
            }),
        });
        const large = node('large', {
            host: host('name:large', {
                gpus: [
                    { kind: 'nvidia', device: 'nvidia0', encodeSessions: 6, maxEncodeSessions: 16 },
                ],
            }),
        });
        for (const nodes of [
            [full, large],
            [large, full],
        ]) {
            const g = summarize(status({ nodes }));
            expect(g.gpu).toMatchObject({ host: 'small', inUse: 2, max: 2, level: 'warn' });
            expect(g.level).toBe('warn');
        }
    });

    it('a full device still warns when another device on the same host has spare sessions', () => {
        const g = summarize(
            status({
                nodes: [
                    node('gpu', {
                        host: host('name:multi', {
                            gpus: [
                                {
                                    kind: 'nvidia',
                                    device: 'nvidia0',
                                    encodeSessions: 2,
                                    maxEncodeSessions: 2,
                                },
                                {
                                    kind: 'nvidia',
                                    device: 'nvidia1',
                                    encodeSessions: 0,
                                    maxEncodeSessions: 8,
                                },
                            ],
                        }),
                    }),
                ],
            }),
        );
        expect(g.gpu).toMatchObject({ inUse: 2, max: 10, level: 'warn' });
    });

    it('compares measured activity without summing different devices or hosts', () => {
        const g = summarize(
            status({
                nodes: [
                    node('quiet', {
                        host: host('name:quiet', {
                            gpus: [
                                {
                                    kind: 'nvidia',
                                    device: 'nvidia0',
                                    encodeSessions: 1,
                                    maxEncodeSessions: 8,
                                    busyPercent: 10,
                                },
                            ],
                        }),
                    }),
                    node('active', {
                        host: host('name:active', {
                            gpus: [
                                {
                                    kind: 'nvidia',
                                    device: 'nvidia0',
                                    busyPercent: 92,
                                    encoderPercent: 42,
                                },
                                {
                                    kind: 'nvidia',
                                    device: 'nvidia1',
                                    busyPercent: 70,
                                    encoderPercent: 65,
                                },
                            ],
                        }),
                    }),
                ],
            }),
        );
        expect(g.gpu).toMatchObject({
            host: 'active',
            utilizationPercent: 92,
            videoPercent: 65,
            videoScope: 'host',
        });
    });

    it('awake-only Intel telemetry never becomes utilization or a video sample', () => {
        const g = summarize(
            status({
                nodes: [
                    node('intel', {
                        host: host('name:intel', {
                            gpus: [
                                {
                                    kind: 'dri',
                                    device: 'renderD128',
                                    awakePercent: 100,
                                    powerWatts: 24.3,
                                },
                            ],
                        }),
                    }),
                ],
            }),
        );
        expect(g.gpu).toMatchObject({ inUse: 0, level: 'ok' });
        expect(g.gpu?.videoPercent).toBeUndefined();
        expect(g.gpu?.utilizationPercent).toBeUndefined();
    });

    it('a measured FFmpeg zero remains a measurement with its own scope', () => {
        const g = summarize(
            status({
                nodes: [
                    node('intel', {
                        host: host('boot:intel', { gpus: [{ kind: 'dri', device: 'renderD128' }] }),
                        process: { rssBytes: 1, gpu: { clients: 1, engines: { video: 0 } } },
                    }),
                ],
            }),
        );
        expect(g.gpu).toMatchObject({ videoPercent: 0, videoScope: 'lumastra' });
    });

    it('ranks host memory severity before ratio so a large cache does not conceal critical pressure', () => {
        const g = summarize(
            status({
                nodes: [
                    node('large', {
                        host: host('name:large', {
                            memTotalBytes: 256 * GiB,
                            memAvailableBytes: 5 * GiB,
                        }),
                    }),
                    node('small', {
                        host: host('name:small', {
                            memTotalBytes: 16 * GiB,
                            memAvailableBytes: 0.7 * GiB,
                        }),
                    }),
                ],
            }),
        );
        expect(g.hostMemory).toMatchObject({ host: 'small', level: 'critical' });
        expect(g.level).toBe('critical');
    });

    it('current critical memory beats a higher historical peak and still counts services online', () => {
        const g = summarize(
            status({
                nodes: [
                    node('web', {
                        role: 'web',
                        host: host('boot:a'),
                        resources: {
                            memoryUsedBytes: 300,
                            memoryLimitBytes: 1000,
                            memoryPeakBytes: 1000,
                        },
                    }),
                    node('worker', {
                        role: 'worker',
                        host: host('boot:a'),
                        resources: {
                            memoryUsedBytes: 960,
                            memoryLimitBytes: 1000,
                            memoryPeakBytes: 960,
                        },
                    }),
                ],
            }),
        );
        expect(g.container).toMatchObject({ role: 'worker', level: 'critical' });
        expect(g.services).toEqual({ up: 2, expected: 2, late: 0 });
    });
});

it('host encoder activity is not hidden by an idle Lumastra engine on the same host', () => {
    const g = summarize(
        status({
            nodes: [
                node('host-active', {
                    host: host('name:host-active', {
                        gpus: [{ kind: 'nvidia', device: 'nvidia0', encoderPercent: 90 }],
                    }),
                    process: { rssBytes: 1, gpu: { clients: 0, engines: { video: 0 } } },
                }),
                node('lumastra-active', {
                    host: host('name:lumastra-active', {
                        gpus: [{ kind: 'dri', device: 'renderD128' }],
                    }),
                    process: { rssBytes: 1, gpu: { clients: 2, engines: { video: 45 } } },
                }),
            ],
        }),
    );
    expect(g.gpu).toMatchObject({ host: 'host-active', videoPercent: 90, videoScope: 'host' });
});
