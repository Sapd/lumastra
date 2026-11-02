// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Playback telemetry lives in TASK Valkey, shared by web pods and workers.
 * This is a concurrency reduction, never a global task pause. On-demand
 * trickplay providers don't enter the background task execution scope.
 * Live TV proxy encodes and offline cacheKey/outputDir renditions aren't counted.
 */
import { parseCpuPressure, readCpuPressurePercent } from '../services/cluster-node-runtime.js';
import { cpus, loadavg } from 'node:os';
import { config } from '$lib/server/config.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import type { ValkeyLike } from './valkey-types.js';

export const PRESSURE_TTL_SECONDS = 30;
export const PRESSURE_RETRY_MS = 10_000;
export const MAX_PLAYBACK_DEFERRAL_MS = 15 * 60_000;
export const PRESSURE_HOLD_MS = 60_000;
export const MIN_BACKGROUND_RUN_MS = 120_000;
const PREFIX = 'v2:playback-pressure:';
const INDEX_KEY = 'v2:playback-pressure-publishers';
const STATE_KEY = 'v2:background-cpu-playback-state';
const SLOT_KEY = 'v2:background-cpu-playback-slot';
const DEFERRED_KEY = 'v2:background-cpu-playback-deferred';
const SLOT_SECONDS = 60;

export interface PlaybackCounts {
    cpuTranscodes: number;
    gpuTranscodes: number;
    activeSessions: number;
}
export interface PlaybackPressureSample extends PlaybackCounts {
    loadRatioPerCore: number;
    /** Cgroup v2 CPU PSI some avg10, percent of wall time stalled. */
    cpuPressurePercent?: number;
    sampledAt: number;
}
export interface PressureState {
    limited: boolean;
    holdUntil: number;
    resumedAt?: number;
}
export interface PlaybackPressureStatus extends PlaybackCounts {
    /** Historical API field: means concurrency limited to one, NOT globally paused. */
    paused: boolean;
    reason: 'cpu_transcode' | 'pod_pressure' | 'host_load' | 'cooloff' | 'minimum_run' | 'none';
    loadRatioPerCore: number;
    cpuPressurePercent?: number;
    threshold: number;
    resumeThreshold: number;
    deferredMinutes: number;
    state: PressureState;
}
export interface PlaybackEncodeJob {
    config: {
        isPreview?: boolean;
        cacheKey?: string;
        outputDir?: string;
        softwareEncodeFallback?: string;
    };
    generationRole: string;
    status: string;
    throttlePaused?: boolean;
    parked?: string;
    lastSegmentRequestedAt?: number;
    process: { killed: boolean; exitCode: number | null; signalCode?: string | null } | null;
    transcodeDecisionResult?: { videoAction: string; useGpu: boolean; gpuEncoder?: string };
}

/** Only recent segment demand is CPU playback pressure. Client progress and
 * FFmpeg progress are NOT segment requests; a paused/buffered encoder is idle.
 */
export function countPlaybackTranscodes(
    jobs: Iterable<PlaybackEncodeJob>,
    now = Date.now(),
): PlaybackCounts {
    let cpuTranscodes = 0;
    let gpuTranscodes = 0;
    let activeSessions = 0;
    for (const job of jobs) {
        if (
            job.config.isPreview ||
            job.config.cacheKey ||
            job.config.outputDir ||
            job.generationRole !== 'current' ||
            !['starting', 'running', 'ready'].includes(job.status) ||
            job.lastSegmentRequestedAt === undefined ||
            now - job.lastSegmentRequestedAt > 20_000
        )
            continue;
        activeSessions++;
        if (
            job.throttlePaused ||
            job.parked ||
            (job.status !== 'starting' &&
                (!job.process || job.process.exitCode !== null || job.process.signalCode != null))
        )
            continue;
        const decision = job.transcodeDecisionResult;
        if (decision?.videoAction !== 'transcode') continue;
        if (decision.useGpu && decision.gpuEncoder && !job.config.softwareEncodeFallback)
            gpuTranscodes++;
        else cpuTranscodes++;
    }
    return { cpuTranscodes, gpuTranscodes, activeSessions };
}

