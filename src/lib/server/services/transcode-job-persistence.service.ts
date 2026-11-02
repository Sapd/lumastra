// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transcode Job Persistence Service
 *
 * Handles database persistence for FFmpeg transcode jobs to support:
 * - Server restart recovery (segments served from disk or FFmpeg restarted)
 * - Kubernetes multi-replica deployments (shared PVC + DB metadata)
 * - Graceful shutdown and orphan cleanup
 */

import type postgres from 'postgres';
import { getDb } from '$lib/server/database/connection.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { TranscodeJob, TranscodeJobConfig, TranscodeDecision } from './transcoding/types.js';
import { playMethodFromDecision } from './transcoding/types.js';
import { reconcileSessionPlayMethod } from '$lib/server/database/queries/play-sessions.queries.js';
import {
    getJob as getJobQuery,
    getJobsForPod as getJobsForPodQuery,
    getAllActiveJobs as getAllActiveJobsQuery,
    getAllJobPlaySessionIds as getAllJobPlaySessionIdsQuery,
    takeOverStaleJob as takeOverStaleJobQuery,
    getJobsByPlaySessions as getJobsByPlaySessionsQuery,
    upsertJob,
    updateLastAccessed as updateLastAccessedQuery,
    updateLastProgress as updateLastProgressQuery,
    updateStatus as updateStatusQuery,
    updateProgress as updateProgressQuery,
    deleteJob as deleteJobQuery,
    cleanupExpiredJobs as cleanupExpiredJobsQuery,
    retireOrphanedJob as retireOrphanedJobQuery,
    claimJobForRestoration as claimJobForRestorationQuery,
    markPodJobsAsStopped as markPodJobsAsStoppedQuery,
    insertActiveTranscodeJob,
    updateTranscodeJobStatus,
    JobStatus,
    type TranscodeJobRow,
    type JobStatusRow,
} from '$lib/server/database/queries/transcode-jobs.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import { AUDIOBOOK_REMUX_OUTPUT_DIR } from './audiobook-remux.service.js';
import {
    JELLYFIN_COMPAT_DEVICE_ID,
    isPersistablePlaySessionId,
} from './transcoding/session-key.js';

const logger = Logger.for('TranscodeJobPersistence');

/**
 * The `active_transcode_jobs.job_id` of one audiobook remux.
 *
 * Exported because two places need the SAME string and they are not the same
 * call: the row is written when the encoder starts, and the terminal update is
 * guarded by this id so a seek that already replaced the row is not overwritten
 * by the previous process's exit.
 */
export function audiobookRemuxJobId(ino: string, startSeconds: number): string {
    return `audiobook-remux-${ino}-t${Math.round(startSeconds)}`;
}

/**
 * This process's pod identity — the single canonical value for
 * `active_transcode_jobs.pod_name` and every "is this row mine"
 * write/guard/comparison built on it.
 *
 * The fallback is `'unknown'`, not `null`: `restoreHlsJobIfMissing`'s
 * `currentPodName` (`lumastra-segment-handler.ts`) already writes `pod_name`
 * via `claimJobForRestoration`/`takeOverStaleJob` using
 * `process.env.HOSTNAME || 'unknown'`, on a call path outside this fix's
 * scope — so every OTHER writer/guard here and in
 * `ffmpeg-transcode.service.ts` must agree with THAT spelling, not invent a
 * second one. A `null` fallback would be a real bug on a HOSTNAME-less
 * install: a row this pod just claimed/took over has `pod_name = 'unknown'`,
 * and `updateStatus`'s pod guard (`pod_name IS NULL OR pod_name =
 * ${ownerPodName}`) is false for `'unknown' = NULL` — refusing this pod's
 * OWN subsequent status write on the row it just claimed.
 */
export function getCurrentPodName(): string {
    return process.env.HOSTNAME || 'unknown';
}

export { JELLYFIN_COMPAT_DEVICE_ID };

// ============================================================================
// Types
// ============================================================================

/**
 * Extended job metadata with properly typed config and transcode_decision.
 * Wraps TranscodeJobRow with the actual typed fields.
 */
export interface PersistedJobMetadata extends Omit<
    TranscodeJobRow,
    'config' | 'transcode_decision'
