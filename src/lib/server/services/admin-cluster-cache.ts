// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Short-TTL server-side cache for the admin cluster-status payload
 * (`/api/admin/cluster`).
 *
 * The cluster panel is polled by every open admin tab and reads recent
 * online/offline transition history from Postgres (getRecentEvents +
 * getInstancesExpectedOnline) on every poll. Before caching, those queries
 * shared the web pool with the playback hot path. A few seconds of staleness is
 * fine for a node-status board.
 *
 * SHARED KEY (not per-replica). The cached "core" — live nodes, transition
 * events, and totals — is the same cluster-wide view from every replica, so one
 * shared key + single-flight collapses all admin tabs across all replicas to a
 * single recompute per TTL. The one replica-local field, `selfInstanceId`, is
 * deliberately NOT cached here; the route injects it at the edge so a payload
 * computed by node A never reports node A as "self" to node B.
 */

import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';

/** A few seconds of staleness is fine for a node-status board; admin tabs poll faster. */
export const ADMIN_CLUSTER_CACHE_TTL_S = 15;

const CACHE_KEY = 'v2:admin:cluster';

/**
 * Cache-or-compute the replica-agnostic cluster "core" JSON (nodes, events,
 * totals) under a single-flight lock. `compute` should return the serialized
 * core — WITHOUT the replica-local `selfInstanceId`, which the caller appends.
 */
export function getOrComputeClusterCore(compute: () => Promise<string>): Promise<string> {
    return getOrComputeSingleFlight({
        cacheKey: CACHE_KEY,
        ttlSeconds: ADMIN_CLUSTER_CACHE_TTL_S,
        compute,
    });
}
