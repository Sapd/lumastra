// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cluster Heartbeat Service
 *
 * Registers each replica in Valkey with a TTL key so crashes are detected
 * automatically via key expiry. One leader node (elected via distributed lock)
 * compares successive SCAN results to detect online/offline transitions and
 * records them in cluster_node_events for the uptime timeline.
 *
 * Known failure modes (accepted degradations, documented for operators):
 * - Full Valkey outage: heartbeat writes and the transition lock both
 *   fail-soft, so NO offline events are recorded for any node until Valkey
 *   recovers (a failed acquireLock is indistinguishable from "a peer is
 *   leader"). Liveness consumers degrade too — notably connection-budget
 *   falls back to replicaCount=1 on every replica, over-allocating the DB
 *   pool in a multi-replica cluster exactly while Valkey is down.
 * - Event-loop stall / GC pause > ~20s: the 30s-TTL key (renewed every 10s)
 *   can lapse between ticks, producing a false offline→online pair for a
 *   node that never died. The zero-set guard in detectTransitions only
 *   covers total wipes (Valkey restart), not single-key expiry.
 * - Unpinned INSTANCE_ID: each restart mints a new random-suffixed ID, so
 *   restarts appear as a fresh node coming online while the old ID ages out
 *   as a dead one. Pin INSTANCE_ID per replica for a stable timeline.
 */

import { publishPlaybackPressure } from '../tasks/playback-pressure.js';

import { dirname } from 'node:path';
import type postgres from 'postgres';
import type { NodeEventInsert } from '../database/queries/cluster-nodes.queries.js';
import { Logger } from '../utils/logger.js';
import {
    cacheSet,
    cacheGet,
    cacheDel,
    getKeysByPattern,
    scanKeysOrThrow,
    acquireLock,
    renewLock,
    releaseLock,
    isCoordinationValkeyReady,
    isCoordinationValkeyHealthy,
    getKeyTtlSeconds,
} from '../cache/valkey.js';
import { config } from '../config.js';
import { resolveTaskProcessRole } from '../task-role.js';
import { getMasterKeyFingerprint } from '../crypto/master-key.js';
import {
    readPlacement,
    ResourceSampler,
    type NodePlacement,
    type NodeResources,
} from './cluster-node-runtime.js';
import {
    HostMetricsSampler,
    parseHostInfo,
    parseImplementation,
    parseProcessInfo,
    sampleHostMetricsSafe,
    type HostInfo,
    type ProcessInfo,
    type ServiceImplementation,
} from '../../../shared/host-metrics.js';
import type { HeartbeatRuntimeState } from './worker-runtime-reason.js';
import { runNvidiaSmi } from '../../../shared/gpu-metrics.js';
import { getGpuAccessSummary, type GpuAccessSummary } from './transcoding/gpu-access-probe.js';

const logger = Logger.for('ClusterHeartbeat');

export type NodeRole = 'web' | 'worker' | 'proxy' | 'general';

export interface HeartbeatPayload {
    instanceId: string;
    role: NodeRole;
    version: string;
    startedAt: string;
    hostname: string;
    /**
     * Non-secret fingerprint of this node's master key. Published for the same
     * reason as `version`: so a mismatch between replicas is detectable instead
     * of manifesting as unexplained runtime failures. Empty when no key
     * resolves — compare only non-empty values.
     */
    keyFingerprint: string;
    /** Kubernetes node / pod IP / namespace (Downward API). Absent outside Kubernetes. */
    placement?: NodePlacement;
    /** CPU and memory against the cgroup limits. Absent when no cgroup is readable. */
    resources?: NodeResources;
    /** When this beat was written. Lets the reader flag a beat that stopped renewing before its TTL ran out. */
    sentAt?: string;
    /** Which runtime runs the service ('node' here; the Rust proxy writes 'rust'). */
    implementation?: ServiceImplementation;
    /** The machine this service runs on, shared by every service on it (src/shared/host-metrics.ts). */
    host?: HostInfo;
    /** This process (plus its direct children, e.g. the worker's Rust watcher). */
    process?: ProcessInfo;
    /**
     * Dedicated-worker runtime state (upgrade, consumers, watcher, lease). Absent on web
     * nodes and on builds that predate it; readers must treat every field as optional.
     */
    runtime?: HeartbeatRuntimeState;
    /**
     * Configured hardware encoder and whether this process can use it (cached test
     * encode, refreshed every 30 min). Absent with GPU_ACCELERATION=none, until the
     * first probe finished, and on builds that predate it.
     */
    gpuAccess?: GpuAccessSummary;
}

export interface NodeTransition {
    instanceId: string;
    eventType: 'online' | 'offline';
    /** Leader-detected key changes only; the node's own start/stop rows are written elsewhere. */
    reason?: 'missing' | 'returned';
    role?: string;
    version?: string;
    hostname?: string;
}

const HEARTBEAT_KEY_PREFIX = 'cluster:node:';
export const HEARTBEAT_TTL_SECONDS = 30;
const HEARTBEAT_INTERVAL_MS = 10_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// `lock:` prefix routes this to the noeviction coordination Valkey instance
// (COORDINATION_KEY_PREFIXES). `cluster:node:` is coordination-prefixed but the
// bare `cluster:` is not, so without `lock:` this distributed lock would land on
// the evictable cache instance and eviction could let two replicas run the
// transition detector concurrently.
const TRANSITION_LOCK_KEY = 'lock:cluster:transition-detector';
const TRANSITION_LOCK_TTL = 30;

/**
 * Returns the set of instance IDs currently claiming to be alive, based on
 * Valkey heartbeat keys.
 *
 * Throws when Valkey is unavailable OR when the SCAN cursor encounters an
 * error OR when this replica is absent from the live set. Callers MUST
 * treat a thrown error as "unknown liveness" — never as "empty cluster".
 * The sole current caller is the startup play-session crash-grace logic in
 * `hooks.server.ts`, which uses the live count to decide whether in-flight
 * play_sessions may belong to a still-running sibling replica (rolling
 * deploy) and deserve a grace window instead of being force-crashed.
 * Silently collapsing a SCAN failure into an empty set would make that
 * caller (and any future reclaim-style caller) treat every peer as dead
 * on any transient Valkey hiccup.
 *
 * We use {@link scanKeysOrThrow} rather than the general-purpose
 * {@link getKeysByPattern} helper, because the latter swallows SCAN errors
 * and returns `[]` for any failure mode — exactly the dangerous behaviour
 * this function exists to prevent. {@link scanKeysOrThrow} lets every error
 * propagate.
 *
 * The self-presence sanity check is load-bearing: we are by definition a
 * live replica (this function only runs inside a live process) and should
 * have written our own heartbeat key already. If we are absent from the
 * returned set, Valkey is answering from stale state (e.g. the heartbeat
 * service has not written its first key yet, or a replication lag on a
 * cluster setup). Treat as unknown — callers fall back to the PTTL path.
 *
 * Heartbeat TTL is 30s, renewed every 10s, so the set reflects replicas
 * that have checked in within the last 30s window.
 */
export async function getLiveInstanceIds(): Promise<Set<string>> {
    // L3 — `isCoordinationValkeyReady()` is a synchronous presence check that remains
    // true through network partitions and ioredis reconnect storms. For the
    // reclaim path we need a genuine round-trip guarantee; `isCoordinationValkeyHealthy`
    // sends PING with a short timeout and returns false on ANY failure.
    // Fail-close to a thrown error — the caller falls back to PTTL, which
    // is the safe default when liveness is unknown.
    if (!isCoordinationValkeyReady()) {
        throw new Error('Valkey not ready — cannot enumerate live instances');
    }
    if (!(await isCoordinationValkeyHealthy())) {
        throw new Error('Valkey health check failed — cannot enumerate live instances');
    }

    // Enumerate peers via SCAN. Do NOT rely on SCAN to surface self.
    //
    // Observed on preprod (confirmed across multiple deploys): Valkey's
    // SCAN does not reliably include the just-SET self heartbeat key,
    // even seconds later. The heartbeat service's own `detectTransitions`
    // sees live=1 (or 2) immediately after `writeHeartbeat()`, and every
    // retry / direct EXISTS probe we layered on top still failed to
    // confirm self's presence at startup. Valkey-glide appears to buffer
    // or snapshot reads in a way that makes self-read immediately after
    // self-write unreliable.
    //
    // Resolution: we ARE the caller. If this code is executing we're a
    // live replica by definition — add self unconditionally. SCAN remains
    // the authoritative source for peer liveness (proven to work for
    // peers). Health check above (isCoordinationValkeyHealthy PING) already confirms
    // the connection is responsive, so an empty SCAN result genuinely
    // means no peers (not stale data).
    //
    // Fail-closed on connection problems is preserved via the ready/
    // healthy checks at the top of this function.
    // scanKeysOrThrow (NOT getKeysByPattern): a SCAN failure here must
    // propagate, never collapse into `[]`. An empty set would be read by the
    // session crash-grace path as "no peers alive" and force-crash play
    // sessions a sibling replica still owns, on a transient Valkey hiccup.
    const keys = await scanKeysOrThrow(`${HEARTBEAT_KEY_PREFIX}*`);
    const liveIds = new Set(keys.map((k) => k.slice(HEARTBEAT_KEY_PREFIX.length)));
    liveIds.add(config.INSTANCE_ID);
    return liveIds;
}

/**
 * Derives node role from existing config flags.
 * Proxy detection takes precedence over worker mode.
 */
export function deriveNodeRole(): NodeRole {
    if (config.STREAM_PROXY_MODE) return 'proxy';
    return resolveTaskProcessRole(config.WORKER_MODE, config.DEDICATED_WORKER);
}

/** One live cluster node, parsed from its Valkey heartbeat key. */
export interface LiveClusterNode {
    instanceId: string;
    role: NodeRole;
    version: string;
    hostname: string;
    startedAt: string;
    uptimeSeconds: number;
    /** '' on nodes running a build that predates the field, or with no key. */
    keyFingerprint: string;
    placement?: NodePlacement;
    resources?: NodeResources;
    sentAt?: string;
    /**
     * Age of the latest beat by Valkey's clock (key TTL vs HEARTBEAT_TTL_SECONDS),
     * whole seconds. Only with `withHeartbeatAge`; immune to clock skew between hosts.
     */
    heartbeatAgeMs?: number;
    implementation?: ServiceImplementation;
    host?: HostInfo;
    process?: ProcessInfo;
    runtime?: HeartbeatRuntimeState;
    gpuAccess?: GpuAccessSummary;
    /** Live TV proxy only: app↔proxy protocol (src/shared/livetv-proxy-protocol.ts). */
    proxyProtocol?: number;
    /** Live TV proxy only: build id of its proxy code. */
    proxyBuild?: string;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A limit or request: 0 would mean "nothing allowed", so it is treated as absent. */
function optionalPositive(value: unknown): number | undefined {
    const n = optionalNumber(value);
    return n !== undefined && n > 0 ? n : undefined;
}

/** Validates the optional placement block of a heartbeat payload written by any build. */
function parsePlacement(raw: unknown): NodePlacement | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const r = raw as Record<string, unknown>;
    const placement: NodePlacement = {
        nodeName: optionalString(r.nodeName),
        podIp: optionalString(r.podIp),
        namespace: optionalString(r.namespace),
    };
    return placement.nodeName || placement.podIp || placement.namespace ? placement : undefined;
}

/** Validates the optional resources block; memoryUsedBytes is the one required field. */
function parseResources(raw: unknown): NodeResources | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const r = raw as Record<string, unknown>;
    const memoryUsedBytes = optionalNumber(r.memoryUsedBytes);
    if (memoryUsedBytes === undefined) return undefined;
    return {
        memoryUsedBytes,
        memoryAnonBytes: optionalNumber(r.memoryAnonBytes),
        memoryFileBytes: optionalNumber(r.memoryFileBytes),
        memoryActiveFileBytes: optionalNumber(r.memoryActiveFileBytes),
        memoryInactiveFileBytes: optionalNumber(r.memoryInactiveFileBytes),
        memoryShmemBytes: optionalNumber(r.memoryShmemBytes),
        memorySlabBytes: optionalNumber(r.memorySlabBytes),
        memoryFileDirtyBytes: optionalNumber(r.memoryFileDirtyBytes),
        memoryLimitBytes: optionalPositive(r.memoryLimitBytes),
        memoryPeakBytes: optionalNumber(r.memoryPeakBytes),
        memoryFileWritebackBytes: optionalNumber(r.memoryFileWritebackBytes),
        memoryUnevictableBytes: optionalNumber(r.memoryUnevictableBytes),
        memoryPressureBytes: optionalNumber(r.memoryPressureBytes),
        memoryReclaimableFileBytes: optionalNumber(r.memoryReclaimableFileBytes),
        memoryPressurePeakBytes: optionalNumber(r.memoryPressurePeakBytes),
        memoryOomKills: optionalNumber(r.memoryOomKills),
        memoryRequestBytes: optionalPositive(r.memoryRequestBytes),
        cpuUsedCores: optionalNumber(r.cpuUsedCores),
        cpuLimitCores: optionalPositive(r.cpuLimitCores),
        cpuRequestCores: optionalPositive(r.cpuRequestCores),
    };
}

