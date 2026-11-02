// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MediaQualitySummary } from '$lib/schemas/media-detail';

export type QualityChipTone = 'amber' | 'orange' | 'purple' | 'cyan';

export interface QualityChip {
    label: string;
    tooltip: string;
    tone: QualityChipTone;
}

/**
 * Adapt the flat quality tiers carried by recommendation rails (sourced from the
 * `media_item_quality` projection) into the {@link MediaQualitySummary} shape
 * {@link buildQualityChips} expects.
 *
 * Every signal here is a column on `media_item_quality`, so a rail gets the full
 * badge set from one PK join — no media_streams scan at request time.
 *
 * `hdrTier` is coarse by design ('hdr' covers both HDR10 and HLG), so it maps to
 * 'HDR10' and renders the generic "HDR" badge rather than over-claiming a
 * specific flavour. Rails carry no audio codec LABEL, only `hasAtmos` — the
 * label mapping (TrueHD/EAC3/DTS…) lives in TypeScript and is not duplicated
 * into SQL.
 */
export function qualitySummaryFromTiers(
    resolutionTier: string | null | undefined,
    hdrTier: string | null | undefined,
    flags?: {
        hasAtmos?: boolean;
        hasCc?: boolean;
        hasSdh?: boolean;
        hasAd?: boolean;
    },
): MediaQualitySummary | null {
    const anyFlag =
        flags?.hasAtmos === true ||
        flags?.hasCc === true ||
        flags?.hasSdh === true ||
        flags?.hasAd === true;
    if (!resolutionTier && !hdrTier && !anyFlag) return null;

    const videoRange: MediaQualitySummary['videoRange'] =
        hdrTier === 'dolby_vision'
            ? 'DolbyVision'
            : hdrTier === 'hdr'
              ? 'HDR10'
              : hdrTier === 'sdr'
                ? 'SDR'
                : undefined;

    return {
        ...(resolutionTier ? { is4k: resolutionTier === '4K' } : {}),
        ...(videoRange ? { videoRange } : {}),
        ...(flags?.hasAtmos ? { hasAtmos: true } : {}),
        ...(flags?.hasCc ? { hasClosedCaptions: true } : {}),
        ...(flags?.hasSdh ? { hasSDH: true } : {}),
        ...(flags?.hasAd ? { hasAudioDescription: true } : {}),
    };
}

/**
 * Build the premium-format badges for a media detail's best-available quality
 * summary. Only "worth highlighting" formats are badged: 4K, HDR / HDR10+ /
 * HLG / Dolby Vision, and Atmos. SDR and sub-4K resolutions are intentionally
 * omitted (they'd be noise). Format names are proper nouns, returned verbatim
 * (not translated). Order: resolution → dynamic range → audio.
 */
export function buildQualityChips(quality: MediaQualitySummary | null | undefined): QualityChip[] {
    if (!quality) return [];
    const chips: QualityChip[] = [];

    if (quality.is4k) {
        chips.push({ label: '4K', tooltip: '4K Ultra HD (2160p)', tone: 'amber' });
    }

    switch (quality.videoRange) {
        case 'DolbyVision':
            chips.push({ label: 'Dolby Vision', tooltip: 'Dolby Vision HDR', tone: 'purple' });
            break;
        case 'HDR10Plus':
            chips.push({ label: 'HDR10+', tooltip: 'HDR10+ dynamic HDR', tone: 'orange' });
            break;
        case 'HDR10':
            chips.push({ label: 'HDR', tooltip: 'HDR10', tone: 'orange' });
            break;
        case 'HLG':
            chips.push({ label: 'HLG', tooltip: 'Hybrid Log-Gamma HDR', tone: 'orange' });
            break;
        // 'SDR' (and absent) → no badge.
    }

    // `hasAtmos` is the explicit signal (rails, from the projection); the
    // audioCodec regex is the legacy detail-page path where Atmos is baked into
    // the label string. Either is sufficient.
    if (quality.hasAtmos || (quality.audioCodec && /atmos/i.test(quality.audioCodec))) {
        chips.push({
            label: 'Atmos',
            // Rails have no codec label (hasAtmos only) — don't render
            // "Dolby Atmos (undefined)".
            tooltip: quality.audioCodec ? `Dolby Atmos (${quality.audioCodec})` : 'Dolby Atmos',
            tone: 'cyan',
        });
    }

    if (quality.hasClosedCaptions) {
        chips.push({ label: 'CC', tooltip: 'Closed captions available', tone: 'cyan' });
    }
    if (quality.hasSDH) {
        chips.push({
            label: 'SDH',
            tooltip: 'Subtitles for the deaf and hard-of-hearing',
            tone: 'cyan',
        });
    }
    if (quality.hasAudioDescription) {
        chips.push({ label: 'AD', tooltip: 'Audio description available', tone: 'cyan' });
    }

    return chips;
}
