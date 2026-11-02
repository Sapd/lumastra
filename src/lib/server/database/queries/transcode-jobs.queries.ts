// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transcode Jobs Queries
 *
 * Centralized database queries for FFmpeg transcode job persistence.
 * Supports server restart recovery and Kubernetes multi-replica deployments.
 *
 * Table: active_transcode_jobs
 *
 * @module queries/transcode-jobs
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Types
// =============================================================================

export interface TranscodeJobRow {
    play_session_id: string;
    job_id: string;
    item_id: string;
    user_id: string;
    device_id: string;
    config: Record<string, unknown>;
    output_dir: string;
    status: string;
    mode: 'full';
    error_message: string | null;
    segment_offset: number;
    segments_ready: number;
    master_playlist_ready: boolean;
    pod_name: string | null;
    ffmpeg_pid: number | null;
    created_at: Date;
    last_accessed_at: Date;
    last_progress_at: Date;
    stopped_at: Date | null;
    transcode_decision: Record<string, unknown> | null;
    can_restore: boolean;
    cpu_percent: number | null;
    memory_mb: number | null;
}

export interface TranscodeJobInsert {
    play_session_id: string;
    job_id: string;
    item_id: string;
    user_id: UserId;
    device_id: string;
    config: Record<string, unknown>; // Object — postgres.js serializes to jsonb
    output_dir: string;
    status: string;
    mode: 'full';
    segment_offset: number;
    segments_ready: number;
    master_playlist_ready: boolean;
    pod_name: string | null;
    ffmpeg_pid: number | null;
    created_at: Date;
    last_accessed_at: Date;
    last_progress_at: Date;
    transcode_decision: Record<string, unknown> | null; // Object — postgres.js serializes to jsonb
    can_restore: boolean;
    /**
     * {@link upsertJob} only: `false` when `play_session_id` is not a
     * `play_sessions.id` (the `/j` PlaySessionId) — no stub is inserted and no
     * play_sessions row is linked. Defaults to `true`.
     */
    ensure_play_session?: boolean;
}

export interface CleanedUpJobRow {
    play_session_id: string;
    job_id: string;
    status: string;
    pod_name: string | null;
    output_dir: string;
}

export interface JobStatusRow {
    play_session_id: string;
    job_id: string;
    status: string;
    error_message: string | null;
    pod_name: string | null;
    /** Distinguishes the dormant sweep's mark (true: keep restorable) from an
     *  explicit cross-pod stop (false) — see cleanupInactiveJobs. */
    can_restore: boolean;
    /** Last client activity any pod recorded (heartbeat or segment fetch) — a
     *  heartbeat the router sent to a non-owner pod only shows up here. */
    last_progress_at: Date;
    /** NULL means the job's ordinary play session has been deleted. */
    play_session_status: string | null;
    play_session_stop_reason: string | null;
}

// Job status constants
export const JobStatus = {
    Starting: 'starting',
    Running: 'running',
    Ready: 'ready',
    Stopping: 'stopping',
    Stopped: 'stopped',
    Error: 'error',
} as const;

// Cleanup timeout constants (in seconds)
const ERROR_JOB_TTL = 300; // 5 minutes
// A stopped, restorable HLS job is dormant rather than abandoned: FFmpeg and
// its segment cache have already been released, but its metadata must remain
// long enough for a paused/backgrounded browser to resume transparently.
const STOPPED_JOB_TTL = 3600; // 60 minutes

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Get a transcode job by play session ID.
 */
export async function getJob(
    sql: postgres.Sql,
    playSessionId: string,
): Promise<TranscodeJobRow | null> {
    const rows = await sql<TranscodeJobRow[]>`
        SELECT * FROM active_transcode_jobs
        WHERE play_session_id = ${playSessionId}
    `;
    return rows[0] || null;
}

/**
 * Get all jobs for a specific pod.
 */
export async function getJobsForPod(
    sql: postgres.Sql,
    podName: string,
): Promise<TranscodeJobRow[]> {
    return await sql<TranscodeJobRow[]>`
        SELECT * FROM active_transcode_jobs
        WHERE pod_name = ${podName}
        ORDER BY created_at DESC
    `;
}

/**
 * Get all active jobs across all pods.
 */
export async function getAllActiveJobs(sql: postgres.Sql): Promise<TranscodeJobRow[]> {
    return await sql<TranscodeJobRow[]>`
        SELECT * FROM active_transcode_jobs
        WHERE status IN (${JobStatus.Starting}, ${JobStatus.Running}, ${JobStatus.Ready}, ${JobStatus.Stopping})
        ORDER BY created_at DESC
    `;
}

