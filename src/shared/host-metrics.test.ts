// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    HostMetricsSampler,
    MAX_DISKS,
    meminfoBytes,
    parseHostInfo,
    parseImplementation,
    parseProcessInfo,
    parseProcStatCpu,
    resolveHostId,
    MAX_GPUS,
    sampleHostMetricsSafe,
    type HostMetricsPaths,
} from './host-metrics.js';

let root: string;
let paths: HostMetricsPaths;

async function put(rel: string, content: string): Promise<void> {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'host-metrics-'));
    paths = {
        proc: join(root, 'proc'),
        sys: join(root, 'sys'),
        dev: join(root, 'dev'),
        machineId: join(root, 'etc/machine-id'),
    };
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('resolveHostId', () => {
    it('uses the boot id even in Kubernetes, so pods with and without the Downward API env group together', async () => {
        await put('proc/sys/kernel/random/boot_id', 'abc\n');
        // sha256("abc"), first 16 hex: the same value the Rust proxy and the sidecar compute.
        expect(await resolveHostId({ K8S_NODE_NAME: 'srv-1' }, paths, 'pod-x')).toBe(
            'boot:ba7816bf8f01cfea',
        );
        expect(await resolveHostId({}, paths, 'pod-y')).toBe('boot:ba7816bf8f01cfea');
    });

    it('falls back to the Kubernetes node name when the boot id is unreadable', async () => {
        expect(await resolveHostId({ K8S_NODE_NAME: 'srv-1' }, paths, 'pod-x')).toBe('k8s:srv-1');
    });

    it('two containers on one kernel get the same id from the boot id, never the raw value', async () => {
        await put('proc/sys/kernel/random/boot_id', '6f1c-boot\n');
        const a = await resolveHostId({}, paths, 'container-a');
        const b = await resolveHostId({}, paths, 'container-b');
        expect(a).toBe(b);
        expect(a).toMatch(/^boot:[0-9a-f]{16}$/);
        expect(a).not.toContain('6f1c');
    });

    it('falls back to machine-id, then the hostname', async () => {
        await put('etc/machine-id', 'abc\n');
        expect(await resolveHostId({}, paths, 'h')).toMatch(/^machine:[0-9a-f]{16}$/);
        await rm(paths.machineId);
        expect(await resolveHostId({}, paths, 'h')).toBe('name:h');
    });
});

describe('meminfoBytes', () => {
    it('reads kB lines as bytes', () => {
        const text = 'MemTotal:       16384 kB\nMemAvailable:    8192 kB\n';
        expect(meminfoBytes(text, 'MemTotal')).toBe(16384 * 1024);
        expect(meminfoBytes(text, 'MemAvailable')).toBe(8192 * 1024);
        expect(meminfoBytes(text, 'SwapTotal')).toBeUndefined();
    });
});

describe('HostMetricsSampler', () => {
    it('reports host memory, load, GPUs, disks, process and child RSS', async () => {
        await put('proc/sys/kernel/random/boot_id', 'boot-1');
        await put('proc/meminfo', 'MemTotal: 2048 kB\nMemAvailable: 512 kB\n');
        await put('proc/loadavg', '0.50 0.25 0.10 1/200 4242\n');
        await put('proc/self/task/1/children', '101 102');
        // Another thread's children file is not read (Node spawns from the main thread).
        await put('proc/self/task/2/children', '103');
        await put('proc/103/status', 'VmRSS: 999999 kB\n');
        await put('proc/101/status', 'Name: watcher\nVmRSS:   1000 kB\n');
        await put('proc/102/status', 'Name: ffmpeg\nVmRSS:   24 kB\n');
        await put('dev/dri/renderD128', '');
        await put('dev/dri/card0', '');
        await mkdir(join(root, 'sys/class/drm/renderD128/device'), { recursive: true });
        await symlink(
            '../../bus/pci/drivers/i915',
            join(root, 'sys/class/drm/renderD128/device/driver'),
        );
        await mkdir(join(root, 'cache'), { recursive: true });

        let cpu = { user: 0, system: 0 };
        let now = 0;
        const sampler = new HostMetricsSampler({
            implementation: 'node',
            disks: [
                { role: 'cache', path: join(root, 'cache') },
                { role: 'transcode', path: join(root, 'missing') },
            ],
            env: { LUMASTRA_HOST_NAME: 'nas' },
            paths,
            now: () => now,
            cpuUsage: () => cpu,
            rss: () => 4096,
            pid: 1,
        });

        const first = await sampler.sample();
        expect(first.implementation).toBe('node');
        expect(first.host).toMatchObject({
            name: 'nas',
            memTotalBytes: 2048 * 1024,
            memAvailableBytes: 512 * 1024,
            load1: 0.5,
            load5: 0.25,
            load15: 0.1,
            gpus: [{ kind: 'dri', device: 'renderD128', driver: 'i915' }],
        });
        expect(first.host.id).toMatch(/^boot:/);
        // The missing transcode dir is skipped, not reported as 0 bytes.
        expect(first.host.disks?.map((d) => d.role)).toEqual(['cache']);
        expect(first.process).toEqual({
            rssBytes: 4096,
            childCount: 2,
            childRssBytes: 1024 * 1024,
            childRssPeakBytes: 1024 * 1024,
        });

        // 500 ms of CPU over 1 s of wall time = 50 % of one core.
        cpu = { user: 400_000, system: 100_000 };
        now = 1000;
        const second = await sampler.sample();
        expect(second.process.cpuPercent).toBe(50);
    });

    it('publishes only the host id when /proc is absent (macOS dev)', async () => {
        const sampler = new HostMetricsSampler({ implementation: 'node', paths, env: {} });
        const snap = await sampler.sample();
        expect(snap.host.id).toMatch(/^name:/);
        expect(snap.host.memTotalBytes).toBeUndefined();
        expect(snap.process.childCount).toBeUndefined();
    });
});

