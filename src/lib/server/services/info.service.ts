// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback decision data shared by playability probes and play-session starts.
 */

import type { PlayMethod } from '$lib/schemas/play-sessions.js';
import type { Sql } from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import type { LumastraVersion } from '$lib/schemas/api-playback-responses.js';
import type { LumastraInfoResponse } from '$lib/schemas/api-playback-responses.js';
import type { TrickplayInfo } from '$lib/schemas/playback-types.js';
import { probeMediaFile, containerFromExtension } from '$lib/server/utils/ffprobe.js';
import { probeMediaFileCached } from '$lib/server/services/probe-cache.js';
import { capComparableBitrate } from '$lib/server/services/transcoding/quality-cap.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import {
    getMediaItemById,
    getMediaItemForWatch,
} from '$lib/server/database/queries/catalog-operations.queries.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { getExternalSubtitlesForFile } from '$lib/server/database/queries/external-subtitles.queries.js';
import {
    getPlaybackPreferences,
    type PlaybackPreferencesRow,
} from '$lib/server/database/queries/user-preferences.queries.js';
import { subtitleTrackHintSchema } from '$lib/schemas/user.js';
import {
    resolveTracks,
    DEFAULT_LANGUAGE_PREFERENCES,
    type LanguagePreferences,
} from '$lib/shared/track-selection.js';
import { features } from '$lib/server/config.js';
import { resolveEffectiveResume } from '$lib/server/services/effective-playback.js';
import { getFileSiblingEpisodes } from '$lib/server/database/queries/episode-search.queries.js';
import {
    resolveEpisodeEntryPoint,
    type EpisodeEntryPoint,
} from '$lib/server/utils/episode-entry-point.js';
import { isEpisode } from '$lib/server/utils/media-types.js';
import {
    fileRuntimeMsForResume,
    resumePositionForStart,
} from '$lib/server/utils/watch-constants.js';
import { Logger } from '$lib/server/utils/logger.js';
import * as m from '$lib/paraglide/messages';
import { buildHlsUrl, isPlayable } from '$lib/server/utils/info.utils.js';
import type { PathScopedCapabilities } from '$lib/components/player/codec-types.js';
import {
    BURN_IN_CODECS,
    normalizeSubtitleCodec,
    supportedSubtitleFormats,
    ASS_CODECS,
    PGS_CODECS,
    VOBSUB_CODECS,
    TEXT_CODECS,
} from '$lib/components/player/subtitle-utils.js';
import {
    type MediaInfo,
    type ServerEncodeCaps,
    type DeviceCapabilities,
    type HdrType,
} from '$lib/server/utils/media-compatibility.js';
import { config } from '$lib/server/config.js';
import { hardwareDetection } from '$lib/server/services/transcoding/hardware-detection.js';
import { playbackPlanner } from '$lib/server/services/playback-planner.service.js';
import { buildTimelineDelivery, subtitleDeliveryMethod } from './playback-timeline.service.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { DeliveryPath } from '$lib/schemas/playback-plan.js';

const logger = Logger.for('LumastraInfoService');

/**
 * Query suffix that carries the caps this start was evaluated against
 * onto the HLS play_methods URLs. The plan records the quality cap, but the
 * HLS job only trusts it for the copy-vs-transcode call — the encode geometry,
 * bitrate and audio downmix come from the URL. A client that used the returned
 * URL as-is (third-party /api/v1 clients, the Apple apps) got a 4K encode with
 * 5.1 audio despite asking for 720p / stereo. Duplicates are harmless: the HLS
 * route takes the last occurrence, so a client appending the same param again
 * (or overriding it) still works.
 */
export function buildPlayMethodCapSuffix(caps: {
    maxBitrate?: number;
    maxHeight?: number;
    maxAudioChannels?: number;
}): string {
    const isPositiveInt = (v: number | undefined): v is number =>
        v !== undefined && Number.isInteger(v) && v > 0;
    const params = new URLSearchParams();
    if (isPositiveInt(caps.maxBitrate)) params.set('maxBitrate', String(caps.maxBitrate));
    if (isPositiveInt(caps.maxHeight)) params.set('maxHeight', String(caps.maxHeight));
    if (isPositiveInt(caps.maxAudioChannels)) {
        params.set('maxAudioChannels', String(caps.maxAudioChannels));
    }
    const query = params.toString();
    return query ? `&${query}` : '';
}

export function defaultBrowserCaps(): DeviceCapabilities {
    return {
        videoCodecs: new Set(['h264', 'av1', 'vp9']),
        audioCodecs: new Set(['aac', 'mp3', 'opus']),
        containers: new Set(['mp4', 'webm', 'm4v', 'mov']),
        canSwitchAudioInDirectPlay: false,
    };
}

export function defaultBrowserPathScoped(): PathScopedCapabilities {
    return {
        directFile: {
            videoCodecs: ['h264', 'av1', 'vp9'],
            audioCodecs: ['aac', 'mp3', 'opus'],
            containers: ['mp4', 'webm', 'm4v', 'mov'],
        },
        nativeHls: {
            videoCodecs: [],
            audioCodecs: [],
        },
        mseHls: {
            videoCodecs: ['h264', 'av1', 'vp9'],
            audioCodecs: ['aac', 'mp3', 'opus'],
        },
        subtitleRendering: {
            vtt: true,
            pgs: true,
            ass: true,
            vobsub: true,
            burnInRequired: [...BURN_IN_CODECS],
        },
        hdr: { decode: [], display: false },
        audioSwitching: false,
        maxChannels: 2,
        codecConstraints: {},
    };
}

