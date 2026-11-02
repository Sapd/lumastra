// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The deep audio-only buffer must survive a MID-PLAYBACK mode switch.
 *
 * `hlsVodBufferSettings` used to be readable only from the config frozen when
 * PlaybackManager was constructed. PlayerController creates the manager once
 * (lazy singleton) and a quality restart calls `destroy()` without ever nulling
 * the reference, so the manager that serves the audio-only stream is the SAME
 * instance that was built while the player was still in video mode. Since
 * audio-only is never persisted it can only ever be entered mid-playback — so
 * the 1800 s buffer, the headline capability of the rung, applied literally
 * never. Preprod corroborated: observed buffers 507/583/520 s, all just under
 * the 600 s video default.
 *
 * These tests assert the buffer depth hls.js is actually CONSTRUCTED with, read
 * off the config object handed to the Hls constructor, across the transition.
 *
 * What they prove:
 *  - the value reaches hls.js from the LIVE config, not the construction-time
 *    one: run 1 on the same instance must be 600 and run 2 must be 1800, so a
 *    fixture that merely matched the constant would fail run 1.
 *  - the transition is reversible: going back to video restores 600, so a
 *    "always deep" regression fails.
 *  - the whole buffer group moves together (maxBufferSize / maxMaxBufferLength
 *    / backBufferLength), not just the one field named in the bug report.
 *
 * What they do NOT prove: that PlayerController calls `updateConfig` on the
 * quality-restart path (that wiring lives in `ensurePlaybackManager()` and is
 * only reachable by instantiating the full controller), nor anything about
 * Safari — Safari never loads hls.js and takes AVPlayer's own buffer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const constructorConfigs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('hls.js', () => {
    class FakeHls {
        static Events = {
            MEDIA_ATTACHED: 'hlsMediaAttached',
            MANIFEST_PARSED: 'hlsManifestParsed',
            LEVEL_LOADED: 'hlsLevelLoaded',
            FRAG_LOADING: 'hlsFragLoading',
            FRAG_LOADED: 'hlsFragLoaded',
            FRAG_BUFFERED: 'hlsFragBuffered',
            LEVEL_SWITCHING: 'hlsLevelSwitching',
            ERROR: 'hlsError',
        };
        static ErrorTypes = {
            NETWORK_ERROR: 'networkError',
            MEDIA_ERROR: 'mediaError',
            OTHER_ERROR: 'otherError',
        };

        subtitleDisplay = false;
        levels: unknown[] = [];
        audioTracks: unknown[] = [];
        bandwidthEstimate = 0;

        constructor(config?: Record<string, unknown>) {
            // The whole point of this mock: capture what hls.js was actually
            // told, rather than what the caller believes it passed.
            constructorConfigs.push(config ?? {});
        }
        on(): void {}
        loadSource(): void {}
        attachMedia(): void {}
        startLoad(): void {}
        recoverMediaError(): void {}
        destroy(): void {}
    }
    return { default: FakeHls };
});

vi.mock('akarisub', () => ({}));
vi.mock('libbitsub', () => ({}));

import { createPlaybackManager, type PlaybackManagerConfig } from './playback-manager';
import { AUDIO_ONLY_HLS_BUFFER_SETTINGS, DEFAULT_HLS_VOD_BUFFER_SETTINGS } from './hls-config';

function makeConfig(): PlaybackManagerConfig {
    return {
        videoElement: document.createElement('video'),
        isSafari: false,
        isLive: false,
        autoPlay: false,
        // Video mode: no override at all — the same shape the player ships when
        // the operator has not configured custom VOD buffers.
        hlsVodBufferSettings: undefined,
        mightBeInWatchParty: () => false,
        isInWatchParty: () => false,
        log: () => {},
        events: {},
    };
}

const lastConfig = () => constructorConfigs.at(-1)!;

beforeEach(() => {
    constructorConfigs.length = 0;
    vi.stubGlobal(
        'MediaSource',
        class {
            static isTypeSupported(): boolean {
                return true;
            }
        },
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('PlaybackManager — audio-only buffer across a mid-playback mode switch', () => {
    it('applies the deep audio-only buffer to a reload of an EXISTING manager', async () => {
        const manager = createPlaybackManager(makeConfig());

        // Run 1 — video mode. Establishes the baseline on this very instance,
        // so run 2 cannot pass just because 1800 happens to be a default.
        await manager.load('https://example.test/video.m3u8', 'hls');
        expect(lastConfig().maxBufferLength).toBe(DEFAULT_HLS_VOD_BUFFER_SETTINGS.maxBufferLength);
        expect(lastConfig().maxBufferLength).not.toBe(
            AUDIO_ONLY_HLS_BUFFER_SETTINGS.maxBufferLength,
        );

        // The mid-playback switch: same manager instance, new mode.
        manager.updateConfig({ hlsVodBufferSettings: AUDIO_ONLY_HLS_BUFFER_SETTINGS });
        await manager.load('https://example.test/audio-only.m3u8', 'hls');

        expect(lastConfig().maxBufferLength).toBe(1800);
        expect(lastConfig().maxBufferLength).toBe(AUDIO_ONLY_HLS_BUFFER_SETTINGS.maxBufferLength);

        manager.destroy();
    });

    it('carries the whole buffer group, not just maxBufferLength', async () => {
        const manager = createPlaybackManager(makeConfig());
        await manager.load('https://example.test/video.m3u8', 'hls');
        manager.updateConfig({ hlsVodBufferSettings: AUDIO_ONLY_HLS_BUFFER_SETTINGS });
        await manager.load('https://example.test/audio-only.m3u8', 'hls');

        const cfg = lastConfig();
        expect({
            maxBufferSize: cfg.maxBufferSize,
            maxMaxBufferLength: cfg.maxMaxBufferLength,
            backBufferLength: cfg.backBufferLength,
        }).toEqual({
            maxBufferSize: AUDIO_ONLY_HLS_BUFFER_SETTINGS.maxBufferSize,
            maxMaxBufferLength: AUDIO_ONLY_HLS_BUFFER_SETTINGS.maxMaxBufferLength,
            backBufferLength: AUDIO_ONLY_HLS_BUFFER_SETTINGS.backBufferLength,
        });

        manager.destroy();
    });

    it('returns to the video buffer when the override is cleared', async () => {
        // Switching back to video must NOT leave a 1800 s buffer in place —
        // clearing the override has to be expressible, which is why
        // updateConfig uses an `in` check rather than `!== undefined`.
        const manager = createPlaybackManager(makeConfig());

        manager.updateConfig({ hlsVodBufferSettings: AUDIO_ONLY_HLS_BUFFER_SETTINGS });
        await manager.load('https://example.test/audio-only.m3u8', 'hls');
        expect(lastConfig().maxBufferLength).toBe(1800);

        manager.updateConfig({ hlsVodBufferSettings: undefined });
        await manager.load('https://example.test/video.m3u8', 'hls');
        expect(lastConfig().maxBufferLength).toBe(DEFAULT_HLS_VOD_BUFFER_SETTINGS.maxBufferLength);

        manager.destroy();
    });
});
