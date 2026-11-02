// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure policy functions for playback reconnection.
 *
 * Kept free of any DOM/HLS dependency so they are trivially unit-testable
 * and shared between the ReconnectController and its consumers.
 */

import type { PlaybackFailureStage } from '$lib/utils/playback-diagnostics';

export interface ReconnectTuning {
    /** First backoff step. */
    baseDelayMs: number;
    /** Backoff ceiling. */
    maxDelayMs: number;
    /** Downward jitter fraction applied to each delay (0..1). */
    jitterRatio: number;
    /** How long currentTime may stop advancing (while intending to play)
     *  before we treat it as a stall. Longer than a normal short rebuffer. */
    stallTimeoutMs: number;
    /** Separate first-frame allowance: network progress and resume-position
     *  jumps must not hide a startup that never produces playable media. */
    startupTimeoutMs: number;
    /** Length of the confirmation window after a recovery attempt before we
     *  declare the connection healthy again. */
    confirmMs: number;
    /** Minimum number of progress ticks (timeupdate events) that must arrive
     *  during the confirm window to treat recovery as *sustained* — guards
     *  against a single tick followed by an immediate re-stall. */
    minConfirmTicks: number;
    /** How many consecutive confirm windows of sustained-but-UNVERIFIED
     *  progress are tolerated before trusting progress alone anyway.
     *
     *  Sustained ticks are corroborated by verified new-data arrival
     *  (notifyNetworkActivity) when possible — see verifiedActivityDuringRecovery
     *  on ReconnectController — because ticks alone can be satisfied by
     *  draining a few already-buffered seconds left over from before a
     *  session died (prod 2026-08-18: exactly this faked "recovered" within
     *  one confirmMs window). But verified activity can legitimately never
     *  fire again after a genuinely successful rebuild too — a deep
     *  pre-existing buffer (hls-config.ts maxBufferLength: up to 600s video /
     *  1800s audio) or the tail of a file needs no further fetches. Requiring
     *  verified activity as an unconditional gate would leave THAT case stuck
     *  in 'recovering' forever: continuous ticks keep re-opening a fresh
     *  confirm window before the paused retry scheduler can ever fire another
     *  attempt (see scheduleNextAttempt's clearRetry-on-every-window
     *  interaction with notifyProgress), so it can neither confirm nor exhaust
     *  the retry budget into 'terminal'. 3 consecutive windows (~9s of
     *  unbroken sustained progress, one break resets the counter) is well
     *  past the few seconds a stale buffer remnant could plausibly cover, so
     *  it stays a strong signal without a permanent hang. */
    maxUnverifiedConfirmWindows: number;
    /** Absolute ceiling on how long currentTime may go without REAL progress
     *  (notifyProgress only — never reset by notifyNetworkActivity), even if
     *  the connection is "dead-but-trickling" (e.g. the DOM 'progress' event
     *  keeps firing without genuine new bytes, masking a frozen playhead
     *  behind the stall dead-man's re-arms).
     *
     *  🔴 The old rationale ("25s = fragLoadingTimeOut 20000ms + 5s margin")
     *  was wrong, and the number is now only loosely related to the loader.
     *  hls.js retries a timed-out fragment INTERNALLY (4 timeout retries) and
     *  reports nothing to us until they are exhausted — measured on prod at
     *  ~110s end to end, not 25s. And since hls-config.ts now sets an explicit
     *  `fragLoadPolicy` (maxLoadTimeMs 120000, maxTimeToFirstByteMs 20000),
     *  there is no single "fragment timeout" to add a margin to. Treat 25s as
     *  what it actually is: the longest a frozen playhead is tolerated before
     *  we stop believing a trickling connection, chosen independently of the
     *  loader's own budget. */
    hardCeilingMs: number;
    /** Upper bound on how long a seek may suppress the stall dead-men.
     *
     *  A seek legitimately disarms both watchdogs — the playhead jumps and
     *  currentTime stops advancing while the new position buffers — and the
     *  suppression is normally lifted by the first post-seek progress tick. But
     *  on a dead stream that tick never comes, so the suppression would last
     *  forever and NO recovery could ever start. Observed in prod: a Safari
     *  session sat frozen through a segment-410 storm with zero recovery
     *  attempts until the user reloaded.
     *
     *  Generous on purpose: a server-side seek kills FFmpeg and spawns a fresh
     *  generation, and the segment handler itself waits up to 30s for the first
     *  segment of that generation. 45s clears that with margin, so this only
     *  fires on a seek that is genuinely never going to complete. */
    seekStallTimeoutMs: number;
    /** Total recovery attempts per incident before the controller gives up and
     *  goes terminal ("reload the page"). The budget resets only on SUSTAINED
     *  progress (a confirmed return to 'connected') — a single unsustained
     *  tick does not refund attempts. Hidden-tab deferrals never spend the
     *  budget. 6 = 2 cheap nudges + up to 4 full fresh-session rebuilds
     *  (≈45–60s of wall-clock backoff): if four rebuilds — each equivalent to
     *  what an F5 does — all failed, a seventh attempt will not succeed, and
     *  the user deserves actionable guidance instead of an endless spinner. */
    maxRecoverAttempts: number;
    /** Minimum wait after dispatching a fresh-session rebuild before the next
     *  attempt, unless the rebuilt source reports a failure first. The next
     *  attempt used to be armed with the plain backoff (<=10s) the moment the
     *  rebuild was dispatched, but a rebuild is an F5: stop, new session, new
     *  transcode, then two segments before `canplay`. Preprod 2026-09-30: an
     *  audio-transcode rebuild over a slow link reached `loadedmetadata` 13s
     *  after its manifest, and every rebuild was torn down mid-seek by the next
     *  one until the budget ran out — recovery that would have worked, never
     *  allowed to finish. Prod remux segments are 7–27 MB each. */
    rebuildGraceMs: number;
    /** How many more `hardCeilingMs` (or `startupTimeoutMs`) periods a frozen
     *  playhead may wait while the server says its encoder is slower than real
     *  time (another app holds the GPU encoder, a software encode). 3 x 25 s
     *  on top of the first: a 6 s segment at 0.1x takes 60 s. Reset by every
     *  real progress tick. See ReconnectControllerDeps.isStallExpected. */
    slowEncoderExtensions: number;
}

