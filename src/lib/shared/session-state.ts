// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure session-state derivation for the admin Active Sessions panel.
 *
 * Folds an `AdminPlaySession` + its attached `FFmpegJobInfo` jobs into three
 * orthogonal axes (health, method, resource) plus a severity derived from
 * health only. This module is intentionally side-effect free and framework
 * agnostic — it is safe to consume from both client and server code, and
 * from component tests.
 */

import type { AdminPlaySession } from '$lib/schemas/api-admin-responses';
import type { FFmpegJobInfo } from '$lib/types/admin-metrics';

/**
 * Playback health — how the session is actually running right now.
 * Order of derivation is priority-ordered (first match wins): errored >
 * paused > stalled > low_buffer > playing.
 */
export type Health =
    | { kind: 'playing' }
    | { kind: 'paused' }
    | { kind: 'low_buffer'; seconds: number }
    | { kind: 'stalled'; since: number }
    | { kind: 'errored'; reason: string };

/**
 * Delivery method — what the pipeline is doing with the source.
 * `plan_mode` wins over `playMethod` when both are present, with ONE exception:
 * `playMethod === 'audio_only'` wins over any plan_mode, because the audio-only
 * rung has no plan_mode of its own (see `deriveMethod`). `starting` and
 * `completing` are transitional states only considered when no plan mode
 * is set.
 */
export type Method =
    | { kind: 'direct' }
    | { kind: 'remux' }
    | { kind: 'audio_transcode' }
    | { kind: 'full_transcode'; reason?: string }
    | { kind: 'audio_only' }
    | { kind: 'starting' }
    | { kind: 'completing' };

/**
 * Resource footprint of the session's FFmpeg jobs.
 * `cpuPercent` / `memoryMB` are intentionally left blank here — they are
 * populated by the panel from SystemMetrics aggregates.
 */
export interface Resource {
    jobCount: number;
    runningJobs: number;
    cpuPercent?: number;
    memoryMB?: number;
}

/** Severity rollup — drives border/accent color. Health is the only input. */
export type Severity = 'healthy' | 'degraded' | 'error';

export interface SessionState {
    health: Health;
    method: Method;
    resource: Resource;
    severity: Severity;
}

const STALL_THRESHOLD_SECONDS = 30;
const LOW_BUFFER_THRESHOLD_SECONDS = 2;

function deriveHealth(session: AdminPlaySession, jobs: FFmpegJobInfo[]): Health {
    // 1. Errored job (truthy `error` or `status === 'error'`).
    const erroredJob = jobs.find((j) => Boolean(j.error) || j.status === 'error');
    if (erroredJob) {
        return {
            kind: 'errored',
            reason: erroredJob.error ?? 'ffmpeg job errored',
        };
    }

    // 2. Paused (explicit).
    if (session.playIsPlaying === false) {
        return { kind: 'paused' };
    }

    // 3. Stalled — a running job whose progress stopped, and not in
    //    readiness-wait mode.
    const stalledJobs = jobs.filter(
        (j) =>
            j.lastProgressSecondsAgo > STALL_THRESHOLD_SECONDS &&
            j.processRunning === true &&
            j.status !== 'ready',
    );
    if (stalledJobs.length > 0) {
        const maxAge = stalledJobs.reduce((acc, j) => Math.max(acc, j.lastProgressSecondsAgo), 0);
        return { kind: 'stalled', since: maxAge };
    }

    // 4. Low buffer.
    if (
        session.buffer_health_sec != null &&
        session.buffer_health_sec < LOW_BUFFER_THRESHOLD_SECONDS
    ) {
        return { kind: 'low_buffer', seconds: session.buffer_health_sec };
    }

    // 5. Playing.
    return { kind: 'playing' };
}

