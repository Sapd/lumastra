// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// =============================================================================
// Terminology Convention
//
// "streams" = raw data from the Jellyfin API (MediaSourceInfo.audioStreams,
//             MediaSourceInfo.subtitleStreams). Read-only input to the player.
// "tracks"  = player-side selected and UI-facing representation of those streams.
//             Stored as indices (currentAudioTrackIndex) so the player can switch
//             without re-fetching playback info. (ref: DL-007)
//
// Both terms refer to the same underlying media data; the distinction clarifies
// data ownership (Jellyfin vs player).
// =============================================================================

import type {
    PlaybackInfo,
    MediaSourceInfo,
    AudioStreamInfo,
    PlaybackVariant,
    SubtitleStreamInfo,
    TranscodingProfile,
    QualityMode,
} from '$lib/types/playback';
import type { TranscodeReason } from '$lib/schemas/playback-plan';
import { safeRandomUUID } from '$lib/utils/safe-uuid';
import { DEFAULT_TRANSCODING_PROFILES, ORIGINAL_PROFILE, AUTO_PROFILE } from '$lib/types/playback';
import { isSameQuality } from './playback-decision';
import { normalizeLanguage, languagesMatch, isUnknownLanguage } from './language-utils';
import {
    resolveTracks,
    isCommentaryOrADTrack,
    audioTrackRole,
    matchSubtitleHint,
    type AudioSelectionReason,
    type SubtitleSelectionReason,
    type TrackResolution,
} from '$lib/shared/track-selection';
import {
    updatePreference,
    updatePreferences,
    getPreferences,
    staleSelectionPreferences,
    type SelectionPreferenceSnapshot,
} from './preferences-sync.svelte';
import { formatTime, isNextItemPromptDue } from './player-utils';
import { formatEpisodeRangeCode } from './playback-display';
import { isEpisode } from '$lib/shared/media-types';
import { formatHdrLabel as formatLumastraHdr } from '$lib/shared/hdr-labels';
import { hdrBadgeLabel } from './hdr-details';
import type {
    TimelineChapter,
    TimelineSegment,
    NextEpisodeInfo,
    NextPlaylistItemInfo,
} from '$lib/types/playback';
import type { LiveTvQualityState } from './livetv-quality.js';
import { bestLanguageMatch, languageMatchScore } from '$lib/shared/language-codes';
import { WorkerTimer } from '$lib/utils/worker-timer';

// Re-export for convenience
export {
    DEFAULT_TRANSCODING_PROFILES,
    ORIGINAL_PROFILE,
    AUTO_PROFILE,
    AUDIO_ONLY_PROFILE,
} from '$lib/types/playback';
export type { QualityMode } from '$lib/types/playback';

// ============================================
// Types
// ============================================

export interface PlayerState {
    // Playback state
    isPlaying: boolean;
    isPaused: boolean;
    isBuffering: boolean;
    isLoading: boolean;
    isSeeking: boolean;
    isReconnecting: boolean;
    /** The most specific cause available for the current recovery attempt.
     *  A network failure is deliberately not attributed to either endpoint:
     *  browsers cannot distinguish a user's internet from a server/proxy drop. */
    reconnectCause: 'network' | 'session-expired' | 'stall' | null;
    /** Evidence-based detail shown below the reconnect status. */
    reconnectDiagnostic: string | null;
    pausedByUser: boolean;
    reconnectNeedsTap: boolean;
    /**
     * True while a Lumastra version change is in flight: from teardown of the
     * old HLS/direct stream through to playback resuming at the saved position.
     * Drives the /admin-style top progress bar so the user sees a dedicated
     * "switching version" hint that doesn't compete with the centre spinner.
     */
    isVersionSwitching: boolean;
    playheadTime: number;
    currentTime: number;
    duration: number;
    bufferedEnd: number;
    volume: number;
    isMuted: boolean;
    isFullscreen: boolean;
    playbackRate: number;

    // Media info
    itemId: string | null;
    title: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    mediaType: 'movie' | 'episode' | 'series' | 'tvchannel' | null;
    originalLanguage: string | null;
    isLive: boolean;
    liveTvQuality: LiveTvQualityState | null;

    // Current selection
    currentMediaSource: MediaSourceInfo | null;
    currentAudioTrackIndex: number;
    currentSubtitleTrackIndex: number | null;
    currentQualityProfile: TranscodingProfile | null;
    previousQualityProfile: TranscodingProfile | null;
    forcedSubtitlesEnabled: boolean;
    forceSubtitleBurnIn: boolean;

    // Adaptive bitrate
    qualityMode: QualityMode;
    measuredBandwidth: number | null;
    adaptiveTargetBitrate: number | null;

    // Available options
    playbackInfo: PlaybackInfo | null;

    // Session info
    playSessionId: string | null;
    playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode' | 'AudioOnly';
    playbackDeliveryInfo: PlaybackDeliveryInfo | null;

    // HDR playback info
    hdrInfo: {
        sourceFormat: string | null;
        outputFormat: string | null;
        isToneMapped: boolean;
        /** Real Dolby Vision profile from the probe (5, 7, 8, 10), when known. */
        dvProfile?: number;
        /** DV base-layer compatibility id (0 none, 1 HDR10, 2 SDR, 4 HLG). */
        dvBlCompatId?: number;
    } | null;

    // Transcoding info for display
    transcodingInfo: {
        videoCodec: string;
        videoBitrate: string;
        resolution: string;
        isTranscoding: boolean;
        isAudioTranscoding: boolean;
        transcodeReasons: string[];
        transcodeReasonCodes: TranscodeReason[];
    } | null;

    // Transcode progress from server heartbeat
    transcodeProgress: {
        progressPercent: number;
        segmentsReady: number;
        totalSegments: number;
        elapsedSeconds: number;
        fps?: number;
        speed?: number;
        /** FFmpeg paused by the server's transcode throttle (far enough ahead). */
        throttled?: boolean;
        /** Seconds transcoded ahead of the newest segment the player requested. */
        bufferAheadSeconds?: number;
        /** Wall-clock seconds until the transcode finishes at its current speed. */
        etaSeconds?: number;
        /** Transcoded parts of the file in % (progressPercent is their sum). */
        coveredRanges?: { start: number; end: number }[];
        /** Where the encoder is, % of the file. */
        encoderPercent?: number;
        /** Client clock when this reading arrived — lets the readout tick
         *  elapsed/ETA between polls instead of jumping. */
        receivedAt?: number;
        // Widened alongside the server's TranscodeDisplayType: the value comes
        // from the shared active_transcode_jobs table, so a non-video kind can
        // arrive here. formatTranscodeType() has a default arm for it.
        transcodeType?:
            | 'remux'
            | 'audio-only'
            | 'audio-drop'
            | 'full'
            | 'tonemapping'
            | 'audiobook-remux'
            | 'unknown';
        videoAction?: 'copy' | 'transcode';
        audioAction?: 'copy' | 'transcode';
        isHardwareAccelerated?: boolean;
        gpuEncoder?: string;
        gpuDecoder?: string;
        hdrTonemapMode?: 'hardware' | 'software' | 'n/a';
        /** The server's encode has been below real time for a while. */
        slowReason?: 'gpu_busy' | 'cpu_slow';
        /** GPU encoder the server fell back from to software (no free session). */
        softwareFallbackFrom?: string;
    } | null;

    // Real-time download bandwidth (link speed — bytes over transfer time)
    downloadBandwidth: number | null;

    // Bitrate of the stream being played (segment bytes over media seconds)
    streamBitrate: number | null;

    // Resolution actually decoded ("1280x720"), from the media element
    decodedResolution: string | null;

    // Measured decoded-frame rate (fps), sampled while actively playing
    liveFps: number | null;

    // Error state
    error: string | null;

    // UI state
    showControls: boolean;

    // Toast notification
    toast: {
        message: string;
        type: 'up' | 'down' | 'info';
    } | null;
}

export interface PlaybackDeliveryInfo {
    type: 'direct' | 'hls';
    hlsClient?: 'hls.js' | 'native';
    hlsContainer?: 'fmp4' | 'mpegts' | 'unknown';
    hlsAudioMode?: 'demux' | 'muxed' | 'unknown';
}

// Effective next item type (moved from player-derived)
export type EffectiveNextItem = {
    type: 'playlist' | 'episode';
    itemId: string;
    internalId?: string;
    title: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    hasPrimaryImage: boolean;
    overview?: string;
    playlistId?: number;
    position?: number;
    isNewSeason?: boolean;
} | null;

// Constants (moved from player-derived)
export const LIVE_EDGE_THRESHOLD_SECONDS = 15;

/**
 * The server's starting tracks in the player's relative display indices.
 * The probe adapter translates the API's absolute audio stream index here.
 */
export interface TrackRecommendation {
    preferenceSnapshot?: SelectionPreferenceSnapshot;
    /** tracks.audio[].index — audio-relative, matches mediaSource.audioStreams[].index. */
    audio_track_index: number;
    /** tracks.subtitles[].index. Absent means the server resolved to "no subtitle track". */
    subtitle_track_index?: number;
    reason: {
        audio: AudioSelectionReason;
        subtitle: SubtitleSelectionReason;
    };
}

// ============================================
// Helper: Detect forced subtitle
// ============================================

function isForcedSubtitle(sub: SubtitleStreamInfo): boolean {
    if (sub.isForced) return true;
    const title = sub.displayTitle?.toLowerCase() || '';
    return title.includes('forced');
}

function getDefaultAudioTrackIndex(mediaSource: MediaSourceInfo): number {
    const ordinary = mediaSource.audioStreams.filter(
        (track) => !isCommentaryOrADTrack(track.title ?? track.displayTitle),
    );
    const candidates = ordinary.length ? ordinary : mediaSource.audioStreams;
    return (
        candidates.find((track) => track.index === mediaSource.defaultAudioStreamIndex)?.index ??
        candidates.find((track) => track.isDefault)?.index ??
        candidates[0]?.index ??
        0
    );
}

