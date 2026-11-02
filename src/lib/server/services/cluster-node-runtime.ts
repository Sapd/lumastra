// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a replica can learn about its own runtime without talking to any API:
 * placement from the Kubernetes Downward API (env vars the Helm chart injects)
 * and CPU/memory usage against its limits from its own cgroup.
 *
 * Published in the cluster heartbeat so /admin/system/health?tab=cluster can
 * show which node a pod runs on and how close it is to an OOM kill. Display
 * only: ResourceSampler makes no admission decisions. The separate CPU PSI
 * reader also feeds background task admission through TASK Valkey. Every reader is
 * fail-soft — a missing file or env var yields `undefined`, never a throw —
 * so Docker Compose, bare-metal and macOS dev simply publish less.
 *
 * Deliberately NOT the Kubernetes API: the chart runs pods with
 * `automountServiceAccountToken: false`, and restart counts / OOM reasons via
 * the API would need a token plus a Role. Restarts come from
 * cluster_node_events instead (see recordInstanceStart).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where the pod runs. Set by the Helm chart's Downward API env; absent elsewhere. */
export interface NodePlacement {
    nodeName?: string;
    podIp?: string;
    namespace?: string;
}

/** Optional memory.stat counters in bytes, from the same cgroup as the working set. */
export interface CgroupMemoryStat {
    memoryAnonBytes?: number;
    memoryFileBytes?: number;
    memoryActiveFileBytes?: number;
    memoryInactiveFileBytes?: number;
    memoryShmemBytes?: number;
    memorySlabBytes?: number;
    memoryFileDirtyBytes?: number;
    memoryFileWritebackBytes?: number;
    memoryUnevictableBytes?: number;
}

/** Usage against limits. Bytes and cores; a field is absent when not knowable. */
export interface NodeResources extends CgroupMemoryStat {
    /** Working set (usage minus inactive page cache) — the kubectl top convention; the cgroup limit applies to total charges. */
    memoryUsedBytes: number;
    /** cgroup memory limit; absent when unlimited. */
    memoryLimitBytes?: number;
    /**
     * Highest working set seen in the last 24 h (since start when younger), sampled
     * every heartbeat. Deliberately NOT cgroup `memory.peak`: that is the peak
     * charge including page cache, which a service streaming media files keeps
     * near its limit all the time although the cache is reclaimable.
     */
    memoryPeakBytes?: number;
    /** Total charge minus clean reclaimable file cache; includes anon, kernel and unevictable memory. */
    memoryPressureBytes?: number;
    /** Clean file cache excluded from memoryPressureBytes, including active file cache. */
    memoryReclaimableFileBytes?: number;
    /** Rolling 24 h peak of memoryPressureBytes, sampled alongside cache (never inferred from a working-set peak). */
    memoryPressurePeakBytes?: number;
    /** Processes the kernel OOM-killed in this cgroup since it was created (memory.events oom_kill). */
    memoryOomKills?: number;
    /** Kubernetes memory request (Downward API); absent when unset. */
    memoryRequestBytes?: number;
    /** CPU used since the previous sample, in cores. Absent on the first sample. */
    cpuUsedCores?: number;
    /** cgroup CPU quota in cores; absent when unlimited. */
    cpuLimitCores?: number;
    /** Kubernetes CPU request (Downward API); absent when unset. */
    cpuRequestCores?: number;
}

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
    const v = value?.trim();
    return v ? v : undefined;
}

/** A positive finite number from an env var, else undefined (Downward API reports unset requests as 0). */
function positiveNumber(value: string | undefined): number | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function readPlacement(env: Env = process.env): NodePlacement | undefined {
    const placement: NodePlacement = {
        nodeName: nonEmpty(env.K8S_NODE_NAME),
        podIp: nonEmpty(env.K8S_POD_IP),
        namespace: nonEmpty(env.K8S_NAMESPACE),
    };
    return placement.nodeName || placement.podIp || placement.namespace ? placement : undefined;
}

