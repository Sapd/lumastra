// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Progressive (non-HLS) transcode for `/j/Videos/{id}/stream?Static=false`.
 *
 * Jellyfin answers `/Videos/{id}/stream` with `Static=false` and an explicit
 * `container` / `videoCodec` / `audioCodec` by transcoding on the fly into ONE
 * progressive response. Clients that never call PlaybackInfo rely on it — Moonfin
 * builds its "download at 720p" URL exactly like that and pipes the response
 * through Android's Media3 Transformer, which only passes samples through. Handed
 * the untouched original (an MKV with E-AC-3), Transformer tries to decode the
 * audio, finds no E-AC-3 decoder on most phones and fails with
 * "Codec exception: CodecInfo{type=AudioDecoder …}".
 *
 * This module is the PURE half: parse the request, decide per track whether the
 * source already satisfies it (copy) or must be encoded, and build the ffmpeg
 * argument vector. Spawning lives in `progressive-transcode-runner.ts`.
 *
 * Scope is deliberately narrow: a request without `container`, or with
 * `Static=true`, never reaches here and keeps getting the original file — that is
 * what every client relying on today's behaviour (and DirectStreamUrl, which
 * carries `static=true`) gets. A source that already satisfies the request is
 * also served untouched, byte-range-capable, rather than piped through ffmpeg.
 */

export type ProgressiveContainer = 'mp4' | 'mkv' | 'ts';
export type EncodableVideoCodec = 'h264' | 'hevc';

export interface ProgressiveRequest {
    container: ProgressiveContainer;
    /** Accepted video codecs, normalised, in client preference order. Empty = any. */
    videoCodecs: string[];
    /** Accepted audio codecs, normalised, in client preference order. Empty = any. */
    audioCodecs: string[];
    videoBitrate: number | null;
    audioBitrate: number | null;
    maxWidth: number | null;
    maxHeight: number | null;
    audioChannels: number | null;
    /** Absolute stream index of the wanted audio track (Jellyfin AudioStreamIndex). */
    audioStreamIndex: number | null;
    startSeconds: number;
}

export interface SourceVideo {
    codec: string;
    width: number | null;
    height: number | null;
    /** Video bitrate in bit/s, or an estimate; null when unknown. */
    bitrate: number | null;
    isHdr: boolean;
}

export interface SourceAudio {
    /** Absolute ffmpeg stream index. */
    index: number;
    codec: string;
    channels: number | null;
    isDefault: boolean;
}

export interface ProgressiveSource {
    /** Container of the source file, from its extension (`mkv`, `mp4`, …). */
    container: string | null;
    video: SourceVideo | null;
    audio: SourceAudio[];
}

export type VideoPlan =
    | { mode: 'copy'; codec: string }
    | {
          mode: 'encode';
          codec: EncodableVideoCodec;
          bitrate: number;
          maxWidth: number | null;
          maxHeight: number | null;
          tonemap: boolean;
      };

export type AudioPlan =
    | { mode: 'copy'; index: number; codec: string }
    | {
          mode: 'encode';
          index: number;
          codec: string;
          encoder: string;
          channels: number;
          /** bit/s, or null for a lossless codec. */
          bitrate: number | null;
      };

export type ProgressivePlan =
    | { kind: 'original' }
    | {
          kind: 'transcode';
          container: ProgressiveContainer;
          video: VideoPlan | null;
          audio: AudioPlan | null;
          startSeconds: number;
      };

const CONTAINER_ALIASES: Record<string, ProgressiveContainer> = {
    mp4: 'mp4',
    m4v: 'mp4',
    mov: 'mp4',
    mkv: 'mkv',
    matroska: 'mkv',
    ts: 'ts',
    mpegts: 'ts',
    m2ts: 'ts',
};

const CODEC_ALIASES: Record<string, string> = {
    h265: 'hevc',
    hev1: 'hevc',
    hvc1: 'hevc',
    x265: 'hevc',
    avc: 'h264',
    avc1: 'h264',
    x264: 'h264',
    mpeg2: 'mpeg2video',
    dts: 'dca',
};

function normaliseCodec(codec: string): string {
    const c = codec.trim().toLowerCase();
    return CODEC_ALIASES[c] ?? c;
}

/** What each output muxer can carry, so a copy never produces an unmuxable stream. */
const MUXABLE_VIDEO: Record<ProgressiveContainer, ReadonlySet<string> | null> = {
    mp4: new Set(['h264', 'hevc', 'av1', 'mpeg4', 'vp9']),
    ts: new Set(['h264', 'hevc', 'mpeg2video']),
    mkv: null, // Matroska carries anything we would copy.
};
const MUXABLE_AUDIO: Record<ProgressiveContainer, ReadonlySet<string> | null> = {
    mp4: new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac', 'flac', 'opus']),
    ts: new Set(['aac', 'mp3', 'ac3', 'eac3', 'mp2']),
    mkv: null,
};