function getDefaultSubtitleTrackIndex(mediaSource: MediaSourceInfo): number | null {
    return (
        mediaSource.subtitleStreams
            .filter((track) => track.deliveryMethod !== 'Drop')
            .find((s) => s.index === mediaSource.defaultSubtitleStreamIndex && !isForcedSubtitle(s))
            ?.index ??
        mediaSource.subtitleStreams
            .filter((track) => track.deliveryMethod !== 'Drop')
            .find((s) => s.isDefault && !isForcedSubtitle(s))?.index ??
        null
    );
}

export function resolveAudioTrackIndexForMediaSource(
    mediaSource: MediaSourceInfo,
    currentAudioTrackIndex: number,
    previousAudioTrack?: AudioStreamInfo,
    options?: { sameFile?: boolean },
): number {
    // Within the same file the absolute stream index identifies the selected
    // track, even when refreshed metadata reorders same-language tracks.
    if (options?.sameFile && previousAudioTrack?.absoluteIndex !== undefined) {
        const selected = mediaSource.audioStreams.find(
            (track) => track.absoluteIndex === previousAudioTrack.absoluteIndex,
        );
        if (selected) return selected.index;
    }

    // Language match wins over raw index equality — see the subtitle
    // resolver for the reasoning (Lumastra multi-version switches point at
    // a different file where index N may be a totally unrelated track).
    if (previousAudioTrack) {
        const prevLang = previousAudioTrack.language || previousAudioTrack.languageCode;

        if (!isUnknownLanguage(prevLang)) {
            const previousRole = audioTrackRole(
                previousAudioTrack.title ?? previousAudioTrack.displayTitle,
            );
            const candidates = mediaSource.audioStreams.filter(
                (track) => audioTrackRole(track.title ?? track.displayTitle) === previousRole,
            );
            const title = previousAudioTrack.title?.trim().toLowerCase();
            const score = (track: AudioStreamInfo): number =>
                languageMatchScore(track.language || track.languageCode, prevLang) * 64 +
                (title && track.title?.trim().toLowerCase() === title ? 16 : 0) +
                (track.codec === previousAudioTrack.codec ? 4 : 0) +
                (track.channels === previousAudioTrack.channels ? 2 : 0);
            const matchingTrack = candidates
                .filter((track) => languagesMatch(track.language || track.languageCode, prevLang))
                .reduce<AudioStreamInfo | undefined>(
                    (best, track) => (!best || score(track) > score(best) ? track : best),
                    undefined,
                );
            if (matchingTrack) {
                return matchingTrack.index;
            }
            // Previous language is known and does not exist here — fall to
            // default rather than reusing the raw index, which would silently
            // switch the user to a different language.
            return getDefaultAudioTrackIndex(mediaSource);
        }

        // Previous track had no language tag — language matching is
        // impossible. For the SAME file (e.g. mid-playback restart for a
        // quality change), the audio-relative index is stable so we fall
        // through to index-based preservation; that handles the common
        // "untagged English audio on a German BD" case where the user
        // explicitly picked the untagged track and we shouldn't reset
        // them to default. For a DIFFERENT file (multi-version switch),
        // index 1 in the old file may map to unrelated content in the
        // new file, so we fall to default instead.
        if (!options?.sameFile) {
            return getDefaultAudioTrackIndex(mediaSource);
        }
    }

    if (mediaSource.audioStreams.some((track) => track.index === currentAudioTrackIndex)) {
        return currentAudioTrackIndex;
    }

    return getDefaultAudioTrackIndex(mediaSource);
}

export function resolveSubtitleTrackIndexForMediaSource(
    mediaSource: MediaSourceInfo,
    currentSubtitleTrackIndex: number | null,
    previousSubtitleTrack: SubtitleStreamInfo | null,
    options?: { previousFileId?: string },
): number | null {
    if (currentSubtitleTrackIndex === null) {
        return null;
    }

    // Identity match (language + forced) wins over raw index equality.
    // Lumastra multi-version switches point at a different file where
    // index N may be an unrelated track — e.g. PGS de at index 2 in v1
    // vs. SRT en at index 2 in v2. Same-index-same-identity still
    // reliably keeps the selection for in-file quality switches.
    if (previousSubtitleTrack) {
        const identityMatch = matchSubtitleHint(
            mediaSource.subtitleStreams
                .filter((track) => track.deliveryMethod !== 'Drop')
                .map((track) => ({
                    ...track,
                    fileId: mediaSource.id,
                    title: track.title ?? track.displayTitle,
                    language: track.language || track.languageCode,
                })),
            {
                language:
                    previousSubtitleTrack.language || previousSubtitleTrack.languageCode || '',
                isForced: isForcedSubtitle(previousSubtitleTrack),
                codec: previousSubtitleTrack.codec ?? null,
                title: previousSubtitleTrack.title ?? previousSubtitleTrack.displayTitle,
                fileId: options?.previousFileId,
                trackId: previousSubtitleTrack.id,
            },
        );
        if (identityMatch) {
            return identityMatch.index;
        }
        // Previous identity is known and does not exist here — fall straight
        // to default. Reusing the same raw index would silently hand the
        // user a subtitle in a language they didn't pick.
        return getDefaultSubtitleTrackIndex(mediaSource);
    }

    if (
        mediaSource.subtitleStreams.some(
            (track) => track.index === currentSubtitleTrackIndex && track.deliveryMethod !== 'Drop',
        )
    ) {
        return currentSubtitleTrackIndex;
    }

    return getDefaultSubtitleTrackIndex(mediaSource);
}

// ============================================
// PlayerStore — Svelte 5 runes class
// ============================================

/** What the mounted player exposes to code outside its component tree. */
export interface PlayerExternalControl {
    isReady: () => boolean;
    seekTo: (seconds: number) => void;
    sessionId: () => string | null;
}

export class PlayerStore {
    // ========== Reactive state ($state) ==========

    isPlaying = $state(false);
    isPaused = $state(true);
    isBuffering = $state(false);
    isLoading = $state(true);
    // Reactive "video reached its end" flag (mirrors the controller's private
    // hasEnded). Drives the watch-party guest "waiting for host" affordance.
    hasEnded = $state(false);
    isSeeking = $state(false);
    // Monotonic intent marker: distinct seeks can start while already seeking.
    // Timeline previews observe this rather than ordinary playhead updates.
    seekRevision = $state(0);
    isVersionSwitching = $state(false);
    /**
     * Two-tier time signals to minimize reactive fan-out:
     *
     * playheadTime — raw video time, updated on every timeupdate (~4x/sec).
     *   Drives progressPercent and activeSegment which need sub-second accuracy.
     *
     * currentTime — display time, updated once per displayed second.
     *   Drives formatted time strings, showNextItemPrompt, isAtLiveEdge, and annotations.
     */
    playheadTime = $state(0);
    currentTime = $state(0);
    private _lastDisplaySecond = -1;
    duration = $state(0);
    bufferedEnd = $state(0);
    volume = $state(1);
    isMuted = $state(false);
    isFullscreen = $state(false);
    playbackRate = $state(1);

    itemId = $state<string | null>(null);
    title = $state('');
    seriesName = $state<string | undefined>(undefined);
    seasonNumber = $state<number | undefined>(undefined);
    episodeNumber = $state<number | undefined>(undefined);
    episodeStartNumber = $state<number | undefined>(undefined);
    episodeEndNumber = $state<number | undefined>(undefined);
    mediaType = $state<'movie' | 'episode' | 'series' | 'tvchannel' | null>(null);
    /**
     * The title's original production language (ISO 639-1), resolved server-side
     * up the episode → season → series chain. Drives the "prefer original
     * language" audio preference; null when no provider knows it.
     */
    originalLanguage = $state<string | null>(null);
    isLive = $state(false);
    liveTvQuality = $state<LiveTvQualityState | null>(null);

    currentMediaSource = $state<MediaSourceInfo | null>(null);
    currentAudioTrackIndex = $state(0);
    /**
     * Why the CURRENT audio track was chosen automatically, or null once the
     * viewer picks a track by hand. The track picker renders this so an
     * automatic pick is never silent — a preference that keeps overriding the
     * viewer should be visible and reachable, not something they only notice by
     * re-selecting the same language every episode.
     */
    audioSelectionReason = $state<AudioSelectionReason | null>(null);
    /** Normalized language behind `audioSelectionReason`, when one drove it. */
    audioSelectionLanguage = $state<string | null>(null);
    currentSubtitleTrackIndex = $state<number | null>(null);
    /** Whether the current subtitle was picked by the viewer this session (vs.
     *  resolved automatically). An automatic forced pick follows the audio
     *  language on an audio switch; a hand-picked one is left alone. */
    subtitlePickedByUser = false;
    subtitleSelectionRevision = $state(0);
    currentQualityProfile = $state<TranscodingProfile | null>(null);
    /**
     * The profile that was active immediately before switching to
     * AUDIO_ONLY_PROFILE. Used for explicit-selection fallback and
     * watch-party mutual exclusion when leaving audio-only.
     */
    previousQualityProfile = $state<TranscodingProfile | null>(null);
    forcedSubtitlesEnabled = $state(true);
    forceSubtitleBurnIn = $state(false);

    qualityMode = $state<QualityMode>('original');
    measuredBandwidth = $state<number | null>(null);
    adaptiveTargetBitrate = $state<number | null>(null);

