// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { parentPort, workerData } from 'node:worker_threads';
import { renderBitmapSubtitle } from './subtitle-render-core.js';
import { SubtitleRenderBudgetError } from './subtitle-render-protocol.js';

const source: unknown = workerData;
if (!(source instanceof Uint8Array) || !parentPort)
    throw new Error('Invalid subtitle worker input');
try {
    const blob = await renderBitmapSubtitle(
        Buffer.from(source.buffer, source.byteOffset, source.byteLength),
    );
    if (blob) {
        const bytes = Uint8Array.from(blob);
        parentPort.postMessage(bytes, [bytes.buffer]);
    } else {
        parentPort.postMessage(null);
    }
} catch (error) {
    // A budget failure carries counts and remains retryable; it is not an empty track.
    if (!(error instanceof SubtitleRenderBudgetError)) throw error;
    parentPort.postMessage({ type: 'budget-exceeded', counts: error.counts });
}