> {
    config: TranscodeJobConfig;
    transcode_decision: TranscodeDecision | null;
}

/**
 * Fix double-serialized jsonb fields from older rows.
 * Older code did JSON.stringify(obj) + ::jsonb, storing a jsonb string.
 * postgres.js auto-parses jsonb but returns a string instead of an object.
 */
function fixJsonbFields(row: PersistedJobMetadata): PersistedJobMetadata {
    if (typeof row.config === 'string') {
        row.config = JSON.parse(row.config) as TranscodeJobConfig;
    }
    if (typeof row.transcode_decision === 'string') {
        row.transcode_decision = JSON.parse(row.transcode_decision) as TranscodeDecision;
    }
    return row;
}

export interface CleanedUpJob {
    play_session_id: string;
    job_id: string;
    status: string;
    pod_name: string | null;
    output_dir: string;
}

// ============================================================================
// Service Implementation
// ============================================================================

// Preview session IDs use "preview-{uuid}-{ts}" format which is not a valid UUID.
// The DB column is typed UUID, so we must skip persistence for these sessions.

export class TranscodeJobPersistenceService {
    private sql: postgres.Sql;

    /**
     * @param sql Injected only by integration tests, which run against
     * `lumastra_tests` rather than the process-wide connection `getDb()` returns.
     * Production always takes the default — see {@link getTranscodeJobPersistenceService}.
     */
    constructor(sql?: postgres.Sql) {
        const db = sql ?? getDb();
        if (!db) {
            throw new Error(
                'AI database not configured - transcode persistence requires DATABASE_URL',
            );
        }
        this.sql = db;
    }

    /**
     * Returns true if the play session ID is a UUID (persistable to DB). Dashless
     * counts: `/j` mints 32-hex ids, which the `uuid` column accepts as input and
     * hands back dashed — see `sessionKey()` for the in-memory side of that.
     */
    private isPersistable(playSessionId: string): boolean {
        return isPersistablePlaySessionId(playSessionId);
    }

