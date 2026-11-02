// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scheduled drain picks up films that still lack a visual row. A film is
 * eligible when it has a linked, present, probed-video file longer than 60s and
 * no completed or tombstoned visual row at the current version.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
    upsertRunningRow,
    resetRunningToPending,
} from '$lib/server/database/queries/stage-state.queries.js';
import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    getUnanalyzedMovies,
    recordFailureByCause,
    assertAnalysisRetryReady,
    ANALYSIS_TIMEOUT_BACKOFF_MS,
    ANALYZER_VISUAL_STAGE_ID,
    VISUAL_PROCESSING_VERSION,
} from '../lumastra-intro-analyzer.js';

import { getAnalyzerInputSnapshot } from '$lib/server/database/queries/media-segment-input.queries.js';
import { markAnalyzed } from '../lumastra-intro-analyzer.js';
import { FFmpegTimeoutError } from '$lib/server/utils/ffmpeg-spawn.js';

const TEST_TITLE = 'intro-movie-visual';

interface MovieSpec {
    label: string;
    durationSeconds: number;
    withVideoStream: boolean;
    visualRow: 'none' | 'completed';
}

async function seedMovie(sql: postgres.Sql, spec: MovieSpec): Promise<string> {
    const movieId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    const filePath = `/${TEST_TITLE}-${spec.label}-${movieId}.mkv`;

    await sql`
        INSERT INTO media_items (id, title, media_type, status, is_dismissed)
        VALUES (${movieId}::uuid, ${`${TEST_TITLE}-${spec.label}`}, 'movie', 'active', false)
    `;
    await sql`
        INSERT INTO media_files (id, file_path, duration_seconds)
        VALUES (${fileId}::uuid, ${filePath}, ${spec.durationSeconds})
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
        VALUES (${fileId}::uuid, ${movieId}::uuid, true, 0)
    `;
    if (spec.withVideoStream) {
        await sql`
            INSERT INTO media_streams (file_id, stream_type, stream_index)
            VALUES (${fileId}::uuid, 'video', 0)
        `;
    }
    if (spec.visualRow === 'completed') {
        await sql`
            INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, completed_at)
            VALUES (${movieId}::uuid, ${ANALYZER_VISUAL_STAGE_ID}, ${VISUAL_PROCESSING_VERSION}, 'completed', now())
        `;
    }
    if (spec.visualRow === 'completed' && spec.withVideoStream && spec.durationSeconds > 60) {
        const input = (await getAnalyzerInputSnapshot(sql, movieId))!;
        await markAnalyzed(
            sql,
            [movieId],
            ANALYZER_VISUAL_STAGE_ID,
            VISUAL_PROCESSING_VERSION,
            new Map([[movieId, input]]),
        );
    }
    return movieId;
}

