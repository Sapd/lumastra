// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bookkeeping for stream restarts that overlap.
 *
 * The player allows ONE restart at a time (`isRestartingPlayback`). Before this
 * module existed, a restart that arrived while another was in flight was simply
 * DROPPED ("Already restarting, skipping"). Windows e2e 2026-09-27 (finding S1):
 * a 720p -> 1080p quality pick made while an earlier restart still held the
 * lock never reached the server at all, and the picker showed a quality the
 * stream was not playing.
 *
 * Two things live here, both DOM-free so they can be unit-tested (the
 * PlayerController itself cannot be instantiated in tests):
 *
 *  1. A one-slot queue with "latest wins" semantics. A quality restart reads
 *     the CURRENT quality/audio/burn-in state when it runs, so any number of
 *     queued quality requests collapse into one. A seek restart carries its
 *     target; a later seek replaces it. Quality + seek merge into a quality
 *     restart that resumes at the seek target, so neither intent is lost.
 *
 *  2. The resume snapshot (position + whether the user was playing). It is
 *     captured SYNCHRONOUSLY when the first restart of a burst starts and is
 *     reused by every restart that follows until the burst settles. A later
 *     restart cannot re-read it from the element: by then the element has been
 *     torn down (currentTime 0, paused), and reading it there is what reset a
 *     0:14 position to 0:00 and left the player paused after a quality switch.
 */

export interface RestartResume {
    /** Media position (seconds) the restarted stream should resume at. */
    position: number;
    /** Whether playback should resume once the new stream can play. */
    play: boolean;
}

export type QueuedRestart =
    /** Re-run the quality restart; `position` overrides the resume position. */
    | { kind: 'quality'; position: number | null }
    /** DirectStream seek beyond the buffer — restart at `position`. */
    | { kind: 'seek'; position: number };

export class RestartQueue {
    private pending: QueuedRestart | null = null;
    private resume: RestartResume | null = null;
    private gen = 0;

    /** Bumped by reset(); lets a deferred drain detect that the item changed. */
    get generation(): number {
        return this.gen;
    }

    hasPending(): boolean {
        return this.pending !== null;
    }

    /** A quality restart was requested while another restart holds the lock. */
    queueQuality(): void {
        const position = this.pending?.position ?? null;
        this.pending = { kind: 'quality', position };
    }

    /** A seek restart was requested while another restart holds the lock. */
    queueSeek(position: number): void {
        if (this.pending?.kind === 'quality') {
            // Keep the quality change, resume it where the user seeked to.
            this.pending = { kind: 'quality', position };
        } else {
            this.pending = { kind: 'seek', position };
        }
        this.noteSeek(position);
    }

    /** The user seeked while a restart is in flight: resume there instead. */
    noteSeek(position: number): void {
        if (this.resume) this.resume = { ...this.resume, position };
    }

    /**
     * Take the queued request (if any). Called when a restart acquires the
     * lock — a restart that reads the current state subsumes whatever was
     * queued — and when a restart finishes, to run the queued one.
     */
    takePending(): QueuedRestart | null {
        const next = this.pending;
        this.pending = null;
        return next;
    }

    /**
     * The resume snapshot for a restart that is starting now. The first restart
     * of a burst reads it (synchronously, before any await or teardown); later
     * restarts in the same burst reuse it. `positionOverride` (a queued seek
     * target) wins over both.
     */
    captureResume(read: () => RestartResume, positionOverride?: number | null): RestartResume {
        if (!this.resume) this.resume = read();
        if (positionOverride !== undefined && positionOverride !== null) {
            this.resume = { ...this.resume, position: positionOverride };
        }
        return this.resume;
    }

    /** The snapshot of the burst in flight, if any (for recovery paths). */
    currentResume(): RestartResume | null {
        return this.resume;
    }

    /**
     * The burst is over: the last restart finished and nothing is queued. The
     * next restart takes a fresh snapshot from the (now healthy) element.
     */
    settle(): void {
        if (!this.pending) this.resume = null;
    }

    /** New item/session: drop everything, invalidate deferred drains. */
    reset(): void {
        this.pending = null;
        this.resume = null;
        this.gen += 1;
    }
}
