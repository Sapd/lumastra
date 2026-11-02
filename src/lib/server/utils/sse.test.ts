// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startSseKeepalive, SSE_KEEPALIVE_MS } from './sse';

/** Minimal fake ReadableStream controller that records enqueues and can be made to throw. */
function makeController() {
    const chunks: Uint8Array[] = [];
    let dead = false;
    return {
        chunks,
        kill: () => {
            dead = true;
        },
        controller: {
            enqueue(chunk: Uint8Array) {
                if (dead) throw new TypeError('controller closed');
                chunks.push(chunk);
            },
        } as unknown as ReadableStreamDefaultController<Uint8Array>,
    };
}

describe('startSseKeepalive', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('writes a comment frame on the default cadence and runs onTick', () => {
        const { controller, chunks } = makeController();
        const onTick = vi.fn();
        const stop = startSseKeepalive(controller, { onTick });

        expect(chunks).toHaveLength(0); // nothing until the first interval fires
        vi.advanceTimersByTime(SSE_KEEPALIVE_MS);
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0])).toBe(': ping\n\n');
        expect(onTick).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(SSE_KEEPALIVE_MS * 2);
        expect(chunks).toHaveLength(3);
        stop();
    });

    it('honors a custom interval', () => {
        const { controller, chunks } = makeController();
        startSseKeepalive(controller, { intervalMs: 1000 });
        vi.advanceTimersByTime(3000);
        expect(chunks).toHaveLength(3);
    });

    it('stops ticking after stop() and is idempotent', () => {
        const { controller, chunks } = makeController();
        const stop = startSseKeepalive(controller);
        vi.advanceTimersByTime(SSE_KEEPALIVE_MS);
        expect(chunks).toHaveLength(1);
        stop();
        stop(); // idempotent — must not throw
        vi.advanceTimersByTime(SSE_KEEPALIVE_MS * 5);
        expect(chunks).toHaveLength(1); // no further writes
    });

    it('self-clears and calls onDead exactly once when the client disconnects', () => {
        const { controller, chunks, kill } = makeController();
        const onDead = vi.fn();
        startSseKeepalive(controller, { onDead });

        vi.advanceTimersByTime(SSE_KEEPALIVE_MS);
        expect(chunks).toHaveLength(1);

        kill(); // subsequent enqueue throws → dead
        vi.advanceTimersByTime(SSE_KEEPALIVE_MS);
        expect(onDead).toHaveBeenCalledTimes(1);

        // Ticker must be gone — no more writes, onDead not called again.
        vi.advanceTimersByTime(SSE_KEEPALIVE_MS * 5);
        expect(onDead).toHaveBeenCalledTimes(1);
    });

    it('does not run onTick when the write throws', () => {
        const { controller, kill } = makeController();
        const onTick = vi.fn();
        startSseKeepalive(controller, { onTick });
        kill();
        vi.advanceTimersByTime(SSE_KEEPALIVE_MS);
        expect(onTick).not.toHaveBeenCalled();
    });

    it('a throwing onTick does NOT stop the ticker or fire onDead (write succeeded)', () => {
        const { controller, chunks } = makeController();
        const onDead = vi.fn();
        const onTick = vi.fn(() => {
            throw new Error('unrelated onTick bug');
        });
        startSseKeepalive(controller, { onTick, onDead });

        // Multiple ticks: writes keep succeeding, onTick keeps throwing (swallowed).
        vi.advanceTimersByTime(SSE_KEEPALIVE_MS * 3);
        expect(chunks).toHaveLength(3); // stream stayed alive
        expect(onTick).toHaveBeenCalledTimes(3);
        expect(onDead).not.toHaveBeenCalled(); // NOT treated as a disconnect
    });

    it('a throwing onDead does not escape the tick', () => {
        const { controller, kill } = makeController();
        const onDead = vi.fn(() => {
            throw new Error('teardown bug');
        });
        startSseKeepalive(controller, { onDead });
        kill();
        // Must not throw out of the timer callback.
        expect(() => vi.advanceTimersByTime(SSE_KEEPALIVE_MS)).not.toThrow();
        expect(onDead).toHaveBeenCalledTimes(1);
    });

    it('intervalMs <= 0 disables the keepalive and returns an inert stop()', () => {
        const { controller, chunks } = makeController();
        const stopZero = startSseKeepalive(controller, { intervalMs: 0 });
        const stopNeg = startSseKeepalive(controller, { intervalMs: -5 });
        vi.advanceTimersByTime(SSE_KEEPALIVE_MS * 10);
        expect(chunks).toHaveLength(0); // never ticked
        expect(() => {
            stopZero();
            stopNeg();
        }).not.toThrow();
    });

    it('SSE_KEEPALIVE_MS stays under a 30s QUIC idle default with margin', () => {
        expect(SSE_KEEPALIVE_MS).toBeLessThanOrEqual(15_000);
        expect(SSE_KEEPALIVE_MS).toBeGreaterThan(0);
    });
});
