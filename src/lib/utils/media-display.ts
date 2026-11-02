// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared media display utilities for formatting codec, bitrate, and resolution info.
 * Used by StreamingSessions and VideoPlayer components.
 */

/**
 * Format bitrate to human-readable string
 * @param bitrate Bitrate in bits per second
 * @returns Formatted string like "20.0 Mbps" or "384 kbps"
 */
export function formatBitrate(bitrate?: number): string {
    if (!bitrate) return '';
    const mbps = bitrate / 1000000;
    const kbps = bitrate / 1000;

    // For audio bitrates (typically < 1 Mbps), show in kbps for better readability
    if (mbps < 1) {
        return `${Math.round(kbps)} kbps`;
    }
    return `${mbps.toFixed(1)} Mbps`;
}

/**
 * Get friendly resolution label from width/height
 *
 * Labels follow the conventional height buckets. The height used is the larger of the
 * coded height and the 16:9 height the width implies, so a cropped cinemascope frame
 * (1920x800) is 1080p and a 640x360 frame is 360p, not 480p.
 *
 * @param width Video width in pixels
 * @param height Video height in pixels
 * @returns Resolution label like "4K", "1080p", "720p", or '' when the size is unknown
 */
export function getFriendlyResolution(width?: number, height?: number): string {
    if (!width || !height) return '';

    const lines = Math.max(height, Math.round((width * 9) / 16));
    if (lines <= 400) return '360p';
    if (lines <= 540) return '480p';
    if (lines <= 800) return '720p';
    if (lines <= 1200) return '1080p';
    if (lines <= 1600) return '1440p';
    return '4K';
}

/**
 * Format codec transcoding info
 * @param originalCodec Original codec (e.g., "hevc")
 * @param transcodeCodec Transcoded codec (e.g., "h264")
 * @param isTranscoding Whether transcoding is active
 * @returns Formatted string like "HEVC → H264" or just "HEVC"
 */
export function formatCodecInfo(
    originalCodec?: string,
    transcodeCodec?: string,
    isTranscoding?: boolean,
): string {
    if (isTranscoding && originalCodec && transcodeCodec) {
        return `${originalCodec.toUpperCase()} → ${transcodeCodec.toUpperCase()}`;
    }
    if (originalCodec) {
        return originalCodec.toUpperCase();
    }
    if (transcodeCodec) {
        return transcodeCodec.toUpperCase();
    }
    return '';
}

/**
 * Format bitrate transcoding info
 * @param originalBitrate Original bitrate in bps
 * @param transcodeBitrate Transcoded bitrate in bps
 * @param isTranscoding Whether transcoding is active
 * @returns Formatted string like "20.0 Mbps → 4.0 Mbps" or just "20.0 Mbps"
 */
export function formatBitrateInfo(
    originalBitrate?: number,
    transcodeBitrate?: number,
    isTranscoding?: boolean,
): string {
    if (isTranscoding && originalBitrate && transcodeBitrate) {
        return `${formatBitrate(originalBitrate)} → ${formatBitrate(transcodeBitrate)}`;
    }
    if (originalBitrate) {
        return formatBitrate(originalBitrate);
    }
    if (transcodeBitrate) {
        return formatBitrate(transcodeBitrate);
    }
    return '';
}

/**
 * Format episode number display, handling multi-episode ranges.
 * @param episodeNumber Start episode number
 * @param episodeNumberEnd Optional end episode number for combined episodes
 * @param pad Whether to zero-pad numbers (e.g., "01" instead of "1")
 * @returns Formatted string like "E1", "E1-E2", or "E01-E02"
 */
export function formatEpisodeNumber(
    episodeNumber: number,
    episodeNumberEnd?: number | null,
    pad: boolean = false,
): string {
    const fmt = (n: number): string => (pad ? String(n).padStart(2, '0') : String(n));
    if (episodeNumberEnd != null && episodeNumberEnd !== episodeNumber) {
        return `E${fmt(episodeNumber)}-E${fmt(episodeNumberEnd)}`;
    }
    return `E${fmt(episodeNumber)}`;
}
