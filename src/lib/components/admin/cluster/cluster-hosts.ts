// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * View model for Admin → System health → Cluster: every service (web, worker,
 * Live TV proxy, sonic sidecar) as one entry with a state, grouped by the
 * machine it runs on.
 *
 * Grouping key is `host.id` from the heartbeat (src/shared/host-metrics.ts): the
 * Kubernetes node, else a hash of the kernel boot id, which every container on
 * one kernel shares. Host figures (memory, load, disks) are host-wide, so a host
 * card shows them ONCE, taken from the freshest member — never summed across the
 * services on it. Per-service figures (RSS, CPU, cgroup limits) are listed per
 * service, and their sum is shown as "Lumastra uses".
 *
 * GPU: device figures (awake %, clock, power, NVENC sessions) are host-wide like
 * memory. Engine use (render, video = encode/decode) is measured per service over
 * its own FFmpeg children, so the host card ADDS the services together: on one
 * machine the web pods, the worker and the Live TV proxy share one GPU.
 */

import type {
    ClusterHostInfo,
    ClusterNode,
    ClusterProcessInfo,
    ClusterSidecar,
    ClusterStatusResponse,
} from '$lib/schemas/api-admin-responses';
import { MEMORY_CRITICAL_RATIO } from '$lib/utils/admin/cluster-node-resources.js';

export type ServiceState = 'healthy' | 'degraded' | 'stale' | 'notConfigured';
export type ServiceKind = 'web' | 'worker' | 'proxy' | 'general' | 'sonic';

/** Missed two 10 s beats; the 30 s key TTL has not run out yet. */
export const STALE_HEARTBEAT_MS = 25_000;
/** A service that went offline this recently stays on the board as a stale card. */
export const RECENTLY_OFFLINE_MS = 15 * 60_000;
/** Host memory share in use at which the host card turns amber. */
export const HOST_MEMORY_WARN_RATIO = 0.9;

export type ServiceReason =
    | 'heartbeatLate'
    | 'noHeartbeat'
    | 'wentOffline'
    | 'memoryNearLimit'
    | 'sidecarLoading'
    | 'sidecarError'
    | 'sidecarDown'
    | 'workerUnavailable'
    | 'watcherDegraded';

export interface ClusterServiceEntry {
    /** Stable key for {#each}. */
    key: string;
    kind: ServiceKind;
    state: ServiceState;
    reasons: ServiceReason[];
    implementation?: 'node' | 'rust' | 'python';
    version?: string;
    hostname?: string;
    uptimeSeconds?: number;
    lastSeenAt?: string;
    /** Age of the last heartbeat/probe at generatedAt, ms. */
    lastSeenAgoMs?: number;
    host?: ClusterHostInfo;
    process?: ClusterProcessInfo;
    /** The live heartbeat node, when the service has one. */
    node?: ClusterNode;
    sidecar?: ClusterSidecar;
    isSelf: boolean;
}

export interface ClusterHostGroup {
    /** host.id, or `unknown` for services that publish no host block. */
    id: string;
    known: boolean;
    /** Freshest host block among the members. */
    host?: ClusterHostInfo;
    services: ClusterServiceEntry[];
    /** Sum of member RSS + child RSS, bytes. */
    serviceRssBytes: number;
    /** Kubernetes node name when every placed member agrees on one. */
    nodeName?: string;
    hostMemoryWarn: boolean;
    /** Host-wide CPU busy, percent of all CPUs, from the freshest member that reports it. */
    cpuPercent?: number;
    /** Devices with live figures, from the freshest member that has any GPU block. */
    gpus?: ClusterHostGpu[];
    /** Sum of the members' child engine use, clamped to 100; absent when nobody measured it. */
    gpuEngines?: ClusterGpuEngines;
    /** FFmpeg processes on the GPU across the members. */
    gpuClients: number;
    /** Hardware encoder probes of the members (one per distinct configured/accessible pair). */
    gpuAccess: NonNullable<ClusterNode['gpuAccess']>[];
}

export type ClusterHostGpu = NonNullable<ClusterHostInfo['gpus']>[number];
export type ClusterGpuEngines = NonNullable<NonNullable<ClusterProcessInfo['gpu']>['engines']>;

/** Engine classes in display order. */
export const GPU_ENGINE_ORDER = ['video', 'render', 'videoEnhance', 'compute', 'copy'] as const;

const KIND_ORDER: Record<ServiceKind, number> = {
    web: 0,
    general: 1,
    worker: 2,
    proxy: 3,
    sonic: 4,
};
const STATE_ORDER: Record<ServiceState, number> = {
    stale: 0,
    degraded: 1,
    healthy: 2,
    notConfigured: 3,
};

