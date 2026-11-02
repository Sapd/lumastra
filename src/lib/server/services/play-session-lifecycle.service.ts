// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PolicyError } from './play-sessions.service.js';
import { stopSessionTranscode } from './play-session-transcode-cleanup.js';
import { notePlaybackSession } from '../tasks/playback-pressure.js';
import { revokeGrantsForPlaySession } from './playback-grant.js';

import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types.js';
import {
    applyMusicHeartbeatLiveInfo,
    clearMusicSessionLiveInfo,
} from './music-session-live-info.js';
import { withTx, inSavepoint } from '$lib/server/database/with-tx.js';
import { getEpisodeWindowsForFile } from '$lib/server/database/queries/file-segments.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { invalidateAllWatchedCaches } from '$lib/server/services/watched-cache.service.js';
import {
    isJellyfinCompatSession,
    playedThresholdFor,
    engagementThresholdMs,
    JELLYFIN_PLAYED_THRESHOLD,
} from '$lib/server/utils/watch-constants.js';
import { playbackTelemetryService } from '$lib/server/services/playback-telemetry.service.js';
import { removePlaySessionDevice } from '$lib/server/services/play-session-device.service.js';
import type { SessionUpdateInternal } from '$lib/schemas/session-update.js';
import type {
    SessionRow,
    HeartbeatParams,
} from '$lib/server/database/queries/play-sessions.queries.js';
import type { MediaMetadataForHistory } from '$lib/server/database/queries/watch-history-insert.queries.js';
import type { CompletedSessionData } from '$lib/server/services/watch-history.service.js';
import { watchStateEvents } from '$lib/server/services/watch-state-events.service.js';
import { classifyStopReason } from '$lib/server/services/play-session-events.service.js';
import { reconcileStreamLimit } from '$lib/server/services/stream-limit-reconciler.service.js';
import { resolveEffectiveResume } from './effective-playback.js';
import type { EventAppendOutcome } from './watch-state-rebuilder.service.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { isMovie, isEpisode } from '$lib/server/utils/media-types.js';
import { publishIntegrationEvent } from '$lib/server/plugins/runtime/integration-events.js';

const logger = Logger.for('PlaySessionLifecycle');

/**
 * A heartbeat or stop within this distance of the session row's stored
 * position (and of the session's last durable progress event) counts as "the
 * playhead did not move".
 */
const IDLE_POSITION_TOLERANCE_MS = 1000;

/**
 * True when `nextPositionMs` is within {@link IDLE_POSITION_TOLERANCE_MS} of
 * the position a previous heartbeat of this session stored. A paused player
 * keeps a 30 s keepalive running (even in a hidden tab), so without this every
 * keepalive would re-stamp `user_media_state.last_event_at` and keep a
 * days-old paused episode the series' most recent activity on every device.
 *
 * `last_event_seq = 0` means no heartbeat has landed yet (fresh or revived
 * row): the stored position then came from session creation and was never
 * offered to durable state, so it never counts as unmoved.
 */
function isUnmovedPosition(session: SessionRow, nextPositionMs: number): boolean {
    if (Number(session.last_event_seq) <= 0) return false;
    const previous = Number(session.position_ms);
    if (!Number.isFinite(previous)) return false;
    return Math.abs(nextPositionMs - previous) <= IDLE_POSITION_TOLERANCE_MS;
}

/**
 * The idle gate proper: the playhead did not move ({@link isUnmovedPosition})
 * AND durable state already holds this session's position. The row's
 * position_ms is written on every heartbeat whether or not the durable write
 * that followed landed, so the row alone would make one failed write
 * (a thrown reportProgress, a rejected event) permanent: every later unmoved
 * keepalive and the stop would skip it. Only the unmoved case pays the lookup.
 */
async function isIdleAndDurable(
    sql: postgres.Sql,
    queries: SessionQueriesLike,
    session: SessionRow,
    sessionId: string,
    nextPositionMs: number,
): Promise<boolean> {
    if (!isUnmovedPosition(session, nextPositionMs)) return false;
    try {
        const durableMs = await queries.getSessionDurableProgressMs(
            sql,
            toUserId(session.user_id),
            session.media_id,
            sessionId,
        );
        return (
            durableMs !== null && Math.abs(nextPositionMs - durableMs) <= IDLE_POSITION_TOLERANCE_MS
        );
    } catch (err) {
        // Unknown durable state: write rather than risk dropping progress.
        logger.warn('Idle-gate durable lookup failed; writing progress', err as Error);
        return false;
    }
}

/**
 * Music tracks are routed to `musicInteractionManager` instead of the watch
 * state, in both `handleHeartbeat` and `handleStop`.
 *
 * Deliberately narrower than `isMusicMediaType` in
 * `media-type-cache.queries.ts`, which also accepts `'music'`: this predicate
 * decides which of two DURABLE STORES a session writes to, so widening it
 * would silently migrate a media type from `user_watch_state` to
 * `user_music_state`. Widen only with a backfill.
 */
export function isMusicSessionMediaType(mediaType: string | null | undefined): boolean {
    return mediaType === 'track' || mediaType === 'audio';
}

/**
 * Adapt a Jellyfin protocol Playing event to a durable music count. Native
 * allocation never calls this: native reports claim their first positive heard
 * time in handleMusicReport. Jellyfin has no reported heard-time accumulator.
 */
