// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MusicCodec } from './types.js';
import { clampBitrate, defaultBitrateFor } from './bitrate-clamp.js';

export interface MediaProfile {
    container: string;
    codec: string;
}

export interface ClientInfo {
    name: string;
    platform: string;
    directPlayProfiles: MediaProfile[];
    transcodingProfiles: MediaProfile[];
    maxAudioBitrate?: number;
    maxTranscodingAudioBitrate?: number;
}

export interface SourceMetadata {
    container: string;
    codec: string;
    bitrate: number;
    sampleRate: number;
    channels: number;
    bitDepth: number;
}

export interface DecisionResult {
    canDirectPlay: boolean;
    canTranscode: boolean;
    transcodeReason: string[];
    chosenTarget: {
        codec: MusicCodec;
        container: string;
        bitrate: number;
    } | null;
}

// Aliases are codec names only. We deliberately do NOT match by container —
// a client that lists `{container:'ogg', codec:'vorbis'}` only decodes
// Vorbis-in-Ogg; matching opus by container would send Opus-in-Ogg to a
// client that can't decode it. Containers ('mp4', 'm4a', 'adts', 'ogg') are
// expressed via the `container` field, not as codec aliases.
const SUPPORTED_TARGETS: {
    codec: MusicCodec;
    container: string;
    aliases: string[];
}[] = [
    { codec: 'opus', container: 'ogg', aliases: ['opus'] },
    { codec: 'mp3', container: 'mp3', aliases: ['mp3', 'mpeg'] },
    { codec: 'aac', container: 'adts', aliases: ['aac'] },
];

function matchesSource(source: SourceMetadata, profile: MediaProfile): boolean {
    return (
        source.container.toLowerCase() === profile.container.toLowerCase() &&
        source.codec.toLowerCase() === profile.codec.toLowerCase()
    );
}

export function decide(client: ClientInfo, source: SourceMetadata): DecisionResult {
    // If ffprobe couldn't determine the codec, we have no basis to decide a
    // target — emitting a transcodeParams token would spawn ffmpeg against a
    // file with no audio stream and tear down the response mid-flight. Tell
    // the caller we can neither direct-play nor transcode and let it serve a
    // proper error.
    if (source.codec === 'unknown' || source.codec === '') {
        return {
            canDirectPlay: false,
            canTranscode: false,
            transcodeReason: ['source_unprobed'],
            chosenTarget: null,
        };
    }

    // Convert source bitrate (bps, from ffprobe) to kbps to match OpenSubsonic spec units
    const sourceBitrateKbps = Math.round(source.bitrate / 1000);

    // Step 1: direct-play check
    const directPlayMatch = client.directPlayProfiles.some((p) => matchesSource(source, p));
    if (directPlayMatch) {
        // If maxAudioBitrate also caps direct-play and source exceeds it, fall through to transcode
        const cap = client.maxAudioBitrate;
        if (!cap || sourceBitrateKbps <= cap) {
            return {
                canDirectPlay: true,
                canTranscode: false,
                transcodeReason: [],
                chosenTarget: null,
            };
        }
    }

    // Step 2: choose a transcoding target
    const reasons: string[] = [];
    if (!directPlayMatch) reasons.push('container_mismatch');
    if (client.maxAudioBitrate && sourceBitrateKbps > client.maxAudioBitrate)
        reasons.push('bitrate_too_high');

    // Iterate SUPPORTED_TARGETS in preference order (opus first), pick first that the client lists.
    // Match by codec only — container alone is not a safe signal (e.g. ogg can carry
    // vorbis, opus, flac, or speex; a profile that lists ogg+vorbis cannot decode opus-in-ogg).
    for (const target of SUPPORTED_TARGETS) {
        const supported = client.transcodingProfiles.some((p) =>
            target.aliases.includes(p.codec.toLowerCase()),
        );
        if (!supported) continue;
        const requestedBitrate =
            client.maxTranscodingAudioBitrate ??
            client.maxAudioBitrate ??
            defaultBitrateFor(target.codec);
        const bitrate = clampBitrate(target.codec, requestedBitrate);
        return {
            canDirectPlay: false,
            canTranscode: true,
            transcodeReason: reasons.length > 0 ? reasons : ['policy'],
            chosenTarget: {
                codec: target.codec,
                container: target.container,
                bitrate,
            },
        };
    }

    return {
        canDirectPlay: false,
        canTranscode: false,
        transcodeReason: ['no_supported_transcode_target'],
        chosenTarget: null,
    };
}