function ageMs(lastSeenAt: string | undefined, generatedAtMs: number): number | undefined {
    if (!lastSeenAt) return undefined;
    const t = Date.parse(lastSeenAt);
    return Number.isFinite(t) ? Math.max(0, generatedAtMs - t) : undefined;
}

export function nodeEntry(
    node: ClusterNode,
    generatedAtMs: number,
    selfInstanceId?: string,
): ClusterServiceEntry {
    const reasons: ServiceReason[] = [];
    // Valkey's TTL is one clock for all hosts; sentAt (the producer's clock) is
    // only the fallback for a payload read without heartbeatAgeMs.
    const lastSeenAgoMs = node.heartbeatAgeMs ?? ageMs(node.lastSeenAt, generatedAtMs);
    if (lastSeenAgoMs !== undefined && lastSeenAgoMs > STALE_HEARTBEAT_MS) {
        reasons.push('heartbeatLate');
    }
    const res = node.resources;
    if (
        res?.memoryLimitBytes !== undefined &&
        res.memoryUsedBytes / res.memoryLimitBytes >= MEMORY_CRITICAL_RATIO
    ) {
        reasons.push('memoryNearLimit');
    }
    if ((node.unavailableReasons?.length ?? 0) > 0) reasons.push('workerUnavailable');
    const watcherState = node.runtime?.watcher?.state;
    if (watcherState === 'degraded' || watcherState === 'failed') reasons.push('watcherDegraded');
    const state: ServiceState = reasons.includes('heartbeatLate')
        ? 'stale'
        : reasons.length > 0
          ? 'degraded'
          : 'healthy';
    return {
        key: `node:${node.instanceId}`,
        kind: node.role,
        state,
        reasons,
        // A proxy without the field may be an older Rust build: leave it unlabelled.
        implementation: node.implementation ?? (node.role === 'proxy' ? undefined : 'node'),
        version: node.version,
        hostname: node.hostname,
        uptimeSeconds: node.uptimeSeconds,
        lastSeenAt: node.lastSeenAt,
        lastSeenAgoMs,
        host: node.host,
        process: node.process,
        node,
        isSelf: node.instanceId === selfInstanceId,
    };
}

export function sidecarEntry(sidecar: ClusterSidecar, generatedAtMs: number): ClusterServiceEntry {
    const reasons: ServiceReason[] = [];
    let state: ServiceState;
    switch (sidecar.state) {
        case 'healthy':
            state = 'healthy';
            break;
        case 'degraded':
            state = 'degraded';
            reasons.push(sidecar.status === 'loading' ? 'sidecarLoading' : 'sidecarError');
            break;
        case 'down':
            state = 'stale';
            reasons.push('sidecarDown');
            break;
        default:
            state = 'notConfigured';
    }
    return {
        key: `sidecar:${sidecar.kind}`,
        kind: sidecar.kind,
        state,
        reasons,
        implementation: sidecar.implementation,
        version: sidecar.version,
        hostname: sidecar.hostname,
        uptimeSeconds: sidecar.uptimeSeconds,
        lastSeenAt: sidecar.state === 'down' ? undefined : sidecar.checkedAt,
        lastSeenAgoMs:
            sidecar.state === 'down' ? undefined : ageMs(sidecar.checkedAt, generatedAtMs),
        host: sidecar.host,
        process: sidecar.process,
        sidecar,
        isSelf: false,
    };
}

/** Every service the board lists, including expected-but-missing and unconfigured ones. */
export function buildServiceEntries(
    status: Pick<
        ClusterStatusResponse,
        'nodes' | 'sidecars' | 'expected' | 'generatedAt' | 'selfInstanceId'
    > &
        Partial<Pick<ClusterStatusResponse, 'events'>>,
    now: number = Date.now(),
): ClusterServiceEntry[] {
    const parsed = status.generatedAt ? Date.parse(status.generatedAt) : NaN;
    const generatedAtMs = Number.isFinite(parsed) ? parsed : now;
    const entries = status.nodes.map((n) => nodeEntry(n, generatedAtMs, status.selfInstanceId));
    entries.push(...recentlyOfflineEntries(status, generatedAtMs));

    // The proxy has no sidecar probe: a configured proxy without a heartbeat is
    // stale, an unconfigured one is listed so "no proxy" is visible, not silent.
    if (!entries.some((e) => e.kind === 'proxy') && status.expected) {
        entries.push({
            key: 'missing:proxy',
            kind: 'proxy',
            state: status.expected.proxy ? 'stale' : 'notConfigured',
            reasons: status.expected.proxy ? ['noHeartbeat'] : [],
            isSelf: false,
        });
    }
    for (const sidecar of status.sidecars ?? []) entries.push(sidecarEntry(sidecar, generatedAtMs));
    return entries;
}