describe('GPUs and timeouts', () => {
    it('lists NVIDIA device nodes (not nvidiactl) and caps the total at MAX_GPUS', async () => {
        for (let i = 128; i < 131; i++) await put(`dev/dri/renderD${i}`, '');
        for (const n of ['nvidia0', 'nvidia1', 'nvidiactl', 'nvidia-uvm'])
            await put(`dev/${n}`, '');
        const snap = await new HostMetricsSampler({
            implementation: 'node',
            paths,
            env: {},
        }).sample();
        expect(snap.host.gpus).toEqual([
            { kind: 'dri', device: 'renderD128' },
            { kind: 'dri', device: 'renderD129' },
            { kind: 'dri', device: 'renderD130' },
            { kind: 'nvidia', device: 'nvidia0' },
        ]);
        expect(snap.host.gpus).toHaveLength(MAX_GPUS);
    });

    it('a hanging sampler costs only the optional fields, never the beat', async () => {
        const hanging = { sample: () => new Promise<never>(() => undefined) };
        const started = Date.now();
        expect(await sampleHostMetricsSafe(hanging, 50)).toEqual({});
        expect(Date.now() - started).toBeLessThan(1000);
        const failing = { sample: () => Promise.reject(new Error('EIO')) };
        expect(await sampleHostMetricsSafe(failing, 50)).toEqual({});
    });

    it('skips relative disk paths instead of measuring the cwd', async () => {
        const snap = await new HostMetricsSampler({
            implementation: 'node',
            paths,
            env: {},
            disks: [{ role: 'cache', path: 'relative/cache' }],
        }).sample();
        expect(snap.host.disks).toBeUndefined();
    });
});

describe('parsers', () => {
    it('round-trips a sampler payload through JSON', () => {
        const host = {
            id: 'boot:0123456789abcdef',
            memTotalBytes: 10,
            memAvailableBytes: 5,
            cpuCount: 4,
            load1: 1,
            disks: [{ role: 'cache', path: '/config/cache', freeBytes: 1, totalBytes: 2 }],
        };
        expect(parseHostInfo(JSON.parse(JSON.stringify(host)))).toEqual(host);
        expect(parseProcessInfo({ rssBytes: 3, cpuPercent: 12.5 })).toEqual({
            rssBytes: 3,
            cpuPercent: 12.5,
        });
    });

    it('drops malformed parts instead of the whole node', () => {
        expect(parseHostInfo({ memTotalBytes: 1 })).toBeUndefined();
        expect(parseHostInfo('x')).toBeUndefined();
        const parsed = parseHostInfo({
            id: 'k8s:a',
            memTotalBytes: -1,
            load1: 'high',
            disks: [
                { role: 'secrets', freeBytes: 1, totalBytes: 1 },
                ...Array(10).fill({ role: 'data', freeBytes: 1, totalBytes: 2 }),
            ],
            gpus: [{ kind: 'dri' }],
        });
        expect(parsed).toEqual({
            id: 'k8s:a',
            disks: Array(MAX_DISKS - 1).fill({
                role: 'data',
                path: '',
                freeBytes: 1,
                totalBytes: 2,
            }),
        });
        expect(parseProcessInfo({ cpuPercent: 1 })).toBeUndefined();
        expect(parseImplementation('go')).toBeUndefined();
        expect(parseImplementation('rust')).toBe('rust');
    });
});