const sessions = new Map<string, number>();
/** Called after authenticated play-session updates, including direct play.
 * Local entries expire, so a disappearing client cannot hold the load gate.
 */
export function notePlaybackSession(id: string, status: string): void {
    if (status === 'ACTIVE') sessions.set(id, Date.now());
    else sessions.delete(id);
}
let countsProvider: (() => PlaybackCounts) | undefined;
export function setPlaybackCountsProvider(provider: () => PlaybackCounts): void {
    countsProvider = provider;
}

export { parseCpuPressure };
/** Prefer this web pod's cgroup pressure. When PSI is unavailable, fall back
 * to host load/core. Workers never publish load into the playback signal.
 */
export async function readPlaybackLoad(): Promise<{
    loadRatioPerCore: number;
    cpuPressurePercent?: number;
}> {
    const cpuPressurePercent = await readCpuPressurePercent();
    // Keep host load observable even when PSI is the selected admission metric.
    const loadRatioPerCore = Math.max(0, loadavg()[0] ?? 0) / Math.max(1, cpus().length);
    return { loadRatioPerCore, cpuPressurePercent };
}

/** Short-lived per-web-process snapshots. No worker host load, no DB scans. */
export async function publishPlaybackPressure(
    instanceId = config.INSTANCE_ID,
    counts?: PlaybackCounts,
    client?: ValkeyLike | null,
): Promise<void> {
    try {
        if (!counts && !countsProvider && sessions.size === 0) return;
        const target = client === undefined ? getCoordinationClient() : client;
        if (!target) return;
        const now = Date.now();
        for (const [id, at] of sessions) if (now - at > 45_000) sessions.delete(id);
        const c = counts ??
            countsProvider?.() ?? { cpuTranscodes: 0, gpuTranscodes: 0, activeSessions: 0 };
        const key = `${PREFIX}${instanceId}`;
        await target.customCommand([
            'SET',
            key,
            JSON.stringify({
                ...c,
                activeSessions: Math.max(c.activeSessions, sessions.size),
                ...(await readPlaybackLoad()),
                sampledAt: now,
            }),
            'EX',
            String(PRESSURE_TTL_SECONDS),
        ]);
        await target.customCommand(['ZADD', INDEX_KEY, String(now), key]);
        await target.customCommand([
            'ZREMRANGEBYSCORE',
            INDEX_KEY,
            '-inf',
            String(now - PRESSURE_TTL_SECONDS * 1000),
        ]);
        await target.customCommand(['EXPIRE', INDEX_KEY, String(PRESSURE_TTL_SECONDS * 2)]);
    } catch {
        /* Telemetry must never prevent playback. */
    }
}

function parseSample(raw: unknown, now: number): PlaybackPressureSample | null {
    try {
        const v: unknown = JSON.parse(String(raw));
        if (typeof v !== 'object' || v === null) return null;
        const r = v as Record<string, unknown>;
        for (const f of [
            'cpuTranscodes',
            'gpuTranscodes',
            'activeSessions',
            'loadRatioPerCore',
            'sampledAt',
        ])
            if (typeof r[f] !== 'number' || !Number.isFinite(r[f]) || r[f] < 0) return null;
        if (
            now - Number(r.sampledAt) >= PRESSURE_TTL_SECONDS * 1000 ||
            Number(r.sampledAt) > now + 5000
        )
            return null;
        if (
            r.cpuPressurePercent !== undefined &&
            (typeof r.cpuPressurePercent !== 'number' ||
                !Number.isFinite(r.cpuPressurePercent) ||
                r.cpuPressurePercent < 0 ||
                r.cpuPressurePercent > 100)
        )
            return null;
        return r as unknown as PlaybackPressureSample;
    } catch {
        return null;
    }
}

/** Schmitt trigger + 60s recovery hold + 2min minimum unrestricted runtime.
 * The minimum run window damps SECONDARY load oscillation. A newly active CPU
 * viewer always takes priority immediately; GPU encoding never hard-triggers.
 */
