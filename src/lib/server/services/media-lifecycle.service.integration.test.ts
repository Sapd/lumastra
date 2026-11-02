// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';
import { TaskRegistry, setTestRegistry } from '$lib/server/tasks/registry.js';
import { findRowsByItem } from '$lib/server/database/queries/stage-state.queries.js';
import type { AnyTaskDefinition, CoversStagesDeclaration } from '@sapd/lumastra-plugin-sdk';

// These tests exercise MediaLifecycleService's OWN (legacy) direct stage-state
// invalidation wrappers, which only run when FEATURE_PIPELINE_EVENT_OUTBOX is
// OFF (its default flipped to true; the DB-trigger + event-outbox dispatcher own
// invalidation otherwise). The flag is a load-time const in config.ts, so it's
// forced off in vitest.integration.config.ts's env block (applied before any
// setup file imports config — a per-file vi.mock/vi.hoisted is too late).
// ---------------------------------------------------------------------------
// Orchestrator mock — placed before any import that would transitively load
// the real orchestrator. The vi.mock factory is hoisted by Vitest.
// ---------------------------------------------------------------------------
const startRunMock = vi.fn().mockResolvedValue({ deduped: false });
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: (...args: unknown[]) => startRunMock(...args),
    },
}));

function mkTask(
    id: string,
    opts: {
        version?: number;
        coversStages?: ReadonlyArray<CoversStagesDeclaration>;
    },
): AnyTaskDefinition {
    return defineTask({
        id,
        name: id,
        version: '1.0.0',
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        processingVersion: opts.version ?? 2,
        inputSchema: z.object({}),
        identityFor: () => id,
        manualOnly: true,
        coversStages: opts.coversStages,
        execute: async () => ({ success: true as const }),
    });
}

describe('MediaLifecycleService.afterCreated', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        startRunMock.mockClear();
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'lifecycle-test-%'`;
        // Reset test registry override after each test
        setTestRegistry(new TaskRegistry());
    });

    it('seeds rows for every applicable stage at the task processingVersion', async () => {
        const reg = new TaskRegistry();
        const t = mkTask('t', {
            version: 2,
            coversStages: [
                { id: 'a', appliesTo: ['movie'] as const },
                {
                    id: 'b',
                    appliesTo: ['movie'] as const,
                    // Immutable appliesTo false → skipped_permanent/'ineligible' (new contract).
                    eligibility: { appliesTo: () => false },
                },
            ],
        });
        reg.registerTask(t);
        setTestRegistry(reg);

        const id = await insertMovie(sql);
        await MediaLifecycleService.afterCreated(id, 'lifecycle-test');

        const rows = await findRowsByItem(sql, id);
        const byStage = Object.fromEntries(rows.map((r) => [r.stage_id, r]));
        expect(byStage['a']?.status).toBe('pending');
        expect(byStage['a']?.processing_version).toBe(2);
        expect(byStage['b']?.status).toBe('skipped_permanent');
        expect(byStage['b']?.skipped_reason).toBe('ineligible');
    });

    it('seeds NO rows for media types not covered by any task', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('movie-only', {
                coversStages: [{ id: 's', appliesTo: ['movie'] as const }],
            }),
        );
        setTestRegistry(reg);

        const id = await insertTrack(sql);
        await MediaLifecycleService.afterCreated(id, 'lifecycle-test');
        const rows = await findRowsByItem(sql, id);
        expect(rows).toEqual([]);
    });

    it('is idempotent: calling twice does not duplicate rows', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                coversStages: [{ id: 'a', appliesTo: ['movie'] as const }],
            }),
        );
        setTestRegistry(reg);

        const id = await insertMovie(sql);
        await MediaLifecycleService.afterCreated(id, 'lifecycle-test');
        await MediaLifecycleService.afterCreated(id, 'lifecycle-test');
        const rows = await findRowsByItem(sql, id);
        expect(rows).toHaveLength(1);
    });
});

describe('MediaLifecycleService.afterMatched', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'matched-test-%'`;
        setTestRegistry(new TaskRegistry());
    });

    it('promotes identity-invalidated rows from skipped_permanent to pending', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                coversStages: [
                    {
                        id: 'identity-stage',
                        appliesTo: ['movie'] as const,
                        invalidatedBy: [
                            'identity.assigned',
                            'identity.changed',
                            'identity.cleared',
                        ] as const,
                    },
                ],
            }),
        );
        setTestRegistry(reg);

        const id = await insertMatchedMovie(sql);
        await MediaLifecycleService.afterCreated(id, 'matched-test');
        // simulate prior skip (e.g., no provider match yet)
        await sql`
            UPDATE media_item_stage_state SET status = 'skipped_permanent'
             WHERE media_item_id = ${id}::uuid AND stage_id = 'identity-stage'
        `;

        await MediaLifecycleService.afterMatched(id, 'movie', {
            match: { provider: 'tmdb', externalId: '12345' },
        });

        const rows = await findRowsByItem(sql, id);
        expect(rows[0]?.status).toBe('pending');
    });

    it('does not touch non-identity-invalidated stages', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                coversStages: [
                    {
                        id: 'content-stage',
                        appliesTo: ['movie'] as const,
                        invalidatedBy: [
                            'file.attached',
                            'file.detached',
                            'file.contentChanged',
                            'file.defaultChanged',
                        ] as const,
                    },
                ],
            }),
        );
        setTestRegistry(reg);

        const id = await insertMatchedMovie(sql);
        await MediaLifecycleService.afterCreated(id, 'matched-test');
        await sql`
            UPDATE media_item_stage_state SET status = 'completed'
             WHERE media_item_id = ${id}::uuid AND stage_id = 'content-stage'
        `;

        await MediaLifecycleService.afterMatched(id, 'movie', {
            match: { provider: 'tmdb', externalId: '12345' },
        });

        const rows = await findRowsByItem(sql, id);
        expect(rows[0]?.status).toBe('completed');
    });
});

