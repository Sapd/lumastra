// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/components/player/play-session-reporter.ts
import type {
    IProgressReporter,
    ProgressEventType,
    ProgressReportData,
    ProgressReporterConfig,
} from './progress-reporter.types.js';
import type { PlaybackReport, SessionUpdate } from '$lib/schemas/session-update.js';
import type { SessionAdaptiveReport } from '$lib/schemas/session-adaptive.js';
import { startPlaySession } from '$lib/api/playback.js';
import { apiGet, apiPut } from '$lib/api/client.js';
import {
    SessionHeartbeatResponseSchema,
    TranscodeProgressResponseSchema,
    type TranscodeProgressPayload,
} from '$lib/schemas/api-playback-responses.js';
import { toPlayMethodOrDefault, type PlayMethod } from '$lib/utils/playback-method.js';
import { describePolicyRefusal } from './playback-refusal.js';
// Top-level import — admin-event-handler is tiny, no reason to lazy-load.
// Avoids surfacing stale-chunk fetch failures as unhandled promise rejections
// in the SSE event switch below.
import { handleAdminEvent } from '$lib/services/sse/admin-event-handler.js';
import type { PlaybackCapabilities, PlaybackStartResponse } from '$lib/schemas/playback-start.js';
import { maintainPlaybackGrant } from '$lib/utils/playback-grant.js';
import { toasts } from '$lib/stores/toast.store.js';
import * as m from '$lib/paraglide/messages.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { isTranscodeFinished } from './transcode-progress-view.js';
import type { WatchEntry } from '$lib/stores/watch-entry.js';

/**
 * Audio/subtitle stream indices use -1 as the "default / none" sentinel, but the
 * play-session API schema accepts only a real (>=0) absolute index or omission
 * (`z.number().int().nonnegative().optional()`). A bare `?? undefined` lets the
 * -1 through and the request 400s. Map a negative/nullish index to undefined so
 * the body omits it (the server treats absent as "default").
 */
function omitNegativeIndex(n: number | null | undefined): number | undefined {
    return typeof n === 'number' && n >= 0 ? n : undefined;
}

/**
 * Wire (camelCase) form of an in-process SessionUpdate. Beacon callers still
 * build the snake_case shape; this is the inverse of playbackReportToSessionUpdate.
 */
function toPlaybackReport(body: SessionUpdate): PlaybackReport {
    return {
        finished: body.finished,
        nextMediaId: body.next_media_id,
        crossfade: body.crossfade,
        positionMs: body.position_ms,
        status: body.status,
        eventSeq: body.event_seq,
        endReason: body.end_reason,
        audioStreamIndex: body.audio_stream_index,
        subtitleStreamIndex: body.subtitle_stream_index,
        bitrateBps:
            body.bitrate_kbps && body.bitrate_kbps > 0 ? body.bitrate_kbps * 1000 : undefined,
        resolution: body.resolution,
        playMethod: body.play_method,
        audioLanguage: body.audio_language,
        subtitleLanguage: body.subtitle_language,
        subtitleMethod: body.subtitle_method,
        bufferHealthMs:
            body.buffer_health_sec === undefined
                ? undefined
                : Math.round(body.buffer_health_sec * 1000),
        adaptive: body.adaptive,
        sessionElapsedMs: body.session_elapsed_ms,
    };
}

/**
 * Transcode progress data — alias of the schema-derived type so callers
 * importing from this module keep a stable surface.
 */
export type TranscodeProgressData = TranscodeProgressPayload;

