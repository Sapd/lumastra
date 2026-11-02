// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SessionManager — normalized ingestion path for non-Lumastra session sources.
 *
 * The unified-session architecture has two writer paths into `play_sessions`,
 * by design:
 *
 *   • Lumastra lifecycle (`play-session-lifecycle.service.ts` +
 *     `play-sessions.service.ts`) — the specialized writer/coordinator for
 *     first-party playback. It owns event_seq gating, transactional watch-state
 *     writes via `appendEventAndRebuild`, ffmpeg-transcode coordination, and
 *     stream-policy enforcement. None of those concerns generalise to external
 *     sources, so Lumastra does NOT route through this service.
 *
 *   • SessionManager (this file) — the normalized ingestion API for every
 *     other source: Jellyfin, ABS, LiveTV, music. Pollers call
 *     `ingestExternal()` per observed session and `markStop()` when one
 *     vanishes. `ingestLumastra()` exists as a thin wrapper for tests and any
 *     future caller that wants the same shape, but the production Lumastra
 *     path does not use it.
 *
 * The single source of truth for *reads* is `SessionReadModel` +
 * `resolveEffective*` regardless of source. That's what unifies the
 * architecture; on the write side, "single ingestion point" was an aspiration
 * that didn't survive contact with the Lumastra lifecycle's specialised
 * responsibilities.
 *
 * ## External-source ingestion contract
 *
 * Every poll, regardless of whether anything changed, MUST refresh
 * `last_seen_at`. The external-source reaper (F5) keys off that column to
 * decide when a session has vanished from upstream — if pollers stopped
 * touching it on no-op polls, idle sessions would be reaped 30s after their
 * last meaningful change rather than 30s after upstream actually drops them.
 *
 * To keep the heavy upsert (semantic columns) out of the hot path, this
 * service splits ingestion into two SQL operations:
 *
 *   1. `refreshExternalSessionPresence` — a one-column UPDATE that bumps
 *      `last_seen_at`. Runs every poll on every existing row.
 *   2. `upsertExternalSession` — the full INSERT … ON CONFLICT path.
 *      Runs only when a semantic field actually changed (status, media_id,
 *      play_method, codecs, container, bitrate, resolution, external_payload),
 *      or when position has moved by ≥ 5 seconds.
 *
 * For the first sighting (no row exists), step 1 returns count=0 and we
 * unconditionally run step 2. For subsequent polls with no semantic delta,
 * we stop after step 1 — which is what the unit tests verify.
 *
 * ## Position threshold
 *
 * A position update counts as a "semantic change" only when the delta is
 * ≥ POSITION_CHANGE_THRESHOLD_MS (5 seconds). This filters out sub-second
 * jitter from clients that report on every frame without throttling, while
 * still capturing real seeks and natural progress.
 *
 * ## Lumastra ingestion (thin wrapper, not the production path)
 *
 * `ingestLumastra` is provided as a symmetric API but is NOT the Lumastra
 * production write path. The lifecycle service is, and it owns the
 * surrounding transactional context (watch-state event log, ffmpeg job
 * coordination, stream-policy enforcement) that wouldn't fit here. Use
 * `ingestLumastra` only for tests or for future callers that genuinely want
 * the same shape across sources.
 */