describe('MediaLifecycleService.afterMatched — metadata-sync routing', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        startRunMock.mockClear();
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_files WHERE file_path LIKE 'route-test-%'`;
        await sql`DELETE FROM media_items WHERE title LIKE 'route-test-%'`;
        // Empty registry → the identity invalidation path enqueues nothing, so
        // startRunMock only ever reflects the metadata-sync enqueue under test.
        setTestRegistry(new TaskRegistry());
    });

    async function insertOfType(mediaType: string, parentId?: string): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, media_type, title, parent_id)
            VALUES (${id}::uuid, ${mediaType}, ${'route-test-' + id.slice(0, 6)}, ${parentId ?? null})
        `;
        return id;
    }

    // Attach a file so the phantom-series gate (afterMatched) sees an owned
    // descendant and allows the series-sync enqueue.
    async function attachFile(mediaItemId: string): Promise<void> {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES (${'route-test-' + mediaItemId.slice(0, 6)})
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${f.id}::uuid, ${mediaItemId}::uuid)
        `;
    }

    const metadataSyncCall = (): unknown[] | undefined =>
        startRunMock.mock.calls.find(
            (c) => c[0] === 'tmdb-metadata-sync' || c[0] === 'series-sync',
        ) as unknown[] | undefined;

    it('routes a matched movie to tmdb-metadata-sync', async () => {
        const id = await insertOfType('movie');
        await MediaLifecycleService.afterMatched(id, 'movie', { enqueueMetadataSync: true });
        expect(metadataSyncCall()?.[0]).toBe('tmdb-metadata-sync');
    });

    it('routes a matched series WITH owned files to series-sync', async () => {
        const seriesId = await insertOfType('tv');
        const episodeId = await insertOfType('episode', seriesId);
        await attachFile(episodeId);
        await MediaLifecycleService.afterMatched(seriesId, 'tv', { enqueueMetadataSync: true });
        expect(metadataSyncCall()?.[0]).toBe('series-sync');
    });

    it('does NOT enqueue series-sync for a phantom series (no owned files)', async () => {
        // Regression: a fileless discovery series would phantom-skip inside
        // series-sync anyway; enqueuing it just spawns a no-op run that burns a
        // TMDB call. Prod saw ~65 such runs/5min for a single 65-episode phantom.
        const seriesId = await insertOfType('tv');
        await insertOfType('episode', seriesId); // child, but no file attached
        await MediaLifecycleService.afterMatched(seriesId, 'tv', { enqueueMetadataSync: true });
        expect(metadataSyncCall()).toBeUndefined();
    });

    it('DOES enqueue a phantom series when the match is admin-forced (manual)', async () => {
        // Admin "re-sync series children" must still work before any file lands —
        // the in-task phantom gate honors force, so afterMatched must not pre-empt it.
        const seriesId = await insertOfType('tv');
        await MediaLifecycleService.afterMatched(seriesId, 'tv', {
            enqueueMetadataSync: true,
            manual: true,
        });
        expect(metadataSyncCall()?.[0]).toBe('series-sync');
    });

    async function markSynced(mediaId: string, stageId: string, agoMinutes: number): Promise<void> {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, completed_at)
            VALUES (${mediaId}::uuid, ${stageId}, 1, 'completed',
                now() - make_interval(mins => ${agoMinutes}))
        `;
    }

    // Prod 2026-09-28: a show is matched once per episode file, and ingest runs per
    // file — 41 series-sync runs in 5 minutes for one new show, 312/day for a series
    // whose duplicate file reconcile re-proposed every 5 minutes.
    it('does NOT re-enqueue series-sync when it completed for this series minutes ago', async () => {
        const seriesId = await insertOfType('tv');
        const episodeId = await insertOfType('episode', seriesId);
        await attachFile(episodeId);
        await markSynced(seriesId, 'series-sync', 5);

        await MediaLifecycleService.afterMatched(seriesId, 'tv', { enqueueMetadataSync: true });

        expect(metadataSyncCall()).toBeUndefined();
    });

    it('re-enqueues once the last sync is older than the window', async () => {
        const seriesId = await insertOfType('tv');
        const episodeId = await insertOfType('episode', seriesId);
        await attachFile(episodeId);
        await markSynced(seriesId, 'series-sync', 45);

        await MediaLifecycleService.afterMatched(seriesId, 'tv', { enqueueMetadataSync: true });

        expect(metadataSyncCall()?.[0]).toBe('series-sync');
    });

    it('an admin-manual match syncs even right after a sync', async () => {
        const id = await insertOfType('movie');
        await markSynced(id, 'tmdb-metadata-sync', 1);

        await MediaLifecycleService.afterMatched(id, 'movie', {
            enqueueMetadataSync: true,
            manual: true,
        });

        expect(metadataSyncCall()?.[0]).toBe('tmdb-metadata-sync');
    });

    it('does NOT enqueue a per-item metadata sync for an episode (both tasks reject episodes)', async () => {
        const id = await insertOfType('episode');
        // Regression: previously routed to tmdb-metadata-sync, which throws a
        // PERMANENT "per-item path is for movies only" error for every episode.
        await MediaLifecycleService.afterMatched(id, 'episode', { enqueueMetadataSync: true });
        expect(metadataSyncCall()).toBeUndefined();
    });
});

