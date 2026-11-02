// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Tests for ClusterHeartbeatService: deriveNodeRole, heartbeat payload fields, transition detection.
import type postgres from 'postgres';
import type { NodeEventInsert } from '../database/queries/cluster-nodes.queries.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Isolate config mock before importing service
vi.mock('../config.js', () => ({
    config: {
        INSTANCE_ID: 'test-instance-abc123',
        STREAM_PROXY_MODE: false,
        PREVIEW_CACHE_DIR: '/config/cache/preview',
        FFMPEG_TRANSCODE_DIR: '/tmp/lumastra-transcode',
        WORKER_MODE: 'enabled',
        DEDICATED_WORKER: false,
        // The heartbeat payload now carries version + hostname; the service reads
        // these straight off config, so the mock must supply them or JSON.stringify
        // drops the undefined keys and the payload-shape assertions fail.
        APP_VERSION: '0.0.0-test',
        HOSTNAME: 'test-host',
    },
}));

vi.mock('../cache/valkey.js', () => ({
    getCoordinationClient: vi.fn(() => null),
    cacheSet: vi.fn().mockResolvedValue(true),
    cacheDel: vi.fn().mockResolvedValue(1),
    cacheGet: vi.fn().mockResolvedValue(null),
    getKeysByPattern: vi.fn().mockResolvedValue([]),
    scanKeysOrThrow: vi.fn().mockResolvedValue([]),
    acquireLock: vi.fn().mockResolvedValue('mock-lock-value'),
    renewLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(true),
    isCoordinationValkeyReady: vi.fn(),
    isCoordinationValkeyHealthy: vi.fn(),
    getKeyTtlSeconds: vi.fn(async () => 27),
}));

// The real sampler reads /sys/fs/cgroup with real async I/O, which fake timers
// do not flush — a tick advanced by advanceTimersByTimeAsync would still be
// awaiting the file reads when the test asserts. cluster-node-runtime.test.ts
// covers the reader itself.
vi.mock('./cluster-node-runtime.js', () => ({
    readPlacement: vi.fn(() => undefined),
    ResourceSampler: class {
        sample(): Promise<undefined> {
            return Promise.resolve(undefined);
        }
    },
}));

const samplerOptions = vi.hoisted((): unknown[] => []);
// Same reason for the host/process collector (src/shared/host-metrics.test.ts covers
// it): only the sampler is stubbed, the parsers stay real.
vi.mock('../../../shared/host-metrics.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../shared/host-metrics.js')>()),
    HostMetricsSampler: class {
        constructor(options: unknown) {
            samplerOptions.push(options);
        }
    },
    sampleHostMetricsSafe: vi.fn(() =>
        Promise.resolve({
            implementation: 'node',
            host: { id: 'boot:0123456789abcdef', memTotalBytes: 1024 },
            process: { rssBytes: 512 },
        }),
    ),
}));

vi.mock('../database/queries/cluster-nodes.queries.js', () => ({
    insertNodeEvent: vi.fn().mockResolvedValue(undefined),
    pruneOldEvents: vi.fn().mockResolvedValue(0),
    getInstancesExpectedOnline: vi.fn().mockResolvedValue([]),
    recordInstanceStart: vi.fn().mockResolvedValue('start'),
}));

/**
 * Minimal `postgres.Sql` stand-in. `detectTransitions` now persists a batch of
 * transitions inside a single transaction via `sql.begin`, so the mock must
 * invoke the callback with a transaction handle.
 */
function makeTxSql(): postgres.Sql {
    const sql = {
        begin: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(sql)),
    } as unknown as postgres.Sql;
    return sql;
}

/**
 * Flattens the batched `insertNodeEvent(sql, NodeEventInsert[])` calls into the
 * individual events. Each tick now writes all its transitions as one array
 * argument instead of one call per event.
 */
function insertedEvents(calls: [unknown, unknown][]): NodeEventInsert[] {
    return calls.flatMap((c) => {
        const arg = c[1];
        return Array.isArray(arg) ? (arg as NodeEventInsert[]) : [arg as NodeEventInsert];
    });
}

