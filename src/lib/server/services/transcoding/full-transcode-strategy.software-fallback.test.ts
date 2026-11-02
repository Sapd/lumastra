// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A job that fell back from NVENC to software after its master was served keeps
 * the GPU encoder's HEVC profile (Main, 8-bit for SDR). libx265 would otherwise
 * emit Main10 for a 10-bit source and the master's CODECS (hvc1.1.6) would no
 * longer describe the stream (AVPlayer: CoreMediaErrorDomain 'fmt?').
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
                channels: 2,
                codec: 'aac',
                isDefault: true,
            },
        ],
        videoInfo: { codec: 'hevc', width: 1920, height: 1080, outputCodec: 'hevc' },
        hlsOutput: { hlsAudioMode: 'demux' },
        decision: {
            mode: 'full',
            reasons: 0,
            videoAction: 'transcode',
            audioAction: 'copy',
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
            targetCodec: { video: 'libx265', audio: 'aac' },
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

const after = (args: string[], flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
};

describe('FullTranscodeStrategy — software fallback keeps the GPU encoder profile', () => {
    it('SDR HEVC fallback: Main profile, 8-bit pixels', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(
            config({ softwareEncodeFallback: 'hevc_nvenc' }),
        );
        expect(after(args, '-c:v')).toBe('libx265');
        expect(after(args, '-profile:v')).toBe('main');
        expect(after(args, '-pix_fmt')).toBe('yuv420p');
    });

    it('a plain software HEVC transcode (no fallback) is unchanged: Main10', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(config());
        expect(after(args, '-profile:v')).toBe('main10');
        expect(after(args, '-pix_fmt')).toBeUndefined();
    });
});
