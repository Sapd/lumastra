// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The PLAYER_QUALITY_* / PLAYER_*_SAMPLES / PLAYER_MIN_ADAPTIVE_BITRATE admin
 * settings reach the switch decision. Until 2026-10-06 the layout serialized
 * them but AbrController never passed `timing`, so adaptive-bitrate.ts always
 * used its built-in constants. These assert at the seam that matters: the
 * bitrate AbrController asks the player to restart at.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbrController } from './abr.controller';
import { hydrateClientTuning, resetClientTuning } from '$lib/stores/client-tuning';

const SOURCE_BITRATE = 20_000_000;

function makeController(isLive = false): {
    ctrl: AbrController;
    onQualitySwitch: ReturnType<typeof vi.fn>;
    onShowToast: ReturnType<typeof vi.fn>;
} {
    const onQualitySwitch = vi.fn();
    const onShowToast = vi.fn();
    const ctrl = new AbrController({
        getMediaSourceBitrate: () => SOURCE_BITRATE,
        getVideoBitrateForEstimator: () => SOURCE_BITRATE,
        getQualityMode: () => 'auto',
        isLive: () => isLive,
        onQualitySwitch,
        onShowToast,
        log: vi.fn(),
        ensureTelemetry: () => null,
    });
    return { ctrl, onQualitySwitch, onShowToast };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
    resetClientTuning();
});

describe('AbrController uses the server ABR timing', () => {
    it('clamps a critically-low switch to the built-in 2 Mbps floor by default', () => {
        const { ctrl, onQualitySwitch } = makeController();
        ctrl.onPlaybackStart();
        ctrl.checkQualitySwitch(500_000);
        expect(onQualitySwitch).toHaveBeenCalledWith(2_000_000);
    });

    it('clamps to PLAYER_MIN_ADAPTIVE_BITRATE when the server sets it', () => {
        hydrateClientTuning({ abrMinAdaptiveBitrate: 1_000_000 });
        const { ctrl, onQualitySwitch } = makeController();
        ctrl.onPlaybackStart();
        ctrl.checkQualitySwitch(500_000);
        expect(onQualitySwitch).toHaveBeenCalledWith(1_000_000);
    });

    it('holds a moderate drop during the default 10 s stability window and 3-sample minimum', () => {
        const { ctrl, onQualitySwitch } = makeController();
        ctrl.onPlaybackStart();
        vi.advanceTimersByTime(2000);
        ctrl.checkQualitySwitch(14_000_000);
        expect(onQualitySwitch).not.toHaveBeenCalled();
    });

    it('switches after PLAYER_QUALITY_STABILITY_MS and PLAYER_MIN_SAMPLES_BEFORE_SWITCH', () => {
        hydrateClientTuning({ abrStabilityMs: 1000, abrMinSamplesBeforeSwitch: 1 });
        const { ctrl, onQualitySwitch } = makeController();
        ctrl.onPlaybackStart();
        vi.advanceTimersByTime(2000);
        ctrl.checkQualitySwitch(14_000_000);
        // 80 % of the measured 14 Mbps.
        expect(onQualitySwitch).toHaveBeenCalledWith(11_200_000);
    });

    it('applies PLAYER_QUALITY_DOWN_COOLDOWN_MS between two downward switches', () => {
        hydrateClientTuning({
            abrStabilityMs: 1000,
            abrMinSamplesBeforeSwitch: 1,
            abrBandwidthSamples: 1,
            abrDownCooldownMs: 1000,
        });
        const { ctrl, onQualitySwitch } = makeController();
        ctrl.onPlaybackStart();
        vi.advanceTimersByTime(2000);
        ctrl.checkQualitySwitch(14_000_000);
        vi.advanceTimersByTime(1500);
        // Built-in cooldown is 10 s; with 1 s configured the second drop goes through.
        ctrl.checkQualitySwitch(10_000_000);
        expect(onQualitySwitch).toHaveBeenNthCalledWith(2, 8_000_000);
    });
});

describe('AbrController on Live TV', () => {
    // hls.js switches between the server's adaptive rungs. A restart through the
    // VOD path tore the live channel down (black picture, "bandwidth down" toast)
    // on every buffer stall when the viewer's saved quality was Auto.
    it('never restarts playback or toasts on a live buffer stall', () => {
        const { ctrl, onQualitySwitch, onShowToast } = makeController(true);
        ctrl.onPlaybackStart();
        ctrl.handleBufferStall();
        expect(onQualitySwitch).not.toHaveBeenCalled();
        expect(onShowToast).not.toHaveBeenCalled();
    });

    it('never restarts playback on a live bandwidth drop', () => {
        const { ctrl, onQualitySwitch } = makeController(true);
        ctrl.onPlaybackStart();
        ctrl.checkQualitySwitch(500_000);
        expect(onQualitySwitch).not.toHaveBeenCalled();
    });

    it('still lowers quality on a VOD buffer stall', () => {
        const { ctrl, onQualitySwitch } = makeController(false);
        ctrl.onPlaybackStart();
        ctrl.handleBufferStall();
        expect(onQualitySwitch).toHaveBeenCalledWith(SOURCE_BITRATE / 2);
    });
});
