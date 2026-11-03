// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { withHlsParams } from './hls-uri.js';

/**
 * HLS Master Playlist Generation
 *
 * Generates HLS master playlists with audio and subtitle renditions.
 * Used by both the main hls-lumastra endpoint and the path endpoint
 * to ensure consistent master playlist content after seeking.
 */

import type { AudioTrackInfo, SubtitleTrackInfo } from './hls-audio-injection.js';
import { localizedLanguageName, normalizeLanguage, toIso6392B } from '$lib/shared/language-codes';
import { isHlsCompatibleAudioCodec } from '$lib/shared/codec-tables';
import { Logger } from './logger.js';
import { HLS_TAGS, DEFAULT_HLS_VERSION } from './hls-definitions.js';
import { classifyHdrSource, dvBaseLayerIsHdr } from '../services/transcoding/types.js';
import { baseCodecLabel } from './media-quality-summary.js';

const logger = Logger.for('HLSMasterPlaylist');

/**
 * Video info for master playlist generation
 */
export interface MasterPlaylistVideoInfo {
    codec: string;
    width: number;
    height: number;
    bitrate?: number;
    /**
     * Source video codec level as `general_level_idc` (HEVC) — e.g. 120 for
     * Level 4.0, 153 for Level 5.1. Used on the copy/remux path to declare the
     * actual bitstream level in the CODECS string instead of the transcoder's
     * fixed L153. Absent when unknown (falls back to L153). Not consulted for
     * transcodes (the encoder emits Level 5.1).
     */
    level?: number;
    outputCodec?: string;
    /** Video dynamic range: SDR, HDR, HDR10, HLG, etc. */
    videoRange?: string;
    /** Video range type from Jellyfin: SDR, HDR10, HLG, DOVIWithHDR10, etc. */
    videoRangeType?: string;
    /**
     * Average frame rate (e.g., 23.976, 24, 25, 29.97, 30, 50, 59.94, 60).
     * Apple HLS spec recommends FRAME-RATE for HDR/DV content.
     */
    frameRate?: number;
    /**
     * Whether the video is being transcoded (vs direct stream copy).
     * Used in combination with preserveHdr to determine codec string.
     */
    isTranscoded?: boolean;
    /**
     * Whether HDR metadata is preserved during transcoding (full mode FFmpeg).
     * When true AND isTranscoded, we use:
     * - HEVC Main 10 profile codec string (10-bit)
     * - VIDEO-RANGE attribute preserved
     *
     * When false AND isTranscoded, HDR is tone-mapped to SDR:
     * - HEVC Main profile codec string (8-bit)
     * - No VIDEO-RANGE attribute
     */
    preserveHdr?: boolean;
    /**
     * Dolby Vision profile number (5, 7, 8, etc).
     * - Profile 5: Non-cross-compatible, requires DV decoder
     * - Profile 7: Non-cross-compatible, single layer
     * - Profile 8: Cross-compatible with HDR10/HLG fallback
     */
    dvProfile?: number;
    /**
     * Dolby Vision level (typically 6 for 4K60)
     */
    dvLevel?: number;
    /**
     * Base layer signal compatibility ID (0 = not compatible, 1+ = compatible)
     */
    dvBlSignalCompatibilityId?: number;
    /** Video bit depth (8, 10, 12). Used to detect 10-bit SDR (Main 10 profile). */
    bitDepth?: number;
    /** Video profile name (e.g. 'Main', 'Main 10'). */
    profile?: string;
    /**
     * For a transcoded-to-SDR HEVC output: whether the encoder emits Main 10
     * (10-bit) rather than Main (8-bit). Software libx265 in jellyfin-ffmpeg is
     * 10-bit-only (Main 10) even for SDR output, while GPU SDR encodes are 8-bit
     * (Main). The manifest's HEVC profile_idc MUST match the actual bitstream or
     * strict decoders reject the CODECS string. Only consulted on the transcoded,
     * non-HDR-preserved branch.
     */
    outputHevcMain10?: boolean;
}

/**
 * Trickplay info for HLS I-FRAME/Image playlist generation
 */
export interface MasterPlaylistTrickplayInfo {
    /** Width of each individual thumbnail in pixels */
    width: number;
    /** Height of each individual thumbnail in pixels */
    height: number;
    /** Number of tiles per row in sprite sheet */
    tileWidth: number;
    /** Number of tiles per column in sprite sheet */
    tileHeight: number;
    /** Total number of thumbnails available */
    thumbnailCount: number;
    /** Interval between thumbnails in milliseconds */
    interval: number;
    /** Bandwidth estimate for the image stream */
    bandwidth: number;
}

/**
 * Options for master playlist generation
 */
export interface MasterPlaylistOptions {
    /** Include #EXT-X-IMAGE-STREAM-INF for JPEG trickplay (client sends trickplay=jpeg) */
    includeTrickplay?: boolean;
    /** Include #EXT-X-I-FRAME-STREAM-INF for synthetic I-frames (client sends iframes=synthetic) */
    syntheticIframes?: boolean;
    /**
     * Audio codec information for accurate CODECS attribute.
     * When audio is copied (not transcoded), this should be the source audio codec.
     * When audio is transcoded, this is typically 'aac'.
     */
    audioCodec?: string;
    /**
     * Whether audio is being copied (pass-through) or transcoded.
     * When true, audioCodec represents the actual source codec.
     * When false or undefined, audio is transcoded to AAC.
     */
    isAudioCopied?: boolean;
    /**
     * Whether this stream carries audio at all. `false` drops the audio entry
     * from CODECS entirely.
     *
     * Undefined means "assume it does", which keeps every existing caller's
     * output byte-identical — only a caller that KNOWS the source is silent
     * should pass `false`.
     *
     * Needed because the audio half of CODECS is otherwise unconditional: with
     * no audio information it falls back to `mp4a.40.2`, so a video-only stream
     * advertised AAC that its segments do not contain. This is the same class of
     * mismatch as the `hvc1`-vs-samples bug documented below — AVPlayer is
     * strict about CODECS describing the actual samples, and hls.js builds its
     * SourceBuffers from this string, so it waits forever for an audio track
     * that is never coming. Silent films and the video-only renditions we ship
     * deliberately both land here.
     */
    hasAudio?: boolean;
    /**
     * HLS segment container. fMP4 (default) signals codecs out-of-band in the
     * sample entry (hvc1 / dvh1); MPEG-TS has no sample entry and MUST signal the
     * in-band forms (hev1 / dvhe) in the CODECS string, or strict players
     * (AVPlayer/tvOS) reject the stream. See hls-definitions.ts.
     */
    hlsContainer?: 'fmp4' | 'mpegts';
    /**
     * Absolute stream index of the audio track the client asked for
     * (`hlsAudioTrack`). When it matches a rendition, that rendition is the only
     * DEFAULT=YES one, so a player that picks the default (iOS Safari) starts on
     * the user's track instead of the file's default. Unset or unmatched: the
     * file's own default flags, as before.
     */
    selectedAudioStreamIndex?: number;
}

/**
 * Native-HLS clients: the Lumastra Apple apps (AVPlayer), identified by the
 * `apple-tv` device profile both apps send, or an Apple TV user agent.
 */
export function isNativeHlsClient(client: {
    deviceProfileId?: string;
    userAgent?: string;
}): boolean {
    return client.deviceProfileId === 'apple-tv' || /apple\s?tv|tvos/i.test(client.userAgent ?? '');
}

/**
 * Decide whether a master playlist should carry the synthetic I-frame variant.
 *
 * AVPlayer draws the scrubbing thumbnails in its transport bar ONLY from an
 * `EXT-X-I-FRAME-STREAM-INF` variant in the master playlist — there is no other
 * mechanism, and no client-side hook to drive one. The sprite/BIF trickplay API
 * feeds the MPV player's custom overlay, not AVPlayer.
 *
 * The variant was originally opt-in behind `iframes=synthetic`, but the tvOS
 * client has no trickplay code of its own and never sent it, so Apple TV never
 * got scrubbing previews at all. Auto-enable for native-HLS clients, which are
 * the ones that cannot ask for it themselves.
 *
 * Callers still gate on trickplay data actually existing — generateMasterPlaylist
 * emits nothing without `trickplayInfo`, so this degrades cleanly to no variant
 * when a title has no thumbnails yet.
 */
export function resolveSyntheticIframes(client: {
    deviceProfileId?: string;
    userAgent?: string;
    iframesParam?: string | null;
}): boolean {
    // Explicit opt-in still works, from any client.
    if (client.iframesParam === 'synthetic') return true;

    // Native-HLS clients (AVPlayer) cannot request it, so decide for them.
    return isNativeHlsClient(client);
}