export function readRequests(env: Env = process.env): {
    cpuRequestCores?: number;
    memoryRequestBytes?: number;
} {
    const millicores = positiveNumber(env.K8S_CPU_REQUEST_MILLICORES);
    return {
        cpuRequestCores: millicores === undefined ? undefined : millicores / 1000,
        memoryRequestBytes: positiveNumber(env.K8S_MEMORY_REQUEST_BYTES),
    };
}

/** One raw cgroup reading. `cpuUsageUsec` is cumulative; a rate needs two samples. */
export interface CgroupSnapshot extends CgroupMemoryStat {
    memoryPressureBytes?: number;
    memoryReclaimableFileBytes?: number;
    memoryUsedBytes: number;
    memoryLimitBytes?: number;
    cpuUsageUsec?: number;
    cpuLimitCores?: number;
    oomKills?: number;
}

export interface CgroupPaths {
    /** cgroupfs mount, `/sys/fs/cgroup`. */
    root: string;
    /** This process's membership file, `/proc/self/cgroup`. */
    procSelfCgroup: string;
}

const DEFAULT_PATHS: CgroupPaths = { root: '/sys/fs/cgroup', procSelfCgroup: '/proc/self/cgroup' };

/** cgroup v1 reports "no limit" as a page-aligned near-2^63 value. */
const V1_UNLIMITED_THRESHOLD = 2 ** 60;

async function readText(path: string): Promise<string | undefined> {
    try {
        return (await readFile(path, 'utf8')).trim();
    } catch {
        return undefined;
    }
}

async function readInt(path: string): Promise<number | undefined> {
    const text = await readText(path);
    if (text === undefined) return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
}

/** `key value` lines (memory.stat, cpu.stat) → the value for `key`. */
function statValue(text: string | undefined, key: string): number | undefined {
    if (!text) return undefined;
    for (const line of text.split('\n')) {
        const [k, v] = line.trim().split(/\s+/);
        if (k === key) {
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
        }
    }
    return undefined;
}

/** v1 counters include descendants via total_*, with local counters as fallback. */
export function parseMemoryStat(text: string | undefined, v1 = false): CgroupMemoryStat {
    const value = (v2Key: string, v1Key = v2Key): number | undefined => {
        const n = v1
            ? (statValue(text, `total_${v1Key}`) ?? statValue(text, v1Key))
            : statValue(text, v2Key);
        return n !== undefined && n >= 0 ? n : undefined;
    };
    return {
        memoryAnonBytes: value('anon', 'rss'),
        memoryFileBytes: value('file', 'cache'),
        memoryActiveFileBytes: value('active_file', 'active_file'),
        memoryInactiveFileBytes: value('inactive_file', 'inactive_file'),
        memoryShmemBytes: value('shmem', 'shmem'),
        memorySlabBytes: value('slab', 'slab'),
        memoryFileDirtyBytes: value('file_dirty', 'dirty'),
        memoryFileWritebackBytes: value('file_writeback', 'writeback'),
        memoryUnevictableBytes: value('unevictable'),
    };
}

/**
 * Only clean file cache can be discounted immediately. Keep tmpfs/shmem,
 * dirty/writeback and unevictable pages, plus every non-file charge (kernel,
 * anonymous memory, sockets, etc.). Subtracting all unevictable bytes is
 * conservative: some can be anonymous rather than file-backed.
 * https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files
 * Missing counters mean unknown, not zero; retain the working-set fallback.
 */
function memoryPressure(
    current: number,
    stat: CgroupMemoryStat,
): {
    memoryPressureBytes?: number;
    memoryReclaimableFileBytes?: number;
} {
    const {
        memoryFileBytes: file,
        memoryShmemBytes: shmem,
        memoryFileDirtyBytes: dirty,
        memoryFileWritebackBytes: writeback,
        memoryUnevictableBytes: unevictable,
    } = stat;
    if (
        file === undefined ||
        shmem === undefined ||
        dirty === undefined ||
        writeback === undefined ||
        unevictable === undefined
    )
        return {};
    const cache = Math.min(current, Math.max(0, file - shmem - dirty - writeback - unevictable));
    return { memoryPressureBytes: Math.max(0, current - cache), memoryReclaimableFileBytes: cache };
}