export function decidePlaybackPressure(
    samples: PlaybackPressureSample[],
    threshold: number,
    previous: PressureState = { limited: false, holdUntil: 0 },
    now = Date.now(),
    psiThreshold = 20,
): PlaybackPressureStatus {
    const cpuTranscodes = samples.reduce((n, s) => n + s.cpuTranscodes, 0);
    const gpuTranscodes = samples.reduce((n, s) => n + s.gpuTranscodes, 0);
    const activeSessions = samples.reduce((n, s) => n + s.activeSessions, 0);
    const live = samples.filter((s) => s.activeSessions > 0);
    const loadRatioPerCore = Math.max(0, ...live.map((s) => s.loadRatioPerCore));
    const psiSamples = live.flatMap((s) =>
        s.cpuPressurePercent === undefined ? [] : [s.cpuPressurePercent],
    );
    const cpuPressurePercent = psiSamples.length ? Math.max(...psiSamples) : undefined;
    const multiplier = previous.limited ? 0.8 : 1;
    const loadPressure = live.some((s) =>
        s.cpuPressurePercent !== undefined
            ? psiThreshold > 0 && s.cpuPressurePercent > psiThreshold * multiplier
            : threshold > 0 && s.loadRatioPerCore > threshold * multiplier,
    );
    const minimumRun =
        previous.resumedAt !== undefined && now - previous.resumedAt < MIN_BACKGROUND_RUN_MS;
    let reason: PlaybackPressureStatus['reason'] = 'none';
    let state = { ...previous };
    if (!samples.length || activeSessions === 0)
        state = {
            limited: false,
            holdUntil: 0,
            resumedAt: previous.limited ? now : previous.resumedAt,
        }; // TTL expiry is NO pressure, including stale holds.
    else if (cpuTranscodes > 0 || (loadPressure && !minimumRun)) {
        reason =
            cpuTranscodes > 0
                ? 'cpu_transcode'
                : cpuPressurePercent !== undefined
                  ? 'pod_pressure'
                  : 'host_load';
        state = { limited: true, holdUntil: now + PRESSURE_HOLD_MS };
    } else if (previous.limited && now < previous.holdUntil) reason = 'cooloff';
    else if (previous.limited) state = { limited: false, holdUntil: 0, resumedAt: now };
    else if (minimumRun) reason = 'minimum_run';
    return {
        paused: state.limited,
        reason,
        cpuTranscodes,
        gpuTranscodes,
        activeSessions,
        loadRatioPerCore,
        cpuPressurePercent,
        threshold,
        resumeThreshold: threshold * 0.8,
        deferredMinutes: 0,
        state,
    };
}

