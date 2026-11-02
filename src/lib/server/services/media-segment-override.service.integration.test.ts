// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Manual media-segment overrides against a real database — plan §4 Phase 6.
 *
 * The unit tests pin the pure decisions; these pin the two claims that only SQL
 * can settle: that an override survives the file-change invalidation as a
 * `stale-manual` tombstone instead of being deleted, and that re-confirming it
 * supersedes that tombstone without tripping
 * `UNIQUE (media_id, type, method)`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../tests/integration/fixtures/index.js';
import {
    upsertMediaFile,
    attachFileToItem,
    invalidateFileProbeData,
} from '$lib/server/database/queries/media-files.queries.js';
import {
    getCandidatesForMedia,
    replaceCandidatesForMethod,
} from '$lib/server/database/queries/media-segment-candidates.queries.js';
import { getSegmentsByMediaId, upsertSegments } from '$lib/server/database/queries/media-segments.queries.js';
import { upsertTaskSettings } from '$lib/server/database/queries/task-settings.queries.js';
import {
    acquireExclusiveMediaSegmentWriteGate,
    acquireMediaSegmentResolutionLock,
} from '$lib/server/tasks/builtin/native/intro-analyzer/resolution-lock.js';
import { applyManualSegmentOverride } from './media-segment-override.service.js';

const INTRO_ANALYZER_PLUGIN_ID = 'lumastra-intro-analyzer';

// The motivating episode: Drifting Clouds S03E12. Blackframe reported the edge of
// its own search window (2632.672) as the credits start; the mkv's untitled
// chapter mark — and a human — say 2789.412.
const DURATION = 2832.672;
const BLACKFRAME_START = 2632.672;
const TRUE_START = 2789.412;

