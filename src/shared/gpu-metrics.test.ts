// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DrmEngineSampler,
    HostGpuSampler,
    getMaxNvencSessions,
    parseDrmFdinfo,
    parseNvidiaSmiCsv,
    type GpuPaths,
} from './gpu-metrics.js';

let root: string;
let paths: GpuPaths;

async function put(rel: string, content: string): Promise<void> {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
}

async function link(rel: string, target: string): Promise<void> {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await symlink(target, full);
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gpu-metrics-'));
    paths = { proc: join(root, 'proc'), sys: join(root, 'sys') };
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/** fdinfo of an h264_qsv FFmpeg on prod's Arc A380 (i915), trimmed. */
function i915Fdinfo(clientId: number, videoNs: number, renderNs = 0): string {
    return [
        'pos:\t0',
        'flags:\t0100002',
        'drm-driver:\ti915',
        `drm-client-id:\t${clientId}`,
        'drm-pdev:\t0000:01:00.0',
        'drm-total-local0:\t106336 KiB',
        `drm-engine-render:\t${renderNs} ns`,
        'drm-engine-copy:\t0 ns',
        `drm-engine-video:\t${videoNs} ns`,
        'drm-engine-capacity-video:\t2',
        'drm-engine-video-enhance:\t0 ns',
        'drm-engine-capacity-video-enhance:\t2',
        'drm-engine-compute:\t0 ns',
        '',
    ].join('\n');
}

async function child(pid: number, fds: Record<string, { target: string; info?: string }>) {
    for (const [fd, { target, info }] of Object.entries(fds)) {
        await link(`proc/${pid}/fd/${fd}`, target);
        if (info !== undefined) await put(`proc/${pid}/fdinfo/${fd}`, info);
    }
}

describe('parseDrmFdinfo', () => {
    it('reads i915 busy nanoseconds per engine class and the engine capacity', () => {
        const u = parseDrmFdinfo(i915Fdinfo(255645, 191930180, 5));
        expect(u).toMatchObject({
            driver: 'i915',
            clientId: '255645',
            busyNs: { render: 5, video: 191930180, videoEnhance: 0, compute: 0, copy: 0 },
            capacity: { video: 2, videoEnhance: 2 },
        });
    });

    it('reads xe busy and total cycles', () => {
        const u = parseDrmFdinfo(
            'drm-driver:\txe\ndrm-client-id:\t9\ndrm-cycles-vcs:\t500\ndrm-total-cycles-vcs:\t1000\ndrm-engine-capacity-vcs:\t2\n',
        );
        expect(u?.cycles).toEqual({ video: { busy: 500, total: 1000 } });
        expect(u?.capacity).toEqual({ video: 2 });
    });

    it('is undefined for a non-DRM fd or a DRM fd without engine stats', () => {
        expect(parseDrmFdinfo('pos:\t0\nflags:\t02\n')).toBeUndefined();
        expect(parseDrmFdinfo('drm-driver:\tamdgpu\ndrm-client-id:\t3\n')).toBeUndefined();
    });
});

describe('DrmEngineSampler', () => {
    it('turns busy time between two beats into percent of the engine capacity', async () => {
        let now = 0;
        const sampler = new DrmEngineSampler(paths, () => now);
        await child(100, {
            '3': { target: '/dev/dri/renderD128', info: i915Fdinfo(1, 0) },
            // Not a GPU fd: never read.
            '4': { target: '/dev/null' },
        });
        expect(await sampler.sample([100])).toEqual({ clients: 1 });

        // 10 s later the client kept one of two video engines fully busy.
        now = 10_000;
        await put('proc/100/fdinfo/3', i915Fdinfo(1, 10_000_000_000, 2_500_000_000));
        expect(await sampler.sample([100])).toEqual({
            clients: 1,
            engines: { render: 25, video: 50, videoEnhance: 0, compute: 0, copy: 0 },
        });
    });

    it('counts a client that shares one drm-client-id over two fds once', async () => {
        let now = 0;
        const sampler = new DrmEngineSampler(paths, () => now);
        const info0 = i915Fdinfo(7, 0);
        await child(100, {
            '3': { target: '/dev/dri/renderD128', info: info0 },
            '5': { target: '/dev/dri/renderD128', info: info0 },
        });
        await sampler.sample([100]);
        now = 1_000;
        const info1 = i915Fdinfo(7, 1_000_000_000);
        await put('proc/100/fdinfo/3', info1);
        await put('proc/100/fdinfo/5', info1);
        expect((await sampler.sample([100]))?.engines?.video).toBe(50);
    });

    it('adds clients of several children and caps a new client at the interval', async () => {
        let now = 0;
        const sampler = new DrmEngineSampler(paths, () => now);
        await child(100, { '3': { target: '/dev/dri/renderD128', info: i915Fdinfo(1, 0) } });
        await sampler.sample([100]);
        now = 1_000;
        await put('proc/100/fdinfo/3', i915Fdinfo(1, 500_000_000));
        // First seen now with a large counter: it started within the interval, so at most
        // 1 s of one engine counts (50 % of two), plus the first client's 25 %.
        await child(200, {
            '3': { target: '/dev/dri/renderD128', info: i915Fdinfo(2, 900_000_000_000) },
        });
        const out = await sampler.sample([100, 200]);
        expect(out?.clients).toBe(2);
        expect(out?.engines?.video).toBe(75);
    });

    it('needs two samples for an xe client', async () => {
        let now = 0;
        const sampler = new DrmEngineSampler(paths, () => now);
        const xe = (busy: number, total: number): string =>
            `drm-driver:\txe\ndrm-client-id:\t9\ndrm-cycles-vcs:\t${busy}\ndrm-total-cycles-vcs:\t${total}\n`;
        await child(100, { '3': { target: '/dev/dri/renderD128', info: xe(0, 0) } });
        await sampler.sample([100]);
        now = 10_000;
        await put('proc/100/fdinfo/3', xe(300, 1_000));
        expect((await sampler.sample([100]))?.engines?.video).toBe(30);
    });

    it('is undefined when no child holds a GPU device', async () => {
        const sampler = new DrmEngineSampler(paths, () => 0);
        await child(100, { '1': { target: 'pipe:[123]' } });
        expect(await sampler.sample([100])).toBeUndefined();
        expect(await sampler.sample([])).toBeUndefined();
    });
});

describe('HostGpuSampler — Intel sysfs', () => {
    /** prod's media node: card0 is the VM display (bochs-drm), the Arc is card1. */
    async function arcOnCard1(rc6Ms: number, energyUj: number): Promise<void> {
        await put('sys/class/drm/renderD128/device/drm/card1/dev', '226:1');
        await put('sys/class/drm/renderD128/device/drm/renderD128/dev', '226:128');
        await put('sys/class/drm/card0/device/vendor', '0x1234');
        await put('sys/class/drm/card1/device/vendor', '0x8086');
        await put('sys/class/drm/card1/device/device', '0x56a5');
        await put('sys/class/drm/card1/gt/gt0/rc6_residency_ms', String(rc6Ms));
        await put('sys/class/drm/card1/gt/gt0/rps_act_freq_mhz', '2400');
        await put('sys/class/drm/card1/gt/gt0/rps_RP0_freq_mhz', '2450');
        await put('sys/class/drm/card1/device/hwmon/hwmon3/energy1_input', String(energyUj));
    }

    it('reads the card behind the render node, not card0, and rates RC6 and energy per beat', async () => {
        let now = 0;
        const sampler = new HostGpuSampler({ paths, now: () => now });
        const devices = [{ kind: 'dri' as const, device: 'renderD128', driver: 'i915' }];
        await arcOnCard1(1_000, 0);
        const first = await sampler.sample(devices);
        expect(first.get('renderD128')).toEqual({
            name: 'Intel Arc A380',
            freqMhz: 2400,
            freqMaxMhz: 2450,
        });

        now = 10_000;
        // 4 s of 10 in RC6 → awake 60 %; 246 J in 10 s → 24.6 W.
        await arcOnCard1(5_000, 246_000_000);
        expect((await sampler.sample(devices)).get('renderD128')).toMatchObject({
            awakePercent: 60,
            powerWatts: 24.6,
        });
    });

    it('reads 100 % awake when RC6 never advances (the GPU never idles)', async () => {
        let now = 0;
        const sampler = new HostGpuSampler({ paths, now: () => now });
        const devices = [{ kind: 'dri' as const, device: 'renderD128', driver: 'i915' }];
        await arcOnCard1(4_417_404, 0);
        await sampler.sample(devices);
        now = 10_000;
        expect((await sampler.sample(devices)).get('renderD128')?.awakePercent).toBe(100);
    });

    it('does not read the counters of a runtime-suspended GPU (that would wake it)', async () => {
        const sampler = new HostGpuSampler({ paths });
        await arcOnCard1(1_000, 5);
        await put('sys/class/drm/card1/device/power/runtime_status', 'suspended');
        const out = await sampler.sample([{ kind: 'dri', device: 'renderD128', driver: 'i915' }]);
        expect(out.get('renderD128')).toEqual({ awakePercent: 0 });
    });

    it('skips a non-Intel render node', async () => {
        await put('sys/class/drm/renderD128/device/drm/card0/dev', '226:0');
        await put('sys/class/drm/card0/device/vendor', '0x1002');
        const sampler = new HostGpuSampler({ paths });
        const out = await sampler.sample([{ kind: 'dri', device: 'renderD128', driver: 'i915' }]);
        expect(out.size).toBe(0);
    });
});

describe('HostGpuSampler — NVIDIA', () => {
    const CSV = '0, NVIDIA GeForce RTX 3090, 560.35.03, 24576, 1024, 35, 22, 10, 2, 54, 120.5\n';

    it('never waits for nvidia-smi: a beat publishes the last finished query', async () => {
        let calls = 0;
        let release: (csv: string) => void = () => undefined;
        const sampler = new HostGpuSampler({
            paths,
            nvidiaSmi: () => {
                calls++;
                return new Promise<string>((resolve) => {
                    release = resolve;
                });
            },
        });
        const devices = [{ kind: 'nvidia' as const, device: 'nvidia0' }];
        expect((await sampler.sample(devices)).size).toBe(0);
        // Still running: no second spawn.
        await sampler.sample(devices);
        expect(calls).toBe(1);
        release(CSV);
        await new Promise((r) => setTimeout(r, 0));
        expect((await sampler.sample(devices)).get('nvidia0')).toMatchObject({
            name: 'NVIDIA GeForce RTX 3090',
            busyPercent: 35,
            encoderPercent: 22,
            encodeSessions: 2,
            maxEncodeSessions: 8,
        });
        expect(calls).toBe(2);
    });

    it('drops the NVIDIA figures after a failed run instead of republishing stale ones', async () => {
        const answers = [CSV, ''];
        const sampler = new HostGpuSampler({ paths, nvidiaSmi: async () => answers.shift() ?? '' });
        const devices = [{ kind: 'nvidia' as const, device: 'nvidia0' }];
        await sampler.sample(devices);
        await new Promise((r) => setTimeout(r, 0));
        expect((await sampler.sample(devices)).has('nvidia0')).toBe(true);
        await new Promise((r) => setTimeout(r, 0));
        expect((await sampler.sample(devices)).has('nvidia0')).toBe(false);
    });

    it('parses one row per GPU and converts MiB to bytes', () => {
        const rows = parseNvidiaSmiCsv(CSV, undefined);
        expect(rows.get(0)).toMatchObject({
            memTotalBytes: 24576 * 1024 * 1024,
            memUsedBytes: 1024 * 1024 * 1024,
            decoderPercent: 10,
            temperatureC: 54,
            powerWatts: 120.5,
        });
        expect(parseNvidiaSmiCsv('garbage', undefined).size).toBe(0);
    });

    it('getMaxNvencSessions honours the env override and driver generations', () => {
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '535.1', undefined)).toBe(5);
        expect(getMaxNvencSessions('Tesla T4', '550', undefined)).toBe(0);
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '550', '12')).toBe(12);
    });
});
