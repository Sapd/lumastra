// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { ReconnectController, type ReconnectCause } from './reconnect-controller';
import { computeBackoffDelay, RECONNECT_TUNING } from './reconnect-policy';
import { IncidentReporter } from './incident-reporter';
import { IncidentRingBuffer } from './incident-buffer';

/** Deterministic, manually-advanced scheduler for the state machine. */
class FakeScheduler {
    now = 0;
    private seq = 0;
    private tasks: { id: number; fn: () => void; due: number }[] = [];

    schedule = (fn: () => void, ms: number): (() => void) => {
        const id = ++this.seq;
        this.tasks.push({ id, fn, due: this.now + ms });
        return () => {
            this.tasks = this.tasks.filter((t) => t.id !== id);
        };
    };

    /** Advance time; fire every task that comes due (in order), including
     *  tasks scheduled by earlier callbacks within the same advance. */
    advance(ms: number): void {
        const target = this.now + ms;
        while (true) {
            const next = this.tasks.filter((t) => t.due <= target).sort((a, b) => a.due - b.due)[0];
            if (!next) break;
            this.tasks = this.tasks.filter((t) => t.id !== next.id);
            this.now = next.due;
            next.fn();
        }
        this.now = target;
    }
}

/**
 * Establish that media is really playing. Takes TWO progress ticks because the
 * first can be a start-position seek jump rather than a presented frame — see
 * `progressTicks` in reconnect-controller.ts.
 */
function establishPlayback(controller: ReconnectController): void {
    controller.notifyProgress();
    controller.notifyProgress();
}

function makeController(
    overrides: Partial<{
        isHidden: () => boolean;
        canRecoverStartup: () => boolean;
        isStallExpected: () => boolean;
    }> = {},
) {
    const sched = new FakeScheduler();
    const attemptRecovery = vi.fn();
    const onStateChange = vi.fn();
    const controller = new (ReconnectController as typeof ReconnectController)({
        attemptRecovery,
        schedule: sched.schedule,
        onStateChange,
        rng: () => 0, // deterministic min-jitter backoff
        isHidden: overrides.isHidden ?? (() => false),
        canRecoverStartup: overrides.canRecoverStartup,
        isStallExpected: overrides.isStallExpected,
    });
    return { controller, sched, attemptRecovery, onStateChange };
}

describe('ReconnectController — recovering/backoff', () => {
    it('enters recovering on trigger and emits one attempt per backoff step', () => {
        const { controller, sched, attemptRecovery, onStateChange } = makeController();

        controller.trigger('network');
        expect(onStateChange).toHaveBeenCalledWith('recovering');
        expect(attemptRecovery).not.toHaveBeenCalled(); // nothing before backoff

        sched.advance(computeBackoffDelay(0, () => 0)); // 1200ms
        expect(attemptRecovery).toHaveBeenCalledTimes(1);
        // Cause + 1-based attempt index (used by the native-stall escalation).
        expect(attemptRecovery).toHaveBeenLastCalledWith('network', 1);

        sched.advance(computeBackoffDelay(1, () => 0)); // 2400ms
        expect(attemptRecovery).toHaveBeenCalledTimes(2);
        expect(attemptRecovery).toHaveBeenLastCalledWith('network', 2);

        // Bounded: keeps trying up to the recovery budget, then stops.
        sched.advance(600000);
        expect(attemptRecovery).toHaveBeenCalledTimes(RECONNECT_TUNING.maxRecoverAttempts);
    });

    it('does not reset the backoff clock on repeated same-cause triggers (410 storm)', () => {
        const { controller, sched, attemptRecovery } = makeController();

        controller.trigger('network'); // schedules the first attempt at t=1200
        sched.advance(600); // t=600 — not yet due

        // hls.js fires an ERROR per failed fragment → many same-cause triggers
        // while a retry is already pending. These must NOT reschedule, or the
        // real attempt gets pushed back indefinitely.
        controller.trigger('network');
        controller.trigger('network');

        sched.advance(600); // t=1200 — the ORIGINAL clock elapses
        expect(attemptRecovery).toHaveBeenCalledTimes(1);
        expect(attemptRecovery).toHaveBeenLastCalledWith('network', 1);
    });

    it('goes terminal without scheduling attempts', () => {
        const { controller, sched, attemptRecovery, onStateChange } = makeController();
        controller.trigger('session-expired', { terminal: true });
        // No exhaustion reason — this terminal was classified externally.
        expect(onStateChange).toHaveBeenLastCalledWith('terminal', undefined);
        sched.advance(60000);
        expect(attemptRecovery).not.toHaveBeenCalled();
        expect(controller.getState()).toBe('terminal');
    });

    it('ignores further triggers once terminal', () => {
        const { controller, onStateChange } = makeController();
        controller.trigger('network', { terminal: true });
        onStateChange.mockClear();
        controller.trigger('network');
        expect(onStateChange).not.toHaveBeenCalled();
        expect(controller.getState()).toBe('terminal');
    });

    it('defers attempts while hidden, resumes on onVisible', () => {
        let hidden = true;
        const { controller, sched, attemptRecovery } = makeController({
            isHidden: () => hidden,
        });
        controller.trigger('network');
        sched.advance(60000);
        expect(attemptRecovery).not.toHaveBeenCalled(); // hidden → deferred

        hidden = false;
        controller.onVisible();
        sched.advance(computeBackoffDelay(0, () => 0));
        expect(attemptRecovery).toHaveBeenCalledTimes(1);
    });
});