export function defaultNativePathScoped(): PathScopedCapabilities {
    return {
        directFile: {
            videoCodecs: ['h264', 'hevc', 'av1'],
            audioCodecs: ['aac', 'mp3', 'opus', 'ac3', 'eac3', 'flac'],
            containers: ['mp4', 'mkv', 'm4v', 'mov'],
        },
        nativeHls: {
            videoCodecs: ['h264', 'hevc', 'av1'],
            audioCodecs: ['aac', 'ac3', 'eac3'],
        },
        mseHls: {
            videoCodecs: ['h264', 'hevc', 'av1'],
            audioCodecs: ['aac', 'mp3', 'opus'],
        },
        subtitleRendering: {
            vtt: true,
            pgs: true,
            ass: true,
            vobsub: true,
            burnInRequired: [...BURN_IN_CODECS],
        },
        hdr: { decode: ['hdr10', 'hlg'], display: true },
        audioSwitching: true,
        maxChannels: 8,
        codecConstraints: {},
    };
}

/**
 * Derive path-scoped capabilities from flat client-declared DeviceCapabilities
 * (e.g. a POSTed Jellyfin DeviceProfile).
 *
 * direct_file playback has no server-side transport constraint, so the client's
 * declared codec/container sets are used as-is. The HLS paths intersect the
 * client's decode capabilities with the clientType defaults, which double as
 * the "what HLS/MSE can actually carry" allowlists. Without this derivation a
 * POSTed DeviceProfile was silently discarded in favour of generic defaults —
 * an H.264-only client would be offered HEVC direct play.
 */
export function pathScopedFromDeviceCaps(
    caps: DeviceCapabilities & { subtitleFormats?: Set<string> },
    clientType: 'browser' | 'native',
): PathScopedCapabilities {
    const base = clientType === 'native' ? defaultNativePathScoped() : defaultBrowserPathScoped();
    const intersect = (allowlist: string[], declared: Set<string>): string[] =>
        allowlist.filter((c) => declared.has(c));
    const hlsAudio = caps.hlsAudioCodecs ?? caps.audioCodecs;
    const subtitleFormats = caps.subtitleFormats
        ? supportedSubtitleFormats(caps.subtitleFormats)
        : undefined;
    const supportsVtt = subtitleFormats?.has('vtt') || subtitleFormats?.has('webvtt');

    return {
        ...base,
        directFile: {
            videoCodecs: [...caps.videoCodecs],
            audioCodecs: [...caps.audioCodecs],
            containers: [...caps.containers],
        },
        nativeHls: {
            videoCodecs: intersect(base.nativeHls.videoCodecs, caps.videoCodecs),
            audioCodecs: intersect(base.nativeHls.audioCodecs, hlsAudio),
        },
        mseHls: {
            videoCodecs: intersect(base.mseHls.videoCodecs, caps.videoCodecs),
            audioCodecs: intersect(base.mseHls.audioCodecs, caps.audioCodecs),
        },
        hdr: caps.hdrFormats
            ? { decode: [...caps.hdrFormats], display: caps.hdrFormats.size > 0 }
            : base.hdr,
        subtitleRendering: subtitleFormats
            ? {
                  vtt: !!supportsVtt,
                  ass: ASS_CODECS.some((codec) => subtitleFormats.has(codec)),
                  pgs: PGS_CODECS.some((codec) => subtitleFormats.has(codec)),
                  vobsub: VOBSUB_CODECS.some((codec) => subtitleFormats.has(codec)),
                  burnInRequired: [
                      ...new Set([
                          ...base.subtitleRendering.burnInRequired,
                          ...ASS_CODECS,
                          ...PGS_CODECS,
                          ...VOBSUB_CODECS,
                          ...(!supportsVtt ? TEXT_CODECS : []),
                      ]),
                  ].filter((codec) => !subtitleFormats.has(normalizeSubtitleCodec(codec))),
              }
            : base.subtitleRendering,
        audioSwitching: caps.canSwitchAudioInDirectPlay,
        maxChannels: caps.maxAudioChannels ?? base.maxChannels,
    };
}

function defaultNativeAppCaps(): DeviceCapabilities {
    return {
        videoCodecs: new Set(['h264', 'hevc', 'av1']),
        audioCodecs: new Set(['aac', 'mp3', 'opus', 'ac3', 'eac3', 'flac']),
        containers: new Set(['mp4', 'mkv', 'm4v', 'mov']),
        hlsAudioCodecs: new Set(['aac', 'ac3', 'eac3']),
        canSwitchAudioInDirectPlay: true,
        hdrFormats: new Set(['hdr10', 'hlg']),
    };
}

let cachedServerEncodeCaps: ServerEncodeCaps | null = null;
let cachedServerEncodeCapsAt = 0;
const SERVER_ENCODE_CAPS_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function buildServerEncodeCaps(): Promise<ServerEncodeCaps> {
    if (
        cachedServerEncodeCaps &&
        Date.now() - cachedServerEncodeCapsAt < SERVER_ENCODE_CAPS_TTL_MS
    ) {
        return cachedServerEncodeCaps;
    }

    const [h264, hevc, av1] = await Promise.all([
        hardwareDetection.getBestEncoder('h264'),
        hardwareDetection.getBestEncoder('hevc'),
        hardwareDetection.getBestEncoder('av1'),
    ]);
    const available = new Set<string>();
    const efficient = new Set<string>();

    // An encoder is "efficient" if it's GPU-accelerated (not a lib* software encoder)
    for (const [codec, encoder] of [
        ['h264', h264],
        ['hevc', hevc],
        ['av1', av1],
    ] as const) {
        if (encoder) {
            available.add(codec);
            if (!encoder.startsWith('lib')) {
                efficient.add(codec);
            }
        }
    }

    cachedServerEncodeCaps = {
        canEncodeCodec: (codec: string) => available.has(codec),
        canEfficientlyEncodeCodec: (codec: string) => efficient.has(codec),
    };
    cachedServerEncodeCapsAt = Date.now();
    return cachedServerEncodeCaps;
}

/** Derive bit depth from ffprobe pixel format string (e.g. 'yuv420p10le' → 10). */
export function parseBitDepth(pixelFormat: string | null | undefined): number | undefined {
    if (!pixelFormat) return undefined;
    const match = pixelFormat.match(/(\d{1,2})(le|be)?$/);
    if (match) {
        const depth = parseInt(match[1], 10);
        if (depth >= 8 && depth <= 16) return depth;
    }
    // p010 format (NV12 10-bit)
    if (pixelFormat.includes('p010')) return 10;
    return undefined;
}