/**
 * Number of VIDEO transcodes that are live right now, across all pods — the
 * signal background CPU work (e.g. acoustid-fingerprint) throttles on.
 *
 * Counts only jobs that actually encode video (`config.videoInfo.isTranscoded`):
 * remux / direct-stream copies, audio-only transcodes of a video file, music
 * and audiobook jobs (`config.type`) are cheap and never count. "Live" = an
 * active status, an ffmpeg pid, and a client heartbeat (`last_progress_at`,
 * persisted every 60 s) within `heartbeatWindowSec`, so a stale or abandoned
 * row never counts.
 */
export async function countLiveVideoTranscodes(
    sql: postgres.Sql,
    heartbeatWindowSec = 180,
): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM active_transcode_jobs
         WHERE status IN (${JobStatus.Starting}, ${JobStatus.Running}, ${JobStatus.Ready})
           AND ffmpeg_pid IS NOT NULL
           AND (config->'videoInfo'->>'isTranscoded')::boolean IS TRUE
           AND last_progress_at > now() - make_interval(secs => ${heartbeatWindowSec})
    `;
    return row?.n ?? 0;
}

/**
 * Every play session with a row in active_transcode_jobs, whatever its status.
 *
 * Deliberately NOT filtered like getAllActiveJobs(): this is the "does anything
 * on disk still belong to someone" question asked by the startup transcode-dir
 * wipe. A graceful shutdown persists status='stopped' with can_restore=true and
 * intentionally LEAVES the output directory in place so a peer can restore the
 * session after a rolling deploy — filtering those out here would delete
 * exactly the directories that mechanism depends on.
 */
export async function getAllJobPlaySessionIds(
    sql: postgres.Sql,
): Promise<{ play_session_id: string }[]> {
    return await sql<{ play_session_id: string }[]>`
        SELECT play_session_id FROM active_transcode_jobs
    `;
}

/**
 * Get jobs by specific play session IDs.
 */
export async function getJobsByPlaySessions(
    sql: postgres.Sql,
    playSessionIds: string[],
): Promise<JobStatusRow[]> {
    if (playSessionIds.length === 0) return [];

    return await sql<JobStatusRow[]>`
        SELECT j.play_session_id, j.job_id, j.status, j.error_message, j.pod_name, j.can_restore,
               j.last_progress_at, s.status AS play_session_status,
               s.stop_reason AS play_session_stop_reason
        FROM active_transcode_jobs j
        LEFT JOIN play_sessions s ON s.id = j.play_session_id
        WHERE j.play_session_id = ANY(${playSessionIds}::uuid[])
    `;
}

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Insert or update a transcode job.
 * Creates a play_sessions record first if it doesn't exist.
 *
 * Returns `true` if the row was written (fresh insert, or an update accepted
 * by the `user_id` guard below), `false` if a conflicting row belongs to a
 * DIFFERENT user and the write was refused.
 *
 * ## D-HLS-1 (security runtime pass 2026-09-26, fix (b)): full replace vs refuse
 *
 * A second process starting a DIFFERENT item under the SAME play_session_id
 * (cross-process start, or two case-variant spellings of one session id
 * racing past `withSessionStartLock`) used to hit the old `ON CONFLICT DO
 * UPDATE`, which only touched `status`/`config`/`segment_offset`/`pod_name`/
 * `ffmpeg_pid`/`last_accessed_at`/`last_progress_at` — leaving `item_id`,
 * `job_id` and `output_dir` from the FIRST job while `config.itemId` named
 * the SECOND, a self-inconsistent row (measured 20/20 on preprod).
 *
 * Fix: when the incoming `item_id` differs from the persisted one, fully
 * replace every insert-time column (including a reset of the terminal-state
 * columns `error_message`/`stopped_at`/`cpu_percent`/`memory_mb`, which the
 * INSERT list never sets and the old partial UPDATE never cleared) instead of
 * keeping the half-update. Newest start wins, mirroring the in-process
 * `playback_config_changed` semantics (stop old, start new): the row must
 * describe exactly the job the client last asked for, so a restore respawns
 * THAT job. Refusing instead would leave the row pointing at an abandoned job
 * while the job the client is actually playing has no row (not restorable),
 * and would also break a legitimate item switch whose pod-guarded
 * `deleteJob` missed or failed. The `item_id` comparison is plain
 * `IS DISTINCT FROM` (not the C1 normalized/bound-set comparison) — a mere
 * respelling of the same item (dashed vs dashless) also takes the
 * full-replace branch, which is harmless: the row then simply describes
 * exactly the job that just persisted, under whichever spelling it used.
 * `job-restoration.ts`'s (c) fix independently fails closed on ANY
 * `item_id`/`config.itemId` disagreement, so a row this function ever leaves
 * mismatched (there should be none) is still caught before takeover/respawn.
 *
 * The loser process's resident in-memory job keeps running until its own
 * stop/inactivity reaper finds it; if it persists again later (e.g. a seek
 * promotion) it replaces the row right back to describing ITS job — each
 * write leaves a self-consistent row (last writer wins). `updateStatus` /
 * `updateProgress` / `updateLastAccessed` / `updateLastProgress` are keyed by
 * `play_session_id` alone (no `item_id` or `job_id` guard), so a loser's stray
 * write after losing the race CAN still land on the winner's row. None of those functions touch `item_id` or
 * `config`, so the item->job BINDING is never corrupted — but `updateStatus`
 * is NOT merely cosmetic: it is the loser's OWN writer for its own job's
 * stopped/error terminal state, and per-pod own-job callers now pass
 * `ownerPodName` (see that function's doc comment) so the write is refused
 * once the row belongs to another pod, rather than marking the winner's
 * still-live job stopped/error out from under it. The own-job
 * `updateProgress` / `updateLastAccessed` / `updateLastProgress` writes take
 * the same `ownerPodName` guard (2026-09-27): a loser's readiness numbers
 * misled the cross-pod fallback, and its freshness stamps kept a dead
 * owner's row from ever going stale enough to take over.
 * No unguarded session-keyed writer is left: the former `updateSeekState` /
 * `updateResourceUsage` (no callers, no pod guard, and the seek one rewrote
 * `config` + `status`) were removed rather than left for a future caller to
 * revive on a pod that had lost the session.
 *
 * The `user_id` guard is defence in depth on top of (d) (the master route's
 * new `PlaySessionId` ownership check): ownership already gates who can
 * start a job under a given session id, so a cross-user conflict here should
 * not occur in practice, but refusing it at the write itself means this
 * function's own contract holds even if a caller upstream ever regresses.
 */
/**
 * Outcome of {@link upsertJob}: `'refused'` — the conflicting row belongs to
 * another user and was left untouched; `'written'` — the row was written and
 * linked to its play session; `'written-unlinked'` — the row was written but
 * the `play_sessions` row with this id belongs to another user, so the link
 * was skipped (a signal the caller should log: ownership is checked before a
 * start, so this should not happen).
 */
export type UpsertJobResult = 'written' | 'written-unlinked' | 'refused';

export async function upsertJob(
    sql: postgres.Sql,
    job: TranscodeJobInsert,
): Promise<UpsertJobResult> {
    const ensurePlaySession = job.ensure_play_session !== false;

    // Ensure play_sessions record exists. A play session isn't guaranteed to exist
    // yet when a transcode job is created, so create a minimal record; the
    // play-session-reporter merges full data via ON CONFLICT DO UPDATE. (No FK
    // requires it since mig 16.282.0 — a /j PlaySessionId has no row of its own.)
    if (ensurePlaySession) {
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
            ON CONFLICT (id) DO NOTHING
        `;
    }

    const written = await sql`
        INSERT INTO active_transcode_jobs (
            play_session_id,
            job_id,
            item_id,
            user_id,
            device_id,
            config,
            output_dir,
            status,
            mode,
            segment_offset,
            segments_ready,
            master_playlist_ready,
            pod_name,
            ffmpeg_pid,
            created_at,
            last_accessed_at,
            last_progress_at,
            transcode_decision,
            can_restore
        ) VALUES (
            ${job.play_session_id},
            ${job.job_id},
            ${job.item_id},
            ${job.user_id},
            ${job.device_id},
            ${sql.json(job.config as postgres.JSONValue)},
            ${job.output_dir},
            ${job.status},
            ${job.mode},
            ${job.segment_offset},
            ${job.segments_ready},
            ${job.master_playlist_ready},
            ${job.pod_name},
            ${job.ffmpeg_pid},
            ${job.created_at},
            ${job.last_accessed_at},
            ${job.last_progress_at},
            ${job.transcode_decision ? sql.json(job.transcode_decision as postgres.JSONValue) : null},
            ${job.can_restore}
        )
        ON CONFLICT (play_session_id) DO UPDATE SET
            -- Item changed (or this is a respelling of it): fully replace,
            -- see the doc comment above. Same item: keep the prior value —
            -- these columns were never part of the pre-fix partial update.
            item_id = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN EXCLUDED.item_id ELSE active_transcode_jobs.item_id END,
            job_id = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN EXCLUDED.job_id ELSE active_transcode_jobs.job_id END,
            output_dir = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN EXCLUDED.output_dir ELSE active_transcode_jobs.output_dir END,
            device_id = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN EXCLUDED.device_id ELSE active_transcode_jobs.device_id END,
            mode = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN EXCLUDED.mode ELSE active_transcode_jobs.mode END,
            segments_ready = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN EXCLUDED.segments_ready ELSE active_transcode_jobs.segments_ready END,
            master_playlist_ready = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN EXCLUDED.master_playlist_ready ELSE active_transcode_jobs.master_playlist_ready END,
            created_at = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN EXCLUDED.created_at ELSE active_transcode_jobs.created_at END,
            transcode_decision = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN EXCLUDED.transcode_decision ELSE active_transcode_jobs.transcode_decision END,
            can_restore = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN EXCLUDED.can_restore ELSE active_transcode_jobs.can_restore END,
            -- Reset on a full replace: a stale error/stop/resource-usage from
            -- the FIRST job must not be read as describing the SECOND one.
            error_message = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN NULL ELSE active_transcode_jobs.error_message END,
            stopped_at = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN NULL ELSE active_transcode_jobs.stopped_at END,
            cpu_percent = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN NULL ELSE active_transcode_jobs.cpu_percent END,
            memory_mb = CASE WHEN active_transcode_jobs.item_id IS DISTINCT FROM EXCLUDED.item_id
                THEN NULL ELSE active_transcode_jobs.memory_mb END,
            -- Unconditional every write, same as before the fix.
            status = EXCLUDED.status,
            config = EXCLUDED.config,
            segment_offset = EXCLUDED.segment_offset,
            pod_name = EXCLUDED.pod_name,
            ffmpeg_pid = EXCLUDED.ffmpeg_pid,
            last_accessed_at = EXCLUDED.last_accessed_at,
            last_progress_at = EXCLUDED.last_progress_at
        WHERE active_transcode_jobs.user_id = EXCLUDED.user_id
        RETURNING play_session_id
    `;

    if (written.length === 0) {
        // Conflicting row belongs to a different user — refused. Do NOT link
        // it to this job's play session either (see below); the row is left
        // exactly as it was.
        return 'refused';
    }
    if (!ensurePlaySession) return 'written';

    // Link the transcode job to the play session — only for the user who
    // actually owns it, matching the WHERE guard above so a refused write
    // can never re-point another user's play_sessions row at this job.
    const linked = await sql`
        UPDATE play_sessions
        SET transcode_job_id = ${job.job_id}
        WHERE id = ${job.play_session_id}
          AND user_id = ${job.user_id}
        RETURNING id
    `;

    return linked.length > 0 ? 'written' : 'written-unlinked';
}

