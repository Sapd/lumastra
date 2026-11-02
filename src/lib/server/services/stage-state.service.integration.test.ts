// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { StageStateService } from './stage-state.service.js';
import { TaskRegistry } from '$lib/server/tasks/registry.js';
import type { AnyTaskDefinition, CoversStagesDeclaration } from '@sapd/lumastra-plugin-sdk';

vi.mock('$lib/server/cache/pipeline-pubsub.js', () => ({
    publishStageStateChange: vi.fn().mockResolvedValue(undefined),
}));

function mkTask(
    id: string,
    coversStages: ReadonlyArray<CoversStagesDeclaration>,
): AnyTaskDefinition {
    return defineTask({
        id,
        name: id,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.object({}),
        identityFor: () => 'global',
        manualOnly: true,
        coversStages,
        async execute() {
            return { success: true };
        },
    });
}

const movieStageTask = mkTask('t-movie', [{ id: 'movie-stage', appliesTo: ['movie'] as const }]);

const audioStageTask = mkTask('t-audio', [
    {
        id: 'audio-stage',
        appliesTo: ['track'] as const,
        // Immutable/external eligibility predicate — gates ROW CREATION at seed
        // (false ⇒ no row, NEVER skipped_permanent).
        eligibility: { appliesTo: (item) => item.has_audio },
    },
]);

