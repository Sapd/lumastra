// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The install overview at the top of the first-run wizard (see
 * `$lib/shared/setup-environment.ts`). The page is served before any admin
 * exists, so anyone can load it in a loop: everything on the render path is
 * cheap and bounded (config reads, memoised file checks, a Valkey PING and the
 * heartbeat keys /admin/cluster reads, both cached for a few seconds and capped
 * by a timeout, cached sidecar probes, one DB query). The slower part, ffmpeg's
 * capabilities, is streamed separately by {@link buildSetupEnvironmentDetails}
 * and probed once per process.
 */

import { existsSync, readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { getConfigStorageStatus } from '$lib/server/config/config.service.js';
import {
    hasSeparateCoordinationValkey,
    isCoordinationValkeyHealthy,
    isValkeyHealthy,
} from '$lib/server/cache/valkey.js';
import {
    hasMasterKeyDivergence,
    readClusterNodes,
    type LiveClusterNode,
} from '$lib/server/services/cluster-heartbeat.service.js';
import { peekSonicEngineConfigured } from '$lib/server/services/sonic-embedding.service.js';
import { hardwareDetection } from '$lib/server/services/transcoding/hardware-detection.js';
import type { HardwareCapabilities } from '$lib/server/services/transcoding/types.js';
import { getDatabaseVersions } from '$lib/server/database/queries/onboarding.queries.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import { runsOnKubernetes } from '$lib/server/utils/trusted-proxy-ranges.js';
import {
    forwardAuthTrustPosture,
    isForwardedHeaderPeerTrusted,
} from '$lib/server/utils/client-ip.js';
import { hasForwardingHeaders } from '$lib/server/auth/cookie-transport.js';
import type {
    SetupConfigState,
    SetupEnvironment,
    SetupEnvironmentDetails,
    SetupEnvironmentNode,
    SetupGpuMode,
    SetupProxyState,
    SetupSidecarState,
    SetupSonicState,
} from '$lib/shared/setup-environment.js';

const SIDECAR_PROBE_TIMEOUT_MS = 2_000;
const SIDECAR_READY_TTL_MS = 30_000;
/** A sidecar still loading its model turns ready soon after; re-ask sooner. */
const SIDECAR_DOWN_TTL_MS = 5_000;
const CLUSTER_TTL_MS = 5_000;
const CLUSTER_READ_TIMEOUT_MS = 1_500;
const FFMPEG_TIMEOUT_MS = 10_000;
/** Recheck bypasses the caches, but at most this often across all visitors. */
const FRESH_MIN_INTERVAL_MS = 3_000;
const MAX_NODES = 50;
const MAX_MOUNTS = 20;
const MAX_FIELD_LENGTH = 64;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([promise.catch(() => fallback), timeout]).finally(() =>
        clearTimeout(timer),
    );
}

// ---- sidecar containers ----------------------------------------------------

interface SidecarProbe {
    url: string;
    at: number;
    ttl: number;
    ready: Promise<boolean>;
}

/** Keyed by sidecar ('sonic', 'livetv'); one entry each. */
const sidecarProbes = new Map<string, SidecarProbe>();

/** `<base><path>`, tolerating a trailing slash, a query string or credentials in the setting. */
function probeUrl(base: string, path: string): string | null {
    try {
        const url = new URL(base);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
        return url.toString();
    } catch {
        return null;
    }
}

/**
 * One request per sidecar per TTL, however many visitors load the page: 30 s
 * while it answers, 5 s while it does not (a sidecar loading its model turns
 * ready soon after). A changed URL probes again.
 */
function sidecarReady(
    name: string,
    base: string,
    path: string,
    headers: Record<string, string>,
    fresh: boolean,
): Promise<boolean> {
    const now = Date.now();
    const cached = sidecarProbes.get(name);
    if (!fresh && cached && cached.url === base && now - cached.at < cached.ttl) {
        return cached.ready;
    }
    const target = probeUrl(base, path);
    const probe: SidecarProbe = {
        url: base,
        at: now,
        ttl: SIDECAR_READY_TTL_MS,
        ready: Promise.resolve(false),
    };
    probe.ready = (
        target
            ? // No redirects: a redirect would carry the shared secret to another host.
              fetchWithTimeout(
                  target,
                  { method: 'GET', headers, redirect: 'manual' },
                  SIDECAR_PROBE_TIMEOUT_MS,
              )
                  .then(async (res) => {
                      await res.body?.cancel().catch(() => undefined);
                      return res.ok;
                  })
                  .catch(() => false)
            : Promise.resolve(false)
    ).then((ok) => {
        // The TTL runs from the answer, not from the start of a probe that may
        // have spent its whole timeout waiting.
        probe.at = Date.now();
        if (!ok) probe.ttl = SIDECAR_DOWN_TTL_MS;
        return ok;
    });
    sidecarProbes.set(name, probe);
    return probe.ready;
}