/**
 * Insert an active transcode job row, with no upsert / FK plumbing.
 *
 * Use this when the caller has already ensured a matching `play_sessions` row
 * exists. For the legacy video-transcode HLS flow that also bootstraps a
 * `play_sessions` stub, use {@link upsertJob} instead.
 *
 * Music transcode service uses this — Subsonic / API flows create the
 * play_sessions row up-front, so we only need to record the job here.
 */
export async function insertActiveTranscodeJob(
    sql: postgres.Sql,
    job: TranscodeJobInsert,
): Promise<void> {
    // ON CONFLICT upsert because the music-transcode flow keys play_sessions by
    // (source, "userId:trackId"); two concurrent streams of the same track by the
    // same user resolve to the same play_session_id and would otherwise hit the
    // UNIQUE(play_session_id) constraint on active_transcode_jobs. Re-attaching
    // a stream to an existing row replaces the prior job metadata so the second
    // stream is the one visible to admin/sessions.
    await sql`
        INSERT INTO active_transcode_jobs (
            play_session_id,
            job_id,
            item_id,
            user_id,
            device_id,
            config,
            output_dir,
            status,
            mode,
            segment_offset,
            segments_ready,
            master_playlist_ready,
            pod_name,
            ffmpeg_pid,
            created_at,
            last_accessed_at,
            last_progress_at,
            transcode_decision,
            can_restore
        ) VALUES (
            ${job.play_session_id},
            ${job.job_id},
            ${job.item_id},
            ${job.user_id},
            ${job.device_id},
            ${sql.json(job.config as postgres.JSONValue)},
            ${job.output_dir},
            ${job.status},
            ${job.mode},
            ${job.segment_offset},
            ${job.segments_ready},
            ${job.master_playlist_ready},
            ${job.pod_name},
            ${job.ffmpeg_pid},
            ${job.created_at},
            ${job.last_accessed_at},
            ${job.last_progress_at},
            ${job.transcode_decision ? sql.json(job.transcode_decision as postgres.JSONValue) : null},
            ${job.can_restore}
        )
        ON CONFLICT (play_session_id) DO UPDATE SET
            job_id = EXCLUDED.job_id,
            config = EXCLUDED.config,
            status = EXCLUDED.status,
            ffmpeg_pid = EXCLUDED.ffmpeg_pid,
            last_accessed_at = EXCLUDED.last_accessed_at,
            last_progress_at = EXCLUDED.last_progress_at,
            stopped_at = NULL,
            error_message = NULL
    `;
}