describe('ReconnectController — terminal ceiling (retry budget)', () => {
    // Without a ceiling the badge spins forever on an unrecoverable failure
    // (observed: Chrome/hls.js buffer_starvation where nothing short of a page
    // reload helps). After maxRecoverAttempts with zero SUSTAINED progress the
    // controller must go terminal with a distinct reason so the UI can show
    // actionable "reload the page" guidance instead of the generic message.

    it('goes terminal with reason retries-exhausted after the budget is spent', () => {
        const { controller, sched, attemptRecovery, onStateChange } = makeController();
        controller.trigger('network');
        sched.advance(600000);

        expect(attemptRecovery).toHaveBeenCalledTimes(RECONNECT_TUNING.maxRecoverAttempts);
        expect(onStateChange).toHaveBeenLastCalledWith('terminal', 'retries-exhausted');
        expect(controller.getState()).toBe('terminal');
    });

    it('a hidden tab does not burn the recovery budget', () => {
        let hidden = false;
        const { controller, sched, attemptRecovery } = makeController({
            isHidden: () => hidden,
        });
        controller.trigger('network');
        sched.advance(4000); // attempts at t=1200 and t=3600 fire while visible
        expect(attemptRecovery).toHaveBeenCalledTimes(2);

        hidden = true;
        sched.advance(600000); // long background stretch — deferred, not spent
        expect(attemptRecovery).toHaveBeenCalledTimes(2);
        expect(controller.getState()).toBe('recovering'); // NOT terminal

        hidden = false;
        controller.onVisible();
        sched.advance(600000); // remaining budget runs, THEN terminal
        expect(attemptRecovery).toHaveBeenCalledTimes(RECONNECT_TUNING.maxRecoverAttempts);
        expect(controller.getState()).toBe('terminal');
    });

    it('sustained recovery resets the budget for the next incident', () => {
        const { controller, sched, attemptRecovery, onStateChange } = makeController();
        controller.trigger('network');
        sched.advance(9000); // attempts at t=1200, 3600, 8400 → 3 spent
        expect(attemptRecovery).toHaveBeenCalledTimes(3);

        // Sustained progress + verified new bytes → back to connected (budget
        // must reset here). Progress alone is not enough — see the
        // "does NOT connect on progress alone" test below.
        controller.notifyNetworkActivity();
        for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) {
            controller.notifyProgress();
        }
        sched.advance(RECONNECT_TUNING.confirmMs);
        expect(controller.getState()).toBe('connected');
        onStateChange.mockClear();

        // A later, unrelated incident gets the FULL budget again.
        controller.trigger('network');
        sched.advance(600000);
        expect(attemptRecovery).toHaveBeenCalledTimes(3 + RECONNECT_TUNING.maxRecoverAttempts);
        expect(onStateChange).toHaveBeenLastCalledWith('terminal', 'retries-exhausted');
    });

    it('a single unsustained progress tick does NOT reset the budget', () => {
        const { controller, sched, attemptRecovery, onStateChange } = makeController();
        controller.trigger('network');
        sched.advance(computeBackoffDelay(0, () => 0)); // first attempt
        expect(attemptRecovery).toHaveBeenCalledTimes(1);

        controller.notifyProgress(); // one tick, then currentTime freezes again
        sched.advance(600000);

        // The confirm window paused retries but did not refund attempts —
        // total attempts stay exactly at the budget, then terminal.
        expect(attemptRecovery).toHaveBeenCalledTimes(RECONNECT_TUNING.maxRecoverAttempts);
        expect(onStateChange).toHaveBeenLastCalledWith('terminal', 'retries-exhausted');
    });

    it('an externally-classified terminal trigger carries NO exhaustion reason', () => {
        const { controller, onStateChange } = makeController();
        controller.trigger('session-expired', { terminal: true });
        // The player-controller distinguishes "budget exhausted" (reload
        // guidance) from "server said stop" (specific/pending message).
        expect(onStateChange).toHaveBeenLastCalledWith('terminal', undefined);
    });
});

