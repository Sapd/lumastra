// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/admin/task-system/now — Mission Control coalesced snapshot (Slice 4).
//
// ONE round trip composing all the slow-changing context the `/admin/tasks/live`
// page needs, so the page runs a SINGLE poll timer instead of the 3+ overlapping
// timers (QueueDepthBar/SystemHealthRail/IngestMap) it would otherwise inherit
// (slice-4 spec §4.4). Live run movement + the error ticker stay on the PUSH bus
// (`run-sse-bus`) — this endpoint is context, not activity.
//
// Each axis is independently guarded — a dead Valkey or DB yields the degraded
// variant for that axis (empty list / 'unknown'), never a 500.

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { getDb } from '$lib/server/database/connection.js';
import { RESOURCE_CLASSES } from '@sapd/lumastra-plugin-sdk';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { registry } from '$lib/server/tasks/registry.js';
import { readHeartbeats } from '$lib/server/tasks/observability/heartbeat.js';
import { readClassLeaders } from '$lib/server/tasks/observability/leaders.js';
import { computeScheduleOverdue } from '$lib/server/tasks/observability/schedule-overdue.js';
import {
    computeHealthVerdict,
    deriveValkeyAvailable,
    type InvariantFinding,
} from '$lib/server/tasks/observability/health-verdict.js';
import { listAllScheduledTasks } from '$lib/server/tasks/scheduler-state.js';
import { listFindings } from '$lib/server/database/queries/health-check-findings.queries.js';
import { buildComponentHealth } from '$lib/server/health/component-health.js';
import { readClusterNodes } from '$lib/server/services/cluster-heartbeat.service.js';
import {
    buildClassSnapshots,
    buildNodeSnapshots,
    buildNowHealth,
    buildEmbeddingCoverage,
    type LeaderEntry,
    type QueueDepthEntry,
} from '$lib/server/tasks/observability/now-snapshot.js';
import { getLibraryEmbeddingCoverage } from '$lib/server/database/queries/embeddings.queries.js';
import type { EmbeddingCoverage } from '$lib/schemas/mission-control.schema.js';
import type { ScheduleOverdueView } from '$lib/schemas/task-system-health.schema.js';
import type {
    ClassLeader,
    ComponentHealth,
    HeartbeatView,
} from '$lib/schemas/task-system-observability.schema.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('mission-control-now');

const def = defineEndpoint({
    // Operational surface (Mission Control coalesced snapshot) — moved from
    // tasks:read to tasks:admin. security review 2026-09-12, C16.
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();

            // ── Resource-class context (queue depths + caps) ────────────────────
            // Best-effort: a Valkey/BullMQ hiccup yields all-zero depths rather than
            // a 500 — the badge advisory degrades, the page still renders.
            let queueDepths: Partial<Record<string, QueueDepthEntry>> = {};
            try {
                queueDepths = await orchestrator.getQueueDepths();
            } catch (err) {
                log.warn('now: getQueueDepths failed', {
                    err: err instanceof Error ? err.message : String(err),
                });
            }
            const caps = orchestrator.getConcurrencyCaps();

            // ── Valkey axis (heartbeats + leaders) ──────────────────────────────
            let subsystems: HeartbeatView[] = [];
            let leaders: ClassLeader[] = [];
            try {
                [subsystems, leaders] = await Promise.all([readHeartbeats(), readClassLeaders()]);
            } catch (err) {
                log.warn('now: Valkey reads failed', {
                    err: err instanceof Error ? err.message : String(err),
                });
            }

            // ── Cluster node identities (Valkey heartbeat keys) ─────────────────
            const clusterNodes = await readClusterNodes();

            // ── DB axis (schedules + invariants + embedding coverage) ───────────
            let schedules: ScheduleOverdueView[] = [];
            let invariants: InvariantFinding[] = [];
            let embeddingCoverage: EmbeddingCoverage | null = null;
            let dbAvailable = sql !== null;
            if (sql) {
                try {
                    const resourceClassByTaskId = new Map<string, string>();
                    const registeredTasks = registry.getAllTasks();
                    for (const task of registeredTasks) {
                        resourceClassByTaskId.set(task.id, task.resourceClass);
                    }
                    // Drop orphaned scheduler_state rows (renamed/removed tasks, or
                    // tasks that dropped their `schedule`) so a stale row whose
                    // next_fire_at never advances can't report phantom-DEGRADED.
                    // Fail OPEN: skip filtering if the registry isn't populated yet.
                    const scheduledTaskIds =
                        registeredTasks.length > 0
                            ? new Set(
                                  registeredTasks.filter((t) => t.schedule?.every).map((t) => t.id),
                              )
                            : undefined;
                    const [scheduleStates, findings] = await Promise.all([
                        listAllScheduledTasks(sql),
                        listFindings(sql),
                    ]);
                    schedules = computeScheduleOverdue(
                        scheduleStates,
                        Date.now(),
                        undefined,
                        resourceClassByTaskId,
                        scheduledTaskIds,
                    );
                    invariants = findings.map((f) => ({
                        status: f.status,
                        id: f.invariant_id,
                        label: f.label,
                    }));
                } catch (err) {
                    dbAvailable = false;
                    log.warn('now: DB reads failed', {
                        err: err instanceof Error ? err.message : String(err),
                    });
                }

                // Embedding coverage is purely informational — read it separately so
                // a hiccup here only nulls the coverage chip, never the operational
                // schedule strip / invariants and never flips dbAvailable.
                try {
                    embeddingCoverage = buildEmbeddingCoverage(
                        await getLibraryEmbeddingCoverage(sql),
                    );
                } catch (err) {
                    log.warn('now: embedding coverage read failed', {
                        err: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            // ── Health verdict (Slice 1, computed over the gathered inputs) ──────
            // Component health is independently guarded internally — never throws.
            const componentsRaw = (await buildComponentHealth()) as {
                timestamp?: string;
            } & Record<string, unknown>;
            const { timestamp: _ts, ...componentEntries } = componentsRaw;
            const components: Record<string, ComponentHealth> = {};
            for (const [name, data] of Object.entries(componentEntries)) {
                components[name] = data as ComponentHealth;
            }
            const valkeyAvailable = deriveValkeyAvailable(components);

            const verdict = computeHealthVerdict({
                heartbeats: subsystems,
                leaders,
                schedules,
                invariants,
                inputsAvailable: { valkey: valkeyAvailable, db: dbAvailable },
            });
            // The verdict is "available" when at least one input axis was readable;
            // a fully-dark system (no valkey, no db) reports unknown + unavailable so
            // the header chip shows a neutral '—' rather than a misleading verdict.
            const healthAvailable = valkeyAvailable || dbAvailable;

            const leaderEntries: LeaderEntry[] = leaders.map((l) => ({
                resourceClass: l.resourceClass,
                holderInstanceId: l.holderInstanceId,
            }));

            const assembleInput = {
                resourceClasses: RESOURCE_CLASSES,
                queueDepths,
                caps,
                leaders: leaderEntries,
                nodes: clusterNodes,
                selfInstanceId: config.INSTANCE_ID,
                healthStatus: healthAvailable ? verdict.status : null,
                healthAvailable,
            };

            return json({
                classes: buildClassSnapshots(assembleInput),
                nodes: buildNodeSnapshots(assembleInput),
                schedules,
                health: buildNowHealth(assembleInput),
                embeddingCoverage,
                generatedAt: new Date().toISOString(),
            });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