export interface PlaySessionReporterConfig extends ProgressReporterConfig {
    capabilities?: PlaybackCapabilities;
    onDelivery?: (start: PlaybackStartResponse) => void;
    /** Runs for every actual start, including implicit recovery from a failed heartbeat. */
    onBeforeStart?: (data: ProgressReportData) => void;
    /** Internal UUID of the media item (required) */
    mediaId: string;
    /** Device ID for session tracking */
    deviceId: string;
    /** Device name (optional) */
    deviceName?: string;
    /** Client name (e.g., 'Lumastra Web') */
    clientName?: string;
    /** Pre-generated session ID — ensures the reporter and HLS transcode
     *  path share a single play_sessions row instead of creating duplicates. */
    sessionId?: string;
    /** Jellyfin item ID — passed when the playback's external item ID differs
     *  from the internal UUID, so the server can correlate sessions for
     *  Jellyfin-synced items. */
    jellyfinItemId?: string;
    /** Jellyfin media source ID — companion to `jellyfinItemId` when known. */
    jellyfinMediaSourceId?: string;
    /** Selected file from the side-effect-free probe. */
    fileId?: string;
    /** Actual method, used only for diagnostic heartbeats. */
    selectedMethod?: string;
    /** Explicit user choice or logged fallback after a real playback failure. */
    requestedMethod?: PlayMethod;
    /** Called when session is remotely killed by admin */
    onKill?: (reason: string) => void;
    /** Called when session start is refused by a server-side policy check
     *  (422 stream_limit/transcode_not_allowed/ip_restricted/
     *  source_incompatible). `kind` is the policy identifier the server
     *  returned; `message` is a ready-to-display, user-friendly string.
     *  Falls back to `onError` when not provided. */
    onPolicyBlocked?: (info: { kind: string; message: string }) => void;
    /** How the viewer opened this playback, read at every session start
     *  (watch-entry.ts). `explicit` keeps the session out of resume-handoff chains. */
    getEntry?: () => WatchEntry | undefined;
    /** Called when this session has been superseded by a newer one (same
     *  user, same media, same device — typically another tab or a fresh
     *  launch). The player should pause; the reporter shows the action toast. */
    onSupersede?: () => void;
    /** Called when transcode progress is received from the server */
    onTranscodeProgress?: (progress: TranscodeProgressData | null) => void;
    /** Called on every successful heartbeat ack (200 response) with the
     *  durable resume anchor and whether the server wrote it to durable
     *  storage on this tick. Not fired for:
     *  - kill actions (early return in the kill branch)
     *  - superseded signals (guarded by !result.superseded check)
     *  - normal COMPLETED stops (server returns 204 for those)
     *  - COMPLETED stops that trigger a kill (handled by the kill branch) */
    onHeartbeatAck?: (info: HeartbeatAckInfo) => void;
    /** Called after the reporter re-registered its session because the server
     *  no longer had it (reaped, expired or ended) — not for a stop's
     *  carrier session, and not for the initial start. */
    onSessionRestarted?: () => void;
    /** Called when a session request answered 401: the browser session may
     *  be gone (see session-reauth.ts). The player decides whether it is. */
    onAuthLost?: () => void;
    /** Adaptive (ABR) state for the heartbeat's `adaptive` block, or undefined
     *  when playback is not adaptive. Display-only on the server. */
    getAdaptiveReport?: () => SessionAdaptiveReport | undefined;
}

export interface HeartbeatAckInfo {
    resume_anchor_epoch_ms: number | null;
    wrote_to_durable: boolean;
}

/** How often the transcode progress readout refreshes between heartbeats. */
const TRANSCODE_PROGRESS_POLL_MS = 4_000;
/** Back-off ceiling for a progress endpoint that keeps failing. */
const TRANSCODE_PROGRESS_MAX_POLL_MS = 30_000;

// Show error toast only after this many ms of consecutive transient (5xx) failures.
// Covers normal deploy windows (~30-60s) without alarming the user.
const TRANSIENT_ERROR_GRACE_MS = 90_000;

