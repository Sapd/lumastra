// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Flush trigger, throttle, budget, and dedup logic for playback incident
 * reporting. Healthy sessions never call `post` — nothing fires until
 * reportError/reportReconnect/reportTerminal is invoked.
 *
 * Budget: <=4 non-terminal flushes + 1 always-flushed terminal, counted per
 * attempt (this class is one instance per playback attempt — the caller is
 * responsible for constructing a fresh instance per new attemptId, NOT per
 * play_session_id, since a reconnect renews the session id but must not
 * reset this budget).
 *
 * Dedup: an error with the same (errorType, stage, httpStatus) as the most
 * recently sent flush, within DEDUP_WINDOW_MS, does not count as a second
 * trigger — a single underlying failure reported twice by HLS.js in quick
 * succession must not burn two budget slots.
 */

import type { IncidentRingBuffer } from './incident-buffer.js';

const NON_TERMINAL_BUDGET = 4;
const DEDUP_WINDOW_MS = 15_000;

export interface IncidentErrorDetail {
    errorType: string;
    stage?: string;
    httpStatus?: number;
    serverDiagnosticCode?: string;
    message?: string;
}

/**
 * What the player knew at the moment it gave up, for a terminal incident.
 *
 * All optional: a terminal report must never be blocked on having a diagnosis.
 * But when the cause IS known it has to travel — a terminal incident is the one
 * users actually experience ("reload the page"). Without error_type/stage/message,
 * a stored report cannot distinguish a stall-driven give-up from a dead manifest.
 *
 * `errorType` is intentionally absent: the wire schema constrains it to real
 * failure classes (network/media/fatal/decode/session_expired), and "the retry
 * budget ran out" is not one of those — it travels in `message` instead.
 */
export interface IncidentTerminalDetail {
    /** The cause that drove the recovery attempts that just failed. */
    reconnectCause?: string;
    /** Request stage of the last classified failure, when one was seen. */
    stage?: string;
    /** Short human reason, e.g. the TerminalReason that ended the ladder. */
    message?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface IncidentReporterOptions {
    attemptId: string;
    buffer: IncidentRingBuffer;
    /** Stable per-install device id, sent verbatim with every flush so an
     *  incident can be attributed to the device that produced it. */
    deviceId: string;
    /**
     * Internal media id, captured with every failure for admin forensics.
     * A GETTER for the same reason as clientInfo: the controller can move to
     * another item without rebuilding the reporter. Only a canonical UUID is
     * sent — the ingest schema types `mediaId` as `z.string().uuid()`, so any
     * other shape would 422 the WHOLE report and lose the incident.
     */
    mediaId?: () => string | undefined;
    /**
     * Evaluated at FLUSH time, not captured at construction: the fields worth
     * recording (playMethod above all) change during a session — a value
     * snapshotted in the constructor would report the method the attempt
     * STARTED with, which is exactly the wrong one when a fallback is what
     * broke.
     */
    clientInfo?: () => Record<string, unknown>;
    post: (body: Record<string, unknown>) => Promise<void>;
    patchResolve: (body: { attemptId: string }) => Promise<void>;
    beacon: (body: Record<string, unknown>) => void;
    now?: () => number;
}

export class IncidentReporter {
    private readonly attemptId: string;
    private readonly buffer: IncidentRingBuffer;
    private readonly deviceId: string;
    private readonly mediaId?: () => string | undefined;
    private readonly clientInfo?: () => Record<string, unknown>;
    private readonly post: (body: Record<string, unknown>) => Promise<void>;
    private readonly patchResolve: (body: { attemptId: string }) => Promise<void>;
    private readonly beacon: (body: Record<string, unknown>) => void;
    private readonly now: () => number;

    private nonTerminalFlushCount = 0;
    private everFlushed = false;
    private terminalReported = false;
    // Idempotency for the unload beacon, mirroring terminalReported: the
    // player wires BOTH `pagehide` and `beforeunload` to the same teardown
    // handler, so a single tab-close calls onPageHide() twice and would
    // otherwise post two identical terminal incidents.
    private pageHideBeaconed = false;
    // Set true by reportRecovered(), cleared by any subsequent flush (error/
    // reconnect/terminal) — lets onPageHide() distinguish "ended healthy
    // after a recovered error" from "still broken", so a tab close well
    // after a successful reconnect doesn't beacon a spurious terminal
    // incident for a session that actually ended fine.
    private recoveredSinceLastFlush = false;
    private lastFlushKey: string | null = null;
    // The unload beacon has no session id of its own to send, but every
    // earlier flush named one. Remembering the last non-empty id keeps the
    // beacon correlatable even when the unload event has no session id.
    private lastPlaySessionId = '';
    private lastFlushAt = 0;