const KINDS: readonly ServiceKind[] = ['web', 'worker', 'proxy', 'general', 'sonic'];

/**
 * A heartbeat key vanishes 30 s after the last beat, so a crashed service would
 * simply disappear. Its latest transition event (written by the leader when the
 * key went missing) keeps it on the board as stale for RECENTLY_OFFLINE_MS —
 * unless it was REPLACED: a live node of the same role started after the dead
 * instance came online (a deploy or restart with an unpinned INSTANCE_ID mints a
 * new id each time, and the old id must not read as an outage).
 */
function recentlyOfflineEntries(
    status: Pick<ClusterStatusResponse, 'nodes'> & Partial<Pick<ClusterStatusResponse, 'events'>>,
    generatedAtMs: number,
): ClusterServiceEntry[] {
    const live = new Set(status.nodes.map((n) => n.instanceId));
    const events = status.events ?? [];
    const seen = new Set<string>();
    const out: ClusterServiceEntry[] = [];
    // Events arrive newest first.
    for (const e of events) {
        if (seen.has(e.instanceId)) continue;
        seen.add(e.instanceId);
        if (e.eventType !== 'offline' || live.has(e.instanceId)) continue;
        const agoMs = ageMs(e.createdAt, generatedAtMs);
        if (agoMs === undefined || agoMs > RECENTLY_OFFLINE_MS) continue;
        const role = KINDS.includes(e.role as ServiceKind) ? (e.role as ServiceKind) : 'general';
        const cameOnline = events.find(
            (o) =>
                o.instanceId === e.instanceId &&
                o.eventType === 'online' &&
                Date.parse(o.createdAt) <= Date.parse(e.createdAt),
        );
        const onlineAtMs = cameOnline ? Date.parse(cameOnline.createdAt) : NaN;
        const replaced =
            Number.isFinite(onlineAtMs) &&
            status.nodes.some((n) => n.role === role && Date.parse(n.startedAt) > onlineAtMs);
        if (replaced) continue;
        out.push({
            key: `offline:${e.instanceId}`,
            kind: role,
            state: 'stale',
            reasons: ['wentOffline'],
            version: e.version,
            hostname: e.hostname,
            lastSeenAt: e.createdAt,
            lastSeenAgoMs: agoMs,
            isSelf: false,
        });
    }
    return out;
}

function freshestHost(services: ClusterServiceEntry[]): ClusterHostInfo | undefined {
    let best: { host: ClusterHostInfo; age: number } | undefined;
    for (const s of services) {
        if (!s.host) continue;
        const age = s.lastSeenAgoMs ?? Number.MAX_SAFE_INTEGER;
        if (!best || age < best.age) best = { host: s.host, age };
    }
    return best?.host;
}

function hasGpuStats(gpus: ClusterHostGpu[] | undefined): boolean {
    return (gpus ?? []).some(
        (g) =>
            g.name !== undefined ||
            g.busyPercent !== undefined ||
            g.awakePercent !== undefined ||
            g.freqMhz !== undefined,
    );
}

/** Freshest member that reports `pick`; older builds and the Rust proxy omit some fields. */
function freshestWith<T>(
    services: ClusterServiceEntry[],
    pick: (host: ClusterHostInfo) => T | undefined,
): T | undefined {
    let best: { value: T; age: number } | undefined;
    for (const s of services) {
        const value = s.host ? pick(s.host) : undefined;
        if (value === undefined) continue;
        const age = s.lastSeenAgoMs ?? Number.MAX_SAFE_INTEGER;
        if (!best || age < best.age) best = { value, age };
    }
    return best?.value;
}

/** Adds the members' engine use per class (each member's share of the same capacity). */
export function sumGpuEngines(services: ClusterServiceEntry[]): ClusterGpuEngines | undefined {
    let out: ClusterGpuEngines | undefined;
    for (const s of services) {
        const engines = s.process?.gpu?.engines;
        if (!engines) continue;
        out ??= {};
        for (const cls of GPU_ENGINE_ORDER) {
            const v = engines[cls];
            if (v === undefined) continue;
            out[cls] = Math.min(100, Math.round(((out[cls] ?? 0) + v) * 10) / 10);
        }
    }
    return out;
}

function sortServices(a: ClusterServiceEntry, b: ClusterServiceEntry): number {
    return (
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        a.key.localeCompare(b.key)
    );
}

/**
 * Groups running services by machine. Services without a host block (older builds,
 * stale or unconfigured placeholders) are returned separately in `unplaced`.
 */
