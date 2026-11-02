// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { speedTestBlock, speedTestStream, SPEED_TEST_BLOCK_BYTES } from './speed-test-payload';

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
    let n = 0;
    const r = stream.getReader();
    for (;;) {
        const { done, value } = await r.read();
        if (done) return n;
        n += value.length;
    }
}
describe('speed test payload', () => {
    it('is a stable 1 MiB block of non-trivial entropy', () => {
        const a = speedTestBlock();
        expect(a.length).toBe(SPEED_TEST_BLOCK_BYTES);
        expect(speedTestBlock()).toBe(a);
        expect(new Set(a.subarray(0, 4096)).size).toBeGreaterThan(200);
    });
    it('streams exactly the requested byte count, including a partial final block', async () => {
        expect(await drain(speedTestStream(SPEED_TEST_BLOCK_BYTES * 2 + 12345))).toBe(
            SPEED_TEST_BLOCK_BYTES * 2 + 12345,
        );
    });
    it('stops when aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const r = speedTestStream(SPEED_TEST_BLOCK_BYTES * 8, ac.signal).getReader();
        const { done } = await r.read();
        expect(done).toBe(true);
    });

    /**
     * The disconnect order the SvelteKit node adapter actually uses: it CANCELS
     * the response stream and only afterwards aborts `request.signal`. An
     * unconditional `controller.close()` in the abort listener then throws
     * `TypeError: Invalid state: Controller is already closed` — and because the
     * throw happens inside an `AbortSignal` listener, Node reports it as an
     * `uncaughtException` instead of rethrowing from `abort()`. So asserting
     * `expect(() => ac.abort()).not.toThrow()` would pass even with the bug;
     * the listener has to be invoked directly for the assertion to mean anything.
     */
    it('survives the cancel-then-abort order of a real client disconnect', async () => {
        const ac = new AbortController();
        const addSpy = vi.spyOn(ac.signal, 'addEventListener');

        const reader = speedTestStream(SPEED_TEST_BLOCK_BYTES * 8, ac.signal).getReader();
        await reader.read();
        await reader.cancel();

        const [type, listener, options] = addSpy.mock.calls[0];
        expect(type).toBe('abort');
        expect(options).toEqual({ once: true });
        expect(() => (listener as EventListener)(new Event('abort'))).not.toThrow();
    });

    it('enqueues nothing more once aborted mid-transfer', async () => {
        const ac = new AbortController();
        const reader = speedTestStream(SPEED_TEST_BLOCK_BYTES * 8, ac.signal).getReader();

        const first = await reader.read();
        expect(first.value?.length).toBe(SPEED_TEST_BLOCK_BYTES);
        ac.abort();

        let total = first.value?.length ?? 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
        }
        // Whatever was already queued for backpressure may still drain, but the
        // 8 MiB the caller asked for must NOT have been generated.
        expect(total).toBeLessThan(SPEED_TEST_BLOCK_BYTES * 8);
    });

    it('removes its abort listener once the payload has been fully sent', async () => {
        const ac = new AbortController();
        const addSpy = vi.spyOn(ac.signal, 'addEventListener');
        const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

        expect(await drain(speedTestStream(SPEED_TEST_BLOCK_BYTES, ac.signal))).toBe(
            SPEED_TEST_BLOCK_BYTES,
        );

        expect(removeSpy).toHaveBeenCalledWith('abort', addSpy.mock.calls[0][1]);
    });

    it('cancelling the reader detaches the listener', async () => {
        const ac = new AbortController();
        const addSpy = vi.spyOn(ac.signal, 'addEventListener');
        const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

        const reader = speedTestStream(SPEED_TEST_BLOCK_BYTES * 4, ac.signal).getReader();
        await reader.read();
        await reader.cancel();

        expect(removeSpy).toHaveBeenCalledWith('abort', addSpy.mock.calls[0][1]);
    });
});
