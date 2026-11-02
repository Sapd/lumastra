// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A season whose files are still inside the stability window is deferred by the
 * drain. The deferral must leave both stages unfinished, withhold the season from
 * the drain's slice until its deadline, and return it once the deadline passes.
 *
 * Chapter and blackframe detection are off, and the files are not probed, so the
 * drain reaches only the deferral branch and no ffmpeg runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    analyzeSliceOfSeasons,
    recordFailureByCause,
    getUnanalyzedSeasons,
    ANALYZER_VISUAL_STAGE_ID,
    ANALYZER_ACOUSTIC_STAGE_ID,
    VISUAL_PROCESSING_VERSION,
    ACOUSTIC_PROCESSING_VERSION,
    type EffectiveConfig,
} from '../lumastra-intro-analyzer.js';

import { getAnalyzerInputSnapshot } from '$lib/server/database/queries/media-segment-input.queries.js';
import { FFmpegTimeoutError } from '$lib/server/utils/ffmpeg-spawn.js';

const TEST_TITLE = 'intro-season-defer';
const STABILITY_MS = 30 * 60 * 1000;

const config: EffectiveConfig = {
    chapterDetection: false,
    blackframeDetection: false,
    chromaprintDetection: true,
    batchSize: 150,
    episodeConcurrency: 1,
    ffmpegThreads: 1,
    maxIntroDuration: 120,
    maxCreditsDuration: 300,
    maxMovieCreditsDuration: 900,
    maxPlausibleCreditsDuration: 90,
    maxPlausibleMovieCreditsDuration: 900,
    outroMinStartFraction: 0.8,
    snapToleranceSec: 10,
    maxPointDifferences: 6,
    maxTimeSkip: 3.5,
    introWindowFraction: 0.25,
    introWindowMaxSec: 600,
    invertedIndexShift: 2,
    minSegmentDuration: 15,
    animePreviewFromCreditsEnd: false,
};

const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
} as never;

interface SeededSeason {
    seasonId: string;
    episodeIds: string[];
    /** The newest file timestamp, in epoch milliseconds. */
    freshestMs: number;
}