export async function reportMusicSessionStart(params: {
    userId: UserId;
    mediaId: string;
    mediaType: string | null | undefined;
    playbackSessionId: string;
}): Promise<void> {
    if (!isMusicSessionMediaType(params.mediaType)) return;
    try {
        const { musicInteractionManager } =
            await import('$lib/server/services/music-interaction-manager.service.js');
        const { aiDbService } = await import('./database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql) throw new Error('Database unavailable');
        await musicInteractionManager.reportSessionStart(
            sql,
            params.userId,
            params.mediaId,
            params.playbackSessionId,
        );
    } catch (err) {
        logger.warn('Failed to record music play-start for session', err as Error);
    }
}

// ---------------------------------------------------------------------------
// Dependency interfaces (duck-typed for testability)
// ---------------------------------------------------------------------------

export interface WatchManagerLike {
    reportProgress(
        params: {
            userId: UserId;
            mediaId: string;
            positionMs: number;
            runtimeMs?: number;
            sessionId: string;
            eventSeq: number;
            mediaType?: string;
            sessionStartedAt?: Date;
            /** Cumulative playing time in this session — drives engagement gate. */
            sessionElapsedMs?: number;
            /** Overrides the completion threshold for the primary item's auto-complete. */
            completionThreshold?: number;
        },
        txSql?: postgres.Sql,
    ): Promise<EventAppendOutcome>;
    markWatched(params: { userId: UserId; mediaId: string }, txSql?: postgres.Sql): Promise<void>;
}

export interface WatchHistoryServiceLike {
    recordCompletedSession(data: CompletedSessionData, txSql?: postgres.Sql): Promise<void>;
}

export interface SessionQueriesLike {
    updateHeartbeat(sql: postgres.Sql, id: string, params: HeartbeatParams): Promise<unknown>;
    stopSession(
        sql: postgres.Sql,
        id: string,
        position_ms: number,
        stop_reason: string,
    ): Promise<SessionRow | null>;
    getSessionById(sql: postgres.Sql, id: string): Promise<SessionRow | null>;
    /**
     * Re-read just `status` and `stop_reason` for the heartbeat backstop's
     * null-disambiguation path. Returns null when the row no longer exists
     * (rare — only when a row is hard-deleted between the failing UPDATE and
     * this SELECT).
     */
    getSessionStatusAndReason(
        sql: postgres.Sql,
        id: string,
    ): Promise<{ status: string; stop_reason: string | null } | null>;
    /** Position of the session's newest durable progress event, or null (see the idle gate). */
    getSessionDurableProgressMs(
        sql: postgres.Sql,
        userId: UserId,
        mediaId: string,
        sessionId: string,
    ): Promise<number | null>;
    /** Whether this session already wrote a live `completed` for the media. */
    sessionHasCompletion(
        sql: postgres.Sql,
        userId: UserId,
        mediaId: string,
        sessionId: string,
    ): Promise<boolean>;
}

export interface TranscodeHeartbeatLike {
    recordProgressHeartbeat(playSessionId: string, status?: 'ACTIVE' | 'PAUSED'): void;
}

export interface LifecycleDeps {
    watchManager: WatchManagerLike;
    watchHistoryService: WatchHistoryServiceLike;
    queries: SessionQueriesLike;
    getMediaMetadata: (
        sql: postgres.Sql,
        mediaId: string,
    ) => Promise<MediaMetadataForHistory | null>;
    getSql: () => postgres.Sql | null;
    transcodeService?: TranscodeHeartbeatLike;
    /**
     * Compute the freshly-recomputed resume_anchor for the heartbeat ack.
     * Optional: production wires up `resolveEffectiveResume`; tests that don't
     * exercise the resolver leave this undefined and we degrade to `null`.
     */
    resolveResumeAnchor?: (userId: UserId, mediaId: string) => Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Result of a heartbeat (status=ACTIVE|PAUSED) update. Always carries
 * `resume_anchor` and `wrote_to_durable` so the client can advance its
 * localStorage resume-cache anchor and detect engagement-gate openings.
 * The optional `action`/`reason` fields preserve the existing kill/superseded
 * branches verbatim — only the success branch changed structurally (it used
 * to be `undefined`).
 */
export type HeartbeatResult =
    | {
          policyError: PolicyError;
          resume_anchor: null;
          wrote_to_durable: false;
          sessionLost?: boolean;
      }
    | {
          action: 'kill' | 'superseded';
          reason: string;
          resume_anchor: number | null;
          wrote_to_durable: boolean;
          sessionLost?: boolean;
      }
    | { resume_anchor: number | null; wrote_to_durable: boolean; sessionLost?: boolean };

/**
 * Result of a stop (status=COMPLETED) update. Returns `undefined` on success.
 * `{ action: 'kill', reason }` (with resume-cache fields populated for shape
 * consistency with `HeartbeatResult`) is still possible if the session vanished
 * before the stop arrived. The player won't keep playing in that case, so
 * `resume_anchor` is unused, but the uniform shape avoids special-casing in
 * the route handler.
 */
export type StopResult =
    | {
          action: 'kill';
          reason: string;
          resume_anchor: number | null;
          wrote_to_durable: boolean;
          sessionLost?: boolean;
      }
    | undefined;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PlaySessionLifecycleService {
    constructor(private deps: LifecycleDeps) {}

    /**
     * Notify SSE subscribers that a new session has started.
     * Call this after successfully creating a play_sessions row.
     */
    notifySessionStarted(userId: UserId, sessionId: string, mediaId: string): void {
        watchStateEvents.emit(userId, {
            type: 'session_changed',
            sessionId,
            status: 'ACTIVE',
            mediaId,
        });
        // Plugin fan-out. Fire-and-forget: a presence or scrobbling integration
        // must never be able to delay or fail the start of playback.
        void publishIntegrationEvent({
            type: 'org.lumastra.playback.started',
            payload: { sessionId, userId: String(userId), mediaId },
        });
    }

    /**
     * Universal session update — the SOLE fan-out point for all session state changes.
     * Handles heartbeat, pause, resume, and stop via the status field.
     *
     * Heartbeat (status=ACTIVE|PAUSED): always returns `{ resume_anchor, wrote_to_durable }`,
     * with optional `action`/`reason` for kill/superseded branches and optional `transcode`
     * progress payload. The client uses `resume_anchor` to advance its localStorage cache
     * anchor and `wrote_to_durable` to detect engagement-gate openings.
     *
     * Stop (status=COMPLETED): returns `undefined` on success, or `{ action: 'kill', ... }`
     * if the session no longer exists.
     */
    async update(
        sessionId: string,
        payload: SessionUpdateInternal,
        reportingUser?: UserContext,
    ): Promise<HeartbeatResult | StopResult> {
        const sql = this.deps.getSql();
        if (!sql) return undefined;

        // Load session for context (username, mediaId, runtime)
        const session = await this.deps.queries.getSessionById(sql, sessionId);
        if (!session) {
            // Heartbeat-ack contract: every result has resume_anchor + wrote_to_durable.
            // Stop callers don't read these fields (the route only checks `action`),
            // but populating them keeps the shape uniform across the union.
            return {
                action: 'kill',
                reason: 'session_not_found',
                resume_anchor: null,
                wrote_to_durable: false,
            };
        }

        const applyClientContext = async (
            result: HeartbeatResult | StopResult,
        ): Promise<HeartbeatResult | StopResult> => {
            if (
                payload.car_play !== undefined &&
                payload.status !== 'COMPLETED' &&
                payload.event_seq > session.last_event_seq &&
                result &&
                !('action' in result) &&
                !('policyError' in result) &&
                !result.sessionLost
            ) {
                try {
                    const { recordSessionCarPlayContext } =
                        await import('../database/queries/play-session-client-context.queries.js');
                    await recordSessionCarPlayContext(
                        sql,
                        sessionId,
                        payload.event_seq,
                        payload.car_play,
                    );
                } catch (error) {
                    logger.warn('Could not record client playback context', { sessionId, error });
                }
            }
            return result;
        };

        if (session.media_type === 'radio') payload = { ...payload, position_ms: 0 };

        if (session.media_type === 'audiobook') {
            const { reportAudiobookPlaybackSession } =
                await import('./audiobook-session.service.js');
            const result = await reportAudiobookPlaybackSession({
                sql,
                playbackSessionId: sessionId,
                userId: toUserId(session.user_id),
                username: reportingUser?.username ?? session.user_id,
                report: payload,
            });
            return applyClientContext({
                resume_anchor: null,
                wrote_to_durable: result.wroteToDurable === true,
                ...(result.superseded
                    ? { action: 'superseded' as const, reason: 'superseded' }
                    : {}),
                sessionLost: !result.ok || result.sessionLost,
            });
        }

        if (isMusicSessionMediaType(session.media_type)) {
            return applyClientContext(
                await this.handleMusicReport(sql, session, sessionId, payload, reportingUser),
            );
        }

        const { status } = payload;
        notePlaybackSession(sessionId, status);

        if (status === 'COMPLETED') {
            void publishIntegrationEvent({
                type: 'org.lumastra.playback.stopped',
                payload: {
                    sessionId,
                    userId: String(session.user_id),
                    mediaId: session.media_id,
                    positionMs: payload.position_ms,
                    reason: payload.end_reason ?? undefined,
                },
            });
            return this.handleStop(sql, session, sessionId, payload);
        }

        // Pause/resume are edges, not levels: a client heartbeats every few
        // seconds, so publishing on every ACTIVE tick would drown a subscriber
        // in duplicates. Only a CHANGE of status is an event.
        if (status !== session.status) {
            if (status === 'PAUSED' || status === 'ACTIVE') {
                void publishIntegrationEvent({
                    type:
                        status === 'PAUSED'
                            ? 'org.lumastra.playback.paused'
                            : 'org.lumastra.playback.resumed',
                    payload: {
                        sessionId,
                        userId: String(session.user_id),
                        mediaId: session.media_id,
                        positionMs: payload.position_ms,
                    },
                });
            }
        }

        return applyClientContext(await this.handleHeartbeat(sql, session, sessionId, payload));
    }

    private async handleMusicReport(
        sql: postgres.Sql,
        session: SessionRow,
        sessionId: string,
        payload: SessionUpdateInternal,
        reportingUser?: UserContext,
    ): Promise<HeartbeatResult | StopResult> {
        const { musicInteractionManager } = await import('./music-interaction-manager.service.js');
        const userId = toUserId(session.user_id);
        let accepted = false;
        let promoted = false;
        let discarded = false;
        let previous: SessionRow[] = [];
        let policyError: PolicyError | undefined;
        let terminalAction: HeartbeatResult | undefined;
        await withTx(sql, async (tx) => {
            // Match allocation's lock order: user, then session. Admission, promotion,
            // ordering, heartbeat and heard-time writes commit as one report.
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;
            const rows = await tx<
                (SessionRow & { surface: string; listened_total_ms: number | null })[]
            >`
                SELECT *,
                       (external_payload ->> '__lumastra_music_listened_total_ms')::bigint AS listened_total_ms
                  FROM play_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
            const current = rows[0];
            if (!current || current.status === 'KILLED') {
                const superseded =
                    current && classifyStopReason(current.stop_reason) === 'superseded';
                terminalAction = {
                    action: superseded ? 'superseded' : 'kill',
                    reason: superseded ? 'superseded' : (current?.stop_reason ?? 'session_ended'),
                    resume_anchor: null,
                    wrote_to_durable: false,
                };
                return;
            }
            if (current.purpose === 'prefetch') {
                if (!['ACTIVE', 'PAUSED'].includes(current.status)) {
                    terminalAction = {
                        action: 'kill',
                        reason: 'session_ended',
                        resume_anchor: null,
                        wrote_to_durable: false,
                    };
                    return;
                }
                if (payload.event_seq <= Number(current.last_event_seq)) return;
                const realPlayback =
                    payload.status === 'ACTIVE' ||
                    payload.position_ms > 0 ||
                    (payload.listened_ms ?? payload.session_elapsed_ms ?? 0) > 0;
                if (!realPlayback) {
                    if (payload.status === 'COMPLETED') {
                        await this.deps.queries.stopSession(tx, sessionId, 0, 'prefetch_discarded');
                        await tx`UPDATE play_sessions SET last_event_seq = ${payload.event_seq}
                            WHERE id = ${sessionId}::uuid`;
                        await revokeGrantsForPlaySession(sessionId, tx, 'stopped');
                        discarded = true;
                    } else {
                        await this.deps.queries.updateHeartbeat(tx, sessionId, {
                            status: payload.status,
                            position_ms: 0,
                            event_seq: payload.event_seq,
                        });
                    }
                    return;
                }
                const { admitMusicPrefetchInTransaction } =
                    await import('./play-sessions.service.js');
                const admission = await admitMusicPrefetchInTransaction(tx, current);
                if (admission === 'lost') {
                    terminalAction = {
                        action: 'kill',
                        reason: 'session_ended',
                        resume_anchor: null,
                        wrote_to_durable: false,
                    };
                    return;
                }
                if (admission) {
                    policyError = admission;
                    return;
                }
                await tx`UPDATE play_sessions SET purpose = 'play' WHERE id = ${sessionId}::uuid`;
                promoted = true;
            }
            const lateCompletion =
                payload.status === 'COMPLETED' &&
                (current.status === 'CRASHED' ||
                    (current.status === 'COMPLETED' &&
                        ['track_change', 'superseded'].includes(current.stop_reason ?? '')));
            if (current.status === 'CRASHED' && payload.status === 'PAUSED') return;
            if (!lateCompletion && payload.event_seq <= Number(current.last_event_seq)) return;
            if (!lateCompletion && !['ACTIVE', 'PAUSED', 'CRASHED'].includes(current.status))
                return;
            // Position is a seekable clock, never evidence of heard audio. Keep
            // the highest reported total so a reaper or regressing final report
            // cannot erase audio already acknowledged by a live report.
            // Jellyfin has no heard-time accumulator: its position counts as heard
            // only on a completed play, never on a scrub-then-pause report.
            const positionFallback =
                current.surface === 'jellyfin_compat' &&
                payload.status === 'COMPLETED' &&
                payload.end_reason === 'completion'
                    ? payload.position_ms
                    : 0;
            const storedHeardMs = Number(current.listened_total_ms ?? 0);
            const heardMs = Math.max(
                storedHeardMs,
                payload.listened_ms ?? payload.session_elapsed_ms ?? positionFallback,
            );
            if (heardMs > 0) {
                await musicInteractionManager.reportSessionStart(
                    tx,
                    userId,
                    session.media_id,
                    sessionId,
                );
                if (heardMs > storedHeardMs)
                    await tx`UPDATE play_sessions SET external_payload = jsonb_set(COALESCE(external_payload, '{}'::jsonb), '{__lumastra_music_listened_total_ms}', to_jsonb(${heardMs}::bigint)) WHERE id = ${sessionId}::uuid`;
            }
            if (payload.status === 'COMPLETED') {
                await musicInteractionManager.reportPlayEnd(
                    userId,
                    session.media_id,
                    heardMs,
                    session.started_at,
                    Number(session.runtime_ms) > 0 ? Number(session.runtime_ms) : undefined,
                    payload.end_reason === 'skip',
                    undefined,
                    sessionId,
                    false,
                    tx,
                );
                await this.deps.queries.stopSession(
                    tx,
                    sessionId,
                    payload.position_ms,
                    payload.end_reason ?? 'user',
                );
                await tx`UPDATE play_sessions SET last_event_seq = GREATEST(last_event_seq, ${payload.event_seq}),
                    last_heartbeat_at = now(), paused_at = NULL WHERE id = ${sessionId}::uuid`;
                await revokeGrantsForPlaySession(sessionId, tx, 'stopped');
            } else {
                await this.deps.queries.updateHeartbeat(tx, sessionId, {
                    position_ms: payload.position_ms,
                    status: payload.status,
                    event_seq: payload.event_seq,
                });
            }
            if (promoted) {
                const { finishPreviousMusicRows } = await import('./play-sessions.service.js');
                previous = await finishPreviousMusicRows(tx, userId, current.device_id, sessionId);
            }
            accepted = true;
        });
        if (policyError) return { policyError, resume_anchor: null, wrote_to_durable: false };
        if (promoted) {
            const { finalizePreviousMusicSessions } = await import('./play-sessions.service.js');
            await finalizePreviousMusicSessions(sql, previous);
            this.notifySessionStarted(userId, sessionId, session.media_id);
        }
        if (discarded) {
            const { cancelMusicStreamForSession } = await import('./session-kill.service.js');
            const { notifySessionKilled } = await import('./play-session-events.service.js');
            await cancelMusicStreamForSession(sql, sessionId);
            notifySessionKilled(sessionId, 'prefetch_discarded');
            await this.cleanupAfterStop(sessionId, userId, 'prefetch_discarded', session);
            return undefined;
        }
        if (accepted) {
            if (reportingUser) {
                await applyMusicHeartbeatLiveInfo(sql, sessionId, reportingUser, {
                    status: payload.status,
                    nextTrackId: payload.next_media_id,
                    crossfade: payload.crossfade,
                });
            } else if (payload.status === 'COMPLETED') {
                await clearMusicSessionLiveInfo(sessionId);
            }
            if (payload.status === 'COMPLETED')
                await this.cleanupAfterStop(
                    sessionId,
                    userId,
                    payload.end_reason ?? payload.stop_reason ?? 'session_stop',
                    session,
                );
            else
                void reconcileStreamLimit(sql, userId).catch((err) =>
                    logger.warn('Music stream reconciliation failed', err as Error),
                );
            if (payload.status !== session.status)
                watchStateEvents.emit(userId, {
                    type: 'session_changed',
                    sessionId,
                    status: payload.status,
                    mediaId: session.media_id,
                });
        }
        if (terminalAction) return terminalAction;
        return payload.status === 'COMPLETED'
            ? undefined
            : { resume_anchor: null, wrote_to_durable: false };
    }

    private async handleHeartbeat(
        sql: postgres.Sql,
        session: SessionRow,
        sessionId: string,
        payload: SessionUpdateInternal,
    ): Promise<HeartbeatResult> {
        // play_sessions.user_id is the stable users.id UUID (mig 16.46.0) — mint
        // the brand at this trusted DB-read boundary.
        const userId = toUserId(session.user_id);
        const { media_id: mediaId } = session;
        const { position_ms, status } = payload;

        // Detect status transition before writing so we can emit session_changed if needed
        const previousStatus = session.status;

        // 1. Update play_sessions row
        // status is guaranteed to be 'ACTIVE' | 'PAUSED' here (COMPLETED is routed to handleStop)
        const updated = await this.deps.queries.updateHeartbeat(sql, sessionId, {
            position_ms,
            status: status as 'ACTIVE' | 'PAUSED',
            bitrate_kbps: payload.bitrate_kbps,
            resolution: payload.resolution,
            play_method: payload.play_method,
            audio_stream_index: payload.audio_stream_index,
            subtitle_stream_index: payload.subtitle_stream_index,
            audio_language: payload.audio_language,
            subtitle_language: payload.subtitle_language,
            subtitle_method: payload.subtitle_method,
            buffer_health_sec: payload.buffer_health_sec,
            event_seq: payload.event_seq,
        });

        if (!updated) {
            // updateHeartbeat returns null in TWO cases that look identical:
            //   1. Row not in ACTIVE/PAUSED/CRASHED — KILLED, COMPLETED, or gone
            //   2. Row still live but event_seq lost the seq gate (out-of-order
            //      or duplicate heartbeat — `clientSeq > last_event_seq` failed)
            // Case 2 must NOT surface as supersede or we'd toast healthy
            // sessions whose heartbeats raced. Re-read and decide.
            //
            // Wrap the SELECT — a transient DB error here must NOT bubble as
            // a 500 on heartbeat traffic. Degrading to silent no-op is the
            // safe default; the next heartbeat retries the disambiguation.
            let current: { status: string; stop_reason: string | null } | null;
            try {
                current = await this.deps.queries.getSessionStatusAndReason(sql, sessionId);
            } catch (err) {
                logger.warn(
                    'Backstop SELECT failed; treating heartbeat as silent no-op',
                    err as Error,
                );
                return { resume_anchor: null, wrote_to_durable: false };
            }
            if (!current) {
                // Row vanished — silent kill (backstop, no toast)
                return {
                    action: 'kill',
                    reason: 'session_ended',
                    resume_anchor: null,
                    wrote_to_durable: false,
                };
            }
            if (current.status === 'KILLED' || current.status === 'COMPLETED') {
                const kind = classifyStopReason(current.stop_reason);
                if (kind === 'superseded') {
                    return {
                        action: 'superseded',
                        reason: 'superseded',
                        resume_anchor: null,
                        wrote_to_durable: false,
                    };
                }
                if (kind === 'kicked') {
                    return {
                        action: 'kill',
                        reason: current.stop_reason ?? 'kicked',
                        resume_anchor: null,
                        wrote_to_durable: false,
                    };
                }
                // session_ended — silent (covers user/completed/null/unknown)
                return {
                    action: 'kill',
                    reason: 'session_ended',
                    resume_anchor: null,
                    wrote_to_durable: false,
                };
            }
            // Status is still ACTIVE/PAUSED/CRASHED → null came from the
            // event_seq gate. Heartbeat is stale/duplicate; treat as no-op
            // success so the client doesn't see a spurious supersede toast.
            return { resume_anchor: null, wrote_to_durable: false };
        }

        // Continuous stream-limit reconciliation ("grace-then-kick"): re-check
        // the user's effective policy on every successful heartbeat so a limit
        // violation that evades or races admission-time enforcement (a
        // direct-play client ignoring the 422, a transcode-path session stub,
        // an admin lowering the limit mid-stream) still gets caught. Scoped to
        // this native write path only — external poller ingestion (Jellyfin
        // sync, subsonic sync) writes play_sessions via upsertExternalSession
        // and never reaches this method, so it deliberately isn't hooked here.
        void reconcileStreamLimit(sql, userId).catch((err) => {
            logger.warn('Failed to fire stream-limit reconciliation', err as Error);
        });

        // Emit session_changed only when status transitions (ACTIVE↔PAUSED)
        if (status !== previousStatus) {
            watchStateEvents.emit(userId, {
                type: 'session_changed',
                sessionId,
                status,
                mediaId,
            });
        }

        // Live radio owns only its lease. It has no catalog-track play count,
        // completion, resume anchor, next-track state or listening history.
        if (session.media_type === 'radio') return { resume_anchor: null, wrote_to_durable: false };

        // 2. Write durable watch state (non-fatal) — music has dedicated tracking.
        //
        // Engagement gate: only persist resume position once the session has
        // accumulated enough active play time. This prevents scrub-and-leave and
        // early-seek heartbeats from polluting continue-watching / resume state.
        // play_sessions is updated unconditionally above (so admin/sessions always
        // reflects the real position), but user_watch_state only writes here.
        //
        // Legacy callers that omit session_elapsed_ms are treated as un-engaged
        // (elapsed = 0) and are gated out until they send the field.
        //
        // SOURCE-AWARE BY PLACEMENT: this gate is in lifecycle.handleHeartbeat
        // intentionally — it scope-limits to Lumastra player heartbeats which
        // carry the engagement signal. Other durable-state writers MUST NOT
        // come through this path:
        //   - Provider syncs (jellyfin-sync, plex-sync) write directly via
        //     watch-sync-engine → appendEventAndRebuild. They're authoritative
        //     resumption sources without an engagement equivalent.
        //   - Explicit user actions (markWatched/clearWatchProgress/etc.) call
        //     watchManager directly from routes — also unconditional.
        //   - Terminal events go through handleStop, which has its own gate:
        //     engaged, past completion or a completion end, and not an idle
        //     stop whose position durable state already holds.
        // Do NOT move this gate into watchManager.reportProgress or
        // appendEventAndRebuild — that would silently gate provider syncs and
        // cause Jellyfin-imported resume positions to be discarded.
        const isMusicTrack = isMusicSessionMediaType(session.media_type);
        // /j-compat never sends session_elapsed_ms; synthesize it from the
        // playhead so the engagement gate AND the CW engagement filter fire.
        const effectiveElapsedMs =
            payload.session_elapsed_ms ??
            (isJellyfinCompatSession(session) ? position_ms : undefined);
        const engagementMs = effectiveElapsedMs ?? 0;
        // Positions/runtime are file-absolute for combined files; engagement
        // must use the opened episode's own duration, as completion does.
        const engagementWindows = isMusicTrack
            ? []
            : await getEpisodeWindowsForFile(sql, mediaId).catch(() => []);
        const engagementWindow = engagementWindows.find((w) => w.mediaItemId === mediaId);
        const engagementRuntimeMs = engagementWindow
            ? engagementWindow.endMs - engagementWindow.startMs
            : Number(session.runtime_ms);
        const engaged = engagementMs >= engagementThresholdMs(engagementRuntimeMs);
        // Idle gate: `session` was loaded before updateHeartbeat, so its
        // position_ms is the previous heartbeat's. An unmoved playhead whose
        // position durable state already holds has nothing new to write; the
        // play_sessions row above still carries liveness.
        let progressOutcome: EventAppendOutcome | undefined;
        let wroteToDurable = false;
        if (
            !isMusicTrack &&
            engaged &&
            !(await isIdleAndDurable(sql, this.deps.queries, session, sessionId, position_ms))
        ) {
            try {
                const runtimeMs = session.runtime_ms ? Number(session.runtime_ms) : undefined;
                // Only /j-compat episodes get the flat 0.90 override; native (and
                // compat non-episodes) pass undefined so reportProgress keeps its
                // window-aware tier (preserves combined-file per-episode bars).
                const thresholdOverride =
                    isJellyfinCompatSession(session) && isEpisode(session.media_type)
                        ? JELLYFIN_PLAYED_THRESHOLD
                        : undefined;
                progressOutcome = await this.deps.watchManager.reportProgress({
                    userId,
                    mediaId,
                    positionMs: position_ms,
                    runtimeMs,
                    sessionId,
                    eventSeq: payload.event_seq,
                    mediaType: session.media_type ?? undefined,
                    sessionStartedAt: session.started_at,
                    sessionElapsedMs: effectiveElapsedMs,
                    completionThreshold: thresholdOverride,
                });
                // Anything but 'accepted' (superseded / stale_seq / duplicate)
                // means nothing landed in durable state.
                wroteToDurable = progressOutcome === 'accepted';
            } catch (err) {
                logger.warn('Failed to write watch progress', err as Error);
            }
        }
        // Music heartbeats are no-ops for the DB — the play_sessions row above
        // is the sole source of truth for the live "Now Streaming" feed.

        // Jellyfin → Lumastra progress: handled by watch-sync-engine pull cycle.
        // Lumastra → Jellyfin progress: handled by watch-sync-push (5-minute dirty-row cycle)

        // 3. Keep transcode job alive (debounced internally). Status is
        // threaded through so a paused heartbeat doesn't count as "active" for
        // eviction-priority purposes — see recordProgressHeartbeat's doc.
        // Guaranteed 'ACTIVE' | 'PAUSED' here — see the comment above updateHeartbeat's call.
        this.deps.transcodeService?.recordProgressHeartbeat(
            sessionId,
            status as 'ACTIVE' | 'PAUSED',
        );

        // Compute the freshly-updated anchor once, after all DB writes are done.
        // The just-written heartbeat's last_heartbeat_at lifts the live-session
        // contribution to the anchor (when the session is still eligible).
        let resumeAnchor: number | null = null;
        if (this.deps.resolveResumeAnchor) {
            try {
                resumeAnchor = await this.deps.resolveResumeAnchor(userId, mediaId);
            } catch (err) {
                logger.warn('Failed to compute resume_anchor for heartbeat ack', err as Error);
            }
        }

        // Signal the client ONLY when a genuinely newer session took this
        // (user, media) over. Clients treat this as terminal — the player
        // auto-pauses and latches until a full reload — so it must never fire
        // for a heartbeat that merely lost a seq race.
        //
        // 'stale_seq' (same session, duplicate or out-of-order heartbeat) and
        // 'duplicate' (idempotent replay) both mean "this write was a no-op",
        // NOT "you were replaced": the session is still the live one and its
        // next heartbeat will carry a forward seq. They fall through to the
        // ordinary ack with wrote_to_durable=false. Collapsing all three into
        // one signal is what let a retried heartbeat stop playback outright.
        if (progressOutcome === 'superseded') {
            return {
                action: 'superseded',
                reason: 'session_superseded',
                resume_anchor: resumeAnchor,
                wrote_to_durable: false,
            };
        }

        return {
            resume_anchor: resumeAnchor,
            wrote_to_durable: wroteToDurable,
        };
    }

    private async handleStop(
        sql: postgres.Sql,
        session: SessionRow,
        sessionId: string,
        payload: SessionUpdateInternal,
    ): Promise<StopResult> {
        // play_sessions.user_id is the stable users.id UUID (mig 16.46.0).
        const userId = toUserId(session.user_id);
        const { media_id: mediaId } = session;
        const { stop_reason } = payload;

        // If client reports position 0 on COMPLETED, prefer the session's last-known
        // position (from heartbeats) to avoid resetting watch progress on client crash.
        const position_ms =
            payload.position_ms === 0 && Number(session.position_ms) > 0
                ? Number(session.position_ms)
                : payload.position_ms;

        // Steps 1-3 share a single transaction connection. Step 1 (session stop)
        // is the durable operation. Steps 2 (watch state) and 3 (watch_history)
        // are best-effort augmentation isolated in savepoints. Catching a SQL
        // error alone leaves Postgres aborted (and postgres.js remembers it),
        // so each optional step must use its savepoint's own handle.
        //
        // crossedCompletion is declared here so step 5 (profile rebuild) outside
        // the transaction can read the result.
        let crossedCompletion = false;

        await withTx(sql, async (rawTxSql) => {
            // TransactionSql omits some Sql methods but is runtime-compatible;
            // cast once so typed query helpers can accept it.
            const txSql = rawTxSql as unknown as postgres.Sql;

            // 1. Mark session COMPLETED in DB
            const stopReasonForDb = payload.end_reason ?? stop_reason ?? 'user';
            const stopped = await this.deps.queries.stopSession(
                txSql,
                sessionId,
                position_ms,
                stopReasonForDb,
            );

            // stopSession also revives CRASHED rows (mirrors updateHeartbeat's
            // revival precedent), so a null here means the row is KILLED or
            // already COMPLETED — a genuine double-stop/admin-kill race, not
            // a heartbeat-timeout reap. Skip remaining steps in that case.
            if (!stopped) return;
            await revokeGrantsForPlaySession(sessionId, txSql, 'stopped');
            if (session.media_type === 'radio') return;

            // 2. Write final watch state (best-effort — does not abort transaction)
            //
            // Engagement gate (terminal-event variant): the heartbeat path is
            // already gated, but a low-engagement scrub-and-leave can still
            // arrive here as a COMPLETED/unload beacon with the scrubbed
            // position. Forwarding that into reportProgress would persist a
            // bogus resume position. Persist durable state only when one of
            // these is true:
            //   (a) the session crossed the engagement threshold (a real
            //       watching session that ended)
            //   (b) the position is past the completion threshold (the user
            //       actually watched to the end, even briefly — this is also
            //       what triggers markWatched below)
            //   (c) end_reason === 'completion' (player itself decided the
            //       video ended at the natural end-of-content)
            // Otherwise: skip the durable write. The session row is still
            // marked COMPLETED in step 1; user_media_state stays at whatever
            // it was, which is the correct behavior for "user opened, scrubbed,
            // left without watching".
            const isMusicTrack = isMusicSessionMediaType(session.media_type);
            const sessionRuntimeMs = Number(session.runtime_ms);
            // Window-aware completion (mirror reportProgress) so a combined
            // multi-episode file judges the OPENED episode's own window, not the
            // whole file — keeps markWatched / watch_history / profile-rebuild
            // consistent with the rebuilder's per-episode auto-complete. For a
            // normal single-episode/movie file there is no window, so this is
            // identical to position_ms / sessionRuntimeMs.
            const completionWindows = await getEpisodeWindowsForFile(txSql, mediaId).catch(
                () => [],
            );
            const completionWindow =
                completionWindows.find((w) => w.mediaItemId === mediaId) ?? null;
            const positionForCompletion = completionWindow
                ? position_ms - completionWindow.startMs
                : position_ms;
            const runtimeForCompletion = completionWindow
                ? completionWindow.endMs - completionWindow.startMs
                : sessionRuntimeMs;
            const completionThreshold = playedThresholdFor(
                session,
                session.media_type,
                runtimeForCompletion > 0 ? runtimeForCompletion : undefined,
            );
            // /j-compat has no session_elapsed_ms; the playhead is the engagement proxy.
            const effectiveElapsedMs =
                payload.session_elapsed_ms ??
                (isJellyfinCompatSession(session) ? position_ms : undefined);
            const engagementMs = effectiveElapsedMs ?? 0;
            const engaged = engagementMs >= engagementThresholdMs(runtimeForCompletion);
            crossedCompletion =
                runtimeForCompletion > 0 &&
                positionForCompletion / runtimeForCompletion >= completionThreshold;
            const isCompletionEnd = payload.end_reason === 'completion';
            // Idle gate (terminal variant): a stop at the position durable
            // state already holds for this session adds nothing, and
            // re-stamping would refresh a stale paused tab's recency. A stop
            // that completes the item always persists.
            const unmovedNonCompletingStop =
                !crossedCompletion &&
                !isCompletionEnd &&
                (await isIdleAndDurable(txSql, this.deps.queries, session, sessionId, position_ms));
            const shouldPersistDurable =
                (engaged || crossedCompletion || isCompletionEnd) && !unmovedNonCompletingStop;
            // Only /j-compat episodes get the flat 0.90 override; native (and
            // compat non-episodes) pass undefined so reportProgress keeps its
            // window-aware tier (preserves combined-file per-episode bars).
            const thresholdOverride =
                isJellyfinCompatSession(session) && isEpisode(session.media_type)
                    ? JELLYFIN_PLAYED_THRESHOLD
                    : undefined;

            if (!isMusicTrack && shouldPersistDurable) {
                const watchResult = await inSavepoint(txSql, async (watchTx) => {
                    const runtimeMs = Number(session.runtime_ms);
                    await this.deps.watchManager.reportProgress(
                        {
                            userId,
                            mediaId,
                            positionMs: position_ms,
                            runtimeMs: runtimeMs > 0 ? runtimeMs : undefined,
                            sessionId,
                            eventSeq: payload.event_seq,
                            mediaType: session.media_type ?? undefined,
                            sessionStartedAt: session.started_at,
                            sessionElapsedMs: effectiveElapsedMs,
                            completionThreshold: thresholdOverride,
                        },
                        watchTx,
                    );
                    // Fallback only: reportProgress above normally completes the
                    // item itself, and this mark (a `lumastra-user-mark`) was a
                    // second +1 on watch_count for every viewing finished in the
                    // player — plus another per stop of the same session
                    // (prod 2026-09-30: 1,728 of 2,360 "user marks"). Mark only
                    // when this session has no completion of its own, e.g. when
                    // the stop's threshold is below reportProgress's tier.
                    if (
                        crossedCompletion &&
                        !(await this.deps.queries.sessionHasCompletion(
                            watchTx,
                            userId,
                            mediaId,
                            sessionId,
                        ))
                    ) {
                        await this.deps.watchManager.markWatched({ userId, mediaId }, watchTx);
                    }
                });
                if (!watchResult.ok) {
                    logger.warn('Failed to write watch state on stop', watchResult.error as Error);
                }
            } else if (!isMusicTrack) {
                logger.debug(
                    'Stop received with low engagement and no completion — skipping durable write',
                    {
                        sessionId,
                        userId,
                        mediaId,
                        engagementMs,
                        position_ms,
                        endReason: payload.end_reason,
                    },
                );
            }

            // 3. Create watch_history entry (best-effort — don't roll back
            //    the session stop if history insert fails)
            const historyResult = await inSavepoint(txSql, async (historyTx) => {
                if (session.started_at) {
                    const mediaRow = await this.deps.getMediaMetadata(historyTx, mediaId);
                    if (mediaRow) {
                        const runtimeMs = Number(session.runtime_ms);
                        const isCompleted =
                            runtimeForCompletion > 0 &&
                            positionForCompletion / runtimeForCompletion >= completionThreshold;
                        await this.deps.watchHistoryService.recordCompletedSession(
                            {
                                userId: userId,
                                mediaId,
                                mediaType: mediaRow.media_type,
                                title: mediaRow.title,
                                year: mediaRow.year ?? undefined,
                                seriesName: mediaRow.series_name ?? undefined,
                                seasonNumber: mediaRow.season_number ?? undefined,
                                episodeNumber: mediaRow.episode_number ?? undefined,
                                startedAt: session.started_at,
                                stoppedAt: new Date(),
                                positionMs: position_ms,
                                runtimeMs: runtimeMs ?? undefined,
                                isCompleted,
                                deviceName: session.user_agent ?? undefined,
                                clientName: session.client_name ?? undefined,
                                playMethod: session.play_method,
                                videoCodec: session.video_codec ?? undefined,
                                resolution: session.resolution ?? undefined,
                                bitrateKbps: session.bitrate_kbps ?? undefined,
                                playSessionId: sessionId,
                            },
                            historyTx,
                        );
                    }
                }
            });
            if (!historyResult.ok) {
                logger.warn('Failed to create watch_history entry', historyResult.error as Error);
            }
        });

        // 4. Post-stop cleanup: watched caches, telemetry, device, transcode job.
        await this.cleanupAfterStop(
            sessionId,
            userId,
            payload.end_reason ?? payload.stop_reason ?? 'session_stop',
            session,
        );

        // 5. Debounced profile rebuild on movie/tv completion (fire-and-forget).
        // Only triggered when the user genuinely finished watching a movie or
        // TV show (crossedCompletion), not for music tracks or scrub-and-leave.
        // The rebuild is debounced via a Valkey TTL key so a binge session
        // triggers at most one rebuild per debounce window.
        // Users watch individual episodes (media_type='episode'), not the series
        // row ('tv'), so match movies and episodes via the case-tolerant
        // comparators rather than string literals.
        if (crossedCompletion && (isMovie(session.media_type) || isEpisode(session.media_type))) {
            try {
                const { aiDbService } = await import('./database.service.js');
                const profileService = await aiDbService.getUserProfileService();
                if (profileService) {
                    profileService.rebuildUserProfileDebounced(userId);
                }
            } catch (err) {
                logger.warn(
                    'Failed to schedule debounced profile rebuild',
                    { sessionId, userId },
                    err as Error,
                );
            }
        }

        // A stop commits the resume point even when playback did not complete.
        // Wake Home/detail readers on every device through the shared user hub.
        watchStateEvents.emit(userId, {
            type: 'watch_state_set_changed',
            mediaId,
            reason: 'playback_stop',
        });

        // Use error end_reason or legacy crash stop_reason to distinguish CRASHED vs COMPLETED
        const stopStatus =
            payload.end_reason === 'error' || stop_reason === 'crash' ? 'CRASHED' : 'COMPLETED';
        watchStateEvents.emit(userId, {
            type: 'session_changed',
            sessionId,
            status: stopStatus,
            mediaId,
        });

        return undefined;
    }

    /**
     * Bundled post-stop cleanup: invalidates watched caches, computes
     * telemetry, releases device, and stops any tied FFmpeg job.
     *
     * Centralised here so any future stop path cannot forget a step.
     */
    private async cleanupAfterStop(
        sessionId: string,
        userId: UserId,
        reason: string,
        session: SessionRow,
    ): Promise<void> {
        const sql = this.deps.getSql();
        if (sql && session.purpose === 'play') {
            const { expireMusicPrefetchForSession } = await import('./play-sessions.service.js');
            await expireMusicPrefetchForSession(sql, sessionId);
        }
        await stopSessionTranscode(sessionId, reason);
        await invalidateAllWatchedCaches(userId);
        playbackTelemetryService.computeSessionQualityOnStop(sessionId, userId);
        await removePlaySessionDevice(sessionId);
    }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

import { watchManager } from './watch-manager.service.js';
import { watchHistoryService } from './watch-history.service.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    updateHeartbeat,
    stopSession,
    getSessionById,
    getSessionStatusAndReason,
    getSessionDurableProgressMs,
    sessionHasCompletion,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { getMediaMetadataForHistory } from '$lib/server/database/queries/watch-history-insert.queries.js';
import { getFFmpegTranscodeService } from './ffmpeg-transcode.service.js';

let _instance: PlaySessionLifecycleService | null = null;

export function getPlaySessionLifecycleService(): PlaySessionLifecycleService {
    if (!_instance) {
        _instance = new PlaySessionLifecycleService({
            watchManager,
            watchHistoryService,
            queries: {
                updateHeartbeat,
                stopSession,
                getSessionById,
                getSessionStatusAndReason,
                getSessionDurableProgressMs,
                sessionHasCompletion,
            },
            getMediaMetadata: getMediaMetadataForHistory,
            getSql: getDb,
            get transcodeService() {
                return getFFmpegTranscodeService();
            },
            resolveResumeAnchor: async (userId, mediaId) => {
                const effective = await resolveEffectiveResume(userId, mediaId);
                return effective.anchorMs;
            },
        });
    }
    return _instance;
}