/** Validates the optional gpuAccess block; anything malformed reads as absent. */
export function parseGpuAccess(raw: unknown): GpuAccessSummary | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const r = raw as Record<string, unknown>;
    const configured = optionalString(r.configured);
    if (!configured || typeof r.accessible !== 'boolean' || configured.length > 32)
        return undefined;
    const capabilities = Array.isArray(r.capabilities)
        ? r.capabilities
              .filter((c): c is string => typeof c === 'string' && c.length <= 64)
              .slice(0, 16)
        : undefined;
    const name = optionalString(r.name);
    const error = optionalString(r.error);
    return {
        configured,
        accessible: r.accessible,
        ...(name && name.length <= 128 ? { name } : {}),
        ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
        ...(error ? { error: error.slice(0, 200) } : {}),
    };
}

/** Validates the optional runtime block; unknown or malformed pieces are dropped, never thrown on. */
export function parseRuntime(raw: unknown): HeartbeatRuntimeState | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const r = raw as Record<string, unknown>;
    const runtime: HeartbeatRuntimeState = {};
    const upgradeState = optionalString(r.upgradeState);
    if (upgradeState) runtime.upgradeState = upgradeState;
    const c = r.consumers as Record<string, unknown> | undefined;
    if (c && typeof c === 'object') {
        const running = optionalNumber(c.running);
        const paused = optionalNumber(c.paused);
        if (running !== undefined && paused !== undefined) {
            runtime.consumers = {
                running,
                paused,
                lastProgressAt: optionalString(c.lastProgressAt),
            };
        }
    }
    const w = r.watcher as Record<string, unknown> | undefined;
    if (w && typeof w === 'object') {
        const state = optionalString(w.state);
        if (state)
            runtime.watcher = {
                state,
                restarts: optionalNumber(w.restarts) ?? 0,
                coverage: optionalString(w.coverage),
            };
    }
    const l = r.lease as Record<string, unknown> | undefined;
    if (l && typeof l === 'object' && typeof l.held === 'boolean') {
        runtime.lease = { held: l.held, lastRenewAt: optionalString(l.lastRenewAt) };
    }
    runtime.lastTickAt = optionalString(r.lastTickAt);
    runtime.uncaughtExceptions = optionalNumber(r.uncaughtExceptions);
    return Object.values(runtime).some((v) => v !== undefined) ? runtime : undefined;
}

