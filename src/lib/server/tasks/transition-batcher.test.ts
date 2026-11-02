// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for TransitionBatcher — buffering, window/cap flush triggers,
 * and the stop()-during-in-flight-sink drain regression.
 *
 * Run with: npx vitest run src/lib/server/tasks/transition-batcher.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { TransitionBatcher, type TransitionRequest } from './transition-batcher.js';
import { taskTransitionBufferDroppedTotal } from './metrics.js';

function req(runId: string): TransitionRequest {
    return { runId, from: 'pending', to: 'active' };
}

describe('TransitionBatcher', () => {
    it('flushes once the batch cap is reached', async () => {
        const sink = vi.fn(async () => {});
        const batcher = new TransitionBatcher(10_000, 2, sink);

        batcher.enqueue(req('a'));
        expect(sink).not.toHaveBeenCalled();
        batcher.enqueue(req('b'));
        // enqueue's cap-triggered flush is fire-and-forget (`void this.flush()`).
        await Promise.resolve();
        await Promise.resolve();

        expect(sink).toHaveBeenCalledTimes(1);
        expect(sink).toHaveBeenCalledWith([req('a'), req('b')]);
        expect(batcher.pendingCount()).toBe(0);
    });

    it('does not strand events enqueued while a sink is in flight — stop() drains them', async () => {
        // Regression test: stop() used to set `stopped=true` and await
        // flush(), which returns immediately when a sink is already
        // in-flight (flushing === true). Anything enqueued during that
        // in-flight sink was never flushed because the in-flight flush's
        // finally block skips re-arming the timer once `stopped` is set.
        let releaseSink: (() => void) | null = null;
        const seenBatches: TransitionRequest[][] = [];
        const sink = vi.fn(async (batch: TransitionRequest[]) => {
            seenBatches.push(batch);
            if (seenBatches.length === 1) {
                // Block the first sink call until the test releases it, so we
                // can enqueue more events while it's still "in flight".
                await new Promise<void>((resolve) => {
                    releaseSink = resolve;
                });
            }
        });
        const batcher = new TransitionBatcher(10_000, 100, sink);

        // Kick off the first flush (in-flight sink) without awaiting it.
        batcher.enqueue(req('first'));
        const firstFlush = batcher.flush();
        // Let the sink call start and hit the awaited gate.
        await Promise.resolve();
        await Promise.resolve();
        expect(sink).toHaveBeenCalledTimes(1);

        // Enqueue a second event WHILE the first sink call is still pending.
        batcher.enqueue(req('during-inflight'));
        expect(batcher.pendingCount()).toBe(1);

        // Now stop the batcher — it must wait for the in-flight sink AND then
        // drain the event that arrived during it, instead of stranding it.
        const stopPromise = batcher.stop();

        // Release the first sink call so everything can proceed.
        // `releaseSink` is only ever assigned inside the sink closure, so
        // control-flow analysis narrows the outer read back to its `null`
        // initializer and drops the call signature. Widen to the declared union
        // and optional-call so the real (runtime-assigned) resolver still runs.
        const release = releaseSink as (() => void) | null;
        release?.();
        await firstFlush;
        await stopPromise;

        expect(sink).toHaveBeenCalledTimes(2);
        expect(seenBatches[1]).toEqual([req('during-inflight')]);
        expect(batcher.pendingCount()).toBe(0);
    });

    it('retains only unresolved original requests ahead of arrivals during a sink', async () => {
        let finish!: () => void;
        const held = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const first = req('first');
        const acknowledged = req('acknowledged');
        const later = req('later');
        let fail = true;
        const sink = vi.fn(async (_batch: TransitionRequest[]) => {
            if (fail) {
                await held;
                return { unresolved: [first] };
            }
            return { unresolved: [] };
        });
        const batcher = new TransitionBatcher(10_000, 100, sink);
        batcher.enqueue(first);
        batcher.enqueue(acknowledged);
        const flushing = batcher.flush();
        batcher.enqueue(later);
        finish();
        await flushing;
        expect(batcher.pendingCount()).toBe(2);
        fail = false;
        await batcher.stop({ strict: true });
        expect(sink.mock.calls.map(([batch]) => batch)).toEqual([
            [first, acknowledged],
            [first, later],
        ]);
        expect(batcher.pendingCount()).toBe(0);
    });

    it('retains tolerant failures for bounded strict retries with a fresh budget', async () => {
        let fail = true;
        const sink = vi.fn(async (): Promise<void> => {
            if (fail) throw new Error('sink unavailable');
        });
        const batcher = new TransitionBatcher(10_000, 100, sink);
        batcher.enqueue(req('retained'));
        await batcher.stop();
        expect(sink).toHaveBeenCalledTimes(2);
        expect(batcher.pendingCount()).toBe(1);
        await expect(batcher.stop({ strict: true })).rejects.toThrow('UNKNOWN');
        expect(sink).toHaveBeenCalledTimes(4);
        fail = false;
        await batcher.stop({ strict: true });
        expect(sink).toHaveBeenCalledTimes(5);
        expect(batcher.pendingCount()).toBe(0);
    });

    it('waits for a failed in-flight sink and retains its obligation during stop', async () => {
        let finish!: () => void;
        const held = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const sink = vi.fn(async (): Promise<void> => {
            await held;
            throw new Error('unacknowledged sink');
        });
        const batcher = new TransitionBatcher(10_000, 1, sink);
        batcher.enqueue(req('retained'));
        const stopping = batcher.stop({ strict: true });
        const rejected = expect(stopping).rejects.toThrow('UNKNOWN');
        finish();
        await rejected;
        expect(sink).toHaveBeenCalledTimes(3);
        expect(batcher.pendingCount()).toBe(1);
    });

    it('retries unresolved work with bounded backoff and recovers without new arrivals or stop', async () => {
        vi.useFakeTimers();
        let fail = true;
        const sink = vi.fn(async (batch: TransitionRequest[]) => ({
            unresolved: fail ? batch : [],
        }));
        const batcher = new TransitionBatcher(10, 1, sink);
        try {
            batcher.enqueue(req('retained'));
            await vi.advanceTimersByTimeAsync(0);
            expect(sink).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(999);
            expect(sink).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(sink).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1999);
            expect(sink).toHaveBeenCalledTimes(2);
            fail = false;
            await vi.advanceTimersByTimeAsync(1);
            expect(sink).toHaveBeenCalledTimes(3);
            expect(batcher.pendingCount()).toBe(0);
        } finally {
            fail = false;
            await batcher.stop({ strict: true });
            vi.useRealTimers();
        }
    });

    it('enqueue after stop() is a silent no-op', async () => {
        const sink = vi.fn(async () => {});
        const batcher = new TransitionBatcher(10_000, 100, sink);
        await batcher.stop();

        batcher.enqueue(req('late'));

        expect(batcher.pendingCount()).toBe(0);
        expect(sink).not.toHaveBeenCalled();
    });

    it('stop() bounds its drain loop when the sink keeps failing', async () => {
        // If the sink is permanently broken, stop() must not hang forever —
        // it gives up after two consecutive failures (matching flush()'s
        // existing catch-and-log behavior).
        const sink = vi.fn(async () => {
            throw new Error('sink permanently broken');
        });
        const batcher = new TransitionBatcher(10_000, 1, sink);

        batcher.enqueue(req('a'));
        // maxBatch === 1 triggers an immediate fire-and-forget flush; let it
        // run (and fail) before calling stop().
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Enqueue more so stop() has something to drain (and keep failing on).
        batcher.enqueue(req('b'));
        batcher.enqueue(req('c'));

        await expect(batcher.stop()).resolves.toBeUndefined();
        // Bounded: gave up after repeated failures rather than looping forever.
        expect(sink.mock.calls.length).toBeGreaterThan(0);
    });

    describe('buffer cap during a persistence outage', () => {
        async function dropped(kind: 'terminal' | 'non_terminal'): Promise<number> {
            const metric = await taskTransitionBufferDroppedTotal.get();
            return metric.values.find((value) => value.labels.kind === kind)?.value ?? 0;
        }
        function transition(
            runId: string,
            from: TransitionRequest['from'],
            to: TransitionRequest['to'],
        ): TransitionRequest {
            return { runId, from, to };
        }
        // A huge maxBatch and window keep everything buffered, as during an outage.
        function outageBatcher(
            sink: (batch: TransitionRequest[]) => Promise<void>,
        ): TransitionBatcher {
            return new TransitionBatcher(60_000, 1_000_000, sink, { maxBuffered: 5, hardCap: 8 });
        }

        it('merges a run chain into one request that starts from the held state', async () => {
            const seen: TransitionRequest[][] = [];
            const batcher = outageBatcher(async (batch) => {
                seen.push(batch);
            });
            const before = await dropped('non_terminal');
            batcher.enqueue(transition('a', 'pending', 'active'));
            batcher.enqueue(transition('a', 'active', 'completed'));
            for (const id of ['b', 'c', 'd', 'e'])
                batcher.enqueue(transition(id, 'pending', 'active'));
            expect(batcher.pendingCount()).toBe(5);
            expect(await dropped('non_terminal')).toBe(before);
            await batcher.stop();
            expect(seen.flat()[0]).toEqual(transition('a', 'pending', 'completed'));
        });

        it('applies coalesced chains through a compare-and-set sink without conflicts', async () => {
            // The orchestrator sink applies each request as CAS(from → to).
            const held = new Map<string, string>();
            const conflicts: TransitionRequest[] = [];
            const batcher = outageBatcher(async (batch) => {
                for (const req of batch) {
                    if ((held.get(req.runId) ?? 'pending') !== req.from) conflicts.push(req);
                    else held.set(req.runId, req.to);
                }
            });
            batcher.enqueue(transition('a', 'pending', 'active'));
            batcher.enqueue(transition('a', 'active', 'cancelling'));
            batcher.enqueue(transition('a', 'cancelling', 'cancelled'));
            for (const id of ['b', 'c', 'd', 'e', 'f'])
                batcher.enqueue(transition(id, 'pending', 'active'));
            await batcher.stop();
            expect(conflicts).toEqual([]);
            expect(held.get('a')).toBe('cancelled');
        });

        it('never folds a terminal transition into a later non-terminal one', async () => {
            const seen: TransitionRequest[][] = [];
            const batcher = outageBatcher(async (batch) => {
                seen.push(batch);
            });
            batcher.enqueue(transition('a', 'active', 'failed'));
            batcher.enqueue(transition('a', 'pending', 'active'));
            for (const id of ['b', 'c', 'd', 'e'])
                batcher.enqueue(transition(id, 'pending', 'active'));
            await batcher.stop();
            expect(seen.flat()[0]).toEqual(transition('a', 'active', 'failed'));
        });

        it('drops the oldest non-terminal transitions, never a terminal one, and counts them', async () => {
            const seen: TransitionRequest[][] = [];
            const batcher = outageBatcher(async (batch) => {
                seen.push(batch);
            });
            const before = await dropped('non_terminal');
            batcher.enqueue(transition('t1', 'active', 'completed'));
            batcher.enqueue(transition('n1', 'pending', 'active'));
            batcher.enqueue(transition('n2', 'pending', 'active'));
            batcher.enqueue(transition('t2', 'active', 'failed'));
            batcher.enqueue(transition('n3', 'pending', 'active'));
            batcher.enqueue(transition('n4', 'pending', 'active'));
            // Trimmed to the low-water mark (cap 5 → 4) so the next pass is amortised.
            expect(batcher.pendingCount()).toBe(4);
            expect(await dropped('non_terminal')).toBe(before + 2);
            await batcher.stop();
            expect(seen.flat().map((req) => req.runId)).toEqual(['t1', 't2', 'n3', 'n4']);
        });

        it('keeps terminal transitions past the soft cap and drops only beyond the hard cap', async () => {
            const batcher = outageBatcher(async () => {});
            const before = await dropped('terminal');
            for (let i = 0; i < 8; i++) batcher.enqueue(transition(`t${i}`, 'active', 'completed'));
            expect(batcher.pendingCount()).toBe(8);
            expect(await dropped('terminal')).toBe(before);
            batcher.enqueue(transition('t8', 'active', 'completed'));
            expect(batcher.pendingCount()).toBe(7);
            expect(await dropped('terminal')).toBe(before + 2);
            await batcher.stop();
        });

        it('does bounded overflow work for many enqueues above the cap', async () => {
            const batcher = new TransitionBatcher(60_000, 1_000_000, async () => {}, {
                maxBuffered: 1_000,
                hardCap: 5_000,
            });
            for (let i = 0; i < 20_000; i++)
                batcher.enqueue(transition(`n${i}`, 'pending', 'active'));
            expect(batcher.pendingCount()).toBeLessThanOrEqual(1_000);
            // Each O(n) pass frees ~10 % of the cap: ~190 passes, not one per enqueue.
            expect(batcher.overflowPassCount()).toBeLessThanOrEqual(200);
            const terminal = new TransitionBatcher(60_000, 1_000_000, async () => {}, {
                maxBuffered: 1_000,
                hardCap: 5_000,
            });
            for (let i = 0; i < 4_000; i++)
                terminal.enqueue(transition(`t${i}`, 'active', 'completed'));
            expect(terminal.pendingCount()).toBe(4_000);
            expect(terminal.overflowPassCount()).toBeLessThanOrEqual(20);
            await batcher.stop();
            await terminal.stop();
        });

        it('bounds work retained by a failing sink together with new arrivals', async () => {
            vi.useFakeTimers();
            const batcher = new TransitionBatcher(
                10,
                1_000_000,
                async (batch) => ({ unresolved: batch }),
                { maxBuffered: 5, hardCap: 8 },
            );
            try {
                for (let i = 0; i < 5; i++)
                    batcher.enqueue(transition(`r${i}`, 'pending', 'active'));
                await vi.advanceTimersByTimeAsync(10);
                for (let i = 5; i < 20; i++)
                    batcher.enqueue(transition(`r${i}`, 'pending', 'active'));
                await vi.advanceTimersByTimeAsync(1_000);
                expect(batcher.pendingCount()).toBeLessThanOrEqual(5);
            } finally {
                await batcher.stop();
                vi.useRealTimers();
            }
        });
    });
});