/**
 * Patch a subset of mutable columns on an active transcode job.
 *
 * Only `status`, `stopped_at`, `ffmpeg_pid`, and `error_message` are exposed
 * — the music-transcode service uses this to flip status to
 * `stopped` / `error` and stamp `stopped_at` on stream termination.
 *
 * Returns the number of rows updated (0 if the session was already cleaned up).
 */
export async function updateTranscodeJobStatus(
    sql: postgres.Sql,
    playSessionId: string,
    patch: {
        status?: string;
        stopped_at?: Date | null;
        ffmpeg_pid?: number | null;
        error_message?: string | null;
        /**
         * Only write if the row still belongs to THIS job.
         *
         * The row's key is `play_session_id`, but one session can produce a series
         * of jobs — the audiobook remux restarts its encoder on every seek, and the
         * new stream's row is written while the old ffmpeg is still dying. Without
         * this guard the OLD process's terminal update lands on the NEW stream's
         * row and the admin surface shows `stopped` over live audio.
         *
         * Omit for the single-job-per-session callers (video, music).
         */
        expected_job_id?: string;
    },
): Promise<number> {
    const hasStatus = patch.status !== undefined;
    const hasStoppedAt = patch.stopped_at !== undefined;
    const hasPid = patch.ffmpeg_pid !== undefined;
    const hasError = patch.error_message !== undefined;

    if (!hasStatus && !hasStoppedAt && !hasPid && !hasError) {
        return 0;
    }

    const expectedJobId = patch.expected_job_id;
    const result = await sql`
        UPDATE active_transcode_jobs
        SET
            status = ${hasStatus ? patch.status! : sql`status`},
            stopped_at = ${hasStoppedAt ? (patch.stopped_at ?? null) : sql`stopped_at`},
            ffmpeg_pid = ${hasPid ? (patch.ffmpeg_pid ?? null) : sql`ffmpeg_pid`},
            error_message = ${hasError ? (patch.error_message ?? null) : sql`error_message`}
        WHERE play_session_id = ${playSessionId}
          ${expectedJobId !== undefined ? sql`AND job_id = ${expectedJobId}` : sql``}
    `;
    return result.count;
}

