// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    buildHlsConfig,
    DEFAULT_HLS_VOD_BUFFER_SETTINGS,
    AUDIO_ONLY_HLS_BUFFER_SETTINGS,
} from './hls-config';

describe('buildHlsConfig', () => {
    it('uses large VOD hls.js buffer defaults', () => {
        const config = buildHlsConfig(false);

        expect(config.maxBufferSize).toBe(DEFAULT_HLS_VOD_BUFFER_SETTINGS.maxBufferSize);
        expect(config.maxBufferLength).toBe(600);
        expect(config.maxMaxBufferLength).toBe(1800);
        expect(config.backBufferLength).toBe(30);
    });

    it('applies configured VOD hls.js buffer values', () => {
        const config = buildHlsConfig(false, {
            maxBufferSize: 250_000_000,
            maxBufferLength: 120,
            maxMaxBufferLength: 240,
            backBufferLength: 15,
        });

        expect(config.maxBufferSize).toBe(250_000_000);
        expect(config.maxBufferLength).toBe(120);
        expect(config.maxMaxBufferLength).toBe(240);
        expect(config.backBufferLength).toBe(15);
    });

    it('keeps live hls.js buffer settings unchanged', () => {
        const config = buildHlsConfig(true, {
            maxBufferSize: 250_000_000,
            maxBufferLength: 120,
            maxMaxBufferLength: 240,
            backBufferLength: 15,
        });

        expect(config.maxBufferSize).toBe(60 * 1000000);
        expect(config.maxBufferLength).toBe(30);
        expect(config.maxMaxBufferLength).toBe(60);
        expect(config.backBufferLength).toBe(30);
    });

    it('buffers deeply for audio-only', () => {
        const config = buildHlsConfig(false, AUDIO_ONLY_HLS_BUFFER_SETTINGS);
        expect(config.maxBufferLength).toBe(1800);
        expect(config.maxMaxBufferLength).toBe(3600);
        expect(config.maxBufferSize).toBe(96_000_000);
        expect(config.backBufferLength).toBe(60);
    });
});

describe('buildHlsConfig — fragment load policy', () => {
    it('separates time-to-first-byte from total load time', () => {
        // The legacy `fragLoadingTimeOut` is mapped by hls.js onto BOTH
        // maxTimeToFirstByteMs AND maxLoadTimeMs. XhrLoader then re-arms its
        // timer on first byte only when the two DIFFER, so with one value a
        // fragment that needs longer than the timeout is aborted however
        // steadily it is arriving — `loadprogress` updates stats, never the
        // timer.
        //
        // Prod 2026-09-12 (testlistener, Firefox/hls.js, 7-11MB copy-mode segments on a
        // link measuring 0.43-4.5 Mbit/s): the same segment was re-requested at
        // 20.5/21/22/24s — the 20s cap plus 500*2^n retry backoff — with two
        // responses truncated at exactly rt=19.971. Playback could not proceed
        // even though the server delivered every byte in under 40ms.
        const config = buildHlsConfig(false);

        expect(config.fragLoadPolicy?.default.maxTimeToFirstByteMs).toBe(20000);
        expect(config.fragLoadPolicy?.default.maxLoadTimeMs).toBe(120000);
        expect(config.fragLoadPolicy?.default.maxLoadTimeMs).toBeGreaterThan(
            config.fragLoadPolicy?.default.maxTimeToFirstByteMs ?? 0,
        );
    });

    it('does not also send the legacy frag fields, which hls.js would ignore', () => {
        // hls.js applies the legacy mapping only when the policy is undefined
        // (`policyNotSet`). Shipping both would leave dead config that reads as
        // authoritative.
        const config = buildHlsConfig(false) as Record<string, unknown>;

        expect(config.fragLoadingTimeOut).toBeUndefined();
        expect(config.fragLoadingMaxRetry).toBeUndefined();
        expect(config.fragLoadingRetryDelay).toBeUndefined();
        expect(config.fragLoadingMaxRetryTimeout).toBeUndefined();
    });

    it('keeps the retry budget and backoff the legacy fields expressed', () => {
        const config = buildHlsConfig(false);
        const policy = config.fragLoadPolicy?.default;

        expect(policy?.timeoutRetry?.maxNumRetry).toBe(4);
        expect(policy?.errorRetry?.maxNumRetry).toBe(4);
        expect(policy?.errorRetry?.retryDelayMs).toBe(500);
        expect(policy?.errorRetry?.maxRetryDelayMs).toBe(16000);
    });
});
