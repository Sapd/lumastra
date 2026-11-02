// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { RECONNECT_TUNING, computeBackoffDelay } from './reconnect-policy';

export type ReconnectCause = 'network' | 'session-expired' | 'stall';
/**
 * How many advanced progress ticks establish that media is really playing.
 * Two, because the first can be a start-position seek jump — see
 * `progressTicks` on ReconnectController.
 */
const PROGRESS_TICKS_FOR_PLAYBACK_STARTED = 2;

export type ReconnectState = 'connected' | 'recovering' | 'terminal';
/** Why a 'terminal' transition happened. Only set when the controller ITSELF
 *  gave up ('retries-exhausted' — the retry budget ran out with zero sustained
 *  progress, so the UI should show actionable "reload the page" guidance).
 *  Externally-classified terminals (server said stop: admin kill, 404, stream
 *  limit) carry no reason — their specific message travels via the caller's
 *  own channel (pendingTerminalMessage). */
export type TerminalReason = 'retries-exhausted';

export interface ReconnectControllerDeps {
    /** Perform one recovery attempt for the given cause (fire-and-forget).
     *  Returning 'rebuild' holds the next attempt for `rebuildGraceMs` unless
     *  the rebuilt source fails first (see trigger()). */
    attemptRecovery: (cause: ReconnectCause, attempt: number) => 'rebuild' | 'nudge' | void;
    /** Schedule `fn` after `ms`; return a cancel function. */
    schedule: (fn: () => void, ms: number) => () => void;
    /** Notified on every state transition. `terminalReason` is only present on
     *  'terminal' transitions the controller decided itself. */
    onStateChange: (state: ReconnectState, terminalReason?: TerminalReason) => void;
    /** Jitter source (0..1). Defaults to Math.random. */
    rng?: () => number;
    /** Whether the tab is currently hidden. Defaults to () => false. */
    isHidden?: () => boolean;
    /** Whether the media element accepted play. A paused element may be waiting
     *  for an autoplay gesture, which must not trigger startup recovery. */
    canRecoverStartup?: () => boolean;
    /** Whether the server has said its encoder is slower than real time for
     *  this session (slow-transcode.ts). Then a frozen playhead is the next
     *  segment taking longer than playback, not a broken connection: the
     *  stall dead-man waits instead of reconnecting, and the hard ceiling and
     *  the startup deadline extend (bounded by
     *  RECONNECT_TUNING.slowEncoderExtensions), so a dead stream is still
     *  caught. A reconnect there would only make it worse: a rebuild restarts
     *  the transcode. Defaults to () => false. */
    isStallExpected?: () => boolean;
}

/**
 * Owns connection recovery for the video player.
 *
 * States:
 *   connected  — normal playback; a stall watchdog runs while intending to play.
 *   recovering — retrying with capped backoff; the badge is shown. The retry
 *                budget is FINITE (RECONNECT_TUNING.maxRecoverAttempts): once
 *                it is spent with no sustained progress, the controller goes
 *                terminal with reason 'retries-exhausted' instead of spinning
 *                forever.
 *   terminal   — unrecoverable; the blocking center overlay is shown.
 *
 * DOM-free by design (scheduler injected) so it is unit-testable without a
 * video element.
 */