export function groupServicesByHost(entries: ClusterServiceEntry[]): {
    hosts: ClusterHostGroup[];
    unplaced: ClusterServiceEntry[];
} {
    const byId = new Map<string, ClusterServiceEntry[]>();
    const unplaced: ClusterServiceEntry[] = [];
    for (const e of entries) {
        if (!e.host) {
            unplaced.push(e);
            continue;
        }
        const list = byId.get(e.host.id) ?? [];
        list.push(e);
        byId.set(e.host.id, list);
    }

    const hosts: ClusterHostGroup[] = [...byId.entries()].map(([id, services]) => {
        services.sort(sortServices);
        const host = freshestHost(services);
        const nodeNames = new Set(
            services.map((s) => s.node?.placement?.nodeName).filter((n): n is string => !!n),
        );
        const serviceRssBytes = services.reduce(
            (sum, s) => sum + (s.process?.rssBytes ?? 0) + (s.process?.childRssBytes ?? 0),
            0,
        );
        const memRatio =
            host?.memTotalBytes && host.memAvailableBytes !== undefined
                ? 1 - host.memAvailableBytes / host.memTotalBytes
                : 0;
        return {
            id,
            known: true,
            host,
            services,
            serviceRssBytes,
            nodeName: nodeNames.size === 1 ? [...nodeNames][0] : undefined,
            hostMemoryWarn: memRatio >= HOST_MEMORY_WARN_RATIO,
            cpuPercent: freshestWith(services, (h) => h.cpuPercent),
            gpus:
                freshestWith(services, (h) => (hasGpuStats(h.gpus) ? h.gpus : undefined)) ??
                freshestWith(services, (h) => h.gpus),
            gpuEngines: sumGpuEngines(services),
            gpuClients: services.reduce((sum, s) => sum + (s.process?.gpu?.clients ?? 0), 0),
            gpuAccess: distinctGpuAccess(services),
        };
    });
    hosts.sort(
        (a, b) =>
            (a.services.some((s) => s.isSelf) ? 0 : 1) -
                (b.services.some((s) => s.isSelf) ? 0 : 1) ||
            (a.host?.name ?? a.id).localeCompare(b.host?.name ?? b.id),
    );
    unplaced.sort(sortServices);
    return { hosts, unplaced };
}

function distinctGpuAccess(
    services: ClusterServiceEntry[],
): NonNullable<ClusterNode['gpuAccess']>[] {
    const out: NonNullable<ClusterNode['gpuAccess']>[] = [];
    for (const s of services) {
        const a = s.node?.gpuAccess;
        if (!a) continue;
        const same = out.find(
            (o) => o.configured === a.configured && o.accessible === a.accessible,
        );
        if (!same) out.push(a);
    }
    // A failing probe first: it is the one to act on.
    return out.sort((a, b) => Number(a.accessible) - Number(b.accessible));
}

/**
 * The host's GPU encode load in one figure for Home: open NVENC sessions against
 * the driver cap where NVIDIA reports them, else FFmpeg processes on the GPU.
 */
export function hostGpuEncodes(
    group: Pick<ClusterHostGroup, 'gpus' | 'gpuClients'>,
): { inUse: number; max?: number } | undefined {
    const nv = (group.gpus ?? []).filter((g) => g.encodeSessions !== undefined);
    if (nv.length > 0) {
        const inUse = nv.reduce((sum, g) => sum + (g.encodeSessions ?? 0), 0);
        const caps = nv.map((g) => g.maxEncodeSessions);
        const max = caps.every((c) => c !== undefined && c > 0)
            ? caps.reduce<number>((sum, c) => sum + (c ?? 0), 0)
            : undefined;
        return { inUse, max };
    }
    if ((group.gpus ?? []).length === 0 && group.gpuClients === 0) return undefined;
    return { inUse: group.gpuClients };
}

/** Worst state across a set of services, ignoring `notConfigured`. */
export function worstState(services: ClusterServiceEntry[]): ServiceState {
    const active = services.filter((s) => s.state !== 'notConfigured');
    if (active.length === 0) return 'notConfigured';
    return active.reduce<ServiceState>(
        (worst, s) => (STATE_ORDER[s.state] < STATE_ORDER[worst] ? s.state : worst),
        'healthy',
    );
}

/** Short display label for a host card: k8s node, configured name, or a short id. */
export function hostLabel(group: ClusterHostGroup): string {
    if (group.host?.name) return group.host.name;
    if (group.nodeName) return group.nodeName;
    const [kind, value] = group.id.split(/:(.*)/s);
    if (kind === 'name') return value;
    return `${kind} ${value?.slice(0, 8) ?? ''}`.trim();
}