function deriveMethod(session: AdminPlaySession, jobs: FFmpegJobInfo[]): Method {
    const planMode = session.plan_mode ?? undefined;
    const playMethod = session.playMethod;

    // 1. Audio-only rung (video dropped, `-vn`) — playMethod ONLY, and it wins
    // over plan_mode. This is the one method plan_mode cannot express: the rung
    // is a client-side quality selection that reuses whatever plan the other
    // methods were built from, so plan_mode still reads 'remux'/'full_transcode'
    // /'direct'. Checked first, or an audio-only session on a transcode-needing
    // source would be reported as a full transcode of video it never encodes.
    if (playMethod === 'audio_only') {
        return { kind: 'audio_only' };
    }

    // 2. Full transcode — plan_mode or playMethod='transcode'.
    if (planMode === 'full_transcode' || playMethod === 'transcode') {
        return {
            kind: 'full_transcode',
            reason: session.plan_reasons?.[0],
        };
    }

    // 3. Audio-only transcode — plan_mode only.
    if (planMode === 'audio_transcode') {
        return { kind: 'audio_transcode' };
    }

    // 4. Remux — plan_mode or playMethod='remux'.
    if (planMode === 'remux' || playMethod === 'remux') {
        return { kind: 'remux' };
    }

    // 5/6. Transitional states — only when no plan_mode was set.
    if (!planMode) {
        if (jobs.some((j) => j.progressPercent >= 100)) {
            return { kind: 'completing' };
        }
        if (jobs.some((j) => j.progressPercent < 1 && j.processRunning)) {
            return { kind: 'starting' };
        }
    }

    // 7. Direct play — fallthrough.
    return { kind: 'direct' };
}

function deriveResource(jobs: FFmpegJobInfo[]): Resource {
    return {
        jobCount: jobs.length,
        runningJobs: jobs.filter((j) => j.processRunning === true).length,
    };
}

function deriveSeverity(health: Health): Severity {
    switch (health.kind) {
        case 'errored':
            return 'error';
        case 'paused':
        case 'stalled':
        case 'low_buffer':
            return 'degraded';
        case 'playing':
            return 'healthy';
    }
}

/**
 * Fold a session + its attached jobs into a single `SessionState` record.
 * Pure function — same inputs always yield the same output.
 */
export function deriveSessionState(session: AdminPlaySession, jobs: FFmpegJobInfo[]): SessionState {
    const health = deriveHealth(session, jobs);
    const method = deriveMethod(session, jobs);
    const resource = deriveResource(jobs);
    const severity = deriveSeverity(health);
    return { health, method, resource, severity };
}

/**
 * What the delivery pipeline is doing for a session, beyond its method:
 * the numbers an operator reads to tell whether a transcode can keep up.
 * Every field is optional — a direct-play session has no job, and a job
 * that has only just started has no meaningful rate yet.
 */
export interface Delivery {
    /** Seconds of output already encoded ahead of the playhead. */
    headroomSec?: number;
    /** Media seconds encoded per wall-clock second since the job started (1 = realtime). */
    encodeSpeed?: number;
    /** Hardware encoder name ("h264_qsv", …) when the job uses the GPU, else 'CPU'. */
    encoder?: string;
    /** Codec the job writes ("h264", "hevc", …). */
    outputCodec?: string;
    cpuPercent?: number;
    gpuPercent?: number;
    /** The server flagged the encode as unable to keep up (see slow-transcode.ts). */
    slowReason?: 'gpu_busy' | 'cpu_slow';
    /** GPU encoder the job fell back from to software (no free encode session). */
    softwareFallbackFrom?: string;
}

/** Below this much ready-ahead output a playing transcode is about to stall. */
export const LOW_HEADROOM_SECONDS = 10;
/**
 * A slow encode with less than this much ready ahead counts as struggling.
 * Same figure as the player's SLOW_NOTICE_MAX_AHEAD_SECONDS.
 */
export const SLOW_HEADROOM_SECONDS = 120;
/** A job younger than this has not produced a rate worth showing. */
const MIN_ELAPSED_FOR_SPEED_SECONDS = 5;

/** The job serving playback now: the running one, most recently started. */
function primaryJob(jobs: FFmpegJobInfo[]): FFmpegJobInfo | undefined {
    const running = jobs.filter((j) => j.processRunning);
    const pool = running.length > 0 ? running : jobs;
    return [...pool].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
}

/**
 * Fold a session's FFmpeg job into the numbers the Delivery column shows.
 * Segment counts become seconds with the job's own `segmentDurationSeconds`,
 * falling back to `segmentDurationSec` (the ffmpeg-jobs response config);
 * without either the time-based figures (headroom, speed) are left undefined
 * rather than guessed.
 */