async function sonicState(fresh: boolean): Promise<SetupSonicState> {
    const url = config.SONIC_EMBEDDER_URL;
    if (url) {
        return (await sidecarReady('sonic', url, '/health', {}, fresh)) ? 'ready' : 'unreachable';
    }
    // Never the interpreter module check: it is a synchronous spawn of up to 10 s.
    // Unknown (not probed in this process yet) reads as installed: the files are there.
    return peekSonicEngineConfigured() === false ? 'absent' : 'subprocess';
}

/** Live TV stream proxy container: `/status`, which wants the shared secret. */
async function liveTvProxyState(fresh: boolean): Promise<SetupSidecarState> {
    const url = config.STREAM_PROXY_URL;
    if (!url || config.LIVETV_SOURCE === 'disabled') return 'absent';
    const headers: Record<string, string> = config.STREAM_PROXY_SECRET
        ? { 'X-Proxy-Secret': config.STREAM_PROXY_SECRET }
        : {};
    return (await sidecarReady('livetv', url, '/status', headers, fresh)) ? 'ready' : 'unreachable';
}

// ---- static facts (never change while the process runs) ------------------

let staticFacts: { gpuDevice: boolean; platform: SetupEnvironment['network']['platform'] } | null =
    null;

function readStaticFacts(): NonNullable<typeof staticFacts> {
    staticFacts ??= {
        // /dev/dxg is how Docker Desktop (WSL2) hands an NVIDIA GPU to a container with
        // `gpus: all`; there is no /dev/nvidia0 there.
        gpuDevice: ['/dev/dri', '/dev/nvidia0', '/dev/nvidiactl', '/dev/dxg'].some((p) =>
            existsSync(p),
        ),
        platform: runsOnKubernetes()
            ? 'kubernetes'
            : existsSync('/.dockerenv') || existsSync('/run/.containerenv')
              ? 'docker'
              : 'host',
    };
    return staticFacts;
}

const GPU_MODES = new Set<string>(['none', 'nvenc', 'qsv', 'vaapi', 'amf', 'videotoolbox']);

function gpuMode(): SetupGpuMode {
    const value = (config.GPU_ACCELERATION || 'none').toLowerCase();
    return GPU_MODES.has(value) ? (value as SetupGpuMode) : 'other';
}

// ---- storage ---------------------------------------------------------------

async function configState(): Promise<{ state: SetupConfigState; path: string | null }> {
    try {
        const s = await getConfigStorageStatus();
        const state: SetupConfigState = !s.directoryExists
            ? 'missing'
            : !s.isWritable
              ? 'not-writable'
              : !s.isMounted
                ? 'not-mounted'
                : 'ok';
        return { state, path: s.path.replace(/\/[^/]*$/, '') || '/' };
    } catch {
        return { state: 'missing', path: null };
    }
}

/** Kernel and runtime mounts that say nothing about where media or data lives. */
const SYSTEM_FS = new Set([
    'proc', 'sysfs', 'tmpfs', 'devtmpfs', 'devpts', 'mqueue', 'cgroup', 'cgroup2', 'overlay',
    'securityfs', 'debugfs', 'tracefs', 'bpf', 'pstore', 'hugetlbfs', 'configfs', 'fusectl',
    'nsfs', 'autofs', 'binfmt_misc', 'rpc_pipefs', 'shm', 'squashfs',
]); // prettier-ignore
const SYSTEM_PATHS = /^\/(?:proc|sys|dev|run|var\/run|etc)(?:\/|$)/;