    /**
     * Save a transcode job to the database.
     * This is called when a new FFmpeg job is started.
     */
    async saveJob(job: TranscodeJob): Promise<void> {
        if (!this.isPersistable(job.config.playSessionId)) return;
        const podName = getCurrentPodName();
        const ffmpegPid = job.process?.pid || null;

        try {
            const persistMode = 'full';

            // play_sessions.user_id / active_transcode_jobs.user_id are the
            // users.id UUID (mig 16.46.0); the transcode config carries the
            // username, so resolve it. No local user ⇒ skip persistence (the
            // job still runs; it's just not restorable across restarts).
            const userId = await getUserIdByUsername(this.sql, job.config.username);
            if (!userId) {
                logger.debug('Skipping transcode-job persistence: no local user for username', {
                    username: job.config.username,
                    jobId: job.id,
                });
                return;
            }

            const ownPlaySession = job.config.deviceId !== JELLYFIN_COMPAT_DEVICE_ID;
            const written = await upsertJob(this.sql, {
                play_session_id: job.config.playSessionId,
                job_id: job.id,
                item_id: job.config.itemId,
                user_id: userId,
                device_id: job.config.deviceId,
                config: job.config as unknown as Record<string, unknown>,
                output_dir: job.outputDir,
                status: job.status,
                mode: persistMode,
                segment_offset: job.segmentOffset || 0,
                segments_ready: job.segmentsReady || 0,
                master_playlist_ready: job.masterPlaylistReady || false,
                pod_name: podName,
                ffmpeg_pid: ffmpegPid,
                created_at: job.startedAt,
                last_accessed_at: job.lastAccessedAt,
                last_progress_at: job.lastProgressAt,
                transcode_decision: job.transcodeDecisionResult
                    ? (job.transcodeDecisionResult as unknown as Record<string, unknown>)
                    : null,
                can_restore: true,
                ensure_play_session: ownPlaySession,
            });

            if (written === 'refused') {
                // upsertJob's user_id-guarded ON CONFLICT refused the write:
                // the persisted row belongs to a different user than this
                // job's config. Non-fatal — the in-memory job still runs;
                // it just isn't persisted/restorable across a restart. Log
                // truncated ids only (playSessionId/jobId can appear in
                // shared logs).
                logger.warn('Transcode job persistence refused: row belongs to another user', {
                    playSessionId: job.config.playSessionId.slice(0, 8),
                    jobId: job.id.slice(0, 8),
                });
                return;
            }
            if (written === 'written-unlinked') {
                // The play_sessions row under this id belongs to another user.
                // Both master-route arms check ownership before a start, so
                // this should be unreachable — log it rather than stay silent.
                logger.warn(
                    'Transcode job persisted but its play session belongs to another user',
                    {
                        playSessionId: job.config.playSessionId.slice(0, 8),
                        jobId: job.id.slice(0, 8),
                    },
                );
            }

            logger.info('Transcode job persisted to database', {
                playSessionId: job.config.playSessionId,
                jobId: job.id,
                mode: job.config.transcodeMode,
                podName,
                ffmpegPid,
            });

            // Correct play_sessions.play_method to what the server actually decided.
            // The value written at session start is the client's REQUEST, and some
            // clients never revise it — the tvOS client reports full_transcode for
            // every session, so stream copies were recorded (and costed) as full
            // transcodes. This is the first point where the real decision is known.
            // Best-effort: a failure here must not affect playback.
            if (ownPlaySession && job.transcodeDecisionResult && job.config.playSessionId) {
                try {
                    const actual = playMethodFromDecision(job.transcodeDecisionResult);
                    const corrected = await reconcileSessionPlayMethod(
                        this.sql,
                        job.config.playSessionId,
                        actual,
                    );
                    if (corrected) {
                        logger.debug('Corrected session play_method to the actual decision', {
                            playSessionId: job.config.playSessionId,
                            playMethod: actual,
                            videoAction: job.transcodeDecisionResult.videoAction,
                            audioAction: job.transcodeDecisionResult.audioAction,
                        });
                    }
                } catch (err) {
                    logger.warn('Failed to reconcile session play_method', {
                        playSessionId: job.config.playSessionId,
                        err,
                    });
                }
            }
        } catch (error) {
            logger.error('Failed to persist transcode job', error as Error, {
                playSessionId: job.config.playSessionId,
                jobId: job.id,
            });
            throw error;
        }
    }

