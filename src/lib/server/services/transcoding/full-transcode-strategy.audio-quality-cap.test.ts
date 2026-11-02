// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Focused coverage for the per-request quality cap's audio handling in
 * FullTranscodeStrategy.configureAudioEncoding — the bitrate cap and the
 * downmix-below-threshold rule from `qualityCapAudioReservationBps` (see
 * quality-cap.ts's computeAudioReservationBps /
 * AUDIO_DOWNMIX_RESERVATION_THRESHOLD_BPS).
 *
 * Uses a REMUX (videoAction: 'copy') decision with `forceAudioTranscode: true`
 * so the video side stays trivial (no GPU/hwaccel code paths) while audio
 * still takes the "must transcode" branch — the same combination the
 * existing audioCodec=aac override already exercises in production.
 */

import { describe, it, expect } from 'vitest';
import { FullTranscodeStrategy } from './full-transcode-strategy.js';
import type { FullStrategyConfig } from './transcode-strategy.js';
import type { AudioTrackInfo } from '../../utils/hls-audio-injection.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import { AUDIO_DOWNMIX_RESERVATION_THRESHOLD_BPS } from './quality-cap.js';

function surroundTrack(overrides: Partial<AudioTrackInfo> = {}): AudioTrackInfo {
    return {
        index: asAbsoluteStreamIndex(1),
        displayTitle: 'English',
        language: 'eng',
        channels: 6,
        codec: 'ac3',
        bitrate: 640_000,
        isDefault: true,
        ...overrides,
    };
}

function baseConfig(overrides: Partial<FullStrategyConfig> = {}): FullStrategyConfig {
    return {
        outputDir: '/tmp/out',
        segmentDuration: 6,
        localFilePath: '/media/movie.mkv',
        audioTracks: [surroundTrack()],
        videoInfo: { codec: 'h264', width: 1920, height: 1080 },
        forceAudioTranscode: true,
        decision: {
            mode: 'full',
            reasons: 0,
            videoAction: 'copy',
            audioAction: 'transcode',
            useGpu: false,
            needsTonemapping: false,
        },
        gpuAcceleration: 'none',
        encodingPreset: 'medium',
        nvencPreset: 'p4',
        h264Crf: 23,
        h265Crf: 28,
        videoBitrateMbps: 0,
        maxWidth: 0,
        maxHeight: 0,
        tonemappingAlgorithm: 'hable',
        deinterlaceMethod: 'none',
        audioCodec: 'aac',
        audioBitrateStereo: '128k',
        audioBitrateSurround: '256k',
        audioVbr: false,
        audioBoost: 1.0,
        ...overrides,
    } as FullStrategyConfig;
}

function audioArgs(args: string[]): { codec?: string; bitrate?: string; channels?: string } {
    const codecIdx = args.indexOf('-c:a:0');
    const bitrateIdx = args.indexOf('-b:a:0');
    const channelsIdx = args.indexOf('-ac:a:0');
    return {
        codec: codecIdx >= 0 ? args[codecIdx + 1] : undefined,
        bitrate: bitrateIdx >= 0 ? args[bitrateIdx + 1] : undefined,
        channels: channelsIdx >= 0 ? args[channelsIdx + 1] : undefined,
    };
}

describe('FullTranscodeStrategy — quality-cap audio reservation', () => {
    it('with no quality cap, transcodes at the normal adaptive surround bitrate/channels', () => {
        const strategy = new FullTranscodeStrategy();
        const { args } = strategy.buildArgs(baseConfig());

        const { channels, bitrate } = audioArgs(args);
        expect(channels).toBe('6');
        // 640k source * 0.7 = 448k, clamped to max 512 for surround.
        expect(bitrate).toBe('448k');
    });

    it('downmixes to stereo when the reservation is below the downmix threshold', () => {
        expect(AUDIO_DOWNMIX_RESERVATION_THRESHOLD_BPS).toBe(192_000);
        const strategy = new FullTranscodeStrategy();
        const { args } = strategy.buildArgs(baseConfig({ qualityCapAudioReservationBps: 128_000 }));

        const { channels, bitrate } = audioArgs(args);
        expect(channels).toBe('2');
        // Capped at the 128k reservation.
        expect(bitrate).toBe('128k');
    });

    it('keeps surround channels when the reservation is AT/above the downmix threshold', () => {
        const strategy = new FullTranscodeStrategy();
        const { args } = strategy.buildArgs(baseConfig({ qualityCapAudioReservationBps: 256_000 }));

        const { channels, bitrate } = audioArgs(args);
        expect(channels).toBe('6');
        expect(bitrate).toBe('256k');
    });

    it('caps the bitrate to the reservation even when the adaptive calc would be lower already', () => {
        const strategy = new FullTranscodeStrategy();
        const { args } = strategy.buildArgs(
            baseConfig({
                audioTracks: [surroundTrack({ bitrate: 96_000, channels: 2 })],
                qualityCapAudioReservationBps: 128_000,
            }),
        );

        const { bitrate } = audioArgs(args);
        // Adaptive calc for a 96k stereo source clamps to the 96k minimum —
        // already under the 128k reservation, so it must be left alone.
        expect(bitrate).toBe('96k');
    });
});

describe('FullTranscodeStrategy — client channel cap (maxAudioChannels)', () => {
    it('downmixes a 5.1 track to the client cap', () => {
        const strategy = new FullTranscodeStrategy();
        const { args } = strategy.buildArgs(baseConfig({ maxAudioChannels: 2 }));

        // Comparison: the no-cap run above emits 6 for the same track.
        expect(audioArgs(args).channels).toBe('2');
    });

    it('never upmixes: a cap above the source leaves the source channel count', () => {
        const strategy = new FullTranscodeStrategy();
        const { args } = strategy.buildArgs(
            baseConfig({
                audioTracks: [surroundTrack({ channels: 2, bitrate: 192_000 })],
                maxAudioChannels: 6,
            }),
        );

        expect(audioArgs(args).channels).toBe('2');
    });

    it('keeps the strategy 5.1 ceiling when the client allows 7.1', () => {
        const strategy = new FullTranscodeStrategy();
        const { args } = strategy.buildArgs(
            baseConfig({
                audioTracks: [surroundTrack({ channels: 8 })],
                maxAudioChannels: 8,
            }),
        );

        expect(audioArgs(args).channels).toBe('6');
    });
});