export class ReconnectController {
    private state: ReconnectState = 'connected';
    private attempt = 0;
    private cause: ReconnectCause = 'network';
    private intendedPlaying = false;
    // The stall watchdog is a MID-PLAYBACK dead-man: it must not fire before the
    // very first frame has played. Initial buffering of a slow-to-start stream
    // (e.g. a 4K→1080p CPU transcode that needs >stallTimeoutMs to produce the
    // first playable segment) is NOT a stall — firing 'stall' there enters
    // 'recovering' before currentTime ever advances, so notifyProgress can never
    // confirm recovery and playback wedges at 0:00 (observed on Safari/native
    // HLS). A separate, generous startup deadline handles streams that never
    // start, including native engines retrying successful segment downloads.
    private hasStartedPlaying = false;
    // Why the FIRST progress tick does not count as "playback started":
    // resuming mid-file seeks the element to the resume position before any
    // media is appended, and that seek makes currentTime jump (0 -> 1732). The
    // caller reports it as forward progress — correctly, by its own contract —
    // but no frame has been presented. Treating it as "started" armed the 6s
    // dead-man against a stream that had not begun loading.
    //
    // If the watchdog fires before hls.js has even parsed the manifest, every
    // nudge (restartLoad -> hls.startLoad -> frag.abortRequests) can abort the
    // fragment download it is waiting on. On a slow link this creates a false
    // stall that escalates to rebuild and then terminal without playback.
    //
    // A second advanced tick can only come from media actually playing, so it
    // is the cheapest honest proxy for "a frame was presented". Cost in the
    // normal case is one tick (~250ms) of later stall detection.
    private progressTicks = 0;
    // A seek legitimately pauses currentTime while the new position buffers — and,
    // for server-side seeks (kill + restart FFmpeg at a keyframe), while the
    // transcoder respawns and produces the first segment. On a slow/GPU-less box
    // a 4K copy segment can take longer than stallTimeoutMs to arrive. The stall
    // dead-man must NOT fire during that window or it shows a false "connection
    // problem" for a seek that is simply taking a moment. Suppressed from seek
    // start until the next progress tick; genuine seek failures still surface via
    // the segment error path (404/410 → trigger('network')).
    private seeking = false;

    private cancelRetry: (() => void) | null = null;
    private cancelConfirm: (() => void) | null = null;
    private cancelStall: (() => void) | null = null;
    private cancelStartup: (() => void) | null = null;
    // Second, independent dead-man on top of the stall watchdog. It is armed
    // and disarmed at every call site the stall watchdog is (setIntendedPlaying,
    // notifyProgress, toConnected, setSeeking, trigger, clearAll) but is
    // deliberately NEVER touched by notifyNetworkActivity — the DOM 'progress'
    // event can keep firing on a dead-but-trickling connection with no real
    // bytes arriving, which would otherwise re-arm the stall watchdog forever
    // and mask a genuinely frozen playhead. See RECONNECT_TUNING.hardCeilingMs.
    private cancelHardCeiling: (() => void) | null = null;
    /** Bounds how long `seeking` may suppress the two dead-men above. */
    private cancelSeekWatchdog: (() => void) | null = null;
    private confirmTicks = 0;
    // Set by notifyNetworkActivity() while state === 'recovering'; cleared on
    // EVERY trigger() call (fresh entry into 'recovering' AND a re-trigger
    // while already recovering — a new/renewed failure invalidates whatever
    // this flag proved about the PREVIOUS attempt). Prod 2026-08-18: a
    // session-expired rebuild never reached the server at all (no new
    // manifest/segment request), yet notifyProgress() still saw 3 ticks of
    // strictly-increasing currentTime inside confirmMs and declared the
    // session recovered — the player was simply draining a few already-
    // buffered seconds left over from before the session died, not proof the
    // rebuilt source was delivering anything. currentTime advancing is not
    // evidence the STREAM is alive; only verified new bytes arriving are. See
    // notifyProgress()'s confirm callback, which now requires both — bounded
    // by maxUnverifiedConfirmWindows/unverifiedSustainedWindows below so a
    // recovery that genuinely has nothing left to fetch doesn't hang forever.
    private verifiedActivityDuringRecovery = false;
    // Consecutive confirm windows (see maxUnverifiedConfirmWindows) that had
    // sustained ticks but no verified activity. Reset whenever a window
    // breaks the streak (ticks didn't reach minConfirmTicks) or verified
    // activity arrives (toConnected fires immediately in that case).
    private unverifiedSustainedWindows = 0;
    // The pending retry is a rebuild's grace window, not a plain backoff step:
    // a NEW failure means the rebuilt source itself failed, so it must end the
    // wait instead of being deduped into it (see trigger()).
    private rebuildGracePending = false;

