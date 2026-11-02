// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SubtitleRenderBudgetError, isSubtitleRenderCounts } from './subtitle-render-protocol.js';
import { AsyncSemaphore } from '../utils/async-semaphore.js';

const slots = new AsyncSemaphore(2);
const MAX_QUEUED = 8;
const DEADLINE_MS = 30_000;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

interface RenderWorkerOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Trusted entry override for lifecycle tests. Never supplied from requests. */
    entry?: URL;
}

/** Parse, convert, hash, encode and pack outside the serving event loop. No in-process fallback. */
export async function runSubtitleWorker(
    source: Buffer,
    options: RenderWorkerOptions = {},
): Promise<Buffer | null> {
    if (source.length > MAX_SOURCE_BYTES) throw new Error('Subtitle source exceeds byte budget');
    if (slots.waiting >= MAX_QUEUED) throw new Error('Subtitle render queue is full');
    return slots.withPermit(async () => {
        // Queue admission is bounded separately. Give every admitted worker its
        // full execution budget, regardless of how long its permit took to arrive.
        options.signal?.throwIfAborted();
        const deadline = new AbortController();
        const timer = setTimeout(
            () => deadline.abort(new Error('Subtitle render deadline exceeded')),
            options.timeoutMs ?? DEADLINE_MS,
        );
        const signal = options.signal
            ? AbortSignal.any([options.signal, deadline.signal])
            : deadline.signal;
        try {
            const bundle = join(process.cwd(), 'build', 'subtitle-render-entry.js');
            const entry = options.entry ?? (existsSync(bundle) ? pathToFileURL(bundle) : undefined);
            if (!entry && process.env.NODE_ENV === 'production') {
                throw new Error('Subtitle worker bundle is missing');
            }
            // tsx is already a production dependency. This development/test entry
            // stays in a worker too, so a missing build never restores sync parsing.
            const devEntry = pathToFileURL(
                join(process.cwd(), 'src/lib/server/services/subtitle-render-entry.ts'),
            ).href;
            const bytes = Uint8Array.from(source);
            const worker = new Worker(
                entry ??
                    `require('tsx/esm/api').tsImport(${JSON.stringify(devEntry)}, ${JSON.stringify(import.meta.url)});`,
                {
                    eval: !entry,
                    execArgv: [],
                    workerData: bytes,
                    transferList: [bytes.buffer],
                    resourceLimits: {
                        maxOldGenerationSizeMb: 256,
                        maxYoungGenerationSizeMb: 32,
                        stackSizeMb: 4,
                    },
                },
            );
            try {
                return await new Promise<Buffer | null>((resolve, reject) => {
                    const abort = (): void => reject(signal.reason);
                    signal.addEventListener('abort', abort, { once: true });
                    const detach = (): void => signal.removeEventListener('abort', abort);
                    worker.once('message', (message: unknown) => {
                        detach();
                        if (message === null) resolve(null);
                        else if (message instanceof Uint8Array)
                            resolve(
                                Buffer.from(message.buffer, message.byteOffset, message.byteLength),
                            );
                        else if (
                            message &&
                            typeof message === 'object' &&
                            'type' in message &&
                            message.type === 'budget-exceeded' &&
                            'counts' in message &&
                            isSubtitleRenderCounts(message.counts)
                        ) {
                            reject(new SubtitleRenderBudgetError(message.counts));
                        } else reject(new Error('Invalid subtitle worker result'));
                    });
                    worker.once('error', (error) => {
                        detach();
                        reject(error);
                    });
                    worker.once('exit', (code) => {
                        detach();
                        reject(new Error(`Subtitle worker exited before result (${code})`));
                    });
                    if (signal.aborted) abort();
                });
            } finally {
                // A permit represents a live worker: reclaim the thread before reuse.
                await worker.terminate();
            }
        } finally {
            clearTimeout(timer);
        }
    }, options.signal);
}
