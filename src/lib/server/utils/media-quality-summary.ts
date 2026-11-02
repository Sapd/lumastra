// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Build the `MediaQualitySummary` (4K / HDR / Dolby Vision / Atmos badges)
 * emitted on a media detail node.
 *
 * Resolution + dynamic range come from the pre-computed `media_item_quality`
 * projection — the single source of truth for best-version ranking, correct for
 * both movies and series (the latter via the episode rollup). `videoRange` uses
 * the fine `hdr_type` (HDR10 / HDR10+ / HLG / Dolby Vision), falling back to the
 * coarse `hdr_tier` only for rows written before the hdr_type backfill. Audio
 * codec is derived from the item's best audio stream (not projected, passed in raw).
 *
 * The Atmos suffix is genuinely best-effort: Atmos is object-based and cannot
 * be read authoritatively from basic stream fields, so this infers it from the
 * probe `profile` string when present (the strongest signal — e.g. ffprobe/
 * Jellyfin reporting "Dolby Digital Plus + Dolby Atmos" / JOC), falling back to
 * a conservative codec+channel heuristic for local files whose profile lacks a
 * descriptive Atmos marker.
 */

import type { MediaQualitySummary } from '$lib/schemas/media-detail';

/** Raw best-audio-stream shape returned by the media-detail query subquery. */
export interface BestAudioStream {
    codec: string | null;
    channels: number | null;
    channel_layout: string | null;
    profile: string | null;
}

export interface QualitySummaryInput {
    /** `media_item_quality.resolution_tier` — '4K' | '1080p' | '720p' | 'SD' | null */
    resolutionTier: string | null | undefined;
    /** `media_item_quality.hdr_type` — fine: 'dolby_vision' | 'hdr10_plus' | 'hdr10' | 'hlg' | 'sdr' | null */
    hdrType?: string | null | undefined;
    /** `media_item_quality.hdr_tier` — coarse fallback for rows without hdr_type: 'dolby_vision' | 'hdr' | 'sdr' | null */
    hdrTier: string | null | undefined;
    /** Best audio stream (highest channel count across the item's versions), or null */
    bestAudio: BestAudioStream | null | undefined;
    hasClosedCaptions?: boolean | undefined;
    hasSDH?: boolean | undefined;
    hasAudioDescription?: boolean | undefined;
}

/** Map the projection's resolution tier → a client resolution label. */
function resolutionLabel(tier: string | null | undefined): string | undefined {
    switch (tier) {
        case '4K':
            return '2160p';
        case '1080p':
            return '1080p';
        case '720p':
            return '720p';
        case 'SD':
            return '480p';
        default:
            return undefined;
    }
}

/** Map the projection's FINE `hdr_type` → the client `videoRange` enum. */
function videoRangeFromType(
    hdrType: string | null | undefined,
): MediaQualitySummary['videoRange'] | undefined {
    switch (hdrType) {
        case 'dolby_vision':
            return 'DolbyVision';
        case 'hdr10_plus':
            return 'HDR10Plus';
        case 'hdr10':
            return 'HDR10';
        case 'hlg':
            return 'HLG';
        case 'sdr':
            return 'SDR';
        default:
            return undefined;
    }
}

/**
 * Coarse `hdr_tier` → `videoRange`. Fallback ONLY for projection rows written
 * before the hdr_type migration/backfill (or a replica mid-deploy) — the coarse
 * tier can't distinguish HDR10 / HDR10+ / HLG, so it reports HDR10.
 */
function videoRangeFromTier(
    tier: string | null | undefined,
): MediaQualitySummary['videoRange'] | undefined {
    switch (tier) {
        case 'dolby_vision':
            return 'DolbyVision';
        case 'hdr':
            return 'HDR10';
        case 'sdr':
            return 'SDR';
        default:
            return undefined;
    }
}