    constructor(opts: IncidentReporterOptions) {
        this.attemptId = opts.attemptId;
        this.buffer = opts.buffer;
        this.deviceId = opts.deviceId;
        this.mediaId = opts.mediaId;
        this.clientInfo = opts.clientInfo;
        this.post = opts.post;
        this.patchResolve = opts.patchResolve;
        this.beacon = opts.beacon;
        this.now = opts.now ?? Date.now;
    }

    reportReconnect(playSessionId: string, cause: string): void {
        // Must be called by the caller BEFORE the session id is renewed —
        // see player-controller.svelte.ts's onStateChange('recovering')
        // wiring, which fires synchronously before any async rebuild.
        //
        // Dedup'd the same way as reportError — a burst of reconnect
        // attempts for the same cause in quick succession (e.g. a flapping
        // connection retrying every few hundred ms) must not each consume a
        // slot from the 4-flush non-terminal budget.
        const key = this.buildDedupKey(['reconnect', cause]);
        if (this.isDuplicate(key)) return;
        this.flush(playSessionId, {
            triggerType: 'reconnect',
            reconnectCause: cause,
        });
    }

    reportError(playSessionId: string, error: IncidentErrorDetail): void {
        const key = this.buildDedupKey([
            'error',
            error.errorType,
            error.stage ?? '',
            error.httpStatus ?? '',
        ]);
        if (this.isDuplicate(key)) return; // Coalesced — not a new trigger.
        this.flush(playSessionId, {
            triggerType: 'error',
            errorType: error.errorType,
            stage: error.stage,
            httpStatus: error.httpStatus,
            serverDiagnosticCode: error.serverDiagnosticCode,
            message: error.message,
        });
    }

    reportTerminal(playSessionId: string, detail?: IncidentTerminalDetail): void {
        // Idempotent — a terminal report from an unrecoverable-error handler
        // AND a teardown/unmount path both firing for the same attempt must
        // not post a duplicate terminal incident. Always flushes on the
        // first call — not subject to the non-terminal budget.
        if (this.terminalReported) return;
        this.terminalReported = true;
        this.everFlushed = true;
        this.recoveredSinceLastFlush = false;
        void this.post(
            this.buildBody(playSessionId, {
                triggerType: 'terminal',
                // Spread-if-present, never explicit undefined keys: the wire
                // schema treats a field as absent only when it is missing.
                ...(detail?.reconnectCause ? { reconnectCause: detail.reconnectCause } : {}),
                ...(detail?.stage ? { stage: detail.stage } : {}),
                ...(detail?.message ? { message: detail.message } : {}),
            }),
        ).catch(() => {
            // Best-effort — a failed report must never surface to the player.
        });
    }

    reportRecovered(): void {
        this.recoveredSinceLastFlush = true;
        void this.patchResolve({ attemptId: this.attemptId }).catch(() => {
            // Best-effort — a failed report must never surface to the player.
        });
    }

    onPageHide(): void {
        if (!this.everFlushed || this.recoveredSinceLastFlush) return;
        if (this.pageHideBeaconed) return;
        this.pageHideBeaconed = true;
        // The last session id an earlier flush reported. Still '' when no
        // flush carried one (the very first request failed before a session
        // existed) — the schema accepts that: an incident that correlates to
        // nothing is worth more than one the server rejects.
        this.beacon(this.buildBody(this.lastPlaySessionId, { triggerType: 'terminal' }));
    }

    /** Builds a dedup key that can't collide across differently-shaped inputs —
     *  JSON-encoding (rather than plain `|`-joining) means a value containing
     *  '|' can never be mistaken for a field boundary. */
    private buildDedupKey(parts: Array<string | number>): string {
        return JSON.stringify(parts);
    }

    private isDuplicate(key: string): boolean {
        if (key === this.lastFlushKey && this.now() - this.lastFlushAt < DEDUP_WINDOW_MS) {
            return true;
        }
        this.lastFlushKey = key;
        this.lastFlushAt = this.now();
        return false;
    }

    private flush(playSessionId: string, extra: Record<string, unknown>): void {
        if (this.nonTerminalFlushCount >= NON_TERMINAL_BUDGET) return;
        this.nonTerminalFlushCount++;
        this.everFlushed = true;
        this.recoveredSinceLastFlush = false;
        void this.post(this.buildBody(playSessionId, extra)).catch(() => {
            // Best-effort — a failed report must never surface to the player.
        });
    }

    private buildBody(
        playSessionId: string,
        extra: Record<string, unknown>,
    ): Record<string, unknown> {
        if (playSessionId) this.lastPlaySessionId = playSessionId;
        const mediaId = this.mediaId?.();
        return {
            attemptId: this.attemptId,
            playSessionId,
            incidentAt: this.now(),
            deviceId: this.deviceId,
            ...(mediaId && UUID_PATTERN.test(mediaId) ? { mediaId } : {}),
            // Called here rather than read from a stored value — see the
            // option's doc comment: a stale snapshot misreports playMethod.
            clientInfo: this.clientInfo?.(),
            timeline: this.buffer.snapshot(),
            ...extra,
        };
    }
}
