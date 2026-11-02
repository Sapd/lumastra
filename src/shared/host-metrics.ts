// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Host and process metrics for the cluster heartbeat.
 *
 * Every service (web, worker; the Rust proxy and the
 * sonic sidecar publish the same JSON shape from their own code) reports which
 * machine it runs on and how that machine is doing, so Admin → System health →
 * Cluster can group services by host and show host memory once per machine
 * instead of once per service.
 *
 * Shared by the app and worker. Node built-ins only.
 *
 * Host identity: `/proc/meminfo`, `/proc/loadavg` and the kernel boot id are NOT
 * namespaced, so every container on one kernel reads the same values — exactly
 * the "same machine" test we need, without a host mount. Order:
 *   1. `boot:<hash>` — sha256 of /proc/sys/kernel/random/boot_id (changes on reboot,
 *      which is harmless: a reboot restarts every service anyway). First, because it
 *      needs no configuration: a pod without the Downward API env still groups with
 *      its neighbours on the same node.
 *   2. `k8s:<node>` — K8S_NODE_NAME, where the boot id is unreadable.
 *   3. `machine:<hash>` — /etc/machine-id.
 *   4. `name:<hostname>` (macOS dev).
 * The boot id and machine id are hashed so the raw values never leave the machine;
 * the Kubernetes node name and LUMASTRA_HOST_NAME are published as they are (the
 * node name doubles as the card's label).
 *
 * Display only, fail-soft: a missing file drops the field, never throws. Bounded:
 * at most MAX_DISKS disks, MAX_GPUS GPUs and MAX_CHILDREN child processes are read
 * per beat (every 10 s).
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, readlink, statfs } from 'node:fs/promises';
import os from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import {
    DrmEngineSampler,
    GPU_ENGINE_CLASSES,
    HostGpuSampler,
    type GpuDeviceStats,
    type GpuEngineUsage,
    type ProcessGpu,
} from './gpu-metrics.js';

export type { GpuDeviceStats, GpuEngineUsage, ProcessGpu } from './gpu-metrics.js';

export type ServiceImplementation = 'node' | 'rust' | 'python';
export type HostDiskRole = 'cache' | 'transcode' | 'data';

export interface HostDisk {
    role: HostDiskRole;
    path: string;
    freeBytes: number;
    totalBytes: number;
}

export interface HostGpu extends GpuDeviceStats {
    kind: 'dri' | 'nvidia';
    /** Device node basename, e.g. `renderD128`, `nvidia0`. */
    device: string;
    /** Kernel driver for DRI devices (`i915`, `xe`, `amdgpu`), when readable. */
    driver?: string;
}

/** The machine a service runs on. Host-wide values: identical for every service on it. */
export interface HostInfo {
    /** Grouping key, see the module comment. Never empty. */
    id: string;
    /** Human name: the Kubernetes node, or LUMASTRA_HOST_NAME. */
    name?: string;
    memTotalBytes?: number;
    memAvailableBytes?: number;
    cpuCount?: number;
    /** Host-wide CPU busy since the previous beat, percent of ALL CPUs (/proc/stat). */
    cpuPercent?: number;
    load1?: number;
    load5?: number;
    load15?: number;
    disks?: HostDisk[];
    gpus?: HostGpu[];
}

/** This service's own process. */
export interface ProcessInfo {
    rssBytes: number;
    /** CPU since the previous sample, percent of ONE core (200 = two cores busy). Absent on the first beat. */
    cpuPercent?: number;
    /** Sum of RSS of direct child processes (the worker's Rust watcher, FFmpeg). */
    childRssBytes?: number;
    /** Largest sampled child RSS in the last minute; keeps decode bursts visible. */
    childRssPeakBytes?: number;
    childCount?: number;
    /** GPU use of the child processes (FFmpeg); absent when no child holds a GPU device. */
    gpu?: ProcessGpu;
}

export const MAX_DISKS = 4;
export const MAX_GPUS = 4;
export const MAX_CHILDREN = 64;

type Env = Record<string, string | undefined>;