export interface LumastraInfoParams {
    surface?: ApiSurface;
    sql: Sql;
    /** Stable users.id UUID — keys the effective-resume lookup (mig 16.46.0). */
    userId: UserId;
    internalId: string;
    fileId?: string;
    audioStreamIndex?: number;
    subtitleId?: string;
    requestedMethod?: PlayMethod;
    clientCaps?: DeviceCapabilities;
    pathScopedCaps?: PathScopedCapabilities;
    clientType?: 'browser' | 'native';
    capsSource?: 'caps_param' | 'device_profile' | 'default_browser' | 'default_native';
    /** User-selected max bitrate (bits/sec) from the player quality settings.
     *  Merged into the final caps even when `clientCaps` is undefined so that the
     *  cap is enforced on default-caps paths (e.g. before codec detection completes). */
    userSelectedMaxBitrate?: number;
    /** User-selected max height (pixels) from the player quality settings.
     *  Same merge behaviour as `userSelectedMaxBitrate` above. */
    userSelectedMaxHeight?: number;
    /**
     * Read-only probe (POST /media/{id}/playability): plans are not stored in
     * Valkey, and when `fileId` is set only that file is probed. The decision
     * itself is unchanged.
     */
    readOnlyProbe?: boolean;
}

/** A version the probe could not read, reported instead of silently dropped. */
export interface UnreadableVersion {
    id: string;
    label: string | null;
    is_default: boolean;
    size_bytes?: number;
    reason: 'probe_failed';
}

/** Total time a read-only probe may spend reading files, however many versions there are. */
const PROBE_DEADLINE_MS = 10_000;
/** Per-file ffprobe timeout in a read-only probe (the scanner's 15 s is too long for a request). */
const PROBE_FILE_TIMEOUT_MS = 5_000;

/**
 * Select the best delivery path for a media file based on path-scoped capabilities.
 * Preference order: direct_file > native_hls > mse_hls.
 *
 * The player consumes this to route playback (planner-as-sole-authority).
 * The client uses delivery_path to choose between direct file, native HLS, or MSE HLS.
 *
 * - direct_file: requires video+audio+container all compatible
 * - native_hls: requires video+audio compatible (HLS handles container)
 * - mse_hls: always available as fallback (server transcodes as needed)
 */
export function selectDeliveryPath(
    mediaInfo: MediaInfo,
    pathScoped: PathScopedCapabilities,
    canSwitchAudio: boolean,
    multiAudio: boolean,
): DeliveryPath {
    // Try direct_file: video + primary audio + container must all be compatible.
    // Only check the primary (first) audio track — the browser plays one track at a time
    // and secondary tracks with exotic codecs shouldn't block direct file playback.
    const dfVideoOk =
        !mediaInfo.videoCodec || pathScoped.directFile.videoCodecs.includes(mediaInfo.videoCodec);
    const primaryAudioCodec = mediaInfo.audioCodecs[0];
    const dfAudioOk =
        !primaryAudioCodec || pathScoped.directFile.audioCodecs.includes(primaryAudioCodec);
    const container = mediaInfo.container
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const dfContainerOk =
        container.length > 0 && container.some((c) => pathScoped.directFile.containers.includes(c));
    const dfMultiAudioOk = !multiAudio || canSwitchAudio;
    if (dfVideoOk && dfAudioOk && dfContainerOk && dfMultiAudioOk) {
        return 'direct_file';
    }

    // Try native_hls: video + audio compatible (container irrelevant for HLS)
    const nhVideoOk =
        !mediaInfo.videoCodec || pathScoped.nativeHls.videoCodecs.includes(mediaInfo.videoCodec);
    const nhAudioAnyOk =
        mediaInfo.audioCodecs.length === 0 ||
        mediaInfo.audioCodecs.some((c) => pathScoped.nativeHls.audioCodecs.includes(c));
    if (nhVideoOk && nhAudioAnyOk) {
        return 'native_hls';
    }

    // Fallback to MSE HLS (always available, server handles transcoding)
    return 'mse_hls';
}

function arrayToSet(values: string[] | undefined): Set<string> {
    return new Set((values ?? []).map((value) => value.toLowerCase()));
}

/**
 * Convert path-scoped browser support into planner caps for the selected path.
 *
 * The flat caps are a union across direct file, native HLS, and MSE HLS. That
 * union is unsafe for planning once the selected path is known: a codec that is
 * direct-file playable is not necessarily appendable through hls.js/MSE. Use
 * the selected path's codec set so video-copy HLS is only chosen when that path
 * can actually decode it.
 */
export function capsForDeliveryPath(
    baseCaps: DeviceCapabilities,
    pathScoped: PathScopedCapabilities,
    deliveryPath: DeliveryPath,
): DeviceCapabilities {
    if (deliveryPath === 'direct_file') {
        return {
            ...baseCaps,
            videoCodecs: arrayToSet(pathScoped.directFile.videoCodecs),
            audioCodecs: arrayToSet(pathScoped.directFile.audioCodecs),
            hlsAudioCodecs: undefined,
            containers: arrayToSet(pathScoped.directFile.containers),
            canSwitchAudioInDirectPlay: pathScoped.audioSwitching,
        };
    }

    if (deliveryPath === 'native_hls') {
        const audioCodecs = arrayToSet(pathScoped.nativeHls.audioCodecs);
        return {
            ...baseCaps,
            videoCodecs: arrayToSet(pathScoped.nativeHls.videoCodecs),
            audioCodecs,
            hlsAudioCodecs: audioCodecs,
            canSwitchAudioInDirectPlay: true,
        };
    }

    const audioCodecs = arrayToSet(pathScoped.mseHls.audioCodecs);
    return {
        ...baseCaps,
        videoCodecs: arrayToSet(pathScoped.mseHls.videoCodecs),
        audioCodecs,
        hlsAudioCodecs: audioCodecs,
        canSwitchAudioInDirectPlay: false,
    };
}

