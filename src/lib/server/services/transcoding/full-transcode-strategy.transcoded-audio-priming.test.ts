// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A transcoded audio track next to copied video keeps source timestamps, and
 * the encoder's priming samples put its first packet before time 0. On prod
 * (TNG S3E16, 2026-11-02) that first fMP4 part carried tfdt 2^64 − 1024 and the
 * GOP assembler built the rendition out of order; AVPlayer froze on it. The
 * strategy now trims the priming's worth of samples from every encoded track
 * when the video is copied — per stream next to copied tracks, in the shared
 * chain when every track is encoded.
 */

import { describe, expect, it } from 'vitest';

import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';

import type { AudioTrackInfo } from '../../utils/hls-audio-injection.js';
import { encoderPrimingSamples, FullTranscodeStrategy } from './full-transcode-strategy.js';
import type { FullStrategyConfig } from './transcode-strategy.js';

function track(
    index: number,
    codec: string,
    overrides: Partial<AudioTrackInfo> = {},
): AudioTrackInfo {
    return {
        index: asAbsoluteStreamIndex(index),
        displayTitle: codec === 'ac3' && index === 1 ? 'German' : 'English',
        language: index === 1 ? 'ger' : 'eng',
        channels: codec === 'dts' ? 6 : 2,
        codec,
        bitrate: 448_000,
        isDefault: index === 1,
        ...overrides,
    };
}

/** TNG S3E16: German AC3, English AC3, English DTS 5.1, English AC3. */
const TNG = [track(1, 'ac3'), track(2, 'ac3'), track(3, 'dts'), track(4, 'ac3')];

function config(overrides: Partial<FullStrategyConfig> = {}): FullStrategyConfig {
    return {
        outputDir: '/tmp/out',
        segmentDuration: 6,
        localFilePath: '/media/tng.mkv',
        audioTracks: TNG,
        videoInfo: { codec: 'h264', width: 960, height: 720 },
        forceAudioTranscode: false,
        hlsOutput: { hlsAudioMode: 'demux' },
        decision: {
            mode: 'full',
            reasons: 0,
            videoAction: 'copy',
            audioAction: 'copy',
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
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

function valueAfter(args: string[], flag: string): string | undefined {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
}

describe('encoderPrimingSamples', () => {
    it('knows the common encoders and leaves the rest alone', () => {
        expect(encoderPrimingSamples('aac')).toBe(1024);
        expect(encoderPrimingSamples('AAC')).toBe(1024);
        expect(encoderPrimingSamples('eac3')).toBe(256);
        expect(encoderPrimingSamples('libopus')).toBe(312);
        expect(encoderPrimingSamples('flac')).toBe(0);
    });
});

describe('FullTranscodeStrategy: transcoded audio next to copied video', () => {
    it('trims only the encoded track, by its own stream index, when other tracks are copied', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(config());
        expect(valueAfter(args, '-c:a:0')).toBe('copy');
        expect(valueAfter(args, '-c:a:2')).toBe('aac');
        expect(valueAfter(args, '-filter:a:2')).toBe('atrim=start_sample=1024');
        expect(args).not.toContain('-filter:a:0');
        expect(args).not.toContain('-filter:a:1');
        expect(args).not.toContain('-filter:a:3');
        // A global -af would make ffmpeg refuse the copied tracks.
        expect(args).not.toContain('-af');
    });

    it('keeps the trim on the audio output of the GOP-mode split', () => {
        const { args, gopSplit } = new FullTranscodeStrategy().buildArgs(
            config({ gopSegments: { videoStartKeyframe: 0 } }),
        );
        expect(gopSplit).toBe(true);
        // The GOP split emits the audio output first, then `-map 0:v:0 …` for the video output.
        const videoStart = args.findIndex((a, i) => a === '-map' && /^0:v/.test(args[i + 1] ?? ''));
        expect(videoStart).toBeGreaterThan(0);
        const audioOutput = args.slice(0, videoStart);
        const videoOutput = args.slice(videoStart);
        expect(valueAfter(audioOutput, '-filter:a:2')).toBe('atrim=start_sample=1024');
        expect(videoOutput).not.toContain('-filter:a:2');
        expect(videoOutput).not.toContain('-af');
    });

    it('does not trim a generation that starts mid-file (its first packet is already positive)', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(
            config({ startTimeSeconds: 120, gopSegments: { videoStartKeyframe: 12 } }),
        );
        expect(args.join(' ')).not.toContain('atrim=');
        expect(valueAfter(args, '-c:a:2')).toBe('aac');
    });

    it('routes the audio boost to the encoded stream alone next to copied tracks', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(config({ audioBoost: 1.5 }));
        expect(args).not.toContain('-af');
        expect(valueAfter(args, '-filter:a:2')).toBe('volume=1.5,atrim=start_sample=1024');
    });

    it('adds the trim to the shared chain when every track is encoded', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(
            config({
                audioTracks: [track(1, 'dts'), track(2, 'dts')],
                forceAudioTranscode: true,
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'transcode',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            }),
        );
        expect(valueAfter(args, '-af')).toBe('aresample=async=1,atrim=start_sample=1024');
        expect(args.some((a) => a.startsWith('-filter:a:'))).toBe(false);
    });

    it('does not trim when the video is transcoded (first_pts=0 anchors audio there)', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(
            config({
                forceAudioTranscode: true,
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'transcode',
                    audioAction: 'transcode',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            }),
        );
        expect(args.join(' ')).not.toContain('atrim=');
    });

    it('does not trim a copied-only layout', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(
            config({ audioTracks: [track(1, 'ac3'), track(2, 'ac3')] }),
        );
        expect(args.join(' ')).not.toContain('atrim=');
        expect(args).not.toContain('-af');
    });
});