    playbackInfo = $state<PlaybackInfo | null>(null);
    // Effective lead (seconds) for the next-episode prompt relative to the
    // outro/credits start. Positive = earlier, negative = later, 0 = at credits
    // start. Seeded from admin config, overridden by the user's per-account
    // preference (synced reactively from VideoPlayer).
    nextItemPromptLeadSeconds = $state(0);
    // Whether the next-episode prompt may show at all (user preference). When
    // false the prompt — and its autoplay countdown — never appear.
    showNextEpisodePopup = $state(true);
    // For episodes with NO detected outro segment: how many seconds before the
    // end the prompt appears. 0 disables the no-outro fallback prompt entirely.
    noOutroFallbackSeconds = $state(30);
    playSessionId = $state<string | null>(null);
    /** Jellyfin-style shorthand, plus `'AudioOnly'` for the audio-only quality
     *  rung. `'AudioOnly'` cannot be derived from the media source (it is a
     *  client-side quality selection, not a source capability), so
     *  `initialize()` never produces it — every writer that runs after
     *  `initialize()` must re-apply it. See setPlayMethod(). */
    playMethod = $state<'DirectPlay' | 'DirectStream' | 'Transcode' | 'AudioOnly'>('DirectPlay');
    playbackDeliveryInfo = $state<PlaybackDeliveryInfo | null>(null);
    /** Mirrors the active probe version's audio-only availability so
     *  QualitySelector can hide the audio-only rung when the source has no
     *  audio stream, instead of offering a quality that immediately errors
     *  and reverts. Defaults to true (no gating) for sources that never carry
     *  this signal — non-Lumastra playback and servers older than the field. */
    audioOnlyAvailable = $state(true);

    hdrInfo = $state<PlayerState['hdrInfo']>(null);
    transcodingInfo = $state<PlayerState['transcodingInfo']>(null);
    transcodeProgress = $state<PlayerState['transcodeProgress']>(null);
    /**
     * The encoder notice from the startup probe poll (PlayerOverlay), before
     * the first heartbeat brings a progress reading. Read together with
     * transcodeProgress by the reconnect controller (encoderExplainsWaiting).
     */
    startupEncoderNotice = $state<{
        slowReason?: 'gpu_busy' | 'cpu_slow';
        softwareFallbackFrom?: string;
    } | null>(null);
    downloadBandwidth = $state<number | null>(null);
    streamBitrate = $state<number | null>(null);
    decodedResolution = $state<string | null>(null);
    /** Measured decoded-frame rate, sampled ~1x/sec by PlayerController while
     *  actively playing. Null until the first sample lands or when the
     *  browser doesn't support `getVideoPlaybackQuality()`. */
    liveFps = $state<number | null>(null);

    error = $state<string | null>(null);
    /** True while the player is in a recoverable reconnect loop (drives the
     *  small non-blocking badge instead of the blocking center overlay). */
    isReconnecting = $state(false);
    reconnectCause = $state<PlayerState['reconnectCause']>(null);
    reconnectDiagnostic = $state<string | null>(null);
    /** True when the user deliberately paused (vs a stall/programmatic pause).
     *  Auto-resume after reconnect is gated on this being false. */
    pausedByUser = $state(false);
    /** True when a post-reconnect play() was blocked by autoplay policy and
     *  the user must tap to resume. */
    reconnectNeedsTap = $state(false);
    showControls = $state(true);
    toast = $state<PlayerState['toast']>(null);

    // Lumastra file variants for the version picker (separate from Jellyfin mediaSources)
    playbackVariants = $state<PlaybackVariant[]>([]);
    activeVariantId = $state<string | null>(null);

    // ========== Private non-reactive fields ==========

    private _controlsTimeout: ReturnType<typeof setTimeout> | null = null;
    private _progressTimer: WorkerTimer | null = null;
    private _toastTimeout: ReturnType<typeof setTimeout> | null = null;

    // ========== Derived values ($derived) ==========

    /**
     * Live TV: the STATION id the watch URL carries (`playbackInfo.itemId`; a backup-group id for
     * grouped channels). `itemId` above is the shown FEED's media item id. The station-keyed
     * endpoints (`/api/livetv/stations/{id}/...`, preferred feed, retry budget) take this one.
     */
    readonly liveTvStationId = $derived(this.playbackInfo?.itemId ?? this.itemId);

    // Available media sources (versions)
    readonly mediaSources = $derived(this.playbackInfo?.mediaSources ?? []);

    // Available audio tracks
    readonly audioTracks = $derived(this.currentMediaSource?.audioStreams ?? []);

    // Available subtitle tracks
    readonly subtitleTracks = $derived(
        (this.currentMediaSource?.subtitleStreams ?? []).filter(
            (track) => track.deliveryMethod !== 'Drop',
        ),
    );

    // Current audio track info
    readonly currentAudioTrack = $derived(
        this.audioTracks.find((t) => t.index === this.currentAudioTrackIndex) ?? null,
    );

    // Current subtitle track info
    readonly currentSubtitleTrack = $derived.by(() =>
        this.currentSubtitleTrackIndex !== null
            ? (this.subtitleTracks.find((t) => t.index === this.currentSubtitleTrackIndex) ?? null)
            : null,
    );

    // Video info (first video stream)
    readonly videoInfo = $derived(this.currentMediaSource?.videoStreams[0] ?? null);

    // HDR format label for display
    readonly hdrFormatLabel = $derived.by(() => {
        if (this.hdrInfo) {
            // Source with its real DV profile, plus "→ output" whenever what plays
            // differs from the file (a DV re-encode is HDR10, not DV).
            return (
                hdrBadgeLabel(this.hdrInfo) ??
                formatLumastraHdr(this.hdrInfo.sourceFormat) ??
                this.hdrInfo.sourceFormat
            );
        }

        const video = this.videoInfo;
        if (!video) return null;

        const rangeType = video.videoRangeType || '';
        const videoRange = video.videoRange || '';

        if (rangeType === 'HDR10Plus' || videoRange.includes('HDR10+')) return 'HDR10+';
        if (rangeType === 'DOVIWithHDR10') return 'DV P8';
        if (rangeType === 'DOVIWithSDR') return 'DV P5';
        if (rangeType === 'DOVIWithHLG') return 'DV HLG';
        if (rangeType === 'DOVI') return 'DV P7';
        if (rangeType === 'HLG' || videoRange === 'HLG') return 'HLG';
        if (rangeType === 'HDR10' || videoRange === 'HDR10') return 'HDR10';
        if (videoRange.includes('HDR') || videoRange.includes('Dolby Vision')) return 'HDR';

        return null;
    });

    // Progress percentage (0-100)
    readonly progressPercent = $derived(
        this.duration > 0 ? (this.playheadTime / this.duration) * 100 : 0,
    );

    // Buffered percentage (0-100)
    readonly bufferedPercent = $derived(
        this.duration > 0 ? (this.bufferedEnd / this.duration) * 100 : 0,
    );

    // Formatted times
    readonly formattedCurrentTime = $derived(formatTime(this.currentTime));
    readonly formattedDuration = $derived(formatTime(this.duration));
    readonly formattedRemainingTime = $derived(
        `-${formatTime(Math.max(0, this.duration - this.currentTime))}`,
    );

    // Is the player at the live edge
    readonly isAtLiveEdge = $derived.by(() => {
        if (!this.isLive) return true;
        if (this.duration <= 0) return true;
        if (!isFinite(this.duration)) return true;
        const distanceFromLive = this.duration - this.currentTime;
        return distanceFromLive <= LIVE_EDGE_THRESHOLD_SECONDS;
    });

    // Full title (including series info for episodes, channel for LiveTV)
    readonly fullTitle = $derived.by(() => {
        if (this.mediaType === 'tvchannel') {
            return this.title;
        }
        if (isEpisode(this.mediaType) && this.seriesName) {
            // Range start comes from the FILE (episodeStartNumber), not from the
            // episode that was opened — see formatEpisodeRangeCode.
            const seasonEp = formatEpisodeRangeCode(
                this.seasonNumber,
                this.episodeStartNumber ?? this.episodeNumber,
                this.episodeEndNumber,
            );
            return `${this.seriesName} - ${seasonEp} - ${this.title}`;
        }
        return this.title;
    });

    // Media segments (intro, outro, etc.)
    chapters = $state<TimelineChapter[]>([]);
    mediaSegments = $state<TimelineSegment[]>([]);
    trickplayManifestHref = $state<string | null>(null);
    trickplayVariants = $state<Array<{ width: number; manifestHref: string }>>([]);

    // Next episode info
    readonly nextEpisode = $derived(
        (this.playbackInfo?.nextEpisode ?? null) as NextEpisodeInfo | null,
    );

    // Playlist context info
    readonly playlistContext = $derived(this.playbackInfo?.playlistContext ?? null);

    // Next playlist item info
    readonly nextPlaylistItem = $derived(
        (this.playbackInfo?.nextPlaylistItem ?? null) as NextPlaylistItemInfo | null,
    );

    // Whether we're in playlist mode
    readonly isPlaylistMode = $derived(!!this.playbackInfo?.playlistContext);

    // Effective next item - playlist item takes precedence over episode
    readonly effectiveNextItem: EffectiveNextItem = $derived.by(() => {
        const playlistItem = this.playbackInfo?.nextPlaylistItem;
        const episodeItem = this.playbackInfo?.nextEpisode;

        if (this.playbackInfo?.playlistContext && playlistItem) {
            return {
                type: 'playlist' as const,
                itemId: playlistItem.itemId,
                internalId: playlistItem.internalId,
                title: playlistItem.title,
                seriesName: playlistItem.seriesName,
                seasonNumber: playlistItem.seasonNumber,
                episodeNumber: playlistItem.episodeNumber,
                hasPrimaryImage: playlistItem.hasPrimaryImage,
                playlistId: playlistItem.playlistId,
                position: playlistItem.position,
                isNewSeason: false,
            };
        }

        if (episodeItem) {
            return {
                type: 'episode' as const,
                itemId: episodeItem.itemId,
                internalId: episodeItem.internalId,
                title: episodeItem.title,
                seriesName: episodeItem.seriesName,
                seasonNumber: episodeItem.seasonNumber,
                episodeNumber: episodeItem.episodeNumber,
                hasPrimaryImage: episodeItem.hasPrimaryImage,
                overview: episodeItem.overview,
                playlistId: undefined,
                position: undefined,
                isNewSeason: episodeItem.isNewSeason,
            };
        }

        return null;
    });