export interface HostMetricsPaths {
    proc: string;
    sys: string;
    dev: string;
    machineId: string;
}

const DEFAULT_PATHS: HostMetricsPaths = {
    proc: '/proc',
    sys: '/sys',
    dev: '/dev',
    machineId: '/etc/machine-id',
};

async function readText(path: string): Promise<string | undefined> {
    try {
        return (await readFile(path, 'utf8')).trim();
    } catch {
        return undefined;
    }
}

function nonEmpty(value: string | undefined): string | undefined {
    const v = value?.trim();
    return v ? v : undefined;
}

function shortHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** `Key:   123 kB` lines → bytes. */
export function meminfoBytes(text: string | undefined, key: string): number | undefined {
    if (!text) return undefined;
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
}

export async function resolveHostId(
    env: Env = process.env,
    paths: HostMetricsPaths = DEFAULT_PATHS,
    hostname: string = os.hostname(),
): Promise<string> {
    const bootId = await readText(join(paths.proc, 'sys/kernel/random/boot_id'));
    if (bootId) return `boot:${shortHash(bootId)}`;
    const node = nonEmpty(env.K8S_NODE_NAME);
    if (node) return `k8s:${node}`;
    const machineId = await readText(paths.machineId);
    if (machineId) return `machine:${shortHash(machineId)}`;
    return `name:${hostname}`;
}

async function readDisks(dirs: { role: HostDiskRole; path: string }[]): Promise<HostDisk[]> {
    const out: HostDisk[] = [];
    for (const { role, path } of dirs.slice(0, MAX_DISKS)) {
        // A relative path would be measured against the cwd, not the volume meant.
        if (!isAbsolute(path)) continue;
        try {
            const s = await statfs(path);
            out.push({
                role,
                path,
                freeBytes: Number(s.bavail) * Number(s.bsize),
                totalBytes: Number(s.blocks) * Number(s.bsize),
            });
        } catch {
            // Directory not created yet / not mounted: skip.
        }
    }
    return out;
}

async function readGpus(paths: HostMetricsPaths): Promise<HostGpu[]> {
    const gpus: HostGpu[] = [];
    try {
        const entries = (await readdir(join(paths.dev, 'dri'))).filter((e) =>
            e.startsWith('renderD'),
        );
        for (const device of entries.sort().slice(0, MAX_GPUS)) {
            let driver: string | undefined;
            try {
                driver = basename(
                    await readlink(join(paths.sys, 'class/drm', device, 'device/driver')),
                );
            } catch {
                driver = undefined;
            }
            gpus.push({ kind: 'dri', device, ...(driver ? { driver } : {}) });
        }
    } catch {
        // No /dev/dri.
    }
    try {
        const nv = (await readdir(paths.dev)).filter((e) => /^nvidia\d+$/.test(e)).sort();
        for (const device of nv.slice(0, MAX_GPUS - gpus.length)) {
            gpus.push({ kind: 'nvidia', device });
        }
    } catch {
        // Unreadable /dev.
    }
    return gpus;
}

/**
 * Direct children of this process, from /proc/self/task/<pid>/children: Node
 * spawns children from the main (event-loop) thread, whose tid is the pid, so one
 * file covers them without walking every libuv/worker thread. Absent on kernels
 * without CONFIG_PROC_CHILDREN, in which case no child figures are published.
 */
async function readChildren(paths: HostMetricsPaths, pid: number): Promise<number[]> {
    const text = await readText(join(paths.proc, 'self/task', String(pid), 'children'));
    const pids: number[] = [];
    for (const part of text?.split(/\s+/) ?? []) {
        const n = Number(part);
        if (Number.isInteger(n) && n > 0) pids.push(n);
        if (pids.length >= MAX_CHILDREN) break;
    }
    return pids;
}