describe('ReconnectController — confirmation', () => {
    it('returns to connected after sustained progress (>= minConfirmTicks) with verified new data', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.trigger('network');
        sched.advance(computeBackoffDelay(0, () => 0)); // first attempt fired
        onStateChange.mockClear();

        // Multiple progress ticks during the window, PLUS at least one
        // byte-verified fetch — that combination is sustained recovery.
        controller.notifyNetworkActivity();
        for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) {
            controller.notifyProgress();
        }
        sched.advance(RECONNECT_TUNING.confirmMs);
        expect(onStateChange).toHaveBeenCalledWith('connected');
        expect(controller.getState()).toBe('connected');
    });

    it('does NOT connect on sustained progress alone, with no verified new data', () => {
        // Prod 2026-08-18: a session-expired rebuild never reached the server
        // (no new segment fetched), but the video kept ticking currentTime
        // forward for a few seconds off video the browser had already
        // buffered before the session died — and the OLD logic mistook that
        // for a confirmed recovery. currentTime advancing must not be
        // sufficient on its own; it must be corroborated by verified network
        // activity during THIS recovering spell.
        const { controller, sched, onStateChange, attemptRecovery } = makeController();
        controller.trigger('session-expired');
        sched.advance(computeBackoffDelay(0, () => 0)); // first attempt fired
        onStateChange.mockClear();
        attemptRecovery.mockClear();

        for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) {
            controller.notifyProgress();
        }
        sched.advance(RECONNECT_TUNING.confirmMs);
        expect(onStateChange).not.toHaveBeenCalledWith('connected');
        expect(controller.getState()).toBe('recovering');
        // The confirm window elapsing without corroboration resumes retrying
        // (on the normal backoff schedule, not instantly).
        sched.advance(600000);
        expect(attemptRecovery).toHaveBeenCalled();
    });

    it('eventually connects on sustained-but-unverified progress after maxUnverifiedConfirmWindows (bounded fallback — no permanent hang)', () => {
        // A genuinely-recovered stream with a deep pre-existing buffer (or
        // near end-of-file) may never fetch another fragment, so
        // notifyNetworkActivity() can legitimately never fire again. Requiring
        // verified activity as an UNCONDITIONAL gate would leave this case
        // stuck in 'recovering' forever. Prove it instead confirms once the
        // unverified streak persists across the configured number of windows.
        const { controller, sched, onStateChange, attemptRecovery } = makeController();
        controller.trigger('network');
        sched.advance(computeBackoffDelay(0, () => 0));
        onStateChange.mockClear();
        attemptRecovery.mockClear();

        for (let w = 0; w < RECONNECT_TUNING.maxUnverifiedConfirmWindows - 1; w++) {
            for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) {
                controller.notifyProgress();
            }
            sched.advance(RECONNECT_TUNING.confirmMs);
            expect(controller.getState()).toBe('recovering');
        }
        // No retry attempt was ever spent while ticks stayed sustained.
        expect(attemptRecovery).not.toHaveBeenCalled();

        // The final window's sustained ticks push the streak over the bound.
        for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) {
            controller.notifyProgress();
        }
        sched.advance(RECONNECT_TUNING.confirmMs);
        expect(onStateChange).toHaveBeenCalledWith('connected');
        expect(controller.getState()).toBe('connected');
    });

    it('does NOT hang if ticks stop partway through an unverified streak — resumes retrying', () => {
        // Companion to the bounded-fallback test above: prove the confirm
        // chain re-arms ITSELF across windows rather than depending on the
        // next incoming tick to reopen it. If ticks stop mid-streak (the
        // original bug's actual shape — a short stale-buffer drain that
        // ends), nothing should be left permanently unscheduled.
        const { controller, sched, attemptRecovery } = makeController();
        controller.trigger('session-expired');
        sched.advance(computeBackoffDelay(0, () => 0));
        attemptRecovery.mockClear();

        // One sustained-but-unverified window, then ticks stop for good.
        for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) {
            controller.notifyProgress();
        }
        sched.advance(RECONNECT_TUNING.confirmMs);
        expect(controller.getState()).toBe('recovering');

        sched.advance(600000); // no further notifyProgress calls
        expect(attemptRecovery).toHaveBeenCalled();
    });

    it('verified activity from an earlier attempt does NOT corroborate a later re-triggered attempt in the same spell', () => {
        // A rebuild attempt can start fetching (real bytes → verified=true)
        // and still fail again before confirming. If the flag survived into
        // the NEXT trigger(), a stale-buffer drain on that later, genuinely
        // dead attempt could fake "recovered" exactly like the original bug —
        // just reconstructed one attempt later inside the same spell.
        const { controller, sched, onStateChange, attemptRecovery } = makeController();
        controller.trigger('network');
        sched.advance(computeBackoffDelay(0, () => 0)); // attempt 1 fires
        controller.notifyNetworkActivity(); // attempt 1 got real bytes...
        controller.notifyWaiting(); // ...but then failed again before confirming

        // A NEW failure re-triggers while still 'recovering' — must not
        // inherit attempt 1's verified-activity evidence.
        controller.trigger('session-expired');
        onStateChange.mockClear();
        attemptRecovery.mockClear();

        for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) {
            controller.notifyProgress();
        }
        sched.advance(RECONNECT_TUNING.confirmMs);
        expect(onStateChange).not.toHaveBeenCalledWith('connected');
        expect(controller.getState()).toBe('recovering');
    });

    it('verified activity while connected does NOT leak into the next recovering spell', () => {
        // The literal prod shape: bytes were flowing right up until the
        // moment of failure. Locks in both the state==='recovering' guard on
        // notifyNetworkActivity() and the flag reset in trigger().
        const { controller, sched, onStateChange } = makeController();
        controller.notifyNetworkActivity(); // healthy playback, state='connected'

        controller.trigger('session-expired');
        sched.advance(computeBackoffDelay(0, () => 0));
        onStateChange.mockClear();

        for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) {
            controller.notifyProgress();
        }
        sched.advance(RECONNECT_TUNING.confirmMs);
        expect(onStateChange).not.toHaveBeenCalledWith('connected');
        expect(controller.getState()).toBe('recovering');
    });

    it('does NOT connect if progress stops after a single tick', () => {
        const { controller, sched, attemptRecovery, onStateChange } = makeController();
        controller.trigger('network');
        sched.advance(computeBackoffDelay(0, () => 0));
        onStateChange.mockClear();
        const attemptsBefore = attemptRecovery.mock.calls.length;

        controller.notifyProgress(); // one tick, then currentTime freezes
        sched.advance(RECONNECT_TUNING.confirmMs);

        expect(onStateChange).not.toHaveBeenCalledWith('connected');
        expect(controller.getState()).toBe('recovering');
        // and it resumes retrying rather than wedging
        sched.advance(60000);
        expect(attemptRecovery.mock.calls.length).toBeGreaterThan(attemptsBefore);
    });

    it('aborts confirmation and resumes retrying on a fresh stall', () => {
        const { controller, sched, attemptRecovery, onStateChange } = makeController();
        controller.trigger('network');
        sched.advance(computeBackoffDelay(0, () => 0));
        const attemptsBefore = attemptRecovery.mock.calls.length;

        controller.notifyProgress(); // start confirm
        controller.notifyWaiting(); // progress didn't stick → abort confirm
        sched.advance(60000);

        expect(onStateChange).not.toHaveBeenCalledWith('connected');
        expect(attemptRecovery.mock.calls.length).toBeGreaterThan(attemptsBefore);
    });
});