export function memoryWorkingSet(current: number, inactiveFile = 0): number {
    return Math.max(0, current - inactiveFile);
}

/**
 * This process's cgroup and every ancestor up to the mount root, most specific
 * first. With a private cgroup namespace (Docker/containerd default on v2) the
 * membership path is `/` and the mount root IS the container's cgroup. With a
 * host namespace (systemd service, `--cgroupns=host`) or an init inside the
 * container (`0::/init.scope`) it is a sub-path — and the limit may sit on an
 * ancestor, not on the leaf.
 */
function ancestorDirs(base: string, membershipPath: string | undefined): string[] {
    const segments = (membershipPath ?? '/').split('/').filter((seg) => seg !== '' && seg !== '..');
    const dirs: string[] = [];
    for (let i = segments.length; i >= 0; i--) dirs.push(join(base, ...segments.slice(0, i)));
    return dirs;
}

export function parseCpuPressure(text: string): number | undefined {
    const value = text.match(/^some\s+avg10=([\d.]+)/m)?.[1];
    const n = Number(value);
    return value !== undefined && Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}
/** This process's cgroup v2 CPU stall percentage. Kept with the existing
 * privileged runtime metrics reader; paths never come from media or requests.
 * Missing PSI (including non-Linux hosts) is an optional metric, not an error.
 */
export async function readCpuPressurePercent(
    paths: CgroupPaths = DEFAULT_PATHS,
): Promise<number | undefined> {
    const membership = await readText(paths.procSelfCgroup);
    const relative = membership?.match(/^0::(.*)$/m)?.[1];
    if (!relative || relative.split('/').includes('..')) return undefined;
    const dir = ancestorDirs(paths.root, relative)[0] ?? paths.root;
    return parseCpuPressure((await readText(join(dir, 'cpu.pressure'))) ?? '');
}

