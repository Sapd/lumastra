// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS Utilities
 *
 * Shared utilities for HLS transcoding strategies.
 */

import * as path from 'path';
import { toIso6392B } from '$lib/shared/language-codes';
import { Logger } from '../../utils/logger.js';
import {
    getHlsCompatibleAudioCodecPatterns,
    getHlsIncompatibleAudioCodecPatterns,
    isHlsCompatibleAudioCodec as isHlsCompatibleFromTable,
    findAudioCodecEntry,
} from '$lib/shared/codec-tables.js';

const logger = Logger.for('HlsUtils');

// ============================================================================
// HLS Audio Codec Compatibility
// ============================================================================

/**
 * Audio codecs that are HLS-compatible and safe to copy without transcoding.
 * These work in fMP4 segments with Apple TV, iOS, and most HLS players.
 *
 * Generated from centralized codec tables in $lib/shared/codec-tables.ts
 */
export const HLS_COMPATIBLE_AUDIO_CODECS = getHlsCompatibleAudioCodecPatterns();

/**
 * Audio codecs that require transcoding for HLS compatibility.
 * These are lossless or proprietary formats that don't work in HLS.
 *
 * Generated from centralized codec tables in $lib/shared/codec-tables.ts
 */
export const HLS_INCOMPATIBLE_AUDIO_CODECS = getHlsIncompatibleAudioCodecPatterns();

/**
 * Check if an audio codec is HLS-compatible and safe to copy.
 *
 * @param codec The audio codec name (case-insensitive)
 * @returns true if the codec can be copied directly into HLS fMP4
 */
export function isHlsCompatibleAudioCodec(codec: string | undefined): boolean {
    return isHlsCompatibleFromTable(codec);
}

/**
 * Check if audio needs transcoding for HLS compatibility.
 *
 * @param codec The audio codec name
 * @returns true if the codec must be transcoded for HLS
 */
export function requiresAudioTranscode(codec: string | undefined): boolean {
    if (!codec) return true; // Unknown codec - safer to transcode

    const entry = findAudioCodecEntry(codec);
    if (!entry) {
        // Unknown codec - safer to transcode
        logger.warn('Unknown audio codec, will transcode for safety', {
            codec,
        });
        return true;
    }

    return !entry.hlsCompatible;
}

/**
 * Determine the best audio handling for a track based on:
 * - Source codec
 * - Requested action (copy/transcode)
 * - HLS compatibility
 *
 * @returns 'copy' if safe to copy, 'transcode' if transcoding required
 */
export function determineAudioAction(
    sourceCodec: string | undefined,
    requestedAction: 'copy' | 'transcode' | undefined,
): 'copy' | 'transcode' {
    // If explicitly requesting transcode, honor it
    if (requestedAction === 'transcode') {
        return 'transcode';
    }

    // If requesting copy, validate codec compatibility
    if (requestedAction === 'copy') {
        if (isHlsCompatibleAudioCodec(sourceCodec)) {
            return 'copy';
        }
        // Codec not compatible - must transcode despite request
        logger.info('Audio copy requested but codec not HLS-compatible, will transcode', {
            sourceCodec,
        });
        return 'transcode';
    }

    // No explicit request - auto-detect based on codec
    if (isHlsCompatibleAudioCodec(sourceCodec)) {
        return 'copy';
    }
    return 'transcode';
}

// ============================================================================
// var_stream_map Building
// ============================================================================

/**
 * Audio track info for var_stream_map building
 */
export interface AudioTrackMapInfo {
    language?: string;
    isDefault: boolean;
}

/**
 * Build FFmpeg var_stream_map for multi-audio HLS demuxing.
 *
 * Creates a mapping that:
 * - Lists audio streams first (with language codes and default flags)
 * - Lists video stream last
 * - Uses consistent naming: audio tracks 0..N-1, video track N
 *
 * @param audioTracks Array of audio track info with language and default status
 * @returns Array of var_stream_map parts to be joined with spaces
 *
 * @example
 * // For 2 audio tracks (English default, German)
 * buildVarStreamMap([
 *   { language: 'eng', isDefault: true },
 *   { language: 'deu', isDefault: false }
 * ])
 * // Returns:
 * // ['a:0,agroup:audio,language:eng,name:0,default:yes',
 * //  'a:1,agroup:audio,language:deu,name:1,default:no',
 * //  'v:0,agroup:audio,name:2']
 */
