// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GPU figures for the cluster heartbeat (src/shared/host-metrics.ts).
 *
 * Two sources, both read once per beat (every 10 s) and never per request:
 *
 * - Host-wide, per device: Intel from sysfs (RC6 residency → share of time the
 *   GPU was awake, actual/max frequency, package energy → watts), NVIDIA from one
 *   `nvidia-smi --query-gpu` call (utilisation, encoder/decoder, NVENC sessions).
 * - Per service: what this process's children (FFmpeg) use, from the kernel's DRM
 *   client stats in /proc/<pid>/fdinfo (Documentation/gpu/drm-usage-stats.rst):
 *   i915 reports busy nanoseconds per engine class, xe reports busy and total GPU
 *   cycles. The cluster view adds the services on one host together. This is the
 *   only spawn-free way to tell the video engine (encode/decode) from render/3D;
 *   RC6 alone reads 100 % as soon as any engine works at all.
 *
 * Lives in `src/shared/` because the TypeScript stream proxy is bundled with zero
 * `$lib` and zero npm imports. CRITICAL: node built-ins only. Fail-soft: an
 * unreadable file drops the field, never throws.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Engine classes the cluster view shows, in the order it shows them. */
export const GPU_ENGINE_CLASSES = ['render', 'video', 'videoEnhance', 'compute', 'copy'] as const;
export type GpuEngineClass = (typeof GPU_ENGINE_CLASSES)[number];
/** Percent of each engine class's capacity (an A380 has two video engines: 100 = both full). */
export type GpuEngineUsage = Partial<Record<GpuEngineClass, number>>;

/** Live figures for one GPU device; every field optional (driver- and vendor-dependent). */
export interface GpuDeviceStats {
    /** Marketing name when known, e.g. "Intel Arc A380", "NVIDIA GeForce RTX 3090". */
    name?: string;
    /** NVIDIA utilization.gpu: real load. Intel has no host-wide load figure (see engines). */
    busyPercent?: number;
    /**
     * Intel: share of the interval the GPU was out of RC6. NOT load: an idle GPU that
     * something keeps awake (a monitoring tool, another program, a stuck client) reads
     * 100 %. Load per engine is in ProcessGpu.engines.
     */
    awakePercent?: number;
    freqMhz?: number;
    freqMaxMhz?: number;
    powerWatts?: number;
    /** NVIDIA only (nvidia-smi). */
    encoderPercent?: number;
    decoderPercent?: number;
    /** NVENC sessions open on the device (all processes on the host). */
    encodeSessions?: number;
    /** Driver cap on NVENC sessions; 0 = no cap (data-centre cards). */
    maxEncodeSessions?: number;
    memUsedBytes?: number;
    memTotalBytes?: number;
    temperatureC?: number;
}

/** This service's children on the GPU. */
export interface ProcessGpu {
    /** Child processes that hold a GPU device open (FFmpeg transcodes on the GPU). */
    clients: number;
    /** Engine use of those children since the previous beat; absent on the first beat. */
    engines?: GpuEngineUsage;
}