export class PlaySessionReporter implements IProgressReporter {
    private config: PlaySessionReporterConfig;
    private sessionId: string | null = null;
    private stopGrantRenewal?: () => void;
    private startResult: PlaybackStartResponse | null = null;
    private starting: Promise<boolean> | null = null;
    private eventSeq = 0;
    private contextGeneration = 0;
    private startingGeneration = -1;
    private pendingRetirements = new Map<string, number>();
    private retirementPromise: Promise<boolean> | null = null;
    /**
     * The session id `eventSeq` is currently counting for.
     *
     * The server keeps `last_event_seq` per session and drops any progress
     * event that is not ahead of it, so the counter may only restart when the
     * session id genuinely changes. A re-registration of the SAME id (see
     * restartSessionAndResend, which fires on any failed update — a transient
     * 5xx, or a 404/410 from a reaped session) must keep counting: restarting
     * at 0 there makes every subsequent event look stale until the counter
     * climbs back past its old value, silently wedging progress/resume
     * reporting for dozens of heartbeats (prod 2026-07-29: "Rejected stale
     * lumastra-player progress event {incomingSeq: 1, currentSeq: 39}").
     */
    private seqOwnerSessionId: string | null = null;
    private sseAbortController: AbortController | null = null;
    /** Pending poll of GET /transcode-progress — see deliverTranscodeProgress. */
    private transcodePollTimer: ReturnType<typeof setTimeout> | null = null;
    /** Bumped on every delivery and on cleanup: a poll response that arrives
     *  after either is stale (a newer heartbeat reading, or a torn-down
     *  reporter) and is dropped. */
    private transcodeEpoch = 0;
    private transcodePollFailures = 0;
    private firstTransientFailureAt: number | null = null;
    private supersededWarningShown = false;
    /**
     * Terminal latch — set when this reporter has been informed it was
     * superseded (via SSE push or the heartbeat backstop). Once set,
     * `report()` returns false for every event including the implicit
     * restart path. Without this, the next pause/keepalive/stop event would
     * hit `if (!sessionId) restartSessionAndResend` and POST a brand-new
     * session, which would then kill the new owner via the kill-prior
     * transaction. Reset only by creating a fresh reporter (i.e. a full
     * page reload via the toast button).
     */
    private superseded = false;

    constructor(config: PlaySessionReporterConfig) {
        this.config = config;
        // The session id is pre-generated by the caller and shared with the HLS
        // transcode path, so the counter starts counting for it immediately —
        // before startSession() ever runs. Claim ownership here or the first
        // re-registration would look like a new id and reset the sequence.
        this.seqOwnerSessionId = config.sessionId ?? null;
    }

    private nextSeq(): number {
        return ++this.eventSeq;
    }

    async report(eventType: ProgressEventType, data: ProgressReportData): Promise<boolean> {
        // Terminal: once superseded, the reporter is dead until a fresh
        // page load. Blocking every event (start, progress, stop) prevents
        // the implicit restart path from POSTing a new session that would
        // then kill the new owner's row.
        if (this.superseded) return false;
        if (eventType === 'start') {
            if (this.sessionId) return true;
            const generation = this.contextGeneration;
            if (this.starting) {
                if (this.startingGeneration === generation) return this.starting;
                // Finish/retire the old start before creating a session in the new context.
                await this.starting;
                if (generation !== this.contextGeneration || this.superseded) return false;
                return this.report('start', data);
            }
            this.startingGeneration = generation;
            const pending = this.startSession(data, generation).finally(() => {
                if (this.starting === pending) this.starting = null;
            });
            this.starting = pending;
            return pending;
        }
        // Guard BEFORE incrementing eventSeq — otherwise a report() call that
        // races setSessionId() advances the counter and leaves a permanent gap
        // in the server-side sequence.
        if (!this.sessionId) {
            return this.restartSessionAndResend(eventType, data);
        }

        if (eventType === 'stop') {
            this.cleanup();
        }

        const generation = this.contextGeneration;
        const updated = await this.update(this.buildUpdateBody(eventType, data));
        if (generation !== this.contextGeneration) return updated;

        // Retry stop the same way progress does: a completion report that
        // lands on an already-reaped/dead session (404/410) or hits a
        // transient failure during a restart must not be silently dropped —
        // that's exactly what leaves an episode frozen mid-progress when a
        // heartbeat-killed session's terminal COMPLETED report has nowhere
        // to land. Restarting a session for a 'stop' creates a short-lived
        // play_sessions row purely to carry the completion write; harmless,
        // since handleStop() only persists durable state when the position
        // genuinely crossed the engagement/completion gate.
        if (!updated) {
            return this.restartSessionAndResend(eventType, data);
        }

        return updated;
    }