/** Mount points from `/proc/self/mountinfo`, minus system and runtime mounts. */
export function parseMountinfo(text: string): string[] {
    const mounts = new Set<string>();
    for (const line of text.split('\n')) {
        const [left, right] = line.split(' - ');
        if (!left || !right) continue;
        const mountPoint = left.split(' ')[4];
        const fsType = right.split(' ')[0];
        if (!mountPoint || mountPoint === '/' || SYSTEM_FS.has(fsType)) continue;
        // mountinfo escapes spaces and the like as \040 octal.
        const path = mountPoint.replace(/\\([0-7]{3})/g, (_, o: string) =>
            String.fromCharCode(Number.parseInt(o, 8)),
        );
        if (SYSTEM_PATHS.test(path)) continue;
        mounts.add(path);
    }
    return [...mounts].sort().slice(0, MAX_MOUNTS);
}

function readMounts(): string[] | undefined {
    try {
        return parseMountinfo(readFileSync('/proc/self/mountinfo', 'utf8'));
    } catch {
        return undefined; // not Linux
    }
}

// ---- cluster ---------------------------------------------------------------

interface ClusterRead {
    valkey: boolean;
    /** Only when TASK_CACHE_URL is a separate instance. */
    valkeyTasks?: boolean;
    live: LiveClusterNode[];
}

let clusterCache: { at: number; read: Promise<ClusterRead> } | null = null;

/** Valkey PING + heartbeat SCAN, shared by every page load for a few seconds and time-boxed. */
function readCluster(now: number, fresh: boolean): Promise<ClusterRead> {
    if (!fresh && clusterCache && now - clusterCache.at < CLUSTER_TTL_MS) return clusterCache.read;
    const split = hasSeparateCoordinationValkey();
    const read = Promise.all([
        isValkeyHealthy().catch(() => false),
        split ? isCoordinationValkeyHealthy().catch(() => false) : Promise.resolve(undefined),
        withTimeout(readClusterNodes(), CLUSTER_READ_TIMEOUT_MS, [] as LiveClusterNode[]),
    ]).then(([valkey, valkeyTasks, live]) => ({ valkey, valkeyTasks, live }));
    clusterCache = { at: now, read };
    return read;
}

const NODE_ROLES = new Set(['web', 'worker', 'proxy', 'general']);

function clip(value: unknown): string {
    return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : '';
}