/**
 * True when live nodes disagree about the master key.
 *
 * Only non-empty fingerprints are compared: a node that publishes '' either has
 * no resolvable key or predates this field, and treating that as a mismatch
 * would fire on every rolling deploy. A single distinct value — the normal
 * case, including a single-node install — is agreement.
 */
export function hasMasterKeyDivergence(nodes: LiveClusterNode[]): boolean {
    const seen = new Set(nodes.map((n) => n.keyFingerprint).filter((fp) => fp !== ''));
    return seen.size > 1;
}

/**
 * Reads the live cluster nodes from Valkey heartbeat keys (`cluster:node:*`),
 * parsing each payload into a {@link LiveClusterNode}. Shared by the
 * `/api/admin/cluster` route and the Slice-4 `/api/admin/task-system/now`
 * snapshot so both single-source the same SCAN + parse logic rather than
 * re-implementing it (avoids the Theme-F drift the audit flags).
 *
 * Best-effort: a malformed payload is skipped (logged at warn), and a Valkey
 * failure surfaces as the empty array via {@link getKeysByPattern}'s own
 * swallow — callers treat that as "no nodes known", never a 500.
 */
export async function readClusterNodes(
    options: { withHeartbeatAge?: boolean } = {},
): Promise<LiveClusterNode[]> {
    const keys = await getKeysByPattern(`${HEARTBEAT_KEY_PREFIX}*`);
    const now = Date.now();
    const nodes: LiveClusterNode[] = [];

    for (const key of keys) {
        try {
            const raw = await cacheGet(key);
            if (!raw) continue;
            const payload = JSON.parse(raw) as {
                instanceId: string;
                role: string;
                version: string;
                startedAt: string;
                hostname: string;
                keyFingerprint?: string;
                placement?: unknown;
                resources?: unknown;
                sentAt?: unknown;
                implementation?: unknown;
                host?: unknown;
                process?: unknown;
                runtime?: unknown;
                gpuAccess?: unknown;
                proxyProtocol?: unknown;
                proxyBuild?: unknown;
            };
            const startedAtMs = new Date(payload.startedAt).getTime();
            const uptimeSeconds = Math.floor((now - startedAtMs) / 1000);
            nodes.push({
                instanceId: payload.instanceId,
                role: payload.role as NodeRole,
                version: payload.version,
                hostname: payload.hostname,
                startedAt: payload.startedAt,
                uptimeSeconds,
                // Optional on read: during a rolling deploy some nodes still
                // run a build that never wrote this field.
                keyFingerprint: payload.keyFingerprint ?? '',
                placement: parsePlacement(payload.placement),
                resources: parseResources(payload.resources),
                sentAt: optionalString(payload.sentAt),
                implementation: parseImplementation(payload.implementation),
                host: parseHostInfo(payload.host),
                process: parseProcessInfo(payload.process),
                runtime: parseRuntime(payload.runtime),
                gpuAccess: parseGpuAccess(payload.gpuAccess),
                proxyProtocol:
                    typeof payload.proxyProtocol === 'number' &&
                    Number.isInteger(payload.proxyProtocol) &&
                    payload.proxyProtocol >= 0
                        ? payload.proxyProtocol
                        : undefined,
                proxyBuild:
                    typeof payload.proxyBuild === 'string' &&
                    /^[0-9a-f]{16}$/.test(payload.proxyBuild)
                        ? payload.proxyBuild
                        : undefined,
            });
            if (options.withHeartbeatAge) {
                // Every producer (web/worker, TS and Rust proxy) writes the key with
                // the same 30 s TTL and renews it per beat, so the TTL left is the age.
                const ttl = await getKeyTtlSeconds(key);
                if (ttl >= 0 && ttl <= HEARTBEAT_TTL_SECONDS) {
                    nodes[nodes.length - 1].heartbeatAgeMs = (HEARTBEAT_TTL_SECONDS - ttl) * 1000;
                }
            }
        } catch (err) {
            logger.warn('Failed to parse heartbeat payload', {
                key,
                error: String(err),
            });
        }
    }

    return nodes;
}