/**
 * `AND` clause for a pod's writes to its OWN job's row: refused once another
 * pod owns the row (unowned rows stay writable). `undefined` = unguarded, for
 * deliberate cross-pod writers. See `updateStatus`'s doc comment.
 */
function ownerPodGuard(sql: postgres.Sql, ownerPodName: string | null | undefined) {
    return ownerPodName === undefined
        ? sql``
        : sql`AND (pod_name IS NULL OR pod_name = ${ownerPodName})`;
}

/**
 * Update the last accessed timestamp for a job.
 * Also updates last_progress_at for external HLS clients.
 *
 * `ownerPodName`: pass it from a pod stamping its own resident job, so a pod
 * that lost the session stops refreshing the new owner's row (which would keep
 * a dead owner's row from ever going stale enough to take over). Omit it when
 * serving another pod's persisted segments from disk, which refreshes that row
 * on purpose.
 */
export async function updateLastAccessed(
    sql: postgres.Sql,
    playSessionId: string,
    ownerPodName?: string | null,
): Promise<void> {
    await sql`
        UPDATE active_transcode_jobs
        SET last_accessed_at = NOW(),
            last_progress_at = NOW()
        WHERE play_session_id = ${playSessionId}
          ${ownerPodGuard(sql, ownerPodName)}
    `;
}

/**
 * Update the last progress timestamp for a job. `ownerPodName` as in
 * `updateLastAccessed`. `ownerUsername`, when given, must be the job's owner
 * (`config.username`): a heartbeat from another user must not keep it alive.
 */
export async function updateLastProgress(
    sql: postgres.Sql,
    playSessionId: string,
    ownerPodName?: string | null,
    ownerUsername?: string,
): Promise<void> {
    await sql`
        UPDATE active_transcode_jobs
        SET last_progress_at = NOW()
        WHERE play_session_id = ${playSessionId}
          -- A heartbeat must not make a stopped/dormant row (or one whose owner
          -- died) look live to the orphan sweep and the live-transcode count.
          AND status IN (${JobStatus.Starting}, ${JobStatus.Running}, ${JobStatus.Ready})
          ${ownerPodGuard(sql, ownerPodName)}
          ${ownerUsername !== undefined ? sql`AND config->>'username' = ${ownerUsername}` : sql``}
    `;
}