    // Active segment at current time (for skip buttons)
    // Uses playheadTime for sub-second accuracy at segment boundaries.
    readonly activeSegment = $derived.by(() => {
        const segments = this.mediaSegments;
        if (!segments || segments.length === 0) return null;

        const currentTime = this.playheadTime * 1000;
        const SHOW_EARLY_MS = 500;
        const KEEP_VISIBLE_MS = 700;

        for (const segment of segments) {
            const effectiveStart = segment.startMs - SHOW_EARLY_MS;
            const effectiveEnd = segment.endMs + KEEP_VISIBLE_MS;
            if (currentTime >= effectiveStart && currentTime < effectiveEnd) {
                return segment;
            }
        }

        return null;
    });

    // Show next item prompt (near end of video)
    readonly showNextItemPrompt = $derived.by(() => {
        // User opted out of the next-episode prompt entirely.
        if (!this.showNextEpisodePopup) return false;
        // Live TV has no meaningful "next item" prompt.
        if (this.isLive) return false;

        const hasNextPlaylistItem = !!this.playbackInfo?.nextPlaylistItem;
        const hasNextEpisode = !!this.playbackInfo?.nextEpisode;

        if (!hasNextPlaylistItem && !hasNextEpisode) return false;

        const segments = this.mediaSegments ?? [];
        return isNextItemPromptDue({
            currentTime: this.currentTime,
            duration: this.duration,
            outroStarts: segments.filter((s) => s.type === 'outro').map((s) => s.startMs / 1000),
            leadSeconds: this.nextItemPromptLeadSeconds,
            noOutroFallbackSeconds: this.noOutroFallbackSeconds,
        });
    });

    // Alias for backwards compatibility
    get showNextEpisodePrompt(): boolean {
        return this.showNextItemPrompt;
    }

    // ========== Methods ==========

    // Initialize with playback info
    initialize(playbackInfo: PlaybackInfo, promptLeadSeconds = 0): void {
        this.chapters = [];
        this.mediaSegments = [];
        this.trickplayVariants = [];
        this.trickplayManifestHref = null;
        this.nextItemPromptLeadSeconds = promptLeadSeconds;
        const mediaSource = playbackInfo.mediaSources[0] || null;

        const defaultAudioIndex = mediaSource ? getDefaultAudioTrackIndex(mediaSource) : 0;

        const defaultSubtitleIndex = mediaSource ? getDefaultSubtitleTrackIndex(mediaSource) : null;

        const durationSeconds = Math.max(0, playbackInfo.runTimeTicks / 10000000);
        const resumeSeconds = Math.max(0, playbackInfo.userData.playbackPositionTicks / 10000000);

        this.isLoading = false;
        this.itemId = playbackInfo.internalId ?? playbackInfo.itemId;
        this.title = playbackInfo.title;
        this.seriesName = playbackInfo.seriesName;
        this.seasonNumber = playbackInfo.seasonNumber;
        this.episodeNumber = playbackInfo.episodeNumber;
        this.episodeStartNumber = playbackInfo.episodeStartNumber;
        this.episodeEndNumber = playbackInfo.episodeEndNumber;
        this.mediaType = playbackInfo.mediaType;
        this.originalLanguage = playbackInfo.originalLanguage ?? null;
        this.isLive = playbackInfo.isLive || false;
        this.duration = durationSeconds;
        this.playheadTime = resumeSeconds;
        this.currentTime = resumeSeconds;
        this._lastDisplaySecond = Math.floor(resumeSeconds);
        this.playbackInfo = playbackInfo;
        this.currentMediaSource = mediaSource;
        this.currentAudioTrackIndex = defaultAudioIndex;
        this.currentSubtitleTrackIndex = defaultSubtitleIndex;
        this.subtitlePickedByUser = false;
        this.playSessionId = playbackInfo.playSessionId;
        this.playMethod = mediaSource?.supportsDirectPlay
            ? 'DirectPlay'
            : mediaSource?.supportsDirectStream
              ? 'DirectStream'
              : 'Transcode';
        this.playbackDeliveryInfo = null;
        this.error = null;
    }

    // Merge playlist context into existing playbackInfo without resetting player state
    setPlaylistContext(
        playlistContext: PlaybackInfo['playlistContext'],
        nextPlaylistItem?: PlaybackInfo['nextPlaylistItem'],
    ): void {
        if (!this.playbackInfo) return;
        this.playbackInfo = {
            ...this.playbackInfo,
            playlistContext,
            nextPlaylistItem,
        };
    }

    // Merge a resolved next-episode into existing playbackInfo without resetting
    // player state. Used by advanceEpisodeInPlace() (audio-only in-place episode
    // advance), which resolves the FOLLOWING episode in the background — via the
    // ordered episode-list endpoints, not the page-load resolver — after the
    // swap itself has already completed, and patches it in once ready so the
    // in-place chain can continue past one hop.
    setNextEpisode(nextEpisode: PlaybackInfo['nextEpisode']): void {
        if (!this.playbackInfo) return;
        this.playbackInfo = {
            ...this.playbackInfo,
            nextEpisode,
        };
    }

    // Update current time (two-tier: playheadTime always, currentTime once per second)
    setCurrentTime(time: number): void {
        this.playheadTime = time;
        const second = Math.floor(time);
        if (second !== this._lastDisplaySecond) {
            this._lastDisplaySecond = second;
            this.currentTime = time;
        }
    }

    // Update duration (only if changed to avoid unnecessary re-renders)
    setDuration(time: number): void {
        if (Math.abs(this.duration - time) < 0.5) return;
        this.duration = time;
    }

    // Update buffered end (only if changed significantly)
    setBufferedEnd(time: number): void {
        if (Math.abs(this.bufferedEnd - time) < 0.5) return;
        this.bufferedEnd = time;
    }

    // Set playing state
    setPlaying(isPlaying: boolean): void {
        this.isPlaying = isPlaying;
        this.isPaused = !isPlaying;
    }

    // Set end-of-video state (reset when a new source loads)
    setEnded(hasEnded: boolean): void {
        this.hasEnded = hasEnded;
    }

    // Set buffering state
    setBuffering(isBuffering: boolean): void {
        this.isBuffering = isBuffering;
    }

    // Set seeking state
    setSeeking(isSeeking: boolean): void {
        if (isSeeking) this.seekRevision++;
        this.isSeeking = isSeeking;
    }

    // Set loading state
    setLoading(isLoading: boolean): void {
        this.isLoading = isLoading;
    }

    setReconnecting(
        isReconnecting: boolean,
        cause: PlayerState['reconnectCause'] = null,
        diagnostic: string | null = null,
    ): void {
        this.isReconnecting = isReconnecting;
        this.reconnectCause = isReconnecting ? cause : null;
        this.reconnectDiagnostic = isReconnecting ? diagnostic : null;
        if (!isReconnecting) this.reconnectNeedsTap = false;
    }

    /** Update the evidence detail without restarting the recovery state. */
    setReconnectDiagnostic(diagnostic: string | null): void {
        if (this.isReconnecting) this.reconnectDiagnostic = diagnostic;
    }

    setPausedByUser(pausedByUser: boolean): void {
        this.pausedByUser = pausedByUser;
    }

    setReconnectNeedsTap(reconnectNeedsTap: boolean): void {
        this.reconnectNeedsTap = reconnectNeedsTap;
    }

    setVersionSwitching(isVersionSwitching: boolean): void {
        this.isVersionSwitching = isVersionSwitching;
    }

    /**
     * Batched write path for the per-frame `timeupdate` event. Calling
     * five separate setters per tick triggered five separate $state
     * invalidations even when the values were unchanged or
     * within-threshold. This consolidates the equality-checked writes
     * into one method so the `$derived` graph downstream of playerStore
     * sees a single coherent transition per tick.
     *
     * All fields are optional. Omit any field you don't have a fresh
     * value for — in particular, omit `currentTime` while the user is
     * scrubbing so we don't clobber `playheadTime`'s fractional value
     * with the whole-second `currentTime` snapshot. The pre-batch code
     * skipped its `setCurrentTime` call entirely while seeking.
     */
    applyTimeupdate(input: {
        currentTime?: number;
        duration?: number;
        bufferedEnd?: number;
        loading?: boolean;
        buffering?: boolean;
    }): void {
        // currentTime — two-tier: playheadTime always, currentTime once
        // per second (matches setCurrentTime behavior). Skipped entirely
        // when caller omits the field (e.g. while seeking).
        if (input.currentTime !== undefined) {
            this.playheadTime = input.currentTime;
            const second = Math.floor(input.currentTime);
            if (second !== this._lastDisplaySecond) {
                this._lastDisplaySecond = second;
                this.currentTime = input.currentTime;
            }
        }
        // duration — only when changed beyond noise threshold.
        if (input.duration !== undefined && Math.abs(this.duration - input.duration) >= 0.5) {
            this.duration = input.duration;
        }
        // bufferedEnd — only when changed beyond noise threshold.
        if (
            input.bufferedEnd !== undefined &&
            Math.abs(this.bufferedEnd - input.bufferedEnd) >= 0.5
        ) {
            this.bufferedEnd = input.bufferedEnd;
        }
        // loading / buffering — only when actually flipping state.
        if (input.loading !== undefined && this.isLoading !== input.loading) {
            this.isLoading = input.loading;
        }
        if (input.buffering !== undefined && this.isBuffering !== input.buffering) {
            this.isBuffering = input.buffering;
        }
    }

