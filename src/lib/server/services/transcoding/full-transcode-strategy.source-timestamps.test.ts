// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `sourceTimestamps` (native-HLS clients) must reach the FFmpeg arguments: a
 * seeked copy-video generation writes source-absolute tfdt
 * (`movflags=+frag_discont`). Without it AVPlayer drew every WebVTT cue late by
 * the generation's start — no subtitles after a resume or a long seek in the
 * Apple apps (prod 2026-10-15). Web (hls.js) jobs keep their argument list.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/media-format-whitelist.js', () => ({
    getMediaFormatWhitelist: () => 'WL-MEDIA',
    getConcatListFormatWhitelist: () => 'WL-CONCAT-LIST',
}));

import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import { FullTranscodeStrategy } from './full-transcode-strategy.js';
import type { FullStrategyConfig } from './transcode-strategy.js';

function config(overrides: Partial<FullStrategyConfig> = {}): FullStrategyConfig {
    return {
        outputDir: '/tmp/out',
        segmentDuration: 6,
        localFilePath: '/media/movie.mkv',
        audioTracks: [
            {
                index: asAbsoluteStreamIndex(1),
                displayTitle: 'English',
                language: 'eng',
                channels: 6,
                codec: 'eac3',
                isDefault: true,
            },
        ],
        videoInfo: { codec: 'hevc', width: 1920, height: 1080 },
        hlsOutput: { hlsAudioMode: 'muxed' },
        decision: {
            mode: 'full',
            reasons: 0,
            videoAction: 'copy',
            audioAction: 'copy',
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

const segmentOptions = (args: string[]): string[] =>
    args.flatMap((t, i) => (t === '-hls_segment_options' ? [args[i + 1]] : []));

describe('FullTranscodeStrategy — source timestamps for native HLS', () => {
    it('writes absolute tfdt on a seeked copy generation for a native-HLS client', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(
            config({ startTimeSeconds: 600, sourceTimestamps: true }),
        );
        expect(segmentOptions(args)).toEqual(['movflags=+frag_discont']);
    });

    it('leaves a web (hls.js) seeked copy generation as it was', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(config({ startTimeSeconds: 600 }));
        expect(segmentOptions(args)).toEqual([]);
    });

    it('changes nothing for a native-HLS generation from 0', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(config({ sourceTimestamps: true }));
        expect(segmentOptions(args)).toEqual([]);
    });

    it('leaves a seeked video transcode to its own startNumber rule', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(
            config({
                startTimeSeconds: 600,
                sourceTimestamps: true,
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            }),
        );
        expect(segmentOptions(args)).toEqual([]);
    });
});