    private readonly rng: () => number;
    private readonly isHidden: () => boolean;

    /** Hard-ceiling / startup extensions spent since the last real progress. */
    private slowExtensions = 0;

    constructor(private readonly deps: ReconnectControllerDeps) {
        this.rng = deps.rng ?? Math.random;
        this.isHidden = deps.isHidden ?? (() => false);
    }

    /** A slow encoder explains the wait, and an extension is left to wait it out. */
    private waitForSlowEncoder(): boolean {
        if (this.deps.isStallExpected?.() !== true) return false;
        if (this.slowExtensions >= RECONNECT_TUNING.slowEncoderExtensions) return false;
        this.slowExtensions++;
        return true;
    }

    getState(): ReconnectState {
        return this.state;
    }

    /** The cause currently driving recovery, for user-facing diagnostics. */
    getCause(): ReconnectCause {
        return this.cause;
    }

    /** Tell the controller whether playback is *intended* to be running. */
    setIntendedPlaying(value: boolean): void {
        this.intendedPlaying = value;
        if (value) this.armStartupTimer();
        else this.disarmStartupTimer();
        // Only run the stall dead-man once playback has actually started — never
        // during initial buffering (see hasStartedPlaying).
        if (value && this.state === 'connected' && this.hasStartedPlaying) {
            this.armStallTimer();
            this.armHardCeiling();
        } else {
            this.disarmStallTimer();
            this.disarmHardCeiling();
        }
    }

    /** Tell the controller a seek is starting. Suppresses the stall dead-man
     *  until the next progress tick (which also covers the post-'seeked'
     *  buffering window). See the `seeking` field for the rationale. */
    setSeeking(value: boolean): void {
        if (value) {
            this.seeking = true;
            this.disarmStallTimer();
            this.disarmHardCeiling();
            // BOUND the suppression. Both dead-men are now disarmed and only a
            // post-seek notifyProgress re-arms them — which a dead stream will
            // never deliver, so without this the player can sit frozen forever
            // with recovery never starting (prod 2026-07-29, Safari native HLS
            // through a segment-410 storm: ~75s silent until a manual reload).
            this.armSeekWatchdog();
        }
        // value=false is intentionally a no-op: the suppression is lifted by the
        // next notifyProgress (first frame after the seek), not by the 'seeked'
        // event — playback is usually still buffering when 'seeked' fires. The
        // seek watchdog above likewise runs until real progress arrives.
    }

    /** Call on every timeupdate (currentTime advanced). */
    notifyProgress(): void {
        // Second real progress = playback has started; the stall watchdog may
        // now apply (and we arm it below for the connected case). See
        // `progressTicks` for why the first tick is not enough.
        this.progressTicks += 1;
        this.slowExtensions = 0;
        if (this.progressTicks >= PROGRESS_TICKS_FOR_PLAYBACK_STARTED) {
            this.hasStartedPlaying = true;
            this.disarmStartupTimer();
        }
        // Progress after a seek means the seek completed — lift the suppression
        // and stand the seek watchdog down; the ordinary dead-men take over.
        this.seeking = false;
        this.disarmSeekWatchdog();
        if (this.state === 'connected') {
            if (this.intendedPlaying) {
                this.armStallTimer(); // reset dead-man
                this.armHardCeiling(); // reset hard ceiling — REAL progress only
            }
            return;
        }
        if (this.state === 'recovering') {
            this.confirmTicks++;
            if (!this.cancelConfirm) {
                // First progress since the attempt — pause retries and open the
                // confirmation window. Require SUSTAINED progress (multiple
                // ticks) before declaring healthy, so a single tick followed by
                // an immediate freeze does not falsely clear the badge.
                this.clearRetry();
                this.armConfirmWindow();
            }
        }
    }

