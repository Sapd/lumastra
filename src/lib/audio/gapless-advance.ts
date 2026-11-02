// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Predictive A/B-deck advance across a file boundary.
 *
 * ## Why this exists
 *
 * 87% of a real audiobook library is multi-file (1028 of 1175 measured), median
 * ~8 files, median duration 1.2 h — a file boundary roughly every nine minutes,
 * and usually `chapters.length === audioFiles.length` so every chapter change
 * is also a boundary. Whatever happens at a boundary happens constantly.
 *
 * Prototype 4a measured four strategies against a continuous 440 Hz tone split
 * over two files, sampling output RMS per 256-sample block, with a forced-200 ms
 * control strategy validating the instrument on every run:
 *
 * | Strategy                      | Chromium mp3 | Chromium m4a | WebKit mp3 |
 * | ----------------------------- | ------------ | ------------ | ---------- |
 * | CONTROL (forced 200 ms)       | 192 ms       | 213 ms       | 2549 ms    |
 * | naive `src` swap on `ended`   | 0 ms         | 21 ms        | 2379 ms    |
 * | preloaded element swap        | 0 ms         | 21 ms        | 2347 ms    |
 * | predictive A/B decks (this)   | 0 ms         | 0 ms         | 0 ms       |
 *
 * The difference between the last two rows is the whole design: the incoming
 * element must already be *rendering audio* at the swap instant. A warm-but-
 * paused element is not enough.
 *
 * ## What that costs — MEASURED 2026-07-29, no longer inferred
 *
 * Because the incoming deck must already be playing at the swap, it has
 * necessarily consumed `leadMs` of wall-clock time — `leadMs * rate` of its own
 * audio — and that audio is never heard. This is inherent, not a bug to be
 * tuned away: for the join to be both gap-free and content-exact the incoming
 * source would have to start producing sound instantaneously, which an
 * `HTMLMediaElement` does not.
 *
 * The 4a harness measured *gaps*, so it could not have caught this: a clipped
 * head reads as 0 ms of silence exactly like a perfect join does. The harness
 * was rebuilt (`scripts/gapless-harness`) with file B as a rising chirp, so the
 * frequency at the join says how much of B was skipped, and with a
 * forced-200 ms-clip control alongside the forced-200 ms-gap one. Headless
 * Chromium, localhost, this scheduler:
 *
 * | Strategy            | mp3 gap / lost | m4a gap / lost |
 * | ------------------- | -------------- | -------------- |
 * | naive cold start    | 5 ms / 14 ms   | 23 ms / 3 ms   |
 * | predictive lead 50  | 0 ms / 37 ms   | 0 ms / 35 ms   |
 * | predictive lead 150 | 0 ms / 137 ms  | 0 ms / 139 ms  |
 * | predictive lead 250 | 0 ms / 241 ms  | 0 ms / 236 ms  |
 *
 * So the loss tracks `leadMs` almost exactly, on both containers. The real
 * choice at a boundary is **~20 ms of audible discontinuity (cold start) versus
 * ~140 ms of missing words (this, at the current default)** — about a syllable,
 * every ~9 minutes on a real multi-file book. That is a judgement about speech
 * that only a human listening can settle, which is why the default is left
 * where it is rather than tuned from a localhost number: `lead_50` was also
 * gapless *here*, but localhost with warm buffers is the most favourable
 * possible case for a short lead, and the lead exists for the unfavourable one.
 *
 * {@link GaplessAdvanceParams.onCommitted} therefore has the caller read the
 * now-active deck's ACTUAL clock, so a virtual timeline rebases on measurement
 * instead of on the requested offset — otherwise the book drifts one lead per
 * boundary.
 *
 * ## Scheduling
 *
 * Polling, not `timeupdate`: `timeupdate` fires at the browser's discretion
 * (~250 ms in Chromium) and is throttled in background tabs, which is exactly
 * where a 20-hour listen lives. The poll only decides *when to arm*; the swap
 * itself is handed to the backend with a deadline so a Web Audio backend can
 * schedule it on the audio clock rather than a timer.
 */

import { DEFAULT_GAPLESS_LEAD_MS, DEFAULT_GAPLESS_PREWARM_MS } from './types';