import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { aiDbService } from './database.service.js';
import type { PlaySurface } from '$lib/server/api/play-surface.js';
import {
    createPlaySession,
    getSessionBySourceKey,
    refreshExternalSessionPresence,
    stopExternalSession,
    stopSession,
    stopLumastraSession,
    updateHeartbeat,
    upsertExternalSession,
    type PlaySessionSource,
    type SessionRow,
    type UpsertExternalSessionParams,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { watchStateEvents } from './watch-state-events.service.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

const logger = Logger.for('SessionManager');

/**
 * Position changes smaller than this (in ms) do not count as a semantic
 * update. Locked at 5 seconds — see the per-session contract in the file
 * header. Exported for tests; not configurable at runtime.
 */
export const POSITION_CHANGE_THRESHOLD_MS = 5_000;

/** External sources accepted by `ingestExternal`. Matches the DB CHECK. */
export type ExternalSessionSource = Exclude<PlaySessionSource, 'lumastra'>;

// ─── Public API types ─────────────────────────────────────────────────────────

export interface IngestLumastraParams {
    /** Existing `play_sessions.id` (uuid). */
    sessionId: string;
    /** Stable users.id UUID — written to play_sessions.user_id (mig 16.46.0). */
    userId: UserId;
    mediaId: string;
    positionMs: number;
    /** Lumastra lifecycle never sends terminal states here — use markStop(). */
    status: 'ACTIVE' | 'PAUSED';
    /**
     * Monotonic per-session sequence from the client. Required for the
     * heartbeat path; unused on first creation. Same gating semantics as
     * `play-sessions.queries.updateHeartbeat`.
     */
    eventSeq?: number;
    deviceId?: string;
    deviceName?: string | null;
    clientName?: string | null;
    clientVersion?: string | null;
    ipAddress?: string;
    playMethod?: 'direct' | 'remux' | 'audio_transcode' | 'full_transcode';
    audioCodec?: string | null;
    videoCodec?: string | null;
    container?: string | null;
    bitrateKbps?: number | null;
    resolution?: string | null;
    runtimeMs?: number | null;
    audioStreamIndex?: number | null;
    subtitleStreamIndex?: number | null;
    audioLanguage?: string | null;
    subtitleLanguage?: string | null;
    subtitleMethod?: 'external_vtt' | 'client_render' | 'none';
    bufferHealthSec?: number | null;
}

export interface IngestExternalParams {
    source: ExternalSessionSource;
    /** Source system's session id. Forms the upsert key with `source`. */
    sourceSessionId: string;
    /** Stable users.id UUID — written to play_sessions.user_id (mig 16.46.0). */
    userId: UserId;
    /** Internal media UUID (callers must resolve before invoking). */
    mediaId: string;
    positionMs: number;
    status: 'ACTIVE' | 'PAUSED';
    playMethod?: string;
    device?: {
        name?: string;
        client?: string;
        deviceId?: string;
        clientVersion?: string;
    };
    technical?: {
        videoCodec?: string;
        audioCodec?: string;
        bitrate?: number;
        container?: string;
        resolution?: string;
    };
    runtimeMs?: number | null;
    /** Opaque jsonb stored on the row. */
    externalPayload?: unknown;
}

export interface IngestExternalResult {
    created: boolean;
    updated: boolean;
}

export interface MarkStopParams {
    /** For Lumastra rows. Mutually exclusive with `source`/`sourceSessionId`. */
    sessionId?: string;
    /** For external rows. Both `source` and `sourceSessionId` required together. */
    source?: ExternalSessionSource;
    sourceSessionId?: string;
    reason: 'completed' | 'crashed' | 'killed';
    finalPositionMs?: number;
    /** Optional human-readable suffix appended to the stop_reason column. */
    detail?: string;
}

// ─── Dependency seam (testability) ────────────────────────────────────────────

export interface SessionManagerDeps {
    getSql: () => Promise<postgres.Sql | null> | postgres.Sql | null;
    queries?: {
        createPlaySession: typeof createPlaySession;
        getSessionBySourceKey: typeof getSessionBySourceKey;
        refreshExternalSessionPresence: typeof refreshExternalSessionPresence;
        stopExternalSession: typeof stopExternalSession;
        stopSession: typeof stopSession;
        stopLumastraSession: typeof stopLumastraSession;
        updateHeartbeat: typeof updateHeartbeat;
        upsertExternalSession: typeof upsertExternalSession;
    };
}

const defaultQueries: NonNullable<SessionManagerDeps['queries']> = {
    createPlaySession,
    getSessionBySourceKey,
    refreshExternalSessionPresence,
    stopExternalSession,
    stopSession,
    stopLumastraSession,
    updateHeartbeat,
    upsertExternalSession,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Surface for a mirrored session, derived from its `source` rather than
 * stamped as a literal here.
 *
 * `ExternalSessionSource` accepts 'jellyfin' | 'audiobookshelf' | 'livetv' |
 * 'music', and only 'jellyfin' is actually fed today (sessions-cache.service
 * polls Jellyfin alone). A literal 'jellyfin_mirror' at this shared helper
 * would therefore look correct now and silently mislabel every ABS, Live TV or
 * music ingest the day one starts flowing — permanently, since `surface` is
 * forward-only. Anything that is not a Jellyfin mirror is 'unknown' until
 * someone decides what it should be.
 */
function surfaceForExternalSource(source: ExternalSessionSource): PlaySurface {
    return source === 'jellyfin' ? 'jellyfin_mirror' : 'unknown';
}

/**
 * Build the `UpsertExternalSessionParams` shape from the public ingestion
 * input. Centralised so both `ingestExternal` and `hasSemanticChange` see the
 * same field projection.
 */
function toUpsertParams(params: IngestExternalParams): UpsertExternalSessionParams {
    return {
        source: params.source,
        surface: surfaceForExternalSource(params.source),
        source_session_id: params.sourceSessionId,
        media_id: params.mediaId,
        user_id: params.userId,
        device_id: params.device?.deviceId ?? params.source,
        user_agent: params.device?.name ?? null,
        client_name: params.device?.client ?? null,
        client_version: params.device?.clientVersion ?? null,
        ip_address: '0.0.0.0',
        play_method: params.playMethod ?? 'direct',
        status: params.status,
        position_ms: params.positionMs,
        runtime_ms: params.runtimeMs ?? null,
        audio_codec: params.technical?.audioCodec ?? null,
        video_codec: params.technical?.videoCodec ?? null,
        container: params.technical?.container ?? null,
        bitrate_kbps: params.technical?.bitrate ?? null,
        resolution: params.technical?.resolution ?? null,
        external_payload: params.externalPayload,
    };
}

/**
 * Decide whether the incoming poll differs enough from the stored row to
 * justify the heavier upsert. Returns true on the first material delta found
 * — the comparison is short-circuited because the semantic fields are
 * independent (any one of them flipping invalidates the cached row).
 *
 * Position change uses `POSITION_CHANGE_THRESHOLD_MS` (5s); all other fields
 * use exact equality. JSON payloads compare by stringification — pollers that
 * normalise the payload shape upstream avoid spurious cache misses.
 *
 * Exported for tests.
 */
export function hasSemanticChange(row: SessionRow, params: IngestExternalParams): boolean {
    if (row.status !== params.status) return true;
    if (row.media_id !== params.mediaId) return true;
    if (row.user_id !== params.userId) return true;

    const positionDelta = Math.abs(Number(row.position_ms ?? 0) - params.positionMs);
    if (positionDelta >= POSITION_CHANGE_THRESHOLD_MS) return true;

    const incoming = toUpsertParams(params);

    if (incoming.play_method !== undefined && row.play_method !== incoming.play_method) {
        return true;
    }
    if (incoming.audio_codec !== null && row.audio_codec !== incoming.audio_codec) {
        return true;
    }
    if (incoming.video_codec !== null && row.video_codec !== incoming.video_codec) {
        return true;
    }
    if (incoming.container !== null && row.container !== incoming.container) {
        return true;
    }
    if (incoming.bitrate_kbps !== null && row.bitrate_kbps !== incoming.bitrate_kbps) {
        return true;
    }
    if (incoming.resolution !== null && row.resolution !== incoming.resolution) {
        return true;
    }
    if (incoming.runtime_ms !== null && row.runtime_ms !== incoming.runtime_ms) {
        return true;
    }
    if (incoming.user_agent !== null && row.user_agent !== incoming.user_agent) {
        return true;
    }
    if (incoming.client_name !== null && row.client_name !== incoming.client_name) {
        return true;
    }
    if (incoming.client_version !== null && row.client_version !== incoming.client_version) {
        return true;
    }

    if (params.externalPayload !== undefined) {
        const incomingJson = stableJsonStringify(params.externalPayload);
        const storedJson = stableJsonStringify(row.external_payload);
        if (incomingJson !== storedJson) return true;
    }

    return false;
}

/**
 * Stringify with sorted keys at every nesting level so that two payloads
 * with identical content but different insertion order compare equal.
 * External pollers (Jellyfin SessionInfo, ABS) often emit objects whose key
 * order is not deterministic across responses; without sorting, every poll
 * would defeat the debounce gate.
 */
function stableJsonStringify(value: unknown): string {
    if (value === undefined || value === null) return '';
    try {
        return JSON.stringify(value, (_key, raw: unknown): unknown => {
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                const sorted: Record<string, unknown> = {};
                const obj = raw as Record<string, unknown>;
                for (const k of Object.keys(obj).sort()) {
                    sorted[k] = obj[k];
                }
                return sorted;
            }
            return raw;
        });
    } catch {
        // best-effort: unserializable value falls back to its String() form for the debounce key.
        return String(value);
    }
}

/** Map the public `reason` to the DB `status` enum. */
function reasonToStatus(reason: MarkStopParams['reason']): 'COMPLETED' | 'CRASHED' | 'KILLED' {
    switch (reason) {
        case 'completed':
            return 'COMPLETED';
        case 'crashed':
            return 'CRASHED';
        case 'killed':
            return 'KILLED';
    }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class SessionManager {
    private readonly queries: NonNullable<SessionManagerDeps['queries']>;

    constructor(private readonly deps: SessionManagerDeps) {
        this.queries = deps.queries ?? defaultQueries;
    }

    /**
     * Ingest a Lumastra lifecycle event (heartbeat or first sighting).
     *
     * If the row exists, this routes to `updateHeartbeat` and respects the
     * existing `event_seq` gate — out-of-order heartbeats are silently
     * dropped at the SQL level. If the row does NOT exist (e.g. first
     * sighting after a server restart), this falls back to `createPlaySession`
     * with the supplied id so subsequent heartbeats merge into the same row.
     *
     * Lumastra callers still go through `play-session-lifecycle.service`;
     * this method is provided so future callers can migrate over without
     * duplicating ingest logic.
     */
    async ingestLumastra(params: IngestLumastraParams): Promise<void> {
        const sql = await this.resolveSql();
        if (!sql) {
            logger.warn('Lumastra ingest skipped — no DB connection', {
                sessionId: params.sessionId,
            });
            return;
        }

        const eventSeq = params.eventSeq ?? 0;
        const updated = await this.queries.updateHeartbeat(sql, params.sessionId, {
            position_ms: params.positionMs,
            status: params.status,
            bitrate_kbps: params.bitrateKbps ?? undefined,
            resolution: params.resolution ?? undefined,
            play_method: params.playMethod,
            audio_stream_index: params.audioStreamIndex ?? undefined,
            subtitle_stream_index: params.subtitleStreamIndex ?? undefined,
            audio_language: params.audioLanguage ?? undefined,
            subtitle_language: params.subtitleLanguage ?? undefined,
            subtitle_method: params.subtitleMethod,
            buffer_health_sec: params.bufferHealthSec ?? undefined,
            event_seq: eventSeq,
        });

        if (updated) return;

        // No row — first sighting. Need a play_method for createPlaySession,
        // and a device_id / ip_address. Fall back to safe defaults so a
        // poller-style boot replay can succeed; subsequent heartbeats will
        // merge into the row via ON CONFLICT.
        if (!params.playMethod) {
            logger.debug(
                'Lumastra ingest: row missing and no play_method supplied — skipping create',
                { sessionId: params.sessionId },
            );
            return;
        }

        await this.queries.createPlaySession(sql, {
            // 'unknown', not a guess. This is ingestLumastra's first-sighting
            // replay after a restart — there is no request and no Principal in
            // scope, so the surface the client originally spoke is genuinely
            // unrecoverable here. The real create stamped it; if this row wins
            // the race instead, the ON CONFLICT COALESCE lets the later create
            // supply the value.
            surface: 'unknown',
            id: params.sessionId,
            media_id: params.mediaId,
            user_id: params.userId,
            device_id: params.deviceId ?? 'lumastra',
            user_agent: params.deviceName ?? undefined,
            client_name: params.clientName ?? undefined,
            client_version: params.clientVersion ?? undefined,
            ip_address: params.ipAddress ?? '0.0.0.0',
            play_method: params.playMethod,
            audio_codec: params.audioCodec ?? undefined,
            video_codec: params.videoCodec ?? undefined,
            container: params.container ?? undefined,
            bitrate_kbps: params.bitrateKbps ?? undefined,
            resolution: params.resolution ?? undefined,
            position_ms: params.positionMs,
            runtime_ms: params.runtimeMs ?? undefined,
            audio_stream_index: params.audioStreamIndex ?? undefined,
            subtitle_stream_index: params.subtitleStreamIndex ?? undefined,
            audio_language: params.audioLanguage ?? undefined,
            subtitle_language: params.subtitleLanguage ?? undefined,
            subtitle_method: params.subtitleMethod,
        });
    }

    /**
     * Ingest an external poller event (Jellyfin / ABS / LiveTV / music).
     *
     * Performs the lightweight presence refresh first; falls through to the
     * full upsert only when the row is new or a semantic field changed (see
     * file header). Returns flags so callers can emit metrics / SSE only on
     * meaningful transitions.
     */
    async ingestExternal(params: IngestExternalParams): Promise<IngestExternalResult> {
        const sql = await this.resolveSql();
        if (!sql) {
            logger.warn('External ingest skipped — no DB connection', {
                source: params.source,
                sourceSessionId: params.sourceSessionId,
            });
            return { created: false, updated: false };
        }

        // Step 1: liveness ping. Always cheap, always runs (when a row exists).
        const refreshed = await this.queries.refreshExternalSessionPresence(
            sql,
            params.source,
            params.sourceSessionId,
        );

        if (refreshed === 0) {
            // First sighting — no presence row yet. Run the full upsert to
            // create it. The `created` flag from the upsert is authoritative.
            const { row, created } = await this.queries.upsertExternalSession(
                sql,
                toUpsertParams(params),
            );
            // First sighting is itself a lifecycle transition — there was no
            // previous status. Emit unconditionally: if another pod inserted
            // between this pod's refresh and upsert, `created` is false but
            // this pod still saw no prior row, so the transition must be emitted.
            this.emitSessionChanged(row, toUserId(row.user_id));
            return { created, updated: !created };
        }

        // Row exists. Decide whether to run the heavier upsert.
        const existing = await this.queries.getSessionBySourceKey(
            sql,
            params.source,
            params.sourceSessionId,
        );

        if (!existing) {
            // Race: row was reaped between the refresh and the read. Treat as
            // first sighting and let the upsert recreate it.
            const { row, created } = await this.queries.upsertExternalSession(
                sql,
                toUpsertParams(params),
            );
            // Emit unconditionally — same reasoning as the refreshed===0 branch.
            this.emitSessionChanged(row, toUserId(row.user_id));
            return { created, updated: !created };
        }

        if (!hasSemanticChange(existing, params)) {
            // Liveness already refreshed in step 1; nothing else to write.
            return { created: false, updated: false };
        }

        const statusFlipped = existing.status !== params.status;
        const mediaChanged = existing.media_id !== params.mediaId;
        const { row } = await this.queries.upsertExternalSession(sql, toUpsertParams(params));
        // Status transitions and media identity changes are lifecycle events
        // worth waking subscribers for. Jellyfin/ABS sometimes keep the same
        // SessionInfo.Id across an auto-next-episode, so the same source
        // session can switch media while staying ACTIVE — that's a different
        // "thing" for CW/admin purposes and needs a refetch. Pure position /
        // codec / payload changes still run the upsert (semantic write) but
        // don't emit — they aren't what CW or admin session lists care about.
        if (statusFlipped || mediaChanged) {
            this.emitSessionChanged(row, toUserId(row.user_id));
        }
        return { created: false, updated: true };
    }

    /**
     * Emit a `session_changed` event for an external lifecycle transition.
     * Coalescing (1/sec/username) lives in the emitter — callers don't need to
     * debounce. The row's id and status come straight from the upsert RETURNING
     * so SSE consumers see the post-write state.
     */
    private emitSessionChanged(row: SessionRow, userId: UserId): void {
        watchStateEvents.emit(userId, {
            type: 'session_changed',
            sessionId: row.id,
            status: row.status,
            mediaId: row.media_id,
        });
    }

    /**
     * Mark a session terminal. Caller picks the reason (`completed`,
     * `crashed`, or `killed`); the service maps it to the DB `status` enum.
     *
     * Lumastra sessions are looked up by `sessionId`; external sessions by the
     * `(source, sourceSessionId)` upsert key. Passing both is a programming
     * error.
     */
    async markStop(params: MarkStopParams): Promise<void> {
        const sql = await this.resolveSql();
        if (!sql) {
            logger.warn('markStop skipped — no DB connection', {
                sessionId: params.sessionId,
                source: params.source,
            });
            return;
        }

        const finalStatus = reasonToStatus(params.reason);
        const stopReason = params.detail ? `${params.reason}:${params.detail}` : params.reason;

        if (params.sessionId) {
            if (params.source || params.sourceSessionId) {
                throw new Error(
                    'markStop: pass either sessionId OR (source, sourceSessionId), not both',
                );
            }

            if (finalStatus === 'COMPLETED') {
                const stoppedRow = await this.queries.stopSession(
                    sql,
                    params.sessionId,
                    params.finalPositionMs ?? 0,
                    stopReason,
                );
                if (stoppedRow) {
                    this.emitSessionChanged(stoppedRow, toUserId(stoppedRow.user_id));
                }
                return;
            }

            // CRASHED / KILLED — delegated to `stopLumastraSession` for parity
            // with `stopExternalSession`. Unlike `stopSession` (COMPLETED
            // branch above), this gate stays `WHERE status IN ('ACTIVE',
            // 'PAUSED')` — there's no reason to transition an
            // already-CRASHED/COMPLETED row to CRASHED/KILLED, so no revival
            // case applies here.
            const stoppedRow = await this.queries.stopLumastraSession(sql, params.sessionId, {
                final_status: finalStatus,
                stop_reason: stopReason,
                position_ms: params.finalPositionMs,
            });
            if (stoppedRow) {
                this.emitSessionChanged(stoppedRow, toUserId(stoppedRow.user_id));
            }
            return;
        }

        if (params.source && params.sourceSessionId) {
            const stoppedRow = await this.queries.stopExternalSession(
                sql,
                params.source,
                params.sourceSessionId,
                {
                    final_status: finalStatus,
                    stop_reason: stopReason,
                    position_ms: params.finalPositionMs,
                },
            );
            // External session vanished from upstream and we transitioned the
            // row to a terminal state. Emit so admin/sessions and ForYou CW
            // converge without waiting for the next 5s poll. The query returns
            // null when the row was already terminal — no transition, no emit.
            if (stoppedRow) {
                this.emitSessionChanged(stoppedRow, toUserId(stoppedRow.user_id));
            }
            return;
        }

        throw new Error(
            'markStop: requires either sessionId (Lumastra) or (source, sourceSessionId) (external)',
        );
    }

    private async resolveSql(): Promise<postgres.Sql | null> {
        const result = await this.deps.getSql();
        return result ?? null;
    }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let singleton: SessionManager | null = null;

export function getSessionManager(): SessionManager {
    if (!singleton) {
        singleton = new SessionManager({
            getSql: () => aiDbService.getSql(),
        });
    }
    return singleton;
}

/** Reset the singleton — exclusively for tests. */
export function __resetSessionManagerForTests(): void {
    singleton = null;
}
