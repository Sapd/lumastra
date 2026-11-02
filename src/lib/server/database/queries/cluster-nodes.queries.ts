// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cluster Node Queries
 *
 * Pure SQL query module for the cluster_node_events table.
 * Records only state transitions (online/offline), not periodic heartbeats.
 * All functions take `sql` as first parameter and have no side effects.
 */

import type postgres from 'postgres';

// =============================================================================
// Types
// =============================================================================

/**
 * Why an event was written (cluster_node_events.reason, NULL on rows from
 * builds before 16.284.0):
 * - 'start' / 'restart' / 'restart_unclean': the process itself, at boot
 *   (recordInstanceStart). 'restart_unclean' = the previous run of this
 *   INSTANCE_ID did not shut down gracefully.
 * - 'stop': the process itself, on graceful shutdown.
 * - 'unseen': backfilled by recordInstanceStart for a previous run whose exit
 *   nobody recorded.
 * - 'missing' / 'returned': the leader saw the heartbeat key vanish / appear.
 *   Also produced by a heartbeat gap without any restart, so never counted.
 */
export type NodeEventReason =
    'start' | 'restart' | 'restart_unclean' | 'stop' | 'unseen' | 'missing' | 'returned';

export interface NodeEventInsert {
    instanceId: string;
    eventType: 'online' | 'offline';
    role?: string;
    version?: string;
    hostname?: string;
    reason?: NodeEventReason;
}