interface RecommendationAudioTrack {
    index: number;
    language: string | null;
    default: boolean;
    title?: string | null;
}

interface RecommendationSubtitleTrack {
    index: number;
    id?: string;
    external?: boolean;
    language: string | null;
    forced: boolean;
    codec?: string;
    title?: string | null;
}

/**
 * Resolve the audio/subtitle tracks the player should start on, and why.
 *
 * Pure function — no DB access — so `resolveTracks` (the shared client/server
 * resolver, see `$lib/shared/track-selection`) stays the single place this
 * logic lives; this is just the adapter between the DB/probe track shape and
 * `TrackCandidate`, plus the tri-state-safe response shape (see the
 * `RecommendationSchema` note in `api-playback-responses.ts` on why
 * `subtitle_track_index` is omitted rather than `null`).
 */
export function buildTrackRecommendation(
    tracks: { audio: RecommendationAudioTrack[]; subtitles: RecommendationSubtitleTrack[] },
    prefs: LanguagePreferences,
    originalLanguage: string | null,
    fileId?: string,
    selectedAudioIndex?: number,
): NonNullable<LumastraInfoResponse['recommended_tracks']> {
    const fileDefault = tracks.audio.find((a) => a.default)?.index ?? tracks.audio[0]?.index ?? 0;
    const resolved = resolveTracks(
        tracks.audio.map((a) => ({
            index: a.index,
            language: a.language,
            isDefault: a.default,
            title: a.title ?? null,
        })),
        tracks.subtitles.map((sub) => ({
            index: sub.index,
            fileId,
            id: sub.id ?? (fileId ? `${fileId}:${sub.index}` : undefined),
            language: sub.language,
            isForced: sub.forced,
            codec: sub.codec ?? null,
            // Mirrors the audio mapping above (`title: a.title ?? null`) — this
            // was previously dropped here, silently starving the server's
            // isTrackForced() of the title-based forced-subtitle fallback the
            // client (playerStore.svelte.ts) uses via `title: s.displayTitle`.
            title: sub.title ?? null,
        })),
        prefs,
        originalLanguage,
        fileDefault,
        selectedAudioIndex,
    );
    const selectedSubtitle = tracks.subtitles.find(
        (track) => track.index === resolved.subtitle.index,
    );
    return {
        audio_track_index: resolved.audio.index,
        // Sidecars carry stable descriptor IDs; keep embedded numeric compatibility.
        ...(selectedSubtitle?.external && selectedSubtitle.id
            ? { subtitle_id: selectedSubtitle.id }
            : resolved.subtitle.index !== null
              ? { subtitle_track_index: resolved.subtitle.index }
              : {}),
        reason: { audio: resolved.audio.reason, subtitle: resolved.subtitle.reason },
    };
}

