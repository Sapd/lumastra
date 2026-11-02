// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browser Media Capabilities Detection
 *
 * Detects what video codecs, HDR formats, and containers the browser can play.
 * Used to filter quality options and make smart transcoding decisions.
 */

import { browser } from '$app/environment';
import { findVideoCodec, findContainer, findHdrFormat, isDolbyVision } from './codec-support';
import { BURN_IN_CODECS } from './subtitle-utils';

// CodecSupport and BrowserCapabilities are defined in codec-types.ts to break
// the import cycle (codec-support <-> browserCapabilities). Re-exported here
// so callers importing from ./browserCapabilities continue to resolve. (ref: DL-003)
import type { CodecSupport, BrowserCapabilities, PathScopedCapabilities } from './codec-types';
export type { CodecSupport, BrowserCapabilities, PathScopedCapabilities } from './codec-types';

const defaultCapabilities: BrowserCapabilities = {
    h264: { supported: false },
    h265: { supported: false },
    vp9: { supported: false },
    av1: { supported: false },
    hdr10: { supported: false },
    hdr10Plus: { supported: false },
    dolbyVision: { supported: false },
    hlg: { supported: false },
    mp4: false,
    webm: false,
    mkv: false,
    hls: false,
    aac: false,
    ac3: false,
    eac3: false,
    truehd: false,
    dts: false,
    opus: false,
    flac: false,
    mse: false,
    eme: false,
    audioTracksApi: false,
    hdrDisplay: false,
    detected: false,
};

// Module-level $state variable replacing the writable store
let _capabilities: BrowserCapabilities = $state({ ...defaultCapabilities });

/**
 * Detect the browser name from user agent
 * Returns a human-readable browser name for display in Jellyfin sessions
 */
export function getBrowserName(): string {
    if (!browser) return 'Dashboard Server';

    const ua = navigator.userAgent;

    // Check for specific browsers (order matters - more specific first)
    if (ua.includes('Firefox/')) {
        return 'Firefox';
    }
    if (ua.includes('Edg/')) {
        return 'Edge';
    }
    if (ua.includes('OPR/') || ua.includes('Opera/')) {
        return 'Opera';
    }
    if (ua.includes('Brave')) {
        return 'Brave';
    }
    if (ua.includes('Vivaldi/')) {
        return 'Vivaldi';
    }
    if (ua.includes('Chrome/') && !ua.includes('Chromium/')) {
        return 'Chrome';
    }
    if (ua.includes('Chromium/')) {
        return 'Chromium';
    }
    if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
        return 'Safari';
    }

    return 'Dashboard Browser';
}

/**
 * Check if a specific codec configuration is supported using MediaCapabilities API
 */
async function checkMediaCapabilities(
    codec: string,
    width: number = 1920,
    height: number = 1080,
    bitrate: number = 10000000,
    framerate: number = 30,
    hdrMetadataType?: string,
    colorGamut?: string,
    transferFunction?: string,
): Promise<CodecSupport> {
    if (!browser || !('mediaCapabilities' in navigator)) {
        return { supported: false };
    }

    try {
        const config: MediaDecodingConfiguration = {
            type: 'media-source',
            video: {
                contentType: `video/mp4; codecs="${codec}"`,
                width,
                height,
                bitrate,
                framerate,
            },
        };

        // Add HDR metadata if specified
        if (hdrMetadataType || colorGamut || transferFunction) {
            const videoConfig = config.video as MediaDecodingConfiguration['video'] & {
                hdrMetadataType?: 'smpteSt2086' | 'smpteSt2094-10' | 'smpteSt2094-40';
                colorGamut?: 'srgb' | 'p3' | 'rec2020';
                transferFunction?: 'srgb' | 'pq' | 'hlg';
            };
            if (hdrMetadataType) {
                videoConfig.hdrMetadataType = hdrMetadataType as typeof videoConfig.hdrMetadataType;
            }
            if (colorGamut) {
                videoConfig.colorGamut = colorGamut as typeof videoConfig.colorGamut;
            }
            if (transferFunction) {
                videoConfig.transferFunction =
                    transferFunction as typeof videoConfig.transferFunction;
            }
        }

        const result = await navigator.mediaCapabilities.decodingInfo(config);
        return {
            supported: result.supported,
            smooth: result.smooth,
            powerEfficient: result.powerEfficient,
        };
    } catch {
        /* expected: mediaCapabilities API may not be available in all browsers */
        return { supported: false };
    }
}