/** Backend-supplied deck operations the scheduler drives. */
export interface GaplessAdvanceOps {
    /** Position of the audible deck, ms. */
    getOutgoingTimeMs(): number;
    /** Duration of the audible deck, ms. 0 / non-finite when unknown. */
    getOutgoingDurationMs(): number;
    /** Effective rate of the audible deck (used to convert media time to wall time). */
    getPlaybackRate(): number;
    /**
     * Attach the incoming src to the inactive deck, silence it, seek it to
     * `startAtMs` and apply `playbackRate`. Left paused.
     */
    prepareIncoming(): Promise<void>;
    /**
     * Start the (already prepared) inactive deck playing at zero gain.
     * Resolves false if the element refused to play — autoplay policy, a
     * decode error, or a src that 404'd.
     */
    playIncomingSilent(): Promise<boolean>;
    /**
     * Make the inactive deck audible and silence the outgoing one, `delaySec`
     * from now. Backends with an audio clock schedule this; others time it.
     */
    commitSwap(delaySec: number): void;
    /**
     * Undo a swap that will not be committed.
     *
     * **Must restore the OUTGOING deck as well as the incoming one.** By the
     * time this runs, `commitSwap` may already have scheduled the outgoing
     * deck's gain to drop to zero at a future audio-clock time — an
     * `abortIncoming` that only pauses the incoming deck leaves that drop in
     * place, and the book goes silent mid-sentence at a boundary that never
     * happened.
     */
    abortSwap(): void;
}

export interface GaplessAdvanceParams {
    leadMs?: number;
    prewarmMs?: number;
    /**
     * Fired once the swap is audible and the backend has flipped its active
     * deck. Takes no position argument on purpose: the caller must read the
     * now-active deck's real clock, which is `leadMs * rate` past the requested
     * offset (see the file header).
     */
    onCommitted: () => void;
    /**
     * Fired when the scheduler gives up on its own — a preparation that threw,
     * an incoming deck that refused to play, an arm point missed by a stalled
     * poll, or a duration that vanished mid-flight.
     *
     * NOT fired for an external {@link GaplessAdvanceScheduler.cancel}: that
     * caller already knows. Backends suppress the outgoing deck's `ended` while
     * an advance is in flight, so without this the flag would never clear and
     * the real boundary would be swallowed — playback stalling at the end of a
     * file with nothing in the log.
     */
    onCancelled?: () => void;
}

/** Poll cadence. Fine enough that the arm point is hit within a frame's worth of slack. */
const POLL_INTERVAL_MS = 25;

/**
 * Below this much remaining wall-clock time there is no point arming: the
 * incoming deck could not reach a rendering state before the boundary, so a
 * cold-start advance on `ended` is the honest outcome.
 */
const MIN_ARMABLE_REMAINING_MS = 20;

type Phase = 'idle' | 'watching' | 'preparing' | 'prepared' | 'armed';

export class GaplessAdvanceScheduler {
    private phase: Phase = 'idle';
    private poll: ReturnType<typeof setInterval> | null = null;
    private commitTimer: ReturnType<typeof setTimeout> | null = null;
    private ops: GaplessAdvanceOps | null = null;
    private params: GaplessAdvanceParams | null = null;
    private leadMs = DEFAULT_GAPLESS_LEAD_MS;
    private prewarmMs = DEFAULT_GAPLESS_PREWARM_MS;

    /** True while an advance is scheduled and not yet committed or cancelled. */
    get isScheduled(): boolean {
        return this.phase !== 'idle';
    }

    /**
     * Begin watching the audible deck for its boundary.
     *
     * Returns false when there is nothing to schedule against — an unknown or
     * non-finite duration, or a boundary already closer than the lead. Callers
     * treat that as "fall back to the cold-start path", not as an error.
     */
    start(ops: GaplessAdvanceOps, params: GaplessAdvanceParams): boolean {
        this.cancel();

        this.leadMs = Math.max(0, params.leadMs ?? DEFAULT_GAPLESS_LEAD_MS);
        this.prewarmMs = Math.max(this.leadMs, params.prewarmMs ?? DEFAULT_GAPLESS_PREWARM_MS);

        const remaining = remainingWallMs(ops);
        if (remaining === null) return false;
        if (remaining <= Math.max(this.leadMs, MIN_ARMABLE_REMAINING_MS)) return false;

        this.ops = ops;
        this.params = params;
        this.phase = 'watching';
        this.poll = setInterval(() => this.tick(), POLL_INTERVAL_MS);
        return true;
    }

