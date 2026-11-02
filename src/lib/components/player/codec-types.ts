// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared codec type definitions
 *
 * Dependency direction: codec-types <- codec-support <- browserCapabilities
 * BrowserCapabilities lives here so both codec-support.ts and browserCapabilities.ts
 * can import it without forming a cycle. (ref: DL-003)
 */

/** Probing result from MediaCapabilities API or CanPlayType for a single codec. */
export interface CodecSupport {
    supported: boolean;
    /** Whether the browser can decode this codec without dropped frames. */
    smooth?: boolean;
    /** Whether decoding uses hardware acceleration. */
    powerEfficient?: boolean;
}

/** Snapshot of browser media capability detection. Populated by detectBrowserCapabilities(). */
export interface BrowserCapabilities {
    // Video Codecs
    h264: CodecSupport;
    h265: CodecSupport; // HEVC
    vp9: CodecSupport;
    av1: CodecSupport;

    // HDR Support
    hdr10: CodecSupport;
    hdr10Plus: CodecSupport;
    dolbyVision: CodecSupport;
    hlg: CodecSupport;

    // Container Support
    mp4: boolean;
    webm: boolean;
    mkv: boolean; // Via MSE
    hls: boolean;

    // Audio Codecs
    aac: boolean;
    ac3: boolean; // Dolby Digital
    eac3: boolean; // Dolby Digital Plus
    truehd: boolean; // Dolby TrueHD (rare in browsers)
    dts: boolean;
    opus: boolean;
    flac: boolean;

    // Features
    mse: boolean; // Media Source Extensions
    eme: boolean; // Encrypted Media Extensions (DRM)
    audioTracksApi: boolean; // HTML5 audioTracks API for switching audio in direct play

    // Display
    hdrDisplay: boolean; // Whether display supports HDR

    // Detection complete
    detected: boolean;
}

/**
 * Three-path scoped capability detection (DL-003).
 * Each delivery path has its own codec/container/audio support set because
 * Safari native HLS vs MSE capabilities are genuinely different.
 */
export interface PathScopedCapabilities {
    directFile: {
        videoCodecs: string[];
        audioCodecs: string[];
        containers: string[];
    };
    nativeHls: {
        videoCodecs: string[];
        audioCodecs: string[];
    };
    mseHls: {
        videoCodecs: string[];
        audioCodecs: string[];
    };
    subtitleRendering: {
        vtt: boolean;
        pgs: boolean;
        ass: boolean;
        vobsub: boolean;
        burnInRequired: string[];
    };
    hdr: {
        decode: string[];
        display: boolean;
    };
    audioSwitching: boolean;
    maxChannels: number;
    codecConstraints: Record<string, { maxLevel?: number }>;
    /**
     * Native HLS must get audio as separate renditions (a master playlist with
     * EXT-X-MEDIA audio and CODECS), never muxed into the video segments.
     * Set on iPhone/iPad: iOS Safari looped on the first segment of muxed
     * fMP4 with AC-3 audio (2026-10-15), and Apple's HLS authoring spec 9.6
     * requires multichannel audio in separate streams. Wire token `da:1`.
     */
    hlsDemuxAudio?: boolean;
}