    /**
     * Register one audiobook remux so it shows up in the admin transcode
     * surfaces next to video and music instead of being an invisible
     * side-channel.
     *
     * ## Why this is a method here and not a hand-rolled INSERT at the call site
     *
     * `active_transcode_jobs` has exactly one owner, and every other subsystem
     * that writes to it (video, music) does so through a service. What it is NOT
     * is {@link saveJob}: that takes a `TranscodeJob`, i.e. an HLS job with an
     * output directory, a segment count, a master playlist and a
     * `TranscodeDecision`. A book has none of those, so calling it would mean
     * fabricating a video job — an object that cannot exist — which is precisely
     * the fixture mistake that has already cost this integration a bug.
     *
     * ## What is deliberately left null / constant
     *
     *  - **`transcode_decision`** stays `null`. The shape is a
     *    `{ videoAction, audioAction }` pair, and writing `videoAction: 'copy'`
     *    for a file with no video stream would make the admin surface read
     *    plausibly off an impossible row. The honest label is derived from
     *    `config.type` instead (see `getAllActiveJobsInfoMultiPod`).
     *  - **`mode`** is `'full'` because the column has a
     *    `CHECK (mode = 'full')` constraint — the schema does not currently
     *    admit another value, and widening it would migrate a column no reader
     *    consults for the job KIND. `config.type` carries the kind, exactly as
     *    the music path already does.
     *  - **`can_restore`** is false. There is nothing to restore: the process
     *    holds the client's socket, so a restart means the client re-requests.
     *  - **`segments_ready` / `master_playlist_ready`** are 0/false forever.
     *    There are no segments. A progress percentage would be a fiction.
     *
     * Failure is non-fatal by design: losing admin visibility for one stream must
     * never stop a listener's audio. In particular the `play_session_id` FK can
     * legitimately fail if the session was closed between the byte request and
     * this write.
     */
    async recordAudiobookRemuxJob(input: {
        /** `play_sessions.id` of the audiobook session this byte stream serves. */
        playSessionId: string;
        /** `media_items.id` of the book. */
        mediaId: string;
        userId: string;
        deviceId: string;
        /** AudiobookShelf inode of the file being remuxed. */
        ino: string;
        /** AudiobookShelf library-item id. */
        absItemId: string;
        /** Codec we are re-encoding away from, e.g. `eac3`. */
        sourceCodec: string;
        /** Where in the file this stream starts, seconds (restart-on-seek). */
        startSeconds: number;
        ffmpegPid: number | null;
    }): Promise<void> {
        if (!this.isPersistable(input.playSessionId)) return;
        const now = new Date();

        try {
            await insertActiveTranscodeJob(this.sql, {
                play_session_id: input.playSessionId,
                // The offset is part of the id: restart-on-seek means one
                // session produces a series of jobs, and an id that collapsed
                // them would make two consecutive seeks indistinguishable in the
                // admin log. It is also what lets the terminal update below
                // refuse to touch a row a later seek has taken over.
                job_id: audiobookRemuxJobId(input.ino, input.startSeconds),
                item_id: input.mediaId,
                user_id: toUserId(input.userId),
                device_id: input.deviceId,
                config: {
                    type: 'audiobook',
                    transcode_mode: 'remux_live',
                    source_codec: input.sourceCodec,
                    target_codec: 'aac',
                    abs_item_id: input.absItemId,
                    ino: input.ino,
                    start_seconds: input.startSeconds,
                },
                output_dir: AUDIOBOOK_REMUX_OUTPUT_DIR,
                status: input.ffmpegPid !== null ? JobStatus.Running : JobStatus.Starting,
                mode: 'full',
                segment_offset: 0,
                segments_ready: 0,
                master_playlist_ready: false,
                pod_name: getCurrentPodName(),
                ffmpeg_pid: input.ffmpegPid,
                created_at: now,
                last_accessed_at: now,
                last_progress_at: now,
                transcode_decision: null,
                can_restore: false,
            });
        } catch (error) {
            logger.warn(
                'Failed to record audiobook remux job',
                {
                    playSessionId: input.playSessionId,
                    mediaId: input.mediaId,
                    ino: input.ino,
                },
                error as Error,
            );
        }
    }

    /**
     * Mark an audiobook remux row terminal.
     *
     * `ok: false` is reserved for a real encode failure. A listener who pauses,
     * seeks or closes the tab makes us SIGTERM ffmpeg, which then exits 255 —
     * recording that as `error` would light up the admin surface on the most
     * ordinary event in the player's life. The distinction is made in
     * `audiobook-remux.service.ts`; this method only records it.
     */
    async finalizeAudiobookRemuxJob(
        playSessionId: string,
        result: { ok: boolean; error?: string; jobId?: string },
    ): Promise<void> {
        if (!this.isPersistable(playSessionId)) return;
        try {
            await updateTranscodeJobStatus(this.sql, playSessionId, {
                status: result.ok ? JobStatus.Stopped : JobStatus.Error,
                stopped_at: new Date(),
                ffmpeg_pid: null,
                error_message: result.ok ? null : (result.error ?? 'unknown error'),
                // Guarded by job id: a seek replaces the row while the previous
                // ffmpeg is still dying, and an unguarded write would mark the
                // NEW stream stopped over live audio.
                ...(result.jobId !== undefined ? { expected_job_id: result.jobId } : {}),
            });
        } catch (error) {
            logger.warn(
                'Failed to finalize audiobook remux job',
                { playSessionId },
                error as Error,
            );
        }
    }

    /**
     * Load a transcode job from the database.
     * Returns null if not found.
     */
    async getJob(playSessionId: string): Promise<PersistedJobMetadata | null> {
        if (!this.isPersistable(playSessionId)) return null;
        try {
            const row = await getJobQuery(this.sql, playSessionId);

            if (!row) {
                logger.debug('Job not found in database', { playSessionId });
                return null;
            }

            const age = Date.now() - row.created_at.getTime();

            logger.debug('Job loaded from database', {
                playSessionId,
                jobId: row.job_id,
                status: row.status,
                age,
                podName: row.pod_name,
            });

            return fixJsonbFields(row as unknown as PersistedJobMetadata);
        } catch (error) {
            logger.error('Failed to load job from database', error as Error, {
                playSessionId,
            });
            throw error;
        }
    }