/**
 * Update job status with optional error message and canRestore flag.
 *
 * Returns the number of rows updated (0 if the session was already cleaned
 * up, OR — see `ownerPodName` — if a conflicting row belongs to another pod).
 *
 * ## D-HLS-1 follow-up (security runtime pass 2026-09-26, fix (b) interaction)
 *
 * A process that LOST the cross-process/case-variant race `upsertJob`'s fix
 * (b) resolves still keeps its own resident job running until its own
 * stop/error/inactivity path fires — and every one of those paths eventually
 * calls this function keyed by `play_session_id` alone, same as before (b).
 * Without a guard, that write lands on the WINNER's live row (same
 * `play_session_id`, now owned by a different pod for a different item) and
 * marks it `stopped`/`error`: the winner's OWN pod then sees its live job as
 * DB-`stopped` and tears it down, and — worse — `claimJobForRestoration`
 * accepts a `stopped` row regardless of `pod_name`, so a later request can
 * claim it and respawn a SECOND FFmpeg for the winner's item into the
 * winner's `output_dir`. This is not cosmetic: it is the loser's job
 * identity landing on the winner's row.
 *
 * `ownerPodName`, passed by the loser's OWN writers, refuses the write when
 * the row is no longer owned by this pod — same idiom as `deleteJob`'s
 * `ownerPodName` guard (unowned rows, `pod_name IS NULL`, stay always
 * writable; omit the argument entirely for the deliberate cross-pod writer
 * in `stopJob`'s not-in-memory branch and any other caller that intends to
 * write another pod's row on purpose).
 */
export async function updateStatus(
    sql: postgres.Sql,
    params: {
        playSessionId: string;
        status: string;
        error?: string;
        canRestore?: boolean;
        /** See the doc comment above — omit to write unconditionally. */
        ownerPodName?: string | null;
    },
): Promise<number> {
    const { playSessionId, status, error, canRestore, ownerPodName } = params;
    const podGuard = ownerPodGuard(sql, ownerPodName);

    if (canRestore !== undefined && status === JobStatus.Stopped) {
        const result = await sql`
            UPDATE active_transcode_jobs
            SET status = ${status},
                error_message = ${error || null},
                stopped_at = CASE WHEN ${status} IN (${JobStatus.Stopped}, ${JobStatus.Error}) THEN NOW() ELSE stopped_at END,
                last_accessed_at = CASE WHEN ${status} = ${JobStatus.Stopped} THEN NOW() ELSE last_accessed_at END,
                can_restore = ${canRestore}
            WHERE play_session_id = ${playSessionId}
              ${podGuard}
        `;
        return result.count;
    } else {
        const result = await sql`
            UPDATE active_transcode_jobs
            SET status = ${status},
                error_message = ${error || null},
                stopped_at = CASE WHEN ${status} IN (${JobStatus.Stopped}, ${JobStatus.Error}) THEN NOW() ELSE stopped_at END,
                last_accessed_at = CASE WHEN ${status} = ${JobStatus.Stopped} THEN NOW() ELSE last_accessed_at END
            WHERE play_session_id = ${playSessionId}
              ${podGuard}
        `;
        return result.count;
    }
}

/**
 * Update job progress (segments ready, master playlist ready).
 * `ownerPodName`: pass it for a pod's own job, so a pod that lost the session
 * cannot overwrite the new owner's readiness (the cross-pod fallback reads it).
 */
export async function updateProgress(
    sql: postgres.Sql,
    params: {
        playSessionId: string;
        segmentsReady: number;
        masterReady: boolean;
        ownerPodName?: string | null;
    },
): Promise<void> {
    await sql`
        UPDATE active_transcode_jobs
        SET segments_ready = ${params.segmentsReady},
            master_playlist_ready = ${params.masterReady}
        WHERE play_session_id = ${params.playSessionId}
          ${ownerPodGuard(sql, params.ownerPodName)}
    `;
}

/**
 * Delete a job from the database.
 */
/**
 * Delete a job row.
 *
 * `ownerPodName` makes the delete OWNERSHIP-GUARDED, which matters because a
 * session can legitimately migrate between pods mid-life: a rolling recreate
 * hands it to a peer, and sticky hashing can hand it back later. A pod that has
 * since lost the session must not delete the current owner's row — that is the
 * cross-pod poison that makes the live stream 410 with no way back (and, now
 * that the transcode dir is a shared mount, the companion directory delete is
 * destructive to the peer's on-disk segments too).
 *
 * Guarding on pod_name rather than job_id is deliberate: restoreJob reuses the
 * persisted job_id, so both pods' in-memory jobs carry the SAME id and it
 * cannot distinguish them. Rows with pod_name IS NULL are unowned and always
 * deletable. Omit the argument for genuinely global cleanup paths. Returns the
 * number of rows deleted (0 when the guard missed or no row existed).
 */
