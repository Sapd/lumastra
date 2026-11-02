// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Music Analysis Query Module
 *
 * Tests track analysis predicates, backlog counts, markers, and wipe operations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../tests/integration/fixtures/index.js';

import {
    getUnanalyzedTracks,
    countUnanalyzedTracks,
    getMusicAnalysisBacklog,
    markTrackExcluded,
    markTrackAnalyzed,
    getMusicAnalysisWipeBatch,
    atomicallyWipeMusicAnalysis,
    findCoverageTableBacklog,
    isTrackOverDurationLimit,
    reconcileDurationLimit,
    TRACK_TOO_LONG_REASON,
} from './music-analysis.queries.js';

describe('Music Analysis Queries', () => {
    let sql: postgres.Sql;
    const PROCESSING_VERSION = 1;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_item_stage_state',
            ...TEST_TABLES.mediaFiles,
            ...TEST_TABLES.media,
        ]);
    });

    // ========================================================================
    // getUnanalyzedTracks / countUnanalyzedTracks
    // ========================================================================

    describe('getUnanalyzedTracks / countUnanalyzedTracks', () => {
        it('returns tracks without a music-analysis marker', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });

            const tracks = await getUnanalyzedTracks(sql, PROCESSING_VERSION, 10);
            const ids = tracks.map((t) => t.id);
            expect(ids).toEqual(expect.arrayContaining(trackIds));

            const count = await countUnanalyzedTracks(sql, PROCESSING_VERSION);
            expect(count).toBe(2);
        });

        it('excludes tracks with a current-version marker', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await markTrackAnalyzed(sql, trackIds[0], PROCESSING_VERSION);

            const tracks = await getUnanalyzedTracks(sql, PROCESSING_VERSION, 10);
            expect(tracks.some((t) => t.id === trackIds[0])).toBe(false);

            const count = await countUnanalyzedTracks(sql, PROCESSING_VERSION);
            expect(count).toBe(0);
        });

        it('excludes tracks without media files', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await sql`DELETE FROM media_file_items WHERE media_item_id = ${trackIds[0]}::uuid`;

            const tracks = await getUnanalyzedTracks(sql, PROCESSING_VERSION, 10);
            expect(tracks.some((t) => t.id === trackIds[0])).toBe(false);
        });
    });

    // ========================================================================
    // getMusicAnalysisBacklog
    // ========================================================================

    describe('getMusicAnalysisBacklog', () => {
        it('reports all tracks as remaining when unmarked', async () => {
            await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });

            const backlog = await getMusicAnalysisBacklog(sql, PROCESSING_VERSION);
            expect(backlog.remaining).toBe(2);
            expect(backlog.analyzed).toBe(0);
            expect(backlog.ineligible).toBe(0);
            expect(backlog.failed).toBe(0);
        });

        it('reports analyzed tracks correctly', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await markTrackAnalyzed(sql, trackIds[0], PROCESSING_VERSION);

            const backlog = await getMusicAnalysisBacklog(sql, PROCESSING_VERSION);
            expect(backlog.analyzed).toBe(1);
            expect(backlog.remaining).toBe(0);
        });

        it('reports failed tracks correctly', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await markTrackExcluded(
                sql,
                trackIds[0],
                PROCESSING_VERSION,
                'failed',
                'essentia error',
            );

            const backlog = await getMusicAnalysisBacklog(sql, PROCESSING_VERSION);
            expect(backlog.failed).toBe(1);
            expect(backlog.remaining).toBe(0);
        });
    });

    // ========================================================================
    // markTrackExcluded / markTrackAnalyzed
    // ========================================================================

    describe('markTrackExcluded', () => {
        it('marks a track as skipped and excludes it from fetch', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            const ok = await markTrackExcluded(
                sql,
                trackIds[0],
                PROCESSING_VERSION,
                'skipped',
                'no file',
            );
            expect(ok).toBe(true);

            const tracks = await getUnanalyzedTracks(sql, PROCESSING_VERSION, 10);
            expect(tracks.some((t) => t.id === trackIds[0])).toBe(false);
        });
    });

    describe('markTrackAnalyzed', () => {
        it('marks a track as analyzed and excludes it from fetch', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            const ok = await markTrackAnalyzed(sql, trackIds[0], PROCESSING_VERSION);
            expect(ok).toBe(true);

            const tracks = await getUnanalyzedTracks(sql, PROCESSING_VERSION, 10);
            expect(tracks.some((t) => t.id === trackIds[0])).toBe(false);
        });
    });

    // ========================================================================
    // Wipe
    // ========================================================================

    describe('getMusicAnalysisWipeBatch / atomicallyWipeMusicAnalysis', () => {
        it('finds tracks with essentia metadata and wipes them', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await markTrackAnalyzed(sql, trackIds[0], PROCESSING_VERSION);

            const batch = await getMusicAnalysisWipeBatch(sql, 'essentia', 10);
            expect(batch).toContain(trackIds[0]);

            const wiped = await atomicallyWipeMusicAnalysis(sql, [trackIds[0]], 'essentia');
            expect(wiped).toBeGreaterThanOrEqual(1);

            const backlog = await getMusicAnalysisBacklog(sql, PROCESSING_VERSION);
            expect(backlog.analyzed).toBe(0);
        });
    });

    // ========================================================================
    // Coverage table backlog
    // ========================================================================

    describe('findCoverageTableBacklog', () => {
        it('returns tracks from coverage table in retriable state', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, status, next_eligible_at, processing_version)
                VALUES (${trackIds[0]}::uuid, 'music-analysis', 'pending', NULL, 1)
            `;

            const rows = await findCoverageTableBacklog(sql, 'music-analysis', 6, 10);
            expect(rows.some((r) => r.id === trackIds[0])).toBe(true);
        });

        it('ignores completed tracks whose processing_version matches the current version', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, status, next_eligible_at, processing_version)
                VALUES (${trackIds[0]}::uuid, 'music-analysis', 'completed', NULL, 6)
            `;

            const rows = await findCoverageTableBacklog(sql, 'music-analysis', 6, 10);
            expect(rows.some((r) => r.id === trackIds[0])).toBe(false);
        });

        it('returns completed tracks whose processing_version is below the current version', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, status, next_eligible_at, processing_version)
                VALUES (${trackIds[0]}::uuid, 'music-analysis', 'completed', NULL, 5)
            `;

            const rows = await findCoverageTableBacklog(sql, 'music-analysis', 6, 10);
            expect(rows.some((r) => r.id === trackIds[0])).toBe(true);
        });
    });

    // ========================================================================
    // Duration cap
    // ========================================================================

    describe('duration cap', () => {
        const CAP = 30 * 60;

        async function setDuration(trackId: string, seconds: number): Promise<void> {
            await sql`
                UPDATE media_files mf SET duration_seconds = ${seconds}
                  FROM media_file_items mfi
                 WHERE mfi.file_id = mf.id AND mfi.media_item_id = ${trackId}::uuid
            `;
        }

        async function marker(trackId: string): Promise<Record<string, unknown> | null> {
            const [row] = await sql<{ m: Record<string, unknown> | null }[]>`
                SELECT processing_state -> 'music-analysis' AS m FROM media_items WHERE id = ${trackId}::uuid
            `;
            return row?.m ?? null;
        }

        it('flags only tracks whose file exceeds the cap, and never with the cap off', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
            await setDuration(trackIds[0], 2 * 3600);
            await setDuration(trackIds[1], 12 * 60);

            expect(await isTrackOverDurationLimit(sql, trackIds[0], CAP)).toBe(true);
            expect(await isTrackOverDurationLimit(sql, trackIds[1], CAP)).toBe(false);
            expect(await isTrackOverDurationLimit(sql, trackIds[0], 0)).toBe(false);
        });

        it('ignores a missing file when judging length', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await setDuration(trackIds[0], 2 * 3600);
            await sql`
                UPDATE media_files mf SET is_missing = true
                  FROM media_file_items mfi
                 WHERE mfi.file_id = mf.id AND mfi.media_item_id = ${trackIds[0]}::uuid
            `;
            expect(await isTrackOverDurationLimit(sql, trackIds[0], CAP)).toBe(false);
        });

        it('re-marks over-cap FAILED tracks as skipped and leaves in-cap failures alone', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 3 });
            const [mix, shortFailed, mixAnalyzed] = trackIds;
            await setDuration(mix, 2 * 3600);
            await setDuration(shortFailed, 5 * 60);
            await setDuration(mixAnalyzed, 45 * 60);
            for (const id of [mix, shortFailed]) {
                await markTrackExcluded(
                    sql,
                    id,
                    PROCESSING_VERSION,
                    'failed',
                    'essentia-empty-result',
                );
            }
            await markTrackAnalyzed(sql, mixAnalyzed, PROCESSING_VERSION);

            const { skippedIds, restoredIds } = await reconcileDurationLimit(
                sql,
                PROCESSING_VERSION,
                CAP,
            );

            expect(skippedIds).toEqual([mix]);
            expect(restoredIds).toEqual([]);
            expect(await marker(mix)).toMatchObject({
                status: 'skipped',
                reason: TRACK_TOO_LONG_REASON,
            });
            expect(await marker(shortFailed)).toMatchObject({ status: 'failed' });
            // A successful analysis is kept, not thrown away by the cap.
            expect((await marker(mixAnalyzed))?.status).toBeUndefined();

            const backlog = await getMusicAnalysisBacklog(sql, PROCESSING_VERSION);
            expect(backlog.failed).toBe(1);
            expect(backlog.ineligible).toBe(1);
        });

        it('re-queues length-skipped tracks once the cap is raised or removed', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
            const [hourMix, twoHourMix] = trackIds;
            await setDuration(hourMix, 3600);
            await setDuration(twoHourMix, 2 * 3600);
            for (const id of trackIds) {
                await markTrackExcluded(
                    sql,
                    id,
                    PROCESSING_VERSION,
                    'skipped',
                    TRACK_TOO_LONG_REASON,
                );
            }

            const raised = await reconcileDurationLimit(sql, PROCESSING_VERSION, 90 * 60);
            expect(raised.restoredIds).toEqual([hourMix]);
            expect(await marker(hourMix)).toBeNull();
            expect(await marker(twoHourMix)).toMatchObject({ reason: TRACK_TOO_LONG_REASON });

            const removed = await reconcileDurationLimit(sql, PROCESSING_VERSION, 0);
            expect(removed.restoredIds).toEqual([twoHourMix]);
            expect(removed.skippedIds).toEqual([]);

            const tracks = await getUnanalyzedTracks(sql, PROCESSING_VERSION, 10);
            expect(tracks.map((t) => t.id)).toEqual(expect.arrayContaining(trackIds));
        });

        it('does not re-queue tracks skipped for a different reason', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await setDuration(trackIds[0], 60);
            await markTrackExcluded(
                sql,
                trackIds[0],
                PROCESSING_VERSION,
                'skipped',
                'file-not-found',
            );

            const { restoredIds } = await reconcileDurationLimit(sql, PROCESSING_VERSION, CAP);
            expect(restoredIds).toEqual([]);
            expect(await marker(trackIds[0])).toMatchObject({ reason: 'file-not-found' });
        });
    });
});
