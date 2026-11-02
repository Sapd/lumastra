// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-response bandwidth limiting.
 *
 * ## What this is for
 *
 * Serving a multi-gigabyte original file or a rendition at line rate lets one
 * client saturate the uplink and starve every live stream on the box. An
 * operator needs to be able to say "downloads get at most 10 MB/s" without
 * putting a reverse proxy in front of everything, so the cap is applied where
 * the bytes are produced.
 *
 * ## Token bucket, not sleep-per-chunk
 *
 * A naive `sleep(chunk / rate)` between reads couples the pacing to whatever
 * chunk size the filesystem happens to hand back (64 KiB for a local read, wildly
 * variable over NFS), so the achieved rate drifts with the storage backend. A
 * token bucket refills on wall-clock time and is therefore accurate regardless of
 * read granularity, and it lets a client that has been idle briefly burst — which
 * matters because HTTP clients read in bursts and a strictly-paced stream reads
 * as a stall.
 *
 * The bucket is per response. That is deliberate: the setting an operator reasons
 * about is "how fast may ONE download go", and a global pool would make a single
 * download's speed depend on how many other people happen to be downloading.
 *
 * ## Backpressure
 *
 * Pacing happens inside `pull()`, so it composes with the consumer's own
 * backpressure rather than fighting it: if the client reads slower than the cap,
 * the cap never engages and nothing is buffered. Cancelling the response destroys
 * the source stream, so an aborted download stops reading immediately instead of
 * paying out its remaining tokens to nobody.
 */

import type { Readable } from 'node:stream';

/** Bucket depth, expressed as seconds of transfer at the configured rate. */
const BURST_SECONDS = 1;

/**
 * Wrap a Node readable in a web `ReadableStream` that emits at most
 * `bytesPerSecond`.
 *
 * `bytesPerSecond <= 0` means unlimited and returns a plain passthrough — the
 * throttle must be free to disable, since that is the default configuration.
 */
export function throttleNodeStream(
    source: Readable,
    bytesPerSecond: number,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = defaultSleep,
): ReadableStream<Uint8Array> {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
        return nodeToWeb(source);
    }

    const capacity = bytesPerSecond * BURST_SECONDS;
    let tokens = capacity;
    let lastRefill = now();

    function refill(): void {
        const at = now();
        tokens = Math.min(capacity, tokens + ((at - lastRefill) / 1000) * bytesPerSecond);
        lastRefill = at;
    }

    /**
     * Charge `needed` bytes, waiting until the debt is paid off.
     *
     * The bucket is allowed to go NEGATIVE rather than requiring `tokens >=
     * needed` up front. That is not a stylistic choice: refill is clamped to
     * `capacity`, so a chunk larger than the bucket could never satisfy a
     * "wait until you have enough" condition and would spin forever. Spending
     * into debt and then waiting for it to drain handles any chunk size, and
     * still yields exactly `bytesPerSecond` on average.
     */
    async function spend(needed: number): Promise<void> {
        refill();
        tokens -= needed;
        while (tokens < 0) {
            await sleep(Math.max(1, Math.ceil((-tokens / bytesPerSecond) * 1000)));
            refill();
        }
    }

    const iterator = source[Symbol.asyncIterator]();

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { value, done } = await iterator.next();
                if (done) {
                    controller.close();
                    return;
                }
                const bytes = toUint8(value);
                await spend(bytes.byteLength);
                controller.enqueue(bytes);
            } catch (err) {
                controller.error(err);
            }
        },
        cancel(reason) {
            // Stop reading from disk the moment the client goes away.
            source.destroy(reason instanceof Error ? reason : undefined);
        },
    });
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toUint8(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (typeof value === 'string') return new TextEncoder().encode(value);
    return new Uint8Array(value as ArrayBuffer);
}

/** Unthrottled adaptation, so the disabled path costs nothing extra. */
function nodeToWeb(source: Readable): ReadableStream<Uint8Array> {
    const iterator = source[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { value, done } = await iterator.next();
                if (done) {
                    controller.close();
                    return;
                }
                controller.enqueue(toUint8(value));
            } catch (err) {
                controller.error(err);
            }
        },
        cancel(reason) {
            source.destroy(reason instanceof Error ? reason : undefined);
        },
    });
}

/** KB/s (as configured) → bytes/sec, with 0/negative meaning unlimited. */
export function kbpsToBytesPerSecond(kbps: number): number {
    if (!Number.isFinite(kbps) || kbps <= 0) return 0;
    return Math.floor(kbps * 1024);
}