/** Friendly display name for a raw audio codec string. */
function baseCodecLabel(codec: string): string {
    switch (codec.toLowerCase()) {
        case 'truehd':
            return 'TrueHD';
        case 'eac3':
        case 'e-ac-3':
        case 'ec-3':
            return 'EAC3';
        case 'ac3':
        case 'ac-3':
            return 'AC3';
        case 'dts':
            return 'DTS';
        case 'dts-hd':
        case 'dtshd':
            return 'DTS-HD';
        case 'flac':
            return 'FLAC';
        case 'aac':
            return 'AAC';
        case 'opus':
            return 'Opus';
        case 'mp3':
            return 'MP3';
        case 'alac':
            return 'ALAC';
        case 'pcm':
            return 'PCM';
        default:
            return codec.toUpperCase();
    }
}

/**
 * Best-effort Atmos detection. The authoritative signal is the probe `profile`
 * string (present on Jellyfin-sourced streams and, after the ffprobe
 * profile-capture fix, on local streams too) containing an "atmos" / "joc"
 * marker — this is the ONLY reliable signal for E-AC-3 JOC (which is typically
 * a 6-channel core, so channel count can't distinguish it, and plain 7.1 DD+
 * exists with 8 discrete non-object channels — channel count would both
 * false-positive on plain 7.1 EAC3 and miss 6ch JOC).
 *
 * Secondary fallback is limited to TrueHD at 8+ channels (7.1 bed): modern
 * TrueHD 7.1 releases are overwhelmingly Atmos-carrying, so this errs toward a
 * useful badge for local files whose probe profile lacks a descriptive marker.
 * Plain 5.1 TrueHD is left un-suffixed. A rare plain 7.1 TrueHD may be
 * over-labeled — accepted as the least-bad tradeoff given the user asked for
 * channel-based inference.
 */
export function isAtmos(audio: BestAudioStream): boolean {
    const codec = (audio.codec ?? '').toLowerCase();
    const profile = (audio.profile ?? '').toLowerCase();

    if (profile.includes('atmos') || profile.includes('joc')) return true;
    if (codec === 'truehd' && (audio.channels ?? 0) >= 8) return true;

    return false;
}

/** Build the `audioCodec` badge label from the best audio stream. */
export function audioCodecLabel(audio: BestAudioStream | null | undefined): string | undefined {
    if (!audio || !audio.codec) return undefined;
    const label = baseCodecLabel(audio.codec);
    return isAtmos(audio) ? `${label} Atmos` : label;
}

/**
 * Assemble the `MediaQualitySummary`, or `undefined` when nothing is known
 * (no projection row and no audio) so the field is omitted entirely rather
 * than emitting an empty object.
 */
export function buildQualitySummary(input: QualitySummaryInput): MediaQualitySummary | undefined {
    const resolution = resolutionLabel(input.resolutionTier);
    // Prefer the fine hdr_type; fall back to the coarse hdr_tier for un-migrated rows.
    const videoRange = videoRangeFromType(input.hdrType) ?? videoRangeFromTier(input.hdrTier);
    const audioCodec = audioCodecLabel(input.bestAudio);

    const anyFlag =
        input.hasClosedCaptions === true ||
        input.hasSDH === true ||
        input.hasAudioDescription === true;
    if (
        resolution === undefined &&
        videoRange === undefined &&
        audioCodec === undefined &&
        !anyFlag
    ) {
        return undefined;
    }

    const summary: MediaQualitySummary = {};
    if (resolution !== undefined) {
        summary.resolution = resolution;
        summary.is4k = input.resolutionTier === '4K';
    }
    if (videoRange !== undefined) summary.videoRange = videoRange;
    if (audioCodec !== undefined) summary.audioCodec = audioCodec;
    if (input.hasClosedCaptions === true) summary.hasClosedCaptions = true;
    if (input.hasSDH === true) summary.hasSDH = true;
    if (input.hasAudioDescription === true) summary.hasAudioDescription = true;
    return summary;
}
