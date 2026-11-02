// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `GET|HEAD /Audio/{itemId}/universal` — the PURE half: parse the query and
 * decide how to deliver the file. The route
 * (`routes/(proprietary)/j/Audio/[itemId]/universal/+server.ts`) acts on it.
 *
 * Jellyfin (UniversalAudioController) builds a throw-away DeviceProfile from the
 * query — one DirectPlayProfile per `container` entry (`container|codec|codec`),
 * one audio TranscodingProfile (`transcodingContainer ?? mp3`, `audioCodec ?? mp3`,
 * `transcodingProtocol ?? http`), optional sample-rate / bit-depth / channel
 * conditions — runs the normal playback decision and then serves:
 *
 * 1. the file itself (200/206, byte ranges) when it is direct-playable;
 * 2. else, for `transcodingProtocol=hls`, an HLS master playlist — audio copied
 *    when only the container was unsupported;
 * 3. else a progressive transcode into `transcodingContainer`.
 *
 * Lumastra decides the same way. Where it differs (the route documents the
 * delivery side): the progressive transcode is the music transcode service,
 * which encodes mp3, AAC (ADTS or in MP4/m4a) and Opus (in Ogg) — a
 * `transcodingContainer` it cannot produce (ts, webm, flac, wav, …) gets the
 * requested codec's natural container instead, mp3 when the codec is none of
 * those. Players sniff progressive audio, so the substitution plays; it is
 * still not byte-for-byte what was asked for.
 */

import type { MusicCodec } from '$lib/server/services/music-transcode/types';

export interface DirectPlayEntry {
    /** Container family (see {@link containerFamily}). */
    family: string;
    /** Accepted codecs, lowercase; empty = any codec in this container. */
    codecs: string[];
}

export interface UniversalAudioRequest {
    directPlay: DirectPlayEntry[];
    /** Transcode target codec (`audioCodec`), lowercase, first of a list. */
    audioCodec: string | null;
    transcodingContainer: string | null;
    transcodingProtocol: 'http' | 'hls';
    /** bit/s */
    maxStreamingBitrate: number | null;
    /** bit/s */
    audioBitRate: number | null;
    maxAudioChannels: number | null;
    transcodingAudioChannels: number | null;
    maxAudioSampleRate: number | null;
    maxAudioBitDepth: number | null;
    startTimeTicks: number;
    mediaSourceId: string | null;
    playSessionId: string | null;
    deviceId: string | null;
}

export interface UniversalAudioSource {
    /** Container from the file extension (`flac`, `m4a`, `mp3`, …). */
    container: string;
    /** The audio stream's codec, as scanned (`flac`, `mp3`, `aac`, `pcm_s16le`). */
    codec: string | null;
    /** bit/s (file total), null when unknown. */
    bitrate: number | null;
    sampleRate: number | null;
    channels: number | null;
    bitDepth: number | null;
}

export type UniversalAudioDecision =
    | { kind: 'direct' }
    /** `audioCodec` is the HLS master's `AudioCodec`: `copy` or a target codec. */
    | { kind: 'hls'; audioCodec: string }
    | { kind: 'progressive'; codec: MusicCodec; bitrate: number | null };

/**
 * Spellings of one container (ffprobe reports mp4 for .m4a/.m4b and ogg for
 * .opus). Kept narrow on purpose: QuickTime (.mov) and 3GP are not what a
 * client means by `mp4`, and an entry for a codec-named container (`opus`)
 * is narrowed by its implied codec, not by widening the family.
 */
const FAMILIES: Record<string, string> = {
    mp4: 'mp4',
    m4a: 'mp4',
    m4b: 'mp4',
    aac: 'aac',
    adts: 'aac',
    ogg: 'ogg',
    oga: 'ogg',
    opus: 'ogg',
    mkv: 'mkv',
    mka: 'mkv',
    matroska: 'mkv',
    webm: 'webm',
    webma: 'webm',
    mp3: 'mp3',
    mpa: 'mp3',
    flac: 'flac',
    wav: 'wav',
    wma: 'asf',
    asf: 'asf',
};