export async function deleteJob(
    sql: postgres.Sql,
    playSessionId: string,
    ownerPodName?: string | null,
): Promise<number> {
    if (ownerPodName === undefined) {
        const result = await sql`
            DELETE FROM active_transcode_jobs
            WHERE play_session_id = ${playSessionId}
        `;
        return result.count;
    }
    const result = await sql`
        DELETE FROM active_transcode_jobs
        WHERE play_session_id = ${playSessionId}
          AND (pod_name IS NULL OR pod_name = ${ownerPodName})
    `;
    return result.count;
}

/**
 * Cleanup expired jobs based on inactivity and progress timeouts.
 * Returns the deleted jobs (including output_dir for cleanup).
 */
export async function cleanupExpiredJobs(
    sql: postgres.Sql,
    params: {
        inactivityTtl: number;
        progressTtl: number;
    },
): Promise<CleanedUpJobRow[]> {
    const { inactivityTtl, progressTtl } = params;

    return await sql<CleanedUpJobRow[]>`
        WITH dormant_hls_jobs AS (
            -- A row with can_restore=true belongs to the resumable HLS flow.
            -- If its owner disappeared, preserve its metadata for the dormant
            -- recovery window instead of deleting it from a different pod.
            UPDATE active_transcode_jobs
            SET status = ${JobStatus.Stopped},
                stopped_at = NOW(),
                last_accessed_at = NOW()
            WHERE status IN (${JobStatus.Starting}, ${JobStatus.Running}, ${JobStatus.Ready})
              AND can_restore = true
              AND last_accessed_at < NOW() - INTERVAL '1 second' * ${inactivityTtl}
              AND last_progress_at < NOW() - INTERVAL '1 second' * ${progressTtl}
        )
        DELETE FROM active_transcode_jobs
        WHERE
            -- Running/starting/ready jobs: Need BOTH segment requests AND progress heartbeats
            -- inactivityTtl governs segment access (client still requesting data)
            -- progressTtl governs FFmpeg progress (encoder still producing output)
            (status IN (${JobStatus.Starting}, ${JobStatus.Running}, ${JobStatus.Ready})
             AND can_restore = false
             AND last_accessed_at < NOW() - INTERVAL '1 second' * ${inactivityTtl}
             AND last_progress_at < NOW() - INTERVAL '1 second' * ${progressTtl})
            OR
            -- A stop interrupted by a pod crash must not keep a stopping row forever.
            (status = ${JobStatus.Stopping}
             AND last_accessed_at < NOW() - INTERVAL '1 second' * ${inactivityTtl}
             AND last_progress_at < NOW() - INTERVAL '1 second' * ${progressTtl})
            OR
            -- Error jobs: 5 min grace period based on segment access
            (status = ${JobStatus.Error}
             AND last_accessed_at < NOW() - INTERVAL '1 second' * ${ERROR_JOB_TTL})
            OR
            -- Stopped jobs: retain metadata for 60 min so a later segment
            -- request can recreate the stream without a 410.
            (status = ${JobStatus.Stopped}
             AND last_accessed_at < NOW() - INTERVAL '1 second' * ${STOPPED_JOB_TTL})
        RETURNING play_session_id, job_id, status, pod_name, output_dir
    `;
}

/** Boot-time retirement, fenced against replacement or fresh client activity. */
export async function retireOrphanedJob(
    sql: postgres.Sql,
    playSessionId: string,
    jobId: string,
    cutoff: Date,
): Promise<boolean> {
    const rows = await sql`
        WITH dormant AS (
            UPDATE active_transcode_jobs
            SET status = ${JobStatus.Stopped}, stopped_at = NOW(), last_accessed_at = NOW()
            WHERE play_session_id = ${playSessionId} AND job_id = ${jobId}
              AND can_restore = true
              AND status IN (${JobStatus.Starting}, ${JobStatus.Running}, ${JobStatus.Ready})
              AND created_at < ${cutoff} AND last_progress_at < ${cutoff} AND last_accessed_at < ${cutoff}
            RETURNING play_session_id
        ), removed AS (
            DELETE FROM active_transcode_jobs
            WHERE play_session_id = ${playSessionId} AND job_id = ${jobId}
              AND ((can_restore = false AND status IN (${JobStatus.Starting}, ${JobStatus.Running}, ${JobStatus.Ready}))
                   OR status = ${JobStatus.Stopping})
              AND created_at < ${cutoff} AND last_progress_at < ${cutoff} AND last_accessed_at < ${cutoff}
            RETURNING play_session_id
        )
        SELECT play_session_id FROM dormant UNION ALL SELECT play_session_id FROM removed
    `;
    return rows.length > 0;
}