    /**
     * Drop a scheduled advance.
     *
     * MUST be called before any seek: the swap is scheduled against a boundary
     * that a seek moves, and a stale schedule would cut to the next file
     * mid-sentence.
     */
    cancel(): void {
        if (this.poll !== null) {
            clearInterval(this.poll);
            this.poll = null;
        }
        if (this.commitTimer !== null) {
            clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }
        // Only tear the swap down if we actually touched a deck. Calling
        // abortSwap() unconditionally would silence a deck a later
        // play()/crossfade had since taken over.
        if (this.phase === 'preparing' || this.phase === 'prepared' || this.phase === 'armed') {
            this.ops?.abortSwap();
        }
        this.phase = 'idle';
        this.ops = null;
        this.params = null;
    }

    private tick(): void {
        const ops = this.ops;
        if (!ops) return;

        const remaining = remainingWallMs(ops);
        if (remaining === null) {
            // Duration went unknown mid-flight (src swapped underneath us).
            // Give up; `ended` still fires and the caller falls back — but only
            // once the caller is told to stop suppressing it.
            this.giveUp();
            return;
        }

        if (this.phase === 'watching' && remaining <= this.prewarmMs) {
            this.phase = 'preparing';
            void ops.prepareIncoming().then(
                () => {
                    // Only NOW is the incoming deck seeked to its start offset.
                    // Arming while that seek is still in flight would start the
                    // deck from wherever it happened to be — on a slow
                    // connection, from the wrong place entirely.
                    if (this.phase === 'preparing') this.phase = 'prepared';
                },
                () => this.giveUp(),
            );
            return;
        }

        if (this.phase === 'preparing' && remaining < MIN_ARMABLE_REMAINING_MS) {
            // The preparation did not finish in time.
            this.giveUp();
            return;
        }

        if (this.phase === 'prepared' && remaining <= this.leadMs) {
            if (remaining < MIN_ARMABLE_REMAINING_MS) {
                // We were late — a background-tab stall, or a lead shorter than
                // the poll interval. Do not half-commit: bail and let the
                // cold-start path handle the boundary.
                this.giveUp();
                return;
            }
            this.phase = 'armed';
            this.arm();
        }
    }

    /**
     * Abandon a scheduled advance and TELL THE CALLER.
     *
     * The distinction from {@link cancel} is the whole point: a backend
     * suppresses the outgoing deck's `ended` while an advance is in flight, so
     * a silent give-up leaves that suppression latched and the boundary is
     * swallowed — the book stops at the end of a file with nothing in the log.
     */
    private giveUp(): void {
        const onCancelled = this.params?.onCancelled;
        this.cancel();
        onCancelled?.();
    }

    /**
     * Start the incoming deck and hand the backend a swap deadline.
     *
     * Takes no `remaining` argument on purpose: awaiting `play()` costs real
     * time — on a slow decode, most of the lead — so the deadline is measured
     * again after the await rather than carried in from the arm point.
     */
    private arm(): void {
        const ops = this.ops;
        const params = this.params;
        if (!ops || !params) return;

        void ops.playIncomingSilent().then(
            (started) => {
                if (this.phase !== 'armed') return; // cancelled while awaiting
                if (!started) {
                    this.giveUp();
                    return;
                }

                const fresh = remainingWallMs(ops) ?? 0;
                const delayMs = Math.max(0, fresh);

                ops.commitSwap(delayMs / 1000);
                this.commitTimer = setTimeout(() => {
                    this.commitTimer = null;
                    if (this.phase !== 'armed') return;
                    if (this.poll !== null) {
                        clearInterval(this.poll);
                        this.poll = null;
                    }
                    const ownParams = params;
                    this.ops = null;
                    this.params = null;
                    this.phase = 'idle';
                    ownParams.onCommitted();
                }, delayMs);
            },
            () => {
                this.giveUp();
            },
        );
    }
}

/**
 * Wall-clock ms until the audible deck reaches its end, or null when that
 * cannot be known (no metadata, a stream, or a rate of zero).
 */
function remainingWallMs(ops: GaplessAdvanceOps): number | null {
    const duration = ops.getOutgoingDurationMs();
    if (!Number.isFinite(duration) || duration <= 0) return null;

    const position = ops.getOutgoingTimeMs();
    if (!Number.isFinite(position)) return null;

    const rate = ops.getPlaybackRate();
    if (!Number.isFinite(rate) || rate <= 0) return null;

    return Math.max(0, (duration - position) / rate);
}