/**
 * Fallback check using video element canPlayType
 */
function checkCanPlayType(mimeType: string): boolean {
    if (!browser) return false;

    try {
        const video = document.createElement('video');
        const result = video.canPlayType(mimeType);
        return result === 'probably' || result === 'maybe';
    } catch {
        /* expected: video element creation may fail in restricted environments */
        return false;
    }
}

/**
 * Detect all browser capabilities
 */
export async function detectCapabilities(): Promise<BrowserCapabilities> {
    if (!browser) {
        return defaultCapabilities;
    }

    const caps: BrowserCapabilities = { ...defaultCapabilities };

    // Check MSE support
    caps.mse = 'MediaSource' in window;

    // Check EME support
    caps.eme = 'requestMediaKeySystemAccess' in navigator;

    // Check HTML5 audioTracks API support (for switching audio tracks in direct play)
    // Only Safari properly supports this API for regular video files.
    // Chrome/Firefox have the property but it's non-functional (empty AudioTrackList).
    // We detect Safari by checking for the presence of 'safari' in the UA and absence of 'chrome'
    const ua = navigator.userAgent.toLowerCase();
    const isSafariBrowser =
        ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium');
    caps.audioTracksApi = isSafariBrowser;

    // Basic container support via canPlayType
    caps.mp4 = checkCanPlayType('video/mp4');
    caps.webm = checkCanPlayType('video/webm');
    caps.hls =
        checkCanPlayType('application/vnd.apple.mpegurl') ||
        checkCanPlayType('application/x-mpegURL');
    caps.mkv = caps.mse; // MKV typically works via MSE remuxing

    // Video codec support
    // H.264 (AVC)
    caps.h264 = await checkMediaCapabilities('avc1.640028'); // High Profile L4.0
    if (!caps.h264.supported) {
        caps.h264.supported = checkCanPlayType('video/mp4; codecs="avc1.640028"');
    }

    // The wire has one HEVC token, with no bit-depth constraint. Do not claim
    // it from an 8-bit Main probe: Firefox may accept Main while rejecting Main 10.
    caps.h265 = await checkMediaCapabilities('hvc1.2.4.L153.B0');
    const hevcConfirmed =
        checkCanPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"') &&
        checkCanPlayType('video/mp4; codecs="hvc1.2.4.L153.B0"');
    caps.h265.supported = caps.h265.supported && hevcConfirmed;

    // VP9
    caps.vp9 = await checkMediaCapabilities('vp09.00.50.08'); // Profile 0, Level 5.0
    if (!caps.vp9.supported) {
        caps.vp9.supported =
            checkCanPlayType('video/webm; codecs="vp9"') ||
            checkCanPlayType('video/mp4; codecs="vp09.00.50.08"');
    }

    // AV1
    caps.av1 = await checkMediaCapabilities('av01.0.08M.08'); // Main Profile, Level 4.0
    if (!caps.av1.supported) {
        caps.av1.supported =
            checkCanPlayType('video/mp4; codecs="av01.0.08M.08"') ||
            checkCanPlayType('video/webm; codecs="av01.0.08M.08"');
    }

    // HDR Support (requires both codec AND HDR metadata support)
    // HDR10 (PQ transfer + BT.2020 color)
    if (caps.h265.supported) {
        caps.hdr10 = await checkMediaCapabilities(
            'hvc1.2.4.L150.B0', // Main 10 Profile
            3840,
            2160,
            50000000,
            60,
            'smpteSt2086',
            'rec2020',
            'pq',
        );
    }

    // VP9 HDR (Profile 2)
    if (caps.vp9.supported) {
        const vp9Hdr = await checkMediaCapabilities(
            'vp09.02.50.10.01.09.16.09.00', // Profile 2, 10-bit, BT.2020, PQ
            3840,
            2160,
            50000000,
            60,
        );
        if (vp9Hdr.supported && !caps.hdr10.supported) {
            caps.hdr10 = vp9Hdr;
        }
    }

    // AV1 HDR
    if (caps.av1.supported) {
        const av1Hdr = await checkMediaCapabilities(
            'av01.0.13M.10.0.110.09.16.09.0', // Main 10 Profile with HDR
            3840,
            2160,
            50000000,
            60,
        );
        if (av1Hdr.supported && !caps.hdr10.supported) {
            caps.hdr10 = av1Hdr;
        }
    }

    // Dolby Vision (mainly Safari)
    caps.dolbyVision = await checkMediaCapabilities('dvhe.05.06'); // Profile 5
    if (!caps.dolbyVision.supported) {
        caps.dolbyVision = await checkMediaCapabilities('dvh1.05.06');
    }
    if (!caps.dolbyVision.supported) {
        caps.dolbyVision.supported =
            checkCanPlayType('video/mp4; codecs="dvhe.05.06"') ||
            checkCanPlayType('video/mp4; codecs="dvh1.05.06"');
    }

    // HLG (Hybrid Log-Gamma)
    caps.hlg = await checkMediaCapabilities(
        'hvc1.2.4.L150.B0',
        3840,
        2160,
        50000000,
        60,
        undefined,
        'rec2020',
        'hlg',
    );

    // Audio codec support
    caps.aac = checkCanPlayType('audio/mp4; codecs="mp4a.40.2"');

    // AC3/EAC3 (Dolby Digital/Digital Plus)
    // Safari supports these natively through its HLS implementation, but canPlayType
    // doesn't reliably report this. Force true for Safari with native HLS support.
    const hasNativeHls =
        checkCanPlayType('application/vnd.apple.mpegurl') ||
        checkCanPlayType('application/x-mpegURL');
    if (isSafariBrowser && hasNativeHls) {
        // Safari on macOS/iOS natively supports AC3/EAC3 in HLS streams
        caps.ac3 = true;
        caps.eac3 = true;
    } else {
        caps.ac3 = checkCanPlayType('audio/mp4; codecs="ac-3"');
        caps.eac3 = checkCanPlayType('audio/mp4; codecs="ec-3"');
    }

    caps.truehd = checkCanPlayType('audio/mp4; codecs="mlpa"');
    caps.dts =
        checkCanPlayType('audio/mp4; codecs="dts+"') ||
        checkCanPlayType('audio/mp4; codecs="dtsc"');
    caps.opus =
        checkCanPlayType('audio/webm; codecs="opus"') ||
        checkCanPlayType('audio/ogg; codecs="opus"');
    caps.flac = checkCanPlayType('audio/flac') || checkCanPlayType('audio/ogg; codecs="flac"');

    // Check if display supports HDR
    try {
        if ('matchMedia' in window) {
            caps.hdrDisplay = window.matchMedia('(dynamic-range: high)').matches;
        }
    } catch {
        /* expected: matchMedia may throw in some browser environments */
        caps.hdrDisplay = false;
    }

    caps.detected = true;

    // Log capabilities for debugging
    console.log('[BrowserCapabilities] Detected:', {
        codecs: {
            h264: caps.h264.supported,
            h265: caps.h265.supported,
            vp9: caps.vp9.supported,
            av1: caps.av1.supported,
        },
        hdr: {
            hdr10: caps.hdr10.supported,
            dolbyVision: caps.dolbyVision.supported,
            hlg: caps.hlg.supported,
            hdrDisplay: caps.hdrDisplay,
        },
        audio: {
            aac: caps.aac,
            ac3: caps.ac3,
            eac3: caps.eac3,
            opus: caps.opus,
        },
    });

    _capabilities = caps;
    return caps;
}