import { deriveNodeRole, getLiveInstanceIds, parseGpuAccess } from './cluster-heartbeat.service.js';
import { config } from '../config.js';
import {
    getKeysByPattern,
    scanKeysOrThrow,
    cacheSet,
    cacheGet,
    renewLock,
    isCoordinationValkeyReady,
    isCoordinationValkeyHealthy,
} from '../cache/valkey.js';

describe('deriveNodeRole', () => {
    it('returns proxy when STREAM_PROXY_MODE is true', () => {
        vi.mocked(config as Record<string, unknown>).STREAM_PROXY_MODE = true;
        expect(deriveNodeRole()).toBe('proxy');
        vi.mocked(config as Record<string, unknown>).STREAM_PROXY_MODE = false;
    });

    it('returns web when WORKER_MODE is disabled', () => {
        vi.mocked(config as Record<string, unknown>).STREAM_PROXY_MODE = false;
        vi.mocked(config as Record<string, unknown>).WORKER_MODE = 'disabled';
        expect(deriveNodeRole()).toBe('web');
    });

    it('returns worker when WORKER_MODE=enabled AND DEDICATED_WORKER (dedicated worker container)', () => {
        vi.mocked(config as Record<string, unknown>).STREAM_PROXY_MODE = false;
        vi.mocked(config as Record<string, unknown>).WORKER_MODE = 'enabled';
        vi.mocked(config as Record<string, unknown>).DEDICATED_WORKER = true;
        expect(deriveNodeRole()).toBe('worker');
        vi.mocked(config as Record<string, unknown>).DEDICATED_WORKER = false;
    });

    it('rejects an obsolete combined process role', () => {
        vi.mocked(config as Record<string, unknown>).STREAM_PROXY_MODE = false;
        vi.mocked(config as Record<string, unknown>).WORKER_MODE = 'enabled';
        vi.mocked(config as Record<string, unknown>).DEDICATED_WORKER = false;
        expect(() => deriveNodeRole()).toThrow('Combined web/task mode is unsupported');
        vi.mocked(config as Record<string, unknown>).WORKER_MODE = 'disabled';
    });
});