interface AudioEncoderSpec {
    encoder: string;
    maxChannels: number;
    /** Highest bitrate worth asking for, bit/s; null = lossless (no -b:a). */
    maxBitrate: number | null;
}

const AUDIO_ENCODERS: Record<string, AudioEncoderSpec> = {
    aac: { encoder: 'aac', maxChannels: 6, maxBitrate: 640_000 },
    mp3: { encoder: 'libmp3lame', maxChannels: 2, maxBitrate: 320_000 },
    ac3: { encoder: 'ac3', maxChannels: 6, maxBitrate: 640_000 },
    eac3: { encoder: 'eac3', maxChannels: 6, maxBitrate: 1_536_000 },
    opus: { encoder: 'libopus', maxChannels: 8, maxBitrate: 512_000 },
    flac: { encoder: 'flac', maxChannels: 8, maxBitrate: null },
};

/** Used when the request names no video bitrate and the source's is unknown. */
const DEFAULT_VIDEO_BITRATE = 8_000_000;
/** Ceiling when the request names no bitrate: never re-encode at remux-sized rates. */
const MAX_UNREQUESTED_VIDEO_BITRATE = 20_000_000;
const MIN_VIDEO_BITRATE = 200_000;

function positiveInt(raw: string | undefined): number | null {
    if (raw === undefined || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function codecList(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(',')
        .map(normaliseCodec)
        .filter((c) => c.length > 0);
}

/**
 * Parse a progressive-transcode request, or null when the request is not one
 * (static, or no recognised container) and the original file should be served.
 * Query keys are matched case-insensitively — clients send both `Static` and
 * `static`, `MaxWidth` and `maxWidth`.
 */
export function parseProgressiveRequest(params: URLSearchParams): ProgressiveRequest | null {
    const q = new Map<string, string>();
    for (const [key, value] of params) {
        const k = key.toLowerCase();
        if (!q.has(k)) q.set(k, value);
    }

    if (q.get('static')?.toLowerCase() === 'true') return null;

    const rawContainer = q.get('container')?.split(',')[0]?.trim().toLowerCase();
    const container = rawContainer ? CONTAINER_ALIASES[rawContainer] : undefined;
    if (!container) return null;

    const ticks = Number(q.get('starttimeticks') ?? '0');
    const startSeconds = Number.isFinite(ticks) && ticks > 0 ? ticks / 10_000_000 : 0;

    const audioIndexRaw = q.get('audiostreamindex');
    const audioIndex = audioIndexRaw === undefined ? NaN : Number(audioIndexRaw);

    return {
        container,
        videoCodecs: codecList(q.get('videocodec')),
        audioCodecs: codecList(q.get('audiocodec')),
        videoBitrate: positiveInt(q.get('videobitrate')),
        audioBitrate: positiveInt(q.get('audiobitrate')),
        maxWidth: positiveInt(q.get('maxwidth')),
        maxHeight: positiveInt(q.get('maxheight')),
        audioChannels: positiveInt(q.get('audiochannels') ?? q.get('maxaudiochannels')),
        audioStreamIndex: Number.isInteger(audioIndex) && audioIndex >= 0 ? audioIndex : null,
        startSeconds,
    };
}

function accepts(list: string[], codec: string): boolean {
    return list.length === 0 || list.includes(normaliseCodec(codec));
}

function muxable(
    table: Record<ProgressiveContainer, ReadonlySet<string> | null>,
    c: ProgressiveContainer,
    codec: string,
): boolean {
    const set = table[c];
    return set === null || set.has(normaliseCodec(codec));
}

function planVideo(req: ProgressiveRequest, video: SourceVideo): VideoPlan {
    const fitsWidth =
        req.maxWidth === null || (video.width !== null && video.width <= req.maxWidth);
    const fitsHeight =
        req.maxHeight === null || (video.height !== null && video.height <= req.maxHeight);
    // An unknown source bitrate is not evidence of a violation; only a known
    // overshoot forces a re-encode.
    const fitsBitrate =
        req.videoBitrate === null || video.bitrate === null || video.bitrate <= req.videoBitrate;

    if (
        accepts(req.videoCodecs, video.codec) &&
        muxable(MUXABLE_VIDEO, req.container, video.codec) &&
        fitsWidth &&
        fitsHeight &&
        fitsBitrate
    ) {
        return { mode: 'copy', codec: normaliseCodec(video.codec) };
    }

    // First codec the client listed that we can encode; H.264 when it named
    // none we can (or none at all) — the one codec every client decodes.
    const codec: EncodableVideoCodec =
        (req.videoCodecs.find((c) => c === 'h264' || c === 'hevc') as EncodableVideoCodec) ??
        'h264';

    let bitrate =
        req.videoBitrate ??
        Math.min(video.bitrate ?? DEFAULT_VIDEO_BITRATE, MAX_UNREQUESTED_VIDEO_BITRATE);
    // Never spend more bits than the source has: re-encoding cannot add detail.
    if (video.bitrate !== null) bitrate = Math.min(bitrate, video.bitrate);
    bitrate = Math.max(MIN_VIDEO_BITRATE, Math.round(bitrate));

    return {
        mode: 'encode',
        codec,
        bitrate,
        maxWidth: req.maxWidth,
        maxHeight: req.maxHeight,
        tonemap: video.isHdr,
    };
}

function pickAudio(req: ProgressiveRequest, audio: SourceAudio[]): SourceAudio | null {
    if (req.audioStreamIndex !== null) {
        const wanted = audio.find((a) => a.index === req.audioStreamIndex);
        if (wanted) return wanted;
    }
    return audio.find((a) => a.isDefault) ?? audio[0] ?? null;
}

function planAudio(req: ProgressiveRequest, track: SourceAudio): AudioPlan {
    const fitsChannels =
        req.audioChannels === null ||
        (track.channels !== null && track.channels <= req.audioChannels);
    if (
        accepts(req.audioCodecs, track.codec) &&
        muxable(MUXABLE_AUDIO, req.container, track.codec) &&
        fitsChannels
    ) {
        return { mode: 'copy', index: track.index, codec: normaliseCodec(track.codec) };
    }

    const codec =
        req.audioCodecs.find(
            (c) => c in AUDIO_ENCODERS && muxable(MUXABLE_AUDIO, req.container, c),
        ) ?? 'aac';
    const spec = AUDIO_ENCODERS[codec];
    const sourceChannels = track.channels ?? 2;
    const channels = Math.max(
        1,
        Math.min(sourceChannels, req.audioChannels ?? sourceChannels, spec.maxChannels),
    );
    let bitrate: number | null = null;
    if (spec.maxBitrate !== null) {
        const fallback = channels > 2 ? 384_000 : 160_000;
        bitrate = Math.min(req.audioBitrate ?? fallback, spec.maxBitrate);
    }
    return { mode: 'encode', index: track.index, codec, encoder: spec.encoder, channels, bitrate };
}

/**
 * Decide what to do. `original` when nothing would change — same container,
 * every track copied, no seek — so the caller serves the file itself with
 * byte ranges instead of piping an identical stream through ffmpeg.
 */
export function planProgressiveTranscode(
    req: ProgressiveRequest,
    source: ProgressiveSource,
): ProgressivePlan {
    const video = source.video ? planVideo(req, source.video) : null;
    const track = pickAudio(req, source.audio);
    const audio = track ? planAudio(req, track) : null;

    const sourceContainer = source.container
        ? (CONTAINER_ALIASES[source.container.toLowerCase()] ?? null)
        : null;
    const allCopied =
        (video === null || video.mode === 'copy') && (audio === null || audio.mode === 'copy');
    // A non-default audio track has to be selected by remuxing even when every
    // codec fits — the original file would play its default track instead.
    const defaultTrackWanted = track === null || track.isDefault || source.audio.length === 1;
    if (
        allCopied &&
        sourceContainer === req.container &&
        req.startSeconds === 0 &&
        defaultTrackWanted
    ) {
        return { kind: 'original' };
    }

    return {
        kind: 'transcode',
        container: req.container,
        video,
        audio,
        startSeconds: req.startSeconds,
    };
}

/** The encoder ffmpeg will run for an `encode` video plan. */
export interface VideoEncoderChoice {
    /** ffmpeg encoder name, e.g. `hevc_qsv`, `libx264`. */
    name: string;
    /** Codec the encoder produces — may differ from the plan if HEVC encoding is disabled. */
    codec: EncodableVideoCodec;
    /** Args that must precede `-i` (device selection). */
    initArgs: string[];
    /** VA-API takes an opaque surface: the filter chain ends with `format=nv12,hwupload`. */
    needsHwUpload: boolean;
    preset: string | null;
    /** `-pix_fmt`, or null when the filter chain fixes it (VA-API). */
    pixFmt: string | null;
}

export const PROGRESSIVE_CONTENT_TYPES: Record<ProgressiveContainer, string> = {
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    ts: 'video/mp2t',
};

function scaleFilter(maxWidth: number | null, maxHeight: number | null): string | null {
    // Downscale-only: a source already inside the box is left at its size. The
    // commas inside min() are escaped because ffmpeg splits filters on them.
    if (maxWidth !== null && maxHeight !== null) {
        return `scale=w='min(iw\\,${maxWidth})':h='min(ih\\,${maxHeight})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
    }
    if (maxWidth !== null) return `scale='min(iw\\,${maxWidth})':-2`;
    if (maxHeight !== null) return `scale=-2:'min(ih\\,${maxHeight})'`;
    return null;
}

/**
 * Build the ffmpeg argument vector. Pure — spawned with an array, never a shell
 * string. Output goes to stdout (`pipe:1`), so MP4 is FRAGMENTED: a regular MP4
 * needs to seek back and rewrite its moov atom, which a pipe cannot do.
 *
 * Decode and filters stay on the CPU and only the encoder may be a GPU one —
 * the same split, for the same measured reasons, as the download renditions
 * (`services/download-rendition/hw-plan.ts`).
 */
export function buildProgressiveArgs(
    plan: Extract<ProgressivePlan, { kind: 'transcode' }>,
    inputPath: string,
    encoder: VideoEncoderChoice | null,
): string[] {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'warning'];
    const encoding = plan.video?.mode === 'encode' ? plan.video : null;
    if (encoding && encoder) args.push(...encoder.initArgs);
    if (plan.startSeconds > 0) args.push('-ss', plan.startSeconds.toFixed(3));
    // A media file is read from disk only — no protocol may redirect the input.
    args.push('-protocol_whitelist', 'file', '-i', inputPath);

    if (plan.video) args.push('-map', '0:v:0');
    if (plan.audio) args.push('-map', `0:${plan.audio.index}`);
    // Subtitles stay sidecars the client fetches itself; data and attachment
    // streams (fonts, cover art) break the MP4 and TS muxers.
    args.push('-sn', '-dn');
    args.push('-map_chapters', plan.container === 'ts' ? '-1' : '0');

    if (plan.video?.mode === 'copy') {
        args.push('-c:v', 'copy');
        if (plan.container === 'mp4' && plan.video.codec === 'hevc') args.push('-tag:v', 'hvc1');
    } else if (encoding) {
        if (!encoder) throw new Error('A video encode needs an encoder choice');
        const filters: string[] = [];
        if (encoding.tonemap) {
            // The chain the HLS pipeline and renditions settled on for CPU tone
            // mapping: handles HDR10/HLG/Dolby Vision and lands on 8-bit yuv420p.
            filters.push('tonemapx=tonemap=hable:p=bt709:t=bt709:m=bt709:r=tv:format=yuv420p');
        }
        const scale = scaleFilter(encoding.maxWidth, encoding.maxHeight);
        if (scale) filters.push(scale);
        if (encoder.needsHwUpload) filters.push('format=nv12', 'hwupload');
        if (filters.length > 0) args.push('-vf', filters.join(','));

        args.push('-c:v', encoder.name);
        if (encoder.preset) args.push('-preset', encoder.preset);
        args.push('-profile:v', encoder.codec === 'hevc' ? 'main' : 'high');
        if (encoder.pixFmt) args.push('-pix_fmt', encoder.pixFmt);
        args.push(
            '-b:v',
            String(encoding.bitrate),
            '-maxrate',
            String(Math.round(encoding.bitrate * 1.5)),
            '-bufsize',
            String(encoding.bitrate * 2),
            // A keyframe every 2 s keeps fragments small, so the client sees bytes
            // early and a dropped connection loses little.
            '-force_key_frames',
            'expr:gte(t,n_forced*2)',
        );
        if (plan.container === 'mp4' && encoder.codec === 'hevc') args.push('-tag:v', 'hvc1');
    }

    if (plan.audio?.mode === 'copy') {
        args.push('-c:a', 'copy');
    } else if (plan.audio) {
        args.push('-c:a', plan.audio.encoder, '-ac', String(plan.audio.channels));
        if (plan.audio.bitrate !== null) args.push('-b:a', String(plan.audio.bitrate));
        args.push('-ar', '48000');
    } else {
        args.push('-an');
    }

    switch (plan.container) {
        case 'mp4':
            // E-AC-3's dec3 metadata is learned from packets. Writing an empty
            // moov before parsing copied packets fails for real Matroska inputs.
            args.push(
                '-f',
                'mp4',
                '-movflags',
                'frag_keyframe+empty_moov+default_base_moof' +
                    (plan.audio?.mode === 'copy' && plan.audio.codec === 'eac3'
                        ? '+delay_moov'
                        : ''),
            );
            break;
        case 'mkv':
            args.push('-f', 'matroska');
            break;
        case 'ts':
            args.push('-f', 'mpegts');
            break;
    }
    args.push('pipe:1');
    return args;
}