    private buildUpdateBody(
        eventType: ProgressEventType,
        data: ProgressReportData,
    ): PlaybackReport {
        // positionMs must be a non-negative integer (PlaybackReportSchema), but
        // a video element can briefly report a small negative currentTime before
        // the first frame — clamp so the PATCH never 400s and drops the session.
        const currentMs = Number.isFinite(data.currentTime)
            ? Math.max(0, Math.round(data.currentTime * 1000))
            : 0;
        return {
            positionMs: currentMs,
            status: eventType === 'stop' ? 'COMPLETED' : data.isPaused ? 'PAUSED' : 'ACTIVE',
            eventSeq: this.nextSeq(),
            endReason: eventType === 'stop' ? (data.endReason ?? 'user') : undefined,
            audioStreamIndex: omitNegativeIndex(data.audioStreamIndex),
            subtitleStreamIndex: omitNegativeIndex(data.subtitleStreamIndex),
            audioLanguage: data.audioLanguage,
            subtitleLanguage: data.subtitleLanguage,
            subtitleMethod: data.subtitleMethod,
            // Mid-playback quality switches (audio-only chief among them) never
            // re-run startSession, so play_method must ride the heartbeat too or
            // the row keeps whatever method the session started with. The server
            // COALESCEs this in (updateHeartbeat), so omitting it here is also
            // safe — this just keeps the row honest without a session restart.
            playMethod: toPlayMethodOrDefault(this.config.selectedMethod ?? data.playMethod),
            bufferHealthMs:
                data.bufferHealthSec === undefined
                    ? undefined
                    : Math.round(data.bufferHealthSec * 1000),
            adaptive: eventType === 'stop' ? undefined : this.adaptiveReport(),
            // The session contract requires this on every update. Zero is the
            // explicit "no verified active playback yet" value.
            sessionElapsedMs:
                typeof data.sessionElapsedMs === 'number' && Number.isFinite(data.sessionElapsedMs)
                    ? Math.max(0, Math.round(data.sessionElapsedMs))
                    : 0,
        };
    }

    private adaptiveReport(): SessionAdaptiveReport | undefined {
        try {
            return this.config.getAdaptiveReport?.();
        } catch {
            // best-effort: a display-only field must never cost the heartbeat.
            return undefined;
        }
    }

    private async restartSessionAndResend(
        eventType: ProgressEventType,
        data: ProgressReportData,
    ): Promise<boolean> {
        const generation = this.contextGeneration;
        this.sessionId = null;
        // Recovery knows a delivered position, including zero. Initial startup
        // can still omit its position and let the server choose an entry point.
        if (this.startResult) this.setStartPosition(data.currentTime);
        const started = await this.report('start', data);
        if (generation !== this.contextGeneration || !started || !this.sessionId) return false;
        if (eventType !== 'stop') this.config.onSessionRestarted?.();
        else this.cleanup();
        return this.update(this.buildUpdateBody(eventType, data));
    }

    /** Update the pre-generated session ID (e.g., after a quality restart
     *  generates a new playSessionId in the player store). */
    setSessionId(id: string | undefined): void {
        if (this.sessionId) this.pendingRetirements.set(this.sessionId, this.eventSeq + 1);
        this.cleanup();
        this.config.sessionId = id;
        this.sessionId = null;
        this.startResult = null;
        this.stopGrantRenewal?.();
        this.eventSeq = 0;
        this.seqOwnerSessionId = id ?? null;
    }

    /** The currently-active session id, or null when no session is in
     *  flight. Read-only accessor for callers that need to advertise the
     *  session externally (e.g. SameBrowserChannel.setActive). */
    getSessionId(): string | null {
        return this.sessionId;
    }

    /** Repoint the reporter at a new media item — used when advancing to a
     *  new episode in place (audio-only mode) without a full page
     *  navigation, where this same reporter instance is reused across items
     *  instead of being recreated. Callers must end the current session
     *  (report('stop', ...) / endCurrentSession) before switching identity,
     *  or the in-flight session would be misattributed to the new item. */
    setItemIdentity(identity: {
        mediaId: string;
        jellyfinItemId?: string;
        jellyfinMediaSourceId?: string;
    }): void {
        if (this.config.mediaId !== identity.mediaId) this.setSessionId(undefined);
        this.config.mediaId = identity.mediaId;
        this.config.jellyfinItemId = identity.jellyfinItemId;
        this.config.jellyfinMediaSourceId = identity.jellyfinMediaSourceId;
    }

    /** Keep file selection separate from delivery-method overrides. */
    setLumastraContext(context: { fileId?: string }): void {
        if (this.config.fileId !== context.fileId) this.setSessionId(undefined);
        this.config.fileId = context.fileId;
    }

    /** Actual delivery method, for heartbeat diagnostics only. */
    setSelectedMethod(method: string | undefined): void {
        this.config.selectedMethod = method;
    }