export function deriveDelivery(
    session: AdminPlaySession,
    jobs: FFmpegJobInfo[],
    segmentDurationSec: number | undefined,
): Delivery {
    const job = primaryJob(jobs);
    if (!job) return {};
    const decision = job.transcodeDecision;
    const delivery: Delivery = {
        // A cross-pod row's decision predates a software fallback.
        encoder:
            decision?.useGpu && !job.softwareFallbackFrom ? (decision.gpuEncoder ?? 'GPU') : 'CPU',
        outputCodec: job.videoOutputCodec,
        cpuPercent: job.cpuPercent,
        gpuPercent: job.gpuVideoPercent,
        slowReason: job.slowReason,
        softwareFallbackFrom: job.softwareFallbackFrom,
    };
    // The job's own segment length wins: copy-mode jobs run on 10 s segments,
    // and the global 6 s made a healthy remux read as "nothing encoded ahead".
    const segmentSec = job.segmentDurationSeconds ?? segmentDurationSec;
    if (segmentSec && segmentSec > 0) {
        const encodedUntil = (job.segmentOffset + job.segmentsReady) * segmentSec;
        if (session.playCurrentTime != null) {
            delivery.headroomSec = Math.max(0, encodedUntil - session.playCurrentTime);
        }
        if (job.elapsedSeconds >= MIN_ELAPSED_FOR_SPEED_SECONDS && job.segmentsReady > 0) {
            delivery.encodeSpeed = (job.segmentsReady * segmentSec) / job.elapsedSeconds;
        }
    }
    return delivery;
}

/**
 * Whether a session needs the operator's eye right now. Deliberately NOT
 * `severity !== 'healthy'`: severity counts a pause as degraded, and a
 * glance surface that turns amber every time someone pauses is noise.
 * A playing transcode whose finished output is about to run out counts,
 * unless the job has already encoded to the end of the file.
 */
export function isStruggling(
    state: SessionState,
    delivery: Delivery,
    jobs: FFmpegJobInfo[] = [],
): boolean {
    const { health } = state;
    if (health.kind === 'errored' || health.kind === 'stalled' || health.kind === 'low_buffer') {
        return true;
    }
    if (health.kind !== 'playing') return false;
    const job = primaryJob(jobs);
    if (job && job.progressPercent >= 100) return false;
    // The encoder has been below real time for a while and less than
    // SLOW_HEADROOM_SECONDS is ready: playback will run dry. With minutes
    // already encoded ahead it will not be felt soon (the player stays quiet
    // then too).
    if (
        delivery.slowReason &&
        (delivery.headroomSec == null || delivery.headroomSec < SLOW_HEADROOM_SECONDS)
    ) {
        return true;
    }
    if (delivery.headroomSec == null) return false;
    return delivery.headroomSec < LOW_HEADROOM_SECONDS;
}

/** One session as the at-a-glance surfaces (Home tile + strip) see it. */
export interface SessionGlance {
    state: SessionState;
    delivery: Delivery;
    struggling: boolean;
    /** Any video or audio transcode, as opposed to direct play / remux. */
    transcoding: boolean;
    bandwidthMbps?: number;
}

export interface GlanceTotals {
    watching: number;
    transcoding: number;
    struggling: number;
    /** Sum of per-session delivery bandwidth, Mbps. */
    bandwidthMbps: number;
}

/**
 * Fold the admin play-sessions + ffmpeg-jobs responses into per-session
 * glance rows and totals. Same rules as the Active sessions table
 * (deriveSessionState / deriveDelivery / isStruggling), so Home and the
 * sessions page cannot disagree about who is struggling.
 */
export function glanceSessions(
    sessions: AdminPlaySession[],
    jobs: FFmpegJobInfo[],
    segmentDurationSec: number | undefined,
): { bySession: Map<string, SessionGlance>; totals: GlanceTotals } {
    const jobsBySession = new Map<string, FFmpegJobInfo[]>();
    for (const job of jobs) {
        const list = jobsBySession.get(job.playSessionId);
        if (list) list.push(job);
        else jobsBySession.set(job.playSessionId, [job]);
    }
    const bySession = new Map<string, SessionGlance>();
    const totals: GlanceTotals = { watching: 0, transcoding: 0, struggling: 0, bandwidthMbps: 0 };
    for (const session of sessions) {
        const sessionJobs = jobsBySession.get(session.__id) ?? [];
        const state = deriveSessionState(session, sessionJobs);
        const delivery = deriveDelivery(session, sessionJobs, segmentDurationSec);
        const struggling = isStruggling(state, delivery, sessionJobs);
        const transcoding =
            state.method.kind === 'full_transcode' || state.method.kind === 'audio_transcode';
        bySession.set(session.__id, {
            state,
            delivery,
            struggling,
            transcoding,
            bandwidthMbps: session.bandwidth_mbps,
        });
        totals.watching += 1;
        if (transcoding) totals.transcoding += 1;
        if (struggling) totals.struggling += 1;
        totals.bandwidthMbps += session.bandwidth_mbps ?? 0;
    }
    return { bySession, totals };
}
