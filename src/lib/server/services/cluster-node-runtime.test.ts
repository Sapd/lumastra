// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readCpuPressurePercent } from './cluster-node-runtime.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    readPlacement,
    readRequests,
    readCgroupSnapshot,
    PeakWindow,
    ResourceSampler,
    type CgroupPaths,
    parseMemoryStat,
    memoryWorkingSet,
} from './cluster-node-runtime.js';

const GiB = 1024 ** 3;

let dir: string;
let paths: CgroupPaths;

async function put(rel: string, content: string): Promise<void> {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cgroup-test-'));
    paths = { root: join(dir, 'sys'), procSelfCgroup: join(dir, 'proc-self-cgroup') };
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('readPlacement', () => {
    it('reads the Downward API env vars', () => {
        expect(
            readPlacement({
                K8S_NODE_NAME: 'worker-2',
                K8S_POD_IP: '10.42.1.23',
                K8S_NAMESPACE: 'lumastra',
            }),
        ).toEqual({ nodeName: 'worker-2', podIp: '10.42.1.23', namespace: 'lumastra' });
    });

    it('is undefined outside Kubernetes', () => {
        expect(readPlacement({ HOSTNAME: 'abc' })).toBeUndefined();
        expect(readPlacement({ K8S_NODE_NAME: '  ' })).toBeUndefined();
    });
});

describe('readRequests', () => {
    it('converts millicores to cores and keeps bytes', () => {
        expect(
            readRequests({
                K8S_CPU_REQUEST_MILLICORES: '250',
                K8S_MEMORY_REQUEST_BYTES: '805306368',
            }),
        ).toEqual({ cpuRequestCores: 0.25, memoryRequestBytes: 805306368 });
    });

    it('treats an unset request (Downward API reports 0) as absent', () => {
        expect(
            readRequests({ K8S_CPU_REQUEST_MILLICORES: '0', K8S_MEMORY_REQUEST_BYTES: '0' }),
        ).toEqual({ cpuRequestCores: undefined, memoryRequestBytes: undefined });
    });
});

describe('readCgroupSnapshot — cgroup v2', () => {
    it('reads a private-namespace container cgroup at the mount root', async () => {
        await put('proc-self-cgroup', '0::/\n');
        await put('sys/cgroup.controllers', 'cpu memory');
        await put('sys/memory.current', String(3 * GiB));
        await put('sys/memory.stat', `anon 123\ninactive_file ${GiB}\nactive_file 5\n`);
        await put('sys/memory.max', String(4 * GiB));
        await put('sys/cpu.max', '200000 100000');
        await put('sys/cpu.stat', 'usage_usec 5000000\nuser_usec 1\n');

        expect(await readCgroupSnapshot(paths)).toMatchObject({
            memoryUsedBytes: 2 * GiB,
            memoryLimitBytes: 4 * GiB,
            cpuUsageUsec: 5_000_000,
            cpuLimitCores: 2,
        });
    });

    it('reports unlimited memory and CPU as absent', async () => {
        await put('proc-self-cgroup', '0::/\n');
        await put('sys/cgroup.controllers', 'cpu memory');
        await put('sys/memory.current', '1000');
        await put('sys/memory.max', 'max');
        await put('sys/cpu.max', 'max 100000');

        const snap = await readCgroupSnapshot(paths);
        expect(snap?.memoryLimitBytes).toBeUndefined();
        expect(snap?.cpuLimitCores).toBeUndefined();
        expect(snap?.memoryUsedBytes).toBe(1000);
    });

    it('follows a host-namespace membership path (systemd service)', async () => {
        await put('proc-self-cgroup', '0::/system.slice/lumastra.service\n');
        await put('sys/cgroup.controllers', 'cpu memory');
        await put('sys/system.slice/lumastra.service/memory.current', '4096');
        await put('sys/system.slice/lumastra.service/memory.max', '8192');

        const snap = await readCgroupSnapshot(paths);
        expect(snap?.memoryUsedBytes).toBe(4096);
        expect(snap?.memoryLimitBytes).toBe(8192);
    });

    it('is undefined on a bare host root cgroup (no memory.current)', async () => {
        await put('proc-self-cgroup', '0::/\n');
        await put('sys/cgroup.controllers', 'cpu memory');
        expect(await readCgroupSnapshot(paths)).toBeUndefined();
    });

    it('is undefined when there is no cgroup at all (macOS dev)', async () => {
        expect(await readCgroupSnapshot(paths)).toBeUndefined();
    });
});

describe('readCgroupSnapshot — cgroup v1', () => {
    it('reads memory and cpu controllers, treating the huge sentinel as unlimited', async () => {
        await put('proc-self-cgroup', '9:memory:/\n4:cpu,cpuacct:/\n');
        await put('sys/memory/memory.usage_in_bytes', '5000');
        await put('sys/memory/memory.stat', 'total_inactive_file 1000\n');
        await put('sys/memory/memory.limit_in_bytes', '9223372036854771712');
        await put('sys/cpu,cpuacct/cpuacct.usage', '3000000000');
        await put('sys/cpu,cpuacct/cpu.cfs_quota_us', '150000');
        await put('sys/cpu,cpuacct/cpu.cfs_period_us', '100000');

        expect(await readCgroupSnapshot(paths)).toMatchObject({
            memoryUsedBytes: 4000,
            memoryLimitBytes: undefined,
            cpuUsageUsec: 3_000_000,
            cpuLimitCores: 1.5,
        });
    });
});

describe('ResourceSampler', () => {
    it('reports CPU as a rate between two samples, merged with the requests', async () => {
        await put('proc-self-cgroup', '0::/\n');
        await put('sys/cgroup.controllers', 'cpu memory');
        await put('sys/memory.current', '100');
        await put('sys/cpu.stat', 'usage_usec 1000000\n');

        let now = 0;
        const sampler = new ResourceSampler(
            paths,
            { K8S_CPU_REQUEST_MILLICORES: '500' },
            () => now,
        );

        const first = await sampler.sample();
        expect(first?.cpuUsedCores).toBeUndefined();
        expect(first?.cpuRequestCores).toBe(0.5);

        // 5 s of CPU time over 10 s of wall time = half a core.
        await put('sys/cpu.stat', 'usage_usec 6000000\n');
        now = 10_000;
        const second = await sampler.sample();
        expect(second?.cpuUsedCores).toBeCloseTo(0.5);
    });

    it('is undefined without a readable cgroup', async () => {
        expect(await new ResourceSampler(paths, {}).sample()).toBeUndefined();
    });
});

describe('readCgroupSnapshot — limits on an ancestor', () => {
    it('v2: an init in a child cgroup still sees the container limit on the namespace root', async () => {
        await put('proc-self-cgroup', '0::/init.scope\n');
        await put('sys/cgroup.controllers', 'cpu memory');
        // Leaf: the process's own cgroup, no limit of its own.
        await put('sys/init.scope/memory.current', String(GiB));
        await put('sys/init.scope/memory.max', 'max');
        await put('sys/init.scope/cpu.max', 'max 100000');
        await put('sys/init.scope/cpu.stat', 'usage_usec 42\n');
        // Namespace root: the container limit and the whole container's usage.
        await put('sys/memory.current', String(3 * GiB));
        await put('sys/memory.stat', `inactive_file ${GiB}\n`);
        await put('sys/memory.max', String(4 * GiB));
        await put('sys/cpu.max', '150000 100000');
        await put('sys/cpu.stat', 'usage_usec 99\n');

        expect(await readCgroupSnapshot(paths)).toMatchObject({
            memoryUsedBytes: 2 * GiB,
            memoryLimitBytes: 4 * GiB,
            cpuUsageUsec: 42,
            cpuLimitCores: 1.5,
        });
    });

    it('v2: a zero memory.max is not a usable limit', async () => {
        await put('proc-self-cgroup', '0::/\n');
        await put('sys/cgroup.controllers', 'cpu memory');
        await put('sys/memory.current', '1000');
        await put('sys/memory.max', '0');
        expect((await readCgroupSnapshot(paths))?.memoryLimitBytes).toBeUndefined();
    });

    it('v1: follows a nested membership path and takes the tightest CPU quota', async () => {
        await put('proc-self-cgroup', '9:memory:/docker/abc\n4:cpu,cpuacct:/docker/abc\n');
        await put('sys/memory/docker/abc/memory.usage_in_bytes', '5000');
        await put('sys/memory/docker/abc/memory.limit_in_bytes', '8000');
        await put('sys/memory/memory.usage_in_bytes', '999999');
        await put('sys/cpu,cpuacct/docker/abc/cpuacct.usage', '2000');
        await put('sys/cpu,cpuacct/docker/abc/cpu.cfs_quota_us', '-1');
        await put('sys/cpu,cpuacct/docker/abc/cpu.cfs_period_us', '100000');
        await put('sys/cpu,cpuacct/docker/cpuacct.usage', '9000');
        await put('sys/cpu,cpuacct/docker/cpu.cfs_quota_us', '50000');
        await put('sys/cpu,cpuacct/docker/cpu.cfs_period_us', '100000');

        expect(await readCgroupSnapshot(paths)).toMatchObject({
            memoryUsedBytes: 5000,
            memoryLimitBytes: 8000,
            cpuUsageUsec: 2,
            cpuLimitCores: 0.5,
        });
    });
});

const DAY_MS = 24 * 60 * 60_000;

describe('PeakWindow', () => {
    it('keeps the largest value of a minute and forgets a value once it is 24 h old', () => {
        const window = new PeakWindow();
        expect(window.max()).toBeUndefined();
        window.record(5 * GiB, 0);
        window.record(3 * GiB, 30_000);
        expect(window.max()).toBe(5 * GiB);
        // One millisecond short of 24 h: the minute bucket of t=0 still counts.
        window.record(GiB, DAY_MS - 1);
        expect(window.max()).toBe(5 * GiB);
        // At 24 h that bucket has aged out.
        window.record(GiB, DAY_MS);
        expect(window.max()).toBe(GiB);
    });

    it('ignores a non-finite sample', () => {
        const window = new PeakWindow();
        window.record(Number.NaN, 0);
        expect(window.max()).toBeUndefined();
    });
});

describe('ResourceSampler — 24 h peak and OOM kills', () => {
    async function setupV2(): Promise<void> {
        await put('proc-self-cgroup', '0::/\n');
        await put('sys/cgroup.controllers', 'cpu memory');
    }

    it('memoryPeakBytes is the largest working set across samples', async () => {
        await setupV2();
        await put('sys/memory.current', String(GiB));
        let now = 0;
        const sampler = new ResourceSampler(paths, {}, () => now);
        expect((await sampler.sample())?.memoryPeakBytes).toBe(GiB);

        await put('sys/memory.current', String(3 * GiB));
        now = 10_000;
        expect((await sampler.sample())?.memoryPeakBytes).toBe(3 * GiB);

        await put('sys/memory.current', String(2 * GiB));
        now = 20_000;
        const calmer = await sampler.sample();
        expect(calmer?.memoryUsedBytes).toBe(2 * GiB);
        expect(calmer?.memoryPeakBytes).toBe(3 * GiB);
    });

    it('a peak ages out a day after it was taken, not before', async () => {
        await setupV2();
        let now = 0;
        await put('sys/memory.current', String(5 * GiB));
        const sampler = new ResourceSampler(paths, {}, () => now);
        await sampler.sample();

        await put('sys/memory.current', String(GiB));
        now = DAY_MS - 1;
        expect((await sampler.sample())?.memoryPeakBytes).toBe(5 * GiB);

        now = DAY_MS;
        expect((await sampler.sample())?.memoryPeakBytes).toBe(GiB);
    });

    it('memoryOomKills reads oom_kill from memory.events on cgroup v2', async () => {
        await setupV2();
        await put('sys/memory.current', '100');
        await put(
            'sys/memory.events',
            'low 0\nhigh 0\nmax 9\noom 3\noom_kill 2\noom_group_kill 0\n',
        );
        expect((await readCgroupSnapshot(paths))?.oomKills).toBe(2);
        expect((await new ResourceSampler(paths, {}).sample())?.memoryOomKills).toBe(2);
    });

    it('memoryOomKills reads oom_kill from memory.oom_control on cgroup v1', async () => {
        await put('proc-self-cgroup', '9:memory:/\n');
        await put('sys/memory/memory.usage_in_bytes', '5000');
        await put('sys/memory/memory.oom_control', 'oom_kill_disable 0\nunder_oom 0\noom_kill 4\n');
        expect((await readCgroupSnapshot(paths))?.oomKills).toBe(4);
        expect((await new ResourceSampler(paths, {}).sample())?.memoryOomKills).toBe(4);
    });

    it('memoryOomKills is undefined when memory.events is missing (v2)', async () => {
        await setupV2();
        await put('sys/memory.current', '100');
        expect((await readCgroupSnapshot(paths))?.oomKills).toBeUndefined();
        expect((await new ResourceSampler(paths, {}).sample())?.memoryOomKills).toBeUndefined();
    });

    it('memoryOomKills is undefined when memory.oom_control has no oom_kill line (v1, pre-4.13 kernel)', async () => {
        await put('proc-self-cgroup', '9:memory:/\n');
        await put('sys/memory/memory.usage_in_bytes', '5000');
        await put('sys/memory/memory.oom_control', 'oom_kill_disable 0\nunder_oom 0\n');
        expect((await readCgroupSnapshot(paths))?.oomKills).toBeUndefined();
    });
});

describe('readCpuPressurePercent', () => {
    it('reads some avg10 from the process cgroup, not host-wide PSI', async () => {
        await put('proc-self-cgroup', '0::/pod/web\n');
        await put(
            'sys/pod/web/cpu.pressure',
            'some avg10=21.50 avg60=4.00 total=42\nfull avg10=1.00',
        );
        await put('sys/cpu.pressure', 'some avg10=99.00 avg60=99.00 total=99');
        expect(await readCpuPressurePercent(paths)).toBe(21.5);
    });
    it('degrades to an unavailable metric for absent or invalid cgroup PSI', async () => {
        expect(await readCpuPressurePercent(paths)).toBeUndefined();
        await put('proc-self-cgroup', '0::/\n');
        await put('sys/cpu.pressure', 'some avg10=NaN avg60=0.00 total=0');
        expect(await readCpuPressurePercent(paths)).toBeUndefined();
    });
});

describe('memory.stat breakdown', () => {
    it.each([false, true])('maps cgroup counters at the binding level (v1=%s)', async (v1) => {
        await put('proc-self-cgroup', v1 ? '9:memory:/child' : '0::/child');
        if (!v1) await put('sys/cgroup.controllers', 'memory');
        const base = v1 ? 'sys/memory' : 'sys';
        await put(`${base}/child/${v1 ? 'memory.usage_in_bytes' : 'memory.current'}`, '999');
        await put(`${base}/${v1 ? 'memory.usage_in_bytes' : 'memory.current'}`, '1000');
        await put(`${base}/${v1 ? 'memory.limit_in_bytes' : 'memory.max'}`, '2000');
        const keys = v1
            ? [
                  'total_rss',
                  'total_cache',
                  'total_active_file',
                  'total_inactive_file',
                  'total_shmem',
                  'total_slab',
                  'total_dirty',
              ]
            : ['anon', 'file', 'active_file', 'inactive_file', 'shmem', 'slab', 'file_dirty'];
        await put(`${base}/memory.stat`, keys.map((k, i) => `${k} ${(i + 1) * 10}`).join('\n'));
        const snap = await new ResourceSampler(paths, {}).sample();
        expect(snap).toMatchObject({
            memoryAnonBytes: 10,
            memoryFileBytes: 20,
            memoryActiveFileBytes: 30,
            memoryInactiveFileBytes: 40,
            memoryShmemBytes: 50,
            memorySlabBytes: 60,
            memoryFileDirtyBytes: 70,
        });
        expect(snap?.memoryUsedBytes).toBe(960);
    });
});

it('handles partial, malformed and local v1 memory.stat counters without inventing unavailable fields', () => {
    expect(parseMemoryStat('rss 10\ncache 20\ninactive_file 5', true)).toMatchObject({
        memoryAnonBytes: 10,
        memoryFileBytes: 20,
        memoryInactiveFileBytes: 5,
    });
    const bad = parseMemoryStat('anon -10\nfile garbage\nfile_dirty NaN');
    expect(bad.memoryAnonBytes).toBeUndefined();
    expect(bad.memoryFileBytes).toBeUndefined();
    expect(bad.memorySlabBytes).toBeUndefined();
    expect(memoryWorkingSet(10, 20)).toBe(0);
});

describe('memory pressure excludes clean file cache', () => {
    it.each([false, true])(
        'samples cache separately and retains anonymous/kernel pressure (v1=%s)',
        async (v1) => {
            await put('proc-self-cgroup', v1 ? '9:memory:/' : '0::/');
            if (!v1) await put('sys/cgroup.controllers', 'memory');
            const base = v1 ? 'sys/memory' : 'sys';
            await put(`${base}/${v1 ? 'memory.limit_in_bytes' : 'memory.max'}`, String(6 * GiB));
            const usagePath = `${base}/${v1 ? 'memory.usage_in_bytes' : 'memory.current'}`;
            const statPath = `${base}/memory.stat`;
            const stats = (file: number): string =>
                v1
                    ? `total_cache ${file}\ntotal_inactive_file 0\ntotal_shmem 0\ntotal_dirty 0\ntotal_writeback 0\ntotal_unevictable 0`
                    : `file ${file}\ninactive_file 0\nshmem 0\nfile_dirty 0\nfile_writeback 0\nunevictable 0`;
            let now = 0;
            const sampler = new ResourceSampler(paths, {}, () => now);
            await put(usagePath, String(5.56 * GiB));
            await put(statPath, stats(4.75 * GiB));
            const cached = await sampler.sample();
            expect(cached?.memoryPressureBytes).toBeCloseTo(0.81 * GiB, 4);
            expect(cached?.memoryReclaimableFileBytes).toBeCloseTo(4.75 * GiB, 4);
            expect(cached?.memoryPressurePeakBytes).toBeCloseTo(0.81 * GiB, 4);
            now += 60_000;
            await put(usagePath, String(5.8 * GiB));
            await put(statPath, stats(0.05 * GiB));
            expect((await sampler.sample())?.memoryPressurePeakBytes).toBeCloseTo(5.75 * GiB, 4);
            now += 24 * 60 * 60_000;
            await put(usagePath, String(GiB));
            expect((await sampler.sample())?.memoryPressurePeakBytes).toBeCloseTo(0.95 * GiB, 4);
        },
    );

    it('keeps shmem, dirty/writeback, unevictable and kernel charges in pressure', async () => {
        await put('proc-self-cgroup', '0::/');
        await put('sys/cgroup.controllers', 'memory');
        await put('sys/memory.current', '1000');
        await put(
            'sys/memory.stat',
            'anon 300\nfile 600\nshmem 100\nfile_dirty 50\nfile_writeback 20\nunevictable 30\ninactive_file 200',
        );
        const snap = await new ResourceSampler(paths, {}).sample();
        expect(snap?.memoryReclaimableFileBytes).toBe(400);
        expect(snap?.memoryPressureBytes).toBe(600);
    });

    it('does not invent a pressure peak from missing cache counters', async () => {
        await put('proc-self-cgroup', '0::/');
        await put('sys/cgroup.controllers', 'memory');
        await put('sys/memory.current', '1000');
        await put('sys/memory.stat', 'inactive_file 100');
        const snap = await new ResourceSampler(paths, {}).sample();
        expect(snap?.memoryUsedBytes).toBe(900);
        expect(snap?.memoryPressureBytes).toBeUndefined();
        expect(snap?.memoryPressurePeakBytes).toBeUndefined();
    });
});
