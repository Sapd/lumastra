// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for `PipelineTimelineService.buildTimeline` (Slice 2).
 *
 * Seeds an item with stage rows across statuses against the real `lumastra_tests`
 * Postgres, then asserts the composed payload: chronological order, registry
 * task resolution, run-ref attachment (live + expired via an injected
 * RunReader), folded event history, summary, and degraded-row tolerance.
 *
 * Valkey is stubbed (null client → probeUnavailable) so the test is
 * deterministic and Valkey-independent; the diagnosis unit test covers the
 * probe-driven branches.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { z } from 'zod';
import type postgres from 'postgres';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from '$lib/server/tasks/registry.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    insertPendingRow,
    markRunning,
    markCompleted,
    markFailedPermanent,
} from '$lib/server/database/queries/stage-state.queries.js';
import {
    PipelineTimelineService,
    type RunReader,
} from '$lib/server/services/pipeline-timeline.service.js';

const NOW = new Date('2026-06-03T12:00:00Z');

function makeRegistry(): TaskRegistry {
    const reg = new TaskRegistry();
    reg.registerTask(
        defineTask({
            id: 'media-probe',
            name: 'Media Probe',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'ingest',
            inputSchema: z.object({ mediaItemId: z.string().optional() }),
            identityFor: (i) => i.mediaItemId ?? 'global',
            coversStages: [
                {
                    id: 'probe',
                    appliesTo: ['movie'],
                    enqueueable: true,
                    terminalDisposition: {
                        kind: 'self-terminal',
                        ruleId: 'probe-terminal',
                    },
                },
            ],
            async execute() {
                return { success: true };
            },
        }),
    );
    reg.registerTask(
        defineTask({
            id: 'trickplay',
            name: 'Trickplay',
            version: '1.0.0',
            processingVersion: 2,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'cpu',
            inputSchema: z.object({ mediaItemId: z.string().optional() }),
            identityFor: (i) => i.mediaItemId ?? 'global',
            coversStages: [
                {
                    id: 'trick',
                    appliesTo: ['movie'],
                    enqueueable: true,
                    terminalDisposition: {
                        kind: 'self-terminal',
                        ruleId: 'trick-terminal',
                    },
                },
            ],
            async execute() {
                return { success: true };
            },
        }),
    );
    return reg;
}

function nullValkey(): () => null {
    return () => null;
}

