// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildPreviewHlsConfig, shouldRetainBackBuffer } from './preview-hls-config';

describe('preview hls config', () => {
    it('bounds the forward buffer well below the 30s artifact cap', () => {
        const c = buildPreviewHlsConfig();
        // maxMaxBufferLength is the real ceiling; must be far under the
        // PREVIEW_TRANSCODE_MAX_SECONDS=30 clip length or an abandoned hover
        // downloads the entire artifact.
        expect(c.maxMaxBufferLength as number).toBeLessThanOrEqual(10);
        expect(c.maxBufferLength as number).toBeLessThanOrEqual(c.maxMaxBufferLength as number);
    });

    it('defaults to a FINITE back buffer — infinite must be opted into', () => {
        // The bug this guards: buildPreviewHlsConfig() took no arguments and
        // was infinite unconditionally, so every caller (trailers, live TV)
        // inherited the hero's looping-snippet buffer regardless of shape.
        expect(buildPreviewHlsConfig().backBufferLength).not.toBe(Infinity);
        expect(buildPreviewHlsConfig({}).backBufferLength).not.toBe(Infinity);
        expect(buildPreviewHlsConfig({ retainBackBuffer: false }).backBufferLength).not.toBe(
            Infinity,
        );
    });

    it('retains the back buffer ONLY when retainBackBuffer is true, so a looped snippet replays from memory', () => {
        expect(buildPreviewHlsConfig({ retainBackBuffer: true }).backBufferLength).toBe(Infinity);
    });

    it('preserves the manifest-retry and deferred-load behaviour regardless of retainBackBuffer', () => {
        for (const retainBackBuffer of [true, false, undefined]) {
            const c = buildPreviewHlsConfig({ retainBackBuffer });
            // autoStartLoad:false stops hls.js probing segment 0 during init,
            // which would trigger the server backward-seek handler and restart
            // FFmpeg from position 0 instead of the resume point.
            expect(c.autoStartLoad).toBe(false);
            expect(c.startOnSegmentBoundary).toBe(true);
            expect(c.manifestLoadingMaxRetry).toBe(15);
        }
    });
});

describe('shouldRetainBackBuffer (MediaPreviewPlayer call-site decision)', () => {
    // Regression 661b6992b: the call site computed
    // `loop && !isLiveTv && !nativeStreamUrl`, which scoped the infinite back
    // buffer correctly away from trailers/live TV but ALSO away from the
    // hover popup — which passes `loop: false` while still looping its
    // bounded 30s snippet internally via `hoverCapActive`. That regressed
    // the highest-frequency preview path into re-downloading its clip on
    // every loop, inside a change whose entire point was preview bandwidth.
    it('hero ambient clip (loop=true, not live TV, not a native stream): retains the back buffer', () => {
        expect(
            shouldRetainBackBuffer({
                loop: true,
                hoverCapActive: false,
                isLiveTv: false,
                nativeStreamUrl: false,
            }),
        ).toBe(true);
    });

    it('hover popup (loop=false, hoverCapActive=true — bounded internal re-loop): retains the back buffer', () => {
        expect(
            shouldRetainBackBuffer({
                loop: false,
                hoverCapActive: true,
                isLiveTv: false,
                nativeStreamUrl: false,
            }),
        ).toBe(true);
    });

    it('ModalTrailerOverlay / hover trailer probe (loop=false, trailerPreferred disables hoverCapActive): finite buffer', () => {
        expect(
            shouldRetainBackBuffer({
                loop: false,
                hoverCapActive: false,
                isLiveTv: false,
                nativeStreamUrl: false,
            }),
        ).toBe(false);
    });

    it('live TV (isLiveTv=true, or a standalone nativeStreamUrl channel): finite buffer even if hoverCapActive somehow got set', () => {
        expect(
            shouldRetainBackBuffer({
                loop: false,
                hoverCapActive: false,
                isLiveTv: true,
                nativeStreamUrl: false,
            }),
        ).toBe(false);
        expect(
            shouldRetainBackBuffer({
                loop: false,
                hoverCapActive: false,
                isLiveTv: false,
                nativeStreamUrl: true,
            }),
        ).toBe(false);
        // isLiveTv/nativeStreamUrl must win even over `loop` — a live channel
        // is unbounded on wall-clock time regardless of a caller passing loop.
        expect(
            shouldRetainBackBuffer({
                loop: true,
                hoverCapActive: false,
                isLiveTv: true,
                nativeStreamUrl: false,
            }),
        ).toBe(false);
    });
});
