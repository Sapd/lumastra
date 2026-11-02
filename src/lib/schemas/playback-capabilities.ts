// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Typed client capabilities. Own module: playback.ts and playback-start.ts both
// use it, and playback-start imports schemas that import playback.ts.
import { z } from 'zod';

/**
 * What the server assumes when a start omits `capabilities`: H.264 + AAC/MP3 in
 * MP4 or HLS-TS, WebVTT subtitles, SDR. Every HLS player handles this, so a
 * client that declares nothing still plays (the server transcodes or remuxes
 * whatever does not fit). Audiobooks fall back to MP3 and MP4/M4B audio.
 */
export const DEFAULT_PLAYBACK_CAPABILITIES = {
    containers: ['mp4', 'ts', 'mp3', 'm4a'],
    videoCodecs: ['h264'],
    audioCodecs: ['aac', 'mp3'],
    subtitleFormats: ['vtt'],
    hdr: [],
} as const satisfies {
    containers: readonly string[];
    videoCodecs: readonly string[];
    audioCodecs: readonly string[];
    subtitleFormats: readonly string[];
    hdr: readonly string[];
};

// Open vocabularies on purpose: an unknown token is ignored rather than refused,
// so a client may declare a codec this server version does not know yet.
const tokens = (known: string) =>
    z
        .array(z.string().min(1).max(128))
        .max(64)
        .optional()
        .describe(
            `Lower-case tokens. Known values: ${known}. Unknown values are ignored; omitted uses the default.`,
        );

export const PlaybackCapabilitiesSchema = z
    .object({
        containers: tokens(
            '`mp4`, `m4a`, `m4b`, `mov`, `mkv`, `webm`, `ts`, `mp3`, `flac`, `ogg`, `opus`, `wav`, `aac`',
        ),
        videoCodecs: tokens('`h264`, `hevc` (alias `h265`), `av1`, `vp9`, `vp8`, `mpeg2video`'),
        audioCodecs: tokens(
            '`aac`, `mp3`, `ac3`, `eac3`, `truehd`, `dts`, `flac`, `opus`, `vorbis`, `alac`, `pcm`',
        ),
        subtitleFormats: tokens(
            '`vtt` (alias `webvtt`), `srt`, `ass`, `ssa`, `pgs`, `vobsub`. A selected unsupported embedded track may require burn-in; declaring formats does not select a track',
        ),
        maxVideoBitrateBps: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Maximum video bitrate, bits per second.'),
        maxHeight: z.number().int().positive().optional().describe('Maximum video height, pixels.'),
        hdr: tokens(
            '`hdr10`, `hdr10plus`, `hlg`, `dovi` (alias `dolby_vision`). Empty: SDR only, HDR is tone-mapped',
        ),
        maxAudioChannels: z.number().int().positive().optional(),
        hlsCopyReload: z
            .boolean()
            .optional()
            .describe(
                'The client can reload a copy-mode HLS stream in place on an audio switch; enables muxed copy HLS for native clients. Defaults to false.',
            ),
        multipartVideo: z
            .boolean()
            .optional()
            .describe(
                'Deprecated; accepted for compatibility with shipped clients, ignored and has no effect.',
            ),
    })
    .strict()
    .describe(
        'What the player can decode. Optional, and so is every field: an omitted field takes its default ' +
            '(containers mp4/ts/mp3/m4a, videoCodecs h264, audioCodecs aac/mp3, subtitleFormats vtt, hdr none). ' +
            'Video uses these defaults; audiobook MIME negotiation uses containers. Music honors audio codecs/containers as well as explicit audio format/bitrate options.',
    )
    .meta({
        example: {
            containers: ['mp4', 'ts', 'mkv'],
            videoCodecs: ['h264', 'hevc'],
            audioCodecs: ['aac', 'ac3', 'eac3'],
            subtitleFormats: ['vtt', 'pgs'],
            hdr: ['hdr10', 'dovi'],
            maxAudioChannels: 6,
        },
    });

export type PlaybackCapabilities = z.infer<typeof PlaybackCapabilitiesSchema>;

/** Capabilities with every list filled in (declared value or the documented default). */
export type ResolvedPlaybackCapabilities = PlaybackCapabilities & {
    containers: string[];
    videoCodecs: string[];
    audioCodecs: string[];
    subtitleFormats: string[];
    hdr: string[];
};

/** The declared capabilities, each omitted list replaced by the documented default. */
export function resolvePlaybackCapabilities(
    capabilities: PlaybackCapabilities | undefined,
): ResolvedPlaybackCapabilities {
    const d = DEFAULT_PLAYBACK_CAPABILITIES;
    return {
        ...capabilities,
        containers: capabilities?.containers ?? [...d.containers],
        videoCodecs: capabilities?.videoCodecs ?? [...d.videoCodecs],
        audioCodecs: capabilities?.audioCodecs ?? [...d.audioCodecs],
        subtitleFormats: capabilities?.subtitleFormats ?? [...d.subtitleFormats],
        hdr: capabilities?.hdr ?? [],
    };
}
