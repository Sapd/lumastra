// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The intro analyzer's drain completes episodes through its own `markAnalyzed`,
 * not through `wrapExecute` — so it never reached the resolve-on-success hook
 * that `markCompleted` has. An episode that failed once (a stale path after a
 * Sonarr upgrade, an ffmpeg timeout) and succeeded on the next drain kept its
 * failure rows forever, and the attention board kept counting it. Prod
 * 2026-09-23: 123 "failed" items, 64 of them `completed` on the very stage the
 * failure was recorded against, AFTER the failure.
 *
 * Resolution is per stage. The analyzer tracks visual and acoustic
 * independently, so a visual success says nothing about a chromaprint failure
 * on the same episode, and clearing it would hide a real problem.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { recordFailure } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import {
    getAnalyzerInputSnapshot,
    type AnalyzerInputSnapshot,
} from '$lib/server/database/queries/media-segment-input.queries.js';
import {
    markAnalyzed,
    ANALYZER_VISUAL_STAGE_ID,
    ANALYZER_ACOUSTIC_STAGE_ID,
    VISUAL_PROCESSING_VERSION,
    ACOUSTIC_PROCESSING_VERSION,
} from '../lumastra-intro-analyzer.js';
const PLUGIN_ID = 'lumastra-intro-analyzer';
describe('markAnalyzed resolves only verified current stage failures', () => {
    let sql: postgres.Sql, directory: string, episodeId: string, input: AnalyzerInputSnapshot;
    const items: string[] = [],
        files: string[] = [];
    beforeAll(async () => {
        sql = getTestDb();
        directory = await mkdtemp(path.join(tmpdir(), 'current-resolution-'));
    });
    beforeEach(async () => {
        episodeId = crypto.randomUUID();
        const file = crypto.randomUUID();
        items.push(episodeId);
        files.push(file);
        const filePath = path.join(directory, file + '.mkv');
        await writeFile(filePath, 'fictional source');
        await sql`INSERT INTO media_items(id,title,media_type,status) VALUES (${episodeId},'Fictional resolution episode','episode','active')`;
        await sql`INSERT INTO media_files(id,file_path,duration_seconds) VALUES (${file},${filePath},1200)`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${file},${episodeId},true)`;
        await sql`INSERT INTO media_streams(file_id,stream_type,stream_index) VALUES (${file},'video',0)`;
        input = (await getAnalyzerInputSnapshot(sql, episodeId))!;
    });
    afterAll(async () => {
        await sql`DELETE FROM plugin_failure_events WHERE item_id=ANY(${items}::text[])`;
        await sql`DELETE FROM media_items WHERE id=ANY(${items}::uuid[])`;
        await sql`DELETE FROM media_files WHERE id=ANY(${files}::uuid[])`;
        await rm(directory, { recursive: true, force: true });
        await closeTestDb();
    });
    async function unresolved() {
        return sql<
            { stage_id: string | null }[]
        >`SELECT stage_id FROM plugin_failure_events WHERE plugin_id=${PLUGIN_ID} AND item_id=${episodeId} AND resolved_at IS NULL ORDER BY stage_id NULLS FIRST`;
    }
    async function failure(reason: string, stage: string) {
        await recordFailure(sql, PLUGIN_ID, episodeId, reason, null, stage, {
            ...input,
            analysisStageId: stage,
            processingVersion:
                stage === ANALYZER_VISUAL_STAGE_ID
                    ? VISUAL_PROCESSING_VERSION
                    : ACOUSTIC_PROCESSING_VERSION,
        });
    }
    async function complete(stage = ANALYZER_VISUAL_STAGE_ID) {
        return markAnalyzed(
            sql,
            [episodeId],
            stage,
            stage === ANALYZER_VISUAL_STAGE_ID
                ? VISUAL_PROCESSING_VERSION
                : ACOUSTIC_PROCESSING_VERSION,
            new Map([[episodeId, input]]),
        );
    }
    it('clears matching current visual failures when the visual stage completes', async () => {
        await failure('fictional first error', ANALYZER_VISUAL_STAGE_ID);
        await failure('fictional second error', ANALYZER_VISUAL_STAGE_ID);
        expect(await complete()).toEqual([episodeId]);
        expect(await unresolved()).toEqual([]);
    });
    it('leaves another stage’s current failures unresolved', async () => {
        await failure('visual error', ANALYZER_VISUAL_STAGE_ID);
        await failure('acoustic error', ANALYZER_ACOUSTIC_STAGE_ID);
        expect(await complete()).toEqual([episodeId]);
        expect(await unresolved()).toEqual([{ stage_id: ANALYZER_ACOUSTIC_STAGE_ID }]);
    });
    it('retains unverified legacy history even when a current stage completes', async () => {
        await recordFailure(sql, PLUGIN_ID, episodeId, 'unverified legacy', null, null);
        await failure('current acoustic', ANALYZER_ACOUSTIC_STAGE_ID);
        expect(await complete(ANALYZER_ACOUSTIC_STAGE_ID)).toEqual([episodeId]);
        expect(await unresolved()).toEqual([{ stage_id: null }]);
    });
});