    // Set volume (0-1)
    setVolume(volume: number): void {
        this.volume = Math.max(0, Math.min(1, volume));
        this.isMuted = volume === 0;
    }

    // Toggle mute
    toggleMute(): void {
        if (this.isMuted && this.volume === 0) {
            this.volume = 0.5;
        }
        this.isMuted = !this.isMuted;
    }

    // Set fullscreen state
    setFullscreen(isFullscreen: boolean): void {
        this.isFullscreen = isFullscreen;
    }

    // Set playback rate
    setPlaybackRate(rate: number): void {
        this.playbackRate = rate;
    }

    audioSelectionRevision = $state(0);

    // Change audio track
    setAudioTrack(index: number): void {
        this.audioSelectionRevision++;
        const audioTrack = this.currentMediaSource?.audioStreams.find((t) => t.index === index);

        // Remember the picked language as the "learned" preference
        // (`lastAudioLanguage`) — NOT the explicit `audioLanguage` set in
        // Settings, which the user controls directly and which outranks this.
        // (Learned is consulted even when the explicit default IS set: it ranks
        // below it but still ahead of the file's own default.) Only persist
        // when the track has a usable language tag: picking an untagged/
        // 'und'/'mul' track must not wipe the learned language (this file just
        // has imperfect metadata).
        if (audioTrack) {
            const trackLang = audioTrack.language || audioTrack.languageCode;
            if (!isUnknownLanguage(trackLang)) {
                updatePreference('lastAudioLanguage', normalizeLanguage(trackLang));
            }
        }

        // The track is now a deliberate choice, so there is no automatic pick
        // left to explain — drop the reason rather than leaving the picker
        // claiming a preference chose what the viewer just chose by hand.
        this.audioSelectionReason = null;
        this.audioSelectionLanguage = null;

        // Auto-enable forced subtitles matching the audio language
        let newSubtitleIndex = this.currentSubtitleTrackIndex;
        if (this.forcedSubtitlesEnabled && audioTrack && this.currentMediaSource) {
            const currentSub =
                this.currentSubtitleTrackIndex === null
                    ? null
                    : this.currentMediaSource.subtitleStreams.find(
                          (s) => s.index === this.currentSubtitleTrackIndex,
                      );

            // Re-evaluate only an AUTOMATIC forced pick (or none): a forced
            // track belongs to one audio language, so it follows the audio.
            // A subtitle the viewer picked by hand — forced or not — stays.
            if (!currentSub || (isForcedSubtitle(currentSub) && !this.subtitlePickedByUser)) {
                const audioLang = audioTrack.language || audioTrack.languageCode;
                const forcedSub = bestLanguageMatch(
                    this.subtitleTracks.filter(isForcedSubtitle),
                    audioLang,
                    (sub) => sub.language || sub.languageCode,
                );

                if (forcedSub) {
                    newSubtitleIndex = forcedSub.index;
                } else {
                    newSubtitleIndex = null;
                }
                this.subtitlePickedByUser = false;
            }
        }

        if (this.currentSubtitleTrackIndex !== newSubtitleIndex) this.subtitleSelectionRevision++;
        this.currentAudioTrackIndex = index;
        this.currentSubtitleTrackIndex = newSubtitleIndex;
    }

    // Change subtitle track (null = off)
    setSubtitleTrack(index: number | null): void {
        if (
            index !== null &&
            this.currentMediaSource?.subtitleStreams.find((track) => track.index === index)
                ?.deliveryMethod === 'Drop'
        )
            return;
        this.currentSubtitleTrackIndex = index;
        this.subtitleSelectionRevision++;
        // Only viewer actions call this (track menu, subtitle hotkey);
        // automatic picks write currentSubtitleTrackIndex directly.
        this.subtitlePickedByUser = index !== null;
    }

    // Toggle server-side subtitle burn-in (debug feature)
    setForceSubtitleBurnIn(enabled: boolean): void {
        this.forceSubtitleBurnIn = enabled;
    }

    // Toggle forced subtitles (auto-enabled based on audio language)
    setForcedSubtitlesEnabled(enabled: boolean): void {
        let newSubtitleIndex = this.currentSubtitleTrackIndex;
        let autoSelectedSub: SubtitleStreamInfo | null = null;

        const currentSub =
            this.currentSubtitleTrackIndex !== null && this.currentMediaSource
                ? this.currentMediaSource.subtitleStreams.find(
                      (s) => s.index === this.currentSubtitleTrackIndex,
                  )
                : null;

        if (enabled && this.currentMediaSource) {
            if (!currentSub || isForcedSubtitle(currentSub)) {
                const audioTrack = this.currentMediaSource.audioStreams.find(
                    (t) => t.index === this.currentAudioTrackIndex,
                );
                if (audioTrack) {
                    const taggedLanguage = audioTrack.language || audioTrack.languageCode;
                    const audioLang = isUnknownLanguage(taggedLanguage)
                        ? this.audioSelectionLanguage
                        : taggedLanguage;
                    const forcedSub = bestLanguageMatch(
                        this.subtitleTracks.filter(isForcedSubtitle),
                        audioLang,
                        (sub) => sub.language || sub.languageCode,
                    );
                    if (forcedSub) {
                        newSubtitleIndex = forcedSub.index;
                        autoSelectedSub = forcedSub;
                    }
                }
            }
        } else if (!enabled && currentSub && isForcedSubtitle(currentSub)) {
            newSubtitleIndex = null;
        }

        // Automatic forced captions are independent of the saved full-caption edition.
        updatePreference('forcedSubtitlesEnabled', enabled);
        this.subtitleSelectionRevision++;

        this.forcedSubtitlesEnabled = enabled;
        this.currentSubtitleTrackIndex = newSubtitleIndex;
        if (autoSelectedSub) this.subtitlePickedByUser = false;
    }

    // Change quality profile (null = direct play/stream)
    setQualityProfile(profile: TranscodingProfile | null): void {
        if (isSameQuality(this.qualityMode, this.currentQualityProfile, profile)) {
            console.log('[PlayerStore] Skipping quality change - already at same quality');
            return;
        }

        if (profile?.mode === 'audio-only' && this.currentQualityProfile?.mode !== 'audio-only') {
            // null currentQualityProfile means "original" (see the mode mapping
            // below and isSameQuality) — normalize so previousQualityProfile is
            // always a concrete profile a caller can restore.
            this.previousQualityProfile = this.currentQualityProfile ?? ORIGINAL_PROFILE;
        }

        let newQualityMode: QualityMode = 'fixed';
        if (profile === null || profile.mode === 'original') {
            newQualityMode = 'original';
        } else if (profile.mode === 'auto') {
            newQualityMode = 'auto';
        } else if (profile.mode === 'audio-only') {
            newQualityMode = 'audio-only';
        }

        // Audio-only is a SESSION-only selection, never a stored preference:
        // quality prefs sync per-user across every device the user owns, so
        // persisting it here would follow them to their TV. There it would
        // round-trip through loadSavedQualityPreference() as
        // `qualityMode: 'fixed'` + `maxBitrate: 128000` with no matching
        // DEFAULT_TRANSCODING_PROFILES entry, synthesizing a bogus 1080p
        // profile at 128kbps and clobbering whatever the user actually had
        // saved. Skip the persistence call entirely for audio-only — only
        // the in-memory mode/profile below change.
        if (newQualityMode !== 'audio-only') {
            updatePreferences({
                qualityMode: newQualityMode,
                maxBitrateBps: profile?.maxBitrate || null,
                preferredResolution: profile?.label || null,
            });
        }

        this.currentQualityProfile = profile;
        this.qualityMode = newQualityMode;
        this.playMethod =
            profile && profile.mode !== 'original' && profile.mode !== 'auto'
                ? 'Transcode'
                : this.currentMediaSource?.supportsDirectPlay
                  ? 'DirectPlay'
                  : this.currentMediaSource?.supportsDirectStream
                    ? 'DirectStream'
                    : 'Transcode';
    }

    // Set quality mode directly
    setQualityMode(mode: QualityMode): void {
        this.qualityMode = mode;
    }

    setLiveTvQuality(state: LiveTvQualityState | null): void {
        this.liveTvQuality = state;
    }

    /** Apply Live TV quality without overwriting the user's separate VOD preference. */
    setLiveTvQualityProfile(profile: TranscodingProfile | null, mode: QualityMode): void {
        this.currentQualityProfile = profile;
        this.qualityMode = mode;
    }

    // Update measured bandwidth
    setBandwidth(bandwidth: number): void {
        this.measuredBandwidth = bandwidth;
        this.adaptiveTargetBitrate = Math.floor(bandwidth * 0.8);
    }

    // Get the effective target bitrate for current quality mode
    getEffectiveTargetBitrate(): number | null {
        if (this.qualityMode === 'original') return null;
        if (this.qualityMode === 'auto') return this.adaptiveTargetBitrate;
        return this.currentQualityProfile?.maxBitrate || null;
    }

