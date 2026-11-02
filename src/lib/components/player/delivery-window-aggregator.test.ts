// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for DeliveryWindowAggregator — the receiver-side delivery timer.
 *
 * The point of the whole mechanism: server-side segment timing measures a write
 * into a 16 MB socket buffer, so it reports "delivered" while the viewer has
 * nothing. Only the receiver can time the bits it actually got, so these tests
 * pin the arithmetic (a window's throughput is summed BYTES over summed
 * TRANSFER time, never an average of per-segment rates) and the boundary rule
 * (a window closes on the first sample that lands past it, and that sample
 * belongs to the NEXT window, not the closing one).
 */

import { describe, it, expect } from 'vitest';
import {
    DeliveryWindowAggregator,
    DELIVERY_WINDOW_MS,
    type FragmentDeliverySample,
} from './delivery-window-aggregator';

/** A sample with sane defaults; every field overridable per case. */
function sample(overrides: Partial<FragmentDeliverySample> = {}): FragmentDeliverySample {
    return {
        bytes: 1_000_000,
        mediaSec: 6,
        requestMs: 500,
        transferMs: 400,
        ttfbMs: 100,
        endedAt: 0,
        ...overrides,
    };
}

describe('DeliveryWindowAggregator', () => {
    it('exposes the agreed 30 s window length', () => {
        expect(DELIVERY_WINDOW_MS).toBe(30_000);
    });

    it('returns null while samples stay inside the current window', () => {
        const agg = new DeliveryWindowAggregator();

        expect(agg.push(sample({ endedAt: 0 }))).toBeNull();
        expect(agg.push(sample({ endedAt: 10_000 }))).toBeNull();
        expect(agg.push(sample({ endedAt: 20_000 }))).toBeNull();
    });

    it('closes the window on the first sample past it and aggregates the three it held', () => {
        const agg = new DeliveryWindowAggregator();

        agg.push(
            sample({
                endedAt: 0,
                bytes: 1_000_000,
                mediaSec: 6,
                requestMs: 500,
                transferMs: 400,
                ttfbMs: 100,
            }),
        );
        agg.push(
            sample({
                endedAt: 10_000,
                bytes: 2_000_000,
                mediaSec: 6,
                requestMs: 1_200,
                transferMs: 1_000,
                ttfbMs: 200,
            }),
        );
        agg.push(
            sample({
                endedAt: 20_000,
                bytes: 500_000,
                mediaSec: 4,
                requestMs: 300,
                transferMs: 100,
                ttfbMs: 50,
            }),
        );

        const closed = agg.push(sample({ endedAt: 30_000 }));
        expect(closed).not.toBeNull();

        const bytes = 1_000_000 + 2_000_000 + 500_000;
        const transferMs = 400 + 1_000 + 100;
        expect(closed!.segments).toBe(3);
        expect(closed!.bytes).toBe(bytes);
        expect(closed!.mediaSec).toBe(16);
        expect(closed!.transferMs).toBe(transferMs);
        expect(closed!.throughputBps).toBe((bytes * 8) / (transferMs / 1000));
        // Wall/TTFB are worst-case, not averages: one 1.2 s request is the
        // number an operator needs, a mean would hide it.
        expect(closed!.wallMaxMs).toBe(1_200);
        expect(closed!.ttfbMaxMs).toBe(200);
        // Slowest single segment: 2 MB in 1 s = 16 Mbps, vs 20 Mbps and 40 Mbps.
        expect(closed!.minSegBps).toBe((2_000_000 * 8) / 1);
    });

    it('starts the next window with the sample that closed the previous one', () => {
        const agg = new DeliveryWindowAggregator();

        agg.push(sample({ endedAt: 0, bytes: 1_000_000, transferMs: 400 }));
        expect(
            agg.push(sample({ endedAt: 30_000, bytes: 700_000, transferMs: 200 })),
        ).not.toBeNull();

        // The crossing sample must NOT have been counted into the closed
        // window, and must NOT have been dropped either.
        const next = agg.flush();
        expect(next).not.toBeNull();
        expect(next!.segments).toBe(1);
        expect(next!.bytes).toBe(700_000);
        expect(next!.transferMs).toBe(200);
    });

    it('keeps closing windows across a long session, each boundary relative to its own start', () => {
        const agg = new DeliveryWindowAggregator();

        agg.push(sample({ endedAt: 5_000 }));
        // Boundary is start+30s = 35_000, not an absolute 30_000 grid.
        expect(agg.push(sample({ endedAt: 34_999 }))).toBeNull();

        const first = agg.push(sample({ endedAt: 35_000 }));
        expect(first).not.toBeNull();
        expect(first!.segments).toBe(2);

        expect(agg.push(sample({ endedAt: 60_000 }))).toBeNull();
        const second = agg.push(sample({ endedAt: 65_000 }));
        expect(second).not.toBeNull();
        expect(second!.segments).toBe(2);
    });

    it('ignores a sample with a non-positive transfer time', () => {
        const agg = new DeliveryWindowAggregator();

        expect(agg.push(sample({ endedAt: 0, transferMs: 0 }))).toBeNull();
        expect(agg.push(sample({ endedAt: 1_000, transferMs: -5 }))).toBeNull();
        // Nothing was accumulated, so there is no window to flush…
        expect(agg.flush()).toBeNull();

        // …and the ignored samples did not open a window either, so the next
        // real sample starts the clock and a later one closes it.
        agg.push(sample({ endedAt: 100_000, bytes: 800_000, transferMs: 250 }));
        const closed = agg.push(sample({ endedAt: 130_000 }));
        expect(closed).not.toBeNull();
        expect(closed!.segments).toBe(1);
        expect(closed!.bytes).toBe(800_000);
    });

    it('returns null from flush() on an empty aggregator', () => {
        expect(new DeliveryWindowAggregator().flush()).toBeNull();
    });

    it('flush() closes a partial window once and then reports empty', () => {
        const agg = new DeliveryWindowAggregator();
        agg.push(
            sample({ endedAt: 0, bytes: 1_500_000, transferMs: 600, requestMs: 800, ttfbMs: 120 }),
        );

        const flushed = agg.flush();
        expect(flushed).not.toBeNull();
        expect(flushed!.segments).toBe(1);
        expect(flushed!.bytes).toBe(1_500_000);
        expect(flushed!.throughputBps).toBe((1_500_000 * 8) / 0.6);
        expect(flushed!.minSegBps).toBe((1_500_000 * 8) / 0.6);
        expect(flushed!.wallMaxMs).toBe(800);
        expect(flushed!.ttfbMaxMs).toBe(120);

        expect(agg.flush()).toBeNull();
    });

    it('restarts the window clock after a flush', () => {
        const agg = new DeliveryWindowAggregator();
        agg.push(sample({ endedAt: 0 }));
        agg.flush();

        // A sample 1 ms later must open a FRESH window, not be judged against
        // the flushed window's start.
        expect(agg.push(sample({ endedAt: 1 }))).toBeNull();
        expect(agg.push(sample({ endedAt: 30_000 }))).toBeNull();
        const closed = agg.push(sample({ endedAt: 30_001 }));
        expect(closed).not.toBeNull();
        expect(closed!.segments).toBe(2);
    });

    it('honours a custom window length', () => {
        const agg = new DeliveryWindowAggregator(1_000);

        expect(agg.push(sample({ endedAt: 0 }))).toBeNull();
        expect(agg.push(sample({ endedAt: 999 }))).toBeNull();
        const closed = agg.push(sample({ endedAt: 1_000 }));
        expect(closed).not.toBeNull();
        expect(closed!.segments).toBe(2);
    });
});