/**
 * Build the `EXT-X-I-FRAME-STREAM-INF` line (and its playlist URI) for the
 * synthetic I-frame variant, or `undefined` when there is no trickplay data to
 * synthesise frames from.
 *
 * Shared by the demux and muxed masters so the two cannot drift — both need to
 * offer AVPlayer the same scrubbing variant.
 */
function buildSyntheticIframeVariant(
    segmentBase: string,
    params: URLSearchParams,
    trickplayInfo: MasterPlaylistTrickplayInfo | undefined,
    itemId: string | undefined,
    fileId: string | undefined,
): string | undefined {
    if (!trickplayInfo || !itemId) return undefined;

    const iframeParams = new URLSearchParams(params);
    if (fileId) {
        iframeParams.set('fileId', fileId);
    }
    // Mark as synthetic mode for the path handler
    iframeParams.set('synthetic', 'true');
    // Pass trickplay metadata for I-frame generation
    iframeParams.set('trickplay_width', String(trickplayInfo.width));
    iframeParams.set('trickplay_height', String(trickplayInfo.height));
    iframeParams.set('trickplay_interval', String(trickplayInfo.interval));
    iframeParams.set('trickplay_count', String(trickplayInfo.thumbnailCount));
    iframeParams.set('trickplay_tile_width', String(trickplayInfo.tileWidth));
    iframeParams.set('trickplay_tile_height', String(trickplayInfo.tileHeight));

    const iframeUri = withHlsParams(`${segmentBase}/iframe.m3u8`, iframeParams);

    // Resolution is the individual thumbnail size (same as trickplay)
    const iframeResolution = `${trickplayInfo.width}x${trickplayInfo.height}`;

    // Estimate I-frame bandwidth (typically 10-20% of main stream for still images)
    const iframeBandwidth = Math.ceil(trickplayInfo.bandwidth * 2);

    // Synthetic I-frames are ALWAYS H.264 baseline profile level 3.0
    // (see encodeThumbnailToIFrame in synthetic-iframe.ts).
    //
    // avc1.42C01E = profile_idc 0x42 (66, Baseline), constraint flags 0xC0
    // (constraint_set0 + constraint_set1), level_idc 0x1E (30 = Level 3.0).
    //
    // The constraint byte MUST match the SPS libx264 actually emits. A segment
    // pulled off preprod reads `67 42 c0 1e` — set0+set1 only. We previously
    // declared 0xE0, claiming a constraint_set2 the bitstream does not set, and
    // AVPlayer is strict about CODECS matching the samples (same class of bug as
    // the hvc1/hev1 tagging fixes). Do not "round up" these flags.
    const syntheticIframeCodec = 'avc1.42C01E';

    return `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=${iframeBandwidth},RESOLUTION=${iframeResolution},CODECS="${syntheticIframeCodec}",URI="${iframeUri}"`;
}

/**
 * Build the `EXT-X-MEDIA:TYPE=SUBTITLES` lines (one per track) pointing at the
 * segmented subtitle playlists served by our path endpoint.
 *
 * Shared by the demux master and the audio-only master so the URL shape (and the
 * `fileId` the path endpoint needs to proxy from Jellyfin) cannot drift between
 * them. Returns an empty array for an empty track list — callers decide whether
 * an empty result still needs a separating blank line.
 */
function buildSubtitleMediaLines(
    tracks: SubtitleTrackInfo[],
    segmentBase: string,
    params: URLSearchParams,
    fileId?: string,
): string[] {
    const lines: string[] = [];

    for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        // toIso6392B's fallback branch passes through any unmapped 3-character
        // string, so a language tag carrying a quote would close the LANGUAGE
        // attribute and break the whole master playlist. Tags come from file
        // metadata.
        const langCode = (toIso6392B(track.language) || 'und').replace(/[^a-z]/g, '') || 'und';
        // Sanitize name for HLS (no special chars except underscore)
        const name =
            track.displayTitle
                ?.replace(/[^a-zA-Z0-9\s_-]/g, '')
                .replace(/\s+/g, '_')
                .slice(0, 50) || `Subtitle_${i}`;

        // Default: prefer forced subtitles, then default subtitle
        const isDefault = track.isForced || track.isDefault ? 'YES' : 'NO';
        const isForced = track.isForced ? 'YES' : 'NO';

        // Build subtitle playlist URL with track metadata
        // The path endpoint uses these to proxy from Jellyfin
        const subsParams = new URLSearchParams(params);
        subsParams.set('SubtitleIndex', String(track.index));
        if (fileId) {
            subsParams.set('fileId', fileId);
        }

        // Always use segmented HLS playlist - AVPlayer doesn't support direct WebVTT reference
        const uri = withHlsParams(`${segmentBase}/subs_${i}/index.m3u8`, subsParams);

        lines.push(
            `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${langCode}",NAME="${name}",DEFAULT=${isDefault},AUTOSELECT=YES,FORCED=${isForced},URI="${uri}"`,
        );
    }

    return lines;
}

/**
 * Generate HLS master playlist from audio and subtitle tracks.
 *
 * We generate the master playlist ourselves with correct BANDWIDTH and CODECS values.
 * FFmpeg's auto-generated values are often incorrect for copy mode.
 *
 * FFmpeg structure:
 *   stream_0/index.m3u8 - Audio track 0
 *   stream_1/index.m3u8 - Audio track 1
 *   stream_N/index.m3u8 - Video stream (last index = audioTracks.length)
 *
 * Subtitle structure (served by our path endpoint):
 *   subs_0/index.m3u8 - Subtitle track 0 playlist
 *   subs_0/seg_XXXXX.vtt - Subtitle segments (6 seconds each)
 *
 * Trickplay structure (optional, for tvOS scrubbing thumbnails):
 *   trickplay.m3u8 - HLS image playlist with #EXT-X-IMAGES-ONLY
 *   References tile images via /api/v1/playback/[itemId]/trickplay/[width]
 *
 * Synthetic I-Frame structure (optional, for Apple TV scrubbing):
 *   iframe.m3u8 - HLS I-frame playlist with #EXT-X-I-FRAMES-ONLY
 *   iframe_XXXXX.m4s - Single-frame video segments from trickplay thumbnails
 *
 * Output format:
 *   #EXT-X-MEDIA for each audio track (GROUP-ID="audio")
 *   #EXT-X-MEDIA for each subtitle track (GROUP-ID="subs")
 *   #EXT-X-IMAGE-STREAM-INF for trickplay (optional, requires trickplay=jpeg)
 *   #EXT-X-I-FRAME-STREAM-INF for synthetic I-frames (optional, requires iframes=synthetic)
 *   #EXT-X-STREAM-INF with AUDIO and SUBTITLES groups for video
 */
/**
 * Will a HEVC transcode emit Main 10 (10-bit) rather than Main (8-bit)?
 *
 * The manifest's profile_idc must match the real bitstream — advertise Main 10
 * over a Main stream and AVFoundation rejects playback outright with
 * CoreMediaErrorDomain 1718449215 (FourCC 'fmt?').
 *
 * Software libx265 emits 10-bit for an SDR transcode, while GPU SDR encodes stay
 * 8-bit. But subtitle burn-in composites the overlay on the CPU and hands the
 * encoder 8-bit frames, so a burn-in encode is Main REGARDLESS of who encodes it
 * — verified on prod: `hevc, Main, yuv420p`.
 *
 * Lives here, shared, because the master playlist is built from two different
 * call sites (the playback service and the segment handler) that previously
 * derived this flag from different predicates and disagreed: the same request
 * produced hvc1.1.6 from one and hvc1.2.4 from the other.
 */
export function resolveHevcMain10(opts: {
    isVideoTranscoded: boolean;
    outputCodec?: string;
    gpuEncoder?: string;
    hasSubtitleBurnIn?: boolean;
}): boolean {
    const codec = (opts.outputCodec ?? '').toLowerCase();
    const isHevc = codec.includes('hevc') || codec.includes('265');
    if (!opts.isVideoTranscoded || !isHevc) return false;
    if (opts.gpuEncoder) return false;
    if (opts.hasSubtitleBurnIn) return false;
    return true;
}

