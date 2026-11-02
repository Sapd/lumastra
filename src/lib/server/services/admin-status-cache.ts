// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Short-TTL server-side cache for the admin system-status payload
 * (`/api/admin/status`).
 *
 * The admin status panel is polled by every open admin tab and rebuilds a
 * payload that runs heavy embedding-coverage aggregates (getSystemStatusStats)
 * plus a handful of liveness probes. Before caching, those queries hit the DB on
 * every poll; with several tabs open that fan-out shared the web pool with the
 * playback hot path. A few seconds of staleness is fine for dashboard counters.
 *
 * KEYED PER REPLICA. Unlike attention/cluster, the status payload embeds
 * replica-local diagnostics — `workerState` (this node's WORKER_MODE /
 * shouldStartWorkers) and `lumastraChecks.watcher` (whether THIS node holds the
 * file-watcher leader lock). A single shared key would let one replica serve
 * another replica's local state, so the cache key includes the instance id. The
 * single-flight lock still collapses the per-tab/per-poll stampede on each
 * replica; cross-replica dedup is deliberately traded away for correctness.
 */

import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';

/** A few seconds of staleness is fine for status counters; admin panels poll faster than this. */
export const ADMIN_STATUS_CACHE_TTL_S = 20;

// v2: the cached body is now the SYSTEM BLOCK of the consolidated
// AdminStatusPayload (admin IA redesign) — bumped so a v1 body from a
// pre-redesign replica can never be served into the new payload shape.
const cacheKey = (instanceId: string): string => `v2:admin:status:${instanceId}`;

/**
 * Cache-or-compute the system-status JSON body for a given replica under a
 * single-flight lock. `compute` should return the serialized JSON body.
 */
export function getOrComputeAdminStatus(
    instanceId: string,
    compute: () => Promise<string>,
): Promise<string> {
    return getOrComputeSingleFlight({
        cacheKey: cacheKey(instanceId),
        ttlSeconds: ADMIN_STATUS_CACHE_TTL_S,
        compute,
    });
}