describe('StageStateService — snapshot + applicable', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'svc-test-%'`;
    });

    it('loadItemSnapshot returns the columns the predicate needs', async () => {
        const id = await insertMediaItem(sql, 'track', { has_audio: true });
        const svc = new StageStateService(sql, new TaskRegistry());
        const snap = await svc.loadItemSnapshot(id);
        expect(snap?.media_type).toBe('track');
        expect(snap?.has_audio).toBe(true);
    });

    it('loadItemSnapshot normalizes DB media_type "tv" to canonical "series"', async () => {
        // The media_items.media_type CHECK constraint stores the legacy
        // lowercase 'tv'; coversStages declarations use 'series'. The service
        // must bridge the gap, otherwise applicableStages never matches for
        // any series item and coverage is silently empty.
        const id = await insertMediaItem(sql, 'tv', {});
        const svc = new StageStateService(sql, new TaskRegistry());
        const snap = await svc.loadItemSnapshot(id);
        expect(snap?.media_type).toBe('series');
    });

    it('applicableStages matches series-typed stages against a "tv"-typed DB row', async () => {
        const reg = new TaskRegistry();
        const seriesStageTask = mkTask('t-series', [
            { id: 'series-stage', appliesTo: ['series'] as const },
        ]);
        reg.registerTask(seriesStageTask);
        const svc = new StageStateService(sql, reg);

        const id = await insertMediaItem(sql, 'tv', {});
        const snap = (await svc.loadItemSnapshot(id))!;
        const stages = svc.applicableStages(snap);
        expect(stages.map((s) => s.id)).toEqual(['series-stage']);
    });

    it('loadItemSnapshot returns null for unknown id', async () => {
        const svc = new StageStateService(sql, new TaskRegistry());
        const snap = await svc.loadItemSnapshot(crypto.randomUUID());
        expect(snap).toBeNull();
    });

    it('applicableStages filters by appliesTo (predicate not yet applied)', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(movieStageTask);
        reg.registerTask(audioStageTask);
        const svc = new StageStateService(sql, reg);

        const id = await insertMediaItem(sql, 'movie', { has_video: true });
        const snap = (await svc.loadItemSnapshot(id))!;
        const stages = svc.applicableStages(snap);
        expect(stages.map((s) => s.id)).toEqual(['movie-stage']);
    });

    it('classifyStagesForCreate returns skipped_permanent/ineligible when appliesTo is false', async () => {
        // New contract: a false immutable appliesTo seeds skipped_permanent with the
        // unified 'ineligible' reason (NOT the old 'predicate-false'). The row MUST
        // exist so the recovery paths (invalidateByEvent / external heal) can reach it.
        const reg = new TaskRegistry();
        reg.registerTask(audioStageTask);
        const svc = new StageStateService(sql, reg);

        const id = await insertMediaItem(sql, 'track', { has_audio: false });
        const snap = (await svc.loadItemSnapshot(id))!;
        const classified = svc.classifyStagesForCreate(snap);
        expect(classified).toEqual([
            expect.objectContaining({
                initialStatus: 'skipped_permanent',
                skippedReason: 'ineligible',
            }),
        ]);
    });

    it('classifyStagesForCreate returns pending when predicate is true', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(audioStageTask);
        const svc = new StageStateService(sql, reg);

        const id = await insertMediaItem(sql, 'track', { has_audio: true });
        const snap = (await svc.loadItemSnapshot(id))!;
        const classified = svc.classifyStagesForCreate(snap);
        expect(classified[0]?.initialStatus).toBe('pending');
    });

    it('seedRowsForCreate inserts a row per applicable stage with correct status', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(movieStageTask);
        reg.registerTask(audioStageTask);
        const svc = new StageStateService(sql, reg);

        const movieId = await insertMediaItem(sql, 'movie', {
            has_video: true,
        });
        await svc.seedRowsForCreate(movieId);
        const { findRowsByItem } =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const movieRows = await findRowsByItem(sql, movieId);
        expect(movieRows).toEqual([
            expect.objectContaining({
                stage_id: 'movie-stage',
                status: 'pending',
            }),
        ]);

        // New contract: a false immutable appliesTo seeds skipped_permanent with
        // reason 'ineligible' (the row must exist for the recovery paths to reach it).
        const noAudioTrack = await insertMediaItem(sql, 'track', {
            has_audio: false,
        });
        await svc.seedRowsForCreate(noAudioTrack);
        const trackRows = await findRowsByItem(sql, noAudioTrack);
        expect(trackRows).toEqual([
            expect.objectContaining({
                stage_id: 'audio-stage',
                status: 'skipped_permanent',
                skipped_reason: 'ineligible',
            }),
        ]);
    });

    it('seedRowsForCreate rolls back all rows on mid-loop failure', async () => {
        const reg = new TaskRegistry();
        const twoStageTask = defineTask({
            id: 't-two-stage',
            name: 't-two-stage',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'io',
            inputSchema: z.object({}),
            identityFor: () => 'global',
            manualOnly: true,
            coversStages: [
                { id: 'stage-first', appliesTo: ['movie'] as const },
                { id: 'stage-second', appliesTo: ['movie'] as const },
            ],
            async execute() {
                return { success: true };
            },
        });
        reg.registerTask(twoStageTask);

        const stateQueriesModule =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const { insertPendingRow: realInsertPendingRow } = stateQueriesModule;

        // Spy on insertPendingRow to throw on the second call, simulating a
        // mid-loop DB failure. The transaction wrapping seedRowsForCreate must
        // roll back the first INSERT so zero rows persist.
        let callCount = 0;
        const spy = vi
            .spyOn(stateQueriesModule, 'insertPendingRow')
            .mockImplementation(async (...args) => {
                callCount++;
                if (callCount === 2) throw new Error('simulated mid-loop failure');
                return realInsertPendingRow(...args);
            });

        const svc = new StageStateService(sql, reg);
        const id = await insertMediaItem(sql, 'movie', { has_video: true });
        await expect(svc.seedRowsForCreate(id)).rejects.toThrow('simulated mid-loop failure');

        spy.mockRestore();

        const rows = await stateQueriesModule.findRowsByItem(sql, id);
        expect(rows).toEqual([]);
    });

    it('deleteRowsForItem removes all rows', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(movieStageTask);
        const svc = new StageStateService(sql, reg);
        const id = await insertMediaItem(sql, 'movie', { has_video: true });
        await svc.seedRowsForCreate(id);
        await svc.deleteRowsForItem(id);
        const { findRowsByItem } =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const rows = await findRowsByItem(sql, id);
        expect(rows).toEqual([]);
    });

    it('invalidateByKind moves only stages with matching invalidatedBy to pending', async () => {
        const { markCompleted } =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const reg = new TaskRegistry();
        const contentTask = mkTask('t-content', [
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
        ]);
        const metadataTask = mkTask('t-meta', [
            {
                id: 'metadata-stage',
                appliesTo: ['movie'] as const,
                invalidatedBy: ['metadata.changed'] as const,
            },
        ]);
        reg.registerTask(contentTask);
        reg.registerTask(metadataTask);

        const svc = new StageStateService(sql, reg);
        const id = await insertMediaItem(sql, 'movie', { has_video: true });
        await svc.seedRowsForCreate(id);
        await markCompleted(sql, { mediaItemId: id, stageId: 'content-stage' });
        await markCompleted(sql, {
            mediaItemId: id,
            stageId: 'metadata-stage',
        });

        await svc.invalidateByKind(id, 'file-content');

        const { findRowsByItem } =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const rows = await findRowsByItem(sql, id);
        const byStage = Object.fromEntries(rows.map((r) => [r.stage_id, r.status]));
        expect(byStage['content-stage']).toBe('pending');
        expect(byStage['metadata-stage']).toBe('completed');
    });

    it('invalidateByKind also promotes skipped_* rows when the predicate now passes (or with no predicate)', async () => {
        const reg = new TaskRegistry();
        const t = mkTask('t-identity', [
            {
                id: 'identity-stage',
                appliesTo: ['movie'] as const,
                invalidatedBy: [
                    'identity.assigned',
                    'identity.changed',
                    'identity.cleared',
                ] as const,
            },
        ]);
        reg.registerTask(t);
        const svc = new StageStateService(sql, reg);
        const id = await insertMediaItem(sql, 'movie', { has_video: true });
        await svc.seedRowsForCreate(id);
        await sql`
            UPDATE media_item_stage_state SET status = 'skipped_permanent'
             WHERE media_item_id = ${id}::uuid AND stage_id = 'identity-stage'
        `;

        await svc.invalidateByKind(id, 'identity');

        const { findRowsByItem } =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const [row] = await findRowsByItem(sql, id);
        expect(row?.status).toBe('pending');
    });

    it('invalidateByKind is a no-op for items with no applicable stages of that kind', async () => {
        const { markCompleted } =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const reg = new TaskRegistry();
        reg.registerTask(mkTask('t', [{ id: 's', appliesTo: ['movie'] as const }]));
        const svc = new StageStateService(sql, reg);
        const id = await insertMediaItem(sql, 'movie', { has_video: true });
        await svc.seedRowsForCreate(id);
        await markCompleted(sql, { mediaItemId: id, stageId: 's' });

        await svc.invalidateByKind(id, 'file-content');

        const { findRowsByItem } =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const [row] = await findRowsByItem(sql, id);
        expect(row?.status).toBe('completed');
    });

    it('invalidateByEvent LEAVES a pending row as-is when appliesTo becomes false (no event disposal)', async () => {
        // New contract: invalidateByEvent NO LONGER disposes ineligible rows — that
        // is now exclusively the sweep dispose pass's job (against live SQL). The
        // removed branch is what closed the M5 pre-claim race and the dropped-event
        // strand class. So a stage whose appliesTo now returns false is simply left
        // untouched for the next sweep tick to dispose.
        const reg = new TaskRegistry();
        const videoStageTask = mkTask('t-video', [
            {
                id: 'video-stage',
                appliesTo: ['movie'] as const,
                invalidatedBy: ['file.contentChanged'] as const,
                eligibility: { appliesTo: (item) => item.has_video },
            },
        ]);
        reg.registerTask(videoStageTask);
        const svc = new StageStateService(sql, reg);

        // Insert item with has_video true so the row seeds as pending.
        const id = await insertMediaItem(sql, 'movie', { has_video: true });
        await svc.seedRowsForCreate(id);

        const { findRowsByItem } =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const [before] = await findRowsByItem(sql, id);
        expect(before?.status).toBe('pending');

        // Remove the video stream so the snapshot now returns has_video = false.
        await sql`
            DELETE FROM media_streams
             WHERE file_id IN (
                 SELECT file_id FROM media_file_items WHERE media_item_id = ${id}::uuid
             )
               AND stream_type = 'video'
        `;

        await svc.invalidateByEvent(id, 'file.contentChanged');

        const [after] = await findRowsByItem(sql, id);
        // Untouched — NOT disposed by the event.
        expect(after?.status).toBe('pending');
        expect(after?.skipped_reason).toBeNull();
    });

    it('invalidateByEvent flips skipped_permanent → pending when appliesTo is true (eligible fast-path)', async () => {
        // The eligible-branch flip still recovers a skipped_permanent row on an
        // interested event when the stage's appliesTo is satisfied. (Seed no longer
        // creates a skipped_permanent row for a false predicate, so we insert the
        // skipped row directly to exercise the flip.)
        const reg = new TaskRegistry();
        const videoStageTask = mkTask('t-video-heal', [
            {
                id: 'video-stage-heal',
                appliesTo: ['movie'] as const,
                invalidatedBy: ['file.contentChanged'] as const,
                eligibility: { appliesTo: (item) => item.has_video },
            },
        ]);
        reg.registerTask(videoStageTask);
        const svc = new StageStateService(sql, reg);

        const id = await insertMediaItem(sql, 'movie', {});

        // Attach a video stream so the snapshot returns has_video = true (appliesTo true).
        const fileId = crypto.randomUUID();
        await sql`INSERT INTO media_files (id, file_path) VALUES (${fileId}::uuid, ${'/svc-test/video-' + fileId + '.mkv'})`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${fileId}::uuid, ${id}::uuid, true)`;
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${fileId}::uuid, 'video', 0, 'h264')`;

        // Seed a skipped_permanent row directly (the state a wrong skip would leave).
        await sql`
            INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, skipped_reason)
            VALUES (${id}::uuid, 'video-stage-heal', 1, 'skipped_permanent', 'ineligible')
        `;

        await svc.invalidateByEvent(id, 'file.contentChanged');

        const { findRowsByItem } =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const [healed] = await findRowsByItem(sql, id);
        expect(healed?.status).toBe('pending');
    });

    it('invalidateByEvent flips failed_permanent → pending on an identity event (re-identify heals dead letters)', async () => {
        // Regression (prod, 2026-07-15): the reset gate only admitted
        // failed_permanent for CONTENT events, so an operator's "Fix match"
        // re-identify (identity.cleared/assigned) could never clear a stage
        // that dead-lettered under the old wrong id — the item completed
        // series-sync with the new identity but bounced straight back into
        // the needs-re-identification list. failed_permanent must reset for
        // ANY event the stage subscribed to via invalidatedBy.
        const reg = new TaskRegistry();
        const identityStageTask = mkTask('t-identity-heal', [
            {
                id: 'identity-stage-heal',
                appliesTo: ['series'] as const,
                invalidatedBy: ['identity.changed'] as const,
            },
        ]);
        reg.registerTask(identityStageTask);
        const svc = new StageStateService(sql, reg);

        const id = await insertMediaItem(sql, 'tv', {});

        // Seed the dead letter the old wrong identity left behind.
        await sql`
            INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, last_error)
            VALUES (${id}::uuid, 'identity-stage-heal', 1, 'failed_permanent',
                    ${JSON.stringify({ message: 'TMDB API request failed: 404 Not Found', retryable: false })}::jsonb)
        `;

        await svc.invalidateByEvent(id, 'identity.changed');

        const { findRowsByItem } =
            await import('$lib/server/database/queries/stage-state.queries.js');
        const [healed] = await findRowsByItem(sql, id);
        expect(healed?.status).toBe('pending');
    });
});

describe('StageStateService.eagerEnqueueForStages — queue-depth throttle (WI-15)', () => {
    // Pure logic over an injected registry + stub fns — no DB needed
    // (eagerEnqueueForStages only reads the registry and calls startRun).
    const enqueueableTask = defineTask({
        id: 't-eager',
        name: 't-eager',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.object({}),
        identityFor: (input: { mediaItemId?: string }) => input.mediaItemId ?? 'global',
        manualOnly: true,
        coversStages: [
            {
                id: 'eager-stage',
                appliesTo: ['movie'] as const,
                enqueueable: true,
                terminalDisposition: { kind: 'self-terminal', ruleId: 'eager-test-self-terminal' },
            },
        ],
        async execute() {
            return { success: true };
        },
    });

    function svcWithDepth(depth: number): {
        svc: StageStateService;
        startRun: ReturnType<typeof vi.fn>;
    } {
        const reg = new TaskRegistry();
        reg.registerTask(enqueueableTask);
        const startRun = vi.fn().mockResolvedValue(undefined);
        const getQueueDepths = vi
            .fn()
            .mockResolvedValue({ io: { waiting: depth, active: 0, delayed: 0, paused: false } });
        // sql is unused on this path; cast a throwaway handle.
        const svc = new StageStateService(
            null as unknown as postgres.Sql,
            reg,
            startRun,
            getQueueDepths,
        );
        return { svc, startRun };
    }

    it('skips enqueue when the stage class is over its depth threshold (io cap 1500)', async () => {
        const { svc, startRun } = svcWithDepth(2000);
        await svc.eagerEnqueueForStages('11111111-1111-1111-1111-111111111111', ['eager-stage']);
        expect(startRun).not.toHaveBeenCalled();
    });

    it('enqueues normally when the class is below threshold', async () => {
        const { svc, startRun } = svcWithDepth(0);
        await svc.eagerEnqueueForStages('11111111-1111-1111-1111-111111111111', ['eager-stage']);
        expect(startRun).toHaveBeenCalledTimes(1);
        expect(startRun).toHaveBeenCalledWith(
            't-eager',
            { mediaItemId: '11111111-1111-1111-1111-111111111111' },
            expect.objectContaining({ idempotencyKey: expect.stringContaining('eager-stage') }),
        );
    });

    it('does not throttle when the depth snapshot throws (degrades to enqueue)', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(enqueueableTask);
        const startRun = vi.fn().mockResolvedValue(undefined);
        const getQueueDepths = vi.fn().mockRejectedValue(new Error('orchestrator not started'));
        const svc = new StageStateService(
            null as unknown as postgres.Sql,
            reg,
            startRun,
            getQueueDepths,
        );
        await svc.eagerEnqueueForStages('11111111-1111-1111-1111-111111111111', ['eager-stage']);
        expect(startRun).toHaveBeenCalledTimes(1);
    });
});

async function insertMediaItem(
    sql: postgres.Sql,
    mediaType: string,
    attrs: { has_audio?: boolean; has_video?: boolean },
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, ${mediaType}, ${'svc-test-' + id.slice(0, 6)})
    `;
    if (attrs.has_audio) {
        const fileId = crypto.randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path)
            VALUES (${fileId}::uuid, ${'/svc-test/audio-' + fileId + '.mkv'})
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${fileId}::uuid, ${id}::uuid, true)
        `;
        await sql`
            INSERT INTO media_streams (file_id, stream_type, stream_index, codec)
            VALUES (${fileId}::uuid, 'audio', 0, 'aac')
        `;
    }
    if (attrs.has_video) {
        const fileId = crypto.randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path)
            VALUES (${fileId}::uuid, ${'/svc-test/video-' + fileId + '.mkv'})
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${fileId}::uuid, ${id}::uuid, true)
        `;
        await sql`
            INSERT INTO media_streams (file_id, stream_type, stream_index, codec)
            VALUES (${fileId}::uuid, 'video', 0, 'h264')
        `;
    }
    return id;
}
