// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '$lib/server/config.js';
import {
    resolvePlaybackCapabilities,
    type PlaybackCapabilities,
} from '$lib/schemas/playback-capabilities.js';
import type { PlayMethod } from '$lib/schemas/play-sessions.js';
import type { TranscodeReason } from '$lib/schemas/playback-plan.js';
import { clampBitrate, defaultBitrateFor } from './bitrate-clamp.js';
import { containerFor } from './ffmpeg-args.js';
import { parseMusicCodec, type MusicCodec } from './types.js';
import type { SourceMetadata } from './decision.js';

export interface AudioNegotiationOptions {
    format?: string;
    bitrateKbps?: number;
    maxBitrateKbps?: number;
    startPositionSeconds?: number;
    capabilities?: PlaybackCapabilities;
    requestedMethod?: PlayMethod;
    transcodeEnabled: boolean;
}
export interface AudioNegotiation {
    codec: string;
    container: string;
    bitrateKbps: number;
    playMethod: 'direct' | 'audio_transcode';
    reasonCodes: TranscodeReason[];
    target?: MusicCodec;
}
const normalizeContainer = (value: string): string => {
    const token = value.toLowerCase();
    if (['m4a', 'm4b', 'mov', 'mp4'].includes(token) || token.startsWith('mov,')) return 'mp4';
    if (token === 'adts') return 'aac';
    if (token === 'opus') return 'ogg';
    return token;
};

/** One decision for starts and byte delivery. Explicit bitrate forces; maximum only caps. */
export function negotiateAudio(
    source: SourceMetadata,
    options: AudioNegotiationOptions,
): AudioNegotiation {
    if (
        options.startPositionSeconds !== undefined &&
        (!Number.isFinite(options.startPositionSeconds) || options.startPositionSeconds < 0)
    )
        throw new Error('Invalid startPositionSeconds');
    for (const value of [options.bitrateKbps, options.maxBitrateKbps]) {
        if (value !== undefined && (!Number.isInteger(value) || value <= 0))
            throw new Error('Bitrate must be a positive integer in kilobits per second');
    }
    const caps = options.capabilities
        ? resolvePlaybackCapabilities(options.capabilities)
        : undefined;
    const explicit =
        options.format === undefined || options.format === 'raw'
            ? undefined
            : parseMusicCodec(options.format);
    if (explicit === null) throw new Error('Unsupported audio format');
    const actualCodec = (target: MusicCodec): string => (target === 'm4a' ? 'aac' : target);
    // Naming an output format declares support for it wherever the client left
    // capabilities implicit. Explicit lists remain authoritative, including [].
    if (caps && explicit) {
        if (options.capabilities?.audioCodecs === undefined)
            caps.audioCodecs = [...caps.audioCodecs, actualCodec(explicit)];
        if (options.capabilities?.containers === undefined)
            caps.containers = [...caps.containers, containerFor(explicit)];
    }
    const supports = (codec: string, container: string): boolean =>
        !caps ||
        (caps.audioCodecs.map((v) => v.toLowerCase()).includes(codec) &&
            caps.containers.some((v) => normalizeContainer(v) === normalizeContainer(container)));
    if (
        caps?.maxAudioChannels !== undefined &&
        source.channels > caps.maxAudioChannels &&
        caps.maxAudioChannels < 2
    )
        throw new Error('Requested audio channel limit cannot be encoded');
    const sourceKbps = Math.max(0, Math.round(source.bitrate / 1000));
    const direct: AudioNegotiation = {
        codec: source.codec,
        container: normalizeContainer(source.container),
        bitrateKbps: sourceKbps,
        playMethod: 'direct',
        reasonCodes: [],
    };
    if (options.format === 'raw') {
        if ((options.startPositionSeconds ?? 0) > 0)
            throw new Error('Raw delivery cannot apply a stream seek');
        if (options.requestedMethod && options.requestedMethod !== 'direct')
            throw new Error('Raw delivery conflicts with requestedMethod');
        if (
            !supports(source.codec, source.container) ||
            (caps?.maxAudioChannels !== undefined && source.channels > caps.maxAudioChannels) ||
            options.bitrateKbps !== undefined ||
            (options.maxBitrateKbps !== undefined && sourceKbps > options.maxBitrateKbps)
        )
            throw new Error('Raw delivery cannot satisfy the requested capabilities or bitrate');
        return direct;
    }
    if (explicit && !supports(actualCodec(explicit), containerFor(explicit)))
        throw new Error('Requested audio format is incompatible with capabilities');
    if (
        options.requestedMethod &&
        !['direct', 'audio_transcode', 'full_transcode'].includes(options.requestedMethod)
    )
        throw new Error('Unsupported music requestedMethod');
    const reasonCodes: TranscodeReason[] = [];
    if (caps?.maxAudioChannels !== undefined && source.channels > caps.maxAudioChannels)
        reasonCodes.push({
            code: 'audio_channels_exceeded',
            params: { channels: source.channels, max: caps.maxAudioChannels },
        });
    if (caps && !caps.audioCodecs.some((codec) => codec.toLowerCase() === source.codec))
        reasonCodes.push({ code: 'audio_codec_incompatible', params: { codecs: source.codec } });
    if (
        caps &&
        !caps.containers.some(
            (container) => normalizeContainer(container) === normalizeContainer(source.container),
        )
    )
        reasonCodes.push({ code: 'audio_container_incompatible' });
    if (
        explicit &&
        (actualCodec(explicit) !== source.codec ||
            normalizeContainer(containerFor(explicit)) !== normalizeContainer(source.container))
    )
        reasonCodes.push({ code: 'audio_format_requested' });
    if (options.bitrateKbps !== undefined) reasonCodes.push({ code: 'audio_bitrate_requested' });
    if (options.maxBitrateKbps !== undefined && sourceKbps > options.maxBitrateKbps)
        reasonCodes.push({ code: 'audio_bitrate_exceeded' });
    if (
        (options.startPositionSeconds ?? 0) > 0 ||
        (options.requestedMethod && options.requestedMethod !== 'direct')
    )
        reasonCodes.push({ code: 'client_requested' });
    if (reasonCodes.length === 0) return direct;
    if (!options.transcodeEnabled) throw new Error('Audio transcoding is unavailable');
    if (caps?.maxAudioChannels !== undefined && caps.maxAudioChannels < 2)
        throw new Error('Requested audio channel limit cannot be encoded');
    const configured = !caps ? parseMusicCodec(config.MUSIC_TRANSCODE_DEFAULT_CODEC) : undefined;
    const target =
        explicit ??
        configured ??
        (['opus', 'm4a', 'mp3', 'aac'] as const).find((candidate) =>
            supports(actualCodec(candidate), containerFor(candidate)),
        );
    if (!target) throw new Error('No supported audio conversion target');
    const requested = options.bitrateKbps ?? options.maxBitrateKbps ?? defaultBitrateFor(target);
    const bitrateKbps = clampBitrate(
        target,
        Math.min(requested, options.maxBitrateKbps ?? Infinity),
    );
    if (options.maxBitrateKbps !== undefined && bitrateKbps > options.maxBitrateKbps)
        throw new Error('Maximum bitrate is below the encoder minimum');
    return {
        target,
        codec: actualCodec(target),
        container: containerFor(target),
        bitrateKbps,
        playMethod: 'audio_transcode',
        reasonCodes,
    };
}