export const RECONNECT_TUNING: ReconnectTuning = {
    baseDelayMs: 1500,
    maxDelayMs: 10000,
    jitterRatio: 0.2,
    stallTimeoutMs: 6000,
    startupTimeoutMs: 60000,
    confirmMs: 3000,
    minConfirmTicks: 3,
    maxUnverifiedConfirmWindows: 3,
    hardCeilingMs: 25000,
    seekStallTimeoutMs: 45000,
    maxRecoverAttempts: 6,
    rebuildGraceMs: 25000,
    slowEncoderExtensions: 3,
};

export type Triage = 'terminal' | 'recovering';

/**
 * Exponential backoff with downward jitter, capped at `maxDelayMs`.
 * Returns a delay in `[exp * (1 - jitterRatio), exp]` where
 * `exp = min(maxDelayMs, baseDelayMs * 2^attempt)`.
 */
export function computeBackoffDelay(
    attempt: number,
    rng: () => number = Math.random,
    tuning: ReconnectTuning = RECONNECT_TUNING,
): number {
    const safeAttempt = Math.max(0, attempt);
    const exp = Math.min(tuning.maxDelayMs, tuning.baseDelayMs * 2 ** safeAttempt);
    const jittered = exp * (1 - tuning.jitterRatio + tuning.jitterRatio * rng());
    // Clamp to [0, maxDelayMs] so the documented ceiling holds even if `rng`
    // returns a value outside [0, 1).
    return Math.round(Math.max(0, Math.min(tuning.maxDelayMs, jittered)));
}