    /**
     * One confirm-window evaluation, self-re-arming for as long as ticks stay
     * sustained but unverified (see maxUnverifiedConfirmWindows). Deliberately
     * NOT driven by "the next incoming tick reopens a window" — that would
     * depend on ticks continuing to arrive to keep the mechanism alive at all,
     * and if they stop right after a partial streak (the ORIGINAL bug's
     * shape: a short stale-buffer drain that ends), nothing would ever be
     * scheduled again and the controller would hang in 'recovering' forever
     * with no pending retry. Self-arming means the chain always ends in one
     * of: toConnected(), scheduleNextAttempt() (ticks genuinely stopped in
     * some window), or — once maxUnverifiedConfirmWindows is reached —
     * toConnected() as the bounded fallback. It can never simply stop.
     */
    private armConfirmWindow(): void {
        this.cancelConfirm = this.deps.schedule(() => {
            this.cancelConfirm = null;
            const ticksOk = this.confirmTicks >= RECONNECT_TUNING.minConfirmTicks;
            this.confirmTicks = 0;
            if (!ticksOk) {
                // Progress didn't continue — resume retrying. Breaks any
                // unverified-sustained streak: a real gap means whatever
                // ticks came before don't corroborate a NEW window's ticks.
                this.unverifiedSustainedWindows = 0;
                this.scheduleNextAttempt();
                return;
            }
            if (this.verifiedActivityDuringRecovery) {
                // Ticks AND at least one byte-verified fetch this recovering
                // spell — the strong case, confirm now.
                this.toConnected();
                return;
            }
            // Sustained ticks with nothing verified YET is exactly what
            // draining a stale pre-existing buffer looks like (the prod
            // incident this whole mechanism guards against) — but it is ALSO
            // exactly what a genuinely-recovered stream with no more segments
            // to fetch looks like (deep buffer, near EOF; hls-config.ts
            // maxBufferLength up to 600s video / 1800s audio). Require the
            // streak to persist across maxUnverifiedConfirmWindows before
            // trusting ticks alone — long enough that a stale-buffer remnant
            // (a few seconds) can't fake it, short enough that a real
            // "nothing left to fetch" recovery still confirms within a bounded
            // number of windows instead of hanging indefinitely.
            this.unverifiedSustainedWindows++;
            if (this.unverifiedSustainedWindows >= RECONNECT_TUNING.maxUnverifiedConfirmWindows) {
                this.unverifiedSustainedWindows = 0;
                this.toConnected();
                return;
            }
            // Not enough consecutive unverified windows yet, but ticks HAVE
            // been sustained through every window so far — re-arm rather than
            // resume retrying, so a session that, for all we know, is fine
            // doesn't eat a redundant rebuild attempt.
            this.armConfirmWindow();
        }, RECONNECT_TUNING.confirmMs);
    }

    /** Call when the media element is still pulling data — hls.js fires this on
     *  a genuinely COMPLETED fragment load (FRAG_LOADED) and via its byte-
     *  verified in-flight poll for a still-downloading one; native engines only
     *  get the weaker DOM `progress` event fallback, which (per hardCeilingMs's
     *  doc comment) can keep firing on a dead-but-trickling connection with no
     *  real bytes — so on native this corroboration is best-effort, not as
     *  strong a guarantee as on hls.js. Two distinct uses depending on state:
     *  connected — a large 4K copy segment can take longer than stallTimeoutMs to
     *  download; that is slow, not frozen, so reset the stall dead-man.
     *  recovering — marks verifiedActivityDuringRecovery so notifyProgress()'s
     *  confirm window can tell "the rebuilt source is actually delivering data"
     *  apart from "currentTime happens to be ticking through stale buffer" (see
     *  that field's doc comment for the incident that required this). */
    notifyNetworkActivity(): void {
        if (this.state === 'recovering') {
            this.verifiedActivityDuringRecovery = true;
        }
        if (this.state === 'connected' && this.intendedPlaying && !this.seeking) {
            this.armStallTimer(); // reset the dead-man countdown
        }
    }