    /**
     * Update the last accessed timestamp for a job.
     * Called when a segment is requested.
     *
     * Also updates last_progress_at to support external HLS clients that don't
     * implement the /progress endpoint. This ensures segment requests alone
     * can keep a job alive.
     */
    async updateLastAccessed(playSessionId: string, ownerPodName?: string | null): Promise<void> {
        if (!this.isPersistable(playSessionId)) return;
        try {
            await updateLastAccessedQuery(this.sql, playSessionId, ownerPodName);

            logger.debug('Updated last_accessed_at and last_progress_at', {
                playSessionId,
            });
        } catch (error) {
            logger.warn(
                'Failed to update timestamps',
                {
                    playSessionId,
                },
                error as Error,
            );
            // Non-fatal, don't throw
        }
    }

    /**
     * Update the last progress timestamp for a job.
     * Called when a progress heartbeat is received from the client.
     */
    async updateLastProgress(
        playSessionId: string,
        ownerPodName?: string | null,
        ownerUsername?: string,
    ): Promise<void> {
        if (!this.isPersistable(playSessionId)) return;
        try {
            await updateLastProgressQuery(this.sql, playSessionId, ownerPodName, ownerUsername);

            logger.debug('Updated last_progress_at', { playSessionId });
        } catch (error) {
            logger.warn(
                'Failed to update last_progress_at',
                {
                    playSessionId,
                },
                error as Error,
            );
            // Non-fatal, don't throw
        }
    }

    /**
     * Update job status and optionally set error message.
     * When marking as 'stopped', also updates last_accessed_at to prevent immediate cleanup.
     *
     * @param canRestore - Whether the job can be restored after being stopped:
     *   - true: Server shutdown (job should restart on segment request)
     *   - false: Admin/client stop (job should NOT restart)
     * @param ownerPodName Pass `getCurrentPodName()` from a caller writing ITS
     * OWN job's status (a loser process must not stamp stopped/error onto a
     * row a newer process's `upsertJob` full-replace has since claimed for a
     * different item — see `updateStatus`'s doc comment in
     * `transcode-jobs.queries.ts`). Omit entirely for a deliberate cross-pod
     * write (e.g. an admin/client stop of another pod's job).
     */
    async updateStatus(
        playSessionId: string,
        status: string,
        error?: string,
        canRestore?: boolean,
        ownerPodName?: string | null,
    ): Promise<void> {
        if (!playSessionId) {
            throw new Error('playSessionId is required');
        }
        if (!this.isPersistable(playSessionId)) return;

        try {
            const updated = await updateStatusQuery(this.sql, {
                playSessionId,
                status,
                error,
                canRestore,
                ownerPodName,
            });

            if (ownerPodName !== undefined && updated === 0) {
                // 0 rows is also the normal outcome when FFmpeg reaches `ready`
                // before `saveJob` has inserted the row (short sources) — only a
                // row under a different pod is a refusal worth a warning.
                const row = await getJobQuery(this.sql, playSessionId);
                if (row) {
                    logger.warn('Job status update refused: row belongs to another pod', {
                        playSessionId: playSessionId.slice(0, 8),
                        status,
                        ownerPodName,
                        rowPodName: row.pod_name,
                    });
                } else {
                    logger.debug('Job status update skipped: no persisted row yet', {
                        playSessionId: playSessionId.slice(0, 8),
                        status,
                    });
                }
                return;
            }

            logger.info('Updated job status', {
                playSessionId,
                status,
                error,
                canRestore,
            });
        } catch (err) {
            logger.error('Failed to update job status', err as Error, {
                playSessionId,
                status,
            });
            throw err;
        }
    }