/**
 * Triage a fatal network error by HTTP status. Real, non-retryable failures
 * (auth / forbidden / not-found) are terminal; connection-level failures
 * (no response) and retryable statuses are recoverable.
 *
 * 429 (stream limit reached on the HLS manifest fetch) is also terminal —
 * retrying burns the recovery budget against a capacity limit that will not
 * clear on its own, and looks like endless buffering instead of surfacing
 * the actual cause.
 */
export function triageNetworkStatus(status: number | undefined): Triage {
    if (status === 401 || status === 403 || status === 404 || status === 429) return 'terminal';
    return 'recovering';
}

/**
 * A 410 Gone is terminal only when the server flags the session as
 * unrecoverable (admin/client stopped it). A plain "session expired" 410
 * (e.g. after a deploy) is recoverable by rebuilding the session.
 */
export function triage410(sessionTerminal: boolean): Triage {
    return sessionTerminal ? 'terminal' : 'recovering';
}

/**
 * The attempt index at which a persistent failure on the NATIVE (Safari) HLS
 * engine escalates from a cheap re-kick to a full fresh-session rebuild.
 * Attempt 1 still just nudges playback (a transient rebuffer may clear on its
 * own); by attempt 2 the stall is treated as a dead/GC'd session that only a
 * brand-new PlaySessionId can recover. Native escalates EARLIER than hls.js
 * because its nudge (`restartLoad()`) is a structural no-op — see
 * `decideRecovery`.
 */
export const NATIVE_STALL_REBUILD_ATTEMPT = 2;

/**
 * The attempt index at which a persistent `network`/`stall` failure on the
 * hls.js (MSE) engine escalates to a full fresh-session rebuild. hls.js gets
 * one more nudge than native because `hls.startLoad()` genuinely re-kicks the
 * fragment loader and clears most transient drops cheaply. By attempt 3
 * (≈8–10s of cumulative backoff with zero sustained progress) the nudge has
 * demonstrably not worked: observed in the wild as a buffer_starvation stall
 * on Chrome/hls.js where `startLoad()` never revived the pipeline and only a
 * full page reload (fresh PlaySessionId + fresh MediaSource) recovered —
 * which is exactly what the rebuild does.
 */
export const HLSJS_REBUILD_ATTEMPT = 3;

/**
 * Decide how to recover from a `network`/`stall` failure (a typed
 * `session-expired` error always rebuilds immediately at the call site).
 *
 * On hls.js we can cheaply re-kick the fragment loader (`hls.startLoad()`),
 * which clears most transient drops — but it structurally CANNOT revive a dead
 * pipeline (wedged MediaSource, GC'd transcode job whose errors keep
 * classifying as generic network failures). After `HLSJS_REBUILD_ATTEMPT`
 * failed nudges, escalate to the same fresh-session rebuild an F5 performs.
 *
 * On native Safari HLS there is NO Hls instance: `restartLoad()` is a no-op and
 * Safari cannot re-fetch a session the server has forgotten (e.g. the transcode
 * job GC'd after a long pause), nor does it expose the 410 status/terminal
 * header to JS. The stall watchdog is the only recovery signal, so a persistent
 * stall there must escalate to a fresh-session rebuild at the current position
 * — and it escalates a step earlier, since nudging never helps.
 */
export function decideRecovery(opts: {
    isNativeEngine: boolean;
    attempt: number;
    /**
     * Where the failure that started this reconnect happened, when known.
     * A manifest-stage failure skips the nudge ladder entirely: `startLoad()`
     * resumes loading on a parsed manifest, so when the manifest itself is
     * what failed, a nudge sends no request at all and the early attempts
     * are pure waiting under a "reconnecting" badge. Only a fresh-session
     * rebuild re-requests a manifest.
     */
    stage?: PlaybackFailureStage;
}): 'rebuild' | 'nudge' {
    if (opts.stage === 'manifest') return 'rebuild';
    const threshold = opts.isNativeEngine ? NATIVE_STALL_REBUILD_ATTEMPT : HLSJS_REBUILD_ATTEMPT;
    return opts.attempt >= threshold ? 'rebuild' : 'nudge';
}