    /** Only callers with an explicit choice or playback failure may override the planner. */
    setRequestedMethod(method: PlayMethod | undefined): void {
        this.config.requestedMethod = method;
    }

    setCapabilities(capabilities: PlaybackCapabilities): void {
        this.config.capabilities = capabilities;
    }

    getStartResult(): PlaybackStartResponse | null {
        return this.startResult;
    }

    private startPositionMs: number | undefined;

    setStartPosition(seconds: number | undefined): void {
        this.startPositionMs =
            seconds === undefined ? undefined : Math.max(0, Math.round(seconds * 1000));
    }

    private async startSession(data: ProgressReportData, generation: number): Promise<boolean> {
        this.sessionId = null;

        try {
            if (this.pendingRetirements.size > 0 && !(await this.retirePendingSessions()))
                return false;
            if (generation !== this.contextGeneration) return false;
            const requestedMethod = this.config.requestedMethod;
            const body = {
                mediaId: this.config.mediaId,
                deviceId: this.config.deviceId,
                clientInfo: {
                    name: this.config.deviceName,
                    client: this.config.clientName ?? 'Lumastra Web',
                },
                capabilities: this.config.capabilities ?? {
                    containers: ['mp4'],
                    videoCodecs: ['h264'],
                    audioCodecs: ['aac'],
                    subtitleFormats: ['vtt'],
                    hdr: [],
                },
                ...(requestedMethod ? { requestedMethod } : {}),
                fileId: this.config.fileId,
                audioStreamIndex: omitNegativeIndex(data.audioStreamIndex),
                subtitleId:
                    requestedMethod === 'audio_only'
                        ? 'none'
                        : (data.subtitleId ??
                          (data.subtitleStreamIndex == null || !this.config.fileId
                              ? 'none'
                              : `${this.config.fileId}:${data.subtitleStreamIndex}`)),
                startPositionMs:
                    this.startPositionMs ??
                    (data.currentTime > 0 ? Math.round(data.currentTime * 1000) : undefined),
                // Every start names it, restarts included: an explicit pick stays
                // out of resume-handoff chains across quality switches and rebuilds.
                entry: this.config.getEntry?.(),
            };

            this.config.onBeforeStart?.(data);
            const { data: result, error, code, status, details } = await startPlaySession(body);

            if (generation !== this.contextGeneration || this.superseded) {
                if (result?.playbackSessionId) {
                    this.pendingRetirements.set(result.playbackSessionId, 1);
                    await this.retirePendingSessions();
                }
                return false;
            }
            if (status === 401) this.config.onAuthLost?.();

            if (status === 422) {
                const kind = code ?? 'source_incompatible';
                const message = describePolicyRefusal(kind, details);
                if (this.config.onPolicyBlocked) {
                    this.config.onPolicyBlocked({ kind, message });
                } else {
                    this.config.onError?.(message);
                }
                return false;
            }

            // Transient server errors (deploy/restart window): silently retry via
            // the progress-heartbeat loop. Only alert the user if the outage lasts
            // longer than the grace period (clearly not a normal deploy).
            if (status === 502 || status === 503 || status === 504) {
                const now = Date.now();
                if (this.firstTransientFailureAt === null) {
                    this.firstTransientFailureAt = now;
                } else if (now - this.firstTransientFailureAt > TRANSIENT_ERROR_GRACE_MS) {
                    this.config.onError?.(`Session reporting unavailable (${status})`);
                }
                return false;
            }

            if (status === 403 && error === 'kicked') {
                this.config.onError?.('Kicked by admin. Please wait a moment before trying again.');
                return false;
            }

            if (error || !result) {
                this.config.onError?.(`Session reporting unavailable (${status})`);
                return false;
            }

            if (!result.playbackSessionId) {
                this.config.onError?.('Server returned no session ID');
                return false;
            }

            // Session created — if we showed an error during a prolonged outage,
            // let the user know things are back to normal.
            if (this.firstTransientFailureAt !== null) {
                this.config.onWarning?.('Session reporting restored');
            }
            this.firstTransientFailureAt = null;
            this.sessionId = result.playbackSessionId;
            this.config.sessionId = result.playbackSessionId;
            if (this.seqOwnerSessionId !== result.playbackSessionId) this.eventSeq = 0;
            this.seqOwnerSessionId = result.playbackSessionId;
            this.startResult = result;
            this.startPositionMs = undefined;
            if ('playMethod' in result.delivery && result.delivery.playMethod) {
                this.config.selectedMethod = result.delivery.playMethod;
            }
            this.stopGrantRenewal?.();
            this.stopGrantRenewal = maintainPlaybackGrant(result, () =>
                this.config.onDelivery?.(result),
            );
            this.config.onDelivery?.(result);

            // Subscribe to kill events
            this.subscribeToKillEvents(result.playbackSessionId);

            return true;
        } catch {
            if (generation !== this.contextGeneration) return false;
            // best-effort: network failure surfaced to the UI via onError; caller branches on the false return.
            this.config.onError?.('Session reporting unavailable: network error');
            return false;
        }
    }