    /**
     * Update job progress (segments ready, master playlist ready).
     */
    async updateProgress(
        playSessionId: string,
        segmentsReady: number,
        masterReady: boolean,
        ownerPodName?: string | null,
    ): Promise<void> {
        if (!this.isPersistable(playSessionId)) return;
        try {
            await updateProgressQuery(this.sql, {
                playSessionId,
                segmentsReady,
                masterReady,
                ownerPodName,
            });

            logger.debug('Updated job progress', {
                playSessionId,
                segmentsReady,
                masterReady,
            });
        } catch (error) {
            logger.warn(
                'Failed to update job progress',
                {
                    playSessionId,
                },
                error as Error,
            );
            // Non-fatal, don't throw
        }
    }

    /**
     * Delete a job from the database.
     * Called when a job is stopped or cleaned up.
     */
    /**
     * Delete a job row.
     *
     * @param ownerPodName Pass a pod name to make the delete ownership-guarded
     * (a pod that has since lost the session to a peer must not delete the new
     * owner's row). Omit only for genuinely global cleanup.
     */
    async deleteJob(playSessionId: string, ownerPodName?: string | null): Promise<void> {
        if (!this.isPersistable(playSessionId)) return;
        try {
            const deleted = await deleteJobQuery(this.sql, playSessionId, ownerPodName);

            if (deleted === 0 && ownerPodName !== undefined) {
                logger.info('Transcode job row not deleted: absent or owned by another pod', {
                    playSessionId,
                    ownerPodName,
                });
                return;
            }
            logger.info('Transcode job deleted from database', {
                playSessionId,
            });
        } catch (error) {
            logger.error('Failed to delete job from database', error as Error, {
                playSessionId,
            });
            throw error;
        }
    }

    /** Retire the exact stale generation the startup sweep inspected. */
    async retireOrphanedJob(playSessionId: string, jobId: string, cutoff: Date): Promise<boolean> {
        return retireOrphanedJobQuery(this.sql, playSessionId, jobId, cutoff);
    }

    /**
     * Cleanup expired jobs based on inactivity and progress timeouts.
     * Different cleanup rules per status:
     * - Running/ready jobs: Need BOTH segment requests AND progress heartbeats (AND condition)
     *   - Progress heartbeats keep paused sessions alive
     *   - Segment requests indicate active playback
     *   - Both must timeout before job is abandoned
     * - Stopped jobs: 60 min recovery window for resumable HLS sessions
     * - Error jobs: 5 min grace period
     * Returns the deleted jobs (including output_dir for cleanup).
     */
    async cleanupExpiredJobs(inactivityTtl: number, progressTtl: number): Promise<CleanedUpJob[]> {
        try {
            const result = await cleanupExpiredJobsQuery(this.sql, {
                inactivityTtl,
                progressTtl,
            });

            if (result.length > 0) {
                logger.info('Cleaned up expired jobs from database', {
                    count: result.length,
                    jobs: result.map((r) => ({
                        playSessionId: r.play_session_id,
                        jobId: r.job_id,
                        status: r.status,
                        podName: r.pod_name,
                        outputDir: r.output_dir,
                    })),
                });
            }

            return result;
        } catch (error) {
            logger.error('Failed to cleanup expired jobs', error as Error);
            throw error;
        }
    }

    /**
     * Get all jobs for a specific pod (by HOSTNAME).
     * Used for startup orphan cleanup.
     */
    async getJobsForPod(podName: string): Promise<PersistedJobMetadata[]> {
        try {
            const result = await getJobsForPodQuery(this.sql, podName);

            logger.debug('Retrieved jobs for pod', {
                podName,
                count: result.length,
            });

            return (result as unknown as PersistedJobMetadata[]).map(fixJsonbFields);
        } catch (error) {
            logger.error('Failed to get jobs for pod', error as Error, {
                podName,
            });
            throw error;
        }
    }

    /**
     * Get all active jobs across all pods.
     * Used for multi-pod admin monitoring.
     */
    async getAllActiveJobs(): Promise<PersistedJobMetadata[]> {
        try {
            const result = await getAllActiveJobsQuery(this.sql);

            logger.debug('Retrieved all active jobs', {
                count: result.length,
            });

            return (result as unknown as PersistedJobMetadata[]).map(fixJsonbFields);
        } catch (error) {
            logger.error('Failed to get all active jobs', error as Error);
            throw error;
        }
    }

