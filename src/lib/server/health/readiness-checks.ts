// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The readiness booleans behind `GET /api/health/ready`, extracted so the admin
 * debug report reads the same checks the probe does (spec 2026-10-21 §4.2).
 * The route keeps its behaviour: it calls {@link getReadinessChecks} and only
 * decides the HTTP status and the detail it shows.
 */

import { getDb } from '$lib/server/database/connection.js';
import {
    connectValkey,
    getCoordinationClient,
    getValkeyClient,
    isCacheValkeyConfigured,
} from '$lib/server/cache/valkey.js';
import {
    workerPresence,
    type WorkerPresenceStatus,
} from '$lib/server/services/worker-presence.service.js';
import { getOrchestrator } from '$lib/server/tasks/orchestrator.js';

/** Rejects with an Error after `ms` milliseconds so hung checks fail fast. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    // Clear the timer when the real promise settles first — otherwise each check
    // leaves a live `ms` timer that keeps the event loop alive (delays shutdown;
    // the readiness probe is polled frequently).
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface ReadinessChecks {
    orchestrator: boolean;
    database: boolean;
    /** The task/coordination Valkey (gating). */
    valkey: boolean;
    /** The disposable cache: informational; 'disabled' when CACHE_URL is unset. */
    cache: 'ok' | 'down' | 'disabled';
    /** A dedicated worker heartbeats (informational; see worker-presence.service). */
    worker: WorkerPresenceStatus;
    leader: boolean;
}

// Short-lived result memo. The readiness route is reachable unauthenticated (it must be —
// a kubelet presents no credential) and each run costs a Postgres round-trip plus
// a Valkey PING on an 8-slot pool, so without this a flood of anonymous requests
// could exhaust the pool and, through this very endpoint, drop the pod out of the
// Service. One second is far below the 15s probe interval, so a real probe never
// reads a stale verdict; it only collapses bursts.
const CHECKS_TTL_MS = 1000;
let cachedChecks: { at: number; checks: ReadinessChecks } | null = null;
let checksInFlight: Promise<ReadinessChecks> | null = null;

/** Test seam — module-level memo has no other way to be reset between cases. */
export function resetReadinessCache(): void {
    cachedChecks = null;
    checksInFlight = null;
}

/** The readiness checks, memoized for one second and shared by concurrent callers. */
export async function getReadinessChecks(): Promise<ReadinessChecks> {
    if (cachedChecks && Date.now() - cachedChecks.at < CHECKS_TTL_MS) {
        return cachedChecks.checks;
    }
    // Concurrent callers share one run rather than each starting their own —
    // the same reason getOrchestrator() memoizes its in-flight start.
    if (checksInFlight) return checksInFlight;

    checksInFlight = runChecks()
        .then((checks) => {
            cachedChecks = { at: Date.now(), checks };
            return checks;
        })
        .finally(() => {
            checksInFlight = null;
        });

    return checksInFlight;
}

async function runChecks(): Promise<ReadinessChecks> {
    const checks: ReadinessChecks = {
        orchestrator: false,
        database: false,
        valkey: false,
        cache: 'disabled',
        worker: workerPresence.get().status,
        leader: false,
    };

    try {
        const sql = getDb();
        if (sql) {
            await withTimeout(sql`SELECT 1`, 2000, 'db');
            checks.database = true;
        }
    } catch {
        // DB unreachable or timed out — check stays false.
    }

    try {
        let client = getCoordinationClient();
        if (!client) {
            // Reconnect from HERE, deliberately. A pod that booted while the task
            // Valkey was down holds no client, and every OTHER caller of
            // connectValkey() runs while SERVING a request. An unready pod is
            // sent no requests, so none of them ever fire: readiness would latch
            // off permanently while liveness on /api/health stayed green, so
            // Kubernetes would never restart it either. The probe has to be
            // what retries.
            //
            // Safe to call on every probe: connectValkey() returns the in-flight
            // promise when one exists, so concurrent probes share one attempt
            // rather than opening a client each. It never waits on the cache
            // after the first attempt (the cache reconnects in the background).
            await withTimeout(connectValkey(), 2000, 'valkey-connect');
            client = getCoordinationClient();
        }
        if (client) {
            await withTimeout(client.customCommand(['PING']), 2000, 'valkey');
            checks.valkey = true;
        }
    } catch {
        // Task Valkey unreachable or timed out — check stays false.
    }

    // Presence only, no round trip: a down cache must not add latency to (or
    // time out) a probe it does not gate. The client re-appears when the
    // background reconnect succeeds.
    if (isCacheValkeyConfigured()) {
        checks.cache = getValkeyClient() ? 'ok' : 'down';
    }

    // getDb() needs no equivalent: it re-creates the pool on any call where the
    // handle is missing, and postgres.js reconnects underneath, so the database
    // check heals on its own.

    try {
        const orch = await withTimeout(getOrchestrator(), 2000, 'orchestrator');
        checks.orchestrator = orch.isHealthy();
        checks.leader = orch.isLeaderForAnyClass();
    } catch {
        // Orchestrator not started or timed out — checks stay false.
    }

    return checks;
}