    /** Clears sessionId and resets transcode progress after a successful
     *  COMPLETED update, regardless of whether the response was 204 or 200. */
    private finalizeOnCompletion(body: PlaybackReport): void {
        if (body.status === 'COMPLETED') {
            this.deliverTranscodeProgress(null);
            this.sessionId = null;
        }
    }

    private async update(body: PlaybackReport): Promise<boolean> {
        if (!this.sessionId) return false;
        const sessionId = this.sessionId;
        const generation = this.contextGeneration;

        try {
            // 204 = COMPLETED stop without a kill action — typed client returns
            // data: null, error: null, status: 204.
            // 200 = JSON ack (heartbeat / kill / superseded / transcode).
            // Fail statuses (404/410/etc.) surface as error non-null.
            const {
                data: result,
                error,
                status,
            } = await apiPut(
                `/api/play-sessions/${sessionId}`,
                // The schema must accept null (204 No Content path).
                SessionHeartbeatResponseSchema.nullable(),
                body,
            );

            if (generation !== this.contextGeneration || sessionId !== this.sessionId) return false;
            if (status === 204 || (status === 200 && result === null)) {
                this.finalizeOnCompletion(body);
                return true;
            }

            if (error !== null) {
                // A final stop has nothing left to resume, so a 401 there is
                // not worth reloading the page for.
                if (status === 401 && body.status !== 'COMPLETED') this.config.onAuthLost?.();
                // Session gone (404) or already stopped — no point retrying via beacon
                if (body.status === 'COMPLETED' && status === 404) {
                    this.sessionId = null;
                }
                if (status === 404 || status === 410) {
                    this.sessionId = null;
                }
                return false;
            }

            if (!result) {
                return false;
            }

            if (result.action === 'kill') {
                this.sessionId = null;
                if (result.reason === 'session_ended') {
                    return false;
                }
                this.cleanup();
                this.config.onKill?.(result.reason ?? 'admin');
                // Kill is a terminal signal — don't fire heartbeat ack
                return true;
            }

            if (result.action === 'superseded') {
                // Two paths land here:
                //   1. Backstop: the SSE push was missed, but the next
                //      heartbeat hit a row killed with reason 'superseded'.
                //   2. Cross-clientInfo: the row is still ACTIVE/PAUSED but
                //      shouldAcceptLumastraProgressEvent rejected the event.
                // Treat both identically — the user always sees the same
                // toast, and the player auto-pauses.
                this.sessionId = null;
                // reason 'session_superseded' is the cross-device case
                // (handleHeartbeat sets that), 'superseded' is the
                // same-device backstop case.
                const scope = result.reason === 'session_superseded' ? 'other_device' : 'same_tab';
                this.fireSuperseded(scope, result.deviceName);
                return true;
            }

            // Existing cleanup that previously only ran on 204 — now also
            // runs on 200-success so COMPLETED stops still drop sessionId
            // and reset transcode progress regardless of response shape.
            this.finalizeOnCompletion(body);

            // Forward the ack to PlayerController. Skip if the server didn't
            // include the field (older server / mid-rollout) or this is a
            // superseded response — superseded is a terminal signal, not a
            // normal heartbeat write.
            if (!result.superseded && typeof result.progressSaved === 'boolean') {
                const anchorMs =
                    result.resumeAnchorAt === null ? NaN : Date.parse(result.resumeAnchorAt);
                this.config.onHeartbeatAck?.({
                    resume_anchor_epoch_ms: Number.isFinite(anchorMs) ? anchorMs : null,
                    wrote_to_durable: result.progressSaved,
                });
            }

            // Absent = no transcode serves this session (any more) — clear the
            // readout instead of leaving the last one frozen on screen.
            this.deliverTranscodeProgress(result.transcode ?? null);
            return true;
        } catch {
            /* expected: network error during session progress update — non-fatal */
            return false;
        }
    }

