// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback Quality Dashboard Formatting Utilities
 * Pure functions for formatting health scores, bandwidth, labels, etc.
 */

import * as m from '$lib/paraglide/messages.js';
import { parseUserAgent } from '$lib/utils/user-agent';
import {
    toPlayMethod,
    getPlayMethodLabel as getCanonicalLabel,
    getPlayMethodStatTextClass,
    getPlayMethodStatBgClass,
} from '$lib/utils/playback-method';

export function formatHealthScore(score: number | string | null | undefined): string {
    if (score === null || score === undefined) return '-';
    const num = typeof score === 'string' ? parseFloat(score) : score;
    if (isNaN(num)) return '-';
    return num.toFixed(1);
}

export function getHealthScoreColor(score: number | string | null | undefined): string {
    if (score === null || score === undefined) return 'text-gray-400';
    const num = typeof score === 'string' ? parseFloat(score) : score;
    if (isNaN(num)) return 'text-gray-400';
    if (num >= 90) return 'text-green-400';
    if (num >= 70) return 'text-yellow-400';
    if (num >= 50) return 'text-orange-400';
    return 'text-red-400';
}

export function getHealthScoreBg(score: number | string | null | undefined): string {
    if (score === null || score === undefined) return 'bg-gray-500/20';
    const num = typeof score === 'string' ? parseFloat(score) : score;
    if (isNaN(num)) return 'bg-gray-500/20';
    if (num >= 90) return 'bg-green-500/20';
    if (num >= 70) return 'bg-yellow-500/20';
    if (num >= 50) return 'bg-orange-500/20';
    return 'bg-red-500/20';
}

export function formatBandwidth(mbps: number | string | null | undefined): string {
    if (mbps === null || mbps === undefined) return '-';
    const num = typeof mbps === 'string' ? parseFloat(mbps) : mbps;
    if (isNaN(num)) return '-';
    return `${num.toFixed(1)} Mbps`;
}

/**
 * Bits per second as a bare Mbit/s figure with one decimal; an absent value
 * reads as `—`, never as 0.
 *
 * Shared because three admin views render the same quantity (the incident
 * drawer's delivery-window table, its speed-test strip, and the session
 * drawer's worst/typical pair) and a link that reads 0.0 Mbit/s is a very
 * different claim from one we have no measurement for. The unit is NOT appended:
 * callers label a column header once rather than every cell.
 */
export function formatMbit(bps: number | null | undefined): string {
    if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
    return (bps / 1_000_000).toFixed(1);
}

/**
 * Plain-English name for a speed-test profile.
 *
 * `single` reads as "quick" rather than "single" because the operator-facing
 * question is how much of a sample the number rests on, not how many HTTP
 * requests produced it — and the client's own label for the same profile is
 * "Quick (16 MB)". Admin surfaces are English-only by policy, so this is not a
 * Paraglide key.
 *
 * An unrecognized value is passed through instead of being folded into "quick":
 * a future profile must not be silently mislabelled as the cheapest one.
 */
export function formatSpeedTestMode(mode: string | null | undefined): string {
    switch (mode) {
        case 'single':
            return 'quick';
        case 'long':
            return 'long';
        case 'cadence':
            return 'cadence';
        default:
            return mode ?? 'quick';
    }
}

export function formatIssue(issue: string): {
    label: string;
    isRootCause: boolean;
} {
    // Root cause labels
    if (issue.startsWith('cause:')) {
        const cause = issue.substring(6);
        const causeLabels: Record<string, string> = {
            slow_client_connection: m.playback_fmt_cause_slow_client(),
            transcoding_bottleneck: m.playback_fmt_cause_transcoding_bottleneck(),
            slow_backend_storage: m.playback_fmt_cause_slow_storage(),
            slow_server_delivery: m.playback_fmt_cause_slow_delivery(),
            network_instability: m.playback_fmt_cause_network_instability(),
            delivery_interruptions: m.playback_fmt_cause_delivery_interruptions(),
            server_errors: m.playback_fmt_cause_server_errors(),
            unknown: m.playback_fmt_cause_unknown(),
        };
        return {
            label:
                causeLabels[cause] ||
                cause.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            isRootCause: true,
        };
    }

    // Standard issue labels
    const issueLabels: Record<string, string> = {
        rebuffering: m.playback_fmt_issue_rebuffering(),
        low_bandwidth: m.playback_fmt_issue_low_bandwidth(),
        low_buffer: m.playback_fmt_issue_low_buffer(),
        server_errors: m.playback_fmt_cause_server_errors(),
        bitrate_below_ideal: m.playback_fmt_issue_bitrate_below_ideal(),
        // Emitted alongside `cause:delivery_interruptions`: the issue tag carries
        // the score penalty, the cause tag carries the diagnosis, and both reach
        // the UI as badges.
        delivery_interruptions: m.playback_fmt_issue_delivery_interruptions(),
    };

    return {
        label:
            issueLabels[issue] || issue.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        isRootCause: false,
    };
}

