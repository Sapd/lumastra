// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lumastra Info Utilities
 *
 * Pure helper functions for the lumastra-info endpoint,
 * extracted for testability.
 */

export type { DeviceCapabilities, HdrType, PlayRecommendation } from './media-compatibility.js';

import type { PlaybackCapabilities } from '$lib/schemas/playback-start.js';
import { resolvePlaybackCapabilities } from '$lib/schemas/playback-capabilities.js';
import type { PathScopedCapabilities } from '$lib/components/player/codec-types.js';
import { BURN_IN_CODECS } from '$lib/components/player/subtitle-utils.js';

/**
 * Parse compact codec capabilities from query param.
 * Format: "v:h264,hevc,av1;a:aac,opus,ac3;c:mp4,webm;h:hdr10,hlg;ha:aac,ac3;as:1;hc:fmp4"
 *
 * New fields:
 *  - ha: HLS-specific audio codecs (hlsAudioCodecs)
 *  - as: canSwitchAudioInDirectPlay ('1' = true, '0' = false, default false)
 *  - hc: preferredHlsContainer ('ts' or 'fmp4', default 'fmp4')
 *  - hr: supportsHlsCopyReload ('1' opts into muxed copy-HLS; absent keeps legacy audio switching)
 *  - da: prefersHlsDemuxAudio ('1' = native HLS needs separate audio renditions, see DeviceCapabilities)
 *
 * Returns undefined when input is missing, empty, or lacks both video and audio.
 */
import type { DeviceCapabilities } from './media-compatibility.js';
import { normalizeVideoCodecToken } from './media-compatibility.js';

/**
 * Normalize a client-sent HDR token to the server's canonical vocabulary.
 *
 * The browser serializes Dolby Vision as `dolby_vision` (the value carried in
 * `PathScopedCapabilities.hdr.decode` / `BrowserCapabilities`), but the planner
 * and compatibility layer key DV support on `dovi` (`hdrFormats.has('dovi')`,
 * see media-compatibility.ts). Without this mapping a DV-capable client is read
 * as NON-DV, so the planner forces a tonemap/transcode for Dolby Vision sources.
 * That server decision then conflicts with the client's own direct-play
 * (`videoCodec=copy`) request, and the running job flip-flops between transcode
 * and copy — handing the player a manifest/segment codec mismatch (black screen,
 * "media failed to decode"). The inverse mapping already exists when building
 * `hdr.decode` back out, so this closes the round-trip.
 */
export function normalizeHdrToken(token: string): string {
    return token === 'dolby_vision' ? 'dovi' : token;
}

