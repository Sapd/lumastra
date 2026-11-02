// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Bounded wait for a music-transcode concurrency slot.
//
// The concurrency caps exist to bound how many ffmpeg processes run at once.
// Rejecting outright the moment they're full is a separate (and wrong) policy:
// Subsonic clients bulk-download whole albums for offline use and pick their
// own parallelism, so *any* cap value gets exceeded and the excess requests
// fail with a 503 the client surfaces as "HTTP error". Waiting briefly for a
// slot turns the cap into a throughput limit — downloads slow down instead of
// erroring — while the ceiling on concurrent ffmpeg processes is unchanged.

/** The `Error & { status: 503 }` contract the slot acquirers throw when full. */
export function isCapRejection(err: unknown): boolean {
    return err instanceof Error && (err as { status?: number }).status === 503;
}

export interface SlotWaitOptions {
    /** Total time to keep retrying before surfacing the 503. 0 disables waiting. */
    timeoutMs: number;
    /** Delay between attempts. */
    pollMs?: number;
    /** Client disconnect — stop waiting and surface the rejection. */
    signal?: AbortSignal;
    /** Injectable for tests. */
    now?: () => number;
    /** Injectable for tests. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SlotWaitResult<T> {
    value: T;
    /** How long we queued — 0 on the fast path. Worth logging when non-zero. */
    waitedMs: number;
}

const DEFAULT_POLL_MS = 250;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(finish, ms);
        function finish(): void {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        }
        signal?.addEventListener('abort', finish, { once: true });
    });
}

/**
 * Call `acquire` until it succeeds, the deadline passes, or the client goes
 * away. Only cap rejections (503) are retried — any other failure propagates
 * on the first attempt, so a broken Valkey or a bad request still fails fast.
 */
export async function acquireWithWait<T>(
    acquire: () => Promise<T>,
    opts: SlotWaitOptions,
): Promise<SlotWaitResult<T>> {
    const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? defaultSleep;
    const started = now();
    const deadline = started + Math.max(0, opts.timeoutMs);

    for (;;) {
        // Check before attempting: a client that hung up while queued must not
        // take a slot it will never read from.
        if (opts.signal?.aborted) {
            const err = new Error(
                'Music transcode slot wait aborted: client disconnected',
            ) as Error & {
                status: number;
            };
            err.status = 503;
            throw err;
        }
        try {
            return { value: await acquire(), waitedMs: now() - started };
        } catch (err) {
            if (!isCapRejection(err)) throw err;
            if (opts.signal?.aborted) throw err;
            if (now() + pollMs > deadline) throw err;
            await sleep(pollMs, opts.signal);
        }
    }
}