export interface NodeEventRow {
    id: string;
    instanceId: string;
    eventType: string;
    role: string | null;
    version: string | null;
    hostname: string | null;
    createdAt: Date;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Insert one or more node online/offline events.
 *
 * Accepts a single event or an array. Passing an array performs a single
 * multi-row INSERT so a batch of transitions detected on one tick is written
 * atomically — either every row lands or none do — rather than as a sequence
 * of independent statements that can tear on a mid-loop crash (F6).
 *
 * Idempotent per instance: a row whose event_type equals that instance's latest
 * event is skipped. Two writers legitimately record the same transition — a
 * gracefully stopping node records its own 'offline' and the leader then sees
 * its key vanish; a starting node records its own 'online' (recordInstanceStart)
 * and the leader then sees its key appear. Without the skip each restart showed
 * up twice and inflated the restart count. Callers pass at most one event per
 * instance per call.
 *
 * An empty array is a no-op (no SQL is issued).
 */
export async function insertNodeEvent(
    sql: postgres.Sql,
    events: NodeEventInsert | NodeEventInsert[],
): Promise<void> {
    const list = Array.isArray(events) ? events : [events];
    if (list.length === 0) return;

    await sql`
        INSERT INTO cluster_node_events (instance_id, event_type, role, version, hostname, reason)
        SELECT v.instance_id, v.event_type, v.role, v.version, v.hostname, v.reason
        FROM unnest(
            ${list.map((e) => e.instanceId)}::text[],
            ${list.map((e) => e.eventType)}::text[],
            ${list.map((e) => e.role ?? null)}::text[],
            ${list.map((e) => e.version ?? null)}::text[],
            ${list.map((e) => e.hostname ?? null)}::text[],
            ${list.map((e) => e.reason ?? null)}::text[]
        ) AS v(instance_id, event_type, role, version, hostname, reason)
        WHERE v.event_type IS DISTINCT FROM (
            SELECT e.event_type
            FROM cluster_node_events e
            WHERE e.instance_id = v.instance_id
            ORDER BY e.created_at DESC
            LIMIT 1
        )
    `;
}

/**
 * A process registers its own start, BEFORE its first heartbeat write. This is
 * the only writer of restart rows, because only the process knows it is new —
 * a heartbeat gap without a restart looks identical from the outside.
 *
 * The 'online' row's reason classifies the start from the instance's latest
 * event:
 * - none → 'start' (first run of this INSTANCE_ID; not a restart);
 * - 'offline' written by a graceful stop → 'restart';
 * - 'offline' written by anyone else (leader saw the key vanish, legacy row
 *   without a version) → 'restart_unclean';
 * - still 'online' → the previous run ended without anyone recording it (OOM
 *   kill back within the 30 s heartbeat TTL, or a single replica with no leader
 *   left to notice): an 'unseen' offline is backfilled first, then
 *   'restart_unclean'.
 *
 * Not serialised against the leader. If the leader's 'missing' offline for the
 * previous run lands just after this start's rows, the timeline briefly ends
 * in 'offline' for a live pod until the leader's next tick adds 'returned'.
 * Restart counts are unaffected: they come only from this function's rows.
 *
 * Returns the reason recorded on the 'online' row.
 */
export async function recordInstanceStart(
    sql: postgres.Sql,
    node: { instanceId: string; role?: string; version?: string; hostname?: string },
): Promise<'start' | 'restart' | 'restart_unclean'> {
    const rows = await sql<{ eventType: string; reason: string }[]>`
        WITH latest AS (
            SELECT event_type, reason, version, created_at
            FROM cluster_node_events
            WHERE instance_id = ${node.instanceId}
            ORDER BY created_at DESC
            LIMIT 1
        ),
        kind AS (
            SELECT CASE
                WHEN NOT EXISTS (SELECT 1 FROM latest) THEN 'start'
                WHEN (SELECT event_type FROM latest) = 'online' THEN 'restart_unclean'
                WHEN (SELECT reason FROM latest) = 'stop' THEN 'restart'
                WHEN (SELECT reason FROM latest) IS NULL
                     AND (SELECT version FROM latest) IS NOT NULL THEN 'restart'
                ELSE 'restart_unclean'
            END AS reason
        ),
        -- Strictly after the previous event even when it landed in the same
        -- microsecond (or the same transaction, where now() does not advance).
        at AS (
            SELECT GREATEST(now(), (SELECT created_at FROM latest) + INTERVAL '1 microsecond') AS ts
        )
        INSERT INTO cluster_node_events
            (instance_id, event_type, role, version, hostname, reason, created_at)
        SELECT ${node.instanceId}, 'offline', NULL, NULL, NULL, 'unseen', (SELECT ts FROM at)
        WHERE (SELECT event_type FROM latest) = 'online'
        UNION ALL
        SELECT ${node.instanceId}, 'online', ${node.role ?? null}, ${node.version ?? null},
               ${node.hostname ?? null}, (SELECT reason FROM kind),
               (SELECT ts FROM at) + INTERVAL '1 microsecond'
        RETURNING event_type AS "eventType", reason
    `;
    const online = rows.find((r) => r.eventType === 'online');
    return (online?.reason ?? 'start') as 'start' | 'restart' | 'restart_unclean';
}

export interface RestartCounts {
    /** Process restarts in the window (deploys included). */
    restarts: number;
    /** The subset whose previous run did not shut down gracefully: crash, OOM kill, node loss. */
    unclean: number;
}

/**
 * Restarts per instance in the last `hours`, counted from the rows each
 * process writes at boot (see {@link recordInstanceStart}) — never from
 * offline/online pairs, which a heartbeat gap also produces. Only meaningful
 * with a stable INSTANCE_ID (the Helm chart pins it to the pod name); an
 * auto-generated id is new on every start and always reads 0.
 */
export async function countRestartsSince(
    sql: postgres.Sql,
    { instanceIds, hours = 24 }: { instanceIds: string[]; hours?: number },
): Promise<Map<string, RestartCounts>> {
    const counts = new Map<string, RestartCounts>();
    if (instanceIds.length === 0) return counts;
    const rows = await sql<{ instanceId: string; restarts: number; unclean: number }[]>`
        SELECT instance_id AS "instanceId",
               count(*)::int AS restarts,
               count(*) FILTER (WHERE reason = 'restart_unclean')::int AS unclean
        FROM cluster_node_events
        WHERE event_type = 'online'
          AND reason IN ('restart', 'restart_unclean')
          AND instance_id = ANY(${instanceIds}::text[])
          AND created_at >= NOW() - (${hours} * INTERVAL '1 hour')
        GROUP BY instance_id
    `;
    for (const r of rows) counts.set(r.instanceId, { restarts: r.restarts, unclean: r.unclean });
    return counts;
}

/**
 * Get recent node events within a time window.
 */
export async function getRecentEvents(
    sql: postgres.Sql,
    { limit = 100, hours = 24 }: { limit?: number; hours?: number },
): Promise<NodeEventRow[]> {
    return sql<NodeEventRow[]>`
        SELECT id, instance_id AS "instanceId", event_type AS "eventType",
               role, version, hostname, created_at AS "createdAt"
        FROM cluster_node_events
        WHERE created_at >= NOW() - (${hours} * INTERVAL '1 hour')
        ORDER BY created_at DESC
        LIMIT ${limit}
    `;
}

/**
 * Get event timeline for a specific node.
 */
export async function getNodeTimeline(
    sql: postgres.Sql,
    { instanceId, limit = 50 }: { instanceId: string; limit?: number },
): Promise<NodeEventRow[]> {
    return sql<NodeEventRow[]>`
        SELECT id, instance_id AS "instanceId", event_type AS "eventType",
               role, version, hostname, created_at AS "createdAt"
        FROM cluster_node_events
        WHERE instance_id = ${instanceId}
        ORDER BY created_at DESC
        LIMIT ${limit}
    `;
}

/**
 * Returns instance_ids whose most recent event is 'online' — the expected-online set.
 * Used by: (1) transition detector to seed baseline on leader handoff so crashed nodes
 * during the gap get an offline event, (2) API endpoint to compute totalRegistered
 * so partial outages show as degraded (e.g. 1/2 online, not 1/1).
 */
export async function getInstancesExpectedOnline(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql<{ instanceId: string }[]>`
        SELECT instance_id AS "instanceId"
        FROM (
            SELECT DISTINCT ON (instance_id)
                   instance_id, event_type
            FROM cluster_node_events
            ORDER BY instance_id, created_at DESC
        ) latest
        WHERE event_type = 'online'
    `;
    return rows.map((r) => r.instanceId);
}

/**
 * Delete events older than N days for retention management.
 */
export async function pruneOldEvents(
    sql: postgres.Sql,
    { days = 30 }: { days?: number },
): Promise<number> {
    const result = await sql`
        DELETE FROM cluster_node_events
        WHERE created_at < NOW() - (${days} * INTERVAL '1 day')
    `;
    return result.count;
}