export interface HostMetricsOptions {
    implementation: ServiceImplementation;
    /** Volumes worth watching for this service (cache, transcode dir). */
    disks?: { role: HostDiskRole; path: string }[];
    env?: Env;
    paths?: HostMetricsPaths;
    now?: () => number;
    cpuUsage?: () => ReturnType<typeof process.cpuUsage>;
    rss?: () => number;
    pid?: number;
    /**
     * Query NVIDIA GPUs with nvidia-smi (at most one run per beat, never awaited by
     * the beat). Off unless the service encodes on NVIDIA; Intel figures need no spawn.
     */
    nvidiaSmi?: () => Promise<string>;
    nvencMaxSessionsEnv?: string;
}

export interface HostProcessSnapshot {
    implementation: ServiceImplementation;
    host: HostInfo;
    process: ProcessInfo;
}

/** `cpu  user nice system idle iowait irq softirq steal …` → busy and total jiffies. */
export function parseProcStatCpu(
    text: string | undefined,
): { busy: number; total: number } | undefined {
    const line = text?.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return undefined;
    const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
    if (v.length < 4 || !v.every(Number.isFinite)) return undefined;
    const total = v.reduce((a, b) => a + b, 0);
    const idle = v[3] + (v[4] ?? 0);
    return { busy: total - idle, total };
}

/**
 * Samples host + process metrics once per heartbeat. Keeps the previous CPU
 * counter so `cpuPercent` covers the last interval, not the process lifetime.
 */
export class HostMetricsSampler {
    private childRssSamples: { atMs: number; rss: number }[] = [];
    private hostId: Promise<string> | null = null;
    private prevCpu: { usage: ReturnType<typeof process.cpuUsage>; atMs: number } | null = null;
    private prevHostCpu: { busy: number; total: number } | null = null;
    private readonly gpuSampler: HostGpuSampler;
    private readonly engineSampler: DrmEngineSampler;
    private readonly env: Env;
    private readonly paths: HostMetricsPaths;
    private readonly now: () => number;
    private readonly cpuUsage: () => ReturnType<typeof process.cpuUsage>;
    private readonly rss: () => number;
    private readonly pid: number;

    constructor(private readonly options: HostMetricsOptions) {
        this.env = options.env ?? process.env;
        this.paths = options.paths ?? DEFAULT_PATHS;
        this.now = options.now ?? (() => performance.now());
        this.cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
        this.rss = options.rss ?? (() => process.memoryUsage.rss());
        this.pid = options.pid ?? process.pid;
        this.gpuSampler = new HostGpuSampler({
            paths: this.paths,
            now: this.now,
            nvidiaSmi: options.nvidiaSmi,
            nvencMaxSessionsEnv: options.nvencMaxSessionsEnv,
        });
        this.engineSampler = new DrmEngineSampler(this.paths, this.now);
    }