export function parseCapsParam(raw: string | null | undefined): DeviceCapabilities | undefined {
    if (!raw || raw.length > 500) return undefined;
    const videoCodecs = new Set<string>();
    const audioCodecs = new Set<string>();
    const containers = new Set<string>();
    const hdrFormats = new Set<string>();
    const hlsAudioCodecs = new Set<string>();
    let canSwitchAudioInDirectPlay = false;
    let supportsHlsCopyReload = false;
    let prefersHlsDemuxAudio = false;
    let maxAudioChannels: number | undefined;
    let codecConstraints: Record<string, { maxLevel?: number; maxProfile?: string }> | undefined;

    for (const part of raw.split(';')) {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) continue;
        const prefix = part.substring(0, colonIdx);
        const values = part.substring(colonIdx + 1);
        if (!values) continue;

        if (prefix === 'as') {
            canSwitchAudioInDirectPlay = values.trim() === '1';
            continue;
        }

        if (prefix === 'hr') {
            supportsHlsCopyReload = values.trim() === '1';
            continue;
        }

        if (prefix === 'da') {
            prefersHlsDemuxAudio = values.trim() === '1';
            continue;
        }

        if (prefix === 'mc') {
            const channels = parseInt(values.trim(), 10);
            if (!isNaN(channels) && channels > 0) {
                maxAudioChannels = channels;
            }
            continue;
        }

        if (prefix === 'hc') {
            continue;
        }

        if (prefix === 'cc') {
            for (const entry of values.split(',')) {
                const [codec, levelStr] = entry.split(':');
                if (codec && levelStr) {
                    const level = parseInt(levelStr.trim(), 10);
                    if (!isNaN(level)) {
                        if (!codecConstraints) codecConstraints = {};
                        codecConstraints[codec.trim().toLowerCase()] = {
                            maxLevel: level,
                        };
                    }
                }
            }
            continue;
        }

        const set =
            prefix === 'v'
                ? videoCodecs
                : prefix === 'a'
                  ? audioCodecs
                  : prefix === 'c'
                    ? containers
                    : prefix === 'h'
                      ? hdrFormats
                      : prefix === 'ha'
                        ? hlsAudioCodecs
                        : null;
        if (set) {
            for (const c of values.split(',')) {
                const trimmed = c.trim().toLowerCase();
                if (trimmed) {
                    set.add(set === hdrFormats ? normalizeHdrToken(trimmed) : trimmed);
                }
            }
        }
    }
    if (videoCodecs.size === 0 && audioCodecs.size === 0) return undefined;
    return {
        videoCodecs,
        audioCodecs,
        containers,
        ...(hdrFormats.size > 0 ? { hdrFormats } : {}),
        ...(hlsAudioCodecs.size > 0 ? { hlsAudioCodecs } : {}),
        canSwitchAudioInDirectPlay,
        ...(supportsHlsCopyReload ? { supportsHlsCopyReload: true } : {}),
        ...(prefersHlsDemuxAudio ? { prefersHlsDemuxAudio: true } : {}),
        ...(maxAudioChannels !== undefined ? { maxAudioChannels } : {}),
        ...(codecConstraints ? { codecConstraints } : {}),
    };
}

export interface ParsedCaps {
    deviceCaps: DeviceCapabilities;
    pathScoped?: PathScopedCapabilities;
}

/**
 * Parse a brace-delimited block like "v:h264,hevc;a:aac,opus;c:mp4,webm" into parts.
 */
function parseBraceBlock(block: string): {
    v: string[];
    a: string[];
    c: string[];
} {
    const result: { v: string[]; a: string[]; c: string[] } = {
        v: [],
        a: [],
        c: [],
    };
    for (const part of block.split(';')) {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) continue;
        const prefix = part.substring(0, colonIdx).trim();
        const values = part.substring(colonIdx + 1).trim();
        if (!values) continue;
        const items = values
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        if (prefix === 'v') result.v = items;
        else if (prefix === 'a') result.a = items;
        else if (prefix === 'c') result.c = items;
    }
    return result;
}

/**
 * Parse path-scoped caps wire format.
 * Returns both the flat DeviceCapabilities (for backwards compat) and the full PathScopedCapabilities.
 *
 * Format: ps:df={v:h264,hevc;a:aac;c:mp4,webm},nh={v:h264,hevc;a:aac,ac3},mh={v:h264,vp9;a:aac,opus},h:hdr10,as:1,da:1,mc:6,cc:h264:52,hevc:153
 */
