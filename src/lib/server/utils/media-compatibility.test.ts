// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    checkCompatibility,
    selectTranscodeCodec,
    parseSoftwareCodecPreference,
    buildTranscodeReasons,
    buildTranscodeReasonCodes,
    mediaInfoFromStreamRows,
    deviceCapsFromProfile,
    normalizeVideoCodecToken,
    type DeviceCapabilities,
    type MediaInfo,
    type ServerEncodeCaps,
    type SelectTranscodeCodecContext,
} from './media-compatibility.js';

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function caps(overrides: Partial<DeviceCapabilities> = {}): DeviceCapabilities {
    return {
        videoCodecs: new Set(['h264', 'hevc', 'av1']),
        audioCodecs: new Set(['aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3']),
        containers: new Set(['mp4', 'webm', 'm4v', 'mov']),
        hdrFormats: new Set(['hdr10', 'hlg']),
        canSwitchAudioInDirectPlay: false,
        ...overrides,
    };
}

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

// ──────────────────────────────────────────────────────────
// checkCompatibility
// ──────────────────────────────────────────────────────────

describe('checkCompatibility', () => {
    it('direct play: h264/aac/mp4 SDR single audio', () => {
        const result = checkCompatibility(media(), caps());
        expect(result.videoCompatible).toBe(true);
        expect(result.audioCompatible).toBe(true);
        expect(result.containerCompatible).toBe(true);
        expect(result.needsTonemapping).toBe(false);
        expect(result.needsHlsForAudio).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('remux: h264/aac in MKV container', () => {
        const result = checkCompatibility(media({ container: 'matroska' }), caps());
        expect(result.videoCompatible).toBe(true);
        expect(result.audioCompatible).toBe(true);
        expect(result.containerCompatible).toBe(false);
        expect(result.recommended).toBe('remux');
    });

    it('audio transcode: h264/dts/mp4', () => {
        const result = checkCompatibility(media({ audioCodecs: ['dts'] }), caps());
        expect(result.videoCompatible).toBe(true);
        expect(result.audioCompatible).toBe(false);
        expect(result.containerCompatible).toBe(true);
        expect(result.recommended).toBe('audio_transcode');
    });

    it('full transcode: hevc without hevc support', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'hevc' }),
            caps({ videoCodecs: new Set(['h264']) }),
        );
        expect(result.videoCompatible).toBe(false);
        expect(result.recommended).toBe('full_transcode');
    });

    it('DV tonemapping: hevc/dovi without device DV support', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', hdr: 'dovi' }),
            caps({ hdrFormats: new Set(['hdr10']) }),
        );
        expect(result.needsTonemapping).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    // A copy preserves DV (ffmpeg writes the dvvC box), so a DV-capable device can
    // direct-play any profile — including 5/7, which carry the DV codec as the
    // primary CODECS entry.
    it('DV direct play: hevc/dovi with device DV support', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', hdr: 'dovi' }),
            caps({ hdrFormats: new Set(['hdr10', 'dovi']) }),
        );
        expect(result.needsTonemapping).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('DV profile 8 direct-plays with device DV support', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', hdr: 'dovi_hdr10' }),
            caps({ hdrFormats: new Set(['hdr10', 'dovi']) }),
        );
        expect(result.needsTonemapping).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('multi-audio forces HLS remux: 2 tracks, canSwitchAudioInDirectPlay=false', () => {
        const result = checkCompatibility(
            media({ audioTrackCount: 2 }),
            caps({ canSwitchAudioInDirectPlay: false }),
        );
        expect(result.needsHlsForAudio).toBe(true);
        expect(result.recommended).toBe('remux');
    });

    it('multi-audio direct play: 2 tracks, canSwitchAudioInDirectPlay=true (Safari)', () => {
        const result = checkCompatibility(
            media({ audioTrackCount: 2 }),
            caps({ canSwitchAudioInDirectPlay: true }),
        );
        expect(result.needsHlsForAudio).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('mixed multi-audio: aac+dts tracks → remux (aac is HLS-compatible)', () => {
        const result = checkCompatibility(
            media({ audioCodecs: ['aac', 'dts'], audioTrackCount: 2 }),
            caps({ canSwitchAudioInDirectPlay: true }),
        );
        expect(result.audioCompatible).toBe(false);
        expect(result.audioAllCompatible).toBe(false);
        expect(result.audioAnyCompatible).toBe(true);
        expect(result.audioAnyCompatibleInHls).toBe(true);
        expect(result.incompatibleAudioCodecs).toEqual(['dts']);
        expect(result.recommended).toBe('remux');
    });

    it('HLS audio codecs: ac3 supported via hlsAudioCodecs', () => {
        const result = checkCompatibility(
            media({ audioCodecs: ['ac3'] }),
            caps({
                audioCodecs: new Set(['aac']),
                hlsAudioCodecs: new Set(['aac', 'ac3', 'eac3']),
            }),
        );
        expect(result.audioCompatibleInHls).toBe(true);
    });

    it('comma-separated container: matroska,webm with webm in containers', () => {
        // checkCompatibility itself correctly parses comma-separated containers.
        // NOTE: In production this input should NEVER reach checkCompatibility —
        // ffprobe's raw format_name is normalized via containerFromExtension() first,
        // which returns 'mkv' for .mkv files. See ffprobe.test.ts for that coverage.
        const result = checkCompatibility(
            media({ container: 'matroska,webm' }),
            caps({ containers: new Set(['webm', 'mp4']) }),
        );
        expect(result.containerCompatible).toBe(true);
    });

    // Regression: MKV files received 'direct' recommendation because ffprobe's
    // format_name "matroska,webm" was passed directly, making 'webm' match browser
    // caps. After normalization via containerFromExtension(), 'mkv' is used and
    // is not in any browser's default container set → correctly forces remux.
    it('mkv container: not in browser caps → remux (regression for ffprobe format_name bug)', () => {
        const result = checkCompatibility(
            media({ container: 'mkv' }),
            caps({ containers: new Set(['mp4', 'webm', 'm4v', 'mov']) }),
        );
        expect(result.containerCompatible).toBe(false);
        expect(result.recommended).toBe('remux');
    });

    it('recommends remux (not audio_transcode) when audio is HLS-compatible', () => {
        // Safari can pass AC3 through in HLS but not in direct play
        const result = checkCompatibility(
            media({ audioCodecs: ['ac3'] }),
            caps({
                audioCodecs: new Set(['aac', 'mp3', 'opus']),
                hlsAudioCodecs: new Set(['aac', 'ac3', 'eac3']),
            }),
        );
        expect(result.audioCompatible).toBe(false);
        expect(result.audioCompatibleInHls).toBe(true);
        expect(result.recommended).toBe('remux'); // not audio_transcode!
    });

    it('recommends audio_transcode when audio is NOT HLS-compatible either', () => {
        const result = checkCompatibility(
            media({ audioCodecs: ['dts'] }),
            caps({ hlsAudioCodecs: new Set(['aac', 'ac3']) }),
        );
        expect(result.audioCompatible).toBe(false);
        expect(result.audioCompatibleInHls).toBe(false);
        expect(result.recommended).toBe('audio_transcode');
    });

    it('DV Profile 8 (dovi_hdr10) needs tonemapping when device lacks DV support', () => {
        // Chrome/Firefox/Edge reject DV P8 bitstreams with bufferAddCodecError on MSE,
        // even though the HDR10 base layer is theoretically playable. The DV EL / dvh1
        // codec-parameter strings confuse MSE decoders, so we must tonemap.
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', hdr: 'dovi_hdr10' }),
            caps({
                videoCodecs: new Set(['h264', 'hevc']),
                hdrFormats: new Set(['hdr10']),
            }),
        );
        expect(result.needsTonemapping).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('DV Profile 8 (dovi_hdr10) direct play when device advertises DV support', () => {
        // Safari and other DV-capable clients can decode the full Profile 8 stream.
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', hdr: 'dovi_hdr10' }),
            caps({
                videoCodecs: new Set(['h264', 'hevc']),
                hdrFormats: new Set(['hdr10', 'dovi']),
            }),
        );
        expect(result.needsTonemapping).toBe(false);
        expect(result.videoCompatible).toBe(true);
        expect(result.recommended).toBe('direct');
    });

    it('DV Profile 5/7 (pure dovi) DOES need tonemapping without device DV support', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', hdr: 'dovi' }),
            caps({
                videoCodecs: new Set(['h264', 'hevc']),
                hdrFormats: new Set(['hdr10']),
            }),
        );
        expect(result.needsTonemapping).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('HDR10 AV1 direct play', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'av1', hdr: 'hdr10' }),
            caps({ hdrFormats: new Set(['hdr10', 'hlg']) }),
        );
        expect(result.videoCompatible).toBe(true);
        expect(result.needsTonemapping).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('no hdrFormats on caps — non-dovi HDR does not force tonemapping', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'h264', hdr: 'hdr10' }),
            caps({ hdrFormats: undefined }),
        );
        expect(result.needsTonemapping).toBe(false);
    });

    it('multi-audio HLS remux takes priority over container mismatch (both → remux)', () => {
        const result = checkCompatibility(
            media({ container: 'matroska', audioTrackCount: 2 }),
            caps({ canSwitchAudioInDirectPlay: false }),
        );
        expect(result.recommended).toBe('remux');
    });

    it('tonemapping overrides video-compatible check → full_transcode', () => {
        // hevc is supported but dovi tonemapping is needed → full_transcode
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', hdr: 'dovi' }),
            caps({
                videoCodecs: new Set(['h264', 'hevc']),
                hdrFormats: new Set(['hdr10']),
            }),
        );
        expect(result.videoCompatible).toBe(true);
        expect(result.needsTonemapping).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('10-bit H.264 (Hi10P) forces full_transcode despite h264 support', () => {
        const result = checkCompatibility(media({ videoCodec: 'h264', videoBitDepth: 10 }), caps());
        expect(result.videoCompatible).toBe(false);
        expect(result.recommended).toBe('full_transcode');
    });

    it('8-bit H.264 is direct play as normal', () => {
        const result = checkCompatibility(media({ videoCodec: 'h264', videoBitDepth: 8 }), caps());
        expect(result.videoCompatible).toBe(true);
        expect(result.recommended).toBe('direct');
    });

    it('10-bit HEVC is NOT blocked (browsers support Main 10)', () => {
        const result = checkCompatibility(media({ videoCodec: 'hevc', videoBitDepth: 10 }), caps());
        expect(result.videoCompatible).toBe(true);
    });

    it('HDR10+ content: direct play when device supports hdr10', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', hdr: 'hdr10plus' }),
            caps({ hdrFormats: new Set(['hdr10']) }),
        );
        // hdr10plus is not 'dovi', so no tonemapping needed
        expect(result.needsTonemapping).toBe(false);
        expect(result.videoCompatible).toBe(true);
        expect(result.recommended).toBe('direct');
    });

    // ── Extended constraint checks ──────────────────────────

    it('video level exceeded: H.264 Level 52 on max 51 device', () => {
        const result = checkCompatibility(media({ videoLevel: 52 }), caps({ maxVideoLevel: 51 }));
        expect(result.videoLevelExceeded).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('video level within limit: H.264 Level 41 on max 51 device', () => {
        const result = checkCompatibility(media({ videoLevel: 41 }), caps({ maxVideoLevel: 51 }));
        expect(result.videoLevelExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('video level: no constraint when maxVideoLevel not set', () => {
        const result = checkCompatibility(media({ videoLevel: 99 }), caps());
        expect(result.videoLevelExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('video profile exceeded: High 10 not in allowed profiles', () => {
        const result = checkCompatibility(
            media({ videoProfile: 'High 10' }),
            caps({ maxVideoProfile: 'high|main|baseline' }),
        );
        expect(result.videoProfileExceeded).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('video profile allowed: Main in pipe-separated list', () => {
        const result = checkCompatibility(
            media({ videoProfile: 'Main' }),
            caps({ maxVideoProfile: 'high|main|baseline|high 10' }),
        );
        expect(result.videoProfileExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('video profile match: High on High device (case-insensitive)', () => {
        const result = checkCompatibility(
            media({ videoProfile: 'high' }),
            caps({ maxVideoProfile: 'High|Main' }),
        );
        expect(result.videoProfileExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('video profile: single value still works', () => {
        const result = checkCompatibility(
            media({ videoProfile: 'High' }),
            caps({ maxVideoProfile: 'High' }),
        );
        expect(result.videoProfileExceeded).toBe(false);
    });

    it('resolution exceeded: 4K on 1080p device', () => {
        const result = checkCompatibility(
            media({ width: 3840, height: 2160 }),
            caps({ maxWidth: 1920, maxHeight: 1080 }),
        );
        expect(result.resolutionExceeded).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('resolution within limit', () => {
        const result = checkCompatibility(
            media({ width: 1920, height: 1080 }),
            caps({ maxWidth: 3840, maxHeight: 2160 }),
        );
        expect(result.resolutionExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('resolution: width exceeds but height does not → exceeded', () => {
        const result = checkCompatibility(
            media({ width: 2560, height: 1080 }),
            caps({ maxWidth: 1920 }),
        );
        expect(result.resolutionExceeded).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('resolution exceeded: device maxHeight only → source is device', () => {
        const result = checkCompatibility(
            media({ width: 3840, height: 2160 }),
            caps({ maxHeight: 1080 }),
        );
        expect(result.resolutionExceeded).toBe(true);
        expect(result.resolutionExceededSource).toBe('device');
        expect(result.recommended).toBe('full_transcode');
    });

    it('resolution exceeded by user-selected height cap only: device allows it', () => {
        const result = checkCompatibility(
            media({ width: 1920, height: 1080 }),
            caps({ maxHeight: 2160, userSelectedMaxHeight: 720 }),
        );
        expect(result.resolutionExceeded).toBe(true);
        expect(result.resolutionExceededSource).toBe('user');
        expect(result.recommended).toBe('full_transcode');
    });

    it('resolution exceeded by both: user cap is tighter → source is user', () => {
        const result = checkCompatibility(
            media({ width: 3840, height: 2160 }),
            caps({ maxHeight: 1080, userSelectedMaxHeight: 720 }),
        );
        expect(result.resolutionExceeded).toBe(true);
        expect(result.resolutionExceededSource).toBe('user');
    });

    it('resolution exceeded by both: device cap is tighter → source is device', () => {
        const result = checkCompatibility(
            media({ width: 3840, height: 2160 }),
            caps({ maxHeight: 720, userSelectedMaxHeight: 1080 }),
        );
        expect(result.resolutionExceeded).toBe(true);
        expect(result.resolutionExceededSource).toBe('device');
    });

    it('user height cap alone: within limit → direct play', () => {
        const result = checkCompatibility(
            media({ width: 1280, height: 720 }),
            caps({ userSelectedMaxHeight: 1080 }),
        );
        expect(result.resolutionExceeded).toBe(false);
        expect(result.resolutionExceededSource).toBeNull();
        expect(result.recommended).toBe('direct');
    });

    it('height exactly equal to user cap is NOT exceeded (strict >)', () => {
        const result = checkCompatibility(
            media({ width: 1920, height: 1080 }),
            caps({ userSelectedMaxHeight: 1080 }),
        );
        expect(result.resolutionExceeded).toBe(false);
        expect(result.resolutionExceededSource).toBeNull();
    });

    it('buildTranscodeReasonCodes emits resolution_exceeded_user_cap when source is user', () => {
        const m = media({ width: 3840, height: 2160 });
        const c = caps({ maxHeight: 2160, userSelectedMaxHeight: 1080 });
        const compat = checkCompatibility(m, c);
        const reasons = buildTranscodeReasonCodes(m, compat, c);
        const reason = reasons.find((r) => r.code === 'resolution_exceeded_user_cap');
        expect(reason).toBeDefined();
        expect(reason?.params?.maxHeight).toBe(1080);
        expect(reasons.find((r) => r.code === 'resolution_exceeded')).toBeUndefined();
    });

    it('buildTranscodeReasonCodes emits resolution_exceeded (device) when source is device', () => {
        const m = media({ width: 3840, height: 2160 });
        const c = caps({ maxWidth: 1920, maxHeight: 1080 });
        const compat = checkCompatibility(m, c);
        const reasons = buildTranscodeReasonCodes(m, compat, c);
        const reason = reasons.find((r) => r.code === 'resolution_exceeded');
        expect(reason).toBeDefined();
        expect(reasons.find((r) => r.code === 'resolution_exceeded_user_cap')).toBeUndefined();
    });

    it('bitrate exceeded: 80 Mbps on 40 Mbps device', () => {
        const result = checkCompatibility(
            media({ bitrate: 80_000_000 }),
            caps({ maxBitrate: 40_000_000 }),
        );
        expect(result.bitrateExceeded).toBe(true);
        expect(result.bitrateExceededSource).toBe('device');
        expect(result.recommended).toBe('full_transcode');
    });

    it('bitrate within limit', () => {
        const result = checkCompatibility(
            media({ bitrate: 20_000_000 }),
            caps({ maxBitrate: 40_000_000 }),
        );
        expect(result.bitrateExceeded).toBe(false);
        expect(result.bitrateExceededSource).toBeNull();
        expect(result.recommended).toBe('direct');
    });

    it('bitrate exceeded by user-selected cap only: device allows it', () => {
        const result = checkCompatibility(
            media({ bitrate: 30_000_000 }),
            caps({ maxBitrate: 40_000_000, userSelectedMaxBitrate: 20_000_000 }),
        );
        expect(result.bitrateExceeded).toBe(true);
        expect(result.bitrateExceededSource).toBe('user');
        expect(result.recommended).toBe('full_transcode');
    });

    it('bitrate exceeded by both: user cap is tighter → source is user', () => {
        const result = checkCompatibility(
            media({ bitrate: 60_000_000 }),
            caps({ maxBitrate: 40_000_000, userSelectedMaxBitrate: 20_000_000 }),
        );
        expect(result.bitrateExceeded).toBe(true);
        expect(result.bitrateExceededSource).toBe('user');
    });

    it('bitrate exceeded by both: device cap is tighter → source is device', () => {
        const result = checkCompatibility(
            media({ bitrate: 60_000_000 }),
            caps({ maxBitrate: 20_000_000, userSelectedMaxBitrate: 40_000_000 }),
        );
        expect(result.bitrateExceeded).toBe(true);
        expect(result.bitrateExceededSource).toBe('device');
    });

    it('user cap alone (no device cap): exceeded → source is user', () => {
        const result = checkCompatibility(
            media({ bitrate: 30_000_000 }),
            caps({ userSelectedMaxBitrate: 10_000_000 }),
        );
        expect(result.bitrateExceeded).toBe(true);
        expect(result.bitrateExceededSource).toBe('user');
    });

    it('user cap alone: within limit → direct play', () => {
        const result = checkCompatibility(
            media({ bitrate: 5_000_000 }),
            caps({ userSelectedMaxBitrate: 10_000_000 }),
        );
        expect(result.bitrateExceeded).toBe(false);
        expect(result.bitrateExceededSource).toBeNull();
        expect(result.recommended).toBe('direct');
    });

    it('bitrate exactly equal to user cap is NOT exceeded (strict >)', () => {
        const result = checkCompatibility(
            media({ bitrate: 10_000_000 }),
            caps({ userSelectedMaxBitrate: 10_000_000 }),
        );
        expect(result.bitrateExceeded).toBe(false);
        expect(result.bitrateExceededSource).toBeNull();
    });

    it('bitrate undefined: exceeds nothing regardless of caps', () => {
        const result = checkCompatibility(
            media({ bitrate: undefined }),
            caps({ maxBitrate: 1_000_000, userSelectedMaxBitrate: 500_000 }),
        );
        expect(result.bitrateExceeded).toBe(false);
        expect(result.bitrateExceededSource).toBeNull();
    });

    it('buildTranscodeReasonCodes emits bitrate_exceeded_user_cap when source is user', () => {
        const m = media({ bitrate: 30_000_000 });
        const c = caps({
            maxBitrate: 40_000_000,
            userSelectedMaxBitrate: 20_000_000,
        });
        const compat = checkCompatibility(m, c);
        const reasons = buildTranscodeReasonCodes(m, compat, c);
        const bitrateReason = reasons.find((r) => r.code === 'bitrate_exceeded_user_cap');
        expect(bitrateReason).toBeDefined();
        expect(bitrateReason?.params?.maxMbps).toBe('20.0');
        expect(reasons.find((r) => r.code === 'bitrate_exceeded')).toBeUndefined();
    });

    it('buildTranscodeReasonCodes emits bitrate_exceeded (device) when source is device', () => {
        const m = media({ bitrate: 80_000_000 });
        const c = caps({ maxBitrate: 40_000_000 });
        const compat = checkCompatibility(m, c);
        const reasons = buildTranscodeReasonCodes(m, compat, c);
        const bitrateReason = reasons.find((r) => r.code === 'bitrate_exceeded');
        expect(bitrateReason).toBeDefined();
        expect(bitrateReason?.params?.maxMbps).toBe('40.0');
        expect(reasons.find((r) => r.code === 'bitrate_exceeded_user_cap')).toBeUndefined();
    });

    it('audio channels exceeded: 7.1 on 5.1 device', () => {
        const result = checkCompatibility(
            media({ audioChannels: 8 }),
            caps({ maxAudioChannels: 6 }),
        );
        expect(result.audioChannelsExceeded).toBe(true);
        expect(result.recommended).toBe('audio_transcode');
    });

    it('audio channels within limit', () => {
        const result = checkCompatibility(
            media({ audioChannels: 6 }),
            caps({ maxAudioChannels: 6 }),
        );
        expect(result.audioChannelsExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('multiple constraints: level + bitrate both exceeded → full_transcode', () => {
        const result = checkCompatibility(
            media({ videoLevel: 60, bitrate: 100_000_000 }),
            caps({ maxVideoLevel: 51, maxBitrate: 40_000_000 }),
        );
        expect(result.videoLevelExceeded).toBe(true);
        expect(result.bitrateExceeded).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    // ── Per-codec constraint resolution ──────────────────────

    it('uses per-codec level: HEVC Level 120 passes with HEVC limit 153 despite H.264 limit 52', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', videoLevel: 120 }),
            caps({
                codecConstraints: {
                    h264: { maxLevel: 52 },
                    hevc: { maxLevel: 153 },
                },
            }),
        );
        expect(result.videoLevelExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('uses per-codec level: H.264 Level 52 fails with H.264 limit 51 despite HEVC limit 153', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'h264', videoLevel: 52 }),
            caps({
                codecConstraints: {
                    h264: { maxLevel: 51 },
                    hevc: { maxLevel: 153 },
                },
            }),
        );
        expect(result.videoLevelExceeded).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('per-codec profile: HEVC Main 10 passes when HEVC allows it despite H.264 not listing it', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', videoProfile: 'Main 10' }),
            caps({
                codecConstraints: {
                    h264: { maxProfile: 'high|main|baseline' },
                    hevc: { maxProfile: 'main|main 10' },
                },
            }),
        );
        expect(result.videoProfileExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('uses _default codecConstraints when no codec-specific entry exists', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'av1', videoLevel: 60 }),
            caps({
                codecConstraints: {
                    _default: { maxLevel: 51 },
                },
            }),
        );
        expect(result.videoLevelExceeded).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('codec-specific entry takes precedence over _default', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'hevc', videoLevel: 120 }),
            caps({
                codecConstraints: {
                    _default: { maxLevel: 51 },
                    hevc: { maxLevel: 153 },
                },
            }),
        );
        expect(result.videoLevelExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('falls back to flat maxVideoLevel when no codecConstraints entry for codec', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'av1', videoLevel: 60 }),
            caps({
                maxVideoLevel: 51,
                codecConstraints: {
                    h264: { maxLevel: 52 },
                    hevc: { maxLevel: 153 },
                },
            }),
        );
        expect(result.videoLevelExceeded).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('codecConstraints takes precedence over flat maxVideoLevel for matching codec', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'h264', videoLevel: 52 }),
            caps({
                maxVideoLevel: 41, // flat field says 41
                codecConstraints: {
                    h264: { maxLevel: 52 }, // per-codec says 52
                },
            }),
        );
        // Per-codec wins — 52 <= 52 passes
        expect(result.videoLevelExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('excludedProfiles triggers full_transcode when media profile is excluded', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'h264', videoProfile: 'High 10' }),
            caps({
                codecConstraints: {
                    h264: { excludedProfiles: 'High 10|High 4:2:2' },
                },
            }),
        );
        expect(result.videoProfileExcluded).toBe(true);
        expect(result.recommended).toBe('full_transcode');
    });

    it('excludedProfiles does not trigger when media profile is not in exclusion list', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'h264', videoProfile: 'High' }),
            caps({
                codecConstraints: {
                    h264: { excludedProfiles: 'High 10|High 4:2:2' },
                },
            }),
        );
        expect(result.videoProfileExcluded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    it('excludedProfiles is case-insensitive', () => {
        const result = checkCompatibility(
            media({ videoCodec: 'h264', videoProfile: 'high 10' }),
            caps({
                codecConstraints: {
                    h264: { excludedProfiles: 'High 10' },
                },
            }),
        );
        expect(result.videoProfileExcluded).toBe(true);
    });

    it('excludedProfiles and maxProfile can coexist — both checked', () => {
        // Profile is allowed by EqualsAny but excluded by NotEquals → excluded wins
        const result = checkCompatibility(
            media({ videoCodec: 'h264', videoProfile: 'High 10' }),
            caps({
                codecConstraints: {
                    h264: {
                        maxProfile: 'High|High 10|Main',
                        excludedProfiles: 'High 10',
                    },
                },
            }),
        );
        expect(result.videoProfileExceeded).toBe(false); // in allowed list
        expect(result.videoProfileExcluded).toBe(true); // but also excluded
        expect(result.recommended).toBe('full_transcode'); // excluded wins
    });

    it('no constraints when optional fields absent on both sides', () => {
        const result = checkCompatibility(media(), caps());
        expect(result.videoLevelExceeded).toBe(false);
        expect(result.videoProfileExceeded).toBe(false);
        expect(result.videoProfileExcluded).toBe(false);
        expect(result.resolutionExceeded).toBe(false);
        expect(result.bitrateExceeded).toBe(false);
        expect(result.audioChannelsExceeded).toBe(false);
        expect(result.recommended).toBe('direct');
    });

    // ── Per-track audio compatibility ──────────────────────────

    it('all audio compatible: audioAllCompatible and audioAnyCompatible both true', () => {
        const result = checkCompatibility(media({ audioCodecs: ['aac', 'opus'] }), caps());
        expect(result.audioAllCompatible).toBe(true);
        expect(result.audioAnyCompatible).toBe(true);
        expect(result.audioAllCompatibleInHls).toBe(true);
        expect(result.audioAnyCompatibleInHls).toBe(true);
        expect(result.incompatibleAudioCodecs).toEqual([]);
        expect(result.recommended).toBe('direct');
    });

    it('all audio incompatible: dts+truehd → audio_transcode', () => {
        const result = checkCompatibility(media({ audioCodecs: ['dts', 'truehd'] }), caps());
        expect(result.audioAllCompatible).toBe(false);
        expect(result.audioAnyCompatible).toBe(false);
        expect(result.audioAllCompatibleInHls).toBe(false);
        expect(result.audioAnyCompatibleInHls).toBe(false);
        expect(result.incompatibleAudioCodecs).toEqual(['dts', 'truehd']);
        expect(result.recommended).toBe('audio_transcode');
    });

    it('empty audio codecs: both all/any are true (vacuous truth)', () => {
        const result = checkCompatibility(media({ audioCodecs: [] }), caps());
        expect(result.audioAllCompatible).toBe(true);
        expect(result.audioAnyCompatible).toBe(true);
        expect(result.audioAllCompatibleInHls).toBe(true);
        expect(result.audioAnyCompatibleInHls).toBe(true);
        expect(result.incompatibleAudioCodecs).toEqual([]);
    });

    it('mixed audio with HLS fallback: aac+dts → remux (aac passes through HLS)', () => {
        const result = checkCompatibility(
            media({ audioCodecs: ['aac', 'dts'], audioTrackCount: 2 }),
            caps(),
        );
        expect(result.audioAllCompatible).toBe(false);
        expect(result.audioAnyCompatible).toBe(true);
        expect(result.audioAnyCompatibleInHls).toBe(true);
        expect(result.incompatibleAudioCodecs).toEqual(['dts']);
        expect(result.recommended).toBe('remux');
    });

    it('HLS-only audio fallback: ac3+dts where only ac3 is HLS-compatible → remux', () => {
        const result = checkCompatibility(
            media({ audioCodecs: ['ac3', 'dts'], audioTrackCount: 2 }),
            caps({
                audioCodecs: new Set(['aac']),
                hlsAudioCodecs: new Set(['aac', 'ac3']),
            }),
        );
        expect(result.audioAllCompatible).toBe(false);
        expect(result.audioAnyCompatible).toBe(false);
        expect(result.audioAnyCompatibleInHls).toBe(true);
        expect(result.incompatibleAudioCodecs).toEqual(['ac3', 'dts']);
        expect(result.recommended).toBe('remux');
    });

    it('incompatibleAudioCodecs deduplicates repeated codecs', () => {
        const result = checkCompatibility(media({ audioCodecs: ['aac', 'dts', 'dts'] }), caps());
        expect(result.incompatibleAudioCodecs).toEqual(['dts']);
    });
});

// ──────────────────────────────────────────────────────────
// selectTranscodeCodec
// ──────────────────────────────────────────────────────────

describe('selectTranscodeCodec', () => {
    // Server with GPU encoding for all codecs
    const serverAllGpu: ServerEncodeCaps = {
        canEncodeCodec: (codec) => ['av1', 'hevc', 'h264'].includes(codec),
        canEfficientlyEncodeCodec: (codec) => ['av1', 'hevc', 'h264'].includes(codec),
    };

    // Server with GPU for hevc/h264 only, CPU-only for av1
    const serverAv1CpuOnly: ServerEncodeCaps = {
        canEncodeCodec: (codec) => ['av1', 'hevc', 'h264'].includes(codec),
        canEfficientlyEncodeCodec: (codec) => ['hevc', 'h264'].includes(codec),
    };

    // Server with software-only encoders for all codecs (no GPU)
    const serverSwAll: ServerEncodeCaps = {
        canEncodeCodec: (codec) => ['av1', 'hevc', 'h264'].includes(codec),
        canEfficientlyEncodeCodec: () => false,
    };

    const nativeHls: SelectTranscodeCodecContext = {
        deliveryPath: 'native_hls',
    };
    const mseHls: SelectTranscodeCodecContext = { deliveryPath: 'mse_hls' };

    it('prefers av1 when server has GPU encoding for it (native HLS)', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverAllGpu,
            nativeHls,
        );
        expect(codec).toBe('av1');
    });

    it('prefers hevc over av1 on GPU when av1 is CPU-only', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverAv1CpuOnly,
            nativeHls,
        );
        expect(codec).toBe('hevc');
    });

    it('falls back to hevc when client lacks av1', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['hevc', 'h264']) }),
            serverAllGpu,
            nativeHls,
        );
        expect(codec).toBe('hevc');
    });

    it('falls back to h264 when client only supports h264', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['h264']) }),
            serverAllGpu,
            nativeHls,
        );
        expect(codec).toBe('h264');
    });

    it('server caps limit selection: server can only encode h264', () => {
        const serverH264Only: ServerEncodeCaps = {
            canEncodeCodec: (c) => c === 'h264',
            canEfficientlyEncodeCodec: (c) => c === 'h264',
        };
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverH264Only,
            nativeHls,
        );
        expect(codec).toBe('h264');
    });

    it('returns null when no intersection exists', () => {
        const serverNone: ServerEncodeCaps = {
            canEncodeCodec: () => false,
            canEfficientlyEncodeCodec: () => false,
        };
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverNone,
            nativeHls,
        );
        expect(codec).toBeNull();
    });

    it('falls back to CPU-only codec when no GPU codec matches client caps', () => {
        const serverCpuAv1Only: ServerEncodeCaps = {
            canEncodeCodec: (c) => c === 'av1',
            canEfficientlyEncodeCodec: () => false,
        };
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1']) }),
            serverCpuAv1Only,
            nativeHls,
        );
        expect(codec).toBe('av1');
    });

    // ──────────────────────────────────────
    // Delivery-path gating
    // ──────────────────────────────────────

    it('gates av1 on mse_hls by default: picks hevc even when client supports av1', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverAllGpu,
            mseHls,
        );
        expect(codec).toBe('hevc');
    });

    it('allows av1 on mse_hls when allowAv1OnMseHls=true', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverAllGpu,
            { deliveryPath: 'mse_hls', allowAv1OnMseHls: true },
        );
        expect(codec).toBe('av1');
    });

    it('gates av1 on mse_hls software path: would pick libsvtav1 but forces h264', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1']) }),
            {
                canEncodeCodec: (c) => c === 'av1',
                canEfficientlyEncodeCodec: () => false,
            },
            mseHls,
        );
        // Client only supports AV1; server can only encode AV1 (software);
        // AV1 is gated on mse_hls → no eligible codec
        expect(codec).toBeNull();
    });

    it('allows av1 on direct_file', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverAllGpu,
            { deliveryPath: 'direct_file' },
        );
        expect(codec).toBe('av1');
    });

    // ──────────────────────────────────────
    // Codec-family kill switches
    // ──────────────────────────────────────

    it('honors allowHevcEncoding=false in hardware pass', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['hevc', 'h264']) }),
            serverAllGpu,
            { deliveryPath: 'native_hls', allowHevcEncoding: false },
        );
        expect(codec).toBe('h264');
    });

    it('honors allowAv1Encoding=false in hardware pass (native_hls)', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverAllGpu,
            { deliveryPath: 'native_hls', allowAv1Encoding: false },
        );
        expect(codec).toBe('hevc');
    });

    it('honors allowHevcEncoding=false in software pass', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['hevc', 'h264']) }),
            serverSwAll,
            { deliveryPath: 'mse_hls', allowHevcEncoding: false },
        );
        expect(codec).toBe('h264');
    });

    // ──────────────────────────────────────
    // Software fallback priority
    // ──────────────────────────────────────

    it('software fallback prefers h264 over hevc over av1 by default', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverSwAll,
            nativeHls,
        );
        expect(codec).toBe('h264');
    });

    it('software fallback honors custom preference order', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverSwAll,
            {
                deliveryPath: 'native_hls',
                softwareCodecPreference: ['hevc', 'h264', 'av1'],
            },
        );
        expect(codec).toBe('hevc');
    });

    it('software fallback with mse_hls skips av1 even if listed first', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverSwAll,
            {
                deliveryPath: 'mse_hls',
                softwareCodecPreference: ['av1', 'h264', 'hevc'],
            },
        );
        expect(codec).toBe('h264');
    });

    // ──────────────────────────────────────
    // Software 4K clamp
    // ──────────────────────────────────────

    it('4K source on software path is forced to h264 (cap 1920)', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverSwAll,
            {
                deliveryPath: 'native_hls',
                sourceWidth: 3840,
                softwareMaxWidth: 1920,
                softwareCodecPreference: ['hevc', 'av1', 'h264'],
            },
        );
        expect(codec).toBe('h264');
    });

    it('software 4K clamp does not apply to the hardware pass', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverAllGpu,
            {
                deliveryPath: 'native_hls',
                sourceWidth: 3840,
                softwareMaxWidth: 1920,
            },
        );
        expect(codec).toBe('av1');
    });

    it('1080p source on software path respects custom priority', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverSwAll,
            {
                deliveryPath: 'native_hls',
                sourceWidth: 1920,
                softwareMaxWidth: 1920,
                softwareCodecPreference: ['hevc', 'h264', 'av1'],
            },
        );
        expect(codec).toBe('hevc');
    });

    it('unknown sourceWidth with softwareMaxWidth>0 defensively clamps to h264', () => {
        // Failed probe / missing width must not silently pick libx265/libsvtav1.
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverSwAll,
            {
                deliveryPath: 'native_hls',
                // sourceWidth omitted (defaults to 0)
                softwareMaxWidth: 1920,
                softwareCodecPreference: ['hevc', 'av1', 'h264'],
            },
        );
        expect(codec).toBe('h264');
    });

    it('unknown sourceWidth with softwareMaxWidth=0 does not clamp', () => {
        // Operator opted out of clamp; unknown width should behave as "no clamp".
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['hevc', 'h264']) }),
            serverSwAll,
            {
                deliveryPath: 'native_hls',
                softwareMaxWidth: 0,
                softwareCodecPreference: ['hevc', 'h264'],
            },
        );
        expect(codec).toBe('hevc');
    });

    it('unknown sourceWidth does not affect the hardware pass', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverAllGpu,
            {
                deliveryPath: 'native_hls',
                softwareMaxWidth: 1920,
                // sourceWidth omitted
            },
        );
        expect(codec).toBe('av1');
    });

    it('softwareMaxWidth=0 disables the 4K clamp', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['hevc', 'h264']) }),
            serverSwAll,
            {
                deliveryPath: 'native_hls',
                sourceWidth: 3840,
                softwareMaxWidth: 0,
                softwareCodecPreference: ['hevc', 'h264'],
            },
        );
        expect(codec).toBe('hevc');
    });

    // ──────────────────────────────────────
    // Composite scenarios mirroring real deployments
    // ──────────────────────────────────────

    it('preprod (no GPU, Chrome 4K): picks h264', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverSwAll,
            {
                deliveryPath: 'mse_hls',
                sourceWidth: 3840,
                allowAv1OnMseHls: false,
                softwareMaxWidth: 1920,
                softwareCodecPreference: ['h264', 'hevc', 'av1'],
            },
        );
        expect(codec).toBe('h264');
    });

    it('prod (nvenc, Chrome 1080p): picks hevc (av1 gated on mse_hls)', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverAllGpu,
            {
                deliveryPath: 'mse_hls',
                sourceWidth: 1920,
                allowAv1OnMseHls: false,
            },
        );
        expect(codec).toBe('hevc');
    });

    it('prod (nvenc, Safari 4K): picks av1', () => {
        const codec = selectTranscodeCodec(
            caps({ videoCodecs: new Set(['av1', 'hevc', 'h264']) }),
            serverAllGpu,
            {
                deliveryPath: 'native_hls',
                sourceWidth: 3840,
            },
        );
        expect(codec).toBe('av1');
    });
});