    // Change media source (for multi-version movies)
    setMediaSource(sourceId: string): void {
        if (!this.playbackInfo) return;

        const mediaSource = this.playbackInfo.mediaSources.find((s) => s.id === sourceId);
        if (!mediaSource) return;

        const defaultAudioIndex = getDefaultAudioTrackIndex(mediaSource);

        const defaultSubtitleIndex = getDefaultSubtitleTrackIndex(mediaSource);

        this.currentMediaSource = mediaSource;
        this.currentAudioTrackIndex = defaultAudioIndex;
        this.currentSubtitleTrackIndex = defaultSubtitleIndex;
        this.subtitlePickedByUser = false;
        this.playMethod = mediaSource.supportsDirectPlay
            ? 'DirectPlay'
            : mediaSource.supportsDirectStream
              ? 'DirectStream'
              : 'Transcode';
    }

    // Update current media source directly (used for LiveTV refresh and lumastra version switch)
    updateCurrentMediaSource(mediaSource: MediaSourceInfo): void {
        const previousAudioTrack = this.currentMediaSource?.audioStreams.find(
            (track) => track.index === this.currentAudioTrackIndex,
        );
        const previousSubtitleTrack =
            this.currentSubtitleTrackIndex === null
                ? null
                : (this.currentMediaSource?.subtitleStreams.find(
                      (track) => track.index === this.currentSubtitleTrackIndex,
                  ) ?? null);

        // sameFile lets the resolver fall back to index-based preservation
        // when the previous track had no language tag — safe within a file
        // but unsafe across version switches.
        const sameFile = !!this.currentMediaSource && this.currentMediaSource.id === mediaSource.id;

        this.currentAudioTrackIndex = resolveAudioTrackIndexForMediaSource(
            mediaSource,
            this.currentAudioTrackIndex,
            previousAudioTrack,
            { sameFile },
        );
        this.currentSubtitleTrackIndex = resolveSubtitleTrackIndexForMediaSource(
            mediaSource,
            this.currentSubtitleTrackIndex,
            previousSubtitleTrack,
            { previousFileId: this.currentMediaSource?.id },
        );
        if (
            !sameFile &&
            !this.subtitlePickedByUser &&
            (!previousSubtitleTrack || isForcedSubtitle(previousSubtitleTrack))
        ) {
            const audio = mediaSource.audioStreams.find(
                (track) => track.index === this.currentAudioTrackIndex,
            );
            this.currentSubtitleTrackIndex = this.forcedSubtitlesEnabled
                ? (bestLanguageMatch(
                      mediaSource.subtitleStreams.filter(
                          (track) => track.deliveryMethod !== 'Drop' && isForcedSubtitle(track),
                      ),
                      audio?.language || audio?.languageCode,
                      (sub) => sub.language || sub.languageCode,
                  )?.index ?? null)
                : null;
        }
        const resolvedAudioTrack = mediaSource.audioStreams.find(
            (track) => track.index === this.currentAudioTrackIndex,
        );
        const sameAudio =
            sameFile &&
            previousAudioTrack &&
            resolvedAudioTrack &&
            (previousAudioTrack.absoluteIndex !== undefined &&
            resolvedAudioTrack.absoluteIndex !== undefined
                ? previousAudioTrack.absoluteIndex === resolvedAudioTrack.absoluteIndex
                : previousAudioTrack.index === resolvedAudioTrack.index);
        if (!sameAudio) {
            // The track was just re-resolved against a DIFFERENT stream list, so any
            // reason recorded for the old one no longer describes what is playing —
            // a version without the preferred language falls to that file's default
            // while the note would still name the preference. Drop it rather than
            // let the picker explain a selection that no longer exists.
            this.audioSelectionReason = null;
            this.audioSelectionLanguage = null;
        }
        this.currentMediaSource = mediaSource;
    }

    // Set playback variants for the version picker (Lumastra file versions)
    setPlaybackVariants(variants: PlaybackVariant[], activeId: string | null): void {
        this.playbackVariants = variants;
        this.activeVariantId = activeId;
    }

    // Apply chapters and skip markers from the selected-file timeline
    setChaptersAndSegments(chapters: TimelineChapter[], mediaSegments: TimelineSegment[]): void {
        if (!this.playbackInfo) return;
        this.chapters = chapters;
        this.mediaSegments = mediaSegments;
    }

    // Set error
    setError(error: string | null): void {
        this.error = error;
        this.isLoading = false;
        // A terminal error supersedes the "Reconnecting" badge. The overlay
        // shows the error banner only when !isReconnecting and the badge only
        // when !error, so leaving BOTH set renders NEITHER — a frozen video with
        // no indicator at all. Any direct setError() (fatal media/decode error,
        // setup failure, etc.) that fires while a reconnect is in progress must
        // therefore clear the reconnecting state so the banner can render.
        if (error) {
            this.isReconnecting = false;
            this.reconnectNeedsTap = false;
            // ...and it also ends buffering. Tearing the stream down (policy
            // block, kick, fatal hls.js error) stalls the video element, so
            // `isBuffering` is typically still true when the error lands —
            // leaving the spinner + "Buffering" rendering underneath the error
            // card, which is centered at the same point.
            this.isBuffering = false;
        }
    }

    // Set HDR playback info
    setHdrInfo(hdrInfo: PlayerState['hdrInfo']): void {
        this.hdrInfo = hdrInfo;
    }

    // Set transcoding info for display
    setTranscodingInfo(transcodingInfo: PlayerState['transcodingInfo']): void {
        this.transcodingInfo = transcodingInfo;
    }

    // Set the live measured decoded-frame rate for display
    setLiveFps(fps: number | null): void {
        this.liveFps = fps;
    }

    // Set active delivery metadata for playback/tooltips.
    setPlaybackDeliveryInfo(info: PlaybackDeliveryInfo | null): void {
        this.playbackDeliveryInfo = info;
    }

    // Set whether the audio-only quality rung is available for the current source.
    setAudioOnlyAvailable(available: boolean): void {
        this.audioOnlyAvailable = available;
    }

    setStartupEncoderNotice(notice: PlayerStore['startupEncoderNotice']): void {
        this.startupEncoderNotice = notice;
    }

    // Set transcode progress from server heartbeat
    setTranscodeProgress(progress: PlayerState['transcodeProgress']): void {
        this.transcodeProgress = progress ? { ...progress, receivedAt: Date.now() } : null;
    }

    // Set download bandwidth
    setDownloadBandwidth(bandwidth: number | null): void {
        this.downloadBandwidth = bandwidth;
    }

    setStreamBitrate(bitsPerSecond: number | null): void {
        this.streamBitrate = bitsPerSecond;
    }

    setDecodedResolution(resolution: string | null): void {
        if (this.decodedResolution !== resolution) this.decodedResolution = resolution;
    }

    // Clear error
    clearError(): void {
        this.error = null;
    }

    // Show/hide controls (renamed from showControls to avoid field name conflict)
    setShowControls(show: boolean): void {
        if (this._controlsTimeout) {
            clearTimeout(this._controlsTimeout);
            this._controlsTimeout = null;
        }
        this.showControls = show;
    }

    // Show controls with auto-hide
    showControlsTemporarily(hideAfterMs: number = 3000): void {
        if (this._controlsTimeout) {
            clearTimeout(this._controlsTimeout);
        }

        this.showControls = true;

        this._controlsTimeout = setTimeout(() => {
            if (!this.itemId) return; // Store was reset, ignore stale timeout
            if (this.isPlaying && !this.isPaused) {
                this.showControls = false;
            }
            this._controlsTimeout = null;
        }, hideAfterMs);
    }

    // Keepalive only — heartbeat writes are event-driven (seek, pause/resume,
    // stop). This timer just covers idle "user paused and walked away" sessions.
    // Uses WorkerTimer (not a plain setInterval): a paused, backgrounded/minimized
    // tab is normal usage, but browsers throttle main-thread setInterval heavily
    // once hidden (worse on mobile) — a plain interval can go silent long enough
    // for the server to conclude the session was abandoned and reap it (prod
    // 2026-08-18). Running the tick in a Worker keeps it firing on schedule
    // regardless of tab visibility.
    startProgressReporting(reportFn: () => Promise<void>): void {
        this._progressTimer?.dispose();
        this._progressTimer = new WorkerTimer();
        this._progressTimer.start('play-session-keepalive', () => void reportFn(), 30_000);
    }

    // Stop progress reporting
    stopProgressReporting(): void {
        this._progressTimer?.dispose();
        this._progressTimer = null;
    }

    // Reset store
    reset(): void {
        this.chapters = [];
        this.mediaSegments = [];
        this.trickplayVariants = [];
        this.trickplayManifestHref = null;
        this._progressTimer?.dispose();
        this._progressTimer = null;
        if (this._controlsTimeout) {
            clearTimeout(this._controlsTimeout);
            this._controlsTimeout = null;
        }
        if (this._toastTimeout) {
            clearTimeout(this._toastTimeout);
            this._toastTimeout = null;
        }

        this.isPlaying = false;
        this.isPaused = true;
        this.isBuffering = false;
        this.isLoading = true;
        this.isSeeking = false;
        this.seekRevision++;
        this.isVersionSwitching = false;
        this.playheadTime = 0;
        this.currentTime = 0;
        this._lastDisplaySecond = -1;
        this.duration = 0;
        this.bufferedEnd = 0;
        this.volume = 1;
        this.isMuted = false;
        this.isFullscreen = false;
        this.playbackRate = 1;
        this.itemId = null;
        this.title = '';
        this.seriesName = undefined;
        this.seasonNumber = undefined;
        this.episodeNumber = undefined;
        this.episodeStartNumber = undefined;
        this.episodeEndNumber = undefined;
        this.mediaType = null;
        this.originalLanguage = null;
        this.audioSelectionReason = null;
        this.audioSelectionLanguage = null;
        this.isLive = false;
        this.liveTvQuality = null;
        // Next-episode-prompt prefs are re-applied from playbackPreferences by the
        // VideoPlayer $effect on the next mount; reset to declared defaults so the
        // store never carries a stale value between sessions.
        this.showNextEpisodePopup = true;
        this.nextItemPromptLeadSeconds = 0;
        this.noOutroFallbackSeconds = 30;
        this.currentMediaSource = null;
        this.currentAudioTrackIndex = 0;
        this.currentSubtitleTrackIndex = null;
        this.subtitlePickedByUser = false;
        this.currentQualityProfile = null;
        this.forcedSubtitlesEnabled = true;
        this.forceSubtitleBurnIn = false;
        this.qualityMode = 'original';
        this.measuredBandwidth = null;
        this.adaptiveTargetBitrate = null;
        this.playbackInfo = null;
        this.playSessionId = null;
        this.playMethod = 'DirectPlay';
        this.playbackDeliveryInfo = null;
        this.hdrInfo = null;
        this.transcodingInfo = null;
        this.transcodeProgress = null;
        this.startupEncoderNotice = null;
        this.downloadBandwidth = null;
        this.streamBitrate = null;
        this.decodedResolution = null;
        this.liveFps = null;
        this.error = null;
        this.isReconnecting = false;
        this.reconnectCause = null;
        this.reconnectDiagnostic = null;
        this.pausedByUser = false;
        this.reconnectNeedsTap = false;
        this.showControls = true;
        this.toast = null;
        this.playbackVariants = [];
        this.activeVariantId = null;
    }