export function parsePathScopedCaps(raw: string): ParsedCaps {
    // Strip ps: prefix
    const body = raw.startsWith('ps:') ? raw.substring(3) : raw;

    // Extract brace-delimited blocks: df={...}, nh={...}, mh={...}
    let df = { v: [] as string[], a: [] as string[], c: [] as string[] };
    let nh = { v: [] as string[], a: [] as string[], c: [] as string[] };
    let mh = { v: [] as string[], a: [] as string[], c: [] as string[] };

    // Collect trailing flat params (everything not inside a block assignment)
    const trailingParts: string[] = [];

    // Parse by finding key={...} patterns then collecting remaining parts
    const blockPattern = /(\w+)=\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    const blockRanges: Array<{ start: number; end: number }> = [];

    while ((match = blockPattern.exec(body)) !== null) {
        const key = match[1];
        const content = match[2];
        blockRanges.push({
            start: match.index,
            end: match.index + match[0].length,
        });

        if (key === 'df') df = parseBraceBlock(content);
        else if (key === 'nh') nh = parseBraceBlock(content);
        else if (key === 'mh') mh = parseBraceBlock(content);
    }

    // Extract trailing params: remove all block ranges, then split by ';'
    // (';' separates trailing params; ',' is reserved for values within a param)
    if (blockRanges.length > 0) {
        let nonBlock = '';
        let lastEnd = 0;
        for (const range of blockRanges) {
            nonBlock += body.substring(lastEnd, range.start);
            lastEnd = range.end;
        }
        nonBlock += body.substring(lastEnd);
        // New format uses ';' between trailing params (preserves ',' for multi-values).
        // Old format used ',' for everything (breaks multi-value params — accepted limitation).
        // Auto-detect: if nonBlock contains ';', use that; otherwise fall back to ','.
        const hasSemicolons = nonBlock.includes(';');
        const delimiter = hasSemicolons ? ';' : ',';
        for (const part of nonBlock.split(delimiter)) {
            const trimmed = part.trim();
            if (trimmed) trailingParts.push(trimmed);
        }
    }

    // Parse trailing flat params
    const hdrFormats = new Set<string>();
    let canSwitchAudio = false;
    let demuxAudio = false;
    let maxChannels: number | undefined;
    let codecConstraints: Record<string, { maxLevel?: number }> | undefined;

    for (const part of trailingParts) {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) continue;
        const prefix = part.substring(0, colonIdx);
        const values = part.substring(colonIdx + 1);
        if (!values) continue;

        if (prefix === 'h') {
            for (const v of values.split(',')) {
                const t = v.trim().toLowerCase();
                if (t) hdrFormats.add(normalizeHdrToken(t));
            }
        } else if (prefix === 'as') {
            canSwitchAudio = values.trim() === '1';
        } else if (prefix === 'da') {
            demuxAudio = values.trim() === '1';
        } else if (prefix === 'mc') {
            const ch = parseInt(values.trim(), 10);
            if (!isNaN(ch) && ch > 0) maxChannels = ch;
        } else if (prefix === 'cc') {
            for (const entry of values.split(',')) {
                const [codec, levelStr] = entry.split(':');
                if (codec && levelStr) {
                    const level = parseInt(levelStr.trim(), 10);
                    if (!isNaN(level)) {
                        if (!codecConstraints) codecConstraints = {};
                        codecConstraints[codec.trim().toLowerCase()] = {
                            maxLevel: level,
                        };
                    }
                }
            }
        }
    }

    // Build PathScopedCapabilities
    const hdrDecodeArray = [...hdrFormats].map((h) => {
        if (h === 'dovi') return 'dolby_vision';
        return h;
    });

    const pathScoped: PathScopedCapabilities = {
        directFile: {
            videoCodecs: df.v,
            audioCodecs: df.a,
            containers: df.c,
        },
        nativeHls: {
            videoCodecs: nh.v,
            audioCodecs: nh.a,
        },
        mseHls: {
            videoCodecs: mh.v,
            audioCodecs: mh.a,
        },
        subtitleRendering: {
            vtt: true,
            pgs: true,
            ass: true,
            vobsub: true,
            burnInRequired: [...BURN_IN_CODECS],
        },
        hdr: {
            decode: hdrDecodeArray,
            display: hdrFormats.size > 0,
        },
        audioSwitching: canSwitchAudio,
        ...(demuxAudio ? { hlsDemuxAudio: true } : {}),
        maxChannels: maxChannels ?? 2,
        codecConstraints: codecConstraints ?? {},
    };

    // Build flat DeviceCapabilities by merging all three paths (union)
    const allVideoCodecs = new Set([...df.v, ...nh.v, ...mh.v]);
    const allAudioCodecs = new Set([...df.a, ...nh.a, ...mh.a]);
    const hlsAudioCodecs = new Set([...nh.a, ...mh.a]);
    const containers = new Set(df.c);

    const deviceCaps: DeviceCapabilities = {
        videoCodecs: allVideoCodecs,
        audioCodecs: allAudioCodecs,
        containers,
        ...(hdrFormats.size > 0 ? { hdrFormats } : {}),
        ...(hlsAudioCodecs.size > 0 ? { hlsAudioCodecs } : {}),
        canSwitchAudioInDirectPlay: canSwitchAudio,
        ...(demuxAudio ? { prefersHlsDemuxAudio: true } : {}),
        ...(maxChannels !== undefined ? { maxAudioChannels: maxChannels } : {}),
        ...(codecConstraints ? { codecConstraints } : {}),
    };

    return { deviceCaps, pathScoped };
}