export class ClusterHeartbeatService {
    private intervalHandle: ReturnType<typeof setInterval> | null = null;
    private lastKnownNodes: Set<string> = new Set();
    /**
     * Role/version/hostname of every node the leader has seen live, so an
     * `offline` (missing) event can still say what died once its key is gone.
     * Without it a node that never recorded its own start (the stream proxy) or
     * was already live when this leader took over had a role-less offline row.
     */
    private nodeMeta = new Map<string, Pick<NodeTransition, 'role' | 'version' | 'hostname'>>();
    private lastPruneAt = 0;
    private readonly startedAt = new Date().toISOString();
    private sql: postgres.Sql | null = null;
    private lockValue: string | null = null; // transition detector leader lock
    private readonly instanceIdOverride?: string;
    private readonly versionOverride?: string;
    private readonly resourceSampler = new ResourceSampler();
    private readonly placement = readPlacement();
    private hostMetrics: HostMetricsSampler | null = null;
    /** The in-flight or finished start, shared by concurrent start() callers. */
    private startPromise: Promise<void> | null = null;

    /**
     * The singleton (`clusterHeartbeatService`) derives identity from `config`
     * and `config`. The optional overrides exist so tests can construct an
     * isolated instance with a fixed identity without mutating global config.
     */
    constructor(instanceId?: string, version?: string) {
        this.instanceIdOverride = instanceId;
        this.versionOverride = version;
    }