export function buildVarStreamMap(audioTracks: AudioTrackMapInfo[]): string[] {
    const streamMapParts: string[] = [];

    // Warn if no audio tracks - this might indicate an upstream issue
    if (audioTracks.length === 0) {
        logger.warn(
            'buildVarStreamMap called with empty audioTracks array - output will be video-only',
        );
    }

    // Use the source isDefault flag from the database, matching what our master playlist advertises.
    // Both FFmpeg's var_stream_map and the master playlist must agree on which track is DEFAULT,
    // otherwise Safari shows one language in the UI but plays another.
    let defaultIndex = audioTracks.findIndex((t) => t.isDefault);
    if (defaultIndex === -1) {
        // No explicit default — use first track
        defaultIndex = 0;
    }

    // Audio streams first (name:0, name:1, ...)
    for (let i = 0; i < audioTracks.length; i++) {
        const track = audioTracks[i];
        // Same guard as the master playlist's LANGUAGE attribute (hls-master-playlist.ts):
        // toIso6392B's fallback branch passes through any unmapped 3-character
        // string, so sanitize before it lands in the -var_stream_map value, for
        // consistency even though this string isn't quoted the way HLS attributes are.
        const langCode = (toIso6392B(track.language) || 'und').replace(/[^a-z]/g, '') || 'und';
        // Use our computed default index instead of source isDefault flag
        const isDefault = i === defaultIndex ? 'yes' : 'no';
        streamMapParts.push(
            `a:${i},agroup:audio,language:${langCode},name:${i},default:${isDefault}`,
        );
    }

    // Video stream last
    const videoStreamIndex = audioTracks.length;
    streamMapParts.push(`v:0,agroup:audio,name:${videoStreamIndex}`);

    return streamMapParts;
}

/**
 * Options for HLS output pattern generation.
 */
export interface HlsOutputPatternOptions {
    /** Segment container: 'fmp4' uses .m4s, 'mpegts' uses .ts. Default: 'fmp4' */
    container?: 'fmp4' | 'mpegts';
    /** Audio mode: 'muxed' uses flat output (no stream_%v dirs). Default: 'demux' */
    audioMode?: 'demux' | 'muxed';
}

/**
 * Build HLS output pattern arguments for FFmpeg.
 *
 * Adds the -hls_segment_filename and output pattern arguments
 * that must come at the end of the FFmpeg command.
 *
 * @param outputDir Base directory for HLS output
 * @param options Container and audio mode configuration
 * @returns Array of FFmpeg arguments for output patterns
 *
 * @example
 * // Demux fMP4 (default):
 * buildHlsOutputPattern('/tmp/abc123')
 * // ['-hls_segment_filename', '/tmp/abc123/stream_%v/segment_%05d.m4s',
 * //  '/tmp/abc123/stream_%v/index.m3u8']
 *
 * // Muxed MPEG-TS:
 * buildHlsOutputPattern('/tmp/abc123', { container: 'mpegts', audioMode: 'muxed' })
 * // ['-hls_segment_filename', '/tmp/abc123/segment_%05d.ts',
 * //  '/tmp/abc123/index.m3u8']
 */
export function buildHlsOutputPattern(
    outputDir: string,
    options?: HlsOutputPatternOptions,
): string[] {
    const ext = options?.container === 'mpegts' ? 'ts' : 'm4s';
    const isMuxed = options?.audioMode === 'muxed';

    if (isMuxed) {
        // Muxed mode: single output, no stream_%v directories
        return [
            '-hls_segment_filename',
            path.join(outputDir, `segment_%05d.${ext}`),
            path.join(outputDir, 'index.m3u8'),
        ];
    }

    // Demux mode: separate stream directories per variant
    return [
        '-hls_segment_filename',
        path.join(outputDir, 'stream_%v', `segment_%05d.${ext}`),
        path.join(outputDir, 'stream_%v', 'index.m3u8'),
    ];
}