export function getClientTypeLabel(type: string): string {
    switch (type) {
        case 'hls_js':
            return 'HLS.js';
        case 'native_hls':
            return m.playback_fmt_client_native_hls();
        case 'unknown':
            return m.playback_fmt_client_external_player();
        default:
            return type;
    }
}

export function getPlayMethodLabel(method: string): string {
    if (method === 'unknown') return m.playback_fmt_unknown();
    const canonical = toPlayMethod(method);
    return canonical ? getCanonicalLabel(canonical) : method;
}

export function getPlayMethodColor(method: string): string {
    const canonical = toPlayMethod(method);
    return canonical ? getPlayMethodStatTextClass(canonical) : 'text-gray-400';
}

export function getPlayMethodBg(method: string): string {
    const canonical = toPlayMethod(method);
    return canonical ? getPlayMethodStatBgClass(canonical) : 'bg-gray-500/20 border-gray-500/30';
}

export { parseUserAgent } from '$lib/utils/user-agent';

/** A browser UA string, as web clients report for their device name. */
function looksLikeBrowserUa(value: string): boolean {
    return /Mozilla\/|AppleWebKit\/|Gecko\//.test(value);
}

export function getFriendlyDeviceName(
    deviceName: string | null,
    clientType: string | null,
): string {
    // Web clients register their UA as the device name; show it the way the
    // rest of the admin UI does ("Safari 18 on iPhone"), not as a raw string.
    if (deviceName) return looksLikeBrowserUa(deviceName) ? parseUserAgent(deviceName) : deviceName;
    if (!clientType) return m.playback_fmt_unknown_device();
    switch (clientType) {
        case 'native_hls':
            return m.playback_fmt_safari_browser();
        case 'hls_js':
            return m.playback_fmt_chrome_firefox_browser();
        default:
            return m.playback_fmt_unknown_browser();
    }
}

export function formatTranscodeReason(reason: string): string {
    const reasonLabels: Record<string, string> = {
        VideoCodecNotSupported: m.playback_fmt_reason_video_codec(),
        AudioCodecNotSupported: m.playback_fmt_reason_audio_codec(),
        ContainerNotSupported: m.playback_fmt_reason_container(),
        ContainerBitrateExceedsLimit: m.playback_fmt_reason_container_bitrate(),
        AudioBitrateNotSupported: m.playback_fmt_reason_audio_bitrate(),
        VideoBitrateNotSupported: m.playback_fmt_reason_video_bitrate(),
        VideoLevelNotSupported: m.playback_fmt_reason_video_level(),
        VideoProfileNotSupported: m.playback_fmt_reason_video_profile(),
        VideoRangeTypeNotSupported: m.playback_fmt_reason_hdr(),
        RefFramesNotSupported: m.playback_fmt_reason_ref_frames(),
        AudioChannelsNotSupported: m.playback_fmt_reason_audio_channels(),
        AudioProfileNotSupported: m.playback_fmt_reason_audio_profile(),
        AudioSampleRateNotSupported: m.playback_fmt_reason_audio_sample_rate(),
        SecondaryAudioNotSupported: m.playback_fmt_reason_secondary_audio(),
        SubtitleCodecNotSupported: m.playback_fmt_reason_subtitle_codec(),
        DirectPlayError: m.playback_fmt_reason_direct_play_error(),
        VideoResolutionNotSupported: m.playback_fmt_reason_resolution(),
        AnamorphicVideoNotSupported: m.playback_fmt_reason_anamorphic(),
        InterlacedVideoNotSupported: m.playback_fmt_reason_interlaced(),
        UnknownVideoStreamInfo: m.playback_fmt_reason_unknown_video(),
        UnknownAudioStreamInfo: m.playback_fmt_reason_unknown_audio(),
    };
    return reasonLabels[reason] || reason.replace(/([A-Z])/g, ' $1').trim();
}