/**
 * Derive `resolveHevcMain10` from the JOB, for every master-playlist call site.
 *
 * WHY THIS EXISTS. The master is built from two places — the playback service
 * on session start, and `serveMasterPlaylist` in lumastra-segment-handler on
 * every re-fetch (seek, audio-track change). `resolveHevcMain10` above was
 * extracted because those two "previously derived this flag from different
 * predicates and disagreed: the same request produced hvc1.1.6 from one and
 * hvc1.2.4 from the other". That unified the FUNCTION. It did not unify its
 * INPUTS, and they stayed divergent:
 *
 *   segment handler   videoAction / job videoInfo / gpuEncoder / job burn-in   (all JOB)
 *   playback service  !isVideoCopy / request codec / gpuEncoder / request burn-in
 *                                                    ^^^^^^^^^^ the only job-derived one
 *
 * Mixed provenance inside a single call. On a REUSED job the two disagree:
 * ffmpeg-transcode.service only rewrites persisted config on an AUDIO-track
 * change, so a session started as a video copy keeps `videoAction: 'copy'`
 * while a re-request carrying a codec override computes `transcode`.
 * `isVideoTranscoded` is the first gate here, so that flips the profile byte —
 * initial master hvc1.1.6, post-seek master hvc1.2.4, same session, and
 * AVFoundation rejects mid-playback with 'fmt?' (CoreMediaErrorDomain
 * 1718449215). The same bug, one level down from where it was fixed.
 *
 * THE JOB WINS, always. The manifest describes the segments ffmpeg is actually
 * writing, and those were determined when the job was created — not by whatever
 * this particular request happens to ask for. That is the same rule the audio
 * codec already follows ("`job.config.hlsOutput`, not this request's
 * `resolvedHlsOutput`: on a REUSED job the two disagree"), and the rule
 * `fix(hls): resolve the muxed master codec from the job, not the request`
 * established. Video was simply never brought in line.
 *
 * Takes a structural shape rather than `TranscodeJob` so it stays trivially
 * testable and does not drag the transcoding type graph into this module.
 */
export function resolveMasterHevcMain10(job: {
    config?: {
        videoInfo?: { outputCodec?: string };
        subtitleBurnIn?: unknown;
    };
    transcodeDecisionResult?: { videoAction?: string; gpuEncoder?: string };
}): boolean {
    return resolveHevcMain10({
        isVideoTranscoded: job.transcodeDecisionResult?.videoAction === 'transcode',
        outputCodec: job.config?.videoInfo?.outputCodec,
        gpuEncoder: job.transcodeDecisionResult?.gpuEncoder,
        hasSubtitleBurnIn: !!job.config?.subtitleBurnIn,
    });
}

/**
 * Position of the audio rendition that carries DEFAULT=YES: the client's
 * selected track when it matches one, else the first track flagged default,
 * else the first track. -1 when there are no audio tracks.
 */
function pickDefaultAudioPosition(
    audioTracks: AudioTrackInfo[],
    selectedIndex: number | undefined,
): number {
    if (audioTracks.length === 0) return -1;
    const selected =
        selectedIndex === undefined ? -1 : audioTracks.findIndex((t) => t.index === selectedIndex);
    if (selected !== -1) return selected;
    const flagged = audioTracks.findIndex((t) => t.isDefault);
    return flagged === -1 ? 0 : flagged;
}

/**
 * NAME for an audio rendition before de-duplication. The track's own title is
 * sanitized for HLS; a title that is empty or only repeats the language code
 * (or `und`) is replaced by the language's English name, or "Audio N" when the
 * language is unknown.
 */
function audioRenditionBaseName(track: AudioTrackInfo, langCode: string, position: number): string {
    const rawTitle = (track.displayTitle ?? '').trim();
    // Apple's players show this NAME as written for a non-primary rendition, so
    // keep the title readable: only a quote or a line break would break the
    // attribute (and the whole master playlist).
    const sanitized = sanitizeRenditionName(rawTitle);
    const placeholders = new Set(
        ['', 'und', langCode, track.language ?? '', normalizeLanguage(track.language)].map((s) =>
            s.trim().toLowerCase(),
        ),
    );
    if (sanitized && !placeholders.has(rawTitle.toLowerCase())) return sanitized;
    // localizedLanguageName returns the uppercased tag when the language has no
    // English name; only a real name counts as a known language here.
    const languageName = localizedLanguageName(track.language, 'en');
    if (languageName && languageName !== languageName.toUpperCase()) return languageName;
    return `Audio ${position + 1}`;
}