function positive(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Heartbeats are written by every build in a rolling deploy and parsed without
 * validation, so any field may be missing or odd: drop nodes without an id,
 * de-duplicate ids, and default the rest.
 */
export function toSetupNodes(
    live: LiveClusterNode[],
    selfId: string,
    trustedContext: boolean,
): SetupEnvironmentNode[] {
    const byId = new Map<string, SetupEnvironmentNode>();
    for (const n of live) {
        const instanceId = clip(n.instanceId);
        if (!instanceId || byId.has(instanceId)) continue;
        const uptime = Number(n.uptimeSeconds);
        byId.set(instanceId, {
            instanceId,
            role: NODE_ROLES.has(n.role) ? n.role : 'general',
            version: clip(n.version),
            uptimeSeconds: Number.isFinite(uptime) ? Math.max(0, Math.floor(uptime)) : 0,
            self: instanceId === selfId,
            host: trustedContext ? clip(n.placement?.nodeName) || undefined : undefined,
            memoryLimitBytes: positive(n.resources?.memoryLimitBytes),
            cpuLimitCores: positive(n.resources?.cpuLimitCores),
        });
    }
    // This node first, then by role (general, proxy, web, worker), then by name.
    return [...byId.values()]
        .sort(
            (a, b) =>
                Number(b.self) - Number(a.self) ||
                a.role.localeCompare(b.role) ||
                a.instanceId.localeCompare(b.instanceId),
        )
        .slice(0, MAX_NODES);
}

function clusterWarnings(
    live: LiveClusterNode[],
    nodes: SetupEnvironmentNode[],
): SetupEnvironment['cluster'] {
    const versions = new Set(nodes.map((n) => n.version).filter(Boolean));
    return {
        versionMismatch: versions.size > 1,
        keyMismatch: hasMasterKeyDivergence(
            live.map((n) => ({ ...n, keyFingerprint: clip(n.keyFingerprint) })),
        ),
        noWorker:
            nodes.length > 0 && !nodes.some((n) => n.role === 'worker' || n.role === 'general'),
    };
}

// ---- network ---------------------------------------------------------------

/**
 * How this request reached the app. Forwarding headers only prove a proxy when
 * TRUSTED_PROXY_IPS pins it: without the list any client can send them.
 */
export function setupProxyState(event: {
    request: Request;
    getClientAddress: () => string;
}): SetupProxyState {
    if (!hasForwardingHeaders(event.request.headers)) return 'direct';
    if (forwardAuthTrustPosture() !== 'allowlist') return 'proxy-unpinned';
    return isForwardedHeaderPeerTrusted(() => event.getClientAddress(), event.request)
        ? 'proxy'
        : 'proxy-untrusted';
}

// ---- assembly ----------------------------------------------------------------

export interface SetupEnvironmentInput {
    proxy: SetupProxyState;
    https: boolean;
    /** Show where things are (paths, service URLs, node placement). Only for the operator. */
    trustedContext: boolean;
    sql: postgres.Sql;
    /** Already read by the page load. */
    embeddingDimension: number | null;
    /** Recheck: skip the probe caches (rate-limited across all visitors). */
    fresh?: boolean;
}

let lastFreshAt = 0;

/** Whether this request may bypass the caches: at most once per interval, globally. */
function takeFresh(requested: boolean | undefined, now: number): boolean {
    if (!requested || now - lastFreshAt < FRESH_MIN_INTERVAL_MS) return false;
    lastFreshAt = now;
    return true;
}

/** Test hook. */
export function resetSetupEnvironmentCachesForTests(): void {
    sidecarProbes.clear();
    staticFacts = null;
    clusterCache = null;
    lastFreshAt = 0;
}

export async function buildSetupEnvironment(
    input: SetupEnvironmentInput,
): Promise<SetupEnvironment> {
    const fresh = takeFresh(input.fresh, Date.now());
    const facts = readStaticFacts();
    const [cluster, sonic, liveTvProxy, storage, database] = await Promise.all([
        readCluster(Date.now(), fresh),
        sonicState(fresh),
        liveTvProxyState(fresh),
        configState(),
        getDatabaseVersions(input.sql).catch(() => ({ postgres: '', pgvector: null })),
    ]);
    const nodes = toSetupNodes(cluster.live, config.INSTANCE_ID, input.trustedContext);

    return {
        services: {
            valkey: cluster.valkey,
            ...(cluster.valkeyTasks === undefined ? {} : { valkeyTasks: cluster.valkeyTasks }),
            sonic,
            liveTvProxy,
            gpu: gpuMode(),
            gpuDevice: facts.gpuDevice,
        },
        database: {
            postgres: database.postgres || null,
            pgvector: database.pgvector,
            dimension: input.embeddingDimension,
        },
        storage: {
            config: storage.state,
            configPath: input.trustedContext ? (storage.path ?? undefined) : undefined,
            mounts: input.trustedContext && facts.platform !== 'host' ? readMounts() : undefined,
        },
        nodes,
        cluster: clusterWarnings(cluster.live, nodes),
        network: {
            proxy: input.proxy,
            https: input.https,
            platform: facts.platform,
        },
    };
}

/**
 * The slower half, streamed after the page renders: ffmpeg's version and
 * hardware accelerators, probed once per process and then cached.
 */
export async function buildSetupEnvironmentDetails(): Promise<SetupEnvironmentDetails> {
    const TIMED_OUT = Symbol('timed-out');
    // A failed probe reads as missing; only the timeout means "still checking".
    const probe = hardwareDetection
        .getCapabilities()
        .catch((): HardwareCapabilities | null => null);
    const caps = await withTimeout<HardwareCapabilities | null | typeof TIMED_OUT>(
        probe,
        FFMPEG_TIMEOUT_MS,
        TIMED_OUT,
    );
    // The first probe keeps running (and is shared) after the timeout.
    if (caps === TIMED_OUT) return { ffmpeg: null, ffmpegPending: true };
    // A missing ffmpeg is not an error to the probe: it reports version 'unknown'.
    const version = caps?.ffmpegVersion;
    return {
        ffmpeg:
            version && version !== 'unknown'
                ? { version, hwaccels: [...caps.hwaccels].sort() }
                : null,
    };
}
