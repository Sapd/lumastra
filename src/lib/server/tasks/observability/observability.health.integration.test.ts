// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for the Slice-1 rollup health pipeline.
 *
 * Exercises the SAME gather + compute path the
 * `/api/admin/task-system/observability` route uses — `listAllScheduledTasks`,
 * `listFindings`, `computeScheduleOverdue`, `computeHealthVerdict` — against a
 * real Postgres (`lumastra_tests`), seeding `scheduler_state` and
 * `health_check_findings`. The route itself is a thin `requireAdmin` wrapper
 * over this pipeline; testing the pipeline avoids SvelteKit event plumbing while
 * still covering the DB-backed reads and the verdict aggregation end-to-end.
 *
 * Requires TEST_DATABASE_URL pointing at a migrated lumastra_tests; skipped
 * automatically when absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { listAllScheduledTasks } from '$lib/server/tasks/scheduler-state.js';
import { listFindings } from '$lib/server/database/queries/health-check-findings.queries.js';
import { computeScheduleOverdue } from './schedule-overdue.js';
import { computeHealthVerdict, type InvariantFinding } from './health-verdict.js';
import type { ClassLeader, HeartbeatView } from '$lib/schemas/task-system-observability.schema.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const RUN = Boolean(TEST_DATABASE_URL);

const SEED_PREFIX = 'slice1-health-test-';

const ALIVE_SUBSYSTEMS: HeartbeatView[] = [
    { name: 'scheduler', alive: true, status: 'ok' },
    { name: 'reconciler', alive: true, status: 'ok', leaderGated: true },
];
const HELD_LEADERS: ClassLeader[] = [
    {
        resourceClass: 'cpu',
        holderInstanceId: 'web-1',
        heldByThisReplica: true,
        ttlMs: 4_000,
    },
    {
        resourceClass: 'io',
        holderInstanceId: 'web-1',
        heldByThisReplica: true,
        ttlMs: 4_000,
    },
];

describe.runIf(RUN)('Slice-1 rollup health pipeline (DB-backed)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
        try {
            await sql`SELECT 1 FROM scheduler_state LIMIT 0`;
            await sql`SELECT 1 FROM health_check_findings LIMIT 0`;
        } catch (e) {
            throw new Error(
                `required tables missing — run db:test:migrate first. ${(e as Error).message}`,
                { cause: e },
            );
        }
    }, 30_000);

    afterAll(async () => {
        await cleanup();
        await sql.end();
    });

    beforeEach(cleanup);

    async function cleanup(): Promise<void> {
        await sql`DELETE FROM scheduler_state WHERE task_id LIKE ${SEED_PREFIX + '%'}`;
        await sql`DELETE FROM health_check_findings WHERE invariant_id LIKE ${SEED_PREFIX + '%'}`;
    }

    async function seedSchedule(taskId: string, nextFireAt: Date, paused: boolean): Promise<void> {
        await sql`
            INSERT INTO scheduler_state (task_id, last_fired_at, next_fire_at, paused, paused_by, paused_at)
            VALUES (${SEED_PREFIX + taskId}, NULL, ${nextFireAt}, ${paused}, NULL, NULL)
        `;
    }

    async function seedFinding(id: string, status: string): Promise<void> {
        await sql`
            INSERT INTO health_check_findings (
                invariant_id, status, value, label, description, remediation,
                threshold_amber, threshold_red, last_run_at, last_change_at, last_value_at, error
            ) VALUES (
                ${SEED_PREFIX + id}, ${status}, NULL, ${'label ' + id}, 'desc', NULL,
                NULL, NULL, NOW(), NOW(), NOW(), NULL
            )
        `;
    }

    /** Gather the DB axis exactly as the route does, scoped to seeded rows. */
    async function gatherSeeded(): Promise<{
        schedules: ReturnType<typeof computeScheduleOverdue>;
        invariants: InvariantFinding[];
    }> {
        const allStates = await listAllScheduledTasks(sql);
        const seededStates = allStates.filter((s) => s.taskId.startsWith(SEED_PREFIX));
        const schedules = computeScheduleOverdue(seededStates, Date.now());

        const allFindings = await listFindings(sql);
        const invariants: InvariantFinding[] = allFindings
            .filter((f) => f.invariant_id.startsWith(SEED_PREFIX))
            .map((f) => ({
                status: f.status,
                id: f.invariant_id,
                label: f.label,
            }));

        return { schedules, invariants };
    }

    it('red finding + overdue schedule → unhealthy with both reasons', async () => {
        await seedSchedule('overdue', new Date(Date.now() - 600_000), false);
        await seedSchedule('ontime', new Date(Date.now() + 600_000), false);
        await seedSchedule('paused', new Date(Date.now() - 600_000), true);
        await seedFinding('stuck-red', 'red');

        const { schedules, invariants } = await gatherSeeded();

        // Schedule shape assertions.
        const overdue = schedules.find((s) => s.taskId === SEED_PREFIX + 'overdue');
        const paused = schedules.find((s) => s.taskId === SEED_PREFIX + 'paused');
        expect(overdue?.overdue).toBe(true);
        expect(paused?.overdue).toBe(false);

        const verdict = computeHealthVerdict({
            heartbeats: ALIVE_SUBSYSTEMS,
            leaders: HELD_LEADERS,
            schedules,
            invariants,
            inputsAvailable: { valkey: true, db: true },
        });

        expect(verdict.status).toBe('unhealthy');
        expect(verdict.reasons.some((r) => r.code === 'invariant-red')).toBe(true);
        expect(verdict.reasons.some((r) => r.code === 'schedule-overdue')).toBe(true);
        // Taxonomy enum value is one of the four.
        expect(['healthy', 'degraded', 'unhealthy', 'unknown']).toContain(verdict.status);
    });

    it('all-green seed → healthy with empty reasons', async () => {
        await seedSchedule('ontime', new Date(Date.now() + 600_000), false);
        await seedFinding('clean', 'green');

        const { schedules, invariants } = await gatherSeeded();
        const verdict = computeHealthVerdict({
            heartbeats: ALIVE_SUBSYSTEMS,
            leaders: HELD_LEADERS,
            schedules,
            invariants,
            inputsAvailable: { valkey: true, db: true },
        });

        expect(verdict.status).toBe('healthy');
        expect(verdict.reasons).toEqual([]);
    });

    it('valkey unreadable → unknown regardless of DB seed', async () => {
        await seedFinding('stuck-red', 'red');
        const { schedules, invariants } = await gatherSeeded();

        const verdict = computeHealthVerdict({
            heartbeats: [],
            leaders: [],
            schedules,
            invariants,
            inputsAvailable: { valkey: false, db: true },
        });

        expect(verdict.status).toBe('unknown');
        expect(verdict.reasons).toHaveLength(1);
        expect(verdict.reasons[0].code).toBe('inputs-unreadable');
    });
});