/** A two-episode season whose files were last touched `ageMs` ago. */
async function seedSeason(sql: postgres.Sql, ageMs: number): Promise<SeededSeason> {
    const token = crypto.randomUUID();
    const seriesId = crypto.randomUUID();
    const seasonId = crypto.randomUUID();
    const episodeIds = [crypto.randomUUID(), crypto.randomUUID()];
    const stamp = new Date(Date.now() - ageMs);

    await sql`
        INSERT INTO media_items (id, title, media_type, status, is_dismissed)
        VALUES (${seriesId}::uuid, ${`${TEST_TITLE}-series-${token}`}, 'tv', 'active', false)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, is_dismissed, parent_id, season_number)
        VALUES (${seasonId}::uuid, ${`${TEST_TITLE}-season-${token}`}, 'season', 'active', false, ${seriesId}::uuid, 1)
    `;
    for (const [index, episodeId] of episodeIds.entries()) {
        await sql`
            INSERT INTO media_items (id, title, media_type, status, is_dismissed, parent_id, season_number, episode_number)
            VALUES (${episodeId}::uuid, ${`${TEST_TITLE}-ep-${token}-${index + 1}`}, 'episode', 'active', false, ${seasonId}::uuid, 1, ${index + 1})
        `;
        const fileId = crypto.randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path, duration_seconds, created_at, updated_at, file_mtime)
            VALUES (${fileId}::uuid, ${`/${TEST_TITLE}-${token}-${index + 1}.mkv`}, 1500, ${stamp}, ${stamp}, ${stamp})
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
            VALUES (${fileId}::uuid, ${episodeId}::uuid, true, 0)
        `;
    }

    await sql`INSERT INTO media_streams(file_id,stream_type,stream_index) SELECT mfi.file_id,'video',0 FROM media_file_items mfi WHERE mfi.media_item_id=ANY(${episodeIds}::uuid[])`;
    return { seasonId, episodeIds, freshestMs: stamp.getTime() };
}

async function stageRows(
    sql: postgres.Sql,
    episodeIds: string[],
): Promise<
    Array<{
        media_item_id: string;
        stage_id: string;
        status: string;
        skipped_reason: string | null;
        next_eligible_at: Date | null;
    }>
> {
    return sql`
        SELECT media_item_id, stage_id, status, skipped_reason, next_eligible_at
          FROM media_item_stage_state
         WHERE media_item_id = ANY(${episodeIds}::uuid[])
           AND stage_id = ANY(${[ANALYZER_VISUAL_STAGE_ID, ANALYZER_ACOUSTIC_STAGE_ID]}::text[])
    `;
}

/** Seasons the drain would hand out, filtered to the one under test. */
async function drainSliceContains(sql: postgres.Sql, seasonId: string): Promise<boolean> {
    const seasons = await getUnanalyzedSeasons(
        sql,
        ANALYZER_VISUAL_STAGE_ID,
        VISUAL_PROCESSING_VERSION,
        ANALYZER_ACOUSTIC_STAGE_ID,
        ACOUSTIC_PROCESSING_VERSION,
        true,
        100_000,
    );
    return seasons.some((season) => season.seasonId === seasonId);
}

describe('lumastra-intro-analyzer: season deferral', () => {
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
            DELETE FROM media_file_items
             WHERE file_id IN (SELECT id FROM media_files WHERE file_path LIKE ${'/' + TEST_TITLE + '%'})
        `;
        await sql`DELETE FROM media_files WHERE file_path LIKE ${'/' + TEST_TITLE + '%'}`;
        await sql`DELETE FROM media_items WHERE title LIKE ${TEST_TITLE + '%'}`;
    });

    it('withholds a timed-out season until the persisted analysis cooldown expires', async () => {
        const seeded = await seedSeason(sql, STABILITY_MS * 2);
        await recordFailureByCause(
            sql,
            logger,
            seeded.episodeIds[0]!,
            new FFmpegTimeoutError(300_000, ''),
            {
                reason: 'timeout',
                input: (await getAnalyzerInputSnapshot(sql, seeded.episodeIds[0]!))!,
            },
        );
        const eligible = () =>
            getUnanalyzedSeasons(
                sql,
                ANALYZER_VISUAL_STAGE_ID,
                VISUAL_PROCESSING_VERSION,
                ANALYZER_ACOUSTIC_STAGE_ID,
                ACOUSTIC_PROCESSING_VERSION,
                true,
                1000,
            );
        expect((await eligible()).map((r) => r.seasonId)).not.toContain(seeded.seasonId);
        await sql`UPDATE media_item_stage_state SET next_eligible_at = now() - interval '1 second' WHERE media_item_id = ${seeded.episodeIds[0]!}::uuid`;
        expect((await eligible()).map((r) => r.seasonId)).toContain(seeded.seasonId);
    });

    it('a season with a file inside the window is deferred: neither stage is completed', async () => {
        const { seasonId, episodeIds, freshestMs } = await seedSeason(sql, 0);

        await analyzeSliceOfSeasons(
            sql,
            logger,
            new AbortController().signal,
            [{ seasonId, visualStale: true, acousticStale: true }],
            config,
            '/tmp',
        );

        const rows = await stageRows(sql, episodeIds);
        expect(rows).toHaveLength(episodeIds.length * 2);
        for (const row of rows) {
            expect(row.status).toBe('skipped_transient');
            expect(row.skipped_reason).toBe('season-scan-not-yet-stable');
            expect(row.next_eligible_at).not.toBeNull();
            // The deadline is the newest file's time plus the stability window.
            const deadline = (row.next_eligible_at as Date).getTime();
            expect(Math.abs(deadline - (freshestMs + STABILITY_MS))).toBeLessThan(5_000);
        }
        expect(await drainSliceContains(sql, seasonId)).toBe(false);
    });

    it('a season whose files are older than the window is handed out by the drain', async () => {
        const { seasonId } = await seedSeason(sql, STABILITY_MS + 60_000);

        expect(await drainSliceContains(sql, seasonId)).toBe(true);
    });

    it('a deferred season is handed out again once its deadline has passed', async () => {
        const { seasonId, episodeIds } = await seedSeason(sql, 0);
        await analyzeSliceOfSeasons(
            sql,
            logger,
            new AbortController().signal,
            [{ seasonId, visualStale: true, acousticStale: true }],
            config,
            '/tmp',
        );
        expect(await drainSliceContains(sql, seasonId)).toBe(false);

        // Stand in for the clock passing the deadline.
        await sql`
            UPDATE media_item_stage_state
               SET next_eligible_at = now() - interval '1 minute'
             WHERE media_item_id = ANY(${episodeIds}::uuid[])
        `;

        expect(await drainSliceContains(sql, seasonId)).toBe(true);
    });
});
