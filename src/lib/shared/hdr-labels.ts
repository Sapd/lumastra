// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Maps raw HDR format enum values (from ffprobe/lumastra-info) to
 * human-readable display labels. Used by both the video player badges
 * and the admin transcoding page.
 */
export function formatHdrLabel(raw: string | null | undefined): string | null {
    switch (raw) {
        case 'dovi_hdr10':
            return 'DV P8';
        case 'dovi':
            return 'DV P7';
        case 'hdr10plus':
            return 'HDR10+';
        case 'hdr10':
            return 'HDR10';
        case 'hlg':
            return 'HLG';
        case 'sdr':
            return 'SDR';
        default:
            return raw ?? null;
    }
}

/**
 * Returns a CSS color class suffix for HDR badge differentiation.
 * - dovi/dovi_hdr10 → purple
 * - hdr10plus → teal
 * - hdr10/hlg/other → amber (default)
 */
export function hdrBadgeColor(raw: string): 'purple' | 'teal' | 'amber' {
    if (raw === 'dovi_hdr10' || raw === 'dovi') return 'purple';
    if (raw === 'hdr10plus') return 'teal';
    return 'amber';
}
