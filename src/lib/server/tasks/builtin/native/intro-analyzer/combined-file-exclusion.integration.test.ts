// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
let directory: string;
import type { DetectedSegment, EpisodeWithFile } from './types.js';
import { acquireMediaSegmentResolutionLocks } from './resolution-lock.js';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';

const { mockIntroAnalysis, mockCreditsAnalysis } = vi.hoisted(() => ({
    mockIntroAnalysis: vi.fn(),
    mockCreditsAnalysis: vi.fn(),
}));

vi.mock('./chromaprint.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./chromaprint.js')>();
    return {
        ...actual,
        analyzeSeasonFingerprints: mockIntroAnalysis,
        analyzeSeasonCreditsFingerprints: mockCreditsAnalysis,
    };
});

import {
    analyzeSingleSeasonChromaprint,
    type SeasonFingerprintOutcome,
    buildConfigHash,
    buildPlausibilityConfig,
    reconcileAndMaterializeSeason,
    type EffectiveConfig,
} from '../lumastra-intro-analyzer.js';

const TEST_TITLE = 'combined-file-exclusion-test';
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
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
} as never;

function segment(type: 'Intro' | 'Outro', startTime: number, endTime: number): DetectedSegment {
    return { type, startTime, endTime, method: 'chromaprint', confidence: 0.95 };
}

async function seedSeason(sql: postgres.Sql): Promise<{
    seasonId: string;
    episodeIds: string[];
}> {
    const seriesId = crypto.randomUUID();
    const seasonId = crypto.randomUUID();
    const combinedFileId = crypto.randomUUID();
    const ordinaryFileId = crypto.randomUUID();
    const episodeIds = Array.from({ length: 5 }, () => crypto.randomUUID());
    await writeFile(path.join(directory, TEST_TITLE + '-combined.mkv'), 'fictional combined');
    await writeFile(path.join(directory, TEST_TITLE + '-ordinary.mkv'), 'fictional ordinary');
    const oldTimestamp = new Date(Date.now() - 31 * 60 * 1000);

    await sql`
        INSERT INTO media_items (id, title, media_type, status, is_dismissed)
        VALUES (${seriesId}::uuid, ${TEST_TITLE + '-series'}, 'tv', 'active', false)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, is_dismissed, parent_id, season_number)
        VALUES (${seasonId}::uuid, ${TEST_TITLE + '-season'}, 'season', 'active', false, ${seriesId}::uuid, 1)
    `;
    for (const [index, episodeId] of episodeIds.entries()) {
        await sql`
            INSERT INTO media_items (id, title, media_type, status, is_dismissed, parent_id, season_number, episode_number)
            VALUES (${episodeId}::uuid, ${TEST_TITLE + '-episode-' + (index + 1)}, 'episode', 'active', false, ${seasonId}::uuid, 1, ${index + 1})
        `;
    }
    await sql`
        INSERT INTO media_files (id, file_path, duration_seconds, created_at, updated_at)
        VALUES
            (${combinedFileId}::uuid, ${directory + '/' + TEST_TITLE + '-combined.mkv'}, 3600, ${oldTimestamp}, ${oldTimestamp}),
            (${ordinaryFileId}::uuid, ${directory + '/' + TEST_TITLE + '-ordinary.mkv'}, 3600, ${oldTimestamp}, ${oldTimestamp})
    `;
    // A probed VIDEO stream per file. `getAnalyzerInputSnapshot` — which backs
    // the `analyzerInputStillCurrent` fence every candidate write goes through —
    // requires one, matching the analyzer's stage eligibility: an episode with no
    // probed video stream has not been probed yet and must not be analysed.
    // Without these rows the fence reads "input changed" for every episode and
    // the pass silently writes nothing, which is not what this test is about.
    await sql`
        INSERT INTO media_streams (file_id, stream_type, stream_index)
        VALUES
            (${combinedFileId}::uuid, 'video', 0),
            (${ordinaryFileId}::uuid, 'video', 0)
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order, start_offset_ms, end_offset_ms)
        VALUES
            (${combinedFileId}::uuid, ${episodeIds[0]}::uuid, true, 0, 0, 1800000),
            (${combinedFileId}::uuid, ${episodeIds[1]}::uuid, true, 0, 1800000, 3600000),
            (${ordinaryFileId}::uuid, ${episodeIds[2]}::uuid, true, 0, NULL, NULL),
            (${ordinaryFileId}::uuid, ${episodeIds[3]}::uuid, true, 0, NULL, NULL),
            (${ordinaryFileId}::uuid, ${episodeIds[4]}::uuid, true, 0, NULL, NULL)
    `;

    return { seasonId, episodeIds };
}