/**
 * Auto-detect and parse caps parameter (flat or path-scoped).
 */
export function parseCapsAuto(raw: string | null | undefined): ParsedCaps | undefined {
    if (!raw) return undefined;
    if (raw.startsWith('ps:')) {
        return parsePathScopedCaps(raw);
    }
    const deviceCaps = parseCapsParam(raw);
    if (!deviceCaps) return undefined;
    return { deviceCaps };
}

/**
 * Convert a Jellyfin DeviceProfile (as sent by tvOS/Android clients) into DeviceCapabilities.
 * Extracts video/audio codecs, containers, HDR formats, and CodecProfiles constraints
 * (VideoLevel, VideoProfile, AudioChannels, MaxStreamingBitrate).
 *
 * Per-codec constraints (e.g. H.264 max level 52 vs HEVC max level 153) are stored
 * in codecConstraints so checkCompatibility() can look up the correct limit for
 * the media's actual video codec.
 */
export function convertJellyfinProfile(
    body: Record<string, unknown>,
): DeviceCapabilities | undefined {
    const profile = (body.deviceProfile ?? body.DeviceProfile) as
        | {
              DirectPlayProfiles?: Array<{
                  VideoCodec?: string;
                  AudioCodec?: string;
                  Container?: string;
                  Type?: string;
              }>;
              TranscodingProfiles?: Array<{ AudioCodec?: string }>;
              CodecProfiles?: Array<{
                  Type?: string;
                  Codec?: string;
                  Conditions?: Array<{
                      Condition?: string;
                      Property?: string;
                      Value?: string;
                  }>;
              }>;
              MaxStreamingBitrate?: number;
              supportsHdr?: boolean;
              supportsDolbyVision?: boolean;
          }
        | undefined;
    if (!profile?.DirectPlayProfiles) return undefined;

    const videoCodecs = new Set<string>();
    const audioCodecs = new Set<string>();
    const hlsAudioCodecs = new Set<string>();
    const containers = new Set<string>();

    for (const dp of profile.DirectPlayProfiles) {
        if (dp.Type === 'Video' && dp.VideoCodec) {
            dp.VideoCodec.split(',').forEach((c) =>
                videoCodecs.add(normalizeVideoCodecToken(c.trim())),
            );
        }
        if (dp.AudioCodec) {
            dp.AudioCodec.split(',').forEach((c) => audioCodecs.add(c.trim().toLowerCase()));
        }
        if (dp.Container) {
            dp.Container.split(',').forEach((c) => containers.add(c.trim().toLowerCase()));
        }
    }
    for (const tp of profile.TranscodingProfiles ?? []) {
        if (tp.AudioCodec) {
            tp.AudioCodec.split(',').forEach((c) => hlsAudioCodecs.add(c.trim().toLowerCase()));
        }
    }

    if (videoCodecs.size === 0) return undefined;

    // Extract HDR support from explicit flags and/or CodecProfiles VideoRangeType conditions
    const hdrFormats = new Set<string>();
    if (profile.supportsHdr) {
        hdrFormats.add('hdr10');
        hdrFormats.add('hlg');
    }
    if (profile.supportsDolbyVision) {
        hdrFormats.add('dovi');
    }

    // Extract constraints from CodecProfiles conditions.
    // Video level/profile constraints are stored per-codec so checkCompatibility()
    // can look up the correct limit for the media's actual codec.
    const codecConstraints: Record<
        string,
        { maxLevel?: number; maxProfile?: string; excludedProfiles?: string }
    > = {};
    let maxAudioChannels: number | undefined;

    for (const cp of profile.CodecProfiles ?? []) {
        for (const cond of cp.Conditions ?? []) {
            // HDR formats (standard Jellyfin format used by tvOS/Android clients)
            if (cond.Property === 'VideoRangeType' && cond.Value) {
                for (const range of cond.Value.split('|')) {
                    const r = range.trim();
                    if (r === 'HDR10' || r.startsWith('DOVIWith')) hdrFormats.add('hdr10');
                    if (r === 'HLG' || r === 'DOVIWithHLG') hdrFormats.add('hlg');
                    // Only the bare 'DOVI' token means the client decodes Dolby
                    // Vision. 'DOVIWith*' tokens mean it plays the HDR10/HLG BASE
                    // layer only — advertising 'dovi' for them ships un-decodable
                    // DV P5 bitstreams to the client.
                    if (r === 'DOVI') hdrFormats.add('dovi');
                }
            }

            // Video level (LessThanEqual → max supported level), stored per-codec
            if (
                cp.Type === 'Video' &&
                cond.Property === 'VideoLevel' &&
                cond.Condition === 'LessThanEqual' &&
                cond.Value
            ) {
                const level = Number(cond.Value);
                if (!isNaN(level)) {
                    const codec = cp.Codec?.toLowerCase() ?? '_default';
                    const entry = (codecConstraints[codec] ??= {});
                    entry.maxLevel =
                        entry.maxLevel === undefined ? level : Math.min(entry.maxLevel, level);
                }
            }

            // Video profile (EqualsAny → allowed profiles), stored per-codec
            if (
                cp.Type === 'Video' &&
                cond.Property === 'VideoProfile' &&
                cond.Condition === 'EqualsAny' &&
                cond.Value
            ) {
                const codec = cp.Codec?.toLowerCase() ?? '_default';
                const entry = (codecConstraints[codec] ??= {});
                entry.maxProfile = cond.Value;
            }

            // Video profile (NotEquals → excluded profiles), stored per-codec
            if (
                cp.Type === 'Video' &&
                cond.Property === 'VideoProfile' &&
                cond.Condition === 'NotEquals' &&
                cond.Value
            ) {
                const codec = cp.Codec?.toLowerCase() ?? '_default';
                const entry = (codecConstraints[codec] ??= {});
                // Accumulate multiple NotEquals conditions as pipe-separated list
                entry.excludedProfiles = entry.excludedProfiles
                    ? `${entry.excludedProfiles}|${cond.Value}`
                    : cond.Value;
            }

            // Audio channels (LessThanEqual → max supported channels)
            if (
                (cp.Type === 'VideoAudio' || cp.Type === 'Audio') &&
                cond.Property === 'AudioChannels' &&
                cond.Condition === 'LessThanEqual' &&
                cond.Value
            ) {
                const channels = Number(cond.Value);
                if (!isNaN(channels)) {
                    maxAudioChannels =
                        maxAudioChannels === undefined
                            ? channels
                            : Math.min(maxAudioChannels, channels);
                }
            }
        }
    }

    // MaxStreamingBitrate from the profile root
    const maxBitrate =
        typeof profile.MaxStreamingBitrate === 'number' && profile.MaxStreamingBitrate > 0
            ? profile.MaxStreamingBitrate
            : undefined;

    return {
        videoCodecs,
        audioCodecs,
        hlsAudioCodecs: hlsAudioCodecs.size > 0 ? hlsAudioCodecs : undefined,
        containers,
        hdrFormats: hdrFormats.size > 0 ? hdrFormats : undefined,
        canSwitchAudioInDirectPlay: false,
        codecConstraints: Object.keys(codecConstraints).length > 0 ? codecConstraints : undefined,
        maxBitrate,
        maxAudioChannels,
    };
}

