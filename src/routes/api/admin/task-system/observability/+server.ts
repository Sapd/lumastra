// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/admin/task-system/observability — composed liveness + history view
// for the admin system-health page (Slice 0 §5, extended by Slice 1).
//
// Combines subsystem heartbeats (Valkey), resource-class leaders (Valkey), the
// latest boot-recovery row (Postgres), the shared component-health block, and
// — added in Slice 1 — schedule countdown/overdue (Postgres) plus the rollup
// `health` verdict. The verdict is computed SERVER-SIDE by the pure
// `computeHealthVerdict` over the inputs gathered here (slice-1 spec Option A).
//
// Each axis is independently guarded: a dead Valkey or DB yields `unknown` for
// that axis (via `inputsAvailable`) rather than a 500.

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { readHeartbeats } from '$lib/server/tasks/observability/heartbeat.js';
import { readClassLeaders } from '$lib/server/tasks/observability/leaders.js';
import { computeScheduleOverdue } from '$lib/server/tasks/observability/schedule-overdue.js';
import {
    computeHealthVerdict,
    deriveValkeyAvailable,
    type InvariantFinding,
} from '$lib/server/tasks/observability/health-verdict.js';
import { getLatestBootRecovery } from '$lib/server/database/queries/observability.queries.js';
import { listAllScheduledTasks } from '$lib/server/tasks/scheduler-state.js';
import { listFindings } from '$lib/server/database/queries/health-check-findings.queries.js';
import { buildComponentHealth } from '$lib/server/health/component-health.js';
import { registry } from '$lib/server/tasks/registry.js';
import type {
    ClassLeader,
    ComponentHealth,
    HeartbeatView,
    BootRecoveryRow,
} from '$lib/schemas/task-system-observability.schema.js';
import type { ScheduleOverdueView } from '$lib/schemas/task-system-health.schema.js';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('observability-endpoint');

const def = defineEndpoint({
    // Operational surface (composed liveness/history view) — moved from
    // tasks:read to tasks:admin. security review 2026-09-12, C16.
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not configured');
            }

            // ── Valkey axis (heartbeats + leaders) ──────────────────────────────
            // These readers are best-effort and never throw — they return empty/
            // "dead" views when Valkey is unreachable. So a failed read here is
            // indistinguishable from an idle system; `valkeyAvailable` is derived
            // below from the component-health PING (the authoritative signal).
            let subsystems: HeartbeatView[] = [];
            let leaders: ClassLeader[] = [];
            try {
                [subsystems, leaders] = await Promise.all([readHeartbeats(), readClassLeaders()]);
            } catch (err) {
                log.warn('observability: Valkey reads failed', {
                    err: err instanceof Error ? err.message : String(err),
                });
            }

            // ── DB axis (boot-recovery + schedules + invariants + components) ────
            let bootRecovery: BootRecoveryRow | null = null;
            let schedules: ScheduleOverdueView[] = [];
            let invariants: InvariantFinding[] = [];
            let dbAvailable = true;
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
                        ? new Set(registeredTasks.filter((t) => t.schedule?.every).map((t) => t.id))
                        : undefined;
                const [bootRow, scheduleStates, findings] = await Promise.all([
                    getLatestBootRecovery(sql),
                    listAllScheduledTasks(sql),
                    listFindings(sql),
                ]);
                bootRecovery = bootRow;
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
                    // Carry the richer context so the verdict reason detail is useful
                    // (what's wrong + how many + what to do), not just {id, status}.
                    description: f.description,
                    remediation: f.remediation,
                    value: f.value !== null ? Number(f.value) : null,
                    thresholdAmber: f.threshold_amber !== null ? Number(f.threshold_amber) : null,
                    thresholdRed: f.threshold_red !== null ? Number(f.threshold_red) : null,
                    // Per-target deep links (task name + href) computed by the
                    // invariant's own details() hook when amber/red — see
                    // InvariantDetailLink. Stored as JSONB, so validate the shape
                    // defensively rather than trusting the column blindly.
                    details: Array.isArray(f.details)
                        ? (f.details as InvariantFinding['details'])
                        : undefined,
                }));
            } catch (err) {
                dbAvailable = false;
                log.warn('observability: DB reads failed', {
                    err: err instanceof Error ? err.message : String(err),
                });
            }

            // Component health is independently guarded internally (each component
            // try/caught) — it never throws.
            const componentsRaw = (await buildComponentHealth()) as {
                timestamp?: string;
            } & Record<string, unknown>;
            const { timestamp: _ts, ...componentEntries } = componentsRaw;
            const components: Record<string, ComponentHealth> = {};
            for (const [name, data] of Object.entries(componentEntries)) {
                components[name] = data as ComponentHealth;
            }

            // Authoritative Valkey reachability comes from the component PING, not
            // from whether the (best-effort, never-throwing) readers above returned
            // data — otherwise a Valkey outage mis-reports as `unhealthy`.
            const valkeyAvailable = deriveValkeyAvailable(components);

            const health = computeHealthVerdict({
                heartbeats: subsystems,
                leaders,
                schedules,
                invariants,
                inputsAvailable: { valkey: valkeyAvailable, db: dbAvailable },
            });

            return json({
                timestamp: new Date().toISOString(),
                health,
                schedules,
                subsystems,
                leaders,
                bootRecovery,
                components,
            });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