/**
 * Take ownership of a job whose owner has stopped serving it, WITHOUT touching
 * its status or spawning anything.
 *
 * Needed because serving a segment from disk calls updateLastAccessed(), which
 * refreshes the very `last_accessed_at` that both the 503 "owner is still
 * serving" defer and claimJobForRestoration's staleness guard read. After a
 * HARD owner death (crash/OOM — the row stays `running`, so the graceful
 * `stopped` shortcut does not apply) with segments already on disk, the peer
 * would serve one segment, stamp NOW, then 503 every request for the next 15s,
 * serve one more, and so on: playback drops to roughly one segment per 15s
 * against 4-6s segments, so the buffer drains and the stream stalls anyway.
 *
 * Flipping pod_name to the pod that is actually receiving the requests makes
 * the defer branch stop applying (it only defers when pod_name !== self), so
 * the disk-serve path can run at full speed. Status is deliberately left alone:
 * no FFmpeg is being started here, and claiming as 'starting' would misreport a
 * job that is merely being read off disk.
 *
 * Atomic via the same 15s staleness guard, so two peers cannot both take over.
 */
export async function takeOverStaleJob(
    sql: postgres.Sql,
    params: {
        playSessionId: string;
        podName: string;
    },
): Promise<boolean> {
    const result = await sql`
        UPDATE active_transcode_jobs
        SET pod_name = ${params.podName},
            last_accessed_at = NOW()
        WHERE play_session_id = ${params.playSessionId}
          AND status != ${JobStatus.Error}
          AND (pod_name IS NULL OR pod_name = ${params.podName}
               OR last_accessed_at < NOW() - INTERVAL '15 seconds')
        RETURNING play_session_id
    `;
    return result.length > 0;
}

/**
 * Attempt to claim a job for restoration by a pod.
 * Uses optimistic locking to prevent multiple pods from restoring the same job.
 */
export async function claimJobForRestoration(
    sql: postgres.Sql,
    params: {
        playSessionId: string;
        podName: string;
        /** The `item_id` the caller validated the row against. When given, the
         *  claim only wins if the row still names that item: restore validates
         *  a snapshot and then claims, and another process's `upsertJob` can
         *  fully replace the row for a different item in between — the claim
         *  must not then respawn the stale snapshot over the new owner's row. */
        expectedItemId?: string;
    },
): Promise<boolean> {
    const result = await sql`
        UPDATE active_transcode_jobs
        SET pod_name = ${params.podName},
            status = ${JobStatus.Starting},
            last_accessed_at = NOW()
        WHERE play_session_id = ${params.playSessionId}
          ${params.expectedItemId !== undefined ? sql`AND item_id = ${params.expectedItemId}` : sql``}
          AND can_restore = TRUE
          AND status != ${JobStatus.Error}
          -- Claimable when unowned, already ours, stopped, OR the owner has gone stale
          -- (>15s without serving a segment) — a rolling recreate can leave a session's
          -- owner != its sticky-hash target, so the peer that now receives its requests
          -- must be able to take over. The 15s window MUST match OWNER_SERVING_STALE_MS in
          -- job-restoration.ts. Setting pod_name+last_accessed_at=NOW() makes the claim
          -- atomic (a second racing pod sees it fresh again and backs off).
          AND (pod_name IS NULL OR pod_name = ${params.podName} OR status = ${JobStatus.Stopped}
               OR last_accessed_at < NOW() - INTERVAL '15 seconds')
        RETURNING play_session_id
    `;
    return result.length > 0;
}

/**
 * Mark all jobs for a specific pod as stopped.
 * Used during graceful shutdown in Kubernetes.
 */
export async function markPodJobsAsStopped(
    sql: postgres.Sql,
    params: {
        podName: string;
        reason: string;
    },
): Promise<{ play_session_id: string; job_id: string }[]> {
    return await sql<{ play_session_id: string; job_id: string }[]>`
        UPDATE active_transcode_jobs
        SET status = ${JobStatus.Stopped},
            error_message = ${params.reason},
            stopped_at = NOW()
        WHERE pod_name = ${params.podName}
          AND status NOT IN (${JobStatus.Stopped}, ${JobStatus.Error})
        RETURNING play_session_id, job_id
    `;
}
