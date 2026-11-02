// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The replica-agnostic cluster "core" (live nodes, sidecars, transition events,
 * totals) behind GET /api/admin/cluster and the cluster tile on /admin.
 *
 * Both read it through the shared 15 s single-flight cache (admin-cluster-cache.ts),
 * so the admin status payload adding a cluster glance costs no extra queries: every
 * admin tab across every replica still collapses to one recompute per TTL. The
 * replica-local `selfInstanceId` is never part of the core; callers add it.
 */

import { Logger } from '$lib/server/utils/logger.js';
import type { ClusterNode, ClusterStatusResponse } from '$lib/schemas/api-admin-responses.js';
import {
    getRecentEvents,
    getInstancesExpectedOnline,
    countRestartsSince,
} from '$lib/server/database/queries/cluster-nodes.queries.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { readClusterNodes } from '$lib/server/services/cluster-heartbeat.service.js';
import { getOrComputeClusterCore } from '$lib/server/services/admin-cluster-cache.js';
import { workerUnavailableReasons } from '$lib/server/services/worker-runtime-reason.js';
import { probeClusterSidecars } from '$lib/server/services/cluster-sidecar-probe.js';
import { config } from '$lib/server/config.js';
import {
    appProxyExpectation,
    decideProxyCompat,
} from '$lib/server/services/livetv/proxy-compat.js';

const logger = Logger.for('AdminCluster');

export type ClusterCore = Omit<ClusterStatusResponse, 'selfInstanceId'>;

async function computeClusterCore(): Promise<string> {
    const sql = getAdminDb();

    // SCAN is required here. KEYS blocks Valkey for the full key scan duration
    // and is O(N) over the entire keyspace. SCAN iterates in cursor batches.
    const live = await readClusterNodes({ withHeartbeatAge: true });
    const restarts = sql
        ? await countRestartsSince(sql, {
              instanceIds: live.map((n) => n.instanceId),
              hours: 24,
          })
        : null;
    const proxyExpectation = appProxyExpectation();
    const nodes: ClusterNode[] = live.map((n) => ({
        instanceId: n.instanceId,
        role: n.role,
        version: n.version,
        hostname: n.hostname,
        startedAt: n.startedAt,
        uptimeSeconds: n.uptimeSeconds,
        // Omit rather than send '' so "unknown" stays distinguishable
        // from a real fingerprint on the client.
        keyFingerprint: n.keyFingerprint || undefined,
        placement: n.placement,
        resources: n.resources,
        // Absent (not 0) when the DB is unavailable, so the card hides the row.
        restarts24h: restarts ? (restarts.get(n.instanceId)?.restarts ?? 0) : undefined,
        uncleanExits24h: restarts ? (restarts.get(n.instanceId)?.unclean ?? 0) : undefined,
        lastSeenAt: n.sentAt,
        heartbeatAgeMs: n.heartbeatAgeMs,
        implementation: n.implementation,
        host: n.host,
        process: n.process,
        runtime: n.runtime,
        gpuAccess: n.gpuAccess,
        unavailableReasons: n.runtime ? workerUnavailableReasons(n.runtime) : undefined,
        proxyCompat:
            n.role === 'proxy'
                ? {
                      ...decideProxyCompat(n, proxyExpectation),
                      serverProtocol: proxyExpectation.protocol,
                      serverVersion: config.APP_VERSION,
                  }
                : undefined,
    }));

    const [events, sidecars] = await Promise.all([
        sql ? getRecentEvents(sql, { limit: 100, hours: 24 }) : [],
        probeClusterSidecars(),
    ]);

    // totalRegistered = instances whose last DB event is 'online'.
    // Survives node crashes: a 2-node cluster with 1 dead node shows 1/2.
    const expectedOnline = sql ? await getInstancesExpectedOnline(sql) : [];
    const totalRegistered = Math.max(expectedOnline.length, nodes.length);

    logger.debug('Cluster status fetched', {
        online: nodes.length,
        events: events.length,
    });

    const core: ClusterCore = {
        nodes,
        sidecars,
        expected: { proxy: config.STREAM_PROXY_URL !== '' },
        generatedAt: new Date().toISOString(),
        events: events.map((e) => ({
            id: e.id,
            instanceId: e.instanceId,
            eventType: e.eventType as 'online' | 'offline',
            createdAt:
                e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
            role: e.role ?? undefined,
            version: e.version ?? undefined,
            hostname: e.hostname ?? undefined,
        })),
        totalOnline: nodes.length,
        totalRegistered,
    };
    return JSON.stringify(core);
}

/** The cached cluster core; an unparseable cache entry reads as an empty cluster. */
export async function getClusterCore(): Promise<ClusterCore> {
    const body = await getOrComputeClusterCore(computeClusterCore);
    try {
        return JSON.parse(body) as ClusterCore;
    } catch {
        logger.warn('Discarding unparseable cached cluster core');
        return { nodes: [], events: [], totalOnline: 0, totalRegistered: 0 };
    }
}
