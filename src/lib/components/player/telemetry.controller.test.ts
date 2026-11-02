// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Tests for the delivery-window seam of TelemetryController: fragment samples in
 * → `delivery_window` events out, as the SERVER receives them.
 *
 * Asserting at this seam rather than on the aggregator is the point — the two
 * ways this feature can silently produce nothing are (a) recording per segment
 * instead of per window and (b) recording the closing window into an instance
 * that never transmits it. Both are invisible from the aggregator's own tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** The payload shape `PlaybackTelemetry` posts — what the server would store. */
interface SentTelemetry {
    playbackSessionId: string;
    events: { type: string; value: number; metadata?: Record<string, string> }[];
}

const { flushTelemetry, sessionState } = vi.hoisted(() => ({
    // Typed with the payload so `mock.calls[n][0]` is the body, not `never`.
    flushTelemetry: vi.fn(async (_payload: SentTelemetry): Promise<void> => {}),
    // Mutable so a test can simulate a play-session swap mid-playback.
    sessionState: { playSessionId: 'session-1', isLive: false },
}));

vi.mock('$lib/api/playback', () => ({ flushTelemetry }));
vi.mock('./playerStore.svelte', () => ({
    playerStore: { getState: () => sessionState },
}));
vi.mock('./device-id', () => ({ getDeviceId: () => 'device-test' }));

import { TelemetryController } from './telemetry.controller';
import type { FragmentDeliverySample } from './delivery-window-aggregator';

function makeController(): TelemetryController {
    return new TelemetryController({
        isSafari: false,
        // No element: buffer-ahead falls back to 0 / last-known, and no
        // buffer-health interval competes with the flush timer.
        getVideoElement: () => undefined,
        log: () => {},
    });
}

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

/** Every event the server was asked to store, across all flush calls. */
function sentEvents(): SentTelemetry['events'] {
    return flushTelemetry.mock.calls.flatMap((call) => call[0].events);
}

function deliveryWindows(): SentTelemetry['events'] {
    return sentEvents().filter((event) => event.type === 'delivery_window');
}