    async sample(): Promise<HostProcessSnapshot> {
        this.hostId ??= resolveHostId(this.env, this.paths);
        const [id, meminfo, loadavg, procStat, disks, gpus, children] = await Promise.all([
            this.hostId,
            readText(join(this.paths.proc, 'meminfo')),
            readText(join(this.paths.proc, 'loadavg')),
            readText(join(this.paths.proc, 'stat')),
            readDisks(this.options.disks ?? []),
            readGpus(this.paths),
            readChildren(this.paths, this.pid),
        ]);

        const loads = loadavg?.split(/\s+/).slice(0, 3).map(Number);
        const host: HostInfo = { id };
        const name = nonEmpty(this.env.K8S_NODE_NAME) ?? nonEmpty(this.env.LUMASTRA_HOST_NAME);
        if (name) host.name = name;
        const memTotal = meminfoBytes(meminfo, 'MemTotal');
        const memAvailable = meminfoBytes(meminfo, 'MemAvailable');
        if (memTotal !== undefined) host.memTotalBytes = memTotal;
        if (memAvailable !== undefined) host.memAvailableBytes = memAvailable;
        host.cpuCount = os.availableParallelism?.() ?? os.cpus().length;
        if (loads && loads.length === 3 && loads.every(Number.isFinite)) {
            [host.load1, host.load5, host.load15] = loads;
        }
        const cpu = parseProcStatCpu(procStat);
        if (cpu && this.prevHostCpu && cpu.total > this.prevHostCpu.total) {
            const busy = (cpu.busy - this.prevHostCpu.busy) / (cpu.total - this.prevHostCpu.total);
            host.cpuPercent = Math.round(Math.min(1, Math.max(0, busy)) * 1000) / 10;
        }
        if (cpu) this.prevHostCpu = cpu;
        if (disks.length > 0) host.disks = disks;
        if (gpus.length > 0) {
            const stats = await this.gpuSampler.sample(gpus);
            host.gpus = gpus.map((g) => ({ ...stats.get(g.device), ...g }));
        }

        const proc: ProcessInfo = { rssBytes: this.rss() };
        const usage = this.cpuUsage();
        const atMs = this.now();
        if (this.prevCpu && atMs > this.prevCpu.atMs) {
            const usedUs =
                usage.user - this.prevCpu.usage.user + (usage.system - this.prevCpu.usage.system);
            if (usedUs >= 0) {
                proc.cpuPercent =
                    Math.round((usedUs / 1000 / (atMs - this.prevCpu.atMs)) * 1000) / 10;
            }
        }
        this.prevCpu = { usage, atMs };

        if (children.length > 0) {
            const statuses = await Promise.all(
                children.map((pid) => readText(join(this.paths.proc, String(pid), 'status'))),
            );
            const childRss = statuses.reduce(
                (sum, st) => sum + (meminfoBytes(st, 'VmRSS') ?? 0),
                0,
            );
            proc.childCount = children.length;
            proc.childRssBytes = childRss;
        }
        this.childRssSamples = this.childRssSamples
            .filter((s) => atMs - s.atMs < 60_000)
            .slice(-63);
        this.childRssSamples.push({ atMs, rss: proc.childRssBytes ?? 0 });
        proc.childRssPeakBytes = Math.max(...this.childRssSamples.map((s) => s.rss));
        // Only children can hold the GPU here (Node itself never opens /dev/dri).
        const gpu = gpus.length > 0 ? await this.engineSampler.sample(children) : undefined;
        if (gpu) proc.gpu = gpu;

        return { implementation: this.options.implementation, host, process: proc };
    }
}

/** A stalled mount (statfs on dead NFS) must never hold up the liveness beat itself. */
export const SAMPLE_TIMEOUT_MS = 1_500;

/**
 * Never throws and never blocks the heartbeat for long: a failing or hanging
 * sampler drops the fields for this beat instead of the whole heartbeat.
 */