import type { PlayRecommendation } from './media-compatibility.js';

const METHOD_PRIORITY: PlayRecommendation[] = [
    'direct',
    'remux',
    'audio_transcode',
    'full_transcode',
];

/**
 * Determine whether playback is possible given a recommendation and HLS availability.
 *
 * Starting from the recommended method, checks if that method or any higher-level
 * fallback is available. Direct play is always available; remux/audio_transcode/
 * full_transcode require HLS.
 */
export function isPlayable(recommended: PlayRecommendation, hlsAvailable: boolean): boolean {
    const recIndex = METHOD_PRIORITY.indexOf(recommended);
    if (recIndex === -1) return false;
    return METHOD_PRIORITY.slice(recIndex).some((m) => (m === 'direct' ? true : hlsAvailable));
}

/**
 * Classify the caller as a browser or a native (AVPlayer/tvOS) client from how
 * it authenticated. Browsers use the session cookie; native apps carry a token.
 *
 * This drives more than capability defaults — it also selects the native_hls
 * audio mode (see resolveHlsAudioMode), where 'browser' keeps the muxed
 * single-audio workaround for Safari's post-seek subtitle drift and 'native'
 * gets demux multi-audio so AVPlayer has an audio-language picker. A client
 * misclassified here silently loses its language selection, so every
 * caller must use the same classification.
 */