beforeEach(() => {
    vi.useFakeTimers();
    flushTelemetry.mockClear();
    flushTelemetry.mockImplementation(async () => {});
    sessionState.playSessionId = 'session-1';
    sessionState.isLive = false;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('TelemetryController — delivery windows', () => {
    it('sends nothing while a window is still open, and one event when it closes', async () => {
        const ctrl = makeController();

        ctrl.recordFragmentDelivery(sample({ endedAt: 0 }), 12);
        ctrl.recordFragmentDelivery(sample({ endedAt: 10_000 }), 11);
        ctrl.recordFragmentDelivery(sample({ endedAt: 20_000 }), 10);

        // Past the 10 s auto-flush: three fragments delivered, nothing to report
        // yet. (A per-segment implementation would have sent three rows here.)
        await vi.advanceTimersByTimeAsync(10_000);
        expect(deliveryWindows()).toHaveLength(0);

        // The sample past the 30 s boundary closes the window.
        ctrl.recordFragmentDelivery(sample({ endedAt: 30_000 }), 9);
        await vi.advanceTimersByTimeAsync(10_000);

        const windows = deliveryWindows();
        expect(windows).toHaveLength(1);
        expect(windows[0].value).toBe((3_000_000 * 8) / (1200 / 1000));
        // Metadata reaches the server as strings, under the exact key spellings
        // `delivery-windows.queries.ts` reads (anything else reads as NULL).
        expect(windows[0].metadata).toEqual({
            bytes: '3000000',
            segments: '3',
            mediaSec: '18',
            transferMs: '1200',
            wallMaxMs: '500',
            ttfbMaxMs: '100',
            minSegBps: '20000000',
            bufferAheadSec: '9',
            engine: 'hls_js',
        });
        // AVPlayer-only fields must not be invented here.
        expect(windows[0].metadata).not.toHaveProperty('overdue');
        expect(windows[0].metadata).not.toHaveProperty('stalls');

        await ctrl.destroy();
    });

    it('delivers the final partial window to the server on destroy()', async () => {
        const ctrl = makeController();
        ctrl.recordFragmentDelivery(sample({ endedAt: 0, bytes: 800_000, transferMs: 500 }), 4);

        // No boundary was crossed, so nothing has been reported yet…
        await vi.advanceTimersByTimeAsync(10_000);
        expect(deliveryWindows()).toHaveLength(0);

        // …and destroy() must both close the window AND actually transmit it.
        // This is the regression: PlaybackTelemetry.destroy() used to set
        // isDestroyed before its final flush, which made that flush a no-op.
        await ctrl.destroy();

        const windows = deliveryWindows();
        expect(windows).toHaveLength(1);
        expect(windows[0].metadata?.segments).toBe('1');
        expect(windows[0].metadata?.bytes).toBe('800000');
        // Buffer-ahead falls back to the last delivered fragment's reading
        // rather than a fabricated 0 (the element is gone by teardown).
        expect(windows[0].metadata?.bufferAheadSec).toBe('4');
    });

    it('closes the open window into the OLD session when the play session swaps', async () => {
        const beacon = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
        const ctrl = makeController();

        ctrl.recordFragmentDelivery(sample({ endedAt: 0, bytes: 900_000, transferMs: 300 }), 7);

        // A quality switch / item change gives the player a new play session.
        sessionState.playSessionId = 'session-2';
        ctrl.recordFragmentDelivery(sample({ endedAt: 6_000, bytes: 400_000 }), 6);

        // The old session's telemetry leaves via sendBeacon as it is torn down.
        expect(beacon).toHaveBeenCalledTimes(1);
        const body = beacon.mock.calls[0][1] as Blob;
        const sent = JSON.parse(await body.text()) as SentTelemetry;
        expect(sent.playbackSessionId).toBe('session-1');
        const beaconWindows = sent.events.filter((event) => event.type === 'delivery_window');
        expect(beaconWindows).toHaveLength(1);
        expect(beaconWindows[0].metadata?.bytes).toBe('900000');

        // The new session starts from an empty aggregator: the post-swap sample
        // is its first, so the window it eventually reports carries only that.
        await ctrl.destroy();
        const lastCall = flushTelemetry.mock.calls.at(-1)![0];
        expect(lastCall.playbackSessionId).toBe('session-2');
        const finalWindows = lastCall.events.filter((event) => event.type === 'delivery_window');
        expect(finalWindows).toHaveLength(1);
        expect(finalWindows[0].metadata?.bytes).toBe('400000');
        expect(finalWindows[0].metadata?.segments).toBe('1');

        beacon.mockRestore();
    });

    it('drops a window with no play session instead of reporting it unattributed', async () => {
        sessionState.playSessionId = '';
        const ctrl = makeController();

        ctrl.recordFragmentDelivery(sample({ endedAt: 0 }), 3);
        ctrl.recordFragmentDelivery(sample({ endedAt: 30_000 }), 3);
        await vi.advanceTimersByTimeAsync(10_000);
        await ctrl.destroy();

        expect(flushTelemetry).not.toHaveBeenCalled();
    });
});

it('keeps replacement telemetry when an outgoing session flush resolves late', async () => {
    const ctrl = makeController();
    ctrl.recordError('decode', 'outgoing error');
    let release: () => void = () => {};
    flushTelemetry.mockImplementationOnce(
        () =>
            new Promise<void>((resolve) => {
                release = resolve;
            }),
    );
    const outgoing = ctrl.destroy();
    sessionState.playSessionId = 'session-2';
    const replacement = ctrl.ensure();
    ctrl.hasNativePlaybackStarted = true;
    release();
    await outgoing;
    expect(ctrl.ensure()).toBe(replacement);
    expect(ctrl.hasNativePlaybackStarted).toBe(true);
    await ctrl.destroy();
});

it('never posts VOD telemetry for live sessions, including timed and beacon flushes', async () => {
    const beacon = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
    sessionState.isLive = true;
    const ctrl = makeController();

    expect(ctrl.ensure()).toBeNull();
    ctrl.recordError('network', 'live stream interrupted');
    ctrl.recordSeek(10, 20);
    ctrl.recordBandwidthThrottled(5_000_000);
    ctrl.recordRebufferStart(20);
    ctrl.recordRebufferEnd(21);
    ctrl.recordReconnect('recovering');
    ctrl.recordFragmentDelivery(sample({ endedAt: 0 }), 3);
    ctrl.recordFragmentDelivery(sample({ endedAt: 30_000 }), 3);
    await vi.advanceTimersByTimeAsync(20_000);
    ctrl.flushViaBeacon();
    ctrl.destroyViaBeacon();
    await ctrl.destroy();

    expect(flushTelemetry).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    beacon.mockRestore();
});

it('retires VOD telemetry on entering live and excludes live samples from the next VOD', async () => {
    const beacon = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
    const ctrl = makeController();
    ctrl.recordFragmentDelivery(sample({ endedAt: 0, bytes: 800_000 }), 4);
    ctrl.recordError('decode', 'outgoing VOD error');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    sessionState.playSessionId = 'live-session';
    sessionState.isLive = true;
    ctrl.recordFragmentDelivery(sample({ endedAt: 10_000, bytes: 9_000_000 }), 8);
    ctrl.recordError('network', 'live stream interrupted');
    ctrl.recordFragmentDelivery(sample({ endedAt: 20_000, bytes: 9_000_000 }), 8);
    expect(ctrl.ensure()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    ctrl.flushViaBeacon();

    expect(flushTelemetry).not.toHaveBeenCalled();
    expect(beacon).toHaveBeenCalledTimes(1);
    const oldBody = beacon.mock.calls[0][1] as Blob;
    const oldTelemetry = JSON.parse(await oldBody.text()) as SentTelemetry;
    expect(oldTelemetry.playbackSessionId).toBe('session-1');
    expect(oldTelemetry.events.filter((event) => event.type === 'delivery_window')).toEqual([
        expect.objectContaining({
            metadata: expect.objectContaining({ bytes: '800000', segments: '1' }),
        }),
    ]);

    sessionState.playSessionId = 'session-2';
    sessionState.isLive = false;
    ctrl.recordFragmentDelivery(sample({ endedAt: 25_000, bytes: 400_000 }), 6);
    await ctrl.destroy();

    expect(flushTelemetry).toHaveBeenCalledTimes(1);
    expect(flushTelemetry.mock.calls[0][0].playbackSessionId).toBe('session-2');
    expect(deliveryWindows()).toEqual([
        expect.objectContaining({
            metadata: expect.objectContaining({ bytes: '400000', segments: '1' }),
        }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
    beacon.mockRestore();
});