describe('lumastra-intro-analyzer: movie visual backlog', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM plugin_failure_events WHERE plugin_id='lumastra-intro-analyzer' AND item_id IN (SELECT id::text FROM media_items WHERE title LIKE ${TEST_TITLE + '%'})`;
        await sql`DELETE FROM media_items WHERE title LIKE ${TEST_TITLE + '%'}`;
        await sql`DELETE FROM media_files WHERE file_path LIKE ${'/' + TEST_TITLE + '%'}`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`
            DELETE FROM media_item_stage_state
             WHERE media_item_id IN (
                 SELECT id FROM media_items WHERE title LIKE ${TEST_TITLE + '%'}
             )
        `;
        await sql`
            DELETE FROM media_streams
             WHERE file_id IN (SELECT id FROM media_files WHERE file_path LIKE ${'/' + TEST_TITLE + '%'})
        `;
        await sql`
            DELETE FROM media_file_items
             WHERE file_id IN (SELECT id FROM media_files WHERE file_path LIKE ${'/' + TEST_TITLE + '%'})
        `;
        await sql`DELETE FROM media_files WHERE file_path LIKE ${'/' + TEST_TITLE + '%'}`;
        await sql`DELETE FROM media_items WHERE title LIKE ${TEST_TITLE + '%'}`;
    });

    it('defers timed-out films across drain runs, then retries after the deadline', async () => {
        const id = await seedMovie(sql, {
            label: 'timeout',
            durationSeconds: 7200,
            withVideoStream: true,
            visualRow: 'completed',
        });
        await sql`UPDATE media_item_stage_state SET processing_version = ${VISUAL_PROCESSING_VERSION - 1} WHERE media_item_id = ${id}::uuid`;
        const logger = mockLogger();
        await recordFailureByCause(sql, logger, id, new FFmpegTimeoutError(300_000, ''), {
            reason: 'timed out',
            input: (await getAnalyzerInputSnapshot(sql, id))!,
        });
        const [row] = await sql<{ status: string; wait_ms: number; attempt: number }[]>`
            SELECT status, extract(epoch FROM (next_eligible_at - now())) * 1000 AS wait_ms, attempt
            FROM media_item_stage_state WHERE media_item_id = ${id}::uuid AND stage_id = ${ANALYZER_VISUAL_STAGE_ID}
        `;
        expect(row?.status).toBe('skipped_transient');
        expect(Number(row?.wait_ms)).toBeGreaterThan(ANALYSIS_TIMEOUT_BACKOFF_MS - 10_000);
        expect(Number(row?.wait_ms)).toBeLessThanOrEqual(ANALYSIS_TIMEOUT_BACKOFF_MS);
        expect(row?.attempt).toBe(0);
        const eligible = () =>
            getUnanalyzedMovies(sql, ANALYZER_VISUAL_STAGE_ID, VISUAL_PROCESSING_VERSION, 1000);
        expect((await eligible()).map((r) => r.mediaId)).not.toContain(id);
        // A job queued before the timeout can still reach the runner. Its claim
        // must not bypass the cooldown or have success:false clear the delay.
        const runId = crypto.randomUUID();
        await upsertRunningRow(sql, {
            mediaItemId: id,
            stageId: ANALYZER_VISUAL_STAGE_ID,
            processingVersion: VISUAL_PROCESSING_VERSION,
            runId,
        });
        await expect(assertAnalysisRetryReady(sql, id)).rejects.toMatchObject({
            name: 'AnalysisCoolingDownError',
        });
        await resetRunningToPending(sql, {
            mediaItemId: id,
            stageId: ANALYZER_VISUAL_STAGE_ID,
            runId,
        });
        expect((await eligible()).map((r) => r.mediaId)).not.toContain(id);

        await sql`UPDATE media_item_stage_state SET next_eligible_at = now() - interval '1 second' WHERE media_item_id = ${id}::uuid`;
        expect((await eligible()).map((r) => r.mediaId)).toContain(id);
        await expect(assertAnalysisRetryReady(sql, id)).resolves.toBeUndefined();
    });

    it('returns only films with a probed video file over 60s and no visual row yet', async () => {
        const eligible = await seedMovie(sql, {
            label: 'eligible',
            durationSeconds: 120,
            withVideoStream: true,
            visualRow: 'none',
        });
        const alreadyDone = await seedMovie(sql, {
            label: 'done',
            durationSeconds: 120,
            withVideoStream: true,
            visualRow: 'completed',
        });
        const noVideo = await seedMovie(sql, {
            label: 'no-video',
            durationSeconds: 120,
            withVideoStream: false,
            visualRow: 'none',
        });
        const tooShort = await seedMovie(sql, {
            label: 'short',
            durationSeconds: 30,
            withVideoStream: true,
            visualRow: 'none',
        });

        const movies = await getUnanalyzedMovies(
            sql,
            ANALYZER_VISUAL_STAGE_ID,
            VISUAL_PROCESSING_VERSION,
            100_000,
        );
        const ids = movies.map((movie) => movie.mediaId);

        expect(ids).toContain(eligible);
        expect(ids).not.toContain(alreadyDone);
        expect(ids).not.toContain(noVideo);
        expect(ids).not.toContain(tooShort);
    });
});