describe('lumastra intro analyzer: combined-file season exclusion', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), 'combined-exclusion-'));
        sql = getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM plugin_failure_events WHERE plugin_id='lumastra-intro-analyzer' AND item_id IN (SELECT id::text FROM media_items WHERE title LIKE ${TEST_TITLE + '%'})`;
        await sql`DELETE FROM media_items WHERE title LIKE ${TEST_TITLE + '%'}`;
        await sql`DELETE FROM media_files WHERE file_path LIKE ${directory + '/' + TEST_TITLE + '%'}`;
        await sql`DELETE FROM plugin_settings WHERE plugin_id='lumastra-intro-analyzer' AND key=ANY(${Object.keys(config)}::text[])`;
        await rm(directory, { recursive: true, force: true });
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`
            DELETE FROM media_file_items
            WHERE file_id IN (
                SELECT id FROM media_files WHERE file_path LIKE ${directory + '/' + TEST_TITLE + '%'}
            )
        `;
        await sql`
            DELETE FROM media_files
            WHERE file_path LIKE ${directory + '/' + TEST_TITLE + '%'}
        `;
        await sql`DELETE FROM media_items WHERE title LIKE ${TEST_TITLE + '%'}`;
        for (const [key, value] of Object.entries(config))
            await sql`INSERT INTO plugin_settings(plugin_id,key,value) VALUES ('lumastra-intro-analyzer',${key},${sql.json(value)}) ON CONFLICT(plugin_id,key) DO UPDATE SET value=EXCLUDED.value`;
        mockIntroAnalysis.mockReset();
        mockCreditsAnalysis.mockReset();
    });

    it('keeps intros, excludes combined-file Outros, and leaves ordinary episodes cohort-eligible', async () => {
        const { seasonId, episodeIds } = await seedSeason(sql);

        mockIntroAnalysis.mockImplementation(async (episodes: EpisodeWithFile[]) => {
            return new Map(
                episodes.map((episode) => [episode.episodeId, segment('Intro', 30, 60)]),
            );
        });
        mockCreditsAnalysis.mockImplementation(async (episodes: EpisodeWithFile[]) => {
            return new Map(
                episodes.map((episode) => [episode.episodeId, segment('Outro', 3540, 3600)]),
            );
        });

        await analyzeSingleSeasonChromaprint(
            sql,
            logger,
            new AbortController().signal,
            seasonId,
            '/tmp',
            config,
        );

        const rows = await sql<{ media_id: string; type: string; method: string }[]>`
            SELECT media_id, type, method
            FROM media_segment_candidates
            WHERE media_id = ANY(${episodeIds}::uuid[])
            ORDER BY media_id, method, type
        `;
        const byEpisode = new Map<string, string[]>();
        for (const row of rows) {
            const values = byEpisode.get(row.media_id) ?? [];
            values.push(`${row.method}:${row.type}`);
            byEpisode.set(row.media_id, values);
        }

        expect(byEpisode.get(episodeIds[0])).toEqual(['chromaprint:Intro']);
        expect(byEpisode.get(episodeIds[1])).toEqual(['chromaprint:Intro']);
        expect(byEpisode.get(episodeIds[2])).toEqual(['chromaprint:Intro', 'chromaprint:Outro']);
        expect(byEpisode.get(episodeIds[3])).toEqual(['chromaprint:Intro', 'chromaprint:Outro']);
        expect(byEpisode.get(episodeIds[4])).toEqual(['chromaprint:Intro', 'chromaprint:Outro']);

        // A different detector can still leave an outlier on a combined-file
        // episode. The cohort guard must exclude that evidence too, rather than
        // projecting the ordinary episodes' consensus onto the wrong file tail.
        await sql`
            INSERT INTO media_segment_candidates (
                media_id, type, method, start_time, end_time, confidence,
                detector_version, config_hash
            )
            VALUES (${episodeIds[0]}::uuid, 'Outro', 'chapter-mark', 3585, 3600, 0.9, 1, NULL)
        `;
        const episodes = await sql<EpisodeWithFile[]>`
            SELECT
                ep.id AS "episodeId",
                ep.title,
                ep.season_number AS "seasonNumber",
                ep.episode_number AS "episodeNumber",
                mf.file_path AS "filePath",
                mf.duration_seconds AS "durationSeconds",
                mf.id AS "fileId",mfi.start_offset_ms AS "startOffsetMs",mfi.end_offset_ms AS "endOffsetMs"
            FROM media_items ep
            JOIN media_file_items mfi ON mfi.media_item_id = ep.id
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE ep.parent_id = ${seasonId}::uuid
              AND ep.media_type = 'episode'
            ORDER BY ep.episode_number
        `;
        await reconcileAndMaterializeSeason(
            sql,
            logger,
            seasonId,
            episodes,
            config,
            buildPlausibilityConfig(config),
            buildConfigHash(config),
        );

        const combinedCohortRows = await sql`
            SELECT 1
            FROM media_segment_candidates
            WHERE media_id = ANY(${episodeIds.slice(0, 2)}::uuid[])
              AND method = 'cohort'
              AND type = 'Outro'
        `;
        expect(combinedCohortRows).toHaveLength(0);
    });

    it('blocks chromaprint before writing evidence while an override lock is held', async () => {
        const { seasonId, episodeIds } = await seedSeason(sql);
        mockIntroAnalysis.mockImplementation(async (episodes: EpisodeWithFile[]) => {
            return new Map(
                episodes.map((episode) => [episode.episodeId, segment('Intro', 30, 60)]),
            );
        });
        mockCreditsAnalysis.mockResolvedValue(new Map());

        const holder = await sql.reserve();
        let transactionOpen = false;
        let pending: Promise<SeasonFingerprintOutcome> | null = null;

        try {
            const [holderBackend] = await holder<{ pid: number }[]>`
                SELECT pg_backend_pid() AS pid
            `;
            await holder`BEGIN`;
            transactionOpen = true;
            await acquireMediaSegmentResolutionLocks(holder as unknown as postgres.Sql, episodeIds);

            pending = analyzeSingleSeasonChromaprint(
                sql,
                logger,
                new AbortController().signal,
                seasonId,
                '/tmp',
                config,
            );

            let waiting = false;
            const deadline = Date.now() + 5_000;
            while (!waiting && Date.now() < deadline) {
                const rows = await sql<{ waiting: boolean }[]>`
                    SELECT EXISTS (
                        SELECT 1
                        FROM pg_locks held
                        JOIN pg_locks waiter
                          ON waiter.locktype = held.locktype
                         AND waiter.database IS NOT DISTINCT FROM held.database
                         AND waiter.classid IS NOT DISTINCT FROM held.classid
                         AND waiter.objid IS NOT DISTINCT FROM held.objid
                         AND waiter.objsubid IS NOT DISTINCT FROM held.objsubid
                        WHERE held.pid = ${holderBackend.pid}
                          AND held.locktype = 'advisory'
                          AND held.granted = TRUE
                          AND waiter.granted = FALSE
                    ) AS waiting
                `;
                waiting = rows[0]?.waiting === true;
                if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
            }

            expect(waiting).toBe(true);
            const beforeRelease = await sql`
                SELECT 1
                FROM media_segment_candidates
                WHERE media_id = ANY(${episodeIds}::uuid[])
                  AND method = 'chromaprint'
            `;
            expect(beforeRelease).toHaveLength(0);

            await holder`COMMIT`;
            transactionOpen = false;
            await expect(pending).resolves.toMatchObject({ deferred: false });
            expect((await pending)?.segments).toBeGreaterThan(0);
        } finally {
            if (transactionOpen) await holder`ROLLBACK`;
            await pending?.catch(() => {});
            holder.release();
        }
    });
});