describe('ReconnectController — stall watchdog', () => {
    it('triggers a stall when currentTime stops advancing AFTER playback started', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true); // connected + intending to play
        // TWO ticks: the first can be a start-position seek jump rather than a
        // presented frame (see the first-tick test below), so real playback is
        // only established by the second.
        controller.notifyProgress();
        controller.notifyProgress();
        expect(controller.getState()).toBe('connected');

        sched.advance(RECONNECT_TUNING.stallTimeoutMs);
        expect(onStateChange).toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('recovering');
    });

    it('does NOT trigger a stall before playback ever starts (slow startup buffering)', () => {
        // A slow-to-start stream (e.g. 4K→1080p CPU transcode) may take longer
        // than stallTimeoutMs to produce its first frame. That is initial
        // buffering, not a stall — entering 'recovering' here would wedge the
        // player at 0:00 (notifyProgress can never confirm recovery).
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        // No notifyProgress() — playback hasn't started yet.
        sched.advance(RECONNECT_TUNING.stallTimeoutMs * 3);
        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('connected');
    });

    it('does NOT arm the dead-man on the FIRST progress tick (start-position seek jump)', () => {
        // Resuming mid-file seeks the element to the resume position before any
        // media is appended. That seek makes currentTime jump (0 -> 1732), which
        // the caller reports as forward progress — but no frame has played.
        // Prod 2026-09-11 (testlistener, a0000003): play at 18:15:11.9, first nudge at
        // 18:15:20 — the 6s dead-man fired BEFORE hls.js had even parsed the
        // manifest, and each nudge then aborted the very fragment download it
        // was waiting on (restartLoad -> startLoad -> frag.abortRequests).
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress(); // the seek jump — NOT a presented frame

        sched.advance(RECONNECT_TUNING.stallTimeoutMs * 3);
        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('connected');
    });

    it('arms once a SECOND progress tick proves media is really playing', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress(); // seek jump
        controller.notifyProgress(); // real playback

        sched.advance(RECONNECT_TUNING.stallTimeoutMs);
        expect(onStateChange).toHaveBeenCalledWith('recovering');
    });

    it('forgets that playback started after reset(), so the next load re-earns it', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress();
        controller.notifyProgress();
        controller.reset();

        controller.setIntendedPlaying(true);
        controller.notifyProgress(); // only the new load's seek jump
        sched.advance(RECONNECT_TUNING.stallTimeoutMs * 3);
        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
    });

    it('does not trigger while progress keeps arriving', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);

        sched.advance(RECONNECT_TUNING.stallTimeoutMs - 1000);
        controller.notifyProgress(); // resets the dead-man timer
        sched.advance(RECONNECT_TUNING.stallTimeoutMs - 1000);

        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('connected');
    });

    it('disarms the watchdog when no longer intending to play', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.setIntendedPlaying(false); // user paused / ended
        sched.advance(60000);
        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
    });

    it('does NOT fire a stall while a seek is in progress (slow seek is not a stall)', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress(); // playback started, watchdog armed

        controller.setSeeking(true); // user seeks — currentTime pauses to buffer
        // A long server-side seek (FFmpeg restart + 4K copy segment) far exceeds
        // the stall timeout, but it must NOT surface as a "connection problem".
        sched.advance(RECONNECT_TUNING.stallTimeoutMs * 4);
        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('connected');
    });

    it('does NOT fire a stall while data keeps arriving (notifyNetworkActivity)', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress(); // playing, watchdog armed

        // currentTime is frozen (downloading a big segment) but the buffer keeps
        // growing — 'progress' events arrive every 2s. Must not trip the 6s stall.
        for (let i = 0; i < 10; i++) {
            sched.advance(2000);
            controller.notifyNetworkActivity();
        }
        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('connected');
    });

    it('still fires a stall when data stops arriving (no activity, no progress)', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        establishPlayback(controller);

        // No progress AND no network activity → genuine freeze.
        sched.advance(RECONNECT_TUNING.stallTimeoutMs);
        expect(onStateChange).toHaveBeenCalledWith('recovering');
    });

    it('re-arms the watchdog after the seek completes (first progress)', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress();

        controller.setSeeking(true);
        sched.advance(RECONNECT_TUNING.stallTimeoutMs * 2); // suppressed
        expect(onStateChange).not.toHaveBeenCalledWith('recovering');

        controller.notifyProgress(); // seek completed — first frame at new pos
        // A genuine freeze AFTER the seek must still be caught.
        sched.advance(RECONNECT_TUNING.stallTimeoutMs);
        expect(onStateChange).toHaveBeenCalledWith('recovering');
    });
});

describe('ReconnectController — hard ceiling (dead-but-trickling connection)', () => {
    // The DOM 'progress' event (surfaced here via notifyNetworkActivity) can
    // keep firing on a dead-but-trickling connection even when no real bytes
    // are arriving — it re-arms the 6s stall dead-man forever, masking a
    // genuinely frozen playhead. The hard ceiling is a second, independent
    // timer that ONLY notifyProgress (real currentTime advance) can reset, so
    // it still fires even if notifyNetworkActivity is spammed indefinitely.

    it('fires a stall at hardCeilingMs even while notifyNetworkActivity keeps arriving (never notifyProgress again)', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        establishPlayback(controller); // arms stall + hard ceiling

        // Network activity every 2s resets the 6s stall dead-man indefinitely,
        // but must NOT reset the 25s hard ceiling.
        const tickMs = 2000;
        const totalTicks = Math.ceil(RECONNECT_TUNING.hardCeilingMs / tickMs) + 2;
        for (let i = 0; i < totalTicks; i++) {
            if (controller.getState() !== 'connected') break;
            sched.advance(tickMs);
            controller.notifyNetworkActivity();
        }

        expect(onStateChange).toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('recovering');
    });

    it('does NOT fire before hardCeilingMs while notifyNetworkActivity keeps arriving', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress();

        const tickMs = 2000;
        const ticksUnderCeiling = Math.floor((RECONNECT_TUNING.hardCeilingMs - 1) / tickMs);
        for (let i = 0; i < ticksUnderCeiling; i++) {
            sched.advance(tickMs);
            controller.notifyNetworkActivity();
        }

        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('connected');
    });

    it('notifyProgress (real progress) re-arms the hard ceiling for a fresh window', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress();

        // Keep the 6s stall dead-man from firing via network activity while
        // approaching (but not reaching) the hard ceiling...
        const tickMs = 2000;
        const ticksToMidpoint = Math.floor((RECONNECT_TUNING.hardCeilingMs - 1000) / tickMs);
        for (let i = 0; i < ticksToMidpoint; i++) {
            sched.advance(tickMs);
            controller.notifyNetworkActivity();
        }
        controller.notifyProgress(); // ...then real progress re-arms the ceiling too

        const ticksAfter = Math.floor((RECONNECT_TUNING.hardCeilingMs - 1000) / tickMs);
        for (let i = 0; i < ticksAfter; i++) {
            sched.advance(tickMs);
            controller.notifyNetworkActivity();
        }

        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('connected');
    });

    it('setSeeking(true) disarms the hard ceiling (slow seek is not a stall)', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress();

        controller.setSeeking(true);
        // Well past the hard ceiling, but still inside seekStallTimeoutMs — the
        // suppression is bounded, not unlimited (see the seek-watchdog tests).
        sched.advance(RECONNECT_TUNING.hardCeilingMs + 1000);

        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('connected');
    });

    it('setIntendedPlaying(false) disarms the hard ceiling', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress();

        controller.setIntendedPlaying(false);
        sched.advance(RECONNECT_TUNING.hardCeilingMs * 2);

        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
    });

    it('entering recovering disarms the hard ceiling (no stray extra trigger)', () => {
        const { controller, sched, attemptRecovery, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress();

        controller.trigger('network'); // enters recovering directly; disarms ceiling
        onStateChange.mockClear();
        const attemptsBefore = attemptRecovery.mock.calls.length;
        sched.advance(RECONNECT_TUNING.hardCeilingMs * 2);

        // The (disarmed) hard ceiling must not fire another 'recovering'
        // transition — the retry loop from trigger('network') is the only
        // thing still running.
        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(attemptRecovery.mock.calls.length).toBeGreaterThan(attemptsBefore);
    });
});

