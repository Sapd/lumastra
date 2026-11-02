// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Media Segment Candidates Query Module
 *
 * Covers the evidence-model invariants that cannot be checked without a real
 * database: the per-method UNIQUE, the mandatory empty-set replacement, and the
 * season roll-up the cohort reconciler reads.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestTvShow,
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getCandidatesForMedia,
    getCandidatesForSeason,
    replaceCandidatesForMethod,
    replaceCandidatesForMethods,
    deleteCandidatesForMedia,
    deleteCandidatesForChildren,
    toCandidates,
    type MediaSegmentCandidateInput,
} from './media-segment-candidates.queries.js';

// The motivating row: Drifting Clouds S03E12, file duration 2832.672 s. Blackframe
// reported 2632.672 (the edge of its search window); the authored chapter mark
// at 2789.412 is the true credits start. Using the real numbers keeps the test
// legible against the plan.
const FILE_DURATION = 2832.672;
const BLACKFRAME_START = 2632.672;
const CHAPTER_MARK_START = 2789.412;

interface SeasonWithEpisodes {
    seriesId: string;
    seasonId: string;
    episodeIds: string[];
}

// createAndInsertTestTvShow picks a random sample when no tmdbId is given, so
// two series created inside one test can collide on the external_ids unique.
let nextFixtureTmdbId = 970_100;

async function insertSeasonWithEpisodes(
    sql: postgres.Sql,
    episodeCount: number,
): Promise<SeasonWithEpisodes> {
    const tmdbId = nextFixtureTmdbId++;
    const { id: seriesId } = await createAndInsertTestTvShow(sql, {
        title: `Candidate Fixture ${tmdbId}`,
        tmdbId,
    });

    const season = createTestMediaItem({
        media_type: 'season',
        title: 'Season 3',
        parent_id: seriesId,
        has_files: true,
    });
    await insertTestMediaItem(sql, season);

    const episodeIds: string[] = [];
    for (let i = 1; i <= episodeCount; i++) {
        const episode = createTestMediaItem({
            media_type: 'episode',
            title: `Episode ${i}`,
            parent_id: season.id,
            has_files: true,
        });
        await insertTestMediaItem(sql, episode);
        // episode_number is not part of the media fixture shape but
        // getCandidatesForSeason orders by it, so set it explicitly.
        await sql`UPDATE media_items SET episode_number = ${i} WHERE id = ${episode.id}::uuid`;
        episodeIds.push(episode.id);
    }

    return { seriesId, seasonId: season.id, episodeIds };
}

const blackframeOutro: MediaSegmentCandidateInput = {
    type: 'Outro',
    startTime: BLACKFRAME_START,
    endTime: FILE_DURATION,
    confidence: 0.3,
    detectorVersion: 1,
    configHash: 'cfg-a',
};

const chapterMarkOutro: MediaSegmentCandidateInput = {
    type: 'Outro',
    startTime: CHAPTER_MARK_START,
    endTime: FILE_DURATION,
    confidence: 0.8,
    detectorVersion: 1,
    configHash: 'cfg-a',
    snappedToChapter: true,
    notes: 'last authored chapter boundary',
};

