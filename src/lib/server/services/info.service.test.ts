// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    selectDeliveryPath,
    capsForDeliveryPath,
    defaultBrowserCaps,
    defaultBrowserPathScoped,
    defaultNativePathScoped,
    pathScopedFromDeviceCaps,
} from './info.service.js';
import type { PathScopedCapabilities } from '$lib/components/player/codec-types.js';
import type { DeviceCapabilities, MediaInfo } from '$lib/server/utils/media-compatibility.js';

// ── Helpers ──

function media(overrides: Partial<MediaInfo> = {}): MediaInfo {
    return {
        videoCodec: 'h264',
        audioCodecs: ['aac'],
        audioTrackCount: 1,
        container: 'mp4',
        hdr: 'sdr',
        ...overrides,
    };
}

// ── selectDeliveryPath ──

describe('selectDeliveryPath', () => {
    const browserPath = defaultBrowserPathScoped();

    it('selects direct_file for h264/aac/mp4 single-audio', () => {
        const result = selectDeliveryPath(media(), browserPath, false, false);
        expect(result).toBe('direct_file');
    });

    it('selects mse_hls for MKV container (not in directFile containers)', () => {
        const result = selectDeliveryPath(
            media({ container: 'matroska' }),
            browserPath,
            false,
            false,
        );
        // Non-Safari browser: no native HLS, falls to mse_hls
        expect(result).toBe('mse_hls');
    });

    it('selects native_hls for Safari-like profile with HEVC', () => {
        const safariPath: PathScopedCapabilities = {
            directFile: {
                videoCodecs: ['h264', 'hevc'],
                audioCodecs: ['aac'],
                containers: ['mp4'],
            },
            nativeHls: {
                videoCodecs: ['h264', 'hevc'],
                audioCodecs: ['aac', 'ac3', 'eac3'],
            },
            mseHls: { videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac'] },
            subtitleRendering: {
                vtt: true,
                pgs: true,
                ass: true,
                vobsub: true,
                burnInRequired: [],
            },
            hdr: { decode: [], display: false },
            audioSwitching: true,
            maxChannels: 6,
            codecConstraints: {},
        };
        // HEVC in MKV — not in directFile containers, but compatible via native HLS
        const result = selectDeliveryPath(
            media({ videoCodec: 'hevc', container: 'matroska' }),
            safariPath,
            true,
            false,
        );
        expect(result).toBe('native_hls');
    });

    it('selects mse_hls when video codec not supported anywhere', () => {
        const result = selectDeliveryPath(
            media({ videoCodec: 'mpeg2video' }),
            browserPath,
            false,
            false,
        );
        expect(result).toBe('mse_hls');
    });

    it('rejects direct_file when multi-audio and canSwitchAudio is false', () => {
        const result = selectDeliveryPath(
            media({ audioCodecs: ['aac', 'ac3'], audioTrackCount: 2 }),
            browserPath,
            false,
            true,
        );
        // Can't switch audio in direct play → not direct_file
        expect(result).not.toBe('direct_file');
    });

    it('allows direct_file with multi-audio when canSwitchAudio is true', () => {
        const result = selectDeliveryPath(
            media({ audioCodecs: ['aac', 'aac'], audioTrackCount: 2 }),
            browserPath,
            true,
            true,
        );
        expect(result).toBe('direct_file');
    });

    it('selects direct_file with comma-separated container matching', () => {
        const result = selectDeliveryPath(
            media({ container: 'mov,mp4,m4a,3gp' }),
            browserPath,
            false,
            false,
        );
        // mp4 and mov are in default browser containers
        expect(result).toBe('direct_file');
    });
});

// ── capsForDeliveryPath ──

describe('capsForDeliveryPath', () => {
    const baseCaps = defaultBrowserCaps();
    const pathScoped = defaultBrowserPathScoped();

    it('narrows to directFile codecs for direct_file path', () => {
        const caps = capsForDeliveryPath(baseCaps, pathScoped, 'direct_file');
        expect(caps.videoCodecs).toEqual(new Set(['h264', 'av1', 'vp9']));
        expect(caps.audioCodecs).toEqual(new Set(['aac', 'mp3', 'opus']));
        expect(caps.containers).toEqual(new Set(['mp4', 'webm', 'm4v', 'mov']));
        expect(caps.hlsAudioCodecs).toBeUndefined();
        expect(caps.canSwitchAudioInDirectPlay).toBe(false);
    });

    it('narrows to nativeHls codecs for native_hls path', () => {
        const safariCaps: DeviceCapabilities = {
            videoCodecs: new Set(['h264', 'hevc']),
            audioCodecs: new Set(['aac', 'ac3', 'eac3']),
            containers: new Set(['mp4']),
            canSwitchAudioInDirectPlay: true,
            hlsAudioCodecs: new Set(['aac', 'ac3', 'eac3']),
        };
        const safariPath: PathScopedCapabilities = {
            directFile: {
                videoCodecs: ['h264', 'hevc'],
                audioCodecs: ['aac'],
                containers: ['mp4'],
            },
            nativeHls: {
                videoCodecs: ['h264', 'hevc'],
                audioCodecs: ['aac', 'ac3', 'eac3'],
            },
            mseHls: { videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac'] },
            subtitleRendering: {
                vtt: true,
                pgs: true,
                ass: true,
                vobsub: true,
                burnInRequired: [],
            },
            hdr: { decode: [], display: false },
            audioSwitching: true,
            maxChannels: 6,
            codecConstraints: {},
        };
        const caps = capsForDeliveryPath(safariCaps, safariPath, 'native_hls');
        expect(caps.videoCodecs).toEqual(new Set(['h264', 'hevc']));
        expect(caps.audioCodecs).toEqual(new Set(['aac', 'ac3', 'eac3']));
        expect(caps.hlsAudioCodecs).toEqual(new Set(['aac', 'ac3', 'eac3']));
        expect(caps.canSwitchAudioInDirectPlay).toBe(true);
    });

    it('narrows to mseHls codecs for mse_hls path', () => {
        const caps = capsForDeliveryPath(baseCaps, pathScoped, 'mse_hls');
        expect(caps.videoCodecs).toEqual(new Set(['h264', 'av1', 'vp9']));
        expect(caps.audioCodecs).toEqual(new Set(['aac', 'mp3', 'opus']));
        expect(caps.hlsAudioCodecs).toEqual(new Set(['aac', 'mp3', 'opus']));
        expect(caps.canSwitchAudioInDirectPlay).toBe(false);
    });
});

// ── Default caps consistency ──

describe('default caps consistency', () => {
    it('defaultBrowserCaps video codecs match defaultBrowserPathScoped directFile+mseHls union', () => {
        const caps = defaultBrowserCaps();
        const ps = defaultBrowserPathScoped();
        const allVideo = new Set([...ps.directFile.videoCodecs, ...ps.mseHls.videoCodecs]);
        expect(caps.videoCodecs).toEqual(allVideo);
    });

    it('defaultBrowserPathScoped nativeHls is empty (non-Safari)', () => {
        const ps = defaultBrowserPathScoped();
        expect(ps.nativeHls.videoCodecs).toHaveLength(0);
        expect(ps.nativeHls.audioCodecs).toHaveLength(0);
    });

    it('defaultNativePathScoped nativeHls has codecs', () => {
        const ps = defaultNativePathScoped();
        expect(ps.nativeHls.videoCodecs.length).toBeGreaterThan(0);
        expect(ps.nativeHls.audioCodecs.length).toBeGreaterThan(0);
    });

    it('defaultNativePathScoped audioSwitching is true', () => {
        const ps = defaultNativePathScoped();
        expect(ps.audioSwitching).toBe(true);
    });

    it('defaultNativePathScoped directFile supports mkv container', () => {
        const ps = defaultNativePathScoped();
        expect(ps.directFile.containers).toContain('mkv');
    });

    it('capsForDeliveryPath with browser defaults on mse_hls sets hlsAudioCodecs', () => {
        const baseCaps = defaultBrowserCaps();
        const pathScoped = defaultBrowserPathScoped();
        const caps = capsForDeliveryPath(baseCaps, pathScoped, 'mse_hls');
        expect(caps.hlsAudioCodecs).toBeDefined();
        expect(caps.hlsAudioCodecs!.size).toBeGreaterThan(0);
    });

    it('capsForDeliveryPath with native defaults on mse_hls narrows correctly', () => {
        // Native clients may fall back to mse_hls; caps should still narrow
        const nativeCaps: DeviceCapabilities = {
            videoCodecs: new Set(['h264', 'hevc', 'av1']),
            audioCodecs: new Set(['aac', 'mp3', 'opus', 'ac3', 'eac3', 'flac']),
            containers: new Set(['mp4', 'mkv', 'm4v', 'mov']),
            hlsAudioCodecs: new Set(['aac', 'ac3', 'eac3']),
            canSwitchAudioInDirectPlay: true,
        };
        const nativePath = defaultNativePathScoped();
        const caps = capsForDeliveryPath(nativeCaps, nativePath, 'mse_hls');
        // mseHls should narrow to what the path supports
        expect(caps.hlsAudioCodecs).toBeDefined();
        for (const codec of caps.audioCodecs) {
            expect(nativePath.mseHls.audioCodecs).toContain(codec);
        }
    });
});

// ── pathScopedFromDeviceCaps ──

describe('pathScopedFromDeviceCaps', () => {
    // Regression: a POSTed client-declared DeviceCapabilities (e.g. from a
    // Jellyfin DeviceProfile) was previously discarded in favour of the
    // generic clientType defaults, silently offering an H.264-only client
    // HEVC direct play. pathScopedFromDeviceCaps must use the declared caps
    // for directFile as-is, and intersect them with the clientType's
    // HLS/MSE allowlists for the HLS paths.
    it('derives path-scoped caps from a narrow H.264-only declaration (native client)', () => {
        const caps: DeviceCapabilities = {
            videoCodecs: new Set(['h264']),
            audioCodecs: new Set(['aac']),
            containers: new Set(['mp4', 'mkv']),
            canSwitchAudioInDirectPlay: true,
            maxAudioChannels: 6,
        };
        const result = pathScopedFromDeviceCaps(caps, 'native');

        expect(result.directFile.videoCodecs).toEqual(['h264']);
        expect(result.directFile.containers).toContain('mkv');

        // The client only declared h264 — HLS/MSE paths must NOT advertise
        // hevc/av1 even though the native clientType default allows them.
        expect(result.nativeHls.videoCodecs).toEqual(['h264']);
        expect(result.nativeHls.videoCodecs).not.toContain('hevc');
        expect(result.nativeHls.videoCodecs).not.toContain('av1');
        expect(result.mseHls.videoCodecs).toEqual(['h264']);
        expect(result.mseHls.videoCodecs).not.toContain('hevc');
        expect(result.mseHls.videoCodecs).not.toContain('av1');

        expect(result.maxChannels).toBe(6);
        expect(result.audioSwitching).toBe(true);
    });

    it('uses hlsAudioCodecs (not audioCodecs) for the nativeHls audio intersection when present', () => {
        const caps: DeviceCapabilities = {
            videoCodecs: new Set(['h264']),
            audioCodecs: new Set(['aac']),
            hlsAudioCodecs: new Set(['ac3']),
            containers: new Set(['mp4']),
            canSwitchAudioInDirectPlay: true,
        };
        const result = pathScopedFromDeviceCaps(caps, 'native');

        // nativeHls audio should be intersected against hlsAudioCodecs (ac3),
        // not the direct-play audioCodecs (aac) — 'ac3' is in the native
        // clientType's nativeHls allowlist, 'aac' would also be, but since we
        // declared hlsAudioCodecs explicitly it takes priority.
        expect(result.nativeHls.audioCodecs).toContain('ac3');
        expect(result.nativeHls.audioCodecs).not.toContain('aac');

        // directFile audio uses the flat audioCodecs set, unaffected by hlsAudioCodecs.
        expect(result.directFile.audioCodecs).toEqual(['aac']);
    });
});