// ============================================================================
// Seek suppression must be BOUNDED
// ============================================================================
//
// Prod 2026-07-29: a Safari (native HLS) session went totally silent for ~75s
// of frozen video during a segment-410 storm — no 'recovering', no attempt, no
// starvation telemetry — until the user reloaded. setSeeking(true) disarms BOTH
// dead-men and is lifted only by notifyProgress, which on a dead stream can
// never arrive: a seek that never completes suppresses recovery permanently.
describe('ReconnectController — seek suppression is bounded', () => {
    it('recovers from a seek that never completes (no progress ever arrives)', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        establishPlayback(controller);
        controller.setSeeking(true); // seek begins — dead-men disarmed

        // The stream is dead: no notifyProgress will ever lift the suppression.
        sched.advance(RECONNECT_TUNING.seekStallTimeoutMs + 1000);

        expect(onStateChange).toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('recovering');
    });

    it('does NOT fire while a slow but legitimate seek is still in flight', () => {
        // Server-side kill+restart seeks are slow (fresh FFmpeg generation must
        // produce the first segment). The bound must be generous enough not to
        // interrupt one.
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress();
        controller.setSeeking(true);

        sched.advance(RECONNECT_TUNING.seekStallTimeoutMs - 1000);

        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(controller.getState()).toBe('connected');
    });

    it('a completed seek lifts the suppression and cancels the seek watchdog', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller.notifyProgress();
        controller.setSeeking(true);

        sched.advance(1000);
        controller.notifyProgress(); // first frame after the seek — seek done

        // Well past the seek bound: the normal stall dead-man governs again,
        // and it was reset by that progress tick.
        sched.advance(RECONNECT_TUNING.stallTimeoutMs - 1000);
        expect(onStateChange).not.toHaveBeenCalledWith('recovering');

        // ...but the ordinary stall watchdog still applies afterwards.
        sched.advance(RECONNECT_TUNING.stallTimeoutMs + 1000);
        expect(onStateChange).toHaveBeenCalledWith('recovering');
    });
});

describe('ReconnectController — reset()', () => {
    it('clears verified-activity/unverified-streak state so a later spell starts clean', () => {
        // reset() is called on item/session switches (next episode, playlist
        // item) while the controller instance is reused. Verified activity
        // from the PREVIOUS item's dead recovery attempt must not corroborate
        // the NEW item's first recovery.
        const { controller, sched, onStateChange } = makeController();
        controller.trigger('network');
        sched.advance(computeBackoffDelay(0, () => 0));
        controller.notifyNetworkActivity(); // stale evidence from the old item

        controller.reset();
        expect(controller.getState()).toBe('connected');

        controller.trigger('session-expired');
        sched.advance(computeBackoffDelay(0, () => 0));
        onStateChange.mockClear();

        for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) {
            controller.notifyProgress();
        }
        sched.advance(RECONNECT_TUNING.confirmMs);
        expect(onStateChange).not.toHaveBeenCalledWith('connected');
        expect(controller.getState()).toBe('recovering');
    });
});

/**
 * player-controller.svelte.ts's incident-reporting wiring — the
 * `onStateChange` callback passed to `new ReconnectController({...})`.
 *
 * PlayerController itself cannot be instantiated in tests (Svelte 5 runes +
 * heavy DOM/HLS.js dependencies — the same constraint documented in
 * initial-position-heartbeat.test.ts), so this drives a REAL
 * ReconnectController through this file's own FakeScheduler/makeController
 * harness, wired to an onStateChange callback that is a byte-for-byte mirror
 * of the block actually added to player-controller.svelte.ts's constructor
 * (see the `state === 'recovering'` branch there). A minimal stub
 * (playerStore-like `store` + spy-based `reporter`) stands in for
 * playerStore/IncidentReporter — those are exercised directly by
 * playerStore.test.ts and incident-reporter.test.ts.
 */
describe('PlayerController incident-reporting wiring — ordering invariant', () => {
    interface StubReporter {
        reportReconnect: (playSessionId: string, cause: string) => void;
        reportRecovered: () => void;
        reportTerminal: (playSessionId: string) => void;
    }

    function makeWiredController(store: { playSessionId: string }, reporter: StubReporter) {
        const sched = new FakeScheduler();
        // Mirrors rebuildPlaybackSession() renewing playerStore.playSessionId
        // once an actual recovery attempt runs.
        const attemptRecovery = vi.fn((cause: ReconnectCause) => {
            store.playSessionId = `renewed-after-${cause}`;
        });
        // `controllerRef` mirrors how the real code reads `this.reconnect?.getCause()`
        // from inside the very onStateChange callback passed to the constructor
        // that assigns `this.reconnect` — resolved by the time it's ever invoked.
        let controllerRef: ReconnectController | undefined;
        const controller = new (ReconnectController as typeof ReconnectController)({
            attemptRecovery,
            schedule: sched.schedule,
            onStateChange: (state) => {
                if (state === 'recovering') {
                    const cause = controllerRef?.getCause() ?? null;
                    // MUST read store.playSessionId and report it BEFORE any
                    // renewal — this whole branch runs synchronously, before
                    // scheduleNextAttempt()/attemptRecovery ever fires.
                    reporter.reportReconnect(store.playSessionId, cause ?? 'network');
                } else if (state === 'connected') {
                    reporter.reportRecovered();
                } else {
                    reporter.reportTerminal(store.playSessionId);
                }
            },
            rng: () => 0,
            isHidden: () => false,
        });
        controllerRef = controller;
        return { controller, sched, attemptRecovery };
    }

    it('reports a reconnect incident using the PRE-renewal play_session_id', () => {
        const store = { playSessionId: 'sess-original' };
        const reportReconnectSpy = vi.fn();
        const reporter: StubReporter = {
            reportReconnect: reportReconnectSpy,
            reportRecovered: vi.fn(),
            reportTerminal: vi.fn(),
        };
        const { controller, sched } = makeWiredController(store, reporter);

        const sessionIdBeforeRenewal = store.playSessionId;

        controller.trigger('network');

        expect(reportReconnectSpy).toHaveBeenCalledWith(sessionIdBeforeRenewal, 'network');

        // Prove the assertion above is not a timing accident: the session id
        // really does get renewed once the retry fires, AFTER the report.
        sched.advance(computeBackoffDelay(0, () => 0));
        expect(store.playSessionId).not.toBe(sessionIdBeforeRenewal);
        expect(reportReconnectSpy).toHaveBeenCalledTimes(1);
        expect(reportReconnectSpy).toHaveBeenLastCalledWith(sessionIdBeforeRenewal, 'network');
    });

    it('reports recovered on a confirmed reconnect', () => {
        const store = { playSessionId: 'sess-1' };
        const reportRecoveredSpy = vi.fn();
        const reporter: StubReporter = {
            reportReconnect: vi.fn(),
            reportRecovered: reportRecoveredSpy,
            reportTerminal: vi.fn(),
        };
        const { controller, sched } = makeWiredController(store, reporter);

        controller.trigger('network');
        sched.advance(computeBackoffDelay(0, () => 0));
        controller.notifyNetworkActivity();
        for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) {
            controller.notifyProgress();
        }
        sched.advance(RECONNECT_TUNING.confirmMs);

        expect(controller.getState()).toBe('connected');
        expect(reportRecoveredSpy).toHaveBeenCalledTimes(1);
    });

    it('reports terminal with the current play_session_id once the retry budget is exhausted', () => {
        const store = { playSessionId: 'sess-1' };
        const reportTerminalSpy = vi.fn();
        const reporter: StubReporter = {
            reportReconnect: vi.fn(),
            reportRecovered: vi.fn(),
            reportTerminal: reportTerminalSpy,
        };
        const { controller, sched } = makeWiredController(store, reporter);

        controller.trigger('network');
        sched.advance(600000); // budget runs out → terminal

        expect(controller.getState()).toBe('terminal');
        expect(reportTerminalSpy).toHaveBeenCalledTimes(1);
        expect(reportTerminalSpy).toHaveBeenLastCalledWith(store.playSessionId);
    });
});