describe('parseSoftwareCodecPreference', () => {
    it('parses comma-separated codec list', () => {
        expect(parseSoftwareCodecPreference('h264,hevc,av1')).toEqual(['h264', 'hevc', 'av1']);
    });

    it('trims whitespace and lowercases', () => {
        expect(parseSoftwareCodecPreference(' H264 , HEVC ')).toEqual(['h264', 'hevc']);
    });

    it('drops unknown tokens', () => {
        expect(parseSoftwareCodecPreference('h264,vp9,hevc,mpeg4,av1')).toEqual([
            'h264',
            'hevc',
            'av1',
        ]);
    });

    it('returns default when input is empty', () => {
        expect(parseSoftwareCodecPreference('')).toEqual(['h264', 'hevc', 'av1']);
    });

    it('returns default when input is nullish', () => {
        expect(parseSoftwareCodecPreference(undefined)).toEqual(['h264', 'hevc', 'av1']);
        expect(parseSoftwareCodecPreference(null)).toEqual(['h264', 'hevc', 'av1']);
    });

    it('returns default when input has no valid tokens', () => {
        expect(parseSoftwareCodecPreference('vp8,vp9,theora')).toEqual(['h264', 'hevc', 'av1']);
    });
});

// ──────────────────────────────────────────────────────────
// buildTranscodeReasons
// ──────────────────────────────────────────────────────────