async function insertMovie(sql: postgres.Sql, prefix: string = 'lifecycle-test'): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, 'movie', ${prefix + '-' + id.slice(0, 6)})
    `;
    return id;
}

async function insertMatchedMovie(sql: postgres.Sql): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, 'movie', ${'matched-test-' + id.slice(0, 6)})
    `;
    return id;
}

async function insertTrack(sql: postgres.Sql): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, 'track', ${'lifecycle-test-' + id.slice(0, 6)})
    `;
    return id;
}

describe('MediaLifecycleService.afterContentChanged', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'lc-test-%'`;
        setTestRegistry(new TaskRegistry());
    });

    it('promotes file-content-invalidated rows to pending', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                coversStages: [
                    {
                        id: 'content-stage',
                        appliesTo: ['movie'] as const,
                        invalidatedBy: [
                            'file.attached',
                            'file.detached',
                            'file.contentChanged',
                            'file.defaultChanged',
                        ] as const,
                    },
                ],
            }),
        );
        setTestRegistry(reg);

        const id = await insertMovie(sql);
        await MediaLifecycleService.afterCreated(id, 'lc-test');
        await sql`UPDATE media_item_stage_state SET status='completed' WHERE media_item_id=${id}::uuid`;

        await MediaLifecycleService.afterContentChanged(id);

        const rows = await findRowsByItem(sql, id);
        expect(rows[0]?.status).toBe('pending');
    });
});