describe('ReconnectController — refundAttempt (the player could not act)', () => {
    it('does not spend the budget when the dispatched attempt could not run', () => {
        // rebuildPlaybackSession() bails at `if (!this.tryStartRestart()) return`
        // when a restart is already in flight, so the attempt does nothing — yet
        // scheduleNextAttempt() has already incremented the counter. Prod
        // 2026-09-11: sessions a0000001/a0000002 were created with
        // transcode_job_id NULL and issued ZERO /hls manifest requests, while
        // the ladder counted them and went terminal.
        const { controller, sched, attemptRecovery } = makeController();
        controller.trigger('network');

        sched.advance(computeBackoffDelay(0, () => 0));
        expect(attemptRecovery).toHaveBeenLastCalledWith('network', 1);

        controller.refundAttempt(); // the player could not act on it

        sched.advance(computeBackoffDelay(1, () => 0));
        // Re-dispatched as attempt 1, not 2 — the slot was not consumed.
        expect(attemptRecovery).toHaveBeenLastCalledWith('network', 1);
    });

    it('still reaches terminal — a refund defers the budget, never removes it', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.trigger('network');
        sched.advance(computeBackoffDelay(0, () => 0));
        controller.refundAttempt();

        // Run well past the budget: terminal must still arrive.
        for (let i = 0; i < RECONNECT_TUNING.maxRecoverAttempts + 3; i++) {
            sched.advance(RECONNECT_TUNING.maxDelayMs);
        }
        expect(onStateChange).toHaveBeenCalledWith('terminal', 'retries-exhausted');
    });

    it('is inert when connected, so a stray call cannot rewind a healthy session', () => {
        const { controller, sched, attemptRecovery } = makeController();
        controller.refundAttempt();
        controller.trigger('network');
        sched.advance(computeBackoffDelay(0, () => 0));
        expect(attemptRecovery).toHaveBeenLastCalledWith('network', 1);
    });
});

describe('ReconnectController — beginProgrammaticRestart (quality/audio switch)', () => {
    it('does not fire the old stream’s stall dead-man while the new stream starts', () => {
        // Windows e2e 2026-09-27 (S1): a 720p NVENC restart needed longer than
        // stallTimeoutMs for its first segment. The dead-man armed by the OLD
        // stream fired mid-restart and the nudge/rebuild ladder tore the new
        // transcode down until terminal.
        const { controller, sched, onStateChange, attemptRecovery } = makeController();
        controller.setIntendedPlaying(true);
        establishPlayback(controller);

        controller.beginProgrammaticRestart();
        sched.advance(RECONNECT_TUNING.hardCeilingMs * 2);

        expect(onStateChange).not.toHaveBeenCalledWith('recovering');
        expect(attemptRecovery).not.toHaveBeenCalled();
        expect(controller.getState()).toBe('connected');
    });

    it('re-arms the dead-man once the new stream has really played', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        establishPlayback(controller);
        controller.beginProgrammaticRestart();

        // First tick is the start-position seek jump of the new stream — not
        // yet proof of playback.
        controller.notifyProgress();
        sched.advance(RECONNECT_TUNING.stallTimeoutMs * 2);
        expect(controller.getState()).toBe('connected');

        // Second tick: the new stream plays; a freeze after it IS a stall.
        controller.notifyProgress();
        sched.advance(RECONNECT_TUNING.stallTimeoutMs);
        expect(onStateChange).toHaveBeenCalledWith('recovering');
    });

    it('keeps playback intent across the restart', () => {
        const { controller, sched, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        establishPlayback(controller);
        controller.beginProgrammaticRestart();
        // No setIntendedPlaying(true) again — the user never paused.
        establishPlayback(controller);
        sched.advance(RECONNECT_TUNING.stallTimeoutMs);
        expect(onStateChange).toHaveBeenCalledWith('recovering');
    });

    it('leaves an in-progress recovery in charge', () => {
        const { controller, sched, attemptRecovery } = makeController();
        controller.trigger('network');
        controller.beginProgrammaticRestart();
        expect(controller.getState()).toBe('recovering');
        sched.advance(computeBackoffDelay(0, () => 0));
        expect(attemptRecovery).toHaveBeenCalledWith('network', 1);
    });

    it('does not resurrect a terminal session', () => {
        const { controller } = makeController();
        controller.trigger('network', { terminal: true });
        controller.beginProgrammaticRestart();
        expect(controller.getState()).toBe('terminal');
    });
});