describe('Media Segment Candidates Queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    describe('replaceCandidatesForMethod', () => {
        it('round-trips every persisted column', async () => {
            const { episodeIds } = await insertSeasonWithEpisodes(sql, 1);

            await replaceCandidatesForMethod(sql, episodeIds[0], 'chapter-mark', [
                chapterMarkOutro,
            ]);

            const rows = await getCandidatesForMedia(sql, episodeIds[0]);
            expect(rows).toHaveLength(1);
            expect(rows[0].media_id).toBe(episodeIds[0]);
            expect(rows[0].type).toBe('Outro');
            expect(rows[0].method).toBe('chapter-mark');
            // real == float4: compare with tolerance, never for exact equality.
            expect(rows[0].start_time).toBeCloseTo(CHAPTER_MARK_START, 2);
            expect(rows[0].end_time).toBeCloseTo(FILE_DURATION, 2);
            expect(rows[0].confidence).toBeCloseTo(0.8, 5);
            expect(rows[0].detector_version).toBe(1);
            expect(rows[0].config_hash).toBe('cfg-a');
            expect(rows[0].snapped_to_chapter).toBe(true);
            expect(rows[0].notes).toBe('last authored chapter boundary');
        });

        it('applies the DDL defaults when the input omits them', async () => {
            const { episodeIds } = await insertSeasonWithEpisodes(sql, 1);

            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [
                { type: 'Outro', startTime: BLACKFRAME_START, endTime: FILE_DURATION },
            ]);

            const rows = await getCandidatesForMedia(sql, episodeIds[0]);
            expect(rows[0].confidence).toBeCloseTo(0.5, 5);
            expect(rows[0].detector_version).toBe(1);
            expect(rows[0].config_hash).toBeNull();
            expect(rows[0].snapped_to_chapter).toBe(false);
            expect(rows[0].notes).toBeNull();
        });

        it('keeps two methods disagreeing about the same type side by side', async () => {
            const { episodeIds } = await insertSeasonWithEpisodes(sql, 1);

            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [blackframeOutro]);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'chapter-mark', [
                chapterMarkOutro,
            ]);

            const rows = await getCandidatesForMedia(sql, episodeIds[0]);
            expect(rows.map((r) => r.method).sort()).toEqual(['blackframe', 'chapter-mark']);
        });

        it('replaces only its own method', async () => {
            const { episodeIds } = await insertSeasonWithEpisodes(sql, 1);

            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [blackframeOutro]);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'chapter-mark', [
                chapterMarkOutro,
            ]);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [
                { ...blackframeOutro, startTime: 2700 },
            ]);

            const rows = await getCandidatesForMedia(sql, episodeIds[0]);
            const byMethod = new Map(rows.map((r) => [r.method, r]));
            expect(byMethod.get('blackframe')?.start_time).toBeCloseTo(2700, 2);
            expect(byMethod.get('chapter-mark')?.start_time).toBeCloseTo(CHAPTER_MARK_START, 2);
        });

        // The invariant the whole evidence model rests on: an abstaining detector
        // must retract its previous answer, or the resolver keeps re-materializing
        // the old wrong segment forever.
        it('deletes the method rows even when the produced set is empty', async () => {
            const { episodeIds } = await insertSeasonWithEpisodes(sql, 1);

            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [blackframeOutro]);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', []);

            const rows = await getCandidatesForMedia(sql, episodeIds[0]);
            expect(rows).toHaveLength(0);
        });
    });

    describe('replaceCandidatesForMethods', () => {
        it('clears every owned method, including those with no produced rows', async () => {
            const { episodeIds } = await insertSeasonWithEpisodes(sql, 1);

            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [blackframeOutro]);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'chromaprint', [
                { type: 'Intro', startTime: 30, endTime: 75 },
            ]);

            // Second pass: blackframe abstains, chapter-mark answers, chromaprint
            // is not owned by this pass and must survive untouched.
            await replaceCandidatesForMethods(
                sql,
                episodeIds[0],
                ['blackframe', 'chapter-mark'],
                new Map([['chapter-mark', [chapterMarkOutro]]]),
            );

            const rows = await getCandidatesForMedia(sql, episodeIds[0]);
            expect(rows.map((r) => r.method).sort()).toEqual(['chapter-mark', 'chromaprint']);
        });
    });

    describe('getCandidatesForSeason', () => {
        it('returns candidates for every episode under the season, in episode order', async () => {
            const { seasonId, episodeIds } = await insertSeasonWithEpisodes(sql, 3);

            for (const [index, episodeId] of episodeIds.entries()) {
                await replaceCandidatesForMethod(sql, episodeId, 'blackframe', [
                    { ...blackframeOutro, startTime: BLACKFRAME_START - index },
                ]);
            }

            const rows = await getCandidatesForSeason(sql, seasonId);
            expect(rows).toHaveLength(3);
            expect(rows.map((r) => r.media_id)).toEqual(episodeIds);
        });

        it('does not leak candidates from another season', async () => {
            const first = await insertSeasonWithEpisodes(sql, 1);
            const second = await insertSeasonWithEpisodes(sql, 1);

            await replaceCandidatesForMethod(sql, first.episodeIds[0], 'blackframe', [
                blackframeOutro,
            ]);
            await replaceCandidatesForMethod(sql, second.episodeIds[0], 'blackframe', [
                blackframeOutro,
            ]);

            const rows = await getCandidatesForSeason(sql, first.seasonId);
            expect(rows.map((r) => r.media_id)).toEqual([first.episodeIds[0]]);
        });
    });

    describe('deleteCandidatesForMedia', () => {
        it('deletes everything by default', async () => {
            const { episodeIds } = await insertSeasonWithEpisodes(sql, 1);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [blackframeOutro]);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'manual', [chapterMarkOutro]);

            const deleted = await deleteCandidatesForMedia(sql, episodeIds[0]);

            expect(deleted).toBe(2);
            expect(await getCandidatesForMedia(sql, episodeIds[0])).toHaveLength(0);
        });

        it('spares the methods named in exceptMethods', async () => {
            const { episodeIds } = await insertSeasonWithEpisodes(sql, 1);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [blackframeOutro]);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'manual', [chapterMarkOutro]);

            const deleted = await deleteCandidatesForMedia(sql, episodeIds[0], {
                exceptMethods: ['manual'],
            });

            expect(deleted).toBe(1);
            const rows = await getCandidatesForMedia(sql, episodeIds[0]);
            expect(rows.map((r) => r.method)).toEqual(['manual']);
        });
    });

    describe('deleteCandidatesForChildren', () => {
        it('deletes candidates for every episode under a season', async () => {
            const { seasonId, episodeIds } = await insertSeasonWithEpisodes(sql, 2);
            for (const episodeId of episodeIds) {
                await replaceCandidatesForMethod(sql, episodeId, 'blackframe', [blackframeOutro]);
            }

            const deleted = await deleteCandidatesForChildren(sql, seasonId, 'season');

            expect(deleted).toBe(2);
            expect(await getCandidatesForSeason(sql, seasonId)).toHaveLength(0);
        });

        it('deletes candidates for every episode under a series', async () => {
            const { seriesId, seasonId, episodeIds } = await insertSeasonWithEpisodes(sql, 2);
            for (const episodeId of episodeIds) {
                await replaceCandidatesForMethod(sql, episodeId, 'blackframe', [blackframeOutro]);
            }

            const deleted = await deleteCandidatesForChildren(sql, seriesId, 'tv');

            expect(deleted).toBe(2);
            expect(await getCandidatesForSeason(sql, seasonId)).toHaveLength(0);
        });

        it('spares manual candidates when asked to', async () => {
            const { seasonId, episodeIds } = await insertSeasonWithEpisodes(sql, 1);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [blackframeOutro]);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'manual', [chapterMarkOutro]);

            const deleted = await deleteCandidatesForChildren(sql, seasonId, 'season', {
                exceptMethods: ['manual'],
            });

            expect(deleted).toBe(1);
            const rows = await getCandidatesForSeason(sql, seasonId);
            expect(rows.map((r) => r.method)).toEqual(['manual']);
        });
    });

    describe('cascade', () => {
        it('removes candidates when the media item is deleted', async () => {
            const { episodeIds } = await insertSeasonWithEpisodes(sql, 1);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [blackframeOutro]);

            await sql`DELETE FROM media_items WHERE id = ${episodeIds[0]}::uuid`;

            const remaining = await sql<{ count: string }[]>`
                SELECT COUNT(*)::text AS count FROM media_segment_candidates
                WHERE media_id = ${episodeIds[0]}::uuid
            `;
            expect(remaining[0].count).toBe('0');
        });
    });

    describe('toCandidates', () => {
        it('maps rows to the application shape with nulls collapsed to undefined', async () => {
            const { episodeIds } = await insertSeasonWithEpisodes(sql, 1);
            await replaceCandidatesForMethod(sql, episodeIds[0], 'blackframe', [
                { type: 'Outro', startTime: BLACKFRAME_START, endTime: FILE_DURATION },
            ]);

            const [candidate] = toCandidates(await getCandidatesForMedia(sql, episodeIds[0]));

            expect(candidate.type).toBe('Outro');
            expect(candidate.method).toBe('blackframe');
            expect(candidate.startTime).toBeCloseTo(BLACKFRAME_START, 2);
            expect(candidate.endTime).toBeCloseTo(FILE_DURATION, 2);
            expect(candidate.confidence).toBeCloseTo(0.5, 5);
            expect(candidate.detectorVersion).toBe(1);
            expect(candidate.configHash).toBeUndefined();
            expect(candidate.snappedToChapter).toBe(false);
            expect(candidate.notes).toBeUndefined();
        });
    });
});