    /**
     * Play session ids of EVERY row in active_transcode_jobs, any status.
     *
     * The startup transcode-directory wipe uses this rather than
     * getAllActiveJobs(), which filters to starting/running/ready. A graceful
     * shutdown persists 'stopped' + can_restore=true and keeps the output
     * directory on purpose so a peer can restore the session across a rolling
     * deploy; treating those as absent would delete the very directories that
     * restore path needs.
     */
    async getAllJobPlaySessionIds(): Promise<string[]> {
        const rows = await getAllJobPlaySessionIdsQuery(this.sql);
        return rows.map((row) => row.play_session_id);
    }

    /**
     * Take ownership of a job whose owner stopped serving it, without changing
     * its status. See takeOverStaleJob in the queries module for why the
     * disk-serve path needs this.
     */
    async takeOverStaleJob(playSessionId: string, podName: string): Promise<boolean> {
        if (!this.isPersistable(playSessionId)) return false;
        try {
            return await takeOverStaleJobQuery(this.sql, { playSessionId, podName });
        } catch (error) {
            logger.warn('Failed to take over stale job', {
                playSessionId,
                podName,
                error: String(error),
            });
            return false;
        }
    }

    /**
     * Get jobs by specific play session IDs (for cross-pod stop detection).
     * Returns jobs regardless of status to detect 'stopped' jobs.
     * Includes job_id to verify the DB record matches the in-memory job.
     */
    async getJobsByPlaySessions(playSessionIds: string[]): Promise<JobStatusRow[]> {
        try {
            if (playSessionIds.length === 0) {
                return [];
            }

            const result = await getJobsByPlaySessionsQuery(this.sql, playSessionIds);

            logger.debug('Retrieved jobs by play sessions', {
                requested: playSessionIds.length,
                found: result.length,
            });

            return result;
        } catch (error) {
            logger.error('Failed to get jobs by play sessions', error as Error);
            throw error;
        }
    }

    /**
     * Attempt to claim a job for restoration by this pod.
     * Uses optimistic locking to prevent multiple pods from restoring the same job.
     * Returns true if the job was successfully claimed, false if another pod claimed it.
     *
     * Only claims jobs where:
     * - can_restore = TRUE (prevents restarting admin-stopped jobs)
     * - status NOT 'error' (prevents infinite retry loops for failed jobs)
     * - status = 'stopped' OR pod_name matches (optimistic locking)
     */
    async claimJobForRestoration(
        playSessionId: string,
        podName: string,
        expectedItemId?: string,
    ): Promise<boolean> {
        try {
            const claimed = await claimJobForRestorationQuery(this.sql, {
                playSessionId,
                podName,
                expectedItemId,
            });

            if (!claimed) {
                logger.info('Job already claimed by another pod', {
                    playSessionId,
                    attemptedPodName: podName,
                });
                return false;
            }

            logger.info('Job claimed for restoration', {
                playSessionId,
                podName,
            });
            return true;
        } catch (error) {
            logger.error('Failed to claim job for restoration', error as Error, {
                playSessionId,
                podName,
            });
            throw error;
        }
    }

    /**
     * Mark all jobs for a specific pod as stopped.
     * Used during graceful shutdown in Kubernetes.
     * Returns the number of jobs marked as stopped.
     */
    async markPodJobsAsStopped(podName: string, reason: string): Promise<number> {
        try {
            const result = await markPodJobsAsStoppedQuery(this.sql, {
                podName,
                reason,
            });

            if (result.length > 0) {
                logger.warn('Marked pod jobs as stopped', {
                    podName,
                    reason,
                    count: result.length,
                    jobs: result.map((r) => ({
                        playSessionId: r.play_session_id,
                        jobId: r.job_id,
                    })),
                });
            }

            return result.length;
        } catch (error) {
            logger.error('Failed to mark pod jobs as stopped', error as Error, {
                podName,
                reason,
            });
            throw error;
        }
    }
}

// Singleton instance
let persistenceService: TranscodeJobPersistenceService | null = null;

/**
 * Get or create the singleton persistence service instance.
 */
export function getTranscodeJobPersistenceService(): TranscodeJobPersistenceService {
    if (!persistenceService) {
        persistenceService = new TranscodeJobPersistenceService();
    }
    return persistenceService;
}