async function insertTestMediaItem(
    sql: postgres.Sql,
    mediaType: 'movie' | 'episode' = 'movie',
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, ${mediaType}, ${'Test ' + id.slice(0, 6)})
    `;
    return id;
}

describe('PipelineTimelineService.buildTimeline', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'Test %'`;
        await sql`DELETE FROM task_circuit_state WHERE task_id IN ('media-probe', 'trickplay')`;
    });

    it('composes chronological stages, resolves taskIds, attaches run refs', async () => {
        const itemId = await insertTestMediaItem(sql);
        const liveRunId = 'a0000000-0000-0000-0000-000000000010';

        // 'trick' completes earlier; 'probe' runs later → chronological order
        // must be [trick, probe] even though stage_id sorts probe < trick.
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 'trick',
            processingVersion: 2,
        });
        await markRunning(sql, {
            mediaItemId: itemId,
            stageId: 'trick',
            runId: 'a0000000-0000-0000-0000-000000000001',
        });
        await markCompleted(sql, { mediaItemId: itemId, stageId: 'trick' });
        // Backdate trick so its firstObservedAt is clearly earlier.
        await sql`
            UPDATE media_item_stage_state
               SET started_at = ${new Date(NOW.getTime() - 60_000)}, completed_at = ${new Date(NOW.getTime() - 50_000)}
             WHERE media_item_id = ${itemId}::uuid AND stage_id = 'trick'
        `;

        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 'probe',
            processingVersion: 1,
        });
        await markRunning(sql, {
            mediaItemId: itemId,
            stageId: 'probe',
            runId: liveRunId,
        });
        await sql`
            UPDATE media_item_stage_state
               SET started_at = ${new Date(NOW.getTime() - 10_000)}
             WHERE media_item_id = ${itemId}::uuid AND stage_id = 'probe'
        `;

        const runReader: RunReader = {
            async getRun(runId) {
                if (runId === liveRunId) {
                    return {
                        id: runId,
                        state: 'active',
                        ownerInstanceId: 'web-1',
                        heartbeatAt: NOW.toISOString(),
                        startedAt: new Date(NOW.getTime() - 10_000).toISOString(),
                    };
                }
                return null; // any other run id → expired
            },
        };

        const service = new PipelineTimelineService(sql, {
            registry: makeRegistry(),
            runReader,
            getValkey: nullValkey(),
            now: () => NOW,
        });

        const timeline = await service.buildTimeline(itemId);

        expect(timeline.mediaItemId).toBe(itemId);
        expect(timeline.stages.map((s) => s.stageId)).toEqual(['trick', 'probe']);

        const trick = timeline.stages[0];
        const probe = timeline.stages[1];
        expect(trick.taskId).toBe('trickplay');
        expect(probe.taskId).toBe('media-probe');

        // probe is running with a live run → run ref alive, diagnosis healthy.
        expect(probe.run?.state).toBe('active');
        expect(probe.run?.alive).toBe(true);
        expect(probe.diagnosis?.reason).toBe('running-healthy');
        expect(probe.timeInStageMs).toBeGreaterThan(0);

        // trick completed → time-in-stage = completed − started.
        expect(trick.status).toBe('completed');
        expect(trick.timeInStageMs).toBe(10_000);

        // Summary reflects the rows.
        expect(timeline.summary.total).toBe(2);
        expect(timeline.summary.in_progress).toBe(1);
        expect(timeline.summary.completed).toBe(1);
    });

    it('marks a run ref expired when getRun returns null', async () => {
        const itemId = await insertTestMediaItem(sql);
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 'probe',
            processingVersion: 1,
        });
        await markRunning(sql, {
            mediaItemId: itemId,
            stageId: 'probe',
            runId: 'a0000000-0000-0000-0000-0000000000ff',
        });

        const runReader: RunReader = {
            async getRun() {
                return null;
            },
        };
        const service = new PipelineTimelineService(sql, {
            registry: makeRegistry(),
            runReader,
            getValkey: nullValkey(),
            now: () => NOW,
        });

        const timeline = await service.buildTimeline(itemId);
        const probe = timeline.stages.find((s) => s.stageId === 'probe');
        expect(probe?.run?.state).toBe('expired');
        expect(probe?.run?.alive).toBe(false);
        // running + not-alive → worker-dead.
        expect(probe?.diagnosis?.reason).toBe('worker-dead');
    });

    it('diagnoses circuit-open from a per-task circuit row', async () => {
        const itemId = await insertTestMediaItem(sql);
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 'probe',
            processingVersion: 1,
        });
        await markFailedPermanent(sql, {
            mediaItemId: itemId,
            stageId: 'probe',
            error: { message: 'boom', code: 'E_BOOM', plugin_id: 'media-probe' },
        });
        await sql`
            INSERT INTO task_circuit_state (task_id, state, opened_reason, next_probe_at)
            VALUES ('media-probe', 'open', 'consecutive_failures', ${new Date(NOW.getTime() + 60_000)})
            ON CONFLICT (task_id) DO UPDATE
               SET state = 'open', opened_reason = 'consecutive_failures',
                   next_probe_at = ${new Date(NOW.getTime() + 60_000)}
        `;

        const service = new PipelineTimelineService(sql, {
            registry: makeRegistry(),
            runReader: {
                async getRun() {
                    return null;
                },
            },
            getValkey: nullValkey(),
            now: () => NOW,
        });

        const timeline = await service.buildTimeline(itemId);
        const probe = timeline.stages.find((s) => s.stageId === 'probe');
        expect(probe?.diagnosis?.reason).toBe('circuit-open');
        // full error surfaced with code + plugin_id.
        expect(probe?.lastError?.code).toBe('E_BOOM');
        expect(probe?.lastError?.plugin_id).toBe('media-probe');
    });

    it('folds per-item event_outbox history newest-first', async () => {
        const itemId = await insertTestMediaItem(sql);
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 'probe',
            processingVersion: 1,
        });
        // Insert both events explicitly. The DB trigger that normally emits
        // 'item.created' is disabled in the test environment
        // (event_outbox_enabled=off, set by run-migrations.ts) so it will not
        // fire automatically. This test only verifies that buildTimeline folds
        // and orders events correctly — the trigger mechanics are covered by
        // media-lifecycle-after-created-repro.integration.test.ts.
        await sql`
            INSERT INTO event_outbox (event_name, media_item_id, payload)
            VALUES
                ('item.created', ${itemId}::uuid, ${sql.json({ event: 'item.created' })}),
                ('file.attached', ${itemId}::uuid, ${sql.json({ event: 'file.attached' })})
        `;

        const service = new PipelineTimelineService(sql, {
            registry: makeRegistry(),
            runReader: {
                async getRun() {
                    return null;
                },
            },
            getValkey: nullValkey(),
            now: () => NOW,
        });

        const timeline = await service.buildTimeline(itemId);
        expect(timeline.events.map((e) => e.eventName)).toEqual(['file.attached', 'item.created']);
    });

    it('reports orphaned-stage when no task owns the stage id', async () => {
        const itemId = await insertTestMediaItem(sql);
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 'ghost-stage',
            processingVersion: 1,
        });

        const service = new PipelineTimelineService(sql, {
            registry: makeRegistry(),
            runReader: {
                async getRun() {
                    return null;
                },
            },
            getValkey: nullValkey(),
            now: () => NOW,
        });

        const timeline = await service.buildTimeline(itemId);
        const ghost = timeline.stages.find((s) => s.stageId === 'ghost-stage');
        expect(ghost?.taskId).toBeNull();
        expect(ghost?.diagnosis?.reason).toBe('orphaned-stage');
    });
});