export async function sampleHostMetricsSafe(
    sampler: Pick<HostMetricsSampler, 'sample'>,
    timeoutMs: number = SAMPLE_TIMEOUT_MS,
): Promise<Partial<HostProcessSnapshot>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Partial<HostProcessSnapshot>>((resolve) => {
        timer = setTimeout(() => resolve({}), timeoutMs);
        timer.unref?.();
    });
    try {
        return await Promise.race([sampler.sample(), timeout]);
    } catch {
        return {};
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Parsing: the reader accepts payloads from every producer and build (TS, Rust,
// Python, older builds without these fields) and drops anything malformed.
// ---------------------------------------------------------------------------

function str(value: unknown, max = 256): string | undefined {
    return typeof value === 'string' && value !== '' && value.length <= max ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function defined<T extends object>(obj: T): T {
    for (const key of Object.keys(obj) as (keyof T)[]) {
        if (obj[key] === undefined) delete obj[key];
    }
    return obj;
}

export function parseImplementation(raw: unknown): ServiceImplementation | undefined {
    return raw === 'node' || raw === 'rust' || raw === 'python' ? raw : undefined;
}

export function parseHostInfo(raw: unknown): HostInfo | undefined {
    const r = record(raw);
    const id = str(r?.id);
    if (!r || !id) return undefined;
    const disks = Array.isArray(r.disks)
        ? r.disks
              .slice(0, MAX_DISKS)
              .map((d): HostDisk | undefined => {
                  const dr = record(d);
                  const role = dr?.role as HostDiskRole | undefined;
                  const freeBytes = num(dr?.freeBytes);
                  const totalBytes = num(dr?.totalBytes);
                  if (
                      (role !== 'cache' && role !== 'transcode' && role !== 'data') ||
                      freeBytes === undefined ||
                      totalBytes === undefined
                  ) {
                      return undefined;
                  }
                  return { role, path: str(dr?.path, 1024) ?? '', freeBytes, totalBytes };
              })
              .filter((d): d is HostDisk => d !== undefined)
        : [];
    const gpus = Array.isArray(r.gpus)
        ? r.gpus
              .slice(0, MAX_GPUS)
              .map((g): HostGpu | undefined => {
                  const gr = record(g);
                  const kind: HostGpu['kind'] | undefined =
                      gr?.kind === 'dri' ? 'dri' : gr?.kind === 'nvidia' ? 'nvidia' : undefined;
                  const device = str(gr?.device, 64);
                  if (!kind || !device) return undefined;
                  const gpu: HostGpu = { kind, device };
                  const driver = str(gr?.driver, 64);
                  if (driver) gpu.driver = driver;
                  const stats = parseGpuDeviceStats(gr!);
                  // Builds from 2026-10-22 published Intel RC6 "awake" time as busyPercent;
                  // it is not load, so it is always read as awakePercent for DRI devices.
                  if (kind === 'dri') {
                      stats.awakePercent ??= stats.busyPercent;
                      stats.busyPercent = undefined;
                  }
                  return defined({ ...gpu, ...stats });
              })
              .filter((g): g is HostGpu => g !== undefined)
        : [];
    return defined({
        id,
        name: str(r.name),
        memTotalBytes: num(r.memTotalBytes),
        memAvailableBytes: num(r.memAvailableBytes),
        cpuCount: num(r.cpuCount),
        cpuPercent: pct(r.cpuPercent),
        load1: num(r.load1),
        load5: num(r.load5),
        load15: num(r.load15),
        disks: disks.length > 0 ? disks : undefined,
        gpus: gpus.length > 0 ? gpus : undefined,
    });
}

export function parseProcessInfo(raw: unknown): ProcessInfo | undefined {
    const r = record(raw);
    const rssBytes = num(r?.rssBytes);
    if (!r || rssBytes === undefined) return undefined;
    return defined({
        rssBytes,
        cpuPercent: num(r.cpuPercent),
        childRssBytes: num(r.childRssBytes),
        childCount: num(r.childCount),
        childRssPeakBytes: num(r.childRssPeakBytes),
        gpu: parseProcessGpu(r.gpu),
    });
}

function pct(value: unknown): number | undefined {
    const n = num(value);
    return n === undefined ? undefined : Math.min(100, n);
}

/** Live device figures; any producer may send any subset. */
function parseGpuDeviceStats(r: Record<string, unknown>): GpuDeviceStats {
    return {
        name: str(r.name, 128),
        busyPercent: pct(r.busyPercent),
        awakePercent: pct(r.awakePercent),
        freqMhz: num(r.freqMhz),
        freqMaxMhz: num(r.freqMaxMhz),
        powerWatts: num(r.powerWatts),
        encoderPercent: pct(r.encoderPercent),
        decoderPercent: pct(r.decoderPercent),
        encodeSessions: num(r.encodeSessions),
        maxEncodeSessions: num(r.maxEncodeSessions),
        memUsedBytes: num(r.memUsedBytes),
        memTotalBytes: num(r.memTotalBytes),
        temperatureC: num(r.temperatureC),
    };
}

/** `process.gpu` from the TS sampler or the Rust proxy; malformed engines are dropped. */
export function parseProcessGpu(raw: unknown): ProcessGpu | undefined {
    const r = record(raw);
    const clients = num(r?.clients);
    if (!r || clients === undefined) return undefined;
    const e = record(r.engines);
    let engines: GpuEngineUsage | undefined;
    if (e) {
        engines = {};
        for (const cls of GPU_ENGINE_CLASSES) {
            const v = pct(e[cls]);
            if (v !== undefined) engines[cls] = v;
        }
    }
    return defined({ clients: Math.floor(clients), engines });
}