    private get instanceId(): string {
        return this.instanceIdOverride ?? config.INSTANCE_ID;
    }

    private get version(): string {
        if (this.versionOverride !== undefined) return this.versionOverride;
        // config.APP_VERSION === config.buildInfo.version — the git-describe string
        // (CI build-arg in prod; injected by vite.config.ts in dev). Commit-level
        // differences between nodes now surface as a version mismatch, which is intended.
        return config.APP_VERSION;
    }

    private get hostname(): string {
        return config.HOSTNAME;
    }

    /**
     * Starts the heartbeat loop and initializes the transition detector.
     * Writes the first heartbeat synchronously before scheduling the interval
     * so the node appears live immediately on startup.
     */
    async start(sql?: postgres.Sql | null): Promise<void> {
        // SQL may have been provided by a prior call — only update when the
        // caller actually supplies one. Assigned before the idempotency check so
        // a later caller's handle is kept even while an earlier start runs.
        if (sql) {
            this.sql = sql;
        }
        // Idempotent and concurrency-safe: the plugin-init chain calls `start()`
        // before `initSchedulers()` (so the ghost-job reclaim sweep sees a live
        // heartbeat set) and a fire-and-forget IIFE in `hooks.server.ts` calls it
        // again as defensive redundancy, possibly while the first is still
        // awaiting. Every caller awaits the same start, so none returns before
        // the first heartbeat and no second interval is ever registered.
        this.startPromise ??= this.doStart().catch((err: unknown) => {
            this.startPromise = null;
            throw err;
        });
        return this.startPromise;
    }