function analyzerRegistry(): TaskRegistry {
    const registry = makeRegistry();
    registry.registerTask(
        defineTask({
            id: 'lumastra-intro-analyzer',
            name: 'Intro Analyzer',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'analysis',
            inputSchema: z.object({
                mediaId: z.string().optional(),
                seasonId: z.string().optional(),
            }),
            exclusiveWith: { scope: 'global', ttl: '8h' },
            identityFor: (input) => {
                const value = input as { mediaId?: string; seasonId?: string };
                return value.mediaId
                    ? `media-${value.mediaId}`
                    : value.seasonId
                      ? `season-${value.seasonId}`
                      : 'global';
            },
            coversStages: [
                {
                    id: 'lumastra-intro-analyzer:visual',
                    appliesTo: ['episode'],
                    enqueueable: true,
                    terminalDisposition: { kind: 'self-terminal', ruleId: 'visual-terminal' },
                },
            ],
            async execute() {
                return { success: true };
            },
        }),
    );
    return registry;
}
describe('cooperative acoustic ownership and per-item identity evidence', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'Test %'`;
    });
    it('resolves pending acoustic rows to the registered season coordinator without declaring or individually queuing them', async () => {
        const mediaItemId = await insertTestMediaItem(sql, 'episode');
        const stageId = 'lumastra-intro-analyzer:acoustic';
        await insertPendingRow(sql, { mediaItemId, stageId, processingVersion: 1 });
        const registry = analyzerRegistry();
        const timeline = await new PipelineTimelineService(sql, {
            registry,
            getValkey: nullValkey(),
            now: () => NOW,
            runReader: {
                async getRun() {
                    return null;
                },
            },
        }).buildTimeline(mediaItemId);
        const stage = timeline.stages.find((row) => row.stageId === stageId)!;
        expect(stage.taskId).toBe('lumastra-intro-analyzer');
        expect(stage.diagnosis).toMatchObject({
            reason: 'none',
            remediable: false,
            detail: { coordination: 'season-cohort' },
        });
        expect(stage.diagnosis?.summary).toContain('whole season');
        expect(stage.prioritizable).toBe(false);
        expect(stage.queueWait).toBeUndefined();
        expect(registry.findTaskByStage(stageId)).toBeUndefined();
        expect(registry.getTask('lumastra-intro-analyzer')?.coversStages).toHaveLength(1);
    });
    it('does not invent cooperative ownership when the analyzer is not registered', async () => {
        const mediaItemId = await insertTestMediaItem(sql, 'episode');
        await insertPendingRow(sql, {
            mediaItemId,
            stageId: 'lumastra-intro-analyzer:acoustic',
            processingVersion: 1,
        });
        const timeline = await new PipelineTimelineService(sql, {
            registry: makeRegistry(),
            getValkey: nullValkey(),
            now: () => NOW,
        }).buildTimeline(mediaItemId);
        expect(timeline.stages[0]).toMatchObject({
            taskId: null,
            diagnosis: { reason: 'orphaned-stage' },
        });
    });
    it('does not probe or allege an orphan item lock from the analyzer shared global scheduling key', async () => {
        const mediaItemId = await insertTestMediaItem(sql, 'episode');
        await insertPendingRow(sql, {
            mediaItemId,
            stageId: 'lumastra-intro-analyzer:visual',
            processingVersion: 1,
        });
        const commands: string[][] = [];
        const timeline = await new PipelineTimelineService(sql, {
            registry: analyzerRegistry(),
            now: () => NOW,
            getValkey: () => ({
                async customCommand(args: string[]) {
                    commands.push(args);
                    if (args[0] === 'PTTL') return 8 * 3600000;
                    return args
                        .slice(1)
                        .map((key) =>
                            key.startsWith('task:identity:') ? 'some-other-global-run' : '0',
                        );
                },
            }),
        }).buildTimeline(mediaItemId);
        expect(timeline.stages[0].diagnosis?.reason).not.toBe('identity-locked');
        expect(commands.flat().some((value) => value.startsWith('task:identity:'))).toBe(false);
        expect(commands.some((command) => command[0] === 'PTTL')).toBe(false);
    });
    it('retains the registered coordinator pause and metadata on a pending acoustic row', async () => {
        const mediaItemId = await insertTestMediaItem(sql, 'episode');
        await insertPendingRow(sql, {
            mediaItemId,
            stageId: 'lumastra-intro-analyzer:acoustic',
            processingVersion: 1,
        });
        await sql`INSERT INTO scheduler_state(task_id,last_fired_at,next_fire_at,paused,paused_by,paused_at)
            VALUES ('lumastra-intro-analyzer',NULL,${NOW},true,'fixture-admin',${NOW})`;
        try {
            const timeline = await new PipelineTimelineService(sql, {
                registry: analyzerRegistry(),
                getValkey: nullValkey(),
                now: () => NOW,
            }).buildTimeline(mediaItemId);
            expect(timeline.stages[0]).toMatchObject({
                taskId: 'lumastra-intro-analyzer',
                operatorState: 'off',
                diagnosis: { reason: 'schedule-paused' },
                paused: {
                    taskId: 'lumastra-intro-analyzer',
                    pausedBy: 'fixture-admin',
                    pausedAt: NOW.toISOString(),
                },
            });
            expect(timeline.stages[0].queueWait).toBeUndefined();
        } finally {
            await sql`DELETE FROM scheduler_state WHERE task_id='lumastra-intro-analyzer'`;
        }
    });
});