/**
 * A `container` entry named after a codec, without a `|codec` list, means that
 * codec: `opus` is Ogg Opus, not any Ogg file (a Vorbis .ogg must not direct-play
 * for a client that only listed `opus`).
 */
const IMPLIED_CODEC: Record<string, string> = {
    opus: 'opus',
    aac: 'aac',
    adts: 'aac',
    mp3: 'mp3',
    flac: 'flac',
};

export function containerFamily(container: string): string {
    const c = container.trim().toLowerCase();
    return FAMILIES[c] ?? c;
}

/** A bare `container` entry (no `|codec` list): its family, narrowed by its implied codec. */
export function directPlayEntryFor(container: string): DirectPlayEntry {
    const c = container.trim().toLowerCase();
    const implied = IMPLIED_CODEC[c];
    return { family: containerFamily(c), codecs: implied ? [implied] : [] };
}

/**
 * What `stream.{container}` may answer with the file itself, beyond
 * {@link IMPLIED_CODEC}: the codecs a client asking for that container plays.
 * `stream.m4a` means AAC (what the transcode would produce) — an ALAC .m4a is
 * not it; `stream.ogg` / `stream.webm` mean Opus or Vorbis, never FLAC-in-Ogg.
 */
const STREAM_CONTAINER_CODECS: Record<string, string[]> = {
    m4a: ['aac'],
    mp4: ['aac'],
    m4b: ['aac'],
    ogg: ['opus', 'vorbis'],
    oga: ['opus', 'vorbis'],
    webm: ['opus', 'vorbis'],
    webma: ['opus', 'vorbis'],
};

/** Audio codecs an MPEG-TS HLS segment can carry, i.e. that `copy` keeps playable. */
const TS_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'mp2']);