/** A NAME attribute value: no quotes, no control characters, single spaces, 50 characters. */
function sanitizeRenditionName(raw: string): string {
    return raw
        .replace(/["\p{Cc}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50)
        .trim();
}

/**
 * Append " 2", " 3"... when an earlier rendition already used the same NAME; a
 * numbered name that collides too ("Audio 2" next to a second "Audio") moves on.
 */
function uniqueAudioRenditionName(base: string, usedNames: Map<string, number>): string {
    let count = (usedNames.get(base) ?? 0) + 1;
    let candidate = count === 1 ? base : `${base} ${count}`;
    while (count > 1 && usedNames.has(candidate)) {
        count += 1;
        candidate = `${base} ${count}`;
    }
    usedNames.set(base, count);
    if (candidate !== base) usedNames.set(candidate, 1);
    return candidate;
}

/**
 * Positions of the renditions Apple's players treat as a language's primary
 * one. AVFoundation labels a primary rendition (AUTOSELECT=YES) with the
 * localized language name and ignores NAME (HLS draft, Appendix E.2), so three
 * untitled English tracks all read "English" in the Apple TV menu. Only the
 * primary of each language stays AUTOSELECT=YES: the DEFAULT one when it has
 * that language, else the first. Every other rendition of the language gets
 * AUTOSELECT=NO, and the player then shows its NAME as written.
 */
function primaryAudioPositions(
    audioTracks: AudioTrackInfo[],
    langCodes: string[],
    defaultPosition: number,
): Set<number> {
    const primaries = new Set<number>();
    const seen = new Set<string>();
    const claim = (i: number): void => {
        const lang = langCodes[i];
        // Tracks of unknown language are not one language: each stays primary.
        if (lang === 'und') {
            primaries.add(i);
            return;
        }
        if (seen.has(lang)) return;
        seen.add(lang);
        primaries.add(i);
    };
    if (defaultPosition >= 0 && defaultPosition < langCodes.length) claim(defaultPosition);
    // The file's own default flags next, then the first track of each language.
    audioTracks.forEach((track, i) => {
        if (track.isDefault) claim(i);
    });
    langCodes.forEach((_, i) => claim(i));
    return primaries;
}

/** "5.1", "7.1", "Mono", "" for stereo, else "Nch". */
function channelLayoutLabel(channels: number): string {
    switch (channels) {
        case 1:
            return 'Mono';
        case 2:
            return '';
        case 3:
            return '2.1';
        case 6:
            return '5.1';
        case 7:
            return '6.1';
        case 8:
            return '7.1';
        default:
            return Number.isFinite(channels) && channels > 0 ? `${channels}ch` : '';
    }
}

/**
 * NAME for a rendition the player will display as written (a non-primary one):
 * the track's own title when it has one, else the language name qualified by
 * codec and layout, "English (DTS 5.1)".
 */
function describedAudioRenditionName(
    track: AudioTrackInfo,
    langCode: string,
    position: number,
): string {
    const base = audioRenditionBaseName(track, langCode, position);
    // "Audio N" is unique already; a title or an unknown language keeps its name.
    if (base !== localizedLanguageName(track.language, 'en')) return base;
    // baseCodecLabel passes an unknown codec string through upper-cased.
    const qualifier = sanitizeRenditionName(
        [track.codec ? baseCodecLabel(track.codec) : '', channelLayoutLabel(track.channels)]
            .filter((part) => part)
            .join(' ')
            .replace(/[()]/g, ''),
    );
    return qualifier ? `${base} (${qualifier})` : base;
}

export function generateMasterPlaylist(
    audioTracks: AudioTrackInfo[],
    subtitleTracks: SubtitleTrackInfo[] | undefined,
    segmentBase: string,
    params: URLSearchParams,
    bandwidth: number,
    videoInfo?: MasterPlaylistVideoInfo,
    outputCodec?: string,
    itemId?: string,
    fileId?: string,
    trickplayInfo?: MasterPlaylistTrickplayInfo,
    options?: MasterPlaylistOptions,
): string {
    const lines: string[] = [
        HLS_TAGS.HEADER,
        `${HLS_TAGS.VERSION}:${DEFAULT_HLS_VERSION}`,
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '',
    ];

    // Audio renditions (stream_0, stream_1, ...)
    //
    // Collected into a local array rather than pushed straight into `lines`, so
    // the `AUDIO=` attribute below can be derived from the lines actually
    // emitted — the same way `SUBTITLES=` already is. Pushing an empty array is
    // identical to not pushing, so this restructure alone changes no output.
    const audioMediaLines: string[] = [];
    const selectedAudioIndex = options?.selectedAudioStreamIndex;
    // Exactly one rendition in the group is DEFAULT=YES; several would leave the
    // player to pick one at random.
    const defaultAudioPosition = pickDefaultAudioPosition(audioTracks, selectedAudioIndex);
    // toIso6392B's fallback branch passes through any unmapped 3-character
    // string, so a language tag carrying a quote would close the LANGUAGE
    // attribute and break the whole master playlist. Tags come from file
    // metadata.
    const langCodes = audioTracks.map(
        (track) => (toIso6392B(track.language) || 'und').replace(/[^a-z]/g, '') || 'und',
    );
    const primaries = primaryAudioPositions(audioTracks, langCodes, defaultAudioPosition);
    const usedNames = new Map<string, number>();
    for (let i = 0; i < audioTracks.length; i++) {
        const track = audioTracks[i];
        const langCode = langCodes[i];
        const isPrimary = primaries.has(i);
        const name = uniqueAudioRenditionName(
            isPrimary
                ? audioRenditionBaseName(track, langCode, i)
                : describedAudioRenditionName(track, langCode, i),
            usedNames,
        );
        const isDefault = i === defaultAudioPosition ? 'YES' : 'NO';
        const autoselect = isPrimary ? 'YES' : 'NO';
        const channels = Math.min(track.channels, 6);
        const uri = withHlsParams(`${segmentBase}/stream_${i}/index.m3u8`, params);

        audioMediaLines.push(
            `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${langCode}",NAME="${name}",DEFAULT=${isDefault},AUTOSELECT=${autoselect},CHANNELS="${channels}",URI="${uri}"`,
        );
    }
    lines.push(...audioMediaLines);

    // Subtitle renditions (subs_0, subs_1, ...)
    // These point to subtitle playlists served by our path endpoint
    const subtitleMediaLines =
        subtitleTracks && subtitleTracks.length > 0 && itemId && fileId
            ? buildSubtitleMediaLines(subtitleTracks, segmentBase, params, fileId)
            : [];
    if (subtitleMediaLines.length > 0) {
        lines.push('', ...subtitleMediaLines);
    }

    // Trickplay (JPEG tiles) rendition for scrubbing thumbnails
    // Uses #EXT-X-IMAGE-STREAM-INF which is supported by modern HLS players including AVPlayer
    // The trickplay.m3u8 playlist serves image segments from Jellyfin's trickplay tiles
    // Only included when client explicitly requests it via trickplay=jpeg query param
    if (options?.includeTrickplay && trickplayInfo && itemId) {
        lines.push('');

        // Build trickplay playlist URL
        const trickplayParams = new URLSearchParams(params);
        if (fileId) {
            trickplayParams.set('fileId', fileId);
        }
        // Pass trickplay metadata for playlist generation
        trickplayParams.set('trickplay_width', String(trickplayInfo.width));
        trickplayParams.set('trickplay_interval', String(trickplayInfo.interval));
        trickplayParams.set('trickplay_count', String(trickplayInfo.thumbnailCount));
        trickplayParams.set('trickplay_tile_width', String(trickplayInfo.tileWidth));
        trickplayParams.set('trickplay_tile_height', String(trickplayInfo.tileHeight));

        const trickplayUri = withHlsParams(`${segmentBase}/trickplay.m3u8`, trickplayParams);

        // Resolution is the individual thumbnail size
        const trickplayResolution = `${trickplayInfo.width}x${trickplayInfo.height}`;

        // #EXT-X-IMAGE-STREAM-INF for HLS image/trickplay streams
        // CODECS="jpeg" indicates JPEG image format
        lines.push(
            `#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=${trickplayInfo.bandwidth},RESOLUTION=${trickplayResolution},CODECS="jpeg",URI="${trickplayUri}"`,
        );
    }

    // Synthetic I-Frames rendition for Apple TV scrubbing
    // Uses #EXT-X-I-FRAME-STREAM-INF with video segments generated from trickplay thumbnails
    // Only included when client explicitly requests it via iframes=synthetic query param
    if (options?.syntheticIframes) {
        const iframeVariant = buildSyntheticIframeVariant(
            segmentBase,
            params,
            trickplayInfo,
            itemId,
            fileId,
        );
        if (iframeVariant) {
            lines.push('', iframeVariant);
        }
    }

    lines.push('');

    // Video stream (last index)
    const videoStreamIndex = audioTracks.length;
    const resolution = videoInfo ? `${videoInfo.width}x${videoInfo.height}` : '1920x1080';
    const hlsContainer = options?.hlsContainer ?? 'fmp4';
    const codecs = getCodecsString(
        videoInfo,
        outputCodec,
        {
            audioCodec: options?.audioCodec,
            isAudioCopied: options?.isAudioCopied,
            // This generator knows the answer outright — the track list it was
            // handed IS the audio of the stream it is describing. No caller has
            // to remember to pass it.
            hasAudio: audioTracks.length > 0,
            // What each rendition really carries: full-transcode-strategy copies a
            // track only when its codec is HLS-compatible and encodes the rest to AAC.
            renditionAudioCodecs: audioTracks.map((track) =>
                isHlsCompatibleAudioCodec(track.codec) ? track.codec : 'aac',
            ),
        },
        hlsContainer,
    );
    const videoUri = withHlsParams(`${segmentBase}/stream_${videoStreamIndex}/index.m3u8`, params);

    // Gate on the MEDIA lines actually emitted, not on the track list. The lines
    // above are additionally gated on `itemId && fileId`, so a track list without
    // them produced `SUBTITLES="subs"` pointing at a group that was never
    // declared — a dangling reference some players reject outright.
    const subtitlesAttr = subtitleMediaLines.length > 0 ? ',SUBTITLES="subs"' : '';

    // Same rule, same reason — and this one was missed when the SUBTITLES
    // dangling-group fix landed. `AUDIO="audio"` used to be hardcoded here, so a
    // file with no audio streams produced a STREAM-INF referencing an audio
    // group that has no EXT-X-MEDIA declaration anywhere in the document.
    // RFC 8216 §4.3.4.2 makes that a MUST violation, and a strict player can
    // reject the whole master rather than just ignoring the attribute.
    //
    // Reachable, not theoretical: playback.service.ts logs "No audio tracks
    // found in media file — proceeding with video-only HLS" and CONTINUES to
    // this generator, so any video-only remux or audio-stripped source hits it.
    const audioAttr = audioMediaLines.length > 0 ? ',AUDIO="audio"' : '';

    // Include VIDEO-RANGE for HDR content (required for AVPlayer to render HDR correctly)
    const videoRangeAttr = getVideoRangeAttribute(
        videoInfo?.videoRange,
        videoInfo?.videoRangeType,
        videoInfo?.isTranscoded,
        videoInfo?.preserveHdr,
        videoInfo?.dvProfile,
        videoInfo?.dvBlSignalCompatibilityId,
    );

    // Include FRAME-RATE for HDR/DV content (Apple HLS spec recommends this)
    const frameRateAttr = getFrameRateAttribute(videoInfo?.frameRate);

    // Advertise DV out of band for cross-compatible profiles, so DV-capable players
    // use it while others fall back to the base layer described in CODECS.
    const supplementalCodecsAttr = getSupplementalCodecsAttribute(videoInfo, hlsContainer);

    // Apple HLS spec (9.14): AVERAGE-BANDWIDTH is MUST.
    // Estimate average as ~80% of peak bandwidth for remux/copy streams.
    const averageBandwidth = Math.round(bandwidth * 0.8);

    lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${averageBandwidth},RESOLUTION=${resolution},CODECS="${codecs}"${supplementalCodecsAttr}${frameRateAttr}${videoRangeAttr}${audioAttr}${subtitlesAttr},CLOSED-CAPTIONS=NONE`,
    );
    lines.push(videoUri);
    lines.push('');

    return lines.join('\n');
}

/**
 * Generate video-only CODECS string for HLS I-frame streams.
 * I-frame playlists contain only video keyframes (no audio).
 *
 * For Dolby Vision content, uses the appropriate DV codec string based on profile.
 * AVPlayer requires correct codec signaling to accept the stream.
 *
 * Dolby Vision Codec String Format: <prefix>.<profile>.<level>
 *
 * Prefix indicates NAL unit format (NOT cross-compatibility!):
 * - dvh1 = NAL length-prefixed (for fMP4/ISOBMFF containers) ← WE USE THIS
 * - dvhe = NAL start-code prefixed (for MPEG-2 TS containers)
 *
 * Profile indicates cross-compatibility:
 * - Profile 5: Non-cross-compatible (base layer has wrong colors, requires DV RPU)
 * - Profile 7: Non-cross-compatible (single layer MEL)
 * - Profile 8: Cross-compatible (base layer can be decoded as HDR10/HLG)
 *
 * Since we use fMP4 segments (-hls_segment_type fmp4), we ALWAYS use dvh1 prefix.
 * The profile number distinguishes the DV type, not the prefix.
 *
 * IMPORTANT: When Jellyfin transcodes HDR content (AV1, VP9, etc. to HEVC),
 * it tone-maps to SDR and outputs HEVC Main profile (8-bit), not Main 10.
 * We must match this in our codec string or AVPlayer will reject the stream.
 */
function getVideoCodecString(
    videoInfo?: {
        width?: number;
        height: number;
        videoRange?: string;
        videoRangeType?: string;
        isTranscoded?: boolean;
        preserveHdr?: boolean;
        dvProfile?: number;
        dvLevel?: number;
        dvBlSignalCompatibilityId?: number;
        bitDepth?: number;
        profile?: string;
        outputHevcMain10?: boolean;
        level?: number;
    },
    outputCodec?: string,
    hlsContainer: 'fmp4' | 'mpegts' = 'fmp4',
): string {
    const codec = outputCodec?.toLowerCase() || 'h264';
    const width = videoInfo?.width || 1920;
    const height = videoInfo?.height || 1080;
    // Check both videoRangeType (Jellyfin) and videoRange (lumastra probe) for HDR detection
    const videoRangeType = (videoInfo?.videoRangeType || videoInfo?.videoRange || '').toUpperCase();
    const isTranscoded = videoInfo?.isTranscoded ?? false;
    const preserveHdr = videoInfo?.preserveHdr ?? false;
    const dvProfile = videoInfo?.dvProfile;
    const dvLevel = videoInfo?.dvLevel ?? 6; // Default to level 6 (4K60)

    // ISO-BMFF (fMP4) carries parameter sets out-of-band in the sample entry, so
    // it signals hvc1 / dvh1. MPEG-TS has no sample entry and MUST use the in-band
    // forms hev1 / dvhe, or AVPlayer/tvOS silently rejects the stream. The prefix
    // is the ONLY thing that changes between containers. (See hls-definitions.ts.)
    const isTs = hlsContainer === 'mpegts';
    const hevcPrefix = isTs ? 'hev1' : 'hvc1';
    const dvPrefix = isTs ? 'dvhe' : 'dvh1';

    logger.debug('getVideoCodecString input', {
        outputCodec,
        codec,
        width,
        height,
        videoRangeType,
        isTranscoded,
        preserveHdr,
        dvProfile,
        dvLevel,
        hlsContainer,
    });

    if (codec === 'hevc' || codec === 'h265') {
        // Codec string format: <prefix>.<profile_idc>.<constraint>.<level>.<flags>
        // - Main profile (8-bit SDR): <prefix>.1.6.L<level>.B0
        // - Main 10 profile (10-bit):  <prefix>.2.4.L<level>.B0
        //
        // Level: always declare the HIGHEST safe level (L153 = Level 5.1). The
        // transcode encoder always emits Level 5.1 (see full-transcode-strategy),
        // and for remux declaring higher than actual is safe while declaring too
        // LOW causes Safari/AVPlayer to silently reject → infinite buffering.
        const hdrClass = classifyHdrSource(undefined, videoRangeType);

        if (isTranscoded) {
            if (preserveHdr && hdrClass.isHdr) {
                // HDR10/HLG preserved → Main 10 (10-bit).
                return `${hevcPrefix}.2.4.L153.B0`;
            }

            // Tone-mapped to SDR. profile_idc MUST match the actual bitstream:
            // software libx265 is 10-bit-only (Main 10) even for SDR, while GPU
            // SDR encodes are 8-bit (Main). outputHevcMain10 carries which one.
            const main10 = videoInfo?.outputHevcMain10 ?? false;
            logger.debug('HEVC SDR transcode profile', { main10, hevcPrefix });
            return main10 ? `${hevcPrefix}.2.4.L153.B0` : `${hevcPrefix}.1.6.L153.B0`;
        }

        // Direct stream (no transcoding) — preserve source characteristics.
        //
        // Dolby Vision survives the copy: ffmpeg writes the `dvvC` configuration box
        // into the fMP4 init segment, so the DV metadata is really there to advertise.
        //
        // What must hold is that CODECS matches the sample-entry 4CC the muxer wrote
        // (see applyVideoEncoding in full-transcode-strategy.ts). Getting that wrong is
        // what caused the audio-only black screen on Apple TV: CODECS said `hvc1` while
        // the track was tagged `dvh1`, so AVPlayer could not build a decoder.
        if (hdrClass.isDolbyVision || dvProfile) {
            const profileNum = dvProfile ?? 8;
            const blCompatId = videoInfo?.dvBlSignalCompatibilityId ?? 0;

            // Cross-compatible DV (profile 8, and profile 10 over AV1) has an ordinary
            // HDR10/HLG base layer. Per Apple's HLS authoring spec the primary CODECS
            // entry describes that base layer — which is what a non-DV decoder falls
            // back to — and DV is advertised out of band via SUPPLEMENTAL-CODECS.
            if (dvBaseLayerIsHdr(blCompatId, profileNum)) {
                // Declare the base layer's REAL level, same as the regular HEVC copy
                // branch below. This branch used to hardcode L153, which contradicted
                // both the bitstream (a level 4.0 / L120 file was advertised as 5.1)
                // and the DV level in our own SUPPLEMENTAL-CODECS — e.g. `L153` next
                // to `dvh1.08.03`, where DV level 3 is ~1080p.
                const hevcCodec = `${hevcPrefix}.2.4.${hevcLevelString(videoInfo?.level)}.B0`;
                logger.debug('DV with compatible base layer (DV in SUPPLEMENTAL-CODECS)', {
                    hevcCodec,
                    dvProfile: profileNum,
                    dvLevel,
                    blCompatId,
                    sourceLevel: videoInfo?.level,
                });
                return hevcCodec;
            }

            // Profiles 5/7: no base layer to fall back to, so the DV codec IS the
            // primary entry. These REQUIRE a DV decoder.
            const profileStr = String(profileNum).padStart(2, '0');
            const levelStr = String(dvLevel).padStart(2, '0');
            const dvCodec = `${dvPrefix}.${profileStr}.${levelStr}`;
            logger.debug('Generated Dolby Vision codec string (non-cross-compatible)', {
                dvCodec,
                profileNum,
                dvLevel,
                videoRangeType,
            });
            return dvCodec;
        }

        // Regular HEVC (HDR10, HLG, or SDR) — non-transcoded (remux/copy).
        // Profile: Main 10 (x.2.4) for HDR OR 10-bit SDR content; Main (x.1.6)
        // only for 8-bit SDR. The HEVC profile must match the actual bit depth,
        // not just the color space (10-bit SDR is still Main 10).
        // A DV bitstream is 10-bit by definition, so its base layer is always Main 10
        // even when the probe left bitDepth/profile/videoRangeType unpopulated.
        const isMain10 =
            dvProfile !== undefined ||
            hdrClass.isDolbyVision ||
            (videoInfo?.bitDepth !== undefined && videoInfo.bitDepth > 8) ||
            (videoInfo?.profile?.toLowerCase().includes('main 10') ?? false) ||
            (videoInfo?.profile?.toLowerCase().includes('main10') ?? false);
        // For a stream COPY the CODECS string must declare the SOURCE bitstream's
        // actual level, not the transcoder's fixed L153. Over-declaring (e.g.
        // L153 for a Level 4.0 / L120 copy) makes strict decoders — notably
        // Firefox on Linux (VA-API), which caps at the level its hardware
        // advertises — reject the codec via MediaSource.isTypeSupported and stall
        // ~1s in, while lenient decoders (Safari/VideoToolbox) tolerate it. We
        // only ever declare the real level here; when it is unknown we keep the
        // L153 over-declaration, since declaring too LOW (below the actual
        // bitstream) is what makes AVPlayer/Safari silently reject → buffer
        // forever. `level` is HEVC general_level_idc (120 = 4.0, 153 = 5.1).
        const levelStr = hevcLevelString(videoInfo?.level);
        return hdrClass.isHdr || isMain10
            ? `${hevcPrefix}.2.4.${levelStr}.B0`
            : `${hevcPrefix}.1.6.${levelStr}.B0`;
    } else if (codec === 'av1') {
        // AV1 codec string format: av01.<profile>.<level><tier>.<bitDepth>
        // Level: 08 = 4.0, 09 = 4.1, 12 = 5.0, 13 = 5.1
        // Bit depth: 08 = 8-bit SDR, 10 = 10-bit (HDR or 10-bit SDR — must match
        // the actual bitstream, not just the color space; mirrors the HEVC
        // Main-10 check above).
        const av1Hdr = classifyHdrSource(undefined, videoRangeType);
        const is10Bit =
            av1Hdr.isHdr || (videoInfo?.bitDepth !== undefined && videoInfo.bitDepth > 8);
        const bitDepth = is10Bit ? '10' : '08';
        // AV1 encoders auto-select their own level, so declare by resolution and
        // lean high (safe): Level 4.0 tops out at ~1080p30 — 1080p60 needs 4.1, so
        // an 08 declaration under-declares 1080p high-frame-rate content and risks
        // player rejection (same rationale as the HEVC level policy above). Bucket
        // on the LARGER dimension so portrait/anamorphic content is classified by
        // its true pixel extent (consistent with the H.264 branch below).
        const maxDim = Math.max(width, height);
        const level = maxDim >= 3840 ? '13' : maxDim >= 2560 ? '12' : maxDim >= 1920 ? '09' : '08';
        const av1Codec = `av01.0.${level}M.${bitDepth}`;
        logger.debug('Generated AV1 codec string', {
            av1Codec,
            width,
            height,
            isHdr: av1Hdr.isHdr,
            videoRangeType,
        });
        return av1Codec;
    } else {
        // H.264 High profile (0x64). avc1.<profile_idc><constraint><level>:
        // 6400 = High, then level hex — 0x28=4.0, 0x2A=4.2, 0x32=5.0, 0x33=5.1.
        if (isTranscoded) {
            // The encoder level is deterministic and forced (see
            // full-transcode-strategy: sourceWidth > 2048 ? 5.1 : 4.0). Declare
            // exactly that — declaring higher would over-state and let a
            // Level-4.0-capped device reject an otherwise-decodable variant.
            return width > 2048 ? 'avc1.640033' : 'avc1.640028';
        }
        // Remux/copy: true level unknown, so declare a safe-high level by
        // resolution (a high-bitrate 1080p remux is often Level 4.2). Bucket on
        // the larger dimension for portrait/anamorphic consistency with AV1.
        const maxDim = Math.max(width, height);
        const levelHex =
            maxDim >= 3840 ? '33' : maxDim >= 2560 ? '32' : maxDim >= 1920 ? '2a' : '28';
        return `avc1.6400${levelHex}`;
    }
}

/**
 * Convert audio codec name to HLS codec string.
 *
 * HLS codec strings for common audio formats:
 * - AAC-LC: mp4a.40.2
 * - HE-AAC (AAC-LC + SBR): mp4a.40.5
 * - HE-AACv2 (AAC-LC + SBR + PS): mp4a.40.29
 * - AC-3 (Dolby Digital): ac-3
 * - E-AC-3 (Dolby Digital Plus): ec-3
 * - E-AC-3 JOC (Dolby Atmos over DD+): ec-3 (same as E-AC-3)
 * - TrueHD: Not HLS compatible (must transcode)
 * - DTS: Not HLS compatible (must transcode)
 * - FLAC: fLaC
 * - Opus: Opus
 * - MP3: mp4a.40.34 or mp3
 *
 * @param codec - Audio codec name from source (e.g., 'aac', 'eac3', 'ac3', 'truehd')
 * @returns HLS codec string
 */
function getAudioCodecString(codec?: string): string {
    if (!codec) return 'mp4a.40.2'; // Default to AAC-LC

    const lowerCodec = codec.toLowerCase();

    // AAC variants
    if (lowerCodec === 'aac' || lowerCodec === 'aac-lc' || lowerCodec === 'mp4a') {
        return 'mp4a.40.2';
    }
    if (lowerCodec === 'he-aac' || lowerCodec === 'aac-he' || lowerCodec === 'aacplus') {
        return 'mp4a.40.5';
    }
    if (lowerCodec === 'he-aacv2' || lowerCodec === 'aac-hev2') {
        return 'mp4a.40.29';
    }

    // Dolby formats
    if (lowerCodec === 'ac3' || lowerCodec === 'ac-3' || lowerCodec === 'dolby digital') {
        return 'ac-3';
    }
    if (
        lowerCodec === 'eac3' ||
        lowerCodec === 'ec-3' ||
        lowerCodec === 'e-ac-3' ||
        lowerCodec === 'dolby digital plus' ||
        lowerCodec === 'atmos'
    ) {
        // Note: Dolby Atmos over DD+ uses the same codec string as E-AC-3
        return 'ec-3';
    }

    // FLAC (Apple added support in iOS 11 / tvOS 11)
    if (lowerCodec === 'flac') {
        return 'fLaC';
    }

    // Opus (widely supported in modern browsers/players)
    if (lowerCodec === 'opus') {
        return 'Opus';
    }

    // MP3
    if (lowerCodec === 'mp3' || lowerCodec === 'mpeg audio') {
        return 'mp4a.40.34';
    }

    // ALAC (Apple Lossless) - supported by Apple devices
    if (lowerCodec === 'alac') {
        return 'alac';
    }

    // TrueHD, DTS, and other non-HLS-compatible formats
    // These should be transcoded to AAC, but if they reach here, fallback to AAC string
    if (
        lowerCodec === 'truehd' ||
        lowerCodec === 'dts' ||
        lowerCodec === 'dts-hd' ||
        lowerCodec === 'dts-hd ma' ||
        lowerCodec === 'pcm' ||
        lowerCodec === 'wav'
    ) {
        logger.warn('Non-HLS-compatible audio codec in manifest - should have been transcoded', {
            codec,
            fallback: 'mp4a.40.2',
        });
        return 'mp4a.40.2';
    }

    // Unknown codec - default to AAC-LC
    logger.debug('Unknown audio codec, defaulting to AAC-LC', { codec });
    return 'mp4a.40.2';
}

/**
 * HEVC level for a CODECS string, as `L<general_level_idc>` (120 = 4.0, 153 = 5.1).
 *
 * Falls back to the L153 over-declaration when the source level is unknown.
 * Over-declaring is the safe direction: declaring too LOW is what makes
 * AVPlayer/Safari silently reject the variant and buffer forever.
 *
 * The guard is `> 0`, not a nullish check: ffprobe reports `-99` for an unknown
 * level and `ffprobe.ts` stores any number verbatim, so `?? 153` alone let `-99`
 * through and produced a nonsense `L-99` in the manifest.
 */
function hevcLevelString(level?: number): string {
    return `L${level !== undefined && level > 0 ? level : 153}`;
}

/**
 * Generate CODECS string for HLS manifest based on output video and audio codecs.
 * Uses the actual output codecs (after any transcoding).
 *
 * @param videoInfo - Video stream information
 * @param outputCodec - Output video codec
 * @param audioOptions - Audio codec information (when audio is copied vs transcoded)
 */
function getCodecsString(
    videoInfo?: MasterPlaylistVideoInfo,
    outputCodec?: string,
    audioOptions?: {
        audioCodec?: string;
        isAudioCopied?: boolean;
        hasAudio?: boolean;
        /** Every copied rendition's codec (demux master). CODECS must name all of them. */
        renditionAudioCodecs?: string[];
    },
    hlsContainer: 'fmp4' | 'mpegts' = 'fmp4',
): string {
    // Video codec string (includes Dolby Vision detection with profile-aware codec strings)
    const videoCodecStr = getVideoCodecString(videoInfo, outputCodec, hlsContainer);

    // No audio in the segments ⇒ no audio in CODECS. Only an explicit `false`
    // suppresses it: undefined keeps the historical "assume audio" fallback, so
    // callers that never learned about this are unaffected.
    if (audioOptions?.hasAudio === false) {
        logger.debug('Video-only stream — omitting audio from CODECS', {
            codecs: videoCodecStr,
        });
        return videoCodecStr;
    }

    // Audio codec string
    // When audio is copied (pass-through), use the actual source codec
    // When audio is transcoded (or no info provided), default to AAC-LC
    let audioCodecStr: string;
    if (audioOptions?.isAudioCopied && audioOptions.renditionAudioCodecs?.length) {
        // The selected codec first, then any other rendition's — an AVPlayer
        // that switches to a rendition whose format CODECS does not name can
        // refuse it (RFC 8216 4.3.4.2: every format in the variant and its
        // renditions).
        const ordered = [audioOptions.audioCodec, ...audioOptions.renditionAudioCodecs]
            .filter((codec): codec is string => !!codec)
            .map((codec) => getAudioCodecString(codec));
        audioCodecStr = [...new Set(ordered)].join(',');
    } else if (audioOptions?.isAudioCopied && audioOptions?.audioCodec) {
        audioCodecStr = getAudioCodecString(audioOptions.audioCodec);
        logger.debug('Using source audio codec for manifest (audio copy mode)', {
            sourceCodec: audioOptions.audioCodec,
            hlsCodecString: audioCodecStr,
        });
    } else {
        // Audio is being transcoded to AAC (or no audio info available)
        audioCodecStr = 'mp4a.40.2';
    }

    const codecs = `${videoCodecStr},${audioCodecStr}`;
    logger.debug('Generated CODECS string', {
        codecs,
        videoCodecStr,
        audioCodecStr,
    });
    return codecs;
}

/**
 * Generate SUPPLEMENTAL-CODECS for Dolby Vision with a backward-compatible base layer.
 *
 * Per Apple's HLS authoring spec, cross-compatible DV is advertised with the base
 * layer in CODECS (so non-DV decoders can play it) and the DV codec here. That claim
 * is backed by the `dvvC` configuration box, which ffmpeg does write into the fMP4
 * init segment on a stream copy — but only when `-strict unofficial` is an OUTPUT
 * option. Placed before `-i` it configures the decoder instead and the box is
 * silently omitted, leaving this attribute advertising DV that is not in the file.
 *
 * Not emitted for transcoded output, which re-encodes the base layer and drops the
 * DV RPU. Not emitted for profiles 5/7 either — they have no base layer, so the DV
 * codec is already the primary CODECS entry.
 *
 * @returns SUPPLEMENTAL-CODECS attribute string (e.g., ',SUPPLEMENTAL-CODECS="dvh1.08.03/db1p"')
 *          or empty string if not applicable
 */
function getSupplementalCodecsAttribute(
    videoInfo?: MasterPlaylistVideoInfo,
    hlsContainer: 'fmp4' | 'mpegts' = 'fmp4',
): string {
    if (!videoInfo) return '';

    const isTranscoded = videoInfo.isTranscoded ?? false;
    if (isTranscoded) return ''; // Transcoded content loses DV metadata

    const dvProfile = videoInfo.dvProfile;
    if (dvProfile === undefined) return '';

    const blCompatId = videoInfo.dvBlSignalCompatibilityId ?? 0;
    // Only DV with a compatible base layer uses SUPPLEMENTAL-CODECS. Profiles 5/7
    // carry the DV codec directly in CODECS instead.
    if (!dvBaseLayerIsHdr(blCompatId, dvProfile)) return '';

    const dvLevel = videoInfo.dvLevel ?? 6;
    // dvh1 for fMP4 (out-of-band sample entry) vs dvhe for MPEG-TS (in-band).
    const dvPrefix = hlsContainer === 'mpegts' ? 'dvhe' : 'dvh1';
    const profileStr = String(dvProfile).padStart(2, '0');
    const levelStr = String(dvLevel).padStart(2, '0');
    const dvCodec = `${dvPrefix}.${profileStr}.${levelStr}`;

    // RFC 8216bis-18 §4.4.6.2: compatibility brands after slash
    // DV 8.1 (bl_compatibility_id=1) → db1p (HDR10 base)
    // DV 8.2 (bl_compatibility_id=2) → db2g (SDR base)
    // DV 8.4 (bl_compatibility_id=4) → db4h (HLG base)
    const compatBrandMap: Record<number, string> = {
        1: 'db1p',
        2: 'db2g',
        4: 'db4h',
    };
    const compatBrand = compatBrandMap[blCompatId];
    const supplemental = compatBrand ? `${dvCodec}/${compatBrand}` : dvCodec;

    logger.debug('Generated SUPPLEMENTAL-CODECS for cross-compatible DV', {
        supplemental,
        dvProfile,
        dvLevel,
        blCompatId,
        compatBrand,
    });

    return `,SUPPLEMENTAL-CODECS="${supplemental}"`;
}

/**
 * Calculate estimated bandwidth for HLS manifest.
 *
 * Uses aggressive minimum bandwidth floors to prevent AVPlayer error -12318
 * "Segment exceeds specified bandwidth for variant" on high-bitrate scenes.
 * The bandwidth value must accommodate PEAK bitrate, not average.
 *
 * @param videoInfo - Video stream info with bitrate
 * @param audioTracks - Audio tracks to calculate total audio bitrate
 * @returns Estimated total bandwidth in bits/second
 */
export function calculateEstimatedBandwidth(
    videoInfo?: { width?: number; height?: number; bitrate?: number },
    audioTracks?: AudioTrackInfo[],
): number {
    // Audio bitrates: FFmpeg uses 128k stereo, 256k surround
    const audioBitrateSum =
        audioTracks?.reduce((sum, track) => {
            const channels = Math.min(track.channels, 6);
            return sum + (channels > 2 ? 256000 : 128000);
        }, 0) || 128000;

    const width = videoInfo?.width || 1920;

    // Minimum bandwidth based on resolution (conservative estimates for peak bitrate)
    // AVPlayer error -12318 occurs when segments exceed declared BANDWIDTH
    // These are high to avoid complaints on high-bitrate HDR/10-bit scenes
    let minBandwidth: number;
    if (width >= 3840) {
        minBandwidth = 120_000_000; // 4K: 120 Mbps min
    } else if (width >= 1920) {
        minBandwidth = 40_000_000; // 1080p: 40 Mbps min
    } else if (width >= 1280) {
        minBandwidth = 20_000_000; // 720p: 20 Mbps min
    } else {
        minBandwidth = 10_000_000; // SD: 10 Mbps min
    }

    // Total bandwidth: video + audio + 15% buffer for HLS overhead
    let estimatedBandwidth: number;
    if (videoInfo?.bitrate && videoInfo.bitrate > 0) {
        estimatedBandwidth = Math.ceil((videoInfo.bitrate + audioBitrateSum) * 1.15);
    } else {
        // No bitrate info - use minimum as baseline
        estimatedBandwidth = minBandwidth;
    }

    // Ensure we never go below the minimum for this resolution
    // This catches cases where reported bitrate is lower than actual peak
    return Math.max(estimatedBandwidth, minBandwidth);
}

/**
 * Generate VIDEO-RANGE attribute for HLS manifest based on video dynamic range.
 *
 * AVPlayer requires this attribute to correctly render HDR content.
 * Without it, HDR10/HLG content is displayed with wrong colors (SDR assumed).
 *
 * @param videoRange - Jellyfin VideoRange (SDR, HDR, etc.)
 * @param videoRangeType - Jellyfin VideoRangeType (SDR, HDR10, HLG, DOVIWithHDR10, etc.)
 * @param isTranscoded - Whether video is being transcoded
 * @param preserveHdr - Whether HDR is preserved during transcoding (full mode)
 * @returns VIDEO-RANGE attribute string or empty string for SDR/tone-mapped
 */
function getVideoRangeAttribute(
    videoRange?: string,
    videoRangeType?: string,
    isTranscoded?: boolean,
    preserveHdr?: boolean,
    dvProfile?: number,
    dvBlSignalCompatibilityId?: number,
): string {
    // When transcoding WITHOUT preserving HDR, HDR is tone-mapped to SDR -
    // do NOT include VIDEO-RANGE.
    // When transcoding WITH preserveHdr (full mode), HDR metadata is kept.
    if (isTranscoded && !preserveHdr) {
        return '';
    }

    // Direct stream OR HDR-preserved transcode - check for HDR characteristics
    const hdr = classifyHdrSource(videoRange, videoRangeType);

    // DV is never delivered as DV — the remux ships the base layer (see
    // getSupplementalCodecsAttribute). The DV configuration record is the only
    // reliable description of that base layer, so it takes precedence over the
    // videoRange strings, which classify a "DOVIWithSDR" source as HDR and would
    // otherwise stamp VIDEO-RANGE=PQ on an SDR base layer. It is also the only
    // signal available when the probe left video_range_type NULL, which it does for
    // some files — without this, an HDR stream would be rendered as SDR.
    if (dvProfile !== undefined) {
        if (dvBlSignalCompatibilityId === 2) return ''; // 8.2 — SDR base layer
        if (dvBlSignalCompatibilityId === 4) return ',VIDEO-RANGE=HLG';
        return ',VIDEO-RANGE=PQ';
    }

    if (!hdr.isHdr) {
        return '';
    }

    // HLG uses its own VIDEO-RANGE value; everything else (HDR10, PQ, DV) uses PQ
    if (hdr.isHlg) {
        return ',VIDEO-RANGE=HLG';
    }

    return ',VIDEO-RANGE=PQ';
}

/**
 * Generate FRAME-RATE attribute for HLS manifest.
 *
 * Apple HLS spec (9.15): FRAME-RATE MUST be present for video content.
 * When frame rate is unknown, defaults to 23.976 (most common for movies).
 *
 * The value should be a decimal representation of the frame rate.
 * Common values: 23.976, 24, 25, 29.97, 30, 50, 59.94, 60
 *
 * @param frameRate - Average frame rate from video stream
 * @returns FRAME-RATE attribute string
 */
function getFrameRateAttribute(frameRate?: number): string {
    // Default to 23.976 when unknown — Apple requires FRAME-RATE for all video
    const fps = frameRate && frameRate > 0 ? frameRate : 23.976;

    // Format to 3 decimal places for common fractional rates (23.976, 29.97, 59.94)
    // but remove trailing zeros for cleaner output (24.000 → 24)
    const formatted = fps.toFixed(3).replace(/\.?0+$/, '');

    return `,FRAME-RATE=${formatted}`;
}

/**
 * Generate a master playlist for a MUXED rendition (audio and video in the same
 * segments), wrapping a single media playlist.
 *
 * The muxed path historically returned its media playlist directly from `/hls`,
 * with no master at all. That works for decode — AVPlayer reads the codecs from
 * the init segment — but it leaves nowhere to declare `VIDEO-RANGE`, and tvOS
 * configures the display's HDR mode from the manifest BEFORE parsing any media.
 * The result was HDR10 content playing correctly while the TV stayed in SDR and
 * tone-mapped it, with no HDR indicator. Apple's authoring spec also requires
 * `CODECS` on every variant.
 *
 * Unlike the demux master this emits no `EXT-X-MEDIA` audio group and no
 * `AUDIO=` attribute: the audio is inside the same segments, so there is exactly
 * one rendition to describe.
 *
 * Subtitles are the exception: they are a separate `EXT-X-MEDIA` group even here,
 * because muxed only refers to audio+video sharing segments. Emitting them was
 * missed when this generator was added for HDR signalling, which silently cost
 * AVPlayer every subtitle track on transcoded content — see `renditionContext`.
 */
export function generateMuxedMasterPlaylist(
    mediaPlaylistUri: string,
    bandwidth: number,
    videoInfo?: MasterPlaylistVideoInfo,
    outputCodec?: string,
    options?: MasterPlaylistOptions,
    /**
     * Context for the renditions that hang off this master rather than living in
     * its segments: the synthetic I-frame variant and the subtitle group.
     *
     * AVPlayer reaches this master for transcoded content (a tvOS client playing
     * AV1 lands on delivery_path `mse_hls`), so it needs both here, not only on
     * the demux master. Neither makes the muxed rendition multi-variant — an
     * I-frame variant is a separate tag, and subtitles are a separate MEDIA group.
     *
     * The subtitle omission was a real bug: this generator was introduced so tvOS
     * could read `VIDEO-RANGE` before configuring the display's HDR mode, and
     * routing native-HLS clients through it dropped `EXT-X-MEDIA:TYPE=SUBTITLES`
     * for exactly the transcoded content it covers. Direct/remux playback kept its
     * subtitles (demux master); anything transcoded lost all of them.
     */
    renditionContext?: {
        segmentBase: string;
        params?: URLSearchParams;
        trickplayInfo?: MasterPlaylistTrickplayInfo;
        itemId?: string;
        fileId?: string;
        /**
         * Text subtitle tracks to advertise. Bitmap tracks are already excluded
         * upstream (media-probe.service builds this list through
         * `isTextBasedSubtitle`) — they cannot produce WebVTT cues and the segment
         * handler answers them with empty segments.
         */
        subtitleTracks?: SubtitleTrackInfo[];
    },
): string {
    const hlsContainer = options?.hlsContainer ?? 'fmp4';
    const codecs = getCodecsString(
        videoInfo,
        outputCodec,
        {
            audioCodec: options?.audioCodec,
            isAudioCopied: options?.isAudioCopied,
            // Unlike generateMasterPlaylist this one is handed a media URI, not
            // a track list, so it cannot work this out — the caller must say.
            hasAudio: options?.hasAudio,
        },
        hlsContainer,
    );
    const supplementalCodecsAttr = getSupplementalCodecsAttribute(videoInfo, hlsContainer);
    const frameRateAttr = getFrameRateAttribute(videoInfo?.frameRate);
    const videoRangeAttr = getVideoRangeAttribute(
        videoInfo?.videoRange,
        videoInfo?.videoRangeType,
        videoInfo?.isTranscoded,
        videoInfo?.preserveHdr,
        videoInfo?.dvProfile,
        videoInfo?.dvBlSignalCompatibilityId,
    );
    const resolution = `${videoInfo?.width || 1920}x${videoInfo?.height || 1080}`;
    const averageBandwidth = Math.round(bandwidth * 0.8);

    // Same gate as the demux master: the path endpoint that serves the subtitle
    // playlists needs BOTH `SubtitleIndex` and `fileId` on every segment URL to
    // proxy the track, and answers 400 without them. No fileId → advertise nothing,
    // rather than a subtitle group whose every rendition 400s.
    const subtitleTracks =
        renditionContext?.fileId && renditionContext.segmentBase
            ? (renditionContext.subtitleTracks ?? [])
            : [];
    const subtitleLines = buildSubtitleMediaLines(
        subtitleTracks,
        renditionContext?.segmentBase ?? '',
        renditionContext?.params ?? new URLSearchParams(),
        renditionContext?.fileId,
    );
    const subtitlesAttr = subtitleLines.length > 0 ? ',SUBTITLES="subs"' : '';

    const lines = [
        HLS_TAGS.HEADER,
        `${HLS_TAGS.VERSION}:${DEFAULT_HLS_VERSION}`,
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '',
    ];

    if (subtitleLines.length > 0) {
        lines.push(...subtitleLines, '');
    }

    lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${averageBandwidth},RESOLUTION=${resolution},CODECS="${codecs}"${supplementalCodecsAttr}${frameRateAttr}${videoRangeAttr}${subtitlesAttr},CLOSED-CAPTIONS=NONE`,
        mediaPlaylistUri,
        '',
    );

    if (options?.syntheticIframes && renditionContext) {
        const iframeVariant = buildSyntheticIframeVariant(
            renditionContext.segmentBase,
            renditionContext.params ?? new URLSearchParams(),
            renditionContext.trickplayInfo,
            renditionContext.itemId,
            renditionContext.fileId,
        );
        if (iframeVariant) {
            lines.push(iframeVariant, '');
        }
    }

    logger.debug('Generated muxed master playlist', {
        codecs,
        resolution,
        videoRangeAttr,
        supplementalCodecsAttr,
        subtitleRenditions: subtitleLines.length,
    });

    return lines.join('\n');
}

/** 128 kbps audio + container overhead. Fixed: the resolution-tiered estimate would
 *  advertise ~40 Mbps and wreck hls.js ABR/buffer math on an audio-only stream. */
export const AUDIO_ONLY_BANDWIDTH = 160_000;

/**
 * Master playlist for an AUDIO-ONLY rendition (video dropped, -vn).
 *
 * No RESOLUTION (RFC 8216 §4.3.4.2), no EXT-X-MEDIA audio group and no AUDIO=
 * attribute (one rendition, and it IS the variant), no I-frame variant (no keyframes).
 * CODECS must match what the muxer writes — see the hvc1/dvh1 4CC-mismatch incident
 * documented in getVideoCodecString's direct-stream branch (search this file for
 * "black screen") that black-screened Apple TV.
 */
export function generateAudioOnlyMasterPlaylist(
    mediaPlaylistUri: string,
    bandwidth: number,
    subtitleTracks: SubtitleTrackInfo[] = [],
    segmentBase = '',
    params: URLSearchParams = new URLSearchParams(),
    fileId?: string,
): string {
    const lines = [
        HLS_TAGS.HEADER,
        `${HLS_TAGS.VERSION}:${DEFAULT_HLS_VERSION}`,
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '',
    ];

    // Gated on fileId, as the demux and muxed masters are. The path endpoint that
    // serves these playlists answers 400 without it, so emitting them here would
    // advertise renditions whose every request fails. The earlier fix corrected
    // only the SUBTITLES= attribute on this master and left the lines ungated.
    const subtitleMediaLines = fileId
        ? buildSubtitleMediaLines(subtitleTracks, segmentBase, params, fileId)
        : [];
    if (subtitleMediaLines.length > 0) lines.push(...subtitleMediaLines, '');

    // Derived from the emitted lines, so the group can never dangle.
    const subtitlesAttr = subtitleMediaLines.length > 0 ? ',SUBTITLES="subs"' : '';
    lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${Math.round(bandwidth * 0.8)},CODECS="mp4a.40.2"${subtitlesAttr},CLOSED-CAPTIONS=NONE`,
        mediaPlaylistUri,
        '',
    );
    return lines.join('\n');
}