    private async doStart(): Promise<void> {
        logger.info('ClusterHeartbeat starting', {
            instanceId: this.instanceId,
            role: deriveNodeRole(),
        });
        // Before the first heartbeat write: once our key exists the leader may
        // record 'online' itself, and recordInstanceStart would then misread that
        // as a previous run that never recorded its exit.
        await this.recordStart();
        await this.tick();
        this.intervalHandle = setInterval(() => void this.tick(), HEARTBEAT_INTERVAL_MS);
    }

    /**
     * Stops the heartbeat loop, deletes the Valkey key, and releases the
     * transition detector lock if this node was the leader.
     */
    async stop(): Promise<void> {
        // Let an in-flight start finish first, or its setInterval would be
        // registered after this clear and keep ticking.
        if (this.startPromise) {
            await this.startPromise.catch(() => undefined);
            this.startPromise = null;
        }
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        // Record own offline event directly — in single-replica clusters there's
        // no other leader to detect the disappearance after shutdown.
        if (this.sql) {
            try {
                const { insertNodeEvent } =
                    await import('../database/queries/cluster-nodes.queries.js');
                await insertNodeEvent(this.sql, {
                    instanceId: this.instanceId,
                    eventType: 'offline',
                    role: deriveNodeRole(),
                    version: this.version,
                    hostname: this.hostname,
                    reason: 'stop',
                });
            } catch (err) {
                logger.warn('Failed to record graceful offline event', {
                    error: String(err),
                });
            }
        }
        try {
            await cacheDel(`${HEARTBEAT_KEY_PREFIX}${this.instanceId}`);
        } catch (err) {
            logger.warn('Failed to delete heartbeat key during shutdown', {
                error: String(err),
            });
        }
        if (this.lockValue) {
            try {
                await releaseLock(TRANSITION_LOCK_KEY, this.lockValue);
            } catch (err) {
                logger.warn('Failed to release transition lock during shutdown', {
                    error: String(err),
                });
            }
            this.lockValue = null;
        }
        logger.info('ClusterHeartbeat stopped', {
            instanceId: this.instanceId,
        });
    }

    /**
     * Registers this process's start in cluster_node_events, backfilling an
     * 'offline' for a previous run with the same INSTANCE_ID that died unseen
     * (see recordInstanceStart). This is what makes restart counts work for a
     * pod that is OOM-killed and back within the 30 s heartbeat TTL, and for a
     * single-replica install where no leader is left to notice the gap.
     * Fail-soft: the leader's key-diff still records transitions without it.
     */
    private async recordStart(): Promise<void> {
        if (!this.sql) return;
        try {
            const { recordInstanceStart } =
                await import('../database/queries/cluster-nodes.queries.js');
            const kind = await recordInstanceStart(this.sql, {
                instanceId: this.instanceId,
                role: deriveNodeRole(),
                version: this.version,
                hostname: this.hostname,
            });
            if (kind === 'restart_unclean') {
                logger.warn('Previous run of this instance ended without a graceful shutdown', {
                    instanceId: this.instanceId,
                });
            }
        } catch (err) {
            logger.warn('Failed to record instance start', { error: String(err) });
        }
    }

    /** Reads and caches a live node's role/version/hostname (fields absent when unreadable). */
    private async rememberMeta(
        id: string,
    ): Promise<Pick<NodeTransition, 'role' | 'version' | 'hostname'>> {
        let meta: Partial<HeartbeatPayload> = {};
        const raw = await cacheGet(`${HEARTBEAT_KEY_PREFIX}${id}`);
        if (raw) {
            try {
                meta = JSON.parse(raw) as HeartbeatPayload;
            } catch {
                /* ignore */
            }
        }
        const picked = { role: meta.role, version: meta.version, hostname: meta.hostname };
        this.nodeMeta.set(id, picked);
        return picked;
    }

    private async tick(): Promise<void> {
        try {
            await this.writeHeartbeat();
            await this.detectTransitions();
        } catch (err) {
            logger.warn('Heartbeat tick failed', { error: String(err) });
        }
    }