function positiveInt(raw: string | undefined): number | null {
    if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Query keys are matched case-insensitively, first value wins. */
function queryMap(params: URLSearchParams): Map<string, string> {
    const q = new Map<string, string>();
    for (const [key, value] of params) {
        const k = key.toLowerCase();
        if (!q.has(k) && value.trim() !== '') q.set(k, value);
    }
    return q;
}

export function parseUniversalAudioRequest(params: URLSearchParams): UniversalAudioRequest {
    const q = queryMap(params);
    // `container` is a comma list; it may also be repeated (`container=a&container=b`).
    const containerValues = params
        .getAll('container')
        .concat(params.getAll('Container'))
        .flatMap((v) => v.split(','));
    const directPlay: DirectPlayEntry[] = [];
    for (const entry of containerValues) {
        const [container, ...codecs] = entry
            .split('|')
            .map((p) => p.trim().toLowerCase())
            .filter((p) => p.length > 0);
        if (!container) continue;
        directPlay.push(
            codecs.length > 0
                ? { family: containerFamily(container), codecs }
                : directPlayEntryFor(container),
        );
    }
    const protocol = q.get('transcodingprotocol')?.trim().toLowerCase();
    const ticks = positiveInt(q.get('starttimeticks'));
    return {
        directPlay,
        audioCodec: q.get('audiocodec')?.split(',')[0]?.trim().toLowerCase() || null,
        transcodingContainer: q.get('transcodingcontainer')?.trim().toLowerCase() || null,
        transcodingProtocol: protocol === 'hls' ? 'hls' : 'http',
        maxStreamingBitrate: positiveInt(q.get('maxstreamingbitrate')),
        audioBitRate: positiveInt(q.get('audiobitrate')),
        maxAudioChannels: positiveInt(q.get('maxaudiochannels')),
        transcodingAudioChannels: positiveInt(q.get('transcodingaudiochannels')),
        maxAudioSampleRate: positiveInt(q.get('maxaudiosamplerate')),
        maxAudioBitDepth: positiveInt(q.get('maxaudiobitdepth')),
        startTimeTicks: ticks ?? 0,
        mediaSourceId: q.get('mediasourceid')?.trim() || null,
        playSessionId: q.get('playsessionid')?.trim() || null,
        deviceId: q.get('deviceid')?.trim() || null,
    };
}

function codecMatches(accepted: string[], codec: string | null): boolean {
    if (accepted.length === 0) return true;
    if (!codec) return false;
    const c = codec.toLowerCase();
    return accepted.some((a) => a === c || (a === 'pcm' && c.startsWith('pcm_')));
}

/** The file (its container + scanned audio codec) satisfies one direct-play entry. */
function entryMatches(
    entry: DirectPlayEntry,
    fileContainer: string,
    codec: string | null,
): boolean {
    return entry.family === containerFamily(fileContainer) && codecMatches(entry.codecs, codec);
}

/**
 * `stream.{container}`'s direct-play test, on the same vocabulary as universal's
 * `container=` entries: the file's container family AND its audio codec must be
 * what the requested container means (`stream.opus` never hands out a Vorbis
 * .ogg, `stream.m4a` never ALAC). An unprobed file (codec null) only matches a
 * container that implies no codec.
 */
export function isCleanDirectMatch(
    container: string,
    fileContainer: string,
    codec: string | null,
): boolean {
    const c = container.trim().toLowerCase();
    const streamCodecs = STREAM_CONTAINER_CODECS[c];
    const entry = streamCodecs
        ? { family: containerFamily(c), codecs: streamCodecs }
        : directPlayEntryFor(c);
    const ext = fileContainer.replace(/^\./, '').toLowerCase();
    return ext !== '' && entryMatches(entry, ext, codec);
}

/** A known value over a set limit fails; an unknown value passes (Jellyfin: IsRequired=false). */
function within(value: number | null, limit: number | null): boolean {
    return limit === null || value === null || value <= limit;
}

const CONTAINER_TO_CODEC: Record<string, MusicCodec> = {
    mp3: 'mp3',
    aac: 'aac',
    adts: 'aac',
    m4a: 'm4a',
    mp4: 'm4a',
    m4b: 'm4a',
    ogg: 'opus',
    oga: 'opus',
    opus: 'opus',
};

const CODEC_TO_CODEC: Record<string, MusicCodec> = {
    mp3: 'mp3',
    aac: 'aac',
    opus: 'opus',
};

/** The music transcode codec that produces `container` (mp3, aac, m4a/mp4, ogg/opus), else null. */
export function musicCodecForContainer(container: string): MusicCodec | null {
    return CONTAINER_TO_CODEC[container.trim().toLowerCase()] ?? null;
}

/** The music transcode target for a progressive answer (see the module comment). */
export function progressiveTarget(req: UniversalAudioRequest): MusicCodec {
    if (req.transcodingContainer && CONTAINER_TO_CODEC[req.transcodingContainer]) {
        return CONTAINER_TO_CODEC[req.transcodingContainer];
    }
    return (req.audioCodec && CODEC_TO_CODEC[req.audioCodec]) || 'mp3';
}

export function decideUniversalAudio(
    req: UniversalAudioRequest,
    source: UniversalAudioSource,
): UniversalAudioDecision {
    const limitsOk =
        within(source.bitrate, req.maxStreamingBitrate) &&
        within(source.sampleRate, req.maxAudioSampleRate) &&
        within(source.bitDepth, req.maxAudioBitDepth) &&
        within(source.channels, req.maxAudioChannels);
    const containerOk = req.directPlay.some((e) => entryMatches(e, source.container, source.codec));
    if (containerOk && limitsOk) return { kind: 'direct' };

    if (req.transcodingProtocol === 'hls') {
        // Jellyfin copies the audio when the container was the only problem.
        // An MPEG-TS segment cannot carry every codec (FLAC, Opus, ALAC…): those
        // are encoded even then, or the playlist would not play.
        const codecOk = req.directPlay.some((e) => codecMatches(e.codecs, source.codec));
        const copy =
            limitsOk &&
            codecOk &&
            source.codec !== null &&
            TS_AUDIO.has(source.codec.toLowerCase());
        return { kind: 'hls', audioCodec: copy ? 'copy' : (req.audioCodec ?? 'aac') };
    }

    return {
        kind: 'progressive',
        codec: progressiveTarget(req),
        bitrate: req.audioBitRate ?? req.maxStreamingBitrate,
    };
}
