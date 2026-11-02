// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the first-run wizard shows about the install before anything is set up:
 * which optional services are there, which nodes are running, where data is
 * stored and how requests reach the app. Built by `src/routes/setup/setup-environment.ts`.
 *
 * Disclosure rule: the page is served before any admin exists, so whoever sees
 * it can claim the install anyway. Statuses, versions and node ids go to every visitor;
 * WHERE things are (paths, service URLs, Kubernetes node names) only to a
 * trusted context, the same gate as the config path in the backup nudge.
 */

/** Music sonic embedder: HTTP sidecar up, configured but not answering, local subprocess, or none. */
export type SetupSonicState = 'ready' | 'unreachable' | 'subprocess' | 'absent';

/** A sibling container: answering, configured but not answering, or not set up. */
export type SetupSidecarState = 'ready' | 'unreachable' | 'absent';

/**
 * How requests reach the app:
 * - `proxy`           — a proxy listed in TRUSTED_PROXY_IPS forwarded this request.
 * - `proxy-unpinned`  — forwarding headers, but TRUSTED_PROXY_IPS is unset, so any client could send them.
 * - `proxy-untrusted` — forwarding headers from a peer outside TRUSTED_PROXY_IPS; they are ignored.
 * - `direct`          — no forwarding headers: the browser talks to the app directly.
 */
export type SetupProxyState = 'proxy' | 'proxy-unpinned' | 'proxy-untrusted' | 'direct';

/** Config volume: settings persist, or why they would not. */
export type SetupConfigState = 'ok' | 'missing' | 'not-writable' | 'not-mounted';

export type SetupGpuMode = 'none' | 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'videotoolbox' | 'other';

export interface SetupEnvironmentNode {
    instanceId: string;
    role: 'web' | 'worker' | 'proxy' | 'general';
    /** '' when the heartbeat did not carry one. */
    version: string;
    uptimeSeconds: number;
    /** The replica that rendered this page. */
    self: boolean;
    /** Kubernetes node the pod runs on. Only in a trusted context. */
    host?: string;
    /** cgroup limits, when the node has any. */
    memoryLimitBytes?: number;
    cpuLimitCores?: number;
}

export interface SetupEnvironment {
    services: {
        /** The cache instance (CACHE_URL); also tasks when there is only one. */
        valkey: boolean;
        /** The task/coordination instance (TASK_CACHE_URL); absent when it is the same as the cache. */
        valkeyTasks?: boolean;
        sonic: SetupSonicState;
        /** Live TV stream proxy container (STREAM_PROXY_URL). */
        liveTvProxy: SetupSidecarState;
        /** GPU_ACCELERATION; 'none' = software transcoding. */
        gpu: SetupGpuMode;
        /** A GPU device node is visible to this container (/dev/dri or /dev/nvidia*). */
        gpuDevice: boolean;
    };
    database: {
        /** e.g. "18.1"; null when it could not be read. */
        postgres: string | null;
        pgvector: string | null;
        /** Locked embedding dimension of the vector column. */
        dimension: number | null;
    };
    storage: {
        config: SetupConfigState;
        /** Config directory. Only in a trusted context. */
        configPath?: string;
        /** Folders mounted into this container. Only in a trusted context, and not on a bare host. */
        mounts?: string[];
    };
    /** Live nodes from the cluster heartbeats; empty when Valkey is down. */
    nodes: SetupEnvironmentNode[];
    cluster: {
        /** Live nodes run different versions. */
        versionMismatch: boolean;
        /** Live nodes have different master keys: secrets saved on one cannot be read on another. */
        keyMismatch: boolean;
        /** Nodes are live, but none runs background tasks (all web/proxy). */
        noWorker: boolean;
    };
    network: {
        proxy: SetupProxyState;
        https: boolean;
        platform: 'kubernetes' | 'docker' | 'host';
    };
}

/** The slower part of the overview, streamed after the page renders. */
export interface SetupEnvironmentDetails {
    /** null when ffmpeg could not be run (or is still being probed, see ffmpegPending). */
    ffmpeg: { version: string; hwaccels: string[] } | null;
    /** The first ffmpeg probe is slower than the page wants to wait; Recheck shows it later. */
    ffmpegPending?: boolean;
}