    /** Lazy so the config getters run after config is loaded, not at import. */
    private hostMetricsSampler(): HostMetricsSampler {
        this.hostMetrics ??= new HostMetricsSampler({
            implementation: 'node',
            // Intel figures come from sysfs; nvidia-smi is a spawn, so only where NVENC is used.
            nvidiaSmi: config.GPU_ACCELERATION === 'nvenc' ? () => runNvidiaSmi() : undefined,
            nvencMaxSessionsEnv: process.env.NVENC_MAX_SESSIONS,
            disks: [
                // The parent of the preview cache is the persistent cache volume (/config/cache).
                { role: 'cache' as const, path: config.PREVIEW_CACHE_DIR },
                { role: 'transcode' as const, path: config.FFMPEG_TRANSCODE_DIR },
            ]
                .filter((d) => typeof d.path === 'string' && d.path !== '')
                .map((d) => (d.role === 'cache' ? { ...d, path: dirname(d.path) } : d)),
        });
        return this.hostMetrics;
    }

    /**
     * Supplied by the dedicated task runtime (web nodes have none). A provider that
     * throws only costs the optional block, never the heartbeat itself.
     */
    setRuntimeStateProvider(provider: (() => HeartbeatRuntimeState | undefined) | undefined): void {
        this.runtimeStateProvider = provider;
    }

    private runtimeStateProvider: (() => HeartbeatRuntimeState | undefined) | undefined;

    private readRuntimeState(): HeartbeatRuntimeState | undefined {
        try {
            return this.runtimeStateProvider?.();
        } catch (err) {
            logger.warn('Runtime state provider failed', { error: String(err) });
            return undefined;
        }
    }

    private readGpuAccess(): GpuAccessSummary | undefined {
        try {
            return getGpuAccessSummary();
        } catch (err) {
            logger.debug('GPU access summary failed', { error: String(err) });
            return undefined;
        }
    }

    private async writeHeartbeat(): Promise<void> {
        void publishPlaybackPressure(this.instanceId);
        const payload: HeartbeatPayload = {
            instanceId: this.instanceId,
            role: deriveNodeRole(),
            version: this.version,
            startedAt: this.startedAt,
            hostname: this.hostname,
            keyFingerprint: getMasterKeyFingerprint(),
            placement: this.placement,
            resources: await this.resourceSampler.sample(),
            sentAt: new Date().toISOString(),
            ...(await sampleHostMetricsSafe(this.hostMetricsSampler())),
            runtime: this.readRuntimeState(),
            gpuAccess: this.readGpuAccess(),
        };
        await cacheSet(
            `${HEARTBEAT_KEY_PREFIX}${this.instanceId}`,
            JSON.stringify(payload),
            HEARTBEAT_TTL_SECONDS,
        );
    }