export interface GpuPaths {
    proc: string;
    sys: string;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** PCI device IDs → marketing names for Intel GPUs (sysfs gives only the IDs). */
export const INTEL_GPU_NAMES: Record<string, string> = {
    '0x56a0': 'Arc A770',
    '0x56a1': 'Arc A750',
    '0x56a5': 'Arc A380',
    '0x56a6': 'Arc A310',
    '0x5690': 'Arc A770M',
    '0x5691': 'Arc A730M',
    '0x5692': 'Arc A550M',
    '0x5693': 'Arc A370M',
    '0x5694': 'Arc A350M',
    '0xe20b': 'Arc B580',
    '0xe20c': 'Arc B570',
    '0x9a49': 'Iris Xe Graphics (TGL)',
    '0x9a40': 'Iris Xe Graphics (TGL)',
    '0x4680': 'Iris Xe Graphics (ADL)',
    '0x4682': 'UHD Graphics (ADL)',
    '0x4688': 'UHD Graphics (ADL)',
    '0x46a6': 'Iris Xe Graphics (ADL)',
    '0xa780': 'Iris Xe Graphics (RPL)',
    '0xa781': 'UHD Graphics (RPL)',
    '0x3e92': 'UHD Graphics 630',
    '0x3e91': 'UHD Graphics 630',
    '0x5917': 'UHD Graphics 620',
    '0x5916': 'UHD Graphics 620',
    '0x591b': 'HD Graphics 630',
};

/**
 * Estimated NVENC concurrent-session cap. The GeForce cap is a DRIVER limit, not a
 * model one: 3 until release 530 (March 2023), 5 from 530, 8 from 550 (Linux 550.40 /
 * Windows 551.23, January 2024) on every NVENC-capable GeForce except the GTX 1630 (3).
 * Data-center/workstation cards are uncapped (0). An unknown driver is assumed
 * current: the bundled ffmpeg's NVENC needs a recent driver anyway.
 */
export function getMaxNvencSessions(
    gpuName: string,
    driverVersion?: string,
    envOverride: string | undefined = process.env.NVENC_MAX_SESSIONS,
): number {
    if (envOverride !== undefined) return Math.max(0, parseInt(envOverride, 10) || 0);

    if (
        /quadro|tesla|\brtx a\d|\brtx pro\b|\brtx \d{4} ada\b|\b(a10g?|a16|a30|a40|a100|h100|h200|l4|l40s?|t4)\b/i.test(
            gpuName,
        )
    )
        return 0;
    if (/gtx 1630/i.test(gpuName)) return 3;

    const driverMajor = driverVersion ? parseInt(driverVersion, 10) : NaN;
    if (isNaN(driverMajor) || driverMajor >= 550) return 8;
    if (driverMajor >= 530) return 5;
    return 3;
}

// ---------------------------------------------------------------------------
// Per-process engine use from DRM fdinfo
// ---------------------------------------------------------------------------

/** i915 engine names and xe engine classes → the classes above. */
const I915_ENGINES: Record<string, GpuEngineClass> = {
    render: 'render',
    video: 'video',
    'video-enhance': 'videoEnhance',
    compute: 'compute',
    copy: 'copy',
};
const XE_ENGINES: Record<string, GpuEngineClass> = {
    rcs: 'render',
    vcs: 'video',
    vecs: 'videoEnhance',
    ccs: 'compute',
    bcs: 'copy',
};

export interface DrmClientUsage {
    driver: string;
    clientId: string;
    /** i915: busy ns per class. */
    busyNs: Partial<Record<GpuEngineClass, number>>;
    /** xe: busy and total GPU cycles per class. */
    cycles: Partial<Record<GpuEngineClass, { busy: number; total: number }>>;
    capacity: Partial<Record<GpuEngineClass, number>>;
}

/** One /proc/<pid>/fdinfo/<fd> file; undefined when it is not a DRM client with engine stats. */
export function parseDrmFdinfo(text: string): DrmClientUsage | undefined {
    const fields = new Map<string, string>();
    for (const line of text.split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    const driver = fields.get('drm-driver');
    const clientId = fields.get('drm-client-id');
    if (!driver || !clientId) return undefined;
    const usage: DrmClientUsage = { driver, clientId, busyNs: {}, cycles: {}, capacity: {} };
    const int = (v: string | undefined): number | undefined => {
        const n = v === undefined ? NaN : Number(v.split(/\s+/)[0]);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    for (const [key, value] of fields) {
        let m = /^drm-engine-capacity-(.+)$/.exec(key);
        if (m) {
            const cls = I915_ENGINES[m[1]] ?? XE_ENGINES[m[1]];
            const n = int(value);
            if (cls && n !== undefined && n > 0) usage.capacity[cls] = n;
            continue;
        }
        m = /^drm-engine-(.+)$/.exec(key);
        if (m && value.endsWith('ns')) {
            const cls = I915_ENGINES[m[1]];
            const n = int(value);
            if (cls && n !== undefined) usage.busyNs[cls] = (usage.busyNs[cls] ?? 0) + n;
            continue;
        }
        m = /^drm-cycles-(.+)$/.exec(key);
        if (m) {
            const cls = XE_ENGINES[m[1]];
            const busy = int(value);
            const total = int(fields.get(`drm-total-cycles-${m[1]}`));
            if (cls && busy !== undefined && total !== undefined) {
                usage.cycles[cls] = { busy, total };
            }
        }
    }
    const hasStats = Object.keys(usage.busyNs).length > 0 || Object.keys(usage.cycles).length > 0;
    return hasStats ? usage : undefined;
}

/** At most this many DRM fds are inspected per child process. */
const MAX_FDS_PER_PROCESS = 256;

async function readDrmClients(paths: GpuPaths, pid: number): Promise<DrmClientUsage[]> {
    let fds: string[];
    try {
        fds = (await readdir(join(paths.proc, String(pid), 'fd'))).slice(0, MAX_FDS_PER_PROCESS);
    } catch {
        return [];
    }
    const out = new Map<string, DrmClientUsage>();
    for (const fd of fds) {
        let target: string;
        try {
            target = await readlink(join(paths.proc, String(pid), 'fd', fd));
        } catch {
            continue;
        }
        if (!target.startsWith('/dev/dri/')) continue;
        let text: string;
        try {
            text = await readFile(join(paths.proc, String(pid), 'fdinfo', fd), 'utf8');
        } catch {
            continue;
        }
        const usage = parseDrmFdinfo(text);
        // Several fds can share one client (dup, a second VA display on the same file).
        if (usage) out.set(`${usage.driver}:${usage.clientId}`, usage);
    }
    return [...out.values()];
}

interface ClientSample {
    busyNs: Partial<Record<GpuEngineClass, number>>;
    cycles: Partial<Record<GpuEngineClass, { busy: number; total: number }>>;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Engine use of this process's children between two beats. A client seen for the
 * first time (a transcode started during the interval) counts with its whole i915
 * busy time, capped at the interval; xe clients need two samples (cycles have no
 * time base of their own).
 */
export class DrmEngineSampler {
    private prev: { atMs: number; clients: Map<string, ClientSample> } | null = null;

    constructor(
        private readonly paths: GpuPaths,
        private readonly now: () => number = () => performance.now(),
    ) {}

    async sample(childPids: number[]): Promise<ProcessGpu | undefined> {
        const perPid = await Promise.all(childPids.map((pid) => readDrmClients(this.paths, pid)));
        const atMs = this.now();
        const clients = new Map<string, ClientSample>();
        const capacity: Partial<Record<GpuEngineClass, number>> = {};
        let processes = 0;
        perPid.forEach((list, i) => {
            if (list.length > 0) processes++;
            for (const c of list) {
                clients.set(`${childPids[i]}:${c.driver}:${c.clientId}`, {
                    busyNs: c.busyNs,
                    cycles: c.cycles,
                });
                for (const [cls, n] of Object.entries(c.capacity) as [GpuEngineClass, number][]) {
                    capacity[cls] = Math.max(capacity[cls] ?? 1, n);
                }
            }
        });

        const prev = this.prev;
        this.prev = { atMs, clients };
        if (processes === 0) return undefined;
        if (!prev || atMs <= prev.atMs) return { clients: processes };

        const elapsedNs = (atMs - prev.atMs) * 1e6;
        const busy: Partial<Record<GpuEngineClass, number>> = {};
        const add = (cls: GpuEngineClass, share: number): void => {
            busy[cls] = (busy[cls] ?? 0) + share;
        };
        for (const [key, cur] of clients) {
            const before = prev.clients.get(key);
            for (const [cls, ns] of Object.entries(cur.busyNs) as [GpuEngineClass, number][]) {
                const delta = ns - (before?.busyNs[cls] ?? 0);
                // A known client can keep several engines of a class busy (capacity ×
                // interval); one first seen now started within the interval, so at most
                // the interval counts (same rule as the Rust proxy).
                const cap = before ? (capacity[cls] ?? 1) * elapsedNs : elapsedNs;
                add(cls, delta > 0 ? Math.min(delta, cap) / elapsedNs : 0);
            }
            for (const [cls, cyc] of Object.entries(cur.cycles) as [
                GpuEngineClass,
                { busy: number; total: number },
            ][]) {
                const b = before?.cycles[cls];
                if (!b) {
                    add(cls, 0);
                    continue;
                }
                const total = cyc.total - b.total;
                const used = cyc.busy - b.busy;
                add(cls, total > 0 && used >= 0 ? used / total : 0);
            }
        }
        const engines: GpuEngineUsage = {};
        for (const cls of GPU_ENGINE_CLASSES) {
            const v = busy[cls];
            if (v === undefined) continue;
            engines[cls] = Math.min(100, Math.max(0, round1((v / (capacity[cls] ?? 1)) * 100)));
        }
        return { clients: processes, engines };
    }
}

// ---------------------------------------------------------------------------
// Host-wide device figures
// ---------------------------------------------------------------------------

async function readText(path: string): Promise<string | undefined> {
    try {
        return (await readFile(path, 'utf8')).trim();
    } catch {
        return undefined;
    }
}

async function readNumber(path: string): Promise<number | undefined> {
    const text = await readText(path);
    const n = text === undefined ? NaN : Number(text);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The DRM card behind a render node. Not `card0` by assumption: a VM or a board
 * with its own display controller has the GPU at card1 (prod's media node:
 * card0 = bochs-drm, card1 = the Arc).
 */
async function cardForRenderNode(paths: GpuPaths, device: string): Promise<string | undefined> {
    try {
        const entries = await readdir(join(paths.sys, 'class/drm', device, 'device/drm'));
        const card = entries.find((e) => /^card\d+$/.test(e));
        return card ? join(paths.sys, 'class/drm', card) : undefined;
    } catch {
        return undefined;
    }
}

interface IntelCounters {
    idleMs?: number;
    energyUj?: number;
}

async function readHwmonEnergy(cardPath: string): Promise<number | undefined> {
    try {
        const hwmons = await readdir(join(cardPath, 'device/hwmon'));
        for (const h of hwmons.sort()) {
            const e = await readNumber(join(cardPath, 'device/hwmon', h, 'energy1_input'));
            if (e !== undefined) return e;
        }
    } catch {
        // No hwmon (integrated GPUs).
    }
    return undefined;
}

/** i915: gt/gt0/rc6_*; xe: device/tile0/gt0/{gtidle,freq0}. Missing files drop fields. */
async function readIntelDevice(
    cardPath: string,
    driver: string | undefined,
): Promise<{ stats: GpuDeviceStats; counters: IntelCounters }> {
    const stats: GpuDeviceStats = {};
    const counters: IntelCounters = {};
    const deviceId = await readText(join(cardPath, 'device/device'));
    const model = deviceId ? INTEL_GPU_NAMES[deviceId] : undefined;
    stats.name = model ? `Intel ${model}` : `Intel GPU${deviceId ? ` (${deviceId})` : ''}`;
    if (driver === 'xe') {
        const gt = join(cardPath, 'device/tile0/gt0');
        counters.idleMs = await readNumber(join(gt, 'gtidle/idle_residency_ms'));
        stats.freqMhz = await readNumber(join(gt, 'freq0/act_freq'));
        stats.freqMaxMhz = await readNumber(join(gt, 'freq0/rp0_freq'));
    } else {
        const gt = join(cardPath, 'gt/gt0');
        counters.idleMs =
            (await readNumber(join(gt, 'rc6_residency_ms'))) ??
            (await readNumber(join(cardPath, 'power/rc6_residency_ms')));
        stats.freqMhz =
            (await readNumber(join(gt, 'rps_act_freq_mhz'))) ??
            (await readNumber(join(cardPath, 'gt_act_freq_mhz')));
        stats.freqMaxMhz =
            (await readNumber(join(gt, 'rps_RP0_freq_mhz'))) ??
            (await readNumber(join(cardPath, 'gt_RP0_freq_mhz')));
    }
    counters.energyUj = await readHwmonEnergy(cardPath);
    return { stats, counters };
}

/** One `nvidia-smi --query-gpu` row per GPU, in index order. */
export const NVIDIA_SMI_FIELDS = [
    'index',
    'name',
    'driver_version',
    'memory.total',
    'memory.used',
    'utilization.gpu',
    'utilization.encoder',
    'utilization.decoder',
    'encoder.stats.sessionCount',
    'temperature.gpu',
    'power.draw',
] as const;

export function parseNvidiaSmiCsv(csv: string, envOverride?: string): Map<number, GpuDeviceStats> {
    const out = new Map<number, GpuDeviceStats>();
    for (const line of csv.split('\n')) {
        const v = line.split(',').map((s) => s.trim());
        if (v.length < NVIDIA_SMI_FIELDS.length) continue;
        const num = (s: string): number | undefined => {
            const n = parseFloat(s);
            return Number.isFinite(n) && n >= 0 ? n : undefined;
        };
        const index = num(v[0]);
        if (index === undefined) continue;
        const memTotal = num(v[3]);
        const memUsed = num(v[4]);
        const stats: GpuDeviceStats = {
            name: v[1] || undefined,
            memTotalBytes: memTotal !== undefined ? memTotal * 1024 * 1024 : undefined,
            memUsedBytes: memUsed !== undefined ? memUsed * 1024 * 1024 : undefined,
            busyPercent: num(v[5]),
            encoderPercent: num(v[6]),
            decoderPercent: num(v[7]),
            encodeSessions: num(v[8]),
            temperatureC: num(v[9]),
            powerWatts: num(v[10]),
            maxEncodeSessions: getMaxNvencSessions(v[1] ?? '', v[2] || undefined, envOverride),
        };
        for (const k of Object.keys(stats) as (keyof GpuDeviceStats)[]) {
            if (stats[k] === undefined) delete stats[k];
        }
        out.set(index, stats);
    }
    return out;
}

/** Runs nvidia-smi once; resolves '' on any failure (absent binary, timeout). */
export function runNvidiaSmi(timeoutMs = 3_000): Promise<string> {
    return new Promise((resolve) => {
        try {
            execFile(
                'nvidia-smi',
                [`--query-gpu=${NVIDIA_SMI_FIELDS.join(',')}`, '--format=csv,noheader,nounits'],
                { timeout: timeoutMs, encoding: 'utf8' },
                (err, stdout) => resolve(err ? '' : stdout),
            );
        } catch {
            resolve('');
        }
    });
}

export interface GpuDeviceRef {
    kind: 'dri' | 'nvidia';
    device: string;
    driver?: string;
}

export interface HostGpuSamplerOptions {
    paths: GpuPaths;
    now?: () => number;
    /** Query NVIDIA devices; omit to never spawn nvidia-smi. */
    nvidiaSmi?: () => Promise<string>;
    nvencMaxSessionsEnv?: string;
}

/**
 * Live figures for the host's GPUs, keyed by device node. Keeps the previous Intel
 * counters so RC6 and energy become rates over the beat interval. One nvidia-smi
 * call per beat at most, and none while the previous one is still running.
 */
export class HostGpuSampler {
    private prev = new Map<string, { atMs: number; counters: IntelCounters }>();
    private nvidiaInFlight: Promise<string> | null = null;
    private nvidiaLast = new Map<number, GpuDeviceStats>();
    private readonly now: () => number;

    constructor(private readonly options: HostGpuSamplerOptions) {
        this.now = options.now ?? (() => performance.now());
    }

    async sample(devices: GpuDeviceRef[]): Promise<Map<string, GpuDeviceStats>> {
        const out = new Map<string, GpuDeviceStats>();
        const intel = devices.filter(
            (d) => d.kind === 'dri' && (d.driver === 'i915' || d.driver === 'xe'),
        );
        await Promise.all(
            intel.map(async (d) => {
                const card = await cardForRenderNode(this.options.paths, d.device);
                if (!card) return;
                const vendor = await readText(join(card, 'device/vendor'));
                if (vendor !== '0x8086') return;
                // Reading hwmon/gt counters can resume a runtime-suspended discrete GPU;
                // a sleeping GPU is idle, so publish just that and let it sleep.
                if ((await readText(join(card, 'device/power/runtime_status'))) === 'suspended') {
                    this.prev.delete(d.device);
                    out.set(d.device, { awakePercent: 0 });
                    return;
                }
                const { stats, counters } = await readIntelDevice(card, d.driver);
                const atMs = this.now();
                const before = this.prev.get(d.device);
                this.prev.set(d.device, { atMs, counters });
                const dtMs = before ? atMs - before.atMs : 0;
                if (before && dtMs > 0) {
                    if (counters.idleMs !== undefined && before.counters.idleMs !== undefined) {
                        const idle = counters.idleMs - before.counters.idleMs;
                        if (idle >= 0) {
                            stats.awakePercent = round1(
                                Math.min(100, Math.max(0, 100 - (idle / dtMs) * 100)),
                            );
                        }
                    }
                    if (
                        counters.energyUj !== undefined &&
                        before.counters.energyUj !== undefined &&
                        counters.energyUj >= before.counters.energyUj
                    ) {
                        stats.powerWatts = round1(
                            (counters.energyUj - before.counters.energyUj) / 1000 / dtMs,
                        );
                    }
                }
                out.set(d.device, stats);
            }),
        );

        const nvidia = devices.filter((d) => d.kind === 'nvidia');
        if (nvidia.length > 0 && this.options.nvidiaSmi) {
            // Never awaited: a cold nvidia-smi can take longer than the whole sample
            // budget (SAMPLE_TIMEOUT_MS). Each beat publishes the last finished query
            // and starts the next one, so NVIDIA figures lag by at most one beat.
            if (!this.nvidiaInFlight) {
                const run = this.options.nvidiaSmi();
                this.nvidiaInFlight = run;
                void run.then(
                    (csv) => {
                        // A failed run clears the figures: republishing the last good
                        // answer would show e.g. a full NVENC cap as live forever.
                        this.nvidiaLast = csv
                            ? parseNvidiaSmiCsv(csv, this.options.nvencMaxSessionsEnv)
                            : new Map();
                        this.nvidiaInFlight = null;
                    },
                    () => {
                        this.nvidiaLast = new Map();
                        this.nvidiaInFlight = null;
                    },
                );
            }
            for (const d of nvidia) {
                const index = Number(/\d+$/.exec(d.device)?.[0]);
                const stats = this.nvidiaLast.get(index);
                if (stats) out.set(d.device, stats);
            }
        }
        return out;
    }
}
