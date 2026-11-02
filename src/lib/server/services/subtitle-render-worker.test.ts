// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { runSubtitleWorker } from './subtitle-render-worker.js';

const busy = new URL('data:text/javascript,while(true){}');
it('terminates a busy worker at its deadline while the parent remains responsive', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
        ticks++;
    }, 5);
    try {
        await expect(
            runSubtitleWorker(Buffer.alloc(0), { entry: busy, timeoutMs: 100 }),
        ).rejects.toThrow(/deadline/i);
        expect(ticks).toBeGreaterThan(2);
    } finally {
        clearInterval(timer);
    }
});
it('cancels running and queued work and releases both worker permits', async () => {
    const running = new AbortController();
    const queued = new AbortController();
    const a = runSubtitleWorker(Buffer.alloc(0), { entry: busy, signal: running.signal });
    const b = runSubtitleWorker(Buffer.alloc(0), { entry: busy, signal: running.signal });
    const c = runSubtitleWorker(Buffer.alloc(0), { entry: busy, signal: queued.signal });
    const outcomes = Promise.allSettled([a, b, c]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    queued.abort(new Error('cancel queued'));
    running.abort(new Error('cancel running'));
    expect((await outcomes).every((r) => r.status === 'rejected')).toBe(true);
    const entry = new URL(
        'data:text/javascript,import {parentPort} from "node:worker_threads"; parentPort.postMessage(new Uint8Array([1,2,3]));',
    );
    const results = await Promise.all(
        Array.from({ length: 3 }, () =>
            runSubtitleWorker(Buffer.alloc(0), { entry, timeoutMs: 2000 }),
        ),
    );
    expect(results.every((r) => r?.equals(Buffer.from([1, 2, 3])))).toBe(true);
});

it('bounds the render queue and recovers after saturation', async () => {
    const controller = new AbortController();
    const runs = Array.from({ length: 10 }, () =>
        runSubtitleWorker(Buffer.alloc(0), { entry: busy, signal: controller.signal }),
    );
    const settled = Promise.allSettled(runs);
    await expect(runSubtitleWorker(Buffer.alloc(0), { entry: busy })).rejects.toThrow(
        /queue is full/i,
    );
    controller.abort(new Error('cancel saturated queue'));
    expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
});

it('gives queued work its complete execution deadline after acquiring a permit', async () => {
    const controller = new AbortController();
    const blockers = Promise.allSettled(
        Array.from({ length: 2 }, () =>
            runSubtitleWorker(Buffer.alloc(0), {
                entry: busy,
                timeoutMs: 5000,
                signal: controller.signal,
            }),
        ),
    );
    const entry = new URL(
        'data:text/javascript,import {parentPort} from "node:worker_threads"; parentPort.postMessage(new Uint8Array([9]));',
    );
    let settled = false;
    const queued = runSubtitleWorker(Buffer.alloc(0), { entry, timeoutMs: 250 }).then(
        (value) => {
            settled = true;
            return value;
        },
        (error: unknown) => {
            settled = true;
            return error;
        },
    );
    try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        controller.abort(new Error('release blockers'));
        expect(await queued).toEqual(Buffer.from([9]));
    } finally {
        controller.abort();
        await blockers;
        await queued;
    }
});

it('propagates budget counts as a retryable error instead of an empty track', async () => {
    const counts = {
        references: 3,
        uniqueBitmaps: 2,
        renderedPixels: 16,
        requestedPixels: 8,
        maxPixels: 16,
        maxReferences: 80_000,
        limit: 'pixels',
    };
    const entry = new URL(
        `data:text/javascript,import {parentPort} from "node:worker_threads"; parentPort.postMessage(${JSON.stringify({ type: 'budget-exceeded', counts })});`,
    );
    await expect(runSubtitleWorker(Buffer.alloc(0), { entry })).rejects.toMatchObject({
        name: 'SubtitleRenderBudgetError',
        counts,
    });
});