/**
 * Get current capabilities (cached)
 */
export function getCapabilities(): BrowserCapabilities {
    return _capabilities;
}

/**
 * Check if a specific video format can be played directly.
 * Uses centralized codec support tables for consistency.
 *
 * IMPORTANT: HDR content is always routed through HLS transcoding even if the browser
 * reports support. This is because:
 * 1. Browser HDR direct play support is inconsistent and often fails
 * 2. HLS allows Jellyfin to do HDR-to-SDR tone mapping when needed
 * 3. Safari's native HLS handler properly supports HDR content
 * 4. HLS provides better buffering and error recovery for high bitrate 4K HDR content
 */
export function canPlayDirectly(codec: string, videoRange?: string, container?: string): boolean {
    const caps = _capabilities;
    if (!caps.detected) return false;

    // Check for Dolby Vision - always force HLS for tone mapping
    const isDV = isDolbyVision(undefined, videoRange);
    if (isDV) {
        console.log('[canPlayDirectly] Dolby Vision detected, forcing HLS for tone mapping', {
            codec,
            videoRange,
            container,
        });
        return false;
    }

    // Check for non-DV HDR content
    const hdrFormat = findHdrFormat(undefined, videoRange);
    const isHdrNonDV = hdrFormat && !isDV;

    // For HDR10/HLG content, verify browser supports the video codec
    if (isHdrNonDV) {
        const videoCodecInfo = findVideoCodec(codec);
        if (!videoCodecInfo) {
            console.log('[canPlayDirectly] Unknown video codec for HDR content', {
                codec,
                videoRange,
                container,
            });
            return false;
        }

        // Check if browser supports this codec
        const capValue = caps[videoCodecInfo.capabilityKey];
        const codecSupported = typeof capValue === 'boolean' ? capValue : capValue?.supported;

        if (!codecSupported) {
            console.log(
                `[canPlayDirectly] HDR ${videoCodecInfo.displayName} content but browser lacks support`,
                { codec, videoRange, container },
            );
            return false;
        }

        console.log(
            '[canPlayDirectly] HDR10/HLG content, browser supports codec, allowing direct play',
            { codec, videoRange, codecInfo: videoCodecInfo.displayName },
        );
    }

    // Check video codec support using centralized table
    const videoCodecInfo = findVideoCodec(codec);
    let codecSupported = false;
    if (videoCodecInfo) {
        const capValue = caps[videoCodecInfo.capabilityKey];
        codecSupported = typeof capValue === 'boolean' ? capValue : capValue?.supported;
    }

    // Check container support using centralized table
    const containerInfo = findContainer(container);
    let containerSupported = false;

    if (containerInfo) {
        containerSupported = containerInfo.browserDirectPlay;
        // For TS container, check HLS/MSE support
        if (containerInfo.displayName === 'MPEG-TS') {
            containerSupported = caps.hls || caps.mse;
        }
    } else if (!container) {
        // No container info - assume compatible
        containerSupported = true;
    }

    return codecSupported && containerSupported;
}