describe('heartbeat payload', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.mocked(getKeysByPattern).mockResolvedValue([]);
    });
    afterEach(async () => {
        const { clusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        await clusterHeartbeatService.stop();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('contains required fields when writing heartbeat', async () => {
        const { clusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        const mockSql = {} as postgres.Sql;
        await clusterHeartbeatService.start(mockSql);

        const callArgs = vi.mocked(cacheSet).mock.calls[0];
        expect(callArgs).toBeDefined();
        const payload = JSON.parse(callArgs[1] as string) as Record<string, unknown>;
        expect(payload).toHaveProperty('instanceId');
        expect(payload).toHaveProperty('role');
        expect(payload).toHaveProperty('version');
        expect(payload).toHaveProperty('startedAt');
        expect(payload).toHaveProperty('hostname');
        // Host + process block (src/shared/host-metrics.ts): always a host id and RSS.
        expect(payload.implementation).toBe('node');
        expect(typeof payload.sentAt).toBe('string');
        expect((payload.host as { id?: unknown }).id).toEqual(expect.any(String));
        expect((payload.process as { rssBytes?: unknown }).rssBytes).toBeGreaterThan(0);
    });

    it('measures the cache volume (parent of the preview cache) and the transcode dir', async () => {
        const { clusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        await clusterHeartbeatService.start({} as postgres.Sql);
        expect(samplerOptions.at(-1)).toEqual({
            implementation: 'node',
            disks: [
                { role: 'cache', path: '/config/cache' },
                { role: 'transcode', path: '/tmp/lumastra-transcode' },
            ],
        });
    });

    it('reads host and process blocks back, and drops malformed ones', async () => {
        const { readClusterNodes } = await import('./cluster-heartbeat.service.js');
        const { getKeysByPattern, cacheGet } = await import('../cache/valkey.js');
        const base = {
            role: 'proxy',
            version: '1',
            startedAt: new Date().toISOString(),
            hostname: 'h',
        };
        const payloads: Record<string, unknown> = {
            'cluster:node:rust': {
                ...base,
                instanceId: 'rust',
                implementation: 'rust',
                sentAt: '2026-10-20T10:42:00.091Z',
                host: { id: 'boot:abc', memTotalBytes: 10, load1: 0.5 },
                process: { rssBytes: 5, cpuPercent: 1.5 },
            },
            'cluster:node:bad': {
                ...base,
                instanceId: 'bad',
                implementation: 'cobol',
                host: { memTotalBytes: 10 },
                process: { cpuPercent: 1 },
            },
        };
        vi.mocked(getKeysByPattern).mockResolvedValueOnce(Object.keys(payloads));
        vi.mocked(cacheGet).mockImplementation(async (key: string) =>
            payloads[key] ? JSON.stringify(payloads[key]) : null,
        );
        const nodes = await readClusterNodes({ withHeartbeatAge: true });
        vi.mocked(cacheGet).mockResolvedValue(null);
        const byId = Object.fromEntries(nodes.map((n) => [n.instanceId, n]));
        // 30 s TTL, 27 s left: the beat is 3 s old by Valkey's clock.
        expect(byId.rust.heartbeatAgeMs).toBe(3000);
        expect(byId.rust).toMatchObject({
            implementation: 'rust',
            sentAt: '2026-10-20T10:42:00.091Z',
            host: { id: 'boot:abc', memTotalBytes: 10, load1: 0.5 },
            process: { rssBytes: 5, cpuPercent: 1.5 },
        });
        expect(byId.bad.implementation).toBeUndefined();
        expect(byId.bad.host).toBeUndefined();
        expect(byId.bad.process).toBeUndefined();
    });

    it('records its own start before the first heartbeat write, once', async () => {
        const { recordInstanceStart } =
            await import('../database/queries/cluster-nodes.queries.js');
        const { ClusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        const order: string[] = [];
        vi.mocked(recordInstanceStart).mockImplementationOnce(async () => {
            order.push('start');
            return 'start';
        });
        vi.mocked(cacheSet).mockImplementationOnce(async () => {
            order.push('heartbeat');
            return true;
        });

        const svc = new ClusterHeartbeatService('test-start-order', '1.0.0');
        await svc.start({} as postgres.Sql);
        await svc.start({} as postgres.Sql);
        await svc.stop();

        expect(order.slice(0, 2)).toEqual(['start', 'heartbeat']);
        expect(vi.mocked(recordInstanceStart)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(recordInstanceStart).mock.calls[0][1]).toMatchObject({
            instanceId: 'test-start-order',
            version: '1.0.0',
        });
    });

    it('concurrent start() callers share one start: one record, one interval, nobody returns early', async () => {
        const { recordInstanceStart, insertNodeEvent } =
            await import('../database/queries/cluster-nodes.queries.js');
        const { ClusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        let releaseStart!: () => void;
        vi.mocked(recordInstanceStart).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseStart = () => resolve('restart');
                }),
        );
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        const svc = new ClusterHeartbeatService('test-concurrent', '1.0.0');
        const first = svc.start({} as postgres.Sql);
        const second = svc.start({} as postgres.Sql);
        let secondDone = false;
        void second.then(() => (secondDone = true));
        await vi.advanceTimersByTimeAsync(0);

        // The second caller must not write a heartbeat ahead of the start record.
        expect(secondDone).toBe(false);
        expect(vi.mocked(cacheSet)).not.toHaveBeenCalled();

        releaseStart();
        await Promise.all([first, second]);
        expect(vi.mocked(recordInstanceStart)).toHaveBeenCalledTimes(1);
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);

        await svc.stop();
        const stopEvent = vi.mocked(insertNodeEvent).mock.calls.at(-1)?.[1];
        expect(stopEvent).toMatchObject({ eventType: 'offline', reason: 'stop' });
        setIntervalSpy.mockRestore();
    });

    it('still heartbeats when recording the start fails', async () => {
        const { recordInstanceStart } =
            await import('../database/queries/cluster-nodes.queries.js');
        const { ClusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        vi.mocked(recordInstanceStart).mockRejectedValueOnce(new Error('db down'));

        const svc = new ClusterHeartbeatService('test-start-fail', '1.0.0');
        await svc.start({} as postgres.Sql);
        await svc.stop();

        expect(vi.mocked(cacheSet)).toHaveBeenCalled();
    });
});

describe('transition detection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });
    afterEach(async () => {
        const { clusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        await clusterHeartbeatService.stop();
        vi.useRealTimers();
    });

    it('detects new nodes coming online', async () => {
        const { insertNodeEvent } = await import('../database/queries/cluster-nodes.queries.js');
        const { clusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        const mockSql = makeTxSql();

        // First tick (start): acquireLock succeeds, establishes baseline with empty set
        vi.mocked(getKeysByPattern).mockResolvedValue([]);
        await clusterHeartbeatService.start(mockSql);
        vi.mocked(insertNodeEvent).mockClear();

        // Second tick: renewLock succeeds, a new node appears
        vi.mocked(getKeysByPattern).mockResolvedValue([
            'cluster:node:test-instance-abc123',
            'cluster:node:new-node-xyz',
        ]);
        vi.mocked(renewLock).mockResolvedValue(true);
        await vi.advanceTimersByTimeAsync(10_000);

        const events = insertedEvents(
            vi.mocked(insertNodeEvent).mock.calls as [unknown, unknown][],
        );
        const onlineEvents = events.filter((e) => e.eventType === 'online');
        expect(onlineEvents.length).toBeGreaterThan(0);
        const newNodeEvent = onlineEvents.find((e) => e.instanceId === 'new-node-xyz');
        expect(newNodeEvent).toBeDefined();
    });

    it('an offline (missing) event carries the role the leader saw while the node was live', async () => {
        const { insertNodeEvent } = await import('../database/queries/cluster-nodes.queries.js');
        const { clusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        const { cacheGet } = await import('../cache/valkey.js');
        const mockSql = makeTxSql();
        // A Rust proxy that was already live when this leader took over: no online
        // event of its own, so its role is known only from its heartbeat payload.
        vi.mocked(getKeysByPattern).mockResolvedValue([
            'cluster:node:test-instance-abc123',
            'cluster:node:proxy-1',
        ]);
        vi.mocked(cacheGet).mockImplementation(async (key: string) =>
            key === 'cluster:node:proxy-1'
                ? JSON.stringify({ role: 'proxy', version: '0.4.2', hostname: 'px' })
                : null,
        );
        await clusterHeartbeatService.start(mockSql);
        vi.mocked(insertNodeEvent).mockClear();

        vi.mocked(getKeysByPattern).mockResolvedValue(['cluster:node:test-instance-abc123']);
        vi.mocked(renewLock).mockResolvedValue(true);
        await vi.advanceTimersByTimeAsync(10_000);
        vi.mocked(cacheGet).mockResolvedValue(null);

        const offline = insertedEvents(
            vi.mocked(insertNodeEvent).mock.calls as [unknown, unknown][],
        ).find((e) => e.instanceId === 'proxy-1' && e.eventType === 'offline');
        expect(offline).toMatchObject({ role: 'proxy', version: '0.4.2', hostname: 'px' });
    });

    it('skips offline events when live set drops to zero', async () => {
        const { insertNodeEvent } = await import('../database/queries/cluster-nodes.queries.js');
        const { clusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        const mockSql = makeTxSql();

        // First tick: acquireLock succeeds, baseline has one node
        vi.mocked(getKeysByPattern).mockResolvedValue(['cluster:node:existing-node']);
        await clusterHeartbeatService.start(mockSql);
        vi.mocked(insertNodeEvent).mockClear();

        // Second tick: all nodes gone (Valkey restart scenario)
        vi.mocked(getKeysByPattern).mockResolvedValue([]);
        vi.mocked(renewLock).mockResolvedValue(true);
        await vi.advanceTimersByTimeAsync(10_000);

        const offlineEvents = insertedEvents(
            vi.mocked(insertNodeEvent).mock.calls as [unknown, unknown][],
        ).filter((e) => e.eventType === 'offline');
        expect(offlineEvents.length).toBe(0);
    });

    it('records offline for nodes that crashed during leader handoff', async () => {
        const { insertNodeEvent, getInstancesExpectedOnline } =
            await import('../database/queries/cluster-nodes.queries.js');
        const { clusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        const mockSql = makeTxSql();

        // DB says 'crashed-node' was last online, but it's not in Valkey anymore
        vi.mocked(getInstancesExpectedOnline).mockResolvedValue([
            'crashed-node',
            'test-instance-abc123',
        ]);
        vi.mocked(getKeysByPattern).mockResolvedValue(['cluster:node:test-instance-abc123']);
        await clusterHeartbeatService.start(mockSql);

        const offlineEvents = insertedEvents(
            vi.mocked(insertNodeEvent).mock.calls as [unknown, unknown][],
        ).filter((e) => e.eventType === 'offline');
        const crashedEvent = offlineEvents.find((e) => e.instanceId === 'crashed-node');
        expect(crashedEvent).toBeDefined();
        // Leader key-diff rows are tagged so restart counts can ignore them.
        expect(crashedEvent?.reason).toBe('missing');
    });
});

/**
 * Exercise the load-bearing guards inside
 * {@link getLiveInstanceIds}. The scheduler's ghost-job reclaim path
 * leans on these: every caller MUST treat a thrown error as "unknown
 * liveness" and fall back to PTTL. Silently collapsing a scan failure
 * into an empty set would mass-reclaim every peer's in-flight work on
 * any transient Valkey fault, so the guards must be tested directly.
 */
describe('getLiveInstanceIds liveness guards', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Healthy Valkey is the default — individual tests override.
        vi.mocked(isCoordinationValkeyReady).mockReturnValue(true);
        vi.mocked(isCoordinationValkeyHealthy).mockResolvedValue(true);
    });

    it('returns the set including self when SCAN yields self among the keys', async () => {
        vi.mocked(scanKeysOrThrow).mockResolvedValue([
            'cluster:node:test-instance-abc123',
            'cluster:node:node-peer',
        ]);

        const result = await getLiveInstanceIds();

        expect(result).toBeInstanceOf(Set);
        expect(result.has('test-instance-abc123')).toBe(true);
        expect(result.has('node-peer')).toBe(true);
        expect(result.size).toBe(2);
    });

    it('adds self unconditionally when SCAN omits self', async () => {
        // Observed-on-preprod case: Valkey SCAN misses the just-SET self
        // key. We're the caller — we know we're alive — so we add self
        // unconditionally. Trusting SCAN here would fail-close even when
        // the replica is healthy, and downstream classification of peer
        // claims depends on knowing self is in the live set.
        vi.mocked(scanKeysOrThrow).mockResolvedValue([
            'cluster:node:node-peer',
            'cluster:node:node-other',
        ]);

        const result = await getLiveInstanceIds();

        expect(result.has('test-instance-abc123')).toBe(true);
        expect(result.has('node-peer')).toBe(true);
        expect(result.has('node-other')).toBe(true);
        expect(result.size).toBe(3);
    });

    it('returns a set with self only when SCAN returns empty', async () => {
        // Fresh cluster with no peer replicas OR a legitimate empty-cluster
        // moment. Either way, self is alive and present; other replicas'
        // absence is correctly reflected.
        vi.mocked(scanKeysOrThrow).mockResolvedValue([]);

        const result = await getLiveInstanceIds();

        expect(result.has('test-instance-abc123')).toBe(true);
        expect(result.size).toBe(1);
    });

    it('propagates a SCAN failure instead of swallowing it into an empty set (F43)', async () => {
        // This is the load-bearing guarantee F43 fixes: getLiveInstanceIds
        // must use the non-swallowing scanKeysOrThrow. A transient Valkey
        // SCAN error MUST throw — never collapse to `[]`, which the ghost-job
        // reclaim path would misread as "no peers alive" and mass-reclaim
        // every peer's in-flight work.
        vi.mocked(scanKeysOrThrow).mockRejectedValue(new Error('SCAN failed — connection reset'));

        await expect(getLiveInstanceIds()).rejects.toThrow(/SCAN failed/);
    });

    it('throws when Valkey is not ready (client absent)', async () => {
        vi.mocked(isCoordinationValkeyReady).mockReturnValue(false);

        await expect(getLiveInstanceIds()).rejects.toThrow(/Valkey not ready/);
    });

    it('throws when Valkey ping health check fails', async () => {
        vi.mocked(isCoordinationValkeyReady).mockReturnValue(true);
        vi.mocked(isCoordinationValkeyHealthy).mockResolvedValue(false);

        await expect(getLiveInstanceIds()).rejects.toThrow(/Valkey health check failed/);
    });
});

describe('readClusterNodes — placement and resources', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('passes valid blocks through and drops malformed or missing ones', async () => {
        const { readClusterNodes } = await import('./cluster-heartbeat.service.js');
        const base = {
            role: 'web',
            version: '1.0.0',
            startedAt: new Date().toISOString(),
            hostname: 'h',
        };
        const payloads: Record<string, unknown> = {
            'cluster:node:k8s': {
                ...base,
                instanceId: 'k8s',
                placement: { nodeName: 'worker-2', podIp: '10.42.1.23', namespace: 'lumastra' },
                resources: {
                    memoryUsedBytes: 1024,
                    memoryLimitBytes: 4096,
                    memoryAnonBytes: 512,
                    memoryFileBytes: 400,
                    memoryActiveFileBytes: 100,
                    memoryInactiveFileBytes: 300,
                    memoryShmemBytes: 20,
                    memorySlabBytes: 30,
                    memoryFileDirtyBytes: 10,
                    cpuUsedCores: 0.4,
                    cpuRequestCores: 0.25,
                },
            },
            'cluster:node:old-build': { ...base, instanceId: 'old-build' },
            'cluster:node:garbage': {
                ...base,
                instanceId: 'garbage',
                placement: 'media',
                resources: { memoryUsedBytes: 'lots', cpuUsedCores: 1 },
            },
        };
        vi.mocked(getKeysByPattern).mockResolvedValueOnce(Object.keys(payloads));
        vi.mocked(cacheGet).mockImplementation(async (key: string) =>
            JSON.stringify(payloads[key]),
        );

        const nodes = new Map((await readClusterNodes()).map((n) => [n.instanceId, n]));
        vi.mocked(cacheGet).mockResolvedValue(null);

        expect(nodes.get('k8s')?.placement).toEqual({
            nodeName: 'worker-2',
            podIp: '10.42.1.23',
            namespace: 'lumastra',
        });
        expect(nodes.get('k8s')?.resources).toMatchObject({
            memoryUsedBytes: 1024,
            memoryLimitBytes: 4096,
            memoryAnonBytes: 512,
            memoryFileBytes: 400,
            memoryActiveFileBytes: 100,
            memoryInactiveFileBytes: 300,
            memoryShmemBytes: 20,
            memorySlabBytes: 30,
            memoryFileDirtyBytes: 10,
            cpuUsedCores: 0.4,
            cpuRequestCores: 0.25,
        });
        expect(nodes.get('old-build')?.placement).toBeUndefined();
        expect(nodes.get('old-build')?.resources).toBeUndefined();
        expect(nodes.get('garbage')?.placement).toBeUndefined();
        expect(nodes.get('garbage')?.resources).toBeUndefined();
    });

    it('passes the 24 h memory peak and the OOM-kill count through, and drops non-numbers', async () => {
        const { readClusterNodes } = await import('./cluster-heartbeat.service.js');
        const base = {
            role: 'web',
            version: '1.0.0',
            startedAt: new Date().toISOString(),
            hostname: 'h',
        };
        const payloads: Record<string, unknown> = {
            'cluster:node:peaked': {
                ...base,
                instanceId: 'peaked',
                resources: {
                    memoryUsedBytes: 1024,
                    memoryLimitBytes: 4096,
                    memoryPeakBytes: 3900,
                    memoryPressureBytes: 900,
                    memoryPressurePeakBytes: 1200,
                    memoryReclaimableFileBytes: 124,
                    memoryFileWritebackBytes: 10,
                    memoryUnevictableBytes: 20,
                    memoryOomKills: 2,
                },
            },
            'cluster:node:text': {
                ...base,
                instanceId: 'text',
                resources: {
                    memoryUsedBytes: 1024,
                    memoryPeakBytes: 'huge',
                    memoryPressureBytes: 'huge',
                    memoryPressurePeakBytes: 'huge',
                    memoryReclaimableFileBytes: 'huge',
                    memoryOomKills: 'many',
                },
            },
        };
        vi.mocked(getKeysByPattern).mockResolvedValueOnce(Object.keys(payloads));
        vi.mocked(cacheGet).mockImplementation(async (key: string) =>
            JSON.stringify(payloads[key]),
        );

        const nodes = new Map((await readClusterNodes()).map((n) => [n.instanceId, n]));
        vi.mocked(cacheGet).mockResolvedValue(null);

        expect(nodes.get('peaked')?.resources).toMatchObject({
            memoryUsedBytes: 1024,
            memoryPeakBytes: 3900,
            memoryOomKills: 2,
            memoryPressureBytes: 900,
            memoryPressurePeakBytes: 1200,
            memoryReclaimableFileBytes: 124,
            memoryFileWritebackBytes: 10,
            memoryUnevictableBytes: 20,
        });
        expect(nodes.get('text')?.resources?.memoryPeakBytes).toBeUndefined();
        expect(nodes.get('text')?.resources?.memoryPressurePeakBytes).toBeUndefined();
        expect(nodes.get('text')?.resources?.memoryPressureBytes).toBeUndefined();
        expect(nodes.get('text')?.resources?.memoryReclaimableFileBytes).toBeUndefined();
        expect(nodes.get('text')?.resources?.memoryOomKills).toBeUndefined();
        expect(nodes.get('text')?.resources?.memoryUsedBytes).toBe(1024);
    });
});

describe('readClusterNodes — Live TV proxy protocol and build', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('passes a valid protocol and build id through and drops garbled ones', async () => {
        const { readClusterNodes } = await import('./cluster-heartbeat.service.js');
        const base = {
            role: 'proxy',
            version: '1.0.0',
            startedAt: new Date().toISOString(),
            hostname: 'p',
        };
        const payloads: Record<string, unknown> = {
            'cluster:node:new': {
                ...base,
                instanceId: 'new',
                proxyProtocol: 1,
                proxyBuild: 'e7292a9df2b9749b',
            },
            'cluster:node:old': { ...base, instanceId: 'old' },
            'cluster:node:bad': {
                ...base,
                instanceId: 'bad',
                proxyProtocol: -1,
                proxyBuild: 'E7292A9DF2B9749B',
            },
            'cluster:node:frac': { ...base, instanceId: 'frac', proxyProtocol: 1.5 },
        };
        vi.mocked(getKeysByPattern).mockResolvedValueOnce(Object.keys(payloads));
        vi.mocked(cacheGet).mockImplementation(async (key: string) =>
            JSON.stringify(payloads[key]),
        );

        const nodes = new Map((await readClusterNodes()).map((n) => [n.instanceId, n]));
        vi.mocked(cacheGet).mockResolvedValue(null);

        expect(nodes.get('new')).toMatchObject({
            proxyProtocol: 1,
            proxyBuild: 'e7292a9df2b9749b',
        });
        for (const id of ['old', 'bad', 'frac']) {
            expect(nodes.get(id)?.proxyProtocol).toBeUndefined();
            expect(nodes.get(id)?.proxyBuild).toBeUndefined();
        }
    });
});

describe('heartbeat runtime state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getKeysByPattern).mockResolvedValue([]);
    });

    it('publishes the provider state, and a throwing provider costs only the optional block', async () => {
        const { ClusterHeartbeatService } = await import('./cluster-heartbeat.service.js');
        const svc = new ClusterHeartbeatService('test-runtime-state', '1.0.0');
        svc.setRuntimeStateProvider(() => ({
            upgradeState: 'prepared',
            consumers: { running: 4, paused: 4 },
            lease: { held: false },
        }));
        await svc.start({} as postgres.Sql);
        const withRuntime = JSON.parse(vi.mocked(cacheSet).mock.calls[0][1] as string) as {
            runtime?: unknown;
        };
        expect(withRuntime.runtime).toEqual({
            upgradeState: 'prepared',
            consumers: { running: 4, paused: 4 },
            lease: { held: false },
        });
        await svc.stop();

        vi.mocked(cacheSet).mockClear();
        const broken = new ClusterHeartbeatService('test-runtime-broken', '1.0.0');
        broken.setRuntimeStateProvider(() => {
            throw new Error('provider down');
        });
        await broken.start({} as postgres.Sql);
        const payload = JSON.parse(vi.mocked(cacheSet).mock.calls[0][1] as string) as Record<
            string,
            unknown
        >;
        expect(payload).toHaveProperty('instanceId');
        expect(payload).not.toHaveProperty('runtime');
        await broken.stop();
    });

    it('readClusterNodes parses the runtime block and tolerates older nodes and garbage', async () => {
        const { readClusterNodes } = await import('./cluster-heartbeat.service.js');
        const base = {
            role: 'worker',
            version: '1.0.0',
            startedAt: new Date().toISOString(),
            hostname: 'h',
        };
        const payloads: Record<string, unknown> = {
            'cluster:node:new': {
                ...base,
                instanceId: 'new',
                runtime: {
                    upgradeState: 'prepared',
                    consumers: { running: 3, paused: 3, lastProgressAt: '2026-10-20T10:00:00Z' },
                    lease: { held: true, lastRenewAt: '2026-10-20T10:00:01Z' },
                    watcher: { state: 'ready', restarts: 1 },
                    uncaughtExceptions: 2,
                },
            },
            'cluster:node:old': { ...base, instanceId: 'old' },
            'cluster:node:junk': {
                ...base,
                instanceId: 'junk',
                runtime: { consumers: 'x', lease: 5 },
            },
        };
        vi.mocked(getKeysByPattern).mockResolvedValueOnce(Object.keys(payloads));
        vi.mocked(cacheGet).mockImplementation(async (key: string) =>
            JSON.stringify(payloads[key]),
        );
        const nodes = new Map((await readClusterNodes()).map((n) => [n.instanceId, n]));
        vi.mocked(cacheGet).mockResolvedValue(null);

        expect(nodes.get('new')?.runtime).toMatchObject({
            upgradeState: 'prepared',
            consumers: { running: 3, paused: 3 },
            lease: { held: true },
            watcher: { state: 'ready', restarts: 1 },
            uncaughtExceptions: 2,
        });
        expect(nodes.get('old')?.runtime).toBeUndefined();
        expect(nodes.get('junk')?.runtime).toBeUndefined();
    });
});

describe('parseGpuAccess (encoder probe in the heartbeat)', () => {
    it('keeps a well-formed probe and drops malformed parts', () => {
        expect(
            parseGpuAccess({
                configured: 'qsv',
                accessible: true,
                name: 'Arc A380',
                capabilities: ['QSV Encode', 42, 'x'.repeat(65)],
            }),
        ).toEqual({
            configured: 'qsv',
            accessible: true,
            name: 'Arc A380',
            capabilities: ['QSV Encode'],
        });
        expect(
            parseGpuAccess({ configured: 'nvenc', accessible: false, error: 'e'.repeat(300) })
                ?.error,
        ).toHaveLength(200);
    });

    it('reads a payload from an older build (no field) or garbage as absent', () => {
        expect(parseGpuAccess(undefined)).toBeUndefined();
        expect(parseGpuAccess({ configured: 'qsv' })).toBeUndefined();
        expect(parseGpuAccess('qsv')).toBeUndefined();
    });
});