describe('MediaLifecycleService.afterMetadataChanged', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'lc-test-%'`;
        setTestRegistry(new TaskRegistry());
    });

    it('promotes metadata-invalidated rows but leaves content-invalidated alone', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                coversStages: [
                    {
                        id: 'meta',
                        appliesTo: ['movie'] as const,
                        invalidatedBy: ['metadata.changed'] as const,
                    },
                    {
                        id: 'content',
                        appliesTo: ['movie'] as const,
                        invalidatedBy: [
                            'file.attached',
                            'file.detached',
                            'file.contentChanged',
                            'file.defaultChanged',
                        ] as const,
                    },
                ],
            }),
        );
        setTestRegistry(reg);

        const id = await insertMovie(sql);
        await MediaLifecycleService.afterCreated(id, 'lc-test');
        await sql`UPDATE media_item_stage_state SET status='completed' WHERE media_item_id=${id}::uuid`;

        await MediaLifecycleService.afterMetadataChanged(id, []);

        const rows = await findRowsByItem(sql, id);
        const byStage = Object.fromEntries(rows.map((r) => [r.stage_id, r.status]));
        expect(byStage['meta']).toBe('pending');
        expect(byStage['content']).toBe('completed');
    });
});

describe('MediaLifecycleService.afterDismissed', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_embeddings WHERE media_id IN (SELECT id FROM media_items WHERE title LIKE 'dismiss-test-%')`;
        await sql`DELETE FROM media_items WHERE title LIKE 'dismiss-test-%'`;
        setTestRegistry(new TaskRegistry());
    });

    it('deletes every stage-state row for the item', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                coversStages: [{ id: 's', appliesTo: ['movie'] as const }],
            }),
        );
        setTestRegistry(reg);

        const id = await insertMovie(sql, 'dismiss-test');
        await MediaLifecycleService.afterCreated(id, 'dismiss-test');
        const before = await findRowsByItem(sql, id);
        expect(before.length).toBeGreaterThan(0);

        await MediaLifecycleService.afterDismissed(id);

        const after = await findRowsByItem(sql, id);
        expect(after).toEqual([]);
    });

    it('fires embedding cleanup immediately (not 30 days later)', async () => {
        const id = await insertMovie(sql, 'dismiss-test');
        const zeroEmb = Array(1024).fill(0);
        const vectorString = `[${zeroEmb.join(',')}]`;
        await sql`
            INSERT INTO media_embeddings (media_id, source, embedding)
            VALUES (${id}::uuid, 'library', ${vectorString}::vector)
        `;

        await MediaLifecycleService.afterDismissed(id);

        const remaining = await sql`SELECT 1 FROM media_embeddings WHERE media_id = ${id}::uuid`;
        expect(remaining).toEqual([]);
    });

    it('is safe to call multiple times', async () => {
        const id = await insertMovie(sql, 'dismiss-test');
        await MediaLifecycleService.afterDismissed(id);
        await MediaLifecycleService.afterDismissed(id);
        // no throw
    });
});