function safeJsonParse(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/**
 * Parse a raw `user_playback_preferences` row into the shape `resolveTracks`
 * consumes. A malformed `subtitle_track_hint` JSONB value falls back to "no
 * hint" rather than failing the whole recommendation.
 */
/**
 * Map a `user_playback_preferences` row onto the shared resolver's
 * `LanguagePreferences`. Exported so every caller that resolves tracks reads
 * the row the same way — the preview path resolves audio too, and a second
 * copy of this mapping is exactly how the two would drift apart.
 */
export function parseLanguagePreferences(row: PlaybackPreferencesRow): LanguagePreferences {
    const rawHint =
        typeof row.subtitle_track_hint === 'string'
            ? safeJsonParse(row.subtitle_track_hint)
            : row.subtitle_track_hint;
    const hint = subtitleTrackHintSchema.nullable().safeParse(rawHint);
    return {
        preferOriginalAudio: row.prefer_original_audio ?? false,
        audioLanguage: row.audio_language,
        lastAudioLanguage: row.last_audio_language ?? null,
        subtitleLanguage: row.subtitle_language,
        subtitlesEnabled: row.subtitles_enabled ?? true,
        forcedSubtitlesEnabled: row.forced_subtitles_enabled ?? true,
        subtitleTrackHint: hint.success ? hint.data : null,
    };
}

/**
 * Build the shared decision record for a playability probe or play-session start.
 */
export async function buildPlaybackStartInfo(
    params: LumastraInfoParams,
): Promise<PlaybackStartInfoResult> {
    const { sql, userId, internalId, fileId } = params;

    // 1. Get media item from DB
    const mediaItem = await getMediaItemById(sql, internalId);
    if (!mediaItem) {
        return { ok: false, status: 404, message: m.error_media_not_found() };
    }

    // 2. Get files for this media item
    const fileRows = await getFilesForMediaItem(sql, internalId);

    const versions = fileRows.map((f, i) => ({
        id: f.id,
        label: f.label ?? f.edition ?? null,
        file_path: f.file_path,
        is_default: f.is_default ?? i === 0,
        sort_order: f.sort_order ?? i,
        // Scanner-written; null until the file has been scanned. Emitted as
        // `size_bytes` so a client can size a download before starting it.
        size_bytes: f.file_size_bytes ?? undefined,
    }));

    if (versions.length === 0) {
        return {
            ok: false,
            status: 404,
            message: m.error_no_file_versions(),
        };
    }

    if (fileId && !versions.some((v) => v.id === fileId)) {
        return {
            ok: false,
            status: 404,
            message: m.error_requested_file_not_found(),
        };
    }

    // 3. Select active version based on fileId param
    const activeVersion = fileId
        ? (versions.find((v) => v.id === fileId) ??
          versions.find((v) => v.is_default) ??
          versions[0])
        : (versions.find((v) => v.is_default) ?? versions[0]);
    const activeFileDurationSeconds =
        fileRows.find((f) => f.id === activeVersion.id)?.duration_seconds ?? null;

    // 4. Get resume position (anchor + is_watched plumbed through for the
    //    localStorage resume-cache feature; see localstorage-resume-backup-design.md).
    //    isWatched is sourced from the same memoized watch-state row inside
    //    resolveEffectiveResume — no second DB round-trip needed.
    // NOTE: resume_position_ms in the response now reflects the eligible live
    // session's position when one is fresh, not just the durable user_media_state
    // row. See EffectiveResume.positionMs in effective-playback.ts for the rule.
    const effectiveResume = await resolveEffectiveResume(userId, internalId);
    const resumeAnchor = effectiveResume.anchorMs;
    const isWatched = effectiveResume.isWatched;

    // 4b. Entry point inside a combined multi-episode file (any arity: E20E21,
    //     E01-02-03, ...). Positions on the wire stay FILE-ABSOLUTE — this is the
    //     offset the episode begins at, not a re-based timeline. Segments are only
    //     ever derived for the default file, so an explicitly requested alternate
    //     version must not inherit them.
    const fileSiblings =
        isEpisode(mediaItem.media_type) && activeVersion.is_default
            ? await getFileSiblingEpisodes(sql, internalId)
            : null;
    const entryPoint: EpisodeEntryPoint = fileSiblings
        ? resolveEpisodeEntryPoint(fileSiblings, internalId)
        : { streamStartPositionMs: 0, clientShouldSeek: false };

    // 5. Probe all accessible versions and build version info
    const hlsAvailable = features.ffmpegAvailable;
    const defaultCaps =
        params.clientType === 'native' ? defaultNativeAppCaps() : defaultBrowserCaps();
    if (!params.clientCaps && params.clientType === 'native') {
        logger.warn('Native app requested playback info without explicit caps — using defaults', {
            internalId,
        });
    }
    const baseCaps = params.clientCaps ?? defaultCaps;
    const caps: DeviceCapabilities =
        params.userSelectedMaxBitrate !== undefined || params.userSelectedMaxHeight !== undefined
            ? {
                  ...baseCaps,
                  ...(params.userSelectedMaxBitrate !== undefined
                      ? { userSelectedMaxBitrate: params.userSelectedMaxBitrate }
                      : {}),
                  ...(params.userSelectedMaxHeight !== undefined
                      ? { userSelectedMaxHeight: params.userSelectedMaxHeight }
                      : {}),
              }
            : baseCaps;
    const serverEncode = await buildServerEncodeCaps();
    const versionInfos: LumastraVersion[] = [];
    const trackRecommendations = new Map<
        string,
        NonNullable<LumastraInfoResponse['recommended_tracks']>
    >();
    const deliveryPaths: Record<string, PlaybackDeliveryPaths> = {};
    const externalSubtitlesByFile = new Map<
        string,
        Awaited<ReturnType<typeof getExternalSubtitlesForFile>>
    >();

    // Where the caps came from — echoed back for debugging, and gates which
    // caps are baked into the play_methods URLs below.
    const capsSource =
        params.capsSource ??
        (params.clientCaps
            ? 'caps_param'
            : params.clientType === 'native'
              ? 'default_native'
              : 'default_browser');
    // Only a channel cap the client stated itself (`caps=…mc:N`) is enforced on
    // the encode. A POSTed Jellyfin DeviceProfile's AudioChannels is the
    // minimum across ALL its CodecProfiles (music and per-codec rows included),
    // fine for steering the recommendation but too coarse to force a downmix.
    const bakeChannelCap = capsSource === 'caps_param';

    const versionsToProbe =
        params.readOnlyProbe && fileId ? versions.filter((v) => v.id === fileId) : versions;
    const unreadable: UnreadableVersion[] = [];
    const probeDeadline = Date.now() + PROBE_DEADLINE_MS;
    const markUnreadable = (version: (typeof versions)[number]): void => {
        unreadable.push({
            id: version.id,
            label: version.label,
            is_default: version.is_default,
            size_bytes: version.size_bytes,
            reason: 'probe_failed',
        });
    };
    let selectionPrefs: ReturnType<typeof parseLanguagePreferences> | undefined;
    let originalLanguage: string | null = null;
    try {
        const prefs = await getPlaybackPreferences.one(sql, { userId });
        if (prefs) {
            selectionPrefs = parseLanguagePreferences(prefs);
            originalLanguage =
                (await getMediaItemForWatch(sql, internalId))?.original_language ?? null;
        }
    } catch (error) {
        selectionPrefs = undefined;
        logger.warn('Failed to resolve recommended tracks — client will resolve locally', {
            internalId,
            error,
        });
    }
    for (const version of versionsToProbe) {
        if (params.readOnlyProbe && Date.now() >= probeDeadline) {
            logger.warn('Probe deadline reached — version not read', {
                internalId,
                fileId: version.id,
            });
            markUnreadable(version);
            continue;
        }
        const pathInfo = await resolveMediaPath(
            version.file_path,
            { skipLocalAccessCheck: true },
            sql,
        );
        if (!pathInfo?.isAccessible) {
            logger.debug('Skipping version — path not accessible', {
                internalId,
                fileId: version.id,
                filePath: version.file_path,
            });
            if (params.readOnlyProbe) markUnreadable(version);
            continue;
        }

        const probe = params.readOnlyProbe
            ? await probeMediaFileCached(
                  pathInfo.containerPath,
                  Math.min(PROBE_FILE_TIMEOUT_MS, Math.max(500, probeDeadline - Date.now())),
              )
            : await probeMediaFile(pathInfo.containerPath);
        if (!probe.success) {
            logger.debug('Skipping version — probe failed', {
                internalId,
                fileId: version.id,
                filePath: version.file_path,
            });
            if (params.readOnlyProbe) markUnreadable(version);
            continue;
        }

        // Start must plan the track it will actually deliver. Keep the real
        // track count for routing multi-audio files through switchable HLS, but
        // do not let another compatible track mask the selected track's codec.
        const selectedVersionAudio =
            version.id === activeVersion.id && params.audioStreamIndex !== undefined
                ? probe.audioStreams.find(
                      (track) => track.absoluteIndex === params.audioStreamIndex,
                  )
                : undefined;
        // Stale/relative indices from older clients fall back to this file's
        // default. Plan that exact track so another codec cannot mask it.
        const fallbackAudio =
            probe.audioStreams.find((track) => track.isDefault) ?? probe.audioStreams[0];
        const plannedAudio = selectedVersionAudio
            ? [selectedVersionAudio]
            : version.id === activeVersion.id && params.audioStreamIndex !== undefined
              ? fallbackAudio
                  ? [fallbackAudio]
                  : []
              : probe.audioStreams;

        const maxAudioChannels = plannedAudio.reduce((max, a) => Math.max(max, a.channels ?? 0), 0);

        const mediaInfo: MediaInfo = {
            videoCodec: probe.video?.codec ?? '',
            videoBitDepth: parseBitDepth(probe.video?.pixelFormat),
            videoProfile: probe.video?.profile ?? undefined,
            videoLevel: probe.video?.level ?? undefined,
            width: probe.video?.width ?? undefined,
            height: probe.video?.height ?? undefined,
            // Shared with the HLS job (playback.service) so the planner and the
            // job compare a quality cap against the SAME number.
            bitrate: capComparableBitrate({
                formatBitrate: probe.formatBitrate,
                videoBitrate: probe.video?.bitrate,
            }),
            audioCodecs: plannedAudio.map((a) => a.codec).filter(Boolean),
            audioTrackCount: probe.audioStreams.length,
            audioChannels: maxAudioChannels > 0 ? maxAudioChannels : undefined,
            container: containerFromExtension(pathInfo.containerPath) ?? probe.container ?? '',
            hdr: probe.video?.hdr ?? 'sdr',
        };

        const pathScoped =
            params.pathScopedCaps ??
            (params.clientCaps
                ? pathScopedFromDeviceCaps(params.clientCaps, params.clientType ?? 'browser')
                : params.clientType === 'native'
                  ? defaultNativePathScoped()
                  : defaultBrowserPathScoped());

        const embeddedSubtitleTracks = probe.subtitleStreams.map((s) => {
            const codec = (s.codec ?? '').toLowerCase();
            // Determine subtitle delivery method based on codec and client capabilities
            let method: 'external_vtt' | 'burn_in' | 'client_render' | undefined;
            if (
                pathScoped.subtitleRendering.burnInRequired.some(
                    (bc: string) => normalizeSubtitleCodec(codec) === normalizeSubtitleCodec(bc),
                )
            ) {
                method = 'burn_in';
            } else if (TEXT_CODECS.includes(codec)) {
                method = pathScoped.subtitleRendering.vtt ? 'external_vtt' : 'client_render';
            } else if (
                // Canonical codec lists from subtitle-utils — hand-rolled
                // copies here drifted (missing pgssub/dvdsub) in the past.
                ASS_CODECS.includes(codec) ||
                PGS_CODECS.includes(codec) ||
                VOBSUB_CODECS.includes(codec)
            ) {
                method = 'client_render';
            }
            return {
                index: s.index,
                codec: s.codec,
                language: s.language ?? null,
                title: s.title ?? null,
                default: s.isDefault,
                forced: s.isForced,
                method,
            };
        });
        const externalRows = await getExternalSubtitlesForFile(sql, version.id).catch(() => []);
        externalSubtitlesByFile.set(version.id, externalRows);
        const subtitleFormats = [
            ...(pathScoped.subtitleRendering.vtt ? ['vtt'] : []),
            ...(pathScoped.subtitleRendering.ass ? ASS_CODECS : []),
            ...(pathScoped.subtitleRendering.pgs ? PGS_CODECS : []),
            ...(pathScoped.subtitleRendering.vobsub ? VOBSUB_CODECS : []),
        ];
        const sidecars = buildTimelineDelivery(
            internalId,
            version.id,
            [],
            externalRows,
            params.surface ?? 'internal',
        ).subtitles.filter(
            (descriptor) =>
                subtitleDeliveryMethod(descriptor, undefined, subtitleFormats) !== 'none',
        );
        const recommendationTracks = {
            audio: probe.audioStreams.map((audio) => ({
                index: audio.audioRelativeIndex,
                language: audio.language ?? null,
                default: audio.isDefault,
                title: audio.title,
            })),
            subtitles: [
                ...embeddedSubtitleTracks.filter((subtitle) => subtitle.method !== undefined),
                ...sidecars.map((subtitle) => ({
                    index: subtitle.index,
                    id: subtitle.id,
                    external: true,
                    language: subtitle.language,
                    default: false,
                    forced: subtitle.forced,
                    codec: subtitle.codec,
                    title: subtitle.title,
                })),
            ],
        };
        // Even without a saved preference row, automatic starts must use the
        // ordinary-audio fallback and its matching forced subtitles.
        let preferencePick = buildTrackRecommendation(
            recommendationTracks,
            selectionPrefs ?? DEFAULT_LANGUAGE_PREFERENCES,
            originalLanguage,
            version.id,
        );
        const selectedAudio =
            params.audioStreamIndex !== undefined
                ? (probe.audioStreams.find(
                      (audio) => audio.absoluteIndex === params.audioStreamIndex,
                  ) ??
                  probe.audioStreams.find(
                      (audio) => audio.audioRelativeIndex === preferencePick.audio_track_index,
                  ))
                : (probe.audioStreams.find(
                      (audio) => audio.audioRelativeIndex === preferencePick?.audio_track_index,
                  ) ??
                  probe.audioStreams.find((audio) => audio.isDefault) ??
                  probe.audioStreams[0]);
        if (selectedAudio && params.audioStreamIndex !== undefined)
            preferencePick = buildTrackRecommendation(
                recommendationTracks,
                selectionPrefs ?? DEFAULT_LANGUAGE_PREFERENCES,
                originalLanguage,
                version.id,
                selectedAudio.audioRelativeIndex,
            );
        if (selectionPrefs) trackRecommendations.set(version.id, preferencePick);
        if (selectedAudio) {
            mediaInfo.audioCodecs = [selectedAudio.codec];
            mediaInfo.audioChannels = selectedAudio.channels ?? 0;
        }
        const subtitleIndex =
            params.subtitleId !== undefined
                ? probe.subtitleStreams.find(
                      (subtitle) => `${version.id}:${subtitle.index}` === params.subtitleId,
                  )?.index
                : preferencePick?.subtitle_track_index;
        const selectedSubtitle = probe.subtitleStreams.find(
            (subtitle) => subtitle.index === subtitleIndex,
        );
        const burnIn =
            selectedSubtitle &&
            pathScoped.subtitleRendering.burnInRequired.some(
                (codec) =>
                    normalizeSubtitleCodec(codec) ===
                    normalizeSubtitleCodec(selectedSubtitle.codec ?? ''),
            );
        const deliveryPath = selectDeliveryPath(
            mediaInfo,
            pathScoped,
            caps.canSwitchAudioInDirectPlay,
            mediaInfo.audioTrackCount > 1,
        );
        const planCaps = capsForDeliveryPath(caps, pathScoped, deliveryPath);

        // Note: Each lumastra-info call creates a new plan in Valkey. Hover previews
        // can cause duplicate plans for the same file. The 30-min TTL bounds the
        // memory impact, but a dedup key (fileId + caps hash) could reduce churn.

        const { plan } = await playbackPlanner.createPlan({
            intent: 'play',
            subtitleMethod: burnIn ? 'burn_in' : 'none',
            requestedMethod: params.requestedMethod,
            fileId: version.id,
            mediaInfo,
            caps: planCaps,
            serverEncode,
            deliveryPath,
            enableHdrPreservation: config.ENABLE_HDR10_PRESERVATION === true,
            clientType: params.clientType ?? 'browser',
            persist: !params.readOnlyProbe,
        });

        const recommended = plan.method;
        const outputHdr = (plan.output_hdr ?? 'sdr') as HdrType;
        const transcodeReasons = plan.transcode_reasons;
        const transcodeReasonCodes = plan.transcode_reason_codes ?? [];
        const versionTranscodeCodec = plan.target_video_codec
            ? (plan.target_video_codec as 'h264' | 'hevc' | 'av1')
            : null;
        const playable = isPlayable(recommended, hlsAvailable);
        const planSuffix = plan.plan_id ? `&plan=${plan.plan_id}` : '';
        // Only the video rungs carry caps. audio_only has no video to cap, a
        // bitrate cap there would only squeeze the audio reservation, and its
        // encode is always stereo (full-transcode-strategy's audio-only branch).
        // The bitrate is the tighter of the user's selection and the device's
        // own limit (a DeviceProfile's MaxStreamingBitrate): the planner flags
        // either as a transcode reason, so the encode must honour either.
        const bitrateCaps = [params.userSelectedMaxBitrate, planCaps.maxBitrate].filter(
            (v): v is number => v !== undefined && v > 0,
        );
        const videoRungSuffix =
            planSuffix +
            buildPlayMethodCapSuffix({
                maxBitrate: bitrateCaps.length > 0 ? Math.min(...bitrateCaps) : undefined,
                maxHeight: params.userSelectedMaxHeight,
                maxAudioChannels: bakeChannelCap ? planCaps.maxAudioChannels : undefined,
            });

        deliveryPaths[version.id] = {
            direct: `/api/playback/${internalId}/file?fileId=${version.id}`,
            remux: buildHlsUrl('', internalId, 'copy', 'copy', version.id) + videoRungSuffix,
            audio_transcode:
                buildHlsUrl('', internalId, 'copy', 'aac', version.id) + videoRungSuffix,
            full_transcode:
                buildHlsUrl(
                    '',
                    internalId,
                    (plan.target_video_codec ?? 'h264') as 'h264' | 'hevc' | 'av1',
                    (plan.target_audio_codec ?? 'aac') as 'aac' | 'ac3' | 'opus',
                    version.id,
                ) + videoRungSuffix,
            audio_only: buildHlsUrl('', internalId, 'none', 'aac', version.id) + planSuffix,
        };

        versionInfos.push({
            id: version.id,
            plan_id: plan.plan_id || undefined,
            delivery_path: plan.delivery_path,
            playback_branch: plan.playback_branch,
            hls_audio_mode: plan.hls_audio_mode,
            label: version.label,
            is_default: version.is_default,
            playable,
            recommended,
            output_hdr: outputHdr,
            transcode_reasons: transcodeReasons,
            transcode_reason_codes: transcodeReasonCodes,
            transcode_codec: versionTranscodeCodec,
            duration_ms: probe.duration ? Math.round(probe.duration * 1000) : null,
            size_bytes: version.size_bytes ?? undefined,
            tracks: {
                video: probe.video
                    ? {
                          codec: probe.video.codec,
                          width: probe.video.width,
                          height: probe.video.height,
                          bitrate: probe.video.bitrate ?? undefined,
                          fps: probe.video.fps ?? undefined,
                          hdr: probe.video.hdr ?? 'sdr',
                          dv_profile: probe.video.dvProfile,
                          dv_bl_compat_id: probe.video.dvBlSignalCompatibilityId,
                          container: mediaInfo.container,
                      }
                    : null,
                audio: probe.audioStreams.map((a) => ({
                    // index = 0-based audio-relative (display / -map 0:a:N).
                    // absoluteIndex = canonical wire value for selecting this track.
                    index: a.audioRelativeIndex,
                    absoluteIndex: a.absoluteIndex,
                    codec: a.codec,
                    channels: a.channels,
                    language: a.language ?? null,
                    title: a.title ?? null,
                    default: a.isDefault,
                })),
                subtitles: embeddedSubtitleTracks,
            },
            play_methods: {
                direct: {
                    // The delivery-path probe only checks codec/container membership;
                    // the plan additionally accounts for level/profile, resolution and
                    // bitrate caps. Both must agree before advertising direct play.
                    available: deliveryPath === 'direct_file' && recommended === 'direct',
                },
                remux: {
                    available: hlsAvailable,
                },
                audio_transcode: {
                    available: hlsAvailable,
                },
                full_transcode: {
                    available: hlsAvailable,
                },
                audio_only: {
                    // Unlike the other rungs, this one has nothing to fall back on:
                    // with `-vn` and no audio stream FFmpeg maps nothing, writes no
                    // playlist, and every segment request 503s forever. A source
                    // with zero audio streams (silent film, video-only remux) must
                    // never be offered the rung in the first place.
                    available: hlsAvailable && probe.audioStreams.length > 0,
                },
            },
        });
    }

    // An explicit edition never falls back to another file when its bytes cannot be read.
    if (fileId && !params.readOnlyProbe && !versionInfos.some((version) => version.id === fileId))
        return { ok: false, status: 404, message: 'Selected file unavailable' };
    // 6. Use active version's data for top-level fields
    const active = versionInfos.find((v) => v.id === activeVersion.id) ?? versionInfos[0];
    if (!active) {
        return {
            ok: false,
            status: 500,
            message: m.error_no_accessible_versions(),
        };
    }

    // 7. Query trickplay params (local storage first, then provider plugins like Jellyfin-disk)
    let trickplayInfo: TrickplayInfo | undefined;
    try {
        const { getBestTrickplayInfo } =
            await import('$lib/server/services/trickplay-storage.service.js');
        const activeFilePath = versions.find((v) => v.id === active.id)?.file_path ?? null;
        const trickParams = await getBestTrickplayInfo(active.id, activeFilePath, internalId);
        if (trickParams) {
            trickplayInfo = trickParams;
        }
    } catch (e) {
        logger.warn('Failed to load trickplay params — trickplay unavailable for this item', {
            internalId,
            error: e,
        });
    }

    // 8. Fetch external subtitle files from DB
    const externalSubRows = externalSubtitlesByFile.get(active.id) ?? [];

    const externalSubtitles = externalSubRows.map((sub) => ({
        id: sub.id,
        language: sub.language,
        format: sub.format,
        isForced: sub.is_forced,
        isSdh: sub.is_sdh,
    }));

    // 9. Resolve the audio/subtitle tracks the player should start on. Best
    //    effort — a wrong opinion is worse than none, so ANY failure here
    //    (missing prefs row, DB error) leaves recommended_tracks absent
    //    rather than emitting defaults; the client falls back to resolving
    //    locally in that case.
    const recommendedTracks = trackRecommendations.get(active.id);

    return {
        ok: true,
        deliveryPaths: deliveryPaths[active.id],
        unreadableVersions: unreadable,
        data: {
            playable: active.playable,
            recommended: active.recommended,
            output_hdr: active.output_hdr,
            transcode_reasons: active.transcode_reasons,
            transcode_reason_codes: active.transcode_reason_codes ?? [],
            transcode_codec: active.transcode_codec,
            // A resume past the completion threshold is a finished item: start
            // from the beginning (resumePositionForStart). Judged against the
            // whole file — positions are file-absolute (fileRuntimeMsForResume).
            resume_position_ms: resumePositionForStart({
                positionMs: effectiveResume.positionMs,
                runtimeMs: fileRuntimeMsForResume({
                    // The live probe of the version being played; the scanner's
                    // stored duration when the probe produced none.
                    fileDurationMs:
                        active.duration_ms ??
                        (activeFileDurationSeconds != null
                            ? Number(activeFileDurationSeconds) * 1000
                            : null),
                    siblings: fileSiblings ?? [],
                }),
                mediaType: mediaItem.media_type,
            }),
            resume_anchor: resumeAnchor,
            is_watched: isWatched,
            stream_start_position_ms: entryPoint.streamStartPositionMs,
            client_should_seek: entryPoint.clientShouldSeek,
            episodeNumberStart: entryPoint.episodeNumberStart,
            episodeNumberEnd: entryPoint.episodeNumberEnd,
            duration_ms: active.duration_ms,
            active_file_id: active.id,
            plan_id: active.plan_id,
            delivery_path: active.delivery_path,
            playback_branch: active.playback_branch,
            hls_audio_mode: active.hls_audio_mode,
            tracks: active.tracks,
            subtitles: buildTimelineDelivery(
                internalId,
                active.id,
                active.tracks.subtitles,
                externalSubRows,
                params.surface ?? 'internal',
            ).subtitles,
            recommended_tracks: recommendedTracks,
            play_methods: active.play_methods,
            versions: versionInfos,
            externalSubtitles: externalSubtitles.length > 0 ? externalSubtitles : undefined,
            trickplay: trickplayInfo,
            caps_used: {
                video_codecs: [...caps.videoCodecs],
                audio_codecs: [...caps.audioCodecs],
                hls_audio_codecs: caps.hlsAudioCodecs ? [...caps.hlsAudioCodecs] : undefined,
                containers: [...caps.containers],
                hdr_formats: caps.hdrFormats ? [...caps.hdrFormats] : undefined,
                can_switch_audio: caps.canSwitchAudioInDirectPlay,
                codec_constraints: caps.codecConstraints,
                source: capsSource,
            },
        },
    };
}

/** Private, credential-free paths consumed only by the grant-bearing start service. */
export type PlaybackDeliveryPaths = Record<keyof LumastraVersion['play_methods'], string>;
export type PlaybackStartInfoResult =
    | {
          ok: true;
          data: LumastraInfoResponse;
          deliveryPaths: PlaybackDeliveryPaths;
          /** Versions a read-only probe could not read; always empty for a start. */
          unreadableVersions: UnreadableVersion[];
      }
    | { ok: false; status: number; message: string };