describe('ReconnectController — rebuild grace', () => {
    // Preprod 2026-09-30: a rebuild reached loadedmetadata 13s after its manifest and
    // the next attempt (plain backoff, <=10s) tore it down mid-seek, every time, until
    // the budget ran out.
    it('holds the next attempt for rebuildGraceMs after a rebuild is dispatched', () => {
        const { controller, sched, attemptRecovery } = makeController();
        attemptRecovery.mockReturnValue('rebuild');

        controller.trigger('session-expired');
        sched.advance(computeBackoffDelay(0, () => 0));
        expect(attemptRecovery).toHaveBeenCalledTimes(1);

        sched.advance(RECONNECT_TUNING.rebuildGraceMs - 1);
        expect(attemptRecovery).toHaveBeenCalledTimes(1);

        sched.advance(1);
        expect(attemptRecovery).toHaveBeenCalledTimes(2);
    });

    it('a new failure of the rebuilt source ends the grace instead of being deduped into it', () => {
        const { controller, sched, attemptRecovery } = makeController();
        attemptRecovery.mockReturnValue('rebuild');

        controller.trigger('session-expired');
        sched.advance(computeBackoffDelay(0, () => 0));
        expect(attemptRecovery).toHaveBeenCalledTimes(1);

        controller.trigger('session-expired'); // the NEW session failed too
        sched.advance(computeBackoffDelay(1, () => 0));
        expect(attemptRecovery).toHaveBeenCalledTimes(2);
    });

    it('a nudge keeps the plain backoff', () => {
        const { controller, sched, attemptRecovery } = makeController();
        attemptRecovery.mockReturnValue('nudge');

        controller.trigger('stall');
        sched.advance(computeBackoffDelay(0, () => 0));
        sched.advance(computeBackoffDelay(1, () => 0));
        expect(attemptRecovery).toHaveBeenCalledTimes(2);
    });

    it('the rebuilt stream playing inside the grace confirms recovery without another attempt', () => {
        const { controller, sched, attemptRecovery, onStateChange } = makeController();
        attemptRecovery.mockReturnValue('rebuild');

        controller.trigger('session-expired');
        sched.advance(computeBackoffDelay(0, () => 0));
        sched.advance(12_000); // slow first segment, still inside the grace
        controller.notifyNetworkActivity();
        for (let i = 0; i < RECONNECT_TUNING.minConfirmTicks; i++) controller.notifyProgress();
        sched.advance(RECONNECT_TUNING.confirmMs);

        expect(onStateChange).toHaveBeenLastCalledWith('connected');
        sched.advance(60_000);
        expect(attemptRecovery).toHaveBeenCalledTimes(1);
    });
});

describe('ReconnectController — bounded startup', () => {
    it.each([false, true])(
        'bounds startup despite network activity and a seek jump (seek=%s)',
        (seek) => {
            const { controller, sched, attemptRecovery } = makeController();
            controller.setIntendedPlaying(true);
            if (seek) controller.setSeeking(true);
            controller.notifyProgress(); // Resume position, not decoded playback.
            for (let i = 0; i < 59; i++) {
                sched.advance(1000);
                controller.notifyNetworkActivity();
                controller.setIntendedPlaying(true);
            }
            expect(controller.getState()).toBe('connected');
            sched.advance(1000);
            expect(controller.getState()).toBe('recovering');
            sched.advance(600000);
            expect(attemptRecovery).toHaveBeenCalledTimes(RECONNECT_TUNING.maxRecoverAttempts);
            expect(controller.getState()).toBe('terminal');
        },
    );

    it('bounds a first seek with no progress event at all', () => {
        const { controller, sched } = makeController();
        controller.setIntendedPlaying(true);
        controller.setSeeking(true);
        sched.advance(RECONNECT_TUNING.startupTimeoutMs);
        expect(controller.getState()).toBe('recovering');
    });

    it('does not count waiting for a gesture as a failed startup', () => {
        let acceptedPlay = false;
        const { controller, sched, attemptRecovery } = makeController({
            canRecoverStartup: () => acceptedPlay,
        });
        controller.setIntendedPlaying(true);
        sched.advance(RECONNECT_TUNING.startupTimeoutMs * 3);
        expect(controller.getState()).toBe('connected');
        expect(attemptRecovery).not.toHaveBeenCalled();
        acceptedPlay = true;
        controller.setIntendedPlaying(true); // The DOM play event after a tap.
        sched.advance(RECONNECT_TUNING.startupTimeoutMs);
        expect(controller.getState()).toBe('recovering');
    });

    it('starts the full allowance at accepted play, not at the earlier autoplay request', () => {
        let acceptedPlay = false;
        const { controller, sched } = makeController({ canRecoverStartup: () => acceptedPlay });
        controller.setIntendedPlaying(true);
        sched.advance(RECONNECT_TUNING.startupTimeoutMs - 1);
        acceptedPlay = true;
        controller.setIntendedPlaying(true);
        sched.advance(RECONNECT_TUNING.startupTimeoutMs - 1);
        expect(controller.getState()).toBe('connected');
        sched.advance(1);
        expect(controller.getState()).toBe('recovering');
    });

    it('cancels startup on pause and gives an explicit resume a fresh allowance', () => {
        const { controller, sched, attemptRecovery } = makeController();
        controller.setIntendedPlaying(true);
        sched.advance(RECONNECT_TUNING.startupTimeoutMs - 1);
        controller.setIntendedPlaying(false);
        sched.advance(RECONNECT_TUNING.startupTimeoutMs * 2);
        expect(attemptRecovery).not.toHaveBeenCalled();
        controller.setIntendedPlaying(true);
        sched.advance(RECONNECT_TUNING.startupTimeoutMs - 1);
        expect(controller.getState()).toBe('connected');
        sched.advance(1);
        expect(controller.getState()).toBe('recovering');
    });

    it('defers a hidden startup without spending attempts and rearms on visibility', () => {
        let hidden = false;
        const { controller, sched, attemptRecovery } = makeController({ isHidden: () => hidden });
        controller.setIntendedPlaying(true);
        hidden = true;
        sched.advance(RECONNECT_TUNING.startupTimeoutMs * 2);
        expect(controller.getState()).toBe('connected');
        expect(attemptRecovery).not.toHaveBeenCalled();
        hidden = false;
        controller.onVisible();
        sched.advance(RECONNECT_TUNING.startupTimeoutMs - 1);
        expect(controller.getState()).toBe('connected');
        sched.advance(1);
        expect(controller.getState()).toBe('recovering');
    });

    it('hands off to ordinary playback watchdogs after real progress', () => {
        const { controller, sched } = makeController();
        controller.setIntendedPlaying(true);
        sched.advance(RECONNECT_TUNING.startupTimeoutMs - 1000);
        establishPlayback(controller);
        sched.advance(1000); // Old startup deadline must be canceled.
        expect(controller.getState()).toBe('connected');
        sched.advance(RECONNECT_TUNING.stallTimeoutMs - 1000);
        expect(controller.getState()).toBe('recovering');
    });

    it.each(['reset', 'destroy'] as const)('cancels the startup deadline on %s', (operation) => {
        const { controller, sched, attemptRecovery, onStateChange } = makeController();
        controller.setIntendedPlaying(true);
        controller[operation]();
        sched.advance(RECONNECT_TUNING.startupTimeoutMs * 3);
        expect(attemptRecovery).not.toHaveBeenCalled();
        expect(onStateChange).not.toHaveBeenCalled();
    });

    it('bounds a deliberate stream replacement with a fresh startup allowance', () => {
        const { controller, sched } = makeController();
        controller.setIntendedPlaying(true);
        establishPlayback(controller);
        controller.beginProgrammaticRestart();
        sched.advance(RECONNECT_TUNING.startupTimeoutMs - 1);
        expect(controller.getState()).toBe('connected');
        sched.advance(1);
        expect(controller.getState()).toBe('recovering');
    });

    it('reports the failed startup and media snapshot before recovery renews its session', () => {
        const sched = new FakeScheduler();
        const post = vi.fn().mockResolvedValue(undefined);
        const beacon = vi.fn();
        let session = 'initial-session';
        const reporter = new IncidentReporter({
            attemptId: 'startup-attempt',
            buffer: new IncidentRingBuffer({ maxEntries: 120, maxAgeMs: 90000 }),
            deviceId: 'test-device',
            clientInfo: () => ({ media: { currentTime: 1205.25, decodedFrames: 0 } }),
            post,
            patchResolve: vi.fn().mockResolvedValue(undefined),
            beacon,
            now: () => sched.now,
        });
        const controller = new ReconnectController({
            schedule: sched.schedule,
            onStateChange: (state) => {
                if (state === 'recovering')
                    reporter.reportReconnect(session, controller.getCause());
            },
            attemptRecovery: () => {
                session = 'replacement-session';
                return 'rebuild';
            },
            rng: () => 0,
        });
        controller.setIntendedPlaying(true);
        sched.advance(RECONNECT_TUNING.startupTimeoutMs);
        expect(post).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                playSessionId: 'initial-session',
                triggerType: 'reconnect',
                reconnectCause: 'stall',
                clientInfo: { media: { currentTime: 1205.25, decodedFrames: 0 } },
            }),
        );
        sched.advance(computeBackoffDelay(0, () => 0));
        expect(session).toBe('replacement-session');
        reporter.onPageHide();
        expect(beacon).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                playSessionId: 'initial-session',
                triggerType: 'terminal',
            }),
        );
        controller.destroy();
    });
});