    // Get current state as a live reactive proxy (for imperative reads).
    // Returns `this` directly — callers should read properties immediately
    // rather than holding a stale reference across async boundaries.
    getState(): PlayerState {
        return this;
    }

    /** Imperative handle the mounted player registers; see bindExternalControl. */
    private externalControl: PlayerExternalControl | null = null;

    /**
     * Lets the mounted player expose a seek and its reporter's live session id
     * to code outside the player tree (the watch page's series-marker re-check,
     * which must seek a paused player in place and exclude its own session).
     * Returns the unbind function; unbinding a stale handle is a no-op.
     */
    bindExternalControl(control: PlayerExternalControl): () => void {
        this.externalControl = control;
        return () => {
            if (this.externalControl === control) this.externalControl = null;
        };
    }

    /** Seek the mounted player to `seconds`. False when no initialized player can take it. */
    seekExternally(seconds: number): boolean {
        const control = this.externalControl;
        if (!control || !control.isReady()) return false;
        control.seekTo(seconds);
        return true;
    }

    /**
     * Epoch ms of the viewer's last seek in the mounted player (plain field:
     * nothing renders from it). The resume handoff compares it with the
     * other device's last move.
     */
    lastUserSeekAt = 0;

    /** The play-session id the reporter registered with the server, or null. */
    reportedSessionId(): string | null {
        return this.externalControl?.sessionId() ?? null;
    }

    /** Plain (non-reactive) listener list: nothing renders from it. */
    private sessionRebuiltListeners: Array<() => void> = [];

    /**
     * Subscribe to play-session rebuilds: the mounted player re-registered its
     * session because the server no longer had it (reaped, expired, ended).
     * Returns the unsubscribe function.
     */
    onSessionRebuilt(listener: () => void): () => void {
        this.sessionRebuiltListeners = [...this.sessionRebuiltListeners, listener];
        return () => {
            this.sessionRebuiltListeners = this.sessionRebuiltListeners.filter(
                (l) => l !== listener,
            );
        };
    }

    /** Called by the mounted player's reporter after it rebuilt its session. */
    notifySessionRebuilt(): void {
        for (const listener of this.sessionRebuiltListeners) listener();
    }

    // Generate a new play session ID
    generateNewPlaySessionId(): string {
        const newSessionId = safeRandomUUID();
        this.playSessionId = newSessionId;
        return newSessionId;
    }

    // Set play session ID directly
    setPlaySessionId(sessionId: string): void {
        this.playSessionId = sessionId;
    }

    /** Stable across session renewal on reconnect — unlike playSessionId,
     *  which restart-orchestrator.ts renews. This is the correlation key
     *  for playback incident reporting; reset only on a genuinely new
     *  playback attempt (new item, explicit restart), never on reconnect. */
    attemptId = $state<string>('');

    generateNewAttemptId(): string {
        const id = safeRandomUUID();
        this.attemptId = id;
        return id;
    }

    // Show a toast notification (auto-dismisses after duration)
    showToast(message: string, type: 'up' | 'down' | 'info', durationMs: number = 2000): void {
        if (this._toastTimeout) {
            clearTimeout(this._toastTimeout);
        }
        this.toast = { message, type };
        this._toastTimeout = setTimeout(() => {
            this.toast = null;
            this._toastTimeout = null;
        }, durationMs);
    }

    // Clear toast immediately
    clearToast(): void {
        if (this._toastTimeout) {
            clearTimeout(this._toastTimeout);
            this._toastTimeout = null;
        }
        this.toast = null;
    }

    /** Set play method.
     *
     *  ORDERING: `initialize()` also writes `playMethod`, deriving it from the
     *  media source's supportsDirectPlay/supportsDirectStream — which can never
     *  yield `'AudioOnly'`. Any caller that both re-initializes the store and
     *  sets a method (the in-place episode advance does exactly that) must call
     *  this AFTER `initialize()`, or the derived value silently wins. */
    setPlayMethod(method: 'DirectPlay' | 'DirectStream' | 'Transcode' | 'AudioOnly'): void {
        this.playMethod = method;
    }

    /**
     * Run the client's OWN resolver over the live media source, without
     * applying the result.
     *
     * Split out of `loadSavedTrackPreferences()` so
     * `applyTrackRecommendation()` can adopt the subtitle half on its own —
     * see the external-subtitle note there. Everything below is the local
     * resolution; the two callers differ only in which halves they apply.
     */
    private resolveTracksLocally(audioIndex?: number): TrackResolution | null {
        if (!this.currentMediaSource) return null;
        const mediaSource = this.currentMediaSource;

        const prefs = getPreferences();
        console.log('[Player:Subtitles] resolveTracksLocally: loaded preferences', {
            audioLanguage: prefs.audioLanguage,
            subtitleLanguage: prefs.subtitleLanguage,
            subtitlesEnabled: prefs.subtitlesEnabled,
            forcedSubtitlesEnabled: prefs.forcedSubtitlesEnabled,
            subtitleTrackHint: prefs.subtitleTrackHint,
            availableSubtitles: mediaSource.subtitleStreams?.map((s) => ({
                index: s.index,
                language: s.language || s.languageCode,
                title: s.displayTitle,
                isForced: s.isForced,
                codec: s.codec,
            })),
        });

        // The file's own default, NOT `currentAudioTrackIndex`. This method runs
        // more than once per item (twice on mount, again after an in-place
        // episode advance), so by the second call the live index is already a
        // preference-driven pick — passing it as the fallback would report a
        // preference-chosen track as 'file-default' and suppress the note that
        // explains it.
        const fileDefaultAudioIndex = getDefaultAudioTrackIndex(mediaSource);

        // Both the audio pick AND the subtitle pick (including the "forced
        // subtitle matching the chosen audio track" fallback that ties them
        // together) go through the same `resolveTracks` the server runs to
        // build `recommended_tracks` (see applyTrackRecommendation above) —
        // this used to be an inline duplicate of that logic; unifying them
        // means there is only ever one client-side subtitle/audio resolver
        // to drift.
        //
        // `TrackCandidate.language` is a single field; this player's stream
        // types separately carry `language` and `languageCode` (a Jellyfin-
        // era duplication), so subtitle candidates fold both into one here —
        // the resolver has no way to do that combining itself. `title` is
        // mapped from `displayTitle`, not the optional raw `.title` field:
        // for Lumastra-built subtitle streams (buildLumastraSource in
        // player-controller.svelte.ts) the raw title metadata is folded INTO
        // displayTitle, and `.title` itself is never populated — mapping
        // `.title` here would silently drop the title-based forced-subtitle
        // heuristic (isTrackForced) that isForcedSubtitle() used to provide.
        const subtitleCandidates = mediaSource.subtitleStreams
            .filter((track) => track.deliveryMethod !== 'Drop')
            .map((s) => ({
                index: s.index,
                id: s.id,
                fileId: mediaSource.id,
                language: s.language || s.languageCode || null,
                isForced: s.isForced,
                codec: s.codec,
                title: s.title ?? s.displayTitle,
            }));

        // Audio candidates pass through unmapped, unlike the subtitles above.
        // That is only safe because mapLumastraAudioStreams (the sole producer
        // of a non-empty audioStreams) populates `title` alongside
        // `displayTitle`. It did not always: while `title` was dropped there,
        // the commentary/AD filter in resolveTracks silently matched nothing on
        // this path — the server filtered and the client did not. If a second
        // producer of audioStreams ever appears, it must carry `title` too.
        const resolved = resolveTracks(
            audioIndex === undefined
                ? mediaSource.audioStreams
                : mediaSource.audioStreams
                      .filter((track) => track.index === audioIndex)
                      .map((track) => ({
                          ...track,
                          // Lock both the adopted audio and its inferred language.
                          language: isUnknownLanguage(track.language || track.languageCode)
                              ? (this.audioSelectionLanguage ?? track.language)
                              : track.language || track.languageCode,
                      })),
            subtitleCandidates,
            {
                preferOriginalAudio: prefs.preferOriginalAudio,
                audioLanguage: prefs.audioLanguage,
                lastAudioLanguage: prefs.lastAudioLanguage,
                subtitleLanguage: prefs.subtitleLanguage,
                subtitlesEnabled: prefs.subtitlesEnabled,
                forcedSubtitlesEnabled: prefs.forcedSubtitlesEnabled,
                subtitleTrackHint: prefs.subtitleTrackHint,
            },
            this.originalLanguage,
            audioIndex ?? fileDefaultAudioIndex,
        );

        console.log(
            `[Player:Subtitles] resolveTracksLocally: idx=${resolved.subtitle.index} lang=${prefs.subtitleLanguage} reason=${resolved.subtitle.reason} prev=${this.currentSubtitleTrackIndex} availSubs=${mediaSource.subtitleStreams?.length ?? 0}`,
        );

        return resolved;
    }