describe('manual media-segment overrides', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // media_segments and media_segment_candidates both cascade from
        // media_items.
        await sql.unsafe('TRUNCATE TABLE media_file_items, media_files, media_items CASCADE');
        // The gate reads operator settings; an inherited row from another file
        // would move the thresholds under these assertions.
        await sql`DELETE FROM plugin_settings WHERE plugin_id = ${INTRO_ANALYZER_PLUGIN_ID}`;
    });

    /** An episode backed by one probed file of `DURATION` seconds. */
    async function episodeWithFile(
        filePath: string,
        durationSeconds: number | null = DURATION,
    ): Promise<{ episodeId: string; fileId: string }> {
        const item = createTestMediaItem({ media_type: 'episode', has_files: true });
        await insertTestMediaItem(sql, item);
        const { id: fileId } = await upsertMediaFile(sql, { filePath });
        await attachFileToItem(sql, fileId, item.id);
        await sql`
            UPDATE media_files
            SET duration_seconds = ${durationSeconds},
                probed_at = NOW()
            WHERE id = ${fileId}
        `;
        return { episodeId: item.id, fileId };
    }

    it('outranks a stored detector answer and materializes under the analyzer source', async () => {
        const { episodeId } = await episodeWithFile('/media/series/bb-s03e12.mkv');
        await replaceCandidatesForMethod(sql, episodeId, 'blackframe', [
            { type: 'Outro', startTime: BLACKFRAME_START, endTime: DURATION },
        ]);

        const result = await applyManualSegmentOverride(sql, {
            mediaId: episodeId,
            type: 'Outro',
            startTime: TRUE_START,
            endTime: DURATION,
            setBy: 'denis',
        });

        expect(result).toMatchObject({ ok: true, materialized: true });

        const segments = await getSegmentsByMediaId(sql, episodeId);
        // Exactly one row per (media_id, type) — the player takes the first by
        // start_time and a second source would make that a coin flip.
        expect(segments).toHaveLength(1);
        expect(segments[0].source).toBe(INTRO_ANALYZER_PLUGIN_ID);
        expect(segments[0].start_time).toBeCloseTo(TRUE_START, 2);

        // The detector's answer is kept as evidence — it lost, it was not wrong
        // to have been recorded.
        const candidates = await getCandidatesForMedia(sql, episodeId);
        expect(candidates.map((c) => c.method).sort()).toEqual(['blackframe', 'manual']);
        expect(candidates.find((c) => c.method === 'manual')?.notes).toContain('denis');
    });

    it('a media-wide manual override removes file-scoped detector answers of the same type/source', async () => {
        const { episodeId, fileId } = await episodeWithFile('/media/series/file-scoped-override.mkv');
        await upsertSegments(sql, episodeId, [{ type: 'Outro', startTime: BLACKFRAME_START, endTime: DURATION }], INTRO_ANALYZER_PLUGIN_ID, fileId);
        const result = await applyManualSegmentOverride(sql, {
            mediaId: episodeId, type: 'Outro', startTime: TRUE_START, endTime: DURATION,
        });
        expect(result).toMatchObject({ ok: true, materialized: true });
        const served = await getSegmentsByMediaId(sql, episodeId, fileId);
        expect(served).toHaveLength(1);
        expect(served[0].file_id).toBeNull();
        expect(served[0].start_time).toBeCloseTo(TRUE_START, 2);
        const stored = await sql`SELECT file_id FROM media_segments WHERE media_id = ${episodeId} AND source = ${INTRO_ANALYZER_PLUGIN_ID}`;
        expect(stored.map(row => row.file_id)).toEqual([null]);
    });

    it('waits for the analyzer resolution lock before changing candidates', async () => {
        const { episodeId } = await episodeWithFile('/media/series/locked-override.mkv');
        const holder = await sql.reserve();
        const contender = await sql.reserve();
        let transactionOpen = false;
        let pending: Promise<Awaited<ReturnType<typeof applyManualSegmentOverride>>> | null = null;

        try {
            const [backend] = await contender<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            await holder`BEGIN`;
            transactionOpen = true;
            await acquireMediaSegmentResolutionLock(holder as unknown as postgres.Sql, episodeId);

            pending = applyManualSegmentOverride(contender as unknown as postgres.Sql, {
                mediaId: episodeId,
                type: 'Outro',
                startTime: TRUE_START,
                endTime: DURATION,
                setBy: 'lock-test',
            });

            let waitingOnAdvisoryLock = false;
            const deadline = Date.now() + 5_000;
            while (!waitingOnAdvisoryLock && Date.now() < deadline) {
                const rows = await sql<{ waiting: boolean }[]>`
                    SELECT EXISTS (
                        SELECT 1
                        FROM pg_locks
                        WHERE pid = ${backend.pid}
                          AND locktype = 'advisory'
                          AND granted = FALSE
                    ) AS waiting
                `;
                waitingOnAdvisoryLock = rows[0]?.waiting === true;
                if (!waitingOnAdvisoryLock) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
            }

            expect(waitingOnAdvisoryLock).toBe(true);
            expect(await getCandidatesForMedia(sql, episodeId)).toHaveLength(0);

            await holder`COMMIT`;
            transactionOpen = false;

            await expect(pending).resolves.toMatchObject({ ok: true, materialized: true });
            expect(await getCandidatesForMedia(sql, episodeId)).toHaveLength(1);
        } finally {
            if (transactionOpen) await holder`ROLLBACK`;
            await pending?.catch(() => {});
            contender.release();
            holder.release();
        }
    });

    it('cannot create first evidence while a global wipe gate is held', async () => {
        const { episodeId } = await episodeWithFile('/media/series/global-wipe-gate.mkv');
        const wipe = await sql.reserve();
        const writer = await sql.reserve();
        let transactionOpen = false;
        let pending: Promise<Awaited<ReturnType<typeof applyManualSegmentOverride>>> | null = null;

        try {
            const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            await wipe`BEGIN`;
            transactionOpen = true;
            await acquireExclusiveMediaSegmentWriteGate(wipe as unknown as postgres.Sql);

            pending = applyManualSegmentOverride(writer as unknown as postgres.Sql, {
                mediaId: episodeId,
                type: 'Outro',
                startTime: TRUE_START,
                endTime: DURATION,
                setBy: 'global-gate-test',
            });

            let waitingOnAdvisoryLock = false;
            const deadline = Date.now() + 5_000;
            while (!waitingOnAdvisoryLock && Date.now() < deadline) {
                const rows = await sql<{ waiting: boolean }[]>`
                    SELECT EXISTS (
                        SELECT 1
                        FROM pg_locks
                        WHERE pid = ${backend.pid}
                          AND locktype = 'advisory'
                          AND granted = FALSE
                    ) AS waiting
                `;
                waitingOnAdvisoryLock = rows[0]?.waiting === true;
                if (!waitingOnAdvisoryLock) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
            }

            expect(waitingOnAdvisoryLock).toBe(true);
            expect(await getCandidatesForMedia(sql, episodeId)).toHaveLength(0);

            await wipe`COMMIT`;
            transactionOpen = false;

            await expect(pending).resolves.toMatchObject({ ok: true, materialized: true });
            expect(await getCandidatesForMedia(sql, episodeId)).toHaveLength(1);
        } finally {
            if (transactionOpen) await wipe`ROLLBACK`;
            await pending?.catch(() => {});
            writer.release();
            wipe.release();
        }
    });

    it('rejects times outside the file rather than clamping them', async () => {
        const { episodeId } = await episodeWithFile('/media/series/bb-s03e13.mkv');

        const result = await applyManualSegmentOverride(sql, {
            mediaId: episodeId,
            type: 'Outro',
            startTime: TRUE_START,
            endTime: DURATION + 60,
        });

        expect(result).toEqual({
            ok: false,
            reason: 'end-past-duration',
            detail: expect.any(String),
        });
        expect(await getCandidatesForMedia(sql, episodeId)).toHaveLength(0);
        expect(await getSegmentsByMediaId(sql, episodeId)).toHaveLength(0);
    });

    it('refuses an item with no probed duration instead of guessing one', async () => {
        const { episodeId } = await episodeWithFile('/media/series/bb-s03e14.mkv', null);

        const result = await applyManualSegmentOverride(sql, {
            mediaId: episodeId,
            type: 'Outro',
            startTime: TRUE_START,
            endTime: DURATION,
        });

        expect(result).toMatchObject({ ok: false, reason: 'unknown-duration' });
    });

    it('serves an override that the automatic credits cap would have refused', async () => {
        const { episodeId } = await episodeWithFile('/media/series/bb-s03e15.mkv');

        const result = await applyManualSegmentOverride(sql, {
            mediaId: episodeId,
            type: 'Outro',
            // 200s of credits on a 47-minute episode is the shape the gate
            // refuses from a DETECTOR. From an operator it is an instruction:
            // the policy caps are heuristics, and overruling them is the point
            // of the override. Structural checks still apply.
            startTime: BLACKFRAME_START,
            endTime: DURATION,
        });

        expect(result).toMatchObject({ ok: true, materialized: true });
        expect(await getCandidatesForMedia(sql, episodeId)).toHaveLength(1);

        const segments = await getSegmentsByMediaId(sql, episodeId);
        expect(segments).toHaveLength(1);
        expect(segments[0].start_time).toBeCloseTo(BLACKFRAME_START, 2);
    });

    it('still refuses an override that falls outside the file', async () => {
        const { episodeId } = await episodeWithFile('/media/series/bb-s03e16.mkv');

        const result = await applyManualSegmentOverride(sql, {
            mediaId: episodeId,
            type: 'Outro',
            startTime: DURATION + 100,
            endTime: DURATION + 400,
        });

        expect(result).toMatchObject({ ok: false });
        expect(await getSegmentsByMediaId(sql, episodeId)).toHaveLength(0);
    });

    it('warns when the read path will hide a manual Intro on episode 1', async () => {
        const { episodeId } = await episodeWithFile('/media/series/bb-s01e01.mkv');
        await sql`UPDATE media_items SET episode_number = 1 WHERE id = ${episodeId}`;
        await upsertTaskSettings(sql, INTRO_ANALYZER_PLUGIN_ID, {
            suppressFirstEpisodeIntro: true,
        });

        const result = await applyManualSegmentOverride(sql, {
            mediaId: episodeId,
            type: 'Intro',
            startTime: 0,
            endTime: 90,
        });

        // It IS materialized — media-segments.service filters it at read time,
        // which from the admin UI is indistinguishable from the override having
        // been ignored. Saying so is the whole point.
        expect(result).toMatchObject({ ok: true, materialized: true, suppressedAtRead: true });
        expect(await getSegmentsByMediaId(sql, episodeId)).toHaveLength(1);
    });

    describe('file content change', () => {
        it('demotes the override to stale-manual and clears detector evidence', async () => {
            const { episodeId, fileId } = await episodeWithFile('/media/series/bb-s04e01.mkv');
            await replaceCandidatesForMethod(sql, episodeId, 'blackframe', [
                { type: 'Outro', startTime: BLACKFRAME_START, endTime: DURATION },
            ]);
            await applyManualSegmentOverride(sql, {
                mediaId: episodeId,
                type: 'Intro',
                startTime: 0,
                endTime: 90,
            });

            await invalidateFileProbeData(sql, fileId);

            const candidates = await getCandidatesForMedia(sql, episodeId);
            expect(candidates).toHaveLength(1);
            expect(candidates[0].method).toBe('stale-manual');
            expect(candidates[0].type).toBe('Intro');
            // The materialized rows go — the timings describe an encode that no
            // longer exists.
            expect(await getSegmentsByMediaId(sql, episodeId)).toHaveLength(0);
        });

        it('survives a second file change without colliding on the unique key', async () => {
            const { episodeId, fileId } = await episodeWithFile('/media/series/bb-s04e02.mkv');
            await applyManualSegmentOverride(sql, {
                mediaId: episodeId,
                type: 'Intro',
                startTime: 0,
                endTime: 90,
            });

            await invalidateFileProbeData(sql, fileId);
            // Re-probe, re-confirm, re-encode again: the second demotion would
            // hit the tombstone the first one left if the delete did not run
            // first.
            await sql`
                UPDATE media_files
                SET duration_seconds = ${DURATION}, probed_at = NOW()
                WHERE id = ${fileId}
            `;
            await applyManualSegmentOverride(sql, {
                mediaId: episodeId,
                type: 'Intro',
                startTime: 5,
                endTime: 95,
            });
            await expect(invalidateFileProbeData(sql, fileId)).resolves.toBeDefined();

            const candidates = await getCandidatesForMedia(sql, episodeId);
            expect(candidates).toHaveLength(1);
            expect(candidates[0].method).toBe('stale-manual');
            expect(candidates[0].start_time).toBeCloseTo(5, 2);
        });

        it('re-confirming supersedes the tombstone for that type only', async () => {
            const { episodeId, fileId } = await episodeWithFile('/media/series/bb-s04e03.mkv');
            await applyManualSegmentOverride(sql, {
                mediaId: episodeId,
                type: 'Intro',
                startTime: 0,
                endTime: 90,
            });
            await applyManualSegmentOverride(sql, {
                mediaId: episodeId,
                type: 'Outro',
                startTime: TRUE_START,
                endTime: DURATION,
            });

            await invalidateFileProbeData(sql, fileId);
            await sql`
                UPDATE media_files
                SET duration_seconds = ${DURATION}, probed_at = NOW()
                WHERE id = ${fileId}
            `;

            const result = await applyManualSegmentOverride(sql, {
                mediaId: episodeId,
                type: 'Outro',
                startTime: TRUE_START,
                endTime: DURATION,
            });
            expect(result).toMatchObject({ ok: true, materialized: true });

            const candidates = await getCandidatesForMedia(sql, episodeId);
            const byType = new Map(candidates.map((c) => [c.type, c.method]));
            expect(byType.get('Outro')).toBe('manual');
            // The Intro tombstone is still unanswered and must not have been
            // swept up by the Outro's re-confirmation.
            expect(byType.get('Intro')).toBe('stale-manual');
        });
    });
});