export function deriveClientType(authMethod: string | undefined): 'browser' | 'native' {
    return authMethod === 'bearer' ||
        authMethod === 'pat' ||
        authMethod === 'service_token' ||
        authMethod === 'stream_token'
        ? 'native'
        : 'browser';
}

/**
 * Build the HLS streaming URL for a given codec configuration.
 */
export function buildHlsUrl(
    baseUrl: string,
    itemId: string,
    videoCodec: 'copy' | 'h264' | 'hevc' | 'av1' | 'none',
    audioCodec: 'copy' | 'aac' | 'ac3' | 'opus',
    fileId?: string,
): string {
    const params = new URLSearchParams({ videoCodec, audioCodec });
    if (fileId) params.set('fileId', fileId);
    return `${baseUrl}/api/playback/${itemId}/hls?${params.toString()}`;
}

/** One adapter between the public typed contract and the existing playback planner. */
export function playbackCapabilitiesToProfile(
    declared: PlaybackCapabilities | undefined,
): DeviceCapabilities & { subtitleFormats: Set<string> } {
    // Every omitted list takes its documented default.
    const capabilities = resolvePlaybackCapabilities(declared);
    return {
        subtitleFormats: new Set(capabilities.subtitleFormats.map((v) => v.toLowerCase())),
        containers: new Set(capabilities.containers.map((v) => v.toLowerCase())),
        videoCodecs: new Set(capabilities.videoCodecs.map(normalizeVideoCodecToken)),
        audioCodecs: new Set(capabilities.audioCodecs.map((v) => v.toLowerCase())),
        hdrFormats: new Set(capabilities.hdr.map((v) => normalizeHdrToken(v.toLowerCase()))),
        maxBitrate: capabilities.maxVideoBitrateBps,
        maxHeight: capabilities.maxHeight,
        maxAudioChannels: capabilities.maxAudioChannels,
        canSwitchAudioInDirectPlay: false,
    };
}
