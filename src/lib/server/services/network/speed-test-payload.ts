// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Incompressible payload generator for the active network speed test.
 *
 * The client downloads this payload and times the transfer itself; the
 * bytes must be genuinely random so nothing on the wire (compression,
 * caching, dedup) can shortcut the download and skew the measurement.
 */

export const SPEED_TEST_BLOCK_BYTES = 1024 * 1024;

/** WebCrypto's `getRandomValues` refuses to fill more than 65536 bytes at once. */
const MAX_RANDOM_FILL_BYTES = 65536;

let cachedBlock: Uint8Array | null = null;

/**
 * A lazily-generated, process-cached 1 MiB block of random bytes. Generated
 * once per process (in 64 KiB slices, per the WebCrypto per-call limit) and
 * reused for every speed-test request.
 */
export function speedTestBlock(): Uint8Array {
    if (cachedBlock === null) {
        const block = new Uint8Array(SPEED_TEST_BLOCK_BYTES);
        for (let offset = 0; offset < block.length; offset += MAX_RANDOM_FILL_BYTES) {
            const end = Math.min(offset + MAX_RANDOM_FILL_BYTES, block.length);
            globalThis.crypto.getRandomValues(block.subarray(offset, end));
        }
        cachedBlock = block;
    }
    return cachedBlock;
}

/**
 * A stream that repeats {@link speedTestBlock} until exactly `totalBytes`
 * have been enqueued (the final chunk is truncated to fit), then closes.
 * Aborting `signal` closes the stream early, without exceeding `totalBytes`.
 *
 * ## Why the abort listener must not trust the controller
 *
 * On a client disconnect the SvelteKit node adapter CANCELS the stream first and
 * only then aborts `request.signal`, so by the time the listener runs the
 * controller is usually already closed — and `close()` on a closed controller
 * throws `TypeError: Invalid state: Controller is already closed`. Thrown from
 * inside an abort listener that is an `uncaughtException`, not a rejected
 * promise: no request-scoped `try`/`catch` can see it, and only the
 * `hooks.server.ts` backstop kept the process alive. And this is the DESIGNED
 * path — the client aborts every test at its own 20 s cap — so it must be
 * ordinary, silent behaviour: `closed` is set first (which stops any further
 * enqueue), the close itself is best-effort, and `cancel()` detaches the
 * listener so a cancelled stream stops listening at all.
 */
export function speedTestStream(
    totalBytes: number,
    signal?: AbortSignal,
): ReadableStream<Uint8Array> {
    let remaining = totalBytes;
    let closed = false;
    let onAbort: (() => void) | null = null;

    /**
     * Drop the abort listener. Called on cancel AND on normal completion —
     * `signal` outlives this stream (it belongs to the request), so a listener
     * left behind holds the controller alive for the rest of the request.
     */
    function detach(): void {
        if (onAbort !== null) {
            signal?.removeEventListener('abort', onAbort);
            onAbort = null;
        }
    }

    return new ReadableStream<Uint8Array>({
        start(controller) {
            if (signal === undefined) return;
            if (signal.aborted) {
                closed = true;
                controller.close();
                return;
            }
            onAbort = (): void => {
                // Order matters: `closed` first, so even if the close below is
                // a no-op, `pull` enqueues nothing more.
                closed = true;
                try {
                    controller.close();
                } catch {
                    // Already closed (the adapter cancelled first) or errored —
                    // there is nothing left to close, and this is the normal
                    // disconnect path, not a fault.
                }
            };
            // `once` because an AbortSignal fires at most once anyway; it also
            // means the listener is gone even on the path that never cancels.
            signal.addEventListener('abort', onAbort, { once: true });
        },
        pull(controller) {
            if (closed) return;
            if (remaining <= 0) {
                closed = true;
                detach();
                controller.close();
                return;
            }
            const block = speedTestBlock();
            const chunk = remaining >= block.length ? block : block.subarray(0, remaining);
            controller.enqueue(chunk);
            remaining -= chunk.length;
        },
        cancel() {
            closed = true;
            detach();
        },
    });
}
