// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaseRadioStream } from './radio-stream-lease.js';

afterEach(() => {
    vi.useRealTimers();
});

describe('live radio delivery lease', () => {
    it.each(['revoked', 'unavailable'] as const)(
        'cancels even a stalled origin when authorization is %s',
        async (failure) => {
            vi.useFakeTimers();
            const cancel = vi.fn();
            const authorize =
                failure === 'revoked'
                    ? vi.fn(async () => false)
                    : vi.fn(async () => {
                          throw new Error('database down');
                      });
            const response = leaseRadioStream(
                new ReadableStream({ cancel }),
                new AbortController().signal,
                authorize,
            );
            const result = response
                .getReader()
                .read()
                .catch(() => null);
            await vi.advanceTimersByTimeAsync(10_000);
            await result;
            expect(cancel).toHaveBeenCalledOnce();
            expect(authorize).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(30_000);
            expect(authorize).toHaveBeenCalledOnce();
        },
    );

    it('forwards bytes with backpressure and clears its timer when the client cancels', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        const authorize = vi.fn(async () => true);
        const response = leaseRadioStream(
            new ReadableStream({
                start(c) {
                    c.enqueue(new Uint8Array([1, 2]));
                },
                cancel,
            }),
            new AbortController().signal,
            authorize,
        );
        const reader = response.getReader();
        expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
        await reader.cancel();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(cancel).toHaveBeenCalledOnce();
        expect(authorize).not.toHaveBeenCalled();
    });

    it('cancels the origin when the request disconnects', async () => {
        const request = new AbortController();
        const cancel = vi.fn();
        const response = leaseRadioStream(
            new ReadableStream({ cancel }),
            request.signal,
            async () => true,
        );
        const result = response
            .getReader()
            .read()
            .catch(() => null);
        request.abort();
        await result;
        expect(cancel).toHaveBeenCalledOnce();
    });
});