    private retirePendingSessions(): Promise<boolean> {
        if (this.retirementPromise) return this.retirementPromise;
        const pending = (async (): Promise<boolean> => {
            for (const [sessionId, eventSeq] of this.pendingRetirements) {
                let retired = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        const result = await apiPut(
                            `/api/play-sessions/${sessionId}`,
                            SessionHeartbeatResponseSchema.nullable(),
                            {
                                positionMs: 0,
                                status: 'COMPLETED',
                                eventSeq,
                                endReason: 'switch',
                                sessionElapsedMs: 0,
                            },
                        );
                        if (
                            (result.status >= 200 && result.status < 300) ||
                            result.status === 404 ||
                            result.status === 410
                        ) {
                            retired = true;
                            break;
                        }
                    } catch {
                        /* keep ownership for the bounded retry and next start */
                    }
                    if (attempt < 2)
                        await new Promise<void>((resolve) =>
                            setTimeout(resolve, 100 * 2 ** attempt),
                        );
                }
                if (!retired) return false;
                if (this.pendingRetirements.get(sessionId) === eventSeq)
                    this.pendingRetirements.delete(sessionId);
            }
            return true;
        })().finally(() => {
            if (this.retirementPromise === pending) this.retirementPromise = null;
        });
        this.retirementPromise = pending;
        return pending;
    }

    private subscribeToKillEvents(sessionId: string): void {
        this.sseAbortController?.abort();
        this.sseAbortController = new AbortController();
        const signal = this.sseAbortController.signal;
        const generation = this.contextGeneration;
        const isCurrent = (): boolean =>
            !signal.aborted &&
            generation === this.contextGeneration &&
            sessionId === this.sessionId;

        fetch(`/api/play-sessions/${sessionId}/events`, { signal })
            .then(async (res) => {
                if (!isCurrent() || !res.ok || !res.body) return;
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done || !isCurrent()) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';
                    for (const line of lines) {
                        if (!isCurrent()) break;
                        if (line.startsWith('data: ')) {
                            try {
                                const event = JSON.parse(line.slice(6)) as {
                                    type?: string;
                                    reason?: string;
                                };
                                if (event.type === 'kill') {
                                    this.cleanup();
                                    this.config.onKill?.(event.reason ?? 'admin');
                                    this.sessionId = null;
                                } else if (event.type === 'session_terminated') {
                                    // Currently only 'superseded' is published —
                                    // see play-session-events.service.ts. Future
                                    // reasons would need their own UX path.
                                    if (event.reason === 'superseded') {
                                        this.sessionId = null;
                                        this.fireSuperseded('same_tab');
                                    }
                                } else if (
                                    event.type === 'admin_message' ||
                                    event.type === 'maintenance_notice' ||
                                    event.type === 'maintenance_cleared'
                                ) {
                                    // This reader IS the session channel, so
                                    // it can answer "is this targeted at me?"
                                    // exactly. The device id is passed too so a
                                    // device-targeted message with no play
                                    // session still lands.
                                    handleAdminEvent(event, {
                                        playSessionId: this.sessionId,
                                        deviceId: this.config.deviceId,
                                    });
                                }
                            } catch {
                                // Ignore malformed SSE data
                            }
                        }
                    }
                }
            })
            .catch(() => {}); // Ignore abort errors
    }

    updateViaBeacon(body: Omit<SessionUpdate, 'event_seq'>): boolean {
        if (!this.sessionId || typeof navigator === 'undefined' || !navigator.sendBeacon)
            return false;
        const payload: SessionUpdate = { ...body, event_seq: this.nextSeq() };
        return navigator.sendBeacon(
            apiUrl('internal', `/play-sessions/${this.sessionId}/beacon`),
            new Blob([JSON.stringify(toPlaybackReport(payload))], { type: 'application/json' }),
        );
    }

    /**
     * Show the supersede action toast and ask the player to pause. Idempotent
     * within a reporter instance (the supersededWarningShown guard prevents
     * duplicate toasts when SSE and the heartbeat backstop both fire). Reset
     * naturally on a fresh page load — a reload via the toast button creates
     * a new reporter instance with a clean guard.
     */
    private fireSuperseded(
        scope: 'same_tab' | 'other_device' = 'same_tab',
        deviceName?: string,
    ): void {
        // Latch first — every subsequent report() must be a no-op so the
        // next progress/stop tick doesn't bypass the supersede via
        // restartSessionAndResend and POST a fresh session.
        this.superseded = true;
        // Drop the SSE subscription too — the row is gone, no more events
        // are coming. Without this we'd hold an open fetch indefinitely.
        this.cleanup();

        // Always pause first — auto-pause is the part the user feels.
        // Pausing on every signal (even when the toast is already showing)
        // is safe; pause is idempotent.
        this.config.onSupersede?.();

        if (this.supersededWarningShown) return;
        this.supersededWarningShown = true;

        const message =
            scope === 'same_tab'
                ? m.player_session_superseded_same_tab()
                : deviceName
                  ? m.player_session_superseded_other_device({ deviceName })
                  : m.player_session_superseded_other_device_unnamed();
        toasts.warning(message, {
            timeout: 0,
            ariaLive: 'polite',
            action: {
                label: m.toast_reload(),
                onClick: () => location.reload(),
            },
        });
    }

    /**
     * Hand transcode progress to the player and keep it fresh. Heartbeats only
     * run every 30 s, so while a transcode is still moving the reporter polls
     * the progress endpoint in between; a finished (or absent) one stops it.
     */
    private deliverTranscodeProgress(progress: TranscodeProgressData | null): void {
        this.transcodeEpoch++;
        this.config.onTranscodeProgress?.(progress);
        // A finished transcode no longer changes; a throttle-paused one will.
        if (progress && !isTranscodeFinished(progress)) {
            this.scheduleTranscodePoll();
        } else {
            this.stopTranscodePoll();
        }
    }

    private scheduleTranscodePoll(): void {
        if (this.transcodePollTimer !== null) return;
        const delay = Math.min(
            TRANSCODE_PROGRESS_MAX_POLL_MS,
            TRANSCODE_PROGRESS_POLL_MS * 2 ** this.transcodePollFailures,
        );
        this.transcodePollTimer = setTimeout(() => {
            this.transcodePollTimer = null;
            void this.pollTranscodeProgress();
        }, delay);
    }

    private stopTranscodePoll(): void {
        if (this.transcodePollTimer !== null) clearTimeout(this.transcodePollTimer);
        this.transcodePollTimer = null;
    }

    private async pollTranscodeProgress(): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        // Nobody can see the badge in a background tab: skip the request but
        // keep the timer, so the readout is fresh again right after return.
        if (typeof document !== 'undefined' && document.hidden) {
            this.scheduleTranscodePoll();
            return;
        }
        const epoch = this.transcodeEpoch;
        const { data, error, status } = await apiGet(
            `/api/play-sessions/${sessionId}/transcode-progress`,
            TranscodeProgressResponseSchema,
        );
        // Torn down, session rolled over, or a heartbeat delivered a newer
        // reading while this request was in flight.
        if (epoch !== this.transcodeEpoch || this.sessionId !== sessionId) return;
        if (error !== null || !data) {
            // Gone (404) or not allowed (401/403) will not get better by
            // asking again; anything else backs off. The next heartbeat
            // carrying a transcode restarts the poll either way.
            if (status === 401) this.config.onAuthLost?.();
            if (status === 401 || status === 403 || status === 404) return;
            this.transcodePollFailures++;
            this.scheduleTranscodePoll();
            return;
        }
        this.transcodePollFailures = 0;
        this.deliverTranscodeProgress(data.transcode);
    }

    cleanup(): void {
        // Pending starts may finish after unmount/stop; they must retire, never revive resources.
        this.contextGeneration++;
        this.stopGrantRenewal?.();
        this.stopGrantRenewal = undefined;
        this.sseAbortController?.abort();
        this.sseAbortController = null;
        this.stopTranscodePoll();
        this.transcodeEpoch++;
    }
}
