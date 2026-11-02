// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { open, type FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Reconnects (including AVPlayer probe/seek handoffs) retain the shared encode. */
export const PROGRESSIVE_READER_GRACE_MS = 20_000;

/** Pins include admitted requests still awaiting session/cache I/O. */
export class ProgressiveReaders {
    private count = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private done = false;

    constructor(private controller: AbortController) {
        controller.signal.addEventListener('abort', () => this.finish(), { once: true });
    }

    pin(): () => void {
        clearTimeout(this.timer);
        this.count++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--this.count !== 0 || this.done) return;
            this.timer = setTimeout(() => {
                this.controller.abort('no music readers after reconnect grace');
            }, PROGRESSIVE_READER_GRACE_MS);
            this.timer.unref();
        };
    }

    /** Once encoding ends, let the pending cache normalization/commit finish. */
    finish(): void {
        this.done = true;
        clearTimeout(this.timer);
    }
}

/** The advertised CBR byte length; the completed file MUST be resized to match. */
export function expectedMp3Size(
    durationSeconds: number | undefined,
    bitrateKbps: number,
    sourceSize?: number,
    sourceBitrate?: number,
): number | null {
    if (
        !durationSeconds ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        durationSeconds >= 6 * 60 * 60 ||
        !Number.isInteger(bitrateKbps) ||
        bitrateKbps <= 0
    )
        return null;
    if (sourceSize !== undefined) {
        const inferredBitrate = (sourceSize * 8) / durationSeconds;
        if (
            !Number.isFinite(inferredBitrate) ||
            inferredBitrate < 16_000 ||
            inferredBitrate > 6_000_000
        )
            return null;
        // Allow container overhead and VBR variation, but reject gross tag errors.
        if (
            sourceBitrate &&
            Number.isFinite(sourceBitrate) &&
            sourceBitrate > 0 &&
            (inferredBitrate < sourceBitrate / 4 || inferredBitrate > sourceBitrate * 4)
        )
            return null;
    }
    const size = Math.ceil((durationSeconds * bitrateKbps * 1000) / 8);
    return Number.isSafeInteger(size) && size > 0 ? size : null;
}

export interface TailFileOptions {
    partialPath: string;
    finalPath: string;
    start: number;
    end: number;
    expectedSize: number;
    completion: Promise<void>;
    signal?: AbortSignal;
    timeoutMs?: number;
    pollMs?: number;
    onClose?: (error?: unknown) => void;
}

/** Bounded, backpressured reads from a growing file; an open fd survives promotion. */
export function tailFile(options: TailFileOptions): ReadableStream<Uint8Array> {
    const stop = new AbortController();
    let handle: FileHandle | undefined;
    let position = options.start;
    let finished = false;
    let encodeDone = false;
    let failure: unknown;
    let failed = false;
    let lastGrowthAt = Date.now();
    let lastSize = 0;
    let web: ReadableStreamDefaultController<Uint8Array>;
    const close = async (error?: unknown): Promise<void> => {
        if (finished) return;
        finished = true;
        stop.abort();
        options.signal?.removeEventListener('abort', onAbort);
        try {
            await handle?.close();
        } finally {
            options.onClose?.(error);
        }
    };
    const fail = (error: unknown): void => {
        if (finished) return;
        const reason = error instanceof Error ? error : new Error(String(error));
        web.error(reason);
        void close(reason).catch(() => {});
    };
    const onAbort = (): void => fail(new Error('Music range aborted'));
    options.completion
        .then(() => {
            encodeDone = true;
        })
        .catch((error: unknown) => {
            failed = true;
            failure = error;
            fail(error);
        });
    return new ReadableStream<Uint8Array>(
        {
            start(controller): void {
                web = controller;
                if (options.signal?.aborted) onAbort();
                else options.signal?.addEventListener('abort', onAbort, { once: true });
            },
            async pull(controller): Promise<void> {
                try {
                    while (!finished) {
                        if (failed) throw failure;
                        if (!handle) {
                            for (const path of [options.partialPath, options.finalPath]) {
                                try {
                                    handle = await open(path, 'r');
                                    break;
                                } catch (error) {
                                    if ((error as { code?: unknown }).code !== 'ENOENT')
                                        throw error;
                                }
                            }
                            // An abort can race the asynchronous open. Close its fd too.
                            if (finished) {
                                await handle?.close();
                                return;
                            }
                        }
                        if (handle) {
                            const { size } = await handle.stat();
                            if (size > lastSize) {
                                lastSize = size;
                                lastGrowthAt = Date.now();
                            }
                        }
                        const doneBeforeRead = encodeDone;
                        // Hold the last byte of a full response until success, so an
                        // encoder failure cannot masquerade as a complete HTTP body.
                        const limit =
                            !doneBeforeRead && options.end === options.expectedSize - 1
                                ? options.end - 1
                                : options.end;
                        if (handle && position <= limit) {
                            const buffer = Buffer.allocUnsafe(
                                Math.min(64 * 1024, limit - position + 1),
                            );
                            const { bytesRead } = await handle.read(
                                buffer,
                                0,
                                buffer.length,
                                position,
                            );
                            if (finished) return;
                            if (bytesRead) {
                                position += bytesRead;
                                controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
                                if (position > options.end) {
                                    controller.close();
                                    await close();
                                }
                                return;
                            }
                            // Completion can race a zero-byte read issued before
                            // truncate extended the file. Recompute the limit and retry.
                            if (encodeDone && !doneBeforeRead) continue;
                            if (encodeDone)
                                throw new Error('Encoded music ended before the requested byte');
                        }
                        if (encodeDone && position <= options.end && !handle)
                            throw new Error('Music range file missing');
                        if (
                            !encodeDone &&
                            Date.now() - lastGrowthAt >= (options.timeoutMs ?? 120_000)
                        ) {
                            throw new Error('Timed out waiting for encoded music bytes');
                        }
                        await delay(options.pollMs ?? 100, undefined, { signal: stop.signal });
                    }
                } catch (error) {
                    fail(error);
                }
            },
            async cancel(reason): Promise<void> {
                await close(reason instanceof Error ? reason : new Error('Music range cancelled'));
            },
        },
        { highWaterMark: 0 },
    );
}
