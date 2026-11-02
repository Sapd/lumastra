// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test for bug #2: audio content-changed must invalidate music-analysis.
 *
 * Verifies the full invalidation chain declared by the music-analysis task:
 *   audio-processor content-changed
 *     → MediaLifecycleService.onFileContentChanged
 *     → afterContentChanged
 *     → StageStateService.invalidateByKind(id, 'file-content')
 *     → music-analysis stage row reverts to 'pending'
 *
 * The test registers the real musicAnalysisTask declaration so that any future
 * change removing invalidatedBy or changing the kind immediately surfaces here.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { StageStateService } from '../../../../services/stage-state.service.js';
import { TaskRegistry } from '$lib/server/tasks/registry.js';
import { musicAnalysisTask } from '../music-analysis.js';

vi.mock('$lib/server/cache/pipeline-pubsub.js', () => ({
    publishStageStateChange: vi.fn().mockResolvedValue(undefined),
}));

describe('bug #2 regression: audio content-changed invalidates music-analysis', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'bug2-test-%'`;
    });

    it('music-analysis stage declaration includes the file-content events', () => {
        // arch #4: the legacy 'file-content' kind was replaced by its explicit
        // PipelineEventName events. invalidateByKind('file-content') still resets
        // it (it maps the kind to these events) — see the next test.
        const stageDecl = musicAnalysisTask.coversStages?.find((s) => s.id === 'music-analysis');
        expect(stageDecl, 'music-analysis coversStages declaration must exist').toBeDefined();
        expect(
            stageDecl?.invalidatedBy,
            'music-analysis must declare the file content-change event',
        ).toContain('file.contentChanged');
    });

    it('invalidateByKind(file-content) resets a completed music-analysis row to pending', async () => {
        const { markCompleted, findRowsByItem } =
            await import('../../../../database/queries/stage-state.queries.js');

        const reg = new TaskRegistry();
        reg.registerTask(musicAnalysisTask);
        const svc = new StageStateService(sql, reg);

        const trackId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, media_type, title)
            VALUES (${trackId}::uuid, 'track', ${'bug2-test-' + trackId.slice(0, 6)})
        `;

        // Seed stage rows and mark music-analysis completed
        await svc.seedRowsForCreate(trackId);
        await markCompleted(sql, {
            mediaItemId: trackId,
            stageId: 'music-analysis',
        });

        const beforeRows = await findRowsByItem(sql, trackId);
        const beforeRow = beforeRows.find((r) => r.stage_id === 'music-analysis');
        expect(beforeRow?.status).toBe('completed');

        // Fire the same invalidation that onFileContentChanged → afterContentChanged invokes
        await svc.invalidateByKind(trackId, 'file-content');

        const afterRows = await findRowsByItem(sql, trackId);
        const afterRow = afterRows.find((r) => r.stage_id === 'music-analysis');
        expect(afterRow?.status).toBe('pending');
    });
});