/** A positive finite limit, else undefined ('max', 0 and garbage all mean "no usable limit"). */
function positiveLimit(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseCpuMax(text: string | undefined): number | undefined {
    if (!text) return undefined;
    const [quota, period] = text.split(/\s+/);
    if (quota === 'max') return undefined;
    const q = Number(quota);
    const p = Number(period);
    return Number.isFinite(p) && p > 0 ? positiveLimit(q / p) : undefined;
}

function minDefined(values: (number | undefined)[]): number | undefined {
    const defined = values.filter((v): v is number => v !== undefined);
    return defined.length > 0 ? Math.min(...defined) : undefined;
}

async function readV2(paths: CgroupPaths, membership: string): Promise<CgroupSnapshot | undefined> {
    const line = membership.split('\n').find((l) => l.startsWith('0::'));
    // memory.current is absent on the host's root cgroup, so a bare host (no
    // container) ends up with no levels and reports "unknown", not the host.
    const levels: { dir: string; current: number; limit?: number }[] = [];
    for (const dir of ancestorDirs(paths.root, line?.slice(3))) {
        const current = await readInt(join(dir, 'memory.current'));
        if (current === undefined) continue;
        const memMax = await readText(join(dir, 'memory.max'));
        levels.push({
            dir,
            current,
            limit:
                memMax === undefined || memMax === 'max'
                    ? undefined
                    : positiveLimit(Number(memMax)),
        });
    }
    if (levels.length === 0) return undefined;

    // Report usage of the level whose limit binds (the nearest one with a
    // limit) — that is the cgroup the OOM killer acts on. Without any limit,
    // report this process's own cgroup.
    const binding = levels.find((l) => l.limit !== undefined) ?? levels[0];
    const memoryStat = parseMemoryStat(await readText(join(binding.dir, 'memory.stat')));

    let cpuUsageUsec: number | undefined;
    const cpuLimits: (number | undefined)[] = [];
    for (const { dir } of levels) {
        cpuUsageUsec ??= statValue(await readText(join(dir, 'cpu.stat')), 'usage_usec');
        cpuLimits.push(parseCpuMax(await readText(join(dir, 'cpu.max'))));
    }

    return {
        ...memoryStat,
        ...memoryPressure(binding.current, memoryStat),
        memoryUsedBytes: memoryWorkingSet(binding.current, memoryStat.memoryInactiveFileBytes),
        memoryLimitBytes: binding.limit,
        cpuUsageUsec,
        cpuLimitCores: minDefined(cpuLimits),
        oomKills: statValue(await readText(join(binding.dir, 'memory.events')), 'oom_kill'),
    };
}

async function readV1(paths: CgroupPaths, membership: string): Promise<CgroupSnapshot | undefined> {
    // v1 lines look like `9:memory:/docker/<id>` and `4:cpu,cpuacct:/docker/<id>`.
    const pathFor = (controller: string): string | undefined => {
        for (const line of membership.split('\n')) {
            const parts = line.split(':');
            if (parts.length >= 3 && parts[1].split(',').includes(controller)) {
                return parts.slice(2).join(':');
            }
        }
        return undefined;
    };

    const memLevels: { dir: string; usage: number; limit?: number }[] = [];
    for (const dir of ancestorDirs(join(paths.root, 'memory'), pathFor('memory'))) {
        const usage = await readInt(join(dir, 'memory.usage_in_bytes'));
        if (usage === undefined) continue;
        const limit = await readInt(join(dir, 'memory.limit_in_bytes'));
        memLevels.push({
            dir,
            usage,
            limit:
                limit !== undefined && limit < V1_UNLIMITED_THRESHOLD
                    ? positiveLimit(limit)
                    : undefined,
        });
    }
    if (memLevels.length === 0) return undefined;
    const binding = memLevels.find((l) => l.limit !== undefined) ?? memLevels[0];
    const memoryStat = parseMemoryStat(await readText(join(binding.dir, 'memory.stat')), true);

    let cpuUsageUsec: number | undefined;
    const cpuLimits: (number | undefined)[] = [];
    for (const dir of ancestorDirs(join(paths.root, 'cpu,cpuacct'), pathFor('cpuacct'))) {
        const usageNs = await readInt(join(dir, 'cpuacct.usage'));
        if (usageNs === undefined) continue;
        cpuUsageUsec ??= usageNs / 1000;
        const quota = await readInt(join(dir, 'cpu.cfs_quota_us'));
        const period = await readInt(join(dir, 'cpu.cfs_period_us'));
        if (quota !== undefined && quota > 0 && period !== undefined && period > 0) {
            cpuLimits.push(quota / period);
        }
    }
    return {
        ...memoryStat,
        ...memoryPressure(binding.usage, memoryStat),
        memoryUsedBytes: memoryWorkingSet(binding.usage, memoryStat.memoryInactiveFileBytes),
        memoryLimitBytes: binding.limit,
        cpuUsageUsec,
        cpuLimitCores: minDefined(cpuLimits),
        // Kernel 4.13+ adds an `oom_kill` line to memory.oom_control.
        oomKills: statValue(await readText(join(binding.dir, 'memory.oom_control')), 'oom_kill'),
    };
}

/** Reads this process's cgroup (v2, else v1). Undefined when not in a cgroup we can read. */
export async function readCgroupSnapshot(
    paths: CgroupPaths = DEFAULT_PATHS,
): Promise<CgroupSnapshot | undefined> {
    const membership = await readText(paths.procSelfCgroup);
    if (membership === undefined) return undefined;
    if ((await readText(join(paths.root, 'cgroup.controllers'))) !== undefined) {
        return readV2(paths, membership);
    }
    return readV1(paths, membership);
}

const PEAK_WINDOW_MS = 24 * 60 * 60_000;
const PEAK_BUCKET_MS = 60_000;

/**
 * Rolling maximum over the last 24 h in one-minute buckets (at most 1440 numbers),
 * so a peak ages out a day after it happened instead of living until a restart.
 */
export class PeakWindow {
    private buckets = new Map<number, number>();

    record(value: number, atMs: number): void {
        const bucket = Math.floor(atMs / PEAK_BUCKET_MS);
        const prev = this.buckets.get(bucket);
        if (Number.isFinite(value) && (prev === undefined || value > prev))
            this.buckets.set(bucket, value);
        const oldest = Math.floor((atMs - PEAK_WINDOW_MS) / PEAK_BUCKET_MS);
        for (const key of this.buckets.keys()) {
            if (key <= oldest) this.buckets.delete(key);
        }
    }

    max(): number | undefined {
        let best: number | undefined;
        for (const v of this.buckets.values()) if (best === undefined || v > best) best = v;
        return best;
    }
}

/**
 * Turns successive cgroup snapshots into {@link NodeResources}. Holds the
 * previous CPU counter so each heartbeat reports the CPU rate over the last
 * interval (~10 s) rather than a lifetime average.
 */
export class ResourceSampler {
    private prev: { usageUsec: number; atMs: number } | null = null;
    private readonly peak = new PeakWindow();
    private readonly pressurePeak = new PeakWindow();

    constructor(
        private readonly paths: CgroupPaths = DEFAULT_PATHS,
        private readonly env: Env = process.env,
        private readonly now: () => number = () => performance.now(),
    ) {}

    async sample(): Promise<NodeResources | undefined> {
        let snap: CgroupSnapshot | undefined;
        try {
            snap = await readCgroupSnapshot(this.paths);
        } catch {
            snap = undefined;
        }
        if (!snap) return undefined;

        let cpuUsedCores: number | undefined;
        const atMs = this.now();
        if (snap.cpuUsageUsec !== undefined) {
            if (this.prev && atMs > this.prev.atMs && snap.cpuUsageUsec >= this.prev.usageUsec) {
                const seconds = (atMs - this.prev.atMs) / 1000;
                cpuUsedCores = (snap.cpuUsageUsec - this.prev.usageUsec) / 1e6 / seconds;
            }
            this.prev = { usageUsec: snap.cpuUsageUsec, atMs };
        }

        this.peak.record(snap.memoryUsedBytes, atMs);
        // NaN records no value but still prunes expired buckets after a missing sample.
        this.pressurePeak.record(snap.memoryPressureBytes ?? NaN, atMs);
        return {
            memoryAnonBytes: snap.memoryAnonBytes,
            memoryFileBytes: snap.memoryFileBytes,
            memoryActiveFileBytes: snap.memoryActiveFileBytes,
            memoryInactiveFileBytes: snap.memoryInactiveFileBytes,
            memoryShmemBytes: snap.memoryShmemBytes,
            memorySlabBytes: snap.memorySlabBytes,
            memoryFileDirtyBytes: snap.memoryFileDirtyBytes,
            memoryFileWritebackBytes: snap.memoryFileWritebackBytes,
            memoryUnevictableBytes: snap.memoryUnevictableBytes,
            memoryPressureBytes: snap.memoryPressureBytes,
            memoryReclaimableFileBytes: snap.memoryReclaimableFileBytes,
            memoryPressurePeakBytes: this.pressurePeak.max(),
            memoryUsedBytes: snap.memoryUsedBytes,
            memoryLimitBytes: snap.memoryLimitBytes,
            memoryPeakBytes: this.peak.max(),
            memoryOomKills: snap.oomKills,
            cpuUsedCores,
            cpuLimitCores: snap.cpuLimitCores,
            ...readRequests(this.env),
        };
    }
}