/**
 * Get recommended transcoding settings based on browser capabilities
 */
export function getRecommendedTranscoding(): {
    videoCodec: string;
    audioCodec: string;
    container: string;
    maxBitrate: number;
} {
    const caps = _capabilities;

    // Prefer AV1 > VP9 > H.264 for transcoding (better compression)
    let videoCodec = 'h264';
    if (caps.av1.supported && caps.av1.powerEfficient) {
        videoCodec = 'av1';
    } else if (caps.vp9.supported && caps.vp9.powerEfficient) {
        videoCodec = 'vp9';
    }

    // Audio codec preference
    let audioCodec = 'aac';
    if (caps.opus) {
        audioCodec = 'opus'; // Better compression
    }

    return {
        videoCodec,
        audioCodec,
        container: 'mp4',
        maxBitrate: 20000000, // 20 Mbps default
    };
}

// ── Path-scoped capability detection ─────────────────────────

let pathScopedCaps = $state<PathScopedCapabilities | null>(null);
let pathScopedCapsPromise: Promise<PathScopedCapabilities | null> | null = null;

type MediaSourceSupport = {
    isTypeSupported?: (type: string) => boolean;
};

/**
 * Detect path-scoped capabilities for direct file, native HLS, and MSE HLS paths.
 * Must be called after detectCapabilities() has populated _capabilities.
 */