describe('MediaLifecycleService.afterReplaced', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        startRunMock.mockClear();
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'lc-test-%'`;
        setTestRegistry(new TaskRegistry());
    });

    it('behaves like afterContentChanged for file-content-invalidated stages', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                coversStages: [
                    {
                        id: 'content-stage',
                        appliesTo: ['movie'] as const,
                        invalidatedBy: [
                            'file.attached',
                            'file.detached',
                            'file.contentChanged',
                            'file.defaultChanged',
                        ] as const,
                    },
                ],
            }),
        );
        setTestRegistry(reg);

        const id = await insertMovie(sql);
        await MediaLifecycleService.afterCreated(id, 'lc-test');
        await sql`UPDATE media_item_stage_state SET status='completed' WHERE media_item_id=${id}::uuid`;

        await MediaLifecycleService.afterReplaced(id);

        const rows = await findRowsByItem(sql, id);
        expect(rows[0]?.status).toBe('pending');
    });
});

// ---------------------------------------------------------------------------
// Eager-enqueue tests — mock orchestrator is declared at top of file
// ---------------------------------------------------------------------------

function mkEnqueueableTask(
    id: string,
    stageId: string,
    opts: {
        invalidatedBy?: ReadonlyArray<string>;
        enqueueable?: boolean;
    } = {},
): AnyTaskDefinition {
    return defineTask({
        id,
        name: id,
        version: '1.0.0',
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        processingVersion: 1,
        inputSchema: z.object({ mediaItemId: z.string().optional() }),
        identityFor: (input) => (input as { mediaItemId?: string }).mediaItemId ?? id,
        manualOnly: true,
        coversStages: [
            {
                id: stageId,
                appliesTo: ['movie'] as const,
                invalidatedBy: opts.invalidatedBy as
                    ReadonlyArray<import('$lib/types/pipeline').PipelineEventName> | undefined,
                enqueueable: opts.enqueueable ?? true,
                // Declarative Stage Contract (2026-06-01): every enqueueable stage
                // must declare a terminalDisposition or registration throws.
                ...((opts.enqueueable ?? true)
                    ? {
                          terminalDisposition: {
                              kind: 'self-terminal' as const,
                              ruleId: `${stageId}-self-terminal`,
                          },
                      }
                    : {}),
            },
        ],
        execute: async () => ({ success: true as const }),
    });
}

describe('MediaLifecycleService eager-enqueue: afterCreated', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        startRunMock.mockClear();
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'eager-test-%'`;
        setTestRegistry(new TaskRegistry());
    });

    it('calls startRun once per enqueueable pending stage after afterCreated', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(mkEnqueueableTask('eq-task', 'eq-stage', { enqueueable: true }));
        setTestRegistry(reg);

        const id = await insertMovie(sql, 'eager-test');
        await MediaLifecycleService.afterCreated(id, 'eager-test');

        expect(startRunMock).toHaveBeenCalledOnce();
        const [taskId, input, opts] = startRunMock.mock.calls[0] as [string, unknown, unknown];
        expect(taskId).toBe('eq-task');
        expect(input).toMatchObject({ mediaItemId: id });
        // Aligned with stage-sweep: `coverage:<stageId>:<mediaItemId>` so the
        // two paths dedupe against each other within the 24h identity window.
        expect(opts).toMatchObject({
            idempotencyKey: `coverage:eq-stage:${id}`,
        });
    });

    it('does not call startRun for stages with enqueueable omitted/false', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkEnqueueableTask('no-eq-task', 'no-eq-stage', {
                enqueueable: false,
            }),
        );
        setTestRegistry(reg);

        const id = await insertMovie(sql, 'eager-test');
        await MediaLifecycleService.afterCreated(id, 'eager-test');

        expect(startRunMock).not.toHaveBeenCalled();
    });
});

describe('MediaLifecycleService eager-enqueue: afterContentChanged', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        startRunMock.mockClear();
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'eager-test-%'`;
        setTestRegistry(new TaskRegistry());
    });

    it('enqueues only content-bound stages after afterContentChanged', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkEnqueueableTask('content-task', 'content-stage', {
                invalidatedBy: [
                    'file.attached',
                    'file.detached',
                    'file.contentChanged',
                    'file.defaultChanged',
                ],
                enqueueable: true,
            }),
        );
        reg.registerTask(
            mkEnqueueableTask('meta-task', 'meta-stage', {
                invalidatedBy: ['metadata.changed'],
                enqueueable: true,
            }),
        );
        setTestRegistry(reg);

        const id = await insertMovie(sql, 'eager-test');
        await MediaLifecycleService.afterCreated(id, 'eager-test');
        startRunMock.mockClear();
        await sql`UPDATE media_item_stage_state SET status='completed' WHERE media_item_id=${id}::uuid`;

        await MediaLifecycleService.afterContentChanged(id);

        const calledTaskIds = startRunMock.mock.calls.map((c) => c[0]);
        expect(calledTaskIds).toContain('content-task');
        expect(calledTaskIds).not.toContain('meta-task');
    });
});

describe('MediaLifecycleService eager-enqueue: afterDismissed', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        startRunMock.mockClear();
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'eager-test-%'`;
        setTestRegistry(new TaskRegistry());
    });

    it('does NOT call startRun after afterDismissed (rows deleted, not pending)', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkEnqueueableTask('dismiss-eq-task', 'dismiss-eq-stage', {
                enqueueable: true,
            }),
        );
        setTestRegistry(reg);

        const id = await insertMovie(sql, 'eager-test');
        await MediaLifecycleService.afterCreated(id, 'eager-test');
        startRunMock.mockClear();

        await MediaLifecycleService.afterDismissed(id);

        expect(startRunMock).not.toHaveBeenCalled();
    });
});