export function getTranscodeReasonBarWidth(count: number, maxCount: number): string {
    const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0;
    return `${Math.max(percentage, 5)}%`;
}

/**
 * Operation category a transcode-reason bucket implies, ordered by cost:
 * `remux` (repackage container only, no re-encode) → `audio_transcode`
 * (re-encode audio, copy video) → `video_transcode` (full video re-encode).
 *
 * The bucket strings come from the `getTranscodeReasons` SQL CASE — keep this
 * map in lockstep with the buckets that query emits.
 */
export type TranscodeReasonCategory = 'remux' | 'audio_transcode' | 'video_transcode';

const TRANSCODE_BUCKET_CATEGORY: Record<string, TranscodeReasonCategory> = {
    container: 'remux',
    multi_audio: 'remux',
    audio_codec: 'audio_transcode',
    audio_channels: 'audio_transcode',
    video_codec: 'video_transcode',
    video_10bit: 'video_transcode',
    hdr: 'video_transcode',
    video_level: 'video_transcode',
    video_profile: 'video_transcode',
    resolution: 'video_transcode',
    video_bitrate: 'video_transcode',
    preview_mode: 'video_transcode',
};

/**
 * A container needs at minimum a remux, so anything unrecognized is treated as
 * a video transcode (the most conservative/expensive bucket) rather than
 * silently understating the cost.
 */
export function transcodeReasonBucketCategory(bucket: string): TranscodeReasonCategory {
    return TRANSCODE_BUCKET_CATEGORY[bucket] ?? 'video_transcode';
}

/** Localized, param-free label for a reason bucket from `getTranscodeReasons`. */
export function formatTranscodeReasonBucket(bucket: string): string {
    switch (bucket) {
        case 'container':
            return m.playback_fmt_reason_container();
        case 'multi_audio':
            return m.playback_fmt_reason_multi_audio();
        case 'audio_codec':
            return m.playback_fmt_reason_audio_codec();
        case 'audio_channels':
            return m.playback_fmt_reason_audio_channels();
        case 'video_codec':
            return m.playback_fmt_reason_video_codec();
        case 'video_10bit':
            return m.playback_fmt_reason_10bit();
        case 'hdr':
            return m.playback_fmt_reason_hdr();
        case 'video_level':
            return m.playback_fmt_reason_video_level();
        case 'video_profile':
            return m.playback_fmt_reason_video_profile();
        case 'resolution':
            return m.playback_fmt_reason_resolution();
        case 'video_bitrate':
            return m.playback_fmt_reason_video_bitrate();
        case 'preview_mode':
            return m.playback_fmt_reason_preview_mode();
        default:
            return bucket.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
}

/**
 * Device classes the analytics queries emit (`PlaybackFormFactor` in
 * playback-analytics.queries.ts), in display order.
 */
export const FORM_FACTORS = ['mobile', 'tablet', 'tv', 'desktop', 'unknown'] as const;
export type FormFactorKey = (typeof FORM_FACTORS)[number];

export function toFormFactor(value: string | null | undefined): FormFactorKey {
    return (FORM_FACTORS as readonly string[]).includes(value ?? '')
        ? (value as FormFactorKey)
        : 'unknown';
}

export function getFormFactorLabel(value: string | null | undefined): string {
    switch (toFormFactor(value)) {
        case 'mobile':
            return m.admin_pbquality_ff_mobile();
        case 'tablet':
            return m.admin_pbquality_ff_tablet();
        case 'tv':
            return m.admin_pbquality_ff_tv();
        case 'desktop':
            return m.admin_pbquality_ff_desktop();
        default:
            return m.admin_pbquality_ff_unknown();
    }
}

/** Text + swatch colour per device class; one hue each, stable across panels. */
export function getFormFactorColor(value: string | null | undefined): {
    text: string;
    swatch: string;
} {
    switch (toFormFactor(value)) {
        case 'mobile':
            return { text: 'text-purple-400', swatch: 'bg-purple-500' };
        case 'tablet':
            return { text: 'text-pink-400', swatch: 'bg-pink-500' };
        case 'tv':
            return { text: 'text-amber-400', swatch: 'bg-amber-500' };
        case 'desktop':
            return { text: 'text-cyan-400', swatch: 'bg-cyan-500' };
        default:
            return { text: 'text-surface-400', swatch: 'bg-surface-500' };
    }
}
