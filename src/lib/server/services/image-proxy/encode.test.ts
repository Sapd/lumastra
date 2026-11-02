// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
import { runImageEncode } from './encode';
import { runImageProviderBudget } from './work-budget';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function drain(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function requestEncode(encode: () => Promise<unknown>, signal?: AbortSignal): Promise<Response> {
    return runImageProviderBudget(
        async () => null,
        async () => {
            await runImageEncode(encode);
            return new Response('encoded');
        },
        async () => null,
        false,
        signal,
    );
}

it('bounds the request FIFO at 256 and maps overload to 503 + Retry-After, including caught errors', async () => {
    const release = deferred();
    const encode = vi.fn(async () => {
        await release.promise;
    });
    const jobs = Array.from({ length: 260 }, () => requestEncode(encode));
    try {
        await drain();
        expect(encode).toHaveBeenCalledTimes(4);
        const overflow = await requestEncode(encode);
        expect(overflow.status).toBe(503);
        expect(overflow.headers.get('Retry-After')).toBe('2');
        expect((await overflow.json()).code).toBe('dependency_unavailable');
        const caught = await runImageProviderBudget(
            async () => null,
            async () => {
                try {
                    await runImageEncode(encode);
                } catch {
                    /* legacy image fallback */
                }
                return new Response('placeholder');
            },
        );
        expect(caught.status).toBe(503);
        expect(caught.headers.get('Retry-After')).toBe('2');
        expect(encode).toHaveBeenCalledTimes(4);
    } finally {
        release.resolve();
        await Promise.all(jobs);
    }
    expect(encode).toHaveBeenCalledTimes(260);
    expect((await requestEncode(async () => undefined)).status).toBe(200);
});

it('removes aborted waiters immediately, frees queue capacity, and never starts their encodes', async () => {
    const release = deferred();
    const active = Array.from({ length: 4 }, () => requestEncode(async () => release.promise));
    const controller = new AbortController();
    const cancelledEncode = vi.fn(async () => undefined);
    const cancelled = requestEncode(cancelledEncode, controller.signal).catch(
        (error: unknown) => error,
    );
    const queuedEncode = vi.fn(async () => undefined);
    const queued = Array.from({ length: 255 }, () => requestEncode(queuedEncode));
    try {
        await drain();
        expect((await requestEncode(queuedEncode)).status).toBe(503);
        controller.abort();
        expect(await cancelled).toMatchObject({ name: 'AbortError' });
        const replacement = requestEncode(queuedEncode);
        queued.push(replacement);
        await drain();
        expect(queuedEncode).not.toHaveBeenCalled();
        expect((await requestEncode(queuedEncode)).status).toBe(503);
    } finally {
        release.resolve();
        await Promise.all([...active, ...queued]);
    }
    expect(cancelledEncode).not.toHaveBeenCalled();
    expect(queuedEncode).toHaveBeenCalledTimes(256);
});

it('rejects already aborted requests without charging or acquiring a permit', async () => {
    const controller = new AbortController();
    controller.abort();
    const charge = vi.fn(async () => null);
    const encode = vi.fn(async () => undefined);
    await expect(
        runImageProviderBudget(
            async () => null,
            async () => {
                await runImageEncode(encode);
                return new Response();
            },
            charge,
            false,
            controller.signal,
        ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(encode).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
});

it('caps background work at two independently of the request FIFO and keeps request permits until completion', async () => {
    const releaseRequests = deferred();
    const releaseBackground = deferred();
    const requestJob = vi.fn(async () => releaseRequests.promise);
    const backgroundJob = vi.fn(async () => releaseBackground.promise);
    const controller = new AbortController();
    const requests = [
        requestEncode(requestJob, controller.signal),
        ...Array.from({ length: 4 }, () => requestEncode(requestJob)),
    ];
    const background = Array.from({ length: 3 }, () => runImageEncode(backgroundJob));
    try {
        await drain();
        expect(requestJob).toHaveBeenCalledTimes(4);
        expect(backgroundJob).toHaveBeenCalledTimes(2);
        controller.abort();
        await drain();
        expect(requestJob).toHaveBeenCalledTimes(4);
        releaseRequests.resolve();
        expect((await Promise.all(requests)).every((response) => response.status === 200)).toBe(
            true,
        );
        expect(requestJob).toHaveBeenCalledTimes(5);
        expect(backgroundJob).toHaveBeenCalledTimes(2);
        expect((await requestEncode(async () => undefined)).status).toBe(200);
    } finally {
        releaseRequests.resolve();
        releaseBackground.resolve();
        await Promise.all([...requests, ...background]);
    }
    expect(backgroundJob).toHaveBeenCalledTimes(3);
});