    /** Call from the `waiting` handler — playback stalled again. */
    notifyWaiting(): void {
        if (this.state === 'recovering' && this.cancelConfirm) {
            // Progress did not stick — abort confirmation, resume retrying.
            this.clearConfirm();
            this.scheduleNextAttempt();
        }
    }

    /** Enter recovery for `cause`, or go terminal. */
    trigger(cause: ReconnectCause, opts?: { terminal?: boolean }): void {
        if (opts?.terminal) {
            this.toTerminal();
            return;
        }
        if (this.state === 'terminal') return;
        // Dedupe repeated same-cause triggers while a retry is already pending
        // (e.g. hls.js emits an ERROR per failed fragment during a 410 storm):
        // rescheduling would clearRetry() and push the real attempt back
        // indefinitely, so keep the existing backoff clock running.
        const alreadyScheduledSameCause =
            this.state === 'recovering' &&
            this.cause === cause &&
            this.cancelRetry !== null &&
            !this.rebuildGracePending;
        this.cause = cause;
        this.clearConfirm();
        // Every trigger() — fresh entry AND a re-trigger while already
        // recovering — starts a clean slate for these two: whatever they
        // proved was about the attempt that just failed again, not the new
        // one about to start. Without this, verified activity from an
        // earlier, unsuccessful attempt within the same recovering spell can
        // wrongly corroborate a LATER attempt that never itself fetched
        // anything (the same false-recovery shape as the original bug, just
        // reconstructed one attempt later).
        this.verifiedActivityDuringRecovery = false;
        this.unverifiedSustainedWindows = 0;
        if (this.state !== 'recovering') {
            this.state = 'recovering';
            this.disarmStartupTimer();
            this.attempt = 0;
            this.disarmStallTimer();
            this.disarmHardCeiling();
            this.deps.onStateChange('recovering');
        }
        if (!alreadyScheduledSameCause) this.scheduleNextAttempt();
    }

    /**
     * The player could not act on the attempt we just dispatched, so it must
     * not count against the recovery budget.
     *
     * `rebuildPlaybackSession()` bails at `if (!this.tryStartRestart()) return`
     * when a restart is already in flight — but `scheduleNextAttempt()` has
     * already incremented the counter, so the slot is spent on a no-op. Sessions
     * can be created with
     * `transcode_job_id NULL` and issued ZERO `/hls` manifest requests, while
     * the ladder counted them and declared terminal three attempts early.
     *
     * Same rationale as the hidden-tab deferral in `scheduleNextAttempt()`,
     * which avoids the problem by returning BEFORE the increment. This is the
     * after-the-fact equivalent for a caller that only discovers it cannot act
     * once dispatched. It DEFERS the budget, never removes it: the retry chain
     * keeps running and still reaches terminal.
     */
    refundAttempt(): void {
        if (this.state !== 'recovering') return;
        if (this.attempt > 0) this.attempt -= 1;
    }

    /** Call when the tab becomes visible — re-arm a deferred attempt. */
    onVisible(): void {
        this.armStartupTimer();
        if (this.state === 'recovering' && !this.cancelRetry && !this.cancelConfirm) {
            this.scheduleNextAttempt();
        }
    }

    destroy(): void {
        this.clearAll();
    }

    /**
     * Reset to a clean idle state for a NEW item/session (in-session switch:
     * next episode, playlist item, channel, search result). Kills every pending
     * timer and clears the recovering state + attempt/cause so a stale retry
     * from the PREVIOUS item can't fire `attemptRecovery` (e.g. rebuild) against
     * the fresh session. The controller instance is reused across item switches
     * (only destroyed on full unmount), so without this its mid-recovery state
     * leaks forward. Emits no onStateChange — the caller's playerStore.reset()
     * clears the reconnecting flag; keeping them decoupled avoids a spurious
     * 'connected' emit during teardown.
     */
    reset(): void {
        this.clearAll();
        this.state = 'connected';
        this.attempt = 0;
        this.cause = 'network';
        this.hasStartedPlaying = false;
        this.progressTicks = 0;
        this.intendedPlaying = false;
        this.verifiedActivityDuringRecovery = false;
    }