    /**
     * Uses SCAN to read live cluster:node:* keys. KEYS is O(N) and blocks
     * Valkey during key enumeration; SCAN iterates in cursor batches.
     */
    private async detectTransitions(): Promise<void> {
        if (!this.sql) return;

        // Leader election: only one replica detects transitions to avoid duplicate DB writes
        if (this.lockValue) {
            // Already leader — renew the lock
            const renewed = await renewLock(
                TRANSITION_LOCK_KEY,
                this.lockValue,
                TRANSITION_LOCK_TTL,
            );
            if (!renewed) {
                // Lock lost (expired or stolen) — relinquish leadership
                this.lockValue = null;
                this.lastKnownNodes = new Set(); // reset so new leader re-establishes baseline
                this.nodeMeta.clear();
                return;
            }
        } else {
            // Try to become leader
            this.lockValue = await acquireLock(TRANSITION_LOCK_KEY, TRANSITION_LOCK_TTL);
            if (!this.lockValue) return; // another replica is leader, skip
            // Seed baseline from DB's expected-online set (instances whose last event was 'online').
            // This catches nodes that crashed during the leadership gap — their key is already gone
            // from Valkey, but the DB still records them as 'online'. The diff on THIS tick
            // (not the next one) will detect them as offline and record the transition.
            const { getInstancesExpectedOnline } =
                await import('../database/queries/cluster-nodes.queries.js');
            const expectedOnline = await getInstancesExpectedOnline(this.sql);
            const initKeys = await getKeysByPattern(`${HEARTBEAT_KEY_PREFIX}*`);
            const liveIds = new Set(initKeys.map((k) => k.slice(HEARTBEAT_KEY_PREFIX.length)));
            // Merge: baseline = union of DB expected-online and current live keys
            this.lastKnownNodes = new Set([...expectedOnline, ...liveIds]);
            // One read per live node at takeover, so their eventual offline rows carry metadata.
            for (const id of liveIds) await this.rememberMeta(id);
            logger.info('Acquired transition detector leadership', {
                fromDb: expectedOnline.length,
                live: liveIds.size,
            });
            // Don't return — fall through to the diff below so nodes that crashed
            // during the leadership gap get immediate offline events.
        }

        const keys = await getKeysByPattern(`${HEARTBEAT_KEY_PREFIX}*`);
        const currentNodes = new Set(keys.map((k) => k.slice(HEARTBEAT_KEY_PREFIX.length)));

        // Skip if entire set dropped to zero — likely a Valkey restart, not real offline events
        if (currentNodes.size === 0 && this.lastKnownNodes.size > 0) {
            logger.warn(
                'Live node set dropped to zero — skipping offline events (possible Valkey restart)',
            );
            this.lastKnownNodes = currentNodes;
            return;
        }

        const transitions: NodeTransition[] = [];

        // Detect new nodes (online) — read their heartbeat payload for metadata
        for (const id of currentNodes) {
            if (!this.lastKnownNodes.has(id)) {
                const meta = await this.rememberMeta(id);
                transitions.push({
                    instanceId: id,
                    eventType: 'online',
                    reason: 'returned',
                    ...meta,
                });
            }
        }

        // Detect disappeared nodes (offline) — the key is gone; metadata comes from
        // what this leader saw while it was live (none for DB-only baseline entries).
        for (const id of this.lastKnownNodes) {
            if (!currentNodes.has(id)) {
                transitions.push({
                    instanceId: id,
                    eventType: 'offline',
                    reason: 'missing',
                    ...this.nodeMeta.get(id),
                });
            }
        }

        if (transitions.length > 0) {
            const recorded = await this.recordTransition(transitions);
            if (!recorded) {
                // DB write failed — keep the OLD baseline so the next tick
                // recomputes the same diff and retries. Advancing the baseline
                // first (the previous behavior) silently dropped the batch:
                // the transitions were gone from the diff forever, leaving
                // e.g. a dead node recorded as expected-online until the
                // 30-day prune aged its history out.
                return;
            }
        }
        for (const id of this.nodeMeta.keys()) {
            if (!currentNodes.has(id)) this.nodeMeta.delete(id);
        }
        this.lastKnownNodes = currentNodes;
    }

    /**
     * Persists a batch of detected transitions atomically and coordinates the
     * hourly retention prune in the same transaction.
     *
     * All transitions detected on a single tick are written together: a single
     * multi-row INSERT inside one transaction (F6). Previously each transition
     * was a separate fire-and-forget statement, so a crash mid-loop left the
     * `cluster_node_events` table holding a partial set of the tick's events —
     * an inconsistent timeline (e.g. a node marked offline but its paired
     * online event lost). The prune runs inside the same transaction so it is
     * coordinated with the inserts rather than racing them as a detached
     * fire-and-forget promise.
     *
     * Returns true when the batch committed — the caller only advances its
     * node-set baseline on success so a failed write is re-detected and
     * retried on the next tick instead of being dropped.
     */
    private async recordTransition(transitions: NodeTransition[]): Promise<boolean> {
        if (!this.sql || transitions.length === 0) return true;

        const { insertNodeEvent, pruneOldEvents } =
            await import('../database/queries/cluster-nodes.queries.js');

        const events: NodeEventInsert[] = transitions.map((t) => ({
            instanceId: t.instanceId,
            eventType: t.eventType,
            role: t.role,
            version: t.version,
            hostname: t.hostname,
            reason: t.reason,
        }));

        // Hourly prune — decide before opening the transaction so the timer is
        // advanced exactly once even if the batch is large.
        const now = Date.now();
        const shouldPrune = now - this.lastPruneAt >= PRUNE_INTERVAL_MS;
        if (shouldPrune) {
            this.lastPruneAt = now;
        }

        try {
            // eslint-disable-next-line callback-safety/no-direct-sql-begin
            await this.sql.begin(async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;
                await insertNodeEvent(tx, events);
                if (shouldPrune) {
                    await pruneOldEvents(tx, { days: 30 });
                }
            });
            logger.info('Recorded node transitions', {
                count: transitions.length,
            });
            return true;
        } catch (err) {
            // Roll back the prune timer so the next tick retries it; the whole
            // transaction (inserts + prune) was rolled back together.
            if (shouldPrune) {
                this.lastPruneAt = 0;
            }
            logger.warn('Failed to record node transitions', {
                count: transitions.length,
                error: String(err),
            });
            return false;
        }
    }
}

export const clusterHeartbeatService = new ClusterHeartbeatService();
