// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// runtime-state.ts - one place that assembles what the dedicated worker knows
// about itself: upgrade state, consumer loops, library watcher, singleton
// lease, loop progress and uncaught exceptions.
//
// Subsystems register optional providers; every provider may be absent (the
// state is then omitted). The same snapshot feeds the cluster heartbeat, the
// /metrics scrape, the readiness reasons and the liveness decision.

import { getLoopTick, getLastLoopTick, type LoopName } from '$lib/server/tasks/loop-progress.js';
import type { HeartbeatRuntimeState } from '$lib/server/services/worker-runtime-reason.js';

export interface WatcherRuntimeState {
    implementation: 'rust';
    state: 'stopped' | 'starting' | 'ready' | 'degraded' | 'failed';
    coverage?: 'full' | 'partial';
    limitations: string[];
    restarts: number;
    lastRestartAt?: string;
    lastError?: string;
    leaseHeld: boolean;
    networkReconcileSecs?: number;
    /** PID of the native watcher child while one runs (child RSS accounting). */
    pid?: number;
}

export interface WorkerLeaseState {
    held: boolean;
    holder?: string;
    since?: string;
    lastRenewAt?: string;
    lastRenewLocalAt?: string;
}

export interface ConsumerProviderState {
    running: number;
    paused: number;
}

export interface WorkerRuntimeState {
    upgradeState?: string;
    consumers?: ConsumerProviderState & { lastProgressAt?: string };
    watcher?: WatcherRuntimeState;
    lease?: WorkerLeaseState;
    lastTickAt?: string;
    uncaughtExceptions: number;
}

let watcherProvider: (() => WatcherRuntimeState | undefined) | undefined;
let leaseProvider: (() => WorkerLeaseState | undefined) | undefined;
let upgradeProvider: (() => string | undefined) | undefined;
let consumerProvider: (() => ConsumerProviderState | undefined) | undefined;
let uncaughtExceptions = 0;
let uncaughtTimes: number[] = [];

export function registerWatcherStateProvider(
    fn: (() => WatcherRuntimeState | undefined) | undefined,
): void {
    watcherProvider = fn;
}
export function registerWorkerLeaseStateProvider(
    fn: (() => WorkerLeaseState | undefined) | undefined,
): void {
    leaseProvider = fn;
}
export function registerUpgradeStateProvider(fn: (() => string | undefined) | undefined): void {
    upgradeProvider = fn;
}
export function registerConsumerStateProvider(
    fn: (() => ConsumerProviderState | undefined) | undefined,
): void {
    consumerProvider = fn;
}

function iso(ms: number | undefined): string | undefined {
    return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** A throwing provider must not take the probe or the heartbeat down with it. */
function safe<T>(fn: (() => T | undefined) | undefined): T | undefined {
    try {
        return fn?.();
    } catch {
        return undefined;
    }
}

export function getWorkerRuntimeState(): WorkerRuntimeState {
    const consumers = safe(consumerProvider);
    return {
        upgradeState: safe(upgradeProvider),
        consumers: consumers
            ? { ...consumers, lastProgressAt: iso(getLoopTick('consumer')) }
            : undefined,
        watcher: safe(watcherProvider),
        lease: safe(leaseProvider),
        lastTickAt: iso(getLastLoopTick()),
        uncaughtExceptions,
    };
}

/**
 * Readiness reasons the library watcher contributes: starting (incl. restart backoff) and failed.
 * A native child restarting within its backoff reports 'starting', so it never reads as failed.
 */
export function watcherReadinessReasons(watcher: WatcherRuntimeState | undefined): string[] {
    if (watcher?.state === 'starting') return ['watcher_starting'];
    if (watcher?.state === 'failed') return ['watcher_failed'];
    return [];
}

/** Small, secret-free projection for the cluster heartbeat (no error text, no holder ids). */
export function getHeartbeatRuntimeState(): HeartbeatRuntimeState {
    const s = getWorkerRuntimeState();
    return {
        upgradeState: s.upgradeState,
        consumers: s.consumers,
        watcher: s.watcher
            ? { state: s.watcher.state, restarts: s.watcher.restarts, coverage: s.watcher.coverage }
            : undefined,
        lease: s.lease ? { held: s.lease.held, lastRenewAt: s.lease.lastRenewAt } : undefined,
        lastTickAt: s.lastTickAt,
        uncaughtExceptions: s.uncaughtExceptions,
    };
}

/** Upgrade states in which the loops are deliberately stopped; stalls are expected there. */
const UPGRADE_QUIET_STATES = new Set(['preparing', 'prepared', 'stopping', 'unknown']);

/** Loops a healthy dedicated worker must keep turning over. */
const EXPECTED_LOOPS: readonly LoopName[] = ['scheduler', 'consumer'];

/**
 * Liveness verdict from loop progress. Stalled when ANY expected loop has not turned
 * over for stallMs (a ticking scheduler must not hide dead consumers, or the reverse).
 * Idle queues still tick. Never stalled before startup finished or while an upgrade
 * has the loops stopped on purpose.
 */
export function isProgressStalled(options: {
    now: number;
    stallMs: number;
    startedAt: number | undefined;
    upgradeState?: string;
    loops?: readonly LoopName[];
}): boolean {
    if (options.startedAt === undefined) return false;
    const startedAt = options.startedAt;
    if (options.upgradeState && UPGRADE_QUIET_STATES.has(options.upgradeState)) return false;
    return (options.loops ?? EXPECTED_LOOPS).some(
        (loop) => options.now - Math.max(getLoopTick(loop) ?? 0, startedAt) > options.stallMs,
    );
}

export interface UncaughtVerdict {
    count: number;
    shutdown: boolean;
    reason?: string;
}

/**
 * Counts an uncaught exception. Strict shutdown when it happens while the
 * process is already stopping, or when `threshold` of them land within `windowMs`.
 */
export function recordUncaughtException(options: {
    now?: number;
    duringShutdown: boolean;
    threshold?: number;
    windowMs?: number;
}): UncaughtVerdict {
    const now = options.now ?? Date.now();
    const threshold = options.threshold ?? 3;
    const windowMs = options.windowMs ?? 10 * 60_000;
    uncaughtExceptions++;
    uncaughtTimes = [...uncaughtTimes.filter((t) => now - t < windowMs), now];
    if (options.duringShutdown)
        return { count: uncaughtExceptions, shutdown: true, reason: 'during shutdown' };
    if (uncaughtTimes.length >= threshold)
        return {
            count: uncaughtExceptions,
            shutdown: true,
            reason: `${uncaughtTimes.length} uncaught exceptions within ${Math.round(windowMs / 60_000)} minutes`,
        };
    return { count: uncaughtExceptions, shutdown: false };
}

/** Test-only. */
export function resetRuntimeStateForTests(): void {
    watcherProvider = leaseProvider = upgradeProvider = consumerProvider = undefined;
    uncaughtExceptions = 0;
    uncaughtTimes = [];
}