    /**
     * The player is deliberately replacing the stream (quality pick, audio
     * track switch that needs a new transcode, burn-in toggle, ABR bitrate
     * change, version switch) — not a failure.
     *
     * Stands the stall dead-men down and forgets that playback had started, so
     * they re-arm only once the NEW stream has really played (two progress
     * ticks, exactly like a fresh start). Windows e2e 2026-09-27 (finding S1):
     * a 720p NVENC restart took longer than stallTimeoutMs to produce its first
     * segment, the dead-man from the OLD stream fired mid-restart, and the
     * nudge -> rebuild ladder then tore the brand-new transcode down six times
     * until it went terminal ("playback stopped receiving frames").
     *
     * Only acts while 'connected'. A restart during 'recovering' leaves the
     * ladder in charge — its confirm window still needs real progress from the
     * new stream to declare recovery — and 'terminal' is final.
     */
    beginProgrammaticRestart(): void {
        if (this.state !== 'connected') return;
        this.clearAll();
        this.seeking = false;
        this.hasStartedPlaying = false;
        this.progressTicks = 0;
        this.armStartupTimer();
    }

    // ---- internals ----

    private scheduleNextAttempt(minDelayMs = 0): void {
        this.clearRetry();
        const delay = Math.max(computeBackoffDelay(this.attempt, this.rng), minDelayMs);
        this.rebuildGracePending = minDelayMs > 0;
        this.cancelRetry = this.deps.schedule(() => {
            this.cancelRetry = null;
            if (this.isHidden()) {
                // Defer until visible; onVisible() re-arms the chain. This
                // deliberately happens BEFORE the budget check so a hidden tab
                // never spends attempts (Chrome throttles hidden-tab IO — see
                // hidden-tab verification hazard — so attempts there would be
                // doomed AND burn the budget against the user).
                return;
            }
            this.attempt += 1;
            if (this.attempt > RECONNECT_TUNING.maxRecoverAttempts) {
                // Budget spent with zero SUSTAINED progress (the counter only
                // resets in toConnected, i.e. after a confirmed recovery — an
                // unsustained single tick merely pauses retries and keeps the
                // spent count). One more attempt won't succeed where
                // maxRecoverAttempts didn't; surface actionable guidance.
                this.toTerminal('retries-exhausted');
                return;
            }
            const action = this.deps.attemptRecovery(this.cause, this.attempt);
            this.scheduleNextAttempt(action === 'rebuild' ? RECONNECT_TUNING.rebuildGraceMs : 0);
        }, delay);
    }

    private toConnected(): void {
        this.clearAll();
        this.attempt = 0;
        this.state = 'connected';
        this.deps.onStateChange('connected');
        if (this.intendedPlaying) {
            this.armStallTimer();
            this.armHardCeiling();
        }
    }

    private toTerminal(reason?: TerminalReason): void {
        this.clearAll();
        this.state = 'terminal';
        this.deps.onStateChange('terminal', reason);
    }

    private clearRetry(): void {
        this.rebuildGracePending = false;
        if (this.cancelRetry) {
            this.cancelRetry();
            this.cancelRetry = null;
        }
    }

    private clearConfirm(): void {
        if (this.cancelConfirm) {
            this.cancelConfirm();
            this.cancelConfirm = null;
        }
        this.confirmTicks = 0;
    }

    private disarmStartupTimer(): void {
        this.cancelStartup?.();
        this.cancelStartup = null;
    }