    /** Resolve temporary caption activation without changing saved preferences. */
    savedSubtitleTrackIndex(): number | null {
        return this.resolveTracksLocally(this.currentAudioTrackIndex)?.subtitle.index ?? null;
    }

    // Load saved track preferences (audio/subtitle language)
    loadSavedTrackPreferences(): void {
        const resolved = this.resolveTracksLocally();
        if (!resolved) return;

        this.currentAudioTrackIndex = resolved.audio.index;
        this.audioSelectionReason = resolved.audio.reason;
        this.audioSelectionLanguage = resolved.audio.language;

        this.forcedSubtitlesEnabled = getPreferences().forcedSubtitlesEnabled;
        this.currentSubtitleTrackIndex = resolved.subtitle.index;
        this.subtitlePickedByUser = false;
    }

    /**
     * Normalized language behind an audio recommendation `reason`, mirroring
     * the tier that produced it in `resolvePreferredAudioTrack` — the
     * server's `reason.audio` says WHICH tier matched, but not what language
     * that tier resolved to, and the track picker's note needs the language
     * to render (e.g. "Playing in Japanese because it's the original
     * language"). Null for the two file-default reasons, matching the local
     * resolver.
     */
    private languageForAudioRecommendationReason(reason: AudioSelectionReason): string | null {
        const prefs = getPreferences();
        switch (reason) {
            case 'original-language':
            case 'original-language-untagged':
                return this.originalLanguage ? normalizeLanguage(this.originalLanguage) : null;
            case 'explicit-default':
            case 'explicit-default-untagged':
                return prefs.audioLanguage ? normalizeLanguage(prefs.audioLanguage) : null;
            case 'learned':
                return prefs.lastAudioLanguage ? normalizeLanguage(prefs.lastAudioLanguage) : null;
            case 'file-default':
            case 'no-match-file-default':
                return null;
        }
    }

    /**
     * Apply the server's resolved starting tracks (`lumastra-info`'s
     * `recommended_tracks`), or fall back to resolving locally when the
     * server expressed no opinion.
     *
     * Three distinct states, not to be collapsed:
     *   - `rec` absent (null/undefined): the server's preference load failed
     *     — fall back to the local resolver so playback can still start.
     *   - `rec` present, `subtitle_track_index` absent: the server DID
     *     resolve, and its answer is "no subtitle track" — honour that,
     *     `rec.reason.subtitle` says why. Do NOT fall back locally here.
     *   - `rec` present with both indices: apply both directly.
     *
     * The fallback calls `loadSavedTrackPreferences()` — the client's single
     * local resolver — rather than duplicating its logic, so there is only
     * ever one client-side implementation to drift.
     */
    applyTrackRecommendation(rec: TrackRecommendation | null | undefined): void {
        const mediaSource = this.currentMediaSource;
        if (!mediaSource) return;

        if (!rec) {
            this.loadSavedTrackPreferences();
            return;
        }

        // Validate against the LIVE media source before adopting either index —
        // every other consumer of an externally-supplied index in this file
        // does the same (resolveAudioTrackIndexForMediaSource,
        // resolveSubtitleTrackIndexForMediaSource, and
        // the probe adapter all
        // check `streams.some(t => t.index === candidate)` first). A stale or
        // mismatched recommendation (version switch mid-flight, cached
        // response race) would otherwise land on an index absent from
        // `audioStreams`/`subtitleStreams`; the audio track picker's getter
        // then returns undefined for the "current" track, and the player
        // reactively falls through to a full stream restart instead of the
        // silent fallback this guard provides.
        const stalePreferences = staleSelectionPreferences(rec.preferenceSnapshot);
        const local = stalePreferences.audio ? this.resolveTracksLocally() : null;
        const audioIndexValid = mediaSource.audioStreams.some(
            (t) => t.index === rec.audio_track_index,
        );
        if (local) {
            this.currentAudioTrackIndex = local.audio.index;
            this.audioSelectionReason = local.audio.reason;
            this.audioSelectionLanguage = local.audio.language;
        } else if (audioIndexValid) {
            this.currentAudioTrackIndex = rec.audio_track_index;
            this.audioSelectionReason = rec.reason.audio;
            this.audioSelectionLanguage = this.languageForAudioRecommendationReason(
                rec.reason.audio,
            );
        } else {
            console.warn(
                '[Player:Subtitles] applyTrackRecommendation: server audio_track_index not found in media source, falling back to default',
                {
                    recommended: rec.audio_track_index,
                    available: mediaSource.audioStreams.map((t) => t.index),
                },
            );
            this.currentAudioTrackIndex = getDefaultAudioTrackIndex(mediaSource);
            // The server's reason explains the index we just discarded, not
            // the default we fell back to — carrying it over would mislabel
            // the track picker's note with a preference that didn't actually
            // apply.
            this.audioSelectionReason = null;
            this.audioSelectionLanguage = null;
        }

        const hasExternalSubtitles = mediaSource.subtitleStreams.some((t) => t.isExternal === true);
        if (
            stalePreferences.audio ||
            stalePreferences.subtitle ||
            (hasExternalSubtitles && rec.reason.subtitle !== 'off')
        ) {
            this.currentSubtitleTrackIndex =
                this.resolveTracksLocally(this.currentAudioTrackIndex)?.subtitle.index ?? null;
        } else if (rec.subtitle_track_index === undefined) {
            this.currentSubtitleTrackIndex = null;
        } else {
            const subtitleIndexValid = mediaSource.subtitleStreams.some(
                (t) => t.index === rec.subtitle_track_index && t.deliveryMethod !== 'Drop',
            );
            if (subtitleIndexValid) {
                this.currentSubtitleTrackIndex = rec.subtitle_track_index;
            } else {
                console.warn(
                    '[Player:Subtitles] applyTrackRecommendation: server subtitle_track_index not found in media source, falling back to default',
                    {
                        recommended: rec.subtitle_track_index,
                        available: mediaSource.subtitleStreams.map((t) => t.index),
                    },
                );
                this.currentSubtitleTrackIndex = getDefaultSubtitleTrackIndex(mediaSource);
            }
        }

        // forcedSubtitlesEnabled is an independent, viewer-controlled toggle
        // (not part of the track resolution itself) — keep it in sync with
        // the saved preference the same way loadSavedTrackPreferences() does,
        // so the toggle UI doesn't silently revert to its default.
        this.forcedSubtitlesEnabled = getPreferences().forcedSubtitlesEnabled;
        this.subtitlePickedByUser = false;

        console.log('[Player:Subtitles] applyTrackRecommendation: server-resolved', {
            audioIndex: this.currentAudioTrackIndex,
            audioReason: rec.reason.audio,
            audioIndexValid,
            subtitleIndex: this.currentSubtitleTrackIndex,
            subtitleReason: rec.reason.subtitle,
        });
    }

    // Load saved quality preference
    loadSavedQualityPreference(
        defaultMode: QualityMode = 'original',
        autoAllowed: boolean = true,
    ): void {
        const prefs = getPreferences();
        const mode = prefs.qualityMode;
        const maxBitrate = prefs.maxBitrateBps;

        if (!mode) {
            this.applyQualityMode(defaultMode);
            console.log('[Player] No saved quality preference, using config default:', defaultMode);
            return;
        }

        // A saved 'auto' preference must not activate adaptive bitrate when Auto
        // quality is disabled (FEATURE_PLAYER_AUTO_QUALITY off). ABR restarts a
        // transcode via buildStreamUrl, which only supports direct-play and
        // returns null → "Failed to build stream URL" → the stream stalls. Users
        // carrying a stale 'auto' pref from when the option existed fall back to
        // the config default (Original) instead. See loadSavedQualityPreference
        // caller in player-controller (effectiveDefaultMode).
        if (mode === 'auto' && !autoAllowed) {
            this.applyQualityMode(defaultMode);
            console.log(
                '[Player] Saved auto quality preference ignored (Auto disabled); using:',
                defaultMode,
            );
            return;
        }

        if (mode === 'auto') {
            this.qualityMode = 'auto';
            this.currentQualityProfile = AUTO_PROFILE;
        } else if (mode === 'original') {
            this.qualityMode = 'original';
            this.currentQualityProfile = null;
        } else if (mode === 'fixed' && maxBitrate) {
            let profile: TranscodingProfile | undefined = DEFAULT_TRANSCODING_PROFILES.find(
                (p) => p.maxBitrate === maxBitrate,
            );

            if (!profile) {
                profile = {
                    maxBitrate,
                    width: 1920,
                    height: 1080,
                    label: prefs.preferredResolution || `${maxBitrate / 1000000} Mbps`,
                    mode: 'fixed',
                };
            }

            this.qualityMode = 'fixed';
            this.currentQualityProfile = profile ?? null;
        } else {
            this.applyQualityMode(defaultMode);
        }
    }

    // Apply a quality mode (used for config defaults)
    applyQualityMode(mode: QualityMode): void {
        if (mode === 'auto') {
            this.qualityMode = 'auto';
            this.currentQualityProfile = AUTO_PROFILE;
        } else {
            this.qualityMode = 'original';
            this.currentQualityProfile = null;
        }
    }
}

// ============================================
// Singleton instance
// ============================================

export const playerStore = new PlayerStore();

// Time utilities — no circular dependency (player-utils doesn't import playerStore).
export { formatTime, secondsToTicks, ticksToSeconds } from './player-utils';