/** iPhone/iPad, including iPadOS reporting itself as a Mac. Same test as `isIOSDevice()` in $lib/pwa. */
function isAppleMobileDevice(): boolean {
    if (!browser) return false;
    return (
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
}

async function detectPathScopedCaps(): Promise<PathScopedCapabilities | null> {
    if (!browser) return null;

    const caps = _capabilities;
    const video = document.createElement('video');
    const mediaSource =
        (window.MediaSource as MediaSourceSupport | undefined) ??
        (window as Window & { ManagedMediaSource?: MediaSourceSupport }).ManagedMediaSource;

    const mseTypeSupported = (mimeType: string): boolean => {
        if (!mediaSource?.isTypeSupported) return false;
        try {
            return mediaSource.isTypeSupported(mimeType);
        } catch {
            return false;
        }
    };

    // ── directFile: progressive MP4/WebM via canPlayType ──
    const dfVideoCodecs: string[] = [];
    if (video.canPlayType('video/mp4; codecs="avc1.640033"')) dfVideoCodecs.push('h264');
    if (
        video.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"') &&
        video.canPlayType('video/mp4; codecs="hvc1.2.4.L153.B0"')
    )
        dfVideoCodecs.push('hevc');
    if (video.canPlayType('video/webm; codecs="vp09.00.51.08"')) dfVideoCodecs.push('vp9');
    if (video.canPlayType('video/mp4; codecs="av01.0.12M.10"')) dfVideoCodecs.push('av1');

    const dfAudioCodecs: string[] = [];
    if (video.canPlayType('audio/mp4; codecs="mp4a.40.2"')) dfAudioCodecs.push('aac');
    if (
        video.canPlayType('audio/webm; codecs="opus"') ||
        video.canPlayType('audio/ogg; codecs="opus"')
    )
        dfAudioCodecs.push('opus');
    if (video.canPlayType('audio/flac') || video.canPlayType('audio/ogg; codecs="flac"'))
        dfAudioCodecs.push('flac');
    if (video.canPlayType('audio/mp4; codecs="ac-3"')) dfAudioCodecs.push('ac3');
    if (video.canPlayType('audio/mp4; codecs="ec-3"')) dfAudioCodecs.push('eac3');

    const dfContainers: string[] = [];
    if (video.canPlayType('video/mp4')) dfContainers.push('mp4');
    if (video.canPlayType('video/webm')) dfContainers.push('webm');

    // ── nativeHls: only Safari ──
    const nhVideoCodecs: string[] = [];
    const nhAudioCodecs: string[] = [];
    const hlsSupported = !!video.canPlayType('application/vnd.apple.mpegurl');
    if (hlsSupported) {
        if (dfVideoCodecs.includes('h264')) nhVideoCodecs.push('h264');
        // A generic HLS MIME answer does not prove support for its codec.
        if (dfVideoCodecs.includes('hevc')) nhVideoCodecs.push('hevc');
        if (dfVideoCodecs.includes('av1')) nhVideoCodecs.push('av1');
        if (video.canPlayType('audio/mp4; codecs="ac-3"')) nhAudioCodecs.push('ac3');
        if (video.canPlayType('audio/mp4; codecs="ec-3"')) nhAudioCodecs.push('eac3');
        if (dfAudioCodecs.includes('aac')) nhAudioCodecs.push('aac');
    }

    // ── mseHls: MediaCapabilities API with type 'media-source' ──
    const mhVideoCodecs: string[] = [];
    const mhAudioCodecs: string[] = [];

    if ('mediaCapabilities' in navigator) {
        const probeVideo = async (codec: string, name: string): Promise<void> => {
            try {
                const result = await navigator.mediaCapabilities.decodingInfo({
                    type: 'media-source',
                    video: {
                        contentType: `video/mp4; codecs="${codec}"`,
                        width: 1920,
                        height: 1080,
                        bitrate: 10000000,
                        framerate: 30,
                    },
                });
                if (
                    result.supported &&
                    mseTypeSupported(`video/mp4; codecs="${codec}"`) &&
                    (name !== 'hevc' || mseTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"'))
                ) {
                    mhVideoCodecs.push(name);
                }
            } catch {
                /* mediaCapabilities may reject for unsupported configs */
            }
        };

        const probeAudio = async (codec: string, name: string): Promise<void> => {
            try {
                const result = await navigator.mediaCapabilities.decodingInfo({
                    type: 'media-source',
                    audio: {
                        contentType: `audio/mp4; codecs="${codec}"`,
                        channels: '2',
                        bitrate: 128000,
                        samplerate: 44100,
                    },
                });
                if (result.supported && mseTypeSupported(`audio/mp4; codecs="${codec}"`)) {
                    mhAudioCodecs.push(name);
                }
            } catch {
                /* mediaCapabilities may reject for unsupported configs */
            }
        };

        await Promise.all([
            probeVideo('avc1.640033', 'h264'),
            probeVideo('hvc1.2.4.L153.B0', 'hevc'),
            probeVideo('vp09.00.51.08', 'vp9'),
            probeVideo('av01.0.12M.10', 'av1'),
            probeAudio('mp4a.40.2', 'aac'),
            probeAudio('opus', 'opus'),
        ]);
    } else {
        // Fallback to canPlayType for MSE path
        if (caps.h264.supported && mseTypeSupported('video/mp4; codecs="avc1.640033"'))
            mhVideoCodecs.push('h264');
        if (
            mseTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"') &&
            mseTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"')
        )
            mhVideoCodecs.push('hevc');
        if (caps.vp9.supported && mseTypeSupported('video/mp4; codecs="vp09.00.51.08"'))
            mhVideoCodecs.push('vp9');
        if (caps.av1.supported && mseTypeSupported('video/mp4; codecs="av01.0.12M.10"'))
            mhVideoCodecs.push('av1');
        if (caps.aac && mseTypeSupported('audio/mp4; codecs="mp4a.40.2"'))
            mhAudioCodecs.push('aac');
        if (caps.opus && mseTypeSupported('audio/mp4; codecs="opus"')) mhAudioCodecs.push('opus');
    }

    // ── HDR detection ──
    const hdrDecode: string[] = [];
    if (caps.hdr10.supported) hdrDecode.push('hdr10');
    if (caps.hlg.supported) hdrDecode.push('hlg');
    if (caps.dolbyVision.supported) hdrDecode.push('dolby_vision');

    let hdrDisplay = false;
    try {
        if ('matchMedia' in window) {
            hdrDisplay = window.matchMedia('(dynamic-range: high)').matches;
        }
    } catch {
        /* matchMedia may throw in restricted environments */
    }

    // ── Max audio channels ──
    let maxChannels = 2;
    try {
        const ctx = new AudioContext();
        maxChannels = ctx.destination.maxChannelCount || 2;
        void ctx.close();
    } catch {
        /* AudioContext may not be available */
    }

    pathScopedCaps = {
        directFile: {
            videoCodecs: dfVideoCodecs,
            audioCodecs: dfAudioCodecs,
            containers: dfContainers,
        },
        nativeHls: {
            videoCodecs: nhVideoCodecs,
            audioCodecs: nhAudioCodecs,
        },
        mseHls: {
            videoCodecs: mhVideoCodecs,
            audioCodecs: mhAudioCodecs,
        },
        subtitleRendering: {
            vtt: true,
            pgs: true,
            ass: true,
            vobsub: true,
            burnInRequired: [...BURN_IN_CODECS],
        },
        hdr: {
            decode: hdrDecode,
            display: hdrDisplay,
        },
        audioSwitching: caps.audioTracksApi,
        hlsDemuxAudio: isAppleMobileDevice(),
        maxChannels,
        codecConstraints: {
            ...(caps.h264.supported ? { h264: { maxLevel: 52 } } : {}),
            ...(caps.h265.supported ? { hevc: { maxLevel: 153 } } : {}),
        },
    };

    if (import.meta.env.DEV) {
        console.log('[BrowserCapabilities] Path-scoped caps detected:', {
            directFile: pathScopedCaps.directFile,
            nativeHls: pathScopedCaps.nativeHls,
            mseHls: pathScopedCaps.mseHls,
            maxChannels,
            hdr: pathScopedCaps.hdr,
        });
    }

    return pathScopedCaps;
}

/**
 * Ensure path-scoped capabilities are available before requesting planner data.
 */
export async function ensurePathScopedCapabilities(): Promise<PathScopedCapabilities | null> {
    if (!browser) return null;
    if (pathScopedCaps) return pathScopedCaps;

    if (!_capabilities.detected) {
        await detectCapabilities();
    }

    if (!pathScopedCapsPromise) {
        pathScopedCapsPromise = detectPathScopedCaps().finally(() => {
            pathScopedCapsPromise = null;
        });
    }

    return pathScopedCapsPromise;
}

/**
 * Get path-scoped capabilities (null if not yet detected).
 */
export function getPathScopedCapabilities(): PathScopedCapabilities | null {
    return pathScopedCaps;
}

/**
 * Serialize PathScopedCapabilities into the compact wire format expected by
 * the server's `parsePathScopedCaps()`.
 *
 * Format: ps:df={v:h264,hevc;a:aac,opus;c:mp4,webm},nh={...},mh={...};h:hdr10,hlg;as:1;mc:8;cc:h264:52,hevc:153
 */
export function serializePathScopedCaps(caps: PathScopedCapabilities): string | null {
    const hasAnyCodec =
        caps.directFile.videoCodecs.length > 0 ||
        caps.directFile.audioCodecs.length > 0 ||
        caps.nativeHls.videoCodecs.length > 0 ||
        caps.nativeHls.audioCodecs.length > 0 ||
        caps.mseHls.videoCodecs.length > 0 ||
        caps.mseHls.audioCodecs.length > 0;
    if (!hasAnyCodec) return null;

    const df = `df={v:${caps.directFile.videoCodecs.join(',')};a:${caps.directFile.audioCodecs.join(',')};c:${caps.directFile.containers.join(',')}}`;
    const nh = `nh={v:${caps.nativeHls.videoCodecs.join(',')};a:${caps.nativeHls.audioCodecs.join(',')}}`;
    const mh = `mh={v:${caps.mseHls.videoCodecs.join(',')};a:${caps.mseHls.audioCodecs.join(',')}}`;

    const blocks = [`ps:${df}`, nh, mh];

    const trailing: string[] = [];
    if (caps.hdr.decode.length > 0) {
        trailing.push(`h:${caps.hdr.decode.join(',')}`);
    }
    if (caps.audioSwitching) {
        trailing.push('as:1');
    }
    if (caps.hlsDemuxAudio) {
        trailing.push('da:1');
    }
    if (caps.maxChannels > 2) {
        trailing.push(`mc:${caps.maxChannels}`);
    }
    const cc = Object.entries(caps.codecConstraints)
        .map(([codec, c]) => (c.maxLevel ? `${codec}:${c.maxLevel}` : null))
        .filter(Boolean)
        .join(',');
    if (cc) {
        trailing.push(`cc:${cc}`);
    }

    const blockStr = blocks.join(',');
    return trailing.length > 0 ? `${blockStr};${trailing.join(';')}` : blockStr;
}

// Auto-detect on module load in browser
if (browser) {
    void detectCapabilities()
        .then(() => ensurePathScopedCapabilities())
        .catch(() => {
            // detectCapabilities may reject in restricted environments (e.g. iframes)
        });
}