describe('ReconnectController — slow encoder (server says it cannot keep up)', () => {
    // Windows tower 2026-10-14: NVENC shared with game streaming, segments every
    // 12–15 s. The 6 s dead-man flipped the player to "Reconnecting" between
    // every segment, and its rebuilds restarted the transcode it waited for.
    it('waits through stalls instead of reconnecting while the encoder is slow', () => {
        let slow = true;
        const { controller, sched, onStateChange } = makeController({
            isStallExpected: () => slow,
        });
        controller.setIntendedPlaying(true);
        establishPlayback(controller);

        // A 6 s segment at 0.45x: ~13 s without playhead progress, repeatedly.
        for (let i = 0; i < 5; i++) {
            sched.advance(13_000);
            expect(controller.getState()).toBe('connected');
            establishPlayback(controller);
        }
        expect(onStateChange).not.toHaveBeenCalledWith('recovering');

        // Encoder recovered: the ordinary dead-man applies again.
        slow = false;
        sched.advance(RECONNECT_TUNING.stallTimeoutMs);
        expect(controller.getState()).toBe('recovering');
    });

    it('still catches a dead stream: the hard ceiling extends a bounded number of times', () => {
        const { controller, sched } = makeController({ isStallExpected: () => true });
        controller.setIntendedPlaying(true);
        establishPlayback(controller);

        const budget =
            RECONNECT_TUNING.hardCeilingMs * (RECONNECT_TUNING.slowEncoderExtensions + 1);
        sched.advance(budget - 1);
        expect(controller.getState()).toBe('connected');
        sched.advance(1);
        expect(controller.getState()).toBe('recovering');
    });

    it('real progress refills the extensions', () => {
        const { controller, sched } = makeController({ isStallExpected: () => true });
        controller.setIntendedPlaying(true);
        establishPlayback(controller);
        // Each segment needs 60 s (0.1x): longer than one hard ceiling.
        for (let i = 0; i < 4; i++) {
            sched.advance(60_000);
            expect(controller.getState()).toBe('connected');
            establishPlayback(controller);
        }
    });

    it('a slow first segment extends the startup deadline, by a bounded budget', () => {
        const { controller, sched } = makeController({
            isStallExpected: () => true,
            canRecoverStartup: () => true,
        });
        controller.setIntendedPlaying(true);
        const budget =
            RECONNECT_TUNING.startupTimeoutMs * (RECONNECT_TUNING.slowEncoderExtensions + 1);
        sched.advance(budget - 1);
        expect(controller.getState()).toBe('connected');
        sched.advance(1);
        expect(controller.getState()).toBe('recovering');
    });

    it('a seek on a slow encoder waits for its first segment, then gives up after the budget', () => {
        const { controller, sched } = makeController({ isStallExpected: () => true });
        controller.setIntendedPlaying(true);
        establishPlayback(controller);
        controller.setSeeking(true);
        const budget =
            RECONNECT_TUNING.seekStallTimeoutMs * (RECONNECT_TUNING.slowEncoderExtensions + 1);
        sched.advance(budget - 1);
        expect(controller.getState()).toBe('connected');
        sched.advance(1);
        expect(controller.getState()).toBe('recovering');
    });

    it('a seek without a slow encoder still recovers at seekStallTimeoutMs', () => {
        const { controller, sched } = makeController({ isStallExpected: () => false });
        controller.setIntendedPlaying(true);
        establishPlayback(controller);
        controller.setSeeking(true);
        sched.advance(RECONNECT_TUNING.seekStallTimeoutMs);
        expect(controller.getState()).toBe('recovering');
    });
});