describe('buildTranscodeReasons', () => {
    it('returns empty array for direct play', () => {
        const compat = checkCompatibility(media(), caps());
        const reasons = buildTranscodeReasons(media(), compat);
        expect(reasons).toHaveLength(0);
    });

    it('returns video incompatibility reason', () => {
        const m = media({ videoCodec: 'hevc' });
        const compat = checkCompatibility(m, caps({ videoCodecs: new Set(['h264']) }));
        const reasons = buildTranscodeReasons(m, compat);
        expect(reasons.some((r) => /video/i.test(r) || /hevc/i.test(r))).toBe(true);
    });

    it('returns audio incompatibility reason', () => {
        const m = media({ audioCodecs: ['dts'] });
        const compat = checkCompatibility(m, caps());
        const reasons = buildTranscodeReasons(m, compat);
        expect(reasons.some((r) => /audio/i.test(r) || /dts/i.test(r))).toBe(true);
    });

    it('returns container incompatibility reason', () => {
        const m = media({ container: 'matroska' });
        const compat = checkCompatibility(m, caps());
        const reasons = buildTranscodeReasons(m, compat);
        expect(
            reasons.some((r) => /container/i.test(r) || /matroska/i.test(r) || /mkv/i.test(r)),
        ).toBe(true);
    });

    it('returns multi-audio reason', () => {
        const m = media({ audioTrackCount: 2 });
        const compat = checkCompatibility(m, caps({ canSwitchAudioInDirectPlay: false }));
        const reasons = buildTranscodeReasons(m, compat);
        expect(reasons.some((r) => /audio/i.test(r))).toBe(true);
    });

    it('returns Dolby Vision tonemapping reason', () => {
        const m = media({ videoCodec: 'hevc', hdr: 'dovi' });
        const compat = checkCompatibility(m, caps({ hdrFormats: new Set(['hdr10']) }));
        const reasons = buildTranscodeReasons(m, compat);
        expect(reasons.some((r) => /dolby vision/i.test(r) || /tone.?map/i.test(r))).toBe(true);
    });

    it('returns 10-bit H.264 specific reason', () => {
        const m = media({ videoCodec: 'h264', videoBitDepth: 10 });
        const compat = checkCompatibility(m, caps());
        const reasons = buildTranscodeReasons(m, compat);
        expect(reasons.some((r) => /10-bit.*H\.264|Hi10P/i.test(r))).toBe(true);
    });

    it('produces one reason per concern, not duplicates', () => {
        const m = media({
            videoCodec: 'hevc',
            audioCodecs: ['dts'],
            container: 'matroska',
            hdr: 'dovi',
            audioTrackCount: 2,
        });
        const compat = checkCompatibility(
            m,
            caps({
                videoCodecs: new Set(['h264']),
                hdrFormats: new Set(['hdr10']),
                canSwitchAudioInDirectPlay: false,
            }),
        );
        const reasons = buildTranscodeReasons(m, compat);
        // Should have distinct reasons for each concern
        expect(reasons.length).toBeGreaterThan(0);
        const uniqueReasons = new Set(reasons);
        expect(uniqueReasons.size).toBe(reasons.length);
    });

    it('returns video level exceeded reason', () => {
        const c = caps({ maxVideoLevel: 51 });
        const m = media({ videoLevel: 52 });
        const compat = checkCompatibility(m, c);
        const reasons = buildTranscodeReasons(m, compat, c);
        expect(reasons.some((r) => /level.*52/i.test(r))).toBe(true);
    });

    it('returns video profile exceeded reason', () => {
        const c = caps({ maxVideoProfile: 'High' });
        const m = media({ videoProfile: 'High 10' });
        const compat = checkCompatibility(m, c);
        const reasons = buildTranscodeReasons(m, compat, c);
        expect(reasons.some((r) => /profile.*High 10/i.test(r))).toBe(true);
    });

    it('returns resolution exceeded reason', () => {
        const c = caps({ maxWidth: 1920, maxHeight: 1080 });
        const m = media({ width: 3840, height: 2160 });
        const compat = checkCompatibility(m, c);
        const reasons = buildTranscodeReasons(m, compat, c);
        expect(reasons.some((r) => /resolution.*3840.*2160.*1920.*1080/i.test(r))).toBe(true);
    });

    it('returns bitrate exceeded reason', () => {
        const c = caps({ maxBitrate: 40_000_000 });
        const m = media({ bitrate: 80_000_000 });
        const compat = checkCompatibility(m, c);
        const reasons = buildTranscodeReasons(m, compat, c);
        expect(reasons.some((r) => /bitrate.*80\.0.*Mbps.*40\.0/i.test(r))).toBe(true);
    });

    it('returns audio channels exceeded reason', () => {
        const c = caps({ maxAudioChannels: 6 });
        const m = media({ audioChannels: 8 });
        const compat = checkCompatibility(m, c);
        const reasons = buildTranscodeReasons(m, compat, c);
        expect(reasons.some((r) => /8 channels/i.test(r))).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────
// buildTranscodeReasonCodes
// ──────────────────────────────────────────────────────────

describe('buildTranscodeReasonCodes', () => {
    it('returns empty array for direct play', () => {
        const compat = checkCompatibility(media(), caps());
        expect(buildTranscodeReasonCodes(media(), compat)).toHaveLength(0);
    });

    it('emits audio_codec_incompatible with joined codecs param', () => {
        const m = media({ audioCodecs: ['truehd', 'eac3'] });
        const compat = checkCompatibility(m, caps({ audioCodecs: new Set(['aac', 'eac3']) }));
        const codes = buildTranscodeReasonCodes(m, compat);
        const audio = codes.find((r) => r.code === 'audio_codec_incompatible');
        expect(audio).toBeDefined();
        expect(audio?.params?.codecs).toBe('TRUEHD');
    });

    it('emits video_10bit_h264 without params for Hi10P', () => {
        const m = media({ videoCodec: 'h264', videoBitDepth: 10 });
        const compat = checkCompatibility(m, caps());
        const codes = buildTranscodeReasonCodes(m, compat);
        expect(codes.some((r) => r.code === 'video_10bit_h264')).toBe(true);
        expect(codes.some((r) => r.code === 'video_codec_incompatible')).toBe(false);
    });

    it('emits container_incompatible with container param', () => {
        const m = media({ container: 'matroska' });
        const compat = checkCompatibility(m, caps());
        const codes = buildTranscodeReasonCodes(m, compat);
        const container = codes.find((r) => r.code === 'container_incompatible');
        expect(container?.params?.container).toBe('MATROSKA');
    });

    it('emits hdr_tonemap_dolby_vision for DoVi on non-DoVi device', () => {
        const m = media({ videoCodec: 'hevc', hdr: 'dovi' });
        const compat = checkCompatibility(m, caps({ hdrFormats: new Set(['hdr10']) }));
        const codes = buildTranscodeReasonCodes(m, compat);
        expect(codes.some((r) => r.code === 'hdr_tonemap_dolby_vision')).toBe(true);
    });

    it('emits resolution_exceeded with 4 params when device max is known', () => {
        const c = caps({ maxWidth: 1920, maxHeight: 1080 });
        const m = media({ width: 3840, height: 2160 });
        const compat = checkCompatibility(m, c);
        const codes = buildTranscodeReasonCodes(m, compat, c);
        const res = codes.find((r) => r.code === 'resolution_exceeded');
        expect(res?.params).toMatchObject({
            width: 3840,
            height: 2160,
            maxWidth: 1920,
            maxHeight: 1080,
        });
    });

    it('codes and strings are emitted in the same order', () => {
        const m = media({
            videoCodec: 'hevc',
            audioCodecs: ['dts'],
            container: 'matroska',
            hdr: 'dovi',
            audioTrackCount: 2,
        });
        const c = caps({
            videoCodecs: new Set(['h264']),
            hdrFormats: new Set(['hdr10']),
            canSwitchAudioInDirectPlay: false,
        });
        const compat = checkCompatibility(m, c);
        const strings = buildTranscodeReasons(m, compat, c);
        const codes = buildTranscodeReasonCodes(m, compat, c);
        expect(strings.length).toBe(codes.length);
    });
});

// ──────────────────────────────────────────────────────────
// mediaInfoFromStreamRows
// ──────────────────────────────────────────────────────────

describe('mediaInfoFromStreamRows', () => {
    it('converts video + audio stream rows to MediaInfo', () => {
        const rows = [
            {
                stream_type: 'video',
                codec: 'hevc',
                width: 3840,
                height: 2160,
                level: 150,
                profile: 'Main 10',
                bit_depth: 10,
                video_range_type: 'HDR10',
            },
            { stream_type: 'audio', codec: 'eac3', channels: 6 },
            { stream_type: 'audio', codec: 'aac', channels: 2 },
        ];
        const info = mediaInfoFromStreamRows(rows, 'mkv', 45_000_000);
        expect(info.videoCodec).toBe('hevc');
        expect(info.videoBitDepth).toBe(10);
        expect(info.videoProfile).toBe('Main 10');
        expect(info.videoLevel).toBe(150);
        expect(info.width).toBe(3840);
        expect(info.height).toBe(2160);
        expect(info.bitrate).toBe(45_000_000);
        expect(info.audioCodecs).toEqual(['eac3', 'aac']);
        expect(info.audioTrackCount).toBe(2);
        expect(info.audioChannels).toBe(6);
        expect(info.container).toBe('mkv');
        expect(info.hdr).toBe('hdr10');
    });

    it('handles Dolby Vision video_range_type', () => {
        const rows = [
            {
                stream_type: 'video',
                codec: 'hevc',
                video_range_type: 'DoLbYvIsIoN',
            },
            { stream_type: 'audio', codec: 'aac', channels: 2 },
        ];
        const info = mediaInfoFromStreamRows(rows, 'mp4');
        expect(info.hdr).toBe('dovi');
    });

    it('handles HLG video_range_type', () => {
        const rows = [{ stream_type: 'video', codec: 'hevc', video_range_type: 'HLG' }];
        const info = mediaInfoFromStreamRows(rows, 'mp4');
        expect(info.hdr).toBe('hlg');
    });

    it('defaults to SDR when no video_range_type', () => {
        const rows = [
            { stream_type: 'video', codec: 'h264' },
            { stream_type: 'audio', codec: 'aac', channels: 2 },
        ];
        const info = mediaInfoFromStreamRows(rows, 'mp4');
        expect(info.hdr).toBe('sdr');
    });

    it('handles audio-only content (no video stream)', () => {
        const rows = [{ stream_type: 'audio', codec: 'flac', channels: 2 }];
        const info = mediaInfoFromStreamRows(rows, 'flac');
        expect(info.videoCodec).toBe('');
        expect(info.audioCodecs).toEqual(['flac']);
    });

    it('filters null audio codecs', () => {
        const rows = [
            { stream_type: 'video', codec: 'h264' },
            { stream_type: 'audio', codec: null, channels: 2 },
            { stream_type: 'audio', codec: 'aac', channels: 2 },
        ];
        const info = mediaInfoFromStreamRows(rows, 'mp4');
        expect(info.audioCodecs).toEqual(['aac']);
        expect(info.audioTrackCount).toBe(2);
    });
});

// ──────────────────────────────────────────────────────────
// deviceCapsFromProfile
// ──────────────────────────────────────────────────────────

describe('deviceCapsFromProfile', () => {
    it('extracts codecs and containers from DirectPlayProfiles', () => {
        const profile = {
            DirectPlayProfiles: [
                {
                    Container: 'mp4,m4v',
                    VideoCodec: 'h264,hevc',
                    AudioCodec: 'aac,ac3',
                },
                { Container: 'mkv', VideoCodec: 'vp9', AudioCodec: 'opus' },
            ],
        };
        const caps = deviceCapsFromProfile(profile);
        expect(caps.videoCodecs).toEqual(new Set(['h264', 'hevc', 'vp9']));
        expect(caps.audioCodecs).toEqual(new Set(['aac', 'ac3', 'opus']));
        expect(caps.containers).toEqual(new Set(['mp4', 'm4v', 'mkv']));
    });

    it('extracts codec constraints from CodecProfiles', () => {
        const profile = {
            DirectPlayProfiles: [{ Container: 'mp4', VideoCodec: 'h264' }],
            CodecProfiles: [
                {
                    Type: 'Video',
                    Codec: 'h264',
                    Conditions: [
                        {
                            Property: 'VideoLevel',
                            Condition: 'LessThanEqual',
                            Value: '51',
                        },
                        {
                            Property: 'VideoProfile',
                            Condition: 'EqualsAny',
                            Value: 'high|main|baseline',
                        },
                    ],
                },
            ],
        };
        const caps = deviceCapsFromProfile(profile);
        expect(caps.codecConstraints?.['h264']?.maxLevel).toBe(51);
        expect(caps.codecConstraints?.['h264']?.maxProfile).toBe('high|main|baseline');
    });

    it('extracts excluded profiles from NotEquals conditions', () => {
        const profile = {
            DirectPlayProfiles: [{ Container: 'mp4', VideoCodec: 'hevc' }],
            CodecProfiles: [
                {
                    Type: 'Video',
                    Codec: 'hevc',
                    Conditions: [
                        {
                            Property: 'VideoProfile',
                            Condition: 'NotEquals',
                            Value: 'Main 444',
                        },
                    ],
                },
            ],
        };
        const caps = deviceCapsFromProfile(profile);
        expect(caps.codecConstraints?.['hevc']?.excludedProfiles).toBe('main 444');
    });

    it('joins multiple NotEquals conditions with pipe separator', () => {
        const profile = {
            DirectPlayProfiles: [{ Container: 'mp4', VideoCodec: 'hevc' }],
            CodecProfiles: [
                {
                    Type: 'Video',
                    Codec: 'hevc',
                    Conditions: [
                        {
                            Property: 'VideoProfile',
                            Condition: 'NotEquals',
                            Value: 'Main 444',
                        },
                        {
                            Property: 'VideoProfile',
                            Condition: 'NotEquals',
                            Value: 'Main 444 10',
                        },
                    ],
                },
            ],
        };
        const caps = deviceCapsFromProfile(profile);
        expect(caps.codecConstraints?.['hevc']?.excludedProfiles).toBe('main 444|main 444 10');
    });

    it('sets maxBitrate from MaxStreamingBitrate', () => {
        const profile = {
            DirectPlayProfiles: [],
            MaxStreamingBitrate: 120_000_000,
        };
        const caps = deviceCapsFromProfile(profile);
        expect(caps.maxBitrate).toBe(120_000_000);
    });

    it('handles empty profile gracefully', () => {
        const caps = deviceCapsFromProfile({});
        expect(caps.videoCodecs.size).toBe(0);
        expect(caps.audioCodecs.size).toBe(0);
        expect(caps.containers.size).toBe(0);
        expect(caps.canSwitchAudioInDirectPlay).toBe(true);
    });

    // ── Comma-list Codec + per-codec constraint registration ────

    it('registers a comma-list Codec constraint under BOTH codec keys', () => {
        const profile = {
            DirectPlayProfiles: [{ Container: 'mp4', VideoCodec: 'h264,hevc' }],
            CodecProfiles: [
                {
                    Type: 'Video',
                    Codec: 'h264,hevc',
                    Conditions: [
                        {
                            Property: 'VideoLevel',
                            Condition: 'LessThanEqual',
                            Value: '120',
                        },
                    ],
                },
            ],
        };
        const caps = deviceCapsFromProfile(profile);
        expect(caps.codecConstraints).toHaveProperty('h264');
        expect(caps.codecConstraints).toHaveProperty('hevc');
        expect(caps.codecConstraints?.h264?.maxLevel).toBe(120);
        expect(caps.codecConstraints?.hevc?.maxLevel).toBe(120);
    });

    it('normalizes h265 DirectPlayProfiles VideoCodec alias to hevc', () => {
        const profile = {
            DirectPlayProfiles: [{ Container: 'mp4', VideoCodec: 'h265' }],
        };
        const caps = deviceCapsFromProfile(profile);
        expect(caps.videoCodecs.has('hevc')).toBe(true);
        expect(caps.videoCodecs.has('h265')).toBe(false);
    });
});

// ──────────────────────────────────────────────────────────
// normalizeVideoCodecToken
// ──────────────────────────────────────────────────────────

describe('normalizeVideoCodecToken', () => {
    it('normalizes h265 to hevc', () => {
        expect(normalizeVideoCodecToken('h265')).toBe('hevc');
    });

    it('normalizes H265 (uppercase) to hevc', () => {
        expect(normalizeVideoCodecToken('H265')).toBe('hevc');
    });

    it('normalizes h.265 to hevc', () => {
        expect(normalizeVideoCodecToken('h.265')).toBe('hevc');
    });

    it('leaves hevc unchanged', () => {
        expect(normalizeVideoCodecToken('hevc')).toBe('hevc');
    });

    it('leaves h264 unchanged', () => {
        expect(normalizeVideoCodecToken('h264')).toBe('h264');
    });
});