export type PressureClient = ValkeyLike | null | (() => ValkeyLike | null);
function resolveClient(client: PressureClient): ValkeyLike | null {
    return typeof client === 'function' ? client() : client;
}
const CAS_STATE = `-- playback-pressure-state-cas
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', 300)
return 1`;
/** Client resolution is INSIDE try: a disconnected getClient() also fails open. */
export async function getPlaybackPressure(
    client: PressureClient = getCoordinationClient,
    threshold = config.LUMASTRA_BACKGROUND_CPU_LOAD_RATIO,
): Promise<PlaybackPressureStatus> {
    const clear = (): PlaybackPressureStatus => decidePlaybackPressure([], threshold);
    try {
        const target = resolveClient(client);
        if (!target) return clear();
        const now = Date.now();
        const keys = await target.customCommand([
            'ZRANGEBYSCORE',
            INDEX_KEY,
            String(now - PRESSURE_TTL_SECONDS * 1000),
            '+inf',
        ]);
        const values =
            Array.isArray(keys) && keys.length
                ? await target.customCommand(['MGET', ...keys.map(String)])
                : [];
        const samples = Array.isArray(values)
            ? values.flatMap((v) => {
                  const s = parseSample(v, now);
                  return s ? [s] : [];
              })
            : [];
        let observed = clear();
        for (let attempt = 0; attempt < 3; attempt++) {
            const raw = await target.customCommand(['GET', STATE_KEY]);
            const state: PressureState = raw
                ? (JSON.parse(String(raw)) as PressureState)
                : { limited: false, holdUntil: 0 };
            const status = decidePlaybackPressure(
                samples,
                threshold,
                state,
                now,
                config.LUMASTRA_BACKGROUND_CPU_PSI_PERCENT,
            );
            observed = status;
            if (
                Number(
                    await target.customCommand([
                        'EVAL',
                        CAS_STATE,
                        '1',
                        STATE_KEY,
                        raw == null ? '' : String(raw),
                        JSON.stringify(status.state),
                    ]),
                ) !== 1
            )
                continue;
            // Sorted first-deferral timestamps support the admin's oldest wait.
            await target.customCommand([
                'ZREMRANGEBYSCORE',
                DEFERRED_KEY,
                '-inf',
                String(now - 24 * 60 * 60_000),
            ]);
            const oldest = await target.customCommand([
                'ZRANGE',
                DEFERRED_KEY,
                '0',
                '0',
                'WITHSCORES',
            ]);
            if (Array.isArray(oldest) && oldest.length > 1)
                status.deferredMinutes = Math.max(
                    0,
                    Math.floor((now - Number(oldest[1])) / 60_000),
                );
            return status;
        }
        // CAS contention means another reader won the state write, not a
        // Valkey failure. Preserve observed pressure so simultaneous admissions
        // still contend for ONE slot rather than all failing open together.
        return observed;
    } catch {
        /* Task Valkey errors degrade to no pressure, never task failures. */
    }
    return clear();
}

export { isBackgroundCpuTask } from './background-cpu-scope.js';
export function playbackCpuExempt(taskId: string, manual = false): boolean {
    return manual || taskId === 'file-system-scan-probe';
}

const RELEASE_SLOT = `-- playback-pressure-slot-release
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
const RENEW_SLOT = `-- playback-pressure-slot-renew
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return 0`;
export interface PlaybackCpuSlot {
    release(): Promise<void>;
}
/** SET NX EX is shared across ALL background CPU task types and worker pods.
 * No global pause: a free slot admits one job even while pressure persists.
 * Keep ownership alive through long FFmpeg calls; compare tokens on release.
 */
export async function acquirePlaybackCpuSlot(
    client: PressureClient,
    owner: string,
): Promise<PlaybackCpuSlot | null> {
    try {
        const target = resolveClient(client);
        if (!target) return { release: async () => {} };
        const result = await target.customCommand([
            'SET',
            SLOT_KEY,
            owner,
            'NX',
            'EX',
            String(SLOT_SECONDS),
        ]);
        if (result !== 'OK') return null;
        const timer = setInterval(() => {
            void target
                .customCommand(['EVAL', RENEW_SLOT, '1', SLOT_KEY, owner, String(SLOT_SECONDS)])
                .catch(() => {});
        }, 10_000);
        timer.unref();
        return {
            release: async () => {
                clearInterval(timer);
                try {
                    await target.customCommand(['EVAL', RELEASE_SLOT, '1', SLOT_KEY, owner]);
                } catch {
                    /* TTL backstop */
                }
            },
        };
    } catch {
        return { release: async () => {} };
    }
}
export async function recordPlaybackDeferral(
    client: PressureClient,
    runId: string,
    firstAt: number | undefined,
): Promise<void> {
    try {
        const target = resolveClient(client);
        if (!target) return;
        if (firstAt === undefined) await target.customCommand(['ZREM', DEFERRED_KEY, runId]);
        else {
            await target.customCommand(['ZADD', DEFERRED_KEY, 'NX', String(firstAt), runId]);
            await target.customCommand(['EXPIRE', DEFERRED_KEY, '86400']);
        }
    } catch {
        /* visibility is best effort */
    }
}
export function playbackDeferralExpired(firstAt: number | undefined, now = Date.now()): boolean {
    return firstAt !== undefined && now - firstAt >= MAX_PLAYBACK_DEFERRAL_MS;
}