describe('host CPU and GPU figures (cluster view per host)', () => {
    it('parseProcStatCpu counts iowait as idle', () => {
        expect(parseProcStatCpu('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n')).toEqual({
            busy: 150,
            total: 1000,
        });
        expect(parseProcStatCpu(undefined)).toBeUndefined();
        expect(parseProcStatCpu('intr 1 2 3')).toBeUndefined();
    });

    it('publishes host-wide CPU percent from the second beat on', async () => {
        await put('proc/stat', 'cpu  100 0 0 900 0 0 0 0\n');
        const sampler = new HostMetricsSampler({ implementation: 'node', paths, env: {} });
        expect((await sampler.sample()).host.cpuPercent).toBeUndefined();
        await put('proc/stat', 'cpu  400 0 0 1600 0 0 0 0\n');
        // 300 busy of 1000 jiffies.
        expect((await sampler.sample()).host.cpuPercent).toBe(30);
    });

    it("merges live Intel figures into host.gpus and the children's engine use into process.gpu", async () => {
        await put('dev/dri/renderD128', '');
        await mkdir(join(root, 'sys/class/drm/renderD128/device/drm/card1'), { recursive: true });
        await mkdir(join(root, 'sys/bus/pci/drivers/i915'), { recursive: true });
        await symlink(
            join(root, 'sys/bus/pci/drivers/i915'),
            join(root, 'sys/class/drm/renderD128/device/driver'),
        );
        await put('sys/class/drm/card1/device/vendor', '0x8086');
        await put('sys/class/drm/card1/device/device', '0x56a5');
        await put('sys/class/drm/card1/gt/gt0/rps_act_freq_mhz', '1800');
        await put('proc/self/task/1/children', '42');
        await mkdir(join(root, 'proc/42/fd'), { recursive: true });
        await symlink('/dev/dri/renderD128', join(root, 'proc/42/fd/3'));
        await put(
            'proc/42/fdinfo/3',
            'drm-driver:\ti915\ndrm-client-id:\t5\ndrm-engine-video:\t0 ns\ndrm-engine-render:\t0 ns\n',
        );
        let now = 0;
        const sampler = new HostMetricsSampler({
            implementation: 'node',
            paths,
            env: {},
            pid: 1,
            now: () => now,
        });
        const first = await sampler.sample();
        expect(first.host.gpus?.[0]).toMatchObject({
            kind: 'dri',
            device: 'renderD128',
            driver: 'i915',
            name: 'Intel Arc A380',
            freqMhz: 1800,
        });
        expect(first.process.gpu).toEqual({ clients: 1 });
        now = 10_000;
        await put(
            'proc/42/fdinfo/3',
            'drm-driver:\ti915\ndrm-client-id:\t5\ndrm-engine-video:\t4000000000 ns\ndrm-engine-render:\t0 ns\n',
        );
        expect((await sampler.sample()).process.gpu).toEqual({
            clients: 1,
            engines: { render: 0, video: 40 },
        });
    });

    it('parses the new GPU fields and still accepts payloads from builds without them', () => {
        const host = parseHostInfo({
            id: 'boot:1',
            cpuPercent: 140,
            gpus: [
                {
                    kind: 'dri',
                    device: 'renderD128',
                    driver: 'i915',
                    busyPercent: 55,
                    name: 'Intel Arc A380',
                },
                {
                    kind: 'nvidia',
                    device: 'nvidia0',
                    encodeSessions: 2,
                    maxEncodeSessions: 8,
                    encoderPercent: 'x',
                    busyPercent: 40,
                },
            ],
        });
        expect(host?.cpuPercent).toBe(100);
        expect(host?.gpus).toEqual([
            {
                kind: 'dri',
                device: 'renderD128',
                driver: 'i915',
                // A 2026-10-22 build sent Intel RC6 awake time as busyPercent: never load.
                awakePercent: 55,
                name: 'Intel Arc A380',
            },
            {
                kind: 'nvidia',
                device: 'nvidia0',
                encodeSessions: 2,
                maxEncodeSessions: 8,
                busyPercent: 40,
            },
        ]);
        // An older build: exactly the old shape back.
        expect(
            parseHostInfo({ id: 'boot:1', gpus: [{ kind: 'dri', device: 'renderD128' }] }),
        ).toEqual({
            id: 'boot:1',
            gpus: [{ kind: 'dri', device: 'renderD128' }],
        });
        expect(
            parseProcessInfo({
                rssBytes: 1,
                gpu: { clients: 2, engines: { video: 30, bogus: 5, render: -1 } },
            }),
        ).toEqual({ rssBytes: 1, gpu: { clients: 2, engines: { video: 30 } } });
        expect(parseProcessInfo({ rssBytes: 1, gpu: { engines: {} } })).toEqual({ rssBytes: 1 });
    });
});

it('retains a child RSS peak for one minute after a decode exits, then expires it', async () => {
    let now = 0;
    const sampler = new HostMetricsSampler({
        implementation: 'node',
        paths,
        env: {},
        pid: 1,
        now: () => now,
    });
    await put('proc/self/task/1/children', '101');
    await put('proc/101/status', 'VmRSS: 1048576 kB');
    expect((await sampler.sample()).process.childRssPeakBytes).toBe(1024 ** 3);
    await put('proc/self/task/1/children', '');
    now = 10_000;
    const quiet = (await sampler.sample()).process;
    expect(quiet.childRssBytes ?? 0).toBe(0);
    expect(quiet.childRssPeakBytes).toBe(1024 ** 3);
    expect(parseProcessInfo(JSON.parse(JSON.stringify(quiet)))?.childRssPeakBytes).toBe(1024 ** 3);
    now = 60_001;
    expect((await sampler.sample()).process.childRssPeakBytes).toBe(0);
});