    private armStartupTimer(): void {
        // Do not slide this deadline on repeated play intent, seek jumps, or
        // DOM progress events: Safari can emit those while endlessly fetching
        // the same segment without decoding a single frame.
        if (
            this.cancelStartup ||
            this.hasStartedPlaying ||
            !this.intendedPlaying ||
            this.state !== 'connected' ||
            this.isHidden() ||
            this.deps.canRecoverStartup?.() === false
        )
            return;
        this.cancelStartup = this.deps.schedule(() => {
            this.cancelStartup = null;
            if (
                !this.intendedPlaying ||
                this.hasStartedPlaying ||
                this.state !== 'connected' ||
                this.isHidden() ||
                this.deps.canRecoverStartup?.() === false
            )
                return;
            // A slow encoder is still producing the first segment.
            if (this.waitForSlowEncoder()) {
                this.armStartupTimer();
                return;
            }
            // Reuse the finite recovery ladder and its pre-rebuild incident
            // flush. Never introduce an independent source-reload loop.
            this.seeking = false;
            this.disarmSeekWatchdog();
            this.trigger('stall');
        }, RECONNECT_TUNING.startupTimeoutMs);
    }

    private disarmStallTimer(): void {
        if (this.cancelStall) {
            this.cancelStall();
            this.cancelStall = null;
        }
    }

    private armStallTimer(): void {
        this.disarmStallTimer();
        // Never run the dead-man during a seek (see `seeking`).
        if (this.seeking) return;
        this.cancelStall = this.deps.schedule(() => {
            this.cancelStall = null;
            if (
                this.intendedPlaying &&
                this.state === 'connected' &&
                this.hasStartedPlaying &&
                !this.seeking
            ) {
                // Slow encoder: keep waiting; the hard ceiling bounds it.
                if (this.deps.isStallExpected?.() === true) {
                    this.armStallTimer();
                    return;
                }
                this.trigger('stall');
            }
        }, RECONNECT_TUNING.stallTimeoutMs);
    }

    private disarmSeekWatchdog(): void {
        if (this.cancelSeekWatchdog) {
            this.cancelSeekWatchdog();
            this.cancelSeekWatchdog = null;
        }
    }

    /**
     * Upper bound on seek suppression — see RECONNECT_TUNING.seekStallTimeoutMs.
     * Deliberately does NOT check `!this.seeking` (unlike the other dead-men):
     * still being in the seeking state is precisely the failure this catches.
     */
    private armSeekWatchdog(): void {
        this.disarmSeekWatchdog();
        this.cancelSeekWatchdog = this.deps.schedule(() => {
            this.cancelSeekWatchdog = null;
            if (
                this.seeking &&
                this.intendedPlaying &&
                this.state === 'connected' &&
                this.hasStartedPlaying
            ) {
                // A slow encoder is still producing the seek target's first
                // segment; a rebuild would restart that very transcode.
                if (this.waitForSlowEncoder()) {
                    this.armSeekWatchdog();
                    return;
                }
                // Treat a seek that never produced a frame as a stall: the
                // recovery ladder (nudge → fresh-session rebuild) is exactly
                // what an incomplete seek on a dead session needs.
                this.seeking = false;
                this.trigger('stall');
            }
        }, RECONNECT_TUNING.seekStallTimeoutMs);
    }

    private disarmHardCeiling(): void {
        if (this.cancelHardCeiling) {
            this.cancelHardCeiling();
            this.cancelHardCeiling = null;
        }
    }

    private armHardCeiling(): void {
        this.disarmHardCeiling();
        // Never run the hard ceiling during a seek (see `seeking`).
        if (this.seeking) return;
        this.cancelHardCeiling = this.deps.schedule(() => {
            this.cancelHardCeiling = null;
            if (
                this.intendedPlaying &&
                this.state === 'connected' &&
                this.hasStartedPlaying &&
                !this.seeking
            ) {
                if (this.waitForSlowEncoder()) {
                    this.armHardCeiling();
                    return;
                }
                this.trigger('stall');
            }
        }, RECONNECT_TUNING.hardCeilingMs);
    }

    private clearAll(): void {
        this.disarmStartupTimer();
        this.clearRetry();
        this.clearConfirm();
        this.disarmStallTimer();
        this.disarmHardCeiling();
        this.disarmSeekWatchdog();
    }
}
