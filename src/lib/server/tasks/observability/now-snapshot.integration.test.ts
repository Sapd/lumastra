// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for the Slice-4 `/api/admin/task-system/now` data assembly.
 *
 * Exercises the SAME DB-backed gather + compose path the `/now` route uses —
 * `listAllScheduledTasks` → `computeScheduleOverdue` for the schedule
 * countdowns, then `buildClassSnapshots` / `buildNodeSnapshots` /
 * `buildNowHealth` over those plus synthetic queue-depth/caps/cluster inputs —
 * against a real Postgres (`lumastra_tests`), seeding `scheduler_state`. The
 * route itself is a thin `requireAdmin` wrapper over this assembly; testing the
 * assembly avoids Valkey/BullMQ/SvelteKit plumbing while still covering the
 * DB-backed schedule reads end-to-end (mirrors the Slice-1 health pipeline test).
 *
 * Requires TEST_DATABASE_URL pointing at a migrated lumastra_tests; skipped
 * automatically when absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { listAllScheduledTasks } from '$lib/server/tasks/scheduler-state.js';
import { computeScheduleOverdue } from './schedule-overdue.js';
import {
    buildClassSnapshots,
    buildNodeSnapshots,
    buildNowHealth,
    type AssembleNowSnapshotInput,
} from './now-snapshot.js';
import type { LiveClusterNode } from '$lib/server/services/cluster-heartbeat.service.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const RUN = Boolean(TEST_DATABASE_URL);

const SEED_PREFIX = 'slice4-now-test-';

const NODE = (instanceId: string): LiveClusterNode => ({
    instanceId,
    role: 'web',
    version: '1.0.0',
    hostname: 'h',
    startedAt: new Date().toISOString(),
    uptimeSeconds: 5,
    keyFingerprint: 'aaaaaaaaaaaaaaaa',
});

describe.runIf(RUN)('Slice-4 /now snapshot assembly (DB-backed)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
        try {
            await sql`SELECT 1 FROM scheduler_state LIMIT 0`;
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
    }

    async function seedSchedule(taskId: string, nextFireAt: Date, paused: boolean): Promise<void> {
        await sql`
            INSERT INTO scheduler_state (task_id, last_fired_at, next_fire_at, paused, paused_by, paused_at)
            VALUES (${SEED_PREFIX + taskId}, NULL, ${nextFireAt}, ${paused}, NULL, NULL)
        `;
    }

    /** Gather the schedule axis exactly as the route does, scoped to seeded rows. */
    async function gatherSchedules(): Promise<ReturnType<typeof computeScheduleOverdue>> {
        const all = await listAllScheduledTasks(sql);
        const seeded = all.filter((s) => s.taskId.startsWith(SEED_PREFIX));
        const classByTaskId = new Map<string, string>([[SEED_PREFIX + 'overdue', 'cpu']]);
        return computeScheduleOverdue(seeded, Date.now(), undefined, classByTaskId);
    }

    // `schedules` is carried straight through to the /now response; the assembly
    // helpers don't reshape it (the route returns Slice 1's view as-is), so this
    // builds only the class/node/health inputs the helpers consume.
    function assembleInput(): AssembleNowSnapshotInput {
        return {
            resourceClasses: ['cpu', 'io'],
            queueDepths: {
                cpu: { waiting: 1, active: 2, delayed: 0, paused: false },
                io: { waiting: 0, active: 0, delayed: 0, paused: false },
            },
            caps: { cpu: 2, io: 4 },
            leaders: [{ resourceClass: 'cpu', holderInstanceId: 'web-1' }],
            nodes: [NODE('web-1'), NODE('web-2')],
            selfInstanceId: 'web-1',
            healthStatus: 'healthy',
            healthAvailable: true,
        };
    }

    it('assembles class saturation, node identity, and schedule countdowns from real scheduler_state', async () => {
        await seedSchedule('overdue', new Date(Date.now() - 600_000), false);
        await seedSchedule('ontime', new Date(Date.now() + 600_000), false);
        await seedSchedule('paused', new Date(Date.now() - 600_000), true);

        const schedules = await gatherSchedules();

        // Schedule axis (Slice 1 view, single-sourced) carried into /now.
        const overdue = schedules.find((s) => s.taskId === SEED_PREFIX + 'overdue');
        const ontime = schedules.find((s) => s.taskId === SEED_PREFIX + 'ontime');
        const paused = schedules.find((s) => s.taskId === SEED_PREFIX + 'paused');
        expect(overdue?.overdue).toBe(true);
        expect(overdue?.resourceClass).toBe('cpu'); // resourceClass carried up front
        expect(ontime?.overdue).toBe(false);
        expect(paused?.overdue).toBe(false); // paused never overdue

        const input = assembleInput();

        // Class snapshots: cpu is at cap (2/2 → amber boundary), leader attached.
        const classes = buildClassSnapshots(input);
        const cpu = classes.find((c) => c.resourceClass === 'cpu')!;
        expect(cpu.active).toBe(2);
        expect(cpu.cap).toBe(2);
        expect(cpu.saturationPct).toBe(1);
        expect(cpu.leaderInstanceId).toBe('web-1');
        const io = classes.find((c) => c.resourceClass === 'io')!;
        expect(io.leaderInstanceId).toBeNull(); // has leaders generally, none for io

        // Node identity join inputs.
        const nodes = buildNodeSnapshots(input);
        expect(nodes.find((n) => n.instanceId === 'web-1')?.isSelf).toBe(true);
        expect(nodes.find((n) => n.instanceId === 'web-2')?.isSelf).toBe(false);
        expect(nodes.every((n) => n.online)).toBe(true);

        // Health summary passthrough.
        expect(buildNowHealth(input)).toEqual({
            status: 'healthy',
            available: true,
        });
    });

    it('degrades health to unknown when observability inputs are unavailable', () => {
        const input: AssembleNowSnapshotInput = {
            ...assembleInput(),
            healthStatus: null,
            healthAvailable: false,
            leaders: [], // Slice 0 absent → no leader badges
        };
        expect(buildNowHealth(input)).toEqual({
            status: 'unknown',
            available: false,
        });
        for (const c of buildClassSnapshots(input)) {
            expect('leaderInstanceId' in c).toBe(false);
        }
    });
});
