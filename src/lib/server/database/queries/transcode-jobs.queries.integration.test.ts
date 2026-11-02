// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Transcode Jobs Query Module
 *
 * Tests getJob, getJobsForPod, getAllActiveJobs, getJobsByPlaySessions,
 * upsertJob, insertActiveTranscodeJob, updateTranscodeJobStatus,
 * updateLastAccessed, updateLastProgress, updateStatus, updateProgress,
 * deleteJob, cleanupExpiredJobs, claimJobForRestoration, markPodJobsAsStopped.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';
import type { UserId } from '$lib/shared/user-id.js';

import {
    getJob,
    getJobsForPod,
    getAllActiveJobs,
    countLiveVideoTranscodes,
    getJobsByPlaySessions,
    upsertJob,
    insertActiveTranscodeJob,
    updateTranscodeJobStatus,
    updateLastAccessed,
    updateLastProgress,
    updateStatus,
    updateProgress,
    deleteJob,
    cleanupExpiredJobs,
    retireOrphanedJob,
    claimJobForRestoration,
    markPodJobsAsStopped,
    JobStatus,
} from './transcode-jobs.queries.js';

describe('Transcode Jobs Queries', () => {
    let sql: postgres.Sql;
    let testUserId: UserId;
    let testMediaId: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['active_transcode_jobs', 'play_sessions', ...TEST_TABLES.media]);
        // active_transcode_jobs.user_id and play_sessions.user_id are
        // uuid REFERENCES users(id) since mig 16.46.0 — must be a valid UUID.
        testUserId = generateTestUserId('trans_user');
        await ensureTestUser(sql, testUserId);
        const result = await createAndInsertTestMovie(sql, { tmdbId: 990301 });
        testMediaId = result.id;
    });

    function makeJob(
        overrides: Partial<{
            playSessionId: string;
            status: string;
            podName: string | null;
            lastAccessedAt: Date;
            lastProgressAt: Date;
            createdAt: Date;
        }> = {},
    ): Parameters<typeof upsertJob>[1] {
        const now = new Date();
        return {
            play_session_id: overrides.playSessionId ?? crypto.randomUUID(),
            job_id: `job-${crypto.randomUUID().slice(0, 8)}`,
            item_id: testMediaId,
            user_id: testUserId,
            device_id: 'trans_device',
            config: { codec: 'h264' },
            output_dir: '/tmp/out',
            status: overrides.status ?? JobStatus.Running,
            mode: 'full',
            segment_offset: 0,
            segments_ready: 0,
            master_playlist_ready: false,
            pod_name: overrides.podName ?? null,
            ffmpeg_pid: null,
            created_at: overrides.createdAt ?? now,
            last_accessed_at: overrides.lastAccessedAt ?? now,
            last_progress_at: overrides.lastProgressAt ?? now,
            transcode_decision: null,
            can_restore: false,
        };
    }

    it.each([true, false])(
        'retires stale stopping orphans (can_restore=%s) at boot and periodically',
        async (canRestore) => {
            const stale = new Date(Date.now() - 3600000);
            const job = {
                ...makeJob({
                    status: 'stopping',
                    createdAt: stale,
                    lastAccessedAt: stale,
                    lastProgressAt: stale,
                }),
                can_restore: canRestore,
            };
            await upsertJob(sql, job);
            expect((await getAllActiveJobs(sql)).map((r) => r.play_session_id)).toContain(
                job.play_session_id,
            );
            await sql`UPDATE active_transcode_jobs SET last_progress_at = NOW() WHERE play_session_id = ${job.play_session_id}`;
            expect(
                await retireOrphanedJob(
                    sql,
                    job.play_session_id,
                    job.job_id,
                    new Date(Date.now() - 300000),
                ),
            ).toBe(false);
            expect(
                await cleanupExpiredJobs(sql, { inactivityTtl: 300, progressTtl: 120 }),
            ).toHaveLength(0);
            await sql`UPDATE active_transcode_jobs SET last_progress_at = ${stale} WHERE play_session_id = ${job.play_session_id}`;
            expect(
                await retireOrphanedJob(
                    sql,
                    job.play_session_id,
                    job.job_id,
                    new Date(Date.now() - 300000),
                ),
            ).toBe(true);
            expect(await getJob(sql, job.play_session_id)).toBeNull();
            await upsertJob(sql, job);
            const removed = await cleanupExpiredJobs(sql, { inactivityTtl: 300, progressTtl: 120 });
            expect(removed.map((r) => r.play_session_id)).toContain(job.play_session_id);
            expect(await getJob(sql, job.play_session_id)).toBeNull();
        },
    );

    // ========================================================================
    // getJob
    // ========================================================================

    describe('getJob', () => {
        it('retrieves job by play session ID', async () => {
            const job = makeJob();
            await upsertJob(sql, job);

            const row = await getJob(sql, job.play_session_id);

            expect(row).not.toBeNull();
            expect(row!.job_id).toBe(job.job_id);
        });

        it('returns null for missing job', async () => {
            const row = await getJob(sql, crypto.randomUUID());
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getJobsForPod
    // ========================================================================

    describe('getJobsForPod', () => {
        it('filters by pod name', async () => {
            await upsertJob(sql, makeJob({ podName: 'pod-a' }));
            await upsertJob(sql, makeJob({ podName: 'pod-b' }));

            const rows = await getJobsForPod(sql, 'pod-a');
            expect(rows).toHaveLength(1);
            expect(rows[0].pod_name).toBe('pod-a');
        });
    });

    // ========================================================================
    // getAllActiveJobs
    // ========================================================================

    describe('getAllActiveJobs', () => {
        it('excludes stopped and error jobs', async () => {
            await upsertJob(sql, makeJob({ status: JobStatus.Running }));
            await upsertJob(sql, makeJob({ status: JobStatus.Stopped }));
            await upsertJob(sql, makeJob({ status: JobStatus.Error }));

            const rows = await getAllActiveJobs(sql);
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe(JobStatus.Running);
        });
    });

    // ========================================================================
    // countLiveVideoTranscodes
    // ========================================================================

    describe('countLiveVideoTranscodes', () => {
        const live = (
            config: Record<string, unknown>,
            over: Parameters<typeof makeJob>[0] = {},
        ) => ({
            ...makeJob(over),
            config,
            ffmpeg_pid: 4242,
        });
        const videoTranscode = { videoInfo: { codec: 'hevc', isTranscoded: true } };

        it('counts only live video transcodes', async () => {
            await upsertJob(sql, live(videoTranscode));
            await upsertJob(sql, live(videoTranscode, { status: JobStatus.Ready }));
            expect(await countLiveVideoTranscodes(sql)).toBe(2);
        });

        it('ignores remux, music, audiobook, stopped, pid-less and stale jobs', async () => {
            // Remux / direct-stream copy.
            await upsertJob(sql, live({ videoInfo: { codec: 'h264', isTranscoded: false } }));
            // Music and audiobook jobs.
            await upsertJob(sql, live({ type: 'music', transcode_mode: 'encode' }));
            await upsertJob(sql, live({ type: 'audiobook', transcode_mode: 'remux_live' }));
            // Video transcode, but not live.
            await upsertJob(sql, live(videoTranscode, { status: JobStatus.Stopped }));
            await upsertJob(sql, { ...live(videoTranscode), ffmpeg_pid: null });
            await upsertJob(
                sql,
                live(videoTranscode, { lastProgressAt: new Date(Date.now() - 10 * 60_000) }),
            );
            expect(await countLiveVideoTranscodes(sql)).toBe(0);
        });
    });

    // ========================================================================
    // getJobsByPlaySessions
    // ========================================================================

    describe('getJobsByPlaySessions', () => {
        it('returns statuses for given session IDs', async () => {
            const job1 = makeJob({ status: JobStatus.Running });
            const job2 = makeJob({ status: JobStatus.Ready });
            await upsertJob(sql, job1);
            await upsertJob(sql, job2);

            const rows = await getJobsByPlaySessions(sql, [
                job1.play_session_id,
                job2.play_session_id,
            ]);
            expect(rows).toHaveLength(2);
        });

        it('returns empty array for empty input', async () => {
            const rows = await getJobsByPlaySessions(sql, []);
            expect(rows).toEqual([]);
        });

        // The owning pod's cleanup loop reads THIS query to tell the dormant
        // sweep's mark (stopped + can_restore=true: keep the row) from an
        // explicit cross-pod stop (can_restore=false: tear down and delete).
        // Without the column the owner saw `undefined` and deleted every
        // dormant row — the 2026-09-25 410 storm.
        it('reports can_restore=true for a row the dormant sweep marked stopped', async () => {
            const stale = new Date(Date.now() - 60 * 60 * 1000);
            const job = {
                ...makeJob({
                    status: JobStatus.Ready,
                    lastAccessedAt: stale,
                    lastProgressAt: stale,
                }),
                can_restore: true,
            };
            await upsertJob(sql, job);

            await cleanupExpiredJobs(sql, { inactivityTtl: 300, progressTtl: 120 });

            const rows = await getJobsByPlaySessions(sql, [job.play_session_id]);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: JobStatus.Stopped, can_restore: true });
        });
    });

    // ========================================================================
    // upsertJob
    // ========================================================================

    describe('upsertJob', () => {
        it('inserts a job and creates play_sessions stub', async () => {
            const job = makeJob();
            await upsertJob(sql, job);

            const row = await getJob(sql, job.play_session_id);
            expect(row).not.toBeNull();

            const [session] = await sql`
                SELECT * FROM play_sessions WHERE id = ${job.play_session_id}
            `;
            expect(session).toBeDefined();
        });

        // /j: the PlaySessionId is dashless 32-hex and is NOT a play_sessions.id
        // (/j keeps its own session row under another id), so no stub — a stub
        // would be a second ACTIVE session counted against the stream limit.
        it('writes a /j row (dashless id) without a play_sessions stub, read back dashed', async () => {
            const dashed = crypto.randomUUID();
            const dashless = dashed.replace(/-/g, '');
            const base = makeJob({ playSessionId: dashless });
            const job = {
                ...base,
                config: { ...base.config, username: 'jf-user' },
                ensure_play_session: false,
            };

            expect(await upsertJob(sql, job)).toBe('written');

            const stubs = await sql`SELECT 1 FROM play_sessions WHERE id = ${dashless}`;
            expect(stubs).toHaveLength(0);
            expect((await getJob(sql, dashless))?.play_session_id).toBe(dashed);
            const [status] = await getJobsByPlaySessions(sql, [dashed]);
            expect(status.play_session_id).toBe(dashed);

            const lastProgress = async () =>
                (await getJob(sql, dashed))!.last_progress_at.getTime();
            await sql`UPDATE active_transcode_jobs SET last_progress_at = NOW() - INTERVAL '1 hour'
                      WHERE play_session_id = ${dashed}`;
            const stale = await lastProgress();
            // A heartbeat naming another user must not keep this row alive.
            await updateLastProgress(sql, dashless, undefined, 'someone-else');
            expect(await lastProgress()).toBe(stale);
            await updateLastProgress(sql, dashless, undefined, 'jf-user');
            expect(await lastProgress()).toBeGreaterThan(stale);

            await updateStatus(sql, {
                playSessionId: dashless,
                status: JobStatus.Stopped,
                error: 'cross-pod stop',
                canRestore: false,
            });
            const row = await getJob(sql, dashed);
            expect(row?.status).toBe(JobStatus.Stopped);
            expect(row?.can_restore).toBe(false);
        });

        it('updates job on conflict', async () => {
            const job = makeJob({ status: JobStatus.Starting });
            await upsertJob(sql, job);

            // Modify payload and re-upsert (same play_session_id)
            const updated = { ...job, status: JobStatus.Running };
            await upsertJob(sql, updated);

            const row = await getJob(sql, job.play_session_id);
            expect(row!.status).toBe(JobStatus.Running);
        });

        // D-HLS-1 (security runtime pass 2026-09-26, fix (b)) — a cross-process
        // (or case-variant) second start under the SAME play_session_id for a
        // DIFFERENT item must fully replace the row, not half-update it into a
        // self-inconsistent state (item_id from job 1, config.itemId from job 2).
        it('fully replaces the row when a second start under the same session names a DIFFERENT item', async () => {
            const sid = crypto.randomUUID();
            const itemY = (await createAndInsertTestMovie(sql, { tmdbId: 990302 })).id;

            const jobX = makeJob({ playSessionId: sid });
            jobX.item_id = testMediaId;
            jobX.job_id = 'job-x';
            jobX.output_dir = '/tmp/out-x';
            jobX.pod_name = 'pod-web';
            jobX.config = { itemId: testMediaId };
            const wroteX = await upsertJob(sql, jobX);
            expect(wroteX).toBe('written');

            const jobY = makeJob({ playSessionId: sid });
            jobY.item_id = itemY;
            jobY.job_id = 'job-y';
            jobY.output_dir = '/tmp/out-y';
            jobY.pod_name = 'pod-wrk';
            jobY.config = { itemId: itemY };
            jobY.created_at = new Date(jobX.created_at.getTime() + 1000);
            const wroteY = await upsertJob(sql, jobY);
            expect(wroteY).toBe('written');

            const row = await getJob(sql, sid);
            expect(row!.item_id).toBe(itemY);
            expect((row!.config as { itemId: string }).itemId).toBe(itemY);
            expect(row!.item_id).toBe((row!.config as { itemId: string }).itemId);
            expect(row!.job_id).toBe('job-y');
            expect(row!.output_dir).toBe('/tmp/out-y');
            expect(row!.pod_name).toBe('pod-wrk');
            expect(row!.created_at.getTime()).toBe(jobY.created_at.getTime());
        });

        // Same item, new generation (the seek-promotion shape): today's partial
        // update is preserved — item_id/job_id/output_dir come from the FIRST
        // insert (the DB row identity for that item), config/pod_name/status
        // reflect the latest generation.
        it('keeps the partial update when the second start is the SAME item (seek promotion)', async () => {
            const sid = crypto.randomUUID();

            const jobX1 = makeJob({ playSessionId: sid });
            jobX1.item_id = testMediaId;
            jobX1.job_id = 'job-x1';
            jobX1.output_dir = '/tmp/out-x1';
            jobX1.pod_name = 'pod-web';
            jobX1.config = { itemId: testMediaId, generation: 1 };
            await upsertJob(sql, jobX1);

            const jobX2 = makeJob({ playSessionId: sid });
            jobX2.item_id = testMediaId;
            jobX2.job_id = 'job-x2';
            jobX2.output_dir = '/tmp/out-x2';
            jobX2.pod_name = 'pod-web';
            jobX2.config = { itemId: testMediaId, generation: 2 };
            await upsertJob(sql, jobX2);

            const row = await getJob(sql, sid);
            // Pinned as the explicit "today's behaviour preserved" case:
            // item_id/job_id/output_dir are NOT replaced for a same-item write.
            expect(row!.item_id).toBe(testMediaId);
            expect(row!.job_id).toBe('job-x1');
            expect(row!.output_dir).toBe('/tmp/out-x1');
            expect((row!.config as { generation: number }).generation).toBe(2);
            expect(row!.pod_name).toBe('pod-web');
        });

        it('refuses a conflicting write from a DIFFERENT user, leaving the row untouched', async () => {
            const sid = crypto.randomUUID();
            const otherUserId = generateTestUserId('trans_user_b');
            await ensureTestUser(sql, otherUserId);

            const jobA = makeJob({ playSessionId: sid });
            await upsertJob(sql, jobA);
            const before =
                await sql`SELECT * FROM active_transcode_jobs WHERE play_session_id = ${sid}`;

            const jobB = makeJob({ playSessionId: sid });
            jobB.user_id = otherUserId;
            jobB.item_id = (await createAndInsertTestMovie(sql, { tmdbId: 990303 })).id;
            jobB.job_id = 'job-b';
            const wroteB = await upsertJob(sql, jobB);
            expect(wroteB).toBe('refused');

            const after =
                await sql`SELECT * FROM active_transcode_jobs WHERE play_session_id = ${sid}`;
            expect(after).toEqual(before);

            const [session] = await sql`
                SELECT transcode_job_id FROM play_sessions WHERE id = ${sid}
            `;
            expect(session.transcode_job_id).not.toBe('job-b');
        });

        it("reports 'written-unlinked' when a fresh row lands under another user's play session", async () => {
            const sid = crypto.randomUUID();
            const otherUserId = generateTestUserId('trans_user_c');
            await ensureTestUser(sql, otherUserId);

            // A's play session exists but has no transcode row (e.g. A's job
            // was stopped and its row deleted), so B's write is a fresh INSERT
            // that the ON CONFLICT user guard never sees.
            await upsertJob(sql, makeJob({ playSessionId: sid }));
            await sql`DELETE FROM active_transcode_jobs WHERE play_session_id = ${sid}`;
            const [sessionBefore] = await sql`
                SELECT transcode_job_id FROM play_sessions WHERE id = ${sid}
            `;

            const jobB = makeJob({ playSessionId: sid });
            jobB.user_id = otherUserId;
            jobB.job_id = 'job-b-unlinked';
            expect(await upsertJob(sql, jobB)).toBe('written-unlinked');

            const [sessionAfter] = await sql`
                SELECT transcode_job_id FROM play_sessions WHERE id = ${sid}
            `;
            expect(sessionAfter.transcode_job_id).toBe(sessionBefore.transcode_job_id);
        });

        it('a fresh insert and a same-user same-item update both return true', async () => {
            const job = makeJob();
            expect(await upsertJob(sql, job)).toBe('written');

            const updated = { ...job, status: JobStatus.Running };
            expect(await upsertJob(sql, updated)).toBe('written');
        });
    });

    // ========================================================================
    // insertActiveTranscodeJob
    // ========================================================================

    describe('insertActiveTranscodeJob', () => {
        it('inserts without play_sessions plumbing', async () => {
            const job = makeJob({ playSessionId: crypto.randomUUID() });
            // insertActiveTranscodeJob requires a pre-existing play_sessions record
            await sql`
                INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
                VALUES (
                    ${job.play_session_id},
                    ${job.item_id}::uuid,
                    ${job.user_id},
                    ${job.device_id},
                    '0.0.0.0'::inet,
                    'full_transcode'
                )
            `;
            await insertActiveTranscodeJob(sql, job);

            const row = await getJob(sql, job.play_session_id);
            expect(row).not.toBeNull();
            expect(row!.job_id).toBe(job.job_id);
        });
    });

    // ========================================================================
    // updateTranscodeJobStatus
    // ========================================================================

    describe('updateTranscodeJobStatus', () => {
        it('updates status and error', async () => {
            const job = makeJob();
            await upsertJob(sql, job);

            const updated = await updateTranscodeJobStatus(sql, job.play_session_id, {
                status: JobStatus.Error,
                error_message: 'FFmpeg crashed',
            });

            expect(updated).toBe(1);
            const row = await getJob(sql, job.play_session_id);
            expect(row!.status).toBe(JobStatus.Error);
            expect(row!.error_message).toBe('FFmpeg crashed');
        });

        it('returns 0 when nothing changes', async () => {
            const job = makeJob();
            await upsertJob(sql, job);

            const updated = await updateTranscodeJobStatus(sql, job.play_session_id, {});
            expect(updated).toBe(0);
        });
    });

    // ========================================================================
    // updateLastAccessed
    // ========================================================================

    describe('updateLastAccessed', () => {
        it('bumps last_accessed_at and last_progress_at', async () => {
            const job = makeJob();
            await upsertJob(sql, job);
            const before = job.last_accessed_at;

            await new Promise((r) => setTimeout(r, 50));
            await updateLastAccessed(sql, job.play_session_id);

            const row = await getJob(sql, job.play_session_id);
            expect(row!.last_accessed_at.getTime()).toBeGreaterThan(before.getTime());
        });
    });

    // ========================================================================
    // updateLastProgress
    // ========================================================================

    describe('updateLastProgress', () => {
        it('bumps last_progress_at', async () => {
            const job = makeJob();
            await upsertJob(sql, job);

            await new Promise((r) => setTimeout(r, 50));
            await updateLastProgress(sql, job.play_session_id);

            const row = await getJob(sql, job.play_session_id);
            expect(row!.last_progress_at).not.toBeNull();
        });

        // A client heartbeat the router hashed to a NON-owner pod is written
        // without a pod guard; the owner's reaper then reads it back through
        // getJobsByPlaySessions (client-gone arm). Takeover must stay keyed off
        // last_accessed_at, so that column must not move.
        it('an unguarded heartbeat from a non-owner pod reaches the owner via getJobsByPlaySessions', async () => {
            const stale = new Date(Date.now() - 10 * 60_000);
            const job = makeJob({ podName: 'web-0', lastAccessedAt: stale, lastProgressAt: stale });
            await upsertJob(sql, job);

            await updateLastProgress(sql, job.play_session_id);

            const [row] = await getJobsByPlaySessions(sql, [job.play_session_id]);
            expect(Date.now() - row!.last_progress_at.getTime()).toBeLessThan(60_000);
            const full = await getJob(sql, job.play_session_id);
            expect(full!.last_accessed_at.getTime()).toBe(stale.getTime());
        });

        it('does not refresh a stopped (dormant) row', async () => {
            const stale = new Date(Date.now() - 10 * 60_000);
            const job = makeJob({ status: JobStatus.Stopped, lastProgressAt: stale });
            await upsertJob(sql, job);

            await updateLastProgress(sql, job.play_session_id);

            const row = await getJob(sql, job.play_session_id);
            expect(row!.last_progress_at.getTime()).toBe(stale.getTime());
        });
    });

    // ========================================================================
    // updateStatus
    // ========================================================================

    describe('updateStatus', () => {
        it('sets stopped status and stamps stopped_at', async () => {
            const job = makeJob({ status: JobStatus.Running });
            await upsertJob(sql, job);

            await updateStatus(sql, {
                playSessionId: job.play_session_id,
                status: JobStatus.Stopped,
                error: 'user_stop',
            });

            const row = await getJob(sql, job.play_session_id);
            expect(row!.status).toBe(JobStatus.Stopped);
            expect(row!.error_message).toBe('user_stop');
            expect(row!.stopped_at).not.toBeNull();
        });

        it('preserves can_restore when provided', async () => {
            const job = makeJob({ status: JobStatus.Running });
            await upsertJob(sql, job);

            await updateStatus(sql, {
                playSessionId: job.play_session_id,
                status: JobStatus.Stopped,
                canRestore: true,
            });

            const row = await getJob(sql, job.play_session_id);
            expect(row!.can_restore).toBe(true);
        });

        // D-HLS-1 follow-up (security runtime pass 2026-09-26, pod-guard):
        // a process that lost the D-HLS-1 cross-process race to upsertJob's
        // fix (b) must not stamp its own job's stopped/error status onto the
        // WINNER's live row (now owned by another pod, for another item).
        it('ownerPodName guard: refuses the write when the row is owned by a DIFFERENT pod', async () => {
            const job = makeJob({ status: JobStatus.Running, podName: 'pod-wrk' });
            await upsertJob(sql, job);

            const before = await getJob(sql, job.play_session_id);
            const updated = await updateStatus(sql, {
                playSessionId: job.play_session_id,
                status: JobStatus.Stopped,
                canRestore: true,
                ownerPodName: 'pod-web',
            });

            expect(updated).toBe(0);
            const after = await getJob(sql, job.play_session_id);
            expect(after!.status).toBe(before!.status);
            expect(after!.can_restore).toBe(before!.can_restore);
            expect(after!.stopped_at).toBe(before!.stopped_at);
        });

        it('ownerPodName guard: applies the write when the row is owned by the SAME pod', async () => {
            const job = makeJob({ status: JobStatus.Running, podName: 'pod-wrk' });
            await upsertJob(sql, job);

            const updated = await updateStatus(sql, {
                playSessionId: job.play_session_id,
                status: JobStatus.Stopped,
                canRestore: true,
                ownerPodName: 'pod-wrk',
            });

            expect(updated).toBe(1);
            const row = await getJob(sql, job.play_session_id);
            expect(row!.status).toBe(JobStatus.Stopped);
            expect(row!.can_restore).toBe(true);
        });

        it('unguarded call (no ownerPodName) still applies, matching the deliberate cross-pod client-stop shape', async () => {
            const job = makeJob({ status: JobStatus.Running, podName: 'pod-wrk' });
            await upsertJob(sql, job);

            const updated = await updateStatus(sql, {
                playSessionId: job.play_session_id,
                status: JobStatus.Stopped,
                canRestore: false,
            });

            expect(updated).toBe(1);
            const row = await getJob(sql, job.play_session_id);
            expect(row!.status).toBe(JobStatus.Stopped);
        });
    });

    // ========================================================================
    // updateProgress
    // ========================================================================

    describe('updateProgress', () => {
        it('updates segments_ready and master_playlist_ready', async () => {
            const job = makeJob();
            await upsertJob(sql, job);

            await updateProgress(sql, {
                playSessionId: job.play_session_id,
                segmentsReady: 10,
                masterReady: true,
            });

            const row = await getJob(sql, job.play_session_id);
            expect(row!.segments_ready).toBe(10);
            expect(row!.master_playlist_ready).toBe(true);
        });
    });

    // ========================================================================
    // deleteJob
    // ========================================================================

    describe('deleteJob', () => {
        it('removes job by play session ID', async () => {
            const job = makeJob();
            await upsertJob(sql, job);

            expect(await deleteJob(sql, job.play_session_id)).toBe(1);

            const row = await getJob(sql, job.play_session_id);
            expect(row).toBeNull();
        });

        it('reports 0 when the pod guard misses, so the caller does not log a delete', async () => {
            const job = makeJob({ podName: 'owner-pod' });
            await upsertJob(sql, job);

            expect(await deleteJob(sql, job.play_session_id, 'other-pod')).toBe(0);
            expect(await getJob(sql, job.play_session_id)).not.toBeNull();
            expect(await deleteJob(sql, job.play_session_id, 'owner-pod')).toBe(1);
        });
    });

    // ========================================================================
    // cleanupExpiredJobs
    // ========================================================================

    describe('cleanupExpiredJobs', () => {
        it('deletes running jobs with stale heartbeats', async () => {
            const job = makeJob({
                status: JobStatus.Running,
                lastAccessedAt: new Date(Date.now() - 1000 * 60 * 60),
                lastProgressAt: new Date(Date.now() - 1000 * 60 * 60),
            });
            await upsertJob(sql, job);

            const cleaned = await cleanupExpiredJobs(sql, {
                inactivityTtl: 60,
                progressTtl: 60,
            });

            expect(cleaned.length).toBe(1);
            expect(cleaned[0].play_session_id).toBe(job.play_session_id);
        });

        it('makes stale restorable HLS jobs dormant instead of deleting them', async () => {
            const job = makeJob({
                status: JobStatus.Running,
                lastAccessedAt: new Date(Date.now() - 1000 * 60 * 60),
                lastProgressAt: new Date(Date.now() - 1000 * 60 * 60),
            });
            job.can_restore = true;
            await upsertJob(sql, job);

            const cleaned = await cleanupExpiredJobs(sql, {
                inactivityTtl: 60,
                progressTtl: 60,
            });

            expect(cleaned).toHaveLength(0);
            const persisted = await getJob(sql, job.play_session_id);
            expect(persisted?.status).toBe(JobStatus.Stopped);
            expect(persisted?.can_restore).toBe(true);
        });

        it('keeps recently active jobs', async () => {
            const job = makeJob({ status: JobStatus.Running });
            await upsertJob(sql, job);

            const cleaned = await cleanupExpiredJobs(sql, {
                inactivityTtl: 3600,
                progressTtl: 3600,
            });

            expect(cleaned).toHaveLength(0);
        });
    });

    // ========================================================================
    // claimJobForRestoration
    // ========================================================================

    describe('claimJobForRestoration', () => {
        it('claims restoreable job', async () => {
            const job = makeJob({
                status: JobStatus.Stopped,
                podName: null,
            });
            await upsertJob(sql, job);
            await sql`
                UPDATE active_transcode_jobs SET can_restore = true WHERE play_session_id = ${job.play_session_id}
            `;

            const claimed = await claimJobForRestoration(sql, {
                playSessionId: job.play_session_id,
                podName: 'new-pod',
            });

            expect(claimed).toBe(true);
            const row = await getJob(sql, job.play_session_id);
            expect(row!.pod_name).toBe('new-pod');
            expect(row!.status).toBe(JobStatus.Starting);
        });

        it('refuses the claim when the row no longer names the item the caller validated', async () => {
            // Restore validates a row snapshot, then claims. If another process
            // fully replaced the row for a different item in between, the claim
            // must lose — otherwise the stale snapshot is respawned over it.
            const job = makeJob({ status: JobStatus.Stopped, podName: null });
            await upsertJob(sql, job);
            await sql`
                UPDATE active_transcode_jobs SET can_restore = true WHERE play_session_id = ${job.play_session_id}
            `;
            const otherItemId = (await createAndInsertTestMovie(sql, { tmdbId: 990304 })).id;

            const stale = await claimJobForRestoration(sql, {
                playSessionId: job.play_session_id,
                podName: 'restoring-pod',
                expectedItemId: otherItemId,
            });
            expect(stale).toBe(false);
            const untouched = await getJob(sql, job.play_session_id);
            expect(untouched!.pod_name).toBeNull();
            expect(untouched!.status).toBe(JobStatus.Stopped);

            const current = await claimJobForRestoration(sql, {
                playSessionId: job.play_session_id,
                podName: 'restoring-pod',
                expectedItemId: job.item_id,
            });
            expect(current).toBe(true);
        });

        it('returns false when job is not restoreable', async () => {
            const job = makeJob({ status: JobStatus.Error });
            await upsertJob(sql, job);
            await sql`
                UPDATE active_transcode_jobs SET can_restore = true WHERE play_session_id = ${job.play_session_id}
            `;

            const claimed = await claimJobForRestoration(sql, {
                playSessionId: job.play_session_id,
                podName: 'pod',
            });

            expect(claimed).toBe(false);
        });

        it('claims a STALE active job owned by another pod (rolling-recreate takeover)', async () => {
            // A rolling recreate can leave a session's owner != its sticky-hash target;
            // the peer now receiving its requests must take over once the owner stops
            // serving (last_accessed_at stale). Otherwise it defers forever → playback halts.
            const job = makeJob({
                status: JobStatus.Running,
                podName: 'owner-pod',
                lastAccessedAt: new Date(Date.now() - 20_000), // > 15s → stale
            });
            await upsertJob(sql, job);
            await sql`UPDATE active_transcode_jobs SET can_restore = true WHERE play_session_id = ${job.play_session_id}`;

            const claimed = await claimJobForRestoration(sql, {
                playSessionId: job.play_session_id,
                podName: 'new-pod',
            });

            expect(claimed).toBe(true);
            const row = await getJob(sql, job.play_session_id);
            expect(row!.pod_name).toBe('new-pod');
            expect(row!.status).toBe(JobStatus.Starting);
        });

        it('does NOT claim a FRESH active job owned by another pod', async () => {
            const job = makeJob({
                status: JobStatus.Running,
                podName: 'owner-pod',
                lastAccessedAt: new Date(), // owner served just now → not claimable by a peer
            });
            await upsertJob(sql, job);
            await sql`UPDATE active_transcode_jobs SET can_restore = true WHERE play_session_id = ${job.play_session_id}`;

            const claimed = await claimJobForRestoration(sql, {
                playSessionId: job.play_session_id,
                podName: 'new-pod',
            });

            expect(claimed).toBe(false);
            const row = await getJob(sql, job.play_session_id);
            expect(row!.pod_name).toBe('owner-pod'); // unchanged
        });
    });

    // ========================================================================
    // markPodJobsAsStopped
    // ========================================================================

    describe('markPodJobsAsStopped', () => {
        it('marks all jobs for pod as stopped', async () => {
            await upsertJob(sql, makeJob({ podName: 'pod-x', status: JobStatus.Running }));
            await upsertJob(sql, makeJob({ podName: 'pod-x', status: JobStatus.Ready }));

            const rows = await markPodJobsAsStopped(sql, {
                podName: 'pod-x',
                reason: 'pod_shutdown',
            });

            expect(rows.length).toBe(2);
            for (const r of rows) {
                const job = await getJob(sql, r.play_session_id);
                expect(job!.status).toBe(JobStatus.Stopped);
                expect(job!.error_message).toBe('pod_shutdown');
            }
        });
    });
});
